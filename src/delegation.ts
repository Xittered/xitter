// X's Delegate (Settings > Delegate): an account shares itself with members,
// Admins or Contributors, who switch to it from their own account menu. While
// switched, the client sends every API call with x-act-as-user-id, and
// actingViewer() turns the member's session into the shared account's viewer.
//
// Each account has one group, so a group's rest_id is its owner's id. The
// client's Relay screens ask from both sides: as a member (groups shared with
// me, invites to accept) and as the owner (my members), the latter while
// switched in as an Admin too.

import { type Viewer, viewerById } from "./auth";
import { isBlockedEitherWay } from "./blocks";
import { sql } from "./db";
import { newId } from "./ids";
import { userResult } from "./model";
import { PostError } from "./posts";
import { toUser, userCols } from "./users";

type Vars = Record<string, any>;
type Role = "Admin" | "Contributor";

// the client lets non-subscribers add 5 (twitter_delegate_normal_limit) and
// subscribers 25; nothing is paid for here, so the larger one
const MAX_MEMBERS = 25;
const ROLES = new Set<Role>(["Admin", "Contributor"]);
export const INVITE_SETTINGS = new Set(["Nobody", "Everyone", "OnlyFollowing"]);

const globalId = (kind: string, id: string) => Buffer.from(`${kind}:${id}`).toString("base64");

// the account behind a request: the member's own while they act as another
const self = (v: Viewer) => v.actor?.id ?? v.id;

// Who may act as `ownerId` from `memberId`'s session, and in which role.
async function membership(ownerId: string, memberId: string): Promise<Role | undefined> {
	const [m] = await sql`select d.role from delegation_members d join users o on o.id = d.owner_id
		where d.owner_id = ${ownerId}::bigint and d.member_id = ${memberId}::bigint and d.status = 'Accepted' and o.status <> 'suspended'`;
	return m?.role;
}

// The viewer for a call sent with x-act-as-user-id: the shared account, still
// signed in through the member's session (csrf, token), never with staff powers.
export async function actingViewer(member: Viewer, ownerId: string): Promise<Viewer | undefined> {
	if (!/^\d{1,19}$/.test(ownerId)) return undefined;
	const role = await membership(ownerId, member.id);
	if (!role) return undefined;
	const owner = await viewerById(ownerId);
	if (!owner) return undefined;
	return { ...owner, role: null, csrf: member.csrf, token: member.token, postSource: member.postSource, actor: { id: member.id, screen_name: member.screen_name, role } };
}

// What a member can't do as the shared account: anything about its sign-in,
// settings or delegation, and its messages (end-to-end keys are the owner's).
const DELEGATE_DENIED_OPS = /XChat|DirectMessage|DmInbox|SendMessage|ConversationEvent|Preference|_settings_|Settings?Mutation|Password|Email|Phone|TwoFactor|Session|Deactivat|ScreenName|UserAccountLabel|AccountParody|Delegat/;
const DELEGATE_DENIED_REST = /^\/(1\.1|2)\/(dm|direct_messages)\/|^\/1\.1\/account\/(?!settings\.json$|verify_credentials)|^\/1\.1\/strato\/column\/.*\/clients\//;
// Post analytics are for Admins (as the client's role screen says).
const ANALYTICS_OPS = /^(accountOverviewDailyQuery|accountOverviewHourlyQuery|activeFollowersTileQuery|useFetchAnalyticsQuery|contentPageQuery|postDetailsProviderQuery)$/;
export function delegateMay(role: Role, method: string, path: string, operation: string | undefined): boolean {
	if (operation && role !== "Admin" && ANALYTICS_OPS.test(operation)) return false;
	if (operation) return method === "GET" ? !/XChat|DirectMessage|DmInbox/.test(operation) : !DELEGATE_DENIED_OPS.test(operation);
	if (DELEGATE_DENIED_REST.test(path)) return method === "GET" && !/\/(dm|direct_messages)\//.test(path);
	// reading settings is fine; changing them isn't
	if (path === "/1.1/account/settings.json") return method === "GET";
	return true;
}

// ---- shapes

