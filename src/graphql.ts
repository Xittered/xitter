// GraphQL operations, routed by name. The client sends a query id that changes
// with every build; the name after it is stable.

import { ChatError, chatHandlers } from "./chat";
import { delegationHandlers } from "./delegation";
import { automationHandlers } from "./automation";
import { analyticsHandlers } from "./analytics";
import { bookmarkFolderHandlers } from "./bookmark-folders";
import { communityHandlers } from "./communities";
import { countryName, regionName } from "./countries";
import { gifHandlers } from "./gifs";
import { listHandlers } from "./lists";
import { placeById } from "./places";
import { PollError, attachPoll } from "./polls";
import { scheduledHandlers } from "./scheduled";
import { noteHandlers } from "./notes";
import { sessionsList, usernameAvailable } from "./account-settings";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { trendScope } from "./explore-settings";
import { activeCards, cardsEntry } from "./explore-cards";
import { blockedIds, blockedFor, outOfView, protectedFor } from "./blocks";
import { settings } from "./settings";
import { rankedFeed } from "./ranking";
import * as articles from "./articles";
import type { Viewer } from "./auth";
import { notificationsTimeline, unreadCount } from "./notifications";
import { searchPosts, searchUsers, trendingHashtags } from "./search";
import { isId, newId } from "./ids";
import { attachMedia } from "./media";
import { cursorEntry, feedEntry, gridAppend, gridEntry, pinnedEntry, replyEntry, tweetEntry, tweetResult, userEntry, userResult } from "./model";
import {
	PostError,
	ancestors,
	bookmarkedPosts,
	highlightedPosts,
	setHighlight,
	createPost,
	deletePost,
	editPost,
	feed,
	getPost,
	originalPostId,
	likedPosts,
	postsByIds,
	replies,
	hiddenReplies,
	hasHiddenReplies,
	setReplyHidden,
	repost,
	setMark,
	setPinned,
	setPinnedReply,
	pinnedReplyOf,
	unrepost,
} from "./posts";
import { TopicError, setTopicState, suggestedTopics, topicById, topicContext, topicFeedbackActions, topicFeedbackKeys, topicResult, topicsForPosts } from "./topics";
import { affiliatesOf, followList, suggestedUsers, userById, userByName, usersByIds } from "./users";

type Vars = Record<string, any>;
type Handler = (viewer: Viewer, vars: Vars) => Promise<unknown> | unknown;

const dec = (id: string) => (BigInt(id) - 1n).toString();
const inc = (id: string) => (BigInt(id) + 1n).toString();
const globalId = (kind: string, id: string) => Buffer.from(`${kind}:${id}`).toString("base64");
// the profile page throws on a suspended account without both rich texts and
// spins forever
const richText = (text: string) => ({ rtl: false, text, entities: [] });
const SUSPENDED_USER = {
	__typename: "UserUnavailable",
	reason: "Suspended",
	unavailable_reason: "Suspended",
	message: "This account is suspended.",
	unavailable_header: richText("Account suspended"),
	unavailable_message: richText("This account broke the rules of this instance and was suspended."),
};

const PARODY_LABELS = new Set(["None", "Parody", "Commentary", "Fan"]);
// the client's confirm dialog says a change locks the label for 48 hours
const PARODY_LOCK_MS = 48 * 3600_000;
async function parodySettings(userId: string) {
	const [u] = await sql`select parody_label, parody_label_at from users where id = ${userId}::bigint`;
	const left = u?.parody_label_at ? new Date(u.parody_label_at).getTime() + PARODY_LOCK_MS - Date.now() : 0;
	const locked = left > 0;
	return {
		disabled_duration_msec: locked ? left : 0,
		is_label_update_disabled: locked,
		parody_commentary_fan_label: u?.parody_label ?? "None",
		update_disabled_reason: locked ? `You changed your label recently. You can change it again in ${Math.ceil(left / 3600_000)} hours.` : null,
	};
}
async function setParodyLabel(userId: string, label: unknown) {
	if (typeof label !== "string" || !PARODY_LABELS.has(label)) throw new PostError("Pick Parody, Commentary, Fan or None.", 214);
	const now = await parodySettings(userId);
	if (now.parody_commentary_fan_label === label) return;
	if (now.is_label_update_disabled) throw new PostError(now.update_disabled_reason!, 214);
	// a label staff gave the account stays: the client would show this one over it
	const [staffLabel] = await sql`select 1 from users where id = ${userId}::bigint and label_id is not null`;
	if (staffLabel) throw new PostError("Your profile label was set by this instance's staff.", 214);
	await sql`update users set parody_label = ${label}, parody_label_at = now() where id = ${userId}::bigint`;
}

function postId(vars: Vars, key = "tweet_id"): string {
	const id = vars[key];
	if (!isId(id)) throw new PostError("Invalid post id.", 144);
	return id;
}

// Cursors are "b<id>" (older than) and "t<id>" (newer than), over feed item ids.
function pageOf(vars: Vars) {
	const count = Math.min(Math.max(Number(vars.count) || 20, 1), 100);
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	const at = isId(cursor.slice(1)) ? cursor.slice(1) : undefined;
	return { count, at, newer: cursor[0] === "t" && !!at };
}

const homeResponse = (entries: unknown[], feedbackActions: unknown[] = []) => ({
	data: {
		home: {
			home_timeline_urt: {
				instructions: [{ type: "TimelineAddEntries", entries }],
				metadata: { scribeConfig: { page: "following" } },
				...(feedbackActions.length ? { responseObjects: { feedbackActions } } : {}),
			},
		},
	},
});

// the post an admin pinned for everyone, on top of the first page
async function globalPin(viewer: Viewer, entries: unknown[], first: boolean) {
	const id = settings().operations.global_pin;
	if (!first || !id) return;
	const [visible] = await sql`select id from posts where id = ${id}::bigint and not hidden and user_id not in ${blockedFor(viewer.id)} and user_id not in ${outOfView(viewer.id)}`;
	const post = visible && (await getPost(viewer.id, id));
	if (!post) return;
	for (let i = entries.length - 1; i >= 0; i--) if ((entries[i] as any).entryId === `tweet-${id}`) entries.splice(i, 1);
	entries.unshift(pinnedEntry(post, newId()));
}

// "For you" is ranked (ranking.ts) and takes in everyone; "Following" is the
// viewer and the accounts they follow, newest first.
// A ranked page's bottom cursor is "r<offset>.<asOf>", where asOf is the item id
// the ranking was made at. Its top cursor is "t<asOf>": the client's poll for
// newer posts gets what arrived since, newest first, above the ranked entries.
const forYou: Handler = async (viewer, vars) => {
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	const ranked = /^r(\d+)\.(\d{1,19})$/.exec(cursor);
	if (cursor && !ranked) return home(false)(viewer, vars);
	const count = Math.min(Math.max(Number(vars.count) || 20, 1), 100);
	const asOf = ranked ? ranked[2] : newId();
	const offset = ranked ? Number(ranked[1]) : 0;
	const page = await rankedFeed(viewer.id, { asOf, offset, limit: count });
	// sort indexes run down from asOf in ranked order, below anything newer
	const base = BigInt(asOf);
	const topics = await topicsForPosts(viewer.id, page.items.filter((i) => !i.repost).map((i) => ({ id: i.post.id, authorId: i.post.author.id })));
	const feedbackActions = [...new Map([...topics.values()].map((t) => [t.id, t])).values()].flatMap(topicFeedbackActions);
	const entries: unknown[] = page.items.map((item, i) => {
		const topic = item.repost ? undefined : topics.get(item.post.id);
		return feedEntry(item, (base - BigInt(offset + i) - 1n).toString(), topic && { context: topicContext(topic), feedbackKeys: topicFeedbackKeys(topic) });
	});
	if (!ranked) entries.unshift(cursorEntry("Top", `t${asOf}`, inc(asOf)));
	if (page.next !== undefined) entries.push(cursorEntry("Bottom", `r${page.next}.${asOf}`, (base - BigInt(page.next) - 1n).toString()));
	await globalPin(viewer,entries,!cursor);
	return homeResponse(entries, feedbackActions);
};

