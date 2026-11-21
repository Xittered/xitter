// End-to-end check of the admin panel's API and what its actions do to the
// rest of the site, against a running server. Needs an admin, a plain account
// (the target) and an organisation (gold badge), all with the same password;
// puts everything back afterwards.
// usage: bun scripts/test-admin.ts <admin> <target> <organisation> <password>

import { sql } from "../src/db";
import { decode } from "../src/jetfuel";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [adminName, targetName, orgName, password] = process.argv.slice(2);
if (!adminName || !targetName || !orgName || !password) throw new Error("usage: bun scripts/test-admin.ts <admin> <target> <organisation> <password>");

async function session(username: string, pw = password) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password: pw }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) return undefined;
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const admin = async (action: string, body: object = {}) => {
		const res = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: res.status, ...(await res.json()) };
	};
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	const page = async (path: string) => fetch(`${origin}${path}`, { headers, redirect: "manual" });
	return { admin, gql, get, page, headers };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const entriesOf = (timeline: any): any[] => (timeline?.instructions ?? []).flatMap((i: any) => i.entries ?? []);
const postIds = (timeline: any) => entriesOf(timeline).map((e) => e.content?.itemContent?.tweet_results?.result?.rest_id).filter(Boolean);
const userIds = (timeline: any) => entriesOf(timeline).map((e) => e.content?.itemContent?.user_results?.result?.rest_id).filter(Boolean);

const a = (await session(adminName))!;
let t = (await session(targetName))!;
const o = (await session(orgName))!;
const [target] = await sql`select id::text as id, role, status from users where lower(screen_name) = lower(${targetName})`;
const [org] = await sql`select id::text as id from users where lower(screen_name) = lower(${orgName})`;

// access
check("the panel opens for staff", (await a.page("/admin")).status === 200);
check("and not for others", !(await (await t.page("/admin")).text()).includes("Admin · Xitter") && (await t.admin("stats")).status === 403);
check("the API wants the csrf header", (await fetch(`${origin}/admin/api/stats`, { method: "POST" })).status === 403);
const stats = await a.admin("stats");
check("stats come back", typeof stats.users === "number" && stats.days?.length === 14, stats.users);
check("the user list finds the target", (await a.admin("users", { q: targetName })).users?.some((u: any) => u.id === target.id));

// roles: a moderator can't do admin things or act on an admin
await a.admin("setRole", { id: target.id, role: "moderator" });
t = (await session(targetName))!;
check("a moderator can open the panel", (await t.admin("me")).role === "moderator");
check("but can't edit profiles", (await t.admin("updateUser", { id: org.id, name: "x" })).status === 403);
const [adminRow] = await sql`select id::text as id from users where lower(screen_name) = lower(${adminName})`;
check("or suspend an admin", (await t.admin("setStatus", { id: adminRow.id, status: "suspended" })).status === 403);
await a.admin("setRole", { id: target.id, role: target.role });
// with other admins about (a real one on a dev instance), stepping down would succeed and lock the test out
const [{ admins }] = await sql`select count(*)::int as admins from users where role = 'admin'`;
if (admins === 1) check("the last admin can't step down", (await a.admin("setRole", { id: adminRow.id, role: null })).status === 400);
else console.log(`skip the last admin can't step down (${admins} admins)`);

// standing
const post = (await t.gql("CreateTweet", { tweet_text: "admin test: before" })).data.create_tweet.tweet_results.result.rest_id;
await a.admin("setStatus", { id: target.id, status: "restricted", reason: "Repeated rule violations." });
check("restricted: can't post", !!(await t.gql("CreateTweet", { tweet_text: "admin test: restricted" })).errors);
const restrictedLike = await t.gql("FavoriteTweet", { tweet_id: post });
check("restricted: can't like", restrictedLike.status === 403 && restrictedLike.data.errors?.[0]?.code === 326);
const accountAccess = await t.page("/account/access");
check("restricted: account access alias returns forbidden", accountAccess.status === 403);
check("restricted: account access alias explains the reason", (await accountAccess.text()).includes("Repeated rule violations."));
await a.admin("setStatus", { id: target.id, status: "limited" });
const orgHome = postIds((await o.get("HomeTimeline", { count: 50 })).data.home.home_timeline_urt);
check("limited: gone from a non-follower's home feed", !orgHome.includes(post));
check("limited: still on their own profile", postIds((await o.get("UserTweets", { userId: target.id, count: 20 })).data.user.result.timeline.timeline).includes(post));
await a.admin("setStatus", { id: target.id, status: "suspended" });
const banned = await session(targetName);
check("suspended: signs in", !!banned);
check("suspended: can't use the admin api", (await banned!.admin("me")).status === 403);
check("suspended: the old session is gone", (await t.admin("me")).status === 403);
const unavailable = (await o.get("UserByScreenName", { screen_name: targetName })).data.user?.result;
check("suspended: the profile says so", unavailable?.__typename === "UserUnavailable");
// without both texts the profile page throws and spins forever
check("suspended: with the header and message the page needs", !!unavailable?.unavailable_header?.text && !!unavailable?.unavailable_message?.text);
check("suspended: staff see the same page", (await a.get("UserByScreenName", { screen_name: targetName })).data.user?.result?.__typename === "UserUnavailable");
check("suspended: also by id", (await o.get("UserByRestId", { userId: target.id })).data.user?.result?.__typename === "UserUnavailable");
await a.admin("setStatus", { id: target.id, status: "active" });
t = (await session(targetName))!;
check("reinstated: can sign in again", !!t);

