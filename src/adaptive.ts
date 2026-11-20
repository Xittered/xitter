// The REST API of 2020-era clients (client/old/): "adaptive" timelines under
// /2/timeline/*, /2/notifications/*, /2/search/adaptive and the 1.1 actions.
// Each one runs the GraphQL operation the current client uses and reshapes its
// answer, so nothing here decides what a timeline holds.
// Adaptive shape: every post and user once in globalObjects, the timeline only
// points at them by id.

import type { Viewer } from "./auth";
import { trendScope } from "./explore-settings";
import { ArticleError } from "./articles";
import { callOperation } from "./graphql";
import { PostError } from "./posts";
import { RateLimitError, limitedResponse } from "./ratelimit";
import { ReplyControlError } from "./reply-controls";
import { cachedTrends } from "./search";
import { legacyDmRoute, legacyUnreadCount } from "./legacy-dm";
import { restRoute } from "./rest";
import { oldAvatar, oldVerified } from "./model";

type Obj = Record<string, any>;
type Globals = { tweets: Obj; users: Obj; notifications: Obj };
const globals = (): Globals => ({ tweets: {}, users: {}, notifications: {} });

const addUser = (g: Globals, u: Obj | undefined): string | undefined => {
	if (!u?.rest_id) return undefined;
	g.users[u.rest_id] = legacyFromResult(u);
	return u.rest_id;
};

// this client knows only twitter.com as its own; an x.com link would leave the app
const ownLink = (url: unknown) => (typeof url === "string" ? url.replace(/^https:\/\/x\.com(?=\/)/, "https://twitter.com") : url);

// a TimelineNotification (follows, likes, reposts) as the 2020 notification object
function addNotification(g: Globals, n: Obj): string {
	const t = n.template ?? {};
	g.notifications[n.id] = {
		id: n.id,
		timestampMs: String(n.timestamp_ms ?? Date.now()),
		icon: { id: n.notification_icon ?? "bird_icon" },
		message: {
			text: n.rich_message?.text ?? "",
			rtl: !!n.rich_message?.rtl,
			entities: (n.rich_message?.entities ?? []).map((e: Obj) => {
				const id = addUser(g, e.ref?.user_results?.result);
				return { fromIndex: e.fromIndex, toIndex: e.toIndex, ref: id ? { user: { id } } : {} };
			}),
		},
		template: {
			aggregateUserActionsV1: {
				targetObjects: (t.target_objects ?? []).map((o: Obj) => ({ tweet: { id: addTweet(g, o.tweet_results?.result) } })).filter((o: Obj) => o.tweet.id),
				fromUsers: (t.from_users ?? []).map((o: Obj) => ({ user: { id: addUser(g, o.user_results?.result) } })).filter((o: Obj) => o.user.id),
			},
		},
	};
	return n.id;
}

// a GraphQL user result as the old REST user record (model.ts legacyUser)
function legacyFromResult(u: Obj): Obj {
	const rel = u.relationship_perspectives ?? {};
	return {
		id: Number(u.rest_id),
		id_str: u.rest_id,
		name: u.core?.name ?? "",
		screen_name: u.core?.screen_name ?? "",
		location: u.location?.location ?? "",
		description: u.profile_bio?.description ?? "",
		url: u.website?.url || null,
		entities: u.profile_bio?.entities ?? { description: { urls: [] } },
		protected: !!u.privacy?.protected,
		followers_count: u.relationship_counts?.followers ?? 0,
		friends_count: u.relationship_counts?.following ?? 0,
		listed_count: 0,
		created_at: u.core?.created_at,
		favourites_count: u.action_counts?.favorites_count ?? 0,
		statuses_count: u.tweet_counts?.tweets ?? 0,
		media_count: u.tweet_counts?.media_tweets ?? 0,
		verified: oldVerified(!!u.is_blue_verified, u.verification?.verified_type ?? u.verified_type, u.affiliates_highlighted_label?.label, u.xitter_badges),
		profile_image_url_https: oldAvatar(u.avatar?.image_url, u.profile_image_shape),
		...(u.banner?.image_url ? { profile_banner_url: u.banner.image_url } : {}),
		pinned_tweet_ids_str: u.pinned_items?.tweet_ids_str ?? [],
		default_profile: false,
		default_profile_image: false,
		has_extended_profile: false,
		// 2020 DMs (legacy-dm.ts) take anyone not blocked; sending checks that
		can_dm: true,
		can_media_tag: u.media_permissions?.can_media_tag ?? true,
		following: !!rel.following,
		followed_by: !!rel.followed_by,
		blocking: !!rel.blocking,
		blocked_by: !!rel.blocked_by,
		muting: !!rel.muting,
		follow_request_sent: !!u.follow_request_sent,
		notifications: !!u.notifications_settings?.notifications_enabled,
		translator_type: u.profile_translation?.translator_type ?? "none",
		advertiser_account_type: "none",
		profile_interstitial_type: "",
	};
}

