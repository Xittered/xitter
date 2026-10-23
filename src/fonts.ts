// Google Fonts, kept on disk under MEDIA_DIR/fonts and served from this origin.
// Family names are a tight whitelist; CSS we emit never includes raw input.

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { StorageFailure, putFile } from "./disk";
import { readLimited } from "./federation";
import { STORAGE_SENTENCE } from "./notices";

const FAMILY_RE = /^[A-Za-z0-9 ]{1,40}$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE_RE = /^(?:fonts\.css|\d{1,4}-(?:latin|latin-ext)\.woff2)$/;
const RANGE_RE = /^[U+0-9A-Fa-f,\s?\-]+$/;
const WEIGHT_RE = /^\d{1,4}$/;
const WOFF2 = Buffer.from("wOF2");
const MAX_FILE = 2 * 1024 * 1024;
const MAX_FAMILY = 8 * 1024 * 1024;
const FAIL_MS = 10 * 60 * 1000;
// families kept on disk at most, so typing names can't fill it
const MAX_FAMILIES = 200;
const CHROME_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export type FontFace = { weight: number; subset: "latin" | "latin-ext"; url: string; unicodeRange: string };
export type FontOk = { ok: true; family: string; slug: string };
export type FontErr = { ok: false; error: string };
export type FontResult = FontOk | FontErr;

const pending = new Map<string, Promise<FontResult>>();
const failed = new Map<string, number>();

function mediaDir() {
	return process.env.MEDIA_DIR ?? "media";
}

export function cssOrigin() {
	return (process.env.GOOGLE_FONTS_CSS_ORIGIN ?? "https://fonts.googleapis.com").replace(/\/$/, "");
}

export function fileOrigin() {
	return (process.env.GOOGLE_FONTS_FILE_ORIGIN ?? "https://fonts.gstatic.com").replace(/\/$/, "");
}

export function validateFamily(v: unknown): string | undefined {
	if (typeof v !== "string") return;
	const s = v.trim().replace(/ {2,}/g, " ");
	if (!FAMILY_RE.test(s)) return;
	return s;
}

export function fontSlug(family: string): string {
	return family.trim().replace(/ {2,}/g, " ").toLowerCase().replace(/ /g, "-");
}

export function familyFromSlug(slug: string): string | undefined {
	if (!SLUG_RE.test(slug) || slug.length > 40) return;
	return validateFamily(slug.replace(/-/g, " "));
}

export function resetFontState() {
	pending.clear();
	failed.clear();
}

function fontsDir(slug: string) {
	return join(mediaDir(), "fonts", slug);
}

function allowedFileUrl(url: string): boolean {
	try {
		const u = new URL(url);
		const o = new URL(fileOrigin());
		return u.origin === o.origin && /\.woff2$/i.test(u.pathname);
	} catch {
		return false;
	}
}

function subsetOf(range: string): "latin" | "latin-ext" | undefined {
	const r = range.toUpperCase();
	if (/\bU\+0000-00FF\b/.test(r)) return "latin";
	if (/\bU\+0400\b|\bU\+0370\b/.test(r)) return;
	if (/\bU\+0100\b/.test(r)) return "latin-ext";
}

