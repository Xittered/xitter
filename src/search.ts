// Search: the query language of X's search box and advanced search form,
// turned into SQL over posts and users. No index beyond Postgres's own; fine
// for an instance of friends, the place to add one when that stops being true.
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

import { blockedFor, outOfView } from "./blocks";
import { sql } from "./db";
import { settings } from "./settings";

type Clause = ReturnType<typeof sql>;

// passed as a parameter: a backslash inside the SQL template would be lost
const HASHTAG_RE = "#(\\w+)";
const like = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
// a hashtag as a whole word: "#go" does not match "#gold"
const tagPattern = (tag: string) => `(^|[^\\w#])#${tag.replace(/[^\w]/g, "")}($|[^\\w])`;

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
	else if ((m = /^from:@?(\w{1,15})$/i.exec(body))) c = sql`p.user_id = (select id from users where lower(screen_name) = lower(${m[1]}))`;
	else if ((m = /^to:@?(\w{1,15})$/i.exec(body)))
		c = sql`exists (select 1 from posts parent join users pu on pu.id = parent.user_id where parent.id = p.reply_to_id and lower(pu.screen_name) = lower(${m[1]}))`;
	else if ((m = /^@(\w{1,15})$/.exec(body)))
		c = sql`exists (select 1 from post_mentions pm join users mu on mu.id = pm.user_id where pm.post_id = p.id and lower(mu.screen_name) = lower(${m[1]}))`;
	else if ((m = /^quoted_tweet_id:(\d{1,19})$/.exec(body))) c = sql`p.quote_id = ${m[1]}::bigint`;
	else if ((m = /^#(\w+)$/.exec(body))) c = sql`p.text ~* ${tagPattern(m[1])}`;
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
	} else if ((m = /^since:(\d{4}-\d{2}-\d{2})$/.exec(body))) c = sql`p.created_at >= ${m[1]}::date`;
	else if ((m = /^until:(\d{4}-\d{2}-\d{2})$/.exec(body))) c = sql`p.created_at < ${m[1]}::date`;
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
	return c && neg ? sql`not (${c})` : c;
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
	const hidden = sql`and p.user_id not in ${blockedFor(opts.viewerId)} and p.user_id not in ${outOfView(opts.viewerId)}
		and p.user_id not in (select id from users where status = 'suspended') and p.notice->>'type' is distinct from 'Fosnr'`;
	if (opts.top) {
		const rows = await sql`select p.id from posts p where ${cond} ${media} ${hidden}
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
		.map((t) => t.replace(/^"|"$/g, "").replace(/^@/, ""));
	if (!words.length) return [];
	const each = words.map((w) => sql`(u.screen_name ilike ${like(w)} or u.name ilike ${like(w)} or u.bio ilike ${like(w)})`);
	const cond = each.reduce((acc, c) => sql`${acc} and ${c}`);
	const first = words[0];
	const rows = await sql`select u.id from users u where ${cond}
			and u.status <> 'suspended' and u.id not in ${outOfView(viewerId)} and u.id not in ${blockedFor(viewerId)}
		order by (lower(u.screen_name) = lower(${first})) desc, (u.screen_name ilike ${`${first.replace(/[\\%_]/g, "")}%`}) desc,
			(select count(*) from follows f where f.followee_id = u.id) desc, u.id
		limit ${limit} offset ${offset}`;
	return rows.map((r: any) => String(r.id));
}

// hashtags used in recent posts that start with the typed text, for the typeahead
export async function hashtagsLike(prefix: string, limit: number): Promise<string[]> {
	const clean = prefix.replace(/^#/, "").replace(/[^\w]/g, "");
	if (!clean) return [];
	const rows = await sql`select tag, count(*) as n from (
			select lower((regexp_matches(p.text, ${HASHTAG_RE}, 'g'))[1]) as tag from posts p where p.text ilike ${like(`#${clean}`)} and not p.hidden and p.user_id not in ${outOfView("0")}
			order by p.id desc limit 2000) t
		where tag like ${`${clean.toLowerCase()}%`} group by tag order by n desc, tag limit ${limit}`;
	return rows.map((r: any) => `#${r.tag}`);
}

const TREND_MIN_PEOPLE = 3;
const TREND_MIN_ACCOUNT_AGE = "3 days";

// hashtags of the last days with how many posts used them, for Explore
// `country`: only posts by accounts based there. `followedBy`: posts by accounts
// that viewer follows count twice (personalized trends).
export async function trendingHashtags(days: number, limit: number, scope: { country?: string | null; followedBy?: string } = {}): Promise<{ tag: string; posts: number }[]> {
	const rows = await sql`select tag, sum(posts)::int as n, sum(w)::int as score from (
			select tag, who, count(distinct id) as posts, max(w) as w from (
				select p.id, lower((regexp_matches(p.text, ${HASHTAG_RE}, 'g'))[1]) as tag,
					coalesce((select e.ip from login_events e where e.user_id = p.user_id and e.ip is not null order by e.created_at desc limit 1), p.user_id::text) as who,
					${scope.followedBy ? sql`case when p.user_id in (select followee_id from follows where follower_id = ${scope.followedBy}::bigint) then 2 else 1 end` : sql`1`} as w
				from posts p join users u on u.id = p.user_id
				where p.created_at > now() - make_interval(days => ${days}) and not p.hidden and p.user_id not in ${outOfView("0")}
					and u.status = 'active' and u.created_at < now() - ${TREND_MIN_ACCOUNT_AGE}::interval
					${scope.country ? sql`and u.country = ${scope.country}` : sql``}) t
			group by tag, who) people
		group by tag having count(*) >= ${TREND_MIN_PEOPLE} order by score desc, n desc, tag limit ${limit}`;
	// an admin can hide hashtags and put others first (Settings, Trends)
	const { hidden_trends: hidden, promoted_trends: promoted } = settings().operations;
	const found = rows.filter((r: any) => !hidden.includes(r.tag)).map((r: any) => ({ tag: `#${r.tag}`, posts: r.n }));
	const first = promoted.filter((tag) => !hidden.includes(tag)).map((tag) => found.find((t) => t.tag === `#${tag}`) ?? { tag: `#${tag}`, posts: 0 });
	return [...first, ...found.filter((t) => !promoted.includes(t.tag.slice(1)))].slice(0, limit);
}
