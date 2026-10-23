import { existsSync, rmSync, statSync } from "node:fs";
import { putFile } from "./disk";
import { join } from "node:path";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { flagValue } from "./flags";
import { pronounsValue } from "./pronouns";
import { badgeUrl, badgesOf } from "./users";
import { FederationError, INSTANCE_ID, type Incoming, isBlocked, isPeer, peers, signedAnswer, signedFetch, signedRawAnswer } from "./federation";
import { newId } from "./ids";
import { replyLimited } from "./blocks";
import { STAFF_HANDLE, STRICT_HANDLE } from "./invites";
import { saveMentions } from "./mentions";
import { cleanText, oneLine } from "./text-clean";
import { parseDecoration } from "./decorations";
import { posterFile } from "./video";

const MEDIA_DIR = process.env.MEDIA_DIR ?? "media";
const PAGE = 200;
const EVENTS_PER_HOUR = Number(process.env.FEDERATION_EVENTS_PER_HOUR) || 20_000;
const MAX_ACCOUNTS = Number(process.env.FEDERATION_MAX_ACCOUNTS) || 100_000;
const budgets = new Map<string, { start: number; used: number }>();
const MAX_MEDIA = 64 * 1024 * 1024;
const STORE_MEDIA = process.env.FEDERATION_MEDIA === "store";
const MEMORY_CACHE = (Number(process.env.FEDERATION_MEDIA_CACHE_MB) || 64) * 1024 * 1024;
const REF_RE = /^(\d{1,19})@([a-z0-9.:-]{1,260})$/;

const ref = (id: string | number | bigint, instance = INSTANCE_ID) => `${id}@${instance}`;
const parseRef = (value: unknown) => {
	const m = typeof value === "string" ? REF_RE.exec(value) : null;
	return m ? { id: m[1], instance: m[2] } : undefined;
};
const clip = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
const isLocalMediaPath = (path: string | null, banner = false) => (path ? new RegExp(`^/media/${banner ? "banner/" : ""}(\\d{1,19})$`).exec(path)?.[1] : undefined);

async function canonicalOf(kind: "user" | "post", localId: string): Promise<string | undefined> {
	const table = kind === "user" ? sql`users` : sql`posts`;
	const [row] =
		kind === "user"
			? await sql`select instance, remote_id::text from ${table} where id = ${localId}::bigint`
			: await sql`select u.instance, f.remote_id::text from posts p join users u on u.id = p.user_id
				left join federated_objects f on f.kind = 'post' and f.local_id = p.id where p.id = ${localId}::bigint`;
	if (!row) return undefined;
	if (!row.instance) return ref(localId);
	return row.remote_id ? ref(row.remote_id, row.instance) : undefined;
}

const userCounts = async (id: string) => {
	const [c] = await sql`select coalesce((u.count_overrides->>'followers')::int, s.followers, 0) as followers, coalesce((u.count_overrides->>'following')::int, s.following, 0) as following,
		coalesce(s.posts, 0) as posts, coalesce(s.likes, 0) as likes from users u left join user_stats s on s.user_id = u.id where u.id = ${id}::bigint`;
	return c ? { followers: c.followers, following: c.following, posts: c.posts, likes: c.likes } : undefined;
};

const postCounts = async (id: string) => {
	const [c] = await sql`select
		coalesce((p.count_overrides->>'likes')::int, (select count(*)::int from likes x where x.post_id = p.id)) as likes,
		coalesce((p.count_overrides->>'reposts')::int, (select count(*)::int from reposts x where x.post_id = p.id)) as reposts,
		coalesce((p.count_overrides->>'replies')::int, (select count(*)::int from posts x where x.reply_to_id = p.id)) as replies,
		coalesce((p.count_overrides->>'quotes')::int, (select count(*)::int from posts x where x.quote_id = p.id)) as quotes,
		coalesce((p.count_overrides->>'bookmarks')::int, (select count(*)::int from bookmarks x where x.post_id = p.id)) as bookmarks,
		coalesce((p.count_overrides->>'views')::int, (select count(*)::int from post_views x where x.post_id = p.id)) as views
		from posts p where p.id = ${id}::bigint`;
	return c ? { likes: c.likes, reposts: c.reposts, replies: c.replies, quotes: c.quotes, bookmarks: c.bookmarks, views: c.views } : undefined;
};

const countsOf = (value: unknown, keys: string[]) => {
	if (!value || typeof value !== "object") return null;
	const out: Record<string, number> = {};
	for (const k of keys) {
		const n = (value as Record<string, unknown>)[k];
		if (Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1_000_000_000) out[k] = n as number;
	}
	return JSON.stringify(out);
};
const USER_COUNTS = ["followers", "following", "posts", "likes"];
const POST_COUNTS = ["likes", "reposts", "replies", "quotes", "bookmarks", "views"];

async function renderUser(id: string) {
	const [u] = await sql`select id::text, screen_name, name, bio, location, website, avatar_url, banner_url, protected, created_at, verified_type, verified_at, translator, flag, pronouns, parody_label, decoration, org_badge_id::text, ${badgesOf(sql`users.id`)} as badges from users
		where id = ${id}::bigint and instance is null and status <> 'suspended' and deactivated_at is null`;
	if (!u) return { kind: "user", id, gone: true };
	return {
		kind: "user",
		id,
		screen_name: u.screen_name,
		name: u.name,
		bio: u.bio,
		location: u.location,
		website: u.website ?? null,
		counts: await userCounts(id),
		verified_type: u.verified_type ?? null,
		verified_at: u.verified_type && u.verified_at ? new Date(u.verified_at).toISOString() : null,
		translator: u.translator ?? null,
		flag: u.flag ?? null,
		pronouns: u.pronouns ?? null,
		parody_label: u.parody_label ?? "None",
		decoration: parseDecoration(u.decoration),
		badges: (u.badges ?? []).map((b: { id: string; name: string }) => ({ name: b.name, url: badgeUrl(b.id) })),
		org_badge: u.org_badge_id ? badgeUrl(u.org_badge_id) : null,
		protected: u.protected,
		created_at: new Date(u.created_at).toISOString(),
		avatar: await renderMedia(isLocalMediaPath(u.avatar_url)),
		banner: await renderMedia(isLocalMediaPath(u.banner_url, true)),
	};
}

