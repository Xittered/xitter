// Settings > Labels and checkmarks: hide the parody, commentary and fan
// labels, or the checkmarks, on every account, for this viewer only. Kept in
// users.preferences (hide_parody_labels, hide_checkmarks); model.ts leaves
// them out of what it sends while the request carries the flags
// (staff-access.ts). The public API at /api/v1 still reports them.

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";

const CSS = `.choices{display:grid;gap:8px;margin-bottom:16px}
.choice{display:flex;align-items:flex-start;gap:12px;margin:0;border:1px solid var(--border);border-radius:16px;padding:12px 14px;cursor:pointer;font-size:15px;line-height:20px;color:var(--text)}
.choice:has(input:checked){border-color:var(--text)}
.choice input{width:20px;min-height:20px;height:20px;margin:0;padding:0;flex:none;accent-color:var(--accent)}
@media (hover:hover){.choice:hover{background:var(--hover)}}`;

type Hidden = { parody: boolean; checks: boolean; ads: boolean };

const hiddenOf = (viewer: Viewer): Hidden => ({ parody: !!viewer.hide_parody_labels, checks: !!viewer.hide_checkmarks, ads: !!viewer.hide_ads });

async function page(req: Request, viewer: Viewer, hidden: Hidden, error = "") {
	const choice = (name: string, on: boolean, title: string, text: string) =>
		`<label class="choice"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""}><span><b>${esc(title)}</b><br><span class="dim">${esc(text)}</span></span></label>`;
	return accountPage({
		req,
		viewer,
		title: "Labels and checkmarks",
		css: CSS,
		status: error ? 400 : 200,
		body: `<h1>Labels and checkmarks</h1>
<p class="dim">Choose what you'd rather not see. Only you see the change.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/account/labels">
<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
<div class="choices">
${choice("parody", hidden.parody, "Hide parody labels", "No parody, commentary or fan label shows on any account. Labels from staff and bots stay.")}
${choice("checks", hidden.checks, "Hide checkmarks", "No blue, gold or grey checkmark shows on any account.")}
${choice("ads", hidden.ads, "Hide ads", "No ads show in your timeline. It's free.")}
</div>
<button type="submit">Save</button>
</form>`,
	});
}

export async function parodyLabelsRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return page(req, viewer, hiddenOf(viewer));
	const form = await req.formData().catch(() => undefined);
	if (String(form?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, hiddenOf(viewer), "That form is out of date. Try again.");
	const prefs = JSON.stringify({ hide_parody_labels: form?.has("parody") ?? false, hide_checkmarks: form?.has("checks") ?? false, hide_ads: form?.has("ads") ?? false });
	await sql`update users set preferences = coalesce(preferences, '{}') || ${prefs}::text::jsonb where id = ${viewer.id}::bigint`;
	return new Response(null, { status: 303, headers: { location: "/account/labels" } });
}
