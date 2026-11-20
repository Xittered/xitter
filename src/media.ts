// Uploads: the client's chunked upload (INIT, APPEND, FINALIZE, STATUS),
// storage on disk, serving, and the media objects attached to posts.
// Images are stored as uploaded (a GIF may be cropped first, and with
// compression on a photo is made smaller by media-compress.ts); GIFs are served
// as images, so they animate without a video conversion step. Videos are
// converted by video.ts.

import { conversationVideoMap } from "./conversation-cards";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import type { SQL } from "bun";
import type { Viewer } from "./auth";
import { remoteMediaFile } from "./federation-sync";
import { MAX_POST_MEDIA, PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "./config";
import { blockedFor, protectedFor, suspendedFor } from "./blocks";
import { isStaffRequest, staffViewer } from "./staff-access";
import { circleSeen } from "./circles";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { settings } from "./settings";
import { gifProxy } from "./gifs";
import { compressUpload } from "./media-compress";
import { cropGif, FFMPEG, maxVideoBytes, posterFile, progress, queueVideo, sourceFile, spawnLimited, videoError, videoSupported } from "./video";

export const MEDIA_DIR = process.env.MEDIA_DIR ?? "media";
const maxImage = () => settings().limits.image_mb * 1024 * 1024;
const MAX_GIF = 15 * 1024 * 1024;
const LEGACY_CLIENT_TOP_BITRATE = 2_176_000;
const MAX_PENDING_MS = 60 * 60 * 1000;

type Pending = { userId: string; total: number; category: string; video: boolean; chunks: Map<number, number>; received: number; started: number };
const pending = new Map<string, Pending>();
const finalizing = new Map<string, Pending>();
// Reserve source-URL downloads before their first await, then keep the slot
// through assembly. They must share the same per-account work limit.
const sourceUploads = new Map<string, string>();
const pendingDir = (id: string) => join(MEDIA_DIR, ".pending", id);
const segmentFile = (id: string, index: number) => join(pendingDir(id), String(index));

function discardPending(id: string) {
	pending.delete(id);
	rmSync(pendingDir(id), { recursive: true, force: true });
}

setInterval(() => {
	const now = Date.now();
	for (const [id, p] of pending) if (now - p.started > MAX_PENDING_MS) discardPending(id);
	const dir = join(MEDIA_DIR, ".pending");
	if (!existsSync(dir)) return;
	for (const id of readdirSync(dir)) {
		if (!/^\d{1,19}$/.test(id) || pending.has(id) || finalizing.has(id)) continue;
		const path = pendingDir(id);
		try {
			if (now - statSync(path).mtimeMs > MAX_PENDING_MS) rmSync(path, { recursive: true, force: true });
		} catch {}
	}
}, 60_000).unref();

export type MediaRow = {
	id: string;
	kind: string;
	mime: string;
	size: number;
	width: number;
	height: number;
	position: number | null;
	duration_ms: number | null;
	alt_text?: string | null;
	sensitive_warning?: string[] | null;
};

export type Image = { mime: string; width: number; height: number };

// The only types media goes out as. A file stored under any other (a peer
// claiming image/svg+xml for a script) is sent as bytes, and none of it may run
// anything when opened on its own.
const SERVED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "video/mp4"]);
export const servedType = (mime: string) => (SERVED_TYPES.has(mime) ? mime : "application/octet-stream");
export const MEDIA_CSP = "default-src 'none'; sandbox";

// type and dimensions from the file header; nothing else is trusted
export function sniffImage(b: Buffer): Image | undefined {
	if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { mime: "image/png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
	if (b.length >= 10 && b.toString("latin1", 0, 3) === "GIF") return { mime: "image/gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
	if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
		const chunk = b.toString("latin1", 12, 16);
		if (chunk === "VP8X") return { mime: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
		if (chunk === "VP8L") {
			const bits = b.readUInt32LE(21);
			return { mime: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
		}
		if (chunk === "VP8 ") return { mime: "image/webp", width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
	}
	if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
		// walk segments to the first start-of-frame marker
		let i = 2;
		while (i + 9 < b.length) {
			if (b[i] !== 0xff) return undefined;
			const marker = b[i + 1];
			const len = b.readUInt16BE(i + 2);
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
				return { mime: "image/jpeg", width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
			i += 2 + len;
		}
	}
	return undefined;
}

// custom badges: GIFs are kept as uploaded, so animated ones play wherever the badge shows
export const BADGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

const fileOf = (id: string) => join(MEDIA_DIR, id);
const EXT: Record<string, string> = { "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/jpeg": "jpg" };

export const THEME_BACKGROUND = "theme_background";
export const THEME_PHOTO_MAX = 8 * 1024 * 1024;
export const THEME_EDGE_MAX = 4096;
export const THEME_FRAME_PIXELS = 40_000_000;

export type ThemeMime = "image/png" | "image/gif" | "image/webp" | "image/jpeg";
export type ImgExt = "png" | "gif" | "webp" | "jpg";
export type ThemePhoto = { readonly mime: ThemeMime; readonly ext: ImgExt; readonly width: number; readonly height: number; readonly bytes: Buffer };
export type ThemePhotoResult = { readonly ok: true; readonly photo: ThemePhoto } | { readonly ok: false; readonly message: string };

const PNG_KEEP = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "sRGB", "cHRM", "bKGD", "pHYs", "sBIT"]);

function skipGifSubs(b: Buffer, i: number): number | undefined {
	while (i < b.length) {
		const n = b[i]!;
		i += 1;
		if (n === 0) return i;
		i += n;
		if (i > b.length) return;
	}
	return;
}

function gifFrames(b: Buffer): { frames: number; trailer: number } | undefined {
	if (b.length < 13 || b.toString("latin1", 0, 3) !== "GIF") return;
	let i = 13;
	if (b[10]! & 0x80) i += 3 * (1 << ((b[10]! & 7) + 1));
	if (i > b.length) return;
	let frames = 0;
	while (i < b.length) {
		const block = b[i]!;
		if (block === 0x3b) return { frames, trailer: i };
		if (block === 0x21) {
			if (i + 2 > b.length) return;
			i += 2;
			const next = skipGifSubs(b, i);
			if (next === undefined) return;
			i = next;
			continue;
		}
		if (block === 0x2c) {
			if (i + 10 > b.length) return;
			const packed = b[i + 9]!;
			i += 10;
			if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1));
			if (i >= b.length) return;
			i += 1;
			const next = skipGifSubs(b, i);
			if (next === undefined) return;
			i = next;
			frames += 1;
			continue;
		}
		return;
	}
	return;
}

