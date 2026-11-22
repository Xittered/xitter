// Notifications, worked out from what already happened instead of being
// stored: likes and reposts of the viewer's posts (grouped per post), new
// followers (grouped per day), new posts from accounts the viewer rang the bell
// for, and replies, quotes and mentions (shown as the posts themselves). Entries sort by time in milliseconds, which is also what
// the cursors and the read marker hold.

import { blockedFor, federatedMutedFor, hasMutedWord, mutedFor, suspendedFor } from "./blocks";
import type { User } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { plainTweetResult, tweetResult, userResult } from "./model";
import type { PostRow } from "./model";
import { postsByIds } from "./posts";
import { circleMember } from "./circles";
import { feature, settings } from "./settings";
import { usersByIds } from "./users";
import { formatCents } from "./money";

// how many names a grouped notification lists before "and N others"
const SHOWN_USERS = 3;

type Group = { kind: "like" | "repost" | "follow" | "bell"; key: string; at: number; users: string[]; total: number; postId?: string };
type Mention = { kind: "post"; postId: string; at: number; reason: "reply" | "quote" | "mention" };
// a message, warning or strike from staff, or the decision on an appeal
// a notice from the instance; `url` is where it leads, /account/notices if none
type Staff = { kind: "staff"; key: string; at: number; text: string; url?: string };
// money sent to the viewer, asked of them, or their request declined (money.ts); `users` holds who did it
type Money = { kind: "money"; key: string; at: number; users: string[]; path: string; text: string; postId?: undefined };
type Item = Group | Mention | Staff | Money;

const ms = (d: Date) => d.getTime();