const home =
	(following: boolean): Handler =>
	async (viewer, vars) => {
	const { count, at, newer } = pageOf(vars);
	const items = await feed({
		viewerId: viewer.id,
		authors: following ? { following: true } : { all: true },
		replies: false,
		kinds: "both",
		limit: count,
		...(newer ? { after: at } : { before: at }),
	});

	const entries: unknown[] = items.map((i) => feedEntry(i, i.id));
	const newest = items[0]?.id ?? at ?? newId();
	const oldest = items[items.length - 1]?.id ?? at ?? newest;
	// a poll for newer posts only moves the top cursor
	entries.unshift(cursorEntry("Top", `t${newest}`, inc(newest)));
	if (!newer) entries.push(cursorEntry("Bottom", `b${oldest}`, dec(oldest)));
	await globalPin(viewer,entries,!vars.cursor);

	return {
		data: {
			home: {
				home_timeline_urt: {
					instructions: [{ type: "TimelineAddEntries", entries }],
					metadata: { scribeConfig: { page: "following" } },
				},
			},
		},
	};
};

const tweetDetail: Handler = async (viewer, vars) => {
	const id = postId(vars, "focalTweetId");
	const entries: unknown[] = [];
	const feedbackActions: unknown[] = [];
	// the whole conversation is returned at once, so a cursor request has nothing more
	if (!vars.cursor) {
		const focal = await getPost(viewer.id, id);
		if (!focal) throw new PostError("No status found with that ID.", 144);
		const above = focal.reply_to_id ? await ancestors(viewer.id, focal.reply_to_id) : [];
		const below = await replies(viewer.id, id);
		// a pinned reply leads the replies to the first post of a conversation
		const pinned = focal.reply_to_id ? null : await pinnedReplyOf(id);
		const at = below.findIndex((p) => p.id === pinned);
		if (at > 0) below.unshift(...below.splice(at, 1));
		const canPin = !focal.reply_to_id && focal.author.id === viewer.id;
		let sort = BigInt(newId());
		for (const p of above) entries.push(tweetEntry(p, (sort--).toString()));
		const focalEntry = tweetEntry(focal, (sort--).toString());
		// the "View hidden replies" link under a conversation's first post
		if (!focal.reply_to_id && (await hasHiddenReplies(id))) Object.assign(focalEntry.content.itemContent, { hasModeratedReplies: true });
		entries.push(focalEntry);
		for (const p of below) {
			const isPinned = p.id === pinned;
			entries.push(replyEntry(p, (sort--).toString(), { pinned: isPinned, ...(canPin ? { feedbackKey: isPinned ? PIN_KEYS.Pinned : PIN_KEYS.Pinnable } : {}) }));
		}
		if (canPin) feedbackActions.push(...pinActions());
	}
	return {
		data: {
			threaded_conversation_with_injections_v2: {
				instructions: [
					...(vars.cursor ? [] : [{ type: "TimelineClearCache" }]),
					{ type: "TimelineAddEntries", entries },
					{ type: "TimelineTerminateTimeline", direction: "Top" },
					{ type: "TimelineTerminateTimeline", direction: "Bottom" },
				],
				metadata: { scribeConfig: { page: "ranked_replies" } },
				...(feedbackActions.length ? { responseObjects: { feedbackActions } } : {}),
			},
		},
	};
};

// The reply menu's "Pin"/"Unpin" item: the client picks its own wording from
// the pin state and calls PinReply/UnpinReply with the reply's id.
const PIN_KEYS = { Pinnable: "reply-pin-pinnable", Pinned: "reply-pin-pinned" } as const;
const pinActions = () =>
	(["Pinnable", "Pinned"] as const).map((state) => ({
		key: PIN_KEYS[state],
		value: {
			feedbackType: "RichBehavior",
			hasUndoAction: false,
			richBehavior: { type: "TimelineRichFeedbackBehaviorReplyPinState", replyPinState: state },
			clientEventInfo: { component: "pinned_reply", element: state === "Pinned" ? "unpin" : "pin" },
		},
	}));

const topicState = (what: Parameters<typeof setTopicState>[2]): Handler => async (v, vars) => {
	try {
		return { data: { topic: topicResult(await setTopicState(v.id, String(vars.topicId ?? ""), what)) } };
	} catch (e) {
		if (e instanceof TopicError) throw new PostError(e.message, 144);
		throw e;
	}
};

const pinReply = (on: boolean): Handler => async (viewer, vars) => {
	const done = isId(vars.conversationId) && isId(vars.tweetId) && (await setPinnedReply(viewer.id, vars.conversationId, vars.tweetId, on));
	return { data: { [on ? "create_conversation_pinned_tweet" : "delete_conversation_pinned_tweet"]: { success: !!done } } };
};

const bookmarks: Handler = async (viewer, vars) => {
	const posts = vars.cursor ? [] : await bookmarkedPosts(viewer.id);
	const base = BigInt(newId());
	const entries: unknown[] = posts.map((p, i) => tweetEntry(p, (base - BigInt(i) - 1n).toString()));
	entries.push(cursorEntry("Top", "t0", base.toString()));
	entries.push(cursorEntry("Bottom", "b0", (base - BigInt(posts.length) - 2n).toString()));
	return {
		data: { bookmark_timeline_v2: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }], responseObjects: {} } } },
	};
};

