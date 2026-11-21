// Scheduled posts and drafts. The composer sends the whole create request
// (status, media_ids, reply target, ...); it is kept as sent and replayed when
// the time comes.

import { MAX_POST_MEDIA } from "./config";
import { replyControl, replyCountrySelections } from "./reply-controls";
import { conversationCard } from "./conversation-cards";
import { checkConversationCard } from "./conversation-card-moderation";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { queueReview } from "./claude-mod";
import { isId, newId } from "./ids";
import { MediaError, attachMedia, mediaUrl, posterUrl, type MediaRow } from "./media";
import { fetchPreview, linksIn, previewable } from "./links";
import { lookupRemoteUser } from "./federation-sync";
import { mentionHandles } from "./mentions";
import { chargePostCost } from "./ratelimit";
import { PostError, checkLength, createPost, refuseHate } from "./posts";

type Vars = Record<string, any>;

// Scheduled quota counts future posts, including every reply in a thread.
// Drafts retain their existing quota of 100 saved composer requests.
const MAX_PENDING = 100;
const MIN_LEAD_SECONDS = 30;
const MAX_LEAD_DAYS = 365 * 2;
const RETRIES = 5;

const ids = (value: unknown): string[] => (Array.isArray(value) ? value.map(String).filter(isId) : []);

// The root request is the first post; thread_tweets contains only its replies.
// Keep the composer's rich-text/media metadata for editing, even where posting
// currently supports only the text, quote and uploaded attachments.
function cleanPart(value: unknown, draft = false): Vars {
	const r = value && typeof value === "object" && !Array.isArray(value) ? value as Vars : {};
	const out: Vars = {
		status: typeof r.status === "string" ? r.status : "",
		media_ids: ids(r.media_ids).slice(0, MAX_POST_MEDIA),
		exclude_reply_user_ids: ids(r.exclude_reply_user_ids).slice(0, 50),
	};
	const selections = replyCountrySelections(r.conversation_control_region_codes);
	const control = replyControl(r.conversation_control, selections);
	if (r.conversation_control !== undefined) {
		out.conversation_control = control.policy ? r.conversation_control : "all";
		out.conversation_control_region_codes = control.selections;
	}
	if (r.xitter_conversation_card !== undefined) {
		try { out.xitter_conversation_card = conversationCard(r.xitter_conversation_card, () => false, draft); }
		catch (error) { throw new PostError(error instanceof Error ? error.message : "Invalid conversation card.", 214); }
		if (r.attachment_url || r.card_uri) throw new PostError("Conversation cards cannot be combined with quotes or other cards.", 214);
	}
	if (Array.isArray(r.media_ids) && (r.media_ids.length > MAX_POST_MEDIA || r.media_ids.some((id: unknown) => !isId(id))))
		throw new PostError("A post can have up to four valid attachments.", 186);
	if (isId(r.in_reply_to_status_id)) out.in_reply_to_status_id = r.in_reply_to_status_id;
	if (typeof r.attachment_url === "string" && r.attachment_url.length <= 300) out.attachment_url = r.attachment_url;
	for (const key of ["auto_populate_reply_metadata", "possibly_sensitive"]) if (typeof r[key] === "boolean") out[key] = r[key];
	for (const key of ["media_options", "richtext_options", "cashtag_attachment_options", "content_disclosure_options"])
		if (r[key] && typeof r[key] === "object") out[key] = r[key];
	return out;
}

function cleanRequest(request: Vars | undefined, kind: "scheduled" | "draft" = "scheduled"): Vars {
	const out = cleanPart(request, kind === "draft");
	const thread = request?.thread_tweets;
	if (thread != null && (!Array.isArray(thread) || thread.length > 25))
		throw new PostError("A thread can have up to 26 posts.", 186);
	out.thread_tweets = (thread ?? []).map((part: unknown) => {
		if (!part || typeof part !== "object" || Array.isArray(part)) throw new PostError("Invalid thread post.", 170);
		return cleanPart(part, kind === "draft");
	});
	if (JSON.stringify(out).length > 300_000) throw new PostError("That post is too large to keep.", 186);
	return out;
}

const parts = (request: Vars): Vars[] => [request, ...request.thread_tweets];
const quoteOf = (request: Vars) => {
	const id = typeof request.attachment_url === "string" ? /\/status(?:es)?\/(\d{1,19})(?!\d)/.exec(request.attachment_url)?.[1] : undefined;
	if (id !== undefined && !isId(id)) throw new PostError("Invalid quoted post.", 144);
	return id;
};

function mediaIdsOf(request: Vars | null): string[] {
	return [request, ...(Array.isArray(request?.thread_tweets) ? request.thread_tweets.slice(0, 25) : [])]
		.flatMap((part) => Array.isArray(part?.media_ids) ? part.media_ids.slice(0, MAX_POST_MEDIA).filter(isId) : []);
}

