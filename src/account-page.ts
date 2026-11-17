import { parseCookies, type Viewer } from "./auth";
import { loadBuild } from "./build";
import { readCached } from "./client-cache";
import { sql } from "./db";
import { settings } from "./settings";
import { menuLinks } from "./tidy";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type Theme = "light" | "dim" | "dark";

const TOKENS: Record<Theme, Record<string, string>> = {
	light: {
		bg: "#fff",
		bar: "rgb(255 255 255 / .85)",
		text: "#0f1419",
		muted: "#536471",
		border: "#eff3f4",
		field: "#cfd9de",
		outline: "#cfd9de",
		surface: "#f7f9f9",
		hover: "rgb(15 20 25 / .1)",
		logo: "url(/public/logo-light.png)",
		scheme: "light",
	},
	dim: {
		bg: "rgb(21 32 43)",
		bar: "rgb(21 32 43 / .85)",
		text: "#f7f9f9",
		muted: "#8b98a5",
		border: "#38444d",
		field: "#425364",
		outline: "#536471",
		surface: "#1e2732",
		hover: "rgb(247 249 249 / .1)",
		logo: "url(/public/logo-dark.png)",
		scheme: "dark",
	},
	dark: {
		bg: "#000",
		bar: "rgb(0 0 0 / .65)",
		text: "#e7e9ea",
		muted: "#71767b",
		border: "#2f3336",
		field: "#333639",
		outline: "#536471",
		surface: "#16181c",
		hover: "rgb(231 233 234 / .1)",
		logo: "url(/public/logo-dark.png)",
		scheme: "dark",
	},
};

const vars = (t: Theme) =>
	Object.entries(TOKENS[t])
		.map(([k, v]) => (k === "scheme" ? `color-scheme:${v}` : `--${k}:${v}`))
		.join(";");

const FONT = `TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`;

let chirp: { sha: string; css: string } | undefined;
const fontFaces = () => {
	const build = loadBuild()?.build;
	if (!build) return "";
	if (chirp?.sha === build.sha) return chirp.css;
	const main = build.scripts.find((s) => /\/main\.[\w.]+\.js$/.test(s));
	const text = main ? (readCached(main)?.toString("utf8") ?? "") : "";
	const dir = main ? main.slice(0, main.lastIndexOf("/")) : "";
	const css = Object.entries({ Regular: 400, Bold: 700, Heavy: 800 })
		.map(([name, weight]) => {
			const file = new RegExp(`Chirp-${name}\\.[0-9a-f]+\\.woff2`).exec(text)?.[0];
			return file ? `@font-face{font-family:TwitterChirp;src:url(/abs${dir}/${file}) format("woff2");font-weight:${weight};font-display:swap}` : "";
		})
		.join("");
	chirp = { sha: build.sha, css };
	return css;
};

