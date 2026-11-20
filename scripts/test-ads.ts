import { strict as assert } from "node:assert";
import { AdminError } from "../src/admin";
import { AdError, adActions, cancelAd, createAd, endExpiredAds, estimateViews, myAds, priceFor } from "../src/ads";
import { sql } from "../src/db";
import { newId } from "../src/ids";
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
	await setSetting("ads", { ...before, enabled: true, min_spend_cents: 500, max_days: 7, max_pending: 3, reject_refund_pct: 70 });

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

	const base = priceFor(0);
	assert.equal(base, settings().ads.base_cpm_cents, "no money in running ads costs the base price");
	assert(priceFor(settings().ads.price_scale_cents) === base * 2, "the price doubles once running budgets reach the scale");
	assert(priceFor(settings().ads.price_scale_cents * 1000) < base * 12, "the price grows slowly as more money comes in");
	assert.equal(estimateViews(1000, 20), 50_000);

	const list = (await run("ads", { status: "rejected" })) as any;
	assert(list.ads.some((a: any) => a.id === second.id && a.rejectReason === "Misleading claim"));
	console.log("ads: ok");
} finally {
	await setSetting("ads", before);
	await sql`delete from users where id in ${sql([people.mod, people.alice, people.bob])}`;
	await sql.close();
}
