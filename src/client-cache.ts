// Local archive of the pinned web client. Files are stored exactly as the CDN
// served them; patching happens at serve time so the archive stays pristine.

import { existsSync, readFileSync, statSync } from "node:fs";
import { putFile } from "./disk";
import { CappedRead, readLimited } from "./federation";
import { join, normalize } from "node:path";

export const CLIENT_DIR = process.env.CLIENT_DIR ?? "client";
export const CDN_ORIGIN = "https://abs.twimg.com";
const downloads = new Map<string, Promise<Buffer | undefined>>();

function localPath(cdnPath: string): string | undefined {
	const clean = normalize(cdnPath).replace(/^([/\\])+/, "");
	if (clean.startsWith("..")) return undefined;
	return join(CLIENT_DIR, "abs", clean);
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
	if (!p || (existsSync(p) && !statSync(p).isFile())) return undefined;
	let pending = downloads.get(p);
	if (!pending) {
		pending = (async () => {
			const res = await fetch(CDN_ORIGIN + cdnPath);
			if (!res.ok) return undefined;
			try {
				const buf = Buffer.from(await readLimited(res, 16 * 1024 * 1024));
				await putFile(p, buf);
				return buf;
			} catch (e) {
				if (e instanceof CappedRead) {
					console.warn("skipped an oversized client file");
					return undefined;
				}
				throw e;
			}
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
