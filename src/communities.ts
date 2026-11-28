// Communities: groups with members, rules and their own timeline. The client
// has a redux path and a relay path for most screens; both read the same
// fields, with `communityResults` as the key a community comes back under.

import type { Viewer } from "./auth";
import { holdLock, sql } from "./db";
import { blockedFor } from "./blocks";
import { isId, newId } from "./ids";
import {
	INVITE_POLICIES,
	JOIN_POLICIES,
	type Role,
	atLeast,
	canModerate,
	communityGlobalId,
	communityObjects,
	communityRows,
} from "./community-model";
import { cursorEntry, feedEntry, tweetEntry, userEntry, userResult } from "./model";
import { forbiddenText } from "./names";
import { PostError, feed, postsByIds } from "./posts";
import { usersByIds } from "./users";

type Vars = Record<string, any>;

const MAX_NAME = 50;
const MAX_DESCRIPTION = 160;
const MAX_QUESTION = 140;
const MAX_RULES = 10;
const MAX_RULE_NAME = 60;
const MAX_RULE_DESCRIPTION = 200;
const MAX_CREATED = 10;

const richText = (text: string) => ({ text, rtl: false, alignment: "Center", entities: [] });
const unavailableText = (title: string, subtitle: string) => ({ title: richText(title), subtitle: richText(subtitle), message: title });

const missing = () => new PostError("Community not found.", 144);

function communityId(vars: Vars, key = "communityId"): string {
	const id = vars[key] ?? vars.id ?? vars.rest_id;
	if (!isId(id)) throw missing();
	return id;
}

async function roleOf(viewerId: string, id: string): Promise<{ role: Role; policy: string; invites: string }> {
	const row = (await communityRows(viewerId, [id])).get(id);
	if (!row) throw missing();
	return { role: row.role, policy: row.join_policy, invites: row.invites_policy };
}

async function mustBe(viewerId: string, id: string, min: Role): Promise<void> {
	const { role } = await roleOf(viewerId, id);
	if (!atLeast(role, min)) throw new PostError("You don't have permission to do that.", 150);
}

const reviewsRequests = (role: Role, policy: string) => (policy === "RestrictedJoinRequestsRequireAdminApproval" ? atLeast(role, "Admin") : canModerate(role));

async function one(viewerId: string, id: string) {
	const obj = (await communityObjects(viewerId, [id])).get(id);
	if (!obj) throw missing();
	return obj;
}

// A community's own page: `communityResults.result.<key>` holds the data.
const inCommunity = async (viewerId: string, id: string, extra: Record<string, unknown>) => {
	const base = (await communityObjects(viewerId, [id])).get(id);
	if (!base) return { data: { communityResults: { result: { __typename: "CommunityUnavailable", reason: "NotFound", ...unavailableText("This community doesn't exist.", "It may have been deleted.") } } } };
	return { data: { communityResults: { result: { ...base, ...extra } } } };
};

const timeline = (entries: unknown[], base: bigint, scribe = "community") => ({
	timeline: {
		instructions: [
			{
				type: "TimelineAddEntries",
				entries: [
					...entries,
					cursorEntry("Top", "t0", (base + 1n).toString()),
					cursorEntry("Bottom", "b0", (base - BigInt(entries.length) - 2n).toString()),
				],
			},
		],
		metadata: { scribeConfig: { page: scribe } },
	},
});

const sortIndex = (base: bigint, i: number) => (base - BigInt(i) - 1n).toString();

// posts of one community, paged like the home feed
async function postsTimeline(viewerId: string, id: string, vars: Vars, media = false) {
	const count = Math.min(Math.max(Number(vars.count) || 20, 1), 100);
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	const at = isId(cursor.slice(1)) ? cursor.slice(1) : undefined;
	const newer = cursor[0] === "t" && !!at;
	const items = await feed({
		viewerId,
		authors: { community: id },
		replies: false,
		kinds: "posts",
		...(media ? { media: "any" as const } : {}),
		limit: count,
		...(newer ? { after: at } : { before: at }),
	});
	const entries: unknown[] = items.map((i) => feedEntry(i, i.id));
	const newest = items[0]?.id ?? at ?? newId();
	const oldest = items[items.length - 1]?.id ?? at ?? newest;
	entries.unshift(cursorEntry("Top", `t${newest}`, (BigInt(newest) + 1n).toString()));
	if (!newer) entries.push(cursorEntry("Bottom", `b${oldest}`, (BigInt(oldest) - 1n).toString()));
	return { timeline: { instructions: [{ type: "TimelineAddEntries", entries }], metadata: { scribeConfig: { page: "community" } } } };
}