const createTweet: Handler = async (viewer, vars) => {
	const text = typeof vars.tweet_text === "string" ? vars.tweet_text.trim() : "";
	const mediaIds: string[] = (Array.isArray(vars.media?.media_entities) ? vars.media.media_entities : [])
		.map((m: any) => String(m?.media_id ?? ""))
		.filter(isId);
	if (!text && !mediaIds.length) throw new PostError("Your post is empty.", 170);
	const previous = vars.edit_options?.previous_tweet_id;
	if (previous !== undefined) {
		if (!isId(previous)) throw new PostError("Invalid post id.", 144);
		await editPost(viewer.id, previous, text);
		return { data: { create_tweet: { tweet_results: { result: tweetResult((await getPost(viewer.id, previous))!, false) } } } };
	}
	const replyTo = vars.reply?.in_reply_to_tweet_id;
	if (replyTo !== undefined && !isId(replyTo)) throw new PostError("Invalid post id.", 144);
	// a quote arrives as a link to the quoted post
	const quoteId = typeof vars.attachment_url === "string" ? /\/status(?:es)?\/(\d{1,19})/.exec(vars.attachment_url)?.[1] : undefined;
	// a post to a community carries it as a semantic annotation (domain 31)
	const annotated = (Array.isArray(vars.semantic_annotation_ids) ? vars.semantic_annotation_ids : []).find((x: any) => String(x?.domain_id) === "31")?.entity_id;
	const communityId = [vars.community_id, annotated].find(isId);
	const id = await createPost(viewer.id, text, { replyToId: replyTo, quoteId, source: viewer.postSource, communityId, placeId: placeById(vars.geo?.place_id) ? vars.geo.place_id : undefined, replyPolicy: ["Community", "ByInvitation", "Verified"].includes(vars.conversation_control?.mode) ? vars.conversation_control.mode : undefined });
	if (typeof vars.card_uri === "string" && vars.card_uri) {
		try {
			await attachPoll(viewer.id, id, vars.card_uri);
		} catch (e) {
			await deletePost(viewer.id, id);
			if (e instanceof PollError) throw new PostError(e.message, 214);
			throw e;
		}
	}
	if (mediaIds.length) await attachMedia(viewer.id, id, mediaIds);
	// a content warning on any of its media makes the post sensitive
	if (vars.media?.possibly_sensitive === true || mediaIds.length)
		await sql`update posts set sensitive = true where id = ${id}::bigint and (${vars.media?.possibly_sensitive === true}
			or exists (select 1 from media m where m.post_id = posts.id and m.sensitive_warning is not null))`;
	const post = await getPost(viewer.id, id);
	return { data: { create_tweet: { tweet_results: { result: tweetResult(post!, false) } } } };
};

// every profile tab is read from the same place in the response
const userTimeline = (entries: unknown[]) => ({
	data: {
		user: {
			result: {
				__typename: "User",
				timeline: {
					timeline: {
						instructions: [{ type: "TimelineAddEntries", entries }],
						metadata: { scribeConfig: { page: "profileBest" } },
					},
				},
			},
		},
	},
});

function userId(vars: Vars): string {
	if (!isId(vars.userId)) throw new PostError("Invalid user id.", 50);
	return vars.userId;
}

// Profile tabs: posts and reposts, with or without replies, or reposts only.
// The pinned post leads the posts tab on the first page.
const profileFeed =
	(withReplies: boolean, kinds: "both" | "posts" | "reposts", onlyReplies = false, articlesOnly = false): Handler =>
	async (viewer, vars) => {
		const { count, at, newer } = pageOf(vars);
		// profile tabs only page downwards
		if (newer) return userTimeline([]);
		const owner = userId(vars);
		const items = await feed({ viewerId: viewer.id, authors: { user: owner }, replies: withReplies, onlyReplies, articlesOnly, kinds, limit: count, before: at });
		let pinned: Awaited<ReturnType<typeof getPost>>;
		if (!at && !withReplies && kinds === "both" && !articlesOnly) {
			const user = await userById(viewer.id, owner);
			pinned = user?.pinned_post_id ? await getPost(viewer.id, user.pinned_post_id) : undefined;
		}
		// the labelled pinned entry goes first; its regular copy would be a duplicate id
		const entries: unknown[] = items.filter((i) => i.id !== pinned?.id).map((i) => feedEntry(i, i.id));
		if (pinned) entries.unshift(pinnedEntry(pinned, inc(BigInt(newId()).toString())));
		if (items.length) {
			if (!at) entries.unshift(cursorEntry("Top", `t${items[0].id}`, inc(items[0].id)));
			const last = items[items.length - 1].id;
			entries.push(cursorEntry("Bottom", `b${last}`, dec(last)));
		}
		return userTimeline(entries);
	};

// the Media tabs: the account's own posts with media, as a grid
const userMedia =
	(media: "any" | "photo" | "video"): Handler =>
	async (viewer, vars) => {
		const { count, at, newer } = pageOf(vars);
		if (newer) return userTimeline([]);
		const items = await feed({ viewerId: viewer.id, authors: { user: userId(vars) }, replies: true, kinds: "posts", media, limit: count, before: at });
		const posts = items.map((i) => i.post);
		const cursors: unknown[] = [];
		if (items.length) {
			if (!at) cursors.push(cursorEntry("Top", `t${items[0].id}`, inc(items[0].id)));
			const last = items[items.length - 1].id;
			cursors.push(cursorEntry("Bottom", `b${last}`, dec(last)));
		}
		if (!at) return userTimeline([...(posts.length ? [gridEntry(posts, items[0].id)] : []), ...cursors]);
		const result = userTimeline(cursors);
		if (posts.length) result.data.user.result.timeline.timeline.instructions.unshift(gridAppend(posts) as any);
		return result;
	};

// lists that are returned whole: a cursor request has nothing more
const wholeList = (entries: unknown[], base: bigint) => [
	...entries,
	cursorEntry("Top", "t0", (base + 1n).toString()),
	cursorEntry("Bottom", "b0", (base - BigInt(entries.length) - 2n).toString()),
];

// Who reposted / liked a post, from the post's activity page. Protected
// accounts' reactions stay with the people allowed to see them.
const reactors = (kind: "reposts" | "likes", key: string): Handler => async (viewer, vars) => {
	const empty = { data: { [key]: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: [] }] } } } };
	if (!isId(vars.tweetId) || vars.cursor) return empty;
	const rows =
		kind === "reposts"
			? await sql`select r.user_id::text as id from reposts r where r.post_id = ${vars.tweetId}::bigint and r.user_id not in ${blockedFor(viewer.id)} and r.user_id not in ${protectedFor(viewer.id)} and r.user_id not in ${outOfView(viewer.id)} order by r.created_at desc limit 100`
			: await sql`select l.user_id::text as id from likes l where l.post_id = ${vars.tweetId}::bigint and l.user_id not in ${blockedFor(viewer.id)} and l.user_id not in ${protectedFor(viewer.id)} and l.user_id not in ${outOfView(viewer.id)} order by l.created_at desc limit 100`;
	const users = await usersByIds(viewer.id, rows.map((r: any) => r.id));
	const base = BigInt(newId());
	const entries = rows.flatMap((r: any, i: number) => (users.has(r.id) ? [userEntry(users.get(r.id)!, (base - BigInt(i) - 1n).toString())] : []));
	return { data: { [key]: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: wholeList(entries, base) }], metadata: { scribeConfig: { page: "reactors" } } } } } };
};

const likes: Handler = async (viewer, vars) => {
	const posts = vars.cursor ? [] : await likedPosts(viewer.id, userId(vars));
	const base = BigInt(newId());
	return userTimeline(wholeList(posts.map((p, i) => tweetEntry(p, (base - BigInt(i) - 1n).toString())), base));
};

const follows =
	(kind: "following" | "followers" | "verified_followers"): Handler =>
	async (viewer, vars) => {
		const users = vars.cursor ? [] : await followList(viewer.id, userId(vars), kind);
		const base = BigInt(newId());
		return userTimeline(wholeList(users.map((u, i) => userEntry(u, (base - BigInt(i) - 1n).toString())), base));
	};

