// The HTML page that boots the client, built from the pinned build snapshot.
// Everything about the signed-in account is ours.

import type { User } from "./auth";
import { loadBuild } from "./build";
import { feature, settings } from "./settings";
import { postLimitFor } from "./textlen";
import { STICKER_PICKER_CSS, STICKER_PICKER_SCRIPT } from "./sticker-picker";
import { FORGOT_SCRIPT, FRESH_SCRIPT, type MenuLink, TIDY_SCRIPT, hideCss, tidyData } from "./tidy";
import { POST_CONTEXT_SCRIPT } from "./post-context";
import { ERROR_SCRIPT } from "./errors";
import { BADGES_SCRIPT } from "./badges";
import { NOTICE_SCRIPT } from "./automod-notice";
import { FLAG_PICKER_CSS, FLAG_PICKER_SCRIPT, flagPickerData } from "./flag-picker";
import { PUBLIC_ORIGIN } from "./config";
import { legacyUser } from "./model";
import { patchText } from "./patch";

// account settings as the client expects them
export function settingsFor(user: User): Record<string, unknown> {
	return {
		display_sensitive_media: false,
		protected: !!user.protected,
		screen_name: user.screen_name,
		always_use_https: true,
		use_cookie_personalization: false,
		sleep_time: { enabled: false, end_time: null, start_time: null },
		geo_enabled: false,
		language: user.language ?? "en",
		discoverable_by_email: !!user.discoverable_by_email,
		discoverable_by_mobile_phone: false,
		personalized_trends: false,
		allow_media_tagging: "all",
		allow_contributor_request: "none",
		allow_ads_personalization: false,
		allow_logged_out_device_personalization: false,
		allow_location_history_personalization: false,
		allow_sharing_data_for_third_party_personalization: false,
		allow_dms_from: "following",
		always_allow_dms_from_subscribers: null,
		allow_dm_groups_from: "following",
		translator_type: "none",
		country_code: "us",
		nsfw_user: false,
		nsfw_admin: false,
		ranked_timeline_setting: null,
		ranked_timeline_eligible: null,
		address_book_live_sync_enabled: false,
		universal_quality_filtering_enabled: "enabled",
		dm_receipt_setting: "all_enabled",
		alt_text_compose_enabled: null,
		mention_filter: "unfiltered",
		allow_authenticated_periscope_requests: false,
		protect_password_reset: false,
		require_password_login: false,
		requires_login_verification: false,
		ext_dm_av_call_settings: {
			has_av_calls_enabled: false,
			av_call_permissions: {
				accept_calls_from_addressbook: false,
				accept_calls_from_following: false,
				accept_calls_from_verified: false,
				accept_calls_from_everyone: false,
			},
		},
		ext_sharing_audiospaces_listening_data_with_followers: false,
		dm_quality_filter: "enabled",
		autoplay_disabled: false,
		settings_metadata: {},
	};
}

// The instance's logo over the client's X in the side bar: the X alone when the
// bar is narrow, the word mark when it is wide. The bar's width depends on the
// window and on the page (Chat keeps it narrow), so tidy.ts measures it and sets
// data-wide-nav on <html>. The client marks its dark themes with color-scheme on <html>.
// The link's label is the instance's name (patch.ts), so it is found by place.
const LOGO = "header h1 a";
const DARK = 'html[style*="color-scheme: dark"]';
const WIDE = "html[data-wide-nav]";
// the X drawn at the top of the sign-in dialog, known by its path
const DIALOG_LOGO = '[role="dialog"] span:has(> svg > path[d^="M21.742 21.75l-7.563-11.179"])';
// the big X beside the signed-out home page's sign-in form
const HERO = 'main div:has(> svg > path[d^="M285.38 207.711"])';
// X's code field is sized for 6 boxes; the 8-digit invite code's boxes share the width
const CODE_BOXES = ".jf-code-input-wrapper:has(> .jf-code-box:nth-child(7))";
const LOGO_CSS = `${LOGO} svg{opacity:0}
${LOGO}{background:url(/public/icon-light.png) center/36px no-repeat}
${DARK} ${LOGO}{background-image:url(/public/icon-dark.png)}
${WIDE} ${LOGO}{width:150px;background-image:url(/public/logo-light.png);background-size:128px auto;background-position:10px center}
${DARK}[data-wide-nav] ${LOGO}{background-image:url(/public/logo-dark.png)}
${DIALOG_LOGO}{background:url(/public/icon-light.png) center/contain no-repeat}
${DARK} ${DIALOG_LOGO}{background-image:url(/public/icon-dark.png)}
${DIALOG_LOGO} svg{opacity:0}
${HERO}{background:url(/public/logo-light.png) center/min(100%,391px) auto no-repeat}
${DARK} ${HERO}{background-image:url(/public/logo-dark.png)}
${HERO} svg{opacity:0}
${CODE_BOXES}{justify-content:center;gap:6px}
${CODE_BOXES} > .jf-code-box{flex:1 1 0;min-width:0;max-width:56px}`;

