import type { User } from "./auth";
import { blockedFor, federatedHiddenFor, GUEST_ID, hiddenFromGuests, isBlockedEitherWay, mutedFor, outOfView, protectedFor } from "./blocks";
import { staffViewer } from "./staff-access";
import { sql } from "./db";
import { PUBLIC_ORIGIN } from "./config";
import { INSTANCE_ID } from "./federation";

// a business account (isOrganization in model.ts), in SQL for the account `u` names
export const isOrganizationSql = (u: unknown) =>
	sql`(coalesce(${u}.verified_type in ('business', 'government'), false) or exists (select 1 from affiliations x where x.org_id = ${u}.id))`;

// where a custom badge's image is served
export const badgeUrl = (id: string) => `${PUBLIC_ORIGIN}/public/badge-${id}.png`;

// an account's custom badges in order, as a json list of { id, name }
export const badgesOf = (userId: unknown) => sql`(select json_agg(json_build_object('id', b.id::text, 'name', b.name) order by ub.position, b.name)
	from user_badges ub join custom_badges b on b.id = ub.badge_id where ub.user_id = ${userId})`;

// one of the account's counters (user_stats, kept by triggers in schema.sql)
const stat = (name: string) => sql`coalesce((select s.${sql(name)} from user_stats s where s.user_id = u.id), 0)`;

// Author columns shared by every query that returns a user; expects the users
// table aliased as `u`. Counters and the viewer's relation come along so the
// same account never reaches the client in two different states.
export const userCols = (viewerId: string) => sql`
	u.id as a_id, u.screen_name as a_screen_name, u.name as a_name, u.bio as a_bio, u.location as a_location,
	u.website as a_website, u.avatar_url as a_avatar_url, u.banner_url as a_banner_url, u.pinned_post_id as a_pinned_post_id, ${viewerId === GUEST_ID ? sql`(u.protected or ${hiddenFromGuests(sql`u`)})` : sql`u.protected`} as a_protected, u.verified_type as a_verified_type, u.verified_at as a_verified_at, u.translator as a_translator, u.flag as a_flag, u.pronouns as a_pronouns, u.status as a_status, u.instance as a_instance, u.created_at as a_created_at,
	${badgesOf(sql`u.id`)} as a_badges, u.remote_badges as a_remote_badges,
	greatest((u.remote_counts->>'posts')::int, ${stat("posts")}) as a_posts,
	(select json_build_object('id', o.id::text, 'name', o.name, 'screen_name', o.screen_name, 'avatar_url', case when o.org_badge_id is not null then '/public/badge-' || o.org_badge_id::text || '.png' else coalesce(o.remote_org_badge, o.avatar_url) end, 'since', af.created_at)
		from affiliations af join users o on o.id = af.org_id where af.user_id = u.id order by af.created_at, af.org_id limit 1) as a_org,
	(select json_agg(json_build_object('id', o.id::text, 'name', o.name, 'screen_name', o.screen_name, 'avatar_url', case when o.org_badge_id is not null then '/public/badge-' || o.org_badge_id::text || '.png' else coalesce(o.remote_org_badge, o.avatar_url) end) order by af.created_at, af.org_id)
		from (select * from affiliations x where x.user_id = u.id order by x.created_at, x.org_id offset 1) af join users o on o.id = af.org_id) as a_more_orgs,
	(select count(*)::int from affiliations af where af.org_id = u.id) as a_affiliates,
	(select m.screen_name from users m where m.id = u.automated_by) as a_automated_by, u.parody_label as a_parody_label,
	(select json_build_object('text', l.text, 'badge_id', l.badge_id::text, 'url', l.url) from account_labels l where l.id = u.label_id) as a_label,
	${stat("media_posts")} as a_media_posts,
	greatest((u.remote_counts->>'likes')::int, ${stat("likes")}) as a_likes,
	${stat("highlights")} as a_highlights,
	${stat("articles")} as a_articles,
	coalesce((u.count_overrides->>'followers')::int, greatest((u.remote_counts->>'followers')::int, ${stat("followers")})) as a_followers,
	coalesce((u.count_overrides->>'following')::int, greatest((u.remote_counts->>'following')::int, ${stat("following")})) as a_following,
	exists (select 1 from follows x where x.follower_id = ${viewerId}::bigint and x.followee_id = u.id) as a_followed_by_viewer,
	exists (select 1 from follows x where x.follower_id = u.id and x.followee_id = ${viewerId}::bigint) as a_follows_viewer,
	exists (select 1 from follow_requests x where x.requester_id = ${viewerId}::bigint and x.target_id = u.id) as a_requested,
	exists (select 1 from blocks x where x.blocker_id = ${viewerId}::bigint and x.blocked_id = u.id) as a_blocking,
	exists (select 1 from blocks x where x.blocker_id = u.id and x.blocked_id = ${viewerId}::bigint) as a_blocked_by,
	exists (select 1 from mutes x where x.muter_id = ${viewerId}::bigint and x.muted_id = u.id) as a_muting,
	exists (select 1 from post_notifications x where x.user_id = ${viewerId}::bigint and x.target_id = u.id) as a_notifying,
	exists (select 1 from repost_mutes x where x.user_id = ${viewerId}::bigint and x.target_id = u.id) as a_reposts_muted,
	(u.id = ${viewerId}::bigint or case coalesce(u.preferences->>'allow_media_tagging', 'all')
		when 'none' then false
		when 'following' then exists (select 1 from follows x where x.follower_id = u.id and x.followee_id = ${viewerId}::bigint)
		else true end) as a_media_taggable`;