// Settings > Privacy > Blocked and Muted accounts; both lists come back whole
const relationList =
	(kind: "blocks" | "mutes" | "none"): Handler =>
	async (viewer, vars) => {
		const ids = vars.cursor || kind === "none" ? [] : await blockedIds(viewer.id, kind);
		const users = await usersByIds(viewer.id, ids);
		const base = BigInt(newId());
		const entries = ids.flatMap((id, i) => (users.has(id) ? [userEntry(users.get(id)!, (base - BigInt(i) - 1n).toString())] : []));
		const timeline = { timeline: { instructions: [{ type: "TimelineAddEntries", entries: wholeList(entries, base) }] } };
		return { data: { viewer: kind === "mutes" ? { muting_timeline: timeline } : { timeline } } };
	};

const viewerUser = (fields: object) => ({ data: { viewer: { user_results: { result: { __typename: "User", ...fields } } } } });

const LANGUAGES: [string, string, string][] = [
	["en", "English", "English"],
	["ru", "Русский", "Russian"],
	["uk", "Українська", "Ukrainian"],
	["de", "Deutsch", "German"],
	["fr", "Français", "French"],
	["es", "Español", "Spanish"],
	["it", "Italiano", "Italian"],
	["pt", "Português", "Portuguese"],
	["pl", "Polski", "Polish"],
	["ja", "日本語", "Japanese"],
];

const userGlobalId = (id: string) => Buffer.from(`User:${id}`).toString("base64");
const EMAIL_SETTINGS = ["send_twitter_emails", "send_email_vit_weekly", "send_network_activity_email", "send_new_direct_text_email", "send_shared_tweet_email", "send_network_digest", "send_performance_digest"];

// "Account based in": the country if its owner chose that, else the continent
function basedIn(country: string | null, preference: string | null): string | null {
	if (!country) return null;
	if (preference === "Country") return countryName(country) ?? null;
	return regionName(country) ?? countryName(country) ?? null;
}

