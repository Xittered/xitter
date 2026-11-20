import { strict as assert } from "node:assert";
import { AdminError } from "../src/admin";
import { adActions } from "../src/ads-admin";
import { AdError, VIEWS_PER_DAY, adStats, cancelAd, chargeView, createAd, endExpiredAds, estimateViews, extendAd, myAds, pauseAd, pickAd, priceFor } from "../src/ads";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { createPost, repost } from "../src/posts";
import { loadSettings, setSetting, settings } from "../src/settings";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

await loadSettings();
const before = settings().ads;
const tag = newId().slice(-8);
const people = { mod: newId(), alice: newId(), bob: newId() };
const mod = { id: people.mod, role: "moderator", screen_name: `adm${tag}` } as any;
const run = (action: string, body: Record<string, unknown>) => adActions[action].run(mod, body as any, undefined as any);
const balance = async (id: string) => Number((await sql`select balance_cents from money_wallets where user_id = ${id}::bigint`)[0]?.balance_cents ?? 0);
const refused = async (p: Promise<unknown>, type: any, text?: RegExp) => {
	try {
		await p;
		assert.fail("expected a refusal");
	} catch (e) {
		assert(e instanceof type, `expected ${type.name}, got ${e}`);
		if (text) assert.match((e as Error).message, text);
	}
};