// grey badges: a government organisation has a square picture, an official a round one
for (const [badge, shape, words] of [["government", "Square", "organization account"], ["government_individual", "Circle", "organization official"]]) {
	const set = await a.admin("setBadge", { id: target.id, badge });
	const u = (await o.get("UserByScreenName", { screen_name: targetName })).data.user.result;
	check(`the ${badge} badge`, set.status === 200 && u.verification?.verified_type === "Government" && u.profile_image_shape === shape && u.verification_info?.reason?.description?.text.includes(words), { status: set.status, shape: u.profile_image_shape });
}
await a.admin("setBadge", { id: target.id, badge: "" });
// translator globes: X's "badged" (blue) and "moderator" (yellow; badges.ts makes translator moderators' gold)
for (const [kind, type, gold] of [["translator", "badged", false], ["moderator", "moderator", true], ["approver", "moderator", false]] as const) {
	await a.admin("setTranslator", { id: target.id, translator: kind });
	const u = (await o.get("UserByScreenName", { screen_name: targetName })).data.user.result;
	const extra = await (await fetch(`${origin}/i/api/xitter/badges?names=${targetName}`, { headers: o.headers })).json();
	check(`the ${kind} globe`, u.profile_translation?.translator_type === type && !!extra[targetName.toLowerCase()]?.gold === gold, { type: u.profile_translation, extra });
}
check("an unknown translator badge is refused", (await a.admin("setTranslator", { id: target.id, translator: "wizard" })).status === 400);
await a.admin("setTranslator", { id: target.id, translator: "" });

// organisations
check("the organisation is listed", (await a.admin("orgs")).orgs?.some((x: any) => x.id === org.id));
await a.admin("addAffiliate", { orgId: org.id, screen_name: targetName });
const affiliate = (await o.get("UserByScreenName", { screen_name: targetName })).data.user.result;
const label = affiliate.affiliates_highlighted_label?.label;
check("an affiliate shows the organisation's badge", label?.description && label?.url?.url?.includes(orgName), label);
check("and X's checkmark", affiliate.is_blue_verified === true);
const about = (await o.get("AboutAccountQuery", { screenName: targetName })).data.user_result_by_screen_name.result;
check("About this account names the organisation", about.about_profile?.affiliate_username === orgName && !!about.verification_info?.reason?.verified_since_msec, about.about_profile);
// the profile page asks this first; Relay keeps its answer for the About card
const spot = (await o.get("ProfileSpotlightsQuery", { screen_name: targetName })).data.user_result_by_screen_name;
check("the profile's spotlights query returns the account, not null", spot?.result?.rest_id === target.id);
const reason = affiliate.verification_info?.reason;
check("its checkmark sheet names the organisation", reason?.description?.text?.includes(`affiliate of @${orgName}`) && reason.description.entities.some((e: any) => e.ref.url.endsWith(`/${orgName}`)) && !!reason.verified_since_msec, reason);
const orgUser = (await t.get("UserByScreenName", { screen_name: orgName })).data.user.result;
check("the organisation counts its affiliates", orgUser.business_account?.affiliates_count >= 1, orgUser.business_account);
check("and lists them on its Affiliates tab", userIds((await t.get("UserBusinessProfileTeamTimeline", { userId: org.id, count: 20 })).data.user.result.timeline.timeline).includes(target.id));
await a.admin("removeAffiliate", { orgId: org.id, userId: target.id });
const removed = (await o.get("UserByScreenName", { screen_name: targetName })).data.user.result;
check("removed affiliates lose the badge", !removed.affiliates_highlighted_label?.label?.url);
check("and the checkmark", removed.is_blue_verified === false && !removed.verification_info?.reason);