const handlers: Record<string, Handler> = {
	// Settings > Notifications > Email: what is stored is what would be mailed
	ViewerEmailSettings: async (v: Viewer) => {
		const [u] = await sql`select email_settings from users where id = ${v.id}::bigint`;
		const stored = u?.email_settings ?? {};
		const settings = Object.fromEntries(EMAIL_SETTINGS.map((k) => [k, stored[k] ?? false]));
		return { data: { viewer: { user_results: { result: { __typename: "User", id: userGlobalId(v.id), notifications_email_notifications: settings } } } } };
	},
	WriteEmailNotificationSettings: async (v: Viewer, vars: Vars) => {
		const given = typeof vars.settings === "object" && vars.settings ? (vars.settings as Record<string, unknown>) : {};
		const next = Object.fromEntries(EMAIL_SETTINGS.filter((k) => typeof given[k] === "boolean" || (typeof given[k] === "string" && ["Daily", "Weekly", "Periodically", "None"].includes(given[k] as string))).map((k) => [k, given[k]]));
		await sql`update users set email_settings = email_settings || ${JSON.stringify(next)}::text::jsonb where id = ${v.id}::bigint`;
		return { data: { write_email_notification_settings: "Done" } };
	},
	UserPreferencesQuery: async (v: Viewer) => {
		const [u] = await sql`select preferences from users where id = ${v.id}::bigint`;
		const p = (u?.preferences ?? {}) as Record<string, unknown>;
		return {
			data: {
				user_preferences: {
					about_this_account_user_preferences: { business_country_code_preferences: [], selected_business_country_code: null },
					allow_for_you_recommendations: p.allow_for_you_recommendations ?? true,
					inferred_location_resolution_preference: p.inferred_location_resolution_preference ?? "Unspecified",
				},
				viewer_v2: { user_results: { result: { __typename: "User", id: userGlobalId(v.id), legacy_extended_profile: { birthdate: null } } } },
			},
		};
	},
	// Settings > About your account: country or region on the About page, and the For you switch
	// Settings > Your account > Profile label: parody, commentary or fan account
	AccountParodyScreenImplV2ParodyLabelSettingQuery: async (v: Viewer) => ({ data: { get_parody_label_settings: await parodySettings(v.id) } }),
	AccountParodyScreenImplV2ParodyLabelMutation: async (v: Viewer, vars: Vars) => {
		await setParodyLabel(v.id, vars.parodyProfileLabel);
		return { data: { update_parody_label: { __typename: "PCFLabelSettings", parody_commentary_fan_label: String(vars.parodyProfileLabel) } } };
	},
	AccountParodyUserMutation: async (v: Viewer, vars: Vars) => {
		await setParodyLabel(v.id, vars.parodyProfileLabel);
		return { data: { user_preferences_put: "Done" } };
	},
	UserPreferencesMutation: async (v: Viewer, vars: Vars) => {
		const next: Record<string, unknown> = {};
		if (vars.inferred_location_resolution_preference === "Country" || vars.inferred_location_resolution_preference === "Region" || vars.inferred_location_resolution_preference === "Unspecified")
			next.inferred_location_resolution_preference = vars.inferred_location_resolution_preference;
		if (typeof vars.allow_for_you_recommendations === "boolean") next.allow_for_you_recommendations = vars.allow_for_you_recommendations;
		await sql`update users set preferences = preferences || ${JSON.stringify(next)}::text::jsonb where id = ${v.id}::bigint`;
		return { data: { user_preferences_put: "Done" } };
	},
	// the note under Settings > About your account about a location that may be off
	LocationDisclaimerQuery: async (v: Viewer) => ({
		data: { viewer_v2: { user_results: { result: { __typename: "User", id: userGlobalId(v.id), about_profile: { location_accurate: true, report_problem_url: null } } } } },
	}),
	AudienceAndTaggingQuery: async (v: Viewer) => ({
		data: {
			user_preferences: { allow_video_downloads: true },
			viewer: { user_results: { result: { __typename: "User", id: userGlobalId(v.id), legacy_extended_profile: { birthdate: null } } } },
		},
	}),
	UserSessionsList: async (v: Viewer) => ({
		data: { viewer: { user_results: { result: { __typename: "User", id: userGlobalId(v.id), sessions_list: await sessionsList(v) } } } },
	}),
	// the composer's flag tab: what the viewer chooses to see, and whether they may choose
	SensitiveMediaSettingsQuery: async (v: Viewer) => ({
		data: {
			viewer_v2: {
				user_results: {
					result: {
						__typename: "User",
						id: userGlobalId(v.id),
						rest_id: v.id,
						sensitive_media_settings: {
							sensitive_media_settings: { view_adult_content: false, view_violent_content: false, view_other_content: false },
							can_user_allow_sensitive_content: true,
						},
					},
				},
			},
		},
	}),
	UserAccountLabel: async (v: Viewer) => ({ data: { user: { result: { __typename: "User", id: userGlobalId(v.id) } } } }),
	GetUsernameAvailabilityAndSuggestions: async (v: Viewer, vars: Vars) => {
		const r = await usernameAvailable(v.id, String(vars.username ?? ""));
		return { data: { get_username_availability_and_suggestions: { __typename: "UsernameAvailabilityAndSuggestions", available: r.available, suggestions: vars.include_suggestions === false ? [] : r.suggestions } } };
	},
	SupportedLanguages: async () => ({
		data: { supported_languages: { supported_languages: LANGUAGES.map(([code, local_name, name]) => ({ code, local_name, name, status: "supported" })) } },
	}),
	PutClientEducationFlag: async (v: Viewer, vars: Vars) => {
		if (typeof vars.flag === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(vars.flag))
			await sql`update users set education_flags = education_flags || ${JSON.stringify({ [vars.flag]: Date.now() })}::text::jsonb where id = ${v.id}::bigint`;
		return { data: { add_client_education_flag_put: "Done" } };
	},
	HomeTimeline: forYou,
	HomeLatestTimeline: home(true),
	TweetDetail: tweetDetail,
	// Hide reply, and the "Hidden replies" page of a conversation
	ModerateTweet: async (v, vars) => {
		await setReplyHidden(v.id, postId(vars, "tweetId"), true);
		return { data: { tweet_moderate_put: "Done" } };
	},
	UnmoderateTweet: async (v, vars) => {
		await setReplyHidden(v.id, postId(vars, "tweetId"), false);
		return { data: { tweet_unmoderate_put: "Done" } };
	},
	ModeratedTimeline: async (v, vars) => {
		const root = postId(vars, "rootTweetId");
		const posts = vars.cursor ? [] : await hiddenReplies(v.id, root);
		const base = BigInt(newId());
		const entries: unknown[] = posts.map((p, i) => tweetEntry(p, (base - BigInt(i) - 1n).toString()));
		return { data: { tweet: { result: { __typename: "Tweet", rest_id: root, timeline_response: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } } } };
	},
	Bookmarks: bookmarks,
	CreateTweet: createTweet,
	// the composer's long post (over 280 weighted characters): the same request,
	// answered under notetweet_create. Bold and italic (richtext_options) aren't kept.
	CreateNoteTweet: async (v, vars) => ({ data: { notetweet_create: ((await createTweet(v, vars)) as any).data.create_tweet } }),
	DeleteTweet: async (v, vars) => {
		await deletePost(v.id, postId(vars));
		return { data: { delete_tweet: { tweet_results: {} } } };
	},
	FavoriteTweet: async (v, vars) => {
		await setMark("likes", v.id, postId(vars), true);
		return { data: { favorite_tweet: "Done" } };
	},
	UnfavoriteTweet: async (v, vars) => {
		await setMark("likes", v.id, postId(vars), false);
		return { data: { unfavorite_tweet: "Done" } };
	},
	CreateBookmark: async (v, vars) => {
		await setMark("bookmarks", v.id, postId(vars), true);
		return { data: { tweet_bookmark_put: "Done" } };
	},
	DeleteBookmark: async (v, vars) => {
		const id = await originalPostId(postId(vars));
		await setMark("bookmarks", v.id, id, false);
		// an unbookmarked post leaves the viewer's folders too
		await sql`delete from bookmark_folder_posts where post_id = ${id}::bigint and folder_id in (select id from bookmark_folders where user_id = ${v.id}::bigint)`;
		return { data: { tweet_bookmark_delete: "Done" } };
	},
	CreateRetweet: async (v, vars) => {
		const id = await repost(v.id, postId(vars));
		return { data: { create_retweet: { retweet_results: { result: { rest_id: id } } } } };
	},
	DeleteRetweet: async (v, vars) => {
		const id = await originalPostId(postId(vars, "source_tweet_id"));
		await unrepost(v.id, id);
		return { data: { unretweet: { source_tweet_results: { result: { rest_id: id } } } } };
	},

	NotificationsTimeline: (v, vars) =>
		notificationsTimeline(v, { type: String(vars.timeline_type ?? "All"), count: Number(vars.count) || 20, cursor: typeof vars.cursor === "string" ? vars.cursor : undefined }),
	TweetResultsByRestIds: async (v, vars) => {
		const ids = Array.isArray(vars.tweetIds) ? (vars.tweetIds as unknown[]).map(String).filter(isId).slice(0, 100) : [];
		const posts = await Promise.all(ids.map((id) => getPost(v.id, id)));
		return { data: { tweetResult: posts.map((p) => (p ? { result: tweetResult(p) } : {})) } };
	},
	TweetResultByRestId: async (v, vars) => {
		const post = await getPost(v.id, postId(vars, "tweetId"));
		return { data: post ? { tweetResult: { result: tweetResult(post) } } : {} };
	},

	UserByScreenName: async (v, vars) => {
		const user = typeof vars.screen_name === "string" ? await userByName(v.id, vars.screen_name) : undefined;
		// an empty answer makes the client show "this account doesn't exist"
		if (!user) return { data: {} };
		// staff too: they look a suspended account up in the admin panel
		if (user.status === "suspended") return { data: { user: { result: SUSPENDED_USER } } };
		// a visit for the profile's analytics, once a day per visitor
		if (user.id !== v.id) sql`insert into profile_visits (profile_id, visitor_id) values (${user.id}::bigint, ${v.id}::bigint) on conflict do nothing`.catch(() => {});
		return { data: { user: { result: userResult(user) } } };
	},
	// "About this account" (/<name>/about)
	AboutAccountQuery: async (v, vars) => {
		const user = typeof vars.screenName === "string" ? await userByName(v.id, vars.screenName) : undefined;
		if (!user || user.status === "suspended")
			return { data: { user_result_by_screen_name: { result: { __typename: "UserUnavailable", unavailable_reason: user ? "Suspended" : "NotFound" } } } };
		const [extra] = await sql`select u.verified_at, u.country, u.based_in_override, u.signup_country, u.preferences->>'inferred_location_resolution_preference' as location_pref,
			-- accounts from before sign-ups were recorded: the app of their first post
			coalesce(u.signup_source, (select p.source from posts p where p.user_id = u.id order by p.id limit 1)) as source,
			(select count(*)::int from username_changes c where c.user_id = u.id) as changes,
			(select max(c.changed_at) from username_changes c where c.user_id = u.id) as last_change
			from users u where u.id = ${user.id}::bigint`;
		const base = userResult(user);
		return {
			data: {
				user_result_by_screen_name: {
					result: {
						...base,
						rest_id: user.id,
						identity_profile_labels_highlighted_label: base.affiliates_highlighted_label,
						about_profile: {
							affiliate_username: user.org?.screen_name ?? null,
							account_based_in: extra.based_in_override ?? basedIn(extra.country, extra.location_pref),
							...(extra.signup_country && countryName(extra.signup_country) ? { created_country: countryName(extra.signup_country), created_country_accurate: true } : {}),
							...(extra.source ? { source: extra.source } : {}),
							learn_more_url: `${PUBLIC_ORIGIN}/rules`,
							location_accurate: true,
							username_changes: { count: String(extra.changes), ...(extra.last_change ? { last_changed_at_msec: String(extra.last_change.getTime()) } : {}) },
						},
					},
				},
			},
		};
	},
	UserByRestId: async (v, vars) => {
		const user = await userById(v.id, userId(vars));
		if (user?.status === "suspended") return { data: { user: { result: SUSPENDED_USER } } };
		return { data: user ? { user: { result: userResult(user) } } : {} };
	},
	UsersByRestIds: async (v, vars) => {
		const ids: unknown[] = Array.isArray(vars.userIds) ? vars.userIds.slice(0, 100) : [];
		const users = await Promise.all(ids.filter(isId).map((id) => userById(v.id, id)));
		return { data: { users: users.filter((u) => u !== undefined).map((u) => ({ result: userResult(u) })) } };
	},
	// the account menu's badges and avatars for the other signed-in accounts
	UsersVerifiedAvatars: async (v, vars) => {
		const ids: unknown[] = Array.isArray(vars.userIds) ? vars.userIds.slice(0, 10) : [];
		const users = await Promise.all(ids.filter(isId).map((id) => userById(v.id, id)));
		return { data: { usersResults: users.filter((u) => u !== undefined).map((u) => ({ result: userResult(u) })) } };
	},
	UserTweets: profileFeed(false, "both"),
	UserRepostsTimeline: profileFeed(false, "reposts"),
	TopicByRestId: async (v, vars) => {
		const t = await topicById(v.id, String(vars.topicId ?? ""));
		return { data: t ? { topic: topicResult(t) } : {} };
	},
	TopicFollow: topicState("follow"),
	TopicUnfollow: topicState("unfollow"),
	TopicNotInterested: topicState("not_interested"),
	TopicUndoNotInterested: topicState("undo_not_interested"),
	TopicToFollowSidebar: async (v) => {
		const topics = await suggestedTopics(v.id);
		const entries = topics.length
			? [
					{
						entryId: "topics-to-follow",
						sortIndex: "1",
						content: {
							__typename: "TimelineTimelineModule",
							entryType: "TimelineTimelineModule",
							displayType: "Vertical",
							header: { text: "Topics to follow", sticky: false },
							items: topics.map((t) => ({
								entryId: `topics-to-follow-topic-${t.id}`,
								item: { itemContent: { __typename: "TimelineTopic", itemType: "TimelineTopic", topic: topicResult(t), topicDisplayType: "Pill", topicFunctionalityType: "Recommendation" } },
							})),
						},
					},
				]
			: [];
		return { data: { user: { result: { __typename: "User", timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } } } };
	},
	PinReply: pinReply(true),
	UnpinReply: pinReply(false),
	PinTweet: async (v, vars) => {
		if (!(await setPinned(v.id, postId(vars)))) throw new PostError("You can only pin your own posts.", 144);
		return { data: { pin_one_tweet: { result: "Done" } } };
	},
	UnpinTweet: async (v) => {
		await setPinned(v.id, null);
		return { data: { unpin_one_tweet: { result: "Done" } } };
	},
	// what the posts tab of this build actually requests
	UserOriginalsTimeline: profileFeed(false, "both"),
	UserTweetsAndReplies: profileFeed(true, "both"),
	Likes: likes,
	BlockedAccountsAll: relationList("blocks"),
	BlockedAccountsImported: relationList("none"),
	MutedAccounts: relationList("mutes"),
	// an organisation's Affiliates tab
	UserBusinessProfileTeamTimeline: async (viewer, vars) => {
		const users = vars.cursor ? [] : await affiliatesOf(viewer.id, userId(vars));
		const base = BigInt(newId());
		return userTimeline(wholeList(users.map((u, i) => userEntry(u, (base - BigInt(i) - 1n).toString())), base));
	},
	Retweeters: reactors("reposts", "retweeters_timeline"),
	Favoriters: reactors("likes", "favoriters_timeline"),
	Following: follows("following"),
	Followers: follows("followers"),
	BlueVerifiedFollowers: follows("verified_followers"),
	UserMedia: userMedia("any"),
	UserPhotoTimeline: userMedia("photo"),
	UserVideoTimeline: userMedia("video"),
	UserRepliesTimeline: profileFeed(true, "posts", true),
	UserHighlightsTweets: async (v, vars) => {
		const posts = vars.cursor ? [] : await highlightedPosts(v.id, userId(vars));
		const base = BigInt(newId());
		return userTimeline([...posts.map((p, i) => tweetEntry(p, (base - BigInt(i) - 1n).toString())), ...wholeList([], base).slice(0)]);
	},
	// the sheet behind "Add/remove from Highlights": is this post one of the viewer's highlights
	HighlightTweetSheetQuery: async (v, vars) => {
		const id = postId(vars);
		const [row] = await sql`select 1 from highlights where user_id = ${v.id}::bigint and post_id = ${id}::bigint`;
		return { data: { tweet_result_by_rest_id: { result: { __typename: "Tweet", id: Buffer.from(`Tweet:${id}`).toString("base64"), rest_id: id, highlights_info: { highlighted: !!row } } } } };
	},
	// who-can-reply choices beyond the built-in ones: none here
	ConversationControlsQuery: () => ({ data: { get_conversation_control_settings: { settings: [] } } }),
	CreateHighlight: async (v, vars) => ({ data: { tweet_highlights_put: { success: await setHighlight(v.id, postId(vars), true) } } }),
	DeleteHighlight: async (v, vars) => ({ data: { tweet_highlights_delete: { success: await setHighlight(v.id, postId(vars), false) } } }),

	// features that do not exist here: valid empty answers so the client stays quiet
	// Relay keeps what this answers under user_result_by_screen_name(screen_name),
	// the same record "About this account" reads; answering nothing stored the
	// account as null, and the About card then said it doesn't exist.
	ProfileSpotlightsQuery: async (v, vars) => {
		const user = typeof vars.screen_name === "string" ? await userByName(v.id, vars.screen_name) : undefined;
		if (!user) return { data: { user_result_by_screen_name: null } };
		return { data: { user_result_by_screen_name: { id: globalId("UserResults", user.id), result: { ...userResult(user), profilemodules: { v1: [] } } } } };
	},
	UserSportsProfile: () => ({ data: {} }),
	isEligibleForVoButtonUpsellQuery: () => ({ data: {} }),
	usePremiumPaywallOnLoadMutation: () => ({ data: {} }),
	ViewerBadgeCounts: async (v) => ({
		data: {
			viewer_v2: {
				user_results: {
					result: {
						__typename: "User",
						badge_counts: await (async () => {
							const n = await unreadCount(v.id);
							return { dm_unread_count: 0, is_from_urt: true, ntab_unread_count: n, total_unread_count: n, xchat_unread_count: 0 };
						})(),
					},
				},
			},
		},
	}),
	DataSaverMode: () => ({ data: { viewer: {} } }),
	CreatorStudioTabBarItemQuery: () => ({ data: { xpayments_audience_rewards_tasks: [] } }),
	SidebarUserRecommendations: async (v: Viewer, vars: Vars) => {
		// on someone's profile: accounts like theirs
		const like = isId(vars.profileUserId) && vars.profileUserId !== v.id ? vars.profileUserId : undefined;
		const users = await suggestedUsers(v.id, 3, [], like);
		return { data: { sidebar_user_recommendations: users.map((u) => ({ token: `xitter-${u.id}`, user_results: { result: userResult(u) } })) } };
	},
	// the Follow page
	ConnectTabTimeline: async (v: Viewer, vars: Vars) => {
		const users = vars.cursor ? [] : await suggestedUsers(v.id, 40);
		const base = BigInt(newId());
		const entries = users.map((u, i) => userEntry(u, (base - BigInt(i) - 1n).toString()));
		return { data: { connect_tab_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries: wholeList(entries, base) }] } } } };
	},
	useStoryTopicQuery: () => ({ data: { story_topic: { id: globalId("StoryTopic", "For You"), stories: { items: [] } } } }),
	useFetchProductSubscriptionsQuery: () => ({ data: { viewer_v2: { list_product_subscriptions: [] } } }),
	useSubscriptionsPaymentFailureQuery: (v) => ({
		data: {
			viewer_v2: {
				user_results: {
					id: globalId("UserResults", v.id),
					result: { __typename: "User", failed_payments: { failed_payments: [] }, id: globalId("User", v.id) },
				},
			},
		},
	}),
	NflScoresSidebarFollow: () => ({ data: { viewer: { user: { is_following_sports_league: { is_following: false } } } } }),
	SportsLeagueFollow: () => ({ data: { viewer: { user: { is_following_sports_league: { is_following: false } } } } }),
	FetchScheduledTweets: () => ({ data: { viewer: { scheduled_tweet_list: [] } } }),
	FetchDraftTweets: () => ({ data: { viewer: { draft_list: { response_data: [] } } } }),
	getAltTextPromptPreference: () => ({ data: {} }),
	grokAccountJwtQuery: () => ({ data: {} }),
};

