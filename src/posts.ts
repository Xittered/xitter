import type { User } from "./auth";
import { sql } from "./db";
import { newId } from "./ids";
import { hasBlockedPhrase } from "./settings";
import { postLimitFor, weightedLength } from "./textlen";
import type { PostRow } from "./model";
import { articlesByIds } from "./articles";
import { blockedFor, hasMutedWord, isBlockedEitherWay, mutedFor, outOfView, protectedFor, suspendedFor } from "./blocks";
import { mediaForPosts } from "./media";
import { communityObjects } from "./community-model";
import { webSource } from "./platforms";
import { pollCard, pollsByIds } from "./polls";
import { toUser, userCols, usersByIds } from "./users";

// @name, not preceded by a word character (so e-mail addresses do not count)
export const MENTION = /(?<![\w@])@(\w{1,15})/g;
const NO_LIMIT = "9223372036854775807";

// accounts whose likes, reposts and replies no longer count for anyone
const SUSPENDED = sql`(select id from users where status = 'suspended')`;

// every post query starts from this; callers append where/order/limit
const select = (viewerId: string) => sql`
	select p.id, p.text, p.reply_to_id, p.conversation_id, p.quote_id, p.article_id, p.created_at, p.source, p.sensitive, p.community_id::text as community_id, p.poll_id::text as poll_id, p.place_id, p.edit_count, p.edited_at, p.reply_policy,
		exists (select 1 from posts r where r.id = p.conversation_id and r.reply_policy is not null and r.user_id <> ${viewerId}::bigint and not (
			(r.reply_policy = 'Community' and exists (select 1 from follows f where f.follower_id = r.user_id and f.followee_id = ${viewerId}::bigint))
			or (r.reply_policy = 'ByInvitation' and exists (select 1 from post_mentions m where m.post_id = r.id and m.user_id = ${viewerId}::bigint))
			or (r.reply_policy = 'Verified' and exists (select 1 from users x where x.id = ${viewerId}::bigint and (x.verified_type is not null or exists (select 1 from affiliations af where af.user_id = x.id))))
		)) as reply_limited,
		(select cr.reply_policy from posts cr where cr.id = p.conversation_id) as conversation_policy,
		(select cu.screen_name from posts cr join users cu on cu.id = cr.user_id where cr.id = p.conversation_id) as conversation_owner,
		ru.id as reply_user_id, ru.screen_name as reply_screen_name,
		${userCols(viewerId)},
		-- staff can set the shown counts (admin panel); the lists behind them stay real
		coalesce((p.count_overrides->>'likes')::int, (select count(*)::int from likes x where x.post_id = p.id and x.user_id not in ${SUSPENDED})) as like_count,
		coalesce((p.count_overrides->>'reposts')::int, (select count(*)::int from reposts x where x.post_id = p.id and x.user_id not in ${SUSPENDED})) as repost_count,
		coalesce((p.count_overrides->>'bookmarks')::int, (select count(*)::int from bookmarks x where x.post_id = p.id)) as bookmark_count,
		coalesce((p.count_overrides->>'replies')::int, (select count(*)::int from posts x where x.reply_to_id = p.id and x.user_id not in ${SUSPENDED})) as reply_count,
		coalesce((p.count_overrides->>'quotes')::int, (select count(*)::int from posts x where x.quote_id = p.id and x.user_id not in ${SUSPENDED})) as quote_count,
		coalesce((p.count_overrides->>'views')::int, (select count(*)::int from post_views x where x.post_id = p.id)) as view_count,
		p.notice,
		exists (select 1 from likes x where x.post_id = p.id and x.user_id = ${viewerId}::bigint) as liked,
		exists (select 1 from reposts x where x.post_id = p.id and x.user_id = ${viewerId}::bigint) as reposted,
		exists (select 1 from bookmarks x where x.post_id = p.id and x.user_id = ${viewerId}::bigint) as bookmarked
	from posts p
	join users u on u.id = p.user_id and (not p.hidden or exists (select 1 from users staff where staff.id = ${viewerId}::bigint and staff.role is not null))
		and u.id not in ${protectedFor(viewerId)} and u.id not in ${suspendedFor(viewerId)}
	left join posts rp on rp.id = p.reply_to_id
	left join users ru on ru.id = rp.user_id`;

