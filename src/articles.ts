// Long-form articles. The editor sends its body as a Draft.js document
// (content_state), which is stored and returned as sent; the server only reads
// it for the plain text and for the media it points at. Publishing creates a
// post carrying the article, which is how feeds, profiles and the reader see it.

import type { User } from "./auth";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { type MediaRow, mediaUrl, posterUrl } from "./media";
import { userResult } from "./model";
import { userById } from "./users";
import { hateIn } from "./hate";
import { automodStrike } from "./moderation";
import { hasBlockedPhrase } from "./settings";

export const MAX_TITLE = 100;
const MAX_CONTENT_BYTES = 512 * 1024;
const PREVIEW_LENGTH = 200;

export class ArticleError extends Error {
	constructor(
		message: string,
		public code = 214,
	) {
		super(message);
	}
}

type ArticleRow = {
	id: string;
	user_id: string;
	title: string;
	content_state: any;
	plain_text: string;
	cover_media_id: string | null;
	state: "Draft" | "Published";
	created_at: Date;
	modified_at: Date;
	first_published_at: Date | null;
	post_id: string | null;
	hidden: boolean;
};

const columns = sql`a.id, a.user_id, a.title, a.content_state, a.plain_text, a.cover_media_id, a.state, a.hidden, a.created_at, a.modified_at, a.first_published_at,
	(select p.id from posts p where p.article_id = a.id order by p.id desc limit 1) as post_id`;

const secs = (d: Date | null) => (d ? Math.floor(d.getTime() / 1000) : undefined);

function plainText(content: any): string {
	return Array.isArray(content?.blocks) ? content.blocks.map((b: any) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "";
}

// media ids the body points at, wherever the editor keeps them in entity data
function mediaIdsIn(value: unknown, out = new Set<string>()): Set<string> {
	if (Array.isArray(value)) for (const v of value) mediaIdsIn(v, out);
	else if (value && typeof value === "object")
		for (const [k, v] of Object.entries(value)) {
			if (/^media_?id$/i.test(k) && (isId(v) || typeof v === "number")) out.add(String(v));
			else mediaIdsIn(v, out);
		}
	return out;
}

// The editor saves snake_case (entity_ranges, entity_map, media_items) and
// loads camelCase (entityRanges, entityMap, mediaItems), as the real API
// converts between them. Stored as sent, converted on the way out.
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
function camelKeys(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(camelKeys);
	if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelKeys(x)]));
	return v;
}
function clientContent(stored: any) {
	if (!stored || !Array.isArray(stored.blocks)) return { blocks: [], entityMap: [] };
	return {
		blocks: stored.blocks.map((b: any) => ({
			key: b.key,
			text: b.text ?? "",
			type: b.type ?? "unstyled",
			data: b.data ?? {},
			entityRanges: b.entity_ranges ?? b.entityRanges ?? [],
			inlineStyleRanges: b.inline_style_ranges ?? b.inlineStyleRanges ?? [],
		})),
		entityMap: (stored.entity_map ?? stored.entityMap ?? []).map((e: any) => ({
			key: String(e.key),
			value: { type: e.value?.type, mutability: e.value?.mutability ?? "Immutable", data: camelKeys(e.value?.data ?? {}) },
		})),
	};
}

function checkContent(content: unknown) {
	if (content === undefined || content === null) return;
	if (typeof content !== "object" || !Array.isArray((content as any).blocks)) throw new ArticleError("The article body is not a document.");
	if (JSON.stringify(content).length > MAX_CONTENT_BYTES) throw new ArticleError("The article is too long.");
}

function checkTitle(title: unknown): string {
	const t = typeof title === "string" ? title.trim() : "";
	if ([...t].length > MAX_TITLE) throw new ArticleError(`Titles can be up to ${MAX_TITLE} characters.`);
	return t;
}

// the media object articles use for the cover and for images in the body
function articleMedia(m: MediaRow) {
	const base = { id: m.id, media_id: m.id, media_key: `3_${m.id}` };
	if (m.kind === "video")
		return {
			...base,
			media_key: `7_${m.id}`,
			media_info: {
				__typename: "ApiVideo",
				aspect_ratio: { numerator: m.width, denominator: m.height },
				duration_millis: m.duration_ms ?? 0,
				preview_image: { original_img_url: posterUrl(m.id), original_img_width: m.width, original_img_height: m.height },
				variants: [{ bit_rate: 0, content_type: "video/mp4", url: mediaUrl(m.id, m.mime) }],
			},
		};
	return { ...base, media_info: { __typename: "ApiImage", original_img_url: mediaUrl(m.id, m.mime), original_img_width: m.width, original_img_height: m.height } };
}

