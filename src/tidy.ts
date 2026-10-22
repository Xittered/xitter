// What the page changes in the client: features this instance switches off
// (admin panel > Settings > Features), links to x.com pages, X's own sign-in
// screens, and the announcement banner. CSS where an element has a stable link
// or test id, a small script where only its text tells it apart.

import { FEDERATION_ON } from "./federation";
import { sql } from "./db";
import { type Feature, feature, settings } from "./settings";

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
	'a[href^="https://ads.x.com"]',
	'a[href^="https://help.x.com"]',
	'[data-testid="sidebarColumn"] nav[aria-label="Footer"]',
	// the signed-out home page's footer keeps Terms and Privacy (our rules page)
	'nav[aria-label="Footer"] > div:has(> a[href^="http"]:not([href$="/tos"]):not([href$="/privacy"]))',
	'nav[aria-label="Footer"] > div:has(> a[href^="/i/jf/stories"])',
];

export function hideCss(): string {
	const off = (Object.keys(BY_FEATURE) as Feature[]).filter((f) => !feature(f)).flatMap((f) => BY_FEATURE[f]);
	return `${[...ALWAYS, ...off].join(",")}{display:none!important}
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
const TONE = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 1.8v14.4a7.2 7.2 0 0 0 0-14.4z";
const CAT = "M5 3.5 9.2 7.6A9 9 0 0 1 12 7.2a9 9 0 0 1 2.8.4L19 3.5V12a7 7 0 0 1-14 0V3.5Zm4.5 8.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm5 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z";
// Material Symbols "terminal"
const TERMINAL = "M160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h640q33 0 56.5 23.5T880-720v480q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H160v400Zm140-40-56-56 103-104-104-104 57-56 160 160-160 160Zm180 0v-80h240v80H480Z";
const KEY = "M280-400q-33 0-56.5-23.5T200-480q0-33 23.5-56.5T280-560q33 0 56.5 23.5T360-480q0 33-23.5 56.5T280-400Zm0 160q-100 0-170-70T40-480q0-100 70-170t170-70q67 0 121.5 33t86.5 87h352l120 120-180 180-80-60-80 60-85-60h-47q-32 54-86.5 87T280-240Zm0-80q56 0 98.5-34t56.5-86h125l58 41 82-61 71 55 75-75-40-40H435q-14-52-56.5-86T280-640q-66 0-113 47t-47 113q0 66 47 113t113 47Z";
const GLOBE = "M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm-40-82v-78q-33 0-56.5-23.5T360-320v-40L168-552q-3 18-5.5 36t-2.5 36q0 121 79.5 212T440-162Zm276-102q41-45 62.5-100.5T800-480q0-98-54.5-179T600-776v16q0 33-23.5 56.5T520-680h-80v80q0 17-11.5 28.5T400-560h-80v80h240q17 0 28.5 11.5T600-440v120h40q26 0 47 15.5t29 40.5Z";
// Every link is in the account pages' navigation, under its `group`. `where`
// adds it to the client too: the More menu, Settings > Your account, or both.
// The menu keeps only what someone may need to act on; the rest live in Settings.
export const GROUPS = ["Account", "Appearance", "Apps and API", "Safety"] as const;
export type MenuLink = { href: string; text: string; description: string; icon: string; viewBox?: string; group: (typeof GROUPS)[number]; where: "menu" | "settings" | "both" | "tabs" };
export async function menuLinks(userId: string): Promise<MenuLink[]> {
	const links: MenuLink[] = [];
	const s = settings();
	links.push({ href: "/account/apps", text: "Connected apps", description: "Review and remove apps authorized to use your account.", icon: CODE, viewBox: "0 -960 960 960", group: "Apps and API", where: "settings" });
	if (s.invite_quota.enabled && s.signup_mode === "invite")
		links.push({ href: "/account/invites", text: "Invites", description: `Invite people you know to ${s.instance_name}.`, icon: TICKET, group: "Account", where: "both" });
	const [u] = await sql`select coalesce(u.verified_type in ('business', 'government'), false) or exists (select 1 from affiliations where org_id = u.id)
			or exists (select 1 from affiliations where user_id = u.id) or exists (select 1 from affiliation_requests where user_id = u.id) as org,
		exists (select 1 from staff_messages where user_id = u.id and revoked_at is null) or exists (select 1 from moderation_appeals where user_id = u.id) as notices,
		coalesce(u.verified_type in ('business', 'government', 'government_individual'), false) as gold
		from users u where u.id = ${userId}::bigint`;
	if (u?.org) links.push({ href: "/account/organisation", text: "Organisation", description: "Manage affiliates, or answer an organisation that asked to add you.", icon: BUILDING, group: "Account", where: "both" });
	if (u?.gold) links.push({ href: "/account/decor", text: "Profile decor", description: "Dress your profile with a theme, background and avatar frame from Steam.", icon: PALETTE, viewBox: "0 -960 960 960", group: "Appearance", where: "settings" });
	links.push({ href: "/account/theme", text: "Theme", description: "Dim, a preset, or your own colours for the client.", icon: TONE, group: "Appearance", where: "settings" });
	links.push({ href: "/account/decoration", text: "Avatar decoration", description: "Put cat ears or a decoration around your avatar.", icon: CAT, group: "Appearance", where: "both" });
	links.push({ href: "/account/automation", text: "Automation", description: "Name the account that runs this one.", icon: ROBOT, group: "Account", where: "tabs" });
	if (u?.notices) links.push({ href: "/account/notices", text: "Staff notices", description: `Messages, warnings and strikes from the ${s.instance_name} team, and your appeals.`, icon: SHIELD, group: "Safety", where: "both" });
	if (FEDERATION_ON) links.push({ href: "/account/instances", text: "Other instances", description: "Hide accounts and organisations from other instances.", icon: GLOBE, viewBox: "0 -960 960 960", group: "Safety", where: "settings" });
	links.push({ href: "/account/passkeys", text: "Passkeys", description: "Sign in with your fingerprint, face or screen lock instead of a password.", icon: KEY, viewBox: "0 -960 960 960", group: "Account", where: "settings" });
	if (feature("archive_import")) links.push({ href: "/account/import", text: "Import from X", description: "Bring your posts, photos and videos over from your X archive.", icon: UPLOAD, viewBox: "0 -960 960 960", group: "Account", where: "settings" });
	links.push({ href: "/account/migrate", text: "Move account", description: "Bring your account here from another instance, or take it to another one.", icon: MOVE, group: "Account", where: "settings" });
	links.push({ href: "/account/api", text: "API", description: "Make tokens that let scripts and bots use your account.", icon: TERMINAL, viewBox: "0 -960 960 960", group: "Apps and API", where: "settings" });
	links.push({ href: "/account/notes/appeals", text: "Note appeals", description: "Appeal a Community Note or review appeals as staff.", icon: SHIELD, group: "Safety", where: "settings" });
	return links;
}

// what the script needs to know, as window.__XITTER__.tidy
export function tidyData(links: MenuLink[] = []) {
	const s = settings();
	const menuItems = ["Embed post"];
	if (!feature("lists")) menuItems.push("Add/remove from Lists");
	return {
		menuItems,
		premium: feature("premium"),
		imageGen: feature("image_gen"),
		announcement: s.announcement.text
			? {
					id: s.announcement.id,
					text: s.announcement.text,
					buttons: s.announcement.buttons?.length ? s.announcement.buttons : s.announcement.link ? [{ label: "More", url: s.announcement.link }] : [],
				}
			: null,
		instance: s.instance_name,
		source: s.source_url,
		links,
	};
}

// The client caches the lists it already fetched and doesn't know our mutations
// change them (a new community, list or bookmark stays missing until a reload).
// After one of those mutations succeeds, the next navigation loads the page
// fresh instead of from the cache.
export const FRESH_SCRIPT = `(function(){
	var stale=false;
	var own=/(List|Communit|PinTimeline|Scheduled|Draft|Bookmark|Poll)/;
	function seen(url,method){
		var m=/\\/graphql\\/[^/]+\\/(\\w+)/.exec(String(url));
		return !!m&&String(method||"GET").toUpperCase()==="POST"&&own.test(m[1])&&!/^(Fetch|Get)/.test(m[1]);
	}
	var f=window.fetch;
	window.fetch=function(input,init){
		var p=f.apply(this,arguments);
		try{
			var hit=seen(typeof input==="string"?input:input.url,(init&&init.method)||(input&&input.method));
			if(hit)p.then(function(r){if(r.ok)stale=true},function(){});
		}catch(e){}
		return p;
	};
	var open=XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open=function(method,url){
		try{
			if(seen(url,method))this.addEventListener("load",function(){if(this.status<400)stale=true});
		}catch(e){}
		return open.apply(this,arguments);
	};
	var push=history.pushState;
	history.pushState=function(s,t,u){
		if(stale&&u&&!/\\/(compose|i\\/flow|i\\/bookmarks\\/add)/.test(String(u))){
			stale=false;
			location.assign(u);
			return;
		}
		return push.apply(this,arguments);
	};
	window.addEventListener("popstate",function(){
		if(stale){stale=false;location.reload()}
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
				location.assign("/account/2fa");
				return;
			}
			el=el.parentElement;
		}
	},true);
})();`;

export const TIDY_SCRIPT = `(function(){
	var T=(window.__XITTER__||{}).tidy||{menuItems:[]};
	// X's old sign-up flow talks to its servers; ours is in the dialog on the signed-out home page
	function ownScreens(){
		var p=location.pathname;
		if(p.indexOf("/i/flow/signup")===0)location.replace("/");
		// Settings > Email's "Update email address": our page, not X's flow
		if(p.indexOf("/i/flow/add_email")===0)location.replace("/account/email");
		// Settings > Automation's "Set up account automation" (automation.ts)
		if(p.indexOf("/i/flow/enable_automated_account")===0)location.replace("/account/automation");
		// Settings > Security's passkey screens and X's add-a-passkey flow talk to its servers (passkeys.ts)
		if(/passkey/i.test(p)&&(p.indexOf("/settings/")===0||p.indexOf("/i/flow/")===0))location.replace("/account/passkeys");
	}
	// the signed-out footer ends with X's copyright (its name already the
	// instance's, patch.ts): the instance's name and source instead
	function footer(){
		var nav=document.querySelector('nav[aria-label="Footer"]');
		if(!nav||nav.querySelector("[data-xitter-source]"))return;
		var c=[].find.call(nav.querySelectorAll("span"),function(s){return /^\u00a9 \d{4} .* Corp\.$/.test(s.textContent)});
		if(!c)return;
		c.textContent=T.instance+" · ";
		var a=document.createElement("a");
		a.href=T.source;a.target="_blank";a.rel="noopener";a.textContent="source code";a.style.color="inherit";
		a.setAttribute("data-xitter-source","");
		c.appendChild(a);
	}
	// the More menu's "Settings and privacy" copied for each of our pages; the
	// copy has none of the client's handlers, so it is a plain link
	function leave(a,href){
		a.setAttribute("href",href);a.setAttribute("data-xitter-link","");
		a.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();location.assign(href)},true);
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
	function accountRows(){
		var rows=(T.links||[]).filter(function(l){return l.where==="settings"||l.where==="both"});
		var screen=document.querySelector('[data-testid="accountScreen"]');
		if(!rows.length||!screen||screen.querySelector("[data-xitter-link]"))return;
		var last=screen.querySelector('a[href="/settings/deactivate"]');
		var all=screen.querySelectorAll('a[data-testid="pivot"]');
		var row=(last||all[all.length-1]||{}).parentNode;
		if(!row)return;
		var next=last?row:row.nextSibling;
		rows.forEach(function(l){
			var box=row.cloneNode(true);
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
	// the client opens links outside x.com in a new tab; our own pages outside
	// the app (messages from staff) open in this one
	var open=window.open;
	window.open=function(u){
		try{var a=new URL(u,location.href);if(a.origin===location.origin&&a.pathname.indexOf("/account/")===0){location.assign(a.href);return null}}catch(e){}
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
		footer();
		menuLinks();
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
		// own app or its store page and looks like being sent to x.com; here
		// signing in is the way in, so its link takes the button's place
		document.querySelectorAll("button").forEach(function(b){
			if(b.innerText.trim()!=="Get the app"||b.style.display==="none")return;
			b.style.display="none";
			var box=b.parentElement;
			while(box&&!box.querySelector('a[href="/i/flow/login"]'))box=box.parentElement;
			if(!box)return;
			box.querySelectorAll("span").forEach(function(n){if(n.innerText.trim()==="Already have an account?")n.style.display="none"});
			var a=box.querySelector('a[href="/i/flow/login"]');
			a.style.backgroundColor="#eff3f4";a.style.borderColor="#eff3f4";
			a.querySelectorAll("span,div").forEach(function(n){n.style.color="#0f1419"});
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