function toRow(r: any): PostRow {
	return {
		id: r.id,
		text: r.text,
		source: r.source,
		sensitive: r.sensitive,
		reply_to_id: r.reply_to_id,
		conversation_id: r.conversation_id,
		quote_id: r.quote_id,
		article_id: r.article_id,
		community_id: r.community_id,
		poll_id: r.poll_id,
		place_id: r.place_id,
		edit_count: r.edit_count,
		view_count: r.view_count,
		notice: r.notice ?? null,
		reply_policy: r.reply_policy,
		reply_limited: !!r.reply_limited,
		conversation_policy: r.conversation_policy,
		conversation_owner: r.conversation_owner,
		edited_at: r.edited_at,
		created_at: r.created_at,
		reply_user_id: r.reply_user_id,
		reply_screen_name: r.reply_screen_name,
		like_count: r.like_count,
		repost_count: r.repost_count,
		bookmark_count: r.bookmark_count,
		reply_count: r.reply_count,
		quote_count: r.quote_count,
		liked: r.liked,
		reposted: r.reposted,
		bookmarked: r.bookmarked,
		author: toUser(r),
	};
}

// media, articles, and the post each one quotes (one level: a quote inside a quote is not expanded)
async function hydrate(viewerId: string, posts: PostRow[], quotes = true): Promise<PostRow[]> {
	const media = await mediaForPosts(posts.map((p) => p.id));
	for (const p of posts) p.media = media.get(p.id) ?? [];
	if (posts.length) {
		const notes = await sql`select n.id::text, n.post_id::text, n.text from community_notes n join users author on author.id = n.author_id and author.status <> 'suspended'
			join community_note_ratings r on r.note_id = n.id join users voter on voter.id = r.user_id and voter.status = 'active'
			where n.post_id = any(${sql.array(posts.map(p => p.id), "INT8")}) and n.classification = 'Misleading' and n.author_id not in ${blockedFor(viewerId)}
			group by n.id having count(*) >= 3 and count(*) filter(where r.rating = 'Helpful') * 3 >= count(*) * 2 order by n.id desc`;
		for (const p of posts) { const note = notes.find((n: any) => n.post_id === p.id); if (note) p.communityNote = { id: note.id, text: note.text }; }
		const mentions = await sql`select m.post_id, u.id, u.screen_name, u.name from post_mentions m join users u on u.id = m.user_id
			where m.post_id = any(${sql.array(posts.map((p) => p.id), "INT8")})`;
		for (const p of posts) p.mentions = mentions.filter((m: any) => String(m.post_id) === p.id).map((m: any) => ({ id: String(m.id), screen_name: m.screen_name, name: m.name }));
	}
	const pollIds = [...new Set(posts.map((p) => p.poll_id).filter((id): id is string => !!id))];
	if (pollIds.length) {
		const polls = await pollsByIds(viewerId, pollIds);
		for (const p of posts) {
			const poll = p.poll_id ? polls.get(p.poll_id) : undefined;
			if (poll) p.poll = pollCard(poll);
		}
	}
	const editedIds = posts.filter((p) => p.edit_count).map((p) => p.id);
	if (editedIds.length) {
		const versions = await sql`select post_id::text, version_id::text from post_versions where post_id = any(${sql.array(editedIds, "INT8")}) order by seq`;
		for (const p of posts) if (p.edit_count) p.versionIds = versions.filter((v: any) => v.post_id === p.id).map((v: any) => v.version_id);
	}
	const communityIds = [...new Set(posts.map((p) => p.community_id).filter((id): id is string => !!id))];
	if (communityIds.length) {
		const communities = await communityObjects(viewerId, communityIds);
		for (const p of posts) if (p.community_id) p.community = communities.get(p.community_id);
	}
	const articles = await articlesByIds(viewerId, [...new Set(posts.map((p) => p.article_id).filter((id): id is string => !!id))]);
	for (const p of posts) if (p.article_id) p.article = articles.get(p.article_id);
	const quoteIds = [...new Set(posts.map((p) => p.quote_id).filter((id): id is string => !!id))];
	if (quotes && quoteIds.length) {
		const quoted = await postsByIds(viewerId, quoteIds, false);
		for (const p of posts) if (p.quote_id) p.quoted = quoted.get(p.quote_id);
	}
	return posts;
}

