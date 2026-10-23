import { parseCookies, type Viewer } from "./auth";
import { loadBuild } from "./build";
import { readCached } from "./client-cache";
import { sql } from "./db";
import { feature, settings } from "./settings";
import { loadMenuFacts } from "./tidy";
import { xitterSections } from "./xitter-menu";
import { FRAMED_HEADERS } from "./owned-paths";
import { renderSettingsShell, settingsChrome, SHELL_CSS } from "./settings-shell";
import type { Accent } from "./themes/presets";
import type { Look, Prefs } from "./themes/validate";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function lookKeyOf(look: Look | null, accent: Accent, decoration: unknown): string {
	return Bun.hash(JSON.stringify([look, accent, decoration ?? null])).toString(36);
}

export type ViewerLook = { look: Look | null; lookKey: string; prefs: Prefs };

export async function viewerLook(viewer: Viewer): Promise<ViewerLook> {
	const { readPrefs } = await import("./themes/validate");
	const [row] = await sql`select preferences, decoration from users where id = ${viewer.id}::bigint`;
	const prefs = readPrefs(row?.preferences);
	return { look: prefs.look, lookKey: lookKeyOf(prefs.look, prefs.accent, row?.decoration), prefs };
}

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
		icon: "url(/public/icon-light.png)",
		scheme: "light",
		primary: "#0f1419",
		"primary-text": "#ffffff",
		"primary-hover": "#272c30",
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
		icon: "url(/public/icon-dark.png)",
		scheme: "dark",
		primary: "#1d9bf0",
		"primary-text": "#ffffff",
		"primary-hover": "#1a8cd8",
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
		icon: "url(/public/icon-dark.png)",
		scheme: "dark",
		primary: "#eff3f4",
		"primary-text": "#0f1419",
		"primary-hover": "#d7dbdc",
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
/* the tabs wrap onto more rows rather than hide past the edge */
.tabs{display:flex;flex-wrap:wrap;border-bottom:1px solid var(--border)}
.tabs a{flex:1 0 auto;display:flex;justify-content:center;padding:0 16px;color:var(--muted);font-weight:500;text-decoration:none}
.tabs span{position:relative;display:block;padding:16px 0;white-space:nowrap}
.tabs a[aria-current]{color:var(--text);font-weight:700}
.tabs a[aria-current] span::after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;border-radius:9999px;background:var(--accent-fill,var(--accent))}
main{flex:1;padding:16px 16px 96px;display:flex;flex-direction:column;gap:12px}
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
.save,.savebar{position:sticky;bottom:16px;z-index:4;display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;width:max-content;max-width:calc(100% - var(--xt-dock,0px));margin-left:auto;margin-right:var(--xt-dock,0px);padding:0;background:transparent;border:0}
.save button,.savebar button{box-shadow:0 2px 12px rgb(0 0 0 / .28)}
.save button:not(.secondary):not(.danger),.savebar button:not(.secondary):not(.danger){background:var(--primary,var(--accent-fill,var(--accent)));color:var(--primary-text,var(--accent-text,#fff))}
@media (hover:hover){
.back:hover,.tabs a:hover{background:var(--hover)}
button:hover:not(:disabled){background:var(--accent-hover)}
button.secondary:hover:not(:disabled){background:var(--hover)}
button.danger:hover:not(:disabled){background:rgb(220 30 41)}
.save button:not(.secondary):not(.danger):hover,.savebar button:not(.secondary):not(.danger):hover{background:var(--primary-hover,var(--accent-hover))}
a:hover{text-decoration:underline}
.back:hover,.tabs a:hover{text-decoration:none}
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
`;

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
	const { paletteOf } = await import("./themes/validate");
	const name = settings().instance_name;
	const night = parseCookies(req).night_mode;
	let look: Look | null = null;
	let extra = "";
	// changes when the theme or the avatar decoration does: the client around a
	// framed page reloads to show it
	let lookKey = "";
	if (viewer) {
		const got = await viewerLook(viewer);
		look = got.look;
		lookKey = got.lookKey;
		extra = got.look?.kind === "painted" ? `:root[data-theme]{${accountVars(got.look.theme)}}` : `:root{${accentVars(got.prefs.accent)}}`;
	}
	const theme = paletteOf(look, night);
	const path = new URL(req.url).pathname;
	const to = back ?? { href: viewer ? "/home" : "/", label: `Back to ${name}` };
	if (viewer && settingsChrome(path)) {
		const facts = await loadMenuFacts(req, viewer);
		const sectionBack = back?.href.startsWith("/account/") ? back : { href: "/account/xitter", label: "Xitter" };
		const frame = renderSettingsShell({
			path,
			title,
			body,
			back: sectionBack,
			sections: xitterSections(facts),
			sourceName: name,
			sourceUrl: settings().source_url,
		});
		const html = `<!doctype html>
<html lang="en"${theme ? ` data-theme="${theme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${theme ? TOKENS[theme].scheme : "light dark"}">
<meta name="xitter-look" content="${lookKey}">
<title>${esc(title)} · ${esc(name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png">
${head}
<style>${fontFaces()}${CSS}${SHELL_CSS}${extra}${css}</style>
</head>
<body>
${frame}
</body>
</html>`;
		return pageResponse(html, { status, cache, referrer, cookies: nightModeCookies(look), framed: true });
	}
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
</head>
<body>
<div class="col">
<header class="bar"><a class="back" href="${esc(to.href)}" aria-label="${esc(to.label)}" title="${esc(to.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ARROW}"/></svg></a><div class="heading"><div class="title">${esc(title)}</div><div class="sub">${esc(name)}</div></div></header>
<main>
${body}
</main>
<footer class="source">${esc(name)} runs <a href="${esc(settings().source_url)}">open source</a> software (AGPL-3.0)</footer>
</div>
</body>
</html>`;
	// never inside another site's frame: these pages hold one-click actions
	// (authorizing an app, removing 2FA) a hidden frame could be clicked into
	return pageResponse(html, { status, cache, referrer, cookies: viewer ? nightModeCookies(look) : [] });
}

function pageResponse(html: string, opts: { status: number; cache: string; referrer: string | null; cookies: readonly string[]; framed?: boolean }): Response {
	// Xitter's settings pages sit in a frame of this site's own client (tidy.ts);
	// nothing else may frame any of these pages
	const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": opts.cache, ...(opts.framed ? FRAMED_HEADERS : { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'" }) });
	if (opts.referrer) headers.set("referrer-policy", opts.referrer);
	for (const c of opts.cookies) headers.append("set-cookie", c);
	return new Response(html, { status: opts.status, headers });
}

export function xitterHome(req: Request, viewer: Viewer): Promise<Response> {
	return accountPage({ req, viewer, title: "Xitter", body: "" });
}