// articles: the editor's operations, the redirect from /i/article/<id> and the profile tab
const articleId = (vars: Vars, key = "articleEntityId") => {
	const id = vars[key];
	if (!isId(id)) throw new PostError("Article not found.", 34);
	return id;
};
// the editor and its preview render a published article through its post,
// so the post goes into the article's metadata in full
async function withPost<T extends articles.ArticleEntity | undefined>(viewerId: string, article: T): Promise<T> {
	const ref = article?.metadata?.tweet_results;
	if (!ref) return article;
	const post = await getPost(viewerId, ref.rest_id);
	if (post) ref.result = tweetResult(post) as any;
	return article;
}

const articleHandlers: Record<string, Handler> = {
	ArticleEntityDraftCreate: async (v, vars) => ({
		data: { articleentity_create_draft: { article_entity_results: { result: await withPost(v.id, await articles.createDraft(v.id, vars.title, vars.content_state)) } } },
	}),
	ArticleEntityResultByRestId: async (v, vars) => {
		const article = await withPost(v.id, await articles.getArticle(v.id, articleId(vars)));
		return { data: article ? { article_result_by_rest_id: { result: article } } : {} };
	},
	ArticleRedirectScreenQuery: async (v, vars) => {
		const article = await articles.getArticle(v.id, articleId(vars), false);
		return { data: { article_result_by_rest_id: article ? { result: article } : {} } };
	},
	ArticleEntityUpdateTitle: async (v, vars) => ({ data: { articleentity_update_title: await withPost(v.id, await articles.updateTitle(v.id, articleId(vars), vars.title)) } }),
	ArticleEntityUpdateContent: async (v, vars) => ({
		data: { articleentity_update_content_state: await withPost(v.id, await articles.updateContent(v.id, articleId(vars, "article_entity"), vars.content_state)) },
	}),
	ArticleEntityUpdateCoverMedia: async (v, vars) => ({
		data: { articleentity_update_cover_media: await withPost(v.id, await articles.updateCover(v.id, articleId(vars), (vars.coverMedia as any)?.media_id)) },
	}),
	ArticleEntityPublish: async (v, vars) => {
		const text = typeof vars.tweetText === "string" ? vars.tweetText : "";
		const result = await withPost(v.id, await articles.publish(v.id, articleId(vars), text, (t, id) => createPost(v.id, t, { articleId: id, source: v.postSource })));
		return { data: { articleentity_publish: { article_entity_results: { result } } } };
	},
	ArticleEntityUnpublish: async (v, vars) => ({
		data: { articleentity_unpublish: { article_entity_results: { result: await articles.unpublish(v.id, articleId(vars)) } } },
	}),
	ArticleEntityDelete: async (v, vars) => {
		await articles.deleteArticle(v.id, articleId(vars));
		return { data: { articleentity_delete: "Done" } };
	},
	ArticleEntitiesSlice: async (v, vars) => {
		const owner = isId(vars.userId) ? vars.userId : v.id;
		const slice = await articles.slice(v.id, owner, String(vars.lifecycle ?? "Draft"), vars.cursor);
		const items = await Promise.all(slice.items.map((a) => withPost(v.id, a)));
		const next = slice.next;
		return {
			data: {
				user: {
					result: {
						__typename: "User",
						articles_article_mixer_slice: {
							items: items.map((result) => ({ article_entity_results: { result } })),
							slice_info: next ? { next_cursor: next } : {},
						},
					},
				},
			},
		};
	},
	UserArticlesTweets: profileFeed(false, "posts", false, true),
};
Object.assign(handlers, articleHandlers);

