// Direct messages for the 2020 web client (client/old/): the 1.1 dm/* API it
// was built against. XChat, the current client's chat, is end-to-end
// encrypted, so neither side can carry the other's messages; these are stored
// as plain text, as Twitter's were in 2020, and only old clients see them.
// One-to-one conversations only; a conversation's id is "<smaller id>-<larger id>".

import type { Viewer } from "./auth";
import { sql } from "./db";
import { queueReview } from "./claude-mod";
import { isId, newId } from "./ids";
import { legacyUser } from "./model";
import { usersByIds } from "./users";

type Obj = Record<string, any>;
const MAX_TEXT = 10_000;
const PAGE = 50;

const pairId = (a: string, b: string) => (BigInt(a) < BigInt(b) ? `${a}-${b}` : `${b}-${a}`);
const pairOf = (conversationId: string) => {
	const m = /^(\d{1,19})-(\d{1,19})$/.exec(conversationId);
	return m && isId(m[1]) && isId(m[2]) ? [m[1], m[2]] : null;
};

async function blockedBetween(a: string, b: string): Promise<boolean> {
	const [row] = await sql`select 1 from blocks where (blocker_id = ${a}::bigint and blocked_id = ${b}::bigint) or (blocker_id = ${b}::bigint and blocked_id = ${a}::bigint)`;
	return !!row;
}

const messageEntry = (e: Obj) => {
	const [a, b] = pairOf(e.conversation_id) ?? [e.sender_id, e.sender_id];
	const message_data = {
		id: e.id,
		time: String(new Date(e.created_at).getTime()),
		recipient_id: e.sender_id === a ? b : a,
		sender_id: e.sender_id,
		conversation_id: e.conversation_id,
		text: e.text,
		entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] },
	};
	return { message: { id: e.id, time: message_data.time, affects_sort: true, request_id: e.request_id ?? undefined, conversation_id: e.conversation_id, message_data } };
};

async function usersFor(viewerId: string, ids: string[]): Promise<Obj> {
	const users = await usersByIds(viewerId, [...new Set(ids)]);
	return Object.fromEntries([...users].map(([id, u]) => [id, { ...legacyUser(u), can_dm: true }]));
}

// the viewer's conversations (not left, or written to since), as the client keys them
async function conversations(viewerId: string, only?: string[]): Promise<Obj> {
	const rows = await sql`select p.conversation_id, p.last_read_event_id::text,
			max(e.id)::text as max_id, min(e.id)::text as min_id, max(e.created_at) as last_at,
			(select json_agg(json_build_object('user_id', o.user_id::text, 'last_read_event_id', o.last_read_event_id::text)) from legacy_dm_participants o where o.conversation_id = p.conversation_id) as participants
		from legacy_dm_participants p join legacy_dm_events e on e.conversation_id = p.conversation_id and not e.hidden
		where p.user_id = ${viewerId}::bigint and (p.left_at_event_id is null or e.id > p.left_at_event_id)
			${only ? sql`and p.conversation_id = any(${sql.array(only, "TEXT")})` : sql``}
		group by p.conversation_id, p.last_read_event_id`;
	return Object.fromEntries(
		rows.map((r: Obj) => [
			r.conversation_id,
			{
				conversation_id: r.conversation_id,
				type: "ONE_TO_ONE",
				sort_event_id: r.max_id,
				sort_timestamp: String(new Date(r.last_at).getTime()),
				participants: r.participants,
				nsfw: false,
				notifications_disabled: false,
				mention_notifications_disabled: false,
				last_read_event_id: r.last_read_event_id,
				read_only: false,
				trusted: true,
				low_quality: false,
				muted: false,
				status: "AT_END",
				min_entry_id: r.min_id,
				max_entry_id: r.max_id,
			},
		]),
	);
}

// messages the viewer can see, newest first; `before` for older pages. With
// `after` (updates) the oldest come first, so a long gap is caught up in order
async function events(viewerId: string, opts: { after?: string; before?: string; conversationId?: string; limit?: number }) {
	return await sql`select e.id::text, e.conversation_id, e.sender_id::text, e.text, e.request_id, e.created_at
		from legacy_dm_events e join legacy_dm_participants p on p.conversation_id = e.conversation_id and p.user_id = ${viewerId}::bigint and not e.hidden
		where (p.left_at_event_id is null or e.id > p.left_at_event_id)
			${opts.conversationId ? sql`and e.conversation_id = ${opts.conversationId}` : sql``}
			${opts.after ? sql`and e.id > ${opts.after}::bigint` : sql``}
			${opts.before ? sql`and e.id < ${opts.before}::bigint` : sql``}
		order by e.id ${opts.after ? sql`asc` : sql`desc`} limit ${opts.limit ?? PAGE}`;
}

