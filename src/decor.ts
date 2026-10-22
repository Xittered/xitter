// Profile decor for gold and grey check accounts (verified_type 'business',
// 'government' or 'government_individual'), taken from
// the Steam Points Shop: a profile theme (Steam's own colour sets), a profile
// background (a picture, or a looping video) and an avatar frame. Kept in
// users.decor as { theme, background, frame }; the items carry only Steam's ids
// and file names, checked against Steam when they're picked, and the files come
// through /public/steam/ so viewers never talk to Steam themselves.

import { existsSync } from "node:fs";
import { StorageFailure, putFile } from "./disk";
import { declaredLength, readJson, readLimited } from "./federation";
import { join } from "node:path";
import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { MEDIA_DIR } from "./media";
import { STAFF_HANDLE } from "./invites";
import { RELATION_BUTTON } from "./x-selectors";
import { FILE_RE, fileUrl, rewardPage, shopBrowserScript, steamItem, steamProfile, type Item, type Kind } from "./steam-items";

const FILES = "https://shared.akamai.steamstatic.com/community_assets/images/items";
const THUMBS = "https://community.akamai.steamstatic.com/economy/profilebackground/items";
const STEAM_DIR = join(MEDIA_DIR, "steam");
const MAX_FILE = 40 * 1024 * 1024;

export type { Item, Kind };

// who may wear it: gold checks and both grey ones
export const DECOR_CHECKS = ["business", "government", "government_individual"];
const mayWear = (v: { verified_type: string | null }) => DECOR_CHECKS.includes(v.verified_type ?? "");

// profile: the game profile the rest came from, if it did
export type Decor = { theme?: string; background?: Item; frame?: Item; profile?: Item };

