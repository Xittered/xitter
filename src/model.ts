// Builds the objects the client expects. Field sets follow the captured
// responses; fields for features we do not have are constants.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { bioEntities, urlEntities as linkEntities } from "./links";
import { conversationCardEntity, type ConversationCard } from "./conversation-cards";
import type { User } from "./auth";
import { CLIENT_DIR } from "./client-cache";
import { PUBLIC_ORIGIN } from "./config";
import type { ArticleEntity } from "./articles";
import { FLAGS, flagList } from "./flags";
import { guessLang } from "./lang-guess";
import { homeOf, mentionsIn } from "./mentions";
import { type MediaRow, absolute, mediaEntity, mediaUrl, posterUrl } from "./media";
import { placeById } from "./places";
import { shownSource } from "./platforms";
import { hidesChecks, hidesParody, requestLanguage } from "./staff-access";
import { feature, settings } from "./settings";
import { SHORT_POST, previewOf, weightedLength } from "./textlen";
import { badgeUrl } from "./users";
import { loadBuild } from "./build";

// a note's text with its links marked, as the note box and the note page expect
export function noteText(text: string) {
	const entities = [...text.matchAll(/https?:\/\/[^\s<>"']+/g)].map((m) => {
		const url = m[0].replace(/[.,;!?]+$/, "");
		// indices count code points, as in notification messages
		const at = [...text.slice(0, m.index)].length;
		return { fromIndex: at, toIndex: at + [...url].length, ref: { type: "TimelineUrl", url, expandedUrl: url, urlType: "ExternalUrl" } };
	});
	return { text, entities };
}

const DEFAULT_AVATAR = `${PUBLIC_ORIGIN}/abs/sticky/default_profile_images/default_profile_400x400.png`;
export const avatarSrc = (url: string | null | undefined) => {
	const id = url && /^\/media\/(\d{1,19})$/.exec(url)?.[1];
	return id ? `${PUBLIC_ORIGIN}/profile_images/${id}_normal.jpg` : absolute(url);
};
// an account's picture as a full URL, X's default one when it has none
export const avatarUrl = (url: string | null | undefined) => absolute(url ?? null) ?? DEFAULT_AVATAR;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

// "Tue Oct 13 21:29:08 +0000 2026"
export function apiDate(d: Date): string {
	return `${DAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`;
}

const globalId = (kind: string, id: string) => Buffer.from(`${kind}:${id}`).toString("base64");

// An account from another instance wears the badge that instance gave it,
// unless this instance stopped showing those (Admin > Federation). A viewer
// can hide every checkmark for themselves (parody-labels.ts).
export const checkHidden = (u: { instance?: string | null }) => hidesChecks() || (!!u.instance && !settings().remote_checkmarks);
export const shownVerifiedType = (u: User) => (checkHidden(u) ? null : u.verified_type);

// Affiliates of an organisation wear X's checkmark next to the organisation's
// badge, as on X, even without a badge of their own, unless the instance
// switched that off (Settings: affiliate_checkmarks).
export const affiliateChecked = (u: User) => !!u.org && feature("affiliate_checkmarks");
export const isVerified = (u: User) => !checkHidden(u) && (u.verified_type !== null || affiliateChecked(u));
// a business or government badge: what makes an account an organisation on
// its own, and gives it a square picture
export const hasOrgBadge = (u: User) => u.verified_type === "business" || u.verified_type === "government";
// a business account to X: an organisation badge, or anyone with affiliates
// (isOrganizationSql in users.ts is the same rule in SQL)
export const isOrganization = (u: User) => hasOrgBadge(u) || !!u.affiliates;
// "Verified since": an affiliate's date of joining its organisation, else when the badge was given
export const verifiedSince = (u: User): Date | null => (affiliateChecked(u) && u.org?.since ? new Date(u.org.since) : u.verified_at ? new Date(u.verified_at) : null);

// X has two globes: "badged" (blue) and "moderator" (yellow). Approvers get the
// yellow one; translator moderators the same, which badges.ts colours gold.
export const translatorType = (u: User) => (u.translator === "translator" ? "badged" : u.translator ? "moderator" : "none");

// organisations, businesses and governments alike, have square pictures; people round ones
export const pictureShape = (u: User) => (hasOrgBadge(u) ? "Square" : "Circle");

// The sheet a checkmark opens: why the account wears it, and since when. The
// client draws the organisation's row itself from the badge label. Entity
// offsets count code points; x.com links stay inside the app.
function verificationInfo(u: User) {
	if (!isVerified(u)) return { is_identity_verified: false };
	const instance = settings().instance_name;
	const type = shownVerifiedType(u);
	const parts: (string | { text: string; url: string })[] = u.org && affiliateChecked(u)
		? ["This account is Premium because it’s an affiliate of ", { text: `@${u.org.screen_name}`, url: `${PUBLIC_ORIGIN}/${u.org.screen_name}` }, ` on ${instance}. `]
		: type === "business"
			? [`This account is verified because it’s an organisation on ${instance}. `]
			: type === "government"
				? [`This account is verified because it is a government or multilateral organization account on ${instance}. `]
				: type === "government_individual"
					? [`This account is verified because it belongs to a government or multilateral organization official on ${instance}. `]
				: [`This account is Premium because the ${instance} team verified it. `];
	parts.push({ text: "Learn more", url: `${PUBLIC_ORIGIN}/rules` });
	let text = "";
	const entities = [];
	for (const p of parts) {
		if (typeof p === "string") {
			text += p;
			continue;
		}
		const from = [...text].length;
		text += p.text;
		entities.push({ from_index: from, to_index: [...text].length, ref: { url: p.url, url_type: "ExternalUrl" } });
	}
	const since = verifiedSince(u);
	return {
		is_identity_verified: false,
		reason: { description: { text, entities }, ...(since ? { verified_since_msec: String(new Date(since).getTime()) } : {}) },
	};
}

function verification(u: User) {
	const type = shownVerifiedType(u);
	if (type === "business") return { verified: false, verified_type: "Business" };
	if (type === "government" || type === "government_individual") return { verified: false, verified_type: "Government" };
	return { verified: false };
}

// the profile header shows the website from the bio's url entity
function urlEntities(u: User) {
	if (!u.website) return {};
	const display = u.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
	return { url: { urls: [{ display_url: display, expanded_url: u.website, url: u.website, indices: [0, u.website.length] }] } };
}

// The badge after the name: an affiliate's organisation, which links to the
// organisation, or else the account's pride flag. There is room for one.
type Badge = { url: string; description: string; org?: string };

// Everything an account wears after its name, in order: its organisation's
// badge, its custom badges, its pride flag, and a globe for an account from
// another instance. X has one slot for it, which gets
// the first; the page script (badges.ts) draws the others after that one.
export function badgeList(u: User): Badge[] {
	const out: Badge[] = [];
	for (const o of [u.org, ...(u.more_orgs ?? [])]) if (o) out.push({ url: absolute(o.avatar_url) ?? DEFAULT_AVATAR, description: o.name, org: o.screen_name });
	for (const b of u.badges ?? []) out.push({ url: badgeUrl(b.id), description: b.name });
	for (const b of u.remote_badges ?? []) out.push({ url: b.url, description: b.name });
	for (const f of flagList(u.flag)) out.push({ url: `${PUBLIC_ORIGIN}/public/flag-${f}.svg`, description: `${FLAGS[f].name} flag` });
	// an account from another instance, last so its own badges keep their place
	// the address names the instance, for the card the page script opens on a click (badges.ts)
	if (u.instance) out.push({ url: `${PUBLIC_ORIGIN}/public/globe.svg?from=${encodeURIComponent(u.instance)}`, description: `From ${u.instance}` });
	return out;
}

// X's one label slot: "Automated by @owner" for a bot, a profile label, else
// the first badge. The client puts a parody, commentary or fan label there
// before anything we send. When a label has it, every badge goes through the
// page script (badges.ts). A bot's other labels go the same way (hiddenLabels).
const hasParodyLabel = (u: User) => !!u.parody_label && u.parody_label !== "None" && !hidesParody();
export const labelTakesSlot = (u: User) => !!u.automated_by || hasParodyLabel(u) || !!u.label;

// the client's own mask icon, for a staff-made label without a badge; its
// file name changes with each client build
let mask: string | undefined;
function parodyMask(): string {
	if (mask === undefined) {
		const dir = join(CLIENT_DIR, "abs", "responsive-web", "client-web");
		const file = (() => {
			try {
				return readdirSync(dir).find((f) => /^parody-mask\.\w+\.svg$/.test(f));
			} catch {
				return undefined;
			}
		})();
		mask = file ? `${PUBLIC_ORIGIN}/abs/responsive-web/client-web/${file}` : "";
	}
	return mask;
}

// the same mask for a bot's extra label (badges.ts), which always wants one:
// a fresh instance hasn't downloaded the svg yet, but the pinned main bundle
// names it, and the server fetches it on first use. "" isn't kept, so a client
// fetched later is found
let bundleMask: string | undefined;
function parodyMaskIcon(): string {
	if (parodyMask()) return parodyMask();
	if (bundleMask !== undefined) return bundleMask;
	try {
		const build = JSON.parse(readFileSync(join(CLIENT_DIR, "build.json"), "utf8"));
		const main = (build.scripts as string[] | undefined)?.find((p) => /(?:^|\/)main\.\w+\.js$/.test(p));
		if (!main) return "";
		const found = readFileSync(join(CLIENT_DIR, "abs", main.replace(/^\//, "")), "utf8").match(/parody-mask\.\w+\.svg/);
		bundleMask = found ? `${PUBLIC_ORIGIN}/abs/responsive-web/client-web/${found[0]}` : "";
		return bundleMask;
	} catch {
		return "";
	}
}

const PCF_TEXT: Record<string, string> = { Parody: "Parody account", Commentary: "Commentary account", Fan: "Fan account" };
const parodyText = (u: User) => PCF_TEXT[u.parody_label!] ?? `${u.parody_label} account`;

// labels the client's one slot hides when "Automated by @owner" takes it;
// badges.ts draws each as its own badge on that row
export function hiddenLabels(u: User): { text: string; url?: string; icon?: string }[] {
	if (!u.automated_by) return [];
	const out: { text: string; url?: string; icon?: string }[] = [];
	if (hasParodyLabel(u)) {
		const icon = parodyMaskIcon();
		out.push({ text: parodyText(u), url: `${PUBLIC_ORIGIN}/rules`, ...(icon ? { icon } : {}) });
	}
	if (u.label) {
		const icon = u.label.badge_id ? badgeUrl(u.label.badge_id) : parodyMaskIcon();
		out.push({ text: u.label.text, ...(u.label.url ? { url: u.label.url } : {}), ...(icon ? { icon } : {}) });
	}
	return out;
}

// a staff-made label, in the shape the client gives its parody label
function profileLabel(l: NonNullable<User["label"]>) {
	const icon = l.badge_id ? badgeUrl(l.badge_id) : parodyMask();
	return {
		label: {
			...(icon ? { badge: { url: icon } } : {}),
			description: l.text,
			...(l.url ? { url: { url: l.url, urlType: "ExternalUrl" } } : {}),
		},
	};
}

function automatedLabel(owner: string) {
	const text = `Automated by @${owner}`;
	return {
		label: {
			description: "Automated",
			// the mention links to the managing account
			longDescription: { text, entities: [{ fromIndex: text.indexOf("@"), toIndex: text.length, ref: { type: "TimelineRichTextMention", screen_name: owner, mention_results: {} } }] },
			userLabelType: "AutomatedLabel",
		},
	};
}

function badgeLabel(u: User) {
	if (u.automated_by) return automatedLabel(u.automated_by);
	// the profile reads parody_commentary_fan_label, but search results, lists
	// and other user cells only ask for this slot: the label goes in both
	if (hasParodyLabel(u)) return profileLabel({ text: parodyText(u), badge_id: null, url: `${PUBLIC_ORIGIN}/rules` });
	if (u.label) return profileLabel(u.label);
	const [first] = badgeList(u);
	if (!first) return {};
	return {
		label: {
			badge: { url: first.url },
			description: first.description,
			...(first.org ? { url: { url: `twitter://user?screen_name=${first.org}`, urlType: "DeepLink" } } : {}),
			userLabelType: "BusinessLabel",
			userLabelDisplayType: "Badge",
		},
	};
}

const bioLanguage = (u: User) => {
	const language = u.bio?.trim() ? guessLang(u.bio) : "und";
	const viewer = requestLanguage()?.split("-")[0]?.toLowerCase();
	return { profile_description_language: language, is_profile_translatable: !!viewer && language !== "und" && language !== viewer };
};

export function userResult(u: User) {
	return {
		__typename: "User",
		action_counts: { favorites_count: u.stats?.likes ?? 0 },
		affiliates_highlighted_label: badgeLabel(u),
		...(oldClient() ? { xitter_badges: badgeList(u) } : {}),
		...(isOrganization(u) ? { business_account: { affiliates_count: u.affiliates ?? 0 } } : {}),
		avatar: { image_url: avatarSrc(u.avatar_url) ?? DEFAULT_AVATAR },
		...bioLanguage(u),
		...(u.banner_url ? { banner: { image_url: absolute(u.banner_url) } } : {}),
		core: { created_at: apiDate(u.created_at), name: u.name, screen_name: u.screen_name },
		follow_request_sent: !!u.stats?.requestedByViewer,
		has_graduated_access: true,
		id: globalId("User", u.id),
		is_blue_verified: isVerified(u),
		location: { location: u.location },
		media_permissions: { can_media_tag: u.stats?.mediaTaggable ?? true },
		notifications_settings: { notifications_enabled: !!u.stats?.notifying },
		// "None": the slot is affiliates_highlighted_label (badgeLabel); extras a
		// bot hid go through badges.ts. this field's label isn't shown
		parody_commentary_fan_label: "None",
		pinned_items: u.pinned_post_id ? { tweet_ids_str: [u.pinned_post_id] } : {},
		possibly_sensitive: false,
		privacy: { protected: !!u.protected },
		profile_bio: { description: u.bio, entities: { description: { urls: bioEntities(u.bio ?? ""), user_mentions: bioMentions(u) }, ...urlEntities(u) } },
		profile_image_shape: pictureShape(u),
		profile_metadata: { profile_interstitial_type: "" },
		profile_translation: { translator_type: translatorType(u), translator_type_enum: { badged: "Badged", moderator: "Moderator", none: "None" }[translatorType(u)] },
		relationship_counts: { followers: u.stats?.followers ?? 0, following: u.stats?.following ?? 0 },
		relationship_perspectives: {
			blocked_by: u.stats?.blockedBy ?? false,
			blocking: u.stats?.blocking ?? false,
			followed_by: u.stats?.followsViewer ?? false,
			following: u.stats?.followedByViewer ?? false,
			live_following: false,
			muting: u.stats?.muting ?? false,
		},
		rest_id: u.id,
		super_follow_eligible: false,
		super_followed_by: false,
		super_following: false,
		tweet_counts: { media_tweets: u.stats?.mediaPosts ?? 0, tweets: u.stats?.posts ?? 0 },
		user_seed_tweet_count: u.stats?.articles ?? 0,
		highlights_info: { can_highlight_tweets: true, highlighted_tweets: String(u.stats?.highlights ?? 0) },
		verification: verification(u),
		verification_info: verificationInfo(u),
		verified_user_profiles: { super_follows_user_profile: { is_active: false } },
		website: { url: u.website ?? "" },
	};
}

// The 2020 client (client/old) has one checkmark and no affiliate badge. Its
// `verified` carries both: true, "business" or "government" paint the check
// (patch.ts LEGACY_RULES), and with badges it is an object that also
// names the badges to draw after the name: the label first, then the rest.
export function oldVerified(blue: boolean, type: string | undefined, label: any, badges: Badge[] = []): unknown {
	const check = !blue ? false : type === "Business" ? "business" : type === "Government" ? "government" : true;
	const shown: { img: string; name: string }[] = [];
	if (label?.badge?.url) shown.push({ img: label.badge.url, name: label.description ?? "" });
	for (const b of badges) if (!shown.some((s) => s.img === b.url)) shown.push({ img: b.url, name: b.description });
	if (!shown.length) return check;
	const org = /screen_name=([^&]+)/.exec(label?.url?.url ?? "")?.[1];
	return { t: check, img: shown[0].img, name: shown[0].name, ...(org ? { org } : {}), ...(shown.length > 1 ? { more: shown.slice(1) } : {}) };
}
const oldClient = () => !!loadBuild()?.build.stateBase;
// a fragment, so the picture loads as ever; shell.ts squares what carries it
export const SQUARE_MARK = "#square";
export const oldAvatar = (url: string | undefined, shape: string | undefined) => (url && shape === "Square" ? url + SQUARE_MARK : url);

// older REST-style user record, used inside the page's initial state
export function legacyUser(u: User) {
	return {
		name: u.name,
		screen_name: u.screen_name,
		id_str: u.id,
		favourites_count: u.stats?.likes ?? 0,
		creator_subscriptions_count: 0,
		...bioLanguage(u),
		location: u.location,
		notifications: !!u.stats?.notifying,
		want_retweets: !u.stats?.repostsMuted,
		possibly_sensitive: false,
		entities: { description: { urls: bioEntities(u.bio ?? ""), user_mentions: bioMentions(u) }, ...urlEntities(u) },
		profile_image_shape: pictureShape(u),
		profile_interstitial_type: "",
		is_translator: translatorType(u) !== "none",
		translator_type: translatorType(u),
		followers_count: u.stats?.followers ?? 0,
		friends_count: u.stats?.following ?? 0,
		media_count: u.stats?.mediaPosts ?? 0,
		user_seed_tweet_count: u.stats?.articles ?? 0,
		statuses_count: u.stats?.posts ?? 0,
		url: u.website ?? "",
		pinned_tweet_ids_str: u.pinned_post_id ? [u.pinned_post_id] : [],
		is_blue_verified: isVerified(u),
		...(shownVerifiedType(u) === "business" ? { verified_type: "Business" } : {}),
		...(shownVerifiedType(u) === "government" || shownVerifiedType(u) === "government_individual" ? { verified_type: "Government" } : {}),
		super_follow_eligible: false,
		super_followed_by: false,
		super_following: false,
		verified_user_profiles: { super_follows_user_profile: { is_active: false } },
		verified: oldClient() ? oldVerified(isVerified(u), verification(u).verified_type, (badgeLabel(u) as any).label, badgeList(u)) : false,
		protected: !!u.protected,
		profile_image_url_https: oldClient() ? oldAvatar(avatarSrc(u.avatar_url) ?? DEFAULT_AVATAR, pictureShape(u)) : (avatarSrc(u.avatar_url) ?? DEFAULT_AVATAR),
		...(u.banner_url ? { profile_banner_url: absolute(u.banner_url) } : {}),
		can_media_tag: u.stats?.mediaTaggable ?? true,
		// with a default avatar and no bio or banner the client offers its "Set up
		// profile" onboarding flow, which we don't run; this keeps the Edit profile dialog
		default_profile_image: false,
		default_profile: false,
		follow_request_sent: !!u.stats?.requestedByViewer,
		description: u.bio,
		blocked_by: u.stats?.blockedBy ?? false,
		blocking: u.stats?.blocking ?? false,
		followed_by: u.stats?.followsViewer ?? false,
		following: u.stats?.followedByViewer ?? false,
		live_following: false,
		muting: u.stats?.muting ?? false,
		has_graduated_access: true,
		created_at: u.created_at.toISOString(),
		// "None": the slot is affiliates_highlighted_label (badgeLabel); extras a
		// bot hid go through badges.ts. this field's label isn't shown
		parody_commentary_fan_label: "None",
		can_dm: false,
	};
}

// a post joined with its author, counters and the viewer's own state
export type PostRow = {
	id: string;
	text: string;
	reply_to_id: string | null;
	conversation_id: string;
	quote_id: string | null;
	created_at: Date;
	source?: string;
	communityNote?: { id: string; text: string };
	sensitive?: boolean;
	never_sensitive?: boolean;
	reply_user_id: string | null;
	reply_screen_name: string | null;
	like_count: number;
	repost_count: number;
	bookmark_count: number;
	reply_count: number;
	quote_count: number;
	liked: boolean;
	reposted: boolean;
	bookmarked: boolean;
	author: User;
	media?: MediaRow[];
	article_id?: string | null;
	community_id?: string | null;
	// the Circle a post is in (circles.ts)
	circle_owner?: { id: string; screen_name: string } | null;
	poll_id?: string | null;
	place_id?: string | null;
	edit_count?: number;
	view_count?: number;
	reply_policy?: string | null;
	// a label staff put under the post (softInterventionPivot): X's type, its text and link
	notice?: { type: string; text: string; url?: string } | null;
	// the viewer may not reply to this conversation
	reply_limited?: boolean;
	conversation_policy?: string | null;
	conversation_selections?: string[] | null;
	conversation_owner?: string | null;
	edited_at?: Date | null;
	// ids the post went by before each edit, oldest first
	versionIds?: string[];
	// set on an older version: the post it is a version of
	staleEditOf?: string;
	// the poll card this post carries, as pollCard builds it
	poll?: Record<string, unknown>;
	conversationCard?: ConversationCard | null;
	conversationCardPostId?: string | null;
	conversationCreative?: MediaRow;
	linkCard?: Record<string, unknown>;
	// the community this post belongs to, as communityObjects builds it
	community?: Record<string, unknown>;
	// accounts named with @ in the text
	mentions?: { id: string; screen_name: string; name: string }[];
	// the published article this post carries
	article?: ArticleEntity;
	// the post this one quotes, when it still exists
	quoted?: PostRow;
	// links in the text to posts that have a page here
	localLinks?: Map<string, string>;
};

const EDIT_WINDOW_MS = 60 * 60 * 1000;
const MAX_EDITS = 5;

// the latest version is the post's own id and comes last; an older version
// shows the same list but is never eligible
function editControl(p: PostRow) {
	const latest = p.staleEditOf ?? p.id;
	const until = (p.staleEditOf ? undefined : p.created_at.getTime()) ?? 0;
	const remaining = MAX_EDITS - (p.edit_count ?? 0);
	return {
		edit_tweet_ids: [...(p.versionIds ?? []), latest],
		editable_until_msecs: String(p.staleEditOf ? 0 : until + EDIT_WINDOW_MS),
		edits_remaining: String(Math.max(remaining, 0)),
		is_edit_eligible: !p.staleEditOf && remaining > 0 && !p.reply_to_id && Date.now() < until + EDIT_WINDOW_MS,
	};
}

const permalink = (p: PostRow) => `${PUBLIC_ORIGIN}/${p.author.screen_name}/status/${p.id}`;

// @names in the text that belong to an account, with code point offsets as the client expects
export function userMentions(p: PostRow) {
	if (!p.mentions?.length) return [];
	const byName = new Map(p.mentions.map((m) => [m.screen_name.toLowerCase(), m]));
	return mentionsIn(p.text, homeOf(p.author.screen_name)).flatMap(({ key, start, end }) => {
		const user = byName.get(key);
		return user ? [{ id_str: user.id, indices: [start, end], name: user.name, screen_name: user.screen_name }] : [];
	});
}

export const bioMentions = (u: User) =>
	mentionsIn(u.bio ?? "", homeOf(u.screen_name)).map(({ key, start, end }) => ({ id_str: "", indices: [start, end], screen_name: key }));

// #tags in the text; the client links each to a search for it
export function hashtags(text: string) {
	// any script's letters (#привет), at least one letter, not glued to a word before it
	return [...text.matchAll(/(?<![\p{L}\p{N}_#&])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu)].map((m) => {
		const start = [...text.slice(0, m.index)].length;
		return { indices: [start, start + [...m[0]].length], text: m[1] };
	});
}

// a post its viewer may not reply to travels in the visibility wrapper, which is
// where the client reads limitedActionResults from
export function tweetResult(p: PostRow, withTypename = true): Record<string, unknown> {
	const tweet = plainTweet(p, withTypename);
	const audience = p.conversation_policy === "Community" ? `Accounts @${p.conversation_owner} follows can reply` : p.conversation_policy === "MyNetwork" ? `Accounts @${p.conversation_owner} follows and accounts they follow can reply` : p.conversation_policy === "Followers" ? `Accounts following @${p.conversation_owner} can reply` : ["Verified", "Premium"].includes(p.conversation_policy ?? "") ? "Verified accounts can reply" : ["Country", "CountryOfOrigin"].includes(p.conversation_policy ?? "") ? `Accounts based in ${(p.conversation_selections ?? []).join(", ")} can reply` : `Accounts @${p.conversation_owner} mentioned can reply`;
	if ((!p.reply_limited && !p.notice) || !withTypename) return tweet;
	return {
		__typename: "TweetWithVisibilityResults",
		tweet,
		...(p.notice ? { softInterventionPivot: noticePivot(p.notice) } : {}),
		...(p.reply_limited ? { limitedActionResults: {
			limited_actions: [
				{
					action: "Reply",
					prompt: {
						__typename: "CtaLimitedActionPrompt",
						cta_type: "SeeConversation",
						headline: { text: "Who can reply?", entities: [] },
						subtext: { text: audience + (p.conversation_policy === "ByInvitation" ? "" : ". Accounts mentioned in the original post can also reply."), entities: [] },
					},
				},
			],
		} } : {}),
	};
}

// A notification's post (its preview line): the client reads only a plain
// Tweet there, so a post with a notice or limited replies goes unwrapped.
export const plainTweetResult = (p: PostRow) => plainTweet(p, true);

// A label under a post, as X sends it (softInterventionPivot): its kind, the
// text, and the link the text and its "Learn more" lead to (the instance's
// rules unless staff gave one).
export const NOTICE_TYPES = {
	Fosnr: "Visibility limited: this post may violate the rules of this instance.",
	Misleading: "This post may be misleading.",
	StayInformed: "Stay informed: get the facts from reliable sources.",
	GetTheLatest: "Get the latest from reliable sources.",
	GovernmentRequested: "This post is withheld or limited in response to a legal demand.",
} as const;
function noticePivot(n: { type: string; text: string; url?: string }) {
	const url = n.url || `${PUBLIC_ORIGIN}/rules`;
	const text = n.text || NOTICE_TYPES[n.type as keyof typeof NOTICE_TYPES] || "";
	const link = { url, urlType: "ExternalUrl" };
	return {
		softInterventionDisplayType: n.type,
		displayType: "TweetFooter",
		text: { rtl: false, text, entities: [] },
		url: link,
		landingUrl: link,
	};
}

// A money card's link closing the text is the card's own, as X does with a
// card's link: the shown text stops before it and the space before it
// (money.ts), so the post doesn't end in a blank line over its card.
function shownUpTo(p: PostRow, shown: string, textLength: number) {
	const link = (p.linkCard as { rest_id?: unknown } | undefined)?.rest_id;
	if (typeof link !== "string" || !link.includes("/i/xmoney/")) return textLength;
	const kept = shown.trimEnd();
	return kept.endsWith(link) ? [...kept.slice(0, kept.length - link.length).trimEnd()].length : textLength;
}

function plainTweet(p: PostRow, withTypename: boolean): Record<string, unknown> {
	// a long post: timelines get its start and "Show more", the post page the
	// whole text (note_tweet), with entities for each
	const long = weightedLength(p.text) > SHORT_POST;
	const shown = long ? previewOf(p.text) : p.text;
	const textLength = [...shown].length;
	const allMentions = userMentions(p);
	const allTags = hashtags(p.text);
	const mentions = allMentions.filter((m: any) => m.indices[1] <= textLength);
	const tags = allTags.filter((t: any) => t.indices[1] <= textLength);
	const urls = linkEntities(shown, textLength, p.localLinks);
	const creative = p.conversationCreative ?? p.media?.[0];
	const conversation = p.conversationCard && creative ? conversationCardEntity(p.conversationCard, p.conversationCardPostId ?? p.id, { kind: creative.kind, url: mediaUrl(creative.id, creative.mime), width: creative.width, height: creative.height, poster: posterUrl(creative.id), stream: `${PUBLIC_ORIGIN}/media/card-video/${creative.id}.xml`, duration: creative.duration_ms }) : undefined;
	const media = (conversation ? [] : p.media ?? []).map((m, i) => mediaEntity(m, p.id, p.author.screen_name, i, textLength));
	const quoteLink = p.quoted && permalink(p.quoted);
	return {
		...(withTypename ? { __typename: "Tweet" } : {}),
		...(p.communityNote ? { has_birdwatch_notes: true, birdwatch_pivot: {
			title: "Readers added context they thought people might want to know", shorttitle: "Readers added context",
			subtitle: noteText(p.communityNote.text), iconType: "BirdwatchLevelHigh", footerIconType: "BirdwatchLevelHigh", visualStyle: "Default",
			destinationUrl: `/i/birdwatch/n/${p.communityNote.id}`, note: { rest_id: p.communityNote.id, language: "en", is_community_note_translatable: false, grok_translated_community_note_with_availability: { is_available: false } },
			footer: { text: `Context is written by people who use ${settings().instance_name}, and appears when rated helpful by others.`, entities: [] },
			callToAction: { destinationUrl: `/i/birdwatch/n/${p.communityNote.id}`, prompt: "Is this note helpful?", title: "Rate it" },
		} } : {}),
		...(p.quoted ? { quoted_status_result: { result: tweetResult(p.quoted) } } : {}),
		...(p.article ? { article: { article_results: { result: p.article } } } : {}),
		...(p.community ? { community_results: { result: p.community } } : {}),
		...(p.conversationCard ? { xitter_conversation_card: p.conversationCard } : {}),
		...(conversation ? { card: conversation } : p.poll ? { card: p.poll } : p.linkCard ? { card: p.linkCard } : {}),
		...(long ? { note_tweet: { is_expandable: true, note_tweet_results: { result: {
			id: globalId("NoteTweet", p.id),
			text: p.text,
			entity_set: { hashtags: allTags, user_mentions: allMentions, urls: linkEntities(p.text, undefined, p.localLinks), symbols: [] },
		} } } } : {}),
		cashtag_attachments: [],
		core: { user_results: { result: userResult(p.author) } },
		edit_control: editControl(p),
		...(p.conversation_policy
			? { conversation_control: { policy: p.conversation_policy === "CountryOfOrigin" ? "Co" : p.conversation_policy, conversation_owner_results: { result: { __typename: "User", legacy: { screen_name: p.conversation_owner } } } }, ...(["Country", "CountryOfOrigin"].includes(p.conversation_policy) ? { conversation_control_details: { mode: p.conversation_policy, allowed_country_codes: p.conversation_selections ?? [] } } : {}) }
			: {}),
		grok_analysis_button: feature("grok"),
		grok_annotations: {},
		grok_translated_post_with_availability: { is_available: false },
		legacy: {
			bookmark_count: p.bookmark_count,
			bookmarked: p.bookmarked,
			conversation_id_str: p.conversation_id,
			created_at: apiDate(p.created_at),
			display_text_range: [0, shownUpTo(p, shown, textLength)],
			entities: {
				...(media.length ? { media } : {}),
				...(mentions.length ? { user_mentions: mentions } : {}),
				...(tags.length ? { hashtags: tags } : {}),
				...(urls.length ? { urls } : {}),
			},
			...(media.length ? { extended_entities: { media } } : {}),
			favorite_count: p.like_count,
			favorited: p.liked,
			full_text: shown,
			possibly_sensitive: !!p.sensitive,
			...(placeById(p.place_id) ? { place: placeById(p.place_id) } : {}),
			source: shownSource(p.source, p.author.instance).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!),
			id_str: p.id,
			...(p.reply_to_id
				? {
						in_reply_to_status_id_str: p.reply_to_id,
						...(p.reply_user_id ? { in_reply_to_screen_name: p.reply_screen_name, in_reply_to_user_id_str: p.reply_user_id } : {}),
					}
				: {}),
			is_quote_status: !!p.quote_id || !!p.quoted,
			...(p.quoted && quoteLink
				? {
						quoted_status_id_str: p.quoted.id,
						quoted_status_permalink: { url: quoteLink, expanded: quoteLink, display: quoteLink.replace(/^https?:\/\//, "") },
					}
				: {}),
			lang: guessLang(p.text),
			quote_count: p.quote_count,
			reply_count: p.reply_count,
			retweet_count: p.repost_count,
			retweeted: p.reposted,
			user_id_str: p.author.id,
		},
		rest_id: p.id,
		// "Only people in @owner's Circle can see this post"; the client reads the owner's handle
		...(p.circle_owner
			? {
					trusted_friends_info_result: {
						__typename: "ApiTrustedFriendsInfo",
						owner_results: {
							result:
								p.circle_owner.id === p.author.id
									? userResult(p.author)
									: { __typename: "User", id: globalId("User", p.circle_owner.id), rest_id: p.circle_owner.id, core: { screen_name: p.circle_owner.screen_name, name: p.circle_owner.screen_name }, legacy: { screen_name: p.circle_owner.screen_name, name: p.circle_owner.screen_name } },
						},
					},
				}
			: {}),
		unmention_data: {},
		unmention_info: {},
		views: p.view_count ? { count: String(p.view_count), state: "EnabledWithCount" } : { state: "Enabled" },
	};
}

// A repost is its own post by the reposter: "RT @author: text" with the
// original nested inside, carrying the counters and viewer state of the original.
export function repostResult(id: string, by: User, createdAt: Date, original: PostRow) {
	const text = `RT @${original.author.screen_name}: ${original.text}`;
	return {
		__typename: "Tweet",
		cashtag_attachments: [],
		core: { user_results: { result: userResult(by) } },
		edit_control: { edit_tweet_ids: [id], editable_until_msecs: String(createdAt.getTime()), edits_remaining: "0", is_edit_eligible: false },
		grok_analysis_button: feature("grok"),
		grok_annotations: {},
		grok_translated_post_with_availability: { is_available: false },
		is_translatable: false,
		legacy: {
			bookmark_count: original.bookmark_count,
			bookmarked: original.bookmarked,
			conversation_id_str: id,
			created_at: apiDate(createdAt),
			display_text_range: [0, [...text].length],
			entities: {
				user_mentions: [
					{
						id_str: original.author.id,
						indices: [3, 4 + original.author.screen_name.length],
						name: original.author.name,
						screen_name: original.author.screen_name,
					},
				],
			},
			favorite_count: original.like_count,
			favorited: original.liked,
			full_text: text,
			id_str: id,
			is_quote_status: false,
			lang: "und",
			quote_count: original.quote_count,
			reply_count: original.reply_count,
			retweet_count: original.repost_count,
			retweeted: original.reposted,
			retweeted_status_result: { result: tweetResult(original) },
			user_id_str: by.id,
		},
		rest_id: id,
		unmention_data: {},
		unmention_info: {},
		views: { state: "Enabled" },
	};
}

type SocialContext =
	| { type: "TimelineGeneralContext"; contextType: string; text: string; landingUrl?: { url: string; urlType: string } }
	| { type: "TimelineTopicContext"; topic: unknown; functionalityType: string };

const tweetItem = (result: unknown, socialContext?: SocialContext, displayType = "Tweet") => ({
	__typename: "TimelineTweet",
	itemType: "TimelineTweet",
	tweetDisplayType: displayType,
	tweet_results: { result },
	...(socialContext ? { socialContext } : {}),
});

const itemEntry = (id: string, result: unknown, sortIndex: string, socialContext?: SocialContext, feedbackKeys?: string[]) => ({
	content: {
		__typename: "TimelineTimelineItem",
		entryType: "TimelineTimelineItem",
		itemContent: tweetItem(result, socialContext),
		...(feedbackKeys ? { feedbackInfo: { feedbackKeys } } : {}),
	},
	entryId: `tweet-${id}`,
	sortIndex,
});

// a post made in a community says so above itself, like a pinned one does
const communityContext = (p: PostRow): SocialContext | undefined => {
	const name = typeof p.community?.name === "string" ? p.community.name : undefined;
	return name ? { type: "TimelineGeneralContext", contextType: "Community", text: name, landingUrl: { url: `/i/communities/${p.community_id}`, urlType: "ExternalUrl" } } : undefined;
};

export const tombstoneEntry = (id: string, text: string, sortIndex: string) =>
	itemEntry(id, { __typename: "TweetTombstone", tombstone: { __typename: "TextTombstone", text: { rtl: false, text, entities: [] } } }, sortIndex);
export const tweetEntry = (p: PostRow, sortIndex: string) => itemEntry(p.id, tweetResult(p), sortIndex, communityContext(p));

// the client lifts an entry to the top of a profile only when it carries this label
export const pinnedEntry = (p: PostRow, sortIndex: string) =>
	itemEntry(p.id, tweetResult(p), sortIndex, { type: "TimelineGeneralContext", contextType: "Pin", text: "Pinned" });

// A boosted post (the shop's Post boost) as X's ad entry: the client marks
// one carrying promotedMetadata "Ad", with its author as the advertiser.
export const promotedEntry = (p: PostRow, sortIndex: string) => ({
	content: {
		__typename: "TimelineTimelineItem",
		entryType: "TimelineTimelineItem",
		itemContent: {
			...tweetItem(tweetResult(p)),
			promotedMetadata: {
				advertiser_results: { result: userResult(p.author) },
				disclosureType: "NoDisclosure",
				experimentValues: [],
				impressionId: BigInt(sortIndex).toString(16),
				impressionString: BigInt(sortIndex).toString(16),
				clickTrackingInfo: { urlParams: [] },
			},
		},
	},
	entryId: `promoted-tweet-${p.id}-${sortIndex}`,
	sortIndex,
});

// a post or a repost from feed(); entry ids are item ids, so both fit in one timeline.
// `topic`: the followed topic that brought a stranger's post into "For you".
export const feedEntry = (
	item: { id: string; post: PostRow; repost?: { by: User; created_at: Date } },
	sortIndex: string,
	topic?: { context: SocialContext; feedbackKeys: string[] },
) =>
	item.repost
		? itemEntry(item.id, repostResult(item.id, item.repost.by, item.repost.created_at, item.post), sortIndex)
		: topic
			? itemEntry(item.post.id, tweetResult(item.post), sortIndex, topic.context, topic.feedbackKeys)
			: tweetEntry(item.post, sortIndex);

// the Media tab: one grid module, later pages append to it
const GRID = "profile-grid-0";
const gridItems = (posts: PostRow[], grid: string) =>
	posts.map((p) => ({ entryId: `${grid}-tweet-${p.id}`, item: { itemContent: tweetItem(tweetResult(p), undefined, "MediaGrid") } }));
// grid is the module's id: the profile's media tab and search each have their own
export const gridEntry = (posts: PostRow[], sortIndex: string, grid = GRID) => ({
	content: {
		__typename: "TimelineTimelineModule",
		displayType: "VerticalGrid",
		entryType: "TimelineTimelineModule",
		items: gridItems(posts, grid),
	},
	entryId: grid,
	sortIndex,
});
export const gridAppend = (posts: PostRow[], grid = GRID) => ({ type: "TimelineAddToModule", moduleEntryId: grid, moduleItems: gridItems(posts, grid) });

// One reply shown as its own thread under the opened post. `feedbackKey` points
// at a TweetDetail responseObjects feedback action (the pin/unpin menu item).
export type ThreadItem = { post: PostRow; parent?: string; indent?: boolean; pinned?: boolean; feedbackKey?: string };
export type ThreadMore = { value: string; after: string };
const threadItemId = (root: string, id: string) => `conversationthread-${root}-tweet-${id}`;
const treeDisplay = (root: string, parent: string | undefined, indent = false) =>
	parent ? { treeDisplay: { parentModuleItemEntryId: threadItemId(root, parent), indentFromParent: indent } } : {};
export const threadItems = (root: string, items: ThreadItem[], more?: ThreadMore) => [
	...items.map((it) => ({
		entryId: threadItemId(root, it.post.id),
		item: {
			itemContent: tweetItem(tweetResult(it.post), it.pinned ? { type: "TimelineGeneralContext", contextType: "ReplyPin", text: "Pinned" } : undefined),
			...(it.feedbackKey ? { feedbackInfo: { feedbackKeys: [it.feedbackKey] } } : {}),
		},
		...treeDisplay(root, it.parent, it.indent),
	})),
	...(more
		? [
				{
					entryId: `conversationthread-${root}-cursor-showmore-${more.after}`,
					item: {
						itemContent: {
							__typename: "TimelineTimelineCursor",
							itemType: "TimelineTimelineCursor",
							cursorType: "ShowMore",
							value: more.value,
							displayTreatment: { actionText: "Show replies" },
						},
					},
					...treeDisplay(root, more.after),
				},
			]
		: []),
];
export const threadEntry = (root: string, items: ThreadItem[], sortIndex: string, more?: ThreadMore) => ({
	content: {
		__typename: "TimelineTimelineModule",
		displayType: "VerticalConversation",
		entryType: "TimelineTimelineModule",
		items: threadItems(root, items, more),
		metadata: { conversationMetadata: { allTweetIds: items.map((it) => it.post.id), enableDeduplication: true } },
	},
	entryId: `conversationthread-${root}`,
	sortIndex,
});

export const showMoreThreadsEntry = (value: string, sortIndex: string) => ({
	content: {
		__typename: "TimelineTimelineCursor",
		cursorType: "ShowMoreThreads",
		entryType: "TimelineTimelineCursor",
		value,
		displayTreatment: { actionText: "Show more replies" },
	},
	entryId: `cursor-showmorethreads-${sortIndex}`,
	sortIndex,
});

export const cursorEntry = (type: "Top" | "Bottom", value: string, sortIndex: string) => ({
	content: { __typename: "TimelineTimelineCursor", cursorType: type, entryType: "TimelineTimelineCursor", value },
	entryId: `cursor-${type.toLowerCase()}-${sortIndex}`,
	sortIndex,
});

export const userEntry = (u: User, sortIndex: string) => ({
	content: {
		__typename: "TimelineTimelineItem",
		entryType: "TimelineTimelineItem",
		itemContent: { __typename: "TimelineUser", itemType: "TimelineUser", userDisplayType: "User", user_results: { result: userResult(u) } },
	},
	entryId: `user-${u.id}`,
	sortIndex,
});
