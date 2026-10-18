// The few REST endpoints the client still uses next to GraphQL.

import { blockedNameIn, blockedWordIn, forbiddenText, suspendForName } from "./names";
import { hateIn, hateInName } from "./hate";
import { automodStrike } from "./moderation";
import { hasBlockedPhrase } from "./settings";
import { hashflagsJson } from "./hashflags";
import { accountsRoute } from "./accounts";
import type { Viewer } from "./auth";
import { addKeyword, mutedKeywords, removeKeywords, setBlock, setMute, updateKeyword } from "./blocks";
import { sql } from "./db";
import { isFlag } from "./flags";
import { isId } from "./ids";
import { isVerified, legacyUser } from "./model";
import { markSeen } from "./notifications";
import { PollError, createCard, vote } from "./polls";
import { placeById, searchPlaces } from "./places";
import { reportFlow } from "./reports";
import { settingsFor } from "./shell";
import { hashtagsLike, searchUsers } from "./search";
import { STAFF_HANDLE } from "./invites";
import { accountSettingsRoute, changeUsername, revokeSessionsRoute } from "./account-settings";
import { dataExportRoute } from "./data-export";
import { addressBook, deleteContacts, uploadContacts } from "./contacts";
import { exploreSettings, searchLocations, setExploreSettings } from "./explore-settings";
import { loginHistory } from "./login-history";
import { emailInfo, resendConfirmation } from "./email-address";
import { pushSettingsRoute } from "./push";
import { answerRequest, pendingRequests, setFollow, setProtected, suggestedUsers, updateFriendship, userById, userByName, usersByIds } from "./users";

// friendships/show's shape, from the viewer's side (source) and the other account's (target)
async function relationship(viewer: Viewer, targetId: string) {
	const u = await userById(viewer.id, targetId);
	const st = u?.stats;
	return {
		relationship: {
			source: {
				id_str: viewer.id,
				screen_name: viewer.screen_name,
				following: !!st?.followedByViewer,
				followed_by: !!st?.followsViewer,
				following_requested: !!st?.requestedByViewer,
				notifications_enabled: !!st?.notifying,
				want_retweets: !st?.repostsMuted,
				blocking: !!st?.blocking,
				blocked_by: !!st?.blockedBy,
				muting: !!st?.muting,
				can_dm: false,
				all_replies: false,
				marked_spam: false,
			},
			target: { id_str: targetId, screen_name: u?.screen_name ?? "", following: !!st?.followsViewer, followed_by: !!st?.followedByViewer, following_requested: false },
		},
	};
}

const profileError = (message: string) => Response.json({ errors: [{ code: 120, message }] }, { status: 403 });

async function form(req: Request): Promise<Record<string, string>> {
	const f = await req.formData().catch(() => undefined);
	const out: Record<string, string> = {};
	if (f) for (const [k, v] of f) if (typeof v === "string") out[k] = v;
	return out;
}

const changedUser = async (viewer: Viewer) => Response.json(legacyUser((await userById(viewer.id, viewer.id))!));