export function toUser(r: any): User {
	return {
		id: r.a_id,
		screen_name: r.a_screen_name,
		name: r.a_name,
		bio: r.a_bio,
		location: r.a_location,
		website: r.a_website,
		avatar_url: r.a_avatar_url,
		banner_url: r.a_banner_url,
		pinned_post_id: r.a_pinned_post_id,
		protected: !!r.a_protected,
		verified_type: r.a_verified_type,
		verified_at: r.a_verified_at ?? null,
		translator: r.a_translator ?? null,
		flag: r.a_flag,
		pronouns: r.a_pronouns ?? null,
		badges: r.a_badges ?? [],
		remote_badges: r.a_remote_badges ?? [],
		status: r.a_status,
		org: r.a_org ?? null,
		more_orgs: r.a_more_orgs ?? [],
		affiliates: r.a_affiliates,
		automated_by: r.a_automated_by ?? null,
		parody_label: r.a_parody_label ?? "None",
		label: r.a_label ?? null,
		instance: r.a_instance ?? null,
		created_at: r.a_created_at,
		stats: {
			posts: r.a_posts,
			mediaPosts: r.a_media_posts,
			likes: r.a_likes,
			articles: r.a_articles,
			highlights: r.a_highlights,
			followers: r.a_followers,
			following: r.a_following,
			followedByViewer: r.a_followed_by_viewer,
			followsViewer: r.a_follows_viewer,
			requestedByViewer: !!r.a_requested,
			blocking: r.a_blocking,
			blockedBy: r.a_blocked_by,
			muting: r.a_muting,
			notifying: !!r.a_notifying,
			repostsMuted: !!r.a_reposts_muted,
			mediaTaggable: r.a_media_taggable !== false,
		},
	};
}

export const localName = (name: string) => (name.toLowerCase().endsWith(`@${INSTANCE_ID}`) ? name.slice(0, -INSTANCE_ID.length - 1) : name);

export async function userByName(viewerId: string, screenName: string): Promise<User | undefined> {
	const rows = await sql`select ${userCols(viewerId)} from users u where lower(u.screen_name) = lower(${localName(screenName)}) and not u.instance_blocked`;
	return rows[0] && toUser(rows[0]);
}

export async function userById(viewerId: string, id: string): Promise<User | undefined> {
	const rows = await sql`select ${userCols(viewerId)} from users u where u.id = ${id}::bigint and not u.instance_blocked`;
	return rows[0] && toUser(rows[0]);
}

