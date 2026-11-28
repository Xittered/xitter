// Lists: owned or subscribed collections of accounts with their own timeline.
// Response shapes come from the client's own fetchers (UserLists chunk):
// mutations answer { list }, ListByRestId { list }, ListBySlug
// { user_by_screen_name: { list } }, member/subscriber/tweet timelines sit under
// list.<name>_timeline.timeline.

import type { Viewer } from "./auth";
import { holdLock, sql } from "./db";
import { blockedFor, outOfView } from "./blocks";
import { isId, newId } from "./ids";
import { cursorEntry, feedEntry, userEntry, userResult } from "./model";
import { forbiddenText } from "./names";
import { PostError, feed } from "./posts";
import { userByName, usersByIds } from "./users";

type Vars = Record<string, any>;

const MAX_NAME = 25;
const MAX_DESCRIPTION = 100;
export const MAX_LISTS = 1000;
export const MAX_MEMBERS = 5000;
const MEMBER_PAGE = 200;

const globalId = (kind: string, id: string) => Buffer.from(`${kind}:${id}`).toString("base64");
const slugOf = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "list";

function listId(vars: Vars, key = "listId"): string {
	const id = vars[key];
	if (!isId(id)) throw new PostError("Invalid list id.", 144);
	return id;
}

const missing = () => new PostError("List not found.", 144);

// "All": every post on the instance. Not a row in `lists`; owned by the
// instance owner, shown first on the home tabs until the viewer unpins it,
// and /all opens it.
export const ALL_ID = "1";
const fixed = () => new PostError("This list can't be changed.", 150);

async function allRow(viewerId: string): Promise<ListRow | undefined> {
	const [r] = await sql`select (select id::text from users where role = 'admin' and instance is null order by created_at, id limit 1) as owner_id,
		(select count(*)::int from users where status <> 'suspended') as members,
		coalesce((select (preferences->>'all_tab_hidden')::boolean from users where id = ${viewerId}::bigint), false) as hidden`;
	if (!r?.owner_id) return undefined;
	return {
		id: ALL_ID, owner_id: r.owner_id, name: "All", description: "Every post on this instance, newest first.",
		is_private: false, banner_media_id: null, created_at: new Date(0),
		member_count: r.members, subscriber_count: 0, following: false, is_member: false, muting: false, pinning: !r.hidden,
	};
}

async function setAllTab(viewerId: string, shown: boolean) {
	await sql`update users set preferences = preferences || ${JSON.stringify({ all_tab_hidden: !shown })}::text::jsonb where id = ${viewerId}::bigint`;
}

type ListRow = {
	id: string;
	owner_id: string;
	name: string;
	description: string;
	is_private: boolean;
	banner_media_id: string | null;
	created_at: Date;
	member_count: number;
	subscriber_count: number;
	following: boolean;
	is_member: boolean;
	muting: boolean;
	pinning: boolean;
};

// Lists the viewer may see: public ones and their own, and not the lists of
// accounts blocking them. `target` is the account whose membership is_member reports.
const listSelect = (viewerId: string, target = "0") => sql`
	select l.id::text, l.owner_id::text, l.name, l.description, l.is_private, l.banner_media_id::text, l.created_at,
		(select count(*)::int from list_members m where m.list_id = l.id) as member_count,
		(select count(*)::int from list_subscribers s where s.list_id = l.id) as subscriber_count,
		exists (select 1 from list_subscribers s where s.list_id = l.id and s.user_id = ${viewerId}::bigint) as following,
		exists (select 1 from list_members m where m.list_id = l.id and m.user_id = ${target}::bigint) as is_member,
		exists (select 1 from list_mutes x where x.list_id = l.id and x.user_id = ${viewerId}::bigint) as muting,
		exists (select 1 from pinned_lists x where x.list_id = l.id and x.user_id = ${viewerId}::bigint) as pinning
	from lists l`;

const visible = (viewerId: string) => sql`(l.owner_id = ${viewerId}::bigint or (not l.is_private and l.owner_id not in ${blockedFor(viewerId)}))`;

async function oneList(viewerId: string, id: string, target?: string): Promise<ListRow | undefined> {
	if (id === ALL_ID) return allRow(viewerId);
	const [row] = await sql`${listSelect(viewerId, target)} where l.id = ${id}::bigint and ${visible(viewerId)}`;
	return row as ListRow | undefined;
}