export async function postsByIds(viewerId: string, ids: string[], quotes = true): Promise<Map<string, PostRow>> {
	if (!ids.length) return new Map();
	const rows = await sql`${select(viewerId)} where p.id = any(${sql.array(ids, "INT8")})`;
	const posts = await hydrate(viewerId, rows.map(toRow), quotes);
	// being shown a post counts once per viewer; nobody waits for it
	const seen = posts.filter((p) => p.author.id !== viewerId).map((p) => p.id);
	if (seen.length)
		void sql`insert into post_views (post_id, user_id) select x, ${viewerId}::bigint from unnest(${sql.array(seen, "INT8")}::bigint[]) x on conflict do nothing`.catch(() => {});
	const out = new Map(posts.map((p) => [p.id, p]));
	const unknown = ids.filter((id) => !out.has(id));
	if (unknown.length) {
		const versions = await sql`select version_id::text, post_id::text, text, created_at from post_versions where version_id = any(${sql.array(unknown, "INT8")})`;
		const current = await postsByIds(viewerId, [...new Set(versions.map((v: any) => v.post_id as string))] as string[], quotes);
		for (const v of versions) {
			const base = current.get(v.post_id);
			if (base) out.set(v.version_id, { ...base, id: v.version_id, text: v.text, created_at: v.created_at, staleEditOf: base.id });
		}
	}
	return out;
}

const EDIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_EDITS = 5;

// Text changes only; media, replies and quotes stay as posted. The post keeps its
// id and what it said before goes to post_versions.
// the author's limit goes by their badge (textlen.ts, Admin > Settings)
export async function checkLength(userId: string, text: string) {
	const [u] = await sql`select verified_type from users where id = ${userId}::bigint`;
	const limit = postLimitFor(u?.verified_type);
	if (weightedLength(text) > limit) throw new PostError(`Posts are limited to ${limit.toLocaleString("en-US")} characters.`, 186);
}

export async function editPost(userId: string, postId: string, text: string): Promise<void> {
	if (hasBlockedPhrase(text)) throw new PostError("Your post contains a phrase this instance doesn't allow.", 186);
	if (!text.trim()) throw new PostError("Your post is empty.", 170);
	await checkLength(userId, text);
	const [post] = await sql`select p.id::text, p.text, p.created_at, p.edit_count, p.edited_at, u.status,
			exists (select 1 from users x where x.id = p.user_id and x.pinned_post_id = p.id) as pinned
		from posts p join users u on u.id = p.user_id where p.id = ${postId}::bigint and p.user_id = ${userId}::bigint`;
	if (!post) throw new PostError("You can only edit your own posts.", 144);
	if (post.status !== "active") throw new PostError("Your account can't edit posts right now.", 326);
	if (post.pinned) throw new PostError("Unpin this post before editing it.", 214);
	if (Date.now() > new Date(post.created_at).getTime() + EDIT_WINDOW_MS) throw new PostError("This post can't be edited anymore.", 214);
	if (post.edit_count >= MAX_EDITS) throw new PostError("This post has reached its edit limit.", 214);
	if (text === post.text) throw new PostError("There's nothing new to save.", 214);
	await sql`insert into post_versions (version_id, post_id, seq, text, created_at)
		values (${newId()}::bigint, ${postId}::bigint, ${post.edit_count}, ${post.text}, ${post.edited_at ?? post.created_at})`;
	await sql`update posts set text = ${text}, edit_count = edit_count + 1, edited_at = now() where id = ${postId}::bigint`;
	await sql`delete from post_mentions where post_id = ${postId}::bigint`;
	const names = [...new Set([...text.matchAll(MENTION)].map((m) => m[1].toLowerCase()))].slice(0, 20);
	if (names.length)
		await sql`insert into post_mentions (post_id, user_id)
			select ${postId}::bigint, u.id from users u where lower(u.screen_name) = any(${sql.array(names, "TEXT")}) on conflict do nothing`;
}

export async function getPost(viewerId: string, id: string): Promise<PostRow | undefined> {
	const post = (await postsByIds(viewerId, [id])).get(id);
	if (post) return post;
	const original = await originalPostId(id);
	return original === id ? undefined : (await postsByIds(viewerId, [original])).get(original);
}

