// Rewrites the host names baked into the client so it talks to this instance.
// Applied when a file is served; the archive keeps the original bytes.

import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "./config";
import { vapidPublicKey } from "./push";
import { settings } from "./settings";
import { patchCountryAudience } from "./reply-control-client";
import { patchCircleComposer } from "./circles";

// X's VAPID public key, which the client subscribes to push with; pushes can
// only be signed with the private half, so the instance's own goes in its place
const X_VAPID = "new Uint8Array([4,94,104,18,141,49,13,74,96,202,82,131,78,91,29,242,150,102,197,0,53,149,230,8,54,38,62,173,43,28,89,130,191,222,213,128,147,62,21,49,187,95,212,194,196,253,140,157,234,34,8,234,143,158,221,15,83,8,222,111,100,204,213,48,75])";

// API hosts the client knows; their paths are served from our root
// Both brand families: the client rewrites "twitter.com" into the current brand
// domain at runtime, which would turn an unpatched api.twitter.com into api.<our host>.
const API_HOSTS = ["api", "upload", "caps", "jf"].flatMap((s) => [`${s}.x.com`, `${s}.twitter.com`]);

// an address as it appears inside a regular expression literal: /https:\/\/a\.b/
const inRegex = (url: string) => url.replace(/[/.]/g, (c) => "\\" + c);