// Steam's profile themes, with the colours its profile page gives them (profilev2.css)
type Palette = { left: string; right: string; bgLeft: string; bgRight: string; bg: string; header: string; btn: string; btnHover: string; outline: string };
const p = (left: string, right: string, bg: string, bgRight: string, bgLeft: string, header: string, btn: string, btnHover: string, outline: string): Palette => ({ left, right, bg, bgRight, bgLeft, header, btn, btnHover, outline });
export const THEMES: Record<string, { name: string } & Palette> = {
	Summer: { name: "Summer", ...p("rgba(9,243,153,.247)", "rgba(252,197,16,.301)", "rgba(51,27,16,.93)", "rgba(252,197,16,0)", "rgba(48,243,9,.13)", "rgba(70,53,31,.93)", "rgb(95,76,39)", "rgb(105,86,49)", "rgb(145,126,89)") },
	Midnight: { name: "Midnight", ...p("rgba(12,85,241,.37)", "rgba(51,54,253,.233)", "rgba(10,14,32,.93)", "rgba(51,54,253,0)", "rgba(12,85,241,.13)", "rgba(34,32,61,.93)", "rgb(38,36,68)", "rgb(48,46,78)", "rgb(88,86,108)") },
	Steel: { name: "Steel", ...p("rgba(86,120,134,.37)", "rgba(70,106,128,.233)", "rgba(41,46,51,.93)", "rgba(17,24,29,0)", "rgba(19,27,31,0)", "rgba(55,62,76,.93)", "rgb(66,76,92)", "rgb(76,86,102)", "rgb(106,126,142)") },
	Cosmic: { name: "Cosmic", ...p("rgba(9,243,99,.247)", "rgba(248,70,180,.301)", "rgba(46,13,36,.93)", "rgba(70,227,248,0)", "rgba(239,243,9,.13)", "rgba(57,24,61,.93)", "rgb(90,40,92)", "rgb(100,50,102)", "rgb(140,90,142)") },
	DarkMode: { name: "Dark Mode", ...p("rgba(51,51,51,.37)", "rgba(49,49,49,.233)", "rgba(24,24,24,.93)", "rgba(34,34,34,0)", "rgba(32,32,32,.13)", "rgba(0,0,0,.5)", "rgba(0,0,0,.5)", "rgb(40,40,40)", "rgb(80,80,80)") },
	Gold: { name: "Gold", ...p("rgb(128 94 36)", "rgb(197 164 79 / 73%)", "rgb(116 93 44 / 64%)", "rgb(0 0 0 / 35%)", "rgb(0 0 0 / 35%)", "rgb(185 145 76 / 76%)", "rgb(145 116 66)", "rgb(169 132 68)", "rgb(108,90,86)") },
	GoldenProfileDebut: { name: "Golden", ...p("rgba(213,172,81,.62)", "rgba(156,66,17,.18)", "rgba(61,47,20,.6)", "rgba(0,0,0,0)", "rgba(243,200,9,.13)", "rgba(95,72,33,.82)", "rgb(125,98,44)", "rgb(135,108,54)", "rgb(175,148,94)") },
	GoldBurgundy: { name: "Gold Burgundy", ...p("rgb(97 75 37)", "rgb(253 219 51 / 23%)", "rgb(39 27 16 / 50%)", "rgb(0 0 0 / 35%)", "rgb(0 0 0 / 35%)", "rgb(53 28 22 / 76%)", "rgb(57 38 25)", "rgb(77 52 36)", "rgb(108,90,86)") },
	VibrantBlue: { name: "Vibrant Blue", ...p("rgb(47 137 188)", "#008ada8a", "#0203048a", "rgb(253 51 51 / 0%)", "rgb(12 140 241 / 17%)", "rgb(19 57 95)", "rgb(25 70 107)", "rgb(35 87 130)", "rgb(34 88 133)") },
	MutedBlue: { name: "Muted Blue", ...p("rgb(115 124 147)", "#737d96", "#2127338c", "rgb(253 51 51 / 0%)", "rgb(20 26 49 / 13%)", "rgb(30 44 66 / 54%)", "rgb(44 55 74)", "rgb(63 81 111)", "rgb(86 91 108)") },
	BlueRed: { name: "Blue Red", ...p("rgb(12 230 241 / 37%)", "rgb(253 56 51 / 23%)", "rgb(10 25 32 / 30%)", "rgb(253 51 51 / 15%)", "rgb(12 241 241 / 13%)", "rgb(64 23 23 / 50%)", "rgb(45 93 111)", "rgb(36 121 130)", "rgb(86 105 108)") },
	PinkTeal: { name: "Pink Teal", ...p("rgb(137 30 67)", "rgb(139 29 68)", "rgb(0 255 255 / 15%)", "rgb(0 0 0 / 0%)", "rgb(0 0 0 / 0%)", "rgb(42 117 122)", "rgb(42 117 122)", "rgb(57 166 173)", "rgb(55 162 169)") },
	MutedRed: { name: "Muted Red", ...p("rgb(163 53 53 / 37%)", "rgb(142 40 40 / 23%)", "rgb(96 17 2 / 30%)", "rgb(253 51 51 / 0%)", "rgba(241,12,12,.13)", "rgb(49 9 9 / 81%)", "rgb(58 13 10)", "rgb(105 26 21)", "rgb(108,90,86)") },
	BurntOrange: { name: "Burnt Orange", ...p("rgb(251 250 251 / 48%)", "rgb(136 66 8 / 66%)", "rgb(47 24 6 / 65%)", "rgb(19 8 2)", "rgb(8 2 5 / 0%)", "rgb(48 12 5 / 88%)", "rgb(50 15 7)", "rgb(89 31 17)", "rgb(86 30 17)") },
	SteamGreen: { name: "Steam Green", ...p("rgb(71 78 52)", "#393e2b", "rgb(53 58 39)", "rgb(194 253 51 / 0%)", "rgb(206 241 12 / 0%)", "rgb(62 69 44)", "rgb(73 82 53)", "rgb(82 91 59)", "rgb(92 111 45)") },
	GreenSlime: { name: "Green Slime", ...p("rgb(98 145 152 / 34%)", "rgb(254 249 156 / 30%)", "rgb(35 58 26 / 58%)", "rgb(0 0 0)", "rgb(0 0 0)", "rgb(27 38 18)", "rgb(33 45 20)", "rgb(80 101 35)", "rgb(86 109 37)") },
	Purple: { name: "Purple", ...p("#52298094", "#3c2c4c", "#20024380", "#0f021f", "#150329", "#4c2f69", "#40245c", "#5f3c80", "#603689") },
	Ghost: { name: "Ghost", ...p("rgb(3 3 4 / 46%)", "rgb(82 64 83 / 52%)", "rgb(93 123 137 / 32%)", "rgb(72 31 46)", "rgb(0 0 0)", "rgb(69 32 46)", "rgb(93 122 135)", "rgb(112 151 169)", "rgb(126 126 126 / 27%)") },
	ColorNightmare: { name: "Color Nightmare", ...p("rgb(243 106 9 / 25%)", "rgb(58 183 180 / 51%)", "rgb(0 0 0 / 50%)", "rgb(0 0 0)", "rgb(9 243 217 / 33%)", "rgb(57 144 152 / 61%)", "rgb(45 114 123)", "rgb(196 96 50)", "rgb(196 96 50)") },
	FlatGrey: { name: "Flat Grey", ...p("rgb(59 62 65 / 0%)", "#3b3e4100", "rgb(59 62 65)", "rgb(59 62 65 / 0%)", "rgb(59 62 65 / 0%)", "rgb(105 110 113)", "rgb(105 110 113)", "rgb(118 122 124)", "rgb(105 110 113)") },
	Winter2021: { name: "Winter", ...p("rgb(157 204 199 / 35%)", "rgb(87 136 137 / 14%)", "rgb(22 77 81 / 88%)", "rgb(95 165 155 / 15%)", "rgb(9 243 217 / 33%)", "rgb(184 99 69)", "rgb(184 99 69)", "rgb(206 131 36)", "rgb(196 96 50)") },
	Lunar2022: { name: "Lunar New Year", ...p("rgb(239 65 12)", "rgb(232 63 12 / 78%)", "rgb(58 44 122 / 83%)", "rgb(135 25 2 / 65%)", "rgb(211 72 31 / 60%)", "rgb(86 62 173)", "rgb(86 62 173)", "rgb(146 78 131)", "rgb(173 85 113)") },
};

// Steam's profile_content: four corner glows over the theme's backdrop
export const themeBackground = (t: Palette) =>
	`radial-gradient(farthest-side at top right,${t.right},transparent 500px),radial-gradient(farthest-corner at top left,${t.left},transparent 600px),` +
	`radial-gradient(farthest-corner at bottom right,${t.bgRight},transparent 500px),radial-gradient(farthest-corner at bottom left,${t.bgLeft},transparent 600px),${t.bg}`;