// everything for the viewer older than `before` (or newer than `after`), newest first
async function items(viewerId: string, opts: { before?: number; after?: number; limit: number; mentionsOnly: boolean }): Promise<Item[]> {
	// the database keeps microseconds and cursors milliseconds, so "after n" starts at the next millisecond
	const lo = opts.after !== undefined ? new Date(opts.after + 1) : new Date(0);
	const hi = opts.before ? new Date(opts.before) : new Date(8.64e15);
	const out: Item[] = [];
	// nothing from blocked or muted accounts, nor posts holding a muted word;
	// nor from hidden instances, for someone who muted those too
	const hidden = sql`(select x.id from ${blockedFor(viewerId)} as x(id) union all select x.id from ${mutedFor(viewerId)} as x(id)
		union all select x.id from ${suspendedFor(viewerId)} as x(id) union all select x.id from ${federatedMutedFor(viewerId)} as x(id))`;

	if (!opts.mentionsOnly) {
		for (const kind of ["like", "repost"] as const) {
			const table = kind === "like" ? sql`likes` : sql`reposts`;
			// newer than a mark (push, unread counts): only posts liked since then are
			// grouped, found by time, instead of every post the viewer ever had liked
			const recent = opts.after !== undefined ? sql`and a.post_id in (select n.post_id from ${table} n where n.created_at >= ${lo})` : sql``;
			const rows = await sql`
				select a.post_id, max(a.created_at) as at, count(*)::int as total,
					(array_agg(a.user_id order by a.created_at desc))[1:${SHOWN_USERS}] as users
				from ${table} a join posts p on p.id = a.post_id
				where p.user_id = ${viewerId}::bigint and a.user_id <> ${viewerId}::bigint and a.user_id not in ${hidden} ${recent}
				group by a.post_id
				having max(a.created_at) >= ${lo} and max(a.created_at) < ${hi}
				order by at desc limit ${opts.limit}`;
			for (const r of rows)
				out.push({ kind, key: `${kind}-${r.post_id}`, at: ms(r.at), users: r.users.map(String), total: r.total, postId: String(r.post_id) });
		}
		const follows = await sql`
			select date_trunc('day', f.created_at) as day, max(f.created_at) as at, count(*)::int as total,
				(array_agg(f.follower_id order by f.created_at desc))[1:${SHOWN_USERS}] as users
			from follows f where f.followee_id = ${viewerId}::bigint and f.follower_id not in ${hidden}
				and f.created_at >= date_trunc('day', ${lo}::timestamptz)
			group by 1
			having max(f.created_at) >= ${lo} and max(f.created_at) < ${hi}
			order by at desc limit ${opts.limit}`;
		for (const r of follows) out.push({ kind: "follow", key: `follow-${ms(r.day)}`, at: ms(r.at), users: r.users.map(String), total: r.total });

		// posts made after the bell was rung; replies don't count, as on X
		const rung = await sql`select p.id, p.user_id, p.created_at as at from posts p
			join post_notifications pn on pn.target_id = p.user_id and pn.user_id = ${viewerId}::bigint
			where p.reply_to_id is null and not p.hidden and p.created_at > pn.created_at and p.user_id not in ${hidden}
				and p.created_at >= ${lo} and p.created_at < ${hi}
			order by p.created_at desc limit ${opts.limit}`;
		for (const r of rung) out.push({ kind: "bell", key: `bell-${r.id}`, at: ms(r.at), users: [String(r.user_id)], total: 1, postId: String(r.id) });

		const team = `the ${settings().instance_name} team`;
		const messages = await sql`select id, kind, body, created_at as at from staff_messages
			where user_id = ${viewerId}::bigint and revoked_at is null and created_at >= ${lo} and created_at < ${hi} order by created_at desc limit ${opts.limit}`;
		for (const r of messages) {
			const what = r.kind === "strike" ? "A strike" : r.kind === "warning" ? "A warning" : "A message";
			out.push({ kind: "staff", key: `staff-${r.id}`, at: ms(r.at), text: `${what} from ${team}: ${clip(r.body)}` });
		}
		const appeals = await sql`select id, status, resolved_at as at from moderation_appeals
			where user_id = ${viewerId}::bigint and resolved_at >= ${lo} and resolved_at < ${hi} order by resolved_at desc limit ${opts.limit}`;
		for (const r of appeals)
			out.push({ kind: "staff", key: `appeal-${r.id}`, at: ms(r.at), text: `${team[0].toUpperCase()}${team.slice(1)} ${r.status === "accepted" ? "accepted" : "turned down"} your appeal.` });
		// Equicoins, while it is switched on (money.ts)
		if (feature("money")) {
			const paid = await sql`select t.id, t.sender_id, t.amount_cents, t.note, t.created_at as at from money_transfers t
				where t.recipient_id = ${viewerId}::bigint and t.sender_id not in ${hidden} and t.created_at >= ${lo} and t.created_at < ${hi}
				order by t.created_at desc limit ${opts.limit}`;
			for (const r of paid)
				out.push({ kind: "money", key: `money-${r.id}`, at: ms(r.at), users: [String(r.sender_id)], path: `/i/xmoney/p/${r.id}`, text: `sent you ${formatCents(Number(r.amount_cents))}${r.note ? `: “${clip(r.note)}”` : ""}` });
			// requests of the viewer, and the viewer's own that were declined
			const requested = await sql`select q.id, q.requester_id, q.amount_cents, q.note, q.created_at as at from money_requests q
				where q.payer_id = ${viewerId}::bigint and q.requester_id not in ${hidden} and q.created_at >= ${lo} and q.created_at < ${hi}
				order by q.created_at desc limit ${opts.limit}`;
			for (const r of requested)
				out.push({ kind: "money", key: `request-${r.id}`, at: ms(r.at), users: [String(r.requester_id)], path: `/i/xmoney/r/${r.id}`, text: `requested ${formatCents(Number(r.amount_cents))} from you${r.note ? `: “${clip(r.note)}”` : ""}` });
			const declined = await sql`select q.id, q.payer_id, q.amount_cents, q.resolved_at as at from money_requests q
				where q.requester_id = ${viewerId}::bigint and q.status = 'declined' and q.payer_id not in ${hidden} and q.resolved_at >= ${lo} and q.resolved_at < ${hi}
				order by q.resolved_at desc limit ${opts.limit}`;
			// something bought in the shop for the viewer, once staff delivered it
			const gifts = await sql`select o.id, o.user_id, o.item_name, o.reviewed_at as at from money_shop_orders o
				where o.recipient_id = ${viewerId}::bigint and o.status = 'approved' and o.user_id not in ${hidden} and o.reviewed_at >= ${lo} and o.reviewed_at < ${hi}
				order by o.reviewed_at desc limit ${opts.limit}`;
			for (const r of gifts)
				out.push({ kind: "money", key: `gift-${r.id}`, at: ms(r.at), users: [String(r.user_id)], path: "/i/xmoney/shop", text: `gave you “${clip(r.item_name)}”` });
			for (const r of declined)
				out.push({ kind: "money", key: `declined-${r.id}`, at: ms(r.at), users: [String(r.payer_id)], path: `/i/xmoney/r/${r.id}`, text: `declined your request for ${formatCents(Number(r.amount_cents))}` });
		}
		const asked = await sql`select o.id, o.screen_name, r.created_at as at from affiliation_requests r join users o on o.id = r.org_id
			where r.user_id = ${viewerId}::bigint and o.allow_affiliates and r.created_at >= ${lo} and r.created_at < ${hi} order by r.created_at desc limit ${opts.limit}`;
		for (const r of asked)
			out.push({ kind: "staff", key: `affiliation-${r.id}`, at: ms(r.at), text: `@${r.screen_name} asked to add you as an affiliate.`, url: "/account/organisation" });
	}

	const posts = await sql`
		select x.id, x.created_at as at, x.reason from (
			select p.id, greatest(p.created_at, least(p.received_at, p.created_at + interval '1 day')) as created_at, 'reply' as reason from posts p join posts parent on parent.id = p.reply_to_id
				where p.reply_to_user_id = ${viewerId}::bigint and parent.user_id = ${viewerId}::bigint and p.user_id <> ${viewerId}::bigint and p.user_id not in ${hidden} and not ${hasMutedWord(viewerId, "notifications", sql`p.id`)}
			union all
			select p.id, greatest(p.created_at, least(p.received_at, p.created_at + interval '1 day')) as created_at, 'mention' from posts p join post_mentions m on m.post_id = p.id
				where not p.ad_only and m.user_id = ${viewerId}::bigint and p.user_id <> ${viewerId}::bigint and p.user_id not in ${hidden} and not ${hasMutedWord(viewerId, "notifications", sql`p.id`)}
			${
				opts.mentionsOnly
					? sql``
					: sql`union all
			select p.id, greatest(p.created_at, least(p.received_at, p.created_at + interval '1 day')) as created_at, 'quote' from posts p join posts quoted on quoted.id = p.quote_id
				where quoted.user_id = ${viewerId}::bigint and p.user_id <> ${viewerId}::bigint and p.user_id not in ${hidden} and not ${hasMutedWord(viewerId, "notifications", sql`p.id`)}`
			}
		) x join posts cp on cp.id = x.id where x.created_at >= ${lo} and x.created_at < ${hi} and ${circleMember(viewerId, sql`cp`)}
		order by x.created_at desc limit ${opts.limit * 2}`;
	const seen = new Set<string>();
	for (const r of posts) {
		const id = String(r.id);
		if (seen.has(id)) continue;
		seen.add(id);
		out.push({ kind: "post", postId: id, at: ms(r.at), reason: r.reason });
	}

	out.sort((a, b) => b.at - a.at);
	return out.slice(0, opts.limit);
}

