// Account analytics (/i/account_analytics): the Overview and Content tabs and
// a post's own page, counted from what the instance keeps. An "engagement" is
// something another account did to one of the viewer's posts or to the
// account itself; the viewer's own actions only count as posts made. What
// isn't recorded here (link and hashtag clicks, shares, detail expands)
// stays 0. The other tabs show their own empty states.

import type { Viewer } from "./auth";
import { sql } from "./db";
import { mediaForPosts, mediaUrl, posterUrl } from "./media";
import { seenBy } from "./posts";
import { userResult } from "./model";
import { userById } from "./users";

type Vars = Record<string, any>;

const gid = (kind: string, id: string) => Buffer.from(`${kind}:${id}`).toString("base64");

// ms since the epoch, from the client's number or ISO string
const ms = (x: unknown, fallback: number) => {
	const n = typeof x === "number" ? x : typeof x === "string" ? (/^\d+$/.test(x) ? Number(x) : Date.parse(x)) : NaN;
	return Number.isFinite(n) ? n : fallback;
};
const DAY = 86_400_000;

// the client's range, at most a bit over a year (the longest the page offers)
// and not past tomorrow: from 0, or from year -270000, one request read every
// row the account ever had or looped over every day since
const MAX_RANGE = 400 * DAY;
const span = (from: number, to: number): [number, number] => {
	const end = Math.max(0, Math.min(to, Date.now() + DAY));
	return [Math.min(end, Math.max(from, end - MAX_RANGE)), end];
};

// the start of the step (ms) an event falls in, counted in the database
const bucketOf = (step: number) => sql`floor(extract(epoch from t.at) * 1000 / ${step})::bigint * ${step}`;

// Every engagement on the account's posts and profile, and its own new posts,
// counted per (engagement_type, step, verified actor). The types are X's:
// Displayed is an impression, Fav a like, ProfilePic a profile visit.
const events = (userId: string, from: number, to: number, step: number, byVerified: boolean) => sql`
	select t.type, ${step ? bucketOf(step) : sql`${from}::bigint`} as bucket,
		${byVerified ? sql`coalesce(a.verified_type is not null, false)` : sql`false`} as verified, count(*)::int as count from (
		select 'Displayed' as type, v.created_at as at, v.user_id as actor from post_views v join posts p on p.id = v.post_id
			where p.user_id = ${userId}::bigint and v.user_id <> p.user_id
		union all select 'Fav', l.created_at, l.user_id from likes l join posts p on p.id = l.post_id
			where p.user_id = ${userId}::bigint and l.user_id <> p.user_id
		union all select 'Retweet', r.created_at, r.user_id from reposts r join posts p on p.id = r.post_id
			where p.user_id = ${userId}::bigint and r.user_id <> p.user_id
		union all select 'Bookmark', b.created_at, b.user_id from bookmarks b join posts p on p.id = b.post_id
			where p.user_id = ${userId}::bigint and b.user_id <> p.user_id
		union all select 'Reply', r.created_at, r.user_id from posts r join posts p on p.id = r.reply_to_id
			where p.user_id = ${userId}::bigint and r.user_id <> p.user_id
		union all select 'QuoteTweet', q.created_at, q.user_id from posts q join posts p on p.id = q.quote_id
			where p.user_id = ${userId}::bigint and q.user_id <> p.user_id
		union all select 'Follow', f.created_at, f.follower_id from follows f where f.followee_id = ${userId}::bigint
		union all select 'Unfollow', u.created_at, u.follower_id from unfollows u where u.followee_id = ${userId}::bigint
		union all select 'ProfilePic', v.created_at, v.visitor_id from profile_visits v where v.profile_id = ${userId}::bigint
		union all select case when p.reply_to_id is not null then 'ReplyCreate' when p.quote_id is not null then 'QuoteCreate' else 'TweetCreate' end,
			p.created_at, p.user_id from posts p where p.user_id = ${userId}::bigint
	) t left join users a on a.id = t.actor
	where t.at >= ${new Date(from)} and t.at < ${new Date(to)}
	group by 1, 2, 3`;