// a GraphQL tweet result into globalObjects, with whatever it reposts or quotes;
// gives the post's id, or nothing for a tombstone
function addTweet(g: Globals, raw: Obj | undefined): string | undefined {
	const r = raw?.__typename === "TweetWithVisibilityResults" ? raw.tweet : raw;
	if (!r?.legacy || !r.rest_id) return undefined;
	const user = r.core?.user_results?.result;
	addUser(g, user);
	const t: Obj = { ...r.legacy, id: Number(r.rest_id), id_str: r.rest_id };
	const rt = addTweet(g, r.legacy.retweeted_status_result?.result);
	delete t.retweeted_status_result;
	if (rt) t.retweeted_status_id_str = rt;
	const qt = addTweet(g, r.quoted_status_result?.result);
	if (qt) {
		t.quoted_status_id_str = qt;
		t.is_quote_status = true;
	}
	// a long post's text lives in note_tweet; the old client shows full_text only
	const note = r.note_tweet?.note_tweet_results?.result;
	if (note?.text) {
		t.full_text = note.text;
		t.display_text_range = [0, [...note.text].length];
	}
	t.user_id_str ??= user?.rest_id;
	if (r.card?.legacy) t.card = { ...r.card.legacy, binding_values: Object.fromEntries((r.card.legacy.binding_values ?? []).map((b: Obj) => [b.key, b.value])) };
	g.tweets[r.rest_id] = t;
	return r.rest_id;
}

const tweetEntry = (id: string, sortIndex: string, entryId = `tweet-${id}`) => ({
	entryId,
	sortIndex,
	content: { item: { content: { tweet: { id, displayType: "Tweet" } } } },
});

// one URT entry into adaptive entries (a conversation module becomes its posts)
function convertEntry(g: Globals, e: Obj): Obj[] {
	const c = e.content ?? {};
	if (c.entryType === "TimelineTimelineCursor" || c.__typename === "TimelineTimelineCursor")
		return [{ entryId: e.entryId, sortIndex: e.sortIndex, content: { operation: { cursor: { value: c.value, cursorType: c.cursorType } } } }];
	if (c.itemContent?.__typename === "TimelineNotification") {
		const n = c.itemContent;
		return [{
			entryId: e.entryId,
			sortIndex: e.sortIndex,
			content: { item: { content: { notification: { id: addNotification(g, n), ...(n.notification_url ? { url: { ...n.notification_url, url: ownLink(n.notification_url.url) } } : {}) } }, clientEventInfo: c.clientEventInfo } },
		}];
	}
	if (c.itemContent?.__typename === "TimelineUser") {
		const id = addUser(g, c.itemContent.user_results?.result);
		return id ? [{ entryId: e.entryId, sortIndex: e.sortIndex, content: { item: { content: { user: { id, displayType: "UserDetailed" } } } } }] : [];
	}
	if (c.itemContent) {
		const id = addTweet(g, c.itemContent.tweet_results?.result);
		return id ? [tweetEntry(id, e.sortIndex, e.entryId)] : [];
	}
	if (Array.isArray(c.items)) {
		const out: Obj[] = [];
		c.items.forEach((it: Obj, k: number) => {
			const id = addTweet(g, it.item?.itemContent?.tweet_results?.result);
			if (id) out.push(tweetEntry(id, (BigInt(e.sortIndex ?? 0) - BigInt(k)).toString()));
		});
		return out;
	}
	return [];
}