// the newest message of each of the viewer's conversations, so the inbox lists
// them all, however many messages the busiest ones hold
async function newestOfEach(viewerId: string) {
	return await sql`select distinct on (e.conversation_id) e.id::text, e.conversation_id, e.sender_id::text, e.text, e.request_id, e.created_at
		from legacy_dm_events e join legacy_dm_participants p on p.conversation_id = e.conversation_id and p.user_id = ${viewerId}::bigint and not e.hidden
		where (p.left_at_event_id is null or e.id > p.left_at_event_id)
		order by e.conversation_id, e.id desc limit 500`;
}

async function box(viewerId: string, rows: Obj[], only?: string[]) {
	const convs = await conversations(viewerId, only ?? [...new Set(rows.map((r) => r.conversation_id))]);
	const ids = [...rows.map((r) => r.sender_id), ...Object.values(convs).flatMap((c: any) => c.participants.map((p: Obj) => p.user_id))];
	return { entries: rows.map(messageEntry), users: await usersFor(viewerId, ids), conversations: convs };
}

async function lastSeen(viewerId: string): Promise<string> {
	const [row] = await sql`select legacy_dm_last_seen::text as id from users where id = ${viewerId}::bigint`;
	return row?.id ?? "0";
}

// the cursor is the newest event id the client has; "0" before the first one
async function newestId(viewerId: string): Promise<string> {
	const [row] = await sql`select coalesce(max(e.id), 0)::text as id from legacy_dm_events e join legacy_dm_participants p on p.conversation_id = e.conversation_id where p.user_id = ${viewerId}::bigint`;
	return row?.id ?? "0";
}

export async function legacyUnreadCount(viewerId: string): Promise<number> {
	const [row] = await sql`select count(distinct p.conversation_id)::int as n from legacy_dm_participants p join legacy_dm_events e on e.conversation_id = p.conversation_id and not e.hidden
		where p.user_id = ${viewerId}::bigint and e.sender_id <> ${viewerId}::bigint and e.id > p.last_read_event_id and (p.left_at_event_id is null or e.id > p.left_at_event_id)`;
	return row?.n ?? 0;
}

async function send(viewer: Viewer, f: Obj): Promise<Response> {
	const text = String(f.text ?? "").trim();
	if (!text) return error(400, 214, "Your message is empty.");
	if (text.length > MAX_TEXT) return error(400, 354, "The text of your direct message is over the max character limit.");
	let pair = f.conversation_id ? pairOf(String(f.conversation_id)) : null;
	const recipient = String(f.recipient_ids ?? "").split(",").find(isId);
	if (!pair && recipient) pair = pairId(viewer.id, recipient).split("-") as [string, string];
	if (!pair || !pair.includes(viewer.id)) return error(403, 150, "You cannot send messages to this user.");
	const other = pair[0] === viewer.id ? pair[1] : pair[0];
	const [exists] = await sql`select 1 from users where id = ${other}::bigint`;
	if (!exists || other === viewer.id || (await blockedBetween(viewer.id, other))) return error(403, 349, "You cannot send messages to this user.");
	const conversationId = pairId(pair[0], pair[1]);
	const id = newId();
	await sql.begin(async (tx) => {
		await tx`insert into legacy_dm_participants (conversation_id, user_id) values (${conversationId}, ${viewer.id}::bigint), (${conversationId}, ${other}::bigint) on conflict do nothing`;
		await tx`insert into legacy_dm_events (id, conversation_id, sender_id, text, request_id) values (${id}::bigint, ${conversationId}, ${viewer.id}::bigint, ${text}, ${String(f.request_id ?? "").slice(0, 64) || null})`;
		// your own message counts as read
		await tx`update legacy_dm_participants set last_read_event_id = ${id}::bigint where conversation_id = ${conversationId} and user_id = ${viewer.id}::bigint`;
	});
	queueReview("dm", id);
	const rows = await events(viewer.id, { conversationId, limit: 1 });
	return Response.json({ entries: rows.map(messageEntry), users: await usersFor(viewer.id, [viewer.id, other]) });
}

const error = (status: number, code: number, message: string) => Response.json({ errors: [{ code, message }] }, { status });

async function form(req: Request): Promise<Obj> {
	const text = await req.text().catch(() => "");
	if (text.trim().startsWith("{")) {
		try {
			return JSON.parse(text);
		} catch {}
	}
	return Object.fromEntries(new URLSearchParams(text));
}

