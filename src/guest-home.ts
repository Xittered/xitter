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