// Every app with items in the shop, named by the community API, for browsing
// without a search: Steam's own events (sales, Lunar New Year, Steam 3000 and
// the like, newest first) and games (A to Z). Built in the background, kept a
// day, and on disk so a restart doesn't wait for it.
type App = { appid: number; name: string };
type Apps = { at: number; events: App[]; games: App[] };
const APPS_FILE = join(STEAM_DIR, "apps.json");
let apps: Apps | undefined;
let building: Promise<Apps> | undefined;
async function buildApps(): Promise<Apps> {
	const r = await fetch("https://api.steampowered.com/ILoyaltyRewardsService/GetEligibleApps/v1/", { signal: AbortSignal.timeout(20_000) });
	if (!r.ok) throw new Error(`Steam answered ${r.status}`);
	const all: any[] = ((await readJson(r, 2 * 1024 * 1024))?.response?.apps ?? []).filter((a: any) => Number.isSafeInteger(a?.appid));
	const names = new Map<number, string>();
	const chunks: number[][] = [];
	for (let i = 0; i < all.length; i += 100) chunks.push(all.slice(i, i + 100).map((a) => a.appid as number));
	// a few at a time: Steam answers each in under a second
	for (let i = 0; i < chunks.length; i += 6)
		await Promise.all(
			chunks.slice(i, i + 6).map(async (chunk) => {
				const params = new URLSearchParams({ language: "0" });
				chunk.forEach((id, j) => params.set(`appids[${j}]`, String(id)));
				const got: any = await fetch(`https://api.steampowered.com/ICommunityService/GetApps/v1/?${params}`, { signal: AbortSignal.timeout(20_000) })
					.then((x) => (x.ok ? readJson(x, 2 * 1024 * 1024) : {}))
					.catch(() => ({}));
				for (const a of got?.response?.apps ?? []) if (typeof a?.name === "string" && a.name.trim()) names.set(a.appid, a.name.trim().slice(0, 80));
			}),
		);
	const named = (a: any): App => ({ appid: a.appid, name: names.get(a.appid) ?? "" });
	const events = all
		.filter((a) => a.event_app && a.has_items_anyone_can_purchase)
		.map(named)
		.map((e) => ({ ...e, name: e.name || `Steam event ${e.appid}` }))
		.sort((a, b) => b.appid - a.appid);
	const games = all
		.filter((a) => !a.event_app)
		.map(named)
		.filter((g) => g.name)
		.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
	const built = { at: Date.now(), events, games };
	if (games.length) {
		try {
			await putFile(APPS_FILE, Buffer.from(JSON.stringify(built)));
		} catch (e) {
			if (!(e instanceof StorageFailure)) throw e;
			console.error(e);
		}
	}
	return built;
}
async function steamApps(): Promise<Apps> {
	if (!apps && existsSync(APPS_FILE)) apps = await Bun.file(APPS_FILE).json().catch(() => undefined);
	if ((!apps || Date.now() - apps.at > 24 * 3600_000) && !building)
		building = buildApps()
			.then((b) => (apps = b))
			.finally(() => (building = undefined));
	// an old list does while the new one is built
	return apps ?? (await building!);
}

// GET /i/api/xitter/decor/catalog: { events: [{ appid, name }], games: [...] }
export async function decorCatalog(): Promise<Response> {
	try {
		const { events, games } = await steamApps();
		return Response.json({ events, games }, { headers: { "cache-control": "private, max-age=3600" } });
	} catch {
		return Response.json({ error: "Steam isn't answering. Try again in a minute." }, { status: 502 });
	}
}

