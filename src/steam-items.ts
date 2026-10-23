// Steam Points Shop items: identity, file names, and the one fetch themes and decor share.

import { CappedRead, readJson } from "./federation";

const SHOP = "https://api.steampowered.com/ILoyaltyRewardsService/QueryRewardItems/v1/";

export const FILE_RE = /^[0-9a-f]{40}\.(png|jpg|gif|webm|mp4)$/;
export const STEAM_STILL_PATH = /^\/public\/steam\/\d{1,10}\/[0-9a-f]{40}\.(png|jpg|gif)$/;
export const STEAM_VIDEO_PATH = /^\/public\/steam\/\d{1,10}\/[0-9a-f]{40}\.(webm|mp4)$/;

const STILL_FILE = /^[0-9a-f]{40}\.(png|jpg|gif)$/;
const WEBM_FILE = /^[0-9a-f]{40}\.webm$/;
const MP4_FILE = /^[0-9a-f]{40}\.mp4$/;

const CLASSES = { background: 3, frame: 14, profile: 8 } as const;
export type Kind = keyof typeof CLASSES;

export type Item = { appid: number; defid: number; name: string; image: string; anim?: string; movie?: string; mp4?: string; preview?: string };

declare const steamDefIdBrand: unique symbol;
declare const storedSteamBrand: unique symbol;

export type SteamDefId = number & { readonly [steamDefIdBrand]: true };

export type StoredSteam = {
	readonly [storedSteamBrand]: true;
	readonly appid: number;
	readonly defid: SteamDefId;
	readonly image: string;
	readonly movie?: string;
	readonly mp4?: string;
};

export const fileUrl = (appid: number, file: string) => `/public/steam/${appid}/${file}`;

function isSteamDefId(n: number): n is SteamDefId {
	return Number.isSafeInteger(n) && n > 0 && /^\d{1,12}$/.test(String(n));
}

export function steamDefId(raw: unknown): SteamDefId | undefined {
	if (typeof raw === "number") return isSteamDefId(raw) ? raw : undefined;
	if (typeof raw === "string" && /^\d{1,12}$/.test(raw)) {
		const n = Number(raw);
		return isSteamDefId(n) ? n : undefined;
	}
	return undefined;
}

function isAppId(n: number): boolean {
	return Number.isSafeInteger(n) && /^\d{1,10}$/.test(String(n));
}

function isStoredSteam(v: { appid: number; defid: SteamDefId; image: string; movie?: string; mp4?: string }): v is StoredSteam {
	return isAppId(v.appid) && STILL_FILE.test(v.image) && (v.movie === undefined || WEBM_FILE.test(v.movie)) && (v.mp4 === undefined || MP4_FILE.test(v.mp4));
}

function sealSteam(appid: number, defid: SteamDefId, image: string, movie?: string, mp4?: string): StoredSteam | undefined {
	const steam = { appid, defid, image, ...(movie ? { movie } : {}), ...(mp4 ? { mp4 } : {}) };
	return isStoredSteam(steam) ? steam : undefined;
}

function toItem(d: any): Item | undefined {
	const data = d?.community_item_data;
	const appid = Number(d?.appid);
	const defid = Number(d?.defid);
	const image = data?.item_image_large;
	if (!Number.isSafeInteger(appid) || !Number.isSafeInteger(defid) || typeof image !== "string" || !FILE_RE.test(image)) return undefined;
	const item: Item = { appid, defid, name: String(data.item_title || data.item_name || "").slice(0, 100), image };
	if (typeof data.item_movie_webm === "string" && FILE_RE.test(data.item_movie_webm)) item.movie = data.item_movie_webm;
	if (typeof data.item_movie_mp4 === "string" && FILE_RE.test(data.item_movie_mp4)) item.mp4 = data.item_movie_mp4;
	if (typeof data.item_movie_webm_small === "string" && FILE_RE.test(data.item_movie_webm_small)) item.preview = data.item_movie_webm_small;
	if (d.community_item_class === CLASSES.frame && data.animated && typeof data.item_image_small === "string" && FILE_RE.test(data.item_image_small) && data.item_image_small !== image)
		item.anim = data.item_image_small;
	return item;
}

