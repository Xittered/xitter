// Brotli or gzip for text responses. Nothing was compressed before: the client's
// entry scripts went out as 2.7 MB, the page shell as 400 KB and a timeline
// page as 100-300 KB of JSON, all of which shrink to a fifth or less.
//
// The client's own files are compressed once and kept (compressedFile);
// everything else is compressed per response, quickly, off the main thread.

import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

export type Encoding = "br" | "gzip";

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);

const COMPRESSIBLE = /^(text\/(?!event-stream)|application\/(json|javascript|manifest\+json|xml)|image\/svg\+xml)/;
// below this the headers outweigh what compression saves
const MIN_BYTES = 1024;

export function acceptedEncoding(req: Request): Encoding | undefined {
	const accept = req.headers.get("accept-encoding");
	if (!accept) return undefined;
	const offered = (name: string) => accept.split(",").some((part) => {
		const [token, ...params] = part.trim().split(";");
		return token.trim().toLowerCase() === name && !params.some((p) => /^\s*q=0(\.0*)?\s*$/.test(p));
	});
	return offered("br") ? "br" : offered("gzip") ? "gzip" : undefined;
}

// quality 4 is about as fast as gzip's default and smaller; the client's own
// files are worth more time since they are compressed once
function encode(body: Uint8Array, encoding: Encoding, once: boolean): Promise<Buffer> {
	if (encoding === "gzip") return gz(body, { level: once ? 9 : 6 });
	return brotli(body, {
		params: {
			[constants.BROTLI_PARAM_QUALITY]: once ? 9 : 4,
			[constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
			[constants.BROTLI_PARAM_SIZE_HINT]: body.byteLength,
		},
	});
}

// Keyed by the patched file's buffer (patch.ts keeps it while it is cached), so
// a compressed copy goes when its file leaves that cache.
const compressed = new WeakMap<Buffer, Partial<Record<Encoding, Promise<Buffer>>>>();
export function compressedFile(body: Buffer, encoding: Encoding): Promise<Buffer> {
	let slot = compressed.get(body);
	if (!slot) compressed.set(body, (slot = {}));
	let job = slot[encoding];
	if (!job) {
		job = encode(body, encoding, true);
		slot[encoding] = job;
		job.catch(() => delete slot![encoding]);
	}
	return job;
}

// Federation and migration answers are signed and read by other instances,
// and the realm proxy passes another server's answer through: those stay as they are.
const UNTOUCHED = /^\/(federation\/|migration\/|\.well-known\/xitter|juicebox\/)/;

export async function compressResponse(req: Request, res: Response, pathname: string): Promise<Response> {
	if (req.method === "HEAD" || !res.body || res.status === 204 || res.status === 304 || res.headers.has("content-encoding") || res.headers.get("x-accel-buffering") === "no") return res;
	if (!COMPRESSIBLE.test(res.headers.get("content-type") ?? "") || UNTOUCHED.test(pathname)) return res;
	const length = Number(res.headers.get("content-length") ?? NaN);
	if (length < MIN_BYTES) return res;
	const encoding = acceptedEncoding(req);
	if (!encoding) {
		// a proxied answer's headers can't be changed; it isn't cached anyway
		try {
			res.headers.append("vary", "accept-encoding");
		} catch {}
		return res;
	}
	const body = new Uint8Array(await res.arrayBuffer());
	const headers = new Headers(res.headers);
	headers.append("vary", "accept-encoding");
	if (body.byteLength < MIN_BYTES) return new Response(body, { status: res.status, statusText: res.statusText, headers });
	headers.set("content-encoding", encoding);
	headers.delete("content-length");
	return new Response(await encode(body, encoding, false), { status: res.status, statusText: res.statusText, headers });
}
