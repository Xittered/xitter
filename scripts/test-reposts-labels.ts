// Acting on a repost by its own id (the client does), a notification's preview of
// a post with a staff notice, the parody label, the account list's default
// picture and the sign-up name messages. Puts everything back afterwards.
// usage: bun scripts/test-reposts-labels.ts <author> <other> <password>
import { sql } from "../src/db";

const [authorName = "pozo", otherName = "goldcorp", password = "testpass123"] = process.argv.slice(2);
const origin = `http://localhost:${process.env.PORT ?? 3000}`;
let failed = 0;
const check = (ok: unknown, what: string, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined || ok ? "" : `: ${JSON.stringify(detail).slice(0, 300)}`}`);
	if (!ok) failed++;
};

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))!.slice(4), "content-type": "application/json" };
	const token = cookies.find((c) => c.startsWith("auth_token="))!.slice(11);
	const gql = async (op: string, vars: any = {}) => (await (await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers, body: JSON.stringify({ variables: vars }) })).json()) as any;
	const get = async (op: string, vars: any = {}) => (await (await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(vars))}`, { headers })).json()) as any;
	return { headers, token, gql, get };
}

const author = await session(authorName);
const other = await session(otherName);
const otherId = (await sql`select id::text from users where screen_name = ${otherName}`)[0].id as string;
const made: string[] = [];
const [savedLabel] = await sql`select parody_label, parody_label_at from users where id = ${otherId}::bigint`;

try {
	// ---- a repost's own id
	let r = await author.gql("CreateTweet", { tweet_text: `repost target ${Date.now()}` });
	const postId = r.data?.create_tweet?.tweet_results?.result?.rest_id;
	made.push(postId);
	r = await other.gql("CreateRetweet", { tweet_id: postId });
	const repostId = r.data?.create_retweet?.retweet_results?.result?.rest_id;
	check(repostId && repostId !== postId, "a repost has its own id", r);
	for (const [op, done] of [["FavoriteTweet", "favorite_tweet"], ["CreateBookmark", "tweet_bookmark_put"]] as const) {
		r = await author.gql(op, { tweet_id: repostId });
		check(r.data?.[done] === "Done", `${op} by the repost's id works`, r);
	}
	const [marks] = await sql`select (select count(*)::int from likes where post_id = ${postId}::bigint) as likes, (select count(*)::int from bookmarks where post_id = ${postId}::bigint) as bookmarks`;
	check(marks.likes === 1 && marks.bookmarks === 1, "and lands on the original post", marks);
	r = await author.gql("UnfavoriteTweet", { tweet_id: repostId });
	r = await author.gql("DeleteBookmark", { tweet_id: repostId });
	const [after] = await sql`select (select count(*)::int from likes where post_id = ${postId}::bigint) as likes, (select count(*)::int from bookmarks where post_id = ${postId}::bigint) as bookmarks`;
	check(after.likes === 0 && after.bookmarks === 0, "undoing by the repost's id works too", after);
	r = await author.get("TweetResultByRestId", { tweetId: repostId });
	check(r.data?.tweetResult?.result?.rest_id === postId, "opening a repost's id shows the original", r);
	r = await other.gql("DeleteRetweet", { source_tweet_id: repostId });
	check(r.data?.unretweet?.source_tweet_results?.result?.rest_id === postId, "undoing a repost by its own id", r);

	// ---- a notification's preview of a post with a notice
	await sql`update posts set notice = ${JSON.stringify({ type: "Misleading", text: "This post may be misleading." })}::text::jsonb where id = ${postId}::bigint`;
	await other.gql("FavoriteTweet", { tweet_id: postId });
	r = await author.get("NotificationsTimeline", { timeline_type: "All", count: 20 });
	const entries = r.data?.viewer_v2?.user_results?.result?.notification_timeline?.timeline?.instructions?.flatMap((i: any) => i.entries ?? []) ?? [];
	const ref = entries
		.flatMap((e: any) => e.content?.itemContent?.template?.target_objects ?? [])
		.find((t: any) => t.tweet_results?.result?.rest_id === postId);
	check(ref?.tweet_results?.result?.__typename === "Tweet", "a notification carries a misleading post as a plain post, so its preview shows", ref);
	r = await author.get("TweetResultByRestId", { tweetId: postId });
	check(r.data?.tweetResult?.result?.softInterventionPivot?.softInterventionDisplayType === "Misleading", "the post itself keeps its notice", r.data?.tweetResult?.result?.__typename);

	// ---- the parody label
	await sql`update users set parody_label = 'None', parody_label_at = null where id = ${otherId}::bigint`;
	r = await other.gql("AccountParodyScreenImplV2ParodyLabelMutation", { parodyProfileLabel: "Fan" });
	check(r.data?.update_parody_label?.parody_commentary_fan_label === "Fan", "the label is set", r);
	r = await author.get("UserByScreenName", { screen_name: otherName });
	// the label travels in the slot user cells read too (model.ts badgeLabel)
	check(r.data?.user?.result?.affiliates_highlighted_label?.label?.description === "Fan account", "the profile carries it", r.data?.user?.result?.affiliates_highlighted_label);
	r = await other.get("AccountParodyScreenImplV2ParodyLabelSettingQuery");
	check(r.data?.get_parody_label_settings?.is_label_update_disabled === true, "then it's locked for 48 hours", r);
	r = await other.gql("AccountParodyScreenImplV2ParodyLabelMutation", { parodyProfileLabel: "Parody" });
	check(r.errors?.length, "a change inside the lock is refused", r);
	r = await other.gql("AccountParodyScreenImplV2ParodyLabelMutation", { parodyProfileLabel: "Satire" });
	check(r.errors?.length, "unknown labels are refused", r);

	// ---- the account list's pictures
	const list = await fetch(`${origin}/i/api/1.1/account/multi/list.json`, { headers: { cookie: `auth_token=${author.token}; auth_multi=${other.token}` } });
	const users = ((await list.json()) as any).users ?? [];
	check(users[0]?.avatar_image_url?.startsWith("http"), "the account list gives every account a picture", users[0]);

	// ---- sign-up name messages
	const begin = async (name: string) => new TextDecoder("latin1").decode(await (await fetch(`${origin}/onboarding/web/actions/begin_login`, { method: "POST", body: new URLSearchParams({ username_or_email: name }) })).arrayBuffer());
	check((await begin("mariuszmika_priv")).includes("at most 15 characters"), "a 16-character name says it's too long, not that underscores are wrong");
	check((await begin("bad-name")).includes("letters, digits and underscores"), "a name with a dash says which characters work");
	check((await begin("abc")).includes("at least 4"), "a short name says it's too short");
} finally {
	for (const id of made) await author.gql("DeleteTweet", { tweet_id: id });
	await sql`update users set parody_label = ${savedLabel.parody_label}, parody_label_at = ${savedLabel.parody_label_at} where id = ${otherId}::bigint`;
}

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
