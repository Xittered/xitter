// What the page changes in the client: features this instance switches off
// (admin panel > Settings > Features), links to x.com pages, X's own sign-in
// screens, and the announcement banner. CSS where an element has a stable link
// or test id, a small script where only its text tells it apart.

import { FEDERATION_ON, INSTANCE_ID } from "./federation";
import { sql } from "./db";
import { isOrganizationSql } from "./users";
import { type Feature, feature, settings } from "./settings";
import type { Viewer } from "./auth";
import { staffGate } from "./staff-access";
import { superadminOf } from "./superadmins";
import { FRAMED_ROOTS, XITTER_SECTION } from "./owned-paths";
import { publicMenuLinks, type ClientPayload, type MenuFacts, type MenuLink } from "./xitter-menu";

export type { MenuLink };

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

// the frame over the column the client leaves empty (TIDY_SCRIPT's sync)
export const FRAME_CSS = `#xitter-frame{position:fixed;display:none;visibility:hidden;border:0;margin:0;padding:0;z-index:0;background:transparent;color-scheme:normal}
html[data-xitter-host] #xitter-frame{display:block}
html[data-xitter-host] #xitter-frame[data-ready]{visibility:visible}
html[data-xitter-host="pending"] #xitter-frame[data-ready]{visibility:hidden}
html[data-xitter-host="settings"] [aria-label="Section details"]>*{display:none}
html[data-xitter-host="pending"] main[role="main"]>*,html[data-xitter-host="settings-phone"] main[role="main"]>*,html[data-xitter-host="admin"] main[role="main"]>*{visibility:hidden}
html[data-xitter-host="settings-phone"] [data-testid="TopNavBar"]{display:none}
html[data-xitter-host],html[data-xitter-host] body{overflow:hidden}`;

export function hideCss(): string {
	const off = (Object.keys(BY_FEATURE) as Feature[]).filter((f) => !feature(f)).flatMap((f) => BY_FEATURE[f]);
	return `${FRAME_CSS}
${[...ALWAYS, ...off].join(",")}{display:none!important}
#xitter-announcement{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;background:var(--xt-accent-fill,var(--xt-accent,#1d9bf0));color:#fff;font:15px TwitterChirp,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#xitter-announcement .xa-body{flex:1;min-width:0;display:grid;gap:10px}
#xitter-announcement .xa-text{white-space:pre-wrap;overflow-wrap:break-word}
#xitter-announcement .xa-buttons{display:flex;flex-wrap:wrap;gap:8px}
#xitter-announcement .xa-buttons a{display:inline-flex;align-items:center;min-height:32px;padding:0 14px;border-radius:8px;background:rgb(255 255 255 / .2);color:#fff;font-weight:700;font-size:14px;text-decoration:none;white-space:nowrap;transition:background-color 120ms ease-out}
#xitter-announcement .xa-buttons a:focus-visible{outline:2px solid #fff;outline-offset:2px}
@media (hover:hover){#xitter-announcement .xa-buttons a:hover{background:rgb(255 255 255 / .3)}}
#xitter-announcement button{border:0;background:none;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:0 4px}`;
}

// The More menu and Settings get a subset of these. `where` says which.
async function accountMenuFacts(userId: string): Promise<MenuFacts> {
	const s = settings();
	const [u] = await sql`select ${isOrganizationSql(sql`u`)}
			or exists (select 1 from affiliations where user_id = u.id) or exists (select 1 from affiliation_requests where user_id = u.id) as org,
		exists (select 1 from staff_messages where user_id = u.id and revoked_at is null) or exists (select 1 from moderation_appeals where user_id = u.id) as notices,
		coalesce(u.verified_type in ('business', 'government', 'government_individual'), false) as gold, u.instance
		from users u where u.id = ${userId}::bigint`;
	return {
		role: null,
		localSuperadmin: false,
		instance: u?.instance ?? null,
		org: !!u?.org,
		gold: !!u?.gold,
		notices: !!u?.notices,
		invitesOpen: !!(s.invite_quota.enabled && s.signup_mode === "invite"),
		federation: FEDERATION_ON,
		archiveImport: feature("archive_import"),
		staffGate: null,
		instanceName: s.instance_name,
	};
}

export async function loadMenuFacts(req: Request, viewer: Viewer): Promise<MenuFacts> {
	const facts = await accountMenuFacts(viewer.id);
	const role = viewer.role ?? null;
	return {
		...facts,
		role,
		localSuperadmin: role === "admin" && !viewer.instance && !!superadminOf(INSTANCE_ID, viewer.screen_name, viewer.id),
		staffGate: role ? await staffGate(req, viewer) : null,
	};
}

