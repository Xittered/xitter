// The public API under /api/v1: plain JSON for bots and scripts, signed in
// with a personal token from /account/api ("Authorization: Bearer xit_...").
// Writes go through the same operations the client calls (graphql.ts), so
// every rule the app enforces holds here too; reads use the same visibility
// (blocks, protected accounts, suspensions). The rate limits are the
// client's. /api is the documentation.

import { type User, type Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { callOperation } from "./graphql";
import { newId } from "./ids";
import { absolute, mediaUpload, mediaUrl, posterUrl } from "./media";
import type { PostRow } from "./model";
import { PostError, feed, getPost, postsByIds, replies, type FeedItem } from "./posts";
import { type Bucket, limitHeaders, limitedResponse, noteRefusal, take } from "./ratelimit";
import { searchPosts, searchUsers } from "./search";
import { settings } from "./settings";
import { followList, setFollow, userByName, usersByIds } from "./users";

const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const MAX_TOKENS = 10;
const isId = (x: unknown): x is string => typeof x === "string" && /^\d{1,19}$/.test(x);

class ApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

// ---- tokens

export async function createToken(userId: string, name: string, scope: "read" | "write") {
	const [{ n }] = await sql`select count(*)::int as n from api_tokens where user_id = ${userId}::bigint`;
	if (n >= MAX_TOKENS) throw new ApiError(400, `You can have up to ${MAX_TOKENS} tokens. Delete one first.`);
	const token = `xit_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
	await sql`insert into api_tokens (id, user_id, name, token_hash, scope) values (${newId()}::bigint, ${userId}::bigint, ${name}, ${hash(token)}, ${scope})`;
	return token;
}

async function tokenViewer(req: Request): Promise<{ viewer: Viewer; scope: string } | undefined> {
	const token = /^Bearer\s+(xit_[0-9a-f]{48})$/i.exec(req.headers.get("authorization") ?? "")?.[1];
	if (!token) return undefined;
	const [row] = await sql`
		select u.id::text, u.screen_name, u.name, u.bio, u.location, u.website, u.avatar_url, u.banner_url, u.verified_type, u.flag, u.status, u.role, u.protected, u.language, u.created_at,
			t.scope, t.id::text as token_id, t.last_used_at
		from api_tokens t join users u on u.id = t.user_id
		where t.token_hash = ${hash(token)} and u.status <> 'suspended' and u.deactivated_at is null`;
	if (!row) return undefined;
	if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) await sql`update api_tokens set last_used_at = now() where id = ${row.token_id}::bigint`;
	const { scope, token_id: _id, last_used_at: _used, ...user } = row;
	// staff tokens are limited like anyone's: the exemption is for the panel
	return { viewer: { ...user, role: null, csrf: "", token: "", postSource: "Xitter API" } as Viewer, scope };
}

// ---- shapes

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function userJson(u: User) {
	return {
		id: u.id,
		screen_name: u.screen_name,
		name: u.name,
		bio: u.bio ?? "",
		location: u.location ?? "",
		website: u.website || null,
		avatar_url: absolute(u.avatar_url),
		banner_url: absolute(u.banner_url),
		verified_type: u.verified_type,
		protected: !!u.protected,
		created_at: iso(u.created_at),
		url: `${PUBLIC_ORIGIN}/${u.screen_name}`,
		...(u.stats
			? {
					counts: { posts: u.stats.posts, followers: u.stats.followers, following: u.stats.following, likes: u.stats.likes },
					viewer: { following: u.stats.followedByViewer, followed_by: u.stats.followsViewer },
				}
			: {}),
	};
}

function postJson(p: PostRow, repostBy?: { by: User; created_at: Date }) {
	return {
		id: p.id,
		text: p.text,
		created_at: iso(p.created_at),
		edited_at: iso(p.edited_at),
		url: `${PUBLIC_ORIGIN}/${p.author.screen_name}/status/${p.id}`,
		author: userJson(p.author),
		reply_to: p.reply_to_id,
		quote_of: p.quote_id,
		sensitive: !!p.sensitive,
		counts: { likes: p.like_count, reposts: p.repost_count, replies: p.reply_count, quotes: p.quote_count, bookmarks: p.bookmark_count, views: p.view_count ?? 0 },
		viewer: { liked: p.liked, reposted: p.reposted, bookmarked: p.bookmarked },
		media: (p.media ?? []).map((m) => ({
			id: m.id,
			type: m.kind === "video" ? "video" : m.mime === "image/gif" ? "gif" : "photo",
			url: mediaUrl(m.id, m.mime),
			...(m.kind === "video" ? { poster_url: posterUrl(m.id) } : {}),
			width: m.width,
			height: m.height,
			alt_text: m.alt_text ?? null,
		})),
		...(repostBy ? { reposted_by: userJson(repostBy.by), reposted_at: iso(repostBy.created_at) } : {}),
	};
}

const itemJson = (i: FeedItem) => postJson(i.post, i.repost);

// a page of feed items, and the cursor for the next one
const page = (items: FeedItem[], limit: number) => ({
	data: items.map(itemJson),
	next_cursor: items.length >= limit ? items[items.length - 1].id : null,
});

// ---- requests

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const fail = (status: number, message: string) => json({ error: message }, status);

const limitOf = (url: URL, max = 100) => Math.min(Math.max(Number(url.searchParams.get("limit")) || 20, 1), max);
const cursorOf = (url: URL) => {
	const c = url.searchParams.get("cursor");
	return isId(c) ? c : undefined;
};

async function body(req: Request): Promise<Record<string, any>> {
	const type = req.headers.get("content-type") ?? "";
	if (Number(req.headers.get("content-length") ?? 0) > 2 * 1024 * 1024) throw new ApiError(413, "That request is too large.");
	if (type.includes("application/json")) return (await req.json().catch(() => ({}))) ?? {};
	if (type.includes("form")) return Object.fromEntries((await req.formData().catch(() => new FormData())).entries());
	return {};
}

async function userOr404(v: Viewer, name: string) {
	const u = await userByName(v.id, decodeURIComponent(name));
	if (!u || u.status === "suspended") throw new ApiError(404, "No account goes by that name.");
	return u;
}

async function postOr404(v: Viewer, id: string) {
	const p = isId(id) ? await getPost(v.id, id) : undefined;
	if (!p) throw new ApiError(404, "No post with that id, or you can't see it.");
	return p;
}

// one image or video sent as the whole request body, through the client's own
// chunked upload so the same checks and video conversion apply
async function uploadMedia(req: Request, v: Viewer) {
	const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
	if (!/^(image|video)\//.test(type)) throw new ApiError(415, "Send the file as the body with its image/* or video/* content type.");
	const data = new Uint8Array(await req.arrayBuffer());
	if (!data.length) throw new ApiError(400, "The body is empty.");
	const call = async (query: Record<string, string>, form?: FormData) => {
		const url = new URL(`${PUBLIC_ORIGIN}/i/media/upload.json?${new URLSearchParams(query)}`);
		const res = await mediaUpload(new Request(url, { method: "POST", body: form }), url, v);
		const out = res.status === 204 ? {} : await res.json().catch(() => ({}));
		if (res.status >= 400) throw new ApiError(res.status, out?.errors?.[0]?.message ?? out?.error ?? "Upload failed.");
		return out;
	};
	const video = type.startsWith("video/");
	const init = await call({ command: "INIT", total_bytes: String(data.length), media_type: type, media_category: video ? "tweet_video" : type === "image/gif" ? "tweet_gif" : "tweet_image" });
	const id = init.media_id_string;
	const form = new FormData();
	form.set("media", new Blob([data], { type }));
	await call({ command: "APPEND", media_id: id, segment_index: "0" }, form);
	const done = await call({ command: "FINALIZE", media_id: id });
	return { media_id: id, processing: done.processing_info?.state ?? "succeeded" };
}

type Route = { method: string; pattern: RegExp; scope: "read" | "write"; bucket?: Bucket; run: (v: Viewer, m: RegExpExecArray, req: Request, url: URL) => Promise<unknown> };

const op = async (name: string, v: Viewer, vars: Record<string, unknown>) => {
	try {
		return await callOperation(name, v, vars);
	} catch (e) {
		if (e instanceof PostError) throw new ApiError(e.code === 144 ? 404 : 400, e.message);
		throw e;
	}
};

const ROUTES: Route[] = [
	{ method: "GET", pattern: /^\/me$/, scope: "read", run: async (v) => ({ data: userJson((await userByName(v.id, v.screen_name))!) }) },
	{ method: "GET", pattern: /^\/users\/([^/]+)$/, scope: "read", run: async (v, m) => ({ data: userJson(await userOr404(v, m[1])) }) },
	{
		method: "GET", pattern: /^\/users\/([^/]+)\/posts$/, scope: "read",
		run: async (v, m, _r, url) => {
			const u = await userOr404(v, m[1]);
			const limit = limitOf(url);
			return page(await feed({ viewerId: v.id, authors: { user: u.id }, replies: url.searchParams.get("replies") === "true", kinds: "both", limit, before: cursorOf(url) }), limit);
		},
	},
	{
		method: "GET", pattern: /^\/users\/([^/]+)\/(followers|following)$/, scope: "read",
		run: async (v, m, _r, url) => {
			const u = await userOr404(v, m[1]);
			return { data: (await followList(v.id, u.id, m[2] as "followers" | "following", limitOf(url, 200))).map(userJson) };
		},
	},
	{
		method: "GET", pattern: /^\/timeline$/, scope: "read",
		run: async (v, _m, _r, url) => {
			const limit = limitOf(url);
			return page(await feed({ viewerId: v.id, authors: { following: true }, replies: false, kinds: "both", limit, before: cursorOf(url) }), limit);
		},
	},
	{ method: "GET", pattern: /^\/posts\/(\d{1,19})$/, scope: "read", run: async (v, m) => ({ data: postJson(await postOr404(v, m[1])) }) },
	{
		method: "GET", pattern: /^\/posts\/(\d{1,19})\/replies$/, scope: "read",
		run: async (v, m, _r, url) => {
			await postOr404(v, m[1]);
			return { data: (await replies(v.id, m[1], limitOf(url))).map((p) => postJson(p)) };
		},
	},
	{
		method: "GET", pattern: /^\/search\/posts$/, scope: "read",
		run: async (v, _m, _r, url) => {
			const q = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
			if (!q) throw new ApiError(400, "Give a query in q.");
			const limit = limitOf(url);
			const ids = await searchPosts(q, { viewerId: v.id, top: url.searchParams.get("sort") === "top", limit, before: cursorOf(url) });
			const byId = await postsByIds(v.id, ids);
			const data = (ids as string[]).map((id) => byId.get(id)).filter((p): p is PostRow => !!p).map((p) => postJson(p));
			return { data, next_cursor: ids.length >= limit ? ids[ids.length - 1] : null };
		},
	},
	{
		method: "GET", pattern: /^\/search\/users$/, scope: "read",
		run: async (v, _m, _r, url) => {
			const q = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
			if (!q) throw new ApiError(400, "Give a query in q.");
			const ids = await searchUsers(v.id, q, limitOf(url));
			const byId = await usersByIds(v.id, ids);
			return { data: (ids as string[]).map((id) => byId.get(id)).filter((x): x is User => !!x).map(userJson) };
		},
	},

	{
		method: "POST", pattern: /^\/posts$/, scope: "write", bucket: "post",
		run: async (v, _m, req) => {
			const b = await body(req);
			const mediaIds = (Array.isArray(b.media_ids) ? b.media_ids : typeof b.media_ids === "string" ? b.media_ids.split(",") : []).map(String).filter(isId);
			if (b.reply_to !== undefined && !isId(String(b.reply_to))) throw new ApiError(400, "reply_to is a post id.");
			if (b.quote !== undefined && !isId(String(b.quote))) throw new ApiError(400, "quote is a post id.");
			const quoted = b.quote !== undefined ? await postOr404(v, String(b.quote)) : undefined;
			const out: any = await op("CreateTweet", v, {
				tweet_text: typeof b.text === "string" ? b.text : "",
				...(b.reply_to !== undefined ? { reply: { in_reply_to_tweet_id: String(b.reply_to) } } : {}),
				...(quoted ? { attachment_url: `${PUBLIC_ORIGIN}/${quoted.author.screen_name}/status/${quoted.id}` } : {}),
				media: { media_entities: mediaIds.map((media_id: string) => ({ media_id })), possibly_sensitive: b.sensitive === true || b.sensitive === "true" },
			});
			const id = out?.data?.create_tweet?.tweet_results?.result?.rest_id;
			return { data: postJson(await postOr404(v, id)), status: 201 };
		},
	},
	{
		method: "DELETE", pattern: /^\/posts\/(\d{1,19})$/, scope: "write",
		run: async (v, m) => {
			const p = await postOr404(v, m[1]);
			if (p.author.id !== v.id) throw new ApiError(403, "You can only delete your own posts.");
			await op("DeleteTweet", v, { tweet_id: m[1] });
			return { data: { deleted: true } };
		},
	},
	...(["like", "repost", "bookmark"] as const).flatMap((what): Route[] => {
		const [on, off] = { like: ["FavoriteTweet", "UnfavoriteTweet"], repost: ["CreateRetweet", "DeleteRetweet"], bookmark: ["CreateBookmark", "DeleteBookmark"] }[what];
		const run = (name: string, key: string) => async (v: Viewer, m: RegExpExecArray) => {
			await postOr404(v, m[1]);
			await op(name, v, { [key]: m[1] });
			return { data: postJson(await postOr404(v, m[1])) };
		};
		return [
			{ method: "POST", pattern: new RegExp(`^/posts/(\\d{1,19})/${what}$`), scope: "write", bucket: "engage", run: run(on, "tweet_id") },
			{ method: "DELETE", pattern: new RegExp(`^/posts/(\\d{1,19})/${what}$`), scope: "write", bucket: "engage", run: run(off, what === "repost" ? "source_tweet_id" : "tweet_id") },
		];
	}),
	...(["POST", "DELETE"] as const).map((method): Route => ({
		method, pattern: /^\/users\/([^/]+)\/follow$/, scope: "write", bucket: "engage",
		run: async (v, m) => {
			const u = await userOr404(v, m[1]);
			if (u.id === v.id) throw new ApiError(400, "You can't follow yourself.");
			await setFollow(v.id, u.id, method === "POST");
			return { data: userJson(await userOr404(v, m[1])) };
		},
	})),
	{ method: "POST", pattern: /^\/media$/, scope: "write", bucket: "upload", run: async (v, _m, req) => ({ data: await uploadMedia(req, v), status: 201 }) },
];

export async function publicApi(req: Request, url: URL): Promise<Response> {
	const path = url.pathname.slice("/api/v1".length) || "/";
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	const auth = await tokenViewer(req);
	if (!auth) return withCors(fail(401, "Send a personal token from /account/api as Authorization: Bearer xit_..."));
	const { viewer, scope } = auth;
	let route: Route | undefined;
	let match: RegExpExecArray | null = null;
	for (const r of ROUTES) {
		const m = r.pattern.exec(path);
		if (!m) continue;
		if (r.method === req.method) {
			route = r;
			match = m;
			break;
		}
	}
	if (!route || !match) return withCors(fail(404, "No such endpoint. See /api for the list."));
	if (route.scope === "write" && scope !== "write") return withCors(fail(403, "This token can only read."));
	if (settings().operations.maintenance) return withCors(fail(503, settings().operations.message || "The instance is under maintenance."));

	const where = `api ${route.method} ${route.pattern.source}`;
	const last = take(route.bucket ? [["read", viewer.id], [route.bucket, viewer.id]] : [["read", viewer.id]], (bucket, first) => {
		if (first) noteRefusal(bucket, where, viewer.id);
	});
	if (!last.ok) return withCors(limitedResponse(last));
	try {
		const out: any = await route.run(viewer, match, req, url);
		const { status, ...rest } = out ?? {};
		return withCors(json(rest, status ?? 200, limitHeaders(last)));
	} catch (e) {
		if (e instanceof ApiError) return withCors(fail(e.status, e.message));
		console.error(e);
		return withCors(fail(500, "Something went wrong on our side."));
	}
}

// tokens are sent explicitly, never as cookies, so any site may call the API
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-max-age": "86400" };
function withCors(res: Response) {
	for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
	return res;
}

// ---- /account/api: the account's tokens

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const accountPage = (body: string, status = 200) =>
	new Response(
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>API tokens · ${esc(settings().instance_name)}</title>
<style>body{margin:0;background:#000;color:#e7e9ea;font:16px/1.45 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{width:min(560px,92vw);padding:24px 0}h1{font-size:26px;margin:0 0 12px}button,input,select{box-sizing:border-box;font:inherit;border-radius:8px}
button{padding:12px 16px;margin:6px 0;background:#eff3f4;color:#0f1419;border:0;font-weight:700;cursor:pointer}button.del{background:none;color:#f4212e;border:1px solid #67070f;padding:6px 12px;margin:0}
input,select{width:100%;padding:12px;margin:6px 0;background:#000;color:inherit;border:1px solid #333639}
.err{color:#f4212e}.dim{color:#71767b;font-size:14px}a{color:#1d9bf0}
.tok{display:flex;gap:12px;align-items:center;background:#16181c;border-radius:8px;padding:12px 14px;margin:8px 0}.tok div{flex:1}
.new{background:#0b2a17;border:1px solid #00ba7c;border-radius:8px;padding:12px 14px;margin:12px 0}.code{font-family:ui-monospace,monospace;word-break:break-all;user-select:all}</style></head>
<body><main>${body}<p><a href="/api">API documentation</a> · <a href="/home">Back to ${esc(settings().instance_name)}</a></p></main></body></html>`,
		// same-origin, not no-referrer: under no-referrer the form posts with "Origin: null"
		{ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "same-origin" } },
	);

