// THEME_SCRIPT, the in-page boot script, and LINK_SCOPES it interpolates.

import { STEAM_STILL_PATH, STEAM_VIDEO_PATH } from "../steam-items";
import { RELATION_BUTTON } from "../x-selectors";
import { ACCENT_IDS, ACCENTS } from "./presets";
import { NIGHT_MODE_ATTR } from "./validate";

export const LINK_SCOPES = [
	'[data-testid="tweetText"]',
	'[data-testid="UserMention"]',
	'a[href*="/hashtag/"]',
	'[data-testid^="card.layout"]',
] as const;

export const THEME_SCRIPT = String.raw`(function(){
	var X=window.__XITTER__||{};
	var STEAM_STILL=new RegExp(${JSON.stringify(STEAM_STILL_PATH.source)});
	var STEAM_VIDEO=new RegExp(${JSON.stringify(STEAM_VIDEO_PATH.source)});
	var theme=X.theme||null;
	var look=X.look||null;
	var accents=${JSON.stringify(ACCENTS)};
	var accentIds=${JSON.stringify(ACCENT_IDS)};
	var accentWire=X.accent!=null?X.accent:(look&&look.accent!=null?look.accent:null);
	var forcedColor=(look&&look.themeColor)||X.themeColor||"blue500";
	var scopes=${JSON.stringify(LINK_SCOPES)};
	var presets=X.themePresets||[];
	var sheet,fontSheet,accentSheet,at=0,timer,key="",accentKey="";
	var RELATION=${JSON.stringify(RELATION_BUTTON)};
	var POST_IDS='[data-testid="tweetButton"],[data-testid="tweetButtonInline"],[data-testid="SideNav_NewTweet_Button"]';
	var POST_NOT=':not([data-testid="tweetButton"]):not([data-testid="tweetButtonInline"]):not([data-testid="SideNav_NewTweet_Button"])';
	var CHIRP='TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
	var TICK='<svg viewBox="0 0 24 24" aria-hidden="true"><g><path d="M9.64 18.952l-5.55-4.861 1.317-1.504 3.951 3.459 8.459-10.948L19.4 6.32 9.64 18.952z"></path></g></svg>';
	var GOLD={"226, 183, 25":1,"212, 167, 44":1};
	var GREY={"130, 154, 171":1};
	function csrf(){return(document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)||[])[1]||""}
	function hexRgb(h){
		h=String(h||"").replace("#","");
		if(h.length===3)h=h.charAt(0)+h.charAt(0)+h.charAt(1)+h.charAt(1)+h.charAt(2)+h.charAt(2);
		return [parseInt(h.slice(0,2),16),parseInt(h.slice(2,4),16),parseInt(h.slice(4,6),16)];
	}
	function mix(a,b,t){
		return "#"+[0,1,2].map(function(i){var n=Math.round(a[i]+(b[i]-a[i])*t);return (n<16?"0":"")+n.toString(16)}).join("");
	}
	function fill(g){
		if(typeof g==="string")return g;
		return !g||!g.stops||!g.stops.length?"":(g.stops.length===1?g.stops[0]:"linear-gradient("+(g.angle||180)+"deg,"+g.stops.join(",")+")")
	}
	function avgOf(g){
		var stops=typeof g==="string"?[g]:(g&&g.stops?g.stops:["#000"]),acc=[0,0,0];
		stops.forEach(function(s){var c=hexRgb(s);acc[0]+=c[0];acc[1]+=c[1];acc[2]+=c[2]});
		var n=stops.length||1;
		return [acc[0]/n,acc[1]/n,acc[2]/n];
	}
	function hexOf(g){
		var a=avgOf(g);
		return "#"+[0,1,2].map(function(i){var x=Math.round(a[i]);return (x<16?"0":"")+x.toString(16)}).join("");
	}
	function rgba(h,a){var c=hexRgb(h);return "rgba("+c[0]+", "+c[1]+", "+c[2]+", "+a+")"}
	function fontOk(n){return typeof n==="string"&&/^[A-Za-z0-9 ]{1,40}$/.test(n)}
	function slugOf(n){return String(n).toLowerCase().replace(/ /g,"-")}
	function namedHex(id){return accents[id]||"#1d9bf0"}
	function resolveAccent(w){
		if(w==null)return {solid:"#1d9bf0",fill:"#1d9bf0",id:"blue500",custom:false};
		if(typeof w==="string"&&accents[w])return {solid:accents[w],fill:accents[w],id:w,custom:false};
		if(typeof w==="string"){
			var id=null,k;
			for(k in accents)if(accents[k]===w)id=k;
			return {solid:w,fill:w,id:id||"blue500",custom:!id};
		}
		var solid=hexOf(w),fl=fill(w)||solid;
		return {solid:solid,fill:fl,id:"blue500",custom:true};
	}
	var resolved=resolveAccent(accentWire);
	function lockLocal(obj){
		if(!obj||typeof obj!=="object")return obj;
		try{
			Object.defineProperty(obj,"themeColor",{configurable:true,enumerable:true,get:function(){return forcedColor},set:function(){}});
		}catch(e){obj.themeColor=forcedColor}
		return obj;
	}
	function seedThemeColor(){
		try{
			var s=window.__INITIAL_STATE__;
			if(s&&s.settings){
				s.settings._xtLocal=lockLocal(s.settings.local||{});
				try{
					Object.defineProperty(s.settings,"local",{
						configurable:true,
						get:function(){return s.settings._xtLocal},
						set:function(v){s.settings._xtLocal=lockLocal(v||{})}
					});
				}catch(e){s.settings.local=s.settings._xtLocal}
			}
		}catch(e){}
		try{
			var req=indexedDB.open("localforage");
			req.onsuccess=function(){
				var db=req.result;
				if(!db.objectStoreNames.contains("keyvaluepairs"))return;
				var tx=db.transaction("keyvaluepairs","readwrite");
				var store=tx.objectStore("keyvaluepairs");
				var g=store.get("device:rweb.settings");
				g.onsuccess=function(){
					var v=g.result;
					if(!v||typeof v!=="object")v={local:{}};
					if(!v.local||typeof v.local!=="object")v.local={};
					v.local.themeColor=forcedColor;
					store.put(v,"device:rweb.settings");
				};
			};
		}catch(e){}
	}
	function applyAccentVars(){
		var a=resolveAccent(accentWire),h=document.documentElement,hover=mix(hexRgb(a.solid),hexRgb("#0f1419"),0.12);
		// on a decorated profile only the choice is kept, for when the theme comes back
		if(held){resolved=a;forcedColor=a.custom?"blue500":a.id;return}
		h.style.setProperty("--xt-accent",a.solid);
		h.style.setProperty("--xt-accent-fill",a.fill);
		h.style.setProperty("--xt-accent-soft",rgba(a.solid,0.1));
		h.style.setProperty("--xt-accent-hover",hover);
		h.style.setProperty("--xt-accent-tint",mix(hexRgb(a.solid),hexRgb("#ffffff"),0.5));
		h.style.setProperty("--xt-accent-text",(hexRgb(a.solid)[0]*299+hexRgb(a.solid)[1]*587+hexRgb(a.solid)[2]*114)/1000>160?"#0f1419":"#ffffff");
		h.setAttribute("data-xitter-accent",a.custom?"custom":a.id);
		resolved=a;
		forcedColor=a.custom?"blue500":a.id;
	}
	function rgbKey(s){
		var m=/rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(s||"");
		return m?m[1]+", "+m[2]+", "+m[3]:"";
	}
	function keptCheck(svg){
		if(svg.querySelector("linearGradient,stop"))return true;
		var nodes=[svg].concat([].slice.call(svg.querySelectorAll("*"))),i,k,c;
		for(i=0;i<nodes.length;i++){
			c=getComputedStyle(nodes[i]);
			k=rgbKey(c.fill)||rgbKey(c.color);
			if(GOLD[k]||GREY[k])return true;
		}
		return false;
	}
	function accentGradUrl(){
		var a=resolved,id="xitter-accent-grad",ns="http://www.w3.org/2000/svg";
		if(!resolved.custom||resolved.fill.indexOf("gradient")<0)return resolved.solid;
		var g=document.getElementById(id);
		if(!g){
			var svg=document.createElementNS(ns,"svg");
			svg.setAttribute("width","0");svg.setAttribute("height","0");
			svg.style.cssText="position:absolute;width:0;height:0";
			var defs=document.createElementNS(ns,"defs");
			g=document.createElementNS(ns,"linearGradient");
			g.id=id;
			defs.appendChild(g);svg.appendChild(defs);
			document.documentElement.appendChild(svg);
		}
		var w=accentWire,stops=w&&w.stops?w.stops:[resolved.solid],ang=(w&&w.angle)||180,rad=ang*Math.PI/180;
		g.setAttribute("x1",String(0.5-0.5*Math.cos(rad)));
		g.setAttribute("y1",String(0.5-0.5*Math.sin(rad)));
		g.setAttribute("x2",String(0.5+0.5*Math.cos(rad)));
		g.setAttribute("y2",String(0.5+0.5*Math.sin(rad)));
		g.textContent="";
		stops.forEach(function(s,i){
			var st=document.createElementNS(ns,"stop");
			st.setAttribute("offset",stops.length===1?"0%":String(Math.round(i/(stops.length-1)*100))+"%");
			st.setAttribute("stop-color",s);
			g.appendChild(st);
		});
		return "url(#"+id+")";
	}
	function paintChecks(){
		if(held)return;
		var fill=accentGradUrl(),color=resolved.solid;
		document.querySelectorAll('svg[data-testid="icon-verified"]').forEach(function(svg){
			if(svg.closest("[data-xitter-badges],[data-xitter-frame],[data-xitter-framed],.xitter-deco,[data-xitter-decor-bg]"))return;
			if(keptCheck(svg))return;
			svg.setAttribute("data-xitter-tinted","");
			svg.style.setProperty("color",color,"important");
			svg.style.setProperty("fill",fill,"important");
			svg.querySelectorAll("path,g").forEach(function(n){
				var k=rgbKey(getComputedStyle(n).fill);
				if(GOLD[k]||GREY[k])return;
				n.setAttribute("data-xitter-tinted","");
				n.style.setProperty("fill",fill,"important");
			});
		});
	}
	function varsOf(t){
		if(!t)return null;
		var avg=avgOf(t.bg),avgHex=hexOf(t.bg),tr=hexRgb(t.text||"#e7e9ea"),surface=hexOf(t.surface||avgHex),text=t.text,accent=hexOf(t.accent),accentFill=fill(t.accent)||accent;
		var muted=t.muted||mix(tr,hexRgb(avgHex),0.45),border=t.border||mix(tr,hexRgb(avgHex),0.82),link=t.link||accent;
		var reply=t.reply||accent,bookmark=t.bookmark||accent,like=t.like||"#f91880",repost=t.repost||"#00ba7c";
		return {
			"--xt-bg":fill(t.bg),"--xt-surface":fill(t.surface),"--xt-text":text,"--xt-secondary":t.secondary||mix(tr,hexRgb(avgHex),0.28),"--xt-muted":muted,"--xt-link":link,
			"--xt-border":border,"--xt-divider":t.divider||border,"--xt-accent":accent,"--xt-accent-fill":accentFill,"--xt-button":fill(t.button),"--xt-button-text":t.buttonText,
			"--xt-button-hover":t.buttonHover||mix(hexRgb(hexOf(t.button)),tr,0.12),"--xt-header":t.header?fill(t.header):"rgb("+Math.round(avg[0])+" "+Math.round(avg[1])+" "+Math.round(avg[2])+" / .85)",
			"--xt-hover":t.hover||("rgb("+tr[0]+" "+tr[1]+" "+tr[2]+" / .1)"),"--xt-input":t.inputBg||mix(hexRgb(surface),tr,0.08),"--xt-input-text":t.inputText||text,"--xt-input-border":t.inputBorder||border,
			"--xt-menu":t.menu?fill(t.menu):fill(t.surface),"--xt-tooltip":t.tooltip||mix(hexRgb(surface),tr,0.16),"--xt-icon":t.icon||muted,"--xt-icon-active":t.iconActive||text,
			"--xt-reply":reply,"--xt-repost":repost,"--xt-like":like,"--xt-bookmark":bookmark,"--xt-views":t.views||muted,
			"--xt-secondary-button":t.secondaryButton?fill(t.secondaryButton):"transparent","--xt-secondary-button-border":t.secondaryButtonBorder||border,"--xt-secondary-button-text":t.secondaryButtonText||text,
			"--xt-badge":t.badge||accent,"--xt-selection":t.selection||rgba(accent,0.28),"--xt-accent-soft":rgba(accent,0.1),"--xt-reply-soft":rgba(reply,0.1),"--xt-repost-soft":rgba(repost,0.1),"--xt-like-soft":rgba(like,0.1),"--xt-bookmark-soft":rgba(bookmark,0.1)
		};
	}
	function dropFonts(){document.querySelectorAll("link[data-xitter-font]").forEach(function(n){n.remove()})}
	function addFont(name){
		if(!fontOk(name))return;
		var slug=slugOf(name);
		if(document.querySelector('link[data-xitter-font="'+slug+'"]'))return;
		var l=document.createElement("link");
		l.rel="stylesheet";l.setAttribute("data-xitter-font",slug);l.href="/i/xitter/fonts/"+slug+"/fonts.css";
		document.head.appendChild(l);
	}
	function applyFonts(t){
		if(!fontSheet){fontSheet=document.createElement("style");fontSheet.setAttribute("data-xitter-font-css","");document.head.appendChild(fontSheet)}
		dropFonts();
		if(!t||!t.font){fontSheet.textContent="";return}
		var css="";
		if(fontOk(t.font.ui)){addFont(t.font.ui);css+='html[data-xitter-theme] body,html[data-xitter-theme] .css-146c3p1,html[data-xitter-theme] .css-1jxf684{font-family:"'+t.font.ui+'",'+CHIRP+'!important}'}
		if(fontOk(t.font.display)){addFont(t.font.display);css+='html[data-xitter-theme] [data-testid="User-Name"] span:first-of-type,html[data-xitter-theme] [data-testid="UserName"],html[data-xitter-theme] h1,html[data-xitter-theme] h2{font-family:"'+t.font.display+'",'+CHIRP+'!important}'}
		fontSheet.textContent=css;
	}
	var VAR_KEYS=["--xt-bg","--xt-surface","--xt-text","--xt-secondary","--xt-muted","--xt-link","--xt-border","--xt-divider","--xt-accent","--xt-accent-fill","--xt-button","--xt-button-text","--xt-button-hover","--xt-header","--xt-hover","--xt-input","--xt-input-text","--xt-input-border","--xt-menu","--xt-tooltip","--xt-icon","--xt-icon-active","--xt-reply","--xt-repost","--xt-like","--xt-bookmark","--xt-views","--xt-secondary-button","--xt-secondary-button-border","--xt-secondary-button-text","--xt-badge","--xt-selection","--xt-accent-soft","--xt-reply-soft","--xt-repost-soft","--xt-like-soft","--xt-bookmark-soft"];
	var ACCENT_KEYS={"--xt-accent":1,"--xt-accent-fill":1,"--xt-accent-soft":1,"--xt-accent-hover":1};
	// An organization's decor owns its profile. While the decor script marks the
	// page with data-xitter-decor, the viewer's theme and accent step aside
	// whole: no theme or accent attribute (every rule here and in the boot CSS
	// hangs off one), no --xt-* values, no tinted ticks, no theme video. Leaving
	// the profile, the decor script drops its mark and the theme comes back.
	var held=false;
	function stepAside(){
		var h=document.documentElement;
		held=true;
		h.removeAttribute("data-xitter-theme");
		h.removeAttribute("data-xitter-accent");
		VAR_KEYS.concat(["--xt-accent-hover","--xt-accent-tint","--xt-accent-text"]).forEach(function(k){h.style.removeProperty(k)});
		document.querySelectorAll("[data-xitter-tinted]").forEach(function(n){n.style.removeProperty("color");n.style.removeProperty("fill");n.removeAttribute("data-xitter-tinted")});
		var v=document.body&&document.body.querySelector(":scope > [data-xitter-theme-bg]");
		if(v)v.remove();
	}
	function syncDecor(){
		var on=document.documentElement.hasAttribute("data-xitter-decor");
		if(on&&!held)stepAside();
		else if(!on&&held){
			held=false;
			if(theme)apply(theme);
			else{applyAccentVars();paintAccent()}
		}
	}
	function apply(t){
		theme=t;
		if(held)return;
		var h=document.documentElement;
		if(!t){
			h.removeAttribute("data-xitter-theme");
			VAR_KEYS.forEach(function(k){if(!ACCENT_KEYS[k])h.style.removeProperty(k)});
			if(sheet)sheet.textContent="";
			applyFonts(null);
			writeBase(false);
			syncThemeVideo();
			key="";
			applyAccentVars();
			paintAccent();
			return;
		}
		h.setAttribute("data-xitter-theme",t.id||"custom");
		var v=varsOf(t),k;
		for(k in v)h.style.setProperty(k,v[k]);
		writeBase(bgMatches(t));
		syncThemeVideo();
		applyFonts(t);
		key="";
		applyAccentVars();
		paint();
		paintAccent();
	}
	function setNight(v){
		document.cookie="night_mode="+v+"; ${NIGHT_MODE_ATTR}";
	}
	function nudge(){
		if(!look)return;
		var digit=String(look.night);
		if((document.cookie.match(/(?:^|;\s*)night_mode=(\d)/)||[])[1]===digit)return;
		setNight(digit);
		try{if(sessionStorage.getItem("xitter-theme-nudge"))return;sessionStorage.setItem("xitter-theme-nudge","1")}catch(e){return}
		location.reload();
	}
	function norm(s){
		var m=/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([0-9.]+))?\)$/.exec(s||"");
		if(!m)return "";
		if(m[4]==null||m[4]===""||Number(m[4])===1)return m[1]+", "+m[2]+", "+m[3];
		return m[1]+", "+m[2]+", "+m[3]+", "+m[4];
	}
	function pal(){
		return theme&&theme.base==="light"?{
			bg:{"255, 255, 255":1},
			text:{"15, 20, 25":1},
			secondary:{"55, 67, 77":1},
			muted:{"83, 100, 113":1},
			border:{"239, 243, 244":1,"207, 217, 222":1,"185, 202, 211":1},
			surface:{"247, 249, 249":1},
			menu:{"255, 255, 255":1},
			header:{"255, 255, 255, 0.85":1},
			buttonBg:{"15, 20, 25":1},
			buttonText:{"255, 255, 255":1},
			hover:{"15, 20, 25, 0.1":1},
			input:{"239, 243, 244":1,"247, 249, 249":1},
			tooltip:{"15, 20, 25":1},
			icon:{"83, 100, 113":1},
			iconFill:{"83, 100, 113":1},
			iconActiveFill:{"15, 20, 25":1}
		}:{
			bg:{"0, 0, 0":1},
			text:{"231, 233, 234":1},
			secondary:{"182, 185, 188":1},
			muted:{"113, 118, 123":1,"89, 93, 98":1},
			border:{"47, 51, 54":1,"51, 54, 57":1,"62, 65, 68":1,"75, 78, 82":1},
			surface:{"22, 24, 28":1,"32, 35, 39":1},
			menu:{"32, 35, 39":1,"42, 45, 48":1,"20, 20, 20":1},
			header:{"0, 0, 0, 0.65":1},
			buttonBg:{"239, 243, 244":1},
			buttonText:{"15, 20, 25":1},
			hover:{"231, 233, 234, 0.1":1,"255, 255, 255, 0.03":1},
			input:{"32, 35, 39":1},
			tooltip:{"39, 44, 48, 0.75":1},
			icon:{"113, 118, 123":1,"100, 105, 109":1},
			iconFill:{"100, 105, 109":1,"130, 154, 171":1},
			iconActiveFill:{"231, 233, 234":1}
		};
	}
	var glassOn=false;
	function wrap(sel, pageBg){
		var skip=sel+':not(img):not(svg[data-testid="icon-verified"]):not(svg[aria-label="Translator account"]):not(.xitter-deco):not([data-xitter-badges]):not([data-xitter-frame]):not([data-xitter-framed]):not([data-xitter-decor-bg]):not(:is(svg[data-testid="icon-verified"] *,svg[aria-label="Translator account"] *,[data-xitter-badges] *,[data-xitter-frame],[data-xitter-framed] *,[data-xitter-decor-bg] *,.xitter-deco,[aria-label="Color options"] *))';
		if(glassOn)skip+=':not([data-testid="primaryColumn"]):not(main[role="main"] section[role="region"]:not([data-testid="primaryColumn"] *)):not([data-testid="primaryColumn"] [role="tablist"]:not([data-testid="toolBar"] *)):not([data-testid="primaryColumn"] [style*="position: sticky"]):not(header[role="banner"]>div>div)';
		if(pageBg)return 'html[data-xitter-theme]:not([data-xitter-decor]) '+skip;
		return 'html[data-xitter-theme]:not([data-xitter-decor]) '+skip+',html[data-xitter-theme][data-xitter-decor] '+skip+':not([data-testid="primaryColumn"] *)';
	}
	var trailing=null;
	function paint(){
		if(!theme)return;
		// at most once a second, but the last call is never dropped: X adds its
		// classes with insertRule, which no observer sees, so a page that settles
		// inside the second would otherwise keep its unthemed classes
		if(Date.now()-at<1000){
			if(!trailing)trailing=setTimeout(function(){trailing=null;tick()},1000-(Date.now()-at)+50);
			return;
		}
		at=Date.now();
		var p=pal(),found={pagebg:[],surface:[],text:[],secondary:[],muted:[],border:[],accentColor:[],accentBg:[],accentHover:[],accentSoft:[],accentOutline:[],button:[],buttonText:[],header:[],hover:[],menu:[],input:[],tooltip:[],icon:[],iconFill:[],iconActiveFill:[],repost:[],repostBg:[],like:[],likeBg:[],chirp:[]},posSels=[];
		function note(kind,sel){if(!found[kind])found[kind]=[];if(found[kind].indexOf(sel)<0)found[kind].push(sel)}
		[].forEach.call(document.styleSheets,function(ss){
			var rules;try{rules=ss.cssRules}catch(e){return}
			[].forEach.call(rules||[],function(r){
				if(!r.selectorText||!r.style||!/^\.[\w-]+$/.test(r.selectorText))return;
				var c=norm(r.style.color),bg=norm(r.style.backgroundColor),bd=norm(r.style.borderColor),fl=norm(r.style.fill),ol=norm(r.style.outlineColor),sel=r.selectorText;
				var ff=r.style.fontFamily||"";
				if(r.style.position==="fixed"||r.style.position==="absolute"){if(posSels.indexOf(sel)<0)posSels.push(sel)}
				if(parseFloat(r.style.borderTopLeftRadius)>=12)note("rounded",sel);
				if(ff.indexOf("TwitterChirp")>=0)note("chirp",sel);
				if(p.bg[bg])note("pagebg",sel);
				if(p.surface[bg])note("surface",sel);
				if(p.menu[bg])note("menu",sel);
				if(p.header[bg])note("header",sel);
				if(p.buttonBg[bg])note("button",sel);
				if(p.hover[bg])note("hover",sel);
				if(p.input[bg])note("input",sel);
				if(p.tooltip[bg])note("tooltip",sel);
				if(p.text[c])note("text",sel);
				if(p.secondary[c])note("secondary",sel);
				if(p.muted[c])note("muted",sel);
				if(p.icon[c])note("icon",sel);
				if(p.buttonText[c]&&!p.text[c])note("buttonText",sel);
				if(c==="29, 155, 240"||c==="26, 140, 216")note("accentColor",sel);
				if(bg==="29, 155, 240")note("accentBg",sel);
				if(bg==="26, 140, 216")note("accentHover",sel);
				if(bg==="29, 155, 240, 0.1"||bg==="29, 155, 240, 0.12"||bg==="29, 155, 240, 0.14"||bg==="29, 155, 240, 0.2")note("accentSoft",sel);
				if(c==="0, 186, 124"||fl==="0, 186, 124")note("repost",sel);
				if(bg==="0, 186, 124"||bg==="0, 186, 124, 0.1"||bg==="0, 186, 124, 0.2")note("repostBg",sel);
				if(c==="249, 24, 128"||fl==="249, 24, 128")note("like",sel);
				if(bg==="249, 24, 128"||bg==="249, 24, 128, 0.1"||bg==="249, 24, 128, 0.2")note("likeBg",sel);
				if(p.border[bd])note("border",sel);
				if(fl==="29, 155, 240"||fl==="26, 140, 216")note("accentColor",sel);
				if(ol==="29, 155, 240")note("accentOutline",sel);
				if(p.iconFill[fl])note("iconFill",sel);
				if(p.iconActiveFill[fl])note("iconActiveFill",sel);
			});
		});
		var inline=[
			['text','[style*="color: rgb(231, 233, 234)"]','[style*="color: rgb(15, 20, 25)"]'],
			['muted','[style*="color: rgb(113, 118, 123)"]','[style*="color: rgb(83, 100, 113)"]'],
			['pagebg','[style*="background-color: rgb(0, 0, 0)"]','[style*="background-color: rgb(255, 255, 255)"]'],
			['surface','[style*="background-color: rgb(22, 24, 28)"]','[style*="background-color: rgb(32, 35, 39)"]','[style*="background-color: rgb(247, 249, 249)"]'],
			['button','[style*="background-color: rgb(239, 243, 244)"]','[style*="background-color: rgb(15, 20, 25)"]'],
			['accentColor','[style*="color: rgb(29, 155, 240)"]','[style*="fill: rgb(29, 155, 240)"]','[style*="color: rgb(26, 140, 216)"]'],
			['accentBg','[style*="background-color: rgb(29, 155, 240)"]'],
			['accentHover','[style*="background-color: rgb(26, 140, 216)"]'],
			['accentSoft','[style*="background-color: rgba(29, 155, 240, 0.1)"]','[style*="background-color: rgba(29, 155, 240, 0.12)"]','[style*="background-color: rgba(29, 155, 240, 0.2)"]'],
			['repost','[style*="color: rgb(0, 186, 124)"]'],
			['repostBg','[style*="background-color: rgb(0, 186, 124)"]','[style*="background-color: rgba(0, 186, 124, 0.1)"]'],
			['like','[style*="color: rgb(249, 24, 128)"]'],
			['likeBg','[style*="background-color: rgb(249, 24, 128)"]','[style*="background-color: rgba(249, 24, 128, 0.1)"]']
		];
		var light=theme.base==="light";
		inline.forEach(function(row){
			var kind=row[0];
			row.slice(1).forEach(function(sel){
				if(kind==="text"&&light&&sel.indexOf("15, 20, 25")>=0)note(kind,sel);
				else if(kind==="text"&&!light&&sel.indexOf("231, 233, 234")>=0)note(kind,sel);
				else if(kind==="muted"&&light&&sel.indexOf("83, 100, 113")>=0)note(kind,sel);
				else if(kind==="muted"&&!light&&sel.indexOf("113, 118, 123")>=0)note(kind,sel);
				else if(kind==="pagebg"&&light&&sel.indexOf("255, 255, 255")>=0)note(kind,sel);
				else if(kind==="pagebg"&&!light&&sel.indexOf("0, 0, 0")>=0)note(kind,sel);
				else if(kind==="surface")note(kind,sel);
				else if(kind==="button"&&light&&sel.indexOf("15, 20, 25")>=0)note(kind,sel);
				else if(kind==="button"&&!light&&sel.indexOf("239, 243, 244")>=0)note(kind,sel);
				else if(kind==="accentColor"||kind==="accentBg"||kind==="accentHover"||kind==="accentSoft"||kind==="repost"||kind==="repostBg"||kind==="like"||kind==="likeBg")note(kind,sel);
			});
		});
		var css=[],k;
		function add(kind,decl,pageBg){
			glassOn=!!(theme.background&&typeof X.pageChrome==="string"&&X.pageChrome&&decl.indexOf("background")>=0);
			(found[kind]||[]).forEach(function(sel){css.push(wrap(sel,pageBg)+"{"+decl+"}")});
			glassOn=false;
		}
		add("pagebg","background-color:transparent!important",true);
		if((found.pagebg||[]).length&&posSels.length){
			// Same frost skip as the transparent rule above, so these win on order
			// instead of losing to its longer :not() chain on specificity.
			glassOn=!!(theme.background&&typeof X.pageChrome==="string"&&X.pageChrome);
			// The sidebar's search band is a fixed layer too, but it is a strip of
			// page, not a popover: it stays clear and the pill inside is the glass.
			var layer=":is("+found.pagebg.join(",")+")",band=":not(:has([role=\"search\"]))";
			css.push(wrap(layer+":is("+posSels.join(",")+")"+band) + "{background:var(--xt-menu)!important}");
			css.push(wrap(layer+"[style*=\"position: fixed\"]"+band) + "{background:var(--xt-menu)!important}");
			css.push(wrap(layer+"[style*=\"position: absolute\"]"+band) + "{background:var(--xt-menu)!important}");
			// Inside a dialog the page's black is the dialog's own surface, as in the
			// media viewer's reply panel: made clear, the page behind read through it
			css.push(wrap('[aria-modal="true"] '+layer) + "{background:var(--xt-menu)!important}");
			glassOn=false;
		}
		// Over an image, the glass goes on X's own rounded boxes in the sidebar:
		// each module's card (empty ones too) and the search pill. They are found
		// by their page-background and corner classes, so the tint follows the
		// corners, and the square wrappers inside and around stay clear.
		if(theme.background&&typeof X.pageChrome==="string"&&X.pageChrome&&(found.pagebg||[]).length&&(found.rounded||[]).length){
			glassOn=true;
			var card=wrap('[data-testid="sidebarColumn"] :is('+found.pagebg.join(",")+'):is('+found.rounded.join(",")+')'+(posSels.length?':not(:is('+posSels.join(",")+'))':''),true);
			glassOn=false;
			css.push(card+"{background:color-mix(in srgb,var(--xt-surface) var(--xt-bg-panel),transparent)!important;-webkit-backdrop-filter:blur(14px)!important;backdrop-filter:blur(14px)!important}");
			css.push("@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){"+card+"{background:color-mix(in srgb,var(--xt-surface) 92%,transparent)!important}}");
		}
		// A sidebar module with nothing to show is hidden: one that is only its
		// border, and one whose only content is X's empty-state message ("No
		// items"). It's matched on what the card holds, not when it was seen, so
		// a module that fills in later comes back, and one that empties goes.
		if((found.pagebg||[]).length&&(found.rounded||[]).length){
			var box='[data-testid="sidebarColumn"] :is('+found.pagebg.join(",")+'):is('+found.rounded.join(",")+')';
			css.push(wrap(box+':is(:empty,:has(> [data-testid="emptyState"]):not(:has(> :not([data-testid="emptyState"]))))',true)+"{display:none!important}");
		}
		add("surface","background:var(--xt-surface)!important",false);
		add("menu","background:var(--xt-menu)!important",false);
		add("header","background-color:var(--xt-header)!important",false);
		add("hover","background-color:var(--xt-hover)!important",false);
		add("input","background-color:var(--xt-input)!important",false);
		add("input","color:var(--xt-input-text)!important;border-color:var(--xt-input-border)!important",false);
		add("tooltip","background-color:var(--xt-tooltip)!important",false);
		add("text","color:var(--xt-text)!important",false);
		add("secondary","color:var(--xt-secondary)!important",false);
		add("muted","color:var(--xt-muted)!important",false);
		add("icon","color:var(--xt-icon)!important",false);
		add("iconFill","fill:var(--xt-icon)!important",false);
		add("iconActiveFill","fill:var(--xt-icon-active)!important",false);
		add("border","border-color:var(--xt-border)!important;border-bottom-color:var(--xt-divider)!important",false);
		found.button=(found.button||[]).map(function(sel){return sel+POST_NOT});
		["accentBg","accentHover"].forEach(function(kind){found[kind]=(found[kind]||[]).map(function(sel){return sel+POST_NOT})});
		add("button","background:var(--xt-button)!important",false);
		add("buttonText","color:var(--xt-button-text)!important",false);
		add("accentColor","color:var(--xt-accent)!important;fill:var(--xt-accent)!important",false);
		add("accentOutline","outline-color:var(--xt-accent)!important",false);
		add("accentBg","background:var(--xt-accent-fill,var(--xt-accent))!important",false);
		add("accentHover","background:var(--xt-accent-hover,var(--xt-accent))!important",false);
		add("accentSoft","background-color:var(--xt-accent-soft)!important",false);
		(found.accentColor||[]).forEach(function(sel){
			scopes.forEach(function(scope){
				css.push(wrap(scope+" "+sel)+"{color:var(--xt-link)!important}");
				css.push(wrap(scope+sel)+"{color:var(--xt-link)!important}");
			});
		});
		add("repost","color:var(--xt-repost)!important;fill:var(--xt-repost)!important",false);
		add("repostBg","background-color:var(--xt-repost-soft)!important",false);
		add("like","color:var(--xt-like)!important;fill:var(--xt-like)!important",false);
		add("likeBg","background-color:var(--xt-like-soft)!important",false);
		css.push('html[data-xitter-theme] [data-testid="reply"]:hover,html[data-xitter-theme] [data-testid="reply"]:hover svg{color:var(--xt-reply)!important;fill:var(--xt-reply)!important}');
		css.push('html[data-xitter-theme] [data-testid="reply"]:hover [style*="background-color: rgba(29, 155, 240"]{background-color:var(--xt-reply-soft)!important}');
		css.push('html[data-xitter-theme] [data-testid="retweet"]:hover,html[data-xitter-theme] [data-testid="retweet"]:hover svg{color:var(--xt-repost)!important;fill:var(--xt-repost)!important}');
		css.push('html[data-xitter-theme] [data-testid="like"]:hover,html[data-xitter-theme] [data-testid="like"]:hover svg{color:var(--xt-like)!important;fill:var(--xt-like)!important}');
		css.push('html[data-xitter-theme] [data-testid="bookmark"]:hover,html[data-xitter-theme] [data-testid="bookmark"]:hover svg,html[data-xitter-theme] [aria-label="Share post"]:hover svg{color:var(--xt-bookmark)!important;fill:var(--xt-bookmark)!important}');
		css.push('html[data-xitter-theme] [data-testid="bookmark"]:hover [style*="background-color: rgba(29, 155, 240"],html[data-xitter-theme] [aria-label="Share post"]:hover [style*="background-color: rgba(29, 155, 240"]{background-color:var(--xt-bookmark-soft)!important}');
		css.push('html[data-xitter-theme] [data-testid="retweet"]:hover [style*="background-color: rgba(0, 186, 124"]{background-color:var(--xt-repost-soft)!important}');
		css.push('html[data-xitter-theme] [data-testid="like"]:hover [style*="background-color: rgba(249, 24, 128"]{background-color:var(--xt-like-soft)!important}');
		css.push('html[data-xitter-theme] [data-testid="app-text-transition-container"]{color:var(--xt-views)!important}');
		css.push('html[data-xitter-theme] [data-testid="AppTabBar_Notifications_Link"] div[style*="background"]{background-color:var(--xt-badge)!important}');
		css.push('html[data-xitter-theme] [data-testid="placementTracking"] '+RELATION+',html[data-xitter-theme] a[data-testid="editProfileButton"]{background:var(--xt-secondary-button)!important;border-color:var(--xt-secondary-button-border)!important;color:var(--xt-secondary-button-text)!important}');
		if(theme.font&&fontOk(theme.font.ui)){
			(found.chirp||[]).forEach(function(sel){css.push('html[data-xitter-theme] '+sel+'{font-family:"'+theme.font.ui+'",'+CHIRP+'!important}')});
		}
		var next=css.join("");
		if(next===key)return;
		key=next;
		if(!sheet){sheet=document.createElement("style");sheet.setAttribute("data-xitter-theme-css","");document.head.appendChild(sheet)}
		sheet.textContent=next;
	}
	function wrapAccent(sel){
		return 'html[data-xitter-accent] '+sel+':not(img):not(svg[data-testid="icon-verified"]):not(svg[aria-label="Translator account"]):not(.xitter-deco):not([data-xitter-badges]):not([data-xitter-frame]):not([data-xitter-framed]):not([data-xitter-decor-bg]):not(:is(svg[data-testid="icon-verified"] *,svg[aria-label="Translator account"] *,[data-xitter-badges] *,[data-xitter-frame],[data-xitter-framed] *,[data-xitter-decor-bg] *,.xitter-deco,[aria-label="Color options"] *))';
	}
	function paintAccent(){
		applyAccentVars();
		var css=[];
		function add(sel,decl){css.push(wrapAccent(sel)+"{"+decl+"}")}
		function addPost(sel,decl){css.push(wrapAccent(sel+POST_NOT)+"{"+decl+"}")}
		[].forEach.call(document.styleSheets,function(ss){
			var rules;try{rules=ss.cssRules}catch(e){return}
			[].forEach.call(rules||[],function(r){
				if(!r.selectorText||!r.style||!/^\.[\w-]+$/.test(r.selectorText))return;
				var c=norm(r.style.color),bg=norm(r.style.backgroundColor),fl=norm(r.style.fill),ol=norm(r.style.outlineColor),bd=norm(r.style.borderColor),sel=r.selectorText;
				if(c==="29, 155, 240"||c==="26, 140, 216"||fl==="29, 155, 240"||fl==="26, 140, 216")add(sel,"color:var(--xt-accent)!important;fill:var(--xt-accent)!important");
				if(bg==="29, 155, 240")addPost(sel,"background:var(--xt-accent-fill,var(--xt-accent))!important");
				if(bg==="26, 140, 216")addPost(sel,"background:var(--xt-accent-hover,var(--xt-accent))!important");
				if(bg==="142, 205, 248"||bg==="107, 201, 251")add(sel,"background-color:var(--xt-accent-tint)!important");
				if(/^29, 155, 240, /.test(bg)||/^26, 140, 216, /.test(bg))add(sel,"background-color:color-mix(in srgb,var(--xt-accent) "+Math.round(Number(bg.split(", ")[3])*100)+"%,transparent)!important");
				if(ol==="29, 155, 240"||bd==="29, 155, 240"||ol==="142, 205, 248"||bd==="142, 205, 248")add(sel,"outline-color:var(--xt-accent)!important;border-color:var(--xt-accent)!important");
				if(/29,\s*155,\s*240|26,\s*140,\s*216|142,\s*205,\s*248/.test(r.style.backgroundImage||""))add(sel,"background-image:linear-gradient(90deg,var(--xt-accent),var(--xt-accent-tint))!important");
			});
		});
		add('[style*="color: rgb(29, 155, 240)"]',"color:var(--xt-accent)!important;fill:var(--xt-accent)!important");
		add('[style*="fill: rgb(29, 155, 240)"]',"fill:var(--xt-accent)!important");
		addPost('[style*="background-color: rgb(29, 155, 240)"]',"background:var(--xt-accent-fill,var(--xt-accent))!important");
		addPost('[style*="background-color: rgb(26, 140, 216)"]',"background:var(--xt-accent-hover,var(--xt-accent))!important");
		add('[style*="background-color: rgba(29, 155, 240"]',"background-color:var(--xt-accent-soft)!important");
		add('[style*="border-color: rgb(29, 155, 240)"]',"border-color:var(--xt-accent)!important");
		add('[style*="border-color: rgb(26, 140, 216)"]',"border-color:var(--xt-accent-hover,var(--xt-accent))!important");
		add('[style*="background-color: rgb(142, 205, 248)"]',"background-color:var(--xt-accent-tint)!important");
		var POST=POST_IDS.split(",");
		var postFill,postText,postHover;
		if(theme){
			var customPost=theme.id==="custom";
			postFill=customPost?"var(--xt-button,var(--xt-accent-fill,var(--xt-accent)))":"var(--xt-accent-fill,var(--xt-accent))";
			postText=customPost?"var(--xt-button-text,var(--xt-accent-text,#fff))":"var(--xt-accent-text,#fff)";
			postHover=customPost?"var(--xt-button-hover,var(--xt-accent-hover))":"var(--xt-accent-hover,var(--xt-accent))";
			css.push(POST.map(function(s){return "html[data-xitter-theme] "+s}).join(",")+"{background:"+postFill+"!important;border-color:transparent!important}");
			css.push(POST.map(function(s){return "html[data-xitter-theme] "+s+" div,html[data-xitter-theme] "+s+" span,html[data-xitter-theme] "+s+" svg"}).join(",")+"{color:"+postText+"!important}");
			css.push(POST.map(function(s){return "html[data-xitter-theme] "+s+":hover"}).join(",")+"{background:"+postHover+"!important}");
		}else{
			var lightNative=(look&&look.night)==="0";
			postFill=lightNative?"#0f1419":"#eff3f4";
			postText=lightNative?"#ffffff":"#0f1419";
			postHover=lightNative?"#272c30":"#d7dbdc";
			css.push(POST.map(function(s){return "html[data-xitter-accent] "+s}).join(",")+"{background:"+postFill+"!important;border-color:transparent!important}");
			css.push(POST.map(function(s){return "html[data-xitter-accent] "+s+" div,html[data-xitter-accent] "+s+" span,html[data-xitter-accent] "+s+" svg"}).join(",")+"{color:"+postText+"!important}");
			css.push(POST.map(function(s){return "html[data-xitter-accent] "+s+":hover"}).join(",")+"{background:"+postHover+"!important}");
		}
		var next=css.join("");
		if(next!==accentKey){
			accentKey=next;
			if(!accentSheet){accentSheet=document.createElement("style");accentSheet.setAttribute("data-xitter-accent-css","");document.head.appendChild(accentSheet)}
			accentSheet.textContent=next;
		}
		paintChecks();
	}
	function post(body,then){
		fetch("/i/api/xitter/theme",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrf()},body:JSON.stringify(body)})
			.then(function(r){return r.json().then(function(d){return {ok:r.ok,d:d}})})
			.then(function(x){if(then)then(x.ok,x.d)},function(){});
	}
	function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text)e.textContent=text;return e}
	function chipBg(g){return g&&g.stops?fill(g):"#15202b"}
	var wired=false,picking=false;
	function circle(card){var r=card.querySelector('[role="radio"]');return r&&r.firstElementChild}
	function unselectCard(card){
		card.style.borderColor="rgb(51, 54, 57)";
		card.style.borderWidth="1px";
		var d=circle(card);
		if(d){d.style.backgroundColor="rgba(0, 0, 0, 0)";d.style.borderColor="rgb(185, 202, 211)";d.innerHTML=""}
		var i=card.querySelector("input");if(i)i.checked=false;
	}
	function selectCard(card){
		var acc=resolved.solid||"#1d9bf0";
		card.style.borderColor=acc;
		card.style.borderWidth="2px";
		var d=circle(card);
		if(d){d.style.backgroundColor=acc;d.style.borderColor=acc;if(!d.querySelector("svg"))d.innerHTML=TICK}
		var i=card.querySelector("input");if(i)i.checked=true;
	}
	function mark(){
		var dim=document.querySelector("[data-xitter-dim]");
		document.querySelectorAll("[data-xitter-native]").forEach(function(c){
			if(theme)unselectCard(c);
			else{
				var i=c.querySelector("input");
				if(i&&i.checked)selectCard(c);
			}
		});
		if(dim){
			if(theme&&theme.id==="dim")selectCard(dim);
			else if(theme)unselectCard(dim);
			else{
				var i=dim.querySelector("input");
				if(i&&i.checked)selectCard(dim);
			}
			dim.setAttribute("data-on",theme&&theme.id==="dim"?"1":"0");
		}
		document.querySelectorAll("[data-xitter-swatch]").forEach(function(c){
			var on=theme&&theme.id===c.getAttribute("data-xitter-swatch");
			c.setAttribute("data-on",on?"1":"0");
			c.style.borderColor=on?(resolved.solid||"#1d9bf0"):"transparent";
		});
	}
	function markColors(group){
		var a=resolveAccent(accentWire),on=a.custom?"custom":a.id;
		group.setAttribute("data-custom",a.custom?"1":"0");
		group.querySelectorAll("[data-xitter-color]").forEach(function(card){
			var id=card.getAttribute("data-xitter-color");
			var sel=id===on;
			var radio=card.querySelector("input[type=radio]");
			if(radio)radio.checked=!!sel;
			card.querySelectorAll("svg").forEach(function(s){
				if(s.querySelector("circle")&&!s.querySelector("path")){
					if(id==="custom")s.style.display="none";
					return;
				}
				if(id!=="custom")s.style.display=sel?"":"none";
			});
			if(id==="custom"){
				var host=card.querySelector('[role="radio"]')||card;
				var tick=card.querySelector("[data-xitter-tick]");
				if(sel){
					if(!tick){
						tick=document.createElement("div");
						tick.setAttribute("data-xitter-tick","");
						tick.innerHTML=TICK;
						tick.style.cssText="position:absolute;inset:0;display:grid;place-items:center;pointer-events:none";
						var svg=tick.querySelector("svg");
						if(svg)svg.style.cssText="width:25px;height:25px;fill:#fff";
						host.style.position="relative";
						host.appendChild(tick);
					}
				}else if(tick)tick.remove();
			}
		});
	}
	function openCustom(group){
		var inp=document.getElementById("xitter-accent-pick");
		if(!inp){
			inp=document.createElement("input");
			inp.type="color";inp.id="xitter-accent-pick";
			inp.style.cssText="position:fixed;left:-99px;width:1px;height:1px;opacity:0";
			document.body.appendChild(inp);
			inp.addEventListener("input",function(){
				if(!inp.value)return;
				forcedColor="blue500";
				accentWire=inp.value;
				applyAccentVars();
				paintAccent();
				markColors(group);
			});
			inp.addEventListener("change",function(){
				post({accent:inp.value},function(ok,d){
					if(ok&&d&&d.accent!=null)accentWire=d.accent;
					if(ok&&d&&d.theme)theme=d.theme;
					applyAccentVars();
					paintAccent();
					markColors(group);
				});
			});
		}
		var a=resolveAccent(accentWire);
		inp.value=/^#[0-9a-f]{6}$/i.test(a.solid)?a.solid:"#ff3d7f";
		inp.click();
	}
	function colors(){
		if(location.pathname.indexOf("/settings/display")!==0)return;
		var group=document.querySelector('[role="radiogroup"][aria-label="Color options"]');
		if(!group)return;
		var kids=[].filter.call(group.children,function(n){return n.getAttribute("data-xitter-color")!=="custom"&&n.querySelector('[role="radio"],input[type="radio"]')});
		kids.forEach(function(card,i){
			var id=accentIds[i];
			if(!id)return;
			if(card.getAttribute("data-xitter-wired"))return;
			card.setAttribute("data-xitter-wired","1");
			card.setAttribute("data-xitter-color",id);
			card.addEventListener("click",function(){
				if(picking)return;
				forcedColor=id;
				accentWire=id;
				post({accent:id},function(ok,d){
					if(ok&&d&&d.accent!=null)accentWire=d.accent;
					if(ok&&d&&d.theme)theme=d.theme;
					applyAccentVars();
					paintAccent();
					markColors(group);
				});
			},true);
		});
		if(!group.querySelector('[data-xitter-color="custom"]')){
			var last=kids[kids.length-1]||group.lastElementChild;
			if(last){
				var custom=last.cloneNode(true);
				custom.removeAttribute("data-xitter-wired");
				custom.setAttribute("data-xitter-color","custom");
				var lab=custom.querySelector("input");
				if(lab){lab.setAttribute("aria-label","Custom");lab.checked=false;lab.name="xitter-accent-custom"}
				var vis=custom.querySelector('[role="radio"]')||custom.firstElementChild;
				if(vis){
					vis.style.background="conic-gradient(#ff3d7f,#ffd400,#00ba7c,#1d9bf0,#7856ff,#f91880,#ff3d7f)";
					vis.style.borderRadius="9999px";
					vis.style.backgroundImage="conic-gradient(#ff3d7f,#ffd400,#00ba7c,#1d9bf0,#7856ff,#f91880,#ff3d7f)";
				}
				var disc=custom.querySelector("svg");
				if(disc)disc.style.display="none";
				custom.addEventListener("click",function(e){
					e.preventDefault();e.stopPropagation();
					if(picking)return;
					picking=true;
					var blue=group.querySelector('[data-xitter-color="blue500"]');
					try{if(blue)blue.click()}catch(err){}
					picking=false;
					forcedColor="blue500";
					openCustom(group);
				},true);
				group.appendChild(custom);
			}
		}
		markColors(group);
	}
	function display(){
		if(location.pathname.indexOf("/settings/display")!==0)return;
		colors();
		if(document.querySelector("[data-xitter-dim]")){mark();return}
		var group=document.querySelector('[role="radiogroup"][aria-label="Background options"]');
		if(!group)return;
		var defCard,lightsCard,i;
		for(i=0;i<group.children.length;i++){
			var card=group.children[i],lab=card.querySelector("span"),tx=lab&&lab.textContent;
			if(tx==="Default")defCard=card;
			if(tx==="Lights out")lightsCard=card;
		}
		if(!defCard||!lightsCard)return;
		defCard.setAttribute("data-xitter-native","default");
		lightsCard.setAttribute("data-xitter-native","lights");
		var dim=lightsCard.cloneNode(true);
		dim.setAttribute("data-xitter-dim","");
		dim.removeAttribute("data-xitter-native");
		dim.querySelectorAll("span").forEach(function(s){if(!s.childElementCount&&s.textContent==="Lights out")s.textContent="Dim"});
		dim.style.backgroundColor="#15202B";
		var inp=dim.querySelector("input");
		if(inp){inp.removeAttribute("name");inp.setAttribute("aria-label","Dim");inp.checked=false}
		unselectCard(dim);
		group.insertBefore(dim,lightsCard);
		function onMode(mode){
			return function(){
				if(picking)return;
				post({mode:mode},function(){apply(null);mark()});
			};
		}
		defCard.addEventListener("click",onMode("light"),true);
		lightsCard.addEventListener("click",onMode("dark"),true);
		dim.addEventListener("click",function(e){
			e.preventDefault();e.stopPropagation();
			picking=true;
			var lightsInp=lightsCard.querySelector("input");
			try{(lightsInp||lightsCard).click()}catch(err){}
			picking=false;
			post({theme:{id:"dim"}},function(ok,d){
				if(ok&&d&&d.theme)apply(d.theme);else apply({id:"dim",base:"dark",bg:{stops:["#15202b"],angle:180},surface:"#1e2732",text:"#f7f9f9",accent:"#1d9bf0",button:{stops:["#eff3f4"],angle:180},buttonText:"#0f1419",muted:"#8b98a5",border:"#38444d"});
				mark();
			});
		},true);
		var face=CHIRP, muted="rgb(113, 118, 123)", accent=resolved.solid||"#1d9bf0";
		var sample=defCard.querySelector("span")||defCard;
		var fam=getComputedStyle(sample).fontFamily;
		if(fam&&!/^\s*(serif|Times|Times New Roman)\s*$/i.test(fam))face=fam;
		var rootAcc=getComputedStyle(document.documentElement).getPropertyValue("--xt-accent").trim();
		if(rootAcc)accent=rootAcc;
		else{
			var ring=getComputedStyle(dim).borderColor;
			if(ring&&ring!=="rgb(51, 54, 57)"&&ring!=="rgba(0, 0, 0, 0)")accent=ring;
		}
		var n,spans=document.querySelectorAll("span");
		for(n=0;n<spans.length;n++){
			if(/Manage your font size/.test(spans[n].textContent||"")){muted=getComputedStyle(spans[n]).color;break}
		}
		var bar=el("div");
		bar.setAttribute("data-xitter-themes","");
		bar.style.cssText="display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:12px 16px;box-sizing:border-box;width:100%;font-family:"+face+";font-size:15px;line-height:20px";
		var lab=el("span","","Custom themes");
		lab.style.cssText="font-family:inherit;font-size:15px;line-height:20px;color:"+muted+";margin:0";
		bar.appendChild(lab);
		presets.forEach(function(p){
			var b=el("button");
			b.type="button";
			b.title=p.name||p.id;
			b.setAttribute("data-xitter-swatch",p.id);
			b.setAttribute("aria-label",p.name||p.id);
			b.style.cssText="width:30px;height:30px;min-width:30px;min-height:30px;border-radius:9999px;border:2px solid transparent;padding:0;margin:0;cursor:pointer;background:"+chipBg(p.bg)+";flex:none;font-family:inherit;appearance:none;-webkit-appearance:none";
			b.addEventListener("click",function(){
				post({theme:{id:p.id}},function(){location.reload()});
			});
			bar.appendChild(b);
		});
		var a=el("a","","Customize…");
		a.href="/account/theme";
		a.style.cssText="font-family:inherit;font-size:15px;line-height:20px;color:"+accent+";text-decoration:none;margin:0";
		a.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();if(window.__xitterGo)window.__xitterGo("/account/theme");else location.assign("/account/theme")},true);
		bar.appendChild(a);
		var host=group.parentElement;
		if(host&&host.parentNode)host.parentNode.insertBefore(bar,host.nextSibling);
		if(!wired){
			wired=true;
			var st=document.createElement("style");
			st.textContent='[data-xitter-themes] a{text-decoration:none}[data-xitter-themes] a:hover{text-decoration:underline}[data-xitter-swatch][data-on="1"]{border-color:var(--xt-accent,'+accent+')!important}';
			document.head.appendChild(st);
		}
		mark();
	}
	var base=document.createElement("style");
	base.setAttribute("data-xitter-theme-base","");
	function writeBase(on){
		base.textContent='html[data-xitter-theme] ::selection{background:var(--xt-selection)}'+
			'html[data-xitter-theme]:not([data-xitter-decor]),html[data-xitter-theme]:not([data-xitter-decor]) body{background:var(--xt-bg)!important;background-attachment:fixed!important}'+
			'html[data-xitter-theme]:not([data-xitter-decor]) #react-root>div>div,html[data-xitter-theme]:not([data-xitter-decor]) #react-root>div>div>div:not([data-testid]){background-color:transparent!important}'+
			(on&&typeof X.pageChrome==="string"?X.pageChrome:"html[data-xitter-theme]{--xt-bg-image:none;--xt-bg-still:none}");
	}
	writeBase(!!(theme&&theme.background));
	document.head.appendChild(base);
	var videoCss=document.createElement("style");
	videoCss.setAttribute("data-xitter-theme-video","");
	videoCss.textContent='[data-xitter-theme-bg]{position:fixed;inset:0;z-index:-1;overflow:hidden;pointer-events:none}#preview [data-xitter-theme-bg]{position:absolute}[data-xitter-theme-bg] video{position:absolute;inset:0;width:100%;height:100%}';
	document.head.appendChild(videoCss);
	seedThemeColor();
	applyAccentVars();
	if(theme)apply(theme);
	else paintAccent();
	nudge();
	function sourceKey(b){
		if(!b)return "";
		if(b.mediaId)return "u:"+b.mediaId;
		if(b.steam&&b.steam.defid)return "s:"+String(b.steam.defid);
		return "";
	}
	function bgMatches(t){
		var a=sourceKey(t&&t.background),b=sourceKey(X.theme&&X.theme.background);
		return !!(a&&a===b);
	}
	function mountThemeVideo(host,motion,knobs){
		if(!host)return;
		var old=host.querySelector(":scope > [data-xitter-theme-bg]");
		if(document.documentElement.hasAttribute("data-xitter-decor")||!motion||(!motion.movie&&!motion.mp4)||matchMedia("(prefers-reduced-motion: reduce)").matches||(knobs&&knobs.fit==="tile")){
			if(old)old.remove();
			return;
		}
		var movie=typeof motion.movie==="string"&&STEAM_VIDEO.test(motion.movie)?motion.movie:"";
		var mp4=typeof motion.mp4==="string"&&STEAM_VIDEO.test(motion.mp4)?motion.mp4:"";
		if(!movie&&!mp4){if(old)old.remove();return}
		var key=movie+"|"+mp4;
		var v=old&&old.getAttribute("data-key")===key?old.querySelector("video"):null;
		if(!v){
			if(old)old.remove();
			var div=document.createElement("div");
			div.setAttribute("data-xitter-theme-bg","");
			div.setAttribute("data-key",key);
			v=document.createElement("video");
			v.muted=true;v.loop=true;v.autoplay=true;v.playsInline=true;v.setAttribute("playsinline","");
			var poster=typeof motion.image==="string"&&STEAM_STILL.test(motion.image)?motion.image:"";
			if(poster)v.poster=poster;
			if(movie){var s1=document.createElement("source");s1.src=movie;s1.type="video/webm";v.appendChild(s1)}
			if(mp4){var s2=document.createElement("source");s2.src=mp4;s2.type="video/mp4";v.appendChild(s2)}
			div.appendChild(v);
			host.prepend(div);
			old=div;
		}
		var fit=knobs&&knobs.fit==="contain"?"contain":"cover";
		var pos=knobs&&(knobs.position==="top"||knobs.position==="bottom")?knobs.position:"center";
		var scale=knobs&&typeof knobs.scale==="number"?knobs.scale:100;
		var blur=knobs&&typeof knobs.blur==="number"?knobs.blur:0;
		v.style.objectFit=fit;
		v.style.objectPosition=pos;
		v.style.width=scale===100?"100%":scale+"%";
		v.style.height=scale===100?"100%":scale+"%";
		v.style.filter=blur?"blur("+blur+"px)":"";
	}
	function syncThemeVideo(){
		if(!document.body)return;
		var motion=X.steamMotion;
		var b=!held&&theme&&theme.background;
		var same=bgMatches(theme)&&motion&&b&&b.steam&&String(motion.defid)===String(b.steam.defid);
		if(!same){
			var gone=document.body.querySelector(":scope > [data-xitter-theme-bg]");
			if(gone)gone.remove();
			return;
		}
		var poster="";
		var chrome=typeof X.pageChrome==="string"?X.pageChrome:"";
		var found=/--xt-bg-image:url\("([^"]+)"\)/.exec(chrome);
		if(found&&STEAM_STILL.test(found[1]))poster=found[1];
		mountThemeVideo(document.body,{defid:motion.defid,movie:motion.movie,mp4:motion.mp4,image:poster},b);
	}
	function tick(){syncDecor();if(theme)paint();paintAccent();display();syncThemeVideo()}
	tick();
	new MutationObserver(function(){if(!timer)timer=setTimeout(function(){timer=null;tick()},150)}).observe(document.documentElement,{childList:true,subtree:true});
	new MutationObserver(syncDecor).observe(document.documentElement,{attributes:true,attributeFilter:["data-xitter-decor"]});
	// and the rules X adds later, with no change to the page, are counted
	var ruleCount=0;
	setInterval(function(){
		if(document.hidden)return;
		var n=0;
		[].forEach.call(document.styleSheets,function(ss){try{n+=ss.cssRules.length}catch(e){}});
		if(n!==ruleCount){ruleCount=n;if(!timer)timer=setTimeout(function(){timer=null;tick()},150)}
	},1500);
})();`;