const ICON = { like: "heart_icon", repost: "retweet_icon", follow: "person_icon", bell: "bell_icon" } as const;
const VERB = { like: "liked your post", repost: "reposted your post", follow: "followed you", bell: "" } as const;

// "A", "A and B", "A, B and C", "A and 5 others" with each name linked to its account
function message(users: User[], total: number, verb: string, prefix = "") {
	const names = users.map((u) => u.name || u.screen_name);
	let parts: (string | User)[];
	if (prefix) parts = [prefix, users[0]];
	else if (total === 1) parts = [users[0]];
	else if (total === 2 && users.length >= 2) parts = [users[0], " and ", users[1]];
	else if (total === 3 && users.length >= 3) parts = [users[0], ", ", users[1], " and ", users[2]];
	else parts = [users[0], ` and ${total - 1} others`];
	// the client counts these indices in code points, not UTF-16 units: a name
	// with an emoji or flag measured by .length ran its link over the next words
	let text = "";
	const entities = [];
	for (const part of parts) {
		if (typeof part === "string") {
			text += part;
			continue;
		}
		const name = names[users.indexOf(part)];
		const ref = { __typename: "TimelineRichTextUser", type: "TimelineRichTextUser", user_results: { result: userResult(part) } };
		const at = [...text].length;
		entities.push({ fromIndex: at, toIndex: at + [...name].length, ref });
		text += name;
	}
	if (verb) text += ` ${verb}`;
	return { rtl: false, text, entities };
}

