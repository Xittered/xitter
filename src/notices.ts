// Sentences a person may see. Callers pass one of these. Request data never becomes a notice.

export const STORAGE_SENTENCE = "The server is out of storage right now. Try again later.";
export const DATABASE_SENTENCE = "The database is unavailable right now. Try again later.";

export const NOTICES = [
	STORAGE_SENTENCE,
	DATABASE_SENTENCE,
	"File is too large.",
	"File is too large or empty.",
	"That request is too large.",
	"The video could not be processed.",
	"The video could not be converted.",
	"This file has no video we can read.",
	"Video processing took too long.",
] as const;

const VIDEO_LENGTH = /^Videos can be up to \d{1,4} minutes long\.$/;

const CANNED = [
	"Some of your media failed to upload.",
	"Something went wrong, but don't fret — it's not your fault.",
	"Something went wrong, but don’t fret — it’s not your fault.",
	"Something went wrong, but don't fret — let’s give it another shot.",
	"Something went wrong, but don’t fret — let’s give it another shot.",
	"Your media failed to resize and is too large to upload.",
	"X is over capacity. Please wait a few moments then try again.",
];

export function allowedNotice(text: string): boolean {
	return (NOTICES as readonly string[]).includes(text) || VIDEO_LENGTH.test(text);
}

export const NOTICE_HEADER = "x-xitter-notice";

export function noticeHeaders(sentence: string): Headers {
	const headers = new Headers({ "cache-control": "no-store", "retry-after": "60" });
	if (allowedNotice(sentence)) headers.set(NOTICE_HEADER, sentence);
	return headers;
}

export function noticeHeadersFor(sentence: string): Headers {
	const headers = new Headers();
	if (allowedNotice(sentence)) headers.set(NOTICE_HEADER, sentence);
	return headers;
}

// the pinned client already toasts its own sentences. this is for the ones it hides behind a canned line.
export const RESOURCE_NOTICE_SCRIPT = `(function(){
var allow=${JSON.stringify([...NOTICES])};
var length=${VIDEO_LENGTH.toString()};
function ok(s){return typeof s==="string"&&(allow.indexOf(s)!==-1||length.test(s))}
var canned=${JSON.stringify(CANNED)};
var timer=0,node=null;
function hideCanned(){
	if(!node||!node.isConnected)return;
	var nodes=document.querySelectorAll('[data-testid="toast"]');
	for(var i=0;i<nodes.length;i++){
		var t=nodes[i].textContent||"";
		for(var j=0;j<canned.length;j++)if(t.indexOf(canned[j])!==-1)nodes[i].style.display="none";
	}
}
function show(text){
	if(!ok(text))return;
	if(!node||!node.isConnected){
		node=document.createElement("div");
		node.setAttribute("role","alert");
		node.setAttribute("data-testid","xitter-notice");
		node.style.cssText="position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;max-width:min(480px,calc(100vw - 32px));box-sizing:border-box;padding:12px 16px;border-radius:9999px;background:#1d9bf0;color:#fff;font:600 15px/20px TwitterChirp,-apple-system,system-ui,sans-serif;text-align:center";
		(document.body||document.documentElement).appendChild(node);
	}
	node.textContent=text;
	hideCanned();
	clearTimeout(timer);
	timer=setTimeout(function(){if(node){node.remove();node=null}},5000);
}
function read(headers){
	try{var v=headers&&headers.get&&headers.get("${NOTICE_HEADER}");if(v)show(v)}catch(e){}
}
var orig=window.fetch;
if(typeof orig==="function")window.fetch=function(){
	var p=orig.apply(this,arguments);
	if(p&&typeof p.then==="function")p.then(function(res){read(res&&res.headers)},function(){});
	return p;
};
var send=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.send=function(){
	this.addEventListener("load",function(){try{show(this.getResponseHeader("${NOTICE_HEADER}"))}catch(e){}});
	return send.apply(this,arguments);
};
if(typeof MutationObserver==="function"&&document.documentElement)new MutationObserver(hideCanned).observe(document.documentElement,{childList:true,subtree:true});
})();`;
