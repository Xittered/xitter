import { parseCookies, type Viewer } from "./auth";
import { loadBuild } from "./build";
import { readCached } from "./client-cache";
import { settings } from "./settings";
import { menuLinks } from "./tidy";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

type Theme = "light" | "dim" | "dark";
const THEMES: Record<string, Theme> = { "0": "light", "1": "dim", "2": "dark" };

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
:root{${vars("light")};--accent:rgb(29 155 240);--accent-hover:rgb(26 140 216);--danger:#f4212e;--success:#00ba7c;--warning:#ffd400}
@media (prefers-color-scheme:dark){:root:not([data-theme]){${vars("dark")}}}
:root[data-theme="dim"]{${vars("dim")}}
:root[data-theme="dark"]{${vars("dark")}}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/20px ${FONT};overflow-wrap:break-word}
.col{width:min(600px,100%);min-height:100vh;margin:0 auto;border-inline:1px solid var(--border);display:flex;flex-direction:column}
.bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:20px;min-height:53px;padding:0 16px;background:var(--bar);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
.back{display:grid;place-items:center;width:36px;height:36px;margin-left:-8px;border-radius:50%;color:var(--text);flex:none}
.back svg{width:20px;height:20px;fill:currentColor}
.heading{min-width:0}
.title{font-size:20px;line-height:24px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sub{color:var(--muted);font-size:13px;line-height:16px}
.tabs{display:flex;border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none}
.tabs::-webkit-scrollbar{display:none}
.tabs a{flex:1 0 auto;display:flex;justify-content:center;padding:0 16px;color:var(--muted);font-weight:500;text-decoration:none}
.tabs span{position:relative;display:block;padding:16px 0;white-space:nowrap}
.tabs a[aria-current]{color:var(--text);font-weight:700}
.tabs a[aria-current] span::after{content:"";position:absolute;left:0;right:0;bottom:0;height:4px;border-radius:9999px;background:var(--accent)}
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
button{min-height:36px;padding:0 16px;border:1px solid transparent;border-radius:9999px;background:var(--accent);color:#fff;font:inherit;font-weight:700;cursor:pointer;white-space:nowrap;transition:scale 200ms ease-out}
button:active:not(:disabled){scale:.97}
button.secondary{background:transparent;border-color:var(--outline);color:var(--text)}
button.danger{background:var(--danger);color:#fff}
button.small{min-height:32px;padding:0 14px;font-size:14px}
button:disabled{opacity:.5;cursor:default}
@media (hover:hover){
.back:hover,.tabs a:hover{background:var(--hover)}
button:hover:not(:disabled){background:var(--accent-hover)}
button.secondary:hover:not(:disabled){background:var(--hover)}
button.danger:hover:not(:disabled){background:rgb(220 30 41)}
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
};

export async function accountPage({ req, title, body, viewer, status = 200, back, cache = "no-store", referrer = "no-referrer", css = "" }: PageOptions): Promise<Response> {
	const name = settings().instance_name;
	const theme = THEMES[parseCookies(req).night_mode ?? ""];
	const path = new URL(req.url).pathname;
	const links = viewer ? await menuLinks(viewer.id) : [];
	const tabs = links.length
		? `<nav class="tabs" aria-label="Account pages">${links
				.map((l) => `<a href="${l.href}"${path === l.href || path.startsWith(`${l.href}/`) ? ' aria-current="page"' : ""}><span>${esc(l.text)}</span></a>`)
				.join("")}</nav>`
		: "";
	const to = back ?? { href: viewer ? "/home" : "/", label: `Back to ${name}` };
	const html = `<!doctype html>
<html lang="en"${theme ? ` data-theme="${theme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="${theme ? TOKENS[theme].scheme : "light dark"}">
<title>${esc(title)} · ${esc(name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>${fontFaces()}${CSS}${css}</style>
</head>
<body>
<div class="col">
<header class="bar"><a class="back" href="${esc(to.href)}" aria-label="${esc(to.label)}" title="${esc(to.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ARROW}"/></svg></a><div class="heading"><div class="title">${esc(title)}</div><div class="sub">${esc(name)}</div></div></header>
${tabs}
<main>
${body}
</main>
<footer class="source">${esc(name)} runs <a href="${esc(settings().source_url)}">open source</a> software (AGPL-3.0)</footer>
</div>
</body>
</html>`;
	const headers: Record<string, string> = { "content-type": "text/html; charset=utf-8", "cache-control": cache };
	if (referrer) headers["referrer-policy"] = referrer;
	return new Response(html, { status, headers });
}