// invites and sign-up mode
const { codes } = await a.admin("createInvite", { count: 1, uses: 1, orgId: org.id });
const name = `adm${Date.now() % 1e8}`;
// sign-up as X's dialog does it: username, invite code, then the account; true when it signs in
async function signup(f: { code: string; username?: string }): Promise<boolean> {
	const act = async (action: string, body: Record<string, string>) => {
		const r = await fetch(`${origin}/i/jfapi/onboarding/web/actions/${action}`, { method: "POST", body: new URLSearchParams(body) });
		const props = decode(new Uint8Array(await r.arrayBuffer())).flatMap(([tag, m]: any) => (tag === 0 ? m.props : []));
		return { token: props.find((p: any) => p[0] === 30)?.[1][1].get("session_token") as string | undefined, cookies: r.headers.getSetCookie() };
	};
	const username = f.username ?? name;
	const { token } = await act("begin_login", { username_or_email: username });
	if (!token) return false;
	await act("finish_verification", { session_token: token, code: f.code.replace(/\D/g, "") });
	const done = await act("verify_signup", { session_token: token, name: "Admin Test", username, password: "testpass123", email: `${username.toLowerCase()}@example.com` });
	return done.cookies.some((c) => c.startsWith("auth_token="));
}
await a.admin("setSignupMode", { mode: "closed" });
check("closed: sign-up refuses even good codes", !(await signup({ code: codes[0] })));
await a.admin("setSignupMode", { mode: "invite" });
check("an organisation's invite signs up and affiliates", (await signup({ code: codes[0] })) && (await sql`select 1 from affiliations af join users u on u.id = af.user_id where u.screen_name = ${name}`).length === 1);
const { codes: [revoked] } = await a.admin("createInvite", {});
await a.admin("revokeInvite", { code: revoked });
check("a revoked code is refused", !(await signup({ code: revoked, username: `${name}r` })));
check("invites are listed with who used them", (await a.admin("invites")).invites?.find((i: any) => i.code === codes[0])?.used_by?.includes(name));

// reports: the client's report flow, then the queue
const reportFlow = async (s: any, body: object, start = false) =>
	(await fetch(`${origin}/i/api/1.1/report/flow.json${start ? "?flow_name=report-flow" : ""}`, { method: "POST", headers: { ...s.headers, "content-type": "application/json" }, body: JSON.stringify(body) })).json();
const reported = (await o.gql("CreateTweet", { tweet_text: "admin test: reported" })).data.create_tweet.tweet_results.result.rest_id;
const step1 = await reportFlow(t, { input_flow_data: { requested_variant: JSON.stringify({ reported_tweet_id: reported, source: "reporttweet" }) } }, true);
check("the report flow asks for a reason", step1.subtasks?.[0]?.choice_selection?.choices?.length > 3, step1.subtasks?.[0]?.subtask_id);
const step2 = await reportFlow(t, { flow_token: step1.flow_token, subtask_inputs: [{ subtask_id: "report_reason", choice_selection: { link: "next_link", selected_choices: ["spam"] } }] });
check("then for details", !!step2.subtasks?.[0]?.enter_text);
const step3 = await reportFlow(t, { flow_token: step2.flow_token, subtask_inputs: [{ subtask_id: "report_details", enter_text: { link: "next_link", text: "test details" } }] });
check("then thanks", !!step3.subtasks?.[0]?.cta);
const open = (await a.admin("reports")).reports ?? [];
const report = open.find((r: any) => r.post_id === reported);
check("the report is in the queue", report?.reason === "spam" && report?.details === "test details" && report?.screen_name?.toLowerCase() === orgName.toLowerCase(), report);
check("non-staff can't close reports", (await t.admin("resolveReport", { id: report?.id })).status === 403);
await a.admin("resolveReport", { id: report?.id, status: "dismissed", note: "test" });
check("closing moves it out of the open queue", !(await a.admin("reports")).reports?.some((r: any) => r.id === report?.id));
await o.gql("DeleteTweet", { tweet_id: reported });
await sql`delete from reports where id = ${report?.id ?? 0}::bigint`;

// instance settings
const before = (await a.admin("settings")).settings;
await a.admin("saveSettings", { announcement: { text: "admin test announcement", link: "" }, features: { polls: false }, default_follows: [orgName], rules: "Be kind.\n\nNo spam." });
const homeHtml = await (await t.page("/home")).text();
check("the announcement reaches the page", homeHtml.includes("admin test announcement"));
check("a switched-off feature is hidden", homeHtml.includes('[data-testid="createPollButton"]'));
check("unknown default follows are refused", (await a.admin("saveSettings", { default_follows: ["nobody_here_x"] })).status === 400);
const rules = await (await fetch(`${origin}/rules`)).text();
check("the rules page shows the rules", rules.includes("Be kind.") && rules.includes("No spam."));
const { codes: [followCode] } = await a.admin("createInvite", {});
const followName = `fol${Date.now() % 1e8}`;
await signup({ code: followCode, username: followName });
check("new accounts follow the default accounts", (await sql`select 1 from follows f join users u on u.id = f.follower_id join users o on o.id = f.followee_id where u.screen_name = ${followName} and o.id = ${org.id}::bigint`).length === 1);
await sql`delete from users where screen_name = ${followName}`;
await sql`delete from invites where code = ${followCode}`;
const png = await Bun.file("public/favicon.png").bytes();
const up = await fetch(`${origin}/admin/api/uploadBranding?slot=favicon`, { method: "POST", headers: a.headers, body: png });
check("a logo upload is accepted", up.ok);
check("an SVG upload is refused", !(await fetch(`${origin}/admin/api/uploadBranding?slot=favicon`, { method: "POST", headers: a.headers, body: "<svg/>" })).ok);
await a.admin("resetBranding", { slot: "favicon" });
await a.admin("saveSettings", { announcement: before.announcement, features: before.features, default_follows: before.default_follows, rules: before.rules });