// APP1, APP13, and COM are where a JPEG hides EXIF, IPTC, and comments. PNG text chunks and WebP EXIF/XMP are the same kind of passenger, so the rebuilt file is the picture without them.
function stripJpeg(b: Buffer): Buffer | undefined {
	if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return;
	const parts: Buffer[] = [b.subarray(0, 2)];
	let i = 2;
	while (i + 1 < b.length) {
		if (b[i] !== 0xff) return;
		const marker = b[i + 1]!;
		if (marker === 0xd9) {
			parts.push(b.subarray(i, i + 2));
			break;
		}
		if (marker === 0xda) {
			parts.push(b.subarray(i));
			break;
		}
		if (marker === 0xff) {
			i += 1;
			continue;
		}
		if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			parts.push(b.subarray(i, i + 2));
			i += 2;
			continue;
		}
		if (i + 4 > b.length) return;
		const len = b.readUInt16BE(i + 2);
		if (len < 2 || i + 2 + len > b.length) return;
		const drop = marker === 0xe1 || marker === 0xed || marker === 0xfe;
		if (!drop) parts.push(b.subarray(i, i + 2 + len));
		i += 2 + len;
	}
	return Buffer.concat(parts);
}

function stripPng(b: Buffer): Buffer | undefined {
	const sig = b.subarray(0, 8);
	if (sig.length < 8 || sig[0] !== 0x89 || sig.toString("latin1", 1, 4) !== "PNG") return;
	const parts: Buffer[] = [b.subarray(0, 8)];
	let i = 8;
	let sawEnd = false;
	while (i + 12 <= b.length) {
		const len = b.readUInt32BE(i);
		if (len > b.length || i + 12 + len > b.length) return;
		const type = b.toString("latin1", i + 4, i + 8);
		const chunk = b.subarray(i, i + 12 + len);
		i += 12 + len;
		if (PNG_KEEP.has(type)) parts.push(chunk);
		if (type === "IEND") {
			sawEnd = true;
			break;
		}
	}
	if (!sawEnd) return;
	return Buffer.concat(parts);
}

function stripWebp(b: Buffer): Buffer | undefined {
	if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP") return;
	const chunks: Buffer[] = [];
	let i = 12;
	while (i + 8 <= b.length) {
		const id = b.toString("latin1", i, i + 4);
		const size = b.readUInt32LE(i + 4);
		const end = i + 8 + size + (size & 1);
		if (end > b.length) return;
		if (id !== "EXIF" && id !== "XMP ") chunks.push(b.subarray(i, end));
		i = end;
	}
	const body = Buffer.concat(chunks);
	const out = Buffer.alloc(12 + body.length);
	out.write("RIFF", 0, "latin1");
	out.writeUInt32LE(4 + body.length, 4);
	out.write("WEBP", 8, "latin1");
	body.copy(out, 12);
	return out;
}

export function acceptThemePhoto(data: Buffer): ThemePhotoResult {
	const image = sniffImage(data);
	if (!image || !EXT[image.mime]) return { ok: false, message: "unsupported image" };
	if (data.length > THEME_PHOTO_MAX) return { ok: false, message: "image is too large" };
	if (image.width < 1 || image.height < 1 || image.width > THEME_EDGE_MAX || image.height > THEME_EDGE_MAX) return { ok: false, message: "image is too large" };
	let frames = 1;
	if (image.mime === "image/gif") {
		const walked = gifFrames(data);
		if (!walked || walked.frames < 1) return { ok: false, message: "image could not be read" };
		const tail = data.toString("latin1", walked.trailer + 1);
		if (/<script|<html|javascript:/i.test(tail)) return { ok: false, message: "unsupported image" };
		frames = walked.frames;
	}
	const pixels = image.width * image.height * frames;
	if (!Number.isFinite(pixels) || pixels > THEME_FRAME_PIXELS) return { ok: false, message: "image is too large" };
	let bytes = data;
	if (image.mime === "image/jpeg") {
		const stripped = stripJpeg(data);
		if (!stripped || !sniffImage(stripped)) return { ok: false, message: "image could not be read" };
		bytes = stripped;
	} else if (image.mime === "image/png") {
		const stripped = stripPng(data);
		if (!stripped || !sniffImage(stripped)) return { ok: false, message: "image could not be read" };
		bytes = stripped;
	} else if (image.mime === "image/webp") {
		const stripped = stripWebp(data);
		if (!stripped || !sniffImage(stripped)) return { ok: false, message: "image could not be read" };
		bytes = stripped;
	}
	return {
		ok: true,
		photo: { mime: image.mime as ThemeMime, ext: EXT[image.mime] as ImgExt, width: image.width, height: image.height, bytes },
	};
}