// Following a protected account asks instead; unfollowing also withdraws a request.
export async function setFollow(followerId: string, followeeId: string, on: boolean) {
	if (followerId === followeeId) return;
	if (on && (await isBlockedEitherWay(followerId, followeeId))) return;
	if (on) {
		const [target] = await sql`select protected from users where id = ${followeeId}::bigint`;
		if (target?.protected) {
			await sql`insert into follow_requests (requester_id, target_id) values (${followerId}::bigint, ${followeeId}::bigint) on conflict do nothing`;
			return;
		}
		await sql`insert into follows (follower_id, followee_id) values (${followerId}::bigint, ${followeeId}::bigint) on conflict do nothing`;
	} else {
		const gone = await sql`delete from follows where follower_id = ${followerId}::bigint and followee_id = ${followeeId}::bigint returning 1`;
		// for the account's analytics
		if (gone.length) await sql`insert into unfollows (follower_id, followee_id) values (${followerId}::bigint, ${followeeId}::bigint)`;
		await sql`delete from follow_requests where requester_id = ${followerId}::bigint and target_id = ${followeeId}::bigint`;
	}
}

export async function pendingRequests(userId: string): Promise<string[]> {
	const rows = await sql`select requester_id::text as id from follow_requests where target_id = ${userId}::bigint order by created_at desc limit 500`;
	return rows.map((r: any) => r.id);
}

// the owner decides; a blocked account's request is dropped on approval
export async function answerRequest(ownerId: string, requesterId: string, approve: boolean): Promise<boolean> {
	const rows = await sql`delete from follow_requests where requester_id = ${requesterId}::bigint and target_id = ${ownerId}::bigint returning requester_id`;
	if (!rows.length) return false;
	if (approve && !(await isBlockedEitherWay(ownerId, requesterId)))
		await sql`insert into follows (follower_id, followee_id) values (${requesterId}::bigint, ${ownerId}::bigint) on conflict do nothing`;
	return true;
}

// Going public approves everyone who asked.
export async function setProtected(userId: string, on: boolean): Promise<void> {
	await sql`update users set protected = ${on} where id = ${userId}::bigint`;
	if (!on) {
		await sql`insert into follows (follower_id, followee_id)
			select r.requester_id, r.target_id from follow_requests r where r.target_id = ${userId}::bigint
				and not exists (select 1 from blocks b where (b.blocker_id = r.requester_id and b.blocked_id = r.target_id) or (b.blocker_id = r.target_id and b.blocked_id = r.requester_id))
			on conflict do nothing`;
		await sql`delete from follow_requests where target_id = ${userId}::bigint`;
	}
}

// accounts `userId` follows, or accounts following `userId`
// verified_followers: followers with any check, for the Verified Followers tab
// "Followers you know": the account's followers that the viewer follows too
const knownFollowers = (viewerId: string, userId: string) => sql`from follows f join users u on u.id = f.follower_id
	where f.followee_id = ${userId}::bigint and u.id <> ${viewerId}::bigint and u.id not in ${outOfView(viewerId)}
	and exists (select 1 from follows k where k.follower_id = ${viewerId}::bigint and k.followee_id = u.id)`;

export async function knownFollowerCount(viewerId: string, userId: string): Promise<number> {
	const [r] = await sql`select count(*)::int as n ${knownFollowers(viewerId, userId)}`;
	return r?.n ?? 0;
}

export async function followList(viewerId: string, userId: string, kind: "following" | "followers" | "verified_followers" | "known_followers", limit = 200, offset = 0): Promise<User[]> {
	// a protected account's lists are for itself and its followers
	if (userId !== viewerId) {
		const [hidden] = await sql`select 1 from users u where u.id = ${userId}::bigint and not ${staffViewer(viewerId)} and (
			(u.protected and not exists (select 1 from follows f where f.follower_id = ${viewerId}::bigint and f.followee_id = u.id))
			or exists (select 1 from blocks b where b.blocker_id = u.id and b.blocked_id = ${viewerId}::bigint))`;
		if (hidden) return [];
	}
	const rows =
		kind === "known_followers"
			? await sql`select ${userCols(viewerId)} ${knownFollowers(viewerId, userId)} order by f.created_at desc, f.follower_id desc limit ${limit} offset ${offset}`
			: kind === "following"
			? await sql`select ${userCols(viewerId)} from follows f join users u on u.id = f.followee_id
				where f.follower_id = ${userId}::bigint and u.id not in ${outOfView(viewerId)} order by f.created_at desc, f.followee_id desc limit ${limit} offset ${offset}`
			: await sql`select ${userCols(viewerId)} from follows f join users u on u.id = f.follower_id
				where f.followee_id = ${userId}::bigint and u.id not in ${outOfView(viewerId)}
				${kind === "verified_followers" ? sql`and u.verified_type is not null` : sql``} order by f.created_at desc, f.follower_id desc limit ${limit} offset ${offset}`;
	return rows.map(toUser);
}

