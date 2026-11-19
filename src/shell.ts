// The HTML page that boots the client, built from the pinned build snapshot.
// Everything about the signed-in account is ours.

import { BEE } from "./bee-icon";
import { grokName } from "./grok";
import type { User } from "./auth";
import { loadBuild } from "./build";
import { NAME_MAX, feature, settings } from "./settings";
import { postLimitFor } from "./textlen";
import { CONVERSATION_CARD_CSS, CONVERSATION_CARD_SCRIPT } from "./conversation-card-ui";
import { COMPOSER_BUTTON_CSS, COMPOSER_BUTTON_SCRIPT } from "./composer-buttons";
import { STICKER_PICKER_CSS, STICKER_PICKER_SCRIPT } from "./sticker-picker";
import { PASSKEY_SCRIPT } from "./passkeys";
import { PIRATE_SCRIPT } from "./pirate";
import { FORGOT_SCRIPT, FRESH_SCRIPT, type MenuLink, TIDY_SCRIPT, hideCss, tidyData } from "./tidy";
import { POST_CONTEXT_SCRIPT } from "./post-context";
import { ERROR_SCRIPT } from "./errors";
import { BADGES_SCRIPT } from "./badges";
import { DECOR_SCRIPT } from "./decor";
import { DECORATIONS_SCRIPT } from "./decorations";
import { THEME_SCRIPT } from "./themes/client";
import { bootAccentCss, bootCss, fontLinks, pageChromeCss, steamMotion, type BackgroundPaint } from "./themes/css";
import { DEFAULT_ACCENT, swatches, themeColorOf, type Accent } from "./themes/presets";
import { clientLook, themeForClient, type Look } from "./themes/validate";
import { NOTICE_SCRIPT } from "./automod-notice";
import { FLAG_PICKER_CSS, FLAG_PICKER_SCRIPT, flagPickerData } from "./flag-picker";
import { PRONOUNS_CSS, PRONOUNS_SCRIPT, pronounsData } from "./pronouns";
import { CLASSIC_DETAIL_CSS, CLASSIC_DETAIL_SCRIPT } from "./classic-detail";
import { PUBLIC_ORIGIN } from "./config";
import { SQUARE_MARK, legacyUser } from "./model";
import { patchText } from "./patch";
import { PWA_SCRIPT, pwaHead } from "./pwa";
import { MONEY_UI_CSS, MONEY_UI_SCRIPT } from "./money-ui";

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
		country_code: (user.country ?? "us").toLowerCase(),
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
// the X anywhere else: the phone layout's top bar, the loading screen
// (the top bar wraps the path in a <g>, so not only direct children)
const MARK = 'svg:has(path[d^="M21.742 21.75l-7.563-11.179"])';
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
${MARK}{background:url(/public/icon-light.png) center/contain no-repeat}
${DARK} ${MARK}{background-image:url(/public/icon-dark.png)}
${MARK} path{opacity:0}
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
	user_display_name_max_limit: { value: NAME_MAX },
	responsive_web_birdwatch_note_writing_enabled: { value: true },
	responsive_web_pinned_replies_enabled: { value: true },
	// Circles (circles.ts): the label on Circle posts stays even with the
	// feature off; the composer sends its Circle choice only with the second
	trusted_friends_consumption_enabled: { value: true },
	super_follow_exclusive_tweet_creation_api_enabled: { value: feature("circles") },
	composer_add_geo_network_conversation_controls: { value: true },
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
	responsive_web_grok_tweet_translation: { value: false },
	responsive_web_grok_api_enable_grok_host: { value: false },
	responsive_web_rich_tweet_landing_enabled: { value: false },
	responsive_web_translation_feedback_enabled: { value: false },
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