// The Relay screens read the label as identity_profile_labels_highlighted_label
// but alias its fields to the names affiliates_highlighted_label already uses.
function userShape(u: ReturnType<typeof toUser>) {
	const r: any = userResult(u);
	r.identity_profile_labels_highlighted_label = r.affiliates_highlighted_label;
	return r;
}

const userResults = (u: ReturnType<typeof toUser>) => ({ id: globalId("UserResults", u.id), result: userShape(u) });

async function usersById(viewerId: string, ids: string[]) {
	if (!ids.length) return new Map<string, ReturnType<typeof toUser>>();
	const rows = await sql`select ${userCols(viewerId)} from users u where u.id = any(${sql.array(ids, "BIGINT")})`;
	return new Map(rows.map((r: any) => [String(r.a_id), toUser(r)]));
}

type Row = { id: string; owner_id: string; member_id: string; role: Role; status: "Pending" | "Accepted" };

// groups (one per owner) with their members, as the client's DelegationGroup
async function groupShapes(viewerId: string, ownerIds: string[], myRole?: Map<string, Role>) {
	if (!ownerIds.length) return [];
	const rows = (await sql`select id::text, owner_id::text, member_id::text, role, status from delegation_members
		where owner_id = any(${sql.array(ownerIds, "BIGINT")}) order by created_at`) as Row[];
	const users = await usersById(viewerId, [...new Set([...ownerIds, ...rows.map((r) => r.member_id)])]);
	return ownerIds
		.filter((o) => users.has(o))
		.map((o) => ({
			id: globalId("DelegationGroup", o),
			rest_id: o,
			...(myRole?.get(o) ? { role: myRole.get(o) } : {}),
			handle_results: userResults(users.get(o)!),
			// the account menu's queries alias handle_results to this
			handle: userResults(users.get(o)!),
			members: rows
				.filter((r) => r.owner_id === o && users.has(r.member_id))
				.map((r) => ({
					id: globalId("DelegationMembership", r.id),
					rest_id: r.id,
					role: r.role,
					status: r.status,
					user_results: userResults(users.get(r.member_id)!),
				})),
		}));
}

// the groups `memberId` belongs to, filtered like list_delegation_groups(roles, status)
async function memberGroups(viewerId: string, memberId: string, roles: Role[] | undefined, status: "Pending" | "Accepted" | undefined) {
	const rows = await sql`select d.owner_id::text, d.role from delegation_members d join users o on o.id = d.owner_id
		where d.member_id = ${memberId}::bigint and o.status <> 'suspended'
		${status ? sql`and d.status = ${status}` : sql``}
		${roles ? sql`and d.role = any(${sql.array(roles, "TEXT")})` : sql``}
		order by d.created_at`;
	return groupShapes(viewerId, rows.map((r: any) => r.owner_id), new Map(rows.map((r: any) => [r.owner_id, r.role])));
}

function viewerUser(v: Viewer, id = v.id) {
	return { id: globalId("User", id), rest_id: id, core: { screen_name: id === v.id ? v.screen_name : v.actor?.screen_name } };
}

// ---- checks

// The owner manages its group; an Admin switched into it may invite and remove
// Contributors only, as the client's role screen says.
function mayManage(v: Viewer, ownerId: string, roles: Role[]) {
	if (v.id !== ownerId) throw new PostError("You can't manage this account's delegates.", 200);
	if (v.actor && v.actor.role !== "Admin") throw new PostError("Only an Admin can manage this account's delegates.", 200);
	if (v.actor && roles.includes("Admin")) throw new PostError("Admins can only invite or remove Contributors.", 200);
}

async function membershipRow(id: unknown): Promise<Row | undefined> {
	if (!/^\d{1,19}$/.test(String(id ?? ""))) return undefined;
	const [r] = await sql`select id::text, owner_id::text, member_id::text, role, status from delegation_members where id = ${String(id)}::bigint`;
	return r as Row | undefined;
}

