// Moving an account to another instance, the old instance's half. On
// /account/migrate (migration-page.ts) the account makes a migration code; the
// new instance presents it as a bearer token to read, under /migration/v1/:
//   GET  info        what this instance runs and what the account holds
//   GET  archive     the account as JSON (format below)
//   GET  media/<id>  one of the account's own files (?poster=1: a video's poster)
//   POST complete    the import finished: record where the account went and,
//                    if asked, leave a note on the profile and deactivate it
// The new instance's half is migration-import.ts.
//
// Other accounts and posts are named by where they live, { i: instance, id,
// h: handle }, the id being the one on their home instance, so the new
// instance can find the same account or post however it came to know it.

import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { FEDERATION_ON, INSTANCE_ID, isPeer } from "./federation";
import { MEDIA_DIR } from "./media";
import { hit, limitedResponse } from "./ratelimit";
import { requestIp } from "./login-history";
import { feature, settings } from "./settings";
import { posterFile } from "./video";
import { COMMIT, MIGRATION_FORMAT_VERSION, SCHEMA, VERSION } from "./version";

export const FORMAT = "xitter-migration";
export const FORMAT_VERSION = MIGRATION_FORMAT_VERSION;
const CODE_TTL_HOURS = 24;

export type VersionInfo = { software: string; version: string; schema: string; commit: string | null; format: string; format_version: number; instance: string; url: string; name: string };

export const versionInfo = (): VersionInfo => ({
	software: "xitter",
	version: VERSION,
	schema: SCHEMA,
	commit: COMMIT,
	format: FORMAT,
	format_version: FORMAT_VERSION,
	instance: INSTANCE_ID,
	url: PUBLIC_ORIGIN,
	name: settings().instance_name,
});

const hashOf = (code: string) => createHash("sha256").update(code).digest("hex");

// A new code replaces any earlier one that hasn't been used to finish a move.
export async function createCode(userId: string): Promise<string> {
	const code = `xmig_${randomBytes(32).toString("base64url")}`;
	await sql.begin(async (tx) => {
		await tx`delete from migration_tokens where user_id = ${userId}::bigint and completed_at is null`;
		await tx`insert into migration_tokens (token_hash, user_id, expires_at) values (${hashOf(code)}, ${userId}::bigint, now() + make_interval(hours => ${CODE_TTL_HOURS}))`;
	});
	return code;
}

export const revokeCodes = (userId: string) => sql`delete from migration_tokens where user_id = ${userId}::bigint and completed_at is null`;

export type CodeState = { created_at: Date; expires_at: Date; used_by: string | null; used_at: Date | null; expired: boolean };

export async function codeState(userId: string): Promise<CodeState | undefined> {
	const [row] = await sql`select created_at, expires_at, used_by, used_at, expires_at < now() as expired from migration_tokens
		where user_id = ${userId}::bigint and completed_at is null order by created_at desc limit 1`;
	return row as CodeState | undefined;
}

type Holder = { userId: string; tokenHash: string };

async function holder(req: Request): Promise<Holder | undefined> {
	const code = /^Bearer (xmig_[A-Za-z0-9_-]{43})$/.exec(req.headers.get("authorization") ?? "")?.[1];
	if (!code) return undefined;
	const tokenHash = hashOf(code);
	const [row] = await sql`select t.user_id::text from migration_tokens t join users u on u.id = t.user_id
		where t.token_hash = ${tokenHash} and t.completed_at is null and t.expires_at > now() and u.instance is null and u.status <> 'suspended'`;
	return row ? { userId: row.user_id, tokenHash } : undefined;
}

const fail = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

// JS's Date.toJSON form, as the data archive uses
const iso = (column: ReturnType<typeof sql>) => sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const list = (query: ReturnType<typeof sql>) => sql`coalesce((select jsonb_agg(to_jsonb(x)) from (${query}) x), '[]'::jsonb)`;

// an account, wherever it lives, named the way its home instance names it;
// the aliases are unusual so the queries they sit in can use the short ones
const userRef = (id: ReturnType<typeof sql>) => sql`(select jsonb_build_object('i', coalesce(ref_u.instance, ${INSTANCE_ID}), 'id', coalesce(ref_u.remote_id, ref_u.id)::text, 'h', ref_u.screen_name)
	from users ref_u where ref_u.id = ${id})`;
