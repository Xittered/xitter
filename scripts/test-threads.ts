import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const password = "testpass123";
let checks = 0;
const check = (ok: unknown, label: string, detail: unknown = "") => {
	if (!ok) throw new Error(`${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
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
type Session = Awaited<ReturnType<typeof session>>;
const post = async (s: Session, text: string, replyTo?: string) =>
	(await s("CreateTweet", { tweet_text: text, ...(replyTo ? { reply: { in_reply_to_tweet_id: replyTo } } : {}) })).data.create_tweet.tweet_results.result.rest_id as string;
const instructionsOf = (r: any) => r.data.threaded_conversation_with_injections_v2.instructions as any[];
const entriesOf = (r: any) => instructionsOf(r).flatMap((i) => i.entries ?? []);
const idOf = (item: any) => item.item.itemContent.tweet_results?.result?.rest_id;
const threads = (r: any) => entriesOf(r).filter((e: any) => e.entryId.startsWith("conversationthread-"));
const threadOf = (r: any, id: string) => threads(r).find((e: any) => e.entryId === `conversationthread-${id}`);
const tweetIds = (t: any) => t.content.items.filter((i: any) => i.item.itemContent.itemType === "TimelineTweet").map(idOf);
const cursorOf = (t: any) => t.content.items.find((i: any) => i.item.itemContent.itemType === "TimelineTimelineCursor")?.item.itemContent;

const stamp = Date.now().toString().slice(-8);
const created: string[] = [];
try {
	const names = ["a", "b", "c", "d"].map((n) => `th_${n}${stamp}`);
	for (const n of names) created.push(await createUser(n, n, password));
	const [a, b, c, d] = await Promise.all(names.map(session));

	const root = await post(a, "the opening post");
	const s1 = await post(a, "thread 2/4", root);
	const s2 = await post(a, "thread 3/4", s1);
	const s3 = await post(a, "thread 4/4", s2);
	const noise = await post(b, "a reply inside the thread", s1);

	const r1 = await post(b, "b asks a question", root);
	const r1a = await post(a, "a answers b", r1);
	const r1b = await post(b, "b follows up", r1a);
	const r1c = await post(a, "a answers again", r1b);
	const aside = await post(c, "c chimes in on the answer", r1a);

	const r2 = await post(c, "c says something", root);
	const x1 = await post(b, "b answers c", r2);
	const x2 = await post(d, "d answers c", r2);
	await b("FavoriteTweet", { tweet_id: x2 });

	const r3 = await post(d, "d says something", root);
	const r3a = await post(b, "b is the only one to answer d", r3);

	let detail = await c("TweetDetail", { focalTweetId: root });
	let order = threads(detail).map((t: any) => t.entryId.replace("conversationthread-", ""));
	check(order[0] === s1, "the author's self-thread comes right after the focal post", order);
	check(JSON.stringify(tweetIds(threadOf(detail, s1))) === JSON.stringify([s1, s2, s3]), "the whole self-thread is one module, in order", tweetIds(threadOf(detail, s1)));
	check(!JSON.stringify(threadOf(detail, s1)).includes(noise), "replies inside the self-thread stay out of it");
	check(order.indexOf(r1) > 0 && order.indexOf(r2) > 0 && order.indexOf(r3) > 0, "every other reply gets its own thread", order);
	const focalAt = entriesOf(detail).findIndex((e: any) => e.entryId === `tweet-${root}`);
	check(entriesOf(detail)[focalAt + 1].entryId === `conversationthread-${s1}`, "the self-thread sits directly under the focal post");
	check(threadOf(detail, s1).content.displayType === "VerticalConversation" && threadOf(detail, s1).content.metadata.conversationMetadata.allTweetIds.length === 3, "threads are VerticalConversation modules listing their posts");

	const backAndForth = threadOf(detail, r1);
	check(JSON.stringify(tweetIds(backAndForth)) === JSON.stringify([r1, r1a, r1b, r1c]), "a back-and-forth between the replier and the author expands", tweetIds(backAndForth));
	check(cursorOf(backAndForth)?.cursorType === "ShowMore", "the side reply to it waits behind a cursor", cursorOf(backAndForth));

	const branching = threadOf(detail, r2);
	check(JSON.stringify(tweetIds(branching)) === JSON.stringify([r2, x2]), "a branch shows one reply, the most liked", tweetIds(branching));
	const more = cursorOf(branching);
	check(more?.cursorType === "ShowMore" && more.displayTreatment?.actionText === "Show replies", "and puts the rest behind Show replies", more);
	const second = branching.content.items[1];
	check(second.treeDisplay?.parentModuleItemEntryId === `conversationthread-${r2}-tweet-${r2}` && second.treeDisplay.indentFromParent === true, "branch replies hang indented under their parent", second.treeDisplay);

	const only = threadOf(detail, r3);
	check(JSON.stringify(tweetIds(only)) === JSON.stringify([r3, r3a]) && !cursorOf(only), "an only reply expands with no cursor", tweetIds(only));
	check(only.content.items[1].treeDisplay?.indentFromParent === false, "and continues the line without indenting");

	const page = await c("TweetDetail", { focalTweetId: root, cursor: more.value });
	const add = instructionsOf(page).find((i) => i.type === "TimelineAddToModule");
	check(add?.moduleEntryId === `conversationthread-${r2}` && add.prepend === false, "the cursor request adds to the same module", instructionsOf(page));
	check(JSON.stringify(add.moduleItems.map(idOf)) === JSON.stringify([x1]), "with the replies it held back", add.moduleItems.map(idOf));
	check(add.moduleItems[0].treeDisplay?.parentModuleItemEntryId === `conversationthread-${r2}-tweet-${r2}`, "placed under the post they answer");
	check(!instructionsOf(page).some((i) => i.type === "TimelineClearCache"), "and leaves the rest of the conversation alone");
	const aside2 = instructionsOf(await c("TweetDetail", { focalTweetId: root, cursor: cursorOf(backAndForth).value })).find((i) => i.type === "TimelineAddToModule");
	check(JSON.stringify(aside2?.moduleItems.map(idOf)) === JSON.stringify([aside]), "the back-and-forth cursor brings the side reply", aside2?.moduleItems.map(idOf));

	const mid = await c("TweetDetail", { focalTweetId: s2 });
	const above = entriesOf(mid).filter((e: any) => e.entryId.startsWith("tweet-")).map((e: any) => e.entryId);
	check(JSON.stringify(above) === JSON.stringify([`tweet-${root}`, `tweet-${s1}`, `tweet-${s2}`]), "opening the middle of a thread shows what it continues", above);
	check(threads(mid)[0]?.entryId === `conversationthread-${s3}`, "and the rest of the thread under it");

	check((await a("PinReply", { conversationId: root, tweetId: r2 })).data?.create_conversation_pinned_tweet?.success, "the author pins a reply");
	detail = await a("TweetDetail", { focalTweetId: root });
	order = threads(detail).map((t: any) => t.entryId.replace("conversationthread-", ""));
	check(order[0] === r2 && order[1] === s1, "the pinned reply leads, then the self-thread", order);
	const lead = threadOf(detail, r2).content.items[0].item;
	check(lead.itemContent.socialContext?.contextType === "ReplyPin" && lead.feedbackInfo?.feedbackKeys?.[0] === "reply-pin-pinned", "labelled pinned with the unpin item");
	check(!threadOf(detail, r2).content.items[1].item.itemContent.socialContext, "the label stays on the pinned reply only");

	const crowd: string[] = [];
	for (let i = 0; i < 30; i++) crowd.push(await post([b, c, d][i % 3], `crowd reply ${i}`, root));
	detail = await c("TweetDetail", { focalTweetId: root });
	const tail = entriesOf(detail).at(-1);
	check(threads(detail).length === 30 && tail?.content?.cursorType === "ShowMoreThreads" && tail.content.displayTreatment?.actionText === "Show more replies", "past 30 threads a Show more replies cursor ends the page", threads(detail).length);
	const rest = await c("TweetDetail", { focalTweetId: root, cursor: tail.content.value });
	const restThreads = threads(rest);
	check(restThreads.length === 4 && !entriesOf(rest).some((e: any) => e.content?.cursorType === "ShowMoreThreads"), "its request brings the remaining threads", restThreads.length);
	check(restThreads.every((e: any) => BigInt(e.sortIndex) < BigInt(tail.sortIndex)), "sorted below the ones already shown");
	const all = [...threads(detail), ...restThreads].map((t: any) => t.entryId);
	check(new Set(all).size === all.length && all.length === 34, "no thread is listed twice", all.length);

	await sql`insert into blocks (blocker_id, blocked_id) values (${created[2]}::bigint, ${created[3]}::bigint) on conflict do nothing`;
	detail = await c("TweetDetail", { focalTweetId: root });
	check(!JSON.stringify(detail).includes(x2) && !threadOf(detail, r3), "blocked accounts' replies and threads disappear");
	await sql`delete from blocks where blocker_id = ${created[2]}::bigint`;

	check((await a("ModerateTweet", { tweetId: r1a })).data?.tweet_moderate_put === "Done", "the author hides a reply in the chain");
	detail = await c("TweetDetail", { focalTweetId: root });
	check(JSON.stringify(tweetIds(threadOf(detail, r1))) === JSON.stringify([r1]) && !cursorOf(threadOf(detail, r1)), "the chain stops at the hidden reply", tweetIds(threadOf(detail, r1)));
	check(entriesOf(detail).find((e: any) => e.entryId === `tweet-${root}`)?.content.itemContent.hasModeratedReplies === true, "and the focal post links to hidden replies");

	console.log(`all passed (${checks})`);
} finally {
	if (created.length) {
		await sql`delete from posts where user_id = any(${sql.array(created, "INT8")})`;
		await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	}
	await sql.end();
}
