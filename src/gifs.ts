// GIF search through Klipy, or Tenor when only TENOR_API_KEY is set; both speak
// Tenor's v2 API. The browser may only talk to this origin, and a picked GIF is
// downloaded by the client and uploaded like any other media, so results point
// at /i/api/xitter/gif, which fetches from the provider's own hosts only.
// Without a key the composer's GIF button is hidden.

import type { Viewer } from "./auth";
import { CappedRead, readJson } from "./federation";

const KLIPY = { id: "klipy", display_name: "Klipy", api: process.env.KLIPY_API_URL ?? "https://api.klipy.com/v2", key: process.env.KLIPY_API_KEY ?? "", hosts: /(^|\.)klipy\.com$/ };
const TENOR = { id: "tenor", display_name: "Tenor", api: process.env.TENOR_API_URL ?? "https://tenor.googleapis.com/v2", key: process.env.TENOR_API_KEY ?? "", hosts: /(^|\.)tenor\.com$|^tenor\.googleapis\.com$/ };
const SOURCE = KLIPY.key ? KLIPY : TENOR;
const API = SOURCE.api;
export const gifKey = () => SOURCE.key;

type Vars = Record<string, any>;

const PROVIDER = { id: SOURCE.id, display_name: SOURCE.display_name };

export const gifHostAllowed = (host: string) => SOURCE.hosts.test(host) || host === new URL(API).host;

const proxied = (url: string) => `/i/api/xitter/gif?u=${encodeURIComponent(url)}`;

function image(format: any, still: string | undefined) {
	if (!format?.url) return null;
	const [width, height] = Array.isArray(format.dims) ? format.dims : [0, 0];
	return { url: proxied(format.url), width, height, still_image_url: proxied(still ?? format.url) };
}

function item(r: any) {
	const gif = r.media_formats?.gif ?? r.media_formats?.mediumgif;
	const tiny = r.media_formats?.tinygif ?? gif;
	const still = r.media_formats?.gifpreview?.url ?? tiny?.url;
	const full = image(gif, still);
	const thumb = image(tiny, still);
	if (!full || !thumb) return null;
	return {
		id: `${SOURCE.id}_${r.id}`,
		provider: PROVIDER,
		alt_text: r.content_description ?? r.title ?? "",
		full_image: full,
		preview_image: thumb,
		thumbnail_images: [thumb],
	};
}

async function provider(path: string, params: Record<string, string>) {
	const key = gifKey();
	if (!key) return { results: [], next: "" };
	const url = new URL(`${API}${path}`);
	for (const [k, v] of Object.entries({ key, client_key: "xitter", media_filter: "gif,tinygif,gifpreview", contentfilter: "medium", ...params })) url.searchParams.set(k, v);
	const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
	if (!r.ok) throw new Error(`${SOURCE.id} ${r.status}`);
	try {
		return (await readJson(r, 2 * 1024 * 1024)) as { results?: any[]; next?: string };
	} catch (e) {
		if (e instanceof CappedRead) return { results: [], next: "" };
		throw e;
	}
}

const slice = (data: { results?: any[]; next?: string }) => ({
	items: (data.results ?? []).map(item).filter(Boolean),
	slice_info: data.next ? { next_cursor: data.next } : {},
});

const count = (vars: Vars) => String(Math.min(Math.max(Number(vars.count) || 20, 1), 50));
const cursor = (vars: Vars): Record<string, string> => (typeof vars.cursor === "string" && vars.cursor ? { pos: vars.cursor } : {});

export const gifHandlers = {
	GifSearch: async (_v: Viewer, vars: Vars) => {
		const q = String(vars.rawQuery ?? vars.raw_query ?? vars.query ?? vars.searchTerm ?? "").trim().slice(0, 100);
		if (!q) return { data: { gif_search_slice: { items: [], slice_info: {} } } };
		return { data: { gif_search_slice: slice(await provider("/search", { q, limit: count(vars), ...cursor(vars) })) } };
	},
	GifEnumerateCategory: async (_v: Viewer, vars: Vars) => {
		const category = String(vars.category ?? vars.categoryName ?? "trending");
		const data =
			category === "trending"
				? await provider("/featured", { limit: count(vars), ...cursor(vars) })
				: await provider("/search", { q: category, limit: count(vars), ...cursor(vars) });
		return { data: { gif_enumerate_category_slice: slice(data) } };
	},
};

export async function gifProxy(url: URL): Promise<Response> {
	let target: URL;
	try {
		target = new URL(url.searchParams.get("u") ?? "");
	} catch {
		return new Response("bad url", { status: 400 });
	}
	if (!/^https?:$/.test(target.protocol) || !gifHostAllowed(target.host)) return new Response("not allowed", { status: 403 });
	// Providers may redirect between their API and CDN hosts. Validate each hop.
	let upstream: Response | undefined;
	for (let hop = 0; hop < 4; hop++) {
		upstream = await fetch(target, { signal: AbortSignal.timeout(10_000), redirect: "manual" }).catch(() => undefined);
		if (!upstream || ![301, 302, 303, 307, 308].includes(upstream.status)) break;
		const location = upstream.headers.get("location");
		let next: URL;
		try {
			next = new URL(location ?? "", target);
		} catch {
			return new Response("bad redirect", { status: 502 });
		}
		await upstream.body?.cancel();
		if (next.protocol !== "https:" || !gifHostAllowed(next.host)) return new Response("redirect not allowed", { status: 403 });
		target = next;
	}
	if (!upstream?.ok) return new Response("not found", { status: 404 });
	const type = upstream.headers.get("content-type") ?? "";
	if (!/^image\/(gif|png|jpeg|webp)(?:\s*;|$)/i.test(type)) {
		await upstream.body?.cancel();
		return new Response("not an image", { status: 415 });
	}
	const maxBytes = 20 * 1024 * 1024;
	const length = Number(upstream.headers.get("content-length"));
	if (length > maxBytes) {
		await upstream.body?.cancel();
		return new Response("image too large", { status: 413 });
	}
	const reader = upstream.body?.getReader();
	if (!reader) return new Response("not found", { status: 404 });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) return new Response("image too large", { status: 413 });
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return new Response(new Blob(chunks), { headers: { "content-type": type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
}