// X's UecMetricsTimeSeriesValue rows: counts per type (and per verified
// actor when asked), per day, hour or for the whole range
async function series(userId: string, from: number, to: number, granularity: "day" | "hour" | "total", byVerified: boolean) {
	const step = granularity === "day" ? DAY : granularity === "hour" ? 3_600_000 : 0;
	const rows = await events(userId, from, to, step, byVerified);
	return (rows as any[])
		.map((r) => ({ count: r.count, timestamp: String(r.bucket), engagement_type: r.type, ...(byVerified ? { is_engaging_user_verified: r.verified } : {}) }))
		.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

// the older OrganicMetricsTimeSeries layout: one entry per day with named values
async function followSeries(userId: string, from: number, to: number) {
	const rows = await sql`select ${bucketOf(DAY)} as day,
			count(*) filter (where t.type = 'Follow')::int as follows, count(*) filter (where t.type = 'Unfollow')::int as unfollows from (
			select 'Follow' as type, f.created_at as at from follows f where f.followee_id = ${userId}::bigint
			union all select 'Unfollow', u.created_at from unfollows u where u.followee_id = ${userId}::bigint
		) t where t.at >= ${new Date(from)} and t.at < ${new Date(to)}
		group by 1 order by 1`;
	return (rows as any[]).map((r) => ({
		metric_values: [{ metric_type: "Follows", metric_value: r.follows }, { metric_type: "Unfollows", metric_value: r.unfollows }],
		timestamp: { iso8601_time: new Date(Number(r.day)).toISOString() },
	}));
}

async function followers(userId: string) {
	const [f] = await sql`select count(*)::int as followers,
		count(*) filter (where u.verified_type is not null)::int as verified,
		count(*) filter (where u.last_seen_at > now() - interval '28 days')::int as active,
		count(*) filter (where u.last_seen_at > now() - interval '28 days' and u.verified_type is not null)::int as active_verified,
		count(*) filter (where u.last_seen_at > now() - interval '1 day')::int as today
		from follows f join users u on u.id = f.follower_id where f.followee_id = ${userId}::bigint`;
	return {
		verified_follower_count: f.verified,
		author_follower_metrics: { active_followers: f.active, active_verified_followers: f.active_verified },
		relationship_counts: { followers: f.followers },
		realtime_active_followers: { active_count: f.today, is_approximate: false },
	};
}

const viewerUser = (v: Viewer, fields: object) => ({
	data: { viewer_v2: { id: gid("Viewer", v.id), user_results: { id: gid("UserResults", v.id), result: { __typename: "User", id: gid("User", v.id), rest_id: v.id, ...fields } } } },
});

// totals for a post, by the metric names the content table and post page ask for
async function postTotals(postIds: string[]) {
	const rows = await sql`select p.id::text,
		(select count(*)::int from post_views v where v.post_id = p.id and v.user_id <> p.user_id) as "Impressions",
		(select count(*)::int from likes l where l.post_id = p.id and l.user_id <> p.user_id) as "Likes",
		(select count(*)::int from posts r where r.reply_to_id = p.id and r.user_id <> p.user_id) as "Replies",
		(select count(*)::int from reposts r where r.post_id = p.id and r.user_id <> p.user_id)
			+ (select count(*)::int from posts q where q.quote_id = p.id and q.user_id <> p.user_id) as "Retweets",
		(select count(*)::int from bookmarks b where b.post_id = p.id and b.user_id <> p.user_id) as "Bookmark"
		from posts p where p.id = any(${sql.array(postIds, "INT8")})`;
	const out = new Map<string, Record<string, number>>();
	for (const r of rows as any[]) {
		const { id, ...m } = r;
		out.set(id, { ...m, Engagements: m.Likes + m.Replies + m.Retweets + m.Bookmark });
	}
	return out;
}

const metricList = (totals: Record<string, number> | undefined, requested: unknown) => {
	const names = Array.isArray(requested) && requested.length ? requested.map(String) : ["Impressions", "Engagements", "Likes", "Replies", "Retweets", "Bookmark", "Share", "Follows", "ProfileVisits", "DetailExpands", "UrlClicks"];
	return names.map((metric_type) => ({ metric_type, metric_value: totals?.[metric_type] ?? 0 }));
};

const details = (p: any) => ({
	// a number: the client hands it straight to new Date()
	created_at_ms: p.created_at.getTime(),
	full_text: p.text ?? "",
	display_text_range: [0, [...(p.text ?? "")].length],
	hashtag_entities: [],
	timestamp_entities: [],
	cashtag_entities: [],
	smarttags: [],
});

async function mediaEntities(postIds: string[]) {
	const media = await mediaForPosts(postIds);
	const out = new Map<string, unknown[]>();
	for (const [postId, rows] of media) {
		out.set(postId, rows.map((m) => {
			const video = m.kind === "video";
			return {
				id_str: m.id,
				type: video ? "video" : m.mime === "image/gif" ? "animated_gif" : "photo",
				media_url_https: video ? posterUrl(m.id) : mediaUrl(m.id, m.mime),
				original_info: { width: m.width, height: m.height },
				ext_alt_text: m.alt_text ?? null,
				...(video ? { video_info: { duration_millis: m.duration_ms ?? 0, aspect_ratio: [m.width, m.height], variants: [{ url: mediaUrl(m.id, m.mime), content_type: "video/mp4", bitrate: 0 }] } } : {}),
			};
		}));
	}
	return out;
}

// one of the viewer's own posts, or nothing: analytics are only for the author
async function ownPost(v: Viewer, id: unknown) {
	if (typeof id !== "string" || !/^\d{1,19}$/.test(id)) return undefined;
	const [p] = await sql`select id::text, user_id::text, text, created_at, reply_to_id::text from posts where id = ${id}::bigint and user_id = ${v.id}::bigint`;
	return p;
}

const tweetWrap = (id: string, result: object | undefined) => ({
	data: { tweet_result_by_rest_id: { id: gid("TweetResults", id), rest_id: id, ...(result ? { result: { __typename: "Tweet", id: gid("Tweet", id), rest_id: id, ...result } } : {}) } },
});

async function postCard(v: Viewer, p: any) {
	const [totals, media, author] = await Promise.all([postTotals([p.id]), mediaEntities([p.id]), userById(v.id, p.user_id)]);
	const t = totals.get(p.id);
	// the counts under the post are its public ones, the author's own included
	const [c] = await sql`select (select count(*)::int from bookmarks where post_id = ${p.id}::bigint) as bookmark_count,
		(select count(*)::int from likes where post_id = ${p.id}::bigint) as favorite_count,
		(select count(*)::int from posts where reply_to_id = ${p.id}::bigint) as reply_count,
		(select count(*)::int from reposts where post_id = ${p.id}::bigint) as retweet_count`;
	return {
		details: details(p),
		url_entities: [],
		mention_entities: [],
		counts: c,
		views: { count: String(t?.Impressions ?? 0) },
		media_entities2: media.get(p.id) ?? [],
		core: { user_results: { id: gid("UserResults", p.user_id), result: author ? userResult(author) : null } },
	};
}

export const analyticsHandlers = {
	accountOverviewDailyQuery: async (v: Viewer, vars: Vars) => {
		const now = Date.now();
		const [from, to] = span(ms(vars.current_from ?? vars.current_from_iso, now - 7 * DAY), ms(vars.current_to ?? vars.current_to_iso, now));
		const [prevFrom, prevTo] = span(ms(vars.prev_from ?? vars.prev_from_iso, from - (to - from)), ms(vars.prev_to ?? vars.prev_to_iso, from));
		const [backFrom, backTo] = span(ms(vars.backfill_from, now - 2 * DAY), ms(vars.backfill_to, now));
		const [current, previous, backfill, follows, previousFollows, f] = await Promise.all([
			series(v.id, from, to, "day", true),
			series(v.id, prevFrom, prevTo, "total", true),
			series(v.id, backFrom, backTo, "hour", false),
			followSeries(v.id, from, to),
			followSeries(v.id, prevFrom, prevTo),
			followers(v.id),
		]);
		return viewerUser(v, {
			...f,
			current_time_series: current,
			previous_totals: previous,
			hourly_backfill: backfill,
			legacy_current_follow_metrics: follows,
			legacy_previous_follow_metrics: previousFollows,
		});
	},
	accountOverviewHourlyQuery: async (v: Viewer, vars: Vars) => {
		const now = Date.now();
		const [from, to] = span(ms(vars.current_from, now - DAY), ms(vars.current_to, now));
		const [prevFrom, prevTo] = span(ms(vars.prev_from, from - (to - from)), ms(vars.prev_to, from));
		const [current, previous, f] = await Promise.all([series(v.id, from, to, "hour", false), series(v.id, prevFrom, prevTo, "total", false), followers(v.id)]);
		return viewerUser(v, { ...f, current_time_series: current, previous_totals: previous });
	},
	activeFollowersTileQuery: async (v: Viewer) => viewerUser(v, { realtime_active_followers: (await followers(v.id)).realtime_active_followers }),
	useFetchAnalyticsQuery: async (v: Viewer, vars: Vars) => {
		// the own-profile widget: last 7 days, by the metric names it asks for
		const rows = await series(v.id, Date.now() - 7 * DAY, Date.now(), "total", false);
		const by = (t: string) => rows.find((r) => r.engagement_type === t)?.count ?? 0;
		const totals: Record<string, number> = { Impressions: by("Displayed"), Likes: by("Fav"), Replies: by("Reply"), Retweets: by("Retweet") + by("QuoteTweet"), Bookmark: by("Bookmark"), Follows: by("Follow"), ProfileVisits: by("ProfilePic") };
		totals.Engagements = totals.Likes + totals.Replies + totals.Retweets + totals.Bookmark;
		return { data: { result: { result: { __typename: "User", id: gid("User", v.id), free_metrics_rollup: metricList(totals, vars.requested_metrics) } } } };
	},

	contentPageQuery: async (v: Viewer, vars: Vars) => {
		const now = Date.now();
		const [from, to] = span(ms(vars.from_time, now - 7 * DAY), ms(vars.to_time, now));
		const limit = Math.min(Math.max(Number(vars.max_results) || 100, 1), 1000);
		const posts = await sql`select id::text, user_id::text, text, created_at, reply_to_id::text, community_id::text from posts
			where user_id = ${v.id}::bigint and created_at >= ${new Date(from)} and created_at <= ${new Date(to)} order by id desc limit ${limit}`;
		const ids = (posts as any[]).map((p) => p.id);
		const [totals, media] = await Promise.all([postTotals(ids), mediaEntities(ids)]);
		const me = await userById(v.id, v.id);
		const tweets = (posts as any[]).map((p) => ({
			id: gid("TweetResults", p.id),
			rest_id: p.id,
			result: {
				__typename: "Tweet",
				id: gid("Tweet", p.id),
				rest_id: p.id,
				details: details(p),
				organic_metrics_total: metricList(totals.get(p.id), vars.requested_metrics),
				...(p.reply_to_id ? { reply_to_results: { id: gid("TweetResults", p.reply_to_id), rest_id: p.reply_to_id } } : {}),
				...(p.community_id ? { community_results: { id: gid("CommunityResults", p.community_id), rest_id: p.community_id } } : {}),
				url_entities: [],
				mention_entities: [],
				media_entities2: media.get(p.id) ?? [],
			},
		}));
		return viewerUser(v, me ? { ...userResult(me), tweets_results: tweets } : { tweets_results: tweets });
	},

	postDetailsProviderQuery: async (v: Viewer, vars: Vars) => {
		const p = await ownPost(v, vars.rest_id);
		if (!p) return tweetWrap(String(vars.rest_id ?? ""), undefined);
		const card = await postCard(v, p);
		const parent = p.reply_to_id ? (await sql`select p.id::text, p.user_id::text, p.text, p.created_at from posts p join users u on u.id = p.user_id where p.id = ${p.reply_to_id}::bigint and ${seenBy(v.id)} and u.id not in (select blocker_id from blocks where blocked_id = ${v.id}::bigint)`)[0] : undefined;
		const parentUser = parent ? await userById(v.id, parent.user_id) : undefined;
		return tweetWrap(p.id, {
			...card,
			...(parent ? {
				reply_to_results: { id: gid("TweetResults", parent.id), rest_id: parent.id, result: { __typename: "Tweet", id: gid("Tweet", parent.id), rest_id: parent.id, ...(await postCard(v, parent)) } },
				reply_to_user_results: { id: gid("UserResults", parent.user_id), result: parentUser ? userResult(parentUser) : null },
			} : {}),
		});
	},
	postDetailsProviderMetricsTotalQuery: async (v: Viewer, vars: Vars) => {
		const p = await ownPost(v, vars.rest_id);
		if (!p) return tweetWrap(String(vars.rest_id ?? ""), undefined);
		return tweetWrap(p.id, { organic_metrics_total: metricList((await postTotals([p.id])).get(p.id), vars.requested_metrics) });
	},
	postDetailsProviderRealtimeDataQuery: async (v: Viewer, vars: Vars) => {
		const p = await ownPost(v, vars.restId ?? vars.rest_id);
		if (!p) return tweetWrap(String(vars.restId ?? vars.rest_id ?? ""), undefined);
		// per minute; the "Last hour" and "Last 48 hours" charts group it themselves
		return tweetWrap(p.id, { uec_instant_refresh: { items: await postSeries(p.id, Date.now() - 2 * DAY, Date.now(), 60_000) } });
	},
	postDetailsProviderAudienceQuery: async (v: Viewer, vars: Vars) => {
		const p = await ownPost(v, vars.rest_id);
		if (!p) return tweetWrap(String(vars.rest_id ?? ""), undefined);
		// no age, gender or app per engagement here: one row per day and type
		const days = await postSeries(p.id, ...span(p.created_at.getTime(), Date.now() + 1), DAY);
		return tweetWrap(p.id, { uec_metrics_daily_time_series_count: days, uec_country_metrics_daily_time_series_count: [] });
	},
	TweetActivityQuery: async (v: Viewer, vars: Vars) => {
		const p = await ownPost(v, vars.restId ?? vars.rest_id);
		if (!p) return tweetWrap(String(vars.restId ?? vars.rest_id ?? ""), undefined);
		const start = p.created_at.getTime();
		const [totals, hours] = await Promise.all([
			postTotals([p.id]),
			postSeries(p.id, ...span(ms(vars.from_time, start), Math.min(ms(vars.first_48_hours_time, start + 2 * DAY), Date.now()) + 1), 3_600_000),
		]);
		const t = totals.get(p.id);
		return tweetWrap(p.id, {
			ad: null,
			organic_metrics_time_series: organic(hours),
			audience_follow_status: [],
			datapoints_grid: metricList(t, vars.requested_organic_metrics),
			promotion_info: metricList(t, ["Impressions"]),
			video: [],
			audience_gender: [],
			audience_age: [],
			audience_top_countries: [],
		});
	},
	overviewDataPostQuery: async (v: Viewer, vars: Vars) => {
		const p = await ownPost(v, vars.rest_id);
		if (!p) return { data: { result: { id: gid("TweetResults", String(vars.rest_id ?? "")) } } };
		const days = await postSeries(p.id, ...span(ms(vars.from_time, p.created_at.getTime()), ms(vars.to_time, Date.now()) + 1), DAY);
		return { data: { result: { id: gid("TweetResults", p.id), result: { __typename: "Tweet", id: gid("Tweet", p.id), organic_metrics_time_series: organic(days) } } } };
	},
	overviewDataUserQuery: async (v: Viewer, vars: Vars) => {
		const now = Date.now();
		const days = await series(v.id, ...span(ms(vars.from_time, now - 28 * DAY), ms(vars.to_time, now) + 1), "day", false);
		return { data: { result: { id: gid("UserResults", v.id), result: { __typename: "User", id: gid("User", v.id), organic_metrics_time_series: organic(days) } } } };
	},
};

// one post's engagements per step (an hour or a day)
async function postSeries(postId: string, from: number, to: number, step: number) {
	const rows = await sql`select t.type, ${bucketOf(step)} as bucket, count(*)::int as count from (
		select 'Displayed' as type, v.created_at as at from post_views v join posts p on p.id = v.post_id where v.post_id = ${postId}::bigint and v.user_id <> p.user_id
		union all select 'Fav', l.created_at from likes l join posts p on p.id = l.post_id where l.post_id = ${postId}::bigint and l.user_id <> p.user_id
		union all select 'Retweet', r.created_at from reposts r join posts p on p.id = r.post_id where r.post_id = ${postId}::bigint and r.user_id <> p.user_id
		union all select 'Bookmark', b.created_at from bookmarks b join posts p on p.id = b.post_id where b.post_id = ${postId}::bigint and b.user_id <> p.user_id
		union all select 'Reply', r.created_at from posts r join posts p on p.id = r.reply_to_id where r.reply_to_id = ${postId}::bigint and r.user_id <> p.user_id
		union all select 'QuoteTweet', q.created_at from posts q join posts p on p.id = q.quote_id where q.quote_id = ${postId}::bigint and q.user_id <> p.user_id
	) t where t.at >= ${new Date(from)} and t.at < ${new Date(to)}
		group by 1, 2`;
	return (rows as any[])
		.map((r) => ({ timestamp: String(r.bucket), engagement_type: r.type as string, count: r.count as number }))
		.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

// daily type counts in the OrganicMetricsTimeSeries layout, by metric names
const METRIC_OF: Record<string, string> = { Displayed: "Impressions", Fav: "Likes", Reply: "Replies", Retweet: "Retweets", QuoteTweet: "Retweets", Bookmark: "Bookmark", Follow: "Follows", Unfollow: "Unfollows", ProfilePic: "ProfileVisits" };
function organic(rows: { timestamp: string; engagement_type: string; count: number }[]) {
	const days = new Map<string, Record<string, number>>();
	for (const r of rows) {
		const name = METRIC_OF[r.engagement_type];
		if (!name) continue;
		const day = days.get(r.timestamp) ?? {};
		day[name] = (day[name] ?? 0) + r.count;
		if (r.engagement_type !== "Displayed" && r.engagement_type !== "Follow" && r.engagement_type !== "Unfollow") day.Engagements = (day.Engagements ?? 0) + r.count;
		days.set(r.timestamp, day);
	}
	return [...days].map(([t, m]) => ({ timestamp: { iso8601_time: new Date(Number(t)).toISOString() }, metric_values: Object.entries(m).map(([metric_type, metric_value]) => ({ metric_type, metric_value })) }));
}
