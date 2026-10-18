// Scheduled posts and drafts. The composer sends the whole create request
// (status, media_ids, reply target, ...); it is kept as sent and replayed when
// the time comes.

import type { Viewer } from "./auth";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { attachMedia } from "./media";
import { PostError, checkLength, createPost } from "./posts";

type Vars = Record<string, any>;

const MAX_PENDING = 100;
const MIN_LEAD_SECONDS = 30;
const MAX_LEAD_DAYS = 365 * 2;

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter(isId) : []);

// keep what the client sent, but only plain values
function cleanRequest(request: Vars | undefined): Vars {
	const r = request ?? {};
	return {
		...r,
		status: typeof r.status === "string" ? r.status : "",
		media_ids: ids(r.media_ids),
		exclude_reply_user_ids: ids(r.exclude_reply_user_ids),
		thread_tweets: Array.isArray(r.thread_tweets) ? r.thread_tweets : [],
	};
}

function item(row: any) {
	const request = row.request as Vars;
	return {
		rest_id: row.id,
		...(row.kind === "scheduled" ? { scheduling_info: { execute_at: Math.floor(new Date(row.execute_at).getTime() / 1000), state: "Scheduled" } } : {}),
		tweet_create_request: request,
		media_entities: [],
	};
}

function executeAt(vars: Vars): Date {
	const seconds = Number(vars.execute_at);
	if (!Number.isFinite(seconds)) throw new PostError("Pick a time to post.", 214);
	const at = new Date(seconds * 1000);
	const now = Date.now();
	if (at.getTime() < now + MIN_LEAD_SECONDS * 1000) throw new PostError("Pick a time in the future.", 214);
	if (at.getTime() > now + MAX_LEAD_DAYS * 86400_000) throw new PostError("That's too far ahead.", 214);
	return at;
}

async function check(userId: string, request: Vars, kind: "scheduled" | "draft") {
	const [n] = await sql`select count(*)::int as n from scheduled_posts where user_id = ${userId}::bigint and kind = ${kind}`;
	if (n.n >= MAX_PENDING) throw new PostError(`You can keep up to ${MAX_PENDING} ${kind === "draft" ? "drafts" : "scheduled posts"}.`, 214);
	if (kind === "scheduled" && !request.status.trim() && !request.media_ids.length) throw new PostError("Your post is empty.", 170);
	await checkLength(userId, request.status);
}

async function create(v: Viewer, vars: Vars, kind: "scheduled" | "draft") {
	const request = cleanRequest(vars.post_tweet_request);
	const at = kind === "scheduled" ? executeAt(vars) : null;
	await check(v.id, request, kind);
	const id = newId();
	await sql`insert into scheduled_posts (id, user_id, kind, execute_at, request) values (${id}::bigint, ${v.id}::bigint, ${kind}, ${at}, ${JSON.stringify(request)}::text::jsonb)`;
	return { data: { tweet: { rest_id: id } } };
}

async function edit(v: Viewer, vars: Vars, kind: "scheduled" | "draft") {
	const id = vars[kind === "draft" ? "draft_tweet_id" : "scheduled_tweet_id"];
	if (!isId(id)) throw new PostError("Not found.", 144);
	const request = cleanRequest(vars.post_tweet_request);
	const at = kind === "scheduled" ? executeAt(vars) : null;
	await checkLength(v.id, request.status);
	const rows = await sql`update scheduled_posts set request = ${JSON.stringify(request)}::text::jsonb, execute_at = ${at}
		where id = ${id}::bigint and user_id = ${v.id}::bigint and kind = ${kind} returning id`;
	if (!rows.length) throw new PostError("Not found.", 144);
	return { data: { tweet: { rest_id: id } } };
}

async function remove(v: Viewer, idsToDelete: unknown[], kind: "scheduled" | "draft") {
	const list = idsToDelete.filter(isId);
	if (list.length) await sql`delete from scheduled_posts where user_id = ${v.id}::bigint and kind = ${kind} and id = any(${sql.array(list, "INT8")})`;
	return { data: { scheduledtweet_delete: "Done" } };
}

async function list(v: Viewer, kind: "scheduled" | "draft") {
	const rows = await sql`select id::text, kind, execute_at, request from scheduled_posts where user_id = ${v.id}::bigint and kind = ${kind}
		order by ${kind === "scheduled" ? sql`execute_at asc` : sql`created_at desc`} limit 100`;
	return rows.map(item);
}

export const scheduledHandlers = {
	CreateScheduledTweet: (v: Viewer, vars: Vars) => create(v, vars, "scheduled"),
	EditScheduledTweet: (v: Viewer, vars: Vars) => edit(v, vars, "scheduled"),
	DeleteScheduledTweet: (v: Viewer, vars: Vars) => remove(v, [vars.scheduled_tweet_id], "scheduled"),
	FetchScheduledTweets: async (v: Viewer) => ({ data: { viewer: { scheduled_tweet_list: await list(v, "scheduled") } } }),
	CreateDraftTweet: (v: Viewer, vars: Vars) => create(v, vars, "draft"),
	EditDraftTweet: (v: Viewer, vars: Vars) => edit(v, vars, "draft"),
	DeleteDraftTweet: (v: Viewer, vars: Vars) => remove(v, [vars.draft_tweet_id], "draft"),
	DeleteDraftTweets: (v: Viewer, vars: Vars) => remove(v, Array.isArray(vars.draft_tweet_ids) ? vars.draft_tweet_ids : [], "draft"),
	FetchDraftTweets: async (v: Viewer) => ({ data: { viewer: { draft_list: { response_data: await list(v, "draft") } } } }),
};

// posts whose time has come; a failure drops the entry so it can't loop
export async function runDue(): Promise<number> {
	const due = await sql`delete from scheduled_posts where id in (
			select id from scheduled_posts where kind = 'scheduled' and execute_at <= now() order by execute_at limit 20 for update skip locked)
		returning user_id::text, request`;
	for (const row of due) {
		const r = row.request as Vars;
		try {
			const replyTo = isId(r.in_reply_to_status_id) ? r.in_reply_to_status_id : undefined;
			const quoteId = typeof r.attachment_url === "string" ? /\/status(?:es)?\/(\d{1,19})/.exec(r.attachment_url)?.[1] : undefined;
			const id = await createPost(row.user_id, String(r.status ?? "").trim(), { replyToId: replyTo, quoteId });
			const media = ids(r.media_ids);
			if (media.length) await attachMedia(row.user_id, id, media);
		} catch (e) {
			console.error("scheduled post failed:", e instanceof Error ? e.message : e);
		}
	}
	return due.length;
}

export function startScheduler() {
	setInterval(() => void runDue().catch((e) => console.error("scheduler:", e)), 15_000).unref();
}
