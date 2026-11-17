// Which web client a request gets, when the instance serves more than one
// (build.ts clientBuilds): the person's own pick (users.preferences.web_client)
// when the hoster lets people pick, else the instance default. A cookie carries
// the pick to the requests a page makes, which come before anyone's account is
// read, and to signed-out visitors.
// Settings > Twitter client (/account/client) is where people switch. The page
// also opens on its own at /settings/xitter/client, for clients without our
// settings screens, and ?client=<id> on any page switches in one step.

import { accountPage, esc } from "./account-page";
import { parseCookies, type Viewer } from "./auth";
import { type ClientEntry, clientBuild, clientBuilds } from "./build";
import { sql } from "./db";
import { settings } from "./settings";

export const CLIENT_COOKIE = "xitter_client";

export function defaultClient(): ClientEntry | undefined {
	return clientBuild(settings().clients.default) ?? clientBuilds()[0];
}

export const choiceAllowed = () => settings().clients.user_choice && clientBuilds().length > 1;

// a person's stored pick, or the cookie's, when they may pick at all
export function chosenClient(pick: string | undefined | null): ClientEntry | undefined {
	return (choiceAllowed() && clientBuild(pick)) || defaultClient();
}

export const requestClient = (req: Request) => chosenClient(parseCookies(req)[CLIENT_COOKIE]);

export const clientCookie = (id: string) => `${CLIENT_COOKIE}=${encodeURIComponent(id)}; Path=/; Max-Age=31536000; SameSite=Lax`;
export const clearClientCookie = () => `${CLIENT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;

export async function saveClient(viewer: Viewer, id: string) {
	await sql`update users set preferences = jsonb_set(coalesce(preferences, '{}'), '{web_client}', to_jsonb(${id}::text), true) where id = ${viewer.id}::bigint`;
}

// ?client=<id>: switch, then the same page without the parameter
export async function switchByQuery(url: URL, viewer: Viewer | undefined): Promise<Response | undefined> {
	const id = url.searchParams.get("client");
	if (id === null) return undefined;
	const rest = new URL(url);
	rest.searchParams.delete("client");
	// a path of "//host/..." would be read as another site's address
	const headers = new Headers({ location: rest.pathname.replace(/^[/\\]+/, "/") + rest.search, "cache-control": "no-store" });
	const build = clientBuild(id);
	if (build && choiceAllowed()) {
		if (viewer) await saveClient(viewer, build.id);
		headers.append("set-cookie", clientCookie(build.id));
	}
	return new Response(null, { status: 302, headers });
}

async function page(req: Request, viewer: Viewer, current: ClientEntry | undefined, error = "") {
	const builds = clientBuilds();
	const fallback = defaultClient();
	const allowed = choiceAllowed();
	const options = builds
		.map((b) => `<label class="card" style="cursor:pointer"><span class="split"><span><b style="color:var(--text)">${esc(b.label)}</b>${b.id === fallback?.id ? ' <span class="meta">(default)</span>' : ""}</span><input type="radio" name="client" value="${esc(b.id)}" style="width:auto;min-height:0"${b.id === current?.id ? " checked" : ""}${allowed ? "" : " disabled"}></span></label>`)
		.join("");
	return accountPage({
		req,
		viewer,
		title: "Twitter client",
		status: error ? 400 : 200,
		body: `<h1>Twitter client</h1>
<p class="dim">Pick the web client you use on ${esc(settings().instance_name)}. Your account, posts and follows stay the same in each; the page reloads in the one you pick.</p>
${allowed ? "" : `<p class="box">${builds.length > 1 ? "This instance doesn't let people pick their client." : "This instance serves one client only."}</p>`}
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/account/client" target="_top" style="justify-items:stretch">
<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
${options}
${allowed ? '<button type="submit" style="justify-self:start">Switch client</button>' : ""}
</form>`,
	});
}

export async function clientRoute(req: Request, viewer: Viewer, current: ClientEntry | undefined): Promise<Response> {
	if (req.method !== "POST") return page(req, viewer, current);
	const form = await req.formData().catch(() => undefined);
	if (String(form?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, current, "That form is out of date. Try again.");
	if (!choiceAllowed()) return page(req, viewer, current, "This instance doesn't let people pick their client.");
	const build = clientBuild(String(form?.get("client") ?? ""));
	if (!build) return page(req, viewer, current, "Pick one of the clients listed.");
	await saveClient(viewer, build.id);
	// the whole page reloads: a client can't swap itself out from inside
	return new Response(null, { status: 303, headers: { location: "/home", "set-cookie": clientCookie(build.id), "cache-control": "no-store" } });
}
