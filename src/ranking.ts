// The "For you" feed: posts and reposts ranked by engagement, closeness and age,
// after the shape of X's published recommendation pipeline (gather candidates,
// score, filter and mix) with real counts in place of predicted ones.
//
// Weights relative to a like, from the 2023 release's heavy ranker: a repost is
// worth 2, a reply 27, and a reply the author answered 150. A post from someone
// the viewer follows, or that people they follow liked or reposted, gets a
// boost, as does an author the viewer often likes or replies to, or a post on a
// topic they follow. Engagement counts on a log scale and the total halves
// every HALF_LIFE hours, so new posts rise past old popular ones within a day
// or two.

import { sql } from "./db";
import { idTime, newId } from "./ids";
import { type FeedItem, communityVisible, homeHidden, itemsFromRows } from "./posts";
import { followedTopicMatch, unwantedTopicMatch } from "./topics";

// how many candidates are ranked; the feed ends after them
const CANDIDATES = 600;
// at most this many entries in a row by one author
const MAX_RUN = 2;
// hours for a post's score to halve
const HALF_LIFE = 12;

export type RankedPage = { items: FeedItem[]; next?: number };

type Row = { item_id: string; post_id: string; reposter_id: string | null; created_at: Date; author_id: string; score: number };
type Ranked = Row[];

// The pages of one scroll share a ranking (same viewer and asOf), so it is kept
// a while instead of ranking every candidate again for each page.
const RANKING_TTL = 10 * 60_000;
const MAX_RANKINGS = 200;
const MAX_PER_VIEWER = 3;
const rankings = new Map<string, { rows: Promise<Ranked>; until: number }>();

function ranking(viewerId: string, asOf: string): Promise<Ranked> {
	const key = `${viewerId}:${asOf}`;
	const now = Date.now();
	const hit = rankings.get(key);
	if (hit && hit.until > now) return hit.rows;
	for (const [k, r] of rankings) if (r.until <= now) rankings.delete(k);
	const own = [...rankings.keys()].filter((k) => k.startsWith(`${viewerId}:`));
	for (const k of own.slice(0, Math.max(0, own.length - (MAX_PER_VIEWER - 1)))) rankings.delete(k);
	while (rankings.size >= MAX_RANKINGS) rankings.delete(rankings.keys().next().value!);
	const rows = rank(viewerId, asOf);
	rankings.set(key, { rows, until: now + RANKING_TTL });
	rows.catch(() => rankings.delete(key));
	return rows;
}

const SEEN_SINK = 0.85;
const SEEN_RECOVERY_MS = 3 * 3600_000;
const SEEN_BELOW_MS = 2 * 3600_000;
const SEEN_PER_VIEWER = CANDIDATES;
const SEEN_VIEWERS = 1000;
const JITTER = 0.25;
const seen = new Map<string, Map<string, number>>();
const views = new Map<string, { rows: Ranked; until: number }>();

function remember(viewerId: string, rows: Row[]) {
	const now = Date.now();
	let mine = seen.get(viewerId);
	if (mine) seen.delete(viewerId);
	else mine = new Map();
	seen.set(viewerId, mine);
	for (const r of rows) {
		mine.delete(r.post_id);
		mine.set(r.post_id, now);
	}
	while (mine.size > SEEN_PER_VIEWER) mine.delete(mine.keys().next().value!);
	while (seen.size > SEEN_VIEWERS) seen.delete(seen.keys().next().value!);
}

function chance(seed: number, postId: string) {
	let h = seed >>> 0;
	for (let i = 0; i < postId.length; i++) h = Math.imul(h ^ postId.charCodeAt(i), 2654435761) >>> 0;
	h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
	return (h ^ (h >>> 13)) / 4294967296;
}

function reorder(viewerId: string, base: Ranked, seed: number): Ranked {
	const now = Date.now();
	const mine = seen.get(viewerId);
	const weighed = base.map((r) => {
		const shownAt = mine?.get(r.post_id);
		const sink = shownAt === undefined ? 1 : 1 - SEEN_SINK * Math.exp(-(now - shownAt) / SEEN_RECOVERY_MS);
		const below = shownAt !== undefined && now - shownAt < SEEN_BELOW_MS ? shownAt : 0;
		return { r, below, score: r.score * sink * Math.exp(JITTER * (2 * chance(seed, r.post_id) - 1)) };
	});
	weighed.sort((a, b) => a.below - b.below || b.score - a.score ||(BigInt(b.r.item_id) > BigInt(a.r.item_id) ? 1 : -1));
	return spreadAuthors(weighed.map((w) => w.r));
}