// a post by its id on its author's instance; a copy of a post from another
// instance whose origin isn't known (it shouldn't happen) has no ref
const postRef = (id: ReturnType<typeof sql>) => sql`(select case when ref_a.instance is null then jsonb_build_object('i', ${INSTANCE_ID}::text, 'id', ref_p.id::text)
		when ref_o.remote_id is not null then jsonb_build_object('i', ref_a.instance, 'id', ref_o.remote_id::text) end
	from posts ref_p join users ref_a on ref_a.id = ref_p.user_id
	left join federated_objects ref_o on ref_o.kind = 'post' and ref_o.local_id = ref_p.id and ref_o.instance = ref_a.instance
	where ref_p.id = ${id})`;

// The files the account's things use: post media, the avatar and banner, poll
// choices, article covers, list banners and uploads in drafts. Uploads left
// over from deleted posts or abandoned composers stay behind.
const ownMedia = (userId: string) => sql`select m.* from media m where m.user_id = ${userId}::bigint and m.remote_instance is null and m.state = 'ready' and (
	m.post_id is not null
	or m.id::text in (select substring(u.avatar_url from '^/media/(\\d+)') from users u where u.id = ${userId}::bigint union all select substring(u.banner_url from '^/media/banner/(\\d+)') from users u where u.id = ${userId}::bigint)
	or m.id in (select unnest(p.choice_media) from polls p where p.user_id = ${userId}::bigint)
	or m.id in (select a.cover_media_id from articles a where a.user_id = ${userId}::bigint and a.cover_media_id is not null)
	or m.id in (select l.banner_media_id from lists l where l.owner_id = ${userId}::bigint and l.banner_media_id is not null)
	or m.id::text in (select jsonb_array_elements_text(case when jsonb_typeof(s.request->'media_ids') = 'array' then s.request->'media_ids' else '[]' end) from scheduled_posts s where s.user_id = ${userId}::bigint
		union all select jsonb_array_elements_text(case when jsonb_typeof(t->'media_ids') = 'array' then t->'media_ids' else '[]' end)
		from scheduled_posts s, jsonb_array_elements(case when jsonb_typeof(s.request->'thread_tweets') = 'array' then s.request->'thread_tweets' else '[]' end) t where s.user_id = ${userId}::bigint))`;

async function summary(userId: string) {
	const [s] = await sql`select u.screen_name, u.name, u.status, u.moved_to, ${iso(sql`u.created_at`)} as created_at,
		(select count(*)::int from posts where user_id = u.id) as posts,
		(select count(*)::int from follows where follower_id = u.id) as following,
		(select count(*)::int from follows where followee_id = u.id) as followers,
		(select count(*)::int from likes where user_id = u.id) as likes,
		(select count(*)::int from bookmarks where user_id = u.id) as bookmarks,
		(select count(*)::int from lists where owner_id = u.id) as lists,
		(select count(*)::int from scheduled_posts where user_id = u.id) as drafts,
		(select count(*)::int from articles where user_id = u.id) as articles,
		(select count(*)::int from chat_members where user_id = u.id) as conversations,
		(select coalesce(jsonb_agg(jsonb_build_object('id', m.id::text, 'kind', m.kind, 'size', m.size)), '[]'::jsonb) from (${ownMedia(userId)}) m) as media
		from users u where u.id = ${userId}::bigint`;
	return { id: userId, ...s };
}

