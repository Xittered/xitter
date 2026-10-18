// Chat: the backend of X's end-to-end encrypted chat app (XChat), which the
// client loads from the pinned chat build (server.ts, patch.ts).
//
// Messages are encrypted in the browser; this instance never sees their text.
// What it keeps: each account's public keys, conversations and who is in
// them, and every event (message, key change, read receipt, ...) as the
// sealed Thrift blob the sender built, stamped with what only the server can
// say: a sequence number, the sender, the time, and the sender's signing key.
// Events reach the other side live over the chat socket (/xchat/ws) and are
// read back by sequence number.
//
// Private keys are backed up behind a PIN with Juicebox: a Juicebox software
// realm (a separate service, see README) reached at /juicebox, with tokens this
// instance signs. Voice and video calls are not offered.

import { pictureShape } from "./model";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import type { User, Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { verifyChatToken } from "./chat-token";
import { chatMedia } from "./chat-media";
import { sql } from "./db";
import { absolute } from "./media";
import { newId } from "./ids";
import { hit } from "./ratelimit";
import * as thrift from "./thrift";
import { type Struct, bool, i32, i64, list, str, struct } from "./thrift";
import { userById, userByName } from "./users";

// --- secrets: chat tokens are signed with tokenKey, realm tokens with the
// Juicebox tenant secret. Environment first, else made once and kept in data/.

type Secrets = { tokenKey: string; realmId: string; tenantSecret: string };
const SECRETS_FILE = "data/chat-secrets.json";

function loadSecrets(): Secrets {
	let saved: Partial<Secrets> = {};
	if (existsSync(SECRETS_FILE)) saved = JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
	const s: Secrets = {
		tokenKey: process.env.CHAT_TOKEN_SECRET ?? saved.tokenKey ?? randomBytes(32).toString("hex"),
		realmId: process.env.JUICEBOX_REALM_ID ?? saved.realmId ?? randomBytes(16).toString("hex"),
		tenantSecret: process.env.JUICEBOX_TENANT_SECRET ?? saved.tenantSecret ?? randomBytes(32).toString("hex"),
	};
	if (!existsSync(SECRETS_FILE) || JSON.stringify(saved) !== JSON.stringify(s)) {
		mkdirSync("data", { recursive: true });
		writeFileSync(SECRETS_FILE, JSON.stringify(s, null, "\t"));
	}
	return s;
}
const secrets = loadSecrets();
export const JUICEBOX = {
	// where this instance reaches the realm; browsers go through /juicebox
	url: (process.env.JUICEBOX_URL ?? "http://localhost:8580").replace(/\/$/, ""),
	realmId: secrets.realmId,
	tenant: "xitter",
	tenantSecret: secrets.tenantSecret,
};

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function jwt(header: object, claims: object, key: string): string {
	const body = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
	return `${body}.${createHmac("sha256", key).update(body).digest("base64url")}`;
}
// the chat socket's token, from GenerateXChatTokenMutation
const socketToken = (userId: string) => jwt({ alg: "HS256", typ: "JWT" }, { sub: userId, exp: Math.floor(Date.now() / 1000) + 86400 }, secrets.tokenKey);
export const socketUser = (token: string): string | undefined => verifyChatToken(token, secrets.tokenKey)?.sub as string | undefined;

// what the realm accepts: kid tenant:version, iss tenant, aud realm, sub user
const realmToken = (userId: string) =>
	jwt(
		{ alg: "HS256", typ: "JWT", kid: `${JUICEBOX.tenant}:1` },
		{ iss: JUICEBOX.tenant, sub: userId, aud: JUICEBOX.realmId, scope: "user", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
		JUICEBOX.tenantSecret,
	);

// the realms a user's key backup lives on: one, ours
function tokenMap(userId: string) {
	const address = `${PUBLIC_ORIGIN}/juicebox/`;
	return {
		__typename: "KeyStoreTokenMap",
		realm_state_string: "Xitter1",
		max_guess_count: 20,
		recover_threshold: 1,
		register_threshold: 1,
		token_map: [{ __typename: "KeyStoreTokenMapEntry", key: JUICEBOX.realmId, value: { __typename: "KeyStoreTokenMapValue", token: realmToken(userId), address, public_key: null } }],
		key_store_token_map_json: JSON.stringify({
			realms: [{ id: JUICEBOX.realmId, address }],
			register_threshold: 1,
			recover_threshold: 1,
			pin_hashing_mode: "Standard2019",
		}),
	};
}

// --- users as the chat app sees them

async function hasKey(userIds: string[]): Promise<Set<string>> {
	if (!userIds.length) return new Set();
	const rows = await sql`select distinct user_id::text as id from chat_keys where user_id = any(${sql.array(userIds, "INT8")})`;
	return new Set(rows.map((r: { id: string }) => r.id));
}

function verificationOf(u: User) {
	return {
		__typename: "UserVerification",
		is_blue_verified: u.verified_type === "blue" || (!u.verified_type && !!u.org),
		is_verified_organization: u.verified_type === "business",
		is_verified_organization_affiliate: !!u.org,
		verified: false,
	};
}

function chatUser(u: User, viewerId: string, keyed: boolean, extra: object = {}) {
	const self = u.id === viewerId;
	const blocked = !!(u.stats?.blocking || u.stats?.blockedBy);
	return {
		__typename: "User",
		rest_id: u.id,
		avatar: { __typename: "UserAvatar", image_url: absolute(u.avatar_url) ?? `${PUBLIC_ORIGIN}/abs/sticky/default_profile_images/default_profile_normal.png` },
		can_pay: false,
		chat_permissions: {
			__typename: "UserDMPermissions",
			can_be_added_to_group: keyed && !blocked,
			can_dm: !blocked,
			can_dm_on_xchat: keyed && !blocked,
			can_dm_reason: blocked ? "Blocked" : "Allowed",
			dm_blocking: !!u.stats?.blocking,
			has_public_key: keyed,
			is_trusted: self || !!(u.stats?.followedByViewer || u.stats?.followsViewer),
			passes_premium_check: true,
		},
		core: { __typename: "UserCore", created_at_ms: new Date(u.created_at).getTime(), name: u.name, screen_name: u.screen_name },
		has_welcome_message: false,
		identity_profile_labels_highlighted_label: { __typename: "HighlightedUserLabelResponse" },
		privacy: { __typename: "UserPrivacy", protected: false, suspended: u.status === "suspended" },
		profile_image_shape: pictureShape(u),
		relationship_counts: { __typename: "UserRelationshipCounts", followers: u.stats?.followers ?? 0, following: u.stats?.following ?? 0 },
		super_followed_by: false,
		verification: verificationOf(u),
		...extra,
	};
}

async function userResults(viewerId: string, ids: string[], opts: { keys?: boolean; tokens?: boolean } = {}) {
	const users = (await Promise.all(ids.map((id) => userById(viewerId, id)))).filter((u): u is User => !!u);
	const keyed = await hasKey(users.map((u) => u.id));
	return Promise.all(
		users.map(async (u) => ({
			__typename: "UserResults",
			rest_id: u.id,
			result: chatUser(u, viewerId, keyed.has(u.id), opts.keys ? { get_public_keys: await publicKeys(u.id, !!opts.tokens && u.id === viewerId) } : {}),
		})),
	);
}

// --- keys

async function publicKeys(userId: string, withTokens: boolean) {
	const rows = await sql`select version::text, public_key, signing_public_key, identity_public_key_signature, registration_method
		from chat_keys where user_id = ${userId}::bigint order by version desc`;
	return {
		__typename: "GetPublicKeysResult",
		is_managed_pin_user: false,
		registration_method: rows[0]?.registration_method ?? null,
		public_keys_with_token_map: rows.map((k: any) => ({
			__typename: "PublicKeyWithTokenMap",
			public_key_with_metadata: {
				__typename: "XChatPublicKeyWithMetadata",
				version: k.version,
				public_key: {
					__typename: "XChatPublicKey",
					public_key: k.public_key,
					signing_public_key: k.signing_public_key,
					identity_public_key_signature: k.identity_public_key_signature,
					registration_method: k.registration_method,
				},
			},
			...(withTokens ? { token_map: tokenMap(userId), target_token_map: null } : {}),
		})),
	};
}

async function signingKey(userId: string, version: string | undefined): Promise<string | undefined> {
	if (version && (!/^\d{1,19}$/.test(version) || BigInt(version) > 9223372036854775807n)) throw new ChatError("Invalid public key version.");
	const [k] = version
		? await sql`select signing_public_key from chat_keys where user_id = ${userId}::bigint and version = ${version}::bigint`
		: await sql`select signing_public_key from chat_keys where user_id = ${userId}::bigint order by version desc limit 1`;
	return k?.signing_public_key;
}

// --- conversations

export class ChatError extends Error {}

// A direct conversation's id names its two members, smaller id first:
// "<a>-<b>" (older clients wrote "<a>:<b>").
function directMembers(id: string): [string, string] | undefined {
	const m = /^(\d{1,19})[-:](\d{1,19})$/.exec(id);
	return m ? [m[1], m[2]] : undefined;
}

async function members(conversationId: string): Promise<string[]> {
	const rows = await sql`select user_id::text as id from chat_members where conversation_id = ${conversationId}`;
	if (rows.length) return rows.map((r: { id: string }) => r.id);
	return directMembers(conversationId) ?? [];
}

// the viewer may write here; a direct conversation starts with its first event
async function joinable(viewerId: string, conversationId: string): Promise<string[]> {
	const pair = directMembers(conversationId);
	if (pair) {
		if (!pair.includes(viewerId)) throw new ChatError("Not a member of this conversation.");
		if (pair[0] === pair[1]) throw new ChatError("Choose another recipient.");
		await writable(viewerId, pair);
		const peer = pair.find((id) => id !== viewerId)!;
		const [trusted] = await sql`select 1 where exists (select 1 from follows where follower_id = ${peer}::bigint and followee_id = ${viewerId}::bigint)
			or exists (select 1 from chat_trust where user_id = ${peer}::bigint and trusted_id = ${viewerId}::bigint)`;
		await sql`insert into chat_members (conversation_id, user_id, accepted) values (${conversationId}, ${viewerId}::bigint, true), (${conversationId}, ${peer}::bigint, ${!!trusted})
			on conflict (conversation_id, user_id) do nothing`;
		return pair;
	}
	const all = await members(conversationId);
	if (!all.includes(viewerId)) throw new ChatError("Not a member of this conversation.");
	await writable(viewerId, all);
	return all;
}

async function writable(viewerId: string, all: string[]) {
	const users = await sql`select id::text, status from users where id = any(${sql.array(all, "INT8")})`;
	if (users.length !== new Set(all).size || users.some((user: any) => user.status === "suspended")) throw new ChatError("Account unavailable.");
	const [blocked] = await sql`select 1 from blocks where (blocker_id = ${viewerId}::bigint and blocked_id = any(${sql.array(all, "INT8")}))
		or (blocked_id = ${viewerId}::bigint and blocker_id = any(${sql.array(all, "INT8")})) limit 1`;
	if (blocked) throw new ChatError("Messaging is blocked.");
}

async function authorized(viewerId: string, conversationId: string) {
	const all = await members(conversationId);
	if (!all.includes(viewerId)) throw new ChatError("Not a member of this conversation.");
	await writable(viewerId, all);
	return all;
}

const media = chatMedia(authorized, joinable);
export const chatMediaRoute = media.route;

// the token every event of a conversation carries (field 5); the client reads
// it back from the events and signs with it
function conversationToken(viewerId: string, conversationId: string): string {
	const other = directMembers(conversationId)?.find((id) => id !== viewerId) ?? conversationId;
	return jwt({ alg: "HS256" }, { requestingUser: viewerId, recipient: other, validSinceMSec: "0" }, secrets.tokenKey);
}

// --- events

// what the server adds to an event the sender built
async function stamp(ev: Struct, senderId: string, conversationId: string): Promise<{ seq: string; ev: Struct }> {
	const seq = newId();
	ev[1] = str(seq);
	ev[3] = str(senderId);
	ev[4] = str(conversationId);
	ev[5] ??= str(conversationToken(senderId, conversationId));
	ev[6] = str(String(Date.now()));
	ev[8] = i32(3);
	ev[11] = bool(true);
	const sig = thrift.fields(ev[9]);
	if (sig) {
		const key = await signingKey(senderId, thrift.text(sig[2]));
		if (key) {
			sig[4] = str(key);
			const infos = sig[5]?.t === 15 ? sig[5].v : [];
			for (const info of infos) if (info.t === 12) info.v[3] ??= str(key);
		}
	}
	return { seq, ev };
}

// detail kinds (field 7's one field)
const KIND = { message: 1, keyChange: 3, groupChange: 4, typing: 6, delete: 7, conversationDelete: 8, read: 12, unread: 13 } as const;
const kindOf = (ev: Struct) => Number(Object.keys(thrift.fields(ev[7]) ?? {})[0] ?? 0);

async function store(seq: string, ev: Struct, senderId: string, conversationId: string, audienceId: string | null = null): Promise<Uint8Array> {
	const bytes = thrift.encode(ev);
	await sql`insert into chat_events (seq, conversation_id, sender_id, kind, event, audience_id)
		values (${seq}::bigint, ${conversationId}, ${senderId}::bigint, ${kindOf(ev)}, ${Buffer.from(bytes)}, ${audienceId}::bigint)`;
	return bytes;
}

// --- the socket: frames are Thrift structs; {1: event} and {3: {1: [events]}}
// carry events, {2: instruction} the rest (2 is keep-alive)

type SocketData = { userId: string };
const sockets = new Map<string, Set<ServerWebSocket<SocketData>>>();

function deliver(userIds: string[], events: Uint8Array[], except?: ServerWebSocket<SocketData>) {
	if (!events.length) return;
	const frame = thrift.encode(
		events.length === 1 ? { 1: struct(thrift.decode(events[0])) } : { 3: struct({ 1: list(thrift.T.struct, events.map((e) => struct(thrift.decode(e)))) }) },
	);
	for (const id of userIds) for (const ws of sockets.get(id) ?? []) if (ws !== except) ws.send(frame);
}

export function closeSockets(userId: string) {
	for (const ws of sockets.get(userId) ?? []) ws.close(4001, "suspended");
	sockets.delete(userId);
}

export const chatSocket = {
	maxPayloadLength: 64 * 1024,
	open(ws: ServerWebSocket<SocketData>) {
		if (process.env.LOG_REQUESTS) console.log(`chat socket open for ${ws.data.userId}`);
		let set = sockets.get(ws.data.userId);
		if (!set) sockets.set(ws.data.userId, (set = new Set()));
		set.add(ws);
	},
	close(ws: ServerWebSocket<SocketData>) {
		sockets.get(ws.data.userId)?.delete(ws);
	},
	async message(ws: ServerWebSocket<SocketData>, data: string | Buffer) {
		if (typeof data === "string") return;
		let frame: Struct;
		try {
			frame = thrift.decode(new Uint8Array(data));
		} catch {
			return;
		}
		// keep-alive: answered in kind
		if (frame[2]) return ws.send(thrift.encode({ 2: struct({ 2: struct({}) }) }));
		if (!hit("endpoint", `${ws.data.userId}:chat-socket`).ok) return;
		// an event sent straight to the socket: typing and the like, passed on
		// to the conversation's other members, not kept
		const ev = thrift.fields(frame[1]);
		const conversationId = ev && thrift.text(ev[4]);
		if (!ev || !conversationId || kindOf(ev) !== KIND.typing) return;
		const all = await members(conversationId);
		if (!all.includes(ws.data.userId)) return;
		try { await writable(ws.data.userId, all); } catch { return; }
		ev[3] = str(ws.data.userId);
		ev[6] = str(String(Date.now()));
		deliver(all, [thrift.encode(ev)], ws);
	},
};

function groupText(value: unknown, max: number): string | null {
	if (value == null) return null;
	if (typeof value !== "string" && typeof value !== "number") throw new ChatError("Invalid group details.");
	const text = String(value);
	if (text.length > max) throw new ChatError("Group details are too long.");
	return text;
}

// --- the inbox

type Vars = Record<string, any>;

async function conversationData(viewerId: string, conversationId: string) {
	const all = await members(conversationId);
	const latest = await sql`select e.event from chat_events e where e.conversation_id = ${conversationId} and e.kind = ${KIND.message} and not e.deleted
		and e.seq > coalesce((select deleted_before from chat_members where conversation_id = ${conversationId} and user_id = ${viewerId}::bigint), 0)
		and not exists (select 1 from chat_hidden_events h where h.user_id = ${viewerId}::bigint and h.seq = e.seq) order by e.seq desc limit 21`;
	const keys = await sql`select event from chat_events where conversation_id = ${conversationId} and kind = ${KIND.keyChange} order by seq desc limit 5`;
	const reads = await sql`select distinct on (sender_id) sender_id::text as id, event from chat_events
		where conversation_id = ${conversationId} and kind = ${KIND.read} order by sender_id, seq desc`;
	const [last] = await sql`select seq::text from chat_events where conversation_id = ${conversationId} order by seq desc limit 1`;
	const b64 = (r: { event: Buffer }) => Buffer.from(r.event).toString("base64");
	const direct = !!directMembers(conversationId);
	const [state] = await sql`select muted, archived from chat_members where conversation_id = ${conversationId} and user_id = ${viewerId}::bigint`;
	const [group] = direct ? [] : await sql`select creator_id::text, metadata from chat_conversations where id = ${conversationId}`;
	const participants = await userResults(viewerId, all);
	const notifiable = (row: { event: Buffer }) => thrift.fields(thrift.fields(thrift.decode(new Uint8Array(row.event))[7])?.[1])?.[102];
	const latestNotifiable = latest.find((row: { event: Buffer }) => notifiable(row)?.v !== false);
	const latestNonNotifiable = latest.find((row: { event: Buffer }) => notifiable(row)?.v === false);
	return {
		__typename: "XChatGetInboxPageConversationData",
		conversation_detail: {
			__typename: direct ? "XChatDirectConversationDetail" : "XChatGroupConversationDetail",
			conversation_id: conversationId,
			is_archived: !!state?.archived,
			is_muted: !!state?.muted,
			message_ttl_msec: null,
			screen_capture_blocking_enabled: false,
			is_grok_enabled: false,
			participants_results: participants,
			...(!direct && group ? {
				group_metadata: { __typename: "XChatGroupMetadata", ...group.metadata,
					admin_settings: { __typename: "XChatGroupAdminSettings", ...Object.fromEntries(
						["add_member", "edit_group_info", "send_message", "start_call", "edit_message_ttl", "block_screen_capture"].map((field) => [field, typeof group.metadata.admin_settings?.[field] === "boolean" ? group.metadata.admin_settings[field] : !["send_message", "start_call"].includes(field)]),
					) },
				},
				group_members_results: participants,
				group_admins_results: (group.metadata.admins ?? [group.creator_id]).map((id: string) => ({ __typename: "UserResults", rest_id: id })),
				group_created_by_user_results: participants.find((p) => p.rest_id === group.creator_id),
				group_removed_users_results: [], latest_group_title_change_message_event: null,
			} : {}),
		},
		latest_message_events: latest.slice(0, 20).reverse().map(b64),
		latest_conversation_key_change_events: keys.map(b64),
		latest_notifiable_message_create_event: latestNotifiable ? b64(latestNotifiable) : null,
		latest_non_notifiable_message_create_event: latestNonNotifiable ? b64(latestNonNotifiable) : null,
		latest_read_events_per_participant: reads.map((r: { id: string; event: Buffer }) => ({
			__typename: "XChatParticipantReadEvent",
			participant_id_results: { __typename: "UserResults", rest_id: r.id },
			latest_mark_conversation_read_event: b64(r),
		})),
		latest_pinned_message_events: [],
		pmk_bundle: [],
		has_more: latest.length > 20,
		latest_message_sequence_id: last?.seq ?? null,
		is_deleted_by_viewer: false,
	};
}

async function inbox(viewerId: string) {
	const convs = await sql`select m.conversation_id as id from chat_members m
		where m.user_id = ${viewerId}::bigint and m.accepted and not m.archived
		and exists (select 1 from chat_events e where e.conversation_id = m.conversation_id and e.seq > m.deleted_before)
		order by (select max(seq) from chat_events e where e.conversation_id = m.conversation_id) desc nulls last limit 50`;
	const [max] = await sql`select max(e.seq)::text as seq from chat_events e join chat_members m on m.conversation_id = e.conversation_id where m.user_id = ${viewerId}::bigint`;
	const [pending] = await sql`select count(*)::int as count from chat_members m where user_id = ${viewerId}::bigint and not accepted
		and exists (select 1 from chat_events e where e.conversation_id = m.conversation_id and e.kind = 1 and not e.deleted and e.seq > m.deleted_before)`;
	return {
		__typename: "XChatGetInboxPageResponse",
		inboxCursor: { __typename: "XChatGetInboxPageEndCursor", inbox_exhausted: true, graph_snapshot_id: newId() },
		items: await Promise.all(convs.map((c: { id: string }) => conversationData(viewerId, c.id))),
		message_requests_count: pending.count,
		message_requests_info: { __typename: "XChatMessageRequestInfo", priority_count: pending.count, hidden_count: 0, unseen_count: pending.count, relevant_users_results: [] },
		message_pull_version: 1,
		max_user_sequence_id: max?.seq ?? "0",
		latest_user_metadata_message_event: null,
		user_metadata_snapshot: { __typename: "XChatUserMetadataFieldSnapshot", pinned_conversations_event: null, nicknames_event: null, verified_users_event: null },
	};
}

// --- GraphQL operations

const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && /^\d{1,19}$/.test(x)).slice(0, 100) : []);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function decodeBlob(value: unknown): Struct {
	if (typeof value !== "string" || !value.length || value.length > 2_000_000) throw new ChatError("Invalid chat event.");
	try { return thrift.decode(thrift.fromBase64(value)); } catch { throw new ChatError("Invalid chat event."); }
}