async function renderMedia(id: string | undefined) {
	if (!id) return null;
	const [m] = await sql`select id::text, kind, mime, width, height, alt_text, duration_ms from media where id = ${id}::bigint and remote_instance is null`;
	return m ? { id: m.id, kind: m.kind, mime: m.mime, width: m.width, height: m.height, alt_text: m.alt_text ?? null, duration_ms: m.duration_ms ?? null } : null;
}

const publicPost = (id: string) =>
	sql`select p.id::text, p.user_id::text, p.text, p.source, p.created_at, p.reply_to_id::text, p.quote_id::text, p.sensitive and not u.never_sensitive as sensitive, p.edited_at from posts p join users u on u.id = p.user_id
		where p.id = ${id}::bigint and u.instance is null and not u.protected and u.status not in ('suspended', 'limited') and u.deactivated_at is null
			and not p.hidden and p.community_id is null and p.article_id is null
			and not exists (select 1 from posts pp join users pu on pu.id = pp.user_id where pp.id = p.reply_to_id and pu.instance is null
				and (pu.protected or pu.status in ('suspended', 'limited') or pu.deactivated_at is not null or pp.hidden or pp.community_id is not null or pp.article_id is not null))`;

const quotable = async (id: string) => {
	const [q] = await sql`select u.instance from posts p join users u on u.id = p.user_id where p.id = ${id}::bigint`;
	return !!q && (q.instance !== null || (await publicPost(id)).length > 0);
};

const quoteUrl = async (id: string) => {
	const [q] = await sql`select u.screen_name from posts p join users u on u.id = p.user_id where p.id = ${id}::bigint and u.instance is null`;
	return q ? `${PUBLIC_ORIGIN}/${q.screen_name}/status/${id}` : undefined;
};

async function renderPost(id: string) {
	const [p] = await publicPost(id);
	if (!p) return { kind: "post", id, gone: true };
	const media = await sql`select id::text, kind, mime, width, height, alt_text, duration_ms from media where post_id = ${id}::bigint order by position, media.id`;
	return {
		kind: "post",
		id,
		author: p.user_id,
		text: p.text,
		created_at: new Date(p.created_at).toISOString(),
		edited_at: p.edited_at ? new Date(p.edited_at).toISOString() : null,
		sensitive: p.sensitive,
		counts: await postCounts(id),
		source: p.source ?? null,
		is_reply: !!p.reply_to_id,
		reply_to: p.reply_to_id ? ((await canonicalOf("post", p.reply_to_id)) ?? null) : null,
		quote: p.quote_id && (await quotable(p.quote_id)) ? ((await canonicalOf("post", p.quote_id)) ?? null) : null,
		quote_url: p.quote_id ? ((await quoteUrl(p.quote_id)) ?? null) : null,
		media: media.map((m: any) => ({ id: m.id, kind: m.kind, mime: m.mime, width: m.width, height: m.height, alt_text: m.alt_text ?? null, duration_ms: m.duration_ms ?? null })),
	};
}

async function renderPair(kind: "like" | "repost" | "follow", a: string, b: string) {
	if (kind === "follow") {
		const [on] = await sql`select 1 from follows f join users u on u.id = f.followee_id where f.follower_id = ${a}::bigint and f.followee_id = ${b}::bigint and not u.protected`;
		const target = await canonicalOf("user", b);
		return target ? { kind, actor: a, target, on: !!on, counts: target === ref(b) ? await userCounts(b) : null } : undefined;
	}
	const table = kind === "like" ? sql`likes` : sql`reposts`;
	const [on] = await sql`select 1 from ${table} where user_id = ${a}::bigint and post_id = ${b}::bigint`;
	const target = await canonicalOf("post", b);
	return target ? { kind, actor: a, target, on: !!on, counts: target === ref(b) ? await postCounts(b) : null } : undefined;
}

async function renderAffiliation(kind: "affiliate" | "affiliation", a: string, b: string) {
	const [org, member] = kind === "affiliate" ? [a, b] : [b, a];
	const target = await canonicalOf("user", b);
	if (!target) return undefined;
	const [on] = await sql`select 1 from affiliations where org_id = ${org}::bigint and user_id = ${member}::bigint`;
	if (kind === "affiliation") return { kind, actor: a, target, on: !!on };
	const [asked] = on ? [] : await sql`select 1 from affiliation_requests where org_id = ${org}::bigint and user_id = ${member}::bigint`;
	return { kind, actor: a, target, state: on ? "on" : asked ? "requested" : "off" };
}

async function eventsAfter(after: string, limit: number) {
	const rows = await sql`select seq::text, kind, a::text, b::text from federation_outbox where seq > ${after}::bigint order by federation_outbox.seq limit ${limit}`;
	const events: unknown[] = [];
	for (const r of rows) {
		const rendered =
			r.kind === "user"
				? await renderUser(r.a)
				: r.kind === "post"
					? await renderPost(r.a)
					: r.kind === "affiliate" || r.kind === "affiliation"
						? await renderAffiliation(r.kind, r.a, r.b)
						: await renderPair(r.kind, r.a, r.b);
		if (rendered) events.push({ seq: r.seq, ...rendered });
	}
	const [{ max }] = await sql`select coalesce(max(seq), 0)::text as max from federation_outbox`;
	return { events, next: rows.length ? rows[rows.length - 1].seq : after, more: rows.length === limit, head: max };
}