async function requireList(viewerId: string, id: string, target?: string): Promise<ListRow> {
	const row = await oneList(viewerId, id, target);
	if (!row) throw missing();
	return row;
}

async function requireOwn(viewerId: string, id: string): Promise<ListRow> {
	if (id === ALL_ID) throw fixed();
	const row = await requireList(viewerId, id);
	if (row.owner_id !== viewerId) throw new PostError("You can only change your own lists.", 150);
	return row;
}

const customBanner = (mediaId: string) => ({
	media_info: { __typename: "ApiImage", original_img_url: `/media/${mediaId}`, original_img_width: 1500, original_img_height: 500 },
	id: `list-banner-media-${mediaId}`,
});

const banner = (id: string) => ({
	media_info: { __typename: "ApiImage", original_img_url: "/public/list-banner.svg", original_img_width: 1500, original_img_height: 500 },
	id: `list-banner-${id}`,
});

async function ownersOf(viewerId: string, rows: ListRow[]) {
	return usersByIds(viewerId, [...new Set(rows.map((r) => r.owner_id))]);
}

function listObject(row: ListRow, owners: Awaited<ReturnType<typeof ownersOf>>) {
	const owner = owners.get(row.owner_id);
	const media = banner(row.id);
	const custom = row.banner_media_id ? customBanner(row.banner_media_id) : null;
	return {
		__typename: "List",
		id: globalId("List", row.id),
		id_str: row.id,
		name: row.name,
		description: row.description,
		mode: row.is_private ? "Private" : "Public",
		created_at: new Date(row.created_at).getTime(),
		member_count: row.member_count,
		subscriber_count: row.subscriber_count,
		following: row.following,
		is_member: row.is_member,
		muting: row.muting,
		pinning: row.pinning,
		custom_banner_media: custom?.media_info ? { media_info: custom.media_info } : null,
		custom_banner_media_results: custom ? { result: { __typename: "ApiMedia", id: custom.id, media_key: custom.id, media_info: custom.media_info } } : null,
		default_banner_media: { media_info: media.media_info },
		default_banner_media_results: { result: { __typename: "ApiMedia", id: media.id, media_key: media.id, media_info: media.media_info } },
		...(owner ? { user_results: { result: userResult(owner) } } : {}),
	};
}

async function listObjects(viewerId: string, rows: ListRow[]) {
	const owners = await ownersOf(viewerId, rows);
	return rows.map((r) => listObject(r, owners));
}

async function one(viewerId: string, id: string, target?: string) {
	const row = await requireList(viewerId, id, target);
	return (await listObjects(viewerId, [row]))[0];
}

// entries come back whole; the cursor value only has to be distinct
const listEntry = (list: unknown, id: string, sortIndex: string) => ({
	entryId: `list-${id}`,
	sortIndex,
	content: {
		__typename: "TimelineTimelineItem",
		entryType: "TimelineTimelineItem",
		itemContent: { __typename: "TimelineTwitterList", itemType: "TimelineTwitterList", displayType: "List", list },
	},
});

const timeline = (entries: unknown[], base: bigint) => ({
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
	},
});

const listEntries = async (viewerId: string, rows: ListRow[], cursor: unknown) => {
	const base = BigInt(newId());
	const objects = cursor ? [] : await listObjects(viewerId, rows);
	return { base, entries: objects.map((o, i) => listEntry(o, rows[i].id, (base - BigInt(i) - 1n).toString())) };
};

async function listsTimeline(viewerId: string, rows: ListRow[], vars: Vars) {
	const { base, entries } = await listEntries(viewerId, rows, vars.cursor);
	return timeline(entries, base);
}

const userOf = (viewerId: string, vars: Vars) => (isId(vars.userId) ? vars.userId : viewerId);

