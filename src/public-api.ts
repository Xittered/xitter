// The public API under /api/v1: plain JSON for bots and scripts, signed in
// with a personal token from /account/api ("Authorization: Bearer xit_...").
// Writes go through the same operations the client calls (graphql.ts), so
// every rule the app enforces holds here too; reads use the same visibility
// (blocks, protected accounts, suspensions). The rate limits are the
// client's. /api is the documentation.

import { BodyTooLarge, boundedBody } from "./api-input";
import { accountPage, esc } from "./account-page";
import { type User, type Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { pronounsValue } from "./pronouns";
import { sql } from "./db";
import { callOperation } from "./graphql";
import { isId, newId } from "./ids";
import { absolute, mediaUpload, mediaUrl, posterUrl } from "./media";
import { type PostRow, badgeList, isOrganization, isVerified, shownVerifiedType, verifiedSince } from "./model";
import { PostError, feed, getPost, likerIds, postsByIds, replies, type FeedItem } from "./posts";
import { setProfileImage, updatePronouns, updateProfileText } from "./rest";
import { ReplyControlError } from "./reply-controls";
import { type Bucket, limitHeaders, limitedResponse, noteRefusal, take } from "./ratelimit";
import { searchPosts, searchUsers } from "./search";
import { feature, settings } from "./settings";
import {
	MoneyError,
	NOTE_MAX,
	type Party,
	type Payment,
	type Request as MoneyRequest,
	acceptDisclaimer,
	balanceOf,
	closeRequest,
	disclaimerAccepted,
	disclaimerText,
	economy,
	paymentUrl,
	payments,
	requestMoney,
	requestUrl,
	requests,
	sendMoney,
} from "./money";
import { badgeUrl, followList, setFollow, userByName, usersByIds } from "./users";

const hash = (token: string) => new Bun.CryptoHasher("sha256").update(token).digest("hex");
const MAX_TOKENS = 10;

class ApiError extends Error {
	constructor(public status: number, message: string) {
		super(message);
	}
}

// ---- tokens

export async function createToken(userId: string, name: string, scope: "read" | "write", issuingSession?: string) {
	const token = `xit_${Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")}`;
	await sql.begin(async (tx) => {
		// Password recovery and token creation take the same account lock. A
		// request authenticated before recovery must not mint a credential after it.
		const [account] = await tx`select id from users where id = ${userId}::bigint
			and status <> 'suspended' and deactivated_at is null and instance is null for update`;
		if (!account) throw new ApiError(401, "Sign in again to make an API token.");
		if (issuingSession !== undefined) {
			const [session] = await tx`select token from sessions where token = ${issuingSession} and user_id = ${userId}::bigint
				and (expires_at is null or expires_at > clock_timestamp())`;
			if (!session) throw new ApiError(401, "Sign in again to make an API token.");
		}
		const [{ n }] = await tx`select count(*)::int as n from api_tokens where user_id = ${userId}::bigint and client_id is null`;
		if (n >= MAX_TOKENS) throw new ApiError(400, `You can have up to ${MAX_TOKENS} tokens. Delete one first.`);
		await tx`insert into api_tokens (id, user_id, name, token_hash, scope) values (${newId()}::bigint, ${userId}::bigint, ${name}, ${hash(token)}, ${scope})`;
	});
	return token;
}

async function tokenViewer(req: Request): Promise<{ viewer: Viewer; scope: string } | undefined> {
	const token = /^Bearer\s+(xit_[0-9a-f]{48})$/i.exec(req.headers.get("authorization") ?? "")?.[1];
	if (!token) return undefined;
	const [row] = await sql`
		select u.id::text, u.screen_name, u.name, u.bio, u.location, u.website, u.avatar_url, u.banner_url, u.verified_type, u.flag, u.status, u.role, u.protected, u.language, u.created_at,
			t.scope, t.id::text as token_id, t.last_used_at, c.name as app_name
		from api_tokens t join users u on u.id = t.user_id left join oauth_clients c on c.id = t.client_id
		where t.token_hash = ${hash(token)} and u.status <> 'suspended' and u.deactivated_at is null
			and (t.expires_at is null or t.expires_at > now()) and (t.client_id is null or c.revoked = false)`;
	if (!row) return undefined;
	if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60_000) await sql`update api_tokens set last_used_at = now() where id = ${row.token_id}::bigint`;
	const { scope, token_id: _id, last_used_at: _used, app_name, ...user } = row;
	// staff tokens are limited like anyone's: the exemption is for the panel
	return { viewer: { ...user, role: null, csrf: "", token: "", postSource: app_name ? `App: ${app_name}` : "Xitter API" } as Viewer, scope };
}

