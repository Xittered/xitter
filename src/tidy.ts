// What the page changes in the client: features this instance switches off
// (admin panel > Settings > Features), links to x.com pages, X's own sign-in
// screens, and the announcement banner. CSS where an element has a stable link
// or test id, a small script where only its text tells it apart.

import { FEDERATION_ON } from "./federation";
import { sql } from "./db";
import { isOrganizationSql } from "./users";
import { type Feature, feature, settings } from "./settings";
import { choiceAllowed } from "./client-choice";
import { gifProviders } from "./gifs";

const links = (...hrefs: string[]) => hrefs.map((h) => `a[href="${h}"],a[href^="${h}?"]`);
const ids = (...testIds: string[]) => testIds.map((t) => `[data-testid="${t}"]`);

const BY_FEATURE: Record<Feature, string[]> = {
	communities: ['[role="menu"] a[href$="/communities"]'],
	lists: ['[role="menu"] a[href$="/lists"]'],
	gifs: ids("gifSearchButton"),
	polls: ids("createPollButton"),
	location: ids("geoButton"),
	scheduling: ids("scheduleOption"),
	grok: [...links("/i/grok"), ...ids("GrokDrawer")],
	image_gen: [...ids("grokImgGen"), '[role="dialog"] [aria-label="Edit with Imagine"]'],
	premium: [
		...links("/i/premium_sign_up", "/settings/premium", "/i/premium"),
		...ids("premium-signup-tab"),
		// the sidebar's upsell boxes ("Subscribe to Premium", "Spend $1k, Get $1k", ...) are
		// asides; the account suggestions are the asides worth keeping
		'[data-testid="sidebarColumn"] div:has(> aside:not([aria-label="Who to follow"]):not([aria-label="Relevant people"]))',
		'[data-testid="sidebarColumn"] aside:not([aria-label="Who to follow"]):not([aria-label="Relevant people"])',
	],
	calls: [...links("/i/calls"), ...ids("AppTabBar_Calls_Link")],
	// only the menu entries: the History page itself holds the Bookmarks tab and its folders
	history: ["header", '[role="menu"]', '[data-testid="sidebarColumn"]'].flatMap((root) => links("/i/history").map((l) => `${root} ${l}`)),
	creator_studio: links("/i/jf/creators/studio", "/i/monetization", "/settings/monetization"),
	spaces: links("/i/spaces/start"),
	business: links("/i/verified-orgs-signup"),
};

// never offered: ads, x.com's help and footer pages, paid partnerships, jobs
const ALWAYS = [
	...links("/jobs"),
	...ids("contentDisclosureButton", "ProfessionalButton_Switch_To_Professional"),
	'[data-testid="toolBar"] [data-testid="ScrollSnap-List"] > [role="presentation"]:has([data-testid="contentDisclosureButton"])',
	'a[href^="https://ads.x.com"]',
	'a[href^="https://help.x.com"]',
	'[data-testid="sidebarColumn"] nav[aria-label="Footer"]',
	// the signed-out home page's footer keeps Terms and Privacy (our rules page)
	'nav[aria-label="Footer"] > div:has(> a[href^="http"]:not([href$="/tos"]):not([href$="/privacy"]))',
	'nav[aria-label="Footer"] > div:has(> a[href^="/i/jf/stories"])',
	// a menu's divider with nothing after it (the More menu ends with one, the
	// entries it led to being gone)
	'[role="menu"] [data-testid="Dropdown"] div:has(> [role="separator"]):last-child',
];

export function hideCss(): string {
	const off = (Object.keys(BY_FEATURE) as Feature[]).filter((f) => !feature(f)).flatMap((f) => BY_FEATURE[f]);
	return `${[...ALWAYS, ...off].join(",")}{display:none!important}
html[data-xitter-full] [data-testid="primaryColumn"] > :not(#xitter-pane){display:none!important}
#xitter-announcement{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;background:var(--xt-accent-fill,var(--xt-accent,#1d9bf0));color:#fff;font:15px TwitterChirp,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#xitter-announcement .xa-body{flex:1;min-width:0;display:grid;gap:10px}
#xitter-announcement .xa-text{white-space:pre-wrap;overflow-wrap:break-word}
#xitter-announcement .xa-buttons{display:flex;flex-wrap:wrap;gap:8px}
#xitter-announcement .xa-buttons a{display:inline-flex;align-items:center;min-height:32px;padding:0 14px;border-radius:8px;background:rgb(255 255 255 / .2);color:#fff;font-weight:700;font-size:14px;text-decoration:none;white-space:nowrap;transition:background-color 120ms ease-out}
#xitter-announcement .xa-buttons a:focus-visible{outline:2px solid #fff;outline-offset:2px}
@media (hover:hover){#xitter-announcement .xa-buttons a:hover{background:rgb(255 255 255 / .3)}}
#xitter-announcement button{border:0;background:none;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:0 4px}`;
}