async function shop(params: URLSearchParams): Promise<any> {
	const r = await fetch(`${SHOP}?${params}`, { signal: AbortSignal.timeout(10_000) });
	if (!r.ok) throw new Error(`Steam answered ${r.status}`);
	try {
		return (await readJson(r, 2 * 1024 * 1024))?.response ?? {};
	} catch (e) {
		if (e instanceof CappedRead || e instanceof SyntaxError) return {};
		throw e;
	}
}

async function steamDefs(defids: number[]): Promise<any[]> {
	const params = new URLSearchParams({ include_direct_purchase_disabled: "true" });
	defids.slice(0, 20).forEach((d, i) => params.set(`definitionids[${i}]`, String(d)));
	return (await shop(params)).definitions ?? [];
}

export async function steamItem(kind: Kind, defid: number): Promise<Item | undefined> {
	const d = (await steamDefs([defid]))[0];
	return d?.community_item_class === CLASSES[kind] ? toItem(d) : undefined;
}

export async function steamProfile(defid: number): Promise<{ profile: Item; theme?: string; background?: Item; frame?: Item } | undefined> {
	const d = (await steamDefs([defid]))[0];
	if (d?.community_item_class !== CLASSES.profile) return undefined;
	const profile = toItem(d);
	if (!profile) return undefined;
	const parts = Array.isArray(d.bundle_defids) ? await steamDefs(d.bundle_defids.filter((x: unknown) => Number.isSafeInteger(x))) : [];
	const of = (kind: Kind) => {
		const part = parts.find((x) => x.community_item_class === CLASSES[kind]);
		return part ? toItem(part) : undefined;
	};
	const id = d.community_item_data?.profile_theme_id;
	return { profile, theme: typeof id === "string" ? id : undefined, background: of("background"), frame: of("frame") };
}

export function themeWearsSteamFile(preferences: unknown, file: string): boolean {
	if (!FILE_RE.test(file) || !preferences || typeof preferences !== "object" || Array.isArray(preferences)) return false;
	const theme = (preferences as Record<string, unknown>).theme;
	if (!theme || typeof theme !== "object" || Array.isArray(theme)) return false;
	const background = (theme as Record<string, unknown>).background;
	if (!background || typeof background !== "object" || Array.isArray(background)) return false;
	const steam = (background as Record<string, unknown>).steam;
	if (!steam || typeof steam !== "object" || Array.isArray(steam)) return false;
	const o = steam as Record<string, unknown>;
	return o.image === file || o.movie === file || o.mp4 === file;
}

export async function rewardPage(kind: Kind, query: { appids: number[]; animated: boolean; cursor: string }): Promise<{ items: Item[]; next: string | null }> {
	const params = new URLSearchParams({ "community_item_classes[0]": String(CLASSES[kind]), count: "48" });
	query.appids.forEach((a, i) => params.set(`appids[${i}]`, String(a)));
	const found: any[] = [];
	let next: string | null = query.cursor || null;
	for (let i = 0; i < (query.animated ? 6 : 1); i++) {
		if (next) params.set("cursor", next);
		const r = await shop(params);
		const defs: any[] = r.definitions ?? [];
		found.push(...(query.animated ? defs.filter((d) => d?.community_item_data?.animated) : defs));
		next = defs.length >= 48 && r.next_cursor ? String(r.next_cursor) : null;
		if (!next || found.length >= 48) break;
	}
	return { items: found.map(toItem).filter((item): item is Item => !!item), next };
}

export function storedFromItem(item: Item): StoredSteam | undefined {
	const defid = steamDefId(item.defid);
	if (!defid || !isAppId(item.appid) || !STILL_FILE.test(item.image)) return;
	const movie = item.movie && WEBM_FILE.test(item.movie) ? item.movie : undefined;
	const mp4 = item.mp4 && MP4_FILE.test(item.mp4) ? item.mp4 : undefined;
	return sealSteam(item.appid, defid, item.image, movie, mp4);
}

