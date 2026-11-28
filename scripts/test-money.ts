// End-to-end check of Equicoins (/account/money) against a running server:
// starting balance, sending, the note, refusals, double-pressed Send, blocks,
// admins adjusting a balance and the side bar entry. Makes its own accounts and
// removes them.
// usage: bun scripts/test-money.ts

import { sql } from "../src/db";
import { createUser } from "../src/auth";
import { parseAmount, formatCents } from "../src/money";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const stamp = Date.now() % 1e8;
const [a, b, c] = [`m${stamp}a`, `m${stamp}b`, `m${stamp}c`];
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

async function signIn(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password: "testpass123" }), redirect: "manual" });
	const cookie = r.headers.getSetCookie().map((x) => x.split(";")[0]).join("; ");
	const csrf = cookie.match(/ct0=([^;]+)/)?.[1] ?? "";
	const headers = { cookie, "sec-fetch-site": "same-origin" };
	const api = { ...headers, "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...api, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers: api })).json();
	const json = async (path: string) => (await fetch(`${origin}/i/api/xitter/${path}`, { headers: api })).json();
	const page = async (query = "") => (await fetch(`${origin}/account/money${query}`, { headers })).text();
	const send = (body: Record<string, string>) =>
		fetch(`${origin}/account/money`, { method: "POST", headers, body: new URLSearchParams({ idem: crypto.randomUUID(), csrf, ...body }), redirect: "manual" });
	const form = (path: string, body: Record<string, string>) =>
		fetch(`${origin}${path}`, { method: "POST", headers, body: new URLSearchParams({ csrf, ...body }), redirect: "manual" });
	const postApi = async (path: string) => (await fetch(`${origin}/i/api/xitter/${path}`, { method: "POST", headers: api })).json();
	return { headers, page, send, gql, get, json, form, postApi };
}
const adminCall = (s: { headers: Record<string, string> }, action: string, body: object = {}) =>
	fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...s.headers, "x-csrf-token": csrfOf(s), "content-type": "application/json" }, body: JSON.stringify(body) });
const csrfOf = (s: { headers: Record<string, string> }) => s.headers.cookie.match(/ct0=([^;]+)/)?.[1] ?? "";
const balance = async (name: string) => {
	const [w] = await sql`select w.balance_cents from money_wallets w join users u on u.id = w.user_id where u.screen_name = ${name}`;
	return w ? Number(w.balance_cents) : null;
};

check("amounts parse", parseAmount("$12.5") === 1250 && parseAmount("3.52") === 352 && parseAmount("100") === 10000 && parseAmount("1,000") === 100000);
check("bad amounts don't", parseAmount("abc") === null && parseAmount("1.234") === null && parseAmount("-5") === null && parseAmount("") === null);
check("cents format", formatCents(352) === "$3.52" && formatCents(123456) === "$1,234.56");

