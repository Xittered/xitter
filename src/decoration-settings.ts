import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { DISCORD_DECORATIONS } from "./decoration-presets";
import {
	type Decoration,
	decorationUrl,
	EAR_STYLES,
	parseDecoration,
} from "./decorations";

const STYLE_NAMES: Record<(typeof EAR_STYLES)[number], string> = {
	pointy: "Pointy",
	round: "Round",
	tilted: "Floppy",
	fluffy: "Fluffy",
};
const DEFAULT_EARS = {
	type: "ears",
	style: "pointy",
	color: "#3a3a3a",
	inner: "#ffb3cf",
	bow: null,
} as const;

const CSS = `
.preview{display:grid;place-items:center;padding:24px 0}
.stage{position:relative;width:120px;height:120px}
.stage .avatar{width:120px;height:120px;border-radius:50%;object-fit:cover;background:var(--surface);outline:1px solid rgb(0 0 0 / .08);outline-offset:-1px}
.stage .deco{position:absolute;left:-12px;top:-12px;width:144px;height:144px;pointer-events:none}
.choices{display:grid;gap:8px;width:100%}
.choice,.styles label,.colours label,.gallery label{margin:0}
.choice{font-size:15px;line-height:20px;color:var(--text)}
.choice input{width:20px;min-height:20px;height:20px;margin:0;padding:0;accent-color:var(--accent)}
.ears,.gallery,.styles{width:100%}
.choice{display:flex;align-items:center;gap:12px;border:1px solid var(--border);border-radius:16px;padding:10px 14px;cursor:pointer}
.choice:has(input:checked){border-color:var(--text)}
.ears{display:grid;gap:16px;margin-top:8px}
.styles{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:8px}
.styles label{position:relative;display:grid;justify-items:center;gap:4px;border:1px solid var(--border);border-radius:12px;padding:8px;cursor:pointer}
.styles label:has(input:checked){border-color:var(--text)}
.styles input,.gallery input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;pointer-events:none}
.styles img{width:100%;max-width:96px;height:40px;object-fit:cover;object-position:top}
.colours{display:flex;flex-wrap:wrap;gap:16px}
.colours label{display:grid;gap:4px;font-size:14px;color:var(--muted)}
.colours input[type=color]{width:56px;height:40px;border:1px solid var(--outline);border-radius:8px;background:none;padding:2px;cursor:pointer}
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(64px,1fr));gap:6px;margin-top:8px}
.gallery label{position:relative;display:grid;place-items:center;aspect-ratio:1;border:1px solid var(--border);border-radius:12px;cursor:pointer}
.gallery label:has(input:checked){border-color:var(--text)}
.gallery label:has(input:focus-visible),.styles label:has(input:focus-visible){outline:2px solid var(--text);outline-offset:2px}
.gallery img{width:84%;height:84%}
.gallery label[hidden]{display:none}
.search{display:grid;gap:6px;margin-top:8px;font-size:14px;color:var(--muted)}
.search input{color:var(--text)}
#deco-count:empty{display:none}
@media (hover:hover){.choice:hover,.styles label:hover,.gallery label:hover{background:var(--hover)}}
`;