async function mediaAllowed(id: string): Promise<boolean> {
	const [m] = await sql`select m.post_id::text, m.user_id::text from media m join users u on u.id = m.user_id
		where m.id = ${id}::bigint and m.remote_instance is null and u.instance is null and u.status <> 'suspended' and u.deactivated_at is null`;
	if (!m) return false;
	if (m.post_id) return (await publicPost(m.post_id)).length > 0;
	const [profile] = await sql`select 1 from users where id = ${m.user_id}::bigint and (avatar_url = ${`/media/${id}`} or banner_url = ${`/media/banner/${id}`})`;
	return !!profile;
}

export async function federationApi(incoming: Incoming, method: string, path: string, url: URL): Promise<Response> {
	if (method === "GET" && path === "/federation/v1/events") {
		const after = /^\d{1,19}$/.test(url.searchParams.get("after") ?? "") ? url.searchParams.get("after")! : "0";
		const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || PAGE, 1), 500);
		return signedAnswer(incoming, 200, await eventsAfter(after, limit));
	}
	const object = /^\/federation\/v1\/objects\/(user|post)\/(\d{1,19})$/.exec(path);
	if (method === "GET" && object) return signedAnswer(incoming, 200, object[1] === "user" ? await renderUser(object[2]) : await renderPost(object[2]));
	const byName = /^\/federation\/v1\/users\/by-name\/([^/]{1,200})$/.exec(path);
	if (method === "GET" && byName) {
		const name = (() => {
			try {
				return decodeURIComponent(byName[1]);
			} catch {
				return "";
			}
		})();
		if (!STAFF_HANDLE.test(name)) return signedAnswer(incoming, 404, { error: "No such account." });
		const [u] = await sql`select id::text from users where lower(screen_name) = lower(${name}) and instance is null`;
		return u ? signedAnswer(incoming, 200, await renderUser(u.id)) : signedAnswer(incoming, 404, { error: "No such account." });
	}
	const media = /^\/federation\/v1\/media\/(\d{1,19})(\/poster)?$/.exec(path);
	if (method === "GET" && media) {
		if (!(await mediaAllowed(media[1]))) return signedAnswer(incoming, 404, { error: "No such media." });
		const file = media[2] ? posterFile(MEDIA_DIR, media[1]) : join(MEDIA_DIR, media[1]);
		if (!existsSync(file) || statSync(file).size > MAX_MEDIA) return signedAnswer(incoming, 404, { error: "No such media." });
		const [m] = await sql`select mime from media where id = ${media[1]}::bigint`;
		return signedRawAnswer(incoming, 200, new Uint8Array(await Bun.file(file).arrayBuffer()), media[2] ? "image/jpeg" : m.mime);
	}
	if (method === "POST" && path === "/federation/v1/poke") {
		pokeSoon(incoming.from);
		return signedAnswer(incoming, 202, {});
	}
	return signedAnswer(incoming, 404, { error: "Unknown federation route." });
}

async function mapped(instance: string, kind: "user" | "post" | "media", remoteId: string): Promise<string | undefined> {
	const [row] = await sql`select local_id::text from federated_objects where instance = ${instance} and kind = ${kind} and remote_id = ${remoteId}::bigint`;
	return row?.local_id;
}

async function fetchObject(instance: string, kind: "user" | "post", id: string): Promise<any> {
	if (!isPeer(instance)) return undefined;
	const r = await signedFetch(instance, "GET", `/federation/v1/objects/${kind}/${id}`);
	return r.status === 200 ? r.json() : undefined;
}

export async function resolveUser(value: unknown, depth = 0): Promise<string | undefined> {
	const r = parseRef(value);
	if (!r) return undefined;
	if (r.instance === INSTANCE_ID) {
		const [u] = await sql`select id::text from users where id = ${r.id}::bigint and instance is null`;
		return u?.id;
	}
	if (isBlocked(r.instance)) return undefined;
	const known = await mapped(r.instance, "user", r.id);
	if (known || depth > 2) return known;
	const obj = await fetchObject(r.instance, "user", r.id).catch(() => undefined);
	return obj ? applyUser(r.instance, obj) : undefined;
}

async function resolvePost(value: unknown, depth = 0): Promise<string | undefined> {
	const r = parseRef(value);
	if (!r) return undefined;
	if (r.instance === INSTANCE_ID) {
		const [p] = await publicPost(r.id);
		return p?.id;
	}
	if (isBlocked(r.instance)) return undefined;
	const known = await mapped(r.instance, "post", r.id);
	if (known || depth > 2) return known;
	const obj = await fetchObject(r.instance, "post", r.id).catch(() => undefined);
	return obj ? applyPost(r.instance, obj, depth + 1) : undefined;
}