async function actionEvents(v: Viewer, conversationId: string, actions: any[], allowed: number[]) {
	const all = await authorized(v.id, conversationId);
	validateActions(actions, allowed);
	const emitted: Uint8Array[] = [];
	for (const action of actions ?? []) {
		if (!action?.encoded_message_event_detail) throw new ChatError("Missing event detail.");
		const detail = thrift.decode(thrift.fromBase64(action.encoded_message_event_detail));
		if (!allowed.includes(Number(Object.keys(detail)[0]))) throw new ChatError("Unexpected event kind.");
		const sig = action?.message_event_signature ?? {};
		const ev: Struct = { 2: str(String(action.message_id ?? crypto.randomUUID())), 7: struct(detail),
			9: struct({ 1: str(String(sig.signature ?? "")), 2: str(String(sig.public_key_version ?? "")), 3: str(String(sig.signature_version ?? "7")) }) };
		const { seq } = await stamp(ev, v.id, conversationId);
		emitted.push(await store(seq, ev, v.id, conversationId));
	}
	if (emitted.length) deliver(all, emitted);
	return emitted.map((bytes) => thrift.text(thrift.decode(bytes)[1])!);
}

function validateActions(actions: any[], allowed: number[]) {
	if (actions == null) return;
	if (!Array.isArray(actions) || actions.length > 16) throw new ChatError("Invalid conversation actions.");
	for (const action of actions) {
		if (typeof action?.encoded_message_event_detail !== "string" || action.encoded_message_event_detail.length > 2_000_000)
			throw new ChatError("Invalid event detail.");
		let detail: Struct;
		try { detail = thrift.decode(thrift.fromBase64(action.encoded_message_event_detail)); } catch { throw new ChatError("Invalid event detail."); }
		if (Object.keys(detail).length !== 1 || !allowed.includes(Number(Object.keys(detail)[0]))) throw new ChatError("Unexpected event kind.");
	}
}

