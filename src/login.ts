// The rules page, and sign-in by form post for scripts. People sign in and up
// in X's own dialog, served by onboarding.ts.

import { recordSignIn } from "./login-history";
import { login, sessionCookies } from "./auth";
import { settings } from "./settings";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

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
	.rules { line-height: 1.5; overflow-wrap: anywhere; }
        .rules p { margin: 0 0 12px; }
        .rules h1, .rules h2, .rules h3, .rules h4, .rules h5, .rules h6 { line-height: 1.25; margin: 20px 0 10px; }
        .rules h1 { font-size: 24px; }
        .rules h2 { font-size: 21px; }
        .rules h3 { font-size: 18px; }
        .rules ul, .rules ol { padding-left: 24px; margin: 8px 0 16px; }
        .rules li { margin: 4px 0; }
        .rules blockquote { border-left: 3px solid #536471; margin: 12px 0; padding-left: 12px; color: #aab8c2; }
        .rules pre, .rules code { background: #16181c; border-radius: 4px; }
        .rules code { padding: 2px 4px; }
        .rules pre { padding: 12px; overflow-x: auto; }
        .rules pre code { padding: 0; }
        .rules hr { border: 0; border-top: 1px solid #333639; margin: 16px 0; }
        .rules > :first-child { margin-top: 0; }
        .rules > :last-child { margin-bottom: 0; }
	a { color: #1d9bf0; text-decoration: none; }
	label { color: #71767b; font-size: 13px; }
	input, textarea { padding: 12px; border: 1px solid #333639; border-radius: 4px; background: #000; color: inherit; font: inherit; }
	input:focus, textarea:focus { outline: 2px solid #1d9bf0; border-color: transparent; }
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

function signedIn(session: { token: string; csrf: string; userId: string }): Response {
	const headers = new Headers({ location: "/home" });
	for (const c of sessionCookies(session)) headers.append("set-cookie", c);
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
	const session = username && password ? await login(username, password) : undefined;
	if (!session) return new Response("Wrong username or password.", { status: 401 });
	await recordSignIn(req, session);
	return signedIn(session);
}

// shown to signed-in accounts while an admin has maintenance mode on
export function maintenancePage(): Response {
	return html(
		layout(
			"Maintenance",
			`<form>
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Back soon</h1>
	<p class="rules">${esc(settings().operations.message)}</p>
</form>`,
		),
		503,
	);
}

// the instance's rules, as written in the admin panel: blank lines split paragraphs
export function rulesPage(): Response {
        const rules = settings().rules.trim();
        const renderedRules = rules
                ? sanitizeHtml(marked.parse(rules, { async: false }), {
                        allowedTags: [
                                "h1", "h2", "h3", "h4", "h5", "h6",
                                "p", "br", "hr", "strong", "b", "em", "i", "del", "s",
                                "ul", "ol", "li", "blockquote", "pre", "code",
                                "a", "table", "thead", "tbody", "tr", "th", "td",
                        ],
                        allowedAttributes: {
                                a: ["href", "title"],
                        },
                        allowedSchemes: ["http", "https", "mailto"],
                        allowProtocolRelative: false,
                })
                : "";

        const body = renderedRules
                ? `<div class="rules">${renderedRules}</div>`
                : `<p class="alt">This instance hasn't written any rules yet.</p>`;

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
