// X's automated account label: Settings > Your account > Automation names the
// account that runs this one, and its profile then reads "Automated by @owner"
// (model.ts). Setting it up is X's own flow (/i/flow/enable_automated_account),
// which asks to sign in to the managing account; ours is a page,
// /account/automation, asking for that account's password the same way.

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { PostError } from "./posts";
import { hit, used } from "./ratelimit";

type Vars = Record<string, any>;

export const automationHandlers: Record<string, (v: Viewer, vars: Vars) => Promise<unknown>> = {
	// the settings page reads account_label.managed_label.owner_screen_name
	UserAccountLabel: async (v, vars) => {
		const id = /^\d{1,19}$/.test(String(vars.rest_id ?? "")) ? String(vars.rest_id) : v.id;
		const [u] = await sql`select (select m.screen_name from users m where m.id = u.automated_by) as owner from users u where u.id = ${id}::bigint`;
		if (!u) throw new PostError("User not found.", 50);
		return { data: { user: { result: { __typename: "User", account_label: u.owner ? { managed_label: { owner_screen_name: u.owner } } : {} } } } };
	},
	DisableUserAccountLabel: async (v) => {
		await sql`update users set automated_by = null where id = ${v.id}::bigint`;
		return { data: { disable_user_account_label: "Done" } };
	},
};

function automationPage(req: Request, viewer: Viewer, owner: string | null, error = "") {
	return accountPage({
		req,
		viewer,
		title: "Automation",
		referrer: null,
		status: error ? 400 : 200,
		body: `<form method="post" action="/account/automation">
	<h1>Set up account automation</h1>
	<p class="dim">Connect the account that runs @${esc(viewer.screen_name)}. Its profile then reads "Automated by" that account, so people know it's a bot and who answers for it.${owner ? ` Right now it's run by <b>@${esc(owner)}</b>.` : ""}</p>
	${error ? `<p class="error">${esc(error)}</p>` : ""}
	<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
	<label for="owner">Managing account</label><input id="owner" name="owner" autocomplete="off" placeholder="@username" required>
	<label for="password">That account's password</label><input id="password" name="password" type="password" autocomplete="off" required>
	<button type="submit">Connect</button>
	<p class="dim">The password only proves the managing account agrees; it isn't kept. <a href="/settings/account/automation">Back to settings</a></p>
</form>`,
	});
}

export async function automationRoute(req: Request, viewer: Viewer): Promise<Response> {
	const [me] = await sql`select (select m.screen_name from users m where m.id = u.automated_by) as owner from users u where u.id = ${viewer.id}::bigint`;
	const current: string | null = me?.owner ?? null;
	if (req.method !== "POST") return automationPage(req, viewer, current);
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return automationPage(req, viewer, current, "That form is out of date. Try again.");
	const name = String(f?.get("owner") ?? "").trim().replace(/^@/, "");
	const password = String(f?.get("password") ?? "");
	if (!/^\w{1,15}$/.test(name)) return automationPage(req, viewer, current, "Enter the managing account's username.");
	// the same tries as signing in to that account
	const account = name.toLowerCase();
	if (used("password", account)) return automationPage(req, viewer, current, "Too many tries for that account. Wait 15 minutes.");
	const [owner] = await sql`select id::text, screen_name, password_hash, status, automated_by from users where lower(screen_name) = ${account}`;
	const ok = owner && (await Bun.password.verify(password, owner.password_hash).catch(() => false));
	if (!ok) {
		hit("password", account);
		return automationPage(req, viewer, current, "Wrong username or password.");
	}
	if (owner.id === viewer.id) return automationPage(req, viewer, current, "An account can't run itself. Pick the account of the person or team behind it.");
	if (owner.status === "suspended") return automationPage(req, viewer, current, "That account is suspended.");
	if (owner.automated_by) return automationPage(req, viewer, current, "That account is automated itself. The managing account has to be run by a person.");
	await sql`update users set automated_by = ${owner.id}::bigint where id = ${viewer.id}::bigint`;
	return new Response(null, { status: 303, headers: { location: "/settings/account/automation" } });
}