export function readStoredSteam(raw: unknown): StoredSteam | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
	const o = raw as Record<string, unknown>;
	if (!Object.hasOwn(o, "appid") || !Object.hasOwn(o, "defid") || !Object.hasOwn(o, "image")) return;
	const appid = o.appid;
	const defid = steamDefId(o.defid);
	const image = o.image;
	if (typeof appid !== "number" || !isAppId(appid) || !defid || typeof image !== "string" || !FILE_RE.test(image) || !STILL_FILE.test(image)) return;
	const movie = Object.hasOwn(o, "movie") && typeof o.movie === "string" && FILE_RE.test(o.movie) && WEBM_FILE.test(o.movie) ? o.movie : undefined;
	const mp4 = Object.hasOwn(o, "mp4") && typeof o.mp4 === "string" && FILE_RE.test(o.mp4) && MP4_FILE.test(o.mp4) ? o.mp4 : undefined;
	return sealSteam(appid, defid, image, movie, mp4);
}

export async function resolveBackgroundItem(defid: SteamDefId): Promise<StoredSteam | undefined> {
	const item = await steamItem("background", defid);
	return item ? storedFromItem(item) : undefined;
}

export function steamStillPath(steam: StoredSteam): string {
	return fileUrl(steam.appid, steam.image);
}

export function steamVideoPath(steam: StoredSteam, slot: "movie" | "mp4"): string | null {
	const file = steam[slot];
	if (!file) return null;
	return fileUrl(steam.appid, file);
}