// X's client acts on a repost by the repost's own id (like, bookmark, repost,
// open); X takes it as the post that was reposted. Ids never collide: posts
// and reposts draw from the same generator.
export async function originalPostId(id: string): Promise<string> {
	const [r] = await sql`select post_id::text from reposts where id = ${id}::bigint`;
	return r?.post_id ?? id;
}

// One entry of a timeline: a post, or someone's repost of it. Reposts have
// their own id, which orders them among posts by when they were made.
export type FeedItem = { id: string; post: PostRow; repost?: { by: User; created_at: Date } };

export type FeedQuery = {
	viewerId: string;
	// whose posts and reposts: everyone, the viewer plus accounts they follow, or one account
	authors: { all: true } | { following: true } | { user: string } | { list: string } | { community: string };
	replies: boolean;
	kinds: "both" | "posts" | "reposts";
	// only posts with attached media of this kind
	media?: "any" | "photo" | "video";
	// replies and nothing else
	onlyReplies?: boolean;
	// posts that carry an article
	articlesOnly?: boolean;
	limit: number;
	// exclusive item ids
	before?: string;
	after?: string;
};

// Conditions on feed_items rows (aliased f). Blocked accounts never show, either
// as author or reposter; muted ones and muted words only leave the home feeds.
// A profile stays readable to the one who blocked it ("View posts"), never to the blocked.
const originalAuthor = () => sql`(select x.user_id from posts x where x.id = f.post_id)`;
export const homeHidden = (viewerId: string) => sql`f.author_id not in ${blockedFor(viewerId)} and ${originalAuthor()} not in ${blockedFor(viewerId)}
	and f.author_id not in ${outOfView(viewerId)} and ${originalAuthor()} not in ${outOfView(viewerId)}
	and f.author_id not in ${protectedFor(viewerId)} and ${originalAuthor()} not in ${protectedFor(viewerId)}
	and f.author_id not in ${mutedFor(viewerId)} and ${originalAuthor()} not in ${mutedFor(viewerId)}
	and not ${hasMutedWord(viewerId, "home_timeline", sql`f.post_id`)}
	and (f.reposter_id is null or f.reposter_id not in (select target_id from repost_mutes where user_id = ${viewerId}::bigint))`;
// posts of a community show outside it only to its members (f is feed_items)
export const communityVisible = (viewerId: string) => sql`((select x.community_id from posts x where x.id = f.post_id) is null
	or (select x.community_id from posts x where x.id = f.post_id) in (select community_id from community_members where user_id = ${viewerId}::bigint))`;

// a muted list keeps its members out of the home feeds, not out of the list itself
const listMuted = (viewerId: string) => sql`f.author_id not in (select m.user_id from list_mutes x join list_members m on m.list_id = x.list_id where x.user_id = ${viewerId}::bigint)`;
const blockedBy = (viewerId: string) => sql`(select blocker_id from blocks where blocked_id = ${viewerId}::bigint)`;
const profileHidden = (viewerId: string) => sql`f.author_id not in ${blockedBy(viewerId)} and ${originalAuthor()} not in ${blockedBy(viewerId)}
	and f.author_id not in ${suspendedFor(viewerId)} and ${originalAuthor()} not in ${suspendedFor(viewerId)}
	and f.author_id not in ${protectedFor(viewerId)} and ${originalAuthor()} not in ${protectedFor(viewerId)}`;

