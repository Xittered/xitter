// Link cards: a post with a link shows X's summary card for the last link in
// its text, made from the page's OpenGraph and Twitter tags. The server fetches
// each page once (never the readers' browsers) and keeps its image under
// MEDIA_DIR/cards, so reading a post tells no other site about the reader.
// Fetches only go to public addresses: the instance shares a network with its
// database and the key-backup realm. Admin > Settings > Features turns cards off.

import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { join } from "node:path";
import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { MEDIA_DIR, sniffImage } from "./media";
import { feature } from "./settings";

// sites give their card tags to Twitterbot, often only to it
const UA = "Twitterbot/1.0 (Xitter link cards)";
const PAGE_BYTES = 512 * 1024;
const IMAGE_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 8000;
// a failed page is tried again after a day, a good one refreshed after a week
const RETRY_MS = 24 * 60 * 60 * 1000;
const REFRESH_MS = 7 * RETRY_MS;
const CARD_DIR = join(MEDIA_DIR, "cards");

const LINK = /https?:\/\/[^\s<>"'`]+/g;

// a link as written, without the punctuation the sentence put after it; a
// closing bracket stays when the link opened one (en.wikipedia.org/wiki/X_(Y))
function trimLink(raw: string): string {
	let url = raw.replace(/[.,;:!?'"]+$/, "");
	while (/[)\]]$/.test(url) && (url.match(/[([]/g)?.length ?? 0) < (url.match(/[)\]]/g)?.length ?? 0)) url = url.slice(0, -1).replace(/[.,;:!?'"]+$/, "");
	return url;
}

const ownLink = (url: string) => {
	try {
		return new URL(url).hostname === PUBLIC_HOSTNAME;
	} catch {
		return true;
	}
};

// X shortens what it shows of a link: no scheme, no www., 25 characters then …
function displayUrl(url: string): string {
	const bare = url.replace(/^https?:\/\/(www\.)?/, "");
	return [...bare].length > 26 ? `${[...bare].slice(0, 25).join("")}…` : bare;
}

// the links in a post's text, as X's url entities (indices count code points,
// like the mention and hashtag entities)
export function linkEntities(text: string) {
	return [...text.matchAll(LINK)].map((m) => {
		const url = trimLink(m[0]);
		const start = [...text.slice(0, m.index)].length;
		return { display_url: displayUrl(url), expanded_url: url, url, indices: [start, start + [...url].length] };
	});
}

// the link a post's card is for: its last one that leaves this instance
export function cardLink(text: string): string | undefined {
	const links = [...text.matchAll(LINK)].map((m) => trimLink(m[0])).filter((u) => u.length <= 2048 && !ownLink(u));
	return links.at(-1);
}

// addresses a link may not lead to: this machine, private networks, and the
// ranges that can stand for them
const PRIVATE = new BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const)
	PRIVATE.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 127], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const)
	PRIVATE.addSubnet(a, p, "ipv6");

async function publicHost(hostname: string): Promise<boolean> {
	const host = hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true }).catch(() => []);
	return addresses.length > 0 && addresses.every((a) => !PRIVATE.check(a.address, a.family === 6 ? "ipv6" : "ipv4"));
}

// GET a public http(s) address, following up to five redirects, each checked
// again. `cut`: keep the first maxBytes of a longer body instead of giving up.
async function fetchPublic(start: string, maxBytes: number, cut: boolean): Promise<{ url: string; type: string; body: Buffer } | undefined> {
	let url = start;
	for (let hop = 0; hop < 6; hop++) {
		const u = new URL(url);
		if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || (u.port && u.port !== "80" && u.port !== "443")) return undefined;
		if (!(await publicHost(u.hostname))) return undefined;
		const res = await fetch(u, {
			redirect: "manual",
			signal: AbortSignal.timeout(TIMEOUT_MS),
			headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,image/avif,image/webp,image/*;q=0.8,*/*;q=0.5", "accept-language": "en" },
		});
		const location = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && location) {
			await res.body?.cancel();
			url = new URL(location, u).href;
			continue;
		}
		if (!res.ok || !res.body) {
			await res.body?.cancel();
			return undefined;
		}
		if (!cut && Number(res.headers.get("content-length") ?? 0) > maxBytes) {
			await res.body.cancel();
			return undefined;
		}
		const chunks: Uint8Array[] = [];
		let size = 0;
		for await (const chunk of res.body) {
			chunks.push(chunk);
			size += chunk.length;
			if (size > maxBytes || (cut && size >= maxBytes)) break;
		}
		if (size > maxBytes && !cut) return undefined;
		return { url, type: res.headers.get("content-type") ?? "", body: Buffer.concat(chunks).subarray(0, maxBytes) };
	}
	return undefined;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“" };