// every instructions array anywhere in a GraphQL answer (each op nests it differently)
function findInstructions(o: unknown, depth = 0): Obj[] | undefined {
	if (!o || typeof o !== "object" || depth > 8) return undefined;
	if (Array.isArray((o as Obj).instructions)) return (o as Obj).instructions;
	for (const v of Object.values(o)) {
		const hit = findInstructions(v, depth + 1);
		if (hit) return hit;
	}
	return undefined;
}

function adaptive(answer: unknown, timelineId: string) {
	const g = globals();
	const entries: Obj[] = [];
	const instructions: Obj[] = [];
	for (const ins of findInstructions(answer) ?? []) {
		if (Array.isArray(ins.entries)) for (const e of ins.entries) entries.push(...convertEntry(g, e));
		else if (ins.type === "TimelineReplaceEntry" && ins.entry) {
			const [entry] = convertEntry(g, ins.entry);
			if (entry) instructions.push({ replaceEntry: { entryIdToReplace: ins.entry_id_to_replace, entry } });
		} else if (ins.type === "TimelinePinEntry" && ins.entry) {
			const [entry] = convertEntry(g, ins.entry);
			if (entry) instructions.push({ pinEntry: { entry } });
		}
	}
	return {
		globalObjects: { tweets: g.tweets, users: g.users, notifications: g.notifications, moments: {}, cards: {}, places: {}, media: {}, broadcasts: {}, topics: {}, lists: {} },
		timeline: { id: timelineId, instructions: [{ addEntries: { entries } }, ...instructions] },
	};
}

// GraphQL answers for an old client: its user readers take everything from
// `legacy` (screen_name, counts, following...), which the current shape moved to
// core, relationship_perspectives and the rest
export function legacyGraphql(json: unknown, depth = 0): unknown {
	if (!json || typeof json !== "object" || depth > 40) return json;
	if (Array.isArray(json)) return json.map((v) => legacyGraphql(v, depth + 1));
	const o = json as Obj;
	const out: Obj = {};
	for (const [k, v] of Object.entries(o)) {
		// 2020 had `user: {...}` where the current API wraps it in `user: { result }`
		const unwrapped = k === "user" && v && typeof v === "object" && "result" in v && Object.keys(v).length === 1 ? (v as Obj).result : v;
		out[k] = legacyGraphql(unwrapped, depth + 1);
	}
	if (o.__typename === "User" && o.rest_id) {
		const old = legacyFromResult(o);
		// our `legacy` has the plain boolean checkmark; the old client's (gold, grey) wins
		out.legacy = { ...old, ...(o.legacy ?? {}), verified: old.verified };
	}
	// 2020 timeline items carry user_result / tweet_result (the object itself),
	// where the current shape has user_results / tweet_results wrapping it in result
	for (const kind of ["user", "tweet"]) {
		const wrapped = out[`${kind}_results`]?.result;
		if (wrapped && !out[`${kind}_result`]) out[`${kind}_result`] = wrapped;
	}
	return out;
}

// where the 2020 client looks for a user's lists: user.followers_timeline,
// where the current answer has user.result.timeline
const USER_TIMELINE_KEYS: Record<string, string> = {
	Followers: "followers_timeline",
	Following: "following_timeline",
	FollowersYouKnow: "friends_following_timeline",
};

