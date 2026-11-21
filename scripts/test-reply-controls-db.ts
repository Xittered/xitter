import assert from "node:assert/strict";
import { sql, migrate } from "../src/db";
import { newId } from "../src/ids";
import { replyLimited } from "../src/blocks";
import { createPost, getPost } from "../src/posts";
import { callOperation, runOperation } from "../src/graphql";
import { runDue, scheduledHandlers } from "../src/scheduled";
import { conversationSettings } from "../src/reply-controls";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
const accounts = Array.from({ length: 6 }, () => newId());
const [author, followed, network, outsider, overridden, custom] = accounts;
const customCountry = `Étoile 星 ${author}`;
const viewer = { id: author } as any;
let scheduled: string, id: string, nested: string, result: any, choices: any[], row: any, policy: string, mode: unknown, selection: unknown;

assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

async function fixture(id: string) {
	await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`reply_${id}`}, 'Reply control test', '!')`;
}

async function expectReply(userId: string, postId: string, allowed: boolean) {
	const post = await getPost(userId, postId);
	assert.equal(await replyLimited(postId, post!.conversation_id, userId), !allowed);
	assert.equal(post!.reply_limited, !allowed);
	if (allowed) await createPost(userId, "allowed reply", { replyToId: postId, skipPreview: true });
	else await assert.rejects(createPost(userId, "disallowed reply", { replyToId: postId, skipPreview: true }), /limited who can reply/);
}

try {
	for (id of accounts) await fixture(id);
	await sql`insert into follows (follower_id, followee_id) values (${author}::bigint, ${followed}::bigint), (${followed}::bigint, ${network}::bigint)`;
	await sql`update users set country = 'SE' where id = any(${sql.array([network, overridden], "INT8")})`;
	await sql`update users set country = 'US' where id = ${outsider}::bigint`;
	await sql`update users set based_in_override = ${customCountry} where id = ${overridden}::bigint`;
	await sql`update users set country = ${customCountry} where id = ${custom}::bigint`;
	choices = (await conversationSettings()).data.get_conversation_control_settings.settings.find((setting) => setting.policy === "Country")!.preferences!.available_preferences;
	assert(choices.some((choice) => choice.value === "SE"));
	assert.equal(choices.filter((choice) => choice.value === customCountry).length, 1);
	[row] = await sql`select account_count::int as n from reply_country_catalog where value = ${customCountry}`;
	assert.equal(row.n, 2);
	await migrate();
	[row] = await sql`select account_count::int as n from reply_country_catalog where value = ${customCountry}`;
	assert.equal(row.n, 2);
	for (policy of ["Community", "MyNetwork"]) {
		id = await createPost(author, "network audience", { replyPolicy: policy, skipPreview: true });
		await expectReply(author, id, true);
		await expectReply(followed, id, true);
		await expectReply(network, id, policy === "MyNetwork");
		await expectReply(outsider, id, false);
	}
	id = await createPost(author, "region audience", { replyPolicy: "CountryOfOrigin", replySelections: ["Europe"], skipPreview: true });
	await expectReply(network, id, true);
	await expectReply(outsider, id, false);
	await expectReply(overridden, id, false);
	nested = await createPost(network, "nested", { replyToId: id, skipPreview: true });
	await expectReply(outsider, nested, false);
	id = await createPost(author, "multiple country audience", { replyPolicy: "Country", replySelections: [customCountry, "US", "SE"], skipPreview: true });
	assert.deepEqual((await getPost(author, id))!.conversation_selections, [customCountry, "US", "SE"]);
	await expectReply(overridden, id, true);
	await expectReply(custom, id, true);
	await expectReply(network, id, true);
	await expectReply(outsider, id, true);
	await expectReply(followed, id, false);
	id = await createPost(author, "country audience", { replyPolicy: "Country", replySelections: ["SE"], skipPreview: true });
	await expectReply(network, id, true);
	await expectReply(overridden, id, false);
	await callOperation("ConversationControlChange", viewer, { tweet_id: id, mode: "Country", allowed_country_codes: [customCountry] });
	await expectReply(overridden, id, true);
	await expectReply(custom, id, true);
	await expectReply(network, id, false);
	await assert.rejects(callOperation("ConversationControlDelete", { id: outsider } as any, { tweet_id: id }), /your own posts/);
	await callOperation("ConversationControlDelete", viewer, { tweet_id: id });
	await expectReply(outsider, id, true);
	result = await (await runOperation("CreateTweet", viewer, { tweet_text: "invalid", conversation_control: { mode: "Country", allowed_country_codes: [] } })).json();
	assert(result.errors?.length);
	for (mode of ["FutureClientMode", 123]) {
		result = await callOperation("CreateTweet", viewer, { tweet_text: "unknown client audience", conversation_control: { mode } });
		id = result.data.create_tweet.tweet_results.result.rest_id;
		[row] = await sql`select reply_policy from posts where id = ${id}::bigint`;
		assert.equal(row.reply_policy, null);
		await expectReply(outsider, id, true);
	}
	for (mode of [undefined, "all", "Community", "FutureClientMode"]) {
		for (selection of [null, "SE", [123], [""], ["a".repeat(101)], Array(1001).fill("SE")]) {
			result = await (await runOperation("CreateDraftTweet", viewer, { post_tweet_request: { status: "invalid draft country list", conversation_control: mode, conversation_control_region_codes: selection } })).json();
			assert.equal(result.errors?.[0]?.code, 214, JSON.stringify(result));
		}
	}
	assert.equal((await sql`select id from scheduled_posts where user_id = ${author}::bigint and request->>'status' = 'invalid draft country list'`).length, 0);
	result = await scheduledHandlers.CreateDraftTweet(viewer, { post_tweet_request: { status: "future client draft", conversation_control: "FutureClientMode", conversation_control_region_codes: ["Mars"] } });
	[row] = await sql`select request from scheduled_posts where id = ${result.data.tweet.rest_id}::bigint`;
	assert.equal(row.request.conversation_control, "all");
	assert.deepEqual(row.request.conversation_control_region_codes, []);
	for (policy of ["Community", "Verified", "MyNetwork", "ByInvitation", "Country", "CountryOfOrigin"]) {
		id = await createPost(author, `Mention @reply_${outsider}`, { replyPolicy: policy, replySelections: policy === "Country" ? [customCountry] : policy === "CountryOfOrigin" ? ["Europe"] : [], skipPreview: true });
		await expectReply(outsider, id, true);
	}
	result = await scheduledHandlers.CreateDraftTweet(viewer, { post_tweet_request: { status: "draft audience", conversation_control: "country", conversation_control_region_codes: [customCountry] } });
	[row] = await sql`select request from scheduled_posts where id = ${result.data.tweet.rest_id}::bigint`;
	assert.equal(row.request.conversation_control, "country");
	assert.deepEqual(row.request.conversation_control_region_codes, [customCountry]);
	result = await scheduledHandlers.CreateScheduledTweet(viewer, { execute_at: Math.floor(Date.now() / 1000) + 3600, post_tweet_request: { status: "scheduled audience", conversation_control: "country", conversation_control_region_codes: [customCountry] } });
	scheduled = result.data.tweet.rest_id;
	await sql`update scheduled_posts set execute_at = now() - interval '1 second' where id = ${scheduled}::bigint`;
	assert.equal(await runDue(), 1);
	[row] = await sql`select id::text from posts where user_id = ${author}::bigint and text = 'scheduled audience'`;
	await expectReply(overridden, row.id, true);
	await expectReply(network, row.id, false);
	await sql`update users set based_in_override = null where id = ${overridden}::bigint`;
	[row] = await sql`select account_count::int as n from reply_country_catalog where value = ${customCountry}`;
	assert.equal(row.n, 1);
	await sql`delete from users where id = ${custom}::bigint`;
	assert.equal((await sql`select value from reply_country_catalog where value = ${customCountry}`).length, 0);
	const root = await createPost(author, "root with open replies", { skipPreview: true });
	const reply = await createPost(author, "a reply that limits its own replies", { replyToId: root, skipPreview: true });
	const changed: any = await callOperation("ConversationControlChange", viewer, { tweet_id: reply, mode: "Community" });
	assert.equal(changed.data.conversation_control_change.tweet_results.result.conversation_control?.policy, "Community", "a reply reports its own reply setting after a change");
	assert.equal((await getPost(author, root))?.conversation_policy ?? null, null, "the post above keeps its own setting");
	await expectReply(outsider, reply, false);
	await expectReply(outsider, root, true);
	const cleared: any = await callOperation("ConversationControlDelete", viewer, { tweet_id: reply });
	assert.equal(cleared.data.conversation_control_delete.tweet_results.result.conversation_control, undefined, "clearing it on a reply shows everyone again");
	await expectReply(outsider, reply, true);
	console.log("Reply audiences, nested enforcement, country overrides, catalog lifecycle and idempotent migration passed.");
} finally {
	await sql`delete from users where id = any(${sql.array(accounts, "INT8")})`;
	await sql.close();
}