// a page of the shop, newest first: of one game (app), of Steam's events
// (event: "all" or one event's appid), of the games a search finds, and only
// what moves (animated). Cached a few minutes so browsing doesn't ask Steam
// for the same page again.
type Filter = { q: string; app: string; event: string; animated: boolean };
const pages = new Map<string, { at: number; value: { items: Item[]; next: string | null } }>();
async function catalogPage(kind: Kind, f: Filter, cursor: string): Promise<{ items: Item[]; next: string | null }> {
	const key = `${kind}|${f.q}|${f.app}|${f.event}|${f.animated}|${cursor}`;
	const hit = pages.get(key);
	if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
	const appids: number[] = [];
	if (f.app) appids.push(Number(f.app));
	else if (f.event) {
		const { events } = await steamApps();
		const ids = f.event === "all" ? events.map((e) => e.appid) : events.filter((e) => String(e.appid) === f.event).map((e) => e.appid);
		if (!ids.length) return { items: [], next: null };
		appids.push(...ids);
	} else if (f.q) {
		// Steam's shop can't search names, but it filters by game: the store's
		// search turns the words into games
		const found = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(f.q)}&cc=us&l=english`, { signal: AbortSignal.timeout(10_000) })
			.then((r) => (r.ok ? r.json() : { items: [] }))
			.catch(() => ({ items: [] }));
		const ids = (found.items ?? []).filter((a: any) => Number.isSafeInteger(a?.id)).slice(0, 10);
		if (!ids.length) return { items: [], next: null };
		for (const a of ids) appids.push(a.id);
	}
	const value = await rewardPage(kind, { appids, animated: f.animated, cursor });
	if (pages.size > 500) pages.clear();
	pages.set(key, { at: Date.now(), value });
	return value;
}

// GET /i/api/xitter/decor/shop?kind=frame|background|profile&app=&event=&animated=1&q=&cursor=
export async function decorShop(url: URL): Promise<Response> {
	const kind = url.searchParams.get("kind");
	if (kind !== "frame" && kind !== "background" && kind !== "profile") return Response.json({ error: "unknown kind" }, { status: 400 });
	const event = url.searchParams.get("event") ?? "";
	const app = url.searchParams.get("app") ?? "";
	if ((event && event !== "all" && !/^\d{1,10}$/.test(event)) || (app && !/^\d{1,10}$/.test(app))) return Response.json({ error: "unknown category" }, { status: 400 });
	const f = { q: (url.searchParams.get("q") ?? "").trim().slice(0, 80), app, event, animated: url.searchParams.get("animated") === "1" };
	const cursor = (url.searchParams.get("cursor") ?? "").slice(0, 200);
	try {
		const page = await catalogPage(kind, f, cursor);
		return Response.json(
			{
				items: page.items.map((i) => ({
					...i,
					thumb: kind === "background" ? `${fileUrl(i.appid, i.image)}?thumb=1` : fileUrl(i.appid, i.image),
					// what plays while the pointer is on the tile
					moving: i.anim ? fileUrl(i.appid, i.anim) : i.preview ? fileUrl(i.appid, i.preview) : null,
				})),
				next: page.next,
			},
			{ headers: { "cache-control": "private, max-age=300" } },
		);
	} catch {
		return Response.json({ error: "Steam isn't answering. Try again in a minute." }, { status: 502 });
	}
}

// /public/steam/<appid>/<file>: a Steam item's file. Worn items are seen by
// everyone, so they're kept on disk once fetched; anything else is only passed
// through, for a signed-in account browsing the shop (?thumb=1 is a small
// picture of a background), and never a video.
const fetching = new Map<string, Promise<boolean>>();
export async function steamFile(req: Request, appid: string, file: string, thumb: boolean, signedIn: boolean): Promise<Response> {
	if (!/^\d{1,10}$/.test(appid) || !FILE_RE.test(file)) return new Response("not found", { status: 404 });
	const type = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webm: "video/webm", mp4: "video/mp4" }[file.split(".")[1]!]!;
	const cache = "public, max-age=31536000, immutable";
	const path = join(STEAM_DIR, appid, file);
	const worn = async () =>
		(
			await sql`select 1 from users
				where (decor is not null and strpos(decor::text, ${file + '"'}) > 0)
					or preferences #>> '{theme,background,steam,image}' = ${file}
					or preferences #>> '{theme,background,steam,movie}' = ${file}
					or preferences #>> '{theme,background,steam,mp4}' = ${file}
				limit 1`
		).length > 0;
	if (thumb || (!existsSync(path) && !(await worn()))) {
		if (!signedIn) return new Response("not found", { status: 404 });
		// a shop preview video plays in pieces, so the range goes along
		const range = type.startsWith("video/") ? req.headers.get("range") : null;
		const r = await fetch(thumb && file.endsWith(".jpg") ? `${THUMBS}/${appid}/${file}?size=320x140` : `${FILES}/${appid}/${file}`, {
			headers: range ? { range } : {},
			signal: AbortSignal.timeout(15_000),
		}).catch(() => undefined);
		if (!r?.ok || declaredLength(r.headers.get("content-length"), MAX_FILE) === undefined) {
			await r?.body?.cancel().catch(() => {});
			return new Response("not found", { status: 404 });
		}
		const headers: Record<string, string> = { "content-type": type, "cache-control": "private, max-age=86400" };
		for (const h of ["content-length", "content-range", "accept-ranges"]) if (r.headers.get(h)) headers[h] = r.headers.get(h)!;
		return new Response(r.body, { status: r.status, headers });
	}
	if (!existsSync(path)) {
		const key = `${appid}/${file}`;
		let job = fetching.get(key);
		if (!job) {
			job = (async () => {
				const r = await fetch(`${FILES}/${appid}/${file}`, { signal: AbortSignal.timeout(60_000) }).catch(() => undefined);
				if (!r?.ok) return false;
				let body: Uint8Array;
				try {
					body = await readLimited(r, MAX_FILE);
				} catch {
					return false;
				}
				await putFile(path, Buffer.from(body));
				return true;
			})().finally(() => fetching.delete(key));
			fetching.set(key, job);
		}
		if (!(await job)) return new Response("not found", { status: 404 });
	}
	const f = Bun.file(path);
	// videos are asked for in pieces
	const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") ?? "");
	if (range && (range[1] || range[2])) {
		const size = f.size;
		const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
		if (start > end || start >= size) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
		return new Response(f.slice(start, end + 1), {
			status: 206,
			headers: { "content-type": type, "cache-control": cache, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}` },
		});
	}
	return new Response(f, { headers: { "content-type": type, "cache-control": cache, "accept-ranges": "bytes" } });
}

