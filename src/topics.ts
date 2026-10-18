// Topics: subjects staff define with a few keywords. People follow them from
// the sidebar's "Topics to follow" and from a post's menu; "For you" then
// lifts posts that match a followed topic and labels the ones from accounts
// the viewer doesn't follow with the topic, the way X does. "Not interested"
// keeps a topic's posts from strangers out of "For you".
//
// The pinned client has no topic page or followed-topics list any more (its
// /i/topics links go nowhere), so everything happens from those two places.

import { outOfView } from "./blocks";
import { sql } from "./db";
import { isId, newId } from "./ids";

export type Topic = { id: string; name: string; description: string; keywords: string[]; following?: boolean; not_interested?: boolean };

export class TopicError extends Error {}

// a keyword is a word or a short phrase; a leading # is optional when matching
export function cleanKeywords(input: unknown): string[] {
	const list = Array.isArray(input) ? input : String(input ?? "").split(/[,\n]/);
	const out = new Set<string>();
	for (const raw of list) {
		const k = String(raw).trim().replace(/^#/, "").toLowerCase().replace(/\s+/g, " ");
		if (/^[\p{L}\p{N}_][\p{L}\p{N}_ ]{0,39}$/u.test(k)) out.add(k);
	}
	return [...out].slice(0, 20);
}

// a post's text against a topic row t; the keywords are letters, digits, _ and spaces only
const pattern = sql`('(^|[^[:alnum:]_])#?(' || array_to_string(t.keywords, '|') || ')([^[:alnum:]_]|$)')`;
const matches = (postId: ReturnType<typeof sql>) => sql`(select x.text from posts x where x.id = ${postId}) ~* ${pattern}`;

// For ranking (f is feed_items): the post matches a topic the viewer follows
export const followedTopicMatch = (viewerId: string, postId: ReturnType<typeof sql>) =>
	sql`exists (select 1 from topics t join topic_follows tf on tf.topic_id = t.id and tf.user_id = ${viewerId}::bigint where ${matches(postId)})`;
// ...and a post from someone they don't follow that matches a topic they're not interested in
export const unwantedTopicMatch = (viewerId: string, postId: ReturnType<typeof sql>, authorId: ReturnType<typeof sql>) =>
	sql`(${authorId} <> ${viewerId}::bigint and ${authorId} not in (select followee_id from follows where follower_id = ${viewerId}::bigint)
		and exists (select 1 from topics t join topic_not_interested tn on tn.topic_id = t.id and tn.user_id = ${viewerId}::bigint where ${matches(postId)}))`;

const topicCols = (viewerId: string) => sql`t.id::text as id, t.name, t.description, t.keywords,
	exists (select 1 from topic_follows tf where tf.topic_id = t.id and tf.user_id = ${viewerId}::bigint) as following,
	exists (select 1 from topic_not_interested tn where tn.topic_id = t.id and tn.user_id = ${viewerId}::bigint) as not_interested`;

export async function topicById(viewerId: string, id: string): Promise<Topic | undefined> {
	if (!isId(id)) return undefined;
	const [t] = await sql`select ${topicCols(viewerId)} from topics t where t.id = ${id}::bigint`;
	return t as Topic | undefined;
}

// X's Topic object
export const topicResult = (t: Topic) => ({
	description: t.description,
	following: !!t.following,
	icon_url: "",
	id: Buffer.from(`Topic:${t.id}`).toString("base64"),
	topic_id: t.id,
	name: t.name,
	not_interested: !!t.not_interested,
});

export async function setTopicState(viewerId: string, id: string, what: "follow" | "unfollow" | "not_interested" | "undo_not_interested"): Promise<Topic> {
	const topic = await topicById(viewerId, id);
	if (!topic) throw new TopicError("No such topic.");
	if (what === "follow") {
		await sql`insert into topic_follows (user_id, topic_id) values (${viewerId}::bigint, ${id}::bigint) on conflict do nothing`;
		await sql`delete from topic_not_interested where user_id = ${viewerId}::bigint and topic_id = ${id}::bigint`;
	} else if (what === "unfollow") await sql`delete from topic_follows where user_id = ${viewerId}::bigint and topic_id = ${id}::bigint`;
	else if (what === "not_interested") {
		await sql`insert into topic_not_interested (user_id, topic_id) values (${viewerId}::bigint, ${id}::bigint) on conflict do nothing`;
		await sql`delete from topic_follows where user_id = ${viewerId}::bigint and topic_id = ${id}::bigint`;
	} else await sql`delete from topic_not_interested where user_id = ${viewerId}::bigint and topic_id = ${id}::bigint`;
	return (await topicById(viewerId, id))!;
}

// Suggestions: topics the viewer neither follows nor turned down, busiest
// (most matching posts this week) first.
export async function suggestedTopics(viewerId: string, limit = 6): Promise<Topic[]> {
	return (await sql`select ${topicCols(viewerId)},
			(select count(*) from posts p where p.created_at > now() - interval '7 days' and not p.hidden and p.user_id not in ${outOfView(viewerId)} and p.text ~* ${pattern}) as recent
		from topics t
		where not exists (select 1 from topic_follows tf where tf.topic_id = t.id and tf.user_id = ${viewerId}::bigint)
			and not exists (select 1 from topic_not_interested tn where tn.topic_id = t.id and tn.user_id = ${viewerId}::bigint)
		order by recent desc, t.name limit ${limit}`) as Topic[];
}

// For the posts on a "For you" page: the followed topic that brought in each
// post by an account the viewer doesn't follow.
export async function topicsForPosts(viewerId: string, posts: { id: string; authorId: string }[]): Promise<Map<string, Topic>> {
	const out = new Map<string, Topic>();
	const strangers = posts.filter((p) => p.authorId !== viewerId);
	if (!strangers.length) return out;
	const followed = new Set(
		(await sql`select followee_id::text as id from follows where follower_id = ${viewerId}::bigint and followee_id = any(${sql.array(strangers.map((p) => p.authorId), "INT8")})`).map((r: any) => r.id),
	);
	const ids = strangers.filter((p) => !followed.has(p.authorId)).map((p) => p.id);
	if (!ids.length) return out;
	const rows = await sql`select distinct on (p.id) p.id::text as post_id, ${topicCols(viewerId)}
		from posts p join topics t on p.text ~* ${pattern}
		join topic_follows tf on tf.topic_id = t.id and tf.user_id = ${viewerId}::bigint
		where p.id = any(${sql.array(ids, "INT8")}) order by p.id, t.name`;
	for (const r of rows as any[]) out.set(r.post_id, r);
	return out;
}

// The feedback actions a topic-labelled post's menu gets: follow or unfollow
// the topic, and "Not interested in <topic>". The client words both itself.
export const topicFeedbackKeys = (t: Topic) => [`topic-follow-${t.id}`, `topic-notinterested-${t.id}`];
export const topicFeedbackActions = (t: Topic) => [
	{
		key: `topic-follow-${t.id}`,
		value: {
			feedbackType: "RichBehavior",
			hasUndoAction: false,
			richBehavior: { type: "TimelineRichFeedbackBehaviorToggleFollowTopicV2", topic: topicResult(t) },
			clientEventInfo: { component: "topic", element: "toggle_follow" },
		},
	},
	{
		key: `topic-notinterested-${t.id}`,
		value: {
			feedbackType: "RichBehavior",
			hasUndoAction: true,
			richBehavior: { type: "TimelineRichFeedbackBehaviorMarkNotInterestedTopic", topic: topicResult(t) },
			clientEventInfo: { component: "topic", element: "not_interested" },
		},
	},
];

export const topicContext = (t: Topic) => ({ type: "TimelineTopicContext", topic: topicResult(t), functionalityType: "Basic" });

// admin panel
export async function listTopics() {
	return sql`select t.id::text as id, t.name, t.description, t.keywords, t.created_at,
		(select count(*)::int from topic_follows tf where tf.topic_id = t.id) as followers
		from topics t order by t.name`;
}

export async function saveTopic(b: { id?: string; name?: unknown; description?: unknown; keywords?: unknown }) {
	const name = typeof b.name === "string" ? b.name.trim() : "";
	if (!name || [...name].length > 50) throw new TopicError("Give the topic a name of 1–50 characters.");
	const description = typeof b.description === "string" ? b.description.trim().slice(0, 200) : "";
	const keywords = cleanKeywords(b.keywords);
	if (!keywords.length) throw new TopicError("Give at least one keyword (letters, digits, spaces).");
	const taken = await sql`select 1 from topics where lower(name) = lower(${name}) and id <> ${b.id ?? "0"}::bigint`;
	if (taken.length) throw new TopicError("There's already a topic with that name.");
	if (b.id) {
		const rows = await sql`update topics set name = ${name}, description = ${description}, keywords = ${sql.array(keywords, "TEXT")} where id = ${b.id}::bigint returning id::text`;
		if (!rows.length) throw new TopicError("No such topic.");
		return b.id;
	}
	const id = newId();
	await sql`insert into topics (id, name, description, keywords) values (${id}::bigint, ${name}, ${description}, ${sql.array(keywords, "TEXT")})`;
	return id;
}

export async function deleteTopic(id: string) {
	const rows = await sql`delete from topics where id = ${id}::bigint returning id`;
	if (!rows.length) throw new TopicError("No such topic.");
}
