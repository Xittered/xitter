const REDIRECT = /\(0,([\w$]+)\.jsx\)\(([\w$]+)\.A,\{exact:!0,from:"\/home",to:"\/"\},"home_redirect_lo"\)/;
const ROUTE = /\(0,[\w$]+\.jsx\)\(([\w$]+)\.Route,\{component:[\w$]+,exact:!0,path:"\/"\},"home_lo"\)/;
const PRELOAD = /case"\/home":return\{key:"\/home",load:\(\)=>([\w$]+)\.b\(\)\}/;
const REQUIRE = /([\w$]+)\.d\([\w$]+,\["createLoggedOutRoutes"/;
const esc = (s: string) => s.replace(/\$/g, "\\$");

function homeModuleId(text: string): string | undefined {
	const preload = PRELOAD.exec(text);
	if (!preload) return undefined;
	const before = text.slice(Math.max(0, preload.index - 200_000), preload.index);
	const binding = new RegExp(`[,;\\s]${esc(preload[1])}=[\\w$]+\\((\\d{1,9})\\)`, "g");
	let id: string | undefined;
	for (const m of before.matchAll(binding)) id = m[1];
	return id;
}

function unguardedHome(text: string, id: string): { lazyModule: string; lazyFn: string } | undefined {
	const start = text.indexOf(`${id}(e,t,n){`);
	if (start < 0) return undefined;
	const body = text.slice(start, start + 4000);
	const wrap = /\(0,([\w$]+)\.v\)\(\(0,([\w$]+)\.([\w$]+)\)\(([\w$]+)\)\)/.exec(body);
	if (!wrap) return undefined;
	const lazy = new RegExp(`[,\\s]${esc(wrap[2])}=n\\((\\d{1,9})\\)`).exec(body);
	return lazy ? { lazyModule: lazy[1], lazyFn: wrap[3] } : undefined;
}

export function patchGuestHome(text: string): string {
	if (!text.includes('"home_redirect_lo"')) return text;
	const redirect = REDIRECT.exec(text);
	const route = ROUTE.exec(text);
	const require = REQUIRE.exec(text);
	const id = homeModuleId(text);
	const home = id && unguardedHome(text, id);
	if (!redirect || !route || !require || !id || !home) return text;
	const [whole, jsx, redirectNs] = redirect;
	const n = require[1];
	const guestHome = `(window.__xitterGuestHome||(window.__xitterGuestHome=${n}(${home.lazyModule}).${home.lazyFn}(${n}(${id}).b)))`;
	const routeEl = `(0,${jsx}.jsx)(${route[1]}.Route,{exact:!0,path:"/home",render:e=>window.__XITTER_GUEST_HOME__?(0,${jsx}.jsx)(${guestHome},{...e}):(0,${jsx}.jsx)(${redirectNs}.A,{to:"/"})},"home_redirect_lo")`;
	return text.replace(whole, routeEl);
}

const VIEWER_GUARD = /if\(!([\w$]+)\)throw Error\("RichHomeTimeline: useModule requires a viewerUserId"\)/;

export function patchGuestTimeline(text: string): string {
	if (!text.includes("RichHomeTimeline: useModule requires a viewerUserId")) return text;
	return text.replace(VIEWER_GUARD, (whole, viewer) => `if(!${viewer}){if(!window.__XITTER_GUEST_HOME__)throw Error("RichHomeTimeline: useModule requires a viewerUserId");${viewer}="0"}`);
}

export const GUEST_CSS = `[data-testid="primaryColumn"] div:has(nav div[role="tab"]):not(:has([data-testid="cellInnerDiv"])),[data-testid="primaryColumn"] div:has([data-testid="tweetTextarea_0_label"]):has([data-testid="toolBar"]):not(:has([data-testid="cellInnerDiv"])){display:none!important}`;

export const termsPopup = (instance: string) => `<dialog id="xt-terms" aria-labelledby="xt-terms-h"><h2 id="xt-terms-h">Before you look around</h2><p>By using ${instance}, you agree to its <a href="/tos" target="_blank">Terms of Service</a>, <a href="/privacy" target="_blank">Privacy Policy</a> and <a href="/rules" target="_blank">Rules</a>.</p><button type="button" autofocus>Agree and continue</button></dialog>
<style>#xt-terms{max-width:400px;width:calc(100% - 32px);padding:28px;border:0;border-radius:16px;background:#000;color:#e7e9ea;font:15px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;box-shadow:0 0 0 1px #2f3336,0 8px 24px rgba(0,0,0,.4)}#xt-terms::backdrop{background:rgba(91,112,131,.4)}#xt-terms h2{margin:0 0 8px;font-size:20px;line-height:24px;text-wrap:balance}#xt-terms p{margin:0 0 24px;color:#71767b;text-wrap:pretty}#xt-terms a{color:#1d9bf0;text-decoration:none}#xt-terms a:hover{text-decoration:underline}#xt-terms button{width:100%;min-height:44px;border:0;border-radius:9999px;background:#eff3f4;color:#0f1419;font:inherit;font-weight:700;text-align:center;cursor:pointer;transition:scale .2s ease-out}#xt-terms button:active{scale:.97}</style>
<script>(function(){var d=document.getElementById("xt-terms");try{if(localStorage.getItem("xitter-terms-ok"))return d.remove()}catch(e){}d.addEventListener("cancel",function(e){e.preventDefault()});d.querySelector("button").onclick=function(){try{localStorage.setItem("xitter-terms-ok","1")}catch(e){}d.close();d.remove()};d.showModal()})()</script>`;