const communityEntry = (community: unknown, id: string, sort: string) => ({
	entryId: `community-${id}`,
	sortIndex: sort,
	content: {
		__typename: "TimelineTimelineItem",
		entryType: "TimelineTimelineItem",
		itemContent: { __typename: "TimelineCommunity", itemType: "TimelineCommunity", displayType: "Community", community_results: { result: community } },
	},
});

async function communityList(viewerId: string, ids: string[], vars: Vars) {
	const base = BigInt(newId());
	const objects = vars.cursor ? new Map() : await communityObjects(viewerId, ids);
	const entries = ids.flatMap((id, i) => (objects.has(id) ? [communityEntry(objects.get(id), id, sortIndex(base, i))] : []));
	return timeline(entries, base, "communities");
}

const memberIds = async (userId: string): Promise<string[]> =>
	(await sql`select m.community_id::text as id from community_members m where m.user_id = ${userId}::bigint order by m.created_at desc`).map((r: any) => r.id);

const discoverIds = async (viewerId: string, topicId?: string): Promise<string[]> =>
	(
		await sql`select c.id::text as id from communities c
			where not exists (select 1 from community_members m where m.community_id = c.id and m.user_id = ${viewerId}::bigint)
				and c.creator_id not in ${blockedFor(viewerId)}
				${topicId ? sql`and c.topic_id = ${topicId}::bigint` : sql``}
			order by (select count(*) from community_members m where m.community_id = c.id) desc, c.created_at desc limit 50`
	).map((r: any) => r.id);

// posts from every community the viewer is in
async function followedPosts(viewerId: string, vars: Vars) {
	const count = Math.min(Math.max(Number(vars.count) || 20, 1), 100);
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	const at = isId(cursor.slice(1)) ? cursor.slice(1) : undefined;
	const rows = await sql`select p.id::text from posts p
		where p.community_id in (select community_id from community_members where user_id = ${viewerId}::bigint)
			and p.user_id not in ${blockedFor(viewerId)} and not p.hidden and p.id < ${at ?? "9223372036854775807"}::bigint
		order by p.id desc limit ${count}`;
	const posts = await postsByIds(viewerId, rows.map((r: any) => r.id));
	const entries: unknown[] = rows.flatMap((r: any) => (posts.has(r.id) ? [tweetEntry(posts.get(r.id)!, r.id)] : []));
	const oldest = rows[rows.length - 1]?.id ?? at;
	if (rows.length) entries.push(cursorEntry("Bottom", `b${oldest}`, (BigInt(oldest) - 1n).toString()));
	return { timeline: { instructions: [{ type: "TimelineAddEntries", entries }], metadata: { scribeConfig: { page: "communities" } } } };
}

async function people(viewerId: string, id: string, moderators: boolean) {
	const rows = await sql`select m.user_id::text from community_members m where m.community_id = ${id}::bigint
		${moderators ? sql`and m.role in ('Moderator', 'Admin')` : sql``} and m.user_id not in ${blockedFor(viewerId)}
		order by (m.role = 'Admin') desc, (m.role = 'Moderator') desc, m.created_at limit 200`;
	const users = await usersByIds(viewerId, rows.map((r: any) => r.user_id));
	const items = rows.flatMap((r: any) => (users.has(r.user_id) ? [{ result: userResult(users.get(r.user_id)!) }] : []));
	return { items_results: items, slice_info: { next_cursor: null, previous_cursor: null } };
}