const clean = (d: unknown): Decor => {
	const out: Decor = {};
	if (!d || typeof d !== "object") return out;
	const o = d as Record<string, any>;
	if (typeof o.theme === "string" && THEMES[o.theme]) out.theme = o.theme;
	if (o.background && typeof o.background === "object") out.background = o.background;
	if (o.frame && typeof o.frame === "object") out.frame = o.frame;
	if (o.profile && typeof o.profile === "object") out.profile = o.profile;
	return out;
};

// what the page script draws: the files as our addresses
const forClient = (d: Decor) => ({
	theme: d.theme ? { id: d.theme, background: themeBackground(THEMES[d.theme]!), header: THEMES[d.theme]!.header, button: THEMES[d.theme]!.btn, buttonHover: THEMES[d.theme]!.btnHover, outline: THEMES[d.theme]!.outline, glass: `color-mix(in srgb,rgb(from ${THEMES[d.theme]!.bg} r g b) 30%,rgb(0 0 0 / .45))` } : null,
	background: d.background
		? { image: fileUrl(d.background.appid, d.background.image), movie: d.background.movie ? fileUrl(d.background.appid, d.background.movie) : null, mp4: d.background.mp4 ? fileUrl(d.background.appid, d.background.mp4) : null }
		: null,
	frame: d.frame ? fileUrl(d.frame.appid, d.frame.anim ?? d.frame.image) : null,
	frameStill: d.frame ? fileUrl(d.frame.appid, d.frame.image) : null,
});

// GET /i/api/xitter/decor?names=a,b: { a: { theme, background, frame }, ... },
// only gold and grey check accounts that wear something
export async function decorFor(url: URL): Promise<Response> {
	const names = [...new Set((url.searchParams.get("names") ?? "").split(",").map((n) => n.trim().toLowerCase()).filter((n) => STAFF_HANDLE.test(n)))].slice(0, 50);
	const out: Record<string, ReturnType<typeof forClient>> = {};
	if (names.length) {
		const rows = await sql`select screen_name, decor from users where lower(screen_name) = any(${sql.array(names, "TEXT")})
			and instance is null and verified_type = any(${sql.array(DECOR_CHECKS, "TEXT")}) and status <> 'suspended' and decor is not null`;
		for (const r of rows) {
			const d = clean(r.decor);
			if (d.theme || d.background || d.frame) out[r.screen_name.toLowerCase()] = forClient(d);
		}
	}
	return Response.json(out, { headers: { "cache-control": "private, max-age=60" } });
}

// Settings > Profile decor
const swatch = (id: string) => `<span class="swatch" style="background:${themeBackground(THEMES[id]!)}"></span>`;

async function page(req: Request, viewer: Viewer, d: Decor, error = "") {
	const gold = mayWear(viewer);
	const form = (fields: string, label: string, kind = "") =>
		`<form method="post" action="/account/decor" class="inline"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}">${fields}<button type="submit"${kind ? ` class="${kind}"` : ""}>${esc(label)}</button></form>`;
	const worn = (kind: Kind, label: string) => {
		const i = d[kind];
		const preview = i
			? kind === "frame"
				? `<div class="framed"><img class="pfp" src="${esc(viewer.avatar_url ?? "/public/default-avatar.png")}" alt=""><img class="ring" src="${fileUrl(i.appid, i.anim ?? i.image)}" alt=""></div>`
				: `<img class="bgpreview" src="${fileUrl(i.appid, i.image)}" alt="">`
			: "";
		return `<div class="card split"><div><b>${label}</b><div class="meta">${i ? esc(i.name) : "None"}</div></div>${preview}${
			i ? form(`<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="defid" value="">`, "Remove", "small secondary") : ""
		}</div>`;
	};
	const themes = Object.entries(THEMES)
		.map(
			([id, t]) =>
				`<button type="submit" name="theme" value="${id}" class="theme${d.theme === id ? " on" : ""}" title="${esc(t.name)}">${swatch(id)}<span>${esc(t.name)}</span></button>`,
		)
		.join("");
	const body = gold
		? `<h1>Profile decor</h1>
	<p class="dim">Gold and grey check accounts can dress their profile with items from the Steam Points Shop: a theme, a background and an avatar frame. Your profile shows them to everyone here; your frame shows on your posts too.</p>
	${error ? `<p class="error">${esc(error)}</p>` : ""}
	<h2>Wearing</h2>
	<div class="card split"><div><b>Theme</b><div class="meta">${d.theme ? esc(THEMES[d.theme]!.name) : "None"}</div></div>${d.theme ? swatch(d.theme) : ""}${
		d.theme ? form('<input type="hidden" name="theme" value="">', "Remove", "small secondary") : ""
	}</div>
	${d.profile ? `<div class="card split"><div><b>Game profile</b><div class="meta">${esc(d.profile.name)}</div></div><img class="bgpreview" src="${fileUrl(d.profile.appid, d.profile.image)}" alt=""></div>` : ""}
	${worn("background", "Background")}
	${worn("frame", "Avatar frame")}
	<h2>Themes</h2>
	<form method="post" action="/account/decor" class="themes"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}">${themes}</form>
	<h2>Steam items</h2>
	<div class="row tabsel"><button type="button" class="small" data-kind="frame">Avatar frames</button><button type="button" class="small secondary" data-kind="background">Backgrounds</button><button type="button" class="small secondary" data-kind="profile">Game profiles</button></div>
	<p class="dim">A game profile is Steam's set for one game: its background, avatar frame and theme, worn together.</p>
	<div class="row" id="cats"></div>
	<div class="row" id="sub"></div>
	<form class="row" id="search"><input name="q" placeholder="Or search by game, like Portal 2" autocomplete="off"><button type="submit" class="small">Search</button></form>
	<div id="shop" class="shop" data-csrf="${esc(viewer.csrf)}" data-avatar="${esc(viewer.avatar_url ?? "")}"></div>
	<button type="button" id="more" class="secondary" hidden>Load more</button>
	<p class="dim">Items and art belong to Valve and the games' makers, shown from Steam.</p>
	<script>${shopBrowserScript()}</script>`
		: `<h1>Profile decor</h1><p class="dim">Profile themes, backgrounds and avatar frames from Steam are for gold and grey check accounts.</p>`;
	return accountPage({ req, viewer, title: "Profile decor", status: error ? 400 : 200, body, css: PAGE_CSS });
}