async function writeThemePoster(id: string): Promise<boolean> {
	const dest = posterFile(MEDIA_DIR, id);
	try {
		const proc = Bun.spawn(["ffmpeg", "-y", "-i", fileOf(id), "-frames:v", "1", "-q:v", "3", dest], { stdout: "ignore", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill(), 8000);
		const code = await proc.exited;
		clearTimeout(timer);
		if (code !== 0) {
			rmSync(dest, { force: true });
			return false;
		}
		return true;
	} catch {
		rmSync(dest, { force: true });
		return false;
	}
}

export async function storeThemePhoto(id: string, userId: string, data: Buffer): Promise<{ ok: true; ext: ImgExt; mime: ThemeMime; width: number; height: number; size: number } | { ok: false; message: string }> {
	if (!isId(id)) return { ok: false, message: "invalid media id" };
	const got = acceptThemePhoto(data);
	if (!got.ok) return got;
	mkdirSync(MEDIA_DIR, { recursive: true });
	writeFileSync(fileOf(id), got.photo.bytes);
	try {
		await sql`insert into media (id, user_id, kind, mime, size, width, height, detached)
			values (${id}::bigint, ${userId}::bigint, 'photo', ${got.photo.mime}, ${got.photo.bytes.length}, ${got.photo.width}, ${got.photo.height}, true)`;
	} catch {
		rmSync(fileOf(id), { force: true });
		return { ok: false, message: "could not store the image" };
	}
	if (got.photo.mime === "image/gif") await writeThemePoster(id);
	return { ok: true, ext: got.photo.ext, mime: got.photo.mime, width: got.photo.width, height: got.photo.height, size: got.photo.bytes.length };
}

export type OwnedPhoto = { readonly ext: ImgExt; readonly poster: boolean };

export async function ownedThemePhoto(userId: string, id: string): Promise<OwnedPhoto | undefined> {
	if (!isId(id)) return;
	const [row] = await sql`select mime, kind, state, detached, post_id::text as post from media where id = ${id}::bigint and user_id = ${userId}::bigint`;
	if (!row || row.kind !== "photo" || row.state !== "ready" || !row.detached || row.post) return;
	const ext = EXT[row.mime];
	if (ext !== "png" && ext !== "gif" && ext !== "webp" && ext !== "jpg") return;
	return { ext, poster: existsSync(posterFile(MEDIA_DIR, id)) };
}

export function themeMediaPath(id: string, ext: ImgExt): `/media/${string}.${ImgExt}` {
	return `/media/${id}.${ext}`;
}

export function themePosterPath(id: string): `/media/poster/${string}.jpg` {
	return `/media/poster/${id}.jpg`;
}
const EXT_VIDEO: Record<string, string> = { "video/mp4": "mp4" };
export const mediaUrl = (id: string, mime: string) => `${PUBLIC_ORIGIN}/media/${id}.${EXT[mime] ?? EXT_VIDEO[mime] ?? "bin"}`;
export const posterUrl = (id: string) => `${PUBLIC_ORIGIN}/media/poster/${id}.jpg`;
// stored paths are relative so the instance can move to another domain
export const absolute = (path: string | null) => (path?.startsWith("/") ? PUBLIC_ORIGIN + path : path);

const MAX_PENDING_PER_USER = 8;
const MAX_SEGMENTS = 10_000;

function activeUploadCount(userId: string): number {
	const ids = new Set<string>();
	for (const [id, p] of pending) if (p.userId === userId) ids.add(id);
	for (const [id, p] of finalizing) if (p.userId === userId) ids.add(id);
	for (const [id, owner] of sourceUploads) if (owner === userId) ids.add(id);
	return ids.size;
}

const uploadError = (message: string, status = 400) => Response.json({ error: message, errors: [{ code: 324, message }] }, { status });

async function params(req: Request, url: URL): Promise<{ fields: Record<string, string>; file?: Buffer }> {
	const fields: Record<string, string> = Object.fromEntries(url.searchParams);
	let file: Buffer | undefined;
	const type = req.headers.get("content-type") ?? "";
	if (req.method === "POST" && /multipart\/form-data|x-www-form-urlencoded/.test(type)) {
		const form = await req.formData();
		for (const [k, v] of form) {
			if (typeof v === "string") fields[k] = v;
			else if (k === "media") file = Buffer.from(await v.arrayBuffer());
		}
	}
	if (!file && fields.media_data) file = Buffer.from(fields.media_data, "base64");
	return { fields, file };
}

function idFields(id: string) {
	// media_id as a number loses precision in JSON; clients read media_id_string
	return { media_id: Number(id), media_id_string: id, media_key: `3_${id}` };
}

// A GIF the client was asked to crop (an avatar or banner) arrives whole, with
// "xitter-crop:left,top,width,height" after the GIF trailer (patch.ts). If
// ffmpeg is missing or fails, the uncropped GIF is kept: avatars are drawn
// center-cropped anyway.
const CROP_NOTE = /xitter-crop:(\d+),(\d+),(\d+),(\d+)$/;
// the header's canvas size, which every decoded frame takes in ffmpeg; anyone
// can add the note, and a 15 MB GIF can claim 65535x65535
const MAX_CROP_PIXELS = 2048 * 2048;

async function croppedGif(id: string, data: Buffer, image: Image): Promise<{ data: Buffer; image: Image }> {
	const note = CROP_NOTE.exec(data.toString("latin1", Math.max(0, data.length - 64)));
	if (!note) return { data, image };
	const gif = data.subarray(0, data.length - note[0].length);
	if (image.width < 1 || image.height < 1 || image.width * image.height > MAX_CROP_PIXELS) return { data: gif, image };
	const [left, top, width, height] = note.slice(1).map(Number);
	const x = Math.min(left, image.width - 1);
	const y = Math.min(top, image.height - 1);
	const w = Math.max(1, Math.min(width, image.width - x));
	const h = Math.max(1, Math.min(height, image.height - y));
	if (x === 0 && y === 0 && w === image.width && h === image.height) return { data: gif, image };
	const out = await cropGif(MEDIA_DIR, id, gif, { x, y, w, h });
	const cropped = out && sniffImage(out);
	return out && cropped ? { data: out, image: cropped } : { data: gif, image };
}

async function finalize(id: string, p: Pending): Promise<Response> {
	pending.delete(id);
	finalizing.set(id, p);
	try {
		if (p.received !== p.total) return uploadError("File size does not match the size announced at INIT.");
		const parts = [...p.chunks.keys()].sort((a, b) => a - b);
		mkdirSync(MEDIA_DIR, { recursive: true });
		const assembled = p.video ? sourceFile(MEDIA_DIR, id) : fileOf(id);
		const output = await open(assembled, "w");
		try {
			const buffer = Buffer.allocUnsafe(64 * 1024);
			for (const index of parts) {
				const input = await open(segmentFile(id, index), "r");
				try {
					for (;;) {
						const { bytesRead } = await input.read(buffer, 0, buffer.length, null);
						if (!bytesRead) break;
						let offset = 0;
						while (offset < bytesRead) offset += (await output.write(buffer, offset, bytesRead - offset, null)).bytesWritten;
					}
				} finally {
					await input.close();
				}
			}
		} finally {
			await output.close();
		}
		if (statSync(assembled).size !== p.total) {
			rmSync(assembled, { force: true });
			return uploadError("File size does not match the size announced at INIT.");
		}
		if (p.video) {
			await sql`insert into media (id, user_id, kind, mime, size, width, height, state)
				values (${id}::bigint, ${p.userId}::bigint, 'video', 'video/mp4', ${p.total}, 0, 0, 'processing')`;
			queueVideo(MEDIA_DIR, id);
			return Response.json({ ...idFields(id), size: p.total, expires_after_secs: 86400, processing_info: { state: "pending", check_after_secs: 1 } });
		}
		let data: Buffer<ArrayBufferLike> = readFileSync(assembled);
		if (p.category === THEME_BACKGROUND) {
			const stored = await storeThemePhoto(id, p.userId, data);
			if (!stored.ok) {
				rmSync(assembled, { force: true });
				return uploadError(stored.message);
			}
			return Response.json({
				...idFields(id),
				size: stored.size,
				expires_after_secs: 86400,
				image: { image_type: stored.mime, w: stored.width, h: stored.height },
				theme_path: themeMediaPath(id, stored.ext),
			});
		}
		let image = sniffImage(data);
		if (!image) {
			rmSync(assembled, { force: true });
			return uploadError("Unsupported file. Images only: JPEG, PNG, GIF or WebP.");
		}
		if (data.length > (image.mime === "image/gif" ? MAX_GIF : maxImage())) {
			rmSync(assembled, { force: true });
			return uploadError("File is too large.");
		}
		if (image.mime === "image/gif") ({ data, image } = await croppedGif(id, data, image));
		let compressed: boolean;
		({ data, image, compressed } = await compressUpload(data, image));
		writeFileSync(fileOf(id), data);
		await sql`insert into media (id, user_id, kind, mime, size, width, height, compressed)
			values (${id}::bigint, ${p.userId}::bigint, 'photo', ${image.mime}, ${data.length}, ${image.width}, ${image.height}, ${compressed})`;
		return Response.json({
			...idFields(id),
			size: data.length,
			expires_after_secs: 86400,
			image: { image_type: image.mime, w: image.width, h: image.height },
			...(/gif|video/.test(p.category) ? { processing_info: { state: "succeeded", progress_percent: 100 } } : {}),
		});
	} finally {
		rmSync(pendingDir(id), { recursive: true, force: true });
		finalizing.delete(id);
	}
}

export async function mediaUpload(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	const { fields, file } = await params(req, url);
	const id = fields.media_id;

	switch (fields.command) {
		case "INIT": {
			const themeBg = (fields.media_category ?? "") === THEME_BACKGROUND;
			if (themeBg && fields.source_url) return uploadError("Theme backgrounds are uploaded as files.");
			if (fields.source_url) {
				let source: URL;
				try {
					source = new URL(fields.source_url, PUBLIC_ORIGIN);
				} catch {
					return uploadError("Invalid GIF source URL.");
				}
				let ownOrigin: string;
				try {
					ownOrigin = new URL(PUBLIC_ORIGIN).origin;
				} catch {
					return uploadError("Server public origin is not configured correctly.", 500);
				}
				if (source.origin !== ownOrigin || source.pathname !== "/i/api/xitter/gif" || !source.searchParams.get("u")) {
					return uploadError("GIF uploads must use this instance's GIF proxy.", 403);
				}
				if (activeUploadCount(viewer.id) >= MAX_PENDING_PER_USER) return uploadError("Finish your other uploads first.", 429);
				const newMedia = newId();
				sourceUploads.set(newMedia, viewer.id);
				try {
					const response = await gifProxy(source);
					if (!response.ok || !response.body) return uploadError("Could not download the selected GIF.");
					const announcedSize = Number(response.headers.get("content-length"));
					if (Number.isFinite(announcedSize) && announcedSize > MAX_GIF) {
						await response.body.cancel();
						return uploadError("File is too large.");
					}
					const reader = response.body.getReader();
					const chunks: Buffer[] = [];
					let size = 0;
					try {
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							size += value.byteLength;
							if (size > MAX_GIF) {
								await reader.cancel();
								return uploadError("File is too large.");
							}
							chunks.push(Buffer.from(value));
						}
					} finally {
						reader.releaseLock();
					}
					const data = Buffer.concat(chunks, size);
					const image = sniffImage(data);
					if (!image || image.mime !== "image/gif") return uploadError("The selected source is not a valid GIF.");
					mkdirSync(pendingDir(newMedia), { recursive: true });
					writeFileSync(segmentFile(newMedia, 0), data);
					return await finalize(newMedia, {
						userId: viewer.id,
						total: data.length,
						category: fields.media_category ?? "tweet_gif",
						video: false,
						chunks: new Map([[0, data.length]]),
						received: data.length,
						started: Date.now(),
					});
				} finally {
					sourceUploads.delete(newMedia);
				}
			}
			const total = Number(fields.total_bytes);
			const video = /^video\//.test(fields.media_type ?? "") || /video/.test(fields.media_category ?? "");
			if (themeBg && video) return uploadError("Theme backgrounds are images.");
			if (video && !(await videoSupported())) return uploadError("Video uploads are not available on this server.");
			if (!video && fields.media_type && !/^image\//.test(fields.media_type)) return uploadError("Only images and videos can be uploaded.");
			const cap = themeBg ? THEME_PHOTO_MAX : video ? maxVideoBytes() : MAX_GIF;
			if (!Number.isInteger(total) || total <= 0 || total > cap) return uploadError("File is too large or empty.");
			if (activeUploadCount(viewer.id) >= MAX_PENDING_PER_USER) return uploadError("Finish your other uploads first.", 429);
			const newMedia = newId();
			pending.set(newMedia, { userId: viewer.id, total, category: fields.media_category ?? "", video, chunks: new Map(), received: 0, started: Date.now() });
			return Response.json({ ...idFields(newMedia), expires_after_secs: 86400 }, { status: 202 });
		}
		case "APPEND": {
			const p = id ? pending.get(id) : undefined;
			if (!p || p.userId !== viewer.id) return uploadError("Unknown upload.", 404);
			if (!file) return uploadError("No data in APPEND.");
			const index = Number(fields.segment_index ?? 0);
			if (!Number.isInteger(index) || index < 0 || index > MAX_SEGMENTS) return uploadError("Bad segment_index.");
			const received = p.received - (p.chunks.get(index) ?? 0) + file.length;
			if (received > p.total) return uploadError("More data than announced at INIT.");
			mkdirSync(pendingDir(id!), { recursive: true });
			writeFileSync(segmentFile(id!, index), file);
			p.chunks.set(index, file.length);
			p.received = received;
			return new Response(null, { status: 204 });
		}
		// the video uploader: one blob holding the consecutive segments listed in
		// segment_indexes, checked against media_md5; kept under its first index
		case "APPENDMULTI": {
			const p = id ? pending.get(id) : undefined;
			if (!p || p.userId !== viewer.id) return uploadError("Unknown upload.", 404);
			if (!file) return uploadError("No data in APPENDMULTI.");
			const first = Number((fields.segment_indexes ?? "0").split(",")[0]);
			if (!Number.isInteger(first) || first < 0 || first > MAX_SEGMENTS) return uploadError("Bad segment_indexes.");
			if (fields.media_md5 && new Bun.CryptoHasher("md5").update(file).digest("hex") !== fields.media_md5.toLowerCase())
				return uploadError("Segment checksum does not match.");
			const received = p.received - (p.chunks.get(first) ?? 0) + file.length;
			if (received > p.total) return uploadError("More data than announced at INIT.");
			mkdirSync(pendingDir(id!), { recursive: true });
			writeFileSync(segmentFile(id!, first), file);
			p.chunks.set(first, file.length);
			p.received = received;
			return new Response(null, { status: 204 });
		}
		case "FINALIZE": {
			if (id && finalizing.get(id)?.userId === viewer.id) return Response.json({
				...idFields(id), processing_info: { state: "pending", check_after_secs: 1 },
			});
			const p = id ? pending.get(id) : undefined;
			if (!p || p.userId !== viewer.id) return uploadError("Unknown upload.", 404);
			return finalize(id!, p);
		}
		case "STATUS": {
			if (!isId(id)) return uploadError("Unknown upload.", 404);
			const uploading = pending.get(id);
			if (uploading?.userId === viewer.id) return Response.json({
				...idFields(id), processing_info: { state: "uploading" },
				total_bytes: uploading.total, received_bytes: uploading.received,
				segments: [...uploading.chunks].sort(([a], [b]) => a - b).map(([segment_index, bytes]) => ({ segment_index, bytes })),
				expires_after_secs: Math.max(0, Math.ceil((uploading.started + MAX_PENDING_MS - Date.now()) / 1000)),
			});
			if (finalizing.get(id)?.userId === viewer.id) return Response.json({
				...idFields(id), processing_info: { state: "pending", check_after_secs: 1 },
			});
			const [row] = await sql`select state from media where id = ${id}::bigint and user_id = ${viewer.id}::bigint`;
			if (!row) return uploadError("Unknown upload.", 404);
			if (row.state === "processing")
				return Response.json({ ...idFields(id), processing_info: { state: "in_progress", check_after_secs: 1, progress_percent: progress.get(id!) ?? 0 } });
			if (row.state === "failed")
				return Response.json({ ...idFields(id), processing_info: { state: "failed", error: { code: 1, name: "InvalidMedia", message: videoError(id!) } } });
			return Response.json({ ...idFields(id), processing_info: { state: "succeeded", progress_percent: 100 } });
		}
	}
	return uploadError("Unknown command.");
}

type Served = { id: string; mime: string; owner: string; post: string | null; detached: boolean };
// Visibility changes, blocks and deletion must apply on the next request, and
// authorized private bytes must not persist in browser or shared caches.
const PRIVATE = "private, no-store";
// A public post's photos and a profile's own pictures may stay in the browser,
// which must still ask on every view: the checks run each time as before, and
// an unchanged file is answered 304 instead of being sent again. Without this
// every avatar and photo was downloaded again on every page.
const REVALIDATE = "private, no-cache";

async function servedOf(id: string): Promise<Served | undefined> {
	const [row] = await sql`select id::text, mime, user_id::text as owner, post_id::text as post, detached from media where id = ${id}::bigint and scan_blocked_at is null`;
	return row as Served | undefined;
}

async function cacheFor(viewer: Viewer, served: Served): Promise<string | undefined> {
	if (served.detached) return served.owner === viewer.id ? PRIVATE : undefined;
	// Choice photos are referenced by polls, not media.post_id. Resolve those
	// only for unbound uploads so ordinary post images keep their indexed path.
	const pollIds: string[] = served.post ? [] : (await sql`select id::text from polls where choice_media @> ${sql.array([served.id], "INT8")}`).map((p: any) => p.id);
	if (!served.post && !pollIds.length) {
		// What a profile, list, community or article shows is as open as that
		// is (its URL may later be attached to private content, so it is
		// revalidated): a private list's banner only to its owner, an article's
		// pictures once it is published in a post the viewer may see. An upload
		// nothing shows yet, a draft's or a scheduled post's, is its owner's
		// alone: ids are snowflakes, not secrets.
		const path = `/media/${served.id}`;
		const [shown] = await sql`select 1 where
			exists (select 1 from users where id = ${served.owner}::bigint and (avatar_url = ${path} or banner_url = ${`/media/banner/${served.id}`}))
			or exists (select 1 from lists l where l.banner_media_id = ${served.id}::bigint
				and (l.owner_id = ${viewer.id}::bigint or (not l.is_private and l.owner_id not in ${blockedFor(viewer.id)})))
			or exists (select 1 from communities where banner_url = ${path})
			or exists (select 1 from articles a join posts post on post.article_id = a.id
				where a.user_id = ${served.owner}::bigint and a.state = 'Published' and not a.hidden and not post.hidden
					and (a.cover_media_id = ${served.id}::bigint or a.content_state::text like ${`%${served.id}%`})
					and ${circleSeen(viewer.id, sql`post`)} and post.user_id not in ${protectedFor(viewer.id)}
					and post.user_id not in ${suspendedFor(viewer.id)} and post.user_id not in ${blockedFor(viewer.id)})`;
		if (shown) return REVALIDATE;
		// besides its owner: the owner's delegates, who upload as the account,
		// and staff past the admin panel's gate
		if (served.owner === viewer.id || isStaffRequest()) return PRIVATE;
		const [delegate] = await sql`select 1 from delegation_members where owner_id = ${served.owner}::bigint and member_id = ${viewer.id}::bigint and status = 'Accepted'`;
		return delegate ? PRIVATE : undefined;
	}
	const [access] = await sql`select not post.hidden and not author.protected and post.circle_owner_id is null as open from posts post join users author on author.id = post.user_id where
		${served.post ? sql`post.id = ${served.post}::bigint` : sql`post.poll_id = any(${sql.array(pollIds, "INT8")})`}
		and (not post.hidden or ${staffViewer(viewer.id)}) and ${circleSeen(viewer.id, sql`post`)}
		and post.user_id not in ${protectedFor(viewer.id)}
		and post.user_id not in ${suspendedFor(viewer.id)}
		and post.user_id not in ${blockedFor(viewer.id)} limit 1`;
	if (access) return access.open ? REVALIDATE : PRIVATE;
	// A draft/deleted poll's uploaded choices remain available to its owner.
	return !served.post && served.owner === viewer.id ? PRIVATE : undefined;
}

async function serveConversationVideo(id: string, viewer: Viewer): Promise<Response> {
	const served = await servedOf(id);
	const cache = served && await cacheFor(viewer, served);
	if (!served || served.mime !== "video/mp4" || !cache) return new Response("not found", { status: 404, headers: { "cache-control": PRIVATE } });
	return new Response(conversationVideoMap(served.id, mediaUrl(served.id, served.mime), served.owner), { headers: { "content-type": "application/xml", "cache-control": cache, "x-content-type-options": "nosniff" } });
}

// a file the browser may keep is tagged by its size and time, which change
// when the file is replaced
function tagOf(served: Served, body: Blob, cache: string): { etag?: string } {
	// a remote file kept only in memory has no time, so a same-size swap would
	// keep its tag; those go untagged and are always sent whole
	const time = (body as Blob & { lastModified?: number }).lastModified;
	if (cache !== REVALIDATE || !time) return {};
	return { etag: `"${served.id}-${body.size.toString(36)}-${time.toString(36)}"` };
}
const unchanged = (req: Request, headers: Record<string, string>) => !!headers.etag && req.headers.get("if-none-match") === headers.etag;

// /media/<id>[.ext], /media/banner/<id>[/<size>] and /media/poster/<id>.jpg; the
// client asks for sizes through the query string or a path suffix, and gets the
// original either way. Byte ranges are answered so the video player can seek.
export async function serveMedia(req: Request, pathname: string, viewer: Viewer): Promise<Response> {
	const cardVideo = /^\/media\/card-video\/(\d{1,19})\.xml$/.exec(pathname);
	const poster = /^\/media\/poster\/(\d{1,19})\.jpg$/.exec(pathname);
	if (cardVideo && isId(cardVideo[1])) return serveConversationVideo(cardVideo[1], viewer);
	if (poster && isId(poster[1])) {
		const body = await remoteMediaFile(poster[1], true);
		const served = body && (await servedOf(poster[1]));
		const cache = served && (await cacheFor(viewer, served));
		if (!body || !cache) return new Response("not found", { status: 404, headers: { "cache-control": PRIVATE } });
		const headers: Record<string, string> = { "content-type": "image/jpeg", "cache-control": cache, "x-content-type-options": "nosniff", "content-security-policy": MEDIA_CSP, ...tagOf(served, body, cache) };
		if (unchanged(req, headers)) return new Response(null, { status: 304, headers });
		return new Response(body, { headers });
	}
	const m = /^\/media\/(?:banner\/)?(\d{1,19})(?:\.[a-z0-9]+)?(?:\/[\w-]+)?$/.exec(pathname);
	const body = m && isId(m[1]) && (await remoteMediaFile(m[1]));
	if (!m || !body) return new Response("not found", { status: 404, headers: { "cache-control": PRIVATE } });
	const served = await servedOf(m[1]);
	const cache = served && (await cacheFor(viewer, served));
	if (!served || !cache) return new Response("not found", { status: 404, headers: { "cache-control": PRIVATE } });
	const headers: Record<string, string> = { "content-type": servedType(served.mime), "cache-control": cache, "x-content-type-options": "nosniff", "content-security-policy": MEDIA_CSP, "accept-ranges": "bytes", ...tagOf(served, body, cache) };
	if (unchanged(req, headers)) return new Response(null, { status: 304, headers });
	const size = body.size;
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
	// If-Range: a part of a file that changed since would be stitched onto the
	// old one, so anything but the current tag gets the whole file
	const ifRange = req.headers.get("if-range");
	if (range && (range[1] || range[2]) && (ifRange === null || ifRange === headers.etag)) {
		// "bytes=-N" means the last N bytes
		const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
		return new Response(body.slice(start, end + 1), {
			status: 206,
			headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
		});
	}
	// Bun answers a Range itself when the body comes from a file, even as a
	// stream and whatever If-Range says; piped, it goes out whole
	if (range && ifRange !== null) return new Response(body.stream().pipeThrough(new TransformStream()), { headers: { ...headers, "content-length": String(size) } });
	return new Response(body, { headers });
}

const AVATAR_SIZES: Record<string, number> = { mini: 24, normal: 48, bigger: 73, x96: 96, reasonably_small: 128 };
const AVATAR_STEPS = [24, 48, 73, 96, 128, 200, 400];
const AVATAR_DIR = () => join(MEDIA_DIR, ".avatars");
const RESIZABLE = new Set(["image/jpeg", "image/png", "image/webp"]);
const resizing = new Map<string, Promise<Blob | undefined>>();

function avatarWidth(suffix: string | undefined): number | undefined {
	if (!suffix) return undefined;
	if (AVATAR_SIZES[suffix]) return AVATAR_SIZES[suffix];
	const box = /^(\d{1,4})x\d{1,4}$/.exec(suffix);
	if (!box) return undefined;
	const want = Number(box[1]);
	return AVATAR_STEPS.find((w) => w >= want) ?? undefined;
}

async function resizedAvatar(served: Served, body: Blob, width: number): Promise<Blob | undefined> {
	const png = served.mime !== "image/jpeg";
	const out = join(AVATAR_DIR(), `${served.id}_${width}.${png ? "png" : "jpg"}`);
	if (existsSync(out)) return Bun.file(out);
	const key = out;
	const running = resizing.get(key);
	if (running) return running;
	const job = (async () => {
		mkdirSync(AVATAR_DIR(), { recursive: true });
		const input = await body.bytes();
		const tmp = `${out}.${process.pid}.tmp`;
		const p = spawnLimited([FFMPEG, "-v", "error", "-i", "pipe:0", "-vf", `scale='min(${width},iw)':-1:flags=lanczos`, "-frames:v", "1", ...(png ? ["-f", "image2", "-c:v", "png"] : ["-f", "image2", "-c:v", "mjpeg", "-q:v", "3"]), "-y", tmp], 20_000, "ignore", input);
		if ((await p.exited) !== 0 || !existsSync(tmp)) {
			rmSync(tmp, { force: true });
			return undefined;
		}
		renameSync(tmp, out);
		return Bun.file(out);
	})().finally(() => resizing.delete(key));
	resizing.set(key, job);
	return job;
}

export async function serveAvatar(req: Request, pathname: string, viewer: Viewer): Promise<Response> {
	const m = /^\/profile_images\/(\d{1,19})(?:_([a-z_]+|\d{1,4}x\d{1,4}))?\.(?:jpe?g|png)$/.exec(pathname);
	const original = m && isId(m[1]) && (await remoteMediaFile(m[1]));
	const served = original && (await servedOf(m![1]));
	const cache = served && (await cacheFor(viewer, served));
	if (!m || !original || !served || !cache) return new Response("not found", { status: 404, headers: { "cache-control": PRIVATE } });
	const width = RESIZABLE.has(served.mime) ? avatarWidth(m[2]) : undefined;
	const body = (width && (await resizedAvatar(served, original, width))) || original;
	const type = body === original ? servedType(served.mime) : served.mime === "image/jpeg" ? "image/jpeg" : "image/png";
	const tag = tagOf(served, body, cache);
	const headers: Record<string, string> = { "content-type": type, "cache-control": cache, "x-content-type-options": "nosniff", "content-security-policy": MEDIA_CSP, ...(tag.etag ? { etag: tag.etag.replace(/"$/, `-${width ?? 0}"`) } : {}) };
	if (unchanged(req, headers)) return new Response(null, { status: 304, headers });
	return new Response(body.stream().pipeThrough(new TransformStream()), { headers: { ...headers, "content-length": String(body.size) } });
}

// attaches uploads to a new post; only the poster's own unused, finished
// uploads count. A video goes alone, photos up to MAX_POST_MEDIA.
export class MediaError extends Error {}

export async function attachMedia(userId: string, postId: string, mediaIds: string[], opts: { db?: SQL; strict?: boolean } = {}) {
	const db = opts.db ?? sql;
	const ids = [...new Set(mediaIds.filter(isId).slice(0, MAX_POST_MEDIA))];
	if (opts.strict && (ids.length !== mediaIds.length || !isId(postId))) throw new MediaError("Invalid media attachments.");
	if (!ids.length) return;
	const [post] = await db`select id from posts where id = ${postId}::bigint and user_id = ${userId}::bigint`;
	if (!post) {
		if (opts.strict) throw new MediaError("The post can't use these attachments.");
		return;
	}
	const rows = await db`select id, kind from media where id = any(${sql.array(ids, "INT8")}) and user_id = ${userId}::bigint
		and post_id is null and state = 'ready' for update`;
	const kinds = new Map<string, string>(rows.map((r: any) => [String(r.id), r.kind]));
	const usable = ids.filter((id) => kinds.has(id));
	const video = usable.find((id) => kinds.get(id) === "video");
	if (opts.strict && (usable.length !== ids.length || (video && usable.length > 1))) throw new MediaError("Attachments must be your own unused, finished uploads. A video goes alone.");
	for (const [i, id] of (video ? [video] : usable).entries()) {
		const changed = await db`update media set post_id = ${postId}::bigint, position = ${i} where id = ${id}::bigint
			and user_id = ${userId}::bigint and post_id is null and state = 'ready' returning id`;
		if (opts.strict && !changed.length) throw new MediaError("An attachment is no longer available.");
	}
}

export async function mediaForPosts(postIds: string[]): Promise<Map<string, MediaRow[]>> {
	const out = new Map<string, MediaRow[]>();
	if (!postIds.length) return out;
	const rows = await sql`select id, post_id, kind, mime, size, width, height, position, duration_ms, alt_text, sensitive_warning from media
		where post_id = any(${sql.array(postIds, "INT8")}) and state = 'ready' order by post_id, position`;
	for (const r of rows) {
		const list = out.get(r.post_id) ?? [];
		list.push(r as MediaRow);
		out.set(r.post_id, list);
	}
	return out;
}

function fit(w: number, h: number, max: number) {
	const scale = Math.min(1, max / Math.max(w, h));
	return { w: Math.round(w * scale), h: Math.round(h * scale), resize: "fit" };
}

// one photo or video as it appears in a post's entities.media and extended_entities.media
const warning = (m: MediaRow) =>
	m.sensitive_warning?.length
		? { sensitive_media_warning: { adult_content: m.sensitive_warning.includes("adult_content"), graphic_violence: m.sensitive_warning.includes("graphic_violence"), other: m.sensitive_warning.includes("other") } }
		: {};

export function mediaEntity(m: MediaRow, postId: string, screenName: string, index: number, textLength: number) {
	if (m.kind === "video") return videoEntity(m, postId, screenName, textLength);
	const page = `${PUBLIC_ORIGIN}/${screenName}/status/${postId}/photo/${index + 1}`;
	return {
		allow_download_status: { allow_download: true },
		display_url: `pic.${PUBLIC_HOSTNAME}/${m.id}`,
		expanded_url: page,
		...(m.alt_text ? { ext_alt_text: m.alt_text } : {}),
		...warning(m),
		ext_media_availability: { status: "Available" },
		features: { large: { faces: [] }, medium: { faces: [] }, orig: { faces: [] }, small: { faces: [] } },
		id_str: m.id,
		// the link is not part of the text, so it takes no room in it
		indices: [textLength, textLength],
		media_key: `3_${m.id}`,
		media_results: { result: { media_key: `3_${m.id}` } },
		media_url_https: mediaUrl(m.id, m.mime),
		original_info: { focus_rects: [], height: m.height, width: m.width },
		sizes: {
			large: fit(m.width, m.height, 2048),
			medium: fit(m.width, m.height, 1200),
			small: fit(m.width, m.height, 680),
			thumb: { h: 150, w: 150, resize: "crop" },
		},
		type: "photo",
		url: page,
	};
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

// a converted video: the poster stands in for the image, the MP4 is the only variant
function videoEntity(m: MediaRow, postId: string, screenName: string, textLength: number) {
	const page = `${PUBLIC_ORIGIN}/${screenName}/status/${postId}/video/1`;
	const d = gcd(m.width, m.height) || 1;
	const key = `7_${m.id}`;
	const seconds = Math.max(1, (m.duration_ms ?? 1000) / 1000);
	return {
		additional_media_info: { monetizable: false },
		allow_download_status: { allow_download: true },
		display_url: `pic.${PUBLIC_HOSTNAME}/${m.id}`,
		expanded_url: page,
		...(m.alt_text ? { ext_alt_text: m.alt_text } : {}),
		...warning(m),
		ext_media_availability: { status: "Available" },
		id_str: m.id,
		indices: [textLength, textLength],
		media_key: key,
		media_results: { result: { media_key: key } },
		media_url_https: posterUrl(m.id),
		original_info: { focus_rects: [], height: m.height, width: m.width },
		sizes: {
			large: fit(m.width, m.height, 2048),
			medium: fit(m.width, m.height, 1200),
			small: fit(m.width, m.height, 680),
			thumb: { h: 150, w: 150, resize: "crop" },
		},
		type: "video",
		url: page,
		video_info: {
			aspect_ratio: [m.width / d, m.height / d],
			duration_millis: m.duration_ms ?? 0,
			variants: [{ bitrate: Math.min(Math.round((m.size * 8) / seconds), LEGACY_CLIENT_TOP_BITRATE), content_type: "video/mp4", url: mediaUrl(m.id, m.mime) }],
		},
	};
}