// the accounts of a list, as user entries; the Bottom cursor is the offset of
// the next page, because a list can hold far more than one page
async function memberTimeline(viewerId: string, table: "list_members" | "list_subscribers", id: string, vars: Vars) {
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	const match = /^b(\d{1,6})$/.exec(cursor);
	if (cursor && !match) return { timeline: { instructions: [] } };
	const offset = match ? Number(match[1]) : 0;
	if (offset > MAX_MEMBERS) return { timeline: { instructions: [] } };
	const rows = await sql`select t.user_id::text from ${sql(table)} t where t.list_id = ${id}::bigint
		and t.user_id not in ${blockedFor(viewerId)} and t.user_id not in ${outOfView(viewerId)}
		order by t.created_at desc, t.user_id desc limit ${MEMBER_PAGE + 1} offset ${offset}`;
	const page = rows.slice(0, MEMBER_PAGE);
	const users = await usersByIds(viewerId, page.map((r: any) => r.user_id));
	const base = BigInt(newId());
	const entries = page.flatMap((r: any, i: number) => (users.has(r.user_id) ? [userEntry(users.get(r.user_id)!, (base - BigInt(i) - 1n).toString())] : []));
	return {
		timeline: {
			instructions: [{
				type: "TimelineAddEntries",
				entries: [
					...entries,
					cursorEntry("Top", "t0", (base + 1n).toString()),
					...(rows.length > MEMBER_PAGE ? [cursorEntry("Bottom", `b${offset + MEMBER_PAGE}`, (base - BigInt(entries.length) - 2n).toString())] : []),
				],
			}],
		},
	};
}

// "b<id>" is older than, "t<id>" newer than, over feed item ids
async function tweetTimeline(viewerId: string, id: string, vars: Vars) {
	const count = Math.min(Math.max(Number(vars.count) || 20, 1), 100);
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	const at = isId(cursor.slice(1)) ? cursor.slice(1) : undefined;
	const newer = cursor[0] === "t" && !!at;
	const items = await feed({
		viewerId,
		authors: id === ALL_ID ? { all: true } : { list: id },
		replies: id === ALL_ID,
		kinds: "both",
		limit: count,
		...(newer ? { after: at } : { before: at }),
	});
	const entries: unknown[] = items.map((i) => feedEntry(i, i.id));
	const newest = items[0]?.id ?? at ?? newId();
	const oldest = items[items.length - 1]?.id ?? at ?? newest;
	entries.unshift(cursorEntry("Top", `t${newest}`, (BigInt(newest) + 1n).toString()));
	if (!newer) entries.push(cursorEntry("Bottom", `b${oldest}`, (BigInt(oldest) - 1n).toString()));
	return { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } };
}

async function create(v: Viewer, vars: Vars) {
	const name = String(vars.name ?? "").trim();
	if (!name) throw new PostError("Name your list.", 214);
	if (name.length > MAX_NAME) throw new PostError(`List names can be up to ${MAX_NAME} characters.`, 214);
	const description = String(vars.description ?? "").trim();
	if (description.length > MAX_DESCRIPTION) throw new PostError(`Descriptions can be up to ${MAX_DESCRIPTION} characters.`, 214);
	if (forbiddenText(name, description)) throw new PostError("The list contains a word this instance doesn't allow.", 186);
	const id = newId();
	await sql.begin(async (tx) => {
		await holdLock(tx, `lists:${v.id}`);
		const [count] = await tx`select count(*)::int as n from lists where owner_id = ${v.id}::bigint`;
		if (count.n >= MAX_LISTS) throw new PostError("You can't have more lists.", 214);
		await tx`insert into lists (id, owner_id, name, description, is_private) values (${id}::bigint, ${v.id}::bigint, ${name}, ${description}, ${!!vars.isPrivate})`;
	});
	return { data: { list: await one(v.id, id) } };
}

async function update(v: Viewer, vars: Vars) {
	const id = listId(vars);
	if (id === ALL_ID) throw fixed();
	await sql.begin(async (tx) => {
		// Subscription checks use this same row lock: turning a list private
		// and removing subscribers must finish before another one can join.
		const [row] = await tx`select l.owner_id::text, l.name, l.description, l.is_private from lists l
			where l.id = ${id}::bigint and ${visible(v.id)} for update`;
		if (!row) throw missing();
		if (row.owner_id !== v.id) throw new PostError("You can only change your own lists.", 150);
		const name = vars.name === undefined ? row.name : String(vars.name).trim();
		if (!name || name.length > MAX_NAME) throw new PostError(`List names are 1 to ${MAX_NAME} characters.`, 214);
		const description = vars.description === undefined ? row.description : String(vars.description).trim();
		if (description.length > MAX_DESCRIPTION) throw new PostError(`Descriptions can be up to ${MAX_DESCRIPTION} characters.`, 214);
		if (forbiddenText(name, description)) throw new PostError("The list contains a word this instance doesn't allow.", 186);
		const isPrivate = vars.isPrivate === undefined ? row.is_private : !!vars.isPrivate;
		await tx`update lists set name = ${name}, description = ${description}, is_private = ${isPrivate} where id = ${id}::bigint`;
		if (isPrivate) await tx`delete from list_subscribers where list_id = ${id}::bigint and user_id <> ${v.id}::bigint`;
	});
	return { data: { list: await one(v.id, id) } };
}

