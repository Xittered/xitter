// Direct OAuth flow checks against a migrated, disposable local database.
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { type Viewer, sessionKey } from "../src/auth";
import { connectedAppsRoute, developerAppsRoute, oauthAppIcon, oauthAuthorize, oauthToken, validRedirect } from "../src/oauth";
import { publicApi } from "../src/public-api";
import { PUBLIC_ORIGIN } from "../src/config";
import { fetcher } from "../src/oauth-metadata";
import { codeAt, newSecret } from "../src/totp";
import "../src/admin"; // first: oauth-admin.ts and admin.ts import each other
import { oauthAppActions } from "../src/oauth-admin";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const developer = newId(), account = newId(), other = newId();
const viewer = (id: string) => ({ id, screen_name: `oauth_${id}`, status: "active", role: null, csrf: `csrf-${id}`, token: `session-${id}` }) as Viewer;
const appOwner = viewer(developer), user = viewer(account);
const registeredRedirect = "https://example.org/callback?source=xitter";
const origin = PUBLIC_ORIGIN;
const postForm = (path: string, fields: Record<string, string>) => new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });

async function approve(clientId: string, scope: "read" | "write" = "read", redirect = registeredRedirect) {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const args = { response_type: "code", client_id: clientId, redirect_uri: redirect, state: "random-state-123", scope, code_challenge: challenge, code_challenge_method: "S256" };
	const url = new URL(`${origin}/oauth/authorize?${new URLSearchParams(args)}`);
	assert.equal((await oauthAuthorize(new Request(url), url, user)).status, 200, "consent page opens");
	const res = await oauthAuthorize(postForm("/oauth/authorize", { ...args, csrf: user.csrf, decision: "approve" }), url, user);
	assert.equal(res.status, 303);
	const callback = new URL(res.headers.get("location")!);
	assert.equal(callback.searchParams.get("state"), args.state);
	const expected = new URL(redirect);
	assert.equal(callback.origin + callback.pathname, expected.origin + expected.pathname);
	return { code: callback.searchParams.get("code")!, verifier, redirect };
}

const exchange = (clientId: string, grant: { code: string; verifier: string; redirect: string }, verifier = grant.verifier) => oauthToken(postForm("/oauth/token", {
	grant_type: "authorization_code", client_id: clientId, redirect_uri: grant.redirect, code: grant.code, code_verifier: verifier,
}));
const redirect = registeredRedirect;