// list mutations: 2020 reads each answer under its own key, the current one under `list`
const LIST_KEYS: Record<string, string> = {
	CreateList: "list_create",
	ListAddMember: "list_member_add_v2",
	ListRemoveMember: "list_member_remove_v2",
	ListSubscribe: "list_subscribe_v2",
	ListUnsubscribe: "list_unsubscribe_v2",
	ListPinOne: "list_pin",
	ListUnpinOne: "list_unpin",
};

export function legacyOperation(name: string, json: unknown): unknown {
	const out = legacyGraphql(json) as Obj;
	const listKey = LIST_KEYS[name];
	if (listKey && out?.data?.list && !(listKey in out.data)) out.data[listKey] = out.data.list;
	const key = USER_TIMELINE_KEYS[name];
	const user = out?.data?.user;
	if (key && user && "timeline" in user && !(key in user)) {
		user[key] = user.timeline;
		delete user.timeline;
	}
	return out;
}

// the GIF picker's category tiles; each opens a search for its name
const GIF_CATEGORIES = ["trending", "Agree", "Applause", "Awww", "Dance", "Facepalm", "Happy", "High five", "Hugs", "Mic drop", "No", "OMG", "Thumbs up", "Yes"];

// a GIF result of gifs.ts as a 2020 foundmedia item
function oldGif(it: Obj): Obj {
	const [provider, ...rest] = String(it.id ?? "").split("_");
	return {
		// the picker keys its rows by these, so each must be unique
		id: it.id,
		url: it.full_image?.url,
		alt_text: it.alt_text ?? "",
		provider: { name: it.provider?.id ?? provider, display_name: it.provider?.display_name ?? provider },
		found_media_origin: { provider: it.provider?.id ?? provider, id: rest.join("_") },
		original_image: it.full_image,
		preview_image: it.preview_image,
		thumbnail_images: it.thumbnail_images ?? [it.preview_image],
	};
}

// a GraphQL list as the 1.1 list record (lists/members/create answers with one)
function restList(l: Obj): Obj {
	const owner = l.user_results?.result;
	return {
		id: Number(l.id_str),
		id_str: l.id_str,
		name: l.name,
		uri: owner ? `/${owner.core?.screen_name}/lists/${l.id_str}` : `/i/lists/${l.id_str}`,
		slug: l.id_str,
		description: l.description ?? "",
		mode: String(l.mode ?? "Public").toLowerCase(),
		member_count: l.member_count ?? 0,
		subscriber_count: l.subscriber_count ?? 0,
		created_at: new Date(Number(l.created_at) || Date.now()).toUTCString(),
		following: !!l.following,
		user: owner ? legacyFromResult(owner) : undefined,
	};
}

async function form(req: Request): Promise<Record<string, string>> {
	const text = await req.text().catch(() => "");
	return Object.fromEntries(new URLSearchParams(text));
}

// a post as statuses/update and favorites/create return it: the record with its user inside
async function oneTweet(viewer: Viewer, id: string) {
	const answer = await callOperation("TweetDetail", viewer, { focalTweetId: id });
	const g = globals();
	for (const ins of findInstructions(answer) ?? []) for (const e of ins.entries ?? []) convertEntry(g, e);
	const t = g.tweets[id];
	return t ? { ...t, user: g.users[t.user_id_str] } : { id_str: id };
}