// Our own account pages in the side bar's More menu, for the accounts they concern:
// invites while members can make them (member-invites.ts), the organisation
// page for organisations, their affiliates and people they asked (org-manage.ts)
const TICKET = "M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5V10a2 2 0 0 0 0 4v3.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V14a2 2 0 0 0 0-4V6.5zM5 7v1.8a4 4 0 0 1 0 6.4V17h14v-1.8a4 4 0 0 1 0-6.4V7H5z";
// Material Symbols "code"
const CODE = "M320-240 80-480l240-240 57 57-184 184 183 183-56 56Zm320 0-57-57 184-184-183-183 56-56 240 240-240 240Z";
const MOVE = "M3 11h13.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H3v-2z";
const BUILDING = "M4 21V3h11v4h5v14H4zm2-2h3v-3h2v3h2V5H6v14zm9 0h3V9h-3v10zM8 7h3v2H8V7zm0 4h3v2H8v-2z";
const SHIELD = "M12 1.5 3.5 5v6c0 5.2 3.6 10 8.5 11.5 4.9-1.5 8.5-6.3 8.5-11.5V5L12 1.5zm0 2.2 6.5 2.7V11c0 4.2-2.8 8.2-6.5 9.4-3.7-1.2-6.5-5.2-6.5-9.4V6.4L12 3.7zM11 7h2v6h-2V7zm0 8h2v2h-2v-2z";
const ROBOT = "M11 2h2v3h5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5V2zM6 7v11h12V7H6zm3 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm-6 5h6v1.5H9V15z";
// Material Symbols "upload"
const UPLOAD = "M440-320v-326L336-542l-56-58 200-200 200 200-56 58-104-104v326h-80ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z";
// Material Symbols "public"
const PALETTE = "M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Zm0-400Zm-220 40q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120-160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm200 0q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120 160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17ZM480-160q9 0 14.5-5t5.5-13q0-14-15-33t-15-57q0-42 29-67t71-25h70q66 0 113-38.5T800-518q0-121-92.5-201.5T488-800q-136 0-232 93t-96 227q0 133 93.5 226.5T480-160Z";
// the Equicoins mark (money.ts): an outlined, slanted S with a bar above and below;
// solid for the side bar while its page is open, as X fills its own icons
export const MONEY_ICON = "M9.69 5.11L10.04 3.60L15.04 3.60L14.76 4.80L18.46 4.80L17.31 9.80L15.63 9.80L16.33 10.13L17 10.66L17.52 11.33L17.77 11.85L17.94 12.41L18.04 13.32L17.95 14.26L17.78 14.90L17.53 15.53L17.21 16.14L16.58 17L16.09 17.52L15.55 17.98L14.96 18.39L14.34 18.72L13.69 18.99L13.27 20.80L8.27 20.80L8.61 19.30L4.61 19.30L5.77 14.30L7.74 14.30L7.05 13.97L6.37 13.44L6.01 13L5.61 12.25L5.38 11.39L5.34 10.78L5.38 10.15L5.60 9.20L5.85 8.57L6.37 7.66L6.80 7.10L7.29 6.58L7.83 6.12L8.42 5.71L9.04 5.38ZM13.13 5.15L11.23 5.15L10.95 6.36L10.28 6.45L9.71 6.63L8.98 7L8.48 7.37L7.89 7.96L7.52 8.46L7.16 9.18L7 9.74L6.93 10.60L6.98 11L7.21 11.65L7.41 11.98L7.66 12.27L7.96 12.52L8.30 12.72L8.79 12.90L9.51 13L13.55 13.01L13.89 13.11L14.17 13.30L14.44 13.71L14.50 14.06L14.46 14.43L14.23 14.97L13.97 15.29L13.65 15.55L13.09 15.80L12.68 15.85L6.96 15.85L6.52 17.75L10.52 17.75L10.18 19.25L12.08 19.25L12.42 17.74L13.10 17.65L13.67 17.47L14.40 17.10L14.90 16.73L15.49 16.14L15.85 15.64L16.21 14.92L16.38 14.36L16.45 13.50L16.39 13.10L16.17 12.45L15.97 12.12L15.71 11.83L15.41 11.58L15.07 11.38L14.58 11.20L13.87 11.10L9.83 11.09L9.34 10.91L9.10 10.68L8.94 10.39L8.88 10.04L8.91 9.67L9.15 9.13L9.56 8.67L9.91 8.44L10.29 8.30L10.70 8.25L16.12 8.25L16.55 6.35L12.85 6.35Z";
export const MONEY_ICON_FILLED = "M10.80 4.20L14 4.20L13.65 5.70L17.65 5.70L16.92 8.90L10.41 8.91L10.11 9.01L9.92 9.13L9.76 9.29L9.60 9.57L9.55 9.87L9.62 10.14L9.80 10.34L10.06 10.44L14.06 10.45L14.86 10.56L15.32 10.72L15.90 11.04L16.25 11.34L16.70 11.92L16.97 12.53L17.11 13.30L17.09 14.01L16.90 14.84L16.69 15.35L16.42 15.85L16.09 16.32L15.72 16.76L15.29 17.16L14.83 17.51L14.33 17.81L13.82 18.05L12.94 18.31L12.51 20.20L9.31 20.20L9.72 18.40L5.42 18.40L6.16 15.20L12.96 15.19L13.27 15.09L13.46 14.97L13.68 14.72L13.78 14.53L13.83 14.23L13.76 13.96L13.58 13.76L13.32 13.66L9.32 13.65L8.52 13.54L8.06 13.38L7.48 13.06L6.94 12.56L6.67 12.18L6.41 11.57L6.27 10.80L6.29 10.09L6.39 9.57L6.56 9.05L6.96 8.25L7.28 7.78L7.66 7.34L8.09 6.94L8.55 6.59L9.04 6.29L9.56 6.05L10.43 5.79Z";
const STATS = "M4 20V10h3v10H4zm6.5 0V4h3v16h-3zM17 20v-7h3v7h-3z";
const CIRCLE = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-3 5a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-3 5c-2.2 0-4 1.1-4 2.5V17h8v-.5c0-1.4-1.8-2.5-4-2.5z";
const TONE = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 1.8v14.4a7.2 7.2 0 0 0 0-14.4z";
const HISTORY = "M480-120q-138 0-240.5-91.5T122-440h82q14 104 92.5 172T480-200q117 0 198.5-81.5T760-480q0-117-81.5-198.5T480-760q-69 0-129 32t-101 88h110v80H120v-240h80v94q51-64 124.5-99T480-840q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-480q0 75-28.5 140.5t-77 114q-48.5 48.5-114 77T480-120Zm112-192L440-464v-216h80v184l128 128-56 56Z";
const GIF = "M120-120v-720h720v720H120Zm80-80h560v-560H200v560Zm80-80h400L560-520 440-360l-80-100-80 180Zm40-280q25 0 42.5-17.5T380-700q0-25-17.5-42.5T320-760q-25 0-42.5 17.5T260-700q0 25 17.5 42.5T320-660Z";
const CAT = "M5 3.5 9.2 7.6A9 9 0 0 1 12 7.2a9 9 0 0 1 2.8.4L19 3.5V12a7 7 0 0 1-14 0V3.5Zm4.5 8.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm5 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z";
// four tiles: the admin panel
const PANEL = "M3 3h8v10H3V3zm2 2v6h4V5H5zm8-2h8v6h-8V3zm2 2v2h4V5h-4zM3 15h8v6H3v-6zm2 2v2h4v-2H5zm8-4h8v8h-8v-8zm2 2v4h4v-4h-4z";
const KEY = "M280-400q-33 0-56.5-23.5T200-480q0-33 23.5-56.5T280-560q33 0 56.5 23.5T360-480q0 33-23.5 56.5T280-400Zm0 160q-100 0-170-70T40-480q0-100 70-170t170-70q67 0 121.5 33t86.5 87h352l120 120-180 180-80-60-80 60-85-60h-47q-32 54-86.5 87T280-240Zm0-80q56 0 98.5-34t56.5-86h125l58 41 82-61 71 55 75-75-40-40H435q-14-52-56.5-86T280-640q-66 0-113 47t-47 113q0 66 47 113t113 47Z";
const GLOBE = "M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm-40-82v-78q-33 0-56.5-23.5T360-320v-40L168-552q-3 18-5.5 36t-2.5 36q0 121 79.5 212T440-162Zm276-102q41-45 62.5-100.5T800-480q0-98-54.5-179T600-776v16q0 33-23.5 56.5T520-680h-80v80q0 17-11.5 28.5T400-560h-80v80h240q17 0 28.5 11.5T600-440v120h40q26 0 47 15.5t29 40.5Z";
// Every link under /account/ is a tab on the account pages. `where` adds it to the client too:
// the More menu, Settings > Your account, or both. The menu keeps only what
// someone may need to act on; the rest live in Settings. "nav" is an entry of
// its own in the side bar, its page filling the main column.
export type MenuLink = { href: string; text: string; description: string; icon: string; iconOn?: string; viewBox?: string; where: "menu" | "settings" | "both" | "tabs" | "nav" };
export async function menuLinks(userId: string): Promise<MenuLink[]> {
	const links: MenuLink[] = [];
	const s = settings();
	if (feature("money")) {
		links.push({ href: "/account/money", text: "Equicoins", description: "Send Equicoins to other accounts.", icon: MONEY_ICON, iconOn: MONEY_ICON_FILLED, where: "nav" });
		links.push({ href: "/account/merchant", text: "Equicoins", description: "Merchant mode: payments to your organisation read as purchases.", icon: MONEY_ICON, where: "settings" });
	}
	links.push({ href: "/account/apps", text: "Connected apps", description: "Review and remove apps authorized to use your account.", icon: CODE, viewBox: "0 -960 960 960", where: "settings" });
	if (s.invite_quota.enabled && s.signup_mode === "invite")
		links.push({ href: "/account/invites", text: "Invites", description: `Invite people you know to ${s.instance_name}.`, icon: TICKET, where: "both" });
	// the menu is for organisations, and for the people in or invited to one
	const [u] = await sql`select ${isOrganizationSql(sql`u`)}
			or exists (select 1 from affiliations where user_id = u.id) or exists (select 1 from affiliation_requests where user_id = u.id) as org,
		exists (select 1 from staff_messages where user_id = u.id and revoked_at is null) or exists (select 1 from moderation_appeals where user_id = u.id) as notices,
		coalesce(u.verified_type in ('business', 'government', 'government_individual'), false) as gold, u.role
		from users u where u.id = ${userId}::bigint`;
	if (u?.org) links.push({ href: "/account/organisation", text: "Organisation", description: "Manage affiliates, or answer an organisation that asked to add you.", icon: BUILDING, where: "both" });
	if (u?.gold) links.push({ href: "/account/decor", text: "Profile decor", description: "Dress your profile with a theme, background and avatar frame from Steam.", icon: PALETTE, viewBox: "0 -960 960 960", where: "settings" });
	links.push({ href: "/account/post-details", text: "Post details", description: "Show reposts, quotes and likes on a row of their own, as Twitter did.", icon: STATS, where: "settings" });
	if (feature("circles")) links.push({ href: "/account/circle", text: "Circle", description: "Choose who sees the posts you send to your Circle.", icon: CIRCLE, where: "settings" });
	if (choiceAllowed()) links.push({ href: "/account/client", text: "Twitter client", description: "Use the current client or an older Twitter one.", icon: HISTORY, viewBox: "0 -960 960 960", where: "settings" });
	links.push({ href: "/account/theme", text: "Theme", description: "Dim, a preset, or your own colours for the client.", icon: TONE, where: "settings" });
	if (feature("gifs") && gifProviders().length > 1) links.push({ href: "/account/gifs", text: "GIF provider", description: "Choose which provider supplies your GIF search results.", icon: GIF, viewBox: "0 -960 960 960", where: "settings" });
	links.push({ href: "/account/decoration", text: "Avatar decoration", description: "Put cat ears or a decoration around your avatar.", icon: CAT, where: "both" });
	links.push({ href: "/account/automation", text: "Automation", description: "Name the account that runs this one.", icon: ROBOT, where: "tabs" });
	if (u?.notices) links.push({ href: "/account/notices", text: "Staff notices", description: `Messages, warnings and strikes from the ${s.instance_name} team, and your appeals.`, icon: SHIELD, where: "both" });
	if (FEDERATION_ON) links.push({ href: "/account/instances", text: "Other instances", description: "Hide accounts and organisations from other instances.", icon: GLOBE, viewBox: "0 -960 960 960", where: "settings" });
	links.push({ href: "/account/passkeys", text: "Passkeys", description: "Sign in with your fingerprint, face or screen lock instead of a password.", icon: KEY, viewBox: "0 -960 960 960", where: "settings" });
	if (feature("archive_import")) links.push({ href: "/account/import", text: "Import from X", description: "Bring your posts, photos and videos over from your X archive.", icon: UPLOAD, viewBox: "0 -960 960 960", where: "settings" });
	if (feature("migration")) links.push({ href: "/account/migrate", text: "Move account", description: "Bring your account here from another instance, or take it to another one.", icon: MOVE, where: "settings" });
	links.push({ href: "/account/api", text: "API", description: "Make tokens that let scripts and bots use your account.", icon: CODE, viewBox: "0 -960 960 960", where: "settings" });
	links.push({ href: "/account/notes/appeals", text: "Note appeals", description: "Appeal a Community Note or review appeals as staff.", icon: SHIELD, where: "settings" });
	// staff reach the panel from the menu; the panel itself still asks what staffGate asks
	if (u?.role) links.push({ href: "/admin", text: "Admin", description: `Reports, accounts and ${s.instance_name}'s settings.`, icon: PANEL, where: "menu" });
	return links;
}

