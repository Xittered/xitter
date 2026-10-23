// X's web client has its own screens at these paths. Every other /account,
// /admin, and /federation/superadmin URL is ours. If a signed-in GET misses
// an exact handler it must not fall through to the client shell: the client
// paints "Hmm...this page doesn't exist" for paths it does not own.

const CLIENT_ACCOUNT = new Set(["/account", "/account/switch"]);

export function blocksClientShell(pathname: string): boolean {
	if (CLIENT_ACCOUNT.has(pathname) || pathname.startsWith("/account/not_my_account/")) return false;
	if (pathname.startsWith("/account/")) return true;
	if (pathname === "/admin" || pathname.startsWith("/admin/")) return true;
	return pathname === "/federation/superadmin" || pathname.startsWith("/federation/superadmin/");
}

export function trailingSlashTarget(pathname: string): string | null {
	if (pathname.length <= 1 || !pathname.endsWith("/")) return null;
	const to = pathname.replace(/\/+$/, "");
	if (!to || to === pathname) return null;
	if (blocksClientShell(to) || blocksClientShell(pathname) || CLIENT_ACCOUNT.has(to) || to.startsWith("/account/not_my_account/")) return to;
	return null;
}

export function xitterNotFoundPage(): Response {
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page not found · Xitter</title></head>
<body data-xitter-page="missing"><h1>Xitter has no page here</h1><p><a href="/settings">Back to settings</a></p></body></html>`;
	return new Response(html, {
		status: 404,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
	});
}

// The Xitter section lives inside the client's own Settings, at /settings/xitter.
// The client paints its nav and its Settings list; tidy.ts frames our page
// (served at its /account address) into the detail column. A browser tab that
// opens an /account address is sent to its place under /settings/xitter.
export const XITTER_SECTION = "/settings/xitter";
export const FRAMED_ROOTS = ["/federation/superadmin", "/account/xitter", "/account/apps", "/account/email", "/account/2fa", "/account/passkeys", "/account/notices", "/account/invites", "/account/api", "/account/notes", "/account/automation", "/account/instances", "/account/import", "/account/decoration", "/account/organisation", "/account/decor", "/account/theme", "/account/migrate"];

export function settingsChrome(pathname: string): boolean {
	return FRAMED_ROOTS.some((root) => pathname === root || pathname.startsWith(`${root}/`));
}

// /account/theme -> /settings/xitter/theme (only pages a browser opens, so not
// /federation/superadmin/enter, which is a form's target)
export function clientRouteFor(pathname: string): string | null {
	if (pathname === "/account/xitter") return XITTER_SECTION;
	if (pathname === "/federation/superadmin") return `${XITTER_SECTION}/superadmin`;
	if (pathname.startsWith("/account/") && settingsChrome(pathname)) return `${XITTER_SECTION}/${pathname.slice("/account/".length)}`;
	return null;
}

// /settings/xitter/theme -> /account/theme
export function framedPathFor(pathname: string): string | null {
	if (pathname === XITTER_SECTION) return "/account/xitter";
	if (pathname === `${XITTER_SECTION}/superadmin`) return "/federation/superadmin";
	if (!pathname.startsWith(`${XITTER_SECTION}/`)) return null;
	const page = `/account/${pathname.slice(XITTER_SECTION.length + 1)}`;
	return settingsChrome(page) ? page : null;
}

// a browser tab, not a frame, a script's fetch or a test's request
export function opensInTab(req: Request): boolean {
	return req.headers.get("sec-fetch-dest") === "document";
}

// framed pages may sit only inside this origin's own pages
export const FRAMED_HEADERS = { "x-frame-options": "SAMEORIGIN", "content-security-policy": "frame-ancestors 'self'" } as const;