async function mediaRows(ownerId: string, ids: string[]): Promise<Map<string, MediaRow>> {
	if (!ids.length) return new Map();
	const rows = await sql`select id, kind, mime, size, width, height, position, duration_ms from media
		where id = any(${sql.array(ids, "INT8")}) and user_id = ${ownerId}::bigint and state = 'ready'`;
	return new Map(rows.map((r: any) => [String(r.id), r as MediaRow]));
}

// the article object the client reads, from the editor and from a post
async function entity(row: ArticleRow, author: User | undefined, withContent: boolean) {
	const bodyIds = withContent ? [...mediaIdsIn(row.content_state)] : [];
	const media = await mediaRows(row.user_id, [...bodyIds, ...(row.cover_media_id ? [row.cover_media_id] : [])]);
	const cover = row.cover_media_id ? media.get(String(row.cover_media_id)) : undefined;
	const preview = row.plain_text.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LENGTH);
	return {
		__typename: "ArticleEntity",
		rest_id: row.id,
		id: Buffer.from(`ArticleEntity:${row.id}`).toString("base64"),
		title: row.title,
		preview_text: preview,
		...(cover ? { cover_media: articleMedia(cover) } : {}),
		...(withContent
			? {
					content_state: clientContent(row.content_state),
					plain_text: row.plain_text,
					media_entities: bodyIds.map((id) => media.get(id)).filter((m): m is MediaRow => !!m).map(articleMedia),
				}
			: {}),
		lifecycle_state: { lifecycle: row.state, modified_at_secs: secs(row.state === "Published" ? row.first_published_at : row.modified_at) },
		metadata: {
			first_published_at_secs: secs(row.first_published_at),
			modified_at_secs: secs(row.modified_at),
			// the redirect page reads rest_id here, the editor reads result (and counts it as published only with it)
			...(row.post_id
				? {
						tweet_results: {
							rest_id: row.post_id,
							id: Buffer.from(`Tweet:${row.post_id}`).toString("base64"),
							result: { __typename: "Tweet", rest_id: row.post_id } as Record<string, unknown>,
						},
					}
				: {}),
			...(author ? { author_results: { result: userResult(author) } } : {}),
		},
	};
}

export type ArticleEntity = Awaited<ReturnType<typeof entity>>;

async function load(id: string): Promise<ArticleRow | undefined> {
	if (!isId(id)) return undefined;
	const [row] = await sql`select ${columns} from articles a where a.id = ${id}::bigint`;
	return row as ArticleRow | undefined;
}

// an article the viewer may see: their own in any state, anyone's once published
export async function getArticle(viewerId: string, id: string, withContent = true): Promise<ArticleEntity | undefined> {
	const row = await load(id);
	if (!row || (row.state !== "Published" && String(row.user_id) !== viewerId)) return undefined;
	// hidden by staff: only its author and staff see it
	if (row.hidden && String(row.user_id) !== viewerId && !(await sql`select 1 from users where id = ${viewerId}::bigint and role is not null`).length) return undefined;
	return entity(row, await userById(viewerId, String(row.user_id)), withContent);
}

// the viewer's own article, for changing it
async function own(viewerId: string, id: string): Promise<ArticleRow> {
	const row = await load(id);
	if (!row || String(row.user_id) !== viewerId) throw new ArticleError("Article not found.", 34);
	return row;
}

const result = async (viewerId: string, id: string) => (await getArticle(viewerId, id))!;

export async function createDraft(viewerId: string, title: unknown, content: unknown) {
	checkContent(content);
	const id = newId();
	await sql`insert into articles (id, user_id, title, content_state, plain_text)
		values (${id}::bigint, ${viewerId}::bigint, ${checkTitle(title)}, ${content ? JSON.stringify(content) : null}::text::jsonb, ${plainText(content)})`;
	return result(viewerId, id);
}

export async function updateTitle(viewerId: string, id: string, title: unknown) {
	await own(viewerId, id);
	await sql`update articles set title = ${checkTitle(title)}, modified_at = now() where id = ${id}::bigint`;
	return result(viewerId, id);
}