const TIMELINES: [RegExp, (m: RegExpExecArray, q: URLSearchParams) => [string, Obj, string]][] = [
	[/^\/2\/timeline\/home\.json$/, (_, q) => ["HomeTimeline", page(q), "home"]],
	[/^\/2\/timeline\/home_latest\.json$/, (_, q) => ["HomeLatestTimeline", page(q), "home_latest"]],
	[/^\/2\/timeline\/profile\/(\d{1,19})\.json$/, (m, q) => [q.get("include_tweet_replies") === "true" ? "UserTweetsAndReplies" : "UserTweets", { ...page(q), userId: m[1] }, `profile-${m[1]}`]],
	[/^\/2\/timeline\/media\/(\d{1,19})\.json$/, (m, q) => ["UserMedia", { ...page(q), userId: m[1] }, `media-${m[1]}`]],
	[/^\/2\/timeline\/favorites\/(\d{1,19})\.json$/, (m, q) => ["Likes", { ...page(q), userId: m[1] }, `favorites-${m[1]}`]],
	[/^\/2\/timeline\/conversation\/(\d{1,19})\.json$/, (m, q) => ["TweetDetail", { focalTweetId: m[1], ...(q.get("cursor") ? { cursor: q.get("cursor") } : {}) }, `conversation-${m[1]}`]],
	[/^\/2\/timeline\/bookmark\.json$/, (_, q) => ["Bookmarks", page(q), "bookmarks"]],
	[/^\/2\/timeline\/list\.json$/, (_, q) => ["ListLatestTweetsTimeline", { ...page(q), listId: q.get("list_id") ?? "" }, `list-${q.get("list_id")}`]],
	[/^\/2\/timeline\/list_recommended_users\.json$/, (_, q) => (q.get("list_id") ? ["ListEditRecommendedUsers", { ...page(q), listId: q.get("list_id") }, "list-recommended"] : ["ListCreationRecommendedUsers", page(q), "list-recommended"])],
	[/^\/2\/notifications\/(all|mentions|verified)\.json$/, (m, q) => ["NotificationsTimeline", { ...page(q), timeline_type: m[1] === "all" ? "All" : m[1] === "mentions" ? "Mentions" : "Verified" }, `notifications-${m[1]}`]],
	[/^\/2\/search\/adaptive\.json$/, (_, q) => ["SearchTimeline", { ...page(q), rawQuery: q.get("q") ?? "", product: q.get("tweet_search_mode") === "live" ? "Latest" : q.get("result_filter") === "user" ? "People" : q.get("result_filter") === "image" ? "Media" : "Top" }, "search"]],
];
const page = (q: URLSearchParams) => ({ count: Number(q.get("count")) || 20, ...(q.get("cursor") ? { cursor: q.get("cursor") } : {}) });

// The operations refuse by throwing (a blocked word, a post that's gone, a
// limit used up); as 1.1 errors, which this client shows
export async function adaptiveRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	try {
		return await route(method, path, viewer, req);
	} catch (e) {
		if (e instanceof RateLimitError) return limitedResponse(e.hit);
		if (e instanceof PostError || e instanceof ReplyControlError || e instanceof ArticleError)
			return Response.json({ errors: [{ code: e.code, message: e.message }] }, { status: e.code === 144 ? 404 : 403 });
		if (e instanceof URIError) return Response.json({ errors: [{ code: 214, message: "Bad request." }] }, { status: 400 });
		throw e;
	}
}