// Unsent posts use ApiImage/ApiVideo/ApiGif, not the published tweet's legacy
// media entity. The client matches media_key's id back to each thread item's
// media_ids when restoring its composer uploads.
function unsentMedia(m: MediaRow) {
	const image = { original_img_width: m.width, original_img_height: m.height, ...(m.alt_text ? { alt_text: m.alt_text } : {}) };
	const url = mediaUrl(m.id, m.mime);
	const video = m.kind === "video";
	const gif = !video && m.mime === "image/gif";
	return {
		media_key: `${video ? "7" : gif ? "16" : "3"}_${m.id}`,
		...(m.sensitive_warning?.length ? { sensitive_media_warning: {
			adult_content: m.sensitive_warning.includes("adult_content"), graphic_violence: m.sensitive_warning.includes("graphic_violence"), other: m.sensitive_warning.includes("other"),
		} } : {}),
		media_info: video ? {
			__typename: "ApiVideo", ...image, original_img_url: posterUrl(m.id), duration_millis: m.duration_ms ?? 0,
			variants: [{ content_type: "video/mp4", bit_rate: Math.round(m.size * 8 / Math.max(1, (m.duration_ms ?? 1000) / 1000)), url }],
		} : gif ? {
			__typename: "ApiGif", ...image, original_img_url: url, variants: [{ content_type: "image/gif", url }],
		} : { __typename: "ApiImage", ...image, original_img_url: url },
	};
}

function item(row: any, media: Map<string, ReturnType<typeof unsentMedia>>) {
	const request = row.request as Vars;
	const attachments = [...new Set(mediaIdsOf(request))].flatMap((id) => media.has(id) ? [media.get(id)!] : []);
	return {
		rest_id: row.id,
		...(row.kind === "scheduled" ? { scheduling_info: { execute_at: new Date(row.execute_at).toISOString(), state: "Scheduled" } } : {}),
		tweet_create_request: { ...request, type: "PostTweetRequest" },
		...(attachments.length ? { media_entities: attachments } : {}),
	};
}

function executeAt(vars: Vars): Date {
	const seconds = Number(vars.execute_at);
	if (!Number.isFinite(seconds)) throw new PostError("Pick a time to post.", 214);
	const at = new Date(seconds * 1000);
	if (!Number.isFinite(at.getTime())) throw new PostError("Pick a valid time to post.", 214);
	const now = Date.now();
	if (at.getTime() < now + MIN_LEAD_SECONDS * 1000) throw new PostError("Pick a time in the future.", 214);
	if (at.getTime() > now + MAX_LEAD_DAYS * 86400_000) throw new PostError("That's too far ahead.", 214);
	return at;
}

async function check(userId: string, request: Vars, kind: "scheduled" | "draft", db: typeof sql = sql, moderate = true) {
	const [author] = await db`select status, deactivated_at from users where id = ${userId}::bigint`;
	const usedMedia = new Set<string>();
	const cardMedia = new Set<string>();
	let part: Vars, id: string, media: { id: string; kind: string }[], videos: Set<string>, checkedMedia: Set<string>;
	if ((author?.status !== "active" && author?.status !== "limited") || author?.deactivated_at) throw new PostError("Your account can't post right now.", 326);
	for (part of parts(request)) {
		if (kind === "scheduled" && !part.status.trim() && !part.media_ids.length) throw new PostError("Your post is empty.", 170);
		await checkLength(userId, part.status.trim(), db);
		if (moderate) await refuseHate(userId, part.status.trim());
		quoteOf(part);
		if (part.xitter_conversation_card) {
			if (moderate) part.xitter_conversation_card = await checkConversationCard(userId, part.xitter_conversation_card, kind === "draft");
			if ((kind === "scheduled" && part.media_ids.length !== 1) || part.media_ids.length > 1) throw new PostError("A conversation card needs exactly one image or video before publishing.", 214);
			for (id of part.media_ids) cardMedia.add(id);
		}
		for (id of part.media_ids) {
			if (kind === "scheduled" && usedMedia.has(id)) throw new PostError("An attachment can only be used once in a thread.", 186);
			usedMedia.add(id);
		}
	}
	checkedMedia = kind === "scheduled" ? usedMedia : cardMedia;
	if (checkedMedia.size) {
		media = await db`select id::text, kind from media where id = any(${sql.array([...checkedMedia], "INT8")})
			and user_id = ${userId}::bigint and post_id is null and not detached and state = 'ready'`;
		if (media.length !== checkedMedia.size) throw new PostError("Attachments must be your own unused, finished uploads.", cardMedia.size ? 214 : 186);
		videos = new Set(media.filter((m) => m.kind === "video").map((m) => m.id));
		if (parts(request).some((part) => part.media_ids.length > 1 && part.media_ids.some((id: string) => videos.has(id))))
			throw new PostError("A video goes alone in a post.", 186);
	}
}

