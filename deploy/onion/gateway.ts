import { gzipSync } from "node:zlib";

const UPSTREAM = (process.env.UPSTREAM ?? "http://xitter:3000").replace(/\/$/, "");
const PUBLIC = new URL(process.env.PUBLIC_ORIGIN ?? "");
const PORT = Number(process.env.PORT ?? 8080);
const HOSTNAME_FILE = process.env.HOSTNAME_FILE ?? "/hs/hostname";

async function onionHost() {
	if (process.env.ONION_HOST) return process.env.ONION_HOST.trim();
	for (;;) {
		const f = Bun.file(HOSTNAME_FILE);
		if (await f.exists()) {
			const name = (await f.text()).trim();
			if (/^[a-z2-7]{56}\.onion$/.test(name)) return name;
		}
		console.log(`waiting for ${HOSTNAME_FILE}`);
		await Bun.sleep(2000);
	}
}
const ONION = await onionHost();
const CLEAR = PUBLIC.host;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hostPattern = (host: string) => host.split(".").map(esc).join("(\\\\*\\.)");
const SCHEME = "(?:(https?|wss?)(:(?:\\\\*\\/){2}))?";
const outRe = new RegExp(SCHEME + hostPattern(CLEAR) + "(?![\\w-])", "g");
const inRe = new RegExp(SCHEME + hostPattern(ONION) + "(?![\\w-])", "g");
const insecure: Record<string, string> = { https: "http", http: "http", wss: "ws", ws: "ws" };
const secure: Record<string, string> = { https: "https", http: "https", wss: "wss", ws: "wss" };

const out = (s: string) =>
	s.replace(outRe, (_m, scheme?: string, sep?: string, ...rest) => {
		const dot = typeof rest[0] === "string" ? rest[0] : ".";
		return (scheme ? insecure[scheme] + sep : "") + ONION.replace(".", dot);
	});
const back = (s: string) =>
	s.replace(inRe, (_m, scheme?: string, sep?: string, ...rest) => {
		const dot = typeof rest[0] === "string" ? rest[0] : ".";
		return (scheme ? secure[scheme] + sep : "") + CLEAR.replaceAll(".", dot);
	});
const bytes = (buf: ArrayBuffer | Uint8Array, f: (s: string) => string) => {
	const b = Buffer.from(buf as ArrayBuffer);
	const s = b.toString("latin1");
	const r = f(s);
	return r === s ? b : Buffer.from(r, "latin1");
};

const TEXT = /^(text\/|application\/(javascript|json|manifest\+json|xml|x-javascript|ld\+json)|image\/svg)/;

type Cached = { status: number; headers: [string, string][]; body: Buffer; gz?: Buffer };
const cache = new Map<string, Cached>();
let cacheBytes = 0;
const CACHE_MAX = Number(process.env.CACHE_MB ?? 256) * 1024 * 1024;
const remember = (key: string, c: Cached) => {
	const size = c.body.length + (c.gz?.length ?? 0);
	if (size > CACHE_MAX / 4) return;
	while (cacheBytes + size > CACHE_MAX && cache.size) {
		const [k, v] = cache.entries().next().value!;
		cache.delete(k);
		cacheBytes -= v.body.length + (v.gz?.length ?? 0);
	}
	cache.set(key, c);
	cacheBytes += size;
};

function upstreamHeaders(req: Request) {
	const h = new Headers();
	for (const [k, v] of req.headers) {
		if (/^(host|cf-|x-forwarded-|x-real-ip|forwarded|accept-encoding|content-length|connection|upgrade|sec-websocket-)/i.test(k)) continue;
		h.set(k, k === "cookie" ? v : back(v));
	}
	h.set("host", CLEAR);
	h.set("x-forwarded-proto", "https");
	h.set("accept-encoding", "identity");
	return h;
}