export async function addListMember(tx: typeof sql, ownerId: string, listId: string, userId: string) {
	const [blocked] = await tx`select 1 from blocks where (blocker_id = ${userId}::bigint and blocked_id = ${ownerId}::bigint) or (blocker_id = ${ownerId}::bigint and blocked_id = ${userId}::bigint)`;
	if (blocked) throw new PostError("You can't add this account to a list.", 150);
	const [exists] = await tx`select 1 from users where id = ${userId}::bigint`;
	if (!exists) throw new PostError("User not found.", 144);
	await holdLock(tx, `list-members:${listId}`);
	const [n] = await tx`select count(*)::int as n from list_members where list_id = ${listId}::bigint`;
	if (n.n >= MAX_MEMBERS) throw new PostError("This list is full.", 214);
	await tx`insert into list_members (list_id, user_id) values (${listId}::bigint, ${userId}::bigint) on conflict do nothing`;
}

async function member(v: Viewer, vars: Vars, on: boolean) {
	const id = listId(vars);
	await requireOwn(v.id, id);
	if (!isId(vars.userId)) throw new PostError("Invalid user id.", 144);
	if (on) {
		await sql.begin((tx) => addListMember(tx, v.id, id, String(vars.userId)));
	} else {
		await sql`delete from list_members where list_id = ${id}::bigint and user_id = ${vars.userId}::bigint`;
	}
	return { data: { list: await one(v.id, id) } };
}

async function subscribe(v: Viewer, vars: Vars, on: boolean) {
	const id = listId(vars);
	if (id === ALL_ID) throw fixed();
	await sql.begin(async (tx) => {
		const [row] = await tx`select l.id from lists l where l.id = ${id}::bigint and ${visible(v.id)} for update`;
		if (!row) throw missing();
		if (on) await tx`insert into list_subscribers (list_id, user_id) values (${id}::bigint, ${v.id}::bigint) on conflict do nothing`;
		else await tx`delete from list_subscribers where list_id = ${id}::bigint and user_id = ${v.id}::bigint`;
	});
	const list = await one(v.id, id);
	return { data: on ? { list_subscribe_v3: list } : { list } };
}

async function mute(v: Viewer, vars: Vars, on: boolean) {
	const id = listId(vars);
	if (id === ALL_ID) throw fixed();
	await requireList(v.id, id);
	if (on) await sql`insert into list_mutes (list_id, user_id) values (${id}::bigint, ${v.id}::bigint) on conflict do nothing`;
	else await sql`delete from list_mutes where list_id = ${id}::bigint and user_id = ${v.id}::bigint`;
	return { data: { list_mute: "Done" } };
}

// X's own order on the management page: pinned first, then owned, then subscribed
async function managementRows(viewerId: string): Promise<ListRow[]> {
	return (await sql`${listSelect(viewerId)}
		left join pinned_lists p on p.list_id = l.id and p.user_id = ${viewerId}::bigint
		where (l.owner_id = ${viewerId}::bigint or exists (select 1 from list_subscribers s where s.list_id = l.id and s.user_id = ${viewerId}::bigint))
			and ${visible(viewerId)}
		order by (p.list_id is null), p.position, (l.owner_id <> ${viewerId}::bigint), l.created_at desc`) as ListRow[];
}

async function ownedBy(viewerId: string, userId: string, target?: string): Promise<ListRow[]> {
	return (await sql`${listSelect(viewerId, target)} where l.owner_id = ${userId}::bigint and ${visible(viewerId)} order by l.created_at desc`) as ListRow[];
}

// lists a user owns or follows, public ones unless the viewer is that user
async function combinedFor(viewerId: string, userId: string, target?: string): Promise<ListRow[]> {
	return (await sql`${listSelect(viewerId, target)}
		where (l.owner_id = ${userId}::bigint or exists (select 1 from list_subscribers s where s.list_id = l.id and s.user_id = ${userId}::bigint))
			and ${visible(viewerId)}
		order by (l.owner_id <> ${userId}::bigint), l.created_at desc`) as ListRow[];
}