async function invite(v: Viewer, ownerId: string, memberId: string, role: Role) {
	if (!ROLES.has(role)) throw new PostError("Pick Admin or Contributor.", 214);
	mayManage(v, ownerId, [role]);
	if (!/^\d{1,19}$/.test(memberId) || memberId === ownerId) throw new PostError("You can't add this account.", 214);
	const [m] = await sql`select status, delegation_invites, automated_by,
		exists (select 1 from follows f where f.follower_id = u.id and f.followee_id = ${ownerId}::bigint) as follows_owner
		from users u where id = ${memberId}::bigint`;
	if (!m || m.status === "suspended") throw new PostError("That account isn't available.", 144);
	if (await isBlockedEitherWay(ownerId, memberId)) throw new PostError("You can't add this account.", 214);
	// the invitee's own setting (Settings > Delegate)
	if (m.delegation_invites === "Nobody" || (m.delegation_invites === "OnlyFollowing" && !m.follows_owner))
		throw new PostError("This account doesn't accept delegation invites from you.", 214);
	const [{ n }] = await sql`select count(*)::int as n from delegation_members where owner_id = ${ownerId}::bigint`;
	if (n >= MAX_MEMBERS) throw new PostError(`An account can have up to ${MAX_MEMBERS} delegates.`, 214);
	await sql`insert into delegation_members (id, owner_id, member_id, role, invited_by)
		values (${newId()}::bigint, ${ownerId}::bigint, ${memberId}::bigint, ${role}, ${self(v)}::bigint)
		on conflict (owner_id, member_id) do update set role = excluded.role`;
}

// ---- operations

const memberList = async (v: Viewer, vars: { roles?: Role[]; status?: "Pending" | "Accepted" }) => memberGroups(v.id, self(v), vars.roles, vars.status);