// account/update_profile, update_profile_image, update_profile_banner, remove_profile_banner,
// and our own update_flag (the pride flag badge, from the picker shell.ts adds to the dialog)
async function profileRoute(path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	const m = /^\/1\.1\/account\/(update_profile|update_profile_image|update_profile_banner|remove_profile_banner|update_flag)\.json$/.exec(path);
	if (!m || req.method !== "POST") return undefined;
	const f = await form(req);

	if (m[1] === "update_profile") {
		const limits: Record<string, [string, number]> = { name: ["name", 50], description: ["bio", 160], location: ["location", 30], url: ["website", 100] };
		// every field is checked before any is saved
		const changes: Record<string, string> = {};
		for (const [field, [column, max]] of Object.entries(limits)) {
			if (!(field in f)) continue;
			const value = f[field].trim();
			if ([...value].length > max) return profileError(`${field} is limited to ${max} characters.`);
			if (field === "name" && !value) return profileError("Name can't be blank.");
			if (field === "url" && value && !/^https?:\/\/\S+$/.test(value)) return profileError("Website must be an http or https address.");
			const hate = field === "name" ? hateInName(value) : hateIn(value);
			if (hate) {
				await automodStrike(viewer.id, hate, field === "name" ? "name" : "profile", value);
				return profileError(field === "name" ? "That name isn't allowed here." : "Your profile contains a slur or hate speech this instance doesn't allow.");
			}
			// a blocked word (names.ts): suspended, staff only refused; the
			// name ignores spacing, the longer fields are read word by word
			if (field === "name" ? blockedNameIn(value) : blockedWordIn(value)) {
				if (!viewer.role) await suspendForName(viewer.id, value);
				return profileError(field === "name" ? "That name isn't allowed here." : "Your profile contains a word this instance doesn't allow.");
			}
			if (hasBlockedPhrase(value)) return profileError("Your profile contains a phrase this instance doesn't allow.");
			changes[column] = value;
		}
		if (Object.keys(changes).length) await sql`update users set ${sql(changes)} where id = ${viewer.id}::bigint`;
		return changedUser(viewer);
	}
	if (m[1] === "update_flag") {
		const flag = f.flag || null;
		if (flag !== null && !isFlag(flag)) return profileError("Unknown flag.");
		await sql`update users set flag = ${flag} where id = ${viewer.id}::bigint`;
		return changedUser(viewer);
	}
	if (m[1] === "remove_profile_banner") {
		await sql`update users set banner_url = null where id = ${viewer.id}::bigint`;
		return changedUser(viewer);
	}
	// the image was uploaded first; only the viewer's own photo upload is accepted
	const mediaId = f.media_id;
	if (!isId(mediaId)) return profileError("Upload the image first and send its media_id.");
	const [media] = await sql`select id from media where id = ${mediaId}::bigint and user_id = ${viewer.id}::bigint`;
	if (!media) return profileError("Unknown upload.");
	if (m[1] === "update_profile_image") await sql`update users set avatar_url = ${`/media/${mediaId}`} where id = ${viewer.id}::bigint`;
	// the client appends a size like /1500x500 to banner addresses
	else await sql`update users set banner_url = ${`/media/banner/${mediaId}`} where id = ${viewer.id}::bigint`;
	return changedUser(viewer);
}

// analytics and ad reporting: accepted and dropped
const TELEMETRY = /\/flow\/|viewer_context|app_context|promoted_content|\/jot\/|csp_report|\/strato\/|\/p2$|update_subscriptions|client_event/;

const EMPTY_LIST = { users: [], next_cursor: 0, next_cursor_str: "0", previous_cursor: 0, previous_cursor_str: "0", total_count: 0 };

