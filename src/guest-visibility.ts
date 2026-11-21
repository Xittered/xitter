import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";

const CSS = `.choice{display:flex;align-items:flex-start;gap:12px;margin:0 0 16px;border:1px solid var(--border);border-radius:16px;padding:12px 14px;cursor:pointer;font-size:15px;line-height:20px;color:var(--text)}
.choice:has(input:checked){border-color:var(--text)}
.choice input{width:20px;min-height:20px;height:20px;margin:0;padding:0;flex:none;accent-color:var(--accent)}
@media (hover:hover){.choice:hover{background:var(--hover)}}`;

async function hiddenNow(viewer: Viewer) {
	const [row] = await sql`select coalesce(preferences->>'hide_from_guests', '') = 'true' as hidden from users where id = ${viewer.id}::bigint`;
	return !!row?.hidden;
}

function page(req: Request, viewer: Viewer, hidden: boolean, error = "") {
	return accountPage({
		req,
		viewer,
		title: "Signed-out visitors",
		css: CSS,
		status: error ? 400 : 200,
		body: `<h1>Signed-out visitors</h1>
<p class="dim">People without an account can open public profiles and posts from a link. You can keep yours to people who are signed in.</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/account/guests">
<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
<label class="choice"><input type="checkbox" name="hide" value="1"${hidden ? " checked" : ""}><span><b>Hide my posts from signed-out visitors</b><br><span class="dim">They see your profile as protected. Everyone signed in sees it as before.</span></span></label>
<button type="submit">Save</button>
</form>`,
	});
}

export async function guestVisibilityRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return page(req, viewer, await hiddenNow(viewer));
	const form = await req.formData().catch(() => undefined);
	if (String(form?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, await hiddenNow(viewer), "That form is out of date. Try again.");
	const prefs = JSON.stringify({ hide_from_guests: form?.has("hide") ?? false });
	await sql`update users set preferences = coalesce(preferences, '{}') || ${prefs}::text::jsonb where id = ${viewer.id}::bigint`;
	return new Response(null, { status: 303, headers: { location: "/account/guests" } });
}