export async function legacyDmRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	if (!path.startsWith("/1.1/dm/")) return undefined;
	const q = new URL(req.url).searchParams;
	if (method === "GET") {
		if (path === "/1.1/dm/inbox_initial_state.json") {
			const recent = await events(viewer.id, {});
			const have = new Set(recent.map((r: Obj) => r.id));
			const rows = [...recent, ...(await newestOfEach(viewer.id)).filter((r: Obj) => !have.has(r.id))].sort((a: Obj, b: Obj) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
			const state = await box(viewer.id, rows);
			// a conversation whose first message isn't among these has more to load
			const shown = new Set(rows.map((r: Obj) => r.id));
			for (const c of Object.values(state.conversations) as Obj[]) if (!shown.has(c.min_entry_id)) c.status = "HAS_MORE";
			return Response.json({
				inbox_initial_state: {
					last_seen_event_id: await lastSeen(viewer.id),
					trusted_last_seen_event_id: await lastSeen(viewer.id),
					untrusted_last_seen_event_id: "0",
					cursor: await newestId(viewer.id),
					inbox_timelines: { trusted: { status: "AT_END" }, untrusted: { status: "AT_END" }, untrusted_low_quality: { status: "AT_END" } },
					...state,
				},
			});
		}
		if (path === "/1.1/dm/user_updates.json") {
			const cursor = isId(q.get("cursor") ?? "") ? q.get("cursor")! : undefined;
			const rows = cursor ? await events(viewer.id, { after: cursor, limit: 200 }) : [];
			return Response.json({
				user_events: { cursor: rows.length ? rows[rows.length - 1].id : (cursor ?? (await newestId(viewer.id))), last_seen_event_id: await lastSeen(viewer.id), trusted_last_seen_event_id: await lastSeen(viewer.id), untrusted_last_seen_event_id: "0", ...(await box(viewer.id, rows)) },
			});
		}
		const timeline = /^\/1\.1\/dm\/inbox_timeline\/(trusted|untrusted|untrusted_low_quality)\.json$/.exec(path);
		if (timeline) {
			const rows = timeline[1] === "trusted" && isId(q.get("max_id") ?? "") ? await events(viewer.id, { before: q.get("max_id")! }) : [];
			return Response.json({ inbox_timeline: { status: rows.length === PAGE ? "HAS_MORE" : "AT_END", min_entry_id: rows.at(-1)?.id, ...(await box(viewer.id, rows)) } });
		}
		const conversation = /^\/1\.1\/dm\/conversation(?:\/([\d-]+))?\.json$/.exec(path);
		if (conversation) {
			let id = conversation[1];
			// looked up by its people when a new message is started
			if (!id) {
				const other = String(q.get("participant_ids") ?? "").split(",").find((p) => isId(p) && p !== viewer.id);
				if (other) id = pairId(viewer.id, other);
			}
			const pair = id ? pairOf(id) : null;
			if (!pair || !pair.includes(viewer.id)) return Response.json({ conversation_timeline: { status: "AT_END", entries: [], users: {}, conversations: {} } });
			const rows = await events(viewer.id, { conversationId: id, before: isId(q.get("max_id") ?? "") ? q.get("max_id")! : undefined });
			const b = await box(viewer.id, rows, [id!]);
			return Response.json({ conversation_timeline: { status: rows.length === PAGE ? "HAS_MORE" : "AT_END", min_entry_id: rows.at(-1)?.id, max_entry_id: rows[0]?.id, ...b } });
		}
		if (path === "/1.1/dm/permissions.json") {
			const ids = String(q.get("recipient_ids") ?? "").split(",").filter(isId).slice(0, 50);
			const keys: Obj = {};
			for (const id of ids) keys[id] = id !== viewer.id && !(await blockedBetween(viewer.id, id)) ? { can_dm: true } : { can_dm: false, error_code: 349 };
			return Response.json({ permissions: { id_keys: keys }, users: await usersFor(viewer.id, ids) });
		}
		return undefined;
	}
	if (method !== "POST") return undefined;
	const f = { ...Object.fromEntries(q), ...(await form(req)) };
	if (path === "/1.1/dm/new.json") return send(viewer, f);
	if (path === "/1.1/dm/update_last_seen_event_id.json") {
		if (isId(f.last_seen_event_id)) await sql`update users set legacy_dm_last_seen = greatest(legacy_dm_last_seen, ${f.last_seen_event_id}::bigint) where id = ${viewer.id}::bigint`;
		return new Response(null, { status: 204 });
	}
	// "typing…": nothing passes it on (the other side only polls user_updates);
	// welcome messages are a business-account feature Xitter doesn't have
	if (/^\/1\.1\/dm\/conversation\/[\d-]+\/typing\.json$/.test(path) || path === "/1.1/dm/welcome_messages/add_to_conversation.json") return new Response(null, { status: 204 });
	const convAction = /^\/1\.1\/dm\/conversation\/([\d-]+)\/(mark_read|delete)\.json$/.exec(path);
	if (convAction) {
		const [, id, what] = convAction;
		if (what === "mark_read") {
			const last = isId(f.last_read_event_id) ? f.last_read_event_id : undefined;
			if (last) await sql`update legacy_dm_participants set last_read_event_id = greatest(last_read_event_id, ${last}::bigint) where conversation_id = ${id} and user_id = ${viewer.id}::bigint`;
		} else {
			await sql`update legacy_dm_participants set left_at_event_id = (select coalesce(max(id), 0) from legacy_dm_events where conversation_id = ${id}) where conversation_id = ${id} and user_id = ${viewer.id}::bigint`;
		}
		return new Response(null, { status: 204 });
	}
	if (path === "/1.1/dm/destroy.json") {
		if (isId(f.id)) await sql`delete from legacy_dm_events where id = ${f.id}::bigint and sender_id = ${viewer.id}::bigint`;
		return new Response(null, { status: 204 });
	}
	return undefined;
}
