import type { XitterSection } from "./xitter-menu";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export { settingsChrome } from "./owned-paths";

const CHEV = "M17.5 12 9 3.5 10.5 2l10 10-10 10L9 20.5 17.5 12z";
const EXTERNAL = "M19 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h6v2H5v12h12v-6h2zM14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42L17.59 5H14V3z";
const SEARCH = "M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 5 1.5-1.5-5-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z";
const ARROW = "M7.414 13l5.043 5.04-1.414 1.42L3.586 12l7.457-7.46 1.414 1.42L7.414 11H21v2H7.414z";

function searchBox(label: string): string {
	return `<label class="xsearch"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SEARCH}"/></svg><input type="search" placeholder="${esc(label)}" aria-label="${esc(label)}" data-xfilter></label>`;
}

function linkRow(href: string, title: string, description: string, on: boolean, icon?: string, viewBox?: string, external?: boolean): string {
	const mark = on ? ' aria-current="page"' : "";
	const glyph = icon ? `<span class="xic"><svg viewBox="${esc(viewBox || "0 0 24 24")}" aria-hidden="true"><path d="${icon}"/></svg></span>` : "";
	const away = external ? ' target="_blank" rel="noopener noreferrer"' : "";
	const trail = external ? EXTERNAL : CHEV;
	return `<a class="xrow" href="${esc(href)}" data-find="${esc(`${title} ${description}`.toLowerCase())}"${mark}${away}>${glyph}<span class="xtx"><span class="xt">${esc(title)}</span>${description ? `<span class="xd">${esc(description)}</span>` : ""}</span><span class="xch" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${trail}"/></svg></span></a>`;
}

function header(title: string, back?: { href: string; label: string }): string {
	const button = back ? `<a class="back" href="${esc(back.href)}" aria-label="${esc(back.label)}" title="${esc(back.label)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${ARROW}"/></svg></a>` : "";
	return `<header class="bar">${button}<div class="heading"><div class="title">${esc(title)}</div></div></header>`;
}

// The page that tidy.ts frames into the client's Settings detail column: the
// Xitter list, or one Xitter page. The client draws the nav and the Settings
// list around it, so nothing here imitates them.
export function renderSettingsShell(opts: { path: string; title: string; body: string; back: { href: string; label: string }; sections: XitterSection[]; sourceName: string; sourceUrl: string }): string {
	const home = opts.path === "/account/xitter";
	const here = (href: string) => opts.path === href || opts.path.startsWith(`${href}/`);
	const footer = `<footer class="source">${esc(opts.sourceName)} runs <a href="${esc(opts.sourceUrl)}" target="_blank" rel="noopener">open source</a> software (AGPL-3.0)</footer>`;
	const groups = opts.sections
		.map((section) => {
			const notes = (section.notes ?? []).map((note) => `<p class="xnote">${esc(note)}</p>`).join("");
			const rows = section.rows.map((row) => linkRow(row.href, row.text, row.description, here(row.href), row.icon, row.viewBox)).join("");
			return `<section data-group>${notes}<div class="xgrp">${esc(section.title)}</div><div class="xrows">${rows}</div></section>`;
		})
		.join("");
	const pane = home
		? `<div class="xlist" data-pane="xitter">${header("Xitter", { href: "/settings", label: "Settings" })}${searchBox("Search Xitter")}<div class="xrows">${groups}</div>${footer}</div>`
		: `<div class="xpage" data-pane="page">${header(opts.title, opts.back)}<main>${opts.body}</main>${footer}</div>`;
	return `<div class="xembed" data-depth="${home ? "1" : "2"}">${pane}</div>
<script>(function(){
document.querySelectorAll("[data-xfilter]").forEach(function(input){
var pane=input.closest("[data-pane]");
input.addEventListener("input",function(){
var q=input.value.trim().toLowerCase();
pane.querySelectorAll("[data-find]").forEach(function(row){row.hidden=!!q&&row.getAttribute("data-find").indexOf(q)<0});
pane.querySelectorAll("[data-group]").forEach(function(g){var any=false;g.querySelectorAll("[data-find]").forEach(function(r){if(!r.hidden)any=true});g.hidden=!!q&&!any});
});
});
})();</script>${FRAME_BRIDGE}`;
}