function notificationEntry(g: Group, users: Map<string, User>, posts: Map<string, PostRow>, viewer: User) {
	const from = g.users.map((id) => users.get(id)).filter((u): u is User => !!u);
	const post = g.postId ? posts.get(g.postId) : undefined;
	if (!from.length || (g.postId && !post)) return undefined;
	// the client opens only x.com and twitter.com addresses inside the app (as
	// their path); any other address, ours included, opens in a new tab
	const url = post ? `${IN_APP}/${post.author.screen_name}/status/${post.id}` : `${IN_APP}/${from[0].screen_name}`;
	return {
		entryId: `notification-${g.key}`,
		sortIndex: String(g.at),
		content: {
			__typename: "TimelineTimelineItem",
			entryType: "TimelineTimelineItem",
			itemContent: {
				__typename: "TimelineNotification",
				itemType: "TimelineNotification",
				id: g.key,
				notification_icon: ICON[g.kind],
				rich_message: g.kind === "bell" ? message(from, 1, "", "New post from ") : message(from, g.total, VERB[g.kind]),
				notification_url: { url, urlType: "ExternalUrl" },
				template: {
					__typename: "TimelineNotificationAggregateUserActions",
					target_objects: post ? [{ __typename: "TimelineNotificationTweetRef", tweet_results: { result: plainTweetResult(post) } }] : [],
					from_users: from.map((u) => ({ __typename: "TimelineNotificationUserRef", user_results: { result: userResult(u) } })),
				},
				// a number: the client passes it straight to Date
				timestamp_ms: g.at,
			},
			clientEventInfo: {
				component: "urt",
				element: g.kind === "bell" ? "device_follow_tweet_notification" : `user_${g.kind === "follow" ? "followed" : g.kind === "like" ? "liked_tweet" : "retweeted_tweet"}`,
			},
		},
	};
}

// "Liza sent you $100.00: “i miss you”", opening the payment
function moneyEntry(m: Money, users: Map<string, User>) {
	const from = users.get(m.users[0]);
	if (!from) return undefined;
	return {
		entryId: `notification-${m.key}`,
		sortIndex: String(m.at),
		content: {
			__typename: "TimelineTimelineItem",
			entryType: "TimelineTimelineItem",
			itemContent: {
				__typename: "TimelineNotification",
				itemType: "TimelineNotification",
				id: m.key,
				notification_icon: "bell_icon",
				rich_message: message([from], 1, m.text),
				notification_url: { url: `${IN_APP}${m.path}`, urlType: "ExternalUrl" },
				template: {
					__typename: "TimelineNotificationAggregateUserActions",
					target_objects: [],
					from_users: [{ __typename: "TimelineNotificationUserRef", user_results: { result: userResult(from) } }],
				},
				timestamp_ms: m.at,
			},
			clientEventInfo: { component: "urt", element: "generic_notification" },
		},
	};
}

const clip = (text: string) => ([...text].length > 200 ? `${[...text].slice(0, 199).join("")}…` : text);

const IN_APP = "https://x.com";

