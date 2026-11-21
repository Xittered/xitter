// Blocks, muted accounts and muted words.
// A block works both ways: neither side sees the other's posts, and any follow
// between them ends. A mute only hides the account from the muter's home feeds
// and notifications. Muted words hide matching posts on the surfaces chosen.

import { sql } from "./db";
import { lockedAbove } from "./reply-controls";
import { newId } from "./ids";
import { revealedSuspended, staffViewer } from "./staff-access";

// accounts the viewer blocked or was blocked by
export const blockedFor = (viewerId: string) =>
	sql`(select blocked_id from blocks where blocker_id = ${viewerId}::bigint
		union all select blocker_id from blocks where blocked_id = ${viewerId}::bigint)`;

const gone = sql`(status = 'suspended' or deactivated_at is not null or instance_blocked)`;
// gone, except a suspended account staff opened (staff-access.ts revealSuspended)
const goneHere = () => {
	const id = revealedSuspended();
	return id ? sql`(${gone} and not (id = ${id}::bigint and status = 'suspended'))` : gone;
};
export const outOfView = (viewerId: string) =>
	sql`(select id from users where ${goneHere()} or (status = 'limited' and id <> ${viewerId}::bigint
		and id not in (select followee_id from follows where follower_id = ${viewerId}::bigint)
		and not ${staffViewer(viewerId)}))`;

export const shadowedFor = (viewerId: string) => sql`(select id from users where shadow_banned and id <> ${viewerId}::bigint)`;

export const GUEST_ID = "0";
export const hiddenFromGuests = (u = sql`users`) => sql`coalesce(${u}.preferences->>'hide_from_guests', '') = 'true'`;

// Protected accounts: their posts are for themselves and the accounts they let
// follow. Staff see everything.
export const protectedFor = (viewerId: string) => viewerId === GUEST_ID
	? sql`(select id from users where protected or ${hiddenFromGuests()})`
	: sql`(select id from users where protected and id <> ${viewerId}::bigint
		and id not in (select followee_id from follows where follower_id = ${viewerId}::bigint)
		and not ${staffViewer(viewerId)})`;

export const suspendedFor = (viewerId: string) => sql`(select id from users where ${goneHere()} and id <> ${viewerId}::bigint)`;

// Accounts from other instances the viewer hid, all of them or some instances
// (Settings > Other instances): they stay out of timelines, replies, search and
// suggestions, except the ones the viewer follows. A search naming a full
// handle still finds them.
export const federatedHiddenFor = (viewerId: string) =>
	sql`(select u.id from users u join users me on me.id = ${viewerId}::bigint where u.instance is not null
		and (me.preferences->>'hide_federated' = 'true' or coalesce(me.preferences->'hidden_instances', '[]'::jsonb) ? u.instance)
		and u.id not in (select followee_id from follows where follower_id = ${viewerId}::bigint))`;

// the same accounts, for notifications: only when the viewer also chose to
// mute notifications from what they hid (mute_hidden_notifications)
export const federatedMutedFor = (viewerId: string) =>
	sql`(select x.id from ${federatedHiddenFor(viewerId)} as x(id)
		where exists (select 1 from users me where me.id = ${viewerId}::bigint and me.preferences->>'mute_hidden_notifications' = 'true'))`;

