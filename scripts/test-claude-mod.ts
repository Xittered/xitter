// The Claude moderator's plumbing against a running server started with
// CLAUDE_MOD_FAKE=1 (claude-mod.ts answers from markers in the text instead of
// calling the API): posts, a profile change and a report, then what was hidden
// and what was filed for staff. Removes what it made.
// usage: CLAUDE_MOD_FAKE=1 on the server; bun scripts/test-claude-mod.ts <user A> <user B> <password of both>
import { sql } from "../src/db";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-claude-mod.ts <user A> <user B> <password>");

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const form = async (path: string, body: Record<string, string>) => fetch(`${origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(body) });
	return { gql, form, headers };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}
// the review runs after the request returns
const settle = () => Bun.sleep(4500);
const post = async (s: Awaited<ReturnType<typeof session>>, text: string) =>
	((await s.gql("CreateTweet", { tweet_text: text })) as any)?.data?.create_tweet?.tweet_results?.result?.rest_id as string;
const reportsFor = (postId: string) => sql`select reason, details, status, note, reporter_id from reports where post_id = ${postId}::bigint order by id`;
const hidden = async (postId: string) => (await sql`select hidden from posts where id = ${postId}::bigint`)[0]?.hidden;

const a = await session(nameA);
const b = await session(nameB);
const made: string[] = [];

const fine = await post(a, `just a normal post ${Date.now()}`);
const bad = await post(a, `CLAUDEMOD_VIOLATION ${Date.now()}`);
const unsure = await post(a, `CLAUDEMOD_BORDERLINE ${Date.now()}`);
const declined = await post(a, `CLAUDEMOD_REFUSE ${Date.now()}`);
made.push(fine, bad, unsure, declined);
check("the posts were made", made.every(Boolean), made);
await settle();

check("a fine post stays up", (await hidden(fine)) === false);
check("a fine post files nothing", (await reportsFor(fine)).length === 0);
check("a clear violation is hidden", (await hidden(bad)) === true);
const badReports = await reportsFor(bad);
check("and filed for staff, by no reporter", badReports.length === 1 && badReports[0].reporter_id === null && badReports[0].reason === "automod_harassment", badReports);
check("saying it was hidden", String(badReports[0]?.details).includes("hidden"));
check("a borderline post stays up", (await hidden(unsure)) === false);
check("and is not filed by default", (await reportsFor(unsure)).length === 0);
check("a declined one is filed for a person", (await reportsFor(declined))[0]?.reason === "automod_review");

// a user's report through the client's flow (reason, then details)
async function report(s: Awaited<ReturnType<typeof session>>, postId: string, reason: string) {
	const json = async (r: Response) => r.json() as Promise<any>;
	const call = (body: object, first = false) =>
		fetch(`${origin}/i/api/1.1/report/flow.json${first ? "?flow_name=report-flow" : ""}`, { method: "POST", headers: { ...s.headers, "content-type": "application/json" }, body: JSON.stringify(body) });
	const start = await json(await call({ input_flow_data: { requested_variant: JSON.stringify({ reported_tweet_id: postId }) } }, true));
	const step = await json(await call({ flow_token: start.flow_token, subtask_inputs: [{ subtask_id: "report_reason", choice_selection: { selected_choices: [reason] } }] }));
	await call({ flow_token: step.flow_token, subtask_inputs: [{ subtask_id: "report_details", enter_text: { text: "please look", link: "next_link" } }] });
}
// a clear violation that slipped past (say the API was down): the report hides it and closes
const reported = await post(b, `CLAUDEMOD_VIOLATION reported ${Date.now()}`);
made.push(reported);
await settle();
await sql`update posts set hidden = false where id = ${reported}::bigint`;
await sql`delete from reports where post_id = ${reported}::bigint`;
await report(a, reported, "harassment");
await settle();
const [triaged] = await reportsFor(reported);
check("a report of a clear violation is actioned", triaged?.status === "actioned" && (await hidden(reported)) === true, triaged);
check("with Claude's note", String(triaged?.note).startsWith("Claude:"), triaged?.note);
// a report of something fine stays open for a person, with Claude's note
const harmless = await post(b, `a perfectly harmless post ${Date.now()}`);
made.push(harmless);
await settle();
await report(a, harmless, "spam");
await settle();
const [dismissed] = await reportsFor(harmless);
check("a report of a fine post stays open with a note", dismissed?.status === "open" && String(dismissed?.note).startsWith("Claude:") && (await hidden(harmless)) === false, dismissed);
// a doubtful one stays open with a summary for staff
const doubtful = await post(b, `CLAUDEMOD_BORDERLINE reported ${Date.now()}`);
made.push(doubtful);
await settle();
await sql`delete from reports where post_id = ${doubtful}::bigint`;
await report(a, doubtful, "hate");
await settle();
const [open] = await reportsFor(doubtful);
check("a doubtful report stays open with a note", open?.status === "open" && String(open?.note).startsWith("Claude:"), open);

// profile: a bio with the marker is filed, nothing changes on the profile
await a.form("/1.1/account/update_profile.json", { description: `CLAUDEMOD_BORDERLINE bio ${Date.now()}` });
await settle();
const [quiet] = await sql`select count(*)::int as n from reports r join users u on u.id = r.user_id where u.screen_name = ${nameA} and r.post_id is null and r.reason like 'automod_%'`;
check("a doubtful bio is not filed by default", quiet.n === 0, quiet);
const bio = await a.form("/1.1/account/update_profile.json", { description: `CLAUDEMOD_VIOLATION bio ${Date.now()}` });
check("the bio saved", bio.ok, bio.status);
await settle();
const [profileReport] = await sql`select reason, details from reports r join users u on u.id = r.user_id where u.screen_name = ${nameA} and r.post_id is null and r.reason like 'automod_%' order by r.id desc limit 1`;
check("a violating bio is filed", !!profileReport && String(profileReport.details).includes("Profile"), profileReport);
for (const n of [1, 2]) {
	await a.form("/1.1/account/update_profile.json", { description: `CLAUDEMOD_VIOLATION bio again ${n} ${Date.now()}` });
	await settle();
}
const [profileOpen] = await sql`select count(*)::int as n from reports r join users u on u.id = r.user_id where u.screen_name = ${nameA} and r.post_id is null and r.reason like 'automod_%' and r.status = 'open'`;
check("more profile edits keep one open report", profileOpen.n === 1, profileOpen);
await a.form("/1.1/account/update_profile.json", { description: "testing xitter" });

// clean up
await sql`delete from reports where post_id = any(${sql.array(made.filter(Boolean), "INT8")}) or (reason like 'automod_%' and post_id is null and user_id = (select id from users where screen_name = ${nameA}))`;
await sql`delete from posts where id = any(${sql.array(made.filter(Boolean), "INT8")})`;
await sql`delete from audit_log where action like 'claude_%' and target = any(${sql.array(made.filter(Boolean), "TEXT")})`;
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