const PAGE_CSS = `
.swatch{display:inline-block;width:56px;height:32px;border-radius:8px;flex:none}
.themes{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;justify-items:stretch}
.theme{display:flex;flex-direction:column;align-items:flex-start;gap:6px;height:auto;padding:8px;border-radius:12px;background:var(--surface);color:var(--text);font-weight:500;white-space:normal;text-align:left}
.theme .swatch{width:100%;height:40px}
.theme.on{outline:2px solid var(--accent)}
@media (hover:hover){.theme:hover:not(:disabled){background:var(--hover)}}
.framed{position:relative;width:48px;height:48px;flex:none}
.framed .pfp{width:100%;height:100%;border-radius:4px;object-fit:cover}
.framed .ring{position:absolute;inset:-11%;width:122%;height:122%;pointer-events:none}
.bgpreview{width:96px;height:42px;object-fit:cover;border-radius:6px;flex:none}
.shop{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.shop.wide{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}
.shop button{display:flex;flex-direction:column;gap:6px;height:auto;padding:10px;border-radius:12px;background:var(--surface);color:var(--text);font-weight:500;white-space:normal;text-align:left;font-size:13px;line-height:16px}
@media (hover:hover){.shop button:hover:not(:disabled){background:var(--hover)}}
.shop .framed{width:72px;height:72px;margin:10px auto}
.shop .bg{width:100%;aspect-ratio:320/140;object-fit:cover;border-radius:8px}
.tabsel button[aria-pressed="true"]{pointer-events:none}
#cats:empty,#sub:empty{display:none}
#sub select{width:auto;max-width:100%}
#sub button{min-width:32px;padding:0 10px}
.games{display:flex;flex-wrap:wrap;gap:6px}
.shop>p{grid-column:1/-1}
.games button{font-weight:500}
`;

export async function decorRoute(req: Request, viewer: Viewer): Promise<Response> {
	const [row] = await sql`select decor from users where id = ${viewer.id}::bigint`;
	const d = clean(row?.decor);
	if (req.method !== "POST") return page(req, viewer, d);
	if (!mayWear(viewer)) return page(req, viewer, d, "Profile decor is for gold and grey check accounts.");
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, d, "That form is out of date. Try again.");
	const theme = f?.get("theme");
	if (theme !== null && theme !== undefined) {
		const id = String(theme);
		if (id && !THEMES[id]) return page(req, viewer, d, "That isn't a theme.");
		if (id) d.theme = id;
		else delete d.theme;
	} else {
		const kind = String(f?.get("kind") ?? "");
		if (kind === "profile") {
			const defid = String(f?.get("defid") ?? "");
			if (!/^\d{1,12}$/.test(defid)) return page(req, viewer, d, "That isn't a Steam item.");
			const set = await steamProfile(Number(defid)).catch(() => undefined);
			if (!set) return page(req, viewer, d, "Steam doesn't have that game profile.");
			d.profile = set.profile;
			if (set.background) d.background = set.background;
			if (set.frame) d.frame = set.frame;
			if (set.theme && THEMES[set.theme]) d.theme = set.theme;
			await sql`update users set decor = ${JSON.stringify(d)}::text::jsonb where id = ${viewer.id}::bigint`;
			return new Response(null, { status: 303, headers: { location: "/account/decor" } });
		}
		if (kind !== "frame" && kind !== "background") return page(req, viewer, d, "That isn't a decor slot.");
		const defid = String(f?.get("defid") ?? "");
		delete d.profile;
		if (!defid) delete d[kind];
		else {
			if (!/^\d{1,12}$/.test(defid)) return page(req, viewer, d, "That isn't a Steam item.");
			const item = await steamItem(kind, Number(defid)).catch(() => undefined);
			if (!item) return page(req, viewer, d, kind === "frame" ? "Steam doesn't have that avatar frame." : "Steam doesn't have that background.");
			d[kind] = item;
		}
	}
	const empty = !d.theme && !d.background && !d.frame;
	await sql`update users set decor = ${empty ? null : JSON.stringify(d)}::text::jsonb where id = ${viewer.id}::bigint`;
	return new Response(null, { status: 303, headers: { location: "/account/decor" } });
}

