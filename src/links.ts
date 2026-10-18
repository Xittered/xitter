import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";

const PROXY = (process.env.EMBED_PROXY ?? "https://cors.estrogen.delivery/").replace(/\/?$/, "/");
export const proxied = (url: string) => `${PROXY}?url=${encodeURIComponent(url)}`;

const URL_IN_TEXT = /https?:\/\/[^\s<>"]+/g;
const TRAILING = /[.,!?;:'")\]}>…]+$/u;
const OWN_HOST = new URL(PUBLIC_ORIGIN).host;
const MAX_URL = 2048;

export function linksIn(text: string): { url: string; start: number; end: number }[] {
	const out = [];
	for (const m of text.matchAll(URL_IN_TEXT)) {
		let url = m[0].replace(TRAILING, "");
		const open = (url.match(/\(/g) ?? []).length > (url.match(/\)/g) ?? []).length;
		if (open && m[0].slice(url.length).startsWith(")")) url += ")";
		if (url.length > MAX_URL) continue;
		try {
			new URL(url);
		} catch {
			continue;
		}
		const start = [...text.slice(0, m.index)].length;
		out.push({ url, start, end: start + [...url].length });
	}
	return out;
}

const displayOf = (url: string) => {
	const bare = url.replace(/^https?:\/\/(www\.)?/, "");
	return [...bare].length > 26 ? `${[...bare].slice(0, 25).join("")}…` : bare;
};

export const urlEntities = (text: string, upTo = Number.POSITIVE_INFINITY) =>
	linksIn(text)
		.filter((l) => l.end <= upTo)
		.map((l) => ({ display_url: displayOf(l.url), expanded_url: l.url, url: l.url, indices: [l.start, l.end] }));

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|\[.*\])$/i;

export function previewable(url: string): boolean {
	try {
		const u = new URL(url);
		return /^https?:$/.test(u.protocol) && !PRIVATE_HOST.test(u.hostname) && u.host !== OWN_HOST && !u.username && !u.password;
	} catch {
		return false;
	}
}

export type Preview = { url: string; title: string; description: string; site: string; image: string | null; width: number; height: number };

const decode = (s: string) =>
	s
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Math.min(Number.parseInt(h, 16), 0x10ffff)))
		.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
		.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" })[e as string] ?? "")
		.replace(/\s+/g, " ")
		.trim();

const clip = (s: string, max: number) => ([...s].length > max ? `${[...s].slice(0, max - 1).join("")}…` : s);

export function parsePreview(url: string, html: string): Preview | undefined {
	const head = html.slice(0, 300_000);
	const meta = new Map<string, string>();
	for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
		const attrs = new Map<string, string>();
		for (const a of tag[0].matchAll(/([a-z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) attrs.set(a[1].toLowerCase(), a[3] ?? a[4] ?? a[5] ?? "");
		const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
		const content = attrs.get("content");
		if (key && content !== undefined && !meta.has(key)) meta.set(key, decode(content));
	}
	const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1];
	const title = meta.get("og:title") ?? meta.get("twitter:title") ?? (titleTag ? decode(titleTag) : "");
	if (!title) return undefined;
	const rawImage = meta.get("og:image:secure_url") ?? meta.get("og:image") ?? meta.get("twitter:image") ?? meta.get("twitter:image:src");
	let image: string | null = null;
	try {
		const resolved = rawImage ? new URL(rawImage, url).toString() : null;
		image = resolved && previewable(resolved) && resolved.length <= MAX_URL ? resolved : null;
	} catch {}
	const size = (v: string | undefined) => Math.max(0, Math.min(Number.parseInt(v ?? "", 10) || 0, 10_000));
	return {
		url,
		title: clip(title, 200),
		description: clip(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description") ?? "", 300),
		site: clip(meta.get("og:site_name") ?? new URL(url).hostname.replace(/^www\./, ""), 80),
		image,
		width: size(meta.get("og:image:width")),
		height: size(meta.get("og:image:height")),
	};
}

const MAX_HTML = 1024 * 1024;

async function fetchPage(url: string): Promise<string | undefined> {
	const res = await fetch(proxied(url), { signal: AbortSignal.timeout(8000), headers: { accept: "text/html,application/xhtml+xml" }, redirect: "follow" }).catch(() => undefined);
	if (!res?.ok || !/html|xml/i.test(res.headers.get("content-type") ?? "")) {
		await res?.body?.cancel().catch(() => {});
		return undefined;
	}
	const reader = res.body?.getReader();
	if (!reader) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_HTML) {
		const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
		if (done || !value) break;
		chunks.push(value);
		size += value.length;
	}
	await reader.cancel().catch(() => {});
	return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_HTML));
}

