// Uploads: the client's chunked upload (INIT, APPEND, FINALIZE, STATUS),
// storage on disk, serving, and the media objects attached to posts.
// Images are stored as uploaded (a GIF may be cropped first); GIFs are served
// as images, so they animate without a video conversion step. Videos are
// converted by video.ts.

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Viewer } from "./auth";
import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { settings } from "./settings";
import { gifProxy } from "./gifs";
import { cropGif, maxVideoBytes, posterFile, progress, queueVideo, sourceFile, videoError, videoSupported } from "./video";

export const MEDIA_DIR = process.env.MEDIA_DIR ?? "media";
const maxImage = () => settings().limits.image_mb * 1024 * 1024;
const MAX_GIF = 15 * 1024 * 1024;
const MAX_PENDING_MS = 60 * 60 * 1000;

type Pending = { userId: string; total: number; category: string; video: boolean; chunks: Map<number, Buffer>; started: number };
const pending = new Map<string, Pending>();

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

type Image = { mime: string; width: number; height: number };

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

const fileOf = (id: string) => join(MEDIA_DIR, id);
const EXT: Record<string, string> = { "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/jpeg": "jpg" };
const EXT_VIDEO: Record<string, string> = { "video/mp4": "mp4" };
export const mediaUrl = (id: string, mime: string) => `${PUBLIC_ORIGIN}/media/${id}.${EXT[mime] ?? EXT_VIDEO[mime] ?? "bin"}`;
export const posterUrl = (id: string) => `${PUBLIC_ORIGIN}/media/poster/${id}.jpg`;
// stored paths are relative so the instance can move to another domain
export const absolute = (path: string | null) => (path?.startsWith("/") ? PUBLIC_ORIGIN + path : path);

const MAX_PENDING_PER_USER = 8;
const MAX_SEGMENTS = 10_000;
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

async function croppedGif(id: string, data: Buffer, image: Image): Promise<{ data: Buffer; image: Image }> {
	const note = CROP_NOTE.exec(data.toString("latin1", Math.max(0, data.length - 64)));
	if (!note) return { data, image };
	const gif = data.subarray(0, data.length - note[0].length);
	if (image.width < 1 || image.height < 1) return { data: gif, image };
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
	const parts = [...p.chunks].sort((a, b) => a[0] - b[0]).map((c) => c[1]);
	let data: Buffer<ArrayBufferLike> = Buffer.concat(parts);
	if (data.length !== p.total) return uploadError("File size does not match the size announced at INIT.");
	if (p.video) {
		mkdirSync(MEDIA_DIR, { recursive: true });
		writeFileSync(sourceFile(MEDIA_DIR, id), data);
		await sql`insert into media (id, user_id, kind, mime, size, width, height, state)
			values (${id}::bigint, ${p.userId}::bigint, 'video', 'video/mp4', ${data.length}, 0, 0, 'processing')`;
		queueVideo(MEDIA_DIR, id);
		return Response.json({ ...idFields(id), size: data.length, expires_after_secs: 86400, processing_info: { state: "pending", check_after_secs: 1 } });
	}
	let image = sniffImage(data);
	if (!image) return uploadError("Unsupported file. Images only: JPEG, PNG, GIF or WebP.");
	if (data.length > (image.mime === "image/gif" ? MAX_GIF : maxImage())) return uploadError("File is too large.");
	mkdirSync(MEDIA_DIR, { recursive: true });
	if (image.mime === "image/gif") ({ data, image } = await croppedGif(id, data, image));
	writeFileSync(fileOf(id), data);
	await sql`insert into media (id, user_id, kind, mime, size, width, height)
		values (${id}::bigint, ${p.userId}::bigint, 'photo', ${image.mime}, ${data.length}, ${image.width}, ${image.height})`;
	return Response.json({
		...idFields(id),
		size: data.length,
		expires_after_secs: 86400,
		image: { image_type: image.mime, w: image.width, h: image.height },
		// the gif flow polls STATUS until processing reports success
		...(/gif|video/.test(p.category) ? { processing_info: { state: "succeeded", progress_percent: 100 } } : {}),
	});
}

