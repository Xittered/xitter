// Search: the query language of X's search box and advanced search form,
// turned into SQL over posts and users. schema.sql installs trigram indexes
// for substring and hashtag matches; short terms can still require a scan.
//
//   words, "exact phrase"            all must appear (case-insensitive)
//   -word, -"phrase"                 must not appear
//   OR between terms                 either side may match
//   from:name  to:name  @name        author, reply target, mentioned account
//   #tag                             hashtag (whole tag)
//   filter:media|images|videos|links|replies, -filter:...
//   since:2026-01-31  until:2026-02-01
//   min_faves:N  min_retweets:N  min_replies:N
//   filter:follows                   authors the viewer follows
//   lang:xx, near:, other operators  accepted and ignored

import { blockedFor, federatedHiddenFor, namesOtherInstance, outOfView, protectedFor } from "./blocks";
import { sql } from "./db";
import { settings } from "./settings";
import { isId } from "./ids";
import { localName } from "./users";
import { staffViewer } from "./staff-access";
import { circleSeen } from "./circles";

type Clause = ReturnType<typeof sql>;

// passed as a parameter: a backslash inside the SQL template would be lost
const HASHTAG_RE = "#(\\w+)";
const HANDLE = "\\w{1,50}(?:@(?:[a-z0-9-]+\\.)*[a-z0-9-]+(?::\\d{1,5})?)?";
const FROM_RE = new RegExp(`^from:@?(${HANDLE})$`, "i");
const TO_RE = new RegExp(`^to:@?(${HANDLE})$`, "i");
const AT_RE = new RegExp(`^@(${HANDLE})$`, "i");
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
// a hashtag as a whole word: "#go" does not match "#gold"
const tagPattern = (tag: string) => `(^|[^\\w#])#${tag.replace(/[^\p{L}\p{N}_]/gu, "")}($|[^\\w])`;