// Paid features the client gates on a per-account claim. Nothing is paid for
// here, so every account holds them.
const CLAIMED_FEATURES = Object.fromEntries(["subscriptions_feature_article_composer", "subscriptions_feature_highlights", "subscriptions_feature_1002"].map((k) => [k, { value: "true" }]));

// Switches whose values name x.com hosts. The client checks them against host
// lists that patch.ts has already rewritten, so the captured value would fail;
// without the switch the client falls back to its (patched) default.
const HOST_SWITCHES = ["responsive_web_media_upload_host"];
// Xitter's own values, over the pinned build's
const ownSwitches = (): Record<string, { value: unknown }> => ({
	responsive_web_birdwatch_note_writing_enabled: { value: true },
	responsive_web_pinned_replies_enabled: { value: true },
	responsive_web_sidebar_ttf_enabled: { value: true },
	// the side bar has one slot for both: History (its Bookmarks tab inside) when
	// the feature is on, the client's own Bookmarks link when it is off
	responsive_web_history_screen_enabled: { value: feature("history") },
	// "Generate with Grok" beside Upload in the media pickers (composer, article
	// cover); with only the picker switch off, the composer grows its own Grok button
	...(feature("image_gen") ? {} : {
		responsive_web_grok_img_composer: { value: false },
		responsive_web_grok_img_composer_in_media_picker: { value: false },
		responsive_web_grok_article_cover_image_gen_enabled: { value: false },
	}),
	// the checkmark sheet's "Upgrade to Premium" leads to X's checkout; there is nothing to buy here
	responsive_web_user_badge_education_get_verified_button_enabled: { value: false },
	// "Want more people to see your reply?" after an inline reply, for accounts over 30 days old
	subscriptions_upsells_reply_boost_popup_enabled: { value: false },
	// the guest set has 0, which offers "reload for the new version" on every service worker update
	responsive_web_service_worker_update_toast_interval_hours: { value: 168 },
	// on, it drops every post label but reposts, pins and communities, topics included
	rweb_home_mixer_enable_social_context_filter_social_contexts: { value: false },
	// the captured "see_more" links a topic label to a topic page this client no
	// longer has; any other value gives the label an inline Follow button instead
	topics_context_controls_followed_variation: { value: "follow_button" },
	// polls with a photo on each choice (polls.ts IMAGE_POLL)
	responsive_web_image_poll_composer_enabled: { value: feature("polls") },
	responsive_web_card_image_poll_enabled: { value: true },
	responsive_web_edit_tweet_enabled: { value: true },
	responsive_web_edit_tweet_composition_enabled: { value: true },
	responsive_web_edit_tweet_perspective_enabled: { value: true },
});
const overrideSwitches = () => Object.fromEntries(Object.entries(settings().switch_overrides).map(([k, value]) => [k, { value }]));
// Long posts for everyone, up to the limit of the viewer's badge (textlen.ts):
// the composer reads its limit from this switch and sends CreateNoteTweet past 280.
const longPostSwitches = (user: User | null) => ({
	longform_notetweets_consumption_enabled: { value: true },
	longform_notetweets_composition_without_claims_enabled: { value: true },
	longform_notetweets_max_weighted_character_length: { value: postLimitFor(user?.verified_type) },
});
// the build's, then Xitter's, then an admin's; the long-post limit is the viewer's own
const clientSwitches = (config: Record<string, unknown>, user: User | null = null) => ({
	...Object.fromEntries(Object.entries(config ?? {}).filter(([k]) => !HOST_SWITCHES.includes(k))),
	...ownSwitches(),
	...overrideSwitches(),
	...longPostSwitches(user),
});

// every switch the build knows, with where its value comes from (admin panel)
export function switchReport() {
	const fs = loadBuild()?.build.featureSwitch;
	const build = { ...(fs?.defaultConfig ?? {}), ...(fs?.config ?? {}) } as Record<string, { value: unknown }>;
	const own = ownSwitches();
	const overrides = settings().switch_overrides;
	const names = [...new Set([...Object.keys(build), ...Object.keys(own), ...Object.keys(overrides)])].sort();
	return names.map((name) => ({
		name,
		build: build[name]?.value,
		...(name in own ? { xitter: own[name].value } : {}),
		...(name in overrides ? { override: overrides[name] } : {}),
	}));
}

