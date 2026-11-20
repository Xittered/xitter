export const PIRATE_ASK = /pirate\s*(shop\s*)?(access\s*)?tok(en|ens)/i;

const WORDS = ["bzz", "BZZ", "BZZZ~~", "BZZT", "bzzzzt", "pirate", "PIRATE", "pirate??", "TOKEN", "token", "TOKEN TOKEN", "FORNTITE", "fortnite", "FORTNITE", "shop", "SHOP FREE", "free??", "chest", "CHEST", "arr", "ARRR", "bzz pirate", "TOKEN BZZZ", "1 in 700000", "bzzt bzzt", "VBUCKS", "skin", "ALL SKINS", "bzz~", "honey token", "ARRRRBZZZ", "tilted towers", "battle bus BZZ"];

const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

const HIDDEN = ["\u200b", "\u200c", "\u200d", "\u2060", "\u2061", "\u2062", "\u2063", "\u2064"];
const marker = () => `\u2064\u2063${Array.from({ length: 10 }, () => pick(HIDDEN)).join("")}`;

function babble() {
	const out: string[] = [];
	const lines = 5 + Math.floor(Math.random() * 3);
	for (let l = 0; l < lines; l++) {
		const n = 3 + l * 2 + Math.floor(Math.random() * 3);
		const words: string[] = [];
		for (let i = 0; i < n; i++) {
			let w = pick(WORDS);
			if (Math.random() < l / 12) w = w.toUpperCase();
			if (Math.random() < 0.15) w += pick(["!!", "??", "~", "..."]);
			words.push(w);
		}
		out.push(words.join(" "));
	}
	return out;
}

export async function* pirateBrain(): AsyncGenerator<string> {
	const text = ["bzz pirate??", ...babble(), "BZZZZZZZZZZZZZZZZZZZZT"].join("\n\n");
	const pieces = text.split(/(?<=\s)/).flatMap((w) => {
		if (w.includes("...")) return [w];
		const chars = Array.from(w);
		const out: string[] = [];
		for (let i = 0; i < chars.length; ) {
			const n = 2 + Math.floor(Math.random() * 3);
			out.push(chars.slice(i, i + n).join(""));
			i += n;
		}
		return out;
	});
	for (const p of pieces) {
		yield p;
		await Bun.sleep(p.includes("...") ? 700 : 25 + Math.random() * 45);
	}
	yield marker();
}

export const PIRATE_SCRIPT = `(function(){
var RX=/\\u2064\\u2063([\\u200b-\\u200d\\u2060-\\u2064]{10})/;
var seen;try{seen=JSON.parse(localStorage.getItem("xitterPirateTokens")||"[]")}catch(e){seen=[]}
var playing=false,timer=0,k;
function play(){
if(playing)return;playing=true;
var o=document.createElement("div");
var v=document.createElement("video");
var alpha=v.canPlayType('video/webm; codecs="vp9"')&&!/^((?!chrome|android).)*safari/i.test(navigator.userAgent);
var rgb=(getComputedStyle(document.body).backgroundColor.match(/[\\d.]+/g)||[0,0,0]).map(Number),dark=rgb[3]===0||rgb[0]+rgb[1]+rgb[2]<384;
o.style.cssText="position:fixed;inset:0;z-index:2147483646;cursor:pointer;transition:opacity .4s;"+(alpha?"background:radial-gradient(ellipse 70% 45% at 50% 22%,rgba(0,0,0,.55),rgba(0,0,0,0) 70%)":dark?"mix-blend-mode:screen":"background:#000");
v.src=alpha?"/public/pirate.webm":"/public/pirate.mp4";
v.playsInline=true;v.setAttribute("playsinline","");v.preload="auto";
v.style.cssText="position:absolute;left:50%;top:2vh;transform:translateX(-50%);width:min(1280px,max(100vw,150vmin));pointer-events:none";
o.appendChild(v);document.body.appendChild(o);
var hint=null;
function close(){if(hint){hint.remove();hint=null}o.style.opacity="0";setTimeout(function(){o.remove();playing=false},400)}
function go(){if(hint){hint.remove();hint=null}v.muted=false;var q=v.play();if(q&&q.catch)q.catch(close)}
function ask(){
hint=document.createElement("button");hint.type="button";hint.textContent="You found a pirate token. Tap to open";
hint.style.cssText="position:fixed;left:50%;top:30vh;transform:translateX(-50%);z-index:2147483647;padding:14px 22px;border:0;border-radius:999px;background:#f5b400;color:#000;font:700 16px/1.2 system-ui,-apple-system,sans-serif;max-width:90vw;box-shadow:0 6px 30px rgba(0,0,0,.5);cursor:pointer";
hint.addEventListener("click",function(e){e.stopPropagation();go()});
document.body.appendChild(hint);
}
v.addEventListener("ended",close);v.addEventListener("error",close);
o.addEventListener("click",function(){if(hint)go();else close()});
var p=v.play();if(p&&p.catch)p.catch(function(){v.muted=true;var q=v.play();if(q&&q.catch)q.catch(ask)});
}
function scan(){
timer=0;
var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(n){return n.nodeValue.indexOf("\\u2064\\u2063")>=0?NodeFilter.FILTER_ACCEPT:NodeFilter.FILTER_REJECT}});
while(w.nextNode()){
var m=RX.exec(w.currentNode.nodeValue);
if(!m||seen.indexOf(k=m[1].split("").map(function(c){return c.charCodeAt(0).toString(16)}).join(""))>=0)continue;
seen.push(k);try{localStorage.setItem("xitterPirateTokens",JSON.stringify(seen.slice(-50)))}catch(e){}
play(m[1]);break;
}
}
function start(){new MutationObserver(function(){if(!timer)timer=setTimeout(scan,400)}).observe(document.body,{childList:true,subtree:true,characterData:true});scan()}
if(document.body)start();else document.addEventListener("DOMContentLoaded",start);
})();`;