export async function mediaUpload(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	const { fields, file } = await params(req, url);
	const id = fields.media_id;
	for (const [key, p] of pending) if (Date.now() - p.started > MAX_PENDING_MS) pending.delete(key);

	switch (fields.command) {
		case "INIT": {
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
				const newMedia = newId();
				return finalize(newMedia, {
					userId: viewer.id,
					total: data.length,
					category: fields.media_category ?? "tweet_gif",
					video: false,
					chunks: new Map([[0, data]]),
					started: Date.now(),
				});
			}
			const total = Number(fields.total_bytes);
			const video = /^video\//.test(fields.media_type ?? "") || /video/.test(fields.media_category ?? "");
			if (video && !(await videoSupported())) return uploadError("Video uploads are not available on this server.");
			if (!video && fields.media_type && !/^image\//.test(fields.media_type)) return uploadError("Only images and videos can be uploaded.");
			if (!Number.isInteger(total) || total <= 0 || total > (video ? maxVideoBytes() : MAX_GIF)) return uploadError("File is too large or empty.");
			if ([...pending.values()].filter((p) => p.userId === viewer.id).length >= MAX_PENDING_PER_USER) return uploadError("Finish your other uploads first.", 429);
			const newMedia = newId();
			pending.set(newMedia, { userId: viewer.id, total, category: fields.media_category ?? "", video, chunks: new Map(), started: Date.now() });
			return Response.json({ ...idFields(newMedia), expires_after_secs: 86400 }, { status: 202 });
		}
		case "APPEND": {
			const p = id ? pending.get(id) : undefined;
			if (!p || p.userId !== viewer.id) return uploadError("Unknown upload.", 404);
			if (!file) return uploadError("No data in APPEND.");
			const received = [...p.chunks.values()].reduce((n, c) => n + c.length, 0);
			if (received + file.length > p.total) return uploadError("More data than announced at INIT.");
			const index = Number(fields.segment_index ?? 0);
			if (!Number.isInteger(index) || index < 0 || index > MAX_SEGMENTS) return uploadError("Bad segment_index.");
			p.chunks.set(index, file);
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
			const received = [...p.chunks.values()].reduce((n, c) => n + c.length, 0);
			if (received + file.length > p.total) return uploadError("More data than announced at INIT.");
			p.chunks.set(first, file);
			return new Response(null, { status: 204 });
		}
		case "FINALIZE": {
			const p = id ? pending.get(id) : undefined;
			if (!p || p.userId !== viewer.id) return uploadError("Unknown upload.", 404);
			return finalize(id!, p);
		}
		case "STATUS": {
			if (!isId(id)) return uploadError("Unknown upload.", 404);
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

const mimeCache = new Map<string, string>();

const IMMUTABLE = "public, max-age=31536000, immutable";

// /media/<id>[.ext], /media/banner/<id>[/<size>] and /media/poster/<id>.jpg; the
// client asks for sizes through the query string or a path suffix, and gets the
// original either way. Byte ranges are answered so the video player can seek.
export async function serveMedia(req: Request, pathname: string): Promise<Response> {
	const poster = /^\/media\/poster\/(\d{1,19})\.jpg$/.exec(pathname);
	if (poster) {
		const file = posterFile(MEDIA_DIR, poster[1]);
		if (!existsSync(file)) return new Response("not found", { status: 404 });
		return new Response(Bun.file(file), { headers: { "content-type": "image/jpeg", "cache-control": IMMUTABLE, "x-content-type-options": "nosniff" } });
	}
	const m = /^\/media\/(?:banner\/)?(\d{1,19})(?:\.[a-z0-9]+)?(?:\/[\w-]+)?$/.exec(pathname);
	if (!m || !existsSync(fileOf(m[1]))) return new Response("not found", { status: 404 });
	let mime = mimeCache.get(m[1]);
	if (!mime) {
		const [row] = await sql`select mime from media where id = ${m[1]}::bigint`;
		if (!row) return new Response("not found", { status: 404 });
		mime = row.mime as string;
		mimeCache.set(m[1], mime);
	}
	const headers: Record<string, string> = { "content-type": mime, "cache-control": IMMUTABLE, "x-content-type-options": "nosniff", "accept-ranges": "bytes" };
	const size = statSync(fileOf(m[1])).size;
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
	if (range && (range[1] || range[2])) {
		// "bytes=-N" means the last N bytes
		const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
		return new Response(Bun.file(fileOf(m[1])).slice(start, end + 1), {
			status: 206,
			headers: { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
		});
	}
	return new Response(Bun.file(fileOf(m[1])), { headers });
}

// attaches uploads to a new post; only the poster's own unused, finished
// uploads count. A video goes alone, photos up to four.
export async function attachMedia(userId: string, postId: string, mediaIds: string[]) {
	const ids = mediaIds.filter((id) => isId(id)).slice(0, 4);
	if (!ids.length) return;
	const rows = await sql`select id, kind from media where id = any(${sql.array(ids, "INT8")}) and user_id = ${userId}::bigint
		and post_id is null and state = 'ready'`;
	const kinds = new Map<string, string>(rows.map((r: any) => [String(r.id), r.kind]));
	const usable = ids.filter((id) => kinds.has(id));
	const video = usable.find((id) => kinds.get(id) === "video");
	for (const [i, id] of (video ? [video] : usable).entries())
		await sql`update media set post_id = ${postId}::bigint, position = ${i} where id = ${id}::bigint`;
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
			variants: [{ bitrate: Math.round((m.size * 8) / seconds), content_type: "video/mp4", url: mediaUrl(m.id, m.mime) }],
		},
	};
}