const ids = [await createUser(a, "Money A", "testpass123"), await createUser(b, "Money B", "testpass123"), await createUser(c, "Money C", "testpass123")];
// a new wallet gets the instance's starting balance; these start at $100 so the sums below hold
const [saved] = await sql`select value from settings where key = 'money'`;
const starting = Number(saved?.value?.starting_cents ?? 500);
const fresh = await createUser(`m${stamp}d`, "Money D", "testpass123");
ids.push(fresh);
// staff, to switch Money on for the run and off again
const staffId = await createUser(`m${stamp}x`, "Money Staff", "testpass123");
ids.push(staffId);
let featuresBefore: Record<string, boolean> | undefined;
await sql`insert into money_wallets (user_id, balance_cents) select unnest(${sql.array(ids.slice(0, 3), "INT8")}::bigint[]), 10000`;
try {
	// Money is off by default: on for this run, put back as it was after
	await sql`update users set role = 'admin' where id = ${staffId}::bigint`;
	const sx = await signIn(`m${stamp}x`);
	featuresBefore = (await (await adminCall(sx, "settings")).json()).settings.features;
	await adminCall(sx, "saveSettings", { features: { ...featuresBefore, money: true } });
	const sa = await signIn(a);
	const sb = await signIn(b);
	const gate = await sa.page("/send");
	check("Money opens with the disclaimer first", gate.includes("Disclaimer:") && gate.includes("no real-world monetary value") && !gate.includes('name="amount"'));
	check("nothing can be sent before it's accepted", (await sa.send({ to: b, amount: "1" })).status === 200 && (await balance(a)) === 10000);
	const accepted = await sa.form("/account/money", { action: "accept", back: "/account/money/send" });
	check("accepting it goes back to the page asked for", accepted.status === 303 && accepted.headers.get("location") === "/account/money/send");
	check("and it isn't shown again", !(await sa.page()).includes("Disclaimer:"));
	const sc0 = await signIn(c);
	await sb.form("/account/money", { action: "accept", back: "/account/money" });
	const offsite = await sc0.form("/account/money", { action: "accept", back: "https://evil.example/" });
	check("accepting never leads off Money", offsite.headers.get("location") === "/account/money", offsite.headers.get("location"));
	const first = await sa.page();
	check("the page shows the balance", first.includes("$100.00"));
	const sd = await signIn(`m${stamp}d`);
	await sd.form("/account/money", { action: "accept", back: "/account/money" });
	check("a new wallet gets the starting balance", (await sd.page()).includes(formatCents(starting)), formatCents(starting));
	const form = await sa.page("/send");
	check("with a send screen", first.includes('href="/account/money/send"') && form.includes('name="amount"') && form.includes('name="idem"'));

	let r = await sa.send({ to: `@${b}`, amount: "12.50", note: "i miss you" });
	check("sending redirects back to the page", r.status === 303 && (r.headers.get("location") ?? "").startsWith("/account/money?sent="), r.status);
	check("the sender is charged", (await balance(a)) === 8750);
	check("the recipient is paid", (await balance(b)) === 11250);
	const after = await sa.page(new URL(r.headers.get("location")!, origin).search);
	check("the sender sees a confirmation", after.includes(`Sent $12.50 to @${b}`));
	check("and the payment in Activity", after.includes("−$12.50") && after.includes("i miss you"));
	const payId = new URL(r.headers.get("location")!, origin).searchParams.get("sent")!;
	const theirs = await sb.page();
	check("the recipient sees it too", theirs.includes("+$12.50") && theirs.includes("i miss you"));

	const receipt = await sa.page(`/p/${payId}`);
	check("the payment has its own page", receipt.includes("Completed") && receipt.includes("data-compose"));
	const sc = await signIn(c);
	check("a stranger can't see an unshared payment", (await fetch(`${origin}/account/money/p/${payId}`, { headers: sc.headers })).status === 404);
	check("nor its card", !(`p${payId}` in (await sc.json(`money/cards?ids=p${payId}`))));
	const recent = await sa.json("money/recent");
	check("the composer lists the payment", recent[0]?.id === payId && recent[0].url.endsWith(`/i/xmoney/p/${payId}`), recent[0]);
	const made = await sa.gql("CreateTweet", { tweet_text: `Fast & Free Payments ${recent[0].url}` });
	const post = made.data.create_tweet.tweet_results.result;
	check("the post's text stops before the card's link", JSON.stringify(post.legacy?.display_text_range) === JSON.stringify([0, "Fast & Free Payments".length]), post.legacy?.display_text_range);
	const spaced = (await sa.gql("CreateTweet", { tweet_text: `Here you go\n\n${recent[0].url}\n` })).data.create_tweet.tweet_results.result;
	check("and before the blank lines over it", spaced.legacy?.display_text_range?.[1] === "Here you go".length, spaced.legacy?.display_text_range);
	const middle = (await sa.gql("CreateTweet", { tweet_text: `look ${recent[0].url} wow` })).data.create_tweet.tweet_results.result;
	check("a link with text after it stays in the text", middle.legacy?.display_text_range?.[1] === [...middle.legacy.full_text].length);
	check("a post with the payment's link gets its card", post.card?.legacy?.name === "summary" && JSON.stringify(post.card).includes(`$12.50 sent to Money B`), post.card?.legacy?.binding_values?.[0]);
	check("a stranger now sees the card", typeof (await sc.json(`money/cards?ids=p${payId}&by=${a}`))[`p${payId}`] === "string");
	const html = (await sb.json(`money/cards?ids=p${payId}&by=${a}`))[`p${payId}`] as string;
	check("the card reads as X's", html.includes("$12.50") && html.includes("sent to") && html.includes("i miss you"));
	check("its page opens for them too", (await fetch(`${origin}/account/money/p/${payId}`, { headers: sc.headers })).status === 200);
	const copied = await sc.gql("CreateTweet", { tweet_text: `look ${recent[0].url}` });
	check("someone else's post with the link gets no card", !copied.data.create_tweet.tweet_results.result.card);
	const notes = JSON.stringify(await sb.get("NotificationsTimeline", { timeline_type: "All", count: 40 }));
	check("the recipient is notified", notes.includes("sent you $12.50") && notes.includes(`/i/xmoney/p/${payId}`));
	const idem = crypto.randomUUID();
	await sa.send({ to: b, amount: "1", idem });
	await sa.send({ to: b, amount: "1", idem });
	check("a double-pressed Send moves the money once", (await balance(a)) === 8650);

	check("too much is refused", (await sa.send({ to: b, amount: "5000" })).status === 400);
	check("more than the balance is refused", (await sa.send({ to: b, amount: "999" })).status === 400 && (await balance(a)) === 8650);
	check("zero is refused", (await sa.send({ to: b, amount: "0" })).status === 400);
	check("yourself is refused", (await sa.send({ to: a, amount: "1" })).status === 400);
	check("an unknown account is refused", (await sa.send({ to: "nobody_here_x", amount: "1" })).status === 400);
	check("a long note is refused", (await sa.send({ to: b, amount: "1", note: "x".repeat(141) })).status === 400);

	await sql`delete from posts where user_id = any(${sql.array(ids, "INT8")})`;
	await sql`insert into blocks (blocker_id, blocked_id) values (${ids[2]}::bigint, ${ids[0]}::bigint)`;
	check("a blocked account is refused", (await sa.send({ to: c, amount: "1" })).status === 400);

	// ten $20 sends at once from $113.50: five go through, none overdraws
	await Promise.all(Array.from({ length: 10 }, () => sb.send({ to: a, amount: "20" })));
	check("concurrent sends never overdraw", (await balance(b))! >= 0 && (await balance(b))! + (await balance(a))! === 8650 + 11350 && (await balance(b)) === 1350, [await balance(a), await balance(b)]);

	// ---- Admin > Money
	const admin = adminCall;
	check("the Money page has no admin form any more", !(await sa.page()).includes('value="adjust"'));
	check("a non-admin can't adjust", (await admin(sb, "adjustMoney", { handle: a, amount: "50" })).status === 403);
	await sql`update users set role = 'admin' where id = ${ids[0]}::bigint`;
	const before = (await balance(b))!;
	r = await admin(sa, "adjustMoney", { handle: b, amount: "50" });
	check("an admin adds money", r.status === 200 && (await balance(b)) === before + 5000, r.status);
	await admin(sa, "adjustMoney", { handle: b, amount: "-100000" });
	check("and takes it away, never below zero", (await balance(b)) === 0);
	const overview = await (await admin(sa, "money")).json();
	check("the admin page totals the money", overview.totals.wallets >= 3 && overview.settings.like_cents === 50 && overview.recent.length > 0, overview.totals);
	const was = { ...overview.settings };
	check("bad settings are refused", (await admin(sa, "saveMoney", { starting: "lots", max_transfer: "1000", like: "0.5" })).status === 400);
	r = await admin(sa, "saveMoney", { starting: "25", max_transfer: "500", like: "0.10" });
	check("settings are saved", r.status === 200 && (await (await admin(sa, "money")).json()).settings.like_cents === 10);
	check("and used: a payment over the new limit is refused", (await sa.send({ to: b, amount: "600" })).status === 400);
	await admin(sa, "saveMoney", { starting: String(was.starting_cents / 100), max_transfer: String(was.max_transfer_cents / 100), like: String(was.like_cents / 100) });
	await sql`update money_wallets set balance_cents = 1000 where user_id = ${ids[0]}::bigint`;
	r = await sa.send({ to: b, amount: "4" });
	const revId = new URL(r.headers.get("location")!, origin).searchParams.get("sent")!;
	r = await admin(sa, "reverseTransfer", { id: revId });
	check("an admin reverses a payment", r.status === 200 && (await balance(a)) === 1000 && (await balance(b)) === 0, r.status);
	check("only once", (await admin(sa, "reverseTransfer", { id: revId })).status === 400);
	// the payments feed
	const feedName = `m${stamp}e`;
	const feedId = await createUser(feedName, "Economy", "testpass123");
	ids.push(feedId);
	check("the feed must be an account here", (await admin(sa, "saveMoney", { starting: "5", max_transfer: "1000", like: "0.5", feed: "@nobody_here_x" })).status === 400);
	check("the feed is set", (await admin(sa, "saveMoney", { starting: String(was.starting_cents / 100), max_transfer: String(was.max_transfer_cents / 100), like: String(was.like_cents / 100), feed: `@${feedName}` })).status === 200);
	check("the Send screen says payments are public", (await sa.page("/send")).includes(`posted publicly by <a href="/${feedName}">`));
	r = await sa.send({ to: b, amount: "2", note: "secret stuff" });
	const fedId = new URL(r.headers.get("location")!, origin).searchParams.get("sent")!;
	await Bun.sleep(500);
	const [fed] = await sql`select id::text, text from posts where user_id = ${feedId}::bigint`;
	check("each payment is posted by the feed account, with names", fed?.text === `Money A sent $2 to Money B! #Money http://localhost:${process.env.PORT ?? 3000}/i/xmoney/p/${fedId}`, fed?.text);
	const fedPost = (await sb.get("TweetDetail", { focalTweetId: fed.id })) as any;
	const fedJson = JSON.stringify(fedPost);
	check("its post reads as the payment over the card", fedJson.includes(`"display_text_range":[0,${"Money A sent $2 to Money B! #Money".length}]`) && fedJson.includes('"name":"summary"'));
	check("and mentions nobody", !JSON.stringify(await sb.get("NotificationsTimeline", { timeline_type: "Mentions", count: 40 })).includes("#Money") && !(await sql`select 1 from post_mentions where post_id = ${fed.id}::bigint`).length);
	const fedCard = (await sc.json(`money/cards?ids=p${fedId}&by=${feedName}`))[`p${fedId}`] as string;
	check("anyone sees its card", typeof fedCard === "string");
	check("naming both sides", fedCard?.includes("Money A") && fedCard?.includes("Money B") && fedCard?.includes("sent to"));
	check("without the note", !fedCard?.includes("secret stuff"));
	const spoofed = (await sc.json(`money/cards?ids=p${fedId}&by=${a}`))[`p${fedId}`] as string;
	check("a stranger naming someone else as the poster still gets no note", typeof spoofed === "string" && !spoofed.includes("secret stuff"));
	check("nor on the payment's page", !(await (await fetch(`${origin}/account/money/p/${fedId}`, { headers: sc.headers })).text()).includes("secret stuff"));
	await admin(sa, "reverseTransfer", { id: fedId });
	check("reversing a payment takes its feed post down", !(await sql`select 1 from posts where user_id = ${feedId}::bigint`).length);
	await admin(sa, "saveMoney", { starting: String(was.starting_cents / 100), max_transfer: String(was.max_transfer_cents / 100), like: String(was.like_cents / 100), feed: "" });
	r = await sa.send({ to: b, amount: "1" });
	await Bun.sleep(300);
	check("with no feed set nothing is posted", !(await sql`select 1 from posts where user_id = ${feedId}::bigint`).length);
	check("and both sides see it reversed", (await sa.page(`/p/${revId}`)).includes("Reversed") && (await sb.page()).includes("Reversed"));
	await sql`update money_wallets set balance_cents = 0 where user_id = ${ids[1]}::bigint`;

	const shell = await fetch(`${origin}/account/money`, { headers: { ...sa.headers, "sec-fetch-dest": "document" }, redirect: "manual" });
	check("opened on its own, it goes to the client's page", shell.status === 302 && shell.headers.get("location") === "/i/xmoney", shell.headers.get("location"));
	check("signed out it isn't there", (await fetch(`${origin}/account/money`, { redirect: "manual" })).status === 302);

	// ---- earning from likes
	await sql`update money_wallets set balance_cents = 10000 where user_id = any(${sql.array(ids, "INT8")})`;
	const liked = (await sc.gql("CreateTweet", { tweet_text: "like me" })).data.create_tweet.tweet_results.result.rest_id;
	await sb.gql("FavoriteTweet", { tweet_id: liked });
	check("a like pays the post's author 50¢", (await balance(c)) === 10050, await balance(c));
	await sb.gql("UnfavoriteTweet", { tweet_id: liked });
	await sb.gql("FavoriteTweet", { tweet_id: liked });
	check("unliking and liking again pays nothing more", (await balance(c)) === 10050);
	await sc.gql("FavoriteTweet", { tweet_id: liked });
	check("liking your own post pays nothing", (await balance(c)) === 10050);
	check("earnings show in Activity", (await sc.page()).includes("Likes on your posts"));

	// ---- a request of one account
	r = await sb.form("/account/money/request", { from: a, amount: "5", note: "pizza" });
	const reqId = /\/account\/money\/r\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1];
	check("a request is made", r.status === 303 && !!reqId, r.status);
	const aNotes = JSON.stringify(await sa.get("NotificationsTimeline", { timeline_type: "All", count: 40 }));
	check("the account asked is notified", aNotes.includes("requested $5.00 from you") && aNotes.includes(`/i/xmoney/r/${reqId}`));
	check("and sees it on the Money page", (await sa.page()).includes("Asks for $5"));
	check("someone else can't see it", (await fetch(`${origin}/account/money/r/${reqId}`, { headers: sc.headers })).status === 404);
	check("paying the wrong amount is refused", (await sa.form("/account/money/send", { to: b, amount: "4", request: reqId!, idem: crypto.randomUUID() })).status === 400);
	r = await sa.form("/account/money/send", { to: b, amount: "5", request: reqId!, idem: crypto.randomUUID() });
	const [paidReq] = await sql`select status from money_requests where id = ${reqId}::bigint`;
	check("paying it pays and closes it", r.status === 303 && paidReq.status === "paid" && (await balance(b)) === 10500, [r.status, paidReq.status]);
	check("it can't be paid twice", (await sa.form("/account/money/send", { to: b, amount: "5", request: reqId!, idem: crypto.randomUUID() })).status >= 400 && (await balance(b)) === 10500);

	// reversing a request's payment puts it back in front of its payer
	r = await sb.form("/account/money/request", { from: a, amount: "2", note: "reverse me" });
	const revReqId = /\/r\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1];
	r = await sa.form("/account/money/send", { to: b, amount: "2", request: revReqId!, idem: crypto.randomUUID() });
	const revPayId = new URL(r.headers.get("location")!, origin).searchParams.get("sent")!;
	check("a request can be paid", r.status === 303 && (await sb.page(`/r/${revReqId}`)).includes("Paid"), r.status);
	r = await admin(sa, "reverseTransfer", { id: revPayId });
	const [reopened] = await sql`select status, resolved_at from money_requests where id = ${revReqId}::bigint`;
	check("reversing its payment reopens the request", r.status === 200 && reopened?.status === "open" && reopened?.resolved_at === null, [r.status, reopened]);
	const reopenedPage = await sb.page(`/r/${revReqId}`);
	check("and it no longer counts as paid", reopenedPage.includes("Waiting") && !reopenedPage.includes("Paid"));
	r = await sa.form("/account/money/send", { to: b, amount: "2", request: revReqId!, idem: crypto.randomUUID() });
	check("so the payer can pay it again", r.status === 303, r.status);

	r = await sb.form("/account/money/request", { from: a, amount: "3", note: "" });
	const declineId = /\/r\/(\d+)/.exec(r.headers.get("location") ?? "")?.[1];
	await sa.form(`/account/money/r/${declineId}`, { action: "decline" });
	const bNotes = JSON.stringify(await sb.get("NotificationsTimeline", { timeline_type: "All", count: 40 }));
	check("declining tells the requester", bNotes.includes("declined your request for $3.00"));
	check("asking without an amount of one account is refused", (await sb.form("/account/money/request", { from: a, amount: "", note: "" })).status === 400);

	// ---- a Pay button anyone can use
	const payMe = await sb.postApi("money/payme");
	check("the composer's Pay button makes a request link", /\/i\/xmoney\/r\/\d+$/.test(payMe.url ?? ""), payMe);
	check("and gives the same one again", (await sb.postApi("money/payme")).url === payMe.url);
	const openId = payMe.url.split("/").pop();
	const payPost = (await sb.gql("CreateTweet", { tweet_text: `Testing ${payMe.url}` })).data.create_tweet.tweet_results.result;
	check("a post with it gets a Pay card", JSON.stringify(payPost.card ?? {}).includes(`Pay @${b}`));
	const payCard = (await sc.json(`money/cards?ids=r${openId}&by=${b}`))[`r${openId}`] as string;
	check("the card has a Pay button for others", payCard.includes(`Pay @${b}`) && payCard.includes(`send?request=${openId}`));
	const ownCard = (await sb.json(`money/cards?ids=r${openId}&by=${b}`))[`r${openId}`] as string;
	check("its owner's Pay button opens the request instead", ownCard.includes("xm-pay") && ownCard.includes(`/account/money/r/${openId}`) && !ownCard.includes("send?request="));
	check("the card leads to the account to pay", payCard.includes(`data-xm-go="/${b}"`));
	r = await sc.form("/account/money/send", { to: b, amount: "2.25", request: openId, idem: crypto.randomUUID() });
	const openPayC = new URL(r.headers.get("location")!, origin).searchParams.get("sent")!;
	r = await sa.form("/account/money/send", { to: b, amount: "1", request: openId, idem: crypto.randomUUID() });
	check("anyone pays it, as often as they like", (await sb.page(`/r/${openId}`)).includes("2 times"));
	await admin(sa, "reverseTransfer", { id: openPayC });
	check("a reversed payment no longer counts toward an open request", (await sb.page(`/r/${openId}`)).includes("1 time · $1.00"));
	const copiedPay = (await sc.gql("CreateTweet", { tweet_text: `pay them ${payMe.url}` })).data.create_tweet.tweet_results.result;
	check("someone else's post with it gets no card", !copiedPay.card);

	// ---- merchant mode and badges
	r = await sa.form("/account/merchant", { on: "1", name: "Shop A" });
	check("merchant mode is only for gold organisations", !(await sql`select 1 from money_merchants where user_id = ${ids[0]}::bigint`).length);
	await sql`update users set verified_type = 'business' where id = ${ids[2]}::bigint`;
	await sc.form("/account/merchant", { on: "1", name: "Taco Bell", banner: "1" });
	const [merchant] = await sql`select name from money_merchants where user_id = ${ids[2]}::bigint`;
	check("a gold organisation turns it on", merchant?.name === "Taco Bell");
	r = await sb.send({ to: c, amount: "3.52", note: "" });
	const shopId = new URL(r.headers.get("location")!, origin).searchParams.get("sent")!;
	const shopCard = (await sb.json(`money/cards?ids=p${shopId}&by=${b}`))[`p${shopId}`] as string;
	check("payments to it read as purchases", shopCard.includes("$3.52") && shopCard.includes("Taco Bell") && shopCard.includes(">at<"));
	check("with its gold checkmark", shopCard.includes("#e2b719"));
	check("and leads to the account paid", shopCard.includes(`data-xm-go="/${c}"`));
	await sql`insert into affiliations (org_id, user_id) values (${ids[2]}::bigint, ${ids[1]}::bigint) on conflict do nothing`;
	r = await sa.send({ to: b, amount: "1", note: "" });
	const affId = new URL(r.headers.get("location")!, origin).searchParams.get("sent")!;
	const affCard = (await sa.json(`money/cards?ids=p${affId}&by=${a}`))[`p${affId}`] as string;
	check("an affiliate wears a blue check and its organisation", affCard.includes("#1d9bf0") && affCard.includes('class="xm-org"'));

	// ---- the To field's list of accounts
	const people = async (q: string) => (await fetch(`${origin}/account/money/people?q=${encodeURIComponent(q)}`, { headers: sa.headers })).json();
	const found = await people(`@${b.slice(0, -1)}`);
	check("typing in To lists matching accounts", found.some((p: any) => p.screen_name === b) && found.some((p: any) => p.screen_name === c));
	check("never yourself", !found.some((p: any) => p.screen_name === a));
	check("with their checkmarks", typeof found[0]?.badges === "string" && typeof found[0]?.avatar === "string");
	check("by name too", (await people("money b")).some((p: any) => p.screen_name === b));
	// A is an admin by now, and admins can't be blocked: B is
	await sql`insert into blocks (blocker_id, blocked_id) values (${ids[2]}::bigint, ${ids[1]}::bigint) on conflict do nothing`;
	const forB = await (await fetch(`${origin}/account/money/people?q=${c}`, { headers: sb.headers })).json();
	check("not accounts that blocked you", Array.isArray(forB) && !forB.some((p: any) => p.screen_name === c));
	const bSend = await sb.page("/send");
	check("quick picks leave out accounts that blocked you", !bSend.includes(`data-handle="${c}"`), bSend.match(/data-handle="[^"]+"/g));
	await sql`delete from blocks where blocker_id = ${ids[2]}::bigint and blocked_id = ${ids[1]}::bigint`;
	check("odd input lists nothing", (await people("%_")).length === 0 && (await people("")).length === 0);

	// ---- release checks
	await sql`update money_wallets set balance_cents = 10000 where user_id = any(${sql.array(ids.slice(0, 3), "INT8")})`;
	const twice = crypto.randomUUID();
	const both = await Promise.all([sa.send({ to: b, amount: "1", idem: twice }), sa.send({ to: b, amount: "1", idem: twice })]);
	check("two presses of Send at once move the money once", both.every((x) => x.status === 303) && (await balance(a)) === 9900, both.map((x) => x.status));
	await sql`update users set status = 'restricted' where id = ${ids[2]}::bigint`;
	const refused = await sc.form("/account/money/request", { from: a, amount: "1", note: "" });
	check("a restricted account can't ask for money", refused.status === 400 && (await refused.text()).includes("can't ask for money"));
	const payMeRefused = await fetch(`${origin}/i/api/xitter/money/payme`, { method: "POST", headers: { ...sc.headers, "x-csrf-token": csrfOf(sc) } });
	check("and its Pay button gets a clean refusal", payMeRefused.status === 403 && (await payMeRefused.text()).includes("can't ask for money"), payMeRefused.status);
	await sql`update users set status = 'active' where id = ${ids[2]}::bigint`;
	await sql`update users set role = 'moderator' where id = ${ids[1]}::bigint`;
	const modView = await (await admin(sb, "money")).json();
	check("moderators see payments but not their notes", modView.notes === false && modView.recent.length > 0 && modView.recent.every((r: any) => r.note === ""));
	check("and can't change anything", (await admin(sb, "adjustMoney", { handle: a, amount: "5" })).status === 403);
	await sql`update users set role = null where id = ${ids[1]}::bigint`;
	await sql`update users set banner_url = ${'/media/x.png") , url(https://evil.example/'} where id = ${ids[2]}::bigint`;
	const oddBanner = (await sb.json(`money/cards?ids=p${shopId}&by=${b}`))[`p${shopId}`] as string;
	check("a banner address that could break out of the card's style is left out", !oddBanner.includes("evil.example"));
	await sql`update users set banner_url = null where id = ${ids[2]}::bigint`;

	// ---- switched off: posts keep their cards, everything else goes
	await admin(sa, "saveSettings", { features: { ...featuresBefore, money: false } });
	try {
		const offCard = (await sc.json(`money/cards?ids=r${openId}&by=${b}`))[`r${openId}`] as string;
		check("off: a post's Pay card still shows", typeof offCard === "string" && offCard.includes(`Pay @${b}`));
		check("off: without its Pay button", !offCard.includes("xm-pay"));
		check("off: payment cards still show", typeof (await sa.json(`money/cards?ids=p${affId}&by=${a}`))[`p${affId}`] === "string");
		check("off: the Money pages are closed", (await fetch(`${origin}/account/money`, { headers: sa.headers })).status === 404 && (await fetch(`${origin}/account/money/r/${openId}`, { headers: sc.headers })).status === 404);
		check("off: nothing can be sent", (await sa.send({ to: b, amount: "1" })).status === 404);
		const offNotes = JSON.stringify(await sa.get("NotificationsTimeline", { timeline_type: "All", count: 40 }));
		check("off: no money notifications", !offNotes.includes("/i/xmoney/"));
		check("off: no composer list", (await sa.json("money/recent")).length === 0);
	} finally {
		await admin(sa, "saveSettings", { features: { ...featuresBefore, money: true } });
	}
} finally {
	if (featuresBefore) await adminCall(await signIn(`m${stamp}x`), "saveSettings", { features: featuresBefore });
	for (const id of ids) {
		await sql`delete from audit_log where target = ${id}`;
		await sql`delete from money_like_rewards where author_id = ${id}::bigint or liker_id = ${id}::bigint`;
		await sql`delete from posts where user_id = ${id}::bigint`;
		await sql`delete from users where id = ${id}::bigint`;
	}
	await sql.close();
}
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