async function view(viewerId: string, asOf: string, seed: number): Promise<Ranked> {
	const base = await ranking(viewerId, asOf);
	if (!seed) return spreadAuthors(base);
	const key = `${viewerId}:${asOf}:${seed}`;
	const now = Date.now();
	const hit = views.get(key);
	if (hit && hit.until > now) return hit.rows;
	for (const [k, v] of views) if (v.until <= now) views.delete(k);
	while (views.size >= MAX_RANKINGS) views.delete(views.keys().next().value!);
	const rows = reorder(viewerId, base, seed);
	views.set(key, { rows, until: now + RANKING_TTL });
	return rows;
}

export const newView = () => 1 + Math.floor(Math.random() * 2_000_000_000);

// Opening "For you" (a reload, the app coming back, several tabs at once) made
// a new ranking each time, the costliest query here by far. For a minute the
// last one is handed out again while nothing new has been posted or reposted
// and the viewer hasn't changed anything (forgetRanking); its ages are then
// measured from a few seconds back, which moves no post more than a hair.
const REUSE_MS = 60_000;
const latest = new Map<string, { asOf: string; at: number }>();

export async function freshAsOf(viewerId: string): Promise<string> {
	const now = Date.now();
	const last = latest.get(viewerId);
	if (last && now - last.at < REUSE_MS && rankings.has(`${viewerId}:${last.asOf}`)) {
		const [{ newer }] = await sql`select exists (select 1 from posts where id > ${last.asOf}::bigint and reply_to_id is null)
			or exists (select 1 from reposts where id > ${last.asOf}::bigint) as newer`;
		if (!newer) return last.asOf;
	}
	if (latest.size >= MAX_RANKINGS) for (const [k, l] of latest) if (now - l.at >= REUSE_MS) latest.delete(k);
	const asOf = newId();
	latest.set(viewerId, { asOf, at: now });
	return asOf;
}

export const forgetRanking = (viewerId: string) => void latest.delete(viewerId);
export const forgetAllRankings = () => latest.clear();

// One page of the ranked feed. `asOf` (an item id) pins the ranking for the pages of one
// scroll: posts newer than it wait for the next refresh, and ages are measured
// from it, so the order does not shift while the viewer pages down.
export async function rankedFeed(viewerId: string, opts: { asOf: string; offset: number; limit: number; view?: number }): Promise<RankedPage> {
	const ranked = await view(viewerId, opts.asOf, opts.view ?? 0);
	const pageRows = ranked.slice(opts.offset, opts.offset + opts.limit);
	remember(viewerId, pageRows);
	const items = await itemsFromRows(viewerId, pageRows);
	const nextOffset = opts.offset + pageRows.length;
	return { items, ...(nextOffset < ranked.length ? { next: nextOffset } : {}) };
}