function initialState(user: User | null, fs: NonNullable<ReturnType<typeof loadBuild>>["build"]["featureSwitch"], inCommunity: boolean, educationFlags: Record<string, number>, accent: Accent = DEFAULT_ACCENT) {
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
				themeColor: themeColorOf(accent),
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

const OLD_ACCENTS = ["blue", "yellow", "red", "purple", "orange", "green", "magenta"];

// 2020-era builds keep the switches at featureSwitch.config and want slices the
// current one dropped; the captured state fills those, ours wins where both have one
function onBase(base: Record<string, any> | undefined, state: ReturnType<typeof initialState>) {
	if (!base) return state;
	const merge = (a: any, b: any): any =>
		a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)
			? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a[k], b[k]) : a[k]]))
			: b;
	const out = merge(base, state);
	out.featureSwitch.config = state.featureSwitch.user.config;
	// accents were plain names then ("blue", not "blue500"); an unknown one leaves the theme without colours
	const color = String(out.settings?.local?.themeColor ?? "").replace(/\d+$/, "");
	out.settings.local.themeColor = OLD_ACCENTS.includes(color) ? color : "blue";
	return out;
}

// the one-off notice an old build shows at the top of a page (its sign-in page after a wrong password)
const withFlash = (state: any, flash?: string) => (flash ? { ...state, session: { ...state.session, flashMessage: flash } } : state);

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// JSON placed inside a <script> must not be able to close it
const inline = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

// per build: an instance can serve more than one (build.ts clientBuilds)
const runtimes = new Map<string, string>();

// Xitter's own scripts are the same on every page (one set signed in, one
// signed out), so they come as a file the browser keeps instead of 130 KB
// inside every page. Its address carries a hash of it (bootScript).
const BOOT_SCRIPTS = (signedIn: boolean) =>
	`${signedIn ? ERROR_SCRIPT : ""}
${TIDY_SCRIPT}
${FRESH_SCRIPT}
${FORGOT_SCRIPT}
${signedIn ? "" : PASSKEY_SCRIPT}
${PRONOUNS_SCRIPT}
${FLAG_PICKER_SCRIPT}
${signedIn ? COMPOSER_BUTTON_SCRIPT : ""}
${signedIn ? STICKER_PICKER_SCRIPT : ""}
${signedIn ? CONVERSATION_CARD_SCRIPT : ""}
${signedIn ? PIRATE_SCRIPT : ""}
${signedIn ? CLASSIC_DETAIL_SCRIPT : ""}
${signedIn ? MONEY_UI_SCRIPT : ""}
${POST_CONTEXT_SCRIPT}
${BADGES_SCRIPT}
${signedIn ? THEME_SCRIPT : ""}
${signedIn ? DECOR_SCRIPT : ""}
${DECORATIONS_SCRIPT}
${signedIn ? NOTICE_SCRIPT : ""}
${PWA_SCRIPT}`;
let boot: { body: Buffer; path: string }[] | undefined;
const boots = () =>
	(boot ??= [false, true].map((signedIn) => {
		const body = Buffer.from(BOOT_SCRIPTS(signedIn));
		return { body, path: `/i/xitter/boot-${Bun.hash(body).toString(36)}.js` };
	}));
const bootFor = (signedIn: boolean) => boots()[signedIn ? 1 : 0];
export const bootScript = (path: string): Buffer | undefined => boots().find((b) => b.path === path)?.body;