// ---- shapes

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

function userJson(u: User) {
	const shown = badgeList(u);
	return {
		id: u.id,
		screen_name: u.screen_name,
		name: u.name,
		bio: u.bio ?? "",
		pronouns: pronounsValue(u.pronouns),
		location: u.location ?? "",
		website: u.website || null,
		avatar_url: absolute(u.avatar_url),
		banner_url: absolute(u.banner_url),
		verified_type: shownVerifiedType(u),
		// what the web client shows, from the same rules (model.ts): a checkmark
		// also for an organisation's affiliates, and its "Verified since" date
		verified: isVerified(u),
		verified_since: iso(isVerified(u) ? verifiedSince(u) : null),
		// X's profile labels: "Parody", "Commentary" or "Fan"; one an admin made
		// (Admin > Labels); and a bot's owner, for "Automated by @owner"
		parody_label: u.parody_label && u.parody_label !== "None" ? u.parody_label : null,
		label: u.label ? { text: u.label.text, url: u.label.url ?? null, badge_url: u.label.badge_id ? badgeUrl(u.label.badge_id) : null } : null,
		automated_by: u.automated_by ?? null,
		// a business account: a business or government, or anyone with affiliates
		organization: isOrganization(u),
		...(isOrganization(u) ? { affiliates_count: u.affiliates ?? 0 } : {}),
		// what it wears after its name, as the web client draws it (badgeList):
		// its organisations first, then custom badges, pride flags and, for an
		// account from another instance, a globe
		affiliations: shown.flatMap((b) => (b.org ? [{ screen_name: b.org, name: b.description, badge_url: b.url }] : [])),
		badges: shown.filter((b) => !b.org).map((b) => ({ name: b.description, url: b.url })),
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

const limitOf = (url: URL, max = 100) => Math.min(Math.max(Math.floor(Number(url.searchParams.get("limit"))) || 20, 1), max);
const cursorOf = (url: URL) => {
	const c = url.searchParams.get("cursor");
	return isId(c) ? c : undefined;
};

async function body(req: Request): Promise<Record<string, any>> {
	const type = req.headers.get("content-type") ?? "";
	const bytes = await boundedBody(req, 2 * 1024 * 1024);
	const parsed = new Response(bytes, { headers: { "content-type": type } });
	if (type.includes("application/json")) {
		const value = await parsed.json().catch(() => ({}));
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	}
	if (type.includes("form")) return Object.fromEntries((await parsed.formData().catch(() => new FormData())).entries());
	return {};
}

async function userOr404(v: Viewer, name: string) {
	const decoded = (() => {
		try {
			return decodeURIComponent(name);
		} catch {
			return "";
		}
	})();
	const u = decoded ? await userByName(v.id, decoded) : undefined;
	if (!u || u.status === "suspended") throw new ApiError(404, "No account goes by that name.");
	return u;
}

async function postOr404(v: Viewer, id: string) {
	const p = isId(id) ? await getPost(v.id, id) : undefined;
	if (!p) throw new ApiError(404, "No post with that id, or you can't see it.");
	return p;
}

const MAX_MEDIA_SEGMENT = 5 * 1024 * 1024;
const mediaLimit = (type: string) => type.startsWith("video/") ? settings().limits.video_mb * 1024 * 1024 : type === "image/gif" ? 15 * 1024 * 1024 : settings().limits.image_mb * 1024 * 1024;

async function callMedia(v: Viewer, query: Record<string, string>, form?: FormData) {
	const url = new URL(`${PUBLIC_ORIGIN}/i/media/upload.json?${new URLSearchParams(query)}`);
	const res = await mediaUpload(new Request(url, { method: "POST", body: form }), url, v);
	const out = res.status === 204 ? {} : await res.json().catch(() => ({}));
	if (res.status >= 400) throw new ApiError(res.status, out?.errors?.[0]?.message ?? out?.error ?? "Upload failed.");
	return out;
}

const mediaResult = (id: string, out: any) => ({
	media_id: id,
	processing: out.processing_info?.state ?? "succeeded",
	...(out.processing_info?.check_after_secs !== undefined ? { check_after_secs: out.processing_info.check_after_secs } : {}),
	...(out.processing_info?.progress_percent !== undefined ? { progress_percent: out.processing_info.progress_percent } : {}),
	...(out.processing_info?.error ? { error: out.processing_info.error } : {}),
	...(out.expires_after_secs !== undefined ? { expires_after_secs: out.expires_after_secs } : {}),
	...(out.total_bytes !== undefined ? { total_bytes: out.total_bytes, received_bytes: out.received_bytes, segments: out.segments } : {}),
});

async function beginMedia(req: Request, v: Viewer) {
	const b = await body(req);
	const type = typeof b.media_type === "string" ? b.media_type.trim().toLowerCase() : "";
	if (!/^(image|video)\/[a-z0-9.+-]+$/.test(type)) throw new ApiError(415, "Give the file's image/* or video/* media_type.");
	const total = typeof b.total_bytes === "number" || typeof b.total_bytes === "string" ? Number(b.total_bytes) : NaN;
	if (!Number.isSafeInteger(total) || total <= 0) throw new ApiError(400, "total_bytes must be the file's positive byte length.");
	if (total > mediaLimit(type)) throw new ApiError(413, "That file is too large.");
	const out = await callMedia(v, { command: "INIT", total_bytes: String(total), media_type: type, media_category: type.startsWith("video/") ? "tweet_video" : type === "image/gif" ? "tweet_gif" : "tweet_image" });
	return { media_id: out.media_id_string, max_segment_bytes: MAX_MEDIA_SEGMENT, expires_after_secs: 3600 };
}

async function appendMedia(req: Request, v: Viewer, id: string, segment: string) {
	if (!isId(id)) throw new ApiError(404, "Unknown upload.");
	const index = Number(segment);
	if (!Number.isInteger(index) || index < 0 || index > 10_000) throw new ApiError(400, "segment_index must be between 0 and 10000.");
	const data = await boundedBody(req, MAX_MEDIA_SEGMENT);
	if (!data.length) throw new ApiError(400, "The segment is empty.");
	const form = new FormData();
	form.set("media", new Blob([data], { type: "application/octet-stream" }));
	await callMedia(v, { command: "APPEND", media_id: id, segment_index: String(index) }, form);
	return { media_id: id, segment_index: index };
}

async function finishMedia(v: Viewer, id: string) {
	if (!isId(id)) throw new ApiError(404, "Unknown upload.");
	const status = await callMedia(v, { command: "STATUS", media_id: id });
	if (status.processing_info?.state !== "uploading") return mediaResult(id, status);
	if (status.received_bytes !== status.total_bytes) throw new ApiError(400, "Upload all segments before finalizing.");
	return mediaResult(id, await callMedia(v, { command: "FINALIZE", media_id: id }));
}

// The simple whole-body endpoint remains useful for small files. Larger files
// use the same uploader through bounded segments below the server's body cap.
async function uploadMedia(req: Request, v: Viewer) {
	const type = (req.headers.get("content-type") ?? "").split(";")[0].trim();
	if (!/^(image|video)\//.test(type)) throw new ApiError(415, "Send the file as the body with its image/* or video/* content type.");
	const data = await boundedBody(req, mediaLimit(type));
	if (!data.length) throw new ApiError(400, "The body is empty.");
	const video = type.startsWith("video/");
	const init = await callMedia(v, { command: "INIT", total_bytes: String(data.length), media_type: type, media_category: video ? "tweet_video" : type === "image/gif" ? "tweet_gif" : "tweet_image" });
	const id = init.media_id_string;
	const form = new FormData();
	form.set("media", new Blob([data], { type }));
	await callMedia(v, { command: "APPEND", media_id: id, segment_index: "0" }, form);
	const done = await callMedia(v, { command: "FINALIZE", media_id: id });
	return { media_id: id, processing: done.processing_info?.state ?? "succeeded" };
}

// ---- Equicoins (money.ts): the instance's own play money, with no cash value

// on for this instance and, before any money moves, the disclaimer accepted
async function moneyOn(v: Viewer, { accepted = true } = {}) {
	if (!feature("money")) throw new ApiError(404, `Equicoins isn't on for ${settings().instance_name}.`);
	if (accepted && !(await disclaimerAccepted(v.id))) throw new ApiError(403, "Accept Equicoins' disclaimer first: POST /money/disclaimer.");
}
async function moneyCall<T>(f: () => Promise<T>): Promise<T> {
	try {
		return await f();
	} catch (e) {
		if (e instanceof MoneyError) throw new ApiError(400, e.message);
		throw e;
	}
}

// the accounts on either side, in the API's account shape; one the viewer
// can't see any more (a block since) keeps its name and picture
async function moneyPeople(v: Viewer, sides: Party[]) {
	const found = await usersByIds(v.id, [...new Set(sides.map((p) => p.id))]);
	return (p: Party) => {
		const u = found.get(p.id);
		return u ? userJson(u) : { id: p.id, screen_name: p.screen_name, name: p.name, avatar_url: p.avatar };
	};
}

async function paymentsJson(v: Viewer, list: Payment[]) {
	const who = await moneyPeople(v, list.flatMap((t) => [t.sender, t.recipient]));
	return list.map((t) => ({
		id: t.id,
		amount_cents: t.amount,
		note: t.note,
		created_at: iso(t.at),
		direction: t.sender.id === v.id ? "sent" : t.recipient.id === v.id ? "received" : null,
		sender: who(t.sender),
		recipient: who(t.recipient),
		// paid to a business in merchant mode: X shows it as a purchase there
		merchant: t.recipient.merchant ? { name: t.recipient.merchant.name, banner_url: t.recipient.merchant.banner } : null,
		reversed: !!t.reversed,
		url: paymentUrl(t.id),
	}));
}

async function requestsJson(v: Viewer, list: MoneyRequest[]) {
	const who = await moneyPeople(v, list.flatMap((q) => [q.requester, ...(q.payer ? [q.payer] : [])]));
	return list.map((q) => {
		const open = q.status === "open";
		return {
			id: q.id,
			amount_cents: q.amount,
			note: q.note,
			status: q.status,
			created_at: iso(q.at),
			requester: who(q.requester),
			// null: anyone may pay it (a "Pay @name" card)
			payer: q.payer ? who(q.payer) : null,
			paid_count: q.paidCount,
			paid_cents: q.paidCents,
			url: requestUrl(q.id),
			can_pay: open && q.requester.id !== v.id && (!q.payer || q.payer.id === v.id),
			can_decline: open && q.payer?.id === v.id,
			can_cancel: open && q.requester.id === v.id,
		};
	});
}

const onePayment = async (v: Viewer, id: string) => {
	const t = (await payments([id], v.id)).get(id);
	if (!t) throw new ApiError(404, "No payment with that id, or you can't see it.");
	return (await paymentsJson(v, [t]))[0];
};
const oneRequest = async (v: Viewer, id: string) => {
	const q = (await requests([id], v.id)).get(id);
	if (!q) throw new ApiError(404, "No request with that id, or you can't see it.");
	return (await requestsJson(v, [q]))[0];
};
const centsOf = (value: unknown, what: string) => {
	const n = typeof value === "string" && value.trim() ? Number(value) : value;
	if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new ApiError(400, `${what} is a whole number of cents over 0.`);
	return n;
};

const MONEY_ROUTES: Route[] = [
	{
		method: "GET", pattern: /^\/money$/, scope: "read",
		run: async (v) => {
			await moneyOn(v, { accepted: false });
			const m = economy();
			return { data: { name: `${settings().instance_name} Equicoins`, balance_cents: await balanceOf(v.id), disclaimer_accepted: await disclaimerAccepted(v.id), disclaimer: disclaimerText(), max_transfer_cents: m.max_transfer_cents, like_cents: m.like_cents, note_max: NOTE_MAX } };
		},
	},
	{
		method: "POST", pattern: /^\/money\/disclaimer$/, scope: "write",
		run: async (v) => {
			await moneyOn(v, { accepted: false });
			await acceptDisclaimer(v.id);
			return { data: { disclaimer_accepted: true } };
		},
	},
	{
		method: "GET", pattern: /^\/money\/activity$/, scope: "read",
		run: async (v, _m, _r, url) => {
			await moneyOn(v);
			const limit = limitOf(url), cursor = cursorOf(url);
			const rows = await sql`select id::text from money_transfers where (sender_id = ${v.id}::bigint or recipient_id = ${v.id}::bigint)
				${cursor ? sql`and id < ${cursor}::bigint` : sql``} order by id desc limit ${limit}`;
			const ids = rows.map((r: { id: string }) => r.id);
			const found = await payments(ids);
			const data = await paymentsJson(v, ids.map((id: string) => found.get(id)).filter((t: Payment | undefined): t is Payment => !!t));
			// likes paid, by day, on the first page only
			const earnings = cursor ? undefined : (await sql`select date_trunc('day', created_at) as day, count(*)::int as likes, sum(cents)::bigint as cents
				from money_like_rewards where author_id = ${v.id}::bigint group by 1 order by 1 desc limit 30`).map((r: any) => ({ day: iso(r.day)!.slice(0, 10), likes: r.likes, cents: Number(r.cents) }));
			return { data, ...(earnings ? { earnings } : {}), next_cursor: ids.length >= limit ? ids[ids.length - 1] : null };
		},
	},
	{
		method: "GET", pattern: /^\/money\/requests$/, scope: "read",
		run: async (v) => {
			await moneyOn(v);
			// what waits on the viewer, and what it's waiting on from others
			const rows = await sql`select id::text from money_requests where status = 'open'
				and (payer_id = ${v.id}::bigint or (requester_id = ${v.id}::bigint and payer_id is not null)) order by id desc limit 40`;
			const ids = rows.map((r: { id: string }) => r.id);
			const found = await requests(ids);
			return { data: await requestsJson(v, ids.map((id: string) => found.get(id)).filter((q: MoneyRequest | undefined): q is MoneyRequest => !!q)) };
		},
	},
	{
		method: "POST", pattern: /^\/money\/send$/, scope: "write", bucket: "write",
		run: async (v, _m, req) => {
			await moneyOn(v);
			const b = await body(req);
			const to = typeof b.to === "string" ? b.to : "";
			const key = typeof b.idempotency_key === "string" ? b.idempotency_key : "";
			if (b.request_id !== undefined && !isId(String(b.request_id))) throw new ApiError(400, "request_id is a request's id.");
			const sent = await moneyCall(() => sendMoney(v.id, to, centsOf(b.amount_cents, "amount_cents"), typeof b.note === "string" ? b.note : "", key, b.request_id !== undefined ? String(b.request_id) : undefined));
			return { data: await onePayment(v, sent.id), status: sent.repeated ? 200 : 201 };
		},
	},
	{
		method: "POST", pattern: /^\/money\/requests$/, scope: "write", bucket: "write",
		run: async (v, _m, req) => {
			await moneyOn(v);
			const b = await body(req);
			const amount = b.amount_cents === undefined || b.amount_cents === null || b.amount_cents === "" ? null : centsOf(b.amount_cents, "amount_cents");
			const id = await moneyCall(() => requestMoney(v.id, typeof b.from === "string" ? b.from : "", amount ? (amount / 100).toFixed(2) : "", typeof b.note === "string" ? b.note : ""));
			return { data: await oneRequest(v, id), status: 201 };
		},
	},
	...(["decline", "cancel"] as const).map((action): Route => ({
		method: "POST", pattern: new RegExp(`^/money/requests/(\\d{1,19})/${action}$`), scope: "write", bucket: "write",
		run: async (v, m) => {
			await moneyOn(v);
			if (!(await closeRequest(v.id, m[1], action))) throw new ApiError(409, action === "decline" ? "That request isn't open to you." : "That request isn't yours, or isn't open.");
			return { data: await oneRequest(v, m[1]) };
		},
	})),
	{ method: "GET", pattern: /^\/money\/payments\/(\d{1,19})$/, scope: "read", run: async (v, m) => (await moneyOn(v, { accepted: false }), { data: await onePayment(v, m[1]) }) },
	{ method: "GET", pattern: /^\/money\/requests\/(\d{1,19})$/, scope: "read", run: async (v, m) => (await moneyOn(v, { accepted: false }), { data: await oneRequest(v, m[1]) }) },
];

type Route = { method: string; pattern: RegExp; scope: "read" | "write"; bucket?: Bucket; run: (v: Viewer, m: RegExpExecArray, req: Request, url: URL) => Promise<unknown> };

const op = async (name: string, v: Viewer, vars: Record<string, unknown>) => {
	try {
		return await callOperation(name, v, vars);
	} catch (e) {
		if (e instanceof PostError || e instanceof ReplyControlError) throw new ApiError(e.code === 144 ? 404 : 400, e.message);
		throw e;
	}
};

const ROUTES: Route[] = [
	{ method: "GET", pattern: /^\/me$/, scope: "read", run: async (v) => ({ data: userJson((await userByName(v.id, v.screen_name))!) }) },
	{
		// edit the profile: name, bio, pronouns, location, website (empty string
		// clears), avatar_media_id / banner_media_id from POST /media, remove_banner: true
		method: "PATCH", pattern: /^\/me$/, scope: "write",
		run: async (v, _m, req) => {
			const b = await body(req);
			const text: Record<string, string> = {};
			for (const [key, web] of [["name", "name"], ["bio", "description"], ["location", "location"], ["website", "url"]] as const) {
				if (b[key] === undefined || b[key] === null) continue;
				if (typeof b[key] !== "string") throw new ApiError(400, `${key} is a string.`);
				text[web] = b[key];
			}
			if (b.pronouns !== undefined && b.pronouns !== null && typeof b.pronouns !== "string") throw new ApiError(400, "pronouns is a string.");
			if (b.avatar_media_id !== undefined && !isId(String(b.avatar_media_id))) throw new ApiError(400, "avatar_media_id is a media id.");
			if (b.banner_media_id !== undefined && !isId(String(b.banner_media_id))) throw new ApiError(400, "banner_media_id is a media id.");
			const problem =
				(Object.keys(text).length ? await updateProfileText(v, text) : null) ??
				(typeof b.pronouns === "string" ? await updatePronouns(v, b.pronouns) : null) ??
				(b.avatar_media_id !== undefined ? await setProfileImage(v, "avatar", String(b.avatar_media_id)) : null) ??
				(b.banner_media_id !== undefined ? await setProfileImage(v, "banner", String(b.banner_media_id)) : null);
			if (problem) throw new ApiError(400, problem);
			if (b.remove_banner === true) await sql`update users set banner_url = null where id = ${v.id}::bigint`;
			return { data: userJson((await userByName(v.id, v.screen_name))!) };
		},
	},
	{ method: "GET", pattern: /^\/users\/([^/]+)$/, scope: "read", run: async (v, m) => ({ data: userJson(await userOr404(v, m[1])) }) },
	{
		method: "GET", pattern: /^\/users\/([^/]+)\/posts$/, scope: "read",
		run: async (v, m, _r, url) => {
			const u = await userOr404(v, m[1]);
			const limit = limitOf(url);
			// replies=true mixes replies in, replies=only is a profile's Replies tab
			const r = url.searchParams.get("replies");
			return page(await feed({ viewerId: v.id, authors: { user: u.id }, replies: r === "true" || r === "only", onlyReplies: r === "only", kinds: "both", limit, before: cursorOf(url) }), limit);
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
		method: "GET", pattern: /^\/posts\/(\d{1,19})\/likes$/, scope: "read",
		run: async (v, m, _r, url) => {
			await postOr404(v, m[1]);
			const ids = await likerIds(v.id, m[1], limitOf(url, 200));
			const users = await usersByIds(v.id, ids);
			return { data: ids.flatMap((id) => (users.has(id) ? [userJson(users.get(id)!)] : [])) };
		},
	},
	{
		method: "GET", pattern: /^\/search\/posts$/, scope: "read",
		run: async (v, _m, _r, url) => {
			const q = (url.searchParams.get("q") ?? "").trim().slice(0, 500);
			if (!q) throw new ApiError(400, "Give a query in q.");
			const limit = limitOf(url);
			const top = url.searchParams.get("sort") === "top";
			// Top is ranked, so its cursor is an offset ("o<n>"), as the client's
			// search is; an id cursor works for the newest-first listing.
			const cursor = url.searchParams.get("cursor") ?? "";
			const offset = top && /^o(\d{1,6})$/.test(cursor) ? Number(cursor.slice(1)) : 0;
			const ids = await searchPosts(q, { viewerId: v.id, top, limit, before: top ? undefined : cursorOf(url), offset });
			const byId = await postsByIds(v.id, ids);
			const data = (ids as string[]).map((id) => byId.get(id)).filter((p): p is PostRow => !!p).map((p) => postJson(p));
			const next = ids.length >= limit ? (top ? `o${offset + limit}` : ids[ids.length - 1]) : null;
			return { data, next_cursor: next };
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
	{ method: "POST", pattern: /^\/media\/uploads$/, scope: "write", bucket: "upload", run: async (v, _m, req) => ({ data: await beginMedia(req, v), status: 201 }) },
	{ method: "POST", pattern: /^\/media\/(\d{1,19})\/segments\/(\d+)$/, scope: "write", bucket: "write", run: async (v, m, req) => ({ data: await appendMedia(req, v, m[1], m[2]) }) },
	{ method: "POST", pattern: /^\/media\/(\d{1,19})\/finalize$/, scope: "write", bucket: "write", run: async (v, m) => {
		if (!isId(m[1])) throw new ApiError(404, "Unknown upload.");
		return { data: await finishMedia(v, m[1]) };
	} },
	{ method: "GET", pattern: /^\/media\/(\d{1,19})$/, scope: "read", run: async (v, m) => {
		if (!isId(m[1])) throw new ApiError(404, "Unknown upload.");
		return { data: mediaResult(m[1], await callMedia(v, { command: "STATUS", media_id: m[1] })) };
	} },
	...MONEY_ROUTES,
];

export async function publicApi(req: Request, url: URL): Promise<Response> {
	const path = url.pathname.slice("/api/v1".length) || "/";
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
	const auth = await tokenViewer(req);
	if (!auth) return withCors(fail(401, "Send a personal or connected-app token as Authorization: Bearer xit_..."));
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
	// the same standing as in the app (restricted-page.ts): reading goes on, nothing else
	if (route.scope === "write" && viewer.status === "restricted") return withCors(fail(403, "Your account can't interact right now."));
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
		if (e instanceof BodyTooLarge) return withCors(fail(413, "That request is too large."));
		if (e instanceof ApiError) return withCors(fail(e.status, e.message));
		console.error(e);
		return withCors(fail(500, "Something went wrong on our side."));
	}
}

// tokens are sent explicitly, never as cookies, so any site may call the API
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS", "access-control-max-age": "86400" };
function withCors(res: Response) {
	for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
	return res;
}

// ---- /account/api: the account's tokens

async function tokensView(req: Request, v: Viewer, fresh = "", error = "", status = 200) {
	const tokens = await sql`select id::text, name, scope, created_at, last_used_at from api_tokens where user_id = ${v.id}::bigint and client_id is null order by created_at desc`;
	const when = (d: Date | null) => (d ? new Date(d).toUTCString().replace(/:\d\d GMT$/, " UTC") : "never");
	return accountPage({
		req,
		viewer: v,
		title: "API tokens",
		status,
		// same-origin, not no-referrer: under no-referrer the form posts with "Origin: null"
		referrer: "same-origin",
		body: `<h1>API tokens</h1>
<p>A token lets a script or bot use your account through the <a href="/api">API</a>. Anyone holding it can act as you, so keep it secret and delete it when you stop using it.</p>
<p>Changing or resetting your password revokes all API tokens. Your scripts and bots will need new tokens afterward.</p>
${fresh ? `<div class="card success"><b>Your new token.</b> Copy it now; it won't be shown again.<p class="code">${esc(fresh)}</p></div>` : ""}
${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post"><input type="hidden" name="do" value="create">
<input name="name" placeholder="What it's for, e.g. my weather bot" maxlength="40" required>
<select name="scope"><option value="read">Read only</option><option value="write">Read and write (post, like, follow...)</option></select>
<button type="submit">Make a token</button></form>
${tokens.length
	? tokens.map((t: any) => `<div class="card split"><div><b>${esc(t.name)}</b><div class="dim">${t.scope === "write" ? "read and write" : "read only"} · made ${esc(when(t.created_at))} · last used ${esc(when(t.last_used_at))}</div></div>
<form method="post"><input type="hidden" name="do" value="delete"><input type="hidden" name="id" value="${esc(t.id)}"><button class="small danger" type="submit">Delete</button></form></div>`).join("")
	: `<p class="dim">No tokens yet.</p>`}
<p><a href="/api">API documentation</a></p>`,
	});
}

export async function apiTokensRoute(req: Request, v: Viewer): Promise<Response> {
	if (req.method !== "POST") return tokensView(req, v);
	// a plain form post from this page only
	const origin = req.headers.get("origin");
	if (origin && origin !== PUBLIC_ORIGIN) return tokensView(req, v, "", "That request didn't come from this page.");
	const f = await req.formData().catch(() => new FormData());
	if (f.get("do") === "delete") {
		const id = String(f.get("id") ?? "");
		if (isId(id)) await sql`delete from api_tokens where id = ${id}::bigint and user_id = ${v.id}::bigint and client_id is null`;
		return tokensView(req, v);
	}
	const name = String(f.get("name") ?? "").trim();
	if (!name || [...name].length > 40) return tokensView(req, v, "", "Name the token (up to 40 characters).");
	const scope = f.get("scope") === "write" ? "write" : "read";
	try {
		return tokensView(req, v, await createToken(v.id, name, scope, v.token));
	} catch (e) {
		if (e instanceof ApiError) return tokensView(req, v, "", e.message, e.status);
		throw e;
	}
}