export async function menuLinks(userId: string): Promise<MenuLink[]> {
	return publicMenuLinks(await accountMenuFacts(userId));
}

// what the script needs to know, as window.__XITTER__.tidy
const XITTER_ROW = {
	href: XITTER_SECTION,
	text: "Xitter",
	description: "Theme, profile decor, apps, and the other things this instance adds.",
	icon: "M4 4h7v7H4V4zm9 0h7v7h-7V4zM4 13h7v7H4v-7zm9 0h7v7h-7v-7z",
	viewBox: "0 0 24 24",
};

export function tidyData(links: MenuLink[] = [], staff?: ClientPayload["staff"]) {
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
		xitter: XITTER_ROW,
		// the pages framed into the client's Settings (owned-paths.ts)
		framed: FRAMED_ROOTS,
		...(staff ? { staff } : {}),
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
		if(u&&ownedPath(u)){
			// the admin panel's back arrow returns here
			try{if(new URL(String(u),location.origin).pathname.indexOf("/admin")===0)sessionStorage.setItem("xitter-admin-from",location.pathname+location.search)}catch(e){}
			location.assign(String(u));return;
		}
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
	function ownedPath(u){
		var path="";
		try{path=new URL(String(u),location.origin).pathname}catch(e){return false}
		if(path==="/account"||path==="/account/switch"||path.indexOf("/account/not_my_account/")===0)return false;
		if(path.indexOf("/account/")===0)return true;
		if(path==="/admin"||path.indexOf("/admin/")===0)return true;
		return path==="/federation/superadmin"||path.indexOf("/federation/superadmin/")===0;
	}
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
	// X's old sign-up flow talks to its servers; ours is in the dialog on the signed-out home page
	function ownScreens(){
		var p=location.pathname;
		if(p.indexOf("/i/flow/signup")===0)location.replace("/");
		// Settings > Email's "Update email address": our page, not X's flow
		if(p.indexOf("/i/flow/add_email")===0)go("/account/email");
		// Settings > Automation's "Set up account automation" (automation.ts)
		if(p.indexOf("/i/flow/enable_automated_account")===0)go("/account/automation");
		// Settings > Security's passkey screens and X's add-a-passkey flow talk to its servers (passkeys.ts)
		if(/passkey/i.test(p)&&p.indexOf("/settings/xitter/")!==0&&(p.indexOf("/settings/")===0||p.indexOf("/i/flow/")===0))location.replace("/account/passkeys");
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
		var to=routeFor(new URL(href,location.origin).pathname)||href;
		a.setAttribute("href",to);a.setAttribute("data-xitter-link","");
		a.addEventListener("click",function(e){
			e.preventDefault();e.stopPropagation();
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
	function xitterRow(){
		var spec=T.xitter;
		if(!spec||document.querySelector("a[data-xitter-settings]"))return;
		var account=document.querySelector('a[href="/settings/account"]');
		var sample=document.querySelector('a[href="/settings/monetization"]')||document.querySelector('a[href="/settings/privacy_and_safety"]')||account;
		var accountBox=account&&account.parentElement;
		var sampleBox=sample&&sample.parentElement;
		if(!accountBox||!sampleBox||!accountBox.parentElement||accountBox.parentElement!==sampleBox.parentElement)return;
		var box=sampleBox.cloneNode(true);
		var link=box.querySelector("a");
		if(!link)return;
		link.setAttribute("href",spec.href);
		link.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();spa(spec.href)},true);
		link.removeAttribute("data-testid");
		link.removeAttribute("aria-selected");
		link.setAttribute("data-xitter-settings","");
		var title=link.querySelector("span");
		if(title)title.textContent=spec.text;
		accountBox.parentElement.insertBefore(box,accountBox.nextSibling);
	}
	// the Settings list marks the open section by a class on the row's wrapper
	// and an extra child (its edge); the Xitter row copies them from a row the
	// client marked, remembered for when no row is marked
	function activeRow(){
		var mine=document.querySelector("a[data-xitter-settings]"),wrap=mine&&mine.parentElement;
		var marked=[].find.call(document.querySelectorAll('[data-testid="activeRoute"]'),function(w){return w!==wrap&&w.children.length>1});
		var seen=null;
		if(marked){seen={wrap:marked.className,edge:marked.lastElementChild.className};try{localStorage.setItem("xitter-active-row",JSON.stringify(seen))}catch(e){}}
		if(!wrap)return;
		var on=location.pathname===T.xitter.href||location.pathname.indexOf(T.xitter.href+"/")===0;
		if(on===wrap.hasAttribute("data-on"))return;
		wrap.toggleAttribute("data-on",on);
		var edge=wrap.querySelector("[data-xitter-edge]");
		if(!on){if(edge)edge.remove();if(wrap.dataset.plain!==undefined)wrap.className=wrap.dataset.plain;wrap.style.backgroundColor="";return}
		if(!seen)try{seen=JSON.parse(localStorage.getItem("xitter-active-row")||"null")}catch(e){}
		wrap.dataset.plain=wrap.className;
		edge=document.createElement("div");edge.setAttribute("data-xitter-edge","");
		if(seen){wrap.className=seen.wrap;edge.className=seen.edge}
		wrap.appendChild(edge);
		// a client that never marked a row this session may not have the classes' rules yet
		if(getComputedStyle(wrap).backgroundColor==="rgba(0, 0, 0, 0)"){
			var bg=getComputedStyle(document.body).backgroundColor;
			wrap.style.backgroundColor=getComputedStyle(document.documentElement).getPropertyValue("--xt-hover")||(bg==="rgb(255, 255, 255)"?"rgb(247, 249, 249)":bg==="rgb(21, 32, 43)"?"rgb(30, 39, 50)":"rgb(22, 24, 28)");
			edge.style.cssText="position:absolute;inset:0;pointer-events:none;border-right:2px solid var(--xt-accent,rgb(29, 155, 240))";
		}
	}
	function staffNav(){
		var spec=T.staff&&T.staff.nav;
		if(!spec)return;
		var nav=document.querySelector('header[role="banner"] nav');
		var home=nav&&nav.querySelector('a[href="/home"]');
		var sample=nav&&(nav.querySelector('a[href="/explore"]')||nav.querySelector('a[href="/notifications"]')||home);
		if(!sample||nav.querySelector('a[href="/admin"]'))return;
		var item=sample.parentElement&&sample.parentElement!==nav?sample.parentElement:sample;
		var box=item.cloneNode(true);
		var link=box.querySelector("a")||box;
		link.setAttribute("href",spec.href);link.setAttribute("data-xitter-link","");
		link.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();spa(spec.href)},true);
		link.removeAttribute("data-testid");
		link.removeAttribute("aria-current");
		var active=location.pathname==="/admin"||location.pathname.indexOf("/admin/")===0;
		var weight=active?"700":"400";
		link.style.fontWeight=weight;
		link.setAttribute("aria-label",spec.text);
		var named=false;
		[].forEach.call(link.querySelectorAll("span"),function(n){
			n.style.fontWeight=weight;
			if(named||n.childElementCount||!n.textContent.trim())return;
			n.textContent=spec.text;
			named=true;
		});
		var svg=link.querySelector("svg");
		var path=svg&&svg.querySelector("path");
		if(path){svg.setAttribute("viewBox","0 0 24 24");path.setAttribute("d","M12 1.5 3.5 5v6c0 5.2 3.6 10 8.5 11.5 4.9-1.5 8.5-6.3 8.5-11.5V5L12 1.5zm0 2.2 6.5 2.7V11c0 4.2-2.8 8.2-6.5 9.4-3.7-1.2-6.5-5.2-6.5-9.4V6.4L12 3.7z")}
		var more=nav.querySelector('[data-testid="AppTabBar_More_Menu"]');
		var before=more&&more.parentElement&&more.parentElement!==nav?more.parentElement:more;
		var homeItem=home&&home.parentElement&&home.parentElement!==nav?home.parentElement:home;
		var parent=homeItem&&homeItem.parentElement;
		if(before&&parent&&before.parentElement===parent)parent.insertBefore(box,before);
		else if(parent)parent.appendChild(box);
		else item.parentElement.appendChild(box);
	}
	// Xitter's settings pages and the admin panel sit in the client's own
	// layout: the client draws its nav and its Settings list, and the page
	// (served at its /account or /admin address) fills a frame over the
	// column the client leaves empty. Links in the frame move the client.
	var ROOTS=T.framed||[];
	function chrome(p){return ROOTS.some(function(r){return p===r||p.indexOf(r+"/")===0})}
	function routeFor(p){
		if(p==="/account/xitter")return "/settings/xitter";
		if(p==="/federation/superadmin")return "/settings/xitter/superadmin";
		if(p.indexOf("/account/")===0&&chrome(p))return "/settings/xitter/"+p.slice(9);
		return null;
	}
	function framedFor(p){
		if(p==="/settings/xitter")return "/account/xitter";
		if(p==="/settings/xitter/superadmin")return "/federation/superadmin";
		if(p.indexOf("/settings/xitter/")!==0)return null;
		var page="/account/"+p.slice(17);
		return chrome(page)?page:null;
	}
	var nativePush=History.prototype.pushState,nativeReplace=History.prototype.replaceState;
	// the client's router follows popstate, so a pushed address plus one renders it
	function spa(path){
		if(path===location.pathname+location.search+location.hash)return;
		if(framedFor(path.split("?")[0])||path.split("#")[0]==="/admin")document.documentElement.setAttribute("data-xitter-host","pending");
		nativePush.call(history,{},"",path);
		dispatchEvent(new PopStateEvent("popstate",{state:{}}));
		sync();
	}
	function go(path){
		var u;try{u=new URL(path,location.origin)}catch(e){return}
		if(u.origin!==location.origin){location.assign(u.href);return}
		var r=routeFor(u.pathname);
		if(r){spa(r+u.search);return}
		if(u.pathname==="/admin"&&T.staff&&T.staff.nav){spa("/admin"+u.hash);return}
		if(u.pathname.indexOf("/account/")===0||u.pathname.indexOf("/admin")===0||u.pathname.indexOf("/federation/")===0||u.pathname.indexOf("/oauth/")===0||u.pathname.indexOf("/media/")===0){location.assign(u.href);return}
		spa(u.pathname+u.search+u.hash);
	}
	window.__xitterGo=go;
	var frame=null,frameAt="",look=null,lastOut="",watched=null,frameTitle="",frameLoaded=false;
	var boot=window.__XITTER__||{},checkingLook=false,checkLookAgain=false,reloadingLook=false,appearanceAt="";
	function reloadLook(){if(!reloadingLook){reloadingLook=true;location.reload()}}
	function checkLook(){
		if(!boot.csrf||!boot.savedLook||reloadingLook)return;
		if(checkingLook){checkLookAgain=true;return}
		checkingLook=true;
		fetch("/i/api/xitter/theme",{credentials:"same-origin",cache:"no-store"}).then(function(r){return r.ok?r.json():null}).then(function(saved){
			if(saved&&JSON.stringify(saved)!==JSON.stringify(boot.savedLook))reloadLook();
		}).catch(function(){}).finally(function(){checkingLook=false;if(checkLookAgain){checkLookAgain=false;checkLook()}});
	}
	addEventListener("focus",checkLook);
	addEventListener("pageshow",checkLook);
	document.addEventListener("visibilitychange",function(){if(!document.hidden)checkLook()});
	if(framedFor(location.pathname)||(location.pathname==="/admin"&&T.staff&&T.staff.nav))document.documentElement.setAttribute("data-xitter-host","pending");
	// the client lays a column out again after a resize (the rail narrowing,
	// the settings list dropping to one column) without adding nodes, so the
	// frame follows the column and the rail by size, not only by mutations
	var ro=window.ResizeObserver?new ResizeObserver(function(){sync()}):null;
	function place(host,kind,phone){
		var r=host.getBoundingClientRect();
		var bar=document.querySelector('[data-testid="BottomBar"]'),bb=bar&&bar.getBoundingClientRect();
		var bottom=bb&&bb.height>0&&bb.top>0?bb.top:innerHeight;
		var top=Math.max(0,r.top),left=r.left+(host.clientLeft||0),width=host.clientWidth||r.width;
		if(phone&&kind==="settings"){
			// with one column (a phone, or a narrow window) the page takes
			// over from the top, with its own header where X puts one on its
			// single-column settings pages
			top=0;
		}
		var css="left:"+left+"px;top:"+top+"px;width:"+width+"px;height:"+Math.max(0,bottom-top)+"px";
		if(frame.getAttribute("data-at")!==css){frame.setAttribute("data-at",css);frame.style.cssText=css}
		// X's chat button floats over the bottom right of the column: the
		// page's floating save controls keep clear of it
		var chat=document.querySelector('[data-testid="chat-drawer-main"]'),cr=chat&&chat.getBoundingClientRect(),dock=0;
		if(cr&&cr.width&&cr.left<left+width&&cr.right>left&&cr.top<bottom&&cr.bottom>top)dock=Math.ceil(left+width-cr.left)+8;
		try{var de=frame.contentDocument.documentElement;if(de.style.getPropertyValue("--xt-dock")!==dock+"px")de.style.setProperty("--xt-dock",dock+"px")}catch(e){}
	}
	function sync(){
		var p=location.pathname,kind=null,want=null,f=framedFor(p);
		var appearancePath=p+location.search+location.hash;
		if(appearanceAt!==appearancePath){appearanceAt=appearancePath;checkLook()}
		if(f){kind="settings";want=f+location.search}
		else if(p==="/admin"&&T.staff&&T.staff.nav){kind="admin";want="/admin"+location.hash}
		var html=document.documentElement;
		if(!kind){
			if(html.hasAttribute("data-xitter-host"))html.removeAttribute("data-xitter-host");
			frameTitle="";
			var here=p+location.search;
			if(here!==lastOut){lastOut=here;try{sessionStorage.setItem("xitter-admin-from",here)}catch(e){}}
			return;
		}
		var host=kind==="settings"?document.querySelector('[aria-label="Section details"]'):null;
		var phone=!host;
		if(kind==="settings"&&!host&&!document.querySelector('[data-testid="error-detail"]'))return;
		host=host||document.querySelector('main[role="main"]');
		if(!host)return;
		if(ro&&watched!==host){
			watched=host;ro.disconnect();ro.observe(host);
			var rail=document.querySelector('header[role="banner"]');
			if(rail)ro.observe(rail);
		}
		var mode=kind+(phone&&kind==="settings"?"-phone":"");
		if(html.getAttribute("data-xitter-host")!==mode)html.setAttribute("data-xitter-host",mode);
		// the frame waits for #layers, its home: moving an iframe reloads it
		var layers=document.getElementById("layers");
		if(!layers)return;
		if(!frame){
			frame=document.createElement("iframe");
			frame.id="xitter-frame";
			frame.title=kind==="admin"?"Admin":"Xitter";
			frame.src=want;frameAt=want;
			frame.addEventListener("load",function(){frameLoaded=true;sync()});
		}else if(frameAt!==want){
			var was=frameAt;frameAt=want;
			if(kind==="admin"&&was.indexOf("/admin")===0){try{frame.contentWindow.location.hash=location.hash}catch(e){frame.src=want}}
			else{frameLoaded=false;frame.removeAttribute("data-ready");try{frame.contentWindow.location.replace(want)}catch(e){frame.src=want}}
		}
		// first inside X's #layers, so its menus, dialogs and chat drawer (added
		// after it) paint on top. Not beside #layers: the client renders that
		// container again while it boots and drops nodes it does not own
		if(frame.parentElement!==layers)layers.insertBefore(frame,layers.firstChild);
		place(host,kind,phone);
		if(frameLoaded&&!frame.hasAttribute("data-ready"))frame.setAttribute("data-ready","");
		// the client titles a route it does not know "Page not found"
		if(frameTitle&&document.title!==frameTitle)document.title=frameTitle;
		// the client's empty-page screen is taller than the window; framed, the
		// page itself never scrolls (the frame does)
		if(scrollY)scrollTo(0,0);
	}
	addEventListener("scroll",function(){if(scrollY&&document.documentElement.hasAttribute("data-xitter-host"))scrollTo(0,0)},{passive:true});
	addEventListener("popstate",function(){setTimeout(sync,0)});
	addEventListener("resize",function(){sync()});
	addEventListener("message",function(e){
		if(e.origin!==location.origin||!frame||e.source!==frame.contentWindow||!e.data||!e.data.xitter)return;
		var d=e.data;
		if(d.type==="go")go(d.path);
		else if(d.type==="back")go(sessionStorage.getItem("xitter-admin-from")||"/settings/xitter");
		else if(d.type==="title"&&d.title){frameTitle=d.title;document.title=d.title}
		else if(d.type==="look")checkLook();
		else if(d.type==="hash"){
			if(location.pathname==="/admin"&&location.hash!==d.hash){frameAt="/admin"+d.hash;nativeReplace.call(history,history.state,"","/admin"+d.hash)}
		}else if(d.type==="page"){
			// the frame moved on its own (a form, a redirect): the address follows
			var u=new URL(d.path,location.origin),r=routeFor(u.pathname);
			frameAt=u.pathname+u.search;
			if(r&&r+u.search!==location.pathname+location.search)nativeReplace.call(history,history.state,"",r+u.search);
			if(d.title){frameTitle=d.title;document.title=d.title}
			// a saved theme or decoration: the client shows it after a reload
			if(look===null)look=d.look;else if(d.look&&d.look!==look)reloadLook();
			checkLook();
		}
	});
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
		try{var a=new URL(u,location.href);if(a.origin===location.origin&&a.pathname.indexOf("/account/")===0){go(a.href);return null}}catch(e){}
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
		xitterRow();
		activeRow();
		var adm=document.querySelector('header[role="banner"] a[href="/admin"][data-xitter-link]');
		if(adm){var w=location.pathname==="/admin"?"700":"400";if(adm.style.fontWeight!==w){adm.style.fontWeight=w;[].forEach.call(adm.querySelectorAll("span"),function(n){n.style.fontWeight=w})}}
		staffNav();
		sync();
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
