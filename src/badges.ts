// More than one badge after a name. X's client draws a single badge there
// (affiliates_highlighted_label); model.ts puts the first of an account's
// badges in it, and this page script adds the others right after it, wherever
// the client shows that badge: posts, profiles, account lists, hover cards.

import { sql } from "./db";
import { STAFF_HANDLE } from "./invites";
import { badgeList, labelTakesSlot } from "./model";
import { toUser, userCols } from "./users";

// GET /i/api/xitter/badges?names=a,b: { a: { badges: [{ url, description }], gold }, ... },
// only accounts that wear more than one badge, or a gold translator globe
// (X's yellow "moderator" globe, recoloured for translator moderators)
export async function extraBadges(viewerId: string, url: URL): Promise<Response> {
	const names = [...new Set((url.searchParams.get("names") ?? "").split(",").map((n) => n.trim().toLowerCase()).filter((n) => STAFF_HANDLE.test(n)))].slice(0, 50);
	const out: Record<string, { badges: { url: string; description: string }[]; gold: boolean }> = {};
	if (names.length) {
		const rows = await sql`select ${userCols(viewerId)} from users u where lower(u.screen_name) = any(${sql.array(names, "TEXT")})`;
		for (const r of rows) {
			const u = toUser(r);
			const badges = badgeList(u).slice(labelTakesSlot(u) ? 0 : 1).map(({ url, description }) => ({ url, description }));
			const gold = u.translator === "moderator";
			if (badges.length || gold) out[u.screen_name.toLowerCase()] = { badges, gold };
		}
	}
	return Response.json(out, { headers: { "cache-control": "private, max-age=60" } });
}

export const BADGES_SCRIPT = String.raw`(function(){
	var known={},waiting={},timer,queue=[];
	// the containers that show a name with its badge; the account is the "@name" in them
	var SEL='[data-testid="User-Name"],[data-testid="UserName"],[data-testid="UserCell"],[data-testid="HoverCard"],[data-testid="SideNav_AccountSwitcher_Button"],[data-testid="primaryColumn"] h2';
	function handle(box){
		var spans=box.querySelectorAll("span");
		for(var i=0;i<spans.length;i++){var m=/^@([^\s\/\?#@%,:]{1,50})$/.exec(spans[i].textContent);if(m)return m[1].toLowerCase()}
		// a profile's top bar has the name but no handle: the page's address does
		if(box.tagName==="H2"&&box.querySelector('div[style*="height: calc(1.0625em)"]')){var p=/^\/([^\/?#]{1,150})(?:\/|$)/.exec(location.pathname);if(p)try{return decodeURIComponent(p[1]).toLowerCase()}catch(e){}}
	}
	function draw(box,name){
		var k=known[name];
		// the translator globe X draws (its label is the client's "Translator account")
		if(k.gold)box.querySelectorAll('svg[aria-label="Translator account"]').forEach(function(g){g.style.setProperty("color","#d4a72c","important")});
		if(!k.badges.length)return;
		// X's own badge: a square box sized to the text, after the name
		var slot=box.querySelector('div[style*="height: calc(1.0625em)"]');
		var holder,inside;
		if(slot){
			holder=slot.parentElement;
			var old=holder.nextElementSibling;
			if(old&&old.hasAttribute("data-xitter-badges"))return;
		}else{
			// no check and the slot taken by a label (automated, parody, staff-made):
			// X draws no badge box, so the badges go at the end of the name itself
			var nameDiv=box.querySelector('div[dir="ltr"]');
			inside=nameDiv&&nameDiv.firstElementChild;
			if(!inside||inside.querySelector("[data-xitter-badges]"))return;
		}
		var row=document.createElement("span");
		row.setAttribute("data-xitter-badges","");
		row.style.cssText="display:inline-flex;align-items:center;vertical-align:text-bottom";
		k.badges.forEach(function(b){
			var img=document.createElement("img");
			img.src=b.url;img.alt=b.description;img.title=b.description;img.draggable=false;
			img.style.cssText="height:1.0625em;width:1.0625em;object-fit:contain;margin-left:2px;border-radius:2px";
			row.appendChild(img);
		});
		if(holder)holder.after(row);else inside.appendChild(row);
	}
	function scan(){
		document.querySelectorAll(SEL).forEach(function(box){
			var name=handle(box);
			if(!name)return;
			if(known[name]){draw(box,name);return}
			if(known[name]===undefined&&!waiting[name]){waiting[name]=true;queue.push(name)}
		});
		if(queue.length)load();
	}
	function load(){
		var names=queue.splice(0,50);
		fetch("/i/api/xitter/badges?names="+names.join(","),{credentials:"same-origin"})
			.then(function(r){return r.json()})
			.then(function(d){names.forEach(function(n){known[n]=d[n]||null;delete waiting[n]});scan()})
			.catch(function(){names.forEach(function(n){delete waiting[n]})});
	}
	new MutationObserver(function(){if(!timer)timer=setTimeout(function(){timer=null;scan()},120)}).observe(document.documentElement,{childList:true,subtree:true});
})();`;