async function groupAdmin(v: Viewer, conversationId: string) {
	await authorized(v.id, conversationId);
	const [group] = await sql`select creator_id::text, metadata from chat_conversations where id = ${conversationId} and created`;
	if (!group || !(group.metadata.admins ?? [group.creator_id]).includes(v.id)) throw new ChatError("Group admin required.");
	return group;
}

async function deleteMessages(v: Viewer, vars: Vars) {
	const id = String(vars.conversation_id ?? "");
	await authorized(v.id, id);
	const seqs = ids(vars.sequence_ids);
	if (!seqs.length) throw new ChatError("Choose a message.");
	const rows = await sql`select seq::text, sender_id::text from chat_events where conversation_id = ${id} and seq = any(${sql.array(seqs, "INT8")}) and kind = 1`;
	if (rows.length !== seqs.length) throw new ChatError("Message unavailable.");
	const everyone = vars.delete_message_action === "DeleteForAll";
	if (everyone && rows.some((r: any) => r.sender_id !== v.id)) throw new ChatError("You can only delete your own messages for everyone.");
	if (everyone && vars.action_signatures?.length) {
		for (const action of vars.action_signatures) {
			const event = thrift.fields(thrift.decode(thrift.fromBase64(action.encoded_message_event_detail))[7]);
			const targets = event?.[1]?.t === thrift.T.list ? event[1].v.map(thrift.text) : [];
			if (thrift.int(event?.[2]) !== 2n || targets.length !== seqs.length || targets.some((id: string | undefined) => !id || !seqs.includes(id)))
				throw new ChatError("Delete event does not match its targets.");
		}
		await actionEvents(v, id, vars.action_signatures, [7]);
		await sql`update chat_events set deleted = true where conversation_id = ${id} and seq = any(${sql.array(seqs, "INT8")})`;
		return { data: { xchat_delete_messages: { __typename: "DeleteMessageResponse", error_code: null } } };
	}
	if (!everyone) for (const seq of seqs) await sql`insert into chat_hidden_events (user_id, seq) values (${v.id}::bigint, ${seq}::bigint) on conflict do nothing`;
	const ev: Struct = { 2: str(crypto.randomUUID()), 7: struct({ 7: struct({ 1: list(thrift.T.string, seqs.map(str)), 2: i32(everyone ? 2 : 1) }) }) };
	const { seq } = await stamp(ev, v.id, id);
	const bytes = await store(seq, ev, v.id, id, everyone ? null : v.id);
	if (everyone) await sql`update chat_events set deleted = true where conversation_id = ${id} and seq = any(${sql.array(seqs, "INT8")})`;
	deliver(everyone ? await members(id) : [v.id], [bytes]);
	return { data: { xchat_delete_messages: { __typename: "DeleteMessageResponse", error_code: null } } };
}

