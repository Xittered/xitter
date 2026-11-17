// Local archive of the pinned web client. Files are stored exactly as the CDN
// served them; patching happens at serve time so the archive stays pristine.

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

// the instance's default build; others can be served next to it (build.ts)
export const CLIENT_DIR = process.env.CLIENT_DIR ?? "client";
// the build a request is served with, chosen per person (server.ts)
const requestDir = new AsyncLocalStorage<string>();
export const clientDir = () => requestDir.getStore() ?? CLIENT_DIR;
export const withClientDir = <T>(dir: string, run: () => T) => requestDir.run(dir, run);
export const CDN_ORIGIN = "https://abs.twimg.com";
// where the client's files live on the CDN; nothing else is fetched for it
const CDN_PATHS = /^\/(responsive-web|x-web|sticky|emoji|fonts|hashflags|images|favicons)\//;
// the biggest file a build has is a few MB; a wasm chat build about ten
const MAX_FILE = 64 * 1024 * 1024;
const downloads = new Map<string, Promise<Buffer | undefined>>();

export const clientPathAllowed = (cdnPath: string) => CDN_PATHS.test(cdnPath);

export function hasClientFile(cdnPath: string): boolean {
	const p = localPath(cdnPath);
	return !!p && existsSync(p) && statSync(p).isFile();
}

// the body in pieces, or undefined once it passes max
async function readUpTo(res: Response, max: number): Promise<Buffer | undefined> {
	if (Number(res.headers.get("content-length") ?? 0) > max) return undefined;
	const reader = res.body?.getReader();
	if (!reader) return Buffer.alloc(0);
	const parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => {});
			return undefined;
		}
		parts.push(value);
	}
	return Buffer.concat(parts);
}

function localPath(cdnPath: string): string | undefined {
	const clean = normalize(cdnPath).replace(/^([/\\])+/, "");
	if (clean.startsWith("..")) return undefined;
	return join(clientDir(), "abs", clean);
}

export function readCached(cdnPath: string): Buffer | undefined {
	const p = localPath(cdnPath);
	// a directory (someone asked for /abs/.../) is not a file to serve
	return p && existsSync(p) && statSync(p).isFile() ? readFileSync(p) : undefined;
}

// Returns the file from the archive, downloading it from the CDN on first use.
export async function getClientFile(cdnPath: string, allowFetch = true): Promise<Buffer | undefined> {
	const cached = readCached(cdnPath);
	if (cached || !allowFetch) return cached;
	const p = localPath(cdnPath);
	if (!p || !clientPathAllowed(cdnPath) || (existsSync(p) && !statSync(p).isFile())) return undefined;
	let pending = downloads.get(p);
	if (!pending) {
		pending = (async () => {
			const res = await fetch(CDN_ORIGIN + cdnPath, { signal: AbortSignal.timeout(60_000) });
			if (!res.ok) return undefined;
			const buf = await readUpTo(res, MAX_FILE);
			if (!buf) return undefined;
			mkdirSync(dirname(p), { recursive: true });
			writeFileSync(p, buf);
			return buf;
		})();
		downloads.set(p, pending);
		void pending.then(() => downloads.delete(p), () => downloads.delete(p));
	}
	return pending;
}

export async function getClientFilePath(cdnPath: string): Promise<string | undefined> {
	const p = localPath(cdnPath);
	if (!p) return undefined;
	if (existsSync(p)) return statSync(p).isFile() ? p : undefined;
	return (await getClientFile(cdnPath)) ? p : undefined;
}