async function joinRequests(viewerId: string, id: string) {
	const rows = await sql`select r.user_id::text, r.answer, r.created_at from community_join_requests r where r.community_id = ${id}::bigint order by r.created_at`;
	const users = await usersByIds(viewerId, rows.map((r: any) => r.user_id));
	const items = rows.flatMap((r: any) =>
		users.has(r.user_id)
			? [
					{
						__typename: "CommunityJoinRequest",
						id: Buffer.from(`CommunityJoinRequest:${id}:${r.user_id}`).toString("base64"),
						answer: r.answer,
						created_at: new Date(r.created_at).getTime(),
						responded_at: null,
						state: "Pending",
						user_relationship: { __typename: "UserCommunityRelationship", user_results: { result: userResult(users.get(r.user_id)!) } },
						actions: {
							join_request_approve_action_result: { __typename: "CommunityJoinRequestApproveAction" },
							join_request_deny_action_result: { __typename: "CommunityJoinRequestDenyAction" },
						},
					},
				]
			: [],
	);
	return {
		__typename: "CommunityJoinRequests",
		id: Buffer.from(`CommunityJoinRequests:${id}`).toString("base64"),
		pending_join_request_count: items.length,
		pending_join_requests_slice: { items, slice_info: { next_cursor: null, previous_cursor: null } },
	};
}

function clean(value: unknown, max: number, label: string, required = false): string {
	const text = typeof value === "string" ? value.trim() : "";
	if (required && !text) throw new PostError(`${label} can't be empty.`, 214);
	if ([...text].length > max) throw new PostError(`${label} can be up to ${max} characters.`, 214);
	if (text && forbiddenText(text)) throw new PostError(`${label} contains a word this instance doesn't allow.`, 186);
	return text;
}

async function create(v: Viewer, vars: Vars) {
	const name = clean(vars.name, MAX_NAME, "The name", true);
	const description = clean(vars.description, MAX_DESCRIPTION, "The description");
	const question = clean(vars.question, MAX_QUESTION, "The question");
	const joinPolicy = JOIN_POLICIES.includes(vars.joinPolicy) ? vars.joinPolicy : "Open";
	const invitesPolicy = INVITE_POLICIES.includes(vars.invitesPolicy) ? vars.invitesPolicy : "MemberInvitesAllowed";
	if (v.status !== "active") throw new PostError("Your account can't create communities right now.", 326);
	const id = newId();
	await sql.begin(async (tx) => {
		await holdLock(tx, `communities-created:${v.id}`);
		const [owned] = await tx`select count(*)::int as n from communities where creator_id = ${v.id}::bigint`;
		if (owned.n >= MAX_CREATED) throw new PostError("You've created the most communities you can.", 214);
		const [taken] = await tx`select 1 from communities where lower(name) = lower(${name})`;
		if (taken) throw new PostError("A community with that name already exists.", 214);
		await tx`insert into communities (id, creator_id, name, description, question, join_policy, invites_policy)
			values (${id}::bigint, ${v.id}::bigint, ${name}, ${description}, ${question}, ${joinPolicy}, ${invitesPolicy})`;
		await tx`insert into community_members (community_id, user_id, role) values (${id}::bigint, ${v.id}::bigint, 'Admin')`;
	});
	return { data: { community_create_v2: await one(v.id, id) } };
}

async function join(v: Viewer, vars: Vars) {
	const id = communityId(vars);
	const { role, policy } = await roleOf(v.id, id);
	if (role === "NonMember") {
		if (policy !== "Open") throw new PostError("This community needs a request to join.", 150);
		await sql`insert into community_members (community_id, user_id, role) values (${id}::bigint, ${v.id}::bigint, 'Member') on conflict do nothing`;
		await sql`delete from community_join_requests where community_id = ${id}::bigint and user_id = ${v.id}::bigint`;
	}
	return { data: { community_join: await one(v.id, id) } };
}

async function requestToJoin(v: Viewer, vars: Vars) {
	const id = communityId(vars);
	const { role, policy } = await roleOf(v.id, id);
	if (role !== "NonMember" || policy === "Open" || policy === "RestrictedJoinRequestsDisabled") {
		return { data: { community_join_request_create: { __typename: "CommunityJoinRequestCreateError", reason: "NotAllowed", message: "You can't request to join this community." } } };
	}
	const answer = clean(vars.answer, MAX_QUESTION * 4, "The answer");
	await sql`insert into community_join_requests (community_id, user_id, answer) values (${id}::bigint, ${v.id}::bigint, ${answer}) on conflict do nothing`;
	return {
		data: {
			community_join_request_create: {
				__typename: "CommunityJoinRequest",
				user_relationship: { community_results: { result: await one(v.id, id) } },
			},
		},
	};
}