export async function updateContent(viewerId: string, id: string, content: unknown) {
	await own(viewerId, id);
	checkContent(content);
	await sql`update articles set content_state = ${content ? JSON.stringify(content) : null}::text::jsonb, plain_text = ${plainText(content)}, modified_at = now()
		where id = ${id}::bigint`;
	return result(viewerId, id);
}

export async function updateCover(viewerId: string, id: string, mediaId: unknown) {
	await own(viewerId, id);
	let cover: string | null = null;
	if (mediaId !== undefined && mediaId !== null) {
		if (!isId(String(mediaId)) || !(await mediaRows(viewerId, [String(mediaId)])).size) throw new ArticleError("Unknown cover image.");
		cover = String(mediaId);
	}
	await sql`update articles set cover_media_id = ${cover}::bigint, modified_at = now() where id = ${id}::bigint`;
	return result(viewerId, id);
}

// publishing posts the article; tweetText is what the post says above it
export async function publish(viewerId: string, id: string, tweetText: unknown, createPost: (text: string, articleId: string) => Promise<string>) {
	const row = await own(viewerId, id);
	if (!row.title) throw new ArticleError("Give the article a title before publishing.");
	if (!row.plain_text.trim()) throw new ArticleError("The article is empty.");
	if (row.hidden) throw new ArticleError("Staff have hidden this article.");
	if (hasBlockedPhrase(row.plain_text)) throw new ArticleError("The article contains a phrase this instance doesn't allow.");
	const hate = hateIn(row.title, row.plain_text);
	if (hate) {
		await automodStrike(viewerId, hate, "article", `${row.title}\n${row.plain_text}`);
		throw new ArticleError("The article contains a slur or hate speech this instance doesn't allow.");
	}
	if (row.state !== "Published") {
		await createPost(typeof tweetText === "string" ? tweetText : "", id);
		await sql`update articles set state = 'Published', first_published_at = coalesce(first_published_at, now()) where id = ${id}::bigint`;
	}
	return result(viewerId, id);
}

// back to a draft; the post that carried it goes away
export async function unpublish(viewerId: string, id: string) {
	await own(viewerId, id);
	await sql`delete from posts where article_id = ${id}::bigint`;
	await sql`update articles set state = 'Draft', modified_at = now() where id = ${id}::bigint`;
	return result(viewerId, id);
}

export async function deleteArticle(viewerId: string, id: string) {
	await own(viewerId, id);
	await sql`delete from posts where article_id = ${id}::bigint`;
	await sql`delete from articles where id = ${id}::bigint`;
}

// the editor's lists of drafts and published articles, newest change first
export async function slice(viewerId: string, userId: string, lifecycle: string, cursor: unknown, count = 20) {
	if (userId !== viewerId && lifecycle !== "Published") return { items: [], next: undefined };
	const before = typeof cursor === "string" && isId(cursor) ? cursor : undefined;
	const rows = await sql`select ${columns} from articles a where a.user_id = ${userId}::bigint and a.state = ${lifecycle === "Published" ? "Published" : "Draft"}
		and (not a.hidden or a.user_id = ${viewerId}::bigint or exists (select 1 from users staff where staff.id = ${viewerId}::bigint and staff.role is not null)) ${before ? sql`and a.id < ${before}::bigint` : sql``} order by a.id desc limit ${count}`;
	const author = await userById(viewerId, userId);
	// in full: the editor opens an article from this list without fetching it again
	const items = await Promise.all(rows.map((r: any) => entity(r as ArticleRow, author, true)));
	return { items, next: rows.length === count ? String(rows[rows.length - 1].id) : undefined };
}

// articles carried by posts, for hydrating feeds: everything the card and the reader need
export async function articlesByIds(viewerId: string, ids: string[]): Promise<Map<string, ArticleEntity>> {
	const out = new Map<string, ArticleEntity>();
	if (!ids.length) return out;
	const rows = await sql`select ${columns} from articles a where a.id = any(${sql.array(ids, "INT8")}) and a.state = 'Published' and (not a.hidden or a.user_id = ${viewerId}::bigint or exists (select 1 from users staff where staff.id = ${viewerId}::bigint and staff.role is not null))`;
	for (const r of rows) out.set(String(r.id), await entity(r as ArticleRow, undefined, true));
	return out;
}