const requestCost = (request: Vars): number => 1 + (Array.isArray(request.thread_tweets) ? request.thread_tweets.length : 0);

async function pendingCost(db: typeof sql, userId: string, kind: "scheduled" | "draft"): Promise<number> {
	const [row] = await db`select coalesce(sum(case when kind = 'scheduled' then 1 +
		case when jsonb_typeof(request->'thread_tweets') = 'array' then jsonb_array_length(request->'thread_tweets') else 0 end
		else 1 end), 0)::int as n from scheduled_posts where user_id = ${userId}::bigint and kind = ${kind}`;
	return row.n;
}

function quotaError(kind: "scheduled" | "draft"): PostError {
	return new PostError(kind === "scheduled"
		? `You can schedule up to ${MAX_PENDING} pending posts, including thread replies.`
		: `You can keep up to ${MAX_PENDING} drafts.`, 214);
}

async function create(v: Viewer, vars: Vars, kind: "scheduled" | "draft") {
	const request = cleanRequest(vars.post_tweet_request, kind);
	const at = kind === "scheduled" ? executeAt(vars) : null;
	await check(v.id, request, kind);
	const id = newId();
	await sql.begin(async (tx) => {
		// A separate per-account quota lock avoids a users-row/schedule-row
		// lock inversion with publication's post-statistics triggers.
		await tx`select pg_advisory_xact_lock(hashtextextended(${`scheduled-quota:${v.id}`}, 0))`;
		const cost = kind === "scheduled" ? requestCost(request) : 1;
		if (await pendingCost(tx, v.id, kind) + cost > MAX_PENDING) throw quotaError(kind);
		// The API already charges the root post; reserve every additional reply
		// against that same post window before the queued request is written.
		if (kind === "scheduled") chargePostCost(v, cost - 1);
		await tx`insert into scheduled_posts (id, user_id, kind, execute_at, request) values (${id}::bigint, ${v.id}::bigint, ${kind}, ${at}, ${JSON.stringify(request)}::text::jsonb)`;
	});
	return { data: { tweet: { rest_id: id } } };
}