async function rank(viewerId: string, asOf: string): Promise<Ranked> {
	// an item id: only entries up to it count, and ages are measured from its time
	const at = idTime(asOf);
	const rows = await sql`
		with candidates as (
			select f.*, (select x.user_id from posts x where x.id = f.post_id) as original_author
			from feed_items f
			where not f.is_reply and f.item_id <= ${asOf}::bigint and ${homeHidden(viewerId)} and ${communityVisible(viewerId)}
				-- "Visibility limited" (staff's Fosnr label): never recommended
				and (select x.notice->>'type' from posts x where x.id = f.post_id) is distinct from 'Fosnr'
				and not ${unwantedTopicMatch(viewerId, sql`f.post_id`, sql`(select x.user_id from posts x where x.id = f.post_id)`)}
			order by f.item_id desc limit ${CANDIDATES * 3}
		),
		-- authors the viewer liked or replied to in the last month, once for all
		-- candidates (inlined, the planner ran it again for each of them)
		affinity as materialized (
			select author, sum(n) as n from (
				select lp.user_id as author, count(*) as n from likes l join posts lp on lp.id = l.post_id
					where l.user_id = ${viewerId}::bigint and l.created_at > ${at}::timestamptz - interval '30 days' group by 1
				union all
				select parent.user_id, count(*) from posts rp join posts parent on parent.id = rp.reply_to_id
					where rp.user_id = ${viewerId}::bigint and rp.created_at > ${at}::timestamptz - interval '30 days' group by 1
			) x group by author
		),
		-- what depends only on the post, once per post: a viral post reposted
		-- hundreds of times was counted again for every one of its reposts
		per_post as materialized (
			select d.post_id,
				-- on a log scale: raw counts let one answered reply outweigh days of age
				ln(2
				 + (select count(*) from likes l where l.post_id = d.post_id)
				 + 2 * (select count(*) from reposts r where r.post_id = d.post_id)
				 + 27 * (select count(*) from posts rp where rp.reply_to_id = d.post_id)
				 + 150 * (select count(*) from posts rp where rp.reply_to_id = d.post_id
					and exists (select 1 from posts ar where ar.reply_to_id = rp.id and ar.user_id = d.original_author))
				) as engagement,
				-- what people the viewer follows liked or reposted
				(case when exists (select 1 from likes l join follows fw on fw.followee_id = l.user_id
						where l.post_id = d.post_id and fw.follower_id = ${viewerId}::bigint)
					or exists (select 1 from reposts r join follows fw on fw.followee_id = r.user_id
						where r.post_id = d.post_id and fw.follower_id = ${viewerId}::bigint) then 1.5 else 1.0 end) as social,
				(case when ${followedTopicMatch(viewerId, sql`d.post_id`)} then 1.5 else 1.0 end) as topic,
				-- authors the viewer engaged with in the last month, up to double
				(1 + least(1.0, 0.1 * coalesce((select af.n from affinity af where af.author = d.original_author), 0))) as affinity,
				-- the viewer's own posts are known to them already
				(case when d.original_author = ${viewerId}::bigint then 0.5 else 1.0 end) as own
			from (select distinct post_id, original_author from candidates) d
		),
		scored as (
			select c.*,
				p.engagement
				-- people the viewer follows: their posts and reposts
				* (case when c.author_id in (select followee_id from follows where follower_id = ${viewerId}::bigint) then 2.0 else 1.0 end)
				* p.social * p.topic * p.affinity * p.own
				-- halves every HALF_LIFE hours: a day-old post needs about 50 times the
				-- engagement of a new one, so a quiet instance's feed still moves
				* power(0.5, greatest(extract(epoch from (${at}::timestamptz - c.created_at)) / 3600, 0) / ${HALF_LIFE})
				as score
			from candidates c join per_post p on p.post_id = c.post_id
		),
		-- one entry per post: the best of the post itself and its reposts
		best as (
			select distinct on (post_id) * from scored order by post_id, score desc, item_id desc
		)
		select * from best order by score desc, item_id desc limit ${CANDIDATES}`;

	// only what a page needs is kept
	return (rows as any[]).map((r) => ({ item_id: String(r.item_id), post_id: String(r.post_id), reposter_id: r.reposter_id === null ? null : String(r.reposter_id), created_at: r.created_at, author_id: String(r.author_id), score: Number(r.score) }));
}

// Keep one author from filling the screen: an entry that would make a run
// longer than MAX_RUN waits until someone else has been shown.
function spreadAuthors<T extends { author_id: unknown }>(rows: T[]): T[] {
	const out: T[] = [];
	const waiting: T[] = [];
	const runOf = (author: string) => {
		let n = 0;
		for (let i = out.length - 1; i >= 0 && String(out[i].author_id) === author; i--) n++;
		return n;
	};
	for (const row of rows) {
		// a waiting entry goes first once it fits again
		for (let i = 0; i < waiting.length; i++) {
			if (runOf(String(waiting[i].author_id)) < MAX_RUN) out.push(...waiting.splice(i--, 1));
		}
		if (runOf(String(row.author_id)) < MAX_RUN) out.push(row);
		else waiting.push(row);
	}
	// nobody else left to put in between
	return out.concat(waiting);
}