// Both clients keep their state in IndexedDB "localforage", in shapes the
// other can't read: the 2020 client waits forever on a blank page over what
// the current one left. Each page notes its build; the 2020 one drops the
// database when another build ran last, before its scripts do.
const BUILD_MARK = "xitter_client_build";
const markBuild = (sha: string) => `try{localStorage.setItem(${inline(BUILD_MARK)},${inline(sha)})}catch(e){}`;
const oldLoader = (sha: string, srcs: string[]) => `(function(){var s=${inline(srcs)};function go(){s.forEach(function(u){var e=document.createElement("script");e.src=u;e.async=false;e.charset="utf-8";e.crossOrigin="anonymous";document.body.appendChild(e)})}
if(/(?:^|;\\s*)night_mode=2/.test(document.cookie)){var nm="night_mode=1; Path=/; Max-Age=31536000; SameSite=Lax";document.cookie=nm;document.cookie=nm+"; domain="+location.hostname}
var was;try{was=localStorage.getItem(${inline(BUILD_MARK)})}catch(e){}${markBuild(sha)}
if(was===${inline(sha)}||!window.indexedDB)return go();var done=false;function once(){if(!done){done=true;go()}}
var OK={themeBackground:["light","dark","darker"],themeColor:["blue","yellow","red","purple","orange","green"],scale:["xSmall","small","normal","large","xLarge"],highContrastEnabled:[true,false],reducedMotionEnabled:[true,false]},r;try{r=indexedDB.open("localforage")}catch(e){return once()}
r.onerror=r.onblocked=once;r.onupgradeneeded=function(){r.transaction.abort()};
r.onsuccess=function(){var db=r.result;if(!db.objectStoreNames.contains("keyvaluepairs")){db.close();return once()}
var t=db.transaction("keyvaluepairs","readwrite"),st=t.objectStore("keyvaluepairs"),g=st.get("device:rweb.settings");
g.onsuccess=function(){var l=g.result&&g.result.local,k={};if(l&&typeof l==="object")Object.keys(OK).forEach(function(n){var v=l[n];if(n==="themeColor"&&typeof v==="string")v=v.replace(/\\d+$/,"");if(OK[n].indexOf(v)>=0)k[n]=v});st.clear();if(l)st.put({local:k},"device:rweb.settings")};
t.oncomplete=t.onerror=t.onabort=function(){db.close();once()}}})();`;