async function remoteMedia(instance: string, owner: string, m: any, post: string | null, position: number | null): Promise<string | undefined> {
	if (!m || typeof m.id !== "string" || !/^\d{1,19}$/.test(m.id)) return undefined;
	const kind = ["photo", "video", "animated_gif"].includes(m.kind) ? m.kind : "photo";
	const mime = typeof m.mime === "string" && /^(image|video)\/[\w.+-]{1,40}$/.test(m.mime) ? m.mime : "application/octet-stream";
	const width = Number.isInteger(m.width) ? Math.min(Math.max(m.width, 1), 20_000) : 1;
	const height = Number.isInteger(m.height) ? Math.min(Math.max(m.height, 1), 20_000) : 1;
	const alt = typeof m.alt_text === "string" ? m.alt_text.slice(0, 1000) : null;
	const duration = Number.isInteger(m.duration_ms) ? m.duration_ms : null;
	const known = await mapped(instance, "media", m.id);
	if (known) {
		await sql`update media set post_id = ${post}::bigint, position = ${position}, alt_text = ${alt} where id = ${known}::bigint`;
		return known;
	}
	const id = newId();
	await sql`insert into media (id, user_id, kind, mime, size, width, height, post_id, position, alt_text, duration_ms, remote_instance, remote_id)
		values (${id}::bigint, ${owner}::bigint, ${kind}, ${mime}, 0, ${width}, ${height}, ${post}::bigint, ${position}, ${alt}, ${duration}, ${instance}, ${m.id}::bigint)`;
	await sql`insert into federated_objects (instance, kind, remote_id, local_id) values (${instance}, 'media', ${m.id}::bigint, ${id}::bigint) on conflict do nothing`;
	prefetch(id, kind === "video");
	return id;
}