async function archive(userId: string) {
	const id = userId;
	const [row] = await sql`select jsonb_build_object(
		'format', ${FORMAT}::text, 'format_version', ${FORMAT_VERSION}::int, 'exported_at', ${new Date().toISOString()}::text,
		'source', ${JSON.stringify(versionInfo())}::text::jsonb,
		'account', (select to_jsonb(x) from (select u.id::text as id, u.screen_name, u.name, u.bio, u.pronouns, u.location, u.website, u.protected, u.language, u.flag, u.parody_label,
			u.never_sensitive, u.preferences, ${iso(sql`u.created_at`)} as created_at, u.pinned_post_id::text as pinned_post_id,
			substring(u.avatar_url from '^/media/(\\d+)') as avatar_media_id, substring(u.banner_url from '^/media/banner/(\\d+)') as banner_media_id
			from users u where u.id = ${id}::bigint) x),
		'media', ${list(sql`select m.id::text as id, m.kind, m.mime, m.size, m.width, m.height, m.post_id::text as post_id, m.position, m.duration_ms,
			m.alt_text, m.sensitive_warning, ${iso(sql`m.created_at`)} as created_at from (${ownMedia(id)}) m order by m.id`)},
		'polls', ${list(sql`select id::text as id, choices, duration_minutes, ${iso(sql`ends_at`)} as ends_at, ${iso(sql`created_at`)} as created_at,
			(select array_agg(c::text order by n) from unnest(choice_media) with ordinality as x(c, n)) as choice_media
			from polls where user_id = ${id}::bigint order by id`)},
		'articles', ${list(sql`select id::text as id, title, content_state, plain_text, cover_media_id::text as cover_media_id, state,
			${iso(sql`created_at`)} as created_at, ${iso(sql`modified_at`)} as modified_at, ${iso(sql`first_published_at`)} as first_published_at
			from articles where user_id = ${id}::bigint order by id`)},
		'posts', ${list(sql`select p.id::text as id, p.text, ${iso(sql`p.created_at`)} as created_at, p.conversation_id::text as conversation_id,
			case when p.reply_to_id is null then null else coalesce(${postRef(sql`p.reply_to_id`)}, '{}'::jsonb) end as reply_to,
			case when p.quote_id is null then null else ${postRef(sql`p.quote_id`)} end as quote,
			p.poll_id::text as poll_id, p.article_id::text as article_id, p.sensitive, p.reply_policy, p.place_id, p.source,
			p.edit_count, ${iso(sql`p.edited_at`)} as edited_at, p.pinned_reply_id::text as pinned_reply_id,
			(select coalesce(jsonb_agg(jsonb_build_object('seq', v.seq, 'text', v.text, 'created_at', ${iso(sql`v.created_at`)}) order by v.seq), '[]'::jsonb)
				from post_versions v where v.post_id = p.id) as versions
			-- a Circle post would arrive public on the other instance (circles.ts)
			from posts p where p.user_id = ${id}::bigint and p.circle_owner_id is null order by p.id`)},
		'drafts', ${list(sql`select id::text as id, kind, request, ${iso(sql`execute_at`)} as execute_at, ${iso(sql`created_at`)} as created_at
			from scheduled_posts where user_id = ${id}::bigint order by id`)},
		'likes', ${list(sql`select ${postRef(sql`l.post_id`)} as post, ${iso(sql`l.created_at`)} as created_at from likes l where l.user_id = ${id}::bigint order by l.created_at`)},
		'bookmarks', ${list(sql`select ${postRef(sql`b.post_id`)} as post, ${iso(sql`b.created_at`)} as created_at from bookmarks b where b.user_id = ${id}::bigint order by b.created_at`)},
		'reposts', ${list(sql`select ${postRef(sql`r.post_id`)} as post, ${iso(sql`r.created_at`)} as created_at from reposts r where r.user_id = ${id}::bigint order by r.id`)},
		'highlights', ${list(sql`select ${postRef(sql`h.post_id`)} as post, ${iso(sql`h.created_at`)} as created_at from highlights h where h.user_id = ${id}::bigint order by h.created_at`)},
		'bookmark_folders', ${list(sql`select f.id::text as id, f.name, ${iso(sql`f.created_at`)} as created_at,
			(select coalesce(jsonb_agg(${postRef(sql`fp.post_id`)} order by fp.created_at), '[]'::jsonb) from bookmark_folder_posts fp where fp.folder_id = f.id) as posts
			from bookmark_folders f where f.user_id = ${id}::bigint order by f.created_at`)},
		'following', ${list(sql`select ${userRef(sql`f.followee_id`)} as user, ${iso(sql`f.created_at`)} as created_at from follows f where f.follower_id = ${id}::bigint order by f.created_at`)},
		'follow_requests', ${list(sql`select ${userRef(sql`f.target_id`)} as user from follow_requests f where f.requester_id = ${id}::bigint`)},
		'blocked', ${list(sql`select ${userRef(sql`b.blocked_id`)} as user from blocks b where b.blocker_id = ${id}::bigint`)},
		'muted', ${list(sql`select ${userRef(sql`m.muted_id`)} as user from mutes m where m.muter_id = ${id}::bigint`)},
		'muted_keywords', ${list(sql`select keyword, surfaces, exclude_following, ${iso(sql`valid_until`)} as valid_until, ${iso(sql`created_at`)} as created_at
			from muted_keywords where user_id = ${id}::bigint and (valid_until is null or valid_until > now())`)},
		'lists', ${list(sql`select l.id::text as id, l.name, l.description, l.is_private, l.banner_media_id::text as banner_media_id, ${iso(sql`l.created_at`)} as created_at,
			(select coalesce(jsonb_agg(${userRef(sql`lm.user_id`)}), '[]'::jsonb) from list_members lm where lm.list_id = l.id) as members
			from lists l where l.owner_id = ${id}::bigint order by l.id`)}
	) as body`;
	return row.body;
}

