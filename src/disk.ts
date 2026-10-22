// Free space for MEDIA_DIR and the only way a public file gets its bytes.
// A crash before rename leaves the previous file in place.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { appendFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { STORAGE_SENTENCE } from "./notices";

export { STORAGE_SENTENCE };

export const WRITE_MARGIN = 1024 * 1024;

export class StorageFailure extends Error {
	readonly kind = "storage" as const;
	constructor(cause?: unknown) {
		super(STORAGE_SENTENCE, cause === undefined ? undefined : { cause });
		this.name = "StorageFailure";
	}
}

export type Statfs = { bavail: bigint | number; blocks: bigint | number; bsize: bigint | number };

export type Space = { free: bigint; total: bigint; warn: boolean };

type WriteFn = (path: string, bytes: Uint8Array) => void;
type StatFn = (path: string) => Statfs | Promise<Statfs>;
type Hooks = { statfs?: StatFn; write?: WriteFn };

// bun test runs files in one process, so a global fake would leak into other files
const hooks = new AsyncLocalStorage<Hooks>();

export function useDisk<T>(hook: Hooks, run: () => T | Promise<T>): Promise<T> {
	return Promise.resolve(hooks.run(hook, run));
}

export function useStatfs<T>(fn: StatFn, run: () => T | Promise<T>): Promise<T> {
	return useDisk({ statfs: fn }, run);
}

const STORAGE_CODES = new Set(["ENOSPC", "EDQUOT", "EROFS"]);

export function storageCode(e: unknown): string | undefined {
	const seen = new Set<unknown>();
	let cur: unknown = e;
	while (cur && typeof cur === "object" && !seen.has(cur)) {
		seen.add(cur);
		const code = (cur as { code?: unknown }).code;
		if (typeof code === "string" && STORAGE_CODES.has(code)) return code;
		cur = (cur as { cause?: unknown }).cause;
	}
	return undefined;
}

function mediaRoot(): string {
	return process.env.MEDIA_DIR ?? "media";
}

function asBig(n: bigint | number): bigint {
	return typeof n === "bigint" ? n : BigInt(Math.trunc(n));
}

export function minFreeBytes(total: bigint): bigint {
	const raw = Number(process.env.MEDIA_MIN_FREE_MB ?? 512);
	const mb = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 512;
	let reserve = BigInt(mb) * 1024n * 1024n;
	const pct = Number(process.env.MEDIA_MIN_FREE_PERCENT ?? "");
	if (Number.isFinite(pct) && pct > 0 && pct <= 100 && total > 0n) {
		const fromPct = (total * BigInt(Math.floor(pct))) / 100n;
		if (fromPct > reserve) reserve = fromPct;
	}
	return reserve;
}

function realStatfs(path: string): Statfs {
	return statfsSync(path, { bigint: true });
}

function existingDir(path: string): string {
	let dir = path;
	while (!existsSync(dir)) {
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return dir;
}

async function statAt(path: string): Promise<Statfs> {
	const fn = hooks.getStore()?.statfs ?? realStatfs;
	const at = existingDir(path);
	try {
		return await fn(at);
	} catch (e) {
		if (fn === realStatfs && (e as { code?: string }).code === "ENOENT" && at === mediaRoot()) {
			mkdirSync(at, { recursive: true });
			return await fn(at);
		}
		throw e;
	}
}

export async function space(dir = mediaRoot()): Promise<Space> {
	const s = await statAt(dir);
	const free = asBig(s.bavail) * asBig(s.bsize);
	const total = asBig(s.blocks) * asBig(s.bsize);
	const warn = free < minFreeBytes(total) || (total > 0n && free * 10n < total);
	return { free, total, warn };
}

export async function roomFor(want: number, dir = mediaRoot()): Promise<void> {
	if (!Number.isFinite(want) || want < 0) throw new StorageFailure();
	const s = await space(dir);
	if (s.free < BigInt(Math.ceil(want)) + minFreeBytes(s.total)) throw new StorageFailure();
}

function remove(path: string) {
	rmSync(path, { recursive: true, force: true });
}

function writeBytes(path: string, bytes: Uint8Array) {
	const write = hooks.getStore()?.write;
	if (write) write(path, bytes);
	else writeFileSync(path, bytes);
}

function tempPath(finalPath: string): string {
	return `${finalPath}.${randomBytes(8).toString("hex")}.tmp`;
}

function failWrite(e: unknown, tmp: string, cleanup: readonly string[]): never {
	remove(tmp);
	if (e instanceof StorageFailure || storageCode(e)) {
		for (const path of cleanup) remove(path);
		if (e instanceof StorageFailure) throw e;
		throw new StorageFailure(e);
	}
	throw e;
}

export async function putFile(finalPath: string, bytes: Uint8Array, cleanup: readonly string[] = []): Promise<void> {
	await roomFor(bytes.byteLength, dirname(finalPath));
	const tmp = tempPath(finalPath);
	try {
		mkdirSync(dirname(finalPath), { recursive: true });
		writeBytes(tmp, bytes);
		renameSync(tmp, finalPath);
	} catch (e) {
		failWrite(e, tmp, cleanup);
	}
}

// a chunk added to a file that already exists. a full disk rewinds to the previous size.
export async function appendBytes(file: string, data: Uint8Array, rewindTo: number): Promise<void> {
	await roomFor(data.byteLength, dirname(file));
	const write = hooks.getStore()?.write;
	try {
		if (write) write(file, data);
		else await appendFile(file, data);
	} catch (e) {
		if (e instanceof StorageFailure || storageCode(e)) {
			await truncate(file, rewindTo).catch(() => {});
			if (e instanceof StorageFailure) throw e;
			throw new StorageFailure(e);
		}
		throw e;
	}
}

export function diskEdge(prev: boolean, warn: boolean): { next: boolean; event?: "low" | "ok" } {
	if (warn === prev) return { next: prev };
	return { next: warn, event: warn ? "low" : "ok" };
}

let diskLow = false;
export function watchDisk() {
	const tick = async () => {
		try {
			const edge = diskEdge(diskLow, (await space()).warn);
			diskLow = edge.next;
			if (edge.event === "low") console.warn("media disk is low on free space");
			if (edge.event === "ok") console.warn("media disk has free space again");
		} catch (e) {
			console.error(e);
		}
	};
	const timer = setInterval(tick, 5 * 60_000);
	timer.unref?.();
}

export async function putStream(
	finalPath: string,
	write: (tmp: string) => void | Promise<void>,
	cleanup: readonly string[] = [],
	bytes?: number,
): Promise<void> {
	if (bytes !== undefined) await roomFor(bytes, dirname(finalPath));
	const tmp = tempPath(finalPath);
	try {
		mkdirSync(dirname(finalPath), { recursive: true });
		await write(tmp);
		renameSync(tmp, finalPath);
	} catch (e) {
		failWrite(e, tmp, cleanup);
	}
}
