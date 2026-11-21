import type { User } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { queueReview } from "./claude-mod";
import { INSTANCE_ID } from "./federation";
import { idAt, newId } from "./ids";
import { hateIn } from "./hate";
import { automodStrike } from "./moderation";
import { feature, hasBlockedPhrase, settings } from "./settings";
import { postLimitFor, weightedLength } from "./textlen";
import type { PostRow } from "./model";
import { articlesByIds } from "./articles";
import { blockedFor, federatedHiddenFor, hasMutedWord, isBlockedEitherWay, mutedFor, outOfView, protectedFor, replyLimited, suspendedFor } from "./blocks";
import { staffViewer } from "./staff-access";
import { fetchPreview, linkCard, linksIn, previewable, previewsFor, statusLinkOf } from "./links";
import { paymentCards, rewardLike } from "./money";
import { mediaForPosts } from "./media";
import { communityObjects } from "./community-model";
import { webSource } from "./platforms";
import { pollCard, pollsByIds } from "./polls";
import { toUser, userCols, usersByIds } from "./users";
import { lookupRemoteUser } from "./federation-sync";
import { saveMentions } from "./mentions";
import { cleanText } from "./text-clean";
import { replyControl, replyRestricted } from "./reply-controls";
import { noteStatus } from "./note-score";
import { circleMember, circleSeen } from "./circles";

const NO_LIMIT = "9223372036854775807";

// accounts whose likes, reposts and replies no longer count for anyone
const SUSPENDED = sql`(select id from users where status = 'suspended' or instance_blocked)`;

// every post query starts from this; callers append where/order/limit
const select = (viewerId: string) => sql`
	select p.id, p.text, p.conversation_card, p.conversation_card_post_id::text, p.reply_to_id, p.conversation_id, p.quote_id, p.article_id, p.created_at, p.source, p.sensitive and not u.never_sensitive as sensitive, u.never_sensitive, p.community_id::text as community_id, p.poll_id::text as poll_id, p.place_id, p.edit_count, p.edited_at, p.reply_policy,
		${replyRestricted(viewerId)} as reply_limited,
		(select cr.reply_policy from posts cr where cr.id = p.conversation_id) as conversation_policy,
		(select cr.reply_selections from posts cr where cr.id = p.conversation_id) as conversation_selections,
		(select cu.screen_name from posts cr join users cu on cu.id = cr.user_id where cr.id = p.conversation_id) as conversation_owner,
		ru.id as reply_user_id, ru.screen_name as reply_screen_name,
		${userCols(viewerId)},
		-- staff can set the shown counts (admin panel); the lists behind them stay real
		coalesce((p.count_overrides->>'likes')::int, greatest((p.remote_counts->>'likes')::int, (select count(*)::int from likes x where x.post_id = p.id and x.user_id not in ${SUSPENDED}))) as like_count,
		coalesce((p.count_overrides->>'reposts')::int, greatest((p.remote_counts->>'reposts')::int, (select count(*)::int from reposts x where x.post_id = p.id and x.user_id not in ${SUSPENDED}))) as repost_count,
		coalesce((p.count_overrides->>'bookmarks')::int, greatest((p.remote_counts->>'bookmarks')::int, (select count(*)::int from bookmarks x where x.post_id = p.id))) as bookmark_count,
		coalesce((p.count_overrides->>'replies')::int, greatest((p.remote_counts->>'replies')::int, (select count(*)::int from posts x where x.reply_to_id = p.id and x.user_id not in ${SUSPENDED}))) as reply_count,
		coalesce((p.count_overrides->>'quotes')::int, greatest((p.remote_counts->>'quotes')::int, (select count(*)::int from posts x where x.quote_id = p.id and x.user_id not in ${SUSPENDED}))) as quote_count,
		coalesce((p.count_overrides->>'views')::int, greatest((p.remote_counts->>'views')::int, (select count(*)::int from post_views x where x.post_id = p.id))) as view_count,
		p.notice, p.circle_owner_id::text as circle_owner_id, (select c.screen_name from users c where c.id = p.circle_owner_id) as circle_owner,
		exists (select 1 from likes x where x.post_id = p.id and x.user_id = ${viewerId}::bigint) as liked,
		exists (select 1 from reposts x where x.post_id = p.id and x.user_id = ${viewerId}::bigint) as reposted,
		exists (select 1 from bookmarks x where x.post_id = p.id and x.user_id = ${viewerId}::bigint) as bookmarked
	from posts p
	join users u on u.id = p.user_id and (not p.hidden or ${staffViewer(viewerId)}) and ${circleSeen(viewerId)}
		and u.id not in ${protectedFor(viewerId)} and u.id not in ${suspendedFor(viewerId)}
		and u.id not in (select blocker_id from blocks where blocked_id = ${viewerId}::bigint)
	left join posts rp on rp.id = p.reply_to_id
	left join users ru on ru.id = coalesce(rp.user_id, p.reply_to_user_id)`;

