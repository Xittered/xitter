// End-to-end check of blocks, muted accounts and muted words against a running
// server. Uses two existing accounts and removes what it creates.
// usage: bun scripts/test-blocks.ts <user A> <user B> <password of both>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-blocks.ts <user A> <user B> <password>");

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	const rest = async (path: string, form: Record<string, string> = {}, method = "POST") =>
		(await fetch(`${origin}/i/api/1.1/${path}`, method === "POST" ? { method, headers, body: new URLSearchParams(form) } : { headers })).json();
	return { gql, get, rest };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const entriesOf = (timeline: any): any[] => (timeline?.instructions ?? []).flatMap((i: any) => i.entries ?? []);
const postIds = (timeline: any) => entriesOf(timeline).map((e) => e.content?.itemContent?.tweet_results?.result?.rest_id).filter(Boolean);
const userIds = (timeline: any) => entriesOf(timeline).map((e) => e.content?.itemContent?.user_results?.result?.rest_id).filter(Boolean);

const a = await session(nameA);
const b = await session(nameB);
const userA = (await a.get("UserByScreenName", { screen_name: nameA })).data.user.result;
const userB = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
// the block ends follows; put back what was there
const before = userB.relationship_perspectives;
const home = async () => postIds((await a.get("HomeTimeline", { count: 40 })).data.home.home_timeline_urt);
const created: [typeof a, string][] = [];
const post = async (s: typeof a, text: string, extra: object = {}) => {
	const r = await s.gql("CreateTweet", { tweet_text: text, ...extra });
	const id = r.data?.create_tweet?.tweet_results?.result?.rest_id;
	if (id) created.push([s, id]);
	return { id, errors: r.errors };
};

// mutes: B's posts leave A's home feed but stay on B's profile
const byB = await post(b, "a post by B for the mute test");
const postA = await post(a, "a post by A for the block test");
check("B's post is in A's home feed", (await home()).includes(byB.id));
await a.rest("mutes/users/create.json", { user_id: userB.rest_id });
check("muted: the profile says so", (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result.relationship_perspectives.muting === true);
check("muted: B's post left A's home feed", !(await home()).includes(byB.id));
check("muted: B's profile still shows it", postIds((await a.get("UserTweets", { userId: userB.rest_id, count: 20 })).data.user.result.timeline.timeline).includes(byB.id));
check("muted accounts list holds B", userIds((await a.get("MutedAccounts", { count: 20 })).data.viewer.muting_timeline.timeline).includes(userB.rest_id));
await a.rest("mutes/users/destroy.json", { user_id: userB.rest_id });
check("unmuted: B's post is back", (await home()).includes(byB.id));

// muted words
const word = `zxq${Date.now() % 100000}`;
const worded = await post(b, `this one has ${word} in it`);
let list = await a.rest("mutes/keywords/create.json", { keyword: word, mute_surfaces: "home_timeline,tweet_replies,notifications", mute_options: "", duration: "" });
const kw = list.muted_keywords?.find((k: any) => k.keyword === word);
check("muted word is listed", !!kw, list);
check("muted word hides the post from home", !(await home()).includes(worded.id));
list = await a.rest("mutes/keywords/update.json", { id: kw?.id ?? "0", mute_surfaces: "notifications", mute_options: "" });
check("muted word updated to notifications only", list.muted_keywords?.find((k: any) => k.id === kw?.id)?.mute_surfaces?.join() === "notifications");
check("post is back in home after the update", (await home()).includes(worded.id));
list = await a.rest("mutes/keywords/destroy.json", { ids: kw?.id ?? "0" });
check("muted word removed", !list.muted_keywords?.some((k: any) => k.keyword === word));

// blocks: follows end both ways, nobody sees the other, replies and follows are refused
await a.rest("friendships/create.json", { user_id: userB.rest_id });
await b.rest("friendships/create.json", { user_id: userA.rest_id });
await a.rest("blocks/create.json", { user_id: userB.rest_id });
const seenByA = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result.relationship_perspectives;
const seenByB = (await b.get("UserByScreenName", { screen_name: nameA })).data.user.result.relationship_perspectives;
check("blocking shows on both sides", seenByA.blocking === true && seenByB.blocked_by === true, { seenByA, seenByB });
check("both follows ended", !seenByA.following && !seenByA.followed_by, seenByA);
check("blocked: B's post left A's home feed", !(await home()).includes(byB.id));
check("blocked: B sees no posts on A's profile", !postIds((await b.get("UserTweets", { userId: userA.rest_id, count: 20 })).data.user.result.timeline.timeline).includes(postA.id));
const reply = await post(b, "replying anyway", { reply: { in_reply_to_tweet_id: postA.id } });
check("blocked: B can't reply to A", !reply.id && !!reply.errors);
await b.rest("friendships/create.json", { user_id: userA.rest_id });
check("blocked: B can't follow A", (await b.get("UserByScreenName", { screen_name: nameA })).data.user.result.relationship_perspectives.following === false);
check("blocked accounts list holds B", userIds((await a.get("BlockedAccountsAll", { count: 20 })).data.viewer.timeline.timeline).includes(userB.rest_id));
check("blocking doesn't mute", seenByA.muting !== true, seenByA);
await a.rest("blocks/destroy.json", { user_id: userB.rest_id });
check("unblocked: B's post is back", (await home()).includes(byB.id));
await a.rest("mutes/users/create.json", { user_id: userB.rest_id });
await a.rest("blocks/create.json", { user_id: userB.rest_id });
await a.rest("blocks/destroy.json", { user_id: userB.rest_id });
check("unblocking keeps a mute made on its own", (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result.relationship_perspectives.muting === true);
await a.rest("mutes/users/destroy.json", { user_id: userB.rest_id });

if (!before.following) await a.rest("friendships/destroy.json", { user_id: userB.rest_id });
if (before.following) await a.rest("friendships/create.json", { user_id: userB.rest_id });
if (before.followed_by) await b.rest("friendships/create.json", { user_id: userA.rest_id });
for (const [s, id] of created.reverse()) await s.gql("DeleteTweet", { tweet_id: id });
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
