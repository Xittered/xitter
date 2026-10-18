// Uploaded videos: ffprobe reads what came in, ffmpeg turns it into an MP4
// every browser plays (H.264 + AAC, moov atom first) and grabs a poster frame.
// Files that already are such an MP4 are only remuxed. One job runs at a time;
// the client polls the upload STATUS command meanwhile.

import { settings } from "./settings";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "./db";

// limits come from the admin panel's settings (defaults: MAX_VIDEO_MB, MAX_VIDEO_SECONDS)
export const maxVideoBytes = () => settings().limits.video_mb * 1024 * 1024;
const maxSeconds = () => settings().limits.video_seconds;
const MAX_SIDE = 1280;
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.FFPROBE ?? "ffprobe";

// progress of running jobs, in percent
export const progress = new Map<string, number>();
const errors = new Map<string, string>();
const MAX_VIDEO_ERRORS = 256;
export const videoError = (id: string) => errors.get(id) ?? "The video could not be processed.";

export const sourceFile = (dir: string, id: string) => join(dir, `${id}.upload`);
export const posterFile = (dir: string, id: string) => join(dir, `${id}.poster.jpg`);

let available: boolean | undefined;
export async function videoSupported(): Promise<boolean> {
	if (available === undefined) {
		try {
			const p = Bun.spawn([FFMPEG, "-version"], { stdout: "ignore", stderr: "ignore" });
			available = (await p.exited) === 0;
		} catch {
			available = false;
		}
		if (!available) console.log("ffmpeg not found: video uploads are refused (set FFMPEG / FFPROBE)");
	}
	return available;
}

type Probe = { width: number; height: number; seconds: number; vcodec: string; pix: string; acodec?: string; format: string };

async function probe(file: string): Promise<Probe | undefined> {
	const p = Bun.spawn([FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(p.stdout).text();
	if ((await p.exited) !== 0) return undefined;
	const info = JSON.parse(out);
	const v = info.streams?.find((s: any) => s.codec_type === "video" && !s.disposition?.attached_pic);
	if (!v) return undefined;
	const a = info.streams?.find((s: any) => s.codec_type === "audio");
	// phone videos store portrait clips as landscape plus a rotation
	const rotation = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? 0)) % 180;
	return {
		width: rotation === 90 ? v.height : v.width,
		height: rotation === 90 ? v.width : v.height,
		seconds: Number(info.format?.duration ?? v.duration ?? 0),
		vcodec: v.codec_name,
		pix: v.pix_fmt,
		acodec: a?.codec_name,
		format: info.format?.format_name ?? "",
	};
}

async function run(args: string[], id: string, seconds: number): Promise<boolean> {
	const p = Bun.spawn([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats", ...args], { stdout: "pipe", stderr: "pipe" });
	const decoder = new TextDecoder();
	for await (const chunk of p.stdout) {
		const m = /out_time_us=(\d+)/.exec(decoder.decode(chunk));
		if (m && seconds > 0) progress.set(id, Math.min(99, Math.floor(Number(m[1]) / 1e4 / seconds)));
	}
	const code = await p.exited;
	if (code !== 0) console.log(`ffmpeg failed for ${id}: ${(await new Response(p.stderr).text()).slice(0, 500)}`);
	return code === 0;
}

async function convert(dir: string, id: string) {
	const src = sourceFile(dir, id);
	const tmp = join(dir, `${id}.tmp.mp4`);
	const fail = async (message: string) => {
		if (errors.size >= MAX_VIDEO_ERRORS) errors.delete(errors.keys().next().value!);
		errors.set(id, message);
		await sql`update media set state = 'failed' where id = ${id}::bigint`;
	};
	try {
		const info = await probe(src);
		if (!info) return await fail("This file has no video we can read.");
		if (info.seconds > maxSeconds()) return await fail(`Videos can be up to ${Math.floor(maxSeconds() / 60)} minutes long.`);
		const playable =
			info.format.includes("mp4") && info.vcodec === "h264" && info.pix === "yuv420p" && (!info.acodec || info.acodec === "aac") && Math.max(info.width, info.height) <= 1920;
		const video = playable
			? ["-c", "copy"]
			: [
					"-vf",
					`scale='if(gt(iw,ih),trunc(min(${MAX_SIDE},iw)/2)*2,-2)':'if(gt(iw,ih),-2,trunc(min(${MAX_SIDE},ih)/2)*2)'`,
					"-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
					"-c:a", "aac", "-b:a", "128k", "-ac", "2",
				];
		if (!(await run(["-i", src, "-map", "0:v:0", "-map", "0:a:0?", ...video, "-movflags", "+faststart", "-f", "mp4", tmp], id, info.seconds)))
			return await fail("The video could not be converted.");
		if (!(await run(["-ss", String(Math.min(1, info.seconds / 2)), "-i", tmp, "-frames:v", "1", "-q:v", "3", posterFile(dir, id)], id, 0)))
			return await fail("The video could not be converted.");
		const out = await probe(tmp);
		if (!out) return await fail("The video could not be converted.");
		renameSync(tmp, join(dir, id));
		const size = Bun.file(join(dir, id)).size;
		await sql`update media set state = 'ready', mime = 'video/mp4', size = ${size}, width = ${out.width}, height = ${out.height},
			duration_ms = ${Math.round(out.seconds * 1000)} where id = ${id}::bigint`;
	} catch (e) {
		console.log(`video ${id} failed:`, e);
		await fail("The video could not be processed.");
	} finally {
		progress.delete(id);
		rmSync(src, { force: true });
		rmSync(tmp, { force: true });
	}
}

// a cropped GIF avatar or banner (see media.ts); one palette for all frames
export async function cropGif(dir: string, id: string, gif: Buffer, box: { x: number; y: number; w: number; h: number }): Promise<Buffer | undefined> {
	if (!(await videoSupported())) return undefined;
	const src = join(dir, `${id}.crop-in.gif`);
	const out = join(dir, `${id}.crop.gif`);
	try {
		writeFileSync(src, gif);
		const filter = `crop=${box.w}:${box.h}:${box.x}:${box.y},split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse`;
		return (await run(["-i", src, "-filter_complex", filter, "-f", "gif", out], id, 0)) ? readFileSync(out) : undefined;
	} finally {
		rmSync(src, { force: true });
		rmSync(out, { force: true });
	}
}

let queue: Promise<void> = Promise.resolve();
export function queueVideo(dir: string, id: string) {
	progress.set(id, 0);
	queue = queue.then(() => convert(dir, id));
}

// uploads that were still converting when the server stopped
export async function resumeVideos(dir: string) {
	const rows = await sql`select id from media where state = 'processing'`;
	for (const r of rows) {
		const id = String(r.id);
		if (existsSync(sourceFile(dir, id))) queueVideo(dir, id);
		else await sql`update media set state = 'failed' where id = ${id}::bigint`;
	}
}