async function edit(v: Viewer, vars: Vars, kind: "scheduled" | "draft") {
	const id = vars[kind === "draft" ? "draft_tweet_id" : "scheduled_tweet_id"];
	if (!isId(id)) throw new PostError("Not found.", 144);
	const [existing] = await sql`select id from scheduled_posts where id = ${id}::bigint and user_id = ${v.id}::bigint and kind = ${kind}`;
	if (!existing) throw new PostError("Not found.", 144);
	const request = cleanRequest(vars.post_tweet_request, kind);
	const at = kind === "scheduled" ? executeAt(vars) : null;
	await check(v.id, request, kind);
	await sql.begin(async (tx) => {
		await tx`select pg_advisory_xact_lock(hashtextextended(${`scheduled-quota:${v.id}`}, 0))`;
		const [current] = await tx`select request from scheduled_posts where id = ${id}::bigint and user_id = ${v.id}::bigint and kind = ${kind} for update`;
		if (!current) throw new PostError("Not found.", 144);
		// Existing over-quota queues remain editable: only expanding one needs
		// free capacity. Draft edits never consume another logical draft slot.
		if (kind === "scheduled" && requestCost(request) > requestCost(current.request)
			&& await pendingCost(tx, v.id, kind) - requestCost(current.request) + requestCost(request) > MAX_PENDING) throw quotaError(kind);
		if (kind === "scheduled") chargePostCost(v, Math.max(0, requestCost(request) - requestCost(current.request)));
		await tx`update scheduled_posts set request = ${JSON.stringify(request)}::text::jsonb, execute_at = ${at}, attempts = 0, last_error = null
			where id = ${id}::bigint and user_id = ${v.id}::bigint and kind = ${kind}`;
	});
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
	const idsToLoad = [...new Set(rows.flatMap((row: any) => mediaIdsOf(row.request)))];
	const media = new Map<string, ReturnType<typeof unsentMedia>>();
	if (idsToLoad.length) {
		// A saved request can contain stale or forged ids. Never expose another
		// account's upload metadata, published attachments, or unfinished files.
		const uploads = await sql`select id::text, kind, mime, size, width, height, duration_ms, alt_text, sensitive_warning
			from media where user_id = ${v.id}::bigint and id = any(${sql.array(idsToLoad, "INT8")})
			and post_id is null and not detached and state = 'ready'`;
		for (const upload of uploads) media.set(upload.id, unsentMedia(upload as MediaRow));
	}
	return rows.map((row: any) => item(row, media));
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

// Claim and finish one schedule in the same transaction. A worker/process crash
// rolls back both the posts and its queue claim; another worker can retry it.
export async function runDue(lookupMention: (handle: string) => Promise<unknown> = lookupRemoteUser): Promise<number> {
	const candidates = await sql`select id::text, user_id::text, request from scheduled_posts where kind = 'scheduled' and execute_at <= now()
		order by execute_at, id limit 20`;
	// Resolve at most 20 unknown remote handles once for the whole batch, with
	// the upstream best-effort timeout. No publication or queue locks exist yet.
	const remote = new Set<string>();
	for (const { request } of candidates) {
		const texts = [request?.status, ...(Array.isArray(request?.thread_tweets) ? request.thread_tweets.slice(0, 25).map((part: any) => part?.status) : [])];
		for (const text of texts) if (typeof text === "string")
			for (const handle of mentionHandles(text)) if (handle.includes("@")) remote.add(handle);
	}
	if (remote.size) {
		const known = new Set((await sql`select lower(screen_name) as name from users where lower(screen_name) = any(${sql.array([...remote], "TEXT")})`).map((row: any) => row.name));
		await Promise.race([Promise.all([...remote].filter((handle) => !known.has(handle)).slice(0, 20)
			.map((handle) => lookupMention(handle).catch(() => undefined))), Bun.sleep(3000)]);
	}
	let handled = 0;
	for (const candidate of candidates) {
		// Safety actions must commit independently, before any queue/publication
		// connection is reserved. This also works with a one-connection pool.
		let preflight: { request: Vars } | { error: unknown };
		try {
			const request = cleanRequest(candidate.request);
			await check(candidate.user_id, request, "scheduled");
			preflight = { request };
		} catch (error) {
			preflight = { error };
		}
		const result = await sql.begin(async (tx) => {
			const [row] = await tx`select id::text, user_id::text, request, attempts from scheduled_posts
				where id = ${candidate.id}::bigint and user_id = ${candidate.user_id}::bigint and kind = 'scheduled' and execute_at <= now()
					and request = ${JSON.stringify(candidate.request)}::text::jsonb for update skip locked`;
			if (!row) return undefined;
			try {
				if ("error" in preflight) throw preflight.error;
				const request = preflight.request;
				// Recheck mutable account/upload state on this transaction. The exact
				// request snapshot (and trimmed text) already passed static moderation.
				await check(row.user_id, request, "scheduled", tx, false);
				const posted: string[] = [];
				await tx.savepoint(async (publication) => {
					let replyTo = request.in_reply_to_status_id;
					for (const part of parts(request)) {
						const id = await createPost(row.user_id, part.status.trim(), { replyToId: replyTo, quoteId: quoteOf(part), replyPolicy: part.conversation_control, replySelections: part.conversation_control_region_codes, db: publication, skipPreview: true });
						await attachMedia(row.user_id, id, part.media_ids, { db: publication, strict: true });
						if (part.xitter_conversation_card) await publication`update posts set conversation_card = ${JSON.stringify(part.xitter_conversation_card)}::text::jsonb where id = ${id}::bigint`;
						if (part.possibly_sensitive) await publication`update posts set sensitive = true where id = ${id}::bigint`;
						replyTo = id;
						posted.push(id);
					}
					await publication`delete from scheduled_posts where id = ${row.id}::bigint`;
				});
				return { posted, previews: parts(request).filter((part) => !quoteOf(part) && !part.media_ids.length)
					.map((part) => linksIn(part.status).filter((link) => previewable(link.url)).at(-1)?.url).filter((url): url is string => !!url) };
			} catch (e) {
				const message = (e instanceof Error ? e.message : String(e)).slice(0, 1000);
				console.error("scheduled post failed:", message);
				if (e instanceof PostError || e instanceof MediaError || row.attempts >= RETRIES) {
					// Rescue authored content instead of silently deleting a rejected
					// post or an exhausted retry. The composer can edit it as a draft.
					await tx`update scheduled_posts set kind = 'draft', execute_at = null, created_at = now(), last_error = ${message} where id = ${row.id}::bigint`;
				} else {
					await tx`update scheduled_posts set execute_at = now() + ${`${2 ** row.attempts} minutes`}::interval,
						attempts = attempts + 1, last_error = ${message} where id = ${row.id}::bigint`;
				}
				return { posted: [] as string[], previews: [] as string[] };
			}
		});
		if (!result) continue;
		handled++;
		// Preview network I/O starts only after publication commits.
		for (const id of result.posted) queueReview("post", id);
		for (const url of new Set(result.previews)) void fetchPreview(url).catch((e) => console.error("scheduled preview:", e));
	}
	return handled;
}

// a pass that outlasts the interval would otherwise start again on top of itself
let running = false;
export function startScheduler() {
	setInterval(() => {
		if (running) return;
		running = true;
		void runDue()
			.catch((e) => console.error("scheduler:", e))
			.finally(() => (running = false));
	}, 15_000).unref();
}
