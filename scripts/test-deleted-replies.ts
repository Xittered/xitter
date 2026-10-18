import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin = "http://localhost:3000";
const password = "testpass123";
let checks = 0;
const check = (ok: unknown, label: string) => {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok  ", label);
};
async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "";
	return async (op: string, variables: Record<string, unknown>) => {
		const res = await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify({ variables }) });
		return (await res.json()) as any;
	};
}
const stamp = Date.now().toString().slice(-8);
const created: string[] = [];
try {
	const [aName, bName] = [`dr_a${stamp}`, `dr_b${stamp}`];
	created.push(await createUser(aName, aName, password), await createUser(bName, bName, password));
	const [a, b] = [await session(aName), await session(bName)];
	const parent = (await a("CreateTweet", { tweet_text: "parent post" })).data.create_tweet.tweet_results.result.rest_id;
	const reply = (await b("CreateTweet", { tweet_text: "reply to a parent", reply: { in_reply_to_tweet_id: parent } })).data.create_tweet.tweet_results.result.rest_id;
	const deeper = (await a("CreateTweet", { tweet_text: "answer to the reply", reply: { in_reply_to_tweet_id: reply } })).data.create_tweet.tweet_results.result.rest_id;
	check((await a("DeleteTweet", { tweet_id: parent })).data, "the parent is deleted");
	const legacy = (await b("TweetResultByRestId", { tweetId: reply })).data.tweetResult.result.legacy;
	check(legacy.in_reply_to_status_id_str === parent, "the reply still points at the deleted post");
	check(legacy.in_reply_to_screen_name === aName, "and still names who it replied to");
	const profile = JSON.stringify(await b("UserTweets", { userId: created[1], count: 40 }));
	check(!profile.includes("reply to a parent"), "it stays off the replier's Posts tab");
	check(JSON.stringify(await b("UserTweetsAndReplies", { userId: created[1], count: 40 })).includes("reply to a parent"), "and stays on their Replies tab");
	const detail = JSON.stringify(await b("TweetDetail", { focalTweetId: reply }));
	check(detail.includes("TweetTombstone") && detail.includes("deleted"), "its thread starts with a deleted post tombstone");
	const deep = JSON.stringify(await b("TweetDetail", { focalTweetId: deeper }));
	check(deep.includes("TweetTombstone") && deep.includes("reply to a parent"), "a deeper reply shows the tombstone above its chain");
	const fresh = (await a("CreateTweet", { tweet_text: "fresh", reply: { in_reply_to_tweet_id: parent } })) as any;
	check(fresh.errors?.length, "replying to the deleted post is refused");
	console.log(`all passed (${checks})`);
} finally {
	for (const id of created) {
		await sql`delete from posts where user_id = ${id}::bigint`;
		await sql`delete from users where id = ${id}::bigint`;
	}
	await sql.end();
}