// shown like X's own account notices: a shield, the text, and a link to the
// full message (a page of ours, outside the app: tidy.ts opens it in this tab)
function staffEntry(s: Staff) {
	return {
		entryId: `notification-${s.key}`,
		sortIndex: String(s.at),
		content: {
			__typename: "TimelineTimelineItem",
			entryType: "TimelineTimelineItem",
			itemContent: {
				__typename: "TimelineNotification",
				itemType: "TimelineNotification",
				id: s.key,
				notification_icon: "shield_icon",
				rich_message: { rtl: false, text: s.text, entities: [] },
				notification_url: { url: `${PUBLIC_ORIGIN}${s.url ?? "/account/notices"}`, urlType: "ExternalUrl" },
				template: { __typename: "TimelineNotificationAggregateUserActions", target_objects: [], from_users: [] },
				timestamp_ms: s.at,
			},
			clientEventInfo: { component: "urt", element: "generic_notification" },
		},
	};
}

function postEntry(m: Mention, posts: Map<string, PostRow>) {
	const post = posts.get(m.postId);
	if (!post) return undefined;
	return {
		entryId: `notification-${m.reason}-${m.postId}`,
		sortIndex: String(m.at),
		content: {
			__typename: "TimelineTimelineItem",
			entryType: "TimelineTimelineItem",
			itemContent: { __typename: "TimelineTweet", itemType: "TimelineTweet", tweetDisplayType: "Tweet", tweet_results: { result: tweetResult(post) } },
			clientEventInfo: { component: "urt", element: m.reason === "reply" ? "user_replied_to_your_tweet" : m.reason === "quote" ? "user_quoted_your_tweet" : "user_mentioned_you" },
		},
	};
}

const cursor = (type: "Top" | "Bottom", value: string, sortIndex: string) => ({
	entryId: `cursor-${type.toLowerCase()}-${sortIndex}`,
	sortIndex,
	content: { __typename: "TimelineTimelineCursor", entryType: "TimelineTimelineCursor", cursorType: type, value },
});

// the All or Mentions tab; cursors are "t<ms>" (newer than) and "b<ms>" (older than)
export async function notificationsTimeline(viewer: User, opts: { type: string; count: number; cursor?: string }) {
	const c = /^([tb])(\d{1,16})$/.exec(opts.cursor ?? "");
	const list = await items(viewer.id, {
		limit: Math.min(Math.max(opts.count, 1), 40),
		mentionsOnly: opts.type === "Mentions",
		...(c?.[1] === "t" ? { after: Number(c[2]) } : c?.[1] === "b" ? { before: Number(c[2]) } : {}),
	});
	const userIds = [...new Set(list.flatMap((i) => (i.kind === "post" || i.kind === "staff" ? [] : i.users)))];
	const postIds = [...new Set(list.map((i) => (i.kind === "staff" ? undefined : i.postId)).filter((id): id is string => !!id))];
	const [users, posts] = await Promise.all([usersByIds(viewer.id, userIds), postsByIds(viewer.id, postIds)]);
	const entries = list
		.map((i) => (i.kind === "post" ? postEntry(i, posts) : i.kind === "staff" ? staffEntry(i) : i.kind === "money" ? moneyEntry(i, users) : notificationEntry(i, users, posts, viewer)))
		.filter((e) => !!e);

	const [{ seen }] = await sql`select notifications_seen_at as seen from users where id = ${viewer.id}::bigint`;
	const newest = list[0]?.at ?? (c?.[1] === "t" ? Number(c[2]) : Date.now());
	const oldest = list[list.length - 1]?.at ?? (c?.[1] === "b" ? Number(c[2]) : 0);
	const instructions: unknown[] = [];
	if (!c) instructions.push({ type: "TimelineClearCache" });
	instructions.push({
		type: "TimelineAddEntries",
		entries: [...entries, cursor("Top", `t${newest}`, String(newest + 1)), cursor("Bottom", `b${oldest}`, String(Math.max(oldest - 1, 0)))],
	});
	// entries newer than the read marker are shown as unread
	instructions.push({ type: "TimelineMarkEntriesUnreadGreaterThanSortIndex", sort_index: String(ms(seen) - 1) });
	return {
		data: {
			viewer_v2: {
				user_results: {
					result: {
						__typename: "User",
						rest_id: viewer.id,
						notification_timeline: { id: Buffer.from(`NotificationTimeline:${viewer.id}`).toString("base64"), timeline: { instructions } },
					},
				},
			},
		},
	};
}

