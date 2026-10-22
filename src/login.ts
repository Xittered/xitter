// The rules page, and sign-in by form post for scripts. People sign in and up
// in X's own dialog, served by onboarding.ts.

import { recordSignIn } from "./login-history";
import { login, sessionCookies } from "./auth";
import { loadLook, nightModeCookies } from "./themes/api";
import { hit, used } from "./ratelimit";
import { settings } from "./settings";

export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export const layout = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(settings().instance_name)}</title>
<link rel="icon" type="image/png" href="/public/favicon.png">
<style>
	.logo { width: 200px; margin: 0 0 16px; }
	body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #000; color: #e7e9ea; font: 15px system-ui, sans-serif; }
	form { width: min(560px, calc(100vw - 32px)); display: grid; gap: 12px; padding: 32px 0; }
	h1 { margin: 0 0 8px; font-size: 28px; }
	.alt { margin: 8px 0 0; color: #71767b; }
	.rules { margin: 0 0 4px; white-space: pre-wrap; line-height: 1.45; }
	a { color: var(--xt-accent, #1d9bf0); text-decoration: none; }
	label { color: #71767b; font-size: 13px; }
	input, textarea { padding: 12px; border: 1px solid #333639; border-radius: 4px; background: #000; color: inherit; font: inherit; }
	input:focus, textarea:focus { outline: 2px solid var(--xt-accent, #1d9bf0); border-color: transparent; }
	textarea { min-height: 120px; resize: vertical; }
	button { padding: 12px 20px; border: 0; border-radius: 999px; background: #eff3f4; color: #0f1419; font: inherit; font-weight: 700; cursor: pointer; }
	button.ghost { justify-self: start; padding: 6px 16px; background: none; border: 1px solid #536471; color: #eff3f4; }
	button:disabled { opacity: .5; cursor: default; }
	.item { border: 1px solid #2f3336; border-radius: 16px; padding: 16px; display: grid; gap: 8px; }
	.item p { margin: 0; white-space: pre-wrap; line-height: 1.45; }
	.item .meta { color: #71767b; font-size: 13px; }
	.item.strike { border-color: rgba(244,33,46,.5); }
	.item.warning { border-color: rgba(255,212,0,.4); }
	.error { color: #f4212e; margin: 0; }
	[hidden] { display: none !important; }
	.source { position: fixed; bottom: 12px; left: 0; right: 0; text-align: center; color: #71767b; font-size: 13px; }
</style>
</head>
<body>
${body}
<p class="source">${esc(settings().instance_name)} runs <a href="${esc(settings().source_url)}">open source</a> software (AGPL-3.0)</p>
</body>
</html>`;

export const html = (body: string, status = 200) =>
	new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

async function signedIn(session: { token: string; csrf: string; userId: string }): Promise<Response> {
	const headers = new Headers({ location: "/home" });
	for (const c of sessionCookies(session)) headers.append("set-cookie", c);
	for (const c of nightModeCookies(await loadLook(session.userId))) headers.append("set-cookie", c);
	return new Response(null, { status: 303, headers });
}

async function fields(req: Request): Promise<Record<string, string>> {
	const form = await req.formData().catch(() => undefined);
	const out: Record<string, string> = {};
	if (form) for (const [k, v] of form) if (typeof v === "string") out[k] = v;
	return out;
}

// For scripts and tests; people sign in through X's own dialog (onboarding.ts).
export async function handleLogin(req: Request): Promise<Response> {
	const f = await fields(req);
	const username = (f.username ?? "").replace(/^@/, "").trim();
	const password = f.password ?? "";
	const account = username.toLowerCase();
	if (username && used("password", account)) return new Response("Too many tries for this account. Wait 15 minutes.", { status: 429 });
	const session = username && password ? await login(username, password) : undefined;
	if (!session) {
		if (username) hit("password", account);
		return new Response("Wrong username or password.", { status: 401 });
	}
	await recordSignIn(req, session);
	return signedIn(session);
}

export function outagePage(sentence: string): Response {
	const res = html(
		layout(
			"Trouble",
			`<form>
	<img class="logo" src="/public/logo-dark.png" alt="">
	<h1>Xitter is having trouble right now</h1>
	<p class="rules">${esc(sentence)}</p>
	<p class="alt"><a href="/">Retry</a></p>
</form>`,
		),
		503,
	);
	res.headers.set("retry-after", "60");
	return res;
}

// shown while an admin has maintenance mode on: to signed-in accounts, and to
// guests, who get a way to the sign-in form so staff can still get in
export function maintenancePage(staffLink = false): Response {
	return html(
		layout(
			"Maintenance",
			`<form>
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Back soon</h1>
	<p class="rules">${esc(settings().operations.message)}</p>${staffLink ? `\n\t<p class="alt"><a href="/?staff=1">Staff sign in</a></p>` : ""}
</form>`,
		),
		503,
	);
}

// the instance's rules, as written in the admin panel: blank lines split paragraphs
export function rulesPage(): Response {
	const rules = settings().rules.trim();
	const body = rules ? rules.split(/\n\s*\n/).map((p) => `<p class="rules">${esc(p)}</p>`).join("") : `<p class="alt">This instance hasn't written any rules yet.</p>`;
	return html(
		layout(
			"Rules",
			`<form>
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Rules</h1>
	${body}
	<p class="alt"><a href="/">Sign in or create an account</a></p>
</form>`,
		),
	);
}