try {
	for (const [k, id] of Object.entries(people)) await sql`insert into users (id, screen_name, name, password_hash, role) values (${id}::bigint, ${`ad${k[0]}${tag}`}, ${k}, 'unused', ${k === "mod" ? "moderator" : null})`;
	await sql`insert into money_wallets (user_id, balance_cents) values (${people.alice}::bigint, 10000), (${people.bob}::bigint, 400)`;
	const ad = { text: "Try Xitter's new thing", url: "https://example.com/thing", budgetCents: 1000, days: 3 };

	await setSetting("ads", { ...before, enabled: false });
	await refused(createAd(people.alice, ad), AdError, /aren't open/);
	await setSetting("ads", { ...before, enabled: true, min_spend_cents: 500, max_days: 7, max_pending: 3, reject_refund_pct: 70, min_viewer_age_days: 3 });

	await refused(createAd(people.alice, { ...ad, budgetCents: 499 }), AdError, /at least/);
	await refused(createAd(people.alice, { ...ad, days: 8 }), AdError, /1 to 7 days/);
	await refused(createAd(people.alice, { ...ad, url: "javascript:alert(1)" }), AdError, /http/);
	await refused(createAd(people.alice, { ...ad, text: "   " }), AdError, /Write/);
	await refused(createAd(people.bob, { ...ad, budgetCents: 500 }), AdError, /enough/);
	assert.equal(await balance(people.bob), 400, "a refused ad takes nothing");

	const first = await createAd(people.alice, ad);
	assert.equal(first.status, "pending");
	assert.equal(await balance(people.alice), 9000, "the budget is held when the ad is sent");
	const second = await createAd(people.alice, ad);
	const third = await createAd(people.alice, ad);
	await refused(createAd(people.alice, ad), AdError, /waiting for review/);
	assert.equal(await balance(people.alice), 7000);

	await refused(run("reviewAd", { id: second.id, approve: false }), AdminError, /why/);
	const rejected = (await run("reviewAd", { id: second.id, approve: false, reason: "Misleading claim" })) as any;
	assert.equal(rejected.ad.status, "rejected");
	assert.equal(rejected.ad.refundedCents, 700, "a rejected ad gets 70% back");
	assert.equal(await balance(people.alice), 7700);
	await refused(run("reviewAd", { id: second.id, approve: true }), AdminError, /already/);

	const approved = (await run("reviewAd", { id: first.id, approve: true })) as any;
	assert.equal(approved.ad.status, "running");
	assert(approved.ad.endsAt.getTime() - approved.ad.startsAt.getTime() >= 3 * 86_400_000 - 1000, "it runs for the days paid for");

	await sql`update ads set spent_cents = 250 where id = ${first.id}::bigint`;
	const cancelled = await cancelAd(people.alice, first.id);
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.refundedCents, 750, "cancelling returns what wasn't spent");
	assert.equal(await balance(people.alice), 8450);
	await refused(cancelAd(people.alice, first.id), AdError, /finished/);
	await refused(cancelAd(people.bob, third.id), AdError, /No such ad/);

	await run("reviewAd", { id: third.id, approve: true });
	await sql`update ads set spent_cents = 100, ends_at = now() - interval '1 minute' where id = ${third.id}::bigint`;
	await endExpiredAds();
	const ended = (await myAds(people.alice)).find((a) => a.id === third.id)!;
	assert.equal(ended.status, "ended");
	assert.equal(ended.refundedCents, 900, "an ended ad returns what wasn't spent");
	assert.equal(await balance(people.alice), 9350);
	await endExpiredAds();
	assert.equal(await balance(people.alice), 9350, "ending twice refunds once");

	const small = { projectedCents: 0 };
	const base = priceFor(0, small);
	assert.equal(base, settings().ads.base_cpm_cents, "a tiny economy with nothing running costs the floor price");
	assert.equal(priceFor(settings().ads.price_scale_cents, small), base * 2, "the price doubles once running budgets reach the scale");
	assert(priceFor(settings().ads.price_scale_cents * 1000, small) < base * 12, "the price grows slowly as more money comes in");
	const big = { projectedCents: 1_000_000_000 };
	assert.equal(priceFor(0, big), 20_000, "with nothing running, the price follows the size of the economy");
	assert.equal(priceFor(10_000_000, big), 40_000, "demand is measured against the economy, not a fixed amount");
	const triple = { projectedCents: 3_000_000_000 };
	assert.equal(priceFor(30_000_000, triple) / priceFor(0, triple), priceFor(10_000_000, big) / priceFor(0, big), "the same share of a bigger economy raises the price by the same factor");
	assert.equal(estimateViews(1000, 20), 50_000);

	const hidden = await createAd(people.alice, { ...ad, text: "Only as an ad", adOnly: true });
	const open = await createAd(people.alice, { ...ad, text: "On my profile too", adOnly: false });
	const hiddenRun = ((await run("reviewAd", { id: hidden.id, approve: true })) as any).ad;
	const openRun = ((await run("reviewAd", { id: open.id, approve: true })) as any).ad;
	assert(hiddenRun.postId && openRun.postId, "approving makes the ad's post");
	const [hiddenPost] = await sql`select ad_only, text from posts where id = ${hiddenRun.postId}::bigint`;
	assert.equal(hiddenPost.ad_only, true);
	assert.equal(hiddenPost.text, "Only as an ad\n\nhttps://example.com/thing", "the link goes under the text");
	const inFeeds = (await sql`select post_id::text from feed_items where author_id = ${people.alice}::bigint`).map((r: any) => r.post_id);
	assert(!inFeeds.includes(hiddenRun.postId), "an ad-only post stays out of profiles and timelines");
	assert(inFeeds.includes(openRun.postId), "a post for everyone shows like any other");
	const [stats] = await sql`select posts from user_stats where user_id = ${people.alice}::bigint`;
	assert.equal(stats.posts, 1, "an ad-only post isn't counted on the profile");
	await sql`delete from posts where id = ${hiddenRun.postId}::bigint`;
	const [statsAfter] = await sql`select posts from user_stats where user_id = ${people.alice}::bigint`;
	assert.equal(statsAfter.posts, 1, "deleting an ad-only post doesn't lower the count");
	await sql`update ads set post_id = null where id = ${hidden.id}::bigint`;
	const second2 = await createPost(people.alice, "keep for picking");
	await sql`update posts set ad_only = true where id = ${second2}::bigint`;
	await sql`update ads set post_id = ${second2}::bigint where id = ${hidden.id}::bigint`;

	const picked = await pickAd(people.bob, []);
	assert(picked && [hidden.id, open.id].includes(picked.adId), "a running ad is picked for someone else");
	assert.equal(await pickAd(people.alice, []), undefined, "nobody is shown their own ad");
	assert.equal(await pickAd(people.bob, [second2, openRun.postId]), undefined, "an ad already on the page isn't picked again");
	await chargeView(hidden.id, people.bob);
	const [young] = await sql`select views from ads where id = ${hidden.id}::bigint`;
	assert.equal(young.views, 0, "a brand new account's views cost nothing");
	await sql`update users set created_at = now() - interval '10 days' where id in ${sql([people.bob, people.mod])}`;
	await sql`update ad_views set last_at = '-infinity' where viewer_id = ${people.bob}::bigint`;
	await chargeView(hidden.id, people.bob);
	await chargeView(hidden.id, people.bob);
	const again = await pickAd(people.bob, []);
	assert.equal(again?.adId, open.id, "every showing counts toward the daily cap, charged or not");
	await refused(repost(people.bob, second2), Error, /Ads can't be reposted/);
	await refused(createPost(people.bob, "look", { quoteId: second2 }), Error, /Ads can't be quoted/);
	await sql`insert into reposts (id, user_id, post_id) values (${newId()}::bigint, ${people.bob}::bigint, ${second2}::bigint)`;
	const viaRepost = await sql`select 1 from feed_items where post_id = ${second2}::bigint`;
	assert.equal(viaRepost.length, 0, "an ad-only post never reaches timelines through a repost");
	const [afterViews] = await sql`select views, spent_milli::bigint as milli from ads where id = ${hidden.id}::bigint`;
	assert.equal(afterViews.views, 1, "a second view within the hour costs nothing");
	assert(Number(afterViews.milli) > 0, "a view is charged");
	await sql`insert into ad_views (ad_id, viewer_id, shown) values (${open.id}::bigint, ${people.bob}::bigint, ${VIEWS_PER_DAY}) on conflict (ad_id, viewer_id, day) do update set shown = ${VIEWS_PER_DAY}`;
	assert.equal(await pickAd(people.bob, []), undefined, "nobody sees one ad more than the daily cap");
	await sql`delete from ad_views where viewer_id = ${people.bob}::bigint`;
	await sql`update users set preferences = '{"hide_ads": true}' where id = ${people.bob}::bigint`;
	assert.equal(await pickAd(people.bob, []), undefined, "hiding ads hides every ad");

	await sql`update ads set spent_milli = budget_cents * 1000 - 1 where id = ${open.id}::bigint`;
	await chargeView(open.id, people.mod);
	const [spent] = await sql`select status, spent_cents::bigint as cents, budget_cents::bigint as budget from ads where id = ${open.id}::bigint`;
	assert.equal(spent.status, "ended", "an ad stops when its budget is spent");
	assert.equal(Number(spent.cents), Number(spent.budget), "it never spends more than its budget");

	await sql`update users set preferences = '{}' where id = ${people.bob}::bigint`;
	await pauseAd(people.alice, hidden.id, true);
	assert.equal(await pickAd(people.bob, []), undefined, "a paused ad isn't shown");
	await refused(pauseAd(people.alice, hidden.id, true), AdError, /running/);
	await refused(pauseAd(people.bob, hidden.id, false), AdError, /paused/);
	await sql`update ads set ends_at = ends_at - interval '1 day' where id = ${hidden.id}::bigint`;
	const [beforeResume] = await sql`select extract(epoch from paused_left)::float8 as s from ads where id = ${hidden.id}::bigint`;
	const resumed = await pauseAd(people.alice, hidden.id, false);
	assert(Math.abs((resumed.endsAt!.getTime() - Date.now()) / 1000 - Number(beforeResume.s)) < 5, "a paused ad keeps the time it had left");
	await pauseAd(people.alice, hidden.id, true);
	await sql`update ads set paused_at = now() - interval '8 days' where id = ${hidden.id}::bigint`;
	await endExpiredAds();
	const [stale] = await sql`select status from ads where id = ${hidden.id}::bigint`;
	assert.equal(stale.status, "ended", "an ad paused longer than the longest run ends and refunds");
	await sql`update ads set status = 'running', paused_at = null, paused_left = null, refunded_cents = 0, ends_at = now() + interval '3 days' where id = ${hidden.id}::bigint`;
	const wallet = await balance(people.alice);
	const longer = await extendAd(people.alice, hidden.id, { budgetCents: 300, days: 2 });
	assert.equal(longer.budgetCents, 1300);
	assert.equal(await balance(people.alice), wallet - 300, "extending takes the added budget");
	await refused(extendAd(people.alice, hidden.id, { days: 3 }), AdError, /more than 7 days/);
	await refused(extendAd(people.alice, hidden.id, {}), AdError, /Add days/);
	await refused(extendAd(people.alice, hidden.id, { budgetCents: 1_000_000 }), AdError, /enough/);
	await refused(extendAd(people.alice, open.id, { days: 1 }), AdError, /running or paused/);

	const list = (await run("ads", { status: "rejected" })) as any;
	assert(list.ads.some((a: any) => a.id === second.id && a.rejectReason === "Misleading claim"));
	console.log("ads: ok");
} finally {
	await setSetting("ads", before);
	await sql`delete from users where id in ${sql([people.mod, people.alice, people.bob])}`;
	await sql.close();
}