// how many notifications arrived since the viewer last looked (or since `sinceMs`)
export async function unreadCount(viewerId: string, sinceMs?: number): Promise<number> {
	const [{ seen }] = await sql`select notifications_seen_at as seen from users where id = ${viewerId}::bigint`;
	return (await items(viewerId, { after: Math.max(ms(seen), sinceMs ?? 0) - 1, limit: 40, mentionsOnly: false })).length;
}

// the client reports the newest entry it has shown; cursors and sort indexes are both accepted
export async function markSeen(viewerId: string, cursorOrIndex: string | null) {
	const m = /(\d{10,16})/.exec(cursorOrIndex ?? "");
	// everything up to the end of that millisecond is read
	const at = m ? new Date(Math.min(Number(m[1]) + 1, Date.now())) : new Date();
	await sql`update users set notifications_seen_at = greatest(notifications_seen_at, ${at}) where id = ${viewerId}::bigint`;
}

// For push: what arrived after `sinceMs`, as text and an in-app path
export type PushItem = { kind: "like" | "repost" | "follow" | "bell" | "reply" | "mention" | "quote" | "staff" | "money"; key: string; at: number; text: string; url: string };

export async function pushItems(viewerId: string, sinceMs: number): Promise<PushItem[]> {
	const list = await items(viewerId, { after: sinceMs, limit: 20, mentionsOnly: false });
	const userIds = [...new Set(list.flatMap((i) => (i.kind === "post" || i.kind === "staff" ? [] : i.users)))];
	const postIds = [...new Set(list.flatMap((i) => (i.kind === "staff" || !i.postId ? [] : [i.postId])))];
	// a push isn't the post being seen: no view is counted
	const [users, posts] = await Promise.all([usersByIds(viewerId, userIds), postsByIds(viewerId, postIds, true, { views: false })]);
	const name = (u?: User) => (u ? u.name || u.screen_name : "Someone");
	const snippet = (p?: PostRow) => (p ? `: ${clip(p.text)}` : "");
	const out: PushItem[] = [];
	for (const i of list) {
		if (i.kind === "staff") {
			out.push({ kind: "staff", key: i.key, at: i.at, text: i.text, url: i.url ?? "/account/notices" });
			continue;
		}
		if (i.kind === "money") {
			const from = users.get(i.users[0]);
			out.push({ kind: "money", key: i.key, at: i.at, text: `${name(from)} ${i.text}`, url: i.path });
			continue;
		}
		const post = i.postId ? posts.get(i.postId) : undefined;
		const path = post ? `/${post.author.screen_name}/status/${post.id}` : "/notifications";
		if (i.kind === "post") {
			if (!post) continue;
			const verb = i.reason === "reply" ? "replied" : i.reason === "quote" ? "quoted your post" : "mentioned you";
			out.push({ kind: i.reason, key: `${i.reason}-${post.id}`, at: i.at, text: `${name(post.author)} ${verb}${snippet(post)}`, url: path });
			continue;
		}
		const from = i.users.map((id) => users.get(id)).filter((u): u is User => !!u);
		if (!from.length) continue;
		const who = i.total > 1 ? `${name(from[0])} and ${i.total - 1} other${i.total === 2 ? "" : "s"}` : name(from[0]);
		const text =
			i.kind === "bell" ? `New post from ${name(from[0])}${snippet(post)}` : i.kind === "follow" ? `${who} followed you` : `${who} ${i.kind === "like" ? "liked" : "reposted"} your post${snippet(post)}`;
		out.push({ kind: i.kind, key: i.key, at: i.at, text, url: i.kind === "follow" ? `/${from[0].screen_name}` : path });
	}
	return out;
}
