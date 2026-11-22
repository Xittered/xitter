import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { fontSlug, prepareFonts, validateFamily } from "./fonts";
import { CHIRP, FONT_SUGGESTIONS, type Theme } from "./themes/presets";

export type FontPref = { ui?: string; display?: string };

export function fontPrefOf(raw: unknown): FontPref {
	if (!raw || typeof raw !== "object") return {};
	const r = raw as Record<string, unknown>;
	const ui = validateFamily(r.ui);
	const display = validateFamily(r.display);
	return { ...(ui ? { ui } : {}), ...(display ? { display } : {}) };
}

const TEXT = "body,.css-146c3p1,.css-1jxf684";
const DISPLAY = '[data-testid="User-Name"] span:first-of-type,[data-testid="UserName"],h1,h2';

export function fontPrefHead(raw: unknown, theme: Theme | null): string {
	const pref = fontPrefOf(raw);
	const ui = theme?.font?.ui ? undefined : pref.ui;
	const display = theme?.font?.display ? undefined : pref.display;
	if (!ui && !display) return "";
	const names = [ui, display].filter((n, i, a): n is string => !!n && a.indexOf(n) === i);
	const links = names.map((n) => `<link rel="stylesheet" href="/i/xitter/fonts/${fontSlug(n)}/fonts.css">`).join("");
	let css = "";
	if (ui) css += `${TEXT}{font-family:"${ui}",${CHIRP}!important}`;
	if (display) css += `${DISPLAY}{font-family:"${display}",${CHIRP}!important}`;
	return `${links}<style>${css}</style>`;
}

async function current(userId: string): Promise<FontPref> {
	const [u] = await sql`select preferences->'font' as font from users where id = ${userId}::bigint`;
	return fontPrefOf(u?.font);
}

async function page(req: Request, viewer: Viewer, pref: FontPref, notes: { error?: string; warnings?: string[]; saved?: boolean } = {}) {
	const options = FONT_SUGGESTIONS.map((n) => `<option value="${esc(n)}">`).join("");
	const field = (name: "ui" | "display", label: string, placeholder: string, sample: string) => `<label class="card">
		<b>${label}</b>
		<input type="text" name="${name}" list="font-list" value="${esc(pref[name] ?? "")}" placeholder="${placeholder}" maxlength="40" autocomplete="off" data-sample="${name}">
		<span class="meta" id="sample-${name}" style="font-size:20px;line-height:28px;margin-top:6px${pref[name] ? `;font-family:&quot;${esc(pref[name]!)}&quot;` : ""}">${sample}</span>
	</label>`;
	const links = [pref.ui, pref.display]
		.filter((n, i, a): n is string => !!n && a.indexOf(n) === i)
		.map((n) => `<link rel="stylesheet" href="/i/xitter/fonts/${fontSlug(n)}/fonts.css">`)
		.join("");
	return accountPage({
		req,
		viewer,
		title: "Font",
		status: notes.error || notes.warnings?.length ? 400 : 200,
		head: links,
		body: `<h1>Font</h1>
	<p class="dim">Pick any family from Google Fonts by its name, or one from the list. Leave a field empty for X's own font. A theme with its own font keeps it.</p>
	${notes.error ? `<p class="error">${esc(notes.error)}</p>` : ""}
	${(notes.warnings ?? []).map((w) => `<p class="error">${esc(w)}</p>`).join("")}
	${notes.saved ? '<p class="dim">Saved. Reload the app to see it.</p>' : ""}
	<form method="post" action="/account/font">
		<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
		<datalist id="font-list">${options}</datalist>
		${field("ui", "Text", "Chirp", "The quick brown fox posts on Xitter")}
		${field("display", "Display names and headings", "Same as text", "Ada Lovelace")}
		<p class="split"><button type="submit">Save</button><button type="submit" name="reset" value="1" class="secondary">Use X's font</button></p>
	</form>
	<script>document.querySelectorAll("[data-sample]").forEach(function(i){i.addEventListener("change",function(){var n=i.value.trim();var s=document.getElementById("sample-"+i.dataset.sample);if(!/^[A-Za-z0-9 ]{1,40}$/.test(n)){s.style.fontFamily="";return}var l=document.createElement("link");l.rel="stylesheet";l.href="/i/xitter/fonts/"+n.toLowerCase().replace(/ +/g,"-")+"/fonts.css?family="+encodeURIComponent(n);document.head.appendChild(l);s.style.fontFamily='"'+n+'"'})})</script>`,
	});
}

export async function fontRoute(req: Request, viewer: Viewer): Promise<Response> {
	const pref = await current(viewer.id);
	if (req.method !== "POST") return page(req, viewer, pref, { saved: new URL(req.url).searchParams.has("saved") });
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, pref, { error: "That form is out of date. Try again." });
	let next: FontPref = {};
	if (String(f?.get("reset") ?? "") !== "1") {
		const wanted: FontPref = {};
		for (const key of ["ui", "display"] as const) {
			const raw = String(f?.get(key) ?? "").trim();
			if (!raw) continue;
			const name = validateFamily(raw);
			if (!name) return page(req, viewer, pref, { error: `"${raw.slice(0, 40)}" isn't a font family.` });
			wanted[key] = name;
		}
		const prep = await prepareFonts(wanted);
		if (prep.warnings.length) return page(req, viewer, { ...pref, ...wanted }, { warnings: prep.warnings });
		next = prep.font;
	}
	await sql`update users set preferences = jsonb_set(coalesce(preferences, '{}'), '{font}', ${JSON.stringify(next)}::text::jsonb) where id = ${viewer.id}::bigint`;
	return new Response(null, { status: 303, headers: { location: "/account/font?saved" } });
}