async function leave(v: Viewer, vars: Vars) {
	const id = communityId(vars);
	const { role } = await roleOf(v.id, id);
	if (role === "Admin") throw new PostError("Admins can't leave their community.", 150);
	await sql`delete from community_members where community_id = ${id}::bigint and user_id = ${v.id}::bigint`;
	return { data: { community_leave: await one(v.id, id) } };
}

async function respond(v: Viewer, vars: Vars, approve: boolean) {
	const id = communityId(vars);
	const { role, policy } = await roleOf(v.id, id);
	if (!reviewsRequests(role, policy)) throw new PostError("You don't have permission to do that.", 150);
	if (!isId(vars.userId)) throw new PostError("Invalid user id.", 144);
	const [request] = await sql`delete from community_join_requests where community_id = ${id}::bigint and user_id = ${vars.userId}::bigint returning answer, created_at`;
	if (request && approve) {
		await sql`insert into community_members (community_id, user_id, role) values (${id}::bigint, ${vars.userId}::bigint, 'Member') on conflict do nothing`;
	}
	const users = await usersByIds(v.id, [vars.userId]);
	const user = users.get(vars.userId);
	const result = {
		__typename: "CommunityJoinRequest",
		id: Buffer.from(`CommunityJoinRequest:${id}:${vars.userId}`).toString("base64"),
		answer: request?.answer ?? "",
		created_at: request ? new Date(request.created_at).getTime() : Date.now(),
		responded_at: Date.now(),
		state: approve ? "Approved" : "Denied",
		user_relationship: {
			__typename: "UserCommunityRelationship",
			user_results: user ? { result: userResult(user) } : undefined,
			community_results: { result: await one(v.id, id) },
		},
	};
	return { data: { [approve ? "community_join_request_approve" : "community_join_request_deny"]: result } };
}

async function setRole(v: Viewer, vars: Vars) {
	const id = communityId(vars);
	await mustBe(v.id, id, "Admin");
	if (!isId(vars.userId)) throw new PostError("Invalid user id.", 144);
	const role = vars.role === "Moderator" ? "Moderator" : vars.role === "Member" ? "Member" : null;
	if (!role) throw new PostError("Unknown role.", 214);
	const [target] = await sql`select role from community_members where community_id = ${id}::bigint and user_id = ${vars.userId}::bigint`;
	if (!target) throw new PostError("That account isn't a member.", 144);
	if (target.role === "Admin") throw new PostError("The admin's role can't change.", 150);
	await sql`update community_members set role = ${role} where community_id = ${id}::bigint and user_id = ${vars.userId}::bigint`;
	return { data: { community_role_put: await one(v.id, id) } };
}

async function removeMember(v: Viewer, id: string, userId: string) {
	await mustBe(v.id, id, "Moderator");
	const [target] = await sql`select role from community_members where community_id = ${id}::bigint and user_id = ${userId}::bigint`;
	if (!target || target.role === "Admin") return;
	await sql`delete from community_members where community_id = ${id}::bigint and user_id = ${userId}::bigint`;
}

async function field(v: Viewer, vars: Vars, column: "name" | "description" | "question", key: string, source: string, max: number) {
	const id = communityId(vars);
	await mustBe(v.id, id, "Admin");
	const text = clean(vars[source], max, `The ${column}`, column === "name");
	if (column === "name") {
		const [taken] = await sql`select 1 from communities where lower(name) = lower(${text}) and id <> ${id}::bigint`;
		if (taken) throw new PostError("A community with that name already exists.", 214);
	}
	await sql`update communities set ${sql(column)} = ${text} where id = ${id}::bigint`;
	const community = await one(v.id, id);
	return { data: { [key]: { ...community, [column]: text } } };
}