export const delegationHandlers: Record<string, (v: Viewer, vars: Vars) => Promise<unknown>> = {
	// Settings > Delegate: the "Allow others to invite you" switch
	DelegateQuery: async (v) => {
		const [u] = await sql`select delegation_invites from users where id = ${v.id}::bigint`;
		return {
			data: {
				viewer_v2: {
					id: globalId("Viewer", v.id),
					user_results: { id: globalId("UserResults", v.id), result: { __typename: "User", id: globalId("User", v.id), rest_id: v.id, delegation_invitation_preferences: u?.delegation_invites ?? "Everyone" } },
				},
			},
		};
	},
	useDelegateMutation_settings_Mutation: async (v, vars) => {
		const setting = String(vars.invitationSetting ?? "");
		if (!INVITE_SETTINGS.has(setting)) throw new PostError("Unknown setting.", 214);
		await sql`update users set delegation_invites = ${setting} where id = ${v.id}::bigint`;
		return { data: { user_delegation_invitation_preferences_put: "Done" } };
	},
	// the account menu's "Delegated accounts" and the switch screen
	useRelayDelegateDataQuery: async (v) => ({ data: { viewer: { id: globalId("Viewer", self(v)), list_delegation_groups: await memberList(v, { status: "Accepted" }) } } }),
	DelegatedAccountListQuery: async (v) => ({ data: { viewer_v2: { id: globalId("Viewer", self(v)), list_delegation_groups: await memberList(v, { status: "Accepted" }) } } }),
	useRelayDelegateDataPendingQuery: async (v) => ({ data: { viewer_v2: { id: globalId("Viewer", self(v)), pendingGroups: await memberList(v, { status: "Pending" }) } } }),
	// Settings > Delegate > Accounts delegated to you
	GroupsDelegateQuery: async (v) => ({
		data: {
			viewer_v2: {
				id: globalId("Viewer", self(v)),
				user: viewerUser(v, self(v)),
				acceptedAdminGroups: await memberList(v, { roles: ["Admin"], status: "Accepted" }),
				acceptedContributorGroups: await memberList(v, { roles: ["Contributor"], status: "Accepted" }),
				pendingGroups: await memberList(v, { status: "Pending" }),
			},
		},
	}),
	GroupDetailDelegateQuery: async (v, vars) => {
		const ownerId = String(vars.groupId ?? "");
		const allowed = ownerId === v.id || (/^\d{1,19}$/.test(ownerId) && (await sql`select 1 from delegation_members where owner_id = ${ownerId}::bigint and member_id = ${self(v)}::bigint`).length > 0);
		const [group] = allowed ? await groupShapes(v.id, [ownerId]) : [];
		return { data: { viewer_v2: { id: globalId("Viewer", self(v)), user: viewerUser(v, self(v)) }, delegation_group: group ?? null } };
	},
	// Settings > Delegate > Members you've delegated (the owner's side)
	MembersDelegateQuery: async (v) => ({
		data: { viewer_v2: { id: globalId("Viewer", v.id), user: viewerUser(v), list_delegation_groups: await groupShapes(v.id, [v.id]) } },
	}),
	// the account picker in the add-member dialog
	GroupsModalQuery: async (v) => {
		const [u] = await sql`select ${userCols(v.id)} from users u where u.id = ${v.id}::bigint`;
		return { data: { viewer_v2: { id: globalId("Viewer", v.id), user_results: userResults(toUser(u)) } } };
	},
	useAddMemberModalMutation_add_Mutation: async (v, vars) => {
		const ownerId = String(vars.delegationGroupId ?? v.id);
		await invite(v, ownerId, String(vars.userId ?? ""), vars.selectedRole);
		const [group] = await groupShapes(v.id, [ownerId]);
		return { data: { delegation_group_invite_member: group } };
	},
	useChangeMemberRoleModalMutation_change_Mutation: async (v, vars) => {
		const role = vars.selectedRole as Role;
		if (!ROLES.has(role)) throw new PostError("Pick Admin or Contributor.", 214);
		// the client passes the membership's rest_id under "userId"; a member's own id works too
		const row = (await membershipRow(vars.userId)) ?? (await sql`select id::text, owner_id::text, member_id::text, role, status from delegation_members
			where owner_id = ${v.id}::bigint and member_id = ${/^\d{1,19}$/.test(String(vars.userId)) ? String(vars.userId) : "0"}::bigint`)[0];
		if (!row) throw new PostError("No such member.", 144);
		mayManage(v, row.owner_id, [row.role, role]);
		await sql`update delegation_members set role = ${role} where id = ${row.id}::bigint`;
		return { data: { delegationmembership_role_put: "Done" } };
	},
	// the owner (or an Admin) withdraws a pending invite
	useMemberMenuMutation_cancel_invite_Mutation: async (v, vars) => {
		const row = await membershipRow(vars.membershipId);
		if (!row) throw new PostError("No such invite.", 144);
		mayManage(v, row.owner_id, [row.role]);
		await sql`delete from delegation_members where id = ${row.id}::bigint and status = 'Pending'`;
		return { data: { delegation_membership_cancel: { id: globalId("DelegationMembership", row.id) } } };
	},
	// the owner (or an Admin) removes a member
	useMemberMenuMutation_remove_Mutation: async (v, vars) => {
		const row = await membershipRow(vars.membershipId);
		if (!row) throw new PostError("No such member.", 144);
		mayManage(v, row.owner_id, [row.role]);
		await sql`delete from delegation_members where id = ${row.id}::bigint`;
		return { data: { delegation_membership_delete: { id: globalId("DelegationGroup", row.owner_id) } } };
	},
	// a member leaves a group they belong to
	GroupMenuMutation: async (v, vars) => {
		const row = await membershipRow(vars.membershipId);
		if (!row || row.member_id !== self(v)) throw new PostError("No such membership.", 144);
		await sql`delete from delegation_members where id = ${row.id}::bigint`;
		const [group] = await groupShapes(self(v), [row.owner_id]);
		return { data: { delegation_membership_delete: { id: globalId("DelegationGroup", row.owner_id), members: group?.members ?? [] } } };
	},
	InviteMenu_accept_Mutation: async (v, vars) => {
		const row = await membershipRow(vars.membershipId);
		if (!row || row.member_id !== self(v)) throw new PostError("No such invite.", 144);
		await sql`update delegation_members set status = 'Accepted' where id = ${row.id}::bigint`;
		return { data: { delegationmembership_status_put: "Done" } };
	},
	InviteMenu_reject_Mutation: async (v, vars) => {
		const row = await membershipRow(vars.membershipId);
		if (!row || row.member_id !== self(v) || row.status !== "Pending") throw new PostError("No such invite.", 144);
		await sql`delete from delegation_members where id = ${row.id}::bigint`;
		return { data: { delegation_membership_reject: { id: globalId("DelegationMembership", row.id) } } };
	},
};