async function route(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	if (!path.startsWith("/2/") && !path.startsWith("/1.1/")) return undefined;
	// its direct messages (legacy-dm.ts)
	const dm = await legacyDmRoute(method, path, viewer, req);
	if (dm) return dm;
	// the people search under New message only offers those with can_dm
	if (method === "GET" && path === "/1.1/search/typeahead.json") {
		const res = await restRoute(method, path, viewer, req);
		if (!res?.ok) return res;
		const body: any = await res.json();
		for (const u of body.users ?? []) u.can_dm = !u.blocking && !u.blocked_by;
		return Response.json(body);
	}
	const q = new URL(req.url).searchParams;
	// Home's next pages come as a POST that lists the posts already seen
	const homePage = method === "POST" && /^\/2\/timeline\/home(?:_latest)?\.json$/.test(path);
	if (method === "GET" || homePage) {
		for (const [re, to] of TIMELINES) {
			const m = re.exec(path);
			if (!m) continue;
			const [op, vars, id] = to(m, q);
			return Response.json(adaptive(await callOperation(op, viewer, vars), id));
		}
		// Explore and the trends box: nothing to show yet, in the shape that says so
		// GIF picker ("foundmedia"): the instance's GIF provider through the same
		// operations the current client uses, in the 2020 shape
		const gifs = /^\/1\.1\/foundmedia\/(categories|categories\/([^/]+)|search)\.json$/.exec(path);
		if (gifs) {
			if (gifs[1] === "categories") {
				const slice: any = await callOperation("GifEnumerateCategory", viewer, { category: "trending", count: GIF_CATEGORIES.length });
				const stills = (slice?.data?.gif_enumerate_category_slice?.items ?? []).map((it: Obj) => it.full_image);
				return Response.json({
					data: { groups: GIF_CATEGORIES.map((name, i) => ({ type: "category", id: name, display_name: name === "trending" ? "Trending" : name, original_image: stills[i % Math.max(stills.length, 1)] ?? { url: "", still_image_url: "", width: 1, height: 1 } })) },
				});
			}
			const cursor = q.get("cursor") ?? undefined;
			const answer: any = gifs[2]
				? await callOperation("GifEnumerateCategory", viewer, { category: decodeURIComponent(gifs[2]), count: q.get("count") ?? 20, cursor })
				: await callOperation("GifSearch", viewer, { rawQuery: q.get("q") ?? "", count: q.get("count") ?? 20, cursor });
			const slice = answer?.data?.gif_enumerate_category_slice ?? answer?.data?.gif_search_slice ?? {};
			return Response.json({ data: { items: (slice.items ?? []).map(oldGif) }, cursor: slice.slice_info?.next_cursor ? { next: slice.slice_info.next_cursor } : {} });
		}
		// Moments: Xitter has none; an empty timeline, with the cursors that tell the client it's done
		if (/^\/2\/moments\/[\w/]+\.json$/.test(path)) {
			const empty = adaptive({}, "moments");
			empty.timeline.instructions[0].addEntries!.entries.push(
				{ entryId: `cursor-top-${Date.now()}`, sortIndex: String(Date.now()), content: { operation: { cursor: { value: "top", cursorType: "Top" } } } },
				{ entryId: "cursor-bottom-0", sortIndex: "0", content: { operation: { cursor: { value: "bottom", cursorType: "Bottom", stopOnEmptyResponse: true } } } },
			);
			return Response.json(empty);
		}
		// Explore and the "What's happening" box: the week's top hashtags as 2020
		// trend items. With no entries at all Explore says "page doesn't exist", and
		// without cursors it keeps spinning.
		if (/^\/2\/guide(\/.*)?\.json$/.test(path)) {
			const empty = adaptive({}, "guide");
			const now = String(Date.now());
			const scope = await trendScope(viewer.id);
			const trends = await cachedTrends(7, Math.min(Number(q.get("count")) || 20, 30), scope);
			empty.timeline.instructions[0].addEntries!.entries.push(
				...trends.map((t, i) => ({
					entryId: `trend-${t.tag.slice(1)}`,
					sortIndex: String(Number(now) - i - 1),
					content: {
						item: {
							content: {
								trend: {
									name: t.tag,
									rank: String(i + 1),
									url: { url: `twitter://search/?query=${encodeURIComponent(t.tag)}&src=trend_click&vertical=trends`, urlType: "DeepLink" },
									trendMetadata: { domainContext: scope.label, metaDescription: `${t.posts} Tweet${t.posts === 1 ? "" : "s"}` },
								},
							},
						},
					},
				})),
				{ entryId: `cursor-top-${now}`, sortIndex: now, content: { operation: { cursor: { value: `top-${now}`, cursorType: "Top" } } } },
				{ entryId: `cursor-bottom-0`, sortIndex: "0", content: { operation: { cursor: { value: "bottom-0", cursorType: "Bottom", stopOnEmptyResponse: true } } } },
			);
			return Response.json(empty);
		}
		// no saved searches yet; the client sorts this list, so it must be one
		if (path === "/1.1/saved_searches/list.json") return Response.json([]);
		// Settings > Display language; the client sorts this list as well
		if (path === "/1.1/help/languages.json") return Response.json([{ code: "en", name: "English", local_name: "English", status: "production", debug: false }]);
		if (path === "/2/badge_count/badge_count.json") {
			const dms = await legacyUnreadCount(viewer.id);
			return Response.json({ ntab_unread_count: 0, dm_unread_count: dms, total_unread_count: dms, is_from_urt: true });
		}
		return undefined;
	}
	if (method !== "POST") return undefined;
	if (path === "/1.1/branch/init.json") return Response.json({});
	// adding to / removing from a list; user_id may be a comma list (members/create_all)
	const listMember = /^\/1\.1\/lists\/members\/(create|create_all|destroy|destroy_all)\.json$/.exec(path);
	if (listMember) {
		const f = { ...Object.fromEntries(q), ...(await form(req)) };
		const listId = f.list_id ?? "";
		const op = listMember[1].startsWith("create") ? "ListAddMember" : "ListRemoveMember";
		let answer: any;
		for (const userId of String(f.user_id ?? "").split(",").filter(Boolean)) answer = await callOperation(op, viewer, { listId, userId });
		const list = answer?.data?.list ?? (await callOperation("ListByRestId", viewer, { listId }) as any)?.data?.list;
		return Response.json(list ? restList(list) : {});
	}
	const act: Record<string, (f: Record<string, string>) => Promise<string>> = {
		"/1.1/favorites/create.json": async (f) => (await callOperation("FavoriteTweet", viewer, { tweet_id: f.id }), f.id),
		"/1.1/favorites/destroy.json": async (f) => (await callOperation("UnfavoriteTweet", viewer, { tweet_id: f.id }), f.id),
		"/1.1/bookmark/entries/add.json": async (f) => (await callOperation("CreateBookmark", viewer, { tweet_id: f.tweet_id }), f.tweet_id),
		"/1.1/bookmark/entries/remove.json": async (f) => (await callOperation("DeleteBookmark", viewer, { tweet_id: f.tweet_id }), f.tweet_id),
		"/1.1/statuses/update.json": async (f) => {
			const r: any = await callOperation("CreateTweet", viewer, {
				tweet_text: f.status ?? "",
				...(f.in_reply_to_status_id ? { reply: { in_reply_to_tweet_id: f.in_reply_to_status_id, exclude_reply_user_ids: [] } } : {}),
				...(f.attachment_url ? { attachment_url: f.attachment_url } : {}),
				// a poll: the card made beforehand by /v2/cards/create.json
				...(f.card_uri ? { card_uri: f.card_uri } : {}),
				...(f.media_ids ? { media: { media_entities: f.media_ids.split(",").map((media_id) => ({ media_id, tagged_users: [] })) } } : {}),
			});
			return r?.data?.create_tweet?.tweet_results?.result?.rest_id ?? "";
		},
	};
	// the id comes in the path (statuses/retweet/<id>.json) or, from this client, as id= in the body
	const statusAct = /^\/1\.1\/statuses\/(retweet|unretweet|destroy)(?:\/(\d{1,19}))?\.json$/.exec(path);
	if (statusAct) {
		const what = statusAct[1];
		const id = statusAct[2] ?? (await form(req)).id;
		if (!id || !/^\d{1,19}$/.test(id)) return Response.json({ errors: [{ code: 144, message: "No status found with that ID." }] }, { status: 404 });
		if (what === "retweet") await callOperation("CreateRetweet", viewer, { tweet_id: id });
		else if (what === "unretweet") await callOperation("DeleteRetweet", viewer, { source_tweet_id: id });
		else await callOperation("DeleteTweet", viewer, { tweet_id: id });
		return Response.json(await oneTweet(viewer, id).catch(() => ({ id_str: id })));
	}
	const fn = act[path];
	if (!fn) return undefined;
	const id = await fn(await form(req));
	return Response.json(id ? await oneTweet(viewer, id).catch(() => ({ id_str: id })) : {});
}
