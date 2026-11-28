// GIF search uses one provider at a time. Result images are fetched through
// the host-checked proxy so the browser only talks to this origin.

import type { Viewer } from "./auth";
import { sql } from "./db";

export type GifSource = { id: string; display_name: string; api: string; key: string; hosts: RegExp; kind: "klipy" | "tenor" | "giphy" };

const KLIPY: GifSource = { id: "klipy", display_name: "Klipy", api: process.env.KLIPY_API_URL ?? "https://api.klipy.com/v2", key: process.env.KLIPY_API_KEY ?? "", hosts: /(^|\.)klipy\.com$/, kind: "klipy" };
const TENOR: GifSource = { id: "tenor", display_name: "Tenor", api: process.env.TENOR_API_URL ?? "https://api.tenor.com/v1", key: process.env.TENOR_API_KEY ?? "3Z0688EVWYKH", hosts: /(^|\.)tenor\.com$|^tenor\.googleapis\.com$/, kind: "tenor" };
const GIPHY: GifSource = { id: "giphy", display_name: "Giphy", api: process.env.GIPHY_API_URL ?? "https://api.giphy.com/v1/gifs", key: process.env.GIPHY_API_KEY ?? "Gc7131jiJuvI7IdN0HZ1D7nh0ow5BU6g", hosts: /(^|\.)giphy\.com$/, kind: "giphy" };
const SOURCES = [KLIPY, TENOR, GIPHY];
const preferred = SOURCES.find((source) => source.id === process.env.GIF_PROVIDER?.toLowerCase());
const DEFAULT_SOURCE = (preferred?.key ? preferred : undefined) ?? SOURCES.find((source) => source.key) ?? null;
export const gifAvailable = () => DEFAULT_SOURCE !== null;
export const gifProviders = () => SOURCES.filter((source) => source.key).map(({ id, display_name }) => ({ id, display_name }));

export async function gifProviderPreference(userId: string): Promise<string> {
	const [row] = await sql`select preferences->>'gif_provider' as provider from users where id = ${userId}::bigint`;
	const value = row?.provider;
	return value === "auto" || SOURCES.some((source) => source.key && source.id === value) ? value : "auto";
}

async function gifSourceForUser(userId: string): Promise<GifSource | null> {
	const choice = await gifProviderPreference(userId);
	return choice === "auto" ? DEFAULT_SOURCE : SOURCES.find((source) => source.key && source.id === choice) ?? DEFAULT_SOURCE;
}

type Vars = Record<string, any>;

export const gifHostAllowed = (host: string) => SOURCES.some((source) => source.key && (source.hosts.test(host) || host === new URL(source.api).host));

const proxied = (url: string) => `/i/api/xitter/gif?u=${encodeURIComponent(url)}`;

function image(format: any, still?: string) {
	if (!format?.url) return null;
	const [width, height] = Array.isArray(format.dims) ? format.dims : [0, 0];
	return { url: proxied(format.url), width, height, still_image_url: proxied(still ?? format.url) };
}

function item(source: GifSource, r: any) {
	let gif: any;
	let tiny: any;
	let still: string | undefined;
	if (source.kind === "giphy") {
		const images = r.images ?? {};
		const sized = (format: any) => format?.url ? { url: format.url, dims: [Number(format.width) || 0, Number(format.height) || 0] } : undefined;
		gif = sized(images.original);
		tiny = sized(images.fixed_width) ?? gif;
		still = images.fixed_width_still?.url;
	} else if (source.kind === "tenor" && !r.media_formats) {
		const media = r.media?.[0] ?? {};
		gif = media.gif ?? media.mediumgif;
		tiny = media.tinygif ?? gif;
		still = gif?.preview ?? tiny?.preview;
	} else {
		gif = r.media_formats?.gif ?? r.media_formats?.mediumgif;
		tiny = r.media_formats?.tinygif ?? gif;
		still = r.media_formats?.gifpreview?.url;
	}
	const full = image(gif, still);
	const thumb = image(tiny, still);
	if (!full || !thumb) return null;
	return {
		id: `${source.id}_${r.id}`,
		provider: { id: source.id, display_name: source.display_name },
		alt_text: r.content_description ?? r.title ?? r.h1_title ?? "",
		full_image: full,
		preview_image: thumb,
		thumbnail_images: [thumb],
	};
}