try {
	for (const id of [developer, account, other]) await sql`insert into users(id, screen_name, name, password_hash) values(${id}::bigint, ${`oauth_${id}`}, 'OAuth test', 'unused')`;
	assert(!validRedirect("http://example.org/callback"), "plain HTTP remote redirect rejected");
	assert(!validRedirect("https://example.org/callback#fragment"), "fragment rejected");
	assert(validRedirect("http://127.0.0.1:3210/callback"), "loopback redirect allowed");
	assert.equal((await developerAppsRoute(postForm("/account/apps/developer", { csrf: "wrong", action: "register", name: "Bad", redirect_uri: redirect }), appOwner)).status, 403, "registration needs CSRF");
	const registered = await developerAppsRoute(postForm("/account/apps/developer", { csrf: appOwner.csrf, action: "register", name: "Example app", redirect_uri: redirect }), appOwner);
	assert.equal(registered.status, 200);
	const [client] = await sql`select id::text from oauth_clients where owner_id = ${developer}::bigint`;
	assert(client?.id);
	const wrongRedirect = new URL(`${origin}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: client.id, redirect_uri: "https://evil.example/callback", state: "random-state-123", scope: "read", code_challenge: createHash("sha256").update("a".repeat(43)).digest("base64url"), code_challenge_method: "S256" })}`);
	assert.equal((await oauthAuthorize(new Request(wrongRedirect), wrongRedirect, user)).status, 400, "unregistered redirect rejected");
	const bad = await approve(client.id);
	assert.equal((await exchange(client.id, bad, randomBytes(32).toString("base64url"))).status, 400, "wrong PKCE verifier rejected");
	assert.equal((await exchange(client.id, bad)).status, 400, "wrong verifier consumed the code");
	const grant = await approve(client.id);
	const tokenResponse = await exchange(client.id, grant);
	assert.equal(tokenResponse.status, 200);
	const issued = await tokenResponse.json();
	assert.equal(issued.scope, "read");
	assert.equal(issued.expires_in, 30 * 24 * 3600);
	assert.equal((await exchange(client.id, grant)).status, 400, "code cannot be replayed");
	const api = (method: string, path: string, token: string) => {
		const url = new URL(`${origin}/api/v1${path}`);
		return publicApi(new Request(url, { method, headers: { authorization: `Bearer ${token}` } }), url);
	};
	const me = await api("GET", "/me", issued.access_token);
	assert.equal((await me.json()).data.id, account, "app token accesses its user's account");
	assert.equal((await api("POST", "/posts", issued.access_token)).status, 403, "read grant cannot write");
	await sql`update api_tokens set expires_at = now() - interval '1 second' where user_id = ${account}::bigint and client_id = ${client.id}::bigint`;
	assert.equal((await api("GET", "/me", issued.access_token)).status, 401, "expired app token rejected");
	assert.equal((await connectedAppsRoute(postForm("/account/apps", { csrf: user.csrf, id: (await sql`select id::text from api_tokens where user_id = ${account}::bigint and client_id = ${client.id}::bigint`)[0].id }), user)).status, 200);
	assert.equal((await api("GET", "/me", issued.access_token)).status, 401, "user revocation takes effect");
	const writeGrant = await approve(client.id, "write");
	const writeToken = (await (await exchange(client.id, writeGrant)).json()).access_token;
	assert.equal((await developerAppsRoute(postForm("/account/apps/developer", { csrf: appOwner.csrf, action: "revoke", id: client.id }), appOwner)).status, 200);
	assert.equal((await api("GET", "/me", writeToken)).status, 401, "developer revocation takes effect");

	// an app identified by its client ID metadata document, never registered here
	const doc = `https://mobile-${account}.example/oauth-client.json`, docRedirect = `https://mobile-${account}.example/`;
	const realGet = fetcher.get;
	fetcher.get = async (url: string) => (url === doc ? JSON.stringify({ client_id: doc, client_name: "xit mob", redirect_uris: [docRedirect] }) : undefined);
	const docPage = new URL(`${origin}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: doc, redirect_uri: docRedirect, state: "random-state-123", scope: "write", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`);
	const consent = await (await oauthAuthorize(new Request(docPage), docPage, user)).text();
	assert(consent.includes("xit mob") && consent.includes(`From mobile-${account}.example`), "consent page names the app and its host");
	const offList = new URL(docPage);
	offList.searchParams.set("redirect_uri", `https://mobile-${account}.example/elsewhere`);
	assert.equal((await oauthAuthorize(new Request(offList), offList, user)).status, 400, "redirect outside the document rejected");
	assert.equal((await exchange(doc, { code: "x".repeat(43), verifier: "v".repeat(43), redirect: docRedirect })).status, 400, "no grant before approval");
	const docGrant = await approve(doc, "write", docRedirect);
	const docToken = await exchange(doc, docGrant);
	assert.equal(docToken.status, 200, "metadata-document app gets a token");
	const docAccess = (await docToken.json()).access_token;
	assert.equal((await (await api("GET", "/me", docAccess)).json()).data.id, account, "its token works");
	const [docClient] = await sql`select id::text, owner_id from oauth_clients where metadata_url = ${doc}`;
	assert(docClient && docClient.owner_id === null, "approval made an ownerless client row");
	assert((await (await connectedAppsRoute(new Request(`${origin}/account/apps`), user)).text()).includes(`mobile-${account}.example · Read and write`), "Connected apps shows the app's domain");
	await approve(doc, "write", docRedirect);
	assert.equal((await sql`select count(*)::int as n from oauth_clients where metadata_url = ${doc}`)[0].n, 1, "approving again reuses the row");
	// Admin > OAuth apps lists it and blocks it
	const staff = { ...viewer(developer), role: "admin" } as Viewer;
	const listedApps = (await oauthAppActions.oauthApps.run(staff, {})) as { apps: { id: string; metadata_url: string | null; grants: number }[] };
	assert.equal(listedApps.apps.find((x) => x.id === docClient.id)?.grants, 1, "the admin list shows the ownerless app and its grant");
	await oauthAppActions.blockOAuthApp.run(staff, { id: docClient.id, reason: "spam" });
	assert.equal((await api("GET", "/me", docAccess)).status, 401, "blocking ends its grants");
	assert.equal((await oauthAuthorize(new Request(docPage), docPage, user)).status, 400, "a blocked app can't ask again");
	await oauthAppActions.unblockOAuthApp.run(staff, { id: docClient.id });
	assert.equal((await oauthAuthorize(new Request(docPage), docPage, user)).status, 200, "unblocking lets it ask again");
	await assert.rejects(oauthAppActions.unblockOAuthApp.run(staff, { id: client.id }), "a developer's revoke isn't lifted by unblock");
	await sql`delete from oauth_clients where id = ${docClient.id}::bigint`;
	// blocking a document URL nobody has approved yet
	await oauthAppActions.blockOAuthApp.run(staff, { url: doc, reason: "known bad" });
	assert.equal((await oauthAuthorize(new Request(docPage), docPage, user)).status, 400, "a pre-emptively blocked app can't ask");
	await assert.rejects(oauthAppActions.blockOAuthApp.run(staff, { url: "http://not-https.example/x.json" }), "only client ID URLs can be blocked by address");
	await sql`delete from oauth_clients where metadata_url = ${doc}`;
	fetcher.get = realGet;

	// app icons: a registered app uploads one; a metadata document names a logo_uri
	const [iconClient] = await sql`select id::text from oauth_clients where owner_id = ${developer}::bigint and not revoked limit 1`
		.then(async (rows) => rows.length ? rows : (await developerAppsRoute(postForm("/account/apps/developer", { csrf: appOwner.csrf, action: "register", name: "Icon app", redirect_uri: redirect }), appOwner),
			await sql`select id::text from oauth_clients where owner_id = ${developer}::bigint and not revoked limit 1`));
	const png = (w: number, h: number) => {
		const b = Buffer.alloc(64);
		b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
		return b;
	};
	const upload = (fields: Record<string, string>, file?: Buffer) => {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		if (file) body.set("icon", new Blob([file], { type: "image/png" }), "icon.png");
		return developerAppsRoute(new Request(`${origin}/account/apps/developer`, { method: "POST", headers: { origin }, body }), appOwner);
	};
	assert((await (await upload({ csrf: appOwner.csrf, action: "icon", id: iconClient.id }, Buffer.from("not an image"))).text()).includes("Use a PNG"), "a non-image is refused");
	assert((await (await upload({ csrf: appOwner.csrf, action: "icon", id: iconClient.id }, png(4000, 4000))).text()).includes("Use a PNG"), "a huge image is refused");
	assert.equal((await upload({ csrf: "wrong", action: "icon", id: iconClient.id }, png(64, 64))).status, 403, "an icon upload needs CSRF");
	assert((await (await upload({ csrf: appOwner.csrf, action: "icon", id: iconClient.id }, png(64, 64))).text()).includes("Icon saved."), "a PNG is saved");
	const served = await oauthAppIcon(iconClient.id);
	assert.equal(served.headers.get("content-type"), "image/png", "the icon is served as what it is");
	assert.equal(served.headers.get("x-content-type-options"), "nosniff");
	assert.deepEqual(Buffer.from(await served.arrayBuffer()), png(64, 64));
	const iconAsk = new URL(`${origin}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: iconClient.id, redirect_uri: redirect, state: "random-state-123", scope: "read", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`);
	assert((await (await oauthAuthorize(new Request(iconAsk), iconAsk, user)).text()).includes(`<img class="mark" src="/oauth/apps/${iconClient.id}/icon?v=`), "the consent page shows it");
	assert((await (await oauthAuthorize(new Request(iconAsk), iconAsk, undefined)).text()).includes(`/oauth/apps/${iconClient.id}/icon?v=`), "so does the sign-in page");
	await developerAppsRoute(postForm("/account/apps/developer", { csrf: appOwner.csrf, action: "removeIcon", id: iconClient.id }), appOwner);
	assert.equal((await oauthAppIcon(iconClient.id)).status, 404, "and it can be removed");
	const otherOwner = viewer(account);
	await developerAppsRoute(new Request(`${origin}/account/apps/developer`, { method: "POST", headers: { origin }, body: (() => { const b = new FormData(); b.set("csrf", otherOwner.csrf); b.set("action", "icon"); b.set("id", iconClient.id); b.set("icon", new Blob([png(64, 64)]), "x.png"); return b; })() }), otherOwner);
	assert.equal((await oauthAppIcon(iconClient.id)).status, 404, "only the app's developer sets its icon");
	const logoDoc = `https://logo-${account}.example/oauth-client.json`;
	const savedGet = fetcher.get;
	fetcher.get = async (url: string) => (url === logoDoc ? JSON.stringify({ client_id: logoDoc, client_name: "Logo app", redirect_uris: [`https://logo-${account}.example/`], logo_uri: `https://logo-${account}.example/icon.png` }) : undefined);
	const logoAsk = new URL(`${origin}/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: logoDoc, redirect_uri: `https://logo-${account}.example/`, state: "random-state-123", scope: "read", code_challenge: "a".repeat(43), code_challenge_method: "S256" })}`);
	assert((await (await oauthAuthorize(new Request(logoAsk), logoAsk, user)).text()).includes(`src="https://logo-${account}.example/icon.png"`), "a metadata document's logo_uri is the icon");
	fetcher.get = savedGet;

	// signed out, the authorize page signs you in and comes back to the request
	await developerAppsRoute(postForm("/account/apps/developer", { csrf: appOwner.csrf, action: "register", name: "Sign-in app", redirect_uri: redirect }), appOwner);
	const [signInClient] = await sql`select id::text from oauth_clients where owner_id = ${developer}::bigint and name = 'Sign-in app'`;
	await sql`update users set password_hash = ${await Bun.password.hash("right-password-1")}, email = ${`signin-${other}@example.org`} where id = ${other}::bigint`;
	const ask = { response_type: "code", client_id: signInClient.id, redirect_uri: redirect, state: "random-state-123", scope: "read", code_challenge: "a".repeat(43), code_challenge_method: "S256" };
	const askUrl = new URL(`${origin}/oauth/authorize?${new URLSearchParams(ask)}`);
	const signInPage = await oauthAuthorize(new Request(askUrl), askUrl, undefined);
	assert.equal(signInPage.status, 200, "signed out, the page opens");
	const signInHtml = await signInPage.text();
	assert(signInHtml.includes('name="password"') && signInHtml.includes("to continue to Sign-in app"), "it's a sign-in form for this app");
	const badAsk = new URL(askUrl);
	badAsk.searchParams.set("redirect_uri", "https://evil.example/callback");
	assert.equal((await oauthAuthorize(new Request(badAsk), badAsk, undefined)).status, 400, "a bad request isn't offered sign-in");
	const crossSite = new Request(`${origin}/oauth/authorize`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...ask, username: `oauth_${other}`, password: "right-password-1" }) });
	assert.equal((await oauthAuthorize(crossSite, askUrl, undefined)).status, 403, "a sign-in posted from another site is refused");
	const wrong = await oauthAuthorize(postForm("/oauth/authorize", { ...ask, username: `oauth_${other}`, password: "nope" }), askUrl, undefined);
	assert.equal(wrong.status, 401);
	assert((await wrong.text()).includes("Wrong username or password."), "a wrong password says so");
	const signedIn = await oauthAuthorize(postForm("/oauth/authorize", { ...ask, username: `signin-${other}@example.org`, password: "right-password-1" }), askUrl, undefined);
	assert.equal(signedIn.status, 303, "the right password (by email) signs in");
	assert.equal(signedIn.headers.get("location"), `/oauth/authorize?${new URLSearchParams(ask)}`, "and goes back to the same request");
	const sessionCookie = signedIn.headers.getSetCookie().find((c) => c.startsWith("auth_token="));
	const sessionToken = sessionCookie?.split(";")[0]?.split("=")[1];
	assert(sessionToken && (await sql`select 1 from sessions where token = ${sessionKey(sessionToken)} and user_id = ${other}::bigint`).length, "with a real session for that account");
	const denied = await oauthAuthorize(postForm("/oauth/authorize", { ...ask, decision: "deny" }), askUrl, undefined);
	assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "access_denied", "Cancel tells the app no without signing in");
	// with two-factor on, the code comes next
	const secret = newSecret();
	await sql`update users set totp_enabled = true, totp_secret = ${secret} where id = ${other}::bigint`;
	const codeStep = await oauthAuthorize(postForm("/oauth/authorize", { ...ask, username: `oauth_${other}`, password: "right-password-1" }), askUrl, undefined);
	const codeHtml = await codeStep.text();
	const challengeId = /name="challenge" value="([^"]+)"/.exec(codeHtml)?.[1];
	assert(challengeId && codeHtml.includes('name="code"'), "two-factor accounts are asked for a code");
	const badCode = await oauthAuthorize(postForm("/oauth/authorize", { ...ask, challenge: challengeId, code: "000000" }), askUrl, undefined);
	assert((await badCode.text()).includes(`value="${challengeId}"`), "a wrong code can be tried again");
	const goodCode = await oauthAuthorize(postForm("/oauth/authorize", { ...ask, challenge: challengeId, code: codeAt(secret, Math.floor(Date.now() / 30000)) }), askUrl, undefined);
	assert.equal(goodCode.status, 303, "the right code signs in");
	assert(goodCode.headers.getSetCookie().some((c) => c.startsWith("auth_token=")), "with a session");
	console.log("OAuth registration, consent, PKCE, scope, replay, revocation, client metadata document and admin block and sign-in checks passed");
} finally {
	await sql`delete from users where id in (${developer}::bigint, ${account}::bigint, ${other}::bigint)`;
	await sql.close();
}
