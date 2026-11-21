// More than one badge after a name. X's client draws a single badge there
// (affiliates_highlighted_label); model.ts puts the first of an account's
// badges in it, and this page script adds the others right after it, wherever
// the client shows that badge: posts, profiles, account lists, hover cards.
// A bot's extra labels (hiddenLabels in model.ts) sit on the same "Automated
// by" row as their own icon+text badges, after the client's robot line.

import { sql } from "./db";
import { ID_RE, INSTANCE_ID, baseUrl, listedInstance } from "./federation";
import { STAFF_HANDLE } from "./invites";
import { badgeList, hiddenLabels, labelTakesSlot } from "./model";
import { toUser, userCols } from "./users";

// GET /i/api/xitter/badges?names=a,b: { a: { badges: [{ url, description }], gold, labels: [{ text, url?, icon? }] }, ... },
// only accounts that wear more than one badge, a gold translator globe
// (X's yellow "moderator" globe, recoloured for translator moderators),
// or a label the client's one slot hid
export async function extraBadges(viewerId: string, url: URL): Promise<Response> {
	const names = [...new Set((url.searchParams.get("names") ?? "").split(",").map((n) => n.trim().toLowerCase()).filter((n) => {
		const at = n.indexOf("@");
		return at < 0 ? STAFF_HANDLE.test(n) : STAFF_HANDLE.test(n.slice(0, at)) && /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(n.slice(at + 1));
	}))].slice(0, 50);
	const out: Record<string, { badges: { url: string; description: string; org?: string }[]; gold: boolean; labels: { text: string; url?: string; icon?: string }[] }> = {};
	if (names.length) {
		const rows = await sql`select ${userCols(viewerId)} from users u where lower(u.screen_name) = any(${sql.array(names, "TEXT")})`;
		for (const r of rows) {
			const u = toUser(r);
			const badges = badgeList(u).slice(labelTakesSlot(u) ? 0 : 1).map(({ url, description, org }) => ({ url, description, ...(org ? { org } : {}) }));
			const gold = u.translator === "moderator";
			const labels = hiddenLabels(u);
			if (badges.length || gold || labels.length) out[u.screen_name.toLowerCase()] = { badges, gold, labels };
		}
	}
	return Response.json(out, { headers: { "cache-control": "private, max-age=60" } });
}

// GET /i/api/xitter/instance?id=example.org: what the globe badge's card shows
// about an instance accounts come from. Only instances this one knows: on the
// list, or with accounts here.
export async function instanceCard(viewerId: string, url: URL): Promise<Response> {
	const id = (url.searchParams.get("id") ?? "").toLowerCase();
	if (!ID_RE.test(id) || id === INSTANCE_ID) return Response.json({ error: "unknown instance" }, { status: 404 });
	const listed = listedInstance(id);
	const [r] = await sql`select (select count(*)::int from users where instance = ${id}) as accounts,
		coalesce(me.preferences->'hidden_instances', '[]'::jsonb) ? ${id} or me.preferences->>'hide_federated' = 'true' as hidden
		from users me where me.id = ${viewerId}::bigint`;
	if (!listed && !r?.accounts) return Response.json({ error: "unknown instance" }, { status: 404 });
	return Response.json(
		{
			id,
			name: listed?.name ?? id,
			state: listed?.state ?? "unlisted",
			home: baseUrl(id),
			rules: `${baseUrl(id)}/rules`,
			source: listed?.source_url ?? null,
			accounts: r?.accounts ?? 0,
			hidden: !!r?.hidden,
		},
		{ headers: { "cache-control": "private, max-age=60" } },
	);
}