function toRow(r: any): PostRow {
	return {
		id: r.id,
		text: r.text,
		source: r.source,
		sensitive: r.sensitive,
		never_sensitive: r.never_sensitive,
		reply_to_id: r.reply_to_id,
		conversation_id: r.conversation_id,
		quote_id: r.quote_id,
		article_id: r.article_id,
		community_id: r.community_id,
		circle_owner: r.circle_owner_id ? { id: r.circle_owner_id, screen_name: r.circle_owner } : null,
		poll_id: r.poll_id,
		conversationCard: r.conversation_card,
		conversationCardPostId: r.conversation_card_post_id,
		place_id: r.place_id,
		edit_count: r.edit_count,
		view_count: r.view_count,
		notice: r.notice ?? null,
		reply_policy: r.reply_policy,
		reply_limited: !!r.reply_limited,
		conversation_policy: r.conversation_policy,
		conversation_selections: r.conversation_selections,
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

// media, articles, and the post each one quotes (one level: a quote inside a quote is not expanded).
// The lookups run at once (in a row they were a dozen round trips on each
// timeline page) and are applied in the order below: whether a link becomes a
// quote, a preview or a payment card depends on what came before it.
async function hydrate(viewerId: string, posts: PostRow[], quotes = true): Promise<PostRow[]> {
	let cardPost: PostRow, cardSource: any;
	const ids = posts.map((p) => p.id);
	const cardSourceIds = [...new Set(posts.map((p) => p.conversationCardPostId).filter((id): id is string => !!id))];
	const pollIds = [...new Set(posts.map((p) => p.poll_id).filter((id): id is string => !!id))];
	const statusLinks = posts.flatMap((p) => linksIn(p.text).flatMap((l) => {
		const at = statusLinkOf(l.url);
		return at ? [{ post: p, url: l.url, ...at }] : [];
	}));
	const editedIds = posts.filter((p) => p.edit_count).map((p) => p.id);
	const communityIds = [...new Set(posts.map((p) => p.community_id).filter((id): id is string => !!id))];
	const quoteIds = [...new Set(posts.map((p) => p.quote_id).filter((id): id is string => !!id))];
	const linkedPosts = async () => {
		const copies = await sql`select instance, remote_id::text, local_id::text from federated_objects where kind = 'post'
			and (instance, remote_id) in (select * from unnest(${sql.array(statusLinks.map((l) => l.host), "TEXT")}::text[], ${sql.array(statusLinks.map((l) => l.id), "TEXT")}::bigint[]))`;
		const localOf = (l: (typeof statusLinks)[number]) => (l.host === INSTANCE_ID ? l.id : copies.find((c: any) => c.instance === l.host && c.remote_id === l.id)?.local_id);
		const linked = await postsByIds(viewerId, [...new Set(statusLinks.map(localOf).filter((id): id is string => !!id))], false);
		return { localOf, linked };
	};
	const [media, cardRows, cardMedia, notes, mentions, polls, links, versions, communities, articles, quoted] = await Promise.all([
		mediaForPosts(ids),
		cardSourceIds.length ? sql`${select(viewerId)} where p.id = any(${sql.array(cardSourceIds, "INT8")}) and p.conversation_card_post_id is null` : [],
		mediaForPosts(cardSourceIds),
		ids.length
			? sql`select n.id::text, n.post_id::text, n.text, count(*)::int as ratings,
				count(*) filter(where r.rating = 'Helpful')::int as helpful, count(*) filter(where r.rating = 'NotHelpful')::int as not_helpful
				from community_notes n join users author on author.id = n.author_id and author.status <> 'suspended'
				join community_note_ratings r on r.note_id = n.id join users voter on voter.id = r.user_id and voter.status = 'active'
				where n.post_id = any(${sql.array(ids, "INT8")}) and n.classification = 'Misleading' and n.author_id not in ${blockedFor(viewerId)}
				group by n.id order by n.id desc`
			: [],
		ids.length
			? sql`select m.post_id, u.id, u.screen_name, u.name from post_mentions m join users u on u.id = m.user_id
				where m.post_id = any(${sql.array(ids, "INT8")})`
			: [],
		pollIds.length ? pollsByIds(viewerId, pollIds) : undefined,
		statusLinks.length ? linkedPosts() : undefined,
		editedIds.length ? sql`select post_id::text, version_id::text from post_versions where post_id = any(${sql.array(editedIds, "INT8")}) order by seq` : [],
		communityIds.length ? communityObjects(viewerId, communityIds) : undefined,
		articlesByIds(viewerId, [...new Set(posts.map((p) => p.article_id).filter((id): id is string => !!id))]),
		quotes && quoteIds.length ? postsByIds(viewerId, quoteIds, false) : undefined,
	]);
	const cardSources = new Map<string, any>(cardRows.map((row: any) => [String(row.id), row]));
	for (cardPost of posts) {
		cardSource = cardPost.conversationCardPostId ? cardSources.get(cardPost.conversationCardPostId) : undefined;
		if (cardSource?.conversation_card) {
			cardPost.conversationCard = cardSource.conversation_card;
			cardPost.conversationCreative = cardMedia.get(String(cardSource.id))?.[0];
			cardPost.sensitive = cardPost.sensitive || cardSource.sensitive;
		}
	}
	for (const p of posts) p.media = (media.get(p.id) ?? []).map((m) => (p.never_sensitive ? { ...m, sensitive_warning: null } : m));
	for (const p of posts) { const note = notes.find((n: any) => n.post_id === p.id && noteStatus(n.ratings, n.helpful, n.not_helpful) === "Helpful"); if (note) p.communityNote = { id: note.id, text: note.text }; }
	if (ids.length) for (const p of posts) p.mentions = mentions.filter((m: any) => String(m.post_id) === p.id).map((m: any) => ({ id: String(m.id), screen_name: m.screen_name, name: m.name }));
	if (polls)
		for (const p of posts) {
			const poll = p.poll_id ? polls.get(p.poll_id) : undefined;
			if (poll) p.poll = pollCard(poll);
		}
	if (links) {
		const { localOf, linked } = links;
		for (const l of statusLinks) {
			const target = linked.get(localOf(l) ?? "");
			if (!target) continue;
			l.post.localLinks ??= new Map();
			l.post.localLinks.set(l.url, `${PUBLIC_ORIGIN}/${target.author.screen_name}/status/${target.id}`);
			if (quotes && !l.post.quote_id && !l.post.poll && !l.post.conversationCard && !l.post.article_id && !l.post.media?.length && target.id !== l.post.id) l.post.quoted = target;
		}
	}
	const linkOf = (p: PostRow) => (p.poll || p.conversationCard || p.quote_id || p.quoted || p.article_id || p.media?.length ? undefined : linksIn(p.text).filter((l) => previewable(l.url)).at(-1)?.url);
	const previews = await previewsFor(posts.map(linkOf).filter((u): u is string => !!u));
	for (const p of posts) {
		const preview = previews.get(linkOf(p) ?? "");
		if (preview) p.linkCard = linkCard(preview);
	}
	// a payment's link put in by one of its sides, or a request's by its
	// requester, becomes its card (money.ts)
	const payable = posts.filter((p) => !p.linkCard && !p.poll && !p.conversationCard && !p.quote_id && !p.quoted && !p.article_id && !p.media?.length && /\/i\/xmoney\/[pr]\//.test(p.text));
	if (payable.length) {
		const cards = await paymentCards(payable.map((p) => ({ authorId: p.author.id, text: p.text })));
		for (const [i, p] of payable.entries()) if (cards[i]) p.linkCard = cards[i];
	}
	if (editedIds.length) for (const p of posts) if (p.edit_count) p.versionIds = versions.filter((v: any) => v.post_id === p.id).map((v: any) => v.version_id);
	if (communities) for (const p of posts) if (p.community_id) p.community = communities.get(p.community_id);
	for (const p of posts) if (p.article_id) p.article = articles.get(p.article_id);
	if (quoted) for (const p of posts) if (p.quote_id) p.quoted = quoted.get(p.quote_id);
	return posts;
}

// `views: false` for lookups nobody sees as a page (push texts)
export async function postsByIds(viewerId: string, ids: string[], quotes = true, opts: { views?: boolean } = {}): Promise<Map<string, PostRow>> {
	if (!ids.length) return new Map();
	const rows = await sql`${select(viewerId)} where p.id = any(${sql.array(ids, "INT8")})`;
	const posts = await hydrate(viewerId, rows.map(toRow), quotes);
	// being shown a post counts once per viewer; nobody waits for it
	const seen = posts.filter((p) => p.author.id !== viewerId).map((p) => p.id);
	if (seen.length && opts.views !== false)
		void sql`insert into post_views (post_id, user_id) select x, ${viewerId}::bigint from unnest(${sql.array(seen, "INT8")}::bigint[]) x on conflict do nothing`.catch(() => {});
	const out = new Map(posts.map((p) => [p.id, p]));
	const unknown = ids.filter((id) => !out.has(id));
	if (unknown.length) {
		const versions = await sql`select version_id::text, post_id::text, text, created_at from post_versions where version_id = any(${sql.array(unknown, "INT8")})`;
		const current = await postsByIds(viewerId, [...new Set(versions.map((v: any) => v.post_id as string))] as string[], quotes, opts);
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
export async function checkLength(userId: string, text: string, db: typeof sql = sql) {
	const [u] = await db`select verified_type from users where id = ${userId}::bigint`;
	const limit = postLimitFor(u?.verified_type);
	if (weightedLength(text) > limit) throw new PostError(`Posts are limited to ${limit.toLocaleString("en-US")} characters.`, 186);
}

export async function refuseHate(userId: string, text: string, where: Parameters<typeof automodStrike>[2] = "post") {
	const hit = hateIn(text);
	if (!hit) return;
	await automodStrike(userId, hit, where, text);
	throw new PostError("Your post wasn't published: it contains a slur or hate speech this instance doesn't allow.", 186);
}

export async function editPost(userId: string, postId: string, input: string): Promise<void> {
	const text = cleanText(input, { blankLines: 2 });
	// the length first: the checks below scan the whole text
	await checkLength(userId, text);
	await refuseHate(userId, text);
	if (hasBlockedPhrase(text)) throw new PostError("Your post contains a phrase this instance doesn't allow.", 186);
	if (!text.trim()) throw new PostError("Your post is empty.", 170);
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
	await saveMentions(postId, text, undefined, lookupRemoteUser);
	queueReview("post", postId);
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
	and f.author_id not in ${federatedHiddenFor(viewerId)} and ${originalAuthor()} not in ${federatedHiddenFor(viewerId)}
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
	// Circle posts the viewer isn't in would only drop out later and shorten the
	// page; staff see them on profiles, not in their own timelines
	const circleFilter = sql`exists (select 1 from posts x where x.id = f.post_id and ${home ? circleMember(q.viewerId, sql`x`) : circleSeen(q.viewerId, sql`x`)})`;
	const hidden = home ? ("list" in q.authors || "community" in q.authors ? homeHidden(q.viewerId) : sql`${homeHidden(q.viewerId)} and ${listMuted(q.viewerId)}`) : profileHidden(q.viewerId);
	const rows = q.after
		? await sql`select * from feed_items f where ${authorFilter} and ${kindFilter} and ${replyFilter} and ${mediaFilter} and ${articleFilter} and ${communityFilter} and ${circleFilter} and ${hidden} and f.item_id > ${q.after}::bigint
			order by f.item_id asc limit ${q.limit}`
		: await sql`select * from feed_items f where ${authorFilter} and ${kindFilter} and ${replyFilter} and ${mediaFilter} and ${articleFilter} and ${communityFilter} and ${circleFilter} and ${hidden} and f.item_id < ${q.before ?? NO_LIMIT}::bigint
			order by f.item_id desc limit ${q.limit}`;
	if (q.after) rows.reverse();

	return itemsFromRows(q.viewerId, rows);
}

// feed_items rows (aliased f) as feed entries, in the order given
export async function itemsFromRows(viewerId: string, rows: any[]): Promise<FeedItem[]> {
	const [posts, reposters] = await Promise.all([
		postsByIds(viewerId, [...new Set(rows.map((r: any) => r.post_id as string))] as string[]),
		usersByIds(viewerId, [...new Set(rows.filter((r: any) => r.reposter_id).map((r: any) => r.reposter_id as string))] as string[]),
	]);
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
		and p.user_id not in ${blockedFor(viewerId)} and p.user_id not in ${outOfView(viewerId)} and p.user_id not in ${federatedHiddenFor(viewerId)}
		and not ${hasMutedWord(viewerId, "tweet_replies", sql`p.id`)} order by p.id asc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

// who liked a post, newest first, minus the accounts the viewer can't see
export async function likerIds(viewerId: string, id: string, limit = 100): Promise<string[]> {
	const rows = await sql`select l.user_id::text as id from likes l where l.post_id = ${id}::bigint
		and l.user_id not in ${blockedFor(viewerId)} and l.user_id not in ${protectedFor(viewerId)} and l.user_id not in ${outOfView(viewerId)}
		order by l.created_at desc limit ${limit}`;
	return rows.map((r: any) => r.id);
}

export async function repliesBelow(viewerId: string, id: string, limit = 1000): Promise<PostRow[]> {
	const rows = await sql`${select(viewerId)} where p.id in (
			with recursive tree as (
				select id, 1 as depth from posts where reply_to_id = ${id}::bigint
				union all
				select x.id, t.depth + 1 from posts x join tree t on x.reply_to_id = t.id where t.depth < 40
			) select id from tree limit ${limit})
		and p.reply_hidden_at is null and p.user_id not in ${blockedFor(viewerId)} and p.user_id not in ${outOfView(viewerId)}
		and p.user_id not in ${federatedHiddenFor(viewerId)} and not ${hasMutedWord(viewerId, "tweet_replies", sql`p.id`)}`;
	return rows.map(toRow);
}

export const hydratePosts = (viewerId: string, posts: PostRow[]) => hydrate(viewerId, posts);

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

export async function folderPosts(viewerId: string, folderId: string, limit = 100, before?: { at: string; id: string }): Promise<{ posts: PostRow[]; next?: { at: string; id: string } }> {
	const rows = await sql`with page as (${select(viewerId)}
		join bookmark_folder_posts f on f.post_id = p.id and f.folder_id = ${folderId}::bigint
		join bookmark_folders bf on bf.id = f.folder_id and bf.user_id = ${viewerId}::bigint
		${before ? sql`where (f.created_at, f.post_id) < (${before.at}::timestamptz, ${before.id}::bigint)` : sql``}
		order by f.created_at desc, f.post_id desc limit ${limit + 1})
		select page.*, f.created_at::text as folder_created_at from page
		join bookmark_folder_posts f on f.post_id = page.id and f.folder_id = ${folderId}::bigint
		order by f.created_at desc, f.post_id desc`;
	const more = rows.length > limit;
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	return { posts: await hydrate(viewerId, page.map(toRow)), ...(more && last ? { next: { at: last.folder_created_at, id: String(last.id) } } : {}) };
}

export async function likedPosts(viewerId: string, userId: string, limit = 100): Promise<PostRow[]> {
	if (userId !== viewerId && !(await sql`select 1 where ${staffViewer(viewerId)}`).length) return [];
	const rows = await sql`${select(viewerId)}
		join likes lk on lk.post_id = p.id and lk.user_id = ${userId}::bigint
		order by lk.created_at desc limit ${limit}`;
	return hydrate(viewerId, rows.map(toRow));
}

export const seenBy = (userId: string) =>
	sql`(u.id = ${userId}::bigint or ((not p.hidden or ${staffViewer(userId)}) and ${circleSeen(userId)} and u.id not in ${protectedFor(userId)} and u.id not in ${suspendedFor(userId)}))`;

export async function createPost(userId: string, input: string, opts: { replyToId?: string; quoteId?: string; articleId?: string; source?: string; communityId?: string; placeId?: string; replyPolicy?: string; replySelections?: string[]; circle?: boolean; db?: typeof sql; skipPreview?: boolean; skipReview?: boolean } = {}): Promise<string> {
	const db = opts.db ?? sql;
	const text = cleanText(input, { blankLines: 2 });
	const control = replyControl(opts.replyPolicy, opts.replySelections);
	const [author] = await db`select status, deactivated_at, role from users where id = ${userId}::bigint`;
	if (!author || author.status === "restricted" || author.status === "suspended" || author.deactivated_at) throw new PostError("Your account can't post right now.", 326);
	const caps = settings().daily_caps;
	if (caps.enabled && !author.role) {
		const reply = !!opts.replyToId;
		const cap = reply ? caps.replies : caps.posts;
		const [made] = await db`select count(*)::int as n from posts
			where user_id = ${userId}::bigint and id >= ${idAt(Date.now() - 86_400_000)}::bigint and (reply_to_id is not null) = ${reply}`;
		if (made.n >= cap) throw new PostError(`You've reached the limit of ${cap} ${reply ? (cap === 1 ? "reply" : "replies") : cap === 1 ? "post" : "posts"} a day. Try again later.`, 185);
	}
	await checkLength(userId, text, db);
	await refuseHate(userId, text);
	if (hasBlockedPhrase(text)) throw new PostError("Your post contains a phrase this instance doesn't allow.", 186);
	const id = newId();
	let conversationId = id;
	let replyToUserId: string | null = null;
	// a reply in a Circle's thread stays in that Circle (circles.ts)
	let circleOwner: string | null = null;
	if (opts.circle && !opts.replyToId) {
		if (!feature("circles")) throw new PostError("Circles are switched off on this instance.", 459);
		if (opts.communityId) throw new PostError("A Circle post can't go to a community.", 459);
		circleOwner = userId;
	}
	if (opts.replyToId) {
		const [parent] = await db`select p.conversation_id, p.user_id, p.circle_owner_id::text as circle from posts p join users u on u.id = p.user_id where p.id = ${opts.replyToId}::bigint and ${seenBy(userId)}`;
		if (!parent) throw new PostError("The post you are replying to no longer exists.", 385);
		if (await isBlockedEitherWay(userId, String(parent.user_id), db)) throw new PostError("You can't reply to this post.", 433);
		conversationId = parent.conversation_id;
		replyToUserId = String(parent.user_id);
		circleOwner = parent.circle ?? null;
		// a public reply inside a protected thread still belongs to that thread
		// (GHSA-m9x2-9x93-6879): its root must be one the author may see too; a
		// deleted root leaves the thread open
		const [unseenRoot] = await db`select 1 from posts p join users u on u.id = p.user_id
			where p.id = ${conversationId}::bigint and not ${seenBy(userId)}`;
		if (unseenRoot) throw new PostError("The post you are replying to no longer exists.", 385);
		if (await replyLimited(opts.replyToId!, String(conversationId), userId, db)) throw new PostError("The author of this post or one above it limited who can reply.", 433);
	}
	if (opts.quoteId) {
		const [quoted] = await db`select p.id, p.user_id, p.circle_owner_id, p.ad_only from posts p join users u on u.id = p.user_id where p.id = ${opts.quoteId}::bigint and ${seenBy(userId)}`;
		if (!quoted) throw new PostError("The post you are quoting no longer exists.", 385);
		if (quoted.circle_owner_id) throw new PostError("Circle posts can't be quoted.", 460);
		if (quoted.ad_only) throw new PostError("Ads can't be quoted.", 460);
		if (await isBlockedEitherWay(userId, String(quoted.user_id), db)) throw new PostError("You can't quote this post.", 433);
		const [owner] = await db`select protected from users where id = ${quoted.user_id}::bigint`;
		if (owner?.protected && String(quoted.user_id) !== userId) throw new PostError("Posts from protected accounts can't be quoted.", 433);
	}
	if (opts.communityId) {
		const [m] = await db`select 1 from community_members where community_id = ${opts.communityId}::bigint and user_id = ${userId}::bigint`;
		if (!m) throw new PostError("Only members can post in this community.", 187);
	}
	await db`insert into posts (id, user_id, text, reply_to_id, reply_to_user_id, conversation_id, quote_id, article_id, source, community_id, place_id, reply_policy, reply_selections, reply_allowed_values, circle_owner_id)
		values (${id}::bigint, ${userId}::bigint, ${text}, ${opts.replyToId ?? null}::bigint, ${replyToUserId}::bigint, ${conversationId}::bigint, ${opts.quoteId ?? null}::bigint, ${opts.articleId ?? null}::bigint, ${opts.source ?? webSource()}, ${opts.communityId ?? null}::bigint, ${opts.placeId ?? null}, ${opts.replyToId ? null : control.policy}, ${db.array(opts.replyToId ? [] : control.selections, "TEXT")}, ${db.array(opts.replyToId ? [] : control.values, "TEXT")}, ${circleOwner}::bigint)`;
	// Transactional callers resolve unknown remote handles before publication;
	// only database writes belong inside the transaction and its row locks.
	await saveMentions(id, text, undefined, opts.db ? undefined : lookupRemoteUser, db);
	const link = opts.quoteId || opts.articleId ? undefined : linksIn(text).filter((l) => previewable(l.url)).at(-1);
	if (!opts.skipPreview && link && !(await db`select 1 from link_previews where url = ${link.url}`).length) await Promise.race([fetchPreview(link.url), Bun.sleep(4000)]);
	// Claude reads it afterwards (claude-mod.ts); inside a caller's transaction
	// (imports) the post isn't committed yet, so those are left out; the
	// server's own posts (payments feed) aren't read either
	if (!opts.db && !opts.skipReview) queueReview("post", id);
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
		if (on) {
			const added = await sql`insert into likes (user_id, post_id) values (${userId}::bigint, ${postId}::bigint) on conflict do nothing returning 1`;
			// each like pays the post's author (money.ts)
			if (added.length) await rewardLike(userId, postId);
		} else await sql`delete from likes where user_id = ${userId}::bigint and post_id = ${postId}::bigint`;
	} else {
		if (on) await sql`insert into bookmarks (user_id, post_id) values (${userId}::bigint, ${postId}::bigint) on conflict do nothing`;
		else await sql`delete from bookmarks where user_id = ${userId}::bigint and post_id = ${postId}::bigint`;
	}
}

export async function repost(userId: string, postId: string): Promise<string> {
	postId = await originalPostId(postId);
	// a protected account's posts can't be passed on
	const [owner] = await sql`select u.protected, u.id::text as owner, p.circle_owner_id is not null as circle, p.ad_only from posts p join users u on u.id = p.user_id where p.id = ${postId}::bigint`;
	if (!owner || !(await getPost(userId, postId))) throw new PostError("No status found with that ID.", 144);
	if (owner.circle) throw new PostError("Circle posts can't be reposted.", 456);
	if (owner.ad_only) throw new PostError("Ads can't be reposted.", 456);
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