export function parseFontCss(css: string, origin = fileOrigin()): FontFace[] {
	const out: FontFace[] = [];
	const seen = new Set<string>();
	const re = /@font-face\s*\{([^{}]*)\}/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(css))) {
		const body = m[1] ?? "";
		if (!/font-style:\s*normal\s*;/i.test(body)) continue;
		const w = /font-weight:\s*(\d{1,4})\s*;/i.exec(body);
		const src = /src:\s*url\(["']?(https?:\/\/[^)\s'"]+\.woff2)["']?\)/i.exec(body);
		const range = /unicode-range:\s*([U+0-9A-Fa-f,\s?\-]+)\s*;/i.exec(body);
		if (!w || !src || !range) continue;
		if (!WEIGHT_RE.test(w[1]!) || !RANGE_RE.test(range[1]!.trim())) continue;
		const url = src[1]!;
		try {
			if (new URL(url).origin !== new URL(origin).origin) continue;
		} catch {
			continue;
		}
		if (!/\.woff2$/i.test(url)) continue;
		const subset = subsetOf(range[1]!.trim());
		if (!subset) continue;
		const weight = Number(w[1]);
		const key = `${weight}-${subset}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ weight, subset, url, unicodeRange: range[1]!.trim().replace(/\s+/g, " ") });
	}
	return out;
}

export function fontCss(family: string, slug: string, faces: { weight: number; subset: string; unicodeRange: string }[]): string {
	return faces
		.map((f) => {
			const file = `${f.weight}-${f.subset}.woff2`;
			return `@font-face{font-family:"${family}";font-style:normal;font-weight:${f.weight};font-display:swap;src:url(/i/xitter/fonts/${slug}/${file}) format("woff2");unicode-range:${f.unicodeRange}}`;
		})
		.join("\n");
}

function isWoff2(buf: Buffer) {
	return buf.length >= 4 && buf.subarray(0, 4).equals(WOFF2);
}

// the body is read in pieces and given up past max, so a huge answer never
// sits in memory whole
async function fetchBuf(url: string, timeout: number, max: number): Promise<Buffer> {
	const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeout), headers: { "user-agent": CHROME_UA } });
	if (!r.ok || !r.body) throw new Error(`http ${r.status}`);
	return Buffer.from(await readLimited(r, max));
}

function familiesKept(): number {
	try {
		return readdirSync(join(mediaDir(), "fonts")).length;
	} catch {
		return 0;
	}
}

async function downloadFamily(family: string): Promise<FontResult> {
	const slug = fontSlug(family);
	const dir = fontsDir(slug);
	const cssPath = join(dir, "fonts.css");
	if (existsSync(cssPath)) return { ok: true, family, slug };
	const died = failed.get(slug);
	if (died && Date.now() - died < FAIL_MS) return { ok: false, error: `couldn't load ${family}` };
	const cssUrl = `${cssOrigin()}/css2?family=${encodeURIComponent(family)}:wght@400;500;700;800&display=swap`;
	let css: string;
	try {
		if (familiesKept() >= MAX_FAMILIES) throw new Error("full");
		const buf = await fetchBuf(cssUrl, 15_000, 256 * 1024);
		css = buf.toString("utf8");
	} catch {
		failed.set(slug, Date.now());
		return { ok: false, error: `couldn't load ${family}` };
	}
	const faces = parseFontCss(css);
	if (!faces.length) {
		failed.set(slug, Date.now());
		return { ok: false, error: `couldn't load ${family}` };
	}
	const files: { name: string; buf: Buffer; unicodeRange: string; weight: number; subset: string }[] = [];
	let total = 0;
	for (const f of faces) {
		if (!allowedFileUrl(f.url)) {
			failed.set(slug, Date.now());
			return { ok: false, error: `couldn't load ${family}` };
		}
		let buf: Buffer;
		try {
			buf = await fetchBuf(f.url, 20_000, MAX_FILE);
		} catch {
			failed.set(slug, Date.now());
			return { ok: false, error: `couldn't load ${family}` };
		}
		if (buf.length > MAX_FILE || !isWoff2(buf)) {
			failed.set(slug, Date.now());
			return { ok: false, error: `couldn't load ${family}` };
		}
		total += buf.length;
		if (total > MAX_FAMILY) {
			failed.set(slug, Date.now());
			return { ok: false, error: `couldn't load ${family}` };
		}
		files.push({ name: `${f.weight}-${f.subset}.woff2`, buf, unicodeRange: f.unicodeRange, weight: f.weight, subset: f.subset });
	}
	mkdirSync(dir, { recursive: true });
	try {
		for (const f of files) await putFile(join(dir, f.name), f.buf);
		await putFile(cssPath, Buffer.from(fontCss(family, slug, files)));
	} catch (e) {
		rmSync(dir, { recursive: true, force: true });
		failed.set(slug, Date.now());
		return { ok: false, error: e instanceof StorageFailure ? STORAGE_SENTENCE : `couldn't load ${family}` };
	}
	failed.delete(slug);
	return { ok: true, family, slug };
}

export async function ensureFont(raw: unknown): Promise<FontResult> {
	const family = validateFamily(raw);
	if (!family) return { ok: false, error: "that isn't a font family" };
	const slug = fontSlug(family);
	if (existsSync(join(fontsDir(slug), "fonts.css"))) return { ok: true, family, slug };
	const died = failed.get(slug);
	if (died && Date.now() - died < FAIL_MS) return { ok: false, error: `couldn't load ${family}` };
	let job = pending.get(slug);
	if (!job) {
		job = downloadFamily(family).finally(() => pending.delete(slug));
		pending.set(slug, job);
	}
	return job;
}

export async function prepareFonts(font: { ui?: string; display?: string }): Promise<{ font: { ui?: string; display?: string }; warnings: string[] }> {
	const out: { ui?: string; display?: string } = {};
	const warnings: string[] = [];
	for (const key of ["ui", "display"] as const) {
		const name = font[key];
		if (!name) continue;
		const got = await ensureFont(name);
		if (got.ok) out[key] = got.family;
		else warnings.push(got.error);
	}
	return { font: out, warnings };
}

// only a signed-in viewer may make the instance fetch a family it hasn't got
export function serveFont(url: URL, mayFetch: boolean): Response | Promise<Response> {
	const m = /^\/i\/xitter\/fonts\/([a-z0-9-]+)\/([^/]+)$/.exec(url.pathname);
	if (!m || !SLUG_RE.test(m[1]!) || !FILE_RE.test(m[2]!)) return new Response("not found", { status: 404 });
	const slug = m[1]!;
	const file = m[2]!;
	const path = join(fontsDir(slug), file);
	const headers = (type: string) => ({ "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
	if (existsSync(path)) {
		return new Response(Bun.file(path), { headers: headers(file.endsWith(".css") ? "text/css; charset=utf-8" : "font/woff2") });
	}
	if (file !== "fonts.css" || !mayFetch) return new Response("not found", { status: 404 });
	const q = validateFamily(url.searchParams.get("family") ?? "");
	if (!q || fontSlug(q) !== slug) return new Response("not found", { status: 404 });
	return ensureFont(q).then((got) => {
		if (!got.ok || !existsSync(path)) return new Response("not found", { status: 404 });
		return new Response(Bun.file(path), { headers: headers("text/css; charset=utf-8") });
	});
}