const CSS = `
:root{${vars("light")};--accent:rgb(29 155 240);--accent-fill:var(--accent);--accent-hover:rgb(26 140 216);--danger:#f4212e;--success:#00ba7c;--warning:#ffd400}
@media (prefers-color-scheme:dark){:root:not([data-theme]){${vars("dark")}}}
:root[data-theme="dim"]{${vars("dim")}}
:root[data-theme="dark"]{${vars("dark")}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/20px var(--font, ${FONT});overflow-wrap:break-word}
.col{width:min(600px,100%);min-height:100vh;margin:0 auto;border-inline:1px solid var(--border);display:flex;flex-direction:column}
.bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:20px;min-height:53px;padding:0 16px;background:var(--bar);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
.back{display:grid;place-items:center;width:36px;height:36px;margin-left:-8px;border-radius:50%;color:var(--text);flex:none}
.back svg{width:20px;height:20px;fill:currentColor}
.heading{min-width:0}
.title{font-size:20px;line-height:24px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{color:var(--muted);font-size:13px;line-height:16px}
main{flex:1;padding:16px;display:flex;flex-direction:column;gap:12px}
h1,h2,p,pre{margin:0}
h1{font-size:23px;line-height:28px;font-weight:800;text-wrap:balance}
h2{font-size:20px;line-height:24px;font-weight:800;margin-top:16px;text-wrap:balance}
p{text-wrap:pretty}
a{color:var(--accent);text-decoration:none}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.dim,label{color:var(--muted)}
.dim{font-size:14px}
label{font-size:13px;line-height:16px;margin-bottom:-6px}
.error{color:var(--danger)}
.logo{width:200px;height:49px;background:var(--logo) left center/contain no-repeat}
form{display:grid;gap:12px;justify-items:start;margin:0}
form.inline{display:inline}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
form.row{display:flex}
.row input{flex:1 1 160px;width:auto}
input,select,textarea{width:100%;min-height:44px;padding:11px 12px;border:1px solid var(--field);border-radius:4px;background:var(--bg);color:inherit;font:inherit;font-size:16px}
textarea{min-height:120px;resize:vertical}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:-2px;border-color:transparent}
button{min-height:36px;padding:0 16px;border:1px solid transparent;border-radius:9999px;background:var(--accent-fill,var(--accent));color:var(--accent-text,#fff);font:inherit;font-weight:700;cursor:pointer;white-space:nowrap;transition:scale 200ms ease-out}
button:active:not(:disabled){scale:.97}
button.secondary{background:transparent;border-color:var(--outline);color:var(--text)}
button.danger{background:var(--danger);color:#fff}
button.small{min-height:32px;padding:0 14px;font-size:14px}
button:disabled{opacity:.5;cursor:default}
@media (hover:hover){
.back:hover{background:var(--hover)}
button:hover:not(:disabled){background:var(--accent-hover)}
button.secondary:hover:not(:disabled){background:var(--hover)}
button.danger:hover:not(:disabled){background:rgb(220 30 41)}
a:hover{text-decoration:underline}
.back:hover{text-decoration:none}
}
.card{border:1px solid var(--border);border-radius:16px;padding:12px 16px;display:grid;gap:4px}
.card p{white-space:pre-wrap}
.card>button{justify-self:start}
.card.strike{border-color:rgb(244 33 46 / .5)}
.card.warning{border-color:rgb(255 212 0 / .4)}
.card.success{border-color:var(--success);background:rgb(0 186 124 / .1)}
.split{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.split>:first-child{flex:1 1 220px;min-width:0}
.meta{color:var(--muted);font-size:13px}
.box{background:var(--surface);border-radius:12px;padding:12px 16px}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
code{background:var(--surface);border-radius:4px;padding:1px 5px}
pre{background:var(--surface);border-radius:12px;padding:12px 16px;overflow-x:auto}
[hidden]{display:none!important}
.source{padding:16px;border-top:1px solid var(--border);color:var(--muted);font-size:13px}
@media (max-width:600px){.col{border-inline:0}}
/* inside the client's Settings (tidy.ts): the frame grows with the page,
   so nothing may size itself to the frame */
html[data-in-settings],html[data-in-settings] body{overflow:hidden}
html[data-in-settings] .col{min-height:0;width:100%;border-inline:0}
html[data-in-settings] .bar{position:static}
html[data-in-settings] .source{display:none}
`;

// Runs in the frame: our own pages stay in it, the client's pages open in the
// client around it without a reload, other sites in a new tab
const FRAMED = `(function(){
	if(top===self)return;
	// an attribute, not a class: pages have their own .framed (decor.ts)
	document.documentElement.setAttribute("data-in-settings","");
	document.addEventListener("click",function(e){
		var a=e.target.closest&&e.target.closest("a[href]");
		if(!a||e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey||a.target==="_blank"||a.hasAttribute("download"))return;
		var u=new URL(a.href,location.href);
		if(u.origin!==location.origin){e.preventDefault();window.open(u.href,"_blank","noopener");return}
		if(u.pathname.indexOf("/account/")===0&&!a.hasAttribute("data-home"))return;
		e.preventDefault();
		var index=location.pathname==="/account/"||location.pathname==="/account";
		// back from one of our pages opens the Xitter settings list in this frame:
		// moving the client to /settings/xitter alone leaves it on the same
		// not-found screen, which doesn't redraw, so the frame would stay put
		if(a.hasAttribute("data-home")&&!index){location.assign("/account/");return}
		var to=a.hasAttribute("data-home")?"/settings":u.pathname+u.search+u.hash;
		try{parent.__xitterGo(to)}catch(err){top.location.assign(to)}
	});
})();`;

const ARROW = "M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z";

type PageOptions = {
	req: Request;
	title: string;
	body: string;
	viewer?: Viewer | null;
	status?: number;
	back?: { href: string; label: string };
	cache?: string;
	referrer?: string | null;
	css?: string;
	head?: string;
};