const inFlight = new Set<string>();
const RETRY_FAILED = "1 day";
const REFRESH = "7 days";

export async function fetchPreview(url: string): Promise<void> {
	if (!previewable(url) || inFlight.has(url) || inFlight.size > 50) return;
	inFlight.add(url);
	try {
		const html = await fetchPage(url);
		const p = html ? parsePreview(url, html) : undefined;
		await sql`insert into link_previews (url, ok, title, description, site, image, width, height, fetched_at)
			values (${url}, ${!!p}, ${p?.title ?? ""}, ${p?.description ?? ""}, ${p?.site ?? ""}, ${p?.image ?? null}, ${p?.width ?? 0}, ${p?.height ?? 0}, now())
			on conflict (url) do update set ok = excluded.ok, title = excluded.title, description = excluded.description, site = excluded.site,
				image = excluded.image, width = excluded.width, height = excluded.height, fetched_at = now()`;
	} catch (e) {
		console.error("link preview failed:", e instanceof Error ? e.message : e);
	} finally {
		inFlight.delete(url);
	}
}

export async function previewsFor(urls: string[]): Promise<Map<string, Preview>> {
	const wanted = [...new Set(urls.filter(previewable))];
	if (!wanted.length) return new Map();
	const rows = await sql`select url, ok, title, description, site, image, width, height,
			fetched_at < now() - (case when ok then ${REFRESH} else ${RETRY_FAILED} end)::interval as stale
		from link_previews where url = any(${sql.array(wanted, "TEXT")})`;
	const known = new Map(rows.map((r: any) => [r.url as string, r]));
	for (const url of wanted) if (!known.has(url) || known.get(url).stale) void fetchPreview(url);
	return new Map(rows.filter((r: any) => r.ok).map((r: any) => [r.url as string, r as Preview]));
}

export function linkCard(p: Preview) {
	const image = p.image ? { url: proxied(p.image), width: p.width || 1200, height: p.height || 630 } : null;
	const large = !!image && (!p.width || p.width >= 400);
	const str = (v: string) => ({ string_value: v, type: "STRING" });
	const img = (v: NonNullable<typeof image>) => ({ image_value: { url: v.url, width: v.width, height: v.height, alt: null }, type: "IMAGE" });
	const domain = new URL(p.url).hostname.replace(/^www\./, "");
	const values: Record<string, unknown> = {
		title: str(p.title),
		description: str(p.description),
		domain: str(domain),
		vanity_url: { ...str(domain), scribe_key: "vanity_url" },
		card_url: { ...str(p.url), scribe_key: "card_url" },
	};
	if (image)
		for (const key of ["thumbnail_image", "thumbnail_image_large", "thumbnail_image_original", "summary_photo_image", "summary_photo_image_large", "summary_photo_image_original", "photo_image_full_size", "photo_image_full_size_large", "photo_image_full_size_original"])
			values[key] = img(image);
	return {
		rest_id: p.url,
		legacy: {
			binding_values: Object.entries(values).map(([key, value]) => ({ key, value })),
			card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
			name: large ? "summary_large_image" : "summary",
			url: p.url,
			user_refs_results: [],
		},
	};
}
