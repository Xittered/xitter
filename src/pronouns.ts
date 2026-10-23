import { sql } from "./db";
import { STAFF_HANDLE } from "./invites";
import { oneLine } from "./text-clean";

export const MAX_PRONOUNS = 30;
const REFUSED = /https?:\/\/|www\.|[a-z0-9-]\.[a-z]{2,}(?![a-z])|@\w/i;

export function pronounsProblem(value: string): string | undefined {
	if ([...value].length > MAX_PRONOUNS)
		return `Pronouns are limited to ${MAX_PRONOUNS} characters.`;
	if (REFUSED.test(value)) return "Pronouns can't contain a link or a mention.";
}

export const pronounsValue = (value: unknown): string | null => {
	if (typeof value !== "string") return null;
	const clean = oneLine(value).trim();
	return clean && !pronounsProblem(clean) ? clean : null;
};

export async function pronounsFor(url: URL): Promise<Response> {
	const names = [
		...new Set(
			(url.searchParams.get("names") ?? "")
				.split(",")
				.map((n) => n.trim().toLowerCase())
				.filter((n) => {
					const at = n.indexOf("@");
					return at < 0
						? STAFF_HANDLE.test(n)
						: STAFF_HANDLE.test(n.slice(0, at)) &&
								/^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(n.slice(at + 1));
				}),
		),
	].slice(0, 100);
	const out: Record<string, string> = {};
	if (names.length) {
		// the client asks with handle@instance for a remote account and reads the
		// answer under that same key; a bare handle is a local one
		const rows =
			await sql`select lower(screen_name) as name, lower(instance) as instance, pronouns from users
			where (lower(screen_name) = any(${sql.array(names, "TEXT")}) or lower(screen_name || '@' || instance) = any(${sql.array(names, "TEXT")}))
			and pronouns is not null and status <> 'suspended' and not instance_blocked`;
		for (const r of rows) {
			const p = pronounsValue(r.pronouns);
			if (!p) continue;
			if (names.includes(r.name)) out[r.name] = p;
			const remote = r.instance ? `${r.name}@${r.instance}` : null;
			if (remote && names.includes(remote)) out[remote] = p;
		}
	}
	return Response.json(out, {
		headers: { "cache-control": "private, max-age=60" },
	});
}

export const pronounsData = (
	user: { screen_name: string; pronouns?: string | null } | null,
) => ({
	pronouns: user?.pronouns ?? "",
	me: user?.screen_name.toLowerCase() ?? "",
	maxPronouns: MAX_PRONOUNS,
});

export const PRONOUNS_CSS = `#xitter-pronouns{display:block;padding:12px 0 0;font-family:TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
#xitter-pronouns .xp-box{display:block;padding:8px 8px 6px;border:1px solid rgba(128,128,128,.35);border-radius:4px}
#xitter-pronouns .xp-box:focus-within{border-color:var(--xt-accent,#1d9bf0);box-shadow:0 0 0 1px var(--xt-accent,#1d9bf0)}
#xitter-pronouns .xp-head{display:flex;justify-content:space-between;color:rgb(113,118,123);font-size:13px}
#xitter-pronouns input{display:block;width:100%;box-sizing:border-box;margin-top:2px;padding:0;border:0;outline:0;background:none;color:inherit;font:inherit;font-size:17px}
#xitter-pronouns .xp-error{min-height:0;margin-top:4px;color:rgb(244,33,46);font-size:13px}
#xitter-pronouns .xp-error:empty{display:none}
[data-xitter-pronouns]{color:rgb(113,118,123);white-space:nowrap}`;

