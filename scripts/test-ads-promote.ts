import { strict as assert } from "node:assert";
import "../src/admin";
import { adActions } from "../src/ads-admin";
import { AdError, createAd, pickAd, promotablePosts, renameAd } from "../src/ads";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { createPost } from "../src/posts";
import { loadSettings, setSetting, settings } from "../src/settings";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

await loadSettings();
const before = settings().ads;
const tag = newId().slice(-8);
const people = { mod: newId(), alice: newId(), bob: newId() };
const mod = { id: people.mod, role: "moderator", screen_name: `pm${tag}` } as any;
const run = (action: string, body: Record<string, unknown>) => adActions[action].run(mod, body as any, undefined as any);
const refused = async (p: Promise<unknown>, text: RegExp) => {
	try {
		await p;
		assert.fail("expected a refusal");
	} catch (e) {
		assert(e instanceof AdError, `expected AdError, got ${e}`);
		assert.match((e as Error).message, text);
	}
};
let passed = 0;
const ok = (name: string) => {
	passed++;
	console.log(`ok ${passed} - ${name}`);
};

try {
	for (const [k, id] of Object.entries(people)) await sql`insert into users (id, screen_name, name, password_hash, role, created_at) values (${id}::bigint, ${`p${k[0]}${tag}`}, ${k}, 'unused', ${k === "mod" ? "moderator" : null}, now() - interval '30 days')`;
	await sql`insert into money_wallets (user_id, balance_cents) values (${people.alice}::bigint, 10000), (${people.bob}::bigint, 10000)`;
	await setSetting("ads", { ...before, enabled: true, min_spend_cents: 500, max_days: 7, max_pending: 3 });
	const postCount = async () => Number((await sql`select count(*)::int as n from posts where user_id = ${people.alice}::bigint`)[0].n);

	const mine = await createPost(people.alice, "Come to the bakery on Saturday");
	const theirs = await createPost(people.bob, "Bob's post");
	assert((await promotablePosts(people.alice)).some((p) => p.id === mine));
	ok("an own post is offered for promotion");

	await refused(createAd(people.alice, { postId: theirs, budgetCents: 1000, days: 3 }), /can't be promoted/);
	ok("someone else's post can't be promoted");

	const ad = await createAd(people.alice, { postId: mine, budgetCents: 1000, days: 3, name: "Bakery" });
	assert.equal(ad.existingPost, true);
	assert.equal(ad.postId, mine);
	assert.equal(ad.adOnly, false);
	assert.equal(ad.text, "Come to the bakery on Saturday");
	assert.equal(ad.name, "Bakery");
	ok("a campaign is made from the post, keeping its text and name");

	assert(!(await promotablePosts(people.alice)).some((p) => p.id === mine));
	await refused(createAd(people.alice, { postId: mine, budgetCents: 1000, days: 3 }), /already in a campaign/);
	ok("one post runs in one campaign at a time");

	const posts = await postCount();
	await run("reviewAd", { id: ad.id, approve: true });
	assert.equal(await postCount(), posts);
	const [row] = await sql`select status, post_id::text from ads where id = ${ad.id}::bigint`;
	assert.equal(row.status, "running");
	assert.equal(row.post_id, mine);
	const [post] = await sql`select ad_only from posts where id = ${mine}::bigint`;
	assert.equal(post.ad_only, false);
	ok("approving runs the post itself, with no copy");

	const picked = await pickAd(people.bob, []);
	assert.equal(picked?.postId, mine);
	ok("the promoted post is picked for timelines");

	assert.equal((await renameAd(people.alice, ad.id, "  Saturday  ")).name, "Saturday");
	assert.equal((await renameAd(people.alice, ad.id, "")).name, null);
	await refused(renameAd(people.bob, ad.id, "mine now"), /No such ad/);
	ok("only the owner renames a campaign");

	await assert.rejects(run("stopAd", { id: ad.id, reason: "" }) as Promise<unknown>, /Say why/);
	const wallet = async () => Number((await sql`select balance_cents from money_wallets where user_id = ${people.alice}::bigint`)[0].balance_cents);
	const had = await wallet();
	await sql`update ads set spent_cents = 200, spent_milli = 200000 where id = ${ad.id}::bigint`;
	const stopped = (await run("stopAd", { id: ad.id, reason: "Misleading claim" })) as any;
	assert.equal(stopped.ad.status, "cancelled");
	assert.equal(stopped.ad.rejectReason, "Misleading claim");
	assert.equal(await wallet(), had + 800);
	const [logged] = await sql`select 1 from audit_log where action = 'ad_stop' and target = ${people.alice}`;
	assert(logged);
	ok("a moderator stops a running ad with a reason and a full refund of what is left");

	assert((await promotablePosts(people.alice)).some((p) => p.id === mine));
	const again = await createAd(people.alice, { postId: mine, budgetCents: 500, days: 1 });
	ok("a stopped campaign frees the post for another");

	await sql`delete from posts where id = ${mine}::bigint`;
	try {
		await run("reviewAd", { id: again.id, approve: true });
		assert.fail("expected a refusal");
	} catch (e) {
		assert.match((e as Error).message, /deleted/);
	}
	ok("a deleted post can't be approved");

	await sql`update users set protected = true where id = ${people.bob}::bigint`;
	const hiddenPost = await createPost(people.bob, "followers only");
	await refused(createAd(people.bob, { postId: hiddenPost, budgetCents: 500, days: 1 }), /protected/);
	ok("a protected account can't promote posts");

	console.log(`${passed} passed`);
} finally {
	await setSetting("ads", before);
	await sql`delete from ads where user_id in ${sql(Object.values(people))}`;
	await sql`delete from users where id in ${sql(Object.values(people))}`;
	await sql.close();
}