function clientHeaders(res: Response, rewritten: boolean) {
	const h: [string, string][] = [];
	for (const [k, v] of res.headers) {
		if (/^(strict-transport-security|alt-svc|connection|transfer-encoding|set-cookie)$/i.test(k)) continue;
		if (rewritten && /^(content-length|content-encoding|etag)$/i.test(k)) continue;
		h.push([k, out(v)]);
	}
	for (const c of res.headers.getSetCookie()) h.push(["set-cookie", out(c)]);
	h.push(["onion-gateway", "1"]);
	return h;
}

const gzipOk = (req: Request) => /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "");
function send(req: Request, c: Cached) {
	const headers = new Headers(c.headers);
	if (c.gz && gzipOk(req)) {
		headers.set("content-encoding", "gzip");
		headers.append("vary", "accept-encoding");
		return new Response(req.method === "HEAD" ? null : c.gz, { status: c.status, headers });
	}
	return new Response(req.method === "HEAD" ? null : c.body, { status: c.status, headers });
}

type WsData = { url: string; headers: Headers; upstream?: WebSocket; queue: (string | Buffer)[] };

const server = Bun.serve<WsData, {}>({
	port: PORT,
	idleTimeout: 120,
	async fetch(req, srv) {
		const url = new URL(req.url);
		const path = back(url.pathname + url.search);
		if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
			const ok = srv.upgrade(req, { data: { url: UPSTREAM.replace(/^http/, "ws") + path, headers: upstreamHeaders(req), queue: [] } });
			return ok ? undefined : new Response("expected a websocket", { status: 400 });
		}
		const key = req.method === "GET" || req.method === "HEAD" ? path : "";
		const hit = key && cache.get(key);
		if (hit) return send(req, hit);

		let body: Buffer | undefined;
		if (req.method !== "GET" && req.method !== "HEAD") body = bytes(await req.arrayBuffer(), back);
		let res: Response;
		try {
			res = await fetch(UPSTREAM + path, { method: req.method, headers: upstreamHeaders(req), body, redirect: "manual", decompress: false } as RequestInit);
		} catch (e) {
			console.error("upstream:", (e as Error).message);
			return new Response("the instance is not answering", { status: 502 });
		}
		const type = res.headers.get("content-type") ?? "";
		if (!TEXT.test(type) || res.headers.get("content-encoding") || req.method === "HEAD")
			return new Response(res.body, { status: res.status, headers: clientHeaders(res, false) });

		const text = bytes(await res.arrayBuffer(), out);
		const c: Cached = { status: res.status, headers: clientHeaders(res, true), body: text };
		if (text.length > 1024) c.gz = gzipSync(text, { level: 6 });
		const cc = res.headers.get("cache-control") ?? "";
		if (key && res.status === 200 && /immutable|max-age=(\d{5,})/.test(cc) && !/private|no-store/.test(cc)) remember(key, c);
		return send(req, c);
	},
	websocket: {
		open(ws) {
			const up = new WebSocket(ws.data.url, { headers: ws.data.headers } as any);
			up.binaryType = "nodebuffer" as BinaryType;
			ws.data.upstream = up;
			up.onopen = () => {
				for (const m of ws.data.queue) up.send(m);
				ws.data.queue = [];
			};
			up.onmessage = (e) => ws.send(typeof e.data === "string" ? out(e.data) : (e.data as Buffer));
			up.onclose = (e) => ws.close(e.code === 1005 || e.code === 1006 ? 1000 : e.code, e.reason);
			up.onerror = () => ws.close(1011);
		},
		message(ws, m) {
			const msg = typeof m === "string" ? back(m) : m;
			const up = ws.data.upstream;
			if (up?.readyState === WebSocket.OPEN) up.send(msg);
			else ws.data.queue.push(msg);
		},
		close(ws) {
			ws.data.upstream?.close();
		},
	},
});

console.log(`onion gateway: http://${ONION} -> ${UPSTREAM} as ${PUBLIC.origin} (port ${server.port})`);
