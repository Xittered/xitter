// End-to-end check of scheduled posts and drafts against a running server.
// Takes about a minute: the scheduler runs every 15 seconds and the shortest
// lead is 30. Removes what it creates.
// usage: bun scripts/test-scheduled.ts <user> <password>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [name, password] = process.argv.slice(2);
if (!name || !password) throw new Error("usage: bun scripts/test-scheduled.ts <user> <password>");

const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error("login failed");
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
const gql = async (op: string, variables: object) =>
	(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
const get = async (op: string, variables: object) =>
	(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const now = Math.floor(Date.now() / 1000);
const past = await gql("CreateScheduledTweet", { post_tweet_request: { status: "too soon" }, execute_at: now + 5 });
check("a time in the next 30 seconds is refused", !!past.errors?.length);

// the length limit holds for scheduled posts and drafts, not only the composer
const long = "a ".repeat(130000);
const tooLong = await gql("CreateScheduledTweet", { post_tweet_request: { status: long }, execute_at: now + 3600 });
check("an over-long scheduled post is refused", !!tooLong.errors?.length && !tooLong.data?.tweet);
const longDraft = await gql("CreateDraftTweet", { post_tweet_request: { status: long } });
check("an over-long draft is refused", !!longDraft.errors?.length && !longDraft.data?.tweet);

const text = `scheduled ${now}`;
const made = await gql("CreateScheduledTweet", { post_tweet_request: { status: text, media_ids: "" }, execute_at: now + 35 });
const id = made.data?.tweet?.rest_id;
check("schedule", !!id, made.errors);

const kept = await gql("CreateScheduledTweet", { post_tweet_request: { status: "to delete" }, execute_at: now + 3600 });
const listed = (await get("FetchScheduledTweets", { ascending: true })).data.viewer.scheduled_tweet_list;
check("listed with time and state", listed.some((x: any) => x.rest_id === id && x.scheduling_info?.state === "Scheduled" && x.tweet_create_request?.status === text) && listed.length >= 2);
const gone = await gql("DeleteScheduledTweet", { scheduled_tweet_id: kept.data.tweet.rest_id });
check("delete", !gone.errors);
const after = (await get("FetchScheduledTweets", { ascending: true })).data.viewer.scheduled_tweet_list;
check("deleted one is gone", !after.some((x: any) => x.rest_id === kept.data.tweet.rest_id));

const draft = await gql("CreateDraftTweet", { post_tweet_request: { status: "a draft" } });
const drafts = (await get("FetchDraftTweets", {})).data.viewer.draft_list.response_data;
check("draft saved and listed", drafts.some((d: any) => d.rest_id === draft.data?.tweet?.rest_id && d.tweet_create_request.status === "a draft"));
await gql("DeleteDraftTweets", { draft_tweet_ids: [draft.data.tweet.rest_id] });
check("drafts deleted", !(await get("FetchDraftTweets", {})).data.viewer.draft_list.response_data.some((d: any) => d.rest_id === draft.data.tweet.rest_id));

// wait for the scheduler
let posted: string | undefined;
for (let i = 0; i < 12 && !posted; i++) {
	await Bun.sleep(5000);
	const user = (await get("UserByScreenName", { screen_name: name })).data.user.result;
	const tl = (await get("UserOriginalsTimeline", { userId: user.rest_id, count: 10 })).data.user.result.timeline.timeline;
	const entries = (tl.instructions ?? []).flatMap((i: any) => i.entries ?? []);
	posted = entries.map((e: any) => e.content?.itemContent?.tweet_results?.result).find((t: any) => t?.legacy?.full_text === text)?.rest_id;
}
check("the post appears when its time comes", !!posted);
check("and leaves the scheduled list", !(await get("FetchScheduledTweets", {})).data.viewer.scheduled_tweet_list.some((x: any) => x.rest_id === id));
if (posted) await gql("DeleteTweet", { tweet_id: posted });
for (const x of (await get("FetchScheduledTweets", {})).data.viewer.scheduled_tweet_list) if (x.tweet_create_request?.status === text) await gql("DeleteScheduledTweet", { scheduled_tweet_id: x.rest_id });

console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