// posts, passwords, audit
check("posts can be found", (await a.admin("posts", { author: targetName })).posts?.some((p: any) => p.id === post));
await a.admin("deletePost", { id: post });
check("and deleted", (await sql`select 1 from posts where id = ${post}::bigint`).length === 0);
const reset = await a.admin("resetPassword", { id: target.id });
check("a password reset gives a working password", !!(await session(targetName, reset.password)));
const log = (await a.admin("audit")).entries ?? [];
check("the audit log records it all", ["set_status", "add_affiliate", "delete_post", "reset_password", "set_signup_mode"].every((x) => log.some((e: any) => e.action === x)));

// labels under a post and the counts it shows
{
	const made = (await o.gql("CreateTweet", { tweet_text: `label test zzlabel${Date.now()}` })).data.create_tweet.tweet_results.result;
	check("labels: an unknown label is refused", (await a.admin("setPostNotice", { id: made.rest_id, type: "Nope" })).status === 400);
	await a.admin("setPostNotice", { id: made.rest_id, type: "Fosnr" });
	const seen = (await a.get("TweetResultByRestId", { tweetId: made.rest_id })).data.tweetResult.result;
	check("labels: the post comes wrapped with the label", seen?.__typename === "TweetWithVisibilityResults" && seen.softInterventionPivot?.softInterventionDisplayType === "Fosnr" && !!seen.softInterventionPivot.text?.text, seen?.softInterventionPivot);
	const found = await a.get("SearchTimeline", { rawQuery: "zzlabel", product: "Latest", count: 20 });
	check("labels: visibility limited keeps it out of search", !JSON.stringify(found).includes(made.rest_id));
	await a.admin("setPostCounts", { id: made.rest_id, counts: { likes: 999, views: 12345 } });
	const counted = (await a.get("TweetResultByRestId", { tweetId: made.rest_id })).data.tweetResult.result.tweet;
	check("counts: the post shows the set counts", counted?.legacy?.favorite_count === 999 && counted?.views?.count === "12345", { likes: counted?.legacy?.favorite_count, views: counted?.views });
	check("counts: a negative count is refused", (await a.admin("setPostCounts", { id: made.rest_id, counts: { likes: -1 } })).status === 400);
	await a.admin("setUserCounts", { id: org.id, counts: { followers: 4242 } });
	const prof = (await a.get("UserByScreenName", { screen_name: orgName })).data.user.result;
	check("counts: the profile shows the set followers", prof?.legacy?.followers_count === 4242 || prof?.relationship_counts?.followers === 4242, prof?.legacy?.followers_count);
	await a.admin("setUserCounts", { id: org.id, counts: {} });
	await o.gql("DeleteTweet", { tweet_id: made.rest_id });
}

// a second admin: the owner (the first admin) outranks them, not the other way round
const ownerFirst = (await sql`select id::text from users where role = 'admin' order by created_at, id limit 1`)[0]?.id === adminRow.id;
if (ownerFirst) {
	await a.admin("setRole", { id: org.id, role: "admin" });
	const o2 = (await session(orgName))!;
	check("owner: another admin can't edit the owner", (await o2.admin("updateUser", { id: adminRow.id, location: "nope" })).status === 403);
	check("owner: nor demote them", (await o2.admin("setRole", { id: adminRow.id, role: null })).status === 403);
	check("owner: the owner can edit another admin", (await a.admin("updateUser", { id: org.id, location: "set by owner" })).status === 200);
	await a.admin("updateUser", { id: org.id, location: "" });
	check("owner: and take their role away", (await a.admin("setRole", { id: org.id, role: null })).status === 200);
} else console.log(`skip owner checks: ${adminName} isn't the first admin`);

// put things back
await sql`update users set password_hash = ${await Bun.password.hash(password)} where id = ${target.id}::bigint`;
await sql`delete from users where screen_name like ${`${name}%`}`;
await sql`delete from invites where code = any(${sql.array([codes[0], revoked], "TEXT")})`;
await sql.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
