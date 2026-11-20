// Settings > Profile labels: hide the parody, commentary and fan labels on
// every account, for this viewer only. Kept in
// users.preferences.hide_parody_labels; model.ts leaves the label out of
// what it sends while the request carries the flag (staff-access.ts).

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";

const CSS = `.choices{display:grid;gap:8px;margin-bottom:16px}
.choice{display:flex;align-items:flex-start;gap:12px;margin:0;border:1px solid var(--border);border-radius:16px;padding:12px 14px;cursor:pointer;font-size:15px;line-height:20px;color:var(--text)}
.choice:has(input:checked){border-color:var(--text)}
.choice input{width:20px;min-height:20px;height:20px;margin:0;padding:0;flex:none;accent-color:var(--accent)}
@media (hover:hover){.choice:hover{background:var(--hover)}}`;

async function page(req: Request, viewer: Viewer, hidden: boolean, error = "") {
	const choice = (value: string, on: boolean, title: string, text: string) =>
		`<label class="choice"><input type="radio" name="labels" value="${value}"${on ? " checked" : ""}><span><b>${esc(title)}</b><br><span class="dim">${esc(text)}</span></span></label>`;
	return accountPage({
		req,
		viewer,
		title: "Profile labels",
		css: CSS,
		status: error ? 400 : 200,
		body: `<h1>Profile labels</h1>
<p class="dim">Whether you see the parody, commentary and fan labels accounts put on themselves. Only you see the change.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/account/labels">
<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
<div class="choices">
${choice("show", !hidden, "Show", "The label shows under the name on profiles, posts and search results, as on X.")}
${choice("hide", hidden, "Hide", "No parody, commentary or fan label shows on any account. Labels from staff and bots stay.")}
</div>
<button type="submit">Save</button>
</form>`,
	});
}

export async function parodyLabelsRoute(req: Request, viewer: Viewer): Promise<Response> {
	const hidden = !!viewer.hide_parody_labels;
	if (req.method !== "POST") return page(req, viewer, hidden);
	const form = await req.formData().catch(() => undefined);
	if (String(form?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, hidden, "That form is out of date. Try again.");
	const choice = String(form?.get("labels") ?? "");
	if (choice !== "show" && choice !== "hide") return page(req, viewer, hidden, "Choose show or hide.");
	await sql`update users set preferences = jsonb_set(coalesce(preferences, '{}'), '{hide_parody_labels}', ${choice === "hide" ? "true" : "false"}::text::jsonb) where id = ${viewer.id}::bigint`;
	return new Response(null, { status: 303, headers: { location: "/account/labels" } });
}