// The 2020 client's More menu gets Xitter settings and the side menu's own
// entries (tidy.ts menuLinks); patch.ts draws them
const GEAR = "M480-80q-17 0-28.5-11.5T440-120v-62q-49-9-90.5-35.5T280-284l-56 24q-15 7-30.5 1.5T170-278l-40-70q-8-14-4.5-29.5T142-402l50-36q-4-20-6-41t-2-41q0-20 2-41t6-41l-50-36q-13-9-16.5-24.5T130-692l40-70q8-14 23.5-19.5T224-780l56 24q27-26 69.5-52.5T440-844v-62q0-17 11.5-28.5T480-946q17 0 28.5 11.5T520-906v62q49 9 90.5 35.5T680-756l56-24q15-7 30.5-1.5T790-762l40 70q8 14 4.5 29.5T818-638l-50 36q4 20 6 41t2 41q0 20-2 41t-6 41l50 36q13 9 16.5 24.5T830-348l-40 70q-8 14-23.5 19.5T736-260l-56-24q-27 26-69.5 52.5T520-196v76q0 17-11.5 28.5T480-80Zm0-280q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35Z";
const oldMenu = (links: MenuLink[]) => [
	{ href: "/settings/xitter", text: "Xitter settings", icon: GEAR, viewBox: "0 -960 960 960" },
	...links.filter((l) => l.where === "menu" || l.where === "both" || l.where === "nav").map((l) => ({ href: l.href, text: l.text, icon: l.icon, viewBox: l.viewBox ?? "0 0 24 24" })),
];
const OLD_BEE = `window.__xitterBeeIcon=function(R,Base){return Base};(function(){function swap(){document.querySelectorAll('a[href="/i/grok"] svg:not([data-gbee])').forEach(function(v){v.setAttribute("data-gbee","");v.setAttribute("viewBox","0 -960 960 960");v.innerHTML='<path d="${BEE}"/>'})}new MutationObserver(swap).observe(document.documentElement,{childList:true,subtree:true})})();`;
// Our pages can't sit inside the 2020 client the way tidy.ts frames them in the
// current one, so links to them load the page itself instead of a client route
const OLD_PAGES = `document.addEventListener("click",function(e){var a=e.target.closest&&e.target.closest("a[href]");if(!a||e.button||e.metaKey||e.ctrlKey||e.shiftKey)return;var u=new URL(a.href,location.href),p=u.pathname;if(u.origin!==location.origin||!(p.indexOf("/account/")===0||p==="/settings/xitter"||p.indexOf("/settings/xitter/")===0||p==="/admin"||p.indexOf("/admin/")===0||(p==="/i/grok"&&window.__XITTER_GBEE__)))return;e.preventDefault();e.stopPropagation();var b=getComputedStyle(document.body).backgroundColor;document.cookie="xitter_old_theme="+(b==="rgb(0, 0, 0)"?"dark":b.indexOf("rgb(21, 32, 43")===0?"dim":"light")+"; Path=/; Max-Age=31536000; SameSite=Lax";location.assign(p+u.search)},true);`;
// An organisation's avatar is square, as on X: the 2020 client draws every
// avatar round (its r-sdzlij class), and its picture's address carries
// SQUARE_MARK (model.ts oldAvatar) where it should not be
const OLD_FOOTER = `[data-testid="sidebarColumn"] nav[aria-label="Footer"]{display:none!important}`;
const OLD_SQUARE = `.r-sdzlij:has(img[src*="${SQUARE_MARK}"]){border-radius:10%!important}`;
// Home's tabs for the 2020 client (patch.ts puts them atop its timeline): For
// you and Following are its own top/latest switch, which the sparkle button's
// component reports in __xitterHome; All is the built-in list. Made with the
// client's React, passed in, and drawn in the colours its page shows.
const OLD_TABS = `window.__xitterTabs=function(R){if(window.__xitterTabsC)return window.__xitterTabsC;
var F='system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Ubuntu,"Helvetica Neue",sans-serif';
function Tabs(p){var s=R.useState(window.__xitterHome||{}),st=s[0],set=s[1],ref=R.useRef(null);
R.useEffect(function(){function on(){set(Object.assign({},window.__xitterHome))}window.addEventListener("xitter:home",on);on();return function(){window.removeEventListener("xitter:home",on)}},[]);
R.useEffect(function(){var el=ref.current,h=document.querySelector('[data-testid="primaryColumn"] h2');if(!el||!h)return;var c=getComputedStyle(h).color,b=getComputedStyle(document.body).backgroundColor;el.style.color=c;el.style.background=b&&b!=="rgba(0, 0, 0, 0)"?b:"";});
var latest=!!st.useLatest;
function tab(label,on,go){return R.createElement("div",{key:label,role:"tab","aria-selected":on,tabIndex:0,onClick:go,onKeyDown:function(e){if(e.key==="Enter")go()},style:{flex:1,display:"flex",alignItems:"center",justifyContent:"center",minHeight:53,position:"relative",cursor:"pointer",fontWeight:on?700:500,opacity:on?1:.6,userSelect:"none"}},label,on?R.createElement("div",{style:{position:"absolute",bottom:0,height:4,width:56,borderRadius:9999,background:"rgb(29,161,242)"}}):null)}
return R.createElement("div",{ref:ref,role:"tablist",style:{display:"flex",position:"sticky",top:53,zIndex:2,borderBottom:"1px solid rgba(128,128,128,.25)",fontFamily:F,fontSize:15}},
tab("For you",!latest,function(){if(latest&&st.toggle)st.toggle()}),
tab("Following",latest,function(){if(!latest&&st.toggle)st.toggle()}),
tab("All",false,function(){p.history&&p.history.push("/i/lists/1")}))}
return window.__xitterTabsC=Tabs};`;