// Inside the client's frame: links and redirects move the client's address,
// not just the frame's; a form that leaves this site takes the whole tab. On
// its own (a script's fetch, a test) the page works as a plain page.
export const FRAME_BRIDGE = `<script>(function(){
var framed=false;try{framed=window.parent!==window&&parent.location.origin===location.origin}catch(e){}
var root=document.documentElement;
function wide(){try{root.toggleAttribute("data-wide",(framed?parent:window).innerWidth>700)}catch(e){}}
wide();addEventListener("resize",wide);
if(!framed)return;
root.setAttribute("data-framed","");
try{parent.addEventListener("resize",wide)}catch(e){}
function send(m){m.xitter=1;parent.postMessage(m,location.origin)}
document.addEventListener("click",function(e){
if(e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
var a=e.target.closest&&e.target.closest("a[href]");
if(!a||a.target==="_blank"||a.hasAttribute("download"))return;
var u=new URL(a.href,location.href);
if(u.origin!==location.origin)return;
if(u.pathname===location.pathname&&u.search===location.search&&u.hash)return;
e.preventDefault();
send({type:"go",path:u.pathname+u.search+u.hash});
});
document.addEventListener("submit",function(e){var f=e.target;try{if(new URL(f.action,location.href).origin!==location.origin)f.target="_top"}catch(err){}},true);
var look=document.querySelector('meta[name="xitter-look"]');
send({type:"page",path:location.pathname+location.search,title:document.title,look:look?look.content:""});
if(look)send({type:"look",look:look.content});
})();</script>`;

export const FRAME_LOOK_REPORT = `<script>try{if(window.parent!==window&&parent.location.origin===location.origin){var m=document.querySelector('meta[name="xitter-look"]');if(m)parent.postMessage({xitter:1,type:"look",look:m.content},location.origin)}}catch(e){}</script>`;

export const SHELL_CSS = `
.xembed{min-height:100vh}
.xlist,.xpage{min-height:100vh;display:flex;flex-direction:column;background:var(--bg)}
.xpage{min-width:0}
.xpage main{flex:1}
.xsearch{margin:4px 16px 12px;display:flex;align-items:center;gap:12px;height:42px;padding:0 16px;border:1px solid var(--border);border-radius:9999px;color:var(--muted)}
.xsearch:focus-within{border-color:var(--accent);color:var(--accent)}
.xsearch input{flex:1;min-width:0;border:0;background:transparent;outline:0;color:var(--text);font:inherit;min-height:0;padding:0;border-radius:0}
.xsearch svg{width:16px;height:16px;fill:currentColor;flex:none}
.xrows{display:flex;flex-direction:column}
.xrow{display:flex;align-items:center;gap:12px;padding:12px 16px;min-height:52px;color:var(--text);text-decoration:none;position:relative}
.xrow .xt{display:block;font-size:15px;line-height:20px}
.xrow .xd{display:block;color:var(--muted);font-size:13px;line-height:16px;margin-top:2px}
.xrow .xtx{flex:1;min-width:0}
.xrow .xic{color:var(--muted);display:grid}
.xrow .xch{color:var(--muted);display:grid}
.xrow .xic svg,.xrow .xch svg{width:18.75px;height:18.75px;fill:currentColor}
.xgrp{padding:16px 16px 4px;font-size:20px;line-height:24px;font-weight:800}
.xnote{margin:0;padding:12px 16px 0;color:var(--muted);font-size:15px;line-height:20px}
@media (hover:hover){.xrow:hover{background-color:var(--hover);text-decoration:none}}
html[data-wide] .xlist>.bar .back{display:none}
html[data-framed] body{background:transparent}
`;
