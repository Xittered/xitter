import { createUser } from "../src/auth";
import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setBlock } from "../src/blocks";
import { sql } from "../src/db";
import * as thrift from "../src/thrift";
import { bin, i32, list, str, struct } from "../src/thrift";
import { content, eciesWrap, encryptBody, generateKeyMaterial, messageCreateEvent, secretstreamDecrypt, secretstreamEncrypt } from "../node_modules/emusks/src/helpers/xchat-crypto.js";
import { buildCKeyMap, decodeMessageEvent } from "../node_modules/emusks/src/helpers/xchat-decode.js";

const origin = process.env.TEST_ORIGIN ?? "http://localhost:3000";
const password = crypto.randomUUID();
const suffix = Date.now().toString(36);
const accounts: { id: string; cookie: string; csrf: string }[] = [];
const conversations: string[] = [];
const sockets: WebSocket[] = [];
let checks = 0;
function check(label: string, ok: unknown) {
	if (!ok) throw new Error(label);
	checks++;
	console.log(`ok  ${label}`);
}
const b64 = (s: thrift.Struct) => Buffer.from(thrift.encode(s)).toString("base64");
async function gql(account: typeof accounts[number], name: string, variables: object = {}) {
	const response = await fetch(`${origin}/i/api/graphql/test/${name}`, { method: "POST",
		headers: { cookie: account.cookie, "x-csrf-token": account.csrf, "content-type": "application/json" }, body: JSON.stringify({ variables }) });
	if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
	return response.json();
}
async function send(account: typeof accounts[number], conversation: string, event = { 100: bin(crypto.getRandomValues(new Uint8Array(32))) }) {
	return gql(account, "SendMessageCreateMutation", { conversation_id: conversation, message_id: crypto.randomUUID(), encoded_message_create_event: b64(event) });
}
const detail = (kind: number, fields: thrift.Struct) => b64({ 2: str(crypto.randomUUID()), 4: str(conversations[0]), 7: struct({ [kind]: struct(fields) }) });
async function socket(account: typeof accounts[number]) {
	const token = (await gql(account, "GenerateXChatTokenMutation")).data.user_get_x_chat_auth_token.token;
	const ws = new WebSocket(`${origin.replace("http", "ws")}/xchat/ws?token=${encodeURIComponent(token)}`);
	ws.binaryType = "arraybuffer";
	await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("socket failed")); });
	sockets.push(ws);
	return ws;
}
function nextFrame(ws: WebSocket) {
	return new Promise<thrift.Struct>((resolve, reject) => {
		const timer = setTimeout(() => { ws.removeEventListener("message", handler); reject(new Error("socket delivery timed out")); }, 3000);
		const handler = (event: MessageEvent) => { clearTimeout(timer); ws.removeEventListener("message", handler); resolve(thrift.decode(new Uint8Array(event.data))); };
		ws.addEventListener("message", handler);
	});
}