// Search results. Latest pages by post id ("b<id>"), Top and People by offset ("o<n>").
// Top starts with a few matching accounts, as on X.
const searchTimeline = (instructions: unknown[]) => ({ data: { search_by_raw_query: { search_timeline: { timeline: { instructions } } } } });

async function search(viewer: Viewer, vars: Vars) {
	const query = typeof vars.rawQuery === "string" ? vars.rawQuery.slice(0, 500) : "";
	const product = String(vars.product ?? "Top");
	const count = Math.min(Math.max(Number(vars.count) || 20, 1), 50);
	const cursor = typeof vars.cursor === "string" ? vars.cursor : "";
	if (cursor.startsWith("t")) return searchTimeline([]);
	const offset = /^o(\d{1,6})$/.exec(cursor) ? Number(cursor.slice(1)) : 0;
	const before = /^b(\d{1,19})$/.exec(cursor) ? cursor.slice(1) : undefined;
	const entries: unknown[] = [];
	const base = BigInt(newId());
	const sort = (i: number) => (base - BigInt(i) - 10n).toString();
	let next: string | undefined;

	if (product === "People") {
		const ids = await searchUsers(viewer.id, query, count, offset);
		const users = await usersByIds(viewer.id, ids);
		ids.forEach((id, i) => users.get(id) && entries.push(userEntry(users.get(id)!, sort(i))));
		if (ids.length === count) next = `o${offset + count}`;
	} else if (product === "Media") {
		const ids = await searchPosts(query, { viewerId: viewer.id, top: false, media: true, limit: count, before });
		const posts = await postsByIds(viewer.id, ids);
		const list = ids.map((id) => posts.get(id)).filter((p) => !!p);
		if (list.length) {
			if (before) {
				const last = ids[ids.length - 1];
				return searchTimeline([gridAppend(list, "search-grid-0"), { type: "TimelineAddEntries", entries: [cursorEntry("Bottom", `b${last}`, sort(count + 1))] }]);
			}
			entries.push(gridEntry(list, sort(0), "search-grid-0"));
		}
		if (ids.length === count) next = `b${ids[ids.length - 1]}`;
	} else if (product === "Latest" || product === "Top") {
		const top = product === "Top";
		if (top && !offset && !/(^|\s)-?\w+:/.test(query)) {
			const userIds = await searchUsers(viewer.id, query, 3);
			const users = await usersByIds(viewer.id, userIds);
			const items = userIds.map((id) => users.get(id)).filter((u) => !!u);
			if (items.length)
				entries.push({
					entryId: "toptabsrpusermodule-0",
					sortIndex: sort(0),
					content: {
						__typename: "TimelineTimelineModule",
						entryType: "TimelineTimelineModule",
						displayType: "Vertical",
						header: { displayType: "Classic", text: "People", sticky: false },
						footer: { displayType: "Classic", text: "View all", landingUrl: { url: `twitter://search/?query=${encodeURIComponent(query)}&src=typed_query&f=user`, urlType: "DeepLink" } },
						items: items.map((u) => ({ entryId: `toptabsrpusermodule-0-user-${u.id}`, item: userEntry(u, "0").content })),
					},
				});
		}
		const ids = await searchPosts(query, { viewerId: viewer.id, top, limit: count, before, offset });
		const posts = await postsByIds(viewer.id, ids);
		ids.forEach((id, i) => posts.get(id) && entries.push(tweetEntry(posts.get(id)!, sort(i + 1))));
		if (ids.length === count) next = top ? `o${offset + count}` : `b${ids[ids.length - 1]}`;
	}
	entries.push(cursorEntry("Top", `t${base}`, (base + 1n).toString()));
	entries.push(cursorEntry("Bottom", next ?? "end", sort(count + 1)));
	return searchTimeline([{ type: "TimelineAddEntries", entries }]);
}