const RULES: [RegExp, string][] = [
	// The Settings search index is built from X's route list: add our custom GIF
	// provider page so searching "gif" can open it from the results.
	[/\blet (\w+)=\(0,[\w$]+\.[\w$]+\)\(\),(\w+)=\[\];(?=for\(let \w+ of \1\)for\(let \w+ of\(\2\.push\()/g, '$&$1.find(group=>group.path==="/settings/account")?.items.push({id:"xitterGifProvider",path:"/settings/xitter/gifs",title:"GIF provider",synonyms:["gif","provider","klipy","tenor","giphy"],isSearchable:true,items:[]});$1.find(group=>group.path==="/settings/account")?.items.push({id:"xitterPostDetails",path:"/settings/xitter/post-details",title:"Post details",synonyms:["post","details","classic","counts","likes","reposts","quotes","twitter"],isSearchable:true,items:[]},{id:"xitterEquicoins",path:"/settings/xitter/merchant",title:"Equicoins",synonyms:["equicoins","money","merchant","payments","purchases"],isSearchable:true,items:[]});'],
	// Settings > Xitter settings: an entry of the client's own in the Settings
	// list, above Additional resources. Its pane is our index (tidy.ts frames
	// /settings/xitter), and it stays lit on our pages under /settings/xitter/.
	[/(\(0,([\w$]+)\.jsx\)\(([\w$]+)\.A,\{label:[\w$]+,link:"\/settings\/about",testID:[\w$]+\}\))/g, '(0,$2.jsx)($3.A,{label:"Xitter settings",link:"/settings/xitter",xitterMatch:"/settings/xitter/:page*",testID:"xitterSettingsLink"}),$1'],
	// the list's entries light up on an exact match of their link only
	[/(\(0,[\w$]+\.jsx\)\([\w$]+\.A,\{exact:!0,path:)([\w$]+)\.link,children:/g, '$1$2.xitterMatch||$2.link,children:'],
	[/(Co:\{id:"co",Icon:([\w$]+)\.default,IconSelected:([\w$]+)\.default,label:[^,]+,description:[^,]+,source:"remote",type:"navigate",order:60\})(?!,Country:\{)/g, '$1,Country:{id:"country",Icon:$2.default,IconSelected:$3.default,label:"Country",description:"Only accounts from selected countries can reply",source:"remote",type:"navigate",order:70}'],
	[/"co"===([\w$]+)\.conversation_control\?\{mode:"CountryOfOrigin",allowed_country_codes:\1\.conversation_control_region_codes\?\?\[\]\}/g, '"country"===$1.conversation_control?{mode:"Country",allowed_country_codes:$1.conversation_control_region_codes??[]}:"co"===$1.conversation_control?{mode:"CountryOfOrigin",allowed_country_codes:$1.conversation_control_region_codes??[]}'],
	[/"co"===([\w$]+)&&\(([\w$]+)="CountryOfOrigin"\)/g, '("country"===$1?$2="Country":"co"===$1&&($2="CountryOfOrigin"))'],
	[/allowed_country_codes:"co"===([\w$]+)\?([\w$]+):void 0/g, 'allowed_country_codes:["co","country"].includes($1)?$2:void 0'],
	[/conversation_control_details:"co"===([\w$]+)\.meta\.policy\?\{mode:"CountryOfOrigin",allowed_country_codes:\1\.meta\.regionCodes\}/g, 'conversation_control_details:["co","country"].includes($1.meta.policy)?{mode:$1.meta.policy==="country"?"Country":"CountryOfOrigin",allowed_country_codes:$1.meta.regionCodes}'],
	[/case"Co":return"co";/g, 'case"Co":return"co";case"Country":return"country";'],
	[/\["co","CountryOfOrigin"\](?=\])/g, '["co","CountryOfOrigin"],["country","Country"]'],
	[/(?<![\w$.])([\w$]+)\.includes\("CountryOfOrigin"\)(?!\|\|\1\.includes\("Country"\))/g, '($1.includes("CountryOfOrigin")||$1.includes("Country"))'],
	[/(restID:\w+\.rest_id,tweetCreateRequest:)(\w+)(,userMentions:\w+\}\))/g, '$1($2?.xitter_conversation_card&&!$2.status?{...$2,status:window.__XITTER_CONVERSATION_DRAFT_LABEL__?.($2.xitter_conversation_card)||"Conversation card"}:$2)$3'],
	[/(\w+)=(\w+)\.status\|\|"",(\w+)="Failed"===/g, '$1=$2.status||($2.xitter_conversation_card&&window.__XITTER_CONVERSATION_DRAFT_LABEL__?.($2.xitter_conversation_card))||"",$3="Failed"==='],
	[/(_handleClick=(\w+)=>\(\)=>\{)(let \w+=\2\.scheduling_info&&\2\.scheduling_info\.execute_at;if\(!this\.isDraftsTab)/g, '$1document.dispatchEvent(new CustomEvent("xitter:restore-conversation-cards",{detail:$2.tweet_create_request}));$3'],
	[/(_areComposersEmptyOrUnchanged=\(\)=>\{)/g, '$1if(!this.props.isInline&&window.__XITTER_CONVERSATION_HAS_DRAFT__?.())return!1;'],
	// Settings > Post details, classic (classic-detail.ts): a post's engagements
	// screen shows its Likes tab, and who liked it, to everyone and not only to
	// the post's author. isOwnPost itself stays, for what only the author gets.
	[/([\w$]+)&&([\w$]+)\.push\(([\w$]+)\("likes"\)\)/g, '($1||window.__XITTER__?.classicDetail)&&$2.push($3("likes"))'],
	[/"likes"!==([\w$]+)\|\|([\w$]+)\?"quotes"===/g, '"likes"!==$1||$2||window.__XITTER__?.classicDetail?"quotes"==='],
	// the pinned build's shape of the same check: its Likes tab sends anyone but the author back to the post
	[/if\("likes"===([\w$]+)&&!([\w$]+)\)return/g, 'if("likes"===$1&&!$2&&!window.__XITTER__?.classicDetail)return'],
	// Chat is a separate app (module federation): its manifest comes from
	// chat.x.com, its files from abs.twimg.com, and both are checked by pattern
	[/https:\/\/chat\.x\.com\/embed-v1\.json/g, `${PUBLIC_ORIGIN}/xchat/embed-v1.json`],
	[new RegExp(String.raw`https:\\\/\\\/chat(\(-staging\)\?)?\\\.x\\\.com\\\/embed-v1\\\.json`, "g"), inRegex(`${PUBLIC_ORIGIN}/xchat/embed-v1.json`)],
	// the main client's check of the chat build's address (only that one: other
	// patterns of the CDN's address decide where auth headers go)
	[new RegExp(String.raw`https:\\\/\\\/abs\\\.twimg\\\.com\\\/x-web\\\/xchat`, "g"), inRegex(`${PUBLIC_ORIGIN}/abs/x-web/xchat`)],
	[/https:\/\/abs\.twimg\.com/g, `${PUBLIC_ORIGIN}/abs`],
	...API_HOSTS.map((h): [RegExp, string] => [new RegExp(`https://${h.replace(/\./g, "\\.")}`, "g"), PUBLIC_ORIGIN]),
	...API_HOSTS.map((h): [RegExp, string] => [new RegExp(`"${h.replace(/\./g, "\\.")}"`, "g"), `"${PUBLIC_HOSTNAME}"`]),
	// the chat app's socket
	[/wss:\/\/chat-ws\.x\.com\/ws/g, `${PUBLIC_ORIGIN.replace(/^http/, "ws")}/xchat/ws`],
	// the key backup realms it trusts ("pinned realms"): ours instead of X's first
	[/https:\/\/realm-a\.x\.com\//g, `${PUBLIC_ORIGIN}/juicebox/`],
	// the site's own links, also when the address is the start of a longer string
	// or template (profile hrefs, share links); subdomains are not matched
	[/https:\/\/x\.com(?=["'`$/?#])/g, PUBLIC_ORIGIN],
	// The profile editor leaves GIFs out of its avatar and banner pickers even
	// though the upload API and the crop patch below support animated GIFs.
	[/(location:\w+\.rz\.(?:Avatar|ProfileBanner),mediaItem:)/g, "acceptGifs:!0,$1"],
	// ...and its "Edit media" cropper takes only isImage files, which a GIF
	// isn't (it is isGif), so it got nothing and spun forever
	[/(_getMedia=\(\)=>\{let\{media:(\w+)\}=this\.props;return \2&&\2\.mediaFile&&)\2\.mediaFile\.isImage\?/g, "$1($2.mediaFile.isImage||$2.mediaFile.isGif)?"],
	// the upload host is assembled from a variable, which would force https and drop the port
	[/`https:\/\/\$\{(\w+)\}\/i\/media\//g, "`${location.origin}/i/media/"],
	[/"x\.com"/g, `"${PUBLIC_HOSTNAME}"`],
	// cookie domain; a cookie scoped to the original domain is dropped by the browser
	[/"\.x\.com"/g, `"${PUBLIC_HOSTNAME}"`],
	[new RegExp(X_VAPID.replace(/[()[\]]/g, (c) => `\\${c}`), "g"), `new Uint8Array([${[...vapidPublicKey].join(",")}])`],
	// The image resizer crops by drawing one frame on a canvas, so it refuses a
	// GIF that needs a crop (any non-square avatar). Instead it sends the whole
	// GIF with the crop box after the GIF trailer, where decoders don't look;
	// media.ts crops every frame. A GIF over the size or dimension limits is
	// still refused.
	[
		/(\{cropData:\w+,maxDimension:(\w+)=\w+,maxFileSize:(\w+)=\w+,targetQuality:\w+=\w+\}=\w+\|\|\{\},(\w+)=\w+\((\w+),\w+\);[^{}]*?)if\(\5\.isGif\)(return Promise\.reject\(new [\w.]+\("Gifs cannot be processed\.",\w+\.GIF_IS_TOO_LARGE\)\);)/g,
		'$1if($5.isGif){if($5.size>$3||$5.width>$2||$5.height>$2)$6return Promise.resolve(new File([$5.fileHandle,"xitter-crop:"+[$4.left,$4.top,$4.width,$4.height].map(Math.round)],"image.gif",{type:"image/gif"}))}',
	],
	// Downloading a video is for Premium subscribers, and nothing is paid for
	// here: both the share menu's item and the media viewer's button download
	// for everyone instead of opening the "Download videos with Plus" sheet
	[/(\w+)=\w+\.isAnyPremiumSubscriber\(\)(,\w+=\w+\.useMemo\(\(\)=>\1\?\{downloadLink:)/g, "$1=!0$2"],
	[/(\w+)=\w+\.isAnyPremiumSubscriber\(\);(if\(this\._scribeAction\("download"\))/g, "$1=!0;$2"],
	[/(\w+)=\w+\.isAnyPremiumSubscriber,(\(\(\{handleDownloadVideo:)/g, "$1=!0,$2"],
	// the router's profile addresses: staff can give a handle any characters up
	// to 50 (invites.ts STAFF_HANDLE), which the address carries percent-encoded
	// (the 2020 client's is {1,20}); remote accounts' user@host go through it too
	[/screenName:"\[a-zA-Z0-9_\]\{1,2[06]\}"/g, 'screenName:"[^/]{1,200}"'],
	[
		/(descriptionTextParts:\((\w+),(\w+),(\w+)\)=>\{let \w+=)(\w+)\(\(0,(\w+\.A)\)\(\2\),(\w+\.A\.MENTION)\)([\s\S]{0,600}?;let \w+=\3&&\3\.description&&\3\.description\.urls;if\(\w+&&\w+\.length\)\{let \3=\5\(\w+\.map\(\3=>\(\{\.\.\.\3,indices:\4\?\.isUTF16EntityIndices\?\3\.indices:\(0,(\w+\.A)\)\(\2,)/g,
		"$1(Array.isArray($3?.description?.user_mentions)?$5($3.description.user_mentions.map($3=>({...$3,screenName:$3.screen_name,indices:$4?.isUTF16EntityIndices?$3.indices:(0,$9)($2,$3.indices[0],$3.indices[1])})),$7):$5((0,$6)($2),$7))$8",
	],
	[/(description:\(0,\w+\.A\)\((\w+)\.description,(\w+)=>\(\{urls:\3\.urls\?\.map\(\w+\))\}/g, "$1,user_mentions:$3.user_mentions}"],
	[
		/("\(#\{validMentionPrecedingChars\}\)\(#\{atSigns\}\)\(\[a-zA-Z0-9_\]\{1,20\})(\)\(\/\[a-zA-Z\]\[a-zA-Z0-9_-\]\{0,24\}\)\?")/g,
		String.raw`$1(?:@[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*(?::\\d+)?)?$2`,
	],
	[/(regexp:|\w+=)\/\^\[@＠\]\(\\w\{1,20\}\)\//g, "$1/^[@＠](\\w{1,20}(?:@[a-zA-Z0-9.:-]*)?)/"],
	[/(WordEnd:\/)(\[\^[^\]]*\\\][^\]]*\]\+)\$\//g, "$1(?:(?<![\\w!#$$%&*@＠])[@＠]\\w{1,20}@[a-zA-Z0-9.:-]*|$2)$$/"],
	// Analytics hides its charts below 50 followers, which on a small instance
	// is nearly everyone
	[/(\w+)=(\w+)\.followerCount>=50,/g, "$1=$2.followerCount>=0,"],
	// A player card (YouTube links, links.ts) opens as a thumbnail with a play
	// button, and only a click switches it to the player in its frame
	// (player-card.ts). One with a frame starts as the player.
	[
		/((?<![\w$])([\w$]+)=[\w$]+&&[\w$]+\?[\w$.]+\.getPlayerCardIFrameUrl\([\w$]+\):void 0,[\s\S]{0,6000}?:\{cardState:)([\w$]+\.[\w$]+)\.DEFAULT(,layout:\{\[\3\.DEFAULT\]:\{size:"small"\},\[\3\.CONDENSED\])/g,
		"$1$2?$3.SECONDARY:$3.DEFAULT$4",
	],
	// The same resizer re-encodes every cropped, rotated or oversized image as
	// JPEG on a canvas it fills white first, so a transparent avatar loses its
	// background. The canvas stays empty, and one with any transparent pixel
	// goes out as PNG; the size loop still shrinks it.
	[
		/(\w+)\.fillStyle="#FFFFFF",\1\.fillRect\(0,0,(\w+),(\w+)\),(\w+)\}/g,
		"$4}",
	],
	[
		/(\w+)=(\w+)\.toDataURL\("image\/jpeg",(\w+)\),(\w+)=\1\.split\(";base64,"\)/g,
		'$1=$2.toDataURL(function(c){try{var p=c.getContext("2d").getImageData(0,0,c.width,c.height).data;for(var i=3;i<p.length;i+=4)if(p[i]<255)return"image/png"}catch(e){}return"image/jpeg"}($2),$3),$4=$1.split(";base64,")',
	],
];

// Only for the chat app's files: its own list of API hosts, which it sends the
// csrf header to, and the pattern its files' address must match. The same
// names and pattern in the main client must stay: changed there, its requests
// go out without their auth headers.
const CHAT_RULES: [RegExp, string][] = [
	...API_HOSTS.map((h): [RegExp, string] => [new RegExp(`\`${h.replace(/\./g, "\\.")}\``, "g"), `\`${PUBLIC_HOSTNAME}\``]),
	[new RegExp(String.raw`https:\\\/\\\/abs\\\.twimg\\\.com`, "g"), inRegex(`${PUBLIC_ORIGIN}/abs`)],
	// the media host for chat attachments; the main client sends requests to
	// this host without auth headers, so there it must keep its own name
	[/https:\/\/ton\.x\.com/g, PUBLIC_ORIGIN],
];

// The translation files hold most sentences the client shows ("Sign up for X";
// "Home / X" is built from the one string "X"), so there the brand becomes the
// instance's name inside every string literal. Newer parts (Chat, the share
// sheet, embeds) keep their messages in the code, where "X" is also a plain
// value (a variable, an enum member) and a regular expression can't tell
// strings from code reliably: there only literals that read as prose change,
// three words or more and nothing that looks like code. Check a new client
// build with scripts/test-branding.ts.
const I18N = /^\/responsive-web\/client-web\/i18n\//;
const STRING = /"(?:[^"\\\n]|\\.)*"/g;
const PROSE = /^"[^();=`]*"$/;
const WORDS = /\S\s+\S+\s+\S/;
// a whole word, not "X.com", "SpaceX", "@X", "X-Large" or "Mac OS X"
const BRAND = /(?<![\w.@/$-]|OS )X(?![\w$-]|\.com)/g;

export function brandText(text: string, name: string, code = false): string {
	const literal = JSON.stringify(name).slice(1, -1);
	return text.replace(STRING, (s) => (!code || (PROSE.test(s) && WORDS.test(s)) ? s.replace(BRAND, () => literal) : s));
}

// only the 2020 client's files (client-web-legacy)
const LEGACY_RULES: [RegExp, string][] = [
	// its cookies (night_mode among them: Display's dim and lights out) are set
	// for .twitter.com, which the browser drops here, so a reload forgot them
	[/domain:"\.twitter\.com"/g, `domain:"${PUBLIC_HOSTNAME}"`],
	// its only checkmark, painted from `verified` (model.ts oldVerified): gold
	// for organisations, grey for governments, blue for the rest (the 2020
	// client drew its one check white on a dark theme); then an affiliate badge
	[
		/(\w+)\.isVerified&&(\w+)\.push\((\w+)\.createElement\((\w+\.a),\{accessibilityLabel:(\w+),style:\[(\w+)\.marginLeft,\6\.defaultBadgeColor,(\w+)\]\}\)\)/g,
		'(function(xv){var xt=xv&&typeof xv=="object"?xv.t:xv;xt&&$2.push($3.createElement($4,{key:"xc",accessibilityLabel:$5,style:[$6.marginLeft,$6.defaultBadgeColor,$7,xt==="business"?{color:"rgb(226,183,25)"}:xt==="government"?{color:"rgb(130,154,171)"}:{color:"rgb(29,155,240)"}]}));xv&&xv.img&&$2.push($3.createElement("img",{key:"xa",src:xv.img,alt:xv.name,title:xv.name,style:{width:"1.05em",height:"1.05em",borderRadius:3,marginLeft:4,verticalAlign:"-0.15em",objectFit:"cover",flexShrink:0}}))})($1.isVerified)',
	],
	// the profile header and user cells cast `verified` to a boolean first
	[/isVerified:!!(\w+)\.verified(?![\w$])/g, "isVerified:$1.verified"],
	// Settings: Xitter settings above Additional resources (shell.ts loads our
	// pages whole when their links are clicked)
	[/(([\w$]+)\.createElement\(([\w$]+),\{label:[\w$]+,link:"\/settings\/about")/g, '$2.createElement($3,{label:"Xitter settings",link:"/settings/xitter"}),$1'],
	// Home's sparkle menu switches top and latest Tweets (For you and Following);
	// All, every post here, is the built-in list (lists.ts)
	[/(_getActionMenuItems",\(function\(\)\{var [\w$]+=[\w$]+\.props\.useLatest,[\w$]+=[^;]{1,20};return\[\{text:[^}]{1,80},Icon:([\w$]+\.a),subText:[\w$]+\},)/g, '$1{link:"/i/lists/1",text:"See all Tweets",subText:"Every Tweet on this instance, newest first.",Icon:$2},'],
	// ...and Home gets For you / Following / All tabs (shell.ts OLD_TABS) atop its
	// timeline, which take over from that button: its component now only says
	// which timeline is on and how to switch
	[/("_renderPrimaryContent",\(function\(\)\{var [\w$]+=[\w$]+\.props,([\w$]+)=[\w$]+\.history,[^;]{0,200};return ([\w$]+)\.createElement\(\3\.Fragment,null,)/g, "$1window.__xitterTabs?$3.createElement(window.__xitterTabs($3),{history:$2}):null,"],
	[/(key:"render",value:function\(\)\{var ([\w$]+)=this\.props\.useLatest;)return [\w$]+\.createElement\([\w$]+,\{onContentPreferencesSelect:this\._handleContentPreferencesSelect,onPress:this\._handleSwitchPress,onToggle:this\._handleToggle,useLatest:\2\}\)/g, '$1var xs=this;window.__xitterHome={useLatest:$2,toggle:function(){xs._handleToggle()}};setTimeout(function(){window.dispatchEvent(new Event("xitter:home"))});return null'],
	// the header says Home on every tab, not "Latest Tweets"
	[/(=this\._latestTimelineSwitchEnabled&&[\w$]+\?)[\w$]+:([\w$]+)(?=[,;])/g, "$1$2:$2"],
	// More menu entries for what Xitter doesn't run: Topics, and the sites
	// Twitter had for ads, analytics and media (they lead to x.com)
	[/(_render(?:Topics|TwitterAds|Analytics|MediaStudio)Item",\(function\([\w$]*\)\{)return /g, "$1return null;"],
];

// the More menu: after Settings and privacy, what shell.ts puts in __XITTER_MENU__
function legacyMenu(text: string): string {
	const names = /_renderSettingsItem",\(function\(\)\{return ([\w$]+)\.createElement\(([\w$]+),\{icon:/.exec(text);
	if (!names) return text;
	const [, react, item] = names;
	// the icon takes the colour, size and spacing of the menu's own icons, which
	// come from styles this module can't reach
	const fit = `function(el){if(!el)return;var own=el.closest("[role=menu]");own=own&&own.querySelector("svg:not([data-xitter])");if(!own)return;var c=getComputedStyle(own);el.style.width=c.width;el.style.height=c.height;el.style.marginRight=c.marginRight;el.style.fill=c.color}`;
	const entries = `(window.__XITTER_MENU__||[]).map(function(l){return ${react}.createElement(${item},{key:l.href,label:l.text,link:l.href,icon:function(){return ${react}.createElement("svg",{viewBox:l.viewBox,"aria-hidden":"true","data-xitter":"",ref:${fit},style:{width:"1.5em",height:"1.5em",marginRight:12,flexShrink:0}},${react}.createElement("path",{d:l.icon}))}})})`;
	return text.replace(/this\._renderSettingsItem\(\),/g, `this._renderSettingsItem(),${entries},`);
}

export function patchText(text: string, chat = false): string {
	let out = text;
	let re: RegExp, to: string;
	for ([re, to] of chat ? [...CHAT_RULES, ...RULES] : RULES) out = out.replace(re, to);
	out = patchCountryAudience(out);
	out = patchCircleComposer(out);
	if (!out.includes("ConversationControlsQuery")) return out;
	// newer clients pass more props between options and value (requiresSelection:n=!1)
	return out.replace(/function [\w$]+\(\{onApply:[\w$]+,onBack:[\w$]+,options:([\w$]+),(?:[\w$]+:[\w$]+(?:=[\w$!.]{1,20})?,){0,4}value:[\w$]+\}\)\{let\[[\w$]+,[\w$]+\]=([\w$]+)\.useState\([\s\S]{0,16000}?(?=let [\w$]+=[\w$]+\.A\.create)/g, (picker, options, react) => {
		const jsx = /\(0,([\w$]+)\.jsxs\)/.exec(picker)?.[1];
		if (!jsx) return picker;
		return picker.replace(/\{let\[/, `{let[xitterCountrySearch,xitterSetCountrySearch]=${react}.useState(""),[`).replace('children:[', `children:[(0,${jsx}.jsx)("input",{type:"search","aria-label":"Search countries or regions",placeholder:"Search countries or regions",value:xitterCountrySearch,onChange:e=>xitterSetCountrySearch(e.target.value),style:{boxSizing:"border-box",width:"100%",padding:12,marginBottom:12,border:"1px solid currentColor",borderRadius:8,background:"transparent",color:"inherit",font:"inherit"}}),`).replace(`children:${options}.map`, `children:${options}.filter(e=>e.label.toLocaleLowerCase().includes(xitterCountrySearch.toLocaleLowerCase())||e.value.toLocaleLowerCase().includes(xitterCountrySearch.toLocaleLowerCase())).map`);
	});
}

const MAX_PATCH_CACHE_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, Buffer>();
let cacheBytes = 0;
// `build`: the client build's folder, as two builds can share a path (/emoji/...)
export function cachedPatch(key: string, build = ""): Buffer | undefined {
	const slot = `${build}\0${key.endsWith(".js") ? `${key}\0${settings().instance_name}` : key}`;
	const hit = cache.get(slot);
	if (hit) {
		cache.delete(slot);
		cache.set(slot, hit);
	}
	return hit;
}
export const clearPatchCache = () => {
	cache.clear();
	cacheBytes = 0;
};

// the name can change while the server runs, so script files are cached per name
export function patchFile(key: string, raw: Buffer, build = ""): Buffer {
	const js = key.endsWith(".js");
	const name = settings().instance_name;
	const slot = `${build}\0${js ? `${key}\0${name}` : key}`;
	let hit = cachedPatch(key, build);
	if (!hit) {
		let text = patchText(raw.toString("utf8"), key.startsWith("/x-web/xchat/"));
		if (key.includes("/client-web-legacy/")) {
			for (const [re, to] of LEGACY_RULES) text = text.replace(re, to);
			text = legacyMenu(text);
		}
		if (js) text = brandText(text, name, !I18N.test(key));
		hit = Buffer.from(text);
		if (hit.byteLength <= MAX_PATCH_CACHE_BYTES) {
			while (cacheBytes + hit.byteLength > MAX_PATCH_CACHE_BYTES) {
				const oldest = cache.keys().next().value!;
				cacheBytes -= cache.get(oldest)!.byteLength;
				cache.delete(oldest);
			}
			cache.set(slot, hit);
			cacheBytes += hit.byteLength;
		}
	}
	return hit;
}
