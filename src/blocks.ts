// Blocks, muted accounts and muted words.
// A block works both ways: neither side sees the other's posts, and any follow
// between them ends. A mute only hides the account from the muter's home feeds
// and notifications. Muted words hide matching posts on the surfaces chosen.

import { sql } from "./db";
import { newId } from "./ids";

// accounts the viewer blocked or was blocked by
export const blockedFor = (viewerId: string) =>
	sql`(select blocked_id from blocks where blocker_id = ${viewerId}::bigint
		union all select blocker_id from blocks where blocked_id = ${viewerId}::bigint)`;

const gone = sql`(status = 'suspended' or deactivated_at is not null)`;
export const outOfView = (viewerId: string) =>
	sql`(select id from users where ${gone} or (status = 'limited' and id <> ${viewerId}::bigint
		and id not in (select followee_id from follows where follower_id = ${viewerId}::bigint)
		and not exists (select 1 from users staff where staff.id = ${viewerId}::bigint and staff.role is not null)))`;

// Protected accounts: their posts are for themselves and the accounts they let
// follow. Staff see everything.
export const protectedFor = (viewerId: string) =>
	sql`(select id from users where protected and id <> ${viewerId}::bigint
		and id not in (select followee_id from follows where follower_id = ${viewerId}::bigint)
		and not exists (select 1 from users staff where staff.id = ${viewerId}::bigint and staff.role is not null))`;

export const suspendedFor = (viewerId: string) =>
	sql`(select id from users where ${gone}
		and not exists (select 1 from users staff where staff.id = ${viewerId}::bigint and staff.role is not null))`;

export const mutedFor = (viewerId: string) => sql`(select muted_id from mutes where muter_id = ${viewerId}::bigint)`;

export type Surface = "home_timeline" | "notifications";

// true when the post `postId` (an SQL expression) holds a word the viewer muted on `surface`
export const hasMutedWord = (viewerId: string, surface: Surface, postId: ReturnType<typeof sql>) =>
	sql`exists (select 1 from muted_keywords k join posts mp on mp.id = ${postId}
		where k.user_id = ${viewerId}::bigint and ${surface} = any(k.surfaces) and (k.valid_until is null or k.valid_until > now())
			and position(lower(k.keyword) in lower(mp.text)) > 0
			and not (k.exclude_following and mp.user_id in (select followee_id from follows where follower_id = ${viewerId}::bigint)))`;

export async function setBlock(blockerId: string, blockedId: string, on: boolean) {
	if (blockerId === blockedId) return;
	if (!on) {
		await sql`delete from blocks where blocker_id = ${blockerId}::bigint and blocked_id = ${blockedId}::bigint`;
		return;
	}
	await sql.begin(async (tx) => {
		await tx`insert into blocks (blocker_id, blocked_id) values (${blockerId}::bigint, ${blockedId}::bigint) on conflict do nothing`;
		await tx`delete from follows where (follower_id = ${blockerId}::bigint and followee_id = ${blockedId}::bigint)
			or (follower_id = ${blockedId}::bigint and followee_id = ${blockerId}::bigint)`;
	});
}

export async function isBlockedEitherWay(a: string, b: string): Promise<boolean> {
	const rows = await sql`select 1 from blocks where (blocker_id = ${a}::bigint and blocked_id = ${b}::bigint)
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