type ProviderPage = { items: any[]; next: string | null };

async function provider(source: GifSource, trending: boolean, query: string, limit: number, cursor?: string): Promise<ProviderPage> {
	const api = source.api.replace(/\/$/, "");
	const path = source.kind === "giphy" ? (trending ? "trending" : "search") : source.kind === "tenor" && !api.includes("googleapis.com") ? (trending ? "trending" : "search") : (trending ? "featured" : "search");
	const url = new URL(`${api}/${path}`);
	let params: Record<string, string>;
	if (source.kind === "giphy") {
		params = { api_key: source.key, limit: String(limit), offset: cursor || "0", rating: "pg-13", lang: "en" };
		if (query) params.q = query;
	} else {
		params = {
			key: source.key,
			limit: String(limit),
			media_filter: "gif,tinygif,gifpreview",
			contentfilter: "medium",
			...(source.kind === "klipy" || api.includes("googleapis.com") ? { client_key: "xitter" } : { locale: "en_US" }),
			...(query ? { q: query } : {}),
			...(cursor ? { pos: cursor } : {}),
		};
	}
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
	if (!r.ok) throw new Error(`${source.id} ${r.status}`);
	const data = await r.json() as any;
	const results = source.kind === "giphy" ? data.data ?? [] : data.results ?? [];
	let next: string | null = data.next || null;
	if (source.kind === "giphy") {
		const offset = Number(cursor ?? 0);
		const total = Number(data.pagination?.total_count);
		next = results.length && (!Number.isFinite(total) || offset + results.length < total) ? String(offset + results.length) : null;
	}
	return { items: results.map((result: any) => item(source, result)).filter(Boolean), next };
}

function readCursor(value: unknown, source: GifSource): string | undefined {
	if (typeof value !== "string" || !value || value.length > 4096) return undefined;
	try {
		const parsed = JSON.parse(decodeURIComponent(value));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
			return parsed.provider === source.id && typeof parsed.cursor === "string" ? parsed.cursor : undefined;
	} catch { }
	return value;
}

async function search(userId: string, query: string, limit: number, cursor: unknown, trending = false) {
	const source = await gifSourceForUser(userId);
	if (!source) return { items: [], slice_info: {} };
	const page = await provider(source, trending, query, limit, readCursor(cursor, source));
	return {
		items: page.items,
		slice_info: page.next ? { next_cursor: encodeURIComponent(JSON.stringify({ provider: source.id, cursor: page.next })) } : {},
	};
}

const count = (vars: Vars) => String(Math.min(Math.max(Number(vars.count) || 20, 1), 50));

export const gifHandlers = {
	GifSearch: async (_v: Viewer, vars: Vars) => {
		const q = String(vars.rawQuery ?? vars.raw_query ?? vars.query ?? vars.searchTerm ?? "").trim().slice(0, 100);
		if (!q) return { data: { gif_search_slice: { items: [], slice_info: {} } } };
		return { data: { gif_search_slice: await search(_v.id, q, Number(count(vars)), vars.cursor) } };
	},
	GifEnumerateCategory: async (_v: Viewer, vars: Vars) => {
		const category = String(vars.category ?? vars.categoryName ?? "trending");
		return { data: { gif_enumerate_category_slice: await search(_v.id, category === "trending" ? "" : category, Number(count(vars)), vars.cursor, category === "trending") } };
	},
};

const MAX_PROXIED = 64;
let proxying = 0;

export async function gifProxy(url: URL): Promise<Response> {
	if (proxying >= MAX_PROXIED) return new Response("busy", { status: 503, headers: { "retry-after": "1" } });
	proxying++;
	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		proxying--;
	};
	try {
		const res = await proxyGif(url, release);
		if (res.status !== 200) release();
		return res;
	} catch (e) {
		release();
		throw e;
	}
}

async function proxyGif(url: URL, release: () => void): Promise<Response> {
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
	let size = 0;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					release();
					controller.close();
					return;
				}
				size += value.byteLength;
				if (size > maxBytes) {
					release();
					await reader.cancel().catch(() => {});
					controller.error(new Error("image too large"));
					return;
				}
				controller.enqueue(value);
			} catch (e) {
				release();
				controller.error(e);
			}
		},
		async cancel() {
			release();
			await reader.cancel().catch(() => {});
		},
	});
	return new Response(body, { headers: { "content-type": type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
}