// The page script: frames on avatars everywhere, and on a decorated profile its
// background behind the page and its theme on the column.
export const DECOR_SCRIPT = String.raw`(function(){
	var RELATION=${JSON.stringify(RELATION_BUTTON)};
	var known={},waiting={},queue=[],timer,current=null;
	var still=matchMedia("(prefers-reduced-motion: reduce)").matches;
	var RESERVED=/^(home|explore|notifications|messages|i|settings|search|compose|account|admin|login|logout|signup|tos|privacy|jobs|bookmarks|lists|communities|premium|verified-choose|public|abs|hashtag|intent)$/;
	function profileName(){
		var m=/^\/([A-Za-z0-9_]{1,15})(?:\/(?:with_replies|media|likes|highlights|articles|superfollows|affiliates))?\/?$/.exec(location.pathname);
		return m&&!RESERVED.test(m[1].toLowerCase())?m[1].toLowerCase():null;
	}
	function want(n){if(known[n]===undefined&&!waiting[n]){waiting[n]=true;queue.push(n)}}
	function frames(){
		document.querySelectorAll('[data-testid^="UserAvatar-Container-"]').forEach(function(box){
			var n=box.getAttribute("data-testid").slice(21).toLowerCase();
			if(!/^[a-z0-9_]{1,15}$/.test(n))return;
			var k=known[n];
			if(k===undefined){want(n);return}
			var ring=box.querySelector(":scope > [data-xitter-frame]");
			var src=k&&(still?k.frameStill:k.frame);
			if(!src){if(ring)ring.remove();box.removeAttribute("data-xitter-framed");return}
			box.setAttribute("data-xitter-framed","");
			if(ring&&ring.getAttribute("src")===src)return;
			if(ring)ring.remove();
			ring=document.createElement("img");
			ring.setAttribute("data-xitter-frame","");ring.alt="";ring.draggable=false;ring.src=src;
			if(getComputedStyle(box).position==="static")box.style.position="relative";
			box.style.overflow="visible";
			box.appendChild(ring);
		});
	}
	// X's muted text, dark and dim, is a class of its own; found by its colour
	function greyRules(){
		var out=[];
		[].forEach.call(document.styleSheets,function(sheet){
			var rules;try{rules=sheet.cssRules}catch(e){return}
			[].forEach.call(rules||[],function(r){
				if(r.selectorText&&r.style&&/^rgba?\((113, 118, 123|139, 152, 165)(, 1)?\)$/.test(r.style.color)&&/^\.[\w-]+$/.test(r.selectorText))out.push(r.selectorText);
			});
		});
		return out;
	}
	var layer,style;
	function clearProfile(){
		if(layer){layer.remove();layer=null}
		if(style){style.remove();style=null}
		document.querySelectorAll("[data-xitter-glass],[data-xitter-clear]").forEach(function(el){el.removeAttribute("data-xitter-glass");el.removeAttribute("data-xitter-clear")});
		seen=new WeakSet();
		greys.textContent="";greyKey="";greyAt=0;
		document.documentElement.removeAttribute("data-xitter-decor");
		current=null;
	}
	function profile(){
		var n=profileName();
		// a dialog opened over the profile (Edit profile, a photo) has an address of
		// its own, but the profile stays behind it, and so does its decor
		if(!n&&current&&(document.querySelector('[aria-modal="true"]')||document.querySelector('[data-testid="primaryColumn"] [data-testid="UserName"]')))return;
		if(!n){if(current)clearProfile();return}
		var k=known[n];
		if(current&&current!==n)clearProfile();
		if(k===undefined){want(n);return}
		if(!k||(!k.background&&!k.theme))return;
		if(current===n)return;
		clearProfile();current=n;
		// X's own colour sits on the body inline: a viewer's theme paints over the
		// computed one, and the decor follows X's mode, not the theme it replaces
		var light=/^rgb\(255, 255, 255/.test(document.body.style.backgroundColor||getComputedStyle(document.body).backgroundColor);
		document.documentElement.setAttribute("data-xitter-decor","");
		var t=k.theme;
		var css="",glass=light?"rgba(255,255,255,.66)":"rgba(0,0,0,.55)",edge=light?"rgba(0,0,0,.08)":"rgba(255,255,255,.14)",frost="-webkit-backdrop-filter:blur(24px) saturate(1.4);backdrop-filter:blur(24px) saturate(1.4)";
		layer=document.createElement("div");
		layer.setAttribute("data-xitter-decor-bg","");
		var bg=k.background;
		if(!bg)layer.style.background=(light?"linear-gradient(rgba(255,255,255,.8),rgba(255,255,255,.8)),":"linear-gradient(rgba(0,0,0,.4),rgba(0,0,0,.4)),")+t.background;
		else if(bg.movie||bg.mp4){
			var v=document.createElement("video");
			v.muted=true;v.loop=true;v.autoplay=true;v.playsInline=true;v.setAttribute("playsinline","");v.poster=bg.image;
			if(bg.movie){var s1=document.createElement("source");s1.src=bg.movie;s1.type="video/webm";v.appendChild(s1)}
			if(bg.mp4){var s2=document.createElement("source");s2.src=bg.mp4;s2.type="video/mp4";v.appendChild(s2)}
			if(still)v.autoplay=false;
			layer.appendChild(v);
		}else{var pic=document.createElement("img");pic.src=bg.image;pic.alt="";layer.appendChild(pic)}
		document.body.prepend(layer);
		var pane='background:'+glass+'!important;'+(t&&!light?"background:"+t.glass+"!important;":"")+frost;
		css+='html[data-xitter-decor] header[role="banner"]>div>div,html[data-xitter-decor] [data-xitter-glass]{'+pane+';border-color:'+edge+'!important}'+
			'html[data-xitter-decor] [data-testid="primaryColumn"]{background:transparent!important;position:relative;z-index:0;border-color:'+edge+'!important}'+
			'html[data-xitter-decor] [data-testid="primaryColumn"]::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;'+pane+'}'+
			'html[data-xitter-decor] [data-xitter-clear]{background:transparent!important}'+
			'html[data-xitter-decor],html[data-xitter-decor] body{background:transparent!important}'+
			'html[data-xitter-decor] #react-root>div>div,html[data-xitter-decor] #react-root>div>div>div:not([data-testid]){background-color:transparent!important}';
		dark=!light;
		if(t&&!light)css+='html[data-xitter-decor] [data-testid="primaryColumn"] [data-testid="placementTracking"] '+RELATION+',html[data-xitter-decor] [data-testid="primaryColumn"] a[data-testid="editProfileButton"]{background:'+t.button+'!important;border-color:'+t.outline+'!important}'+
			'html[data-xitter-decor] [data-testid="primaryColumn"] [data-testid="placementTracking"] '+RELATION+' *,html[data-xitter-decor] [data-testid="primaryColumn"] a[data-testid="editProfileButton"] *{color:#fff!important}'+
			'@media (hover:hover){html[data-xitter-decor] [data-testid="primaryColumn"] [data-testid="placementTracking"] '+RELATION+':hover,html[data-xitter-decor] [data-testid="primaryColumn"] a[data-testid="editProfileButton"]:hover{background:'+t.buttonHover+'!important}}';
		style=document.createElement("style");style.setAttribute("data-xitter-decor-css","");style.textContent=css;document.head.appendChild(style);
		greys.textContent="";greyKey="";glassAt=0;lighten();sidebar();
	}
	var glassAt=0,glassTimer=null,seen=new WeakSet();
	function sidebar(){
		if(!current||!layer)return;
		if(Date.now()-glassAt<300){if(!glassTimer)glassTimer=setTimeout(function(){glassTimer=null;sidebar()},300);return}
		glassAt=Date.now();
		var page=document.body.style.backgroundColor||"rgb(0, 0, 0)";
		document.querySelectorAll('[data-testid="sidebarColumn"] div,[data-testid="primaryColumn"] div').forEach(function(el){
			if(seen.has(el))return;
			seen.add(el);
			var cs=getComputedStyle(el),opaque=cs.backgroundColor===page;
			if(el.closest('[data-testid="sidebarColumn"]')){if(opaque)el.setAttribute(parseFloat(cs.borderTopLeftRadius)>0?"data-xitter-glass":"data-xitter-clear","");return}
			if(opaque||cs.backdropFilter!=="none"&&cs.backdropFilter)el.setAttribute("data-xitter-clear","");
		});
	}
	// X adds its classes as it first uses them: the grey ones are looked for again
	// while a decorated profile is up, a second apart at most
	var greys=document.createElement("style"),greyKey="",greyAt=0,dark=false;
	greys.setAttribute("data-xitter-decor-grey","");
	function lighten(){
		if(!current||!dark||Date.now()-greyAt<1000)return;
		greyAt=Date.now();
		// some of it is coloured inline instead
		var found=greyRules().concat(['[style*="color: rgb(113, 118, 123)"]','[style*="color: rgb(139, 152, 165)"]']),key=found.join(",");
		if(key===greyKey)return;
		greyKey=key;
		greys.textContent=found.map(function(sel){return 'html[data-xitter-decor] [data-testid="primaryColumn"] '+sel+'{color:rgb(206,211,216)!important}'}).join("");
		if(!greys.isConnected)document.head.appendChild(greys);
	}
	function scan(){
		frames();profile();lighten();sidebar();
		if(queue.length)load();
	}
	function load(){
		var names=queue.splice(0,50);
		fetch("/i/api/xitter/decor?names="+names.join(","),{credentials:"same-origin"})
			.then(function(r){return r.json()})
			.then(function(d){names.forEach(function(n){known[n]=d[n]||null;delete waiting[n]});scan()})
			.catch(function(){names.forEach(function(n){delete waiting[n]})});
	}
	var base=document.createElement("style");
	// Steam's frames are drawn around a square picture: a round one leaves gaps
	// in the corners, so a framed picture is squared off
	base.textContent='[data-xitter-framed] div{border-radius:4%!important}'+
		'[data-xitter-frame]{position:absolute;left:-11%;top:-11%;width:122%;height:122%;max-width:none;pointer-events:none;z-index:1}'+
		'[data-xitter-decor-bg]{position:fixed;inset:0;z-index:-1;background:#000;overflow:hidden;pointer-events:none}'+
		'[data-xitter-decor-bg] video,[data-xitter-decor-bg] img{position:absolute;left:50%;top:0;width:max(108vw,230vh);height:auto;max-width:none;transform:translateX(-50%)}';
	document.head.appendChild(base);
	new MutationObserver(function(){if(!timer)timer=setTimeout(function(){timer=null;scan()},150)}).observe(document.documentElement,{childList:true,subtree:true});
	addEventListener("popstate",scan);
})();`;
