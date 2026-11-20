import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deserializeRswKeypair, generateChallenge, generateRswKeypair, serializeRswKeypair, validateChallenge } from "capjs-core";
import { requestIp } from "./login-history";
import { hit } from "./ratelimit";
import { SECURE } from "./auth";

const SECRET_FILE = process.env.CAP_SECRET_FILE ?? "data/cap-secret";
const RSW_FILE = process.env.CAP_RSW_FILE ?? "data/cap-rsw.json";
const RSW_T = Number(process.env.CAP_RSW_T ?? 10_000);
const COOKIE = "xitter_cap";
const TOKEN_TTL_MS = 20 * 60 * 1000;

function keep<T>(file: string, make: () => T, encode: (v: T) => string, decode: (s: string) => T): T {
	if (existsSync(file)) return decode(readFileSync(file, "utf8"));
	const value = make();
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, encode(value), { mode: 0o600 });
	return value;
}

let secret: string | undefined;
const capSecret = () =>
	(secret ??= process.env.CAP_SECRET || keep(SECRET_FILE, () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex"), (s) => s, (s) => s.trim()));

let keypair: ReturnType<typeof generateRswKeypair> | undefined;
const rswKeypair = () =>
	(keypair ??= keep(RSW_FILE, () => generateRswKeypair(), (k) => JSON.stringify(serializeRswKeypair(k)), (s) => deserializeRswKeypair(JSON.parse(s))));

const nonces = new Map<string, number>();
const tokens = new Map<string, number>();

function sweep(map: Map<string, number>) {
	const now = Date.now();
	for (const [k, until] of map) if (until <= now) map.delete(k);
}

const consumeNonce = (sig: string, ttlMs: number) => {
	sweep(nonces);
	if (nonces.has(sig)) return false;
	nonces.set(sig, Date.now() + ttlMs);
	return true;
};

const cookieOf = (req: Request) => /(?:^|;\s*)xitter_cap=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export async function capRoute(req: Request, path: string): Promise<Response | undefined> {
	if (path === "/i/xitter/cap/widget.js") return new Response(Bun.file("node_modules/cap-widget/cap.min.js"), { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=86400" } });
	const wasm = /^\/i\/xitter\/cap\/(hashwx|cap_wasm_bg)\.wasm$/.exec(path);
	if (wasm) return new Response(Bun.file(`node_modules/@cap.js/wasm/browser/${wasm[1]}.wasm`), { headers: { "content-type": "application/wasm", "cache-control": "public, max-age=86400" } });
	if (path !== "/i/xitter/cap/challenge" && path !== "/i/xitter/cap/redeem") return undefined;
	if (req.method !== "POST") return json({ error: "Use POST." }, 405);
	if (!hit("auth", requestIp(req) ?? "unknown").ok) return json({ error: "Too many tries. Wait a few minutes." }, 429);
	if (path === "/i/xitter/cap/challenge") return json(await generateChallenge(capSecret(), { protocols: ["hashwx", "rsw", "instrumentation"], keypair: rswKeypair(), t: RSW_T }));
	const body = await req.json().catch(() => undefined);
	if (!body || typeof body !== "object") return json({ success: false, reason: "bad_request" }, 400);
	const result = await validateChallenge(capSecret(), body, { consumeNonce, tokenTtlMs: TOKEN_TTL_MS, request: req });
	if (!result.success) return json({ success: false, reason: result.reason }, 403);
	sweep(tokens);
	tokens.set(result.tokenKey, result.expires);
	return json(result, 200, { "set-cookie": `${COOKIE}=${encodeURIComponent(result.token)}; Path=/; Max-Age=${TOKEN_TTL_MS / 1000}; HttpOnly; SameSite=Strict${SECURE}` });
}

export function capPassed(req: Request, spend: boolean): boolean {
	const raw = cookieOf(req);
	if (!raw) return false;
	const [id, verToken] = decodeURIComponent(raw).split(":");
	if (!id || !verToken) return false;
	const key = `${id}:${new Bun.CryptoHasher("sha256").update(verToken).digest("hex")}`;
	const until = tokens.get(key);
	if (spend) tokens.delete(key);
	return !!until && until > Date.now();
}

export const CAP_SCRIPT = String.raw`(function(){
	if(!(window.__XITTER__||{}).cap)return;
	function load(){
		if(document.getElementById("xitter-cap-js"))return;
		window.CAP_CUSTOM_HASHWX_URL="/i/xitter/cap/hashwx.wasm";
		window.CAP_CUSTOM_WASM_URL="/i/xitter/cap/cap_wasm_bg.wasm";
		var s=document.createElement("script");
		s.id="xitter-cap-js";
		s.src="/i/xitter/cap/widget.js";
		document.head.appendChild(s);
	}
	function look(){
		var pw=document.querySelector('input[name="password"][autocomplete="new-password"]');
		if(!pw||!document.querySelector('input[name="username"]')||document.querySelector("cap-widget"))return;
		var field=pw;
		while(field.parentElement&&!field.parentElement.querySelector('input[name="username"]'))field=field.parentElement;
		if(!field.parentElement)return;
		load();
		var st=getComputedStyle(pw),box=getComputedStyle(pw.parentElement);
		var w=document.createElement("cap-widget");
		w.setAttribute("data-cap-api-endpoint","/i/xitter/cap/");
		w.setAttribute("required","");
		w.style.cssText="display:block;margin:16px 0 4px;--cap-widget-width:100%;--cap-background:transparent;--cap-color:"+st.color+";--cap-border-color:"+box.borderColor+";--cap-border-radius:4px;--cap-font:inherit;--cap-checkbox-background:transparent;--cap-checkbox-border:2px solid "+box.borderColor;
		field.after(w);
	}
	new MutationObserver(look).observe(document.documentElement,{childList:true,subtree:true});
	look();
})();`;