// what the script needs to know, as window.__XITTER__.tidy
export function tidyData(links: MenuLink[] = []) {
	const s = settings();
	const menuItems = ["Embed post", "Go to grok.com"];
	if (!feature("lists")) menuItems.push("Add/remove from Lists");
	const announcement = s.money_shop.enabled && s.money_shop.announcement?.text ? s.money_shop.announcement : s.announcement;
	return {
		menuItems,
		premium: feature("premium"),
		imageGen: feature("image_gen"),
		gbee: feature("grok") && s.grok.brain === "bee",
		announcement: announcement.text
			? {
				id: announcement.id,
				text: announcement.text,
				buttons: announcement.buttons?.length ? announcement.buttons : "link" in announcement && announcement.link ? [{ label: "More", url: announcement.link }] : [],
			}
			: null,
		instance: s.instance_name,
		source: s.source_url,
		signup: s.signup_mode !== "closed",
		links,
	};
}

// The client caches the lists it already fetched and doesn't know our mutations
// change them (a new community, list or bookmark stays missing until a reload).
// After one of those mutations succeeds, going to the page it changed loads
// fresh instead of from the cache; every other page still opens in place.
export const FRESH_SCRIPT = `(function(){
	var PAGES=[
		[/List/,/\\/lists(\\/|$)|^\\/i\\/lists/],
		[/Communit/,/communities/],
		[/PinTimeline/,/^\\/home/],
		[/Scheduled|DraftTweet/,/^\\/compose\\/post\\/unsent/],
		[/ArticleEntityDraft/,/^\\/compose\\/articles/],
		[/Bookmark/,/^\\/i\\/(bookmarks|history)/]
	];
	// queries go out as POST too: only names that change something count
	var CHANGE=/Create|Delete|Edit|Update|Join|Leave|Mute|Pin|Remove|Add|Subscribe/;
	var stale=[];
	function seen(url,method){
		var m=/\\/graphql\\/[^/]+\\/(\\w+)/.exec(String(url));
		if(!m||String(method||"GET").toUpperCase()!=="POST"||!CHANGE.test(m[1]))return null;
		var hit=PAGES.filter(function(p){return p[0].test(m[1])});
		return hit.length?hit:null;
	}
	function mark(hit){hit.forEach(function(p){if(stale.indexOf(p[1])<0)stale.push(p[1])})}
	function due(u){
		var path=new URL(String(u),location.href).pathname;
		return stale.some(function(re){return re.test(path)});
	}
	var f=window.fetch;
	window.fetch=function(input,init){
		var p=f.apply(this,arguments);
		try{
			var hit=seen(typeof input==="string"?input:input.url,(init&&init.method)||(input&&input.method));
			if(hit)p.then(function(r){if(r.ok)mark(hit)},function(){});
		}catch(e){}
		return p;
	};
	var open=XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open=function(method,url){
		try{
			var hit=seen(url,method);
			if(hit)this.addEventListener("load",function(){if(this.status<400)mark(hit)});
		}catch(e){}
		return open.apply(this,arguments);
	};
	var push=history.pushState;
	history.pushState=function(s,t,u){
		if(u&&stale.length&&due(u)&&!/\\/(compose\\/post$|i\\/flow|i\\/bookmarks\\/add)/.test(String(u))){
			stale=[];
			location.assign(u);
			return;
		}
		return push.apply(this,arguments);
	};
	window.addEventListener("popstate",function(){
		if(stale.length&&due(location.href)){stale=[];location.reload()}
	});
})();`;