// With no user the client boots signed out, for the sign-in dialog.
// `multi`: other accounts are signed in too (auth_multi), so the account menu
// asks for them.
export function shell(user: User | null, multi = false, inCommunity = false, educationFlags: Record<string, number> = {}, links: MenuLink[] = [], look: Look | null = null, accent: Accent = DEFAULT_ACCENT, paint?: BackgroundPaint, csrf?: string, flash?: string): string | undefined {
	const theme = look?.kind === "painted" ? look.theme : null;
	const clientTheme = theme ? themeForClient(theme) : null;
	const loaded = loadBuild();
	if (!loaded) return undefined;
	const { build, runtime } = loaded;
	let runtimeText = runtimes.get(build.sha);
	if (runtimeText === undefined) {
		if (runtimes.size > 8) runtimes.clear();
		runtimes.set(build.sha, (runtimeText = patchText(runtime)));
	}
	// the chat build's address is ours (the rest of the metadata stays as captured:
	// the client decides from it where its csrf header goes)
	const chatBuild = build.meta.xchatEmbedBuild;
	const meta = { ...build.meta, ...(typeof chatBuild === "string" ? { xchatEmbedBuild: patchText(chatBuild) } : {}), sha: build.sha, isLoggedIn: !!user, userId: user?.id ?? null, hasMultiAccountCookie: !!user && multi, serverDate: Date.now() };
	const scripts = build.scripts
		.map((p) => `<script defer charset="utf-8" crossorigin="anonymous" src="${PUBLIC_ORIGIN}/abs${p}"></script>`)
		.join("");
	// an old build gets the page it came with: Xitter's CSS and scripts are written
	// against the current client's markup and would only get in its way
	if (build.stateBase)
		return `<!DOCTYPE html><html dir="ltr" lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0,viewport-fit=cover" />
<meta name="theme-color" content="#ffffff" /><title>${esc(settings().instance_name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png" />
<style>html,body{height:100%}body{margin:0}${OLD_SQUARE}${user ? OLD_FOOTER : ""}</style>
</head><body><div id="react-root" style="height:100%;display:flex;"></div>
<script>window.__INITIAL_STATE__=${inline(withFlash(onBase(build.stateBase, initialState(user, build.featureSwitch, inCommunity, educationFlags, accent)), flash))};window.__META_DATA__=${inline(meta)};</script>
${user ? `<script>window.__XITTER_MENU__=${inline(oldMenu(links))};window.__XITTER_GBEE__=${inline(feature("grok") ? grokName() : null)};${OLD_BEE}${OLD_PAGES}${OLD_TABS}</script>` : ""}
<script id="nonce-csp"></script>
<script>${runtimeText}</script>
<script>${oldLoader(build.sha, build.scripts.map((p) => `${PUBLIC_ORIGIN}/abs${p}`))}</script>
</body></html>`;
	return `<!DOCTYPE html><html dir="ltr" lang="en"${theme ? ` data-xitter-theme="${esc(theme.id)}"` : ""} data-xitter-accent="${esc(accent.kind === "named" ? accent.id : "custom")}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=0,viewport-fit=cover" />
<meta name="theme-color" content="${theme ? esc(theme.bg.stops[0] ?? "#000000") : "#000000"}" /><title>${esc(settings().instance_name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png" />${pwaHead()}${fontLinks(theme)}
<style>html,body{height:100%}body{margin:0;background-color:#000}
html{-webkit-tap-highlight-color:transparent;-webkit-text-size-adjust:100%}
@media (display-mode:standalone){body{overscroll-behavior-y:none}}${LOGO_CSS}
${hideCss()}
${FLAG_PICKER_CSS}
${PRONOUNS_CSS}
${STICKER_PICKER_CSS}${bootAccentCss(accent)}${theme ? bootCss(theme, paint) : ""}
${CONVERSATION_CARD_CSS}
${COMPOSER_BUTTON_CSS}
${user ? MONEY_UI_CSS : ""}
${user?.classic_post_details ? CLASSIC_DETAIL_CSS : ""}
[data-testid="sidebarColumn"] div:has(> [data-testid="emptyState"]),[data-testid="sidebarColumn"] div:has(> div > aside) ~ div:empty{display:none}</style>
</head><body><div id="react-root" style="height:100%;display:flex;"></div>
<script>window.__INITIAL_STATE__=${inline(onBase(build.stateBase, initialState(user, build.featureSwitch, inCommunity, educationFlags, accent)))};window.__META_DATA__=${inline(meta)};</script>
<script>window.__XITTER__=${inline({ ...flagPickerData(user?.flag ?? null), ...pronounsData(user), classicDetail: !!user?.classic_post_details, circles: !!user && feature("circles"), tidy: tidyData(links), theme: clientTheme, look: clientLook(look, accent), accent: clientLook(look, accent).accent, themeColor: themeColorOf(accent), themePresets: swatches(), pageChrome: pageChromeCss(paint), steamMotion: steamMotion(paint), ...(user && csrf ? { csrf } : {}) })};</script>
<script src="${bootFor(!!user).path}"></script>
<script id="nonce-csp"></script>
<script>${runtimeText}</script>
<script>${markBuild(build.sha)}</script>
${scripts}
</body></html>`;
}