function initialState(user: User | null, fs: NonNullable<ReturnType<typeof loadBuild>>["build"]["featureSwitch"], inCommunity: boolean, educationFlags: Record<string, number>) {
	return {
		optimist: [],
		entities: {
			users: user ? { entities: { [user.id]: legacyUser(user) }, errors: {}, fetchStatus: { [user.id]: "loaded" } } : { entities: {}, errors: {}, fetchStatus: {} },
		},
		featureSwitch: {
			defaultConfig: clientSwitches(fs.defaultConfig, user),
			user: { config: clientSwitches(fs.config, user), impression_pointers: {}, impressions: {}, keysRead: {}, settingsVersion: fs.settingsVersion },
			debug: {},
			featureSetToken: fs.featureSetToken,
			isLoaded: true,
			isLoading: false,
			customOverrides: {},
		},
		settings: {
			local: {
				nextPushCheckin: 0,
				shouldAutoPlayGif: false,
				scale: "normal",
				themeColor: "blue500",
				highContrastEnabled: false,
				loginPromptLastShown: 0,
				moneyNotificationsLastSeenSortIndex: {},
				reducedMotionEnabled: false,
				showTweetMediaDetailDrawer: true,
				autoPollNewTweets: false,
				shouldAutoTagLocation: false,
				replyVotingSurveyClicked: 0,
				pushNotificationsPermission: null,
				quoteVideoToggleUsed: false,
			},
			remote: user ? { settings: settingsFor(user), fetchStatus: "loaded" } : { settings: {}, fetchStatus: "none" },
			dataSaver: { dataSaverMode: false },
			transient: { loginPromptShown: false, lastViewedDmInboxPath: "/messages", themeFocus: null, notificationsType: null },
		},
		devices: {
			browserPush: { fetchStatus: "none", pushNotificationsPrompt: { dismissed: false, fetchStatus: "none" }, subscribed: false, supported: null },
			devices: { data: { emails: [], phone_numbers: [] }, fetchStatus: "none" },
			notificationSettings: {
				push_settings: { error: null, fetchStatus: "none" },
				push_settings_template: { template: { settings: [] } },
				checkin_time: null,
			},
		},
		educationFlags,
		userClaim: { config: { subscriptions: {}, features: CLAIMED_FEATURES }, commerceSubscriptions: [], debug: {}, fetchStatus: "loaded" },
		session: {
			communitiesActions: { create: true },
			country: "US",
			guestId: "",
			hasCommunityMemberships: inCommunity,
			isActiveCreator: false,
			isLoaded: true,
			isRestrictedSession: false,
			language: "en",
			ssoInitTokens: {},
			superFollowersCount: 0,
			superFollowsApplicationStatus: "NotStarted",
			user_id: user?.id ?? null,
			userFeatures: {},
			xpaymentsEnrolled: false,
			canAccessPayments: false,
			isSuperFollowSubscriber: false,
		},
		developer: { dtabBarInfo: { hide: true } },
	};
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// JSON placed inside a <script> must not be able to close it
const inline = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

let runtimePatched: { sha: string; text: string } | undefined;

// With no user the client boots signed out, for the sign-in dialog.
// `multi`: other accounts are signed in too (auth_multi), so the account menu
// asks for them.
export function shell(user: User | null, multi = false, inCommunity = false, educationFlags: Record<string, number> = {}, links: MenuLink[] = []): string | undefined {
	const loaded = loadBuild();
	if (!loaded) return undefined;
	const { build, runtime } = loaded;
	if (runtimePatched?.sha !== build.sha) runtimePatched = { sha: build.sha, text: patchText(runtime) };
	// the chat build's address is ours (the rest of the metadata stays as captured:
	// the client decides from it where its csrf header goes)
	const chatBuild = build.meta.xchatEmbedBuild;
	const meta = { ...build.meta, ...(typeof chatBuild === "string" ? { xchatEmbedBuild: patchText(chatBuild) } : {}), sha: build.sha, isLoggedIn: !!user, userId: user?.id ?? null, hasMultiAccountCookie: !!user && multi, serverDate: Date.now() };
	const scripts = build.scripts
		.map((p) => `<script defer charset="utf-8" crossorigin="anonymous" src="${PUBLIC_ORIGIN}/abs${p}"></script>`)
		.join("");
	return `<!DOCTYPE html><html dir="ltr" lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0,viewport-fit=cover" />
<meta name="theme-color" content="#000000" /><title>${esc(settings().instance_name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png" /><link rel="apple-touch-icon" href="/public/icon-light.png" />
<style>html,body{height:100%}body{margin:0;background-color:#000}${LOGO_CSS}
${hideCss()}
${FLAG_PICKER_CSS}
${STICKER_PICKER_CSS}</style>
</head><body><div id="react-root" style="height:100%;display:flex;"></div>
<script>window.__INITIAL_STATE__=${inline(initialState(user, build.featureSwitch, inCommunity, educationFlags))};window.__META_DATA__=${inline(meta)};</script>
<script>window.__XITTER__=${inline({ ...flagPickerData(user?.flag ?? null), tidy: tidyData(links) })};
${user ? ERROR_SCRIPT : ""}
${TIDY_SCRIPT}
${FRESH_SCRIPT}
${FORGOT_SCRIPT}
${FLAG_PICKER_SCRIPT}
${user ? STICKER_PICKER_SCRIPT : ""}
${POST_CONTEXT_SCRIPT}
${BADGES_SCRIPT}
${user ? NOTICE_SCRIPT : ""}</script>
<script id="nonce-csp"></script>
<script>${runtimePatched.text}</script>
${scripts}
</body></html>`;
}