// The dialog's "Forgot password?" has no screen behind it here: it goes to our
// own reset page, with the username typed so far.
export const FORGOT_SCRIPT = `(function(){
	document.addEventListener("click",function(e){
		var el=e.target;
		while(el&&el!==document.body){
			if(el.textContent==="Forgot password?"&&(/^(BUTTON|A)$/.test(el.tagName)||el.getAttribute("role")==="button")){
				e.preventDefault();e.stopPropagation();
				var field=document.querySelector('input[name="username"],input[name="username_or_email"]');
				location.assign("/account/forgot"+(field&&field.value?"?u="+encodeURIComponent(field.value):""));
				return;
			}
			el=el.parentElement;
		}
	},true);
	// Settings > Two-factor: the authenticator app row opens our set-up page
	document.addEventListener("click",function(e){
		if(location.pathname.indexOf("/settings/account/login_verification")!==0)return;
		var el=e.target;
		while(el&&el!==document.body){
			var t=el.textContent||"";
			if(t.indexOf("Authentication app")===0&&t.length<260){
				e.preventDefault();e.stopPropagation();
				if(window.__xitterGo)window.__xitterGo("/account/2fa");else location.assign("/account/2fa");
				return;
			}
			el=el.parentElement;
		}
	},true);
})();`;