const trendItem = (t: { tag: string; posts: number }, i: number, label = "Trending") => ({
	__typename: "TimelineTrend",
	itemType: "TimelineTrend",
	name: t.tag,
	rank: String(i + 1),
	trend_url: { url: `twitter://search/?query=${encodeURIComponent(t.tag)}&src=trend_click&vertical=trends`, urlType: "DeepLink" },
	trend_metadata: { domain_context: label, meta_description: `${t.posts} post${t.posts === 1 ? "" : "s"}` },
});

// Explore: hashtags used most in the last week, as trends, from where the
// viewer's Explore settings say
async function explorePage(viewer: Viewer) {
	const scope = await trendScope(viewer.id);
	const trends = await trendingHashtags(7, 20, scope);
	const base = BigInt(newId());
	const entries: unknown[] = trends.map((t, i) => ({
		entryId: `trend-${t.tag.slice(1)}`,
		sortIndex: (base - BigInt(i)).toString(),
		content: { __typename: "TimelineTimelineItem", entryType: "TimelineTimelineItem", itemContent: trendItem(t, i, scope.label) },
	}));
	const cards = await activeCards();
	if (cards.length) entries.unshift(cardsEntry(cards, (base + 1n).toString()));
	const timeline = { instructions: [{ type: "TimelineAddEntries", entries }] };
	return { data: { explore_page: { id: globalId("ExplorePage", "explore"), body: { __typename: "Timeline", timeline } } } };
}

// the "What's happening" box beside every page: the top few trends
async function exploreSidebar(viewer: Viewer) {
	const scope = await trendScope(viewer.id);
	const trends = await trendingHashtags(7, 5, scope);
	const id = newId();
	const entries = trends.length
		? [
				{
					entryId: `trend-${id}`,
					sortIndex: id,
					content: {
						__typename: "TimelineTimelineModule",
						entryType: "TimelineTimelineModule",
						displayType: "Vertical",
						header: { displayType: "Classic", text: "What’s happening" },
						footer: { displayType: "Classic", text: "Show more", landingUrl: { url: "twitter://explore", urlType: "DeepLink" } },
						items: trends.map((t, i) => ({ entryId: `trend-${id}-trend-${t.tag}`, item: { itemContent: trendItem(t, i, scope.label) } })),
					},
				},
			]
		: [];
	const instructions = [{ type: "TimelineClearCache" }, { type: "TimelineAddEntries", entries }];
	return { data: { explore_sidebar: { timeline: { instructions, responseObjects: { feedbackActions: [] } } } } };
}

// the versions of an edited post, newest first; the client opens it from "Last edited"
async function editHistory(viewer: Viewer, vars: Vars) {
	const post = await getPost(viewer.id, postId(vars, "tweetId"));
	if (!post) throw new PostError("Post not found.", 144);
	const versions = await postsByIds(viewer.id, post.versionIds ?? []);
	const chain = [post, ...[...(post.versionIds ?? [])].reverse().flatMap((id) => (versions.has(id) ? [versions.get(id)!] : []))];
	const base = BigInt(newId());
	const entries = chain.map((p, i) => tweetEntry(p, (base - BigInt(i) - 1n).toString()));
	return { data: { tweet_result_by_rest_id: { result: { __typename: "Tweet", rest_id: post.id, edit_history_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } } } };
}

Object.assign(handlers, {
	SearchTimeline: (v: Viewer, vars: Vars) => search(v, vars),
	TweetEditHistory: editHistory,
	ExplorePage: (v: Viewer) => explorePage(v),
	ExploreSidebar: (v: Viewer) => exploreSidebar(v),
} satisfies Record<string, Handler>);

// the chat app's operations
Object.assign(handlers, chatHandlers);
Object.assign(handlers, noteHandlers);
Object.assign(handlers, listHandlers);
Object.assign(handlers, communityHandlers);
Object.assign(handlers, bookmarkFolderHandlers);
Object.assign(handlers, scheduledHandlers);
Object.assign(handlers, gifHandlers);
Object.assign(handlers, analyticsHandlers);
Object.assign(handlers, delegationHandlers);

// The signed-in account. The page carries it already (shell.ts); the client
// asks when it builds its view of an account a delegate switches into, and
// checks the answer is that account (delegation.ts).
Object.assign(handlers, {
	Viewer: async (v: Viewer) => {
		const u = await userById(v.id, v.id);
		if (!u) throw new PostError("User not found.", 50);
		return {
			data: {
				is_super_follow_subscriber: false,
				viewer: { create_community_action_result: { __typename: "CommunityCreateAction" }, user_features: [], user_results: { result: userResult(u) } },
			},
		};
	},
	GetUserClaims: () => ({ data: { viewer_v2: { claims: [] } } }),
} satisfies Record<string, Handler>);
Object.assign(handlers, automationHandlers);

export const knownOperation = (name: string) => name in handlers;

// an operation's result as the client would get it, for the public API
// (public-api.ts); errors are thrown as they are
export const callOperation = (name: string, viewer: Viewer, vars: Vars) => handlers[name](viewer, vars);

export async function runOperation(name: string, viewer: Viewer, vars: Vars): Promise<Response> {
	try {
		return Response.json(await handlers[name](viewer, vars));
	} catch (e) {
		// the chat app reads these as they are
		if (e instanceof ChatError) return Response.json({ errors: [{ message: e.message, code: e.code }], data: {} });
		// the main client takes the code from extensions and shows the message
		// after its first ": ", as in X's "_Missing: No status found with that ID."
		if (e instanceof PostError || e instanceof articles.ArticleError) {
			const missing = e.code === 144;
			return Response.json({
				errors: [{ message: `${missing ? "_Missing" : "Error"}: ${e.message}`, code: e.code, kind: missing ? "NotFound" : "Validation",
					extensions: { name: "GenericError", source: "Server", code: e.code, kind: missing ? "NotFound" : "Validation" } }],
				data: {},
			});
		}
		throw e;
	}
}