try {
	for (let i = 0; i < 3; i++) {
		const name = `chat${suffix}${i}`;
		const id = await createUser(name, name, password);
		const response = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
		const cookies = response.headers.getSetCookie().map((value) => value.split(";")[0]);
		accounts.push({ id, cookie: cookies.join("; "), csrf: cookies.find((value) => value.startsWith("ct0="))!.slice(4) });
	}
	const [a, b, outsider] = accounts;
	const identities = await Promise.all(accounts.map(() => generateKeyMaterial()));
	for (let i = 0; i < accounts.length; i++) {
		const key = identities[i];
		await gql(accounts[i], "AddXChatPublicKeyMutation", { generate_version: true, public_key: { public_key: key.publicKeyB64,
			signing_public_key: key.signingPublicKeyB64, identity_public_key_signature: key.identitySignatureB64, registration_method: "CustomPin" } });
	}
	const published = (await gql(a, "GetPublicKeysQuery", { ids: [a.id, b.id], include_juicebox_tokens: true })).data.user_results_by_rest_ids;
	check("viewer receives own realm token", !!published[0].result.get_public_keys.public_keys_with_token_map[0].token_map);
	check("another user's realm token stays private", !published[1].result.get_public_keys.public_keys_with_token_map[0].token_map);
	const conversation = [a.id, b.id].sort().join(":"); conversations.push(conversation);
	const receiver = await socket(b);
	const frame = nextFrame(receiver);
	const first = await send(a, conversation);
	const event = thrift.decode(thrift.fromBase64(first.data.xchat_send_create_message_event.encoded_message_event));
	const seq = thrift.text(event[1])!;
	check("message stamped with authenticated sender", thrift.text(event[3]) === a.id);
	check("message delivered live to recipient", thrift.text(thrift.fields((await frame)[1])?.[1]) === seq);
	const second = await send(a, conversation);
	const seq2 = thrift.text(thrift.decode(thrift.fromBase64(second.data.xchat_send_create_message_event.encoded_message_event))[1])!;
	const data = (await gql(a, "GetInboxPageConversationDataQuery", { conversation_id: conversation })).data.get_inbox_page_conversation_data;
	check("inbox messages ordered oldest first", thrift.text(thrift.decode(thrift.fromBase64(data.latest_message_events.at(-1)))[1]) === seq2);
	check("inbox latest message uses newest event", thrift.text(thrift.decode(thrift.fromBase64(data.latest_notifiable_message_create_event))[1]) === seq2);
	check("newest timestamp is current", Math.abs(Number(thrift.text(thrift.decode(thrift.fromBase64(data.latest_notifiable_message_create_event))[6])) - Date.now()) < 3000);
	const trustOf = async () => (await gql(b, "GetPublicKeysQuery", { ids: [a.id] })).data.user_results_by_rest_ids[0]?.result.chat_permissions.is_trusted;
	check("a stranger isn't trusted before accepting", (await trustOf()) === false);
	check("non-followers receive a request", (await gql(b, "GetMessageRequestsPageQuery")).data.get_message_requests_page.total_count === 1);
	check("request not included in normal inbox", (await gql(b, "GetInitialXChatPageQuery")).data.get_initial_chat_page.items.length === 0);
	check("request state matches client enum", (await gql(b, "GetConversationPageQuery", { conversation_id: conversation })).data.get_conversation_page.message_request_state === "Received");
	check("sender sees the sent request state", (await gql(a, "GetConversationPageQuery", { conversation_id: conversation })).data.get_conversation_page.message_request_state === "Sent");
	await gql(b, "AcceptMessageRequestMutation", { targetUserId: a.id });
	check("accepting trusts the sender, so the client stops asking", (await trustOf()) === true);
	check("accepting clears pending request", (await gql(b, "GetMessageRequestsPageQuery")).data.get_message_requests_page.total_count === 0);
	check("accepted conversation appears in inbox", (await gql(b, "GetInitialXChatPageQuery")).data.get_initial_chat_page.items.length === 1);
	const requestFlags = async (account: typeof a) => {
		const page = (await gql(account, "GetConversationPageQuery", { conversation_id: conversation })).data.get_conversation_page.encoded_message_events as string[];
		return page.map((e) => thrift.fields(thrift.fields(thrift.decode(thrift.fromBase64(e))[7])?.[1])?.[109]?.v);
	};
	const flagsAfter = await requestFlags(b);
	check("messages sent before accepting no longer say they're requests", flagsAfter.length >= 2 && flagsAfter.every((f) => f === false));
	check("nor for the sender", (await requestFlags(a)).every((f) => f === false));
	const conversationKey = crypto.getRandomValues(new Uint8Array(32));
	const wrapped = await Promise.all([a, b].map(async (account, i) => ({ user_id: account.id, public_key_version: "1",
		encrypted_conversation_key: await eciesWrap(conversationKey, Buffer.from(identities[i].publicKeyB64, "base64")) })));
	await gql(a, "AddEncryptedConversationKeysMutation", { conversation_id: conversation, conversation_key_version: "1", conversation_participant_keys: wrapped });
	const keyPage = (await gql(b, "GetConversationPageQuery", { conversation_id: conversation })).data.get_conversation_page;
	const recoveredKeys = await buildCKeyMap(keyPage.missing_conversation_key_change_events, b.id, identities[1].identity.privateKey);
	check("recipient unwraps conversation key with emusks", Buffer.from(recoveredKeys["1"]).equals(Buffer.from(conversationKey)));
	for (const [label, plain, expected] of [
		["text", content.text("encrypted test"), "message"],
		["reaction", content.reactionAdd(seq, "👍"), "reaction_add"],
		["remove reaction", content.reactionRemove(seq, "👍"), "reaction_remove"],
		["edit", content.edit(seq, "updated test"), "edit"],
	] as const) {
		const encoded = Buffer.from(messageCreateEvent(encryptBody(plain, conversationKey), "1")).toString("base64");
		const result = await gql(a, "SendMessageCreateMutation", { conversation_id: conversation, message_id: crypto.randomUUID(), encoded_message_create_event: encoded });
		const decoded = decodeMessageEvent(result.data.xchat_send_create_message_event.encoded_message_event, recoveredKeys);
		check(`${label}: recipient decrypts original event`, decoded.entry?.kind === expected || decoded.kind === expected);
	}
	await send(b, conversation, { 100: bin(crypto.getRandomValues(new Uint8Array(32))), 102: thrift.bool(false) });
	await sql`update chat_members set accepted = false where conversation_id = ${conversation} and user_id = ${b.id}::bigint`;
	const requestPreview = (await gql(b, "GetMessageRequestsPageQuery")).data.get_message_requests_page.message_request_items[0];
	check("request preview never uses viewer's acceptance event", thrift.text(thrift.decode(thrift.fromBase64(requestPreview.encoded_message_create_event))[3]) === a.id);
	await gql(b, "AcceptMessageRequestMutation", { targetUserId: a.id });
	const read = await gql(b, "SendMessageEventMutation", { encoded_message_event: detail(12, { 1: str(seq2), 2: thrift.i64(Date.now()) }) });
	check("read event stored", !!read.data.xchat_send_message_event.encoded_message_event);
	const reads = (await gql(a, "GetInboxPageConversationDataQuery", { conversation_id: conversation })).data.get_inbox_page_conversation_data.latest_read_events_per_participant;
	check("read receipt associated with recipient", reads[0]?.participant_id_results.rest_id === b.id);
	const sender = await socket(a);
	const typingFrame = nextFrame(receiver);
	sender.send(thrift.encode({ 1: struct({ 4: str(conversation), 7: struct({ 6: struct({ 2: i32(1) }) }) }) }));
	check("typing relayed with sender identity", thrift.text(thrift.fields((await typingFrame)[1])?.[3]) === a.id);
	check("outsider cannot read conversation", (await gql(outsider, "GetInboxPageConversationDataQuery", { conversation_id: conversation })).data.get_inbox_page_conversation_data === null);
	check("outsider cannot send message", !!(await send(outsider, conversation)).errors);
	check("malformed message fails as a chat error", !!(await gql(a, "SendMessageCreateMutation", { conversation_id: conversation, encoded_message_create_event: "broken" })).errors);
	await setBlock(b.id, a.id, true);
	check("recipient block rejects sends", !!(await send(a, conversation)).errors);
	check("block rejects sends in reverse direction", !!(await send(b, conversation)).errors);
	check("the blocker can still mute the conversation", !(await gql(b, "MuteConversationMutation", { conversationIds: [conversation] })).errors);
	await gql(b, "UnmuteConversationMutation", { conversationIds: [conversation] });
	await setBlock(b.id, a.id, false);
	for (const content of ["image/png", "video/mp4", "application/pdf"]) {
		const plain = crypto.getRandomValues(new Uint8Array(71));
		const bytes = secretstreamEncrypt(plain, conversationKey);
		const message = crypto.randomUUID();
		const upload = (await gql(a, "InitializeXChatMediaUploadMutation", { conversation_id: conversation, message_id: message, total_bytes: String(bytes.length), content_type: content })).data.xchat_initialize_media_upload;
		const url = `${upload.resume_upload_url}?resumeId=${upload.resume_id}&partNumber=0`;
		check(`${content}: outsider cannot upload`, (await fetch(url, { method: "POST", headers: { cookie: outsider.cookie, "x-csrf-token": outsider.csrf }, body: bytes })).status === 403);
		check(`${content}: cross-origin upload rejected`, (await fetch(url, { method: "POST", headers: { cookie: a.cookie, origin: "https://untrusted.invalid", "sec-fetch-site": "cross-site" }, body: bytes })).status === 403);
		const split = Math.floor(bytes.length / 2);
		check(`${content}: first part accepted`, (await fetch(url, { method: "POST", headers: { cookie: a.cookie, "x-csrf-token": a.csrf }, body: bytes.slice(0, split) })).status === 204);
		const vars = { conversation_id: conversation, message_id: message, media_hash_key: upload.media_hash_key, resume_id: upload.resume_id, num_parts: "2" };
		check(`${content}: incomplete upload cannot finalize`, !!(await gql(a, "FinalizeXChatMediaUploadMutation", vars)).data.xchat_finalize_media_upload.upload_error);
		check(`${content}: repeated part is idempotent`, (await fetch(url, { method: "POST", headers: { cookie: a.cookie, "x-csrf-token": a.csrf }, body: bytes.slice(0, split) })).status === 204);
		check(`${content}: second part accepted`, (await fetch(url.replace("partNumber=0", "partNumber=1"), { method: "POST", headers: { cookie: a.cookie, "x-csrf-token": a.csrf }, body: bytes.slice(split) })).status === 204);
		const result = await gql(a, "FinalizeXChatMediaUploadMutation", vars);
		check(`${content}: finalize succeeded`, result.data.xchat_finalize_media_upload.upload_error === null);
		check(`${content}: recipient gets identical ciphertext`, Buffer.from(await (await fetch(upload.resume_upload_url, { headers: { cookie: b.cookie } })).arrayBuffer()).equals(Buffer.from(bytes)));
		check(`${content}: recipient decrypts file`, Buffer.from(secretstreamDecrypt(new Uint8Array(await (await fetch(upload.resume_upload_url, { headers: { cookie: b.cookie } })).arrayBuffer()), recoveredKeys["1"])).equals(Buffer.from(plain)));
		check(`${content}: outsider cannot download`, (await fetch(upload.resume_upload_url, { headers: { cookie: outsider.cookie } })).status === 403);
	}
	check("oversized attachment rejected before upload", !!(await gql(a, "InitializeXChatMediaUploadMutation", { conversation_id: conversation, message_id: crypto.randomUUID(), total_bytes: "9999999999" })).data.xchat_initialize_media_upload.upload_error);
	const group = (await gql(a, "InitializeGroupConversationMutation")).data.xchat_initialize_group.conversation_id.rest_id; conversations.push(group);
	check("outsider cannot claim group draft", !!(await gql(b, "CreateGroupConversationMutation", { conversation_id: group, member_user_ids: [a.id, b.id], admin_user_ids: [a.id] })).errors);
	await gql(a, "CreateGroupConversationMutation", { conversation_id: group, member_user_ids: [a.id, b.id], admin_user_ids: [a.id], group_title: "test", action_signatures: [] });
	check("group participant can send", !(await send(b, group)).errors);
	check("outsider cannot join group by sending", !!(await send(outsider, group)).errors);
	check("non-admin cannot edit group", !!(await gql(b, "EditGroupConversationMutation", { conversation_id: group, group_name: "bad", action_signatures: [] })).errors);
	await gql(a, "EditGroupConversationMutation", { conversation_id: group, group_name: "updated", action_signatures: [] });
	check("group metadata persists", (await gql(b, "GetInboxPageConversationDataQuery", { conversation_id: group })).data.get_inbox_page_conversation_data.conversation_detail.group_metadata.group_name === "updated");
	check("non-admin cannot add group members", !!(await gql(b, "AddGroupMembersMutation", { conversation_id: group, user_ids: [outsider.id], action_signatures: [] })).errors);
	await gql(a, "AddGroupMembersMutation", { conversation_id: group, user_ids: [outsider.id], action_signatures: [] });
	check("added group member can send", !(await send(outsider, group)).errors);
	await gql(a, "RemoveFromGroupMutation", { conversation_id: group, user_ids: [outsider.id], action_signatures: [] });
	check("removed group member cannot send", !!(await send(outsider, group)).errors);
	check("removed group member cannot fetch history", (await gql(outsider, "GetInboxPageConversationDataQuery", { conversation_id: group })).data.get_inbox_page_conversation_data === null);
	await gql(a, "AddGroupMembersMutation", { conversation_id: group, user_ids: [outsider.id], action_signatures: [] });
	await sql`update users set status = 'suspended' where id = ${outsider.id}::bigint`;
	check("a suspended member doesn't stop the group sending", !(await send(b, group)).errors);
	check("or its admin removing them", !(await gql(a, "RemoveFromGroupMutation", { conversation_id: group, user_ids: [outsider.id], action_signatures: [] })).errors);
	await sql`update users set status = 'active' where id = ${outsider.id}::bigint`;
	check("cannot delete another sender's message for everyone", !!(await gql(b, "DeleteMessageMutation", { conversation_id: conversation, sequence_ids: [seq], delete_message_action: "DeleteForAll" })).errors);
	await gql(b, "DeleteMessageMutation", { conversation_id: conversation, sequence_ids: [seq], delete_message_action: "DeleteForSelf" });
	const hidden = (await gql(b, "GetConversationPageQuery", { conversation_id: conversation })).data.get_conversation_page.encoded_message_events;
	check("delete for self hides the message", !hidden.some((e: string) => thrift.text(thrift.decode(thrift.fromBase64(e))[1]) === seq));
	const byId = (await gql(b, "GetMessageEventsBySequenceIdQuery", { sequence_ids: [seq] })).data.get_message_events_by_sequence_id;
	check("delete for self also hides fetch by sequence", byId.not_found_sequence_ids.includes(seq));
	check("whole-event endpoint cannot bypass deletion ownership", !!(await gql(b, "SendMessageEventMutation", { encoded_message_event: detail(7, { 1: list(thrift.T.string, [str(seq2)]), 2: i32(2) }) })).errors);
	const senderHistory = (await gql(a, "GetConversationPageQuery", { conversation_id: conversation })).data.get_conversation_page.encoded_message_events;
	check("recipient's private delete event is not exposed to sender", !senderHistory.some((encoded: string) => {
		const detail = thrift.fields(thrift.decode(thrift.fromBase64(encoded))[7]);
		return !!detail?.[7] && thrift.int(thrift.fields(detail[7])?.[2]) === 1n;
	}));
	const oldKeys = (await gql(b, "GetConversationPageQuery", { conversation_id: conversation, min_conversation_key_version: "9223372036854775807" })).data.get_conversation_page.missing_conversation_key_change_events;
	check("key history supports recovery from emusks MAX cursor", oldKeys.length > 0);
	await gql(a, "DeleteMessageMutation", { conversation_id: conversation, sequence_ids: [seq2], delete_message_action: "DeleteForAll" });
	check("deleted-for-all ciphertext cannot be fetched", (await gql(a, "GetMessageEventsBySequenceIdQuery", { sequence_ids: [seq2] })).data.get_message_events_by_sequence_id.not_found_sequence_ids.includes(seq2));
	const pull = (await gql(b, "GetMessageEventsPageQuery", { continue_cursor: { max_local_sequence_id: seq } })).data.get_message_events_page;
	check("reconnect recovers newer events", pull.encoded_message_events.length > 0);
	await gql(b, "ConversationDeleteMutation", { conversation_id: conversation });
	check("deleted conversation leaves inbox", !(await gql(b, "GetInitialXChatPageQuery")).data.get_initial_chat_page.items.some((item: any) => item.conversation_detail.conversation_id === conversation));
	console.log(`all ${checks} chat checks passed`);
} finally {
	for (const ws of sockets) ws.close();
	if (accounts.length) {
		const uploads = await sql`select hash from chat_uploads where uploader_id = any(${sql.array(accounts.map((a) => a.id), "INT8")})`;
		const root = resolve(process.env.MEDIA_DIR ?? "media", "chat");
		for (const { hash } of uploads) {
			const path = resolve(root, hash);
			if (!/^[a-f0-9]{48}$/.test(hash) || dirname(path) !== root) throw new Error("Invalid temporary upload path.");
			await rm(path, { recursive: true, force: true });
		}
	}
	for (const id of conversations) {
		await sql`delete from chat_events where conversation_id = ${id}`;
		await sql`delete from chat_members where conversation_id = ${id}`;
		await sql`delete from chat_conversations where id = ${id}`;
	}
	for (const account of accounts) await sql`delete from users where id = ${account.id}::bigint`;
	await sql.close();
}
