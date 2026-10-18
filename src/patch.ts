// Rewrites the host names baked into the client so it talks to this instance.
// Applied when a file is served; the archive keeps the original bytes.

import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "./config";
import { vapidPublicKey } from "./push";
import { settings } from "./settings";

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
	[/screenName:"\[a-zA-Z0-9_\]\{1,26\}"/g, 'screenName:"[^/]{1,200}"'],
	// Analytics hides its charts below 50 followers, which on a small instance
	// is nearly everyone
	[/(\w+)=(\w+)\.followerCount>=50,/g, "$1=$2.followerCount>=0,"],
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

export function patchText(text: string, chat = false): string {
	let out = text;
	for (const [re, to] of chat ? [...CHAT_RULES, ...RULES] : RULES) out = out.replace(re, to);
	return out;
}

const cache = new Map<string, Buffer>();
export const clearPatchCache = () => cache.clear();

// the name can change while the server runs, so script files are cached per name
export function patchFile(key: string, raw: Buffer): Buffer {
	const js = key.endsWith(".js");
	const name = settings().instance_name;
	const slot = js ? `${key}\0${name}` : key;
	let hit = cache.get(slot);
	if (!hit) {
		let text = patchText(raw.toString("utf8"), key.startsWith("/x-web/xchat/"));
		if (js) text = brandText(text, name, !I18N.test(key));
		hit = Buffer.from(text);
		cache.set(slot, hit);
	}
	return hit;
}