export async function applyUser(instance: string, u: any): Promise<string | undefined> {
	if (typeof u?.id !== "string" || !/^\d{1,19}$/.test(u.id)) return undefined;
	const local = await mapped(instance, "user", u.id);
	if (u.gone) {
		if (local) await sql`delete from users where id = ${local}::bigint and instance = ${instance}`;
		return undefined;
	}
	if (typeof u.screen_name !== "string" || !STRICT_HANDLE.test(u.screen_name)) return undefined;
	const pick = (value: unknown, allowed: string[]) => (typeof value === "string" && allowed.includes(value) ? value : null);
	const badgeUrl = new RegExp(`^https?://${instance.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/public/badge-\\d{1,19}\\.png$`);
	const badges = (Array.isArray(u.badges) ? u.badges : [])
		.filter((b: any) => typeof b?.name === "string" && typeof b?.url === "string" && badgeUrl.test(b.url))
		.slice(0, 10)
		.map((b: any) => ({ name: b.name.slice(0, 60), url: b.url }));
	const looks = {
		verified_type: pick(u.verified_type, ["blue", "business", "government", "government_individual"]),
		// older instances don't send it: then the date stays unknown
		verified_at: typeof u.verified_at === "string" && !Number.isNaN(Date.parse(u.verified_at)) && Date.parse(u.verified_at) <= Date.now() ? new Date(u.verified_at) : null,
		translator: pick(u.translator, ["translator", "moderator", "approver"]),
		flag: flagValue(u.flag),
		pronouns: pronounsValue(u.pronouns),
		parody_label: pick(u.parody_label, ["Parody", "Commentary", "Fan"]) ?? "None",
		remote_badges: JSON.stringify(badges),
		org_badge: typeof u.org_badge === "string" && badgeUrl.test(u.org_badge) ? u.org_badge : null,
		decoration: JSON.stringify(parseDecoration(u.decoration)),
	};
	const website = typeof u.website === "string" && /^https?:\/\/[^\s<>"]{1,200}$/.test(u.website) ? u.website : "";
	const handle = `${u.screen_name}@${instance}`;
	await sql`update users set screen_name = screen_name || '~' || remote_id::text where lower(screen_name) = lower(${handle}) and instance = ${instance} and remote_id <> ${u.id}::bigint`;
	const created = typeof u.created_at === "string" && !Number.isNaN(Date.parse(u.created_at)) ? new Date(u.created_at) : new Date();
	const id = local ?? newId();
	if (local)
		await sql`update users set screen_name = ${handle}, name = ${oneLine(clip(u.name, 50))}, bio = ${cleanText(clip(u.bio, 300), { lines: 6 })}, location = ${oneLine(clip(u.location, 60))}, website = ${website}, protected = ${!!u.protected}
			where id = ${local}::bigint`;
	else {
		const [{ n }] = await sql`select count(*)::int as n from users where instance = ${instance}`;
		if (n >= MAX_ACCOUNTS) throw new FederationError(`${instance} already has ${MAX_ACCOUNTS} accounts here`);
		await sql`insert into users (id, screen_name, name, password_hash, bio, location, website, protected, instance, remote_id, created_at)
			values (${id}::bigint, ${handle}, ${oneLine(clip(u.name, 50))}, '!', ${cleanText(clip(u.bio, 300), { lines: 6 })}, ${oneLine(clip(u.location, 60))}, ${website}, ${!!u.protected}, ${instance}, ${u.id}::bigint, ${created})
			on conflict (instance, remote_id) where instance is not null do nothing`;
		const again = await mapped(instance, "user", u.id);
		if (again) return again;
		await sql`insert into federated_objects (instance, kind, remote_id, local_id) values (${instance}, 'user', ${u.id}::bigint, ${id}::bigint) on conflict do nothing`;
	}
	const avatar = await remoteMedia(instance, id, u.avatar, null, null);
	const banner = await remoteMedia(instance, id, u.banner, null, null);
	await sql`update users set avatar_url = ${avatar ? `/media/${avatar}` : null}, banner_url = ${banner ? `/media/banner/${banner}` : null},
		remote_counts = ${countsOf(u.counts, USER_COUNTS)}::text::jsonb, verified_type = ${looks.verified_type}, verified_at = ${looks.verified_type ? looks.verified_at : null}, translator = ${looks.translator}, flag = ${looks.flag}, pronouns = ${looks.pronouns}, parody_label = ${looks.parody_label}, remote_badges = ${looks.remote_badges}::text::jsonb, remote_org_badge = ${looks.org_badge}, decoration = nullif(${looks.decoration}, 'null')::jsonb
		where id = ${id}::bigint`;
	if (u.protected) await sql`delete from posts where user_id = ${id}::bigint`;
	return id;
}

async function applyPost(instance: string, p: any, depth = 0): Promise<string | undefined> {
	if (typeof p?.id !== "string" || !/^\d{1,19}$/.test(p.id)) return undefined;
	const local = await mapped(instance, "post", p.id);
	if (p.gone) {
		if (local) await sql`delete from posts where id = ${local}::bigint`;
		await sql`delete from federated_objects where instance = ${instance} and kind = 'post' and remote_id = ${p.id}::bigint`;
		return undefined;
	}
	const author = await resolveUser(ref(String(p.author ?? ""), instance), depth);
	if (!author) return undefined;
	const quote = p.quote ? await resolvePost(p.quote, depth) : undefined;
	const homeLink = typeof p.quote_url === "string" && p.quote_url.length <= 300 && /^https?:\/\/[^\s<>"]+$/.test(p.quote_url) && new URL(p.quote_url).host === instance ? p.quote_url : undefined;
	const raw = cleanText(clip(p.text, 25_000), { blankLines: 2 });
	const text = !quote && homeLink && !raw.includes(homeLink) ? `${raw} ${homeLink}` : raw;
	const editedAt = typeof p.edited_at === "string" && !Number.isNaN(Date.parse(p.edited_at)) ? new Date(p.edited_at) : null;
	// the app it was posted from on its home instance; older instances don't send it
	const source = typeof p.source === "string" && /^[^\p{Cc}]{1,60}$/u.test(p.source.trim()) ? p.source.trim() : instance;
	if (local) {
		const old = await sql.begin(async (tx) => {
			const [row] = await tx`select text, created_at, edited_at, edit_count, reply_to_id from posts where id = ${local}::bigint for update`;
			const changed = !!row && row.text !== text;
			if (changed)
				await tx`insert into post_versions (version_id, post_id, seq, text, created_at)
					values (${newId()}::bigint, ${local}::bigint, ${row.edit_count}, ${row.text}, ${row.edited_at ?? row.created_at})`;
			await tx`update posts set text = ${text}, source = ${source}, sensitive = ${!!p.sensitive}, edited_at = ${changed ? (editedAt ?? new Date()) : editedAt},
				edit_count = edit_count + ${changed ? 1 : 0}, remote_counts = ${countsOf(p.counts, POST_COUNTS)}::text::jsonb where id = ${local}::bigint`;
			return row;
		});
		const orphaned = old?.reply_to_id && !(await sql`select 1 from posts where id = ${old.reply_to_id}::bigint`).length;
		if (old && (!old.reply_to_id || orphaned) && p.reply_to) {
			const replyTo = await resolvePost(p.reply_to, depth);
			const [parent] = replyTo ? await sql`select conversation_id::text, user_id::text from posts where id = ${replyTo}::bigint` : [];
			if (parent && !(await blockedBetween(author, parent.user_id)))
				await sql`update posts set reply_to_id = ${replyTo}::bigint, reply_to_user_id = ${parent.user_id}::bigint, conversation_id = ${parent.conversation_id}::bigint where id = ${local}::bigint`;
		}
		await saveMentions(local, text, instance, lookupRemoteUser);
		await attachMedia(instance, author, local, p.media);
		return local;
	}
	const replyTo = (p.reply_to ? await resolvePost(p.reply_to, depth) : undefined) ?? (p.reply_to || p.is_reply === true ? newId() : undefined);
	const [parent] = replyTo ? await sql`select conversation_id::text, user_id::text from posts where id = ${replyTo}::bigint` : [];
	if (parent && ((await blockedBetween(author, parent.user_id)) || (await replyLimited(parent.conversation_id, author)))) return undefined;
	const id = newId();
	const created = typeof p.created_at === "string" && !Number.isNaN(Date.parse(p.created_at)) ? new Date(Math.min(Date.parse(p.created_at), Date.now())) : new Date();
	await sql`insert into posts (id, user_id, text, reply_to_id, reply_to_user_id, conversation_id, quote_id, source, sensitive, edited_at, created_at)
		values (${id}::bigint, ${author}::bigint, ${text}, ${replyTo ?? null}::bigint, ${parent?.user_id ?? null}::bigint, ${parent?.conversation_id ?? id}::bigint,
			${quote ?? null}::bigint, ${source}, ${!!p.sensitive}, ${editedAt}, ${created})`;
	await sql`insert into federated_objects (instance, kind, remote_id, local_id) values (${instance}, 'post', ${p.id}::bigint, ${id}::bigint) on conflict do nothing`;
	await sql`update posts set remote_counts = ${countsOf(p.counts, POST_COUNTS)}::text::jsonb where id = ${id}::bigint`;
	await saveMentions(id, text, instance, lookupRemoteUser);
	await attachMedia(instance, author, id, p.media);
	return id;
}

async function attachMedia(instance: string, author: string, post: string, list: unknown) {
	const items = Array.isArray(list) ? list.slice(0, 4) : [];
	const kept: string[] = [];
	for (const [i, m] of items.entries()) {
		const id = await remoteMedia(instance, author, m, post, i);
		if (id) kept.push(id);
	}
	await sql`delete from media where post_id = ${post}::bigint and remote_instance = ${instance} and not (id = any(${sql.array(kept, "INT8")}))`;
}

const blockedBetween = async (a: string, b: string) =>
	(await sql`select 1 from blocks where (blocker_id = ${a}::bigint and blocked_id = ${b}::bigint) or (blocker_id = ${b}::bigint and blocked_id = ${a}::bigint)`).length > 0;

async function applyPair(instance: string, e: any) {
	const actor = await resolveUser(ref(String(e.actor ?? ""), instance));
	if (!actor) return;
	const home = parseRef(e.target);
	if (home?.instance === instance && e.counts) {
		const target = await mapped(instance, e.kind === "follow" ? "user" : "post", home.id);
		if (target)
			await (e.kind === "follow"
				? sql`update users set remote_counts = ${countsOf(e.counts, USER_COUNTS)}::text::jsonb where id = ${target}::bigint`
				: sql`update posts set remote_counts = ${countsOf(e.counts, POST_COUNTS)}::text::jsonb where id = ${target}::bigint`);
	}
	if (e.kind === "follow") {
		const target = await resolveUser(e.target);
		if (!target || target === actor) return;
		if (!e.on) {
			await sql`delete from follows where follower_id = ${actor}::bigint and followee_id = ${target}::bigint`;
			return void (await sql`insert into federation_outbox (kind, a) select 'user', id from users where id = ${target}::bigint and instance is null`);
		}
		const [t] = await sql`select protected from users where id = ${target}::bigint`;
		if (t?.protected || (await blockedBetween(actor, target))) return;
		await sql`insert into follows (follower_id, followee_id) values (${actor}::bigint, ${target}::bigint) on conflict do nothing`;
		await sql`insert into federation_outbox (kind, a) select 'user', id from users where id = ${target}::bigint and instance is null`;
		return;
	}
	const post = await resolvePost(e.target);
	if (!post) return;
	const table = e.kind === "like" ? sql`likes` : sql`reposts`;
	if (!e.on) {
		await sql`delete from ${table} where user_id = ${actor}::bigint and post_id = ${post}::bigint`;
		return void (await sql`insert into federation_outbox (kind, a) select 'post', p.id from posts p join users u on u.id = p.user_id where p.id = ${post}::bigint and u.instance is null`);
	}
	const [owner] = await sql`select user_id::text from posts where id = ${post}::bigint`;
	if (owner && (await blockedBetween(actor, owner.user_id))) return;
	if (e.kind === "like") await sql`insert into likes (user_id, post_id) values (${actor}::bigint, ${post}::bigint) on conflict do nothing`;
	else await sql`insert into reposts (id, user_id, post_id) values (${newId()}::bigint, ${actor}::bigint, ${post}::bigint) on conflict do nothing`;
	await sql`insert into federation_outbox (kind, a) select 'post', p.id from posts p join users u on u.id = p.user_id where p.id = ${post}::bigint and u.instance is null`;
}

async function applyAffiliation(instance: string, e: any) {
	const fromOrg = e.kind === "affiliate";
	const actor = await resolveUser(ref(String(e.actor ?? ""), instance));
	const other = actor && (await resolveUser(e.target));
	if (!actor || !other || actor === other) return;
	const [org, member] = fromOrg ? [actor, other] : [other, actor];
	const on = fromOrg ? e.state === "on" : e.on === true;
	const [o] = await sql`select instance, verified_type in ('business', 'government') as is_org from users where id = ${org}::bigint`;
	const [m] = await sql`select instance from users where id = ${member}::bigint`;
	if (!o || !m) return;
	const pair = sql`org_id = ${org}::bigint and user_id = ${member}::bigint`;
	const join = () => (o.is_org ? sql`insert into affiliations (org_id, user_id) values (${org}::bigint, ${member}::bigint) on conflict do nothing`.catch(() => {}) : undefined);
	if (!o.instance) {
		if (fromOrg) return;
		if (!on) {
			await sql`delete from affiliation_requests where ${pair}`;
			await sql`delete from affiliations where ${pair}`;
			return;
		}
		const asked = await sql`delete from affiliation_requests where ${pair} returning 1`;
		if (asked.length) await join();
		return;
	}
	if (!m.instance) {
		if (!fromOrg || e.state === "on") return;
		if (e.state === "requested") {
			if (o.is_org && !(await blockedBetween(org, member)) && !(await sql`select 1 from affiliations where ${pair}`).length)
				await sql`insert into affiliation_requests (org_id, user_id) values (${org}::bigint, ${member}::bigint) on conflict do nothing`;
			return;
		}
		await sql`delete from affiliation_requests where ${pair}`;
		await sql`delete from affiliations where ${pair}`;
		return;
	}
	if (o.instance === m.instance) {
		await (on ? join() : sql`delete from affiliations where ${pair}`);
		return;
	}
	const side = fromOrg ? "org" : "member";
	if (!on) {
		await sql`delete from affiliation_votes where ${pair} and side = ${side}`;
		await sql`delete from affiliations where ${pair}`;
		return;
	}
	await sql`insert into affiliation_votes (org_id, user_id, side) values (${org}::bigint, ${member}::bigint, ${side}) on conflict do nothing`;
	const [votes] = await sql`select count(*)::int as n from affiliation_votes where ${pair}`;
	if (votes.n === 2) await join();
}

async function applyEvent(instance: string, e: any) {
	if (e?.kind === "user") return void (await applyUser(instance, e));
	if (e?.kind === "post") return void (await applyPost(instance, e));
	if (e?.kind === "like" || e?.kind === "repost" || e?.kind === "follow") return applyPair(instance, e);
	if (e?.kind === "affiliate" || e?.kind === "affiliation") return applyAffiliation(instance, e);
}

const pulling = new Set<string>();
const wanted = new Set<string>();
const known = new Set<string>();

// An instance that is down, or doesn't take us yet, was asked again every 15
// seconds for as long as it failed, each time with a request out and a write
// here. After a failure the timed pulls wait twice as long each time, up to
// PULL_BACKOFF_MAX; a pull that works, or a poke from the instance, ends that.
const PULL_BACKOFF_BASE = 15_000;
const PULL_BACKOFF_MAX = 15 * 60_000;
const failing = new Map<string, { failures: number; until: number }>();
const backingOff = (instance: string) => (failing.get(instance)?.until ?? 0) > Date.now();

export async function pullFrom(instance: string): Promise<number> {
	if (pulling.has(instance)) {
		wanted.add(instance);
		return 0;
	}
	pulling.add(instance);
	let applied = 0;
	try {
		if (!known.has(instance)) {
			await sql`insert into federation_peers (instance) values (${instance}) on conflict do nothing`;
			known.add(instance);
		}
		for (let page = 0; page < 20; page++) {
			const [peer] = await sql`select cursor::text from federation_peers where instance = ${instance}`;
			const r = await signedFetch(instance, "GET", `/federation/v1/events?after=${peer.cursor}&limit=${PAGE}`);
			if (r.status !== 200) throw new FederationError(`${instance} answered ${r.status}`);
			const doc = r.json();
			if (!Array.isArray(doc?.events) || !/^\d{1,19}$/.test(String(doc.next))) throw new FederationError(`${instance} sent a malformed page`);
			failing.delete(instance);
			const previous = budgets.get(instance);
			const budget = previous && Date.now() - previous.start <= 3_600_000 ? previous : { start: Date.now(), used: 0 };
			budgets.set(instance, budget);
			let stoppedAt: string | undefined;
			for (const e of doc.events) {
				if (isBlocked(instance)) return applied;
				if (budget.used >= EVENTS_PER_HOUR) {
					stoppedAt = /^\d{1,19}$/.test(String(e?.seq)) && BigInt(e.seq) > BigInt(peer.cursor) && BigInt(e.seq) <= BigInt(doc.next) ? String(BigInt(e.seq) - 1n) : peer.cursor;
					break;
				}
				budget.used++;
				await applyEvent(instance, e).catch((err) => console.error(`federation: ${instance} event ${e?.seq}:`, err instanceof Error ? err.message : err));
				applied++;
			}
			if (stoppedAt !== undefined) {
				await sql`update federation_peers set cursor = greatest(cursor, ${stoppedAt}::bigint), last_error = ${`paused: more than ${EVENTS_PER_HOUR} changes in an hour`}, last_error_at = now() where instance = ${instance}`;
				return applied;
			}
			await sql`update federation_peers set cursor = greatest(cursor, ${doc.next}::bigint), last_ok_at = now(), last_error = null where instance = ${instance}`;
			if (!doc.more) break;
		}
	} catch (e) {
		const failures = (failing.get(instance)?.failures ?? 0) + 1;
		failing.set(instance, { failures, until: Date.now() + Math.min(PULL_BACKOFF_BASE * 2 ** failures, PULL_BACKOFF_MAX) });
		await sql`update federation_peers set last_error = ${e instanceof Error ? e.message.slice(0, 500) : String(e)}, last_error_at = now() where instance = ${instance}`;
	} finally {
		pulling.delete(instance);
		if (wanted.delete(instance)) void pullFrom(instance);
	}
	return applied;
}

const pokes = new Map<string, ReturnType<typeof setTimeout>>();
function pokeSoon(instance: string) {
	if (pokes.has(instance) || !isPeer(instance)) return;
	// it answers again
	failing.delete(instance);
	pokes.set(
		instance,
		setTimeout(() => {
			pokes.delete(instance);
			void pullFrom(instance);
		}, 500),
	);
}

let lastPoked = "0";
async function pokePeers() {
	const [{ max }] = await sql`select coalesce(max(seq), 0)::text as max from federation_outbox`;
	if (max === lastPoked) return;
	lastPoked = max;
	await Promise.all(peers().map((p) => signedFetch(p.id, "POST", "/federation/v1/poke", {}).catch(() => undefined)));
}

const fetching = new Map<string, Promise<Uint8Array | undefined>>();
function pullOnce(localId: string, poster: boolean): Promise<Uint8Array | undefined> {
	const key = `${localId}${poster ? "p" : ""}`;
	const running = fetching.get(key);
	if (running) return running;
	const job = pullRemoteMedia(localId, poster).finally(() => fetching.delete(key));
	fetching.set(key, job);
	return job;
}

const memory = new Map<string, Uint8Array>();
let memoryBytes = 0;
function remember(key: string, body: Uint8Array) {
	if (body.length > MEMORY_CACHE / 4) return;
	memory.set(key, body);
	memoryBytes += body.length;
	for (const [k, v] of memory) {
		if (memoryBytes <= MEMORY_CACHE) break;
		memory.delete(k);
		memoryBytes -= v.length;
	}
}

export async function remoteMediaFile(localId: string, poster = false): Promise<Blob | undefined> {
	const file = poster ? posterFile(MEDIA_DIR, localId) : join(MEDIA_DIR, localId);
	if (existsSync(file)) return Bun.file(file);
	const key = `${localId}${poster ? "p" : ""}`;
	const cached = memory.get(key);
	if (cached) {
		memory.delete(key);
		memory.set(key, cached);
		return new Blob([cached as Uint8Array<ArrayBuffer>]);
	}
	const body = await pullOnce(localId, poster);
	if (!body) return undefined;
	if (!STORE_MEDIA) {
		remember(key, body);
		return new Blob([body as Uint8Array<ArrayBuffer>]);
	}
	await putFile(file, body);
	if (!poster) await sql`update media set size = ${body.length} where id = ${localId}::bigint`;
	return Bun.file(file);
}

// Files are fetched when their post or profile syncs, not when someone first
// views them: fetched on view, everything not yet seen went blank while the
// other instance was down. A failing instance is left alone for a while and
// the backfill below picks its files up again.
const QUEUE_PARALLEL = 3;
const BACKOFF_MS = STORE_MEDIA ? 5 * 60_000 : 30_000;
const queue: { id: string; poster: boolean }[] = [];
const queued = new Set<string>();
const failingUntil = new Map<string, number>();
// answered 404 by their instance: not asked again until the next start
const gone = new Set<string>();
let draining = 0;

function prefetch(localId: string, poster = false) {
	if (!STORE_MEDIA) return;
	for (const p of poster ? [false, true] : [false]) {
		const key = `${localId}${p ? "p" : ""}`;
		if (queued.has(key) || queue.length >= 10_000) continue;
		queued.add(key);
		queue.push({ id: localId, poster: p });
	}
	drain();
}

function drain() {
	while (draining < QUEUE_PARALLEL && queue.length) {
		const job = queue.shift()!;
		draining++;
		void remoteMediaFile(job.id, job.poster)
			.catch(() => undefined)
			.finally(() => {
				queued.delete(`${job.id}${job.poster ? "p" : ""}`);
				draining--;
				drain();
			});
	}
}

// files still missing (an instance that was down, a server restart mid-queue)
async function backfillMedia() {
	if (!STORE_MEDIA) return;
	const rows = await sql`select id::text, kind from media where remote_instance is not null and size = 0
		and remote_instance <> all(${sql.array([...failingUntil].filter(([, until]) => until > Date.now()).map(([i]) => i), "TEXT")})
		and id <> all(${sql.array([...gone], "INT8")})
		order by id desc limit 200`;
	for (const r of rows as any[]) prefetch(r.id, r.kind === "video");
}

async function pullRemoteMedia(localId: string, poster: boolean): Promise<Uint8Array | undefined> {
	const [m] = await sql`select remote_instance, remote_id::text from media where id = ${localId}::bigint and remote_instance is not null`;
	if (!m || !isPeer(m.remote_instance)) return undefined;
	if ((failingUntil.get(m.remote_instance) ?? 0) > Date.now()) return undefined;
	let failure = "";
	const r = await signedFetch(m.remote_instance, "GET", `/federation/v1/media/${m.remote_id}${poster ? "/poster" : ""}`, undefined, MAX_MEDIA).catch((e) => {
		failure = e instanceof Error ? e.message : String(e);
		return undefined;
	});
	// a 404 is that one file; anything else is the instance
	if (r?.status !== 200) {
		if (r?.status === 404 && !poster) gone.add(localId);
		if (r?.status !== 404) {
			if (!((failingUntil.get(m.remote_instance) ?? 0) > Date.now()))
				console.error(`federation: media from ${m.remote_instance} failing (${failure || `status ${r?.status}`}), retrying in ${BACKOFF_MS / 60_000} minutes`);
			failingUntil.set(m.remote_instance, Date.now() + BACKOFF_MS);
		}
		return undefined;
	}
	failingUntil.delete(m.remote_instance);
	return r.body;
}

export async function lookupRemoteUser(handle: string): Promise<string | undefined> {
	const m = /^([^\s\p{C}/\\?#@%,:]{1,50})@([a-z0-9.:-]{1,260})$/iu.exec(handle);
	if (!m) return undefined;
	const instance = m[2].toLowerCase();
	const [known] = await sql`select id::text from users where lower(screen_name) = lower(${`${m[1]}@${instance}`}) and instance = ${instance}`;
	if (known) return known.id;
	if (!isPeer(instance)) return undefined;
	const r = await signedFetch(instance, "GET", `/federation/v1/users/by-name/${encodeURIComponent(m[1])}`).catch(() => undefined);
	return r?.status === 200 ? applyUser(instance, r.json()) : undefined;
}

let started = false;
export function startFederationSync() {
	if (started) return;
	started = true;
	let tick = 0;
	setInterval(() => {
		tick++;
		void pokePeers().catch(() => {});
		if (tick % 5 === 0) for (const p of peers()) if (!backingOff(p.id)) void pullFrom(p.id);
		if (tick % 200 === 10) void backfillMedia().catch((e) => console.error("federation: media backfill:", e instanceof Error ? e.message : e));
		if (tick % 3600 === 0) void sql`delete from federation_outbox where created_at < now() - interval '60 days'`.catch(() => {});
	}, 3000).unref();
}

export const storesRemoteMedia = () => STORE_MEDIA;

export async function savedRemoteMedia(): Promise<{ files: number; bytes: number }> {
	const [r] = await sql`select count(*) filter (where size > 0)::int as files, coalesce(sum(size), 0)::float8 as bytes from media where remote_instance is not null`;
	return { files: r.files, bytes: r.bytes };
}

export async function dropRemoteMedia(instance?: string): Promise<{ files: number; bytes: number }> {
	let files = 0;
	let bytes = 0;
	for (const { id } of await sql`select id::text from media where remote_instance is not null and (${instance ?? null}::text is null or remote_instance = ${instance ?? null})`) {
		for (const file of [join(MEDIA_DIR, id), posterFile(MEDIA_DIR, id)]) {
			if (!existsSync(file)) continue;
			bytes += statSync(file).size;
			rmSync(file, { force: true });
			files++;
		}
	}
	await sql`update media set size = 0 where remote_instance is not null and size <> 0`;
	memory.clear();
	memoryBytes = 0;
	return { files, bytes };
}