// Validate before casting: an impossible date otherwise aborts the whole search.
function validDate(value: string): boolean {
	const [year, month, day] = value.split("-").map(Number);
	if (year < 1 || month < 1 || month > 12 || day < 1) return false;
	const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
	return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function tokens(q: string): string[] {
	return [...q.matchAll(/-?"[^"]*"|\S+/g)].map((m) => m[0]);
}

// one term of the query as a condition on a post aliased p
function term(t: string, viewerId: string): Clause | undefined {
	const neg = t.startsWith("-") && t.length > 1;
	const body = neg ? t.slice(1) : t;
	let c: Clause | undefined;
	let m: RegExpExecArray | null;
	if ((m = /^"(.*)"$/.exec(body))) c = m[1] ? sql`p.text ilike ${like(m[1])}` : undefined;
	else if ((m = FROM_RE.exec(body)))
		c = sql`p.user_id = (select id from users where lower(screen_name) = ${localName(m[1]).toLowerCase()})`;
	else if ((m = TO_RE.exec(body)))
		c = sql`exists (select 1 from posts parent join users pu on pu.id = parent.user_id where parent.id = p.reply_to_id and lower(pu.screen_name) = ${localName(m[1]).toLowerCase()})`;
	else if ((m = AT_RE.exec(body)))
		c = sql`exists (select 1 from post_mentions pm join users mu on mu.id = pm.user_id where pm.post_id = p.id and lower(mu.screen_name) = ${localName(m[1]).toLowerCase()})`;
	else if ((m = /^quoted_tweet_id:(\d{1,19})$/.exec(body))) c = isId(m[1]) ? sql`p.quote_id = ${m[1]}::bigint` : sql`false`;
	else if ((m = /^#([\p{L}\p{N}_]+)$/u.exec(body))) c = sql`p.text ~* ${tagPattern(m[1])}`;
	else if ((m = /^filter:(\w+)$/i.exec(body))) {
		const f = m[1].toLowerCase();
		if (f === "media") c = sql`exists (select 1 from media fm where fm.post_id = p.id)`;
		else if (f === "images") c = sql`exists (select 1 from media fm where fm.post_id = p.id and fm.kind <> 'video')`;
		else if (f === "videos" || f === "native_video") c = sql`exists (select 1 from media fm where fm.post_id = p.id and fm.kind = 'video')`;
		else if (f === "replies") c = sql`p.reply_to_id is not null`;
		else if (f === "links") c = sql`p.text ~* 'https?://'`;
		else if (f === "quote") c = sql`p.quote_id is not null`;
		// "People you follow" in the search filters
		else if (f === "follows") c = sql`p.user_id in (select followee_id from follows where follower_id = ${viewerId}::bigint)`;
	} else if ((m = /^since:(\d{4}-\d{2}-\d{2})$/.exec(body))) c = validDate(m[1]) ? sql`p.created_at >= ${m[1]}::date` : sql`false`;
	else if ((m = /^until:(\d{4}-\d{2}-\d{2})$/.exec(body))) c = validDate(m[1]) ? sql`p.created_at < ${m[1]}::date` : sql`false`;
	else if ((m = /^min_(faves|retweets|replies):(\d{1,9})$/i.exec(body))) {
		const n = Number(m[2]);
		const kind = m[1].toLowerCase();
		c =
			kind === "faves"
				? sql`(select count(*) from likes x where x.post_id = p.id) >= ${n}`
				: kind === "retweets"
					? sql`(select count(*) from reposts x where x.post_id = p.id) >= ${n}`
					: sql`(select count(*) from posts x where x.reply_to_id = p.id) >= ${n}`;
	}
	// operators this server does not know (lang:, near:, within:, ...) are left out, not searched as text
	else if (/^(?!https?:)\w+:\S/i.test(body)) return undefined;
	else c = sql`p.text ilike ${like(body)}`;
	// A missing author or quote is a non-match, including under negation.
	return c && neg ? sql`not coalesce((${c}), false)` : c;
}

// the whole query as one condition: terms are ANDed, and "OR" binds the terms
// on either side of it, so "a b OR c d" means a and (b or c) and d, as on X
export function postCondition(query: string, viewerId: string): Clause | undefined {
	const parts: Clause[] = [];
	let orNext = false;
	for (const t of tokens(query.trim()).slice(0, 30)) {
		if (t === "OR") {
			orNext = parts.length > 0;
			continue;
		}
		const c = term(t, viewerId);
		if (!c) continue;
		if (orNext) parts.push(sql`(${parts.pop()!} or ${c})`);
		else parts.push(c);
		orNext = false;
	}
	return parts.length ? parts.reduce((acc, c) => sql`${acc} and ${c}`) : undefined;
}

const TOP_POOL = 5000;

// post ids for a query: Latest is newest first, Top by likes and reposts first
export async function searchPosts(
	query: string,
	opts: { viewerId: string; top: boolean; media?: boolean; limit: number; before?: string; offset?: number },
) {
	const cond = postCondition(query, opts.viewerId);
	if (!cond) return [];
	const media = opts.media ? sql`and exists (select 1 from media fm where fm.post_id = p.id)` : sql``;
	// "Visibility limited" posts (staff's Fosnr label) don't come up in search
	// suspended accounts' posts stay out of search for staff too
	// What the viewer can't open stays out here, not only when the posts are
	// loaded: the paging cursor is made of these ids.
	const hidden = sql`and not p.ad_only and p.user_id not in ${blockedFor(opts.viewerId)} and p.user_id not in ${outOfView(opts.viewerId)}
		and p.user_id not in (select id from users where status = 'suspended') and p.notice->>'type' is distinct from 'Fosnr'
		and p.user_id not in ${protectedFor(opts.viewerId)} and (not p.hidden or ${staffViewer(opts.viewerId)}) and ${circleSeen(opts.viewerId)}
		${namesOtherInstance(query) ? sql`` : sql`and p.user_id not in ${federatedHiddenFor(opts.viewerId)}`}`;
	if (opts.top) {
		const rows = await sql`select p.id from (select p.id from posts p where ${cond} ${media} ${hidden} order by p.id desc limit ${TOP_POOL}) p
			order by ((select count(*) from likes x where x.post_id = p.id) + 2 * (select count(*) from reposts x where x.post_id = p.id)
				+ (select count(*) from posts x where x.reply_to_id = p.id)) desc, p.id desc
			limit ${opts.limit} offset ${opts.offset ?? 0}`;
		return rows.map((r: any) => String(r.id));
	}
	const rows = await sql`select p.id from posts p where ${cond} ${media} ${hidden}
		${opts.before ? sql`and p.id < ${opts.before}::bigint` : sql``} order by p.id desc limit ${opts.limit}`;
	return rows.map((r: any) => String(r.id));
}

// accounts by handle, name or bio; handle matches first
// Suspended accounts stay out of search for everyone, staff included (they
// have the admin panel); limited ones and blocks follow the usual rules.
export async function searchUsers(viewerId: string, query: string, limit: number, offset = 0) {
	const words = tokens(query.replace(/^@/, "").trim())
		.filter((t) => !t.startsWith("-") && !t.includes(":"))
		.map((t) => localName(t.replace(/^"|"$/g, "").replace(/^@/, "")));
	if (!words.length) return [];
	const each = words.map((w) => sql`(u.screen_name ilike ${like(w)} or u.name ilike ${like(w)} or u.bio ilike ${like(w)})`);
	const cond = each.reduce((acc, c) => sql`${acc} and ${c}`);
	const first = words[0];
	const rows = await sql`select u.id from users u where ${cond}
			and u.status <> 'suspended' and u.id not in ${outOfView(viewerId)} and u.id not in ${blockedFor(viewerId)}
			${namesOtherInstance(query) ? sql`` : sql`and u.id not in ${federatedHiddenFor(viewerId)}`}
		order by (lower(u.screen_name) = lower(${first})) desc, (u.screen_name ilike ${`${first.replace(/[\\%_]/g, "")}%`}) desc,
			(select count(*) from follows f where f.followee_id = u.id) desc, u.id
		limit ${limit} offset ${offset}`;
	return rows.map((r: any) => String(r.id));
}

// hashtags used in recent posts that start with the typed text, for the typeahead
export async function hashtagsLike(prefix: string, limit: number): Promise<string[]> {
	const clean = prefix.replace(/^#/, "").replace(/[^\p{L}\p{N}_]/gu, "");
	if (!clean) return [];
	const rows = await sql`select tag, count(*) as n from (
			select lower((regexp_matches(p.text, ${HASHTAG_RE}, 'g'))[1]) as tag from posts p where p.text ilike ${like(`#${clean}`)} and not p.hidden and not p.ad_only and p.circle_owner_id is null and p.user_id not in ${outOfView("0")} and p.user_id not in (select id from users where protected)
			order by p.id desc limit 2000) t
		where tag like ${`${clean.toLowerCase()}%`} group by tag order by n desc, tag limit ${limit}`;
	return rows.map((r: any) => `#${r.tag}`);
}

// hashtags of the last days with how many posts used them, for Explore
// `country`: only posts by accounts based there. `followedBy`: posts by accounts
// that viewer follows count twice (personalized trends).
type TrendScope = { country?: string | null; followedBy?: string };
// A tag's score is how many people used it (people who share an address
// count once, see `who`); a person counts twice when one of their posts is by
// someone the viewer follows. The scan of the last days' posts is the
// expensive part and is the same for everyone in a country, so it runs once
// a minute per country and the viewer's follows are applied to its rows here.
// Run once per viewer, it was the database's main load on busy instances.
type Person = { posts: number; authors: string[] };
type TagPeople = { tag: string; people: Person[] };
const TREND_POOL = 500;
const trendRows = new Map<string, { at: number; rows: Promise<TagPeople[]> }>();

export async function trendingHashtags(days: number, limit: number, scope: TrendScope = {}): Promise<{ tag: string; posts: number }[]> {
	return rankTrends(await scoreTrends(await queryTrends(days, scope.country ?? null), scope.followedBy), limit);
}

export async function cachedTrends(days: number, limit: number, scope: TrendScope = {}): Promise<{ tag: string; posts: number }[]> {
	const { trend_min_people: people, trend_min_account_days: age } = settings().operations;
	const key = JSON.stringify([days, scope.country ?? null, people, age]);
	let cached = trendRows.get(key);
	if (!cached || Date.now() - cached.at > 60_000) {
		if (trendRows.size >= 500) trendRows.clear();
		const loading = queryTrends(days, scope.country ?? null).catch((e) => {
			trendRows.delete(key);
			throw e;
		});
		cached = { at: Date.now(), rows: loading };
		trendRows.set(key, cached);
	}
	return rankTrends(await scoreTrends(await cached.rows, scope.followedBy), limit);
}

async function queryTrends(days: number, country: string | null): Promise<TagPeople[]> {
	const rows = await sql`with t as (
			select p.id, p.user_id, lower((regexp_matches(p.text, ${HASHTAG_RE}, 'g'))[1]) as tag,
				coalesce((select e.ip from login_events e where e.user_id = p.user_id and e.ip is not null order by e.created_at desc limit 1), p.user_id::text) as who
			from posts p join users u on u.id = p.user_id
			where p.created_at > now() - make_interval(days => ${days}) and not p.hidden and p.circle_owner_id is null and p.user_id not in ${outOfView("0")}
				and u.status = 'active' and not u.protected and u.created_at <= now() - make_interval(days => ${settings().operations.trend_min_account_days})
				${country ? sql`and u.country = ${country}` : sql``}
		), people as (
			select tag, who, count(distinct id)::int as posts, array_agg(distinct user_id::text) as authors from t group by tag, who
		), tags as (
			select tag from people group by tag having count(*) >= ${settings().operations.trend_min_people}
			order by count(*) desc, sum(posts) desc, tag limit ${TREND_POOL}
		)
		select p.tag, p.posts, p.authors from people p join tags using (tag)`;
	const byTag = new Map<string, Person[]>();
	for (const r of rows as any[]) {
		const list = byTag.get(r.tag) ?? [];
		list.push({ posts: r.posts, authors: r.authors });
		byTag.set(r.tag, list);
	}
	return [...byTag].map(([tag, people]) => ({ tag, people }));
}

async function scoreTrends(tags: TagPeople[], viewerId?: string) {
	const follows = viewerId ? new Set((await sql`select followee_id::text as id from follows where follower_id = ${viewerId}::bigint`).map((r: any) => r.id as string)) : undefined;
	return tags
		.map(({ tag, people }) => ({
			tag,
			n: people.reduce((s, p) => s + p.posts, 0),
			score: people.reduce((s, p) => s + (follows && p.authors.some((a) => follows.has(a)) ? 2 : 1), 0),
		}))
		.sort((a, b) => b.score - a.score || b.n - a.n || (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

function rankTrends(rows: any[], limit: number) {
	const { hidden_trends: hidden, promoted_trends: promoted } = settings().operations;
	const found = rows.filter((r: any) => !hidden.includes(r.tag)).map((r: any) => ({ tag: `#${r.tag}`, posts: r.n }));
	const first = promoted.filter((tag) => !hidden.includes(tag)).map((tag) => found.find((t) => t.tag === `#${tag}`) ?? { tag: `#${tag}`, posts: 0 });
	return [...first, ...found.filter((t) => !promoted.includes(t.tag.slice(1)))].slice(0, limit);
}