async function rules(v: Viewer, vars: Vars, op: "create" | "update" | "remove" | "reorder") {
	const id = communityId(vars);
	await mustBe(v.id, id, "Moderator");
	if (op === "create") {
		const name = clean(vars.name, MAX_RULE_NAME, "The rule name", true);
		const description = clean(vars.description, MAX_RULE_DESCRIPTION, "The rule description");
		await sql.begin(async (tx) => {
			await holdLock(tx, `community-rules:${id}`);
			const [n] = await tx`select count(*)::int as n, coalesce(max(position), 0) + 1 as next from community_rules where community_id = ${id}::bigint`;
			if (n.n >= MAX_RULES) throw new PostError(`A community can have up to ${MAX_RULES} rules.`, 214);
			await tx`insert into community_rules (id, community_id, name, description, position) values (${newId()}::bigint, ${id}::bigint, ${name}, ${description}, ${n.next})`;
		});
	} else if (op === "update") {
		if (!isId(vars.ruleId)) throw missing();
		const name = clean(vars.name, MAX_RULE_NAME, "The rule name", true);
		const description = clean(vars.description, MAX_RULE_DESCRIPTION, "The rule description");
		await sql`update community_rules set name = ${name}, description = ${description} where id = ${vars.ruleId}::bigint and community_id = ${id}::bigint`;
	} else if (op === "remove") {
		if (!isId(vars.ruleId)) throw missing();
		await sql`delete from community_rules where id = ${vars.ruleId}::bigint and community_id = ${id}::bigint`;
	} else {
		const ids: string[] = Array.isArray(vars.ruleIds) ? [...new Set<string>(vars.ruleIds.filter(isId))] : [];
		if (ids.length > MAX_RULES) throw new PostError(`A community can have up to ${MAX_RULES} rules.`, 214);
		if (ids.length) await sql`update community_rules r set position = t.ord - 1 from unnest(${sql.array(ids, "INT8")}::bigint[]) with ordinality t(id, ord)
			where r.id = t.id and r.community_id = ${id}::bigint`;
	}
	return { data: { [`community_rule_${op === "reorder" ? "rules_reorder" : op}`]: await one(v.id, id) } };
}

async function membershipSettings(v: Viewer, vars: Vars) {
	const id = communityId(vars);
	await mustBe(v.id, id, "Admin");
	const joinPolicy = JOIN_POLICIES.includes(vars.joinPolicy) ? vars.joinPolicy : null;
	const invitesPolicy = INVITE_POLICIES.includes(vars.invitesPolicy) ? vars.invitesPolicy : null;
	if (joinPolicy) await sql`update communities set join_policy = ${joinPolicy} where id = ${id}::bigint`;
	if (invitesPolicy) await sql`update communities set invites_policy = ${invitesPolicy} where id = ${id}::bigint`;
	const community = await one(v.id, id);
	return { data: { community_membership_settings_put: { ...community, communityId: id, join_requests_result: await joinRequests(v.id, id) } } };
}

async function remove(v: Viewer, vars: Vars) {
	const id = communityId(vars);
	await mustBe(v.id, id, "Admin");
	await sql`delete from communities where id = ${id}::bigint`;
	return { data: { community_delete: { __typename: "CommunityDeleteSuccess", community_results: { id: communityGlobalId(id), result: { __typename: "Community", id: communityGlobalId(id) } } } } };
}

const fetchOne = async (v: Viewer, vars: Vars) => {
	const id = communityId(vars);
	const base = await inCommunity(v.id, id, {});
	const result = (base.data.communityResults as any).result;
	const obj = result.__typename === "Community" ? { ...result, is_member: result.role !== "NonMember" } : result;
	return { data: { communityResults: { result: obj }, community_results_by_rest_id: { result: obj }, community_by_rest_id: obj } };
};