async function tokensView(v: Viewer, fresh = "", error = "") {
	const tokens = await sql`select id::text, name, scope, created_at, last_used_at from api_tokens where user_id = ${v.id}::bigint order by created_at desc`;
	const when = (d: Date | null) => (d ? new Date(d).toUTCString().replace(/:\d\d GMT$/, " UTC") : "never");
	return accountPage(`<h1>API tokens</h1>
<p>A token lets a script or bot use your account through the <a href="/api">API</a>. Anyone holding it can act as you, so keep it secret and delete it when you stop using it.</p>
${fresh ? `<div class="new"><b>Your new token.</b> Copy it now; it won't be shown again.<p class="code">${esc(fresh)}</p></div>` : ""}
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post"><input type="hidden" name="do" value="create">
<input name="name" placeholder="What it's for, e.g. my weather bot" maxlength="40" required>
<select name="scope"><option value="read">Read only</option><option value="write">Read and write (post, like, follow...)</option></select>
<button type="submit">Make a token</button></form>
${tokens.length
	? tokens.map((t: any) => `<div class="tok"><div><b>${esc(t.name)}</b><div class="dim">${t.scope === "write" ? "read and write" : "read only"} · made ${esc(when(t.created_at))} · last used ${esc(when(t.last_used_at))}</div></div>
<form method="post"><input type="hidden" name="do" value="delete"><input type="hidden" name="id" value="${esc(t.id)}"><button class="del" type="submit">Delete</button></form></div>`).join("")
	: `<p class="dim">No tokens yet.</p>`}`);
}

export async function apiTokensRoute(req: Request, v: Viewer): Promise<Response> {
	if (req.method !== "POST") return tokensView(v);
	// a plain form post from this page only
	const origin = req.headers.get("origin");
	if (origin && origin !== PUBLIC_ORIGIN) return tokensView(v, "", "That request didn't come from this page.");
	const f = await req.formData().catch(() => new FormData());
	if (f.get("do") === "delete") {
		const id = String(f.get("id") ?? "");
		if (isId(id)) await sql`delete from api_tokens where id = ${id}::bigint and user_id = ${v.id}::bigint`;
		return tokensView(v);
	}
	const name = String(f.get("name") ?? "").trim();
	if (!name || [...name].length > 40) return tokensView(v, "", "Name the token (up to 40 characters).");
	const scope = f.get("scope") === "write" ? "write" : "read";
	try {
		return tokensView(v, await createToken(v.id, name, scope));
	} catch (e) {
		if (e instanceof ApiError) return tokensView(v, "", e.message);
		throw e;
	}
}