async function membershipsOf(viewerId: string, userId: string): Promise<ListRow[]> {
	return (await sql`${listSelect(viewerId)}
		where exists (select 1 from list_members m where m.list_id = l.id and m.user_id = ${userId}::bigint) and not l.is_private and l.owner_id not in ${blockedFor(viewerId)}
		order by l.created_at desc limit 100`) as ListRow[];
}

async function discover(viewerId: string): Promise<ListRow[]> {
	return (await sql`${listSelect(viewerId)}
		where not l.is_private and l.owner_id <> ${viewerId}::bigint and l.owner_id not in ${blockedFor(viewerId)} and l.owner_id not in ${outOfView(viewerId)}
			and not exists (select 1 from list_subscribers s where s.list_id = l.id and s.user_id = ${viewerId}::bigint)
			and (select count(*) from list_members m where m.list_id = l.id) > 0
		order by (select count(*) from list_subscribers s where s.list_id = l.id) desc, l.created_at desc limit 50`) as ListRow[];
}

// accounts the viewer follows who aren't on the list yet; the Bottom cursor is
// the offset of the next page, because the viewer can follow more than 20
async function recommended(viewerId: string, id: string, vars: Vars) {
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	const match = /^b(\d{1,6})$/.exec(cursor);
	if (cursor && !match) return { timeline: { instructions: [] } };
	const offset = match ? Number(match[1]) : 0;
	const pageSize = 20;
	const rows = await sql`select f.followee_id::text as user_id from follows f where f.follower_id = ${viewerId}::bigint
		and f.followee_id not in (select m.user_id from list_members m join lists l on l.id = m.list_id where m.list_id = ${id}::bigint and l.owner_id = ${viewerId}::bigint)
		and f.followee_id not in ${blockedFor(viewerId)}
		order by f.created_at desc, f.followee_id desc limit ${pageSize + 1} offset ${offset}`;
	const page = rows.slice(0, pageSize);
	const users = await usersByIds(viewerId, page.map((r: any) => r.user_id));
	const base = BigInt(newId());
	const entries = page.flatMap((r: any, i: number) => (users.has(r.user_id) ? [userEntry(users.get(r.user_id)!, (base - BigInt(i) - 1n).toString())] : []));
	return {
		timeline: {
			instructions: [{
				type: "TimelineAddEntries",
				entries: [
					...entries,
					cursorEntry("Top", "t0", (base + 1n).toString()),
					...(rows.length > pageSize ? [cursorEntry("Bottom", `b${offset + pageSize}`, (base - BigInt(entries.length) - 2n).toString())] : []),
				],
			}],
		},
	};
}

// Pinned lists are extra tabs on the home page. The client reads each pinned
// item as { __typename: "ListPinnedTimeline", list }.
async function pinnedItems(viewerId: string) {
	const rows = (await sql`${listSelect(viewerId)} join pinned_lists p on p.list_id = l.id and p.user_id = ${viewerId}::bigint
		where ${visible(viewerId)} order by p.position`) as ListRow[];
	const all = await allRow(viewerId);
	if (all?.pinning) rows.unshift(all);
	return (await listObjects(viewerId, rows)).map((list) => ({ __typename: "ListPinnedTimeline", list }));
}

async function pinnableItems(viewerId: string) {
	const rows = (await sql`${listSelect(viewerId)}
		where (l.owner_id = ${viewerId}::bigint or exists (select 1 from list_subscribers s where s.list_id = l.id and s.user_id = ${viewerId}::bigint))
			and ${visible(viewerId)}
		order by l.created_at desc`) as ListRow[];
	const all = await allRow(viewerId);
	if (all) rows.unshift(all);
	return (await listObjects(viewerId, rows)).map((list) => ({ __typename: "ListPinnedTimeline", list }));
}

const MAX_PINNED = 5;

async function setPinnedLists(viewerId: string, ids: string[]) {
	await sql`delete from pinned_lists where user_id = ${viewerId}::bigint`;
	let position = 0;
	for (const id of ids.slice(0, MAX_PINNED)) {
		if (!(await oneList(viewerId, id))) continue;
		await sql`insert into pinned_lists (user_id, list_id, position) values (${viewerId}::bigint, ${id}::bigint, ${position++}) on conflict do nothing`;
	}
}