export const TIDY_SCRIPT = `(function(){
	var T=(window.__XITTER__||{}).tidy||{menuItems:[]};
	// Our account pages open inside Settings: /settings/xitter/<page> shows
	// /account/<page> in a frame where the client's own screen would be (its
	// "page doesn't exist" pane, which any settings path it doesn't know gets)
	var OWN="/settings/xitter/";
	// the side bar's own entries (where "nav") open on a path of the client's
	// own instead, which it answers with its not-found page in the main column
	var FULL={"/i/xmoney":"/account/money","/i/circles":"/account/circle"};
	// and the pages under it (a payment: /i/xmoney/p/<id>)
	function fullOf(p){for(var k in FULL)if(p===k||p.indexOf(k+"/")===0)return FULL[k]+p.slice(k.length)}
	function full(p){for(var k in FULL)if(p===FULL[k]||p.indexOf(FULL[k]+"/")===0)return k+p.slice(FULL[k].length)}
	function own(href){
		var u=new URL(href,location.href);
		if(full(u.pathname))return full(u.pathname)+u.search;
		// the index (/account/) is Settings > Xitter settings, whose entry links to /settings/xitter
		if(u.pathname==="/account/")return "/settings/xitter"+u.search;
		return u.pathname.indexOf("/account/")===0?OWN+u.pathname.slice(9)+u.search:u.pathname+u.search+u.hash;
	}
	function framed(p){return p==="/settings/xitter"?"/account/":p.indexOf(OWN)===0?"/account/"+p.slice(OWN.length):fullOf(p)||null}
	// the client follows the address on popstate, so this moves it without a reload
	function go(path,replace){
		if(location.pathname+location.search+location.hash===path)return;
		history[replace?"replaceState":"pushState"]({},"",path);
		window.dispatchEvent(new PopStateEvent("popstate",{state:{}}));
	}
	window.__xitterGo=function(p){go(own(p))};
	// where the client puts a header over the pane (narrow screens) it says "Not
	// found": it takes the page's name, and the page's own header goes
	function heading(f){
		var name=f.getAttribute("data-name"),d;
		try{d=f.contentDocument}catch(e){}
		if(!name||!d)return;
		var h=[].find.call(document.querySelectorAll('h2[role="heading"]'),function(h){return h.hasAttribute("data-xitter-head")||h.textContent==="Not found"});
		var bar=d.querySelector(".bar");
		if(bar)bar.hidden=!!h;
		if(!h)return;
		h.setAttribute("data-xitter-head","");
		// the text node itself, so the client still finds its own when it moves on
		var leaf=[].find.call(h.querySelectorAll("span"),function(s){return !s.childElementCount&&s.firstChild&&s.firstChild.nodeType===3});
		if(leaf&&leaf.firstChild.nodeValue!==name)leaf.firstChild.nodeValue=name;
	}
	var since=0,paneObserver=null,paneFitFrame=0;
	function stopPaneFit(){
		if(paneObserver){paneObserver.disconnect();paneObserver=null}
		if(paneFitFrame){cancelAnimationFrame(paneFitFrame);paneFitFrame=0}
	}
	function pane(){
		var p=location.pathname,f=document.getElementById("xitter-pane"),base=framed(p);
		document.documentElement.toggleAttribute("data-xitter-full",!!(base&&fullOf(p)&&f&&f.hasAttribute("data-col")));
		if(!base){if(f){stopPaneFit();f.remove()}since=0;return}
		var want=base+location.search;
		var err=document.querySelector('[data-testid="error-detail"]');
		if(f&&f.getAttribute("data-src")!==want){stopPaneFit();f.setAttribute("data-src",want);f.contentWindow.location.replace(want)}
		if(f&&f.title&&document.title!==f.title)document.title=f.title;
		if(f)heading(f);
		// should the client draw no not-found page on a side bar path, the frame
		// takes the main column itself once the client has settled
		var col=!err&&fullOf(p)&&document.querySelector('[data-testid="primaryColumn"]');
		if(col&&!f){
			if(!since){since=Date.now();setTimeout(pane,1000)}
			if(Date.now()-since<1000)return;
		}
		if(!err&&!col)return;
		if(err)err.style.display="none";
		if(f&&(err?f.parentNode===err.parentNode:f.hasAttribute("data-col")))return;
		if(f){stopPaneFit();f.remove()}
		f=document.createElement("iframe");
		f.id="xitter-pane";f.src=want;f.setAttribute("data-src",want);
		f.style.cssText="display:block;width:100%;height:100vh;border:0;background:transparent";
		f.addEventListener("load",function(){
			stopPaneFit();
			var w=f.contentWindow,d;
			try{d=f.contentDocument}catch(e){}
			if(!d||!d.body)return;
			var at=w.location.pathname+w.location.search;
			// a form sent inside the frame can land outside our pages
			if(w.location.pathname.indexOf("/account/")!==0){stopPaneFit();f.remove();go(at,true);return}
			// a look saved on the theme page only reaches the client on a fresh load
			if(w.location.pathname==="/account/theme"&&f.getAttribute("data-was")==="/account/theme"){location.reload();return}
			f.setAttribute("data-was",w.location.pathname);
			// or on another of ours: the address follows
			f.setAttribute("data-src",at);
			if(location.pathname+location.search!==own(at))history.replaceState(history.state,"",own(at));
			f.setAttribute("data-name",d.title.split(" · ")[0]);
			f.title=f.getAttribute("data-name")+" / "+T.instance;
			document.title=f.title;
			heading(f);
			// Resize the frame on the next animation frame, outside the observer
			// delivery cycle. Ignore detached frames and identical measurements.
			var fitPending=false;
			var fit=function(){
				paneFitFrame=0;fitPending=false;
				if(!document.documentElement.contains(f)||!d.body)return;
				var height=Math.ceil(d.body.getBoundingClientRect().height)+"px";
				if(f.style.height!==height)f.style.height=height;
			};
			var scheduleFit=function(){
				if(fitPending||!document.documentElement.contains(f))return;
				fitPending=true;paneFitFrame=requestAnimationFrame(fit);
			};
			fit();
			if(window.ResizeObserver){paneObserver=new ResizeObserver(scheduleFit);paneObserver.observe(d.body)}
		});
		if(err)err.parentNode.insertBefore(f,err);
		else{f.setAttribute("data-col","");col.insertBefore(f,col.firstChild);document.documentElement.setAttribute("data-xitter-full","")}
	}
	// X's old sign-up flow talks to its servers; ours is in the dialog on the signed-out home page
	function ownScreens(){
		var p=location.pathname;
		if(p.indexOf("/i/flow/signup")===0)location.replace("/");
		// Settings > Email's "Update email address": our page, not X's flow
		if(p.indexOf("/i/flow/add_email")===0)go(OWN+"email",true);
		// Settings > Automation's "Set up account automation" (automation.ts)
		if(p.indexOf("/i/flow/enable_automated_account")===0)go(OWN+"automation",true);
		// Settings > Security's passkey screens and X's add-a-passkey flow talk to its servers (passkeys.ts)
		if(/passkey/i.test(p)&&(p.indexOf("/settings/")===0||p.indexOf("/i/flow/")===0))go(OWN+"passkeys",true);
	}
	// the signed-out footer ends with X's copyright (its name already the
	// instance's, patch.ts): the instance's name and source instead
	function footer(){
		var nav=document.querySelector('nav[aria-label="Footer"]');
		if(!nav||nav.querySelector("[data-xitter-source]"))return;
		var c=[].find.call(nav.querySelectorAll("span"),function(s){return /^\u00a9 \\d{4} .* Corp\\.$/.test(s.textContent)});
		if(!c)return;
		c.textContent=T.instance+" · ";
		var a=document.createElement("a");
		a.href=T.source;a.target="_blank";a.rel="noopener";a.textContent="source code";a.style.color="inherit";
		a.setAttribute("data-xitter-source","");
		c.appendChild(a);
	}
	// the More menu's "Settings and privacy" copied for each of our pages; the
	// copy has none of the client's handlers, so it moves the client itself
	function leave(a,href){
		var to=own(href);
		a.setAttribute("href",to);a.setAttribute("data-xitter-link","");
		a.addEventListener("click",function(e){
			e.preventDefault();e.stopPropagation();
			// the admin panel is a page of its own, outside the client
			if(to==="/admin"){location.assign(to);return}
			// the menu shuts when its full-screen backdrop is clicked, not on a page change
			var menu=a.closest('[role="menu"]');
			if(menu)[].forEach.call(menu.parentNode.children,function(c){if(c!==menu&&getComputedStyle(c).position==="fixed")c.click()});
			go(to);
		},true);
	}
	function copy(a,l){
		leave(a,l.href);a.removeAttribute("data-testid");
		var text=[l.text,l.description];
		[].filter.call(a.querySelectorAll("span"),function(n){return !n.childElementCount&&n.textContent.trim()}).forEach(function(n,i){if(text[i])n.textContent=text[i]});
		var svg=a.querySelector("svg"),path=svg&&svg.querySelector("path");
		if(path){[].slice.call(svg.querySelectorAll("path")).slice(1).forEach(function(p){p.remove()});path.removeAttribute("fill-rule");path.removeAttribute("clip-rule");path.setAttribute("d",l.icon);if(l.viewBox)svg.setAttribute("viewBox",l.viewBox)}
		// the client hovers its entries from script, which the copy doesn't
		// get: X's hover grey for the theme (light, dim, dark)
		a.addEventListener("mouseenter",function(){
			var bg=getComputedStyle(document.body).backgroundColor;
			a.style.backgroundColor=bg==="rgb(255, 255, 255)"?"rgb(247, 249, 249)":bg==="rgb(21, 32, 43)"?"rgb(30, 39, 50)":"rgb(22, 24, 28)";
		});
		a.addEventListener("mouseleave",function(){a.style.backgroundColor=""});
	}
	function menuLinks(){
		var items=(T.links||[]).filter(function(l){return l.where==="menu"||l.where==="both"});
		if(!items.length)return;
		// each entry sits alone in a row wrapper, so the copy takes the wrapper along
		var s=document.querySelector('[role="menu"] a[href="/settings"]');
		var row=s&&s.parentNode;
		if(!row||row.parentNode.querySelector("[data-xitter-link]"))return;
		items.forEach(function(l){
			var box=row.cloneNode(true);
			copy(box.querySelector('a[href="/settings"]'),l);
			row.parentNode.insertBefore(box,row);
		});
	}
	// the side bar's entries: a copy of its Profile link, placed above it
	function navLinks(){
		var items=(T.links||[]).filter(function(l){return l.where==="nav"});
		var nav=document.querySelector('header[role="banner"] nav');
		var tpl=nav&&nav.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
		if(!items.length||!tpl)return;
		// the bar shows labels only when it is wide; a copy made the other way is made again
		var shape=tpl.innerText.trim()?"wide":"narrow";
		items.forEach(function(l){
			var a=nav.querySelector('a[data-xitter-nav="'+l.href+'"]');
			if(a&&a.getAttribute("data-shape")!==shape){a.remove();a=null}
			if(!a){
				a=tpl.cloneNode(true);
				a.removeAttribute("data-testid");a.removeAttribute("aria-current");
				a.setAttribute("data-xitter-nav",l.href);a.setAttribute("data-shape",shape);a.setAttribute("aria-label",l.text);
				leave(a,l.href);
				var label=[].find.call(a.querySelectorAll("span"),function(n){return !n.childElementCount&&n.textContent.trim()});
				if(label)label.textContent=l.text;
				var svg=a.querySelector("svg"),path=svg&&svg.querySelector("path");
				if(path){[].slice.call(svg.querySelectorAll("path")).slice(1).forEach(function(p){p.remove()});path.removeAttribute("fill-rule");path.removeAttribute("clip-rule");path.setAttribute("d",l.icon);if(l.viewBox)svg.setAttribute("viewBox",l.viewBox)}
				// the client hovers the pill inside the link from script, which the copy doesn't get
				var pill=a.firstElementChild||a;
				a.addEventListener("mouseenter",function(){pill.style.backgroundColor=getComputedStyle(document.body).color.replace("rgb(","rgba(").replace(")",", 0.1)")});
				a.addEventListener("mouseleave",function(){pill.style.backgroundColor=""});
				tpl.parentNode.insertBefore(a,tpl);
			}
			// bold while its page is open, as the client marks its own (and not
			// because the Profile link was copied while the profile was open)
			var at=own(l.href).split("?")[0],on=location.pathname===at||location.pathname.indexOf(at+"/")===0;
			if(on)a.setAttribute("aria-current","page");else a.removeAttribute("aria-current");
			var icon=a.querySelector("svg path"),d=on&&l.iconOn||l.icon;
			if(icon&&icon.getAttribute("d")!==d)icon.setAttribute("d",d);
			[].forEach.call(a.querySelectorAll("span"),function(n){var w=on?"700":"400";if(n.style.fontWeight!==w)n.style.fontWeight=w});
		});
	}
	// Settings > Xitter settings (patch.ts) lists our pages. Only while the
	// client's Settings list hasn't shown that entry (a build the patch
	// missed, or the Account screen opened straight away on a phone) do they
	// also go on the Account screen, as they did before the entry
	var sawEntry=false;
	function accountRows(){
		var screen=document.querySelector('[data-testid="accountScreen"]');
		if(!sawEntry&&document.querySelector('[data-testid="xitterSettingsLink"]'))sawEntry=true;
		if(sawEntry){if(screen)screen.querySelectorAll("[data-xitter-row]").forEach(function(r){r.remove()});return}
		var rows=(T.links||[]).filter(function(l){return l.where==="settings"||l.where==="both"});
		if(!rows.length||!screen||screen.querySelector("[data-xitter-row]"))return;
		var last=screen.querySelector('a[href="/settings/deactivate"]');
		var all=screen.querySelectorAll('a[data-testid="pivot"]');
		var row=(last||all[all.length-1]||{}).parentNode;
		if(!row)return;
		var next=last?row:row.nextSibling;
		rows.forEach(function(l){
			var box=row.cloneNode(true);
			box.setAttribute("data-xitter-row","");
			copy(box.querySelector("a"),l);
			row.parentNode.insertBefore(box,next);
		});
	}
	function twoFactorRow(){
		var a=document.querySelector('a[href="/settings/account/login_verification"]');
		if(!a)return;
		leave(a,"/account/2fa");
		var about=a.nextElementSibling&&a.nextElementSibling.querySelector("span");
		if(about&&about.textContent.indexOf("You can choose a text message")>=0)about.textContent="Help protect your account from unauthorized access by asking for a code from an authentication app when you log in, as well as your password.";
	}
	// the client opens links outside x.com in a new tab; our own pages (messages
	// from staff) open in this one
	var open=window.open;
	window.open=function(u){
		try{var a=new URL(u,location.href);if(a.origin===location.origin&&a.pathname.indexOf("/account/")===0){go(own(a.href));return null}}catch(e){}
		return open.apply(window,arguments);
	};
	// the code boxes cut a paste to their length before dropping what isn't a
	// digit, so "1234-5678" would lose its last digit: paste only the digits
	document.addEventListener("paste",function(e){
		var t=e.target;
		if(!t||!t.classList||!t.classList.contains("jf-code-input-field"))return;
		var text=(e.clipboardData||window.clipboardData).getData("text");
		e.preventDefault();
		document.execCommand("insertText",false,text.replace(/\\D/g,""));
	},true);
	var A=T.announcement,closed=false;
	try{closed=!!A&&localStorage.getItem("xitter-announcement")===A.id}catch(e){}
	function announce(){
		if(!A||closed)return;
		var col=document.querySelector('[data-testid="primaryColumn"]');
		if(!col||col.querySelector("#xitter-announcement"))return;
		var bar=document.createElement("div");
		bar.id="xitter-announcement";
		bar.setAttribute("role","status");
		var body=document.createElement("div");
		body.className="xa-body";
		var text=document.createElement("div");
		text.className="xa-text";
		text.textContent=A.text;
		body.appendChild(text);
		if(A.buttons&&A.buttons.length){
			var row=document.createElement("div");
			row.className="xa-buttons";
			A.buttons.forEach(function(b){var a=document.createElement("a");a.href=b.url;a.target="_blank";a.rel="noopener";a.textContent=b.label;row.appendChild(a)});
			body.appendChild(row);
		}
		var x=document.createElement("button");
		x.type="button";x.setAttribute("aria-label","Close");x.textContent="\\u00d7";
		x.onclick=function(){closed=true;try{localStorage.setItem("xitter-announcement",A.id)}catch(e){}bar.remove();};
		bar.appendChild(body);bar.appendChild(x);
		col.insertBefore(bar,col.firstChild);
	}
	// the side bar shows its labels (and our word mark) only when it is wide
	function navWidth(){
		var nav=document.querySelector('header[role="banner"] nav');
		if(nav)document.documentElement.toggleAttribute("data-wide-nav",nav.getBoundingClientRect().width>=180);
	}
	window.addEventListener("resize",navWidth);
	function tidy(){
		if(location.pathname.indexOf("/i/birdwatch")===0||location.pathname.indexOf("/i/communitynotes")===0)document.querySelectorAll("span").forEach(function(n){
			if(n.childElementCount)return;
			var text=n.textContent;
			if(text==="Note statuses aren’t defined by majority rule")n.textContent=T.instance+" uses a local rating rule";
			else if(text&&text.indexOf("To identify notes that are helpful to a wide range of people, note statuses require agreement")===0)n.textContent="Notes appear on posts after at least three ratings, when two thirds rate them Helpful. Authors cannot rate their own notes.";
		});
		ownScreens();
		pane();
		footer();
		menuLinks();
		navLinks();
		accountRows();
		twoFactorRow();
		navWidth();
		announce();
		if(!T.imageGen)document.querySelectorAll('[role="dialog"] button').forEach(function(b){
			if(b.innerText.trim()!=="Edit Photo")return;
			var box=b;
			while(box.parentElement&&box.parentElement.innerText.indexOf("Imagine")>=0&&!box.parentElement.querySelector("input"))box=box.parentElement;
			box.style.display="none";
		});
		document.querySelectorAll('[role="menu"] [role="menuitem"]').forEach(function(m){
			if(T.menuItems.indexOf(m.innerText.trim())>=0)m.style.display="none";
		});
		// signed out on a phone, X's page leads with "Get the app", which opens X's
		// own app or its store page and looks like being sent to x.com. Where
		// sign-up is open, a "Create account" button takes its place and opens the
		// sign-in dialog, where a new username starts sign-up (onboarding.ts);
		// where it's closed, signing in is the way in, so its link does
		document.querySelectorAll("button").forEach(function(b){
			if(b.innerText.trim()!=="Get the app"||b.style.display==="none")return;
			b.style.display="none";
			var box=b.parentElement;
			while(box&&!box.querySelector('a[href="/i/flow/login"]'))box=box.parentElement;
			if(!box)return;
			if(T.signup){
				var c=b.cloneNode(true);
				c.style.display="";
				c.setAttribute("data-xitter-signup","");
				c.querySelectorAll("span").forEach(function(n){if(!n.childElementCount&&n.textContent.trim()==="Get the app")n.textContent="Create account"});
				// X's own handler stays on the hidden button; this one opens the dialog in place
				c.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();box.querySelector('a[href="/i/flow/login"]').click()});
				b.after(c);
				return;
			}
			box.querySelectorAll("span").forEach(function(n){if(n.innerText.trim()==="Already have an account?")n.style.display="none"});
			var a=box.querySelector('a[href="/i/flow/login"]');
			a.style.backgroundColor="#eff3f4";a.style.borderColor="#eff3f4";
			a.querySelectorAll("span,div").forEach(function(n){n.style.color="#0f1419"});
		});
		if(T.gbee){
			var G=window.__gbeeD||(window.__gbeeD={});
			document.querySelectorAll('a[href="/i/grok"] svg:not([data-gbee]) path').forEach(function(p){G[p.getAttribute("d")]=1});
			document.querySelectorAll("svg:not([data-gbee]) path").forEach(function(p){
				if(!G[p.getAttribute("d")])return;
				var v=p.ownerSVGElement;
				if(!v)return;
				v.setAttribute("data-gbee","");
				v.setAttribute("viewBox","0 -960 960 960");
				v.innerHTML='<path fill="currentColor" d="m720-600-32 28q-14 13-33 13t-33-11q-14-11-19-28t1-36l16-50-34-20q-16-9-22.5-26t-1.5-34q5-17 20-26.5t34-9.5h40l12-38q6-19 20.5-30.5T720-880q17 0 31.5 11.5T772-838l12 38h40q19 0 33.5 9.5T878-764q7 18 0 35t-22 25l-36 20 16 50q6 19 1 36.5T818-570q-15 11-33.5 11T752-572l-32-28Zm0-80q17 0 28.5-11.5T760-720q0-17-11.5-28.5T720-760q-17 0-28.5 11.5T680-720q0 17 11.5 28.5T720-680ZM552-244q23 60-15 112T430-80q-33 0-62.5-17T324-142q-83 12-137.5-42.5T142-324q-30-17-46-46.5T80-438q0-61 55.5-98.5T244-552l62 26q20-31 53-50.5t71-21.5v-82h60v90q37 11 61 34.5t41 65.5h88v60h-82q-2 38-20.5 71T528-306l24 62Zm-248 24q0-27 4.5-52.5T322-322q-23 11-49.5 15.5T220-304q0 39 22.5 61.5T304-220Zm-74-164q32 0 56.5-8t63.5-32l-120-50q-29-12-49.5.5T160-434q0 26 17 38t53 12Zm200 224q25 0 40.5-17.5T478-214l-54-136q-19 32-29.5 64T384-228q0 33 11.5 50.5T430-160Zm66-222q10-10 16-26.5t6-34.5q0-32-21-54t-52-22q-18 0-34 6t-27 17l78 36 34 78Zm-174 60Z"/>';
			});
			var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
				if(n.nodeValue.indexOf("Grok")<0)return NodeFilter.FILTER_REJECT;
				var e=n.parentElement;
				return e&&!e.closest('[data-testid="tweetText"],[contenteditable="true"],textarea,script,style')?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT;
			}});
			var hits=[];
			while(w.nextNode())hits.push(w.currentNode);
			hits.forEach(function(n){n.nodeValue=n.nodeValue.replace(/Grok/g,"GBee")});
			document.querySelectorAll('[placeholder*="Grok"],[aria-label*="Grok"]').forEach(function(e){
				["placeholder","aria-label"].forEach(function(a){var v=e.getAttribute(a);if(v&&v.indexOf("Grok")>=0)e.setAttribute(a,v.replace(/Grok/g,"GBee"))});
			});
			if(document.title.indexOf("Grok")>=0)document.title=document.title.replace(/Grok/g,"GBee");
			document.querySelectorAll('svg[viewBox="0 0 88 32"]:not([data-gbee])').forEach(function(v){
				var p=v.querySelector("path");
				if(!p||(p.getAttribute("d")||"").indexOf("M76.717 24.208")!==0)return;
				v.setAttribute("data-gbee","");
				v.innerHTML='<svg x="0" y="2" width="28" height="28" viewBox="0 -960 960 960"><path fill="currentColor" d="m720-600-32 28q-14 13-33 13t-33-11q-14-11-19-28t1-36l16-50-34-20q-16-9-22.5-26t-1.5-34q5-17 20-26.5t34-9.5h40l12-38q6-19 20.5-30.5T720-880q17 0 31.5 11.5T772-838l12 38h40q19 0 33.5 9.5T878-764q7 18 0 35t-22 25l-36 20 16 50q6 19 1 36.5T818-570q-15 11-33.5 11T752-572l-32-28Zm0-80q17 0 28.5-11.5T760-720q0-17-11.5-28.5T720-760q-17 0-28.5 11.5T680-720q0 17 11.5 28.5T720-680ZM552-244q23 60-15 112T430-80q-33 0-62.5-17T324-142q-83 12-137.5-42.5T142-324q-30-17-46-46.5T80-438q0-61 55.5-98.5T244-552l62 26q20-31 53-50.5t71-21.5v-82h60v90q37 11 61 34.5t41 65.5h88v60h-82q-2 38-20.5 71T528-306l24 62Zm-248 24q0-27 4.5-52.5T322-322q-23 11-49.5 15.5T220-304q0 39 22.5 61.5T304-220Zm-74-164q32 0 56.5-8t63.5-32l-120-50q-29-12-49.5.5T160-434q0 26 17 38t53 12Zm200 224q25 0 40.5-17.5T478-214l-54-136q-19 32-29.5 64T384-228q0 33 11.5 50.5T430-160Zm66-222q10-10 16-26.5t6-34.5q0-32-21-54t-52-22q-18 0-34 6t-27 17l78 36 34 78Zm-174 60Z"/></svg><text x="33" y="24" font-size="21" font-weight="600" font-family="system-ui,sans-serif" fill="currentColor">GBee</text>';
			});
		}
		document.querySelectorAll('button[aria-label="Link accounts"]').forEach(function(b){b.style.display="none"});
		document.querySelectorAll('a[href*="grok.com"]').forEach(function(a){(a.closest('[role="menuitem"]')||a).style.display="none"});
		document.querySelectorAll('[role="menuitem"],[role="option"],[role="button"],button').forEach(function(m){
			if(m.innerText&&m.innerText.trim()==="Go to grok.com")m.style.display="none";
		});
		document.querySelectorAll('[data-testid="primaryColumn"] span').forEach(function(n){
			var t=n.textContent.trim();
			if(n.childElementCount||(t!=="Meet Grok Bot"&&t!=="Meet GBee Bot"))return;
			var box=n;
			while(box.parentElement&&!/Learn more/.test(box.innerText))box=box.parentElement;
			while(box.parentElement&&box.parentElement.children.length===1)box=box.parentElement;
			box.style.display="none";
		});
		// the verified-badge popup's "Upgrade to get verified": nothing to upgrade to here
		document.querySelectorAll('a,button,[role="button"]').forEach(function(b){
			if(b.innerText&&b.innerText.trim()==="Upgrade to get verified")b.style.display="none";
		});
		// upsell banners: the box around a Premium link, up to whatever else shares its column
		if(!T.premium)document.querySelectorAll('[data-testid="primaryColumn"] a[href="/i/premium_sign_up"]').forEach(function(a){
			var box=a;
			while(box.parentElement&&!box.parentElement.querySelector('[role="tablist"],[data-testid="UserName"],[data-testid="tweet"]'))box=box.parentElement;
			box.style.display="none";
		});
	}
	tidy();
	new MutationObserver(tidy).observe(document.documentElement,{childList:true,subtree:true});
})();`;