// a search that names someone on another instance (@name@example.org, from:name@example.org)
export const namesOtherInstance = (query: string) => /\w@[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(query);

export const mutedFor = (viewerId: string) => sql`(select muted_id from mutes where muter_id = ${viewerId}::bigint)`;

export type Surface = "home_timeline" | "notifications";

// true when the post `postId` (an SQL expression) holds a word the viewer muted on `surface`
export const hasMutedWord = (viewerId: string, surface: Surface, postId: ReturnType<typeof sql>) =>
	sql`exists (select 1 from muted_keywords k join posts mp on mp.id = ${postId}
		where k.user_id = ${viewerId}::bigint and ${surface} = any(k.surfaces) and (k.valid_until is null or k.valid_until > now())
			and position(lower(k.keyword) in lower(mp.text)) > 0
			and not (k.exclude_following and mp.user_id in (select followee_id from follows where follower_id = ${viewerId}::bigint)))`;

export async function setBlock(blockerId: string, blockedId: string, on: boolean): Promise<boolean> {
	if (blockerId === blockedId) return false;
	if (!on) {
		await sql`delete from blocks where blocker_id = ${blockerId}::bigint and blocked_id = ${blockedId}::bigint`;
		return true;
	}
	const [admin] = await sql`select 1 from users b join users t on t.id = ${blockedId}::bigint where b.id = ${blockerId}::bigint and b.instance is null and t.role = 'admin' and t.instance is null`;
	if (admin) return false;
	await sql.begin(async (tx) => {
		await tx`insert into blocks (blocker_id, blocked_id) values (${blockerId}::bigint, ${blockedId}::bigint) on conflict do nothing`;
		await tx`delete from follows where (follower_id = ${blockerId}::bigint and followee_id = ${blockedId}::bigint)
			or (follower_id = ${blockedId}::bigint and followee_id = ${blockerId}::bigint)`;
		for (const t of [tx`list_members`, tx`list_subscribers`])
			await tx`delete from ${t} m using lists l where m.list_id = l.id
				and ((l.owner_id = ${blockerId}::bigint and m.user_id = ${blockedId}::bigint) or (l.owner_id = ${blockedId}::bigint and m.user_id = ${blockerId}::bigint))`;
	});
	return true;
}

export async function replyLimited(parentId: string, conversationId: string, userId: string, db: typeof sql = sql): Promise<boolean> {
	const [limited] = await db`select ${lockedAbove(sql`${parentId}::bigint`, sql`${conversationId}::bigint`, userId)} as no`;
	return limited.no;
}

export async function isBlockedEitherWay(a: string, b: string, db: typeof sql = sql): Promise<boolean> {
	const rows = await db`select 1 from blocks where (blocker_id = ${a}::bigint and blocked_id = ${b}::bigint)
		or (blocker_id = ${b}::bigint and blocked_id = ${a}::bigint) limit 1`;
	return rows.length > 0;
}

export async function setMute(muterId: string, mutedId: string, on: boolean) {
	if (muterId === mutedId) return;
	if (on) await sql`insert into mutes (muter_id, muted_id) values (${muterId}::bigint, ${mutedId}::bigint) on conflict do nothing`;
	else await sql`delete from mutes where muter_id = ${muterId}::bigint and muted_id = ${mutedId}::bigint`;
}

// accounts the viewer blocked or muted, newest first
export async function blockedIds(viewerId: string, kind: "blocks" | "mutes", limit = 500): Promise<string[]> {
	const rows =
		kind === "blocks"
			? await sql`select blocked_id as id from blocks where blocker_id = ${viewerId}::bigint order by created_at desc limit ${limit}`
			: await sql`select muted_id as id from mutes where muter_id = ${viewerId}::bigint order by created_at desc limit ${limit}`;
	return rows.map((r: any) => String(r.id));
}

// Muted words in the shape of /1.1/mutes/keywords/list.json. The form sends
// the surfaces as a comma list, "exclude_following_accounts" or nothing as the
// option, and the duration in milliseconds (empty for forever).
type KeywordForm = { keyword?: string; mute_surfaces?: string; mute_options?: string; duration?: string };

const SURFACES = new Set(["home_timeline", "tweet_replies", "notifications"]);
const surfacesOf = (s = "") => [...new Set(s.split(",").map((x) => x.trim()).filter((x) => SURFACES.has(x)))];
const untilOf = (duration?: string) => (duration && /^\d+$/.test(duration) ? new Date(Date.now() + Number(duration)) : null);

export async function mutedKeywords(userId: string) {
	const rows = await sql`select * from muted_keywords where user_id = ${userId}::bigint and (valid_until is null or valid_until > now())
		order by created_at desc`;
	return {
		muted_keywords: rows.map((r: any) => ({
			id: String(r.id),
			keyword: r.keyword,
			mute_options: r.exclude_following ? ["exclude_following_accounts"] : [],
			mute_surfaces: r.surfaces,
			valid_until: r.valid_until ? r.valid_until.getTime() : null,
		})),
	};
}

export async function addKeyword(userId: string, f: KeywordForm): Promise<string | undefined> {
	const keyword = (f.keyword ?? "").trim();
	if (!keyword || [...keyword].length > 100) return "Muted words must be 1 to 100 characters.";
	const [count] = await sql`select count(*)::int as n from muted_keywords where user_id = ${userId}::bigint`;
	if (count.n >= 1000) return "You can mute up to 1000 words.";
	const surfaces = surfacesOf(f.mute_surfaces);
	await sql`insert into muted_keywords (id, user_id, keyword, surfaces, exclude_following, valid_until)
		values (${newId()}::bigint, ${userId}::bigint, ${keyword}, ${sql.array(surfaces.length ? surfaces : ["home_timeline", "tweet_replies", "notifications"], "TEXT")},
			${f.mute_options === "exclude_following_accounts"}, ${untilOf(f.duration)})
		on conflict (user_id, lower(keyword)) do nothing`;
}

export async function updateKeyword(userId: string, id: string, f: KeywordForm) {
	const surfaces = surfacesOf(f.mute_surfaces);
	// a missing duration keeps the current end
	const until = f.duration === undefined ? sql`valid_until` : sql`${untilOf(f.duration)}::timestamptz`;
	await sql`update muted_keywords set surfaces = ${sql.array(surfaces, "TEXT")}, exclude_following = ${f.mute_options === "exclude_following_accounts"},
		valid_until = ${until} where id = ${id}::bigint and user_id = ${userId}::bigint`;
}

export async function removeKeywords(userId: string, ids: string[]) {
	if (!ids.length) return;
	await sql`delete from muted_keywords where user_id = ${userId}::bigint and id = any(${sql.array(ids, "INT8")})`;
}