export async function feed(q: FeedQuery): Promise<FeedItem[]> {
	const authorFilter =
		"user" in q.authors
			? sql`f.author_id = ${q.authors.user}::bigint`
			: "community" in q.authors
				? sql`(f.reposter_id is null and f.post_id in (select id from posts where community_id = ${q.authors.community}::bigint))`
			: "list" in q.authors
				? sql`f.author_id in (select user_id from list_members where list_id = ${q.authors.list}::bigint)`
				: "following" in q.authors
					? sql`(f.author_id = ${q.viewerId}::bigint or f.author_id in (select followee_id from follows where follower_id = ${q.viewerId}::bigint))`
					: sql`true`;
	const kindFilter = q.kinds === "posts" ? sql`f.reposter_id is null` : q.kinds === "reposts" ? sql`f.reposter_id is not null` : sql`true`;
	const replyFilter = q.onlyReplies ? sql`f.is_reply` : q.replies ? sql`true` : sql`not f.is_reply`;
	const articleFilter = q.articlesOnly ? sql`exists (select 1 from posts a where a.id = f.post_id and a.article_id is not null)` : sql`true`;
	const mediaFilter = !q.media
		? sql`true`
		: q.media === "any"
			? sql`exists (select 1 from media m where m.post_id = f.post_id)`
			: q.media === "video"
				? sql`exists (select 1 from media m where m.post_id = f.post_id and m.kind = 'video')`
				: sql`exists (select 1 from media m where m.post_id = f.post_id and m.kind <> 'video')`;
	// a community's posts stay in the community for everyone who isn't in it
	const communityFilter = "community" in q.authors ? sql`true` : communityVisible(q.viewerId);
	const home = !("user" in q.authors);
	const hidden = home ? ("list" in q.authors || "community" in q.authors ? homeHidden(q.viewerId) : sql`${homeHidden(q.viewerId)} and ${listMuted(q.viewerId)}`) : profileHidden(q.viewerId);
	const rows = q.after
		? await sql`select * from feed_items f where ${authorFilter} and ${kindFilter} and ${replyFilter} and ${mediaFilter} and ${articleFilter} and ${communityFilter} and ${hidden} and f.item_id > ${q.after}::bigint
			order by f.item_id asc limit ${q.limit}`
		: await sql`select * from feed_items f where ${authorFilter} and ${kindFilter} and ${replyFilter} and ${mediaFilter} and ${articleFilter} and ${communityFilter} and ${hidden} and f.item_id < ${q.before ?? NO_LIMIT}::bigint
			order by f.item_id desc limit ${q.limit}`;
	if (q.after) rows.reverse();

	return itemsFromRows(q.viewerId, rows);
}

// feed_items rows (aliased f) as feed entries, in the order given
export async function itemsFromRows(viewerId: string, rows: any[]): Promise<FeedItem[]> {
	const posts = await postsByIds(viewerId, [...new Set(rows.map((r: any) => r.post_id as string))] as string[]);
	const reposters = await usersByIds(viewerId, [...new Set(rows.filter((r: any) => r.reposter_id).map((r: any) => r.reposter_id as string))] as string[]);
	const items: FeedItem[] = [];
	for (const r of rows) {
		const post = posts.get(r.post_id);
		if (!post) continue;
		const by = r.reposter_id ? reposters.get(r.reposter_id) : undefined;
		items.push({ id: r.item_id, post, ...(by ? { repost: { by, created_at: r.created_at } } : {}) });
	}
	return items;
}