function decode(s: string): string {
	return s
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
			if (e[0] === "#") {
				const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
				return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all;
			}
			return ENTITIES[e.toLowerCase()] ?? all;
		})
		.replace(/\s+/g, " ")
		.trim();
}

function pageText(body: Buffer, type: string): string {
	const declared = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(body.toString("latin1", 0, 4096))?.[1] ?? "utf-8";
	try {
		return new TextDecoder(declared).decode(body);
	} catch {
		return new TextDecoder().decode(body);
	}
}

// <meta property|name="…" content="…"> by lowercased key, first one winning
function metaTags(html: string): Map<string, string> {
	const tags = new Map<string, string>();
	for (const tag of html.matchAll(/<meta\b([^>]*)>/gi)) {
		const attrs = new Map<string, string>();
		for (const a of tag[1].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
		const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
		const content = attrs.get("content");
		if (key && content !== undefined && !tags.has(key)) tags.set(key, decode(content));
	}
	return tags;
}

const clip = (s: string | undefined, n: number) => (s ? ([...s].length > n ? `${[...s].slice(0, n - 1).join("")}…` : s) : undefined);

type CardRow = { url: string; ok: boolean; kind: string | null; title: string | null; description: string | null; domain: string | null; image: string | null; image_width: number | null; image_height: number | null; fetched_at: Date };

async function saveImage(src: string): Promise<{ name: string; width: number; height: number } | undefined> {
	const got = await fetchPublic(src, IMAGE_BYTES, false).catch(() => undefined);
	if (!got) return undefined;
	const image = sniffImage(got.body);
	if (!image || image.width < 1 || image.height < 1) return undefined;
	const ext = { "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/jpeg": "jpg" }[image.mime] ?? "img";
	const name = `${createHash("sha256").update(got.body).digest("hex").slice(0, 32)}.${ext}`;
	mkdirSync(CARD_DIR, { recursive: true });
	if (!existsSync(join(CARD_DIR, name))) writeFileSync(join(CARD_DIR, name), got.body);
	return { name, width: image.width, height: image.height };
}

async function fetchCard(url: string): Promise<void> {
	let row: Omit<CardRow, "url" | "fetched_at"> = { ok: false, kind: null, title: null, description: null, domain: null, image: null, image_width: null, image_height: null };
	try {
		const page = await fetchPublic(url, PAGE_BYTES, true);
		if (page && /html/i.test(page.type)) {
			const html = pageText(page.body, page.type);
			const tags = metaTags(html);
			const title = tags.get("og:title") || tags.get("twitter:title") || decode(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1] ?? "");
			if (title) {
				const description = tags.get("og:description") || tags.get("twitter:description") || tags.get("description");
				const src = tags.get("og:image:secure_url") || tags.get("og:image") || tags.get("og:image:url") || tags.get("twitter:image") || tags.get("twitter:image:src");
				let imageUrl: string | undefined;
				try {
					imageUrl = src ? new URL(src, page.url).href : undefined;
				} catch {}
				const image = imageUrl ? await saveImage(imageUrl) : undefined;
				// a big picture unless the site asks for the small card, or the picture is small
				const large = !!image && tags.get("twitter:card") !== "summary" && image.width >= 300;
				row = {
					ok: true,
					kind: large ? "summary_large_image" : "summary",
					title: clip(title, 200)!,
					description: clip(description, 300) ?? null,
					domain: new URL(page.url).hostname.replace(/^www\./, ""),
					image: image?.name ?? null,
					image_width: image?.width ?? null,
					image_height: image?.height ?? null,
				};
			}
		}
	} catch {}
	await sql`insert into link_cards ${sql({ url, ...row, fetched_at: new Date() })}
		on conflict (url) do update set ok = excluded.ok, kind = excluded.kind, title = excluded.title, description = excluded.description,
			domain = excluded.domain, image = excluded.image, image_width = excluded.image_width, image_height = excluded.image_height, fetched_at = excluded.fetched_at`;
}