export const BADGES_SCRIPT = String.raw`(function(){
	var known={},waiting={},timer,queue=[];
	// the containers that show a name with its badge; the account is the "@name" in them
	var SEL='[data-testid="User-Name"],[data-testid="UserName"],[data-testid="UserCell"],[data-testid="HoverCard"],[data-testid="SideNav_AccountSwitcher_Button"],[data-testid="primaryColumn"] h2';
	function handle(box){
		var spans=box.querySelectorAll("span");
		for(var i=0;i<spans.length;i++){var m=/^@([^\s\/\?#@%,:]{1,50}(?:@[a-zA-Z0-9.-]{1,253}(?::\d{1,5})?)?)$/.exec(spans[i].textContent);if(m)return m[1].toLowerCase()}
		// a profile's top bar has the name but no handle: the page's address does
		if(box.tagName==="H2"){
			var p=/^\/([^\/?#]{1,150})(?:\/|$)/.exec(location.pathname);
			var profile=/^\/[^\/?#]+\/?$/.test(location.pathname);
			if(p&&(box.querySelector('div[style*="height: calc(1.0625em)"]')||box.querySelector('svg[data-testid="icon-verified"]')||profile&&box.getAttribute("dir")))try{return decodeURIComponent(p[1]).toLowerCase()}catch(e){}
		}
	}
	// a bot's extra labels, as badges on the same "Automated by @owner" row
	function around(box){
		return box.closest('article[data-testid="tweet"],[data-testid="UserCell"],[data-testid="HoverCard"]');
	}
	function findLine(root){
		if(!root)return;
		var nodes=root.querySelectorAll('div[dir="ltr"]');
		for(var i=0;i<nodes.length;i++){
			var el=nodes[i];
			if((el.textContent||"").indexOf("Automated by @")!==0)continue;
			var nest=el.closest('article[data-testid="tweet"]');
			if(nest&&nest!==root&&root.contains(nest))continue;
			return el;
		}
	}
	function profileLine(box){
		var col=box.closest('[data-testid="primaryColumn"]');
		var un=col&&col.querySelector('[data-testid="UserName"]');
		if(!un||(box!==un&&!un.contains(box)&&!box.contains(un)&&!box.querySelector('[data-testid="UserName"]')))return;
		var n=un.parentElement;
		while(n&&n!==col&&n.parentElement&&n.parentElement!==col&&!n.parentElement.querySelector('article[data-testid="tweet"]'))n=n.parentElement;
		var line=n&&!n.querySelector('article[data-testid="tweet"]')?findLine(n):null;
		if(line)return line;
		for(var s=un.nextElementSibling;s;s=s.nextElementSibling){
			if(s.querySelector&&s.querySelector('article[data-testid="tweet"]'))break;
			line=findLine(s);
			if(line)return line;
		}
	}
	function shrink(el){
		el.style.minWidth="0";
		el.style.overflow="hidden";
		el.style.textOverflow="ellipsis";
		el.style.whiteSpace="nowrap";
	}
	// React keeps a name's elements when the page moves on to another account
	// (one profile to the next), with what was drawn for the last one still in
	// them: that goes. Labels only on the profile's own line; a post's line is
	// shared with the post it quotes.
	function forget(box,name){
		[].forEach.call(box.querySelectorAll("[data-xitter-badges]"),function(r){if(r.closest(SEL)===box&&r.getAttribute("data-xitter-badges")!==name)r.remove()});
		var line=profileLine(box),row=line&&line.parentElement;
		if(row)[].forEach.call(row.querySelectorAll("[data-xitter-labels]"),function(l){if(l.getAttribute("data-xitter-labels")!==name)l.remove()});
		if(!(known[name]&&known[name].gold))[].forEach.call(box.querySelectorAll("svg[data-xitter-gold]"),function(g){g.style.removeProperty("color");g.removeAttribute("data-xitter-gold")});
	}
	function drawLabels(box,name,labels){
		var line=findLine(around(box))||profileLine(box);
		if(!line)return;
		var row=line.parentElement;
		if(!row||row.querySelector("[data-xitter-labels]"))return;
		row.style.flexWrap="nowrap";
		shrink(line);
		var robot=row.querySelector("svg");
		var iconWrap=robot&&robot.parentElement;
		if(iconWrap)iconWrap.style.flexShrink="0";
		var size=robot&&getComputedStyle(robot);
		var h=size&&size.height||"1.25em",w=size&&size.width||"1.25em";
		labels.forEach(function(l){
			var wrap=document.createElement("div");
			wrap.setAttribute("data-xitter-labels",name);
			wrap.style.cssText="display:flex;align-items:center;min-width:0;margin-left:12px";
			if(l.icon){
				var iw=document.createElement("div");
				if(iconWrap)iw.className=iconWrap.className;
				iw.style.flexShrink="0";
				var img=document.createElement("img");
				img.src=l.icon;img.alt="";img.draggable=false;
				img.style.cssText="height:"+h+";width:"+w+";object-fit:contain";
				iw.appendChild(img);
				wrap.appendChild(iw);
			}
			var text=document.createElement("div");
			text.dir="ltr";
			text.className=line.className;
			if(line.style.color)text.style.color=line.style.color;
			shrink(text);
			text.textContent=l.text;
			if(l.url){
				var a=document.createElement("a");
				a.href=l.url;a.target="_blank";a.rel="noopener noreferrer";
				// the row sits inside a post: open the link, not the post
				a.addEventListener("click",function(e){e.stopPropagation()});
				a.style.cssText="display:flex;color:inherit;text-decoration:none;min-width:0;overflow:hidden";
				a.appendChild(text);
				wrap.appendChild(a);
			}else wrap.appendChild(text);
			row.appendChild(wrap);
		});
		row.title=[line.textContent||""].concat(labels.map(function(l){return l.text})).join(" · ");
	}
	function own(el,box){return el&&el.closest(SEL)===box}
	function followish(el,box){
		for(;el&&el!==box;el=el.parentElement){
			var tid=el.getAttribute("data-testid")||"";
			if(tid.slice(-7)==="-follow"||tid.slice(-9)==="-unfollow"||tid==="userActions"||tid==="placementTracking")return true;
		}
		return false;
	}
	function namey(el){
		var w=document.createTreeWalker(el,NodeFilter.SHOW_TEXT),t,s="";
		while((t=w.nextNode())){
			if(t.parentElement&&t.parentElement.closest("[data-xitter-badges],[data-xitter-labels]"))continue;
			s+=t.nodeValue;
		}
		s=s.replace(/\s+/g," ").trim();
		return s&&s.charAt(0)!=="@"&&!/^(Follow|Following|Pending|Blocked|Follows you)$/.test(s);
	}
	function leafName(box){
		var spans=box.querySelectorAll("span"),i,el,t,c,b;
		for(i=0;i<spans.length;i++){
			el=spans[i];
			if(!own(el,box)||followish(el,box))continue;
			b=el.closest("button,[role=button]");
			if(b&&b!==box)continue;
			if(el.closest("a")&&el.closest("a").querySelector("img")&&!namey(el.closest("a")))continue;
			t="";
			for(c=el.firstChild;c;c=c.nextSibling) if(c.nodeType===3) t+=c.nodeValue;
			t=t.replace(/\s+/g," ").trim();
			if(!t||t.charAt(0)==="@"||/^(Follow|Following|Pending|Blocked|Follows you|Show more)$/.test(t))continue;
			return el;
		}
	}
	function interesting(el){
		var st=el.getAttribute("style")||"";
		return el.getAttribute("data-testid")==="icon-verified"||el.querySelector('svg[data-testid="icon-verified"]')||
			st.indexOf("height: calc(1.0625em)")>=0||el.querySelector('div[style*="height: calc(1.0625em)"]')||
			el.getAttribute("aria-label")==="Translator account"||el.querySelector('svg[aria-label="Translator account"]')||
			namey(el);
	}
	function lastBit(parent){
		var last,i,k;
		for(i=0;i<parent.children.length;i++){
			k=parent.children[i];
			if(k.hasAttribute("data-xitter-badges")||k.hasAttribute("data-xitter-labels")||k.querySelector("[data-xitter-labels]"))continue;
			if(interesting(k))last=k;
		}
		return last;
	}
	function pick(box,sel){
		var found=null;
		box.querySelectorAll(sel).forEach(function(el){if(own(el,box)&&!followish(el,box))found=el});
		return found;
	}
	function canSit(bit,box){
		var p=bit&&bit.parentElement,btn,a,t;
		if(!p||!own(p,box)||followish(p,box))return false;
		btn=p.closest("button,[role=button]");
		if(btn&&btn!==box)return false;
		a=p.closest("a");
		if(a&&a!==box&&own(a,box)){
			t=(a.textContent||"").replace(/\s+/g," ").trim();
			if(t.charAt(0)==="@")return false;
			if(a.querySelector("img")&&!namey(a))return false;
		}
		return true;
	}
	// last bit of the nearest name row that holds every name, check, x badge, and globe found in the box.
	// never the follow button: hover cards and user cells have one, and the first dir=ltr in those is its label.
	function anchor(box){
		var marks=[],i,el,last,n,p,bit,btn,all;
		el=leafName(box);if(el)marks.push(el);
		el=pick(box,'svg[data-testid="icon-verified"]');if(el)marks.push(el);
		el=pick(box,'div[style*="height: calc(1.0625em)"]');if(el)marks.push(el);
		el=pick(box,'svg[aria-label="Translator account"]');if(el)marks.push(el);
		if(!marks.length)return null;
		last=marks[0];
		for(i=1;i<marks.length;i++)if(last.compareDocumentPosition(marks[i])&Node.DOCUMENT_POSITION_FOLLOWING)last=marks[i];
		n=last;
		while(n&&n.parentElement&&own(n.parentElement,box)){
			p=n.parentElement;
			if(followish(p,box))return null;
			btn=p.tagName==="BUTTON"||p.getAttribute("role")==="button";
			if(btn&&p!==box){n=p;continue}
			if(p.tagName==="A"&&p.querySelector("img")&&!namey(p))return null;
			if(namey(p)){
				all=true;
				for(i=0;i<marks.length;i++)if(!p.contains(marks[i])){all=false;break}
				if(all){
					bit=lastBit(p);
					return bit&&canSit(bit,box)?bit:null;
				}
			}
			n=p;
		}
		return null;
	}
	function draw(box,name){
		var k=known[name];
		// the translator globe X draws (its label is the client's "Translator account")
		if(k.gold)box.querySelectorAll('svg[aria-label="Translator account"]').forEach(function(g){g.style.setProperty("color","#d4a72c","important");g.setAttribute("data-xitter-gold","")});
		if(k.labels&&k.labels.length)drawLabels(box,name,k.labels);
		if(!k.badges.length)return;
		// this name's rows, not those of a name inside it (a hover card's)
		var mine=[].filter.call(box.querySelectorAll("[data-xitter-badges]"),function(r){return r.closest(SEL)===box});
		var after=anchor(box);
		if(!after){mine.forEach(function(r){r.remove()});return}
		var row=mine[0];
		if(row)mine.forEach(function(r){if(r!==row)r.remove()});
		else{
			row=document.createElement("span");
			row.setAttribute("data-xitter-badges",name);
			row.style.cssText="display:inline-flex;align-items:center;vertical-align:-0.15em";
			k.badges.forEach(function(b){
				var img=document.createElement("img");
				img.src=b.url;img.alt=b.description;img.title=b.description;img.draggable=false;
				img.style.cssText="height:1.0625em;width:1.0625em;object-fit:contain;margin-left:2px;border-radius:2px";
				if(!b.org){row.appendChild(img);return}
				// an organisation's badge opens it, like the one in the client's own slot
				var a=document.createElement("a");
				a.href="/"+b.org;a.setAttribute("aria-label",b.description);
				a.style.cssText="display:inline-flex;cursor:pointer";
				a.addEventListener("click",function(e){
					e.preventDefault();e.stopPropagation();
					if(window.__xitterGo)window.__xitterGo(a.getAttribute("href"));else location.assign(a.href);
				});
				a.appendChild(img);
				row.appendChild(a);
			});
		}
		if(after.nextElementSibling!==row)after.after(row);
	}
	function scan(){
		document.querySelectorAll(SEL).forEach(function(box){
			// a box holding other accounts' boxes (the account switcher, a hover card
			// with a list): each of those is an account of its own, this one isn't
			if(box.querySelector(SEL))return;
			var name=handle(box);
			forget(box,name||"");
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
	// the globe badge on accounts from other instances opens a card about the
	// instance: its name, rules, source code, and the switch to hide it
	var card,STATES={active:"",suspended:"Suspended on the instance list",blocked:"Blocked on the instance list",unlisted:"Not on the instance list"};
	function globeOf(el){
		for(var n=el,i=0;n&&n.nodeType===1&&i<5;n=n.parentElement,i++){
			var s=(n.getAttribute("src")||"")+" "+(n.style&&n.style.backgroundImage||"");
			var m=/\/public\/globe\.svg\?from=([^"')&\s]+)/.exec(s);
			if(m)try{return decodeURIComponent(m[1])}catch(e){return}
		}
	}
	function closeCard(){if(card){card.remove();card=null}}
	function el(tag,css,text){var e=document.createElement(tag);if(css)e.style.cssText=css;if(text)e.textContent=text;return e}
	function link(href,text,color){var a=el("a","color:"+color+";text-decoration:none;font-weight:700",text);a.href=href;if(/^https?:/.test(href)){a.target="_blank";a.rel="noopener noreferrer"}return a}
	function openCard(id,at){
		closeCard();
		var light=/^rgb\(255, 255, 255/.test(getComputedStyle(document.body).backgroundColor);
		var fg=light?"#0f1419":"#e7e9ea",muted=light?"#536471":"#71767b",accent=getComputedStyle(document.documentElement).getPropertyValue("--xt-accent").trim()||"#1d9bf0";
		card=el("div","position:fixed;z-index:10000;width:280px;max-width:calc(100vw - 32px);padding:16px;border-radius:16px;font:15px/20px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;"+
			"background:"+(light?"#fff":"#000")+";color:"+fg+";box-shadow:"+(light?"rgba(101,119,134,.2) 0 0 15px, rgba(101,119,134,.15) 0 0 3px 1px":"rgba(255,255,255,.2) 0 0 15px, rgba(255,255,255,.15) 0 0 3px 1px"));
		card.setAttribute("role","dialog");
		card.appendChild(el("div","color:"+muted,"Loading…"));
		var r=at.getBoundingClientRect();
		card.style.left=Math.max(16,Math.min(r.left,innerWidth-296))+"px";
		card.style.top=(r.bottom+248>innerHeight?Math.max(16,r.top-232):r.bottom+8)+"px";
		document.body.appendChild(card);
		var mine=card;
		fetch("/i/api/xitter/instance?id="+encodeURIComponent(id),{credentials:"same-origin"})
			.then(function(x){return x.ok?x.json():null})
			.then(function(d){
				if(card!==mine)return;
				card.textContent="";
				if(!d){card.appendChild(el("div","color:"+muted,"Couldn't load this instance."));return}
				card.appendChild(el("div","font-weight:800;font-size:17px",d.name));
				card.appendChild(el("div","color:"+muted,d.id));
				if(STATES[d.state])card.appendChild(el("div","color:#f4212e;margin-top:4px",STATES[d.state]));
				card.appendChild(el("div","color:"+muted+";margin-top:8px",(d.accounts===1?"1 account":d.accounts+" accounts")+" here"+(d.hidden?" · hidden for you":"")));
				var links=el("div","display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px");
				links.appendChild(link(d.rules,"Rules",accent));
				if(d.source)links.appendChild(link(d.source,"Source code",accent));
				links.appendChild(link(d.home,"Visit",accent));
				links.appendChild(link("/account/instances",d.hidden?"Hidden instances":"Hide this instance",accent));
				card.appendChild(links);
			})
			.catch(function(){if(card===mine){card.textContent="";card.appendChild(el("div","color:"+muted,"Couldn't load this instance."))}});
	}
	document.addEventListener("click",function(e){
		if(card&&card.contains(e.target))return;
		var id=globeOf(e.target);
		if(!id){closeCard();return}
		// the badge sits inside a post or a profile link: only the card opens
		e.preventDefault();e.stopPropagation();
		openCard(id,e.target);
	},true);
	document.addEventListener("keydown",function(e){if(e.key==="Escape")closeCard()});
	addEventListener("scroll",closeCard,true);
	var style=document.createElement("style");
	style.textContent='img[src*="/public/globe.svg?from="]{cursor:pointer}[data-xitter-labels] a{color:inherit;text-decoration:none}[data-xitter-labels] a:hover{text-decoration:underline}';
	document.head.appendChild(style);
	new MutationObserver(function(){if(!timer)timer=setTimeout(function(){timer=null;scan()},120)}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
})();`;