// `path` has no /i/api prefix
export async function restRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	// poll cards: created before the post, voted on afterwards
	if (method === "POST" && /^\/v2\/cards\/create\.json$/.test(path)) {
		const form = await req.formData().catch(() => undefined);
		try {
			return Response.json(await createCard(viewer.id, form?.get("card_data")));
		} catch (e) {
			if (e instanceof PollError) return Response.json({ errors: [{ code: 214, message: e.message }] }, { status: e.status });
			throw e;
		}
	}
	if (method === "POST" && path.endsWith("/capi/passthrough/1")) {
		const form = await req.formData().catch(() => undefined);
		try {
			return Response.json(await vote(viewer.id, form ?? new FormData()));
		} catch (e) {
			if (e instanceof PollError) return Response.json({ errors: [{ code: 214, message: e.message }] }, { status: e.status });
			throw e;
		}
	}
	if (method === "GET" && /^\/1\.1\/geo\/(?:places|search)(?:\.json)?$/.test(path)) {
		const q = new URL(req.url).searchParams;
		const num = (k: string) => (q.get(k) === null || Number.isNaN(Number(q.get(k))) ? null : Number(q.get(k)));
		return Response.json({
			places: searchPlaces(q.get("query"), num("lat"), num("long") ?? num("lng"), Math.min(num("max_results") ?? 20, 50)),
			geo_search_request_id: crypto.randomUUID().replace(/-/g, ""),
			attributions: [],
		});
	}
	const geoId = /^\/1\.1\/geo\/id\/([0-9a-f]{16})(?:\.json)?$/.exec(path);
	if (method === "GET" && geoId) {
		const place = placeById(geoId[1]);
		return place ? Response.json(place) : Response.json({ errors: [{ code: 34, message: "Sorry, that page does not exist." }] }, { status: 404 });
	}
	// alt text for an uploaded image, sent before the post is made
	if (method === "POST" && path === "/1.1/media/metadata/create.json") {
		const body: any = await req.json().catch(() => ({}));
		const alt = typeof body?.alt_text?.text === "string" ? body.alt_text.text.slice(0, 1000) : undefined;
		if (alt && forbiddenText(alt)) return Response.json({ errors: [{ code: 186, message: "The description contains a word this instance doesn't allow." }] }, { status: 400 });
		if (/^\d{1,19}$/.test(String(body?.media_id)) && alt !== undefined)
			await sql`update media set alt_text = ${alt || null} where id = ${String(body.media_id)}::bigint and user_id = ${viewer.id}::bigint`;
		const warnings = Array.isArray(body?.sensitive_media_warning) ? body.sensitive_media_warning.filter((w: unknown) => ["adult_content", "graphic_violence", "other"].includes(String(w))) : undefined;
		if (/^\d{1,19}$/.test(String(body?.media_id)) && warnings !== undefined)
			await sql`update media set sensitive_warning = ${warnings.length ? sql.array(warnings, "TEXT") : null} where id = ${String(body.media_id)}::bigint and user_id = ${viewer.id}::bigint`;
		return Response.json({});
	}
	const own = (await accountSettingsRoute(method, path, viewer, req)) ?? (await revokeSessionsRoute(method, path, viewer, req));
	if (own) return own;
	const exported = await dataExportRoute(method, path, viewer, req);
	if (exported) return exported;
	// Settings pages that only read: email on file, personalisation (we keep none)
	// the client keeps this as its "devices" data: a list of emails, confirmed or not
	if (method === "GET" && path === "/1.1/users/email_phone_info.json") return Response.json(await emailInfo(viewer.id));
	if (method === "POST" && path === "/1.1/account/resend_confirmation_email.json") {
		const problem = await resendConfirmation(viewer);
		return problem ? Response.json({ errors: [{ code: 214, message: problem }] }, { status: 400 }) : Response.json({});
	}
	if (method === "GET" && path === "/1.1/account/personalization/p13n_preferences.json")
		return Response.json({ interest_preferences: { disabled_interests: [], partner_interests: [] }, personalization_enabled: false });
	if (method === "GET" && path === "/1.1/account/personalization/p13n_data.json")
		return Response.json({ interests: { interests: [], partner_interests: [], audience_and_advertisers: {} }, demographics: {}, login_history: await loginHistory(viewer.id), location_history: [] });
	// Settings > Connected apps: nothing here signs in other apps for people (no OAuth)
	if (method === "GET" && /^\/1\.1\/oauth\/list(?:\.json)?$/.test(path)) return Response.json({ applications: [] });
	if (method === "POST" && /^\/1\.1\/oauth\/revoke(?:\.json)?$/.test(path)) return Response.json({});
	const accounts = await accountsRoute(method, path, viewer, req);
	if (accounts) return accounts;
	const profile = await profileRoute(path, viewer, req);
	if (profile) return profile;
	const friendship = /^\/1\.1\/friendships\/(create|destroy)\.json$/.exec(path);
	if (friendship && method === "POST") {
		const form = await req.formData().catch(() => undefined);
		const target = form?.get("user_id");
		if (!isId(target)) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		await setFollow(viewer.id, target, friendship[1] === "create");
		const user = await userById(viewer.id, target);
		if (!user) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		return Response.json(legacyUser(user));
	}
	// the profile bell (device=) and "Turn off reposts" (retweets=)
	if (method === "POST" && /^\/1\.1\/friendships\/update(?:\.json)?$/.test(path)) {
		const f = await form(req);
		const target = f.id ?? f.user_id ?? (f.screen_name ? (await userByName(viewer.id, f.screen_name))?.id : undefined);
		const flag = (v: string | undefined) => (v === undefined ? undefined : v === "true" || v === "1");
		if (!isId(target) || !(await updateFriendship(viewer.id, target, { device: flag(f.device), retweets: flag(f.retweets) })))
			return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		return Response.json(await relationship(viewer, target));
	}
	// the account menu asks whether reposts are on before offering to turn them off
	if (method === "GET" && /^\/1\.1\/friendships\/(list|show)(?:\.json)?$/.test(path)) {
		const q = new URL(req.url).searchParams;
		const target = q.get("user_id") ?? q.get("target_id") ?? (q.get("screen_name") ? (await userByName(viewer.id, q.get("screen_name")!))?.id : undefined);
		if (!isId(target)) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		const r = await relationship(viewer, target);
		return Response.json(path.includes("show") ? r : [r]);
	}
	// accounts like another one ("similar_to" the profile being viewed), or plain suggestions
	if (method === "GET" && /^\/1\.1\/users\/recommendations(?:\.json)?$/.test(path)) {
		const q = new URL(req.url).searchParams;
		const like = q.get("user_id");
		const users = await suggestedUsers(viewer.id, Math.min(Math.max(Number(q.get("limit")) || 20, 1), 50), [], isId(like) && like !== viewer.id ? like : undefined);
		return Response.json(users.map((u) => ({ user_id: u.id, token: `xitter-${u.id}`, user: legacyUser(u) })));
	}
	// browser push subscriptions and their switches
	const pushSettings = /^\/1\.1\/notifications\/settings\/(login|checkin|save|logout)(?:\.json)?$/.exec(path);
	if (method === "POST" && pushSettings) {
		const answer = await pushSettingsRoute(viewer.id, pushSettings[1], await req.json().catch(() => ({})));
		if (answer) return answer;
	}
	// Explore settings: where trends come from
	if (method === "GET" && /^\/2\/guide\/get_explore_settings(?:\.json)?$/.test(path)) return Response.json(await exploreSettings(viewer.id));
	if (method === "POST" && /^\/2\/guide\/set_explore_settings(?:\.json)?$/.test(path)) {
		const text = await req.text();
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(text);
		} catch {
			body = Object.fromEntries(new URLSearchParams(text));
		}
		return Response.json(await setExploreSettings(viewer.id, body ?? {}));
	}
	if (method === "GET" && /^\/2\/guide\/explore_locations_with_auto_complete(?:\.json)?$/.test(path))
		return Response.json(searchLocations(new URL(req.url).searchParams.get("prefix") ?? new URL(req.url).searchParams.get("q") ?? ""));
	// Settings > Contacts: the uploaded address book, and removing it
	if (method === "GET" && /^\/1\.1\/contacts\/addressbook(?:\.json)?$/.test(path)) {
		const q = new URL(req.url).searchParams;
		return Response.json(await addressBook(viewer.id, q.get("cursor"), Number(q.get("count")) || 100));
	}
	if (method === "POST" && /^\/1\.1\/contacts\/upload_v2(?:\.json)?$/.test(path)) {
		const body: any = await req.json().catch(() => ({}));
		return Response.json({ uploaded: await uploadContacts(viewer.id, body?.contacts) });
	}
	if (method === "POST" && /^\/1\.1\/contacts\/destroy\/all(?:\.json)?$/.test(path)) {
		await deleteContacts(viewer.id);
		return Response.json({});
	}
	// accounts by id or handle, up to 100 (the follower requests list asks for these)
	if (path === "/1.1/users/lookup.json" && (method === "GET" || method === "POST")) {
		const params = method === "GET" ? new URL(req.url).searchParams : new URLSearchParams(String(await req.text().catch(() => "")));
		const ids = (params.get("user_id") ?? "").split(",").map((x) => x.trim()).filter(isId).slice(0, 100);
		const names = (params.get("screen_name") ?? "").split(",").map((x) => x.trim().replace(/^@/, "")).filter((x) => STAFF_HANDLE.test(x)).slice(0, 100);
		const found = await Promise.all([...ids.map((id) => userById(viewer.id, id)), ...names.map((n) => userByName(viewer.id, n))]);
		const users = found.filter((u) => u && u.status !== "suspended");
		if (!users.length) return Response.json({ errors: [{ code: 17, message: "No user matches for specified terms." }] }, { status: 404 });
		return Response.json(users.map((u) => legacyUser(u!)));
	}
	// follow requests of a protected account
	if (method === "GET" && /^\/1\.1\/friendships\/incoming(?:\.json)?$/.test(path)) {
		const ids = await pendingRequests(viewer.id);
		return Response.json({ ids, next_cursor: 0, next_cursor_str: "0", previous_cursor: 0, previous_cursor_str: "0" });
	}
	if (method === "GET" && /^\/1\.1\/friendships\/outgoing(?:\.json)?$/.test(path)) {
		const rows = await sql`select target_id::text as id from follow_requests where requester_id = ${viewer.id}::bigint`;
		return Response.json({ ids: rows.map((r: any) => r.id), next_cursor: 0, next_cursor_str: "0", previous_cursor: 0, previous_cursor_str: "0" });
	}
	const answer = /^\/1\.1\/friendships\/(accept|deny|cancel)(?:\.json)?$/.exec(path);
	if (answer && method === "POST") {
		const form = await req.formData().catch(() => undefined);
		const target = form?.get("user_id");
		if (!isId(target)) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		if (answer[1] === "cancel") await setFollow(viewer.id, target, false);
		else await answerRequest(viewer.id, target, answer[1] === "accept");
		const user = await userById(viewer.id, target);
		if (!user) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		return Response.json(legacyUser(user));
	}
	// Settings > Privacy > Protect your posts
	if (method === "POST" && path === "/1.1/account/settings.json") {
		const form = await req.formData().catch(() => undefined);
		const asked = form?.get("protected");
		if (asked !== null && asked !== undefined) await setProtected(viewer.id, String(asked) === "true");
		const name = form?.get("screen_name");
		if (typeof name === "string" && name !== viewer.screen_name) {
			const problem = await changeUsername(viewer, name);
			if (problem) return Response.json({ errors: [{ code: 120, message: problem }] }, { status: 400 });
		}
		// whether people who uploaded this account's email may find it
		const findable = form?.get("discoverable_by_email");
		if (findable === "true" || findable === "false")
			await sql`update users set preferences = preferences || ${JSON.stringify({ discoverable_by_email: findable })}::text::jsonb where id = ${viewer.id}::bigint`;
		const lang = form?.get("lang") ?? form?.get("language");
		if (typeof lang === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang)) await sql`update users set language = ${lang} where id = ${viewer.id}::bigint`;
		const [fresh] = await sql`select screen_name, language, protected, preferences->>'discoverable_by_email' = 'true' as discoverable_by_email from users where id = ${viewer.id}::bigint`;
		return Response.json(settingsFor({ ...viewer, ...fresh }) ?? {});
	}
	// Report post / Report account
	if (path === "/1.1/report/flow.json" && method === "POST") {
		const body = await req.json().catch(() => ({}));
		if (process.env.LOG_REQUESTS) console.log(`report flow ${JSON.stringify(body).slice(0, 600)}`);
		return reportFlow(viewer, new URL(req.url), body);
	}
	const relation = /^\/1\.1\/(blocks|mutes\/users)\/(create|destroy)\.json$/.exec(path);
	if (relation && method === "POST") {
		const f = await form(req);
		const target = f.user_id ?? (f.screen_name ? (await userByName(viewer.id, f.screen_name))?.id : undefined);
		if (!isId(target) || target === viewer.id) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		const on = relation[2] === "create";
		if (relation[1] === "blocks") await setBlock(viewer.id, target, on);
		else await setMute(viewer.id, target, on);
		const user = await userById(viewer.id, target);
		if (!user) return Response.json({ errors: [{ code: 50, message: "User not found." }] }, { status: 404 });
		return Response.json(legacyUser(user));
	}
	const keywords = /^\/1\.1\/mutes\/keywords\/(list|create|update|destroy)\.json$/.exec(path);
	if (keywords) {
		const f = method === "POST" ? await form(req) : {};
		if (keywords[1] === "create") {
			const error = await addKeyword(viewer.id, f);
			if (error) return Response.json({ errors: [{ code: 214, message: error }] }, { status: 400 });
		} else if (keywords[1] === "update" && isId(f.id)) await updateKeyword(viewer.id, f.id, f);
		else if (keywords[1] === "destroy") await removeKeywords(viewer.id, (f.ids ?? "").split(",").filter(isId));
		return Response.json(await mutedKeywords(viewer.id));
	}
	// words the client warns about muting; there are none
	if (path === "/1.1/mutes/keywords/discouraged.json") return Response.json({ discouraged_keywords: [] });
	// notification filters (who may notify you); none are kept
	if (path === "/1.1/mutes/advanced_filters.json") return Response.json({});
	// the notifications page reports the newest entry it has shown
	if (/^\/2\/notifications\/\w+\/last_seen_cursor(\.json)?$/.test(path) && method === "POST") {
		const body = await req.text();
		let cursor: string | null = null;
		try {
			cursor = JSON.parse(body).cursor ?? null;
		} catch {
			cursor = new URLSearchParams(body).get("cursor");
		}
		await markSeen(viewer.id, cursor);
		return Response.json({ cursor });
	}
	// suggestions under the search box: accounts, and hashtags when one is being typed
	if (path === "/1.1/search/typeahead.json") {
		const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 100);
		const users = q && !q.startsWith("#") ? await usersByIds(viewer.id, await searchUsers(viewer.id, q, 8)) : new Map();
		const tags = q.startsWith("#") ? await hashtagsLike(q, 8) : [];
		return Response.json({
			num_results: users.size + tags.length,
			users: [...users.values()].map((u) => ({
				...legacyUser(u),
				ext_is_blue_verified: isVerified(u),
				social_context: { following: u.stats?.followedByViewer ?? false, followed_by: u.stats?.followsViewer ?? false },
			})),
			topics: tags.map((topic) => ({ topic, rounded_score: 0, tokens: [{ token: topic }], inline: false, result_context: { display_string: "", types: [] } })),
			// the client maps over each of these lists, so none may be missing
			cashtags: [],
			events: [],
			lists: [],
			ordered_sections: [],
			oneclick: [],
			hashtags: [],
			completed_in: 0,
			query: q,
		});
	}
	if (path === "/1.1/account/settings.json") return Response.json(settingsFor(viewer) ?? {});
	// branded hashtags (hashflags.ts)
	if (path === "/1.1/hashflags.json") return Response.json(await hashflagsJson());
	if (path === "/1.1/help/settings.json") return Response.json({});
	if (path === "/fleets/v1/fleetline") return Response.json({ threads: [], hydrated_threads: [], refresh_delay_secs: 300 });
	if (path === "/fleets/v1/avatar_content") return Response.json({ users: {}, refresh_delay_secs: 0 });
	if (path === "/1.1/friends/following/list.json") return Response.json(EMPTY_LIST);
	if (path === "/1.1/live_pipeline/update_subscriptions") return Response.json({ subscriptions: { errors: [] } });
	if (path.endsWith("/p2"))
		return Response.json({ totalEvents: 0, eventsFailed: 0, shouldRetry: false, retryAfterMs: null, eventsFailedSequenceNumbers: null, message: null });
	if (TELEMETRY.test(path)) return Response.json({});
	return undefined;
}

// Server-sent events channel for live updates. Nothing is pushed yet; the
// stream only stays open so the client does not keep reconnecting.
export function livePipeline(): Response {
	let timer: Timer;
	const stream = new ReadableStream({
		start(controller) {
			controller.enqueue(":\n\n");
			timer = setInterval(() => controller.enqueue(":\n\n"), 25_000);
		},
		cancel() {
			clearInterval(timer);
		},
	});
	return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}