// one fetch per link at a time, a few links at once
const running = new Map<string, Promise<void>>();
const waiting: (() => void)[] = [];
let active = 0;
const MAX_ACTIVE = 4;

function queueCard(url: string): Promise<void> {
	const known = running.get(url);
	if (known) return known;
	const job = (async () => {
		if (active >= MAX_ACTIVE) await new Promise<void>((go) => waiting.push(go));
		active++;
		try {
			await fetchCard(url);
		} finally {
			active--;
			waiting.shift()?.();
			running.delete(url);
		}
	})();
	running.set(url, job);
	return job;
}

// a new or edited post: its card is fetched now, and the post waits a little
// for it so the client's copy of the post already has it
export async function prepareCard(text: string): Promise<void> {
	const url = feature("link_cards") ? cardLink(text) : undefined;
	if (!url) return;
	const [row] = await sql`select fetched_at, ok from link_cards where url = ${url}`;
	if (row && Date.now() - row.fetched_at.getTime() < (row.ok ? REFRESH_MS : RETRY_MS)) return;
	await Promise.race([queueCard(url), Bun.sleep(4000)]);
}

const str = (v: string) => ({ type: "STRING", string_value: v });

function cardObject(c: CardRow) {
	const out: Record<string, unknown> = {
		title: str(c.title ?? ""),
		domain: str(c.domain ?? ""),
		vanity_url: { ...str(c.domain ?? ""), scribe_key: "vanity_url" },
		card_url: { ...str(c.url), scribe_key: "card_url" },
	};
	if (c.description) out.description = str(c.description);
	if (c.image) {
		const image = { type: "IMAGE", image_value: { url: `${PUBLIC_ORIGIN}/media/cards/${c.image}`, width: c.image_width, height: c.image_height } };
		const names = c.kind === "summary_large_image" ? ["photo_image_full_size", "summary_photo_image", "thumbnail_image"] : ["thumbnail_image"];
		for (const n of names) for (const size of ["", "_small", "_large", "_x_large", "_original"]) out[n + size] = image;
	}
	return {
		rest_id: c.url,
		legacy: {
			binding_values: Object.entries(out).map(([key, value]) => ({ key, value })),
			card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
			name: c.kind,
			url: c.url,
			user_refs_results: [],
		},
	};
}

// the cards for these posts' links, by post id; links not fetched yet (older
// posts, or ones whose card went stale) are fetched for the next time
export async function cardsForPosts(posts: { id: string; text: string }[]): Promise<Map<string, Record<string, unknown>>> {
	const out = new Map<string, Record<string, unknown>>();
	if (!feature("link_cards")) return out;
	const links = new Map(posts.map((p) => [p.id, cardLink(p.text)]).filter((e): e is [string, string] => !!e[1]));
	if (!links.size) return out;
	const rows: CardRow[] = await sql`select * from link_cards where url = any(${sql.array([...new Set(links.values())], "TEXT")})`;
	const byUrl = new Map(rows.map((r) => [r.url, r]));
	for (const url of new Set(links.values())) {
		const r = byUrl.get(url);
		if (!r || Date.now() - r.fetched_at.getTime() > (r.ok ? REFRESH_MS : RETRY_MS)) queueCard(url).catch(() => {});
	}
	for (const [id, url] of links) {
		const r = byUrl.get(url);
		if (r?.ok && r.kind) out.set(id, cardObject(r));
	}
	return out;
}

export function linkCardImage(pathname: string): Response {
	const name = /^\/media\/cards\/([0-9a-f]{32}\.(?:png|gif|webp|jpg))$/.exec(pathname)?.[1];
	if (!name || !existsSync(join(CARD_DIR, name))) return new Response("not found", { status: 404 });
	const type = { png: "image/png", gif: "image/gif", webp: "image/webp", jpg: "image/jpeg" }[name.split(".")[1]]!;
	return new Response(Bun.file(join(CARD_DIR, name)), { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
}