async function pinOne(v: Viewer, vars: Vars, on: boolean) {
	const item = vars.pinnedTimelineItem ?? {};
	const key = on ? "pin_timeline" : "unpin_timeline";
	if (item.pinned_timeline_type !== "List" || !isId(item.id)) {
		return { data: { [key]: { __typename: on ? "PinTimelineErrorResult" : "UnpinTimelineErrorResult", reason: "Unsupported", message: "That can't be pinned here." } } };
	}
	const id = item.id as string;
	if (id === ALL_ID) await setAllTab(v.id, on);
	const row = await oneList(v.id, id);
	if (!row) return { data: { [key]: { __typename: on ? "PinTimelineErrorResult" : "UnpinTimelineErrorResult", reason: "NotFound", message: "List not found." } } };
	if (id === ALL_ID) {
		// stored in preferences, above
	} else if (on) {
		const pinned = await sql.begin(async (tx) => {
			await holdLock(tx, `pinned-lists:${v.id}`);
			const [n] = await tx`select count(*)::int as n, coalesce(max(position) + 1, 0)::int as next from pinned_lists where user_id = ${v.id}::bigint`;
			if (n.n >= MAX_PINNED) return false;
			await tx`insert into pinned_lists (user_id, list_id, position) values (${v.id}::bigint, ${id}::bigint, ${n.next}) on conflict do nothing`;
			return true;
		});
		if (!pinned) {
			return { data: { pin_timeline: { __typename: "PinTimelineErrorResult", reason: "LimitReached", message: `You can pin up to ${MAX_PINNED} lists.` } } };
		}
	} else {
		await sql`delete from pinned_lists where user_id = ${v.id}::bigint and list_id = ${id}::bigint`;
	}
	const list = await one(v.id, id);
	return { data: { [key]: { __typename: on ? "PinTimelineSuccessResult" : "UnpinTimelineSuccessResult", updated_pinned_timeline: { __typename: "ListPinnedTimeline", list } } } };
}