// the moderator Tools screen also reads the pending request count and a spotlight action
const toolsQuery = async (v: Viewer, vars: Vars) => {
	const r = await fetchOne(v, vars);
	const id = communityId(vars);
	const obj = (r.data.community_results_by_rest_id as any).result;
	if (obj?.__typename !== "Community") return r;
	const { role, policy } = await roleOf(v.id, id);
	obj.actions = { ...obj.actions, community_spotlight_setup_action_result: { __typename: "CommunitySpotlightSetupActionUnavailable", reason: "NotSupported", message: "Spotlight isn't available here." } };
	obj.join_requests_result = reviewsRequests(role, policy) ? await joinRequests(v.id, id) : { __typename: "CommunityJoinRequestsUnavailable" };
	return r;
};
export const communityHandlers = {
	CreateCommunity: create,
	JoinCommunity: join,
	LeaveCommunity: leave,
	RequestToJoinCommunity: requestToJoin,

	CommunityByRestId: fetchOne,
	CommunitiesFetchOneQuery: fetchOne,
	CommunityQuery: fetchOne,
	CommunityInviteButtonQuery: fetchOne,
	CommunityToolsScreenContainerQuery: toolsQuery,
	EditMembershipTypeQuery: fetchOne,
	PeopleCommunity_Query: fetchOne,

	CommunityTweetsTimeline: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		const tl = await postsTimeline(v.id, id, vars);
		return inCommunity(v.id, id, { community_timeline: tl, ranked_community_timeline: tl });
	},
	CommunityTweetsRankedTimeline: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		const tl = await postsTimeline(v.id, id, vars);
		return inCommunity(v.id, id, { community_timeline: tl, ranked_community_timeline: tl });
	},
	CommunityMediaTimeline: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		return inCommunity(v.id, id, { community_media_timeline: await postsTimeline(v.id, id, vars, true) });
	},
	CommunityAboutTimeline: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		return inCommunity(v.id, id, { about_timeline: timeline([], BigInt(newId())) });
	},
	CommunityHashtagsTimeline: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		return inCommunity(v.id, id, { community_filtered_timeline: timeline([], BigInt(newId())) });
	},
	membersSliceTimeline_Query: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		return inCommunity(v.id, id, { members_slice: await people(v.id, id, false) });
	},
	moderatorsSliceTimeline_Query: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		return inCommunity(v.id, id, { moderators_slice: await people(v.id, id, true) });
	},
	MemberRequests_Query: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		const { role, policy } = await roleOf(v.id, id);
		return inCommunity(v.id, id, { join_requests_result: reviewsRequests(role, policy) ? await joinRequests(v.id, id) : { __typename: "CommunityJoinRequestsUnavailable" } });
	},
	actions_approveMemberRequest_Mutation: (v: Viewer, vars: Vars) => respond(v, vars, true),
	actions_denyMemberRequest_Mutation: (v: Viewer, vars: Vars) => respond(v, vars, false),
	communityPeopleActionMenu_roleUpdate_Mutation: setRole,
	CommunityUpdateRole: setRole,
	edit_membershipSettings_Mutation: membershipSettings,
	DeleteCommunityMutation: (v: Viewer, vars: Vars) => remove(v, { communityId: vars.id ?? vars.communityId }),

	CommunityEditName: (v: Viewer, vars: Vars) => field(v, vars, "name", "community_name_put", "name", MAX_NAME),
	CommunityEditPurpose: (v: Viewer, vars: Vars) => field(v, vars, "description", "community_description_put", "description", MAX_DESCRIPTION),
	CommunityEditQuestion: (v: Viewer, vars: Vars) => field(v, vars, "question", "community_question_put", "question", MAX_QUESTION),
	CommunityCreateRule: (v: Viewer, vars: Vars) => rules(v, vars, "create"),
	CommunityEditRule: (v: Viewer, vars: Vars) => rules(v, vars, "update"),
	CommunityRemoveRule: (v: Viewer, vars: Vars) => rules(v, vars, "remove"),
	CommunityReorderRules: (v: Viewer, vars: Vars) => rules(v, vars, "reorder"),
	// the banner is a photo the admin uploaded first (media_id)
	CommunityEditBannerMedia: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		await mustBe(v.id, id, "Admin");
		const mediaId = String(vars.mediaId ?? "");
		const [media] = isId(mediaId) ? await sql`select id::text, width, height from media where id = ${mediaId}::bigint and user_id = ${v.id}::bigint and kind = 'photo'` : [];
		if (!media) throw new PostError("Upload the picture first.", 324);
		await sql`update communities set banner_url = ${`/media/${media.id}`}, banner_width = ${media.width}, banner_height = ${media.height} where id = ${id}::bigint`;
		return { data: { community_custom_banner_media_put: await one(v.id, id) } };
	},
	CommunityRemoveBannerMedia: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		await mustBe(v.id, id, "Admin");
		await sql`update communities set banner_url = null, banner_width = null, banner_height = null where id = ${id}::bigint`;
		return { data: { community_custom_banner_media_delete: await one(v.id, id) } };
	},
	// a community's topic is one of the instance's (topics.ts); no topic clears it
	EditTopicMutation: async (v: Viewer, vars: Vars) => {
		const id = communityId(vars);
		await mustBe(v.id, id, "Admin");
		const topicId = vars.topicId == null || vars.topicId === "" ? null : String(vars.topicId);
		if (topicId !== null && (!isId(topicId) || !(await sql`select 1 from topics where id = ${topicId}::bigint`).length)) throw new PostError("No such topic.", 144);
		await sql`update communities set topic_id = ${topicId} where id = ${id}::bigint`;
		return { data: { community_topic_put: await one(v.id, id) } };
	},
	CommunityUserInvite: async () => ({
		data: { user_community_invite: { __typename: "UserCommunityInviteActionUnavailable", reason: "NotSupported", message: "Invites aren't available here." } },
	}),

	// the main Communities pages
	CommunitiesMainPageTimeline: async (v: Viewer, vars: Vars) => ({ data: { viewer: { communities_timeline: await followedPosts(v.id, vars) } } }),
	CommunitiesRankedTimeline: async (v: Viewer, vars: Vars) => ({ data: { viewer: { ranked_communities_timeline: await followedPosts(v.id, vars) } } }),
	CommunitiesExploreTimeline: async (v: Viewer, vars: Vars) => ({
		data: { viewer: { explore_communities_timeline: await communityList(v.id, await discoverIds(v.id, isId(vars.topicId) ? vars.topicId : undefined), vars) } },
	}),
	CommunityDiscoveryTimeline: async (v: Viewer, vars: Vars) => ({
		data: { viewer: { community_discovery_timeline: await communityList(v.id, await discoverIds(v.id), vars) } },
	}),
	CommunitiesMainDiscoveryModule: async (v: Viewer, vars: Vars) => ({
		data: { communities_viewer: { community_discovery_module: await communityList(v.id, (await discoverIds(v.id)).slice(0, 5), vars) } },
	}),
	CommunitiesMembershipsTimeline: async (v: Viewer, vars: Vars) => {
		const userId = isId(vars.userId) ? vars.userId : v.id;
		return { data: { user: { result: { __typename: "User", timeline: await communityList(v.id, await memberIds(userId), vars) } } } };
	},
	CommunitiesMembershipsSlice: memberships,
	CommunitiesMembershipsRecentQuery: memberships,
	CommunitiesListActivityQuery: memberships,
	CarouselQuery: memberships,
	TopicCarouselQuery: topics,
	EditTopicQuery: topics,
	CommunitiesCreateButtonQuery: async () => ({
		data: { viewer: { create_community_action_result: { __typename: "CommunityCreateAction" } }, viewer_v2: { create_community_action_result: { __typename: "CommunityCreateAction" } } },
	}),
};

// The topic pickers and Explore's topic carousel: the instance's topics
// (Admin > Topics), with no subtopics. The carousel shows only topics some
// community has.
async function topics() {
	const rows = await sql`select t.id::text as topic_id, t.name as topic_name,
		exists (select 1 from communities c where c.topic_id = t.id) as used from topics t order by t.name`;
	const all = { community_topics: rows.map((r: any) => ({ __typename: "CommunityTopic", topic_id: r.topic_id, topic_name: r.topic_name, subtopics: [] })) };
	const used = { community_topics: all.community_topics.filter((_, i) => rows[i].used) };
	return { data: { communityTopicResults: all, fetch_user_community_topics: used, fetch_community_topics: all } };
}

async function memberships(v: Viewer) {
	const ids = await memberIds(v.id);
	const objects = await communityObjects(v.id, ids);
	const slice = {
		items_results: ids.flatMap((id) => (objects.has(id) ? [{ result: objects.get(id) }] : [])),
		slice_info: { next_cursor: null, previous_cursor: null },
	};
	const user = { __typename: "User", community_memberships_slice: slice };
	return { data: { viewer: { user_results: { result: user } }, viewer_v2: { user_results: { result: user } } } };
}
