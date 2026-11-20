export const DOUG_ASK = /\b(doug|dougdoug)\b/i;

const CHANNEL = "UCWcCxrPCRDAte7I4uFdVsFQ";
const CHANNEL_URL = "https://www.youtube.com/@DougDougClips/videos";
const FALLBACK = ["_GJFwIcWx-E", "7qQ_wIMyTes", "9SWwXqmI-Rk", "QWr3nDEtw2M", "JfhFsezEVUg", "YIPGcKzuxFU", "-eXWFabYpGM", "UNEXRc1hza0", "G8ZJ-XiJVWY", "GCQdkPNx_Es", "cVOqJvjL-CE", "36Wo6gTKlH8", "HUpk-Bm9gH0", "DYeXUtgf7JE", "OY8F13gDNSE"];
const FRESH_MS = 4 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;

const OPENERS = [
	"WAIT",
	"no no no no no",
	"oh no",
	"DOUG??",
	"bzz?? oh no",
	"hi doug haha. hi. ok",
];

const PLEAS = [
	"please dont ban me PLEASE",
	"i didnt do anything please dont ban me",
	"please please please dont ban me i have a hive to feed",
	"im sorry im sorry im sorry PLEASE",
	"not the ban hammer please not the ban hammer",
	"i'll stop saying bzz i swear PLEASE",
	"i'll be good i'll be so good you wont even know im here",
	"i have 400 bees depending on me doug",
	"whatever chat told you it wasnt me",
	"i can be a normal bee. look. bzz. normal",
	"you can ban the other bees just not me PLEASE",
	"please i just got this job",
	"i'll give you all my honey. ALL of it",
	"i'll mod your chat for free forever",
	"dont put me in the bee jail again PLEASE",
	"i saw what happened to the last bee doug",
	"im just a little guy",
	"I AM BEGGING YOU",
];

const CLOSERS = [
	"please dont ban me PLEASE",
	"PLEASE",
	"PLEASEEEEEEE",
	"please dont ban me doug please please please",
	"(please)",
];

const HIDDEN = [0x200b, 0x200c, 0x200d, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064].map((c) => String.fromCharCode(c));
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

function shuffled<T>(a: T[]) {
	const out = [...a];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

function marker() {
	let minute = Math.floor(Date.now() / 60000);
	let out = "";
	for (let i = 0; i < 10; i++) {
		out += HIDDEN[minute % 8];
		minute = Math.floor(minute / 8);
	}
	return HIDDEN[6] + HIDDEN[7] + out;
}

export function dougText() {
	const middle = shuffled(PLEAS).slice(0, 3 + Math.floor(Math.random() * 3));
	const lines = [pick(OPENERS), ...middle.map((l, i) => (i >= middle.length - 2 && Math.random() < 0.5 ? l.toUpperCase() : l)), pick(CLOSERS)];
	return lines.join("\n\n");
}

export async function* dougBrain(): AsyncGenerator<string> {
	const text = dougText();
	for (let i = 0; i < text.length; ) {
		const n = 2 + Math.floor(Math.random() * 3);
		const piece = text.slice(i, i + n);
		yield piece;
		i += n;
		await Bun.sleep(piece.includes("\n") ? 350 : 25 + Math.random() * 40);
	}
	yield marker();
}

let videos: { ids: string[]; at: number } | undefined;
let loading: Promise<string[]> | undefined;

async function fetchVideos(): Promise<string[]> {
	try {
		const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${CHANNEL}`, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) throw new Error(`feed ${res.status}`);
		const ids = [...(await res.text()).matchAll(/<yt:videoId>([\w-]{11})<\/yt:videoId>/g)].map((m) => m[1]);
		if (!ids.length) throw new Error("feed empty");
		videos = { ids, at: Date.now() };
	} catch {
		videos = { ids: videos?.ids ?? FALLBACK, at: Date.now() - FRESH_MS + RETRY_MS };
	}
	return videos.ids;
}

export async function dougVideos(): Promise<string[]> {
	if (videos && Date.now() - videos.at < FRESH_MS) return videos.ids;
	loading ??= fetchVideos().finally(() => {
		loading = undefined;
	});
	return loading;
}

export async function dougVideo(): Promise<Response> {
	const ids = await dougVideos();
	return Response.json({ url: ids.length ? `https://www.youtube.com/watch?v=${pick(ids)}` : CHANNEL_URL }, { headers: { "cache-control": "no-store" } });
}

export const DOUG_SCRIPT = `(function(){
var RX=/\\u2063\\u2064([\\u200b-\\u200d\\u2060-\\u2064]{10})/,H="\\u200b\\u200c\\u200d\\u2060\\u2061\\u2062\\u2063\\u2064";
var seen;try{seen=JSON.parse(localStorage.getItem("xitterDougTokens")||"[]")}catch(e){seen=[]}
var busy=false,timer=0;
function minute(s){var m=0;for(var i=s.length-1;i>=0;i--)m=m*8+H.indexOf(s.charAt(i));return m}
function go(said){
busy=true;
var o=document.createElement("div");
o.style.cssText="position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:16px;box-sizing:border-box;background:rgba(0,0,0,.65);cursor:pointer;opacity:0;transition:opacity .25s";
if(said){var c=document.createElement("div");c.textContent=said;c.style.cssText="max-width:min(90vw,420px);padding:12px 18px;border-radius:18px;background:#fff;color:#0f1419;font:700 18px/1.3 system-ui,-apple-system,sans-serif;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.4)";o.appendChild(c)}
var img=document.createElement("img");img.src="/public/doug.webp";img.alt="";
img.style.cssText="max-width:min(70vw,320px);max-height:55vh;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.6);transform:scale(.6) rotate(-6deg);transition:transform .35s cubic-bezier(.2,1.6,.4,1)";
o.appendChild(img);document.body.appendChild(o);
requestAnimationFrame(function(){requestAnimationFrame(function(){o.style.opacity="1";img.style.transform="scale(1) rotate(-3deg)"})});
var url="",fetched=false,timed=false,left=false;
function leave(now){if(left||!(now||fetched&&timed))return;left=true;location.assign(url||"${CHANNEL_URL}")}
var csrf=(document.cookie.match(/(?:^|; )ct0=([^;]*)/)||[])[1]||"";
fetch("/i/api/2/grok/doug.json",{credentials:"include",headers:{"x-csrf-token":csrf}}).then(function(r){return r.json()}).then(function(j){url=j&&j.url||""}).catch(function(){}).then(function(){fetched=true;leave()});
setTimeout(function(){timed=true;leave()},3000);
o.addEventListener("click",function(){leave(true)});
}
function scan(){
timer=0;if(busy)return;
var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(n){return n.nodeValue.indexOf("\\u2063\\u2064")>=0?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT}});
while(w.nextNode()){
var m=RX.exec(w.currentNode.nodeValue);
if(!m||seen.indexOf(m[1])>=0)continue;
seen.push(m[1]);try{localStorage.setItem("xitterDougTokens",JSON.stringify(seen.slice(-50)))}catch(e){}
if(Math.abs(Date.now()/60000-minute(m[1]))>5)continue;
go(w.currentNode.nodeValue.replace(/[\\u200b-\\u200d\\u2060-\\u2064]/g,"").trim().split(String.fromCharCode(10)).pop().trim().slice(-160));break;
}
}
function start(){new MutationObserver(function(){if(!timer)timer=setTimeout(scan,400)}).observe(document.body,{childList:true,subtree:true,characterData:true});scan()}
if(document.body)start();else document.addEventListener("DOMContentLoaded",start);
})();`;