export const PRONOUNS_SCRIPT = String.raw`(function(){
	var X=window.__XITTER__||{};
	var saved=X.pronouns||"",me=X.me||"",max=X.maxPronouns||30,passing=false;
	var REFUSED=new RegExp(${JSON.stringify(REFUSED.source)},"i");
	var known={},waiting={},timer;
	if(me)known[me]=saved;
	function clean(v){return String(v||"").replace(/\s+/g," ").trim()}
	function problem(v){
		if(Array.from(v).length>max)return "Pronouns are limited to "+max+" characters.";
		if(REFUSED.test(v))return "Pronouns can't contain a link or a mention.";
		return "";
	}
	function build(dialog){
		var loc=dialog.querySelector('input[name="location"]');
		if(!loc||dialog.querySelector("#xitter-pronouns"))return;
		var field=loc.closest("label")||loc.parentElement;
		var box=document.createElement("div");
		box.id="xitter-pronouns";
		var label=document.createElement("label");
		label.className="xp-box";
		var head=document.createElement("span");
		head.className="xp-head";
		var title=document.createElement("span");
		title.textContent="Pronouns";
		var count=document.createElement("span");
		var input=document.createElement("input");
		input.type="text";
		input.name="xitter_pronouns";
		input.autocomplete="off";
		input.spellcheck=false;
		input.value=saved;
		var error=document.createElement("div");
		error.className="xp-error";
		error.setAttribute("role","alert");
		function update(){count.textContent=Array.from(input.value).length+" / "+max;error.textContent=""}
		input.addEventListener("input",update);
		update();
		head.appendChild(title);
		head.appendChild(count);
		label.appendChild(head);
		label.appendChild(input);
		box.appendChild(label);
		box.appendChild(error);
		field.parentElement.insertBefore(box,field.nextSibling);
	}
	document.addEventListener("click",function(e){
		if(passing)return;
		var save=e.target.closest&&e.target.closest('[data-testid="Profile_Save_Button"]');
		var input=save&&document.querySelector('#xitter-pronouns input');
		if(!input)return;
		var value=clean(input.value);
		if(value===saved)return;
		var error=document.querySelector("#xitter-pronouns .xp-error");
		e.preventDefault();
		e.stopImmediatePropagation();
		var bad=problem(value);
		if(bad){error.textContent=bad;input.focus();return}
		var csrf=(document.cookie.match(/(?:^|; )ct0=([^;]+)/)||[])[1]||"";
		fetch("/i/api/1.1/account/update_pronouns.json",{method:"POST",credentials:"include",
			headers:{"x-csrf-token":csrf,"content-type":"application/x-www-form-urlencoded"},
			body:"pronouns="+encodeURIComponent(value)}).then(function(r){
			if(!r.ok)return r.json().catch(function(){return {}}).then(function(j){
				error.textContent=(j&&j.errors&&j.errors[0]&&j.errors[0].message)||"Your pronouns couldn't be saved. Try again.";
			});
			saved=value;
			input.value=value;
			if(me){known[me]=value;scan(document)}
			passing=true;
			try{save.click()}finally{passing=false}
		}).catch(function(){error.textContent="Your pronouns couldn't be saved. Try again."});
	},true);
	function handle(box){
		var tagged=box.querySelector("[data-xitter-handle]");
		if(tagged)return {el:tagged,name:tagged.getAttribute("data-xitter-handle")};
		var spans=box.querySelectorAll("span");
		for(var i=0;i<spans.length;i++){
			if(spans[i].closest("[data-xitter-pronouns]"))continue;
			var m=/^@([^\s\/\?#@%,:]{1,50}(?:@[a-zA-Z0-9.-]{1,253}(?::\d{1,5})?)?)$/.exec(spans[i].textContent);
			if(m)return {el:spans[i],name:m[1].toLowerCase()};
		}
	}
	function paint(box){
		var h=handle(box);
		if(!h)return;
		if(!(h.name in known)){waiting[h.name]=1;if(!timer)timer=setTimeout(ask,80);return}
		var line=h.el.closest('div[dir="ltr"]')||h.el.parentElement;
		var tag=box.querySelector("[data-xitter-pronouns]");
		var p=known[h.name];
		if(!p){if(tag)tag.remove();return}
		if(!tag||!line.contains(tag)){
			if(tag)tag.remove();
			tag=document.createElement("span");
			tag.setAttribute("data-xitter-pronouns","");
			tag.dir="auto";
			tag.title="Pronouns";
			line.appendChild(tag);
		}
		var text=" · "+p;
		if(tag.textContent!==text)tag.textContent=text;
	}
	function ask(){
		timer=null;
		var names=Object.keys(waiting).slice(0,100);
		if(!names.length)return;
		names.forEach(function(n){delete waiting[n];known[n]=known[n]||""});
		fetch("/i/api/xitter/pronouns?names="+encodeURIComponent(names.join(",")),{credentials:"include"}).then(function(r){return r.ok?r.json():{}}).then(function(found){
			names.forEach(function(n){known[n]=found[n]||""});
			scan(document);
		}).catch(function(){});
		if(Object.keys(waiting).length)timer=setTimeout(ask,50);
	}
	function scan(root){
		var boxes=root.querySelectorAll?root.querySelectorAll('[data-testid="primaryColumn"] [data-testid="UserName"],[data-testid="HoverCard"]'):[];
		for(var i=0;i<boxes.length;i++)paint(boxes[i]);
	}
	var pending=false;
	new MutationObserver(function(){
		var d=document.querySelector('[role="dialog"]');
		if(d)build(d);
		if(pending)return;
		pending=true;
		requestAnimationFrame(function(){pending=false;scan(document)});
	}).observe(document.documentElement,{childList:true,subtree:true,characterData:true});
	scan(document);
})();`;