function page(
	req: Request,
	viewer: Viewer,
	current: Decoration | null,
	notice = "",
) {
	const ears = current?.type === "ears" ? current : DEFAULT_EARS;
	const chosen =
		current?.type === "discord"
			? `discord:${current.asset}`
			: (current?.type ?? "none");
	const radio = (value: string, label: string, extra = "") =>
		`<label class="choice"><input type="radio" name="choice" value="${esc(value)}"${chosen === value ? " checked" : ""}${extra}>${esc(label)}</label>`;
	const styles = EAR_STYLES.map(
		(s) =>
			`<label><input type="radio" name="style" value="${s}"${ears.style === s ? " checked" : ""}><img alt="" src="${esc(decorationUrl({ ...ears, style: s }) ?? "")}">${STYLE_NAMES[s]}</label>`,
	).join("");
	const gallery = DISCORD_DECORATIONS.map((d, i) => {
		const name = d.name || `Discord decoration ${i + 1}`;
		const title = d.category && d.category !== d.name ? `${name}, ${d.category}` : name;
		const terms = ` ${d.name} ${d.category} ${d.label}`.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ");
		return `<label title="${esc(title)}" data-terms="${esc(terms)}"><input type="radio" name="choice" value="discord:${d.asset}"${chosen === `discord:${d.asset}` ? " checked" : ""} aria-label="${esc(title)}"><img loading="lazy" alt="" src="/i/xitter/decoration/${d.asset}.png"></label>`;
	}).join("");
	const avatar = viewer.avatar_url
		? `<img class="avatar" alt="Your avatar" src="${esc(viewer.avatar_url)}">`
		: `<div class="avatar" aria-label="Your avatar"></div>`;
	return accountPage({
		req,
		viewer,
		title: "Avatar decoration",
		css: CSS,
		body: `<h1>Avatar decoration</h1>
<p class="dim">A decoration shows around your avatar everywhere, here and on other instances.</p>
${notice ? `<p class="card success" role="status">${esc(notice)}</p>` : ""}
<div class="preview"><div class="stage">${avatar}<img class="deco" id="deco" alt="" src="${esc(decorationUrl(current, true) ?? "")}"${current ? "" : " hidden"}></div></div>
<form method="post" action="/account/decoration" id="form">
<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
<div class="choices">
${radio("none", "No decoration")}
${radio("ears", "Cat ears")}
</div>
<div class="ears">
<div class="styles" role="radiogroup" aria-label="Ear shape">${styles}</div>
<div class="colours">
<label>Ears<input type="color" name="color" value="${ears.color}"></label>
<label>Inside<input type="color" name="inner" value="${ears.inner}"></label>
<label>Bow<input type="color" name="bow" value="${ears.bow ?? "#ff5c8a"}"></label>
<label class="choice"><input type="checkbox" name="with_bow" value="1"${ears.bow ? " checked" : ""}>Add a bow</label>
</div>
</div>
<h2>From Discord</h2>
<p class="dim">${DISCORD_DECORATIONS.length} of Discord's decorations. They move on your profile and stay still everywhere else.</p>
<label class="search">Search decorations<input type="search" id="deco-search" placeholder="Cats, Valorant, flowers" autocomplete="off" spellcheck="false"></label>
<p class="dim" id="deco-count" role="status"></p>
<div class="gallery" id="gallery">${gallery}</div>
<div class="save"><button type="submit">Save decoration</button></div>
</form>
<script>(function(){
var f=document.getElementById("form"),deco=document.getElementById("deco");
function earsUrl(style){var q=new URLSearchParams({s:style||f.style.value||"pointy",c:f.color.value.slice(1),i:f.inner.value.slice(1)});if(f.with_bow.checked)q.set("b",f.bow.value.slice(1));return "/i/xitter/decoration/ears.svg?"+q}
function update(e){
	if(e&&e.target&&["style","color","inner","bow","with_bow"].indexOf(e.target.name)>=0)f.querySelector('input[name=choice][value=ears]').checked=true;
	var c=f.querySelector("input[name=choice]:checked");var v=c?c.value:"none";
	[].forEach.call(f.querySelectorAll(".styles label"),function(l){var s=l.querySelector("input").value;l.querySelector("img").src=earsUrl(s)});
	if(v==="none"){deco.hidden=true;return}
	deco.hidden=false;
	deco.src=v==="ears"?earsUrl():"/i/xitter/decoration/"+v.slice(8)+".png?animated=1";
}
f.addEventListener("input",function(e){if(e.target.id!=="deco-search")update(e)});f.addEventListener("change",function(e){if(e.target.id!=="deco-search")update(e)});
var search=document.getElementById("deco-search"),count=document.getElementById("deco-count"),tiles=[].slice.call(document.querySelectorAll("#gallery > label"));
search.addEventListener("keydown",function(e){if(e.key==="Enter")e.preventDefault()});
search.addEventListener("input",function(){
	var words=search.value.toLowerCase().split(/\\s+/).filter(Boolean),shown=0;
	tiles.forEach(function(t){var terms=t.getAttribute("data-terms");var on=words.every(function(w){return terms.indexOf(" "+w)>=0});t.hidden=!on;if(on)shown++});
	count.textContent=words.length?(shown?shown+(shown===1?" decoration":" decorations"):"No decorations match. Try a shorter word."):"";
});
})();</script>`,
	});
}

export async function decorationRoute(
	req: Request,
	viewer: Viewer,
): Promise<Response> {
	const [u] =
		await sql`select decoration from users where id = ${viewer.id}::bigint`;
	const current = parseDecoration(u?.decoration);
	if (req.method !== "POST")
		return page(
			req,
			viewer,
			current,
			new URL(req.url).searchParams.has("saved")
				? "Saved. It shows everywhere within a minute."
				: "",
		);
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf)
		return page(req, viewer, current, "That form is out of date. Try again.");
	const choice = String(f?.get("choice") ?? "none");
	const next = choice.startsWith("discord:")
		? parseDecoration({ type: "discord", asset: choice.slice(8) })
		: choice === "ears"
			? parseDecoration({
					type: "ears",
					style: f?.get("style"),
					color: f?.get("color"),
					inner: f?.get("inner"),
					bow: f?.get("with_bow") ? f?.get("bow") : null,
				})
			: null;
	await sql`update users set decoration = ${next ? JSON.stringify(next) : null}::text::jsonb where id = ${viewer.id}::bigint`;
	return new Response(null, {
		status: 303,
		headers: { location: "/account/decoration?saved" },
	});
}