// the chain of posts this one replies to, oldest first
export async function ancestors(viewerId: string, replyToId: string): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		where p.id in (
			with recursive chain as (
				select id, reply_to_id from posts where id = ${replyToId}::bigint
				union all
				select x.id, x.reply_to_id from posts x join chain c on x.id = c.reply_to_id
			) select id from chain)
		order by p.id asc`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function replies(viewerId: string, id: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)} where p.reply_to_id = ${id}::bigint and p.reply_hidden_at is null
		and p.user_id not in ${blockedFor(viewerId)} and p.user_id not in ${outOfView(viewerId)}
		and not ${hasMutedWord(viewerId, "tweet_replies", sql`p.id`)} order by p.id asc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

// Hide reply: only the author of the conversation's first post may hide a
// reply in it, or show it again.
export async function setReplyHidden(viewerId: string, replyId: string, hidden: boolean): Promise<void> {
	const [r] = await sql`select root.user_id::text as root_author from posts p join posts root on root.id = p.conversation_id
		where p.id = ${replyId}::bigint and p.reply_to_id is not null`;
	if (!r) throw new PostError("No status found with that ID.", 144);
	if (r.root_author !== viewerId) throw new PostError("Only the author of the conversation can hide replies.", 200);
	await sql`update posts set reply_hidden_at = ${hidden ? sql`now()` : null} where id = ${replyId}::bigint`;
}

// what the "Hidden replies" page lists, newest hidden first
export async function hiddenReplies(viewerId: string, rootId: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)} where p.conversation_id = ${rootId}::bigint and p.reply_hidden_at is not null
		and p.user_id not in ${blockedFor(viewerId)} and p.user_id not in ${outOfView(viewerId)} order by p.reply_hidden_at desc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function hasHiddenReplies(rootId: string): Promise<boolean> {
	const [r] = await sql`select 1 from posts where conversation_id = ${rootId}::bigint and reply_hidden_at is not null limit 1`;
	return !!r;
}

export async function bookmarkedPosts(viewerId: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		join bookmarks b on b.post_id = p.id and b.user_id = ${viewerId}::bigint
		order by b.created_at desc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function highlightedPosts(viewerId: string, userId: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		join highlights h on h.post_id = p.id and h.user_id = ${userId}::bigint
		order by h.created_at desc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function setHighlight(userId: string, postId: string, on: boolean): Promise<boolean> {
	if (!on) {
		await sql`delete from highlights where user_id = ${userId}::bigint and post_id = ${postId}::bigint`;
		return true;
	}
	const [mine] = await sql`select 1 from posts where id = ${postId}::bigint and user_id = ${userId}::bigint`;
	if (!mine) return false;
	await sql`insert into highlights (user_id, post_id) values (${userId}::bigint, ${postId}::bigint) on conflict do nothing`;
	return true;
}

export async function folderPosts(viewerId: string, folderId: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		join bookmark_folder_posts f on f.post_id = p.id and f.folder_id = ${folderId}::bigint
		join bookmark_folders bf on bf.id = f.folder_id and bf.user_id = ${viewerId}::bigint
		order by f.created_at desc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function likedPosts(viewerId: string, userId: string, limit = 100): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)}
		join likes lk on lk.post_id = p.id and lk.user_id = ${userId}::bigint
		order by lk.created_at desc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

export async function createPost(userId: string, text: string, opts: { replyToId?: string; quoteId?: string; articleId?: string; source?: string; communityId?: string; placeId?: string; replyPolicy?: string } = {}): Promise<string> {
	if (hasBlockedPhrase(text)) throw new PostError("Your post contains a phrase this instance doesn't allow.", 186);
	const [author] = await sql`select status from users where id = ${userId}::bigint`;
	if (author?.status === "restricted") throw new PostError("Your account can't post right now.", 326);
	await checkLength(userId, text);
	const id = newId();
	let conversationId = id;
	if (opts.replyToId) {
		const [parent] = await sql`select conversation_id, user_id from posts where id = ${opts.replyToId}::bigint`;
		if (!parent) throw new PostError("The post you are replying to no longer exists.", 385);
		if (await isBlockedEitherWay(userId, String(parent.user_id))) throw new PostError("You can't reply to this post.", 433);
		conversationId = parent.conversation_id;
		const [limited] = await sql`select exists (select 1 from posts r where r.id = ${conversationId}::bigint and r.reply_policy is not null and r.user_id <> ${userId}::bigint and not (
				(r.reply_policy = 'Community' and exists (select 1 from follows f where f.follower_id = r.user_id and f.followee_id = ${userId}::bigint))
				or (r.reply_policy = 'ByInvitation' and exists (select 1 from post_mentions m where m.post_id = r.id and m.user_id = ${userId}::bigint))
				or (r.reply_policy = 'Verified' and exists (select 1 from users x where x.id = ${userId}::bigint and (x.verified_type is not null or exists (select 1 from affiliations af where af.user_id = x.id)))))) as no`;
		if (limited.no) throw new PostError("The author of the original post limited who can reply to it.", 433);
	}
	if (opts.quoteId) {
		const [quoted] = await sql`select id, user_id from posts where id = ${opts.quoteId}::bigint`;
		if (!quoted) throw new PostError("The post you are quoting no longer exists.", 385);
		if (await isBlockedEitherWay(userId, String(quoted.user_id))) throw new PostError("You can't quote this post.", 433);
		const [owner] = await sql`select protected from users where id = ${quoted.user_id}::bigint`;
		if (owner?.protected && String(quoted.user_id) !== userId) throw new PostError("Posts from protected accounts can't be quoted.", 433);
	}
	if (opts.communityId) {
		const [m] = await sql`select 1 from community_members where community_id = ${opts.communityId}::bigint and user_id = ${userId}::bigint`;
		if (!m) throw new PostError("Only members can post in this community.", 187);
	}
	await sql`insert into posts (id, user_id, text, reply_to_id, conversation_id, quote_id, article_id, source, community_id, place_id, reply_policy)
		values (${id}::bigint, ${userId}::bigint, ${text}, ${opts.replyToId ?? null}::bigint, ${conversationId}::bigint, ${opts.quoteId ?? null}::bigint, ${opts.articleId ?? null}::bigint, ${opts.source ?? webSource()}, ${opts.communityId ?? null}::bigint, ${opts.placeId ?? null}, ${opts.replyToId ? null : opts.replyPolicy ?? null})`;
	const names = [...new Set([...text.matchAll(MENTION)].map((m) => m[1].toLowerCase()))].slice(0, 20);
	if (names.length)
		await sql`insert into post_mentions (post_id, user_id)
			select ${id}::bigint, u.id from users u where lower(u.screen_name) = any(${sql.array(names, "TEXT")}) on conflict do nothing`;
	return id;
}

export async function deletePost(userId: string, id: string): Promise<boolean> {
	const rows = await sql`delete from posts where id = ${id}::bigint and user_id = ${userId}::bigint returning id`;
	return rows.length > 0;
}

// only the author can pin, and only one post at a time
export async function setPinned(userId: string, postId: string | null): Promise<boolean> {
	if (postId === null) {
		await sql`update users set pinned_post_id = null where id = ${userId}::bigint`;
		return true;
	}
	const rows = await sql`update users set pinned_post_id = ${postId}::bigint
		where id = ${userId}::bigint and exists (select 1 from posts where id = ${postId}::bigint and user_id = ${userId}::bigint)
		returning id`;
	return rows.length > 0;
}

// The author of a conversation's first post may pin one direct reply to it.
export async function setPinnedReply(userId: string, conversationId: string, replyId: string, on: boolean): Promise<boolean> {
	if (!on) {
		const rows = await sql`update posts set pinned_reply_id = null
			where id = ${conversationId}::bigint and user_id = ${userId}::bigint and pinned_reply_id = ${replyId}::bigint returning id`;
		return rows.length > 0;
	}
	const rows = await sql`update posts set pinned_reply_id = ${replyId}::bigint
		where id = ${conversationId}::bigint and user_id = ${userId}::bigint and reply_to_id is null
			and exists (select 1 from posts r where r.id = ${replyId}::bigint and r.reply_to_id = ${conversationId}::bigint and not r.hidden)
		returning id`;
	return rows.length > 0;
}

export async function pinnedReplyOf(postId: string): Promise<string | null> {
	const [row] = await sql`select pinned_reply_id::text as id from posts where id = ${postId}::bigint`;
	return row?.id ?? null;
}

type Mark = "likes" | "bookmarks";

export async function setMark(table: Mark, userId: string, postId: string, on: boolean) {
	postId = await originalPostId(postId);
	// a deleted post, or one this account can't see (blocked, protected,
	// hidden): X's "not found", not a database error
	if (on && !(await getPost(userId, postId))) throw new PostError("No status found with that ID.", 144);
	if (table === "likes") {
		if (on) await sql`insert into likes (user_id, post_id) values (${userId}::bigint, ${postId}::bigint) on conflict do nothing`;
		else await sql`delete from likes where user_id = ${userId}::bigint and post_id = ${postId}::bigint`;
	} else {
		if (on) await sql`insert into bookmarks (user_id, post_id) values (${userId}::bigint, ${postId}::bigint) on conflict do nothing`;
		else await sql`delete from bookmarks where user_id = ${userId}::bigint and post_id = ${postId}::bigint`;
	}
}

export async function repost(userId: string, postId: string): Promise<string> {
	postId = await originalPostId(postId);
	// a protected account's posts can't be passed on
	const [owner] = await sql`select u.protected, u.id::text as owner from posts p join users u on u.id = p.user_id where p.id = ${postId}::bigint`;
	if (!owner || !(await getPost(userId, postId))) throw new PostError("No status found with that ID.", 144);
	if (owner?.protected && owner.owner !== userId) throw new PostError("Posts from protected accounts can't be reposted.", 328);
	const id = newId();
	const rows = await sql`insert into reposts (id, user_id, post_id) values (${id}::bigint, ${userId}::bigint, ${postId}::bigint)
		on conflict (user_id, post_id) do update set post_id = excluded.post_id returning id`;
	return rows[0].id;
}

export async function unrepost(userId: string, postId: string) {
	postId = await originalPostId(postId);
	await sql`delete from reposts where user_id = ${userId}::bigint and post_id = ${postId}::bigint`;
}

export class PostError extends Error {
	constructor(
		message: string,
		public code: number,
	) {
		super(message);
	}
}
