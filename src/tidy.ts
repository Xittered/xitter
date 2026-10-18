// What the page changes in the client: features this instance switches off
// (admin panel > Settings > Features), links to x.com pages, X's own sign-in
// screens, and the announcement banner. CSS where an element has a stable link
// or test id, a small script where only its text tells it apart.

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
#xitter-announcement{display:flex;gap:12px;align-items:flex-start;padding:12px 16px;background:rgb(29,155,240);color:#fff;font:15px TwitterChirp,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#xitter-announcement a{color:#fff;text-decoration:underline}
#xitter-announcement span{flex:1;white-space:pre-wrap}
#xitter-announcement button{border:0;background:none;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:0 4px}`;
}

// Our own account pages in the side bar's More menu, for the accounts they concern:
// invites while members can make them (member-invites.ts), the organisation
// page for organisations, their affiliates and people they asked (org-manage.ts)
const TICKET = "M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5V10a2 2 0 0 0 0 4v3.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V14a2 2 0 0 0 0-4V6.5zM5 7v1.8a4 4 0 0 1 0 6.4V17h14v-1.8a4 4 0 0 1 0-6.4V7H5z";
// Material Symbols "code"
const CODE = "M320-240 80-480l240-240 57 57-184 184 183 183-56 56Zm320 0-57-57 184-184-183-183 56-56 240 240-240 240Z";
const BUILDING = "M4 21V3h11v4h5v14H4zm2-2h3v-3h2v3h2V5H6v14zm9 0h3V9h-3v10zM8 7h3v2H8V7zm0 4h3v2H8v-2z";
export type MenuLink = { href: string; text: string; icon: string; viewBox?: string };
export async function menuLinks(userId: string): Promise<MenuLink[]> {
	const links: MenuLink[] = [];
	if (settings().invite_quota.enabled && settings().signup_mode === "invite") links.push({ href: "/account/invites", text: "Invites", icon: TICKET });
	const [org] = await sql`select 1 from users u where u.id = ${userId}::bigint and (u.verified_type in ('business', 'government')
		or exists (select 1 from affiliations where user_id = u.id) or exists (select 1 from affiliation_requests where user_id = u.id))`;
	if (org) links.push({ href: "/account/organisation", text: "Organisation", icon: BUILDING });
	links.push({ href: "/account/api", text: "API", icon: CODE, viewBox: "0 -960 960 960" });
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
		announcement: s.announcement.text ? s.announcement : null,
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
	function menuLinks(){
		if(!T.links||!T.links.length)return;
		// each entry sits alone in a row wrapper, so the copy takes the wrapper along
		var s=document.querySelector('[role="menu"] a[href="/settings"]');
		var row=s&&s.parentNode;
		if(!row||row.parentNode.querySelector("[data-xitter-link]"))return;
		T.links.forEach(function(l){
			var box=row.cloneNode(true),a=box.querySelector('a[href="/settings"]');
			a.setAttribute("href",l.href);a.setAttribute("data-xitter-link","");a.removeAttribute("data-testid");
			var label=[].find.call(a.querySelectorAll("span"),function(n){return !n.childElementCount&&n.textContent.trim()});
			if(label)label.textContent=l.text;
			var path=a.querySelector("svg path");
			if(path){[].slice.call(a.querySelectorAll("svg path")).slice(1).forEach(function(p){p.remove()});path.setAttribute("d",l.icon);if(l.viewBox)a.querySelector("svg").setAttribute("viewBox",l.viewBox)}
			a.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();location.assign(l.href)},true);
			// the client hovers its entries from script, which the copy doesn't
			// get: X's hover grey for the theme (light, dim, dark)
			a.addEventListener("mouseenter",function(){
				var bg=getComputedStyle(document.body).backgroundColor;
				a.style.backgroundColor=bg==="rgb(255, 255, 255)"?"rgb(247, 249, 249)":bg==="rgb(21, 32, 43)"?"rgb(30, 39, 50)":"rgb(22, 24, 28)";
			});
			a.addEventListener("mouseleave",function(){a.style.backgroundColor=""});
			row.parentNode.insertBefore(box,row);
		});
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
		var text=document.createElement("span");
		text.textContent=A.text+" ";
		if(A.link){var a=document.createElement("a");a.href=A.link;a.target="_blank";a.rel="noopener";a.textContent="More";text.appendChild(a);}
		var x=document.createElement("button");
		x.type="button";x.setAttribute("aria-label","Close");x.textContent="\\u00d7";
		x.onclick=function(){closed=true;try{localStorage.setItem("xitter-announcement",A.id)}catch(e){}bar.remove();};
		bar.appendChild(text);bar.appendChild(x);
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