export const listHandlers = {
	CreateList: create,
	UpdateList: update,
	DeleteList: async (v: Viewer, vars: Vars) => {
		const id = listId(vars);
		await requireOwn(v.id, id);
		await sql`delete from lists where id = ${id}::bigint`;
		return { data: { list_delete: "Done" } };
	},
	ListByRestId: async (v: Viewer, vars: Vars) => ({ data: { list: await one(v.id, listId(vars)) } }),
	ListBySlug: async (v: Viewer, vars: Vars) => {
		const owner = await userByName(v.id, String(vars.screenName ?? ""));
		if (!owner) throw missing();
		const slug = String(vars.listSlug ?? "").toLowerCase();
		const rows = await ownedBy(v.id, owner.id);
		const row = rows.find((r) => slugOf(r.name) === slug);
		if (!row) throw missing();
		return { data: { user_by_screen_name: { list: (await listObjects(v.id, [row]))[0] } } };
	},
	ListAddMember: (v: Viewer, vars: Vars) => member(v, vars, true),
	ListRemoveMember: (v: Viewer, vars: Vars) => member(v, vars, false),
	ListSubscribe: (v: Viewer, vars: Vars) => subscribe(v, vars, true),
	ListUnsubscribe: (v: Viewer, vars: Vars) => subscribe(v, vars, false),
	MuteList: (v: Viewer, vars: Vars) => mute(v, vars, true),
	UnmuteList: (v: Viewer, vars: Vars) => mute(v, vars, false),
	// the banner picker uploads through the media endpoint, then names the media here
	EditListBanner: async (v: Viewer, vars: Vars) => {
		const id = listId(vars);
		await requireOwn(v.id, id);
		const [media] = isId(vars.mediaId) ? await sql`select 1 from media where id = ${vars.mediaId}::bigint and user_id = ${v.id}::bigint` : [];
		if (!media) throw new PostError("That image isn't available.", 214);
		await sql`update lists set banner_media_id = ${vars.mediaId}::bigint where id = ${id}::bigint`;
		return { data: { list: await one(v.id, id) } };
	},
	DeleteListBanner: async (v: Viewer, vars: Vars) => {
		const id = listId(vars);
		await requireOwn(v.id, id);
		await sql`update lists set banner_media_id = null where id = ${id}::bigint`;
		return { data: { list: await one(v.id, id) } };
	},

	ListsManagementPageTimeline: async (v: Viewer, vars: Vars) => {
		const result = { list_management_timeline: await listsTimeline(v.id, await managementRows(v.id), vars) };
		return { data: { viewer: result, viewer_v2: result } };
	},
	ListsDiscovery: async (v: Viewer, vars: Vars) => ({ data: { list_discovery_list_mixer_timeline: await listsTimeline(v.id, await discover(v.id), vars) } }),
	CombinedLists: async (v: Viewer, vars: Vars) => {
		const userId = userOf(v.id, vars);
		const tl = await listsTimeline(v.id, await combinedFor(v.id, userId, isId(vars.isListMemberTargetUserId) ? vars.isListMemberTargetUserId : undefined), vars);
		return {
			data: {
				user: { result: { __typename: "User", timeline: tl } },
				user_result_by_rest_id: { result: { __typename: "User", all_subscribed_lists_timeline: tl } },
			},
		};
	},
	ListOwnerships: async (v: Viewer, vars: Vars) => {
		const target = isId(vars.isListMemberTargetUserId) ? vars.isListMemberTargetUserId : undefined;
		const tl = await listsTimeline(v.id, await ownedBy(v.id, userOf(v.id, vars), target), vars);
		return { data: { user: { result: { __typename: "User", timeline: tl } } } };
	},
	ListMemberships: async (v: Viewer, vars: Vars) => {
		const tl = await listsTimeline(v.id, await membershipsOf(v.id, userOf(v.id, vars)), vars);
		return { data: { user: { result: { __typename: "User", timeline: tl } } } };
	},
	ListMembers: async (v: Viewer, vars: Vars) => {
		const id = listId(vars);
		await requireList(v.id, id);
		return { data: { list: { members_timeline: await memberTimeline(v.id, "list_members", id, vars) } } };
	},
	ListSubscribers: async (v: Viewer, vars: Vars) => {
		const id = listId(vars);
		await requireList(v.id, id);
		return { data: { list: { subscribers_timeline: await memberTimeline(v.id, "list_subscribers", id, vars) } } };
	},
	ListLatestTweetsTimeline: async (v: Viewer, vars: Vars) => {
		const id = listId(vars);
		await requireList(v.id, id);
		return { data: { list: { tweets_timeline: await tweetTimeline(v.id, id, vars) } } };
	},
	ListRankedTweetsTimeline: async (v: Viewer, vars: Vars) => {
		const id = listId(vars);
		await requireList(v.id, id);
		return { data: { list: { tweets_timeline: await tweetTimeline(v.id, id, vars) } } };
	},
	ListCreationRecommendedUsers: async (v: Viewer, vars: Vars) => ({
		data: { list: { recommended_users: await recommended(v.id, isId(vars.listId) ? vars.listId : "0", vars) } },
	}),
	ListEditRecommendedUsers: async (v: Viewer, vars: Vars) => {
		const id = listId(vars);
		await requireOwn(v.id, id);
		return { data: { list: { recommended_users: await recommended(v.id, id, vars) } } };
	},
	ListSearchTimeline: async () => ({ data: { list: { search_timeline: timeline([], BigInt(newId())) } } }),

	PinnedTimelines: async (v: Viewer) => ({ data: { pinned_timelines: { pinned_timelines: await pinnedItems(v.id) } } }),
	PinnableTimelines: async (v: Viewer) => ({ data: { pinnable_timelines: { pinnable_timelines: await pinnableItems(v.id) } } }),
	PinTimeline: (v: Viewer, vars: Vars) => pinOne(v, vars, true),
	UnpinTimeline: (v: Viewer, vars: Vars) => pinOne(v, vars, false),
	UpdatePinnedTimelines: async (v: Viewer, vars: Vars) => {
		const items = Array.isArray(vars.pinnedTimelineItems) ? vars.pinnedTimelineItems : [];
		await setAllTab(v.id, items.some((i: any) => i?.pinned_timeline_type === "List" && i.id === ALL_ID));
		await setPinnedLists(v.id, items.filter((i: any) => i?.pinned_timeline_type === "List" && isId(i.id)).map((i: any) => i.id as string));
		return { data: { update_pinned_timelines: { pinned_timelines: await pinnedItems(v.id) } } };
	},
};