export async function accountPage({ req, title, body, viewer, status = 200, back, cache = "no-store", referrer = "no-referrer", css = "", head = "" }: PageOptions): Promise<Response> {
	const { accountVars, accentVars } = await import("./themes/css");
	const { nightModeCookies } = await import("./themes/api");
	const { paletteOf, readPrefs } = await import("./themes/validate");
	const name = settings().instance_name;
	const night = parseCookies(req).night_mode;
	let look: ReturnType<typeof readPrefs>["look"] = null;
	let extra = "";
	// From the 2020 client these pages take its look, which it keeps to itself:
	// its pages note the theme they show as they link here (shell.ts OLD_PAGES)
	const old = !!loadBuild()?.build.stateBase;
	const oldTheme = parseCookies(req).xitter_old_theme;
	if (old) extra = ":root{--accent:rgb(29 161 242);--accent-fill:rgb(29 161 242);--accent-hover:rgb(26 145 218)}";
	else if (viewer) {
		const [row] = await sql`select preferences from users where id = ${viewer.id}::bigint`;
		const prefs = readPrefs(row?.preferences);
		look = prefs.look;
		extra = look?.kind === "painted" ? `:root[data-theme]{${accountVars(look.theme)}}` : `:root{${accentVars(prefs.accent)}}`;
	}
	const theme = old ? (oldTheme === "dim" || oldTheme === "dark" || oldTheme === "light" ? oldTheme : "light") : paletteOf(look, night);
	// the 2020 client opens these pages whole, not framed in its Settings
	const index = /^\/account\/?$/.test(new URL(req.url).pathname);
	const home = !old ? { href: "/settings/xitter", label: "Back to Xitter settings" } : index ? { href: "/settings", label: "Back to Settings" } : { href: "/account/", label: "Back to Xitter settings" };
	const to = back ?? (viewer ? home : { href: "/", label: `Back to ${name}` });
	const html = `<!doctype html>
<html lang="en"${theme ? ` data-theme="${theme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${theme ? TOKENS[theme].scheme : "light dark"}">
<title>${esc(title)} · ${esc(name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png">
${head}
<style>${fontFaces()}${CSS}${extra}${css}</style>
<script>${FRAMED}</script>
</head>
<body>
<div class="col">
<header class="bar"><a class="back" href="${esc(to.href)}"${back ? "" : " data-home"} aria-label="${esc(to.label)}" title="${esc(to.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ARROW}"/></svg></a><div class="heading"><div class="title">${esc(title)}</div><div class="sub">${esc(name)}</div></div></header>
<main>
${body}
</main>
<footer class="source">${esc(name)} runs <a href="${esc(settings().source_url)}">open source</a> software (AGPL-3.0)</footer>
</div>
</body>
</html>`;
	// never inside another site's frame: these pages hold one-click actions
	// (authorizing an app, removing 2FA) a hidden frame could be clicked into.
	// Our own client frames them in Settings.
	const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": cache, "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'" });
	if (referrer) headers.set("referrer-policy", referrer);
	if (viewer) for (const c of nightModeCookies(look)) headers.append("set-cookie", c);
	return new Response(html, { status, headers });
}

// /account/ (Settings > Xitter settings): every page of ours in one list
export async function accountIndexRoute(req: Request, viewer: Viewer): Promise<Response> {
	const name = settings().instance_name;
	const links = (await menuLinks(viewer.id)).filter((l) => l.href.startsWith("/account/") && l.where !== "tabs" && l.where !== "nav");
	const CHEVRON = "M14.586 12L7.543 4.96l1.414-1.42L17.414 12l-8.457 8.46-1.414-1.42 7.043-7.04z";
	const rows = links
		.map(
			(l) =>
				`<li><a href="${esc(l.href)}"><svg class="ico" viewBox="${l.viewBox ?? "0 0 24 24"}" aria-hidden="true"><path d="${l.icon}"/></svg><span class="txt"><span class="t">${esc(l.text)}</span><span class="d">${esc(l.description)}</span></span><svg class="go" viewBox="0 0 24 24" aria-hidden="true"><path d="${CHEVRON}"/></svg></a></li>`,
		)
		.join("");
	return accountPage({
		req,
		viewer,
		title: "Xitter settings",
		css: `html[data-in-settings] .back{display:none}.index{list-style:none;margin:-16px;padding:0}.index a{display:flex;align-items:center;gap:12px;padding:12px 16px;color:var(--text);text-decoration:none}.index .ico{width:24px;height:24px;flex:none;fill:var(--muted)}.index .txt{flex:1;min-width:0;display:flex;flex-direction:column}.index .t{font-size:15px;line-height:20px}.index .d{font-size:13px;line-height:16px;color:var(--muted)}.index .go{width:20px;height:20px;flex:none;fill:var(--muted)}@media (hover:hover){.index a:hover{background:var(--hover)}}`,
		body: `<ul class="index">${rows}</ul>`,
	});
}