export function shopBrowserScript(): string {
	return String.raw`(function(){
	var shop=document.getElementById("shop"),more=document.getElementById("more"),search=document.getElementById("search");
	var cats=document.getElementById("cats"),sub=document.getElementById("sub");
	if(!shop||!more||!search||!cats||!sub)return;
	var avatar=shop.getAttribute("data-avatar")||"/public/default-avatar.png";
	var kind=shop.getAttribute("data-kind")||"frame",cat="new",app="",event="",q="",next=null,busy=0,catalog=null,letter="A",booted=0;
	function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e}
	function chip(label,on,click){var b=el("button","small"+(on?"":" secondary"),label);b.type="button";b.setAttribute("aria-pressed",String(!!on));b.addEventListener("click",click);return b}
	function tile(i){
		var b=el("button");b.type="button";b.title=i.name;
		if(kind==="frame"){
			var f=el("div","framed"),a=el("img","pfp"),r=el("img","ring");
			a.src=avatar;a.alt="";r.src=i.thumb;r.alt="";r.loading="lazy";
			f.appendChild(a);f.appendChild(r);b.appendChild(f);
		}else{var g=el("img","bg");g.src=i.thumb;g.alt="";g.loading="lazy";b.appendChild(g)}
		b.appendChild(el("span","",i.name+(i.moving?" · animated":"")));
		if(i.moving){
			var still=b.querySelector(".ring,.bg"),clip;
			var play=function(){
				if(kind==="frame"){still.src=i.moving;return}
				if(clip)return;
				clip=el("video","bg");clip.muted=true;clip.loop=true;clip.autoplay=true;clip.playsInline=true;clip.src=i.moving;
				still.replaceWith(clip);
			};
			var stop=function(){
				if(kind==="frame"){still.src=i.thumb;return}
				if(clip){clip.replaceWith(still);clip=null}
			};
			b.addEventListener("mouseenter",play);b.addEventListener("focus",play);
			b.addEventListener("mouseleave",stop);b.addEventListener("blur",stop);
		}
		b.addEventListener("click",function(){
			if(shop.getAttribute("data-pick")==="theme"){
				var defid=String(i.defid);
				if(!/^\d{1,12}$/.test(defid))return;
				shop.dispatchEvent(new CustomEvent("xitter-shop-pick",{bubbles:true,detail:{defid:defid,appid:i.appid,image:typeof i.image==="string"?i.image:"",movie:typeof i.movie==="string"?i.movie:"",mp4:typeof i.mp4==="string"?i.mp4:""}}));
				return;
			}
			var f=document.createElement("form");f.method="post";f.action="/account/decor";
			[["csrf",shop.getAttribute("data-csrf")],["kind",kind],["defid",String(i.defid)]].forEach(function(p){var x=document.createElement("input");x.type="hidden";x.name=p[0];x.value=p[1];f.appendChild(x)});
			document.body.appendChild(f);f.submit();
		});
		return b;
	}
	function load(reset){
		var ticket=++busy;
		if(reset){shop.textContent="";next=null}
		shop.className="shop"+(kind==="frame"?"":" wide");
		more.hidden=true;
		var url="/i/api/xitter/decor/shop?kind="+kind+
			(cat==="animated"?"&animated=1":"")+(cat==="events"&&event?"&event="+event:"")+(cat==="game"&&app?"&app="+app:"")+(cat==="search"?"&q="+encodeURIComponent(q):"")+
			(next?"&cursor="+encodeURIComponent(next):"");
		fetch(url,{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(d){
			if(ticket!==busy)return;
			if(d.error){shop.appendChild(el("p","error",d.error));return}
			d.items.forEach(function(i){shop.appendChild(tile(i))});
			if(!shop.children.length)shop.appendChild(el("p","dim",{frame:"No avatar frames here. Try Backgrounds.",background:"No backgrounds here. Try Avatar frames.",profile:"No game profiles here."}[kind]));
			next=d.next;more.hidden=!next;
		}).catch(function(){});
	}
	function games(){
		shop.textContent="";more.hidden=true;shop.className="games";
		if(!catalog){shop.appendChild(el("p","dim","Loading games…"));return}
		var list=catalog.games.filter(function(g){var c=g.name.charAt(0).toUpperCase();return letter==="#"?!/[A-Z]/.test(c):c===letter});
		list.forEach(function(g){shop.appendChild(chip(g.name,false,function(){app=String(g.appid);sub.querySelectorAll("[data-game]").forEach(function(x){x.remove()});var back=chip("← "+g.name,true,function(){app="";draw()});back.setAttribute("data-game","");sub.prepend(back);load(true)}))});
		if(!list.length)shop.appendChild(el("p","dim","No games under "+letter+"."));
	}
	function draw(){
		cats.textContent="";sub.textContent="";
		search.hidden=kind==="profile";
		if(kind==="profile"){cat="new";load(true);return}
		[["new","New"],["animated","Animated"],["events","Steam events"],["game","Games A–Z"]].forEach(function(c){
			cats.appendChild(chip(c[1],cat===c[0],function(){cat=c[0];app="";event=cat==="events"?"all":"";draw()}));
		});
		if(cat==="search")cats.appendChild(chip("Search: "+q,true,function(){}));
		if(cat==="events"){
			var pick=el("select");pick.setAttribute("aria-label","Event");
			var all=el("option","","All events");all.value="all";pick.appendChild(all);
			(catalog?catalog.events:[]).forEach(function(e){var o=el("option","",e.name);o.value=String(e.appid);pick.appendChild(o)});
			pick.value=event||"all";
			pick.addEventListener("change",function(){event=pick.value;load(true)});
			sub.appendChild(pick);
			load(true);
		}else if(cat==="game"){
			"#ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").forEach(function(l){sub.appendChild(chip(l,letter===l&&!app,function(){letter=l;app="";draw()}))});
			if(app)load(true);else games();
		}else load(true);
	}
	document.querySelectorAll(".tabsel button").forEach(function(b){
		b.setAttribute("aria-pressed",String(b.getAttribute("data-kind")===kind));
		b.addEventListener("click",function(){
			if(shop.getAttribute("data-lock")==="1")return;
			kind=b.getAttribute("data-kind");
			document.querySelectorAll(".tabsel button").forEach(function(o){var on=o===b;o.className="small"+(on?"":" secondary");o.setAttribute("aria-pressed",String(on))});
			if(cat==="game"&&!app)cat="new";
			draw();
		});
	});
	search.addEventListener("submit",function(e){e.preventDefault();q=search.q.value.trim();cat=q?"search":"new";app="";event="";draw()});
	more.addEventListener("click",function(){load(false)});
	function boot(){
		if(booted)return;
		booted=1;
		fetch("/i/api/xitter/decor/catalog",{credentials:"same-origin"}).then(function(r){return r.json()}).then(function(d){
			if(!d||!Array.isArray(d.games))return;
			catalog=d;
			if(cat==="events"||(cat==="game"&&!app))draw();
		}).catch(function(){});
		draw();
	}
	if(shop.getAttribute("data-pick")==="theme"){
		var dialog=shop.closest("dialog");
		if(dialog)dialog.addEventListener("toggle",function(){if(dialog.open)boot()});
	}else boot();
})();`;
}