export async function migrationApi(req: Request, url: URL): Promise<Response> {
	if (!feature("migration")) return fail(403, "Moving accounts away from this instance is turned off.");
	const ip = requestIp(req) ?? "unknown";
	const who = await holder(req);
	if (!who) {
		const h = hit("auth", ip);
		if (!h.ok) return limitedResponse(h);
		return fail(401, "That migration code isn't valid. It may have expired, been replaced or already been used.");
	}
	const h = hit("migration", who.tokenHash);
	if (!h.ok) return limitedResponse(h);
	const p = url.pathname.slice("/migration/v1/".length);
	const from = (req.headers.get("x-xitter-migration-to") ?? "").slice(0, 300) || null;
	if (p === "info" && req.method === "GET") {
		await sql`update migration_tokens set used_by = coalesce(${from}, used_by), used_at = now() where token_hash = ${who.tokenHash}`;
		// whether this instance federates with the one asking, which it names; the
		// other instance warns when the two don't, since then the account's
		// connections there can't be matched
		const federation = { enabled: FEDERATION_ON, with_you: !!from && isPeer(from) };
		return Response.json({ ...versionInfo(), federation, account: await summary(who.userId) }, { headers: { "cache-control": "no-store" } });
	}
	if (p === "archive" && req.method === "GET") {
		await sql`update migration_tokens set used_by = coalesce(${from}, used_by), used_at = now() where token_hash = ${who.tokenHash}`;
		return new Response(JSON.stringify(await archive(who.userId)), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
	}
	const file = /^media\/(\d{1,19})$/.exec(p);
	if (file && req.method === "GET") {
		const [m] = await sql`select id::text, mime, kind from (${ownMedia(who.userId)}) m where m.id = ${file[1]}::bigint`;
		if (!m) return fail(404, "No such file.");
		const poster = url.searchParams.get("poster") === "1";
		if (poster && m.kind !== "video") return fail(404, "No such file.");
		const path = poster ? posterFile(MEDIA_DIR, m.id) : join(MEDIA_DIR, m.id);
		if (!existsSync(path)) return fail(404, "The file is missing on this instance.");
		return new Response(Bun.file(path), { headers: { "content-type": poster ? "image/jpeg" : m.mime, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
	}
	if (p === "complete" && req.method === "POST") {
		const body = await req.json().catch(() => ({}));
		const to = typeof body?.to === "string" && /^\w{1,15}@[a-z0-9.-]{1,253}(?::\d{1,5})?$/i.test(body.to) ? body.to.toLowerCase() : undefined;
		if (!to) return fail(400, "Say where the account went, as handle@instance.");
		const done = await sql.begin(async (tx) => {
			const [token] = await tx`update migration_tokens set completed_at = now(), used_by = ${to.slice(to.indexOf("@") + 1)}
				where token_hash = ${who.tokenHash} and completed_at is null returning user_id::text`;
			if (!token) return undefined;
			await tx`update users set moved_to = ${to}, moved_at = now() where id = ${who.userId}::bigint`;
			// the new instance has these now and publishes them itself
			await tx`delete from scheduled_posts where user_id = ${who.userId}::bigint and kind = 'scheduled'`;
			if (body.note === true) await tx`update users set bio = ${`Moved to @${to}`} where id = ${who.userId}::bigint`;
			let deactivated = false;
			if (body.deactivate === true) {
				const rows = await tx`update users set status = 'suspended', deactivated_at = now()
					where id = ${who.userId}::bigint and role is null and status = 'active' and status_until is null returning id`;
				deactivated = rows.length > 0;
				if (deactivated) await tx`delete from sessions where user_id = ${who.userId}::bigint`;
			}
			return { deactivated };
		});
		if (!done) return fail(409, "This move was already finished.");
		void import("./money").then(({ moveBalance }) => moveBalance(who.userId, to)).catch((e) => console.error("Equicoins balance move:", e instanceof Error ? e.message : e));
		return Response.json({ ok: true, ...done }, { headers: { "cache-control": "no-store" } });
	}
	return fail(404, "Unknown migration call.");
}