export const chatHandlers: Record<string, (viewer: Viewer, vars: Vars) => Promise<unknown> | unknown> = {
	...media.handlers,
	GetConversationEntryDetailsQuery: async (v, vars) => {
		await authorized(v.id, String(vars.conversation_id));
		return { data: { get_conversation_entry_details: { __typename: "XChatGetConversationEntryDetailsResponse", group_type: "Normal", read_only_reason: null } } };
	},
	InitializeGroupConversationMutation: async (v) => {
		const id = `g${newId()}`;
		await sql`insert into chat_conversations (id, creator_id) values (${id}, ${v.id}::bigint)`;
		return { data: { xchat_initialize_group: { __typename: "XChatInitializeGroupResponse", error_code: null,
			conversation_id: { __typename: "ConversationId", id, rest_id: id } } } };
	},
	CreateGroupConversationMutation: async (v, vars) => {
		validateActions(vars.action_signatures, [3, 4]);
		const id = String(vars.conversation_id ?? "");
		const [draft] = await sql`select creator_id::text, created from chat_conversations where id = ${id}`;
		if (!draft || draft.creator_id !== v.id || draft.created) throw new ChatError("Invalid group draft.");
		const all = [...new Set([v.id, ...ids(vars.member_user_ids), ...ids(vars.admin_user_ids)])];
		if (all.length < 2 || all.length > 100) throw new ChatError("Groups need 2–100 members.");
		await writable(v.id, all);
		const admins = [...new Set([v.id, ...ids(vars.admin_user_ids)])];
		const now = String(Date.now());
		const metadata = { group_name: groupText(vars.group_title, 4000) ?? "", description: "", description_ckey_version: groupText(vars.conversation_key_version, 40) ?? "1",
			created_at_msec: now, updated_at_msec: now, group_avatar_url: groupText(vars.avatar_url, 2048), message_ttl_msec: Number.isFinite(Number(vars.ttl_msec)) && vars.ttl_msec != null ? String(Math.max(0, Math.min(Number(vars.ttl_msec), 31_536_000_000))) : null,
			classification: { __typename: "XChatGroupClassification", group_type: vars.group_type === "Normal" || vars.group_type == null ? "Normal" : (groupText(vars.group_type, 40) ?? "Normal") },
			group_invite_details: null, screen_capture_blocking_enabled: false, is_grok_enabled: false,
			admin_settings: { __typename: "XChatGroupAdminSettings", add_member: true, edit_group_info: true, send_message: false, start_call: false, edit_message_ttl: true, block_screen_capture: true }, admins };
		await sql.begin(async (tx) => {
			await tx`update chat_conversations set metadata = ${JSON.stringify(metadata)}::text::jsonb, created = true where id = ${id}`;
			for (const member of all) await tx`insert into chat_members (conversation_id, user_id) values (${id}, ${member}::bigint)`;
		});
		const seqs = await actionEvents(v, id, vars.action_signatures, [3, 4]);
		let keySeq = seqs[0] ?? null;
		if (vars.conversation_participant_keys?.length && !(vars.action_signatures ?? []).some((action: any) => thrift.decode(thrift.fromBase64(action.encoded_message_event_detail))[3])) {
			const key: any = await chatHandlers.AddEncryptedConversationKeysMutation(v, { ...vars, action_signatures: [] });
			keySeq = key.data.xchat_add_encrypted_conversation_key.conversation_key_change_sequence_id;
		}
		return { data: { xchat_create_group: { __typename: "CreateGroupConversationResult", conversation_id: { __typename: "ConversationId", id, rest_id: id }, conversation_key_change_sequence_id: keySeq } } };
	},
	EditGroupConversationMutation: async (v, vars) => {
		validateActions(vars.action_signatures, [3, 4]);
		const id = String(vars.conversation_id ?? "");
		const group = await groupAdmin(v, id);
		const metadata = { ...group.metadata, updated_at_msec: String(Date.now()) };
		for (const [input, output, max] of [["group_name", "group_name", 4000], ["group_description", "description", 8000], ["avatar_url", "group_avatar_url", 2048]] as const)
			if (vars[input] != null) metadata[output] = groupText(vars[input], max);
		metadata.description_ckey_version = groupText(vars.conversation_key_version, 40);
		await sql`update chat_conversations set metadata = ${JSON.stringify(metadata)}::text::jsonb where id = ${id}`;
		const seqs = await actionEvents(v, id, vars.action_signatures, [3, 4]);
		return { data: { xchat_edit_group: { __typename: "EditGroupConversationResult", conversation_key_change_sequence_id: seqs[0] ?? null } } };
	},
	DeleteMessageMutation: deleteMessages,
	ConversationDeleteMutation: async (v, vars) => {
		const id = String(vars.conversation_id ?? "");
		await authorized(v.id, id);
		const [latest] = await sql`select max(seq)::text as seq from chat_events where conversation_id = ${id}`;
		await sql`update chat_members set deleted_before = ${latest.seq ?? "0"}::bigint where conversation_id = ${id} and user_id = ${v.id}::bigint`;
		return { data: { xchat_delete_conversation: { __typename: "DeleteConversationResponse", error_code: null } } };
	},
	MuteConversationMutation: async (v, vars) => {
		for (const id of vars.conversationIds ?? []) { await authorized(v.id, String(id)); await sql`update chat_members set muted = true where conversation_id = ${String(id)} and user_id = ${v.id}::bigint`; }
		return { data: { xchat_mute_conversation: { __typename: "MuteXChatConversationResponse", error_code: null } } };
	},
	ArchiveConversationMutation: async (v, vars) => {
		const id = String(vars.conversationId ?? ""); await authorized(v.id, id);
		await sql`update chat_members set archived = true where conversation_id = ${id} and user_id = ${v.id}::bigint`;
		return { data: { xchat_archive_conversation: { __typename: "ArchiveXChatConversationResponse", error_code: null } } };
	},
	UnmuteConversationMutation: async (v, vars) => {
		for (const id of vars.conversationIds ?? []) { await authorized(v.id, String(id)); await sql`update chat_members set muted = false where conversation_id = ${String(id)} and user_id = ${v.id}::bigint`; }
		return { data: { xchat_unmute_conversation: { __typename: "MuteXChatConversationResponse", error_code: null } } };
	},
	UnarchiveConversationMutation: async (v, vars) => {
		const id = String(vars.conversationId ?? ""); await authorized(v.id, id);
		await sql`update chat_members set archived = false where conversation_id = ${id} and user_id = ${v.id}::bigint`;
		return { data: { xchat_unarchive_conversation: { __typename: "ArchiveXChatConversationResponse", error_code: null } } };
	},
	AddGroupMembersMutation: async (v, vars) => {
		validateActions(vars.action_signatures, [3, 4]);
		const id = String(vars.conversation_id ?? "");
		await groupAdmin(v, id);
		const added = ids(vars.user_ids);
		const all = [...new Set([...await members(id), ...added])];
		if (all.length > 100) throw new ChatError("Group is full.");
		await writable(v.id, all);
		for (const member of added) await sql`insert into chat_members (conversation_id, user_id) values (${id}, ${member}::bigint) on conflict do nothing`;
		const seqs = await actionEvents(v, id, vars.action_signatures, [3, 4]);
		return { data: { xchat_add_group_members: { __typename: "AddGroupMembersResponse", error_code: null,
			current_member_ids_results: all.map((user) => ({ __typename: "UserResults", id: user, rest_id: user })), conversation_key_change_sequence_id: seqs[0] ?? null } } };
	},
	RemoveFromGroupMutation: async (v, vars) => {
		validateActions(vars.action_signatures, [3, 4, 14]);
		const id = String(vars.conversation_id ?? "");
		const removed = ids(vars.user_ids);
		const self = removed.length === 1 && removed[0] === v.id;
		const all = await authorized(v.id, id);
		if (!self) await groupAdmin(v, id);
		const seqs = await actionEvents(v, id, vars.action_signatures, [3, 4, 14]);
		for (const member of removed) await sql`delete from chat_members where conversation_id = ${id} and user_id = ${member}::bigint`;
		const [group] = await sql`select creator_id::text, metadata from chat_conversations where id = ${id}`;
		if (group) {
			group.metadata.admins = (group.metadata.admins ?? [group.creator_id]).filter((user: string) => !removed.includes(user));
			if (!group.metadata.admins.length) group.metadata.admins = all.filter((user) => !removed.includes(user)).slice(0, 1);
			await sql`update chat_conversations set metadata = ${JSON.stringify(group.metadata)}::text::jsonb where id = ${id}`;
		}
		return { data: { xchat_remove_group_members: { __typename: "RemoveGroupMembersResponse", error_code: null, conversation_key_change_sequence_id: seqs[0] ?? null } } };
	},
	xChatDmSettingsQuery: () => ({
		data: {
			dm_settings: {
				__typename: "DmSettings",
				allow_dms_from: "all",
				dm_quality_filter: "disabled",
				av_settings: {
					__typename: "AvSettings",
					has_av_calls_enabled: false,
					av_call_permissions: { accept_calls_from_addressbook: false, accept_calls_from_everyone: false, accept_calls_from_following: false, accept_calls_from_verified: false },
				},
			},
		},
	}),
	// calls run on X's Periscope servers; none here
	useDirectCallSetupQuery: () => ({ data: { authenticate_periscope: null } }),
	GetExternalAppIntegrationsQuery: () => ({ data: { get_external_app_integrations: { __typename: "ExternalAppIntegrations", integrations: [] } } }),
	viewerQuery: async (v) => {
		const [me] = await userResults(v.id, [v.id]);
		return { data: { viewer: { claims: [], is_active_creator: false, user_results: { id: Buffer.from(`User:${v.id}`).toString("base64"), ...me } } } };
	},
	GenerateXChatTokenMutation: (v) => ({ data: { user_get_x_chat_auth_token: { __typename: "XChatGetAuthTokenResponse", token: socketToken(v.id) } } }),

	GetPublicKeysQuery: async (v, vars) => ({
		data: {
			user_results_by_rest_ids: (await userResults(v.id, ids(vars.ids), { keys: true, tokens: !!vars.include_juicebox_tokens })).map((r) => ({
				...r,
				id: Buffer.from(`UserResults:${r.rest_id}`).toString("base64"),
			})),
		},
	}),
	AddXChatPublicKeyMutation: async (v, vars) => {
		const k = vars.public_key ?? {};
		const long = [k.public_key, k.signing_public_key, k.identity_public_key_signature, k.registration_method].some((x) => x != null && (typeof x !== "string" || x.length > 4096));
		const [keys] = await sql`select count(*)::int as n from chat_keys where user_id = ${v.id}::bigint`;
		if (long || keys.n >= 200 || typeof k.public_key !== "string" || typeof k.signing_public_key !== "string")
			return { data: { user_add_public_key: { __typename: "AddPublicKeyResponse", error_code: "InvalidPublicKey", version: null, token_map: null } } };
		const [last] = await sql`select max(version)::text as v from chat_keys where user_id = ${v.id}::bigint`;
		const version = vars.generate_version || !/^\d+$/.test(String(vars.version ?? "")) ? String(BigInt(last?.v ?? "0") + 1n) : String(vars.version);
		await sql`insert into chat_keys (user_id, version, public_key, signing_public_key, identity_public_key_signature, registration_method)
			values (${v.id}::bigint, ${version}::bigint, ${k.public_key}, ${k.signing_public_key}, ${k.identity_public_key_signature ?? ""}, ${k.registration_method ?? "CustomPin"})
			on conflict (user_id, version) do update set public_key = excluded.public_key, signing_public_key = excluded.signing_public_key,
				identity_public_key_signature = excluded.identity_public_key_signature, registration_method = excluded.registration_method`;
		return { data: { user_add_public_key: { __typename: "AddPublicKeyResponse", error_code: null, version, token_map: tokenMap(v.id) } } };
	},
	UpdateXChatUserRealmStateMutation: () => ({ data: { xchat_update_user_key_version_realm_state: { __typename: "UpdateRealmStateResponse", error_code: null } } }),

	GetUsersByIdsForXChat: async (v, vars) => ({
		data: {
			get_member_results: {
				__typename: "XChatMemberResults",
				results: (await userResults(v.id, ids(vars.ids), { keys: !!vars.include_user_public_keys })).map((r) => ({
					__typename: "XChatMemberResult",
					id: r.rest_id,
					status: "Found",
					member_results: r,
				})),
			},
		},
	}),
	GetUsersByScreenNameForXChat: async (v, vars) => {
		const names: string[] = Array.isArray(vars.screen_names) ? vars.screen_names.filter((x: unknown) => typeof x === "string").slice(0, 50) : [];
		const found = (await Promise.all(names.map((n) => userByName(v.id, n)))).filter((u): u is User => !!u);
		const results = await userResults(v.id, found.map((u) => u.id), { keys: !!vars.include_user_public_keys, tokens: !!vars.include_juicebox_tokens });
		return {
			data: {
				get_member_results_by_screen_name: {
					__typename: "XChatMemberResults",
					results: results.map((r) => ({ __typename: "XChatMemberResult", id: r.rest_id, status: "Found", member_results: r })),
				},
			},
		};
	},
	TypeaheadXChatQuery: async (v, vars) => {
		const q = String(vars.query ?? "").trim().replace(/^@/, "");
		// with nothing typed: the accounts the viewer follows
		const rows = q
			? await sql`select id::text from users where status <> 'suspended' and (screen_name ilike ${`${q}%`} or name ilike ${`%${q}%`}) order by (lower(screen_name) = lower(${q})) desc, screen_name limit 10`
			: await sql`select u.id::text from follows f join users u on u.id = f.followee_id where f.follower_id = ${v.id}::bigint and u.status <> 'suspended' order by f.created_at desc limit 10`;
		const results = await userResults(v.id, rows.map((r: { id: string }) => r.id), { keys: !!vars.include_user_public_keys, tokens: !!vars.include_juicebox_tokens });
		return {
			data: {
				search_by_raw_query: {
					__typename: "SearchQuery",
					x_chat_users_typeahead: results.map((r) => ({
						__typename: "TypeaheadXChatUserItem",
						typeahead_user: { __typename: "TypeaheadUserItem", user_results: r, metadata: { __typename: "TypeaheadMetadata", source: "Search" } },
					})),
				},
			},
		};
	},

	GetInitialXChatPageQuery: async (v) => ({ data: { get_initial_chat_page: await inbox(v.id) } }),
	GetInboxPageRequestQuery: async (v) => ({ data: { get_inbox_page: await inbox(v.id) } }),
	GetInboxPageConversationDataQuery: async (v, vars) => {
		const id = String(vars.conversation_id ?? "");
		if (!(await members(id)).includes(v.id)) return { data: { get_inbox_page_conversation_data: null } };
		return { data: { get_inbox_page_conversation_data: await conversationData(v.id, id) } };
	},
	GetMessageRequestsPageQuery: async (v) => {
		const rows = await sql`select conversation_id from chat_members m where user_id = ${v.id}::bigint and not accepted
			and exists (select 1 from chat_events e where e.conversation_id = m.conversation_id and e.kind = 1 and not e.deleted and e.seq > m.deleted_before)
			order by joined_at desc limit 100`;
		const items = await Promise.all(rows.map(async (r: { conversation_id: string }) => {
			const data = await conversationData(v.id, r.conversation_id);
			const incoming = data.latest_message_events.filter((encoded: string) => {
				const event = thrift.decode(thrift.fromBase64(encoded));
				return thrift.text(event[3]) !== v.id && thrift.fields(thrift.fields(event[7])?.[1])?.[102]?.v !== false;
			});
			return { __typename: "XChatMessageRequestItem", conversation_id: r.conversation_id,
				encoded_conversation_key_change_events: data.latest_conversation_key_change_events,
				encoded_message_create_event: incoming.at(-1) ?? null,
				latest_message_events: incoming, latest_read_events_per_participant: data.latest_read_events_per_participant,
				message_request_type: "YouMayKnow", social_proof_users_results: [],
			};
		}));
		return { data: { get_message_requests_page: { __typename: "XChatGetMessageRequestsPageResponse", total_count: items.length,
			cursor: { __typename: "XChatGetMessageRequestsPageEndCursor", pull_finished: true }, message_request_items: items } } };
	},
	AcceptMessageRequestMutation: async (v, vars) => {
		const target = String(vars.targetUserId ?? "");
		if (!ids([target]).length || target === v.id) throw new ChatError("Invalid recipient.");
		await writable(v.id, [v.id, target]);
		await sql`insert into chat_trust (user_id, trusted_id) values (${v.id}::bigint, ${target}::bigint) on conflict do nothing`;
		await sql`update chat_members m set accepted = true where user_id = ${v.id}::bigint
			and exists (select 1 from chat_members peer where peer.conversation_id = m.conversation_id and peer.user_id = ${target}::bigint)`;
		let key: any = null, sent: any = null;
		if (vars.add_ckey) key = await chatHandlers.AddEncryptedConversationKeysMutation(v, vars.add_ckey);
		if (vars.send_mce) sent = await chatHandlers.SendMessageCreateMutation(v, vars.send_mce);
		return { data: { user_add_trust: { __typename: "XChatAddTrustResponse", error_code: null,
			send_message_create_event_response: sent?.data?.xchat_send_create_message_event ?? null,
			add_encrypted_conversation_key_response: key?.data?.xchat_add_encrypted_conversation_key ?? null } } };
	},
	GetConversationPageQuery: async (v, vars) => {
		const id = String(vars.conversation_id ?? "");
		const empty = { __typename: "XChatGetConversationPageResponse", encoded_message_events: [], missing_conversation_key_change_events: [], has_more: false, message_request_state: "None" };
		if (!(await members(id)).includes(v.id)) return { data: { get_conversation_page: empty } };
		const [state] = await sql`select accepted, deleted_before::text from chat_members where conversation_id = ${id} and user_id = ${v.id}::bigint`;
		const [pendingPeer] = await sql`select 1 from chat_members where conversation_id = ${id} and user_id <> ${v.id}::bigint and not accepted limit 1`;
		const limit = Math.min(Number(vars.query_settings?.conversation_event_limit) || 50, 100);
		// older than what the client has (min_local_sequence_id is its oldest), newest first
		const before = /^\d+$/.test(String(vars.min_local_sequence_id ?? "")) && vars.min_local_sequence_id !== "0" ? String(vars.min_local_sequence_id) : null;
		const rows = before
			? await sql`select e.event from chat_events e where conversation_id = ${id} and seq < ${before}::bigint and seq > ${state?.deleted_before ?? "0"}::bigint and kind <> ${KIND.keyChange}
				and not e.deleted and (e.audience_id is null or e.audience_id = ${v.id}::bigint)
				and not exists (select 1 from chat_hidden_events h where h.user_id = ${v.id}::bigint and h.seq = e.seq) order by seq desc limit ${limit + 1}`
			: await sql`select e.event from chat_events e where conversation_id = ${id} and seq > ${state?.deleted_before ?? "0"}::bigint and kind <> ${KIND.keyChange}
				and not e.deleted and (e.audience_id is null or e.audience_id = ${v.id}::bigint)
				and not exists (select 1 from chat_hidden_events h where h.user_id = ${v.id}::bigint and h.seq = e.seq) order by seq desc limit ${limit + 1}`;
		const minKey = /^\d+$/.test(String(vars.min_conversation_key_version ?? "")) ? BigInt(vars.min_conversation_key_version) : 0n;
		const keys = await sql`select event from chat_events where conversation_id = ${id} and kind = ${KIND.keyChange} order by seq`;
		const missing = keys.filter((r: { event: Buffer }) => {
			const version = thrift.text(thrift.fields(thrift.fields(thrift.decode(new Uint8Array(r.event))[7])?.[3])?.[1]);
			return !version || minKey === 0n || BigInt(version) <= minKey;
		});
		return {
			data: {
				get_conversation_page: {
					...empty,
					message_request_state: state?.accepted === false ? "Received" : pendingPeer ? "Sent" : "None",
					encoded_message_events: rows.slice(0, limit).map((r: { event: Buffer }) => b64(r.event)),
					missing_conversation_key_change_events: missing.map((r: { event: Buffer }) => b64(r.event)),
					has_more: rows.length > limit,
				},
			},
		};
	},
	GetMessageEventsBySequenceIdQuery: async (v, vars) => {
		const seqs = ids(vars.sequence_ids);
		const rows = seqs.length
			? await sql`select e.seq::text, e.kind, e.event from chat_events e join chat_members m on m.conversation_id = e.conversation_id and m.user_id = ${v.id}::bigint
				where e.seq = any(${sql.array(seqs, "INT8")}) and not e.deleted and (e.audience_id is null or e.audience_id = ${v.id}::bigint)
				and e.seq > m.deleted_before and not exists (select 1 from chat_hidden_events h where h.user_id = ${v.id}::bigint and h.seq = e.seq)`
			: [];
		const found = new Set(rows.map((r: { seq: string }) => r.seq));
		return {
			data: {
				get_message_events_by_sequence_id: {
					__typename: "XChatGetMessageEventsBySequenceIdResponse",
					encoded_message_events: rows.filter((r: any) => r.kind !== KIND.keyChange).map((r: any) => b64(r.event)),
					encoded_conversation_key_change_events: rows.filter((r: any) => r.kind === KIND.keyChange).map((r: any) => b64(r.event)),
					not_found_sequence_ids: seqs.filter((s) => !found.has(s)),
				},
			},
		};
	},
	// everything newer than the client's newest, after a reconnect
	GetMessageEventsPageQuery: async (v, vars) => {
		const after = /^\d+$/.test(String(vars.continue_cursor?.max_local_sequence_id ?? "")) ? String(vars.continue_cursor.max_local_sequence_id) : "0";
		const limit = 200;
		const rows = await sql`select e.seq::text, e.event from chat_events e join chat_members m on m.conversation_id = e.conversation_id and m.user_id = ${v.id}::bigint
			where e.seq > ${after}::bigint and not e.deleted and e.seq > m.deleted_before and (e.audience_id is null or e.audience_id = ${v.id}::bigint)
			and not exists (select 1 from chat_hidden_events h where h.user_id = ${v.id}::bigint and h.seq = e.seq) order by e.seq limit ${limit + 1}`;
		const page = rows.slice(0, limit);
		return {
			data: {
				get_message_events_page: {
					__typename: "XChatGetMessageEventsPageResponse",
					cursor:
						rows.length > limit
							? { __typename: "XChatGetMessageEventsPageContinueCursor", max_local_sequence_id: page[page.length - 1].seq }
							: { __typename: "XChatGetMessageEventsPageEndCursor", pull_finished: true },
					encoded_message_events: page.map((r: any) => b64(r.event)),
					message_requests_count: 0,
					message_requests_info: null,
					error_code: null,
				},
			},
		};
	},

	// a conversation key, wrapped for each member's public key
	AddEncryptedConversationKeysMutation: async (v, vars) => {
		const conversationId = String(vars.conversation_id ?? "");
		const all = await joinable(v.id, conversationId);
		const action = Array.isArray(vars.action_signatures) ? vars.action_signatures[0] : undefined;
		const wrapped = Array.isArray(vars.conversation_participant_keys) ? vars.conversation_participant_keys : [];
		if (wrapped.length > 200 || wrapped.some((p: any) => String(p?.encrypted_conversation_key ?? "").length > 8192 || String(p?.user_id ?? "").length > 20 || String(p?.public_key_version ?? "").length > 20))
			throw new ChatError("Too many keys.");
		if (!action?.encoded_message_event_detail && (!wrapped.length || all.some((id) => !wrapped.some((p: any) => p.user_id === id))))
			throw new ChatError("Missing the key change.");
		const sig = action?.message_event_signature ?? {};
		const ev: Struct = {
			2: str(String(action?.message_id ?? crypto.randomUUID())),
			7: struct(action?.encoded_message_event_detail ? decodeBlob(action.encoded_message_event_detail) : {
				3: struct({ 1: str(String(vars.conversation_key_version)), 2: list(thrift.T.struct, wrapped.map((p: any) => struct({
					1: str(String(p.user_id)), 2: str(String(p.encrypted_conversation_key)), 3: str(String(p.public_key_version)),
				}))), 5: bool(!!vars.base64_encoded_key_rotation) }),
			}),
			9: struct({
				1: str(String(sig.signature ?? "")),
				2: str(String(sig.public_key_version ?? "")),
				3: str(String(sig.signature_version ?? "7")),
				5: list(thrift.T.struct, [struct({ 1: str(v.id), 2: str(String(sig.public_key_version ?? "")) })]),
			}),
		};
		if (kindOf(ev) !== KIND.keyChange) throw new ChatError("Expected a conversation key change.");
		const { seq } = await stamp(ev, v.id, conversationId);
		deliver(all, [await store(seq, ev, v.id, conversationId)]);
		return { data: { xchat_add_encrypted_conversation_key: { __typename: "AddEncryptedConversationKeyResponse", conversation_key_change_sequence_id: seq } } };
	},
	SendMessageCreateMutation: async (v, vars) => {
		const conversationId = String(vars.conversation_id ?? "");
		const all = await joinable(v.id, conversationId);
		const mce = decodeBlob(vars.encoded_message_create_event);
		mce[104] = i64(Date.now());
		const [request] = await sql`select 1 from chat_members where conversation_id = ${conversationId} and user_id <> ${v.id}::bigint and not accepted`;
		mce[109] = bool(!!request);
		await sql`update chat_members set accepted = true, archived = false where conversation_id = ${conversationId} and user_id = ${v.id}::bigint`;
		const peer = directMembers(conversationId)?.find((id) => id !== v.id);
		if (peer) await sql`insert into chat_trust (user_id, trusted_id) values (${v.id}::bigint, ${peer}::bigint) on conflict do nothing`;
		const ev: Struct = {
			2: str(String(vars.message_id ?? crypto.randomUUID())),
			...(vars.conversation_token ? { 5: str(String(vars.conversation_token)) } : {}),
			7: struct({ 1: struct(mce) }),
			...(vars.encoded_message_event_signature ? { 9: struct(decodeBlob(vars.encoded_message_event_signature)) } : {}),
		};
		const { seq } = await stamp(ev, v.id, conversationId);
		const bytes = await store(seq, ev, v.id, conversationId);
		deliver(all, [bytes]);
		return { data: { xchat_send_create_message_event: { __typename: "XChatSendMessageCreateEventResponse", encoded_message_event: b64(bytes) } } };
	},
	// any other event the client builds whole: read receipts, deletes, ...
	SendMessageEventMutation: async (v, vars) => {
		const ev = decodeBlob(vars.encoded_message_event);
		const conversationId = thrift.text(ev[4]) ?? "";
		const all = await joinable(v.id, conversationId);
		if (![1, 6, 9, 12, 13, 17, 18, 19].includes(kindOf(ev))) throw new ChatError("Use the conversation action for this event.");
		const { seq } = await stamp(ev, v.id, conversationId);
		const bytes = await store(seq, ev, v.id, conversationId);
		deliver(all, [bytes]);
		return { data: { xchat_send_message_event: { __typename: "XChatSendMessageEventResponse", encoded_message_event: b64(bytes) } } };
	},
};

export const knownChatOperation = (name: string) => name in chatHandlers;

// the browser's way to the Juicebox realm
export async function juiceboxProxy(req: Request, path: string): Promise<Response> {
	// the SDK's own headers (X-Juicebox-Version, the realm token) go along; the
	// instance's cookies don't
	const headers = new Headers(req.headers);
	for (const h of ["cookie", "host", "connection", "content-length", "accept-encoding"]) headers.delete(h);
	const res = await fetch(`${JUICEBOX.url}/${path}`, {
		method: req.method,
		headers,
		body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
	}).catch(() => undefined);
	if (!res) return new Response("key backup is unavailable", { status: 503 });
	return new Response(await res.arrayBuffer(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/octet-stream" } });
}