export async function usersByIds(viewerId: string, ids: string[]): Promise<Map<string, User>> {
	if (!ids.length) return new Map();
	const rows = await sql`select ${userCols(viewerId)} from users u where u.id = any(${sql.array(ids, "INT8")})`;
	return new Map(rows.map((r: any) => [r.a_id as string, toUser(r)]));
}

// an organisation's affiliates, newest first
export async function affiliatesOf(viewerId: string, orgId: string, limit = 200): Promise<User[]> {
	const rows = await sql`select ${userCols(viewerId)} from affiliations af join users u on u.id = af.user_id
		where af.org_id = ${orgId}::bigint and u.status <> 'suspended' order by af.created_at desc limit ${limit}`;
	return rows.map(toUser);
}

// Accounts to follow: not followed, not blocked either way, not muted, not out of
// view. Ranked by how many of the accounts the viewer follows follow them, then size.
// `similarTo`: accounts like that one first, by how many of its followers also
// follow them; contacts the viewer uploaded who let themselves be found by email
// come before both.
export async function suggestedUsers(viewerId: string, limit = 20, exclude: string[] = [], similarTo?: string): Promise<User[]> {
	const rows = await sql`select ${userCols(viewerId)} from users u
		where u.id <> ${viewerId}::bigint and u.status = 'active'
			and u.id not in (select followee_id from follows where follower_id = ${viewerId}::bigint)
			and u.id not in ${blockedFor(viewerId)} and u.id not in ${mutedFor(viewerId)} and u.id not in ${outOfView(viewerId)}
			and not u.shadow_banned and u.id not in ${federatedHiddenFor(viewerId)}
			${exclude.length ? sql`and u.id <> all(${sql.array(exclude, "INT8")})` : sql``}
			${similarTo ? sql`and u.id <> ${similarTo}::bigint` : sql``}
		order by exists (select 1 from contacts c where c.user_id = ${viewerId}::bigint and lower(u.email) = any(c.emails)
				and u.preferences->>'discoverable_by_email' = 'true') desc,
			${similarTo ? sql`(select count(*) from follows m where m.followee_id = u.id and m.follower_id <> ${viewerId}::bigint
				and m.follower_id in (select follower_id from follows where followee_id = ${similarTo}::bigint)) desc,` : sql``}
			(select count(*) from follows m where m.followee_id = u.id
				and m.follower_id in (select followee_id from follows where follower_id = ${viewerId}::bigint)) desc,
			(select count(*) from follows x where x.followee_id = u.id) desc, u.created_at desc
		limit ${limit}`;
	return rows.map(toUser);
}

// The profile bell (device) and "Turn off reposts" (retweets), both set
// through friendships/update.
export async function updateFriendship(viewerId: string, targetId: string, change: { device?: boolean; retweets?: boolean }): Promise<boolean> {
	if (targetId === viewerId || (await isBlockedEitherWay(viewerId, targetId))) return false;
	if (change.device === true && (await sql`select 1 where ${targetId}::bigint in ${protectedFor(viewerId)}`).length) return false;
	if (change.device === true) await sql`insert into post_notifications (user_id, target_id) values (${viewerId}::bigint, ${targetId}::bigint) on conflict do nothing`;
	if (change.device === false) await sql`delete from post_notifications where user_id = ${viewerId}::bigint and target_id = ${targetId}::bigint`;
	if (change.retweets === false) await sql`insert into repost_mutes (user_id, target_id) values (${viewerId}::bigint, ${targetId}::bigint) on conflict do nothing`;
	if (change.retweets === true) await sql`delete from repost_mutes where user_id = ${viewerId}::bigint and target_id = ${targetId}::bigint`;
	return true;
}
