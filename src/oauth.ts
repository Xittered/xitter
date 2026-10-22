// OAuth 2 authorization-code flow for public clients. PKCE is mandatory;
// client secrets and implicit grants are intentionally unsupported.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Viewer } from "./auth";
import { otherAccounts, signInCookies, switchCookies } from "./accounts";
import { accountPage, esc } from "./account-page";
import { boundedBody } from "./api-input";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { sniffImage } from "./media";
import { requestIp } from "./login-history";
import { clientMetadata, metadataClientId } from "./oauth-metadata";
import { passwordStep } from "./password-sign-in";
import { hit, limitedResponse } from "./ratelimit";
import { settings } from "./settings";
import { loadLook, nightModeCookies } from "./themes/api";
import { answerChallenge } from "./two-factor";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const challengeFor = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const token = () => `xit_${randomBytes(24).toString("hex")}`;
const code = () => randomBytes(32).toString("base64url");
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS", "cache-control": "no-store" };
const oauthError = (error: string, status = 400) => Response.json({ error }, { status, headers: cors });

export function validRedirect(value: string): boolean {
	if (!value || value.length > 2048) return false;
	try {
		const url = new URL(value);
		if (url.hash || url.username || url.password || url.origin === "null") return false;
		return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
	} catch { return false; }
}

async function form(req: Request, limit = 8192): Promise<FormData | undefined> {
	const type = req.headers.get("content-type") ?? "";
	// multipart only where a file is expected (the developer page's icon upload)
	if (!type.startsWith("application/x-www-form-urlencoded") && !(limit > 8192 && type.startsWith("multipart/form-data"))) return undefined;
	try {
		const bytes = await boundedBody(req, limit);
		return await new Response(bytes, { headers: { "content-type": type.startsWith("multipart/") ? type : "application/x-www-form-urlencoded" } }).formData();
	} catch { return undefined; }
}

const ICON_BYTES = 256 * 1024;
const iconUrl = (id: string, at: Date | string) => `/oauth/apps/${id}/icon?v=${new Date(at).getTime()}`;

// GET /oauth/apps/:id/icon: a registered app's uploaded icon
export async function oauthAppIcon(id: string): Promise<Response> {
	const [row] = isId(id) ? await sql`select icon, icon_mime from oauth_clients where id = ${id}::bigint and icon is not null` : [];
	if (!row) return new Response("No icon.", { status: 404 });
	return new Response(row.icon, { headers: { "content-type": row.icon_mime, "cache-control": "public, max-age=604800, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'" } });
}

const value = (f: FormData, key: string) => String(f.get(key) ?? "");

export async function oauthToken(req: Request): Promise<Response> {
	if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
	if (req.method !== "POST") return oauthError("invalid_request", 405);
	const limit = hit("auth", requestIp(req) ?? "unknown");
	if (!limit.ok) return limitedResponse(limit);
	const f = await form(req);
	if (!f || value(f, "grant_type") !== "authorization_code") return oauthError("unsupported_grant_type");
	const givenId = value(f, "client_id"), givenCode = value(f, "code"), verifier = value(f, "code_verifier"), redirect = value(f, "redirect_uri");
	// a metadata document URL stands for the row made when it was first approved
	const clientId = isId(givenId) ? givenId : metadataClientId(givenId) ? (await sql`select id::text from oauth_clients where metadata_url = ${givenId}`)[0]?.id : undefined;
	if (!clientId) return oauthError(isId(givenId) || metadataClientId(givenId) ? "invalid_grant" : "invalid_request");
	if (!/^[A-Za-z0-9_-]{43}$/.test(givenCode) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !validRedirect(redirect)) return oauthError("invalid_request");
	const result = await sql.begin(async (tx) => {
		// DELETE consumes the code even when the verifier or redirect is wrong.
		const [grant] = await tx`delete from oauth_codes where code_hash = ${digest(givenCode)} returning client_id::text, user_id::text, redirect_uri, scope, code_challenge, expires_at`;
		if (!grant || grant.client_id !== clientId || grant.redirect_uri !== redirect || new Date(grant.expires_at).getTime() <= Date.now()) return undefined;
		const expected = Buffer.from(grant.code_challenge), actual = Buffer.from(challengeFor(verifier));
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
		const [account] = await tx`select u.id from users u join oauth_clients c on c.id = ${clientId}::bigint
			where u.id = ${grant.user_id}::bigint and u.status = 'active' and u.deactivated_at is null and u.instance is null and not c.revoked for update of u`;
		if (!account) return undefined;
		const access = token();
		await tx`delete from api_tokens where user_id = ${grant.user_id}::bigint and client_id = ${clientId}::bigint`;
		const issued = await tx`insert into api_tokens(id, user_id, name, token_hash, scope, client_id, expires_at)
			select ${newId()}::bigint, ${grant.user_id}::bigint, left(name, 40), ${digest(access)}, ${grant.scope}, id, now() + interval '30 days'
			from oauth_clients where id = ${clientId}::bigint and not revoked returning id`;
		if (!issued.length) return undefined;
		return { access_token: access, token_type: "Bearer", scope: grant.scope, expires_in: 30 * 24 * 3600 };
	});
	return result ? Response.json(result, { headers: cors }) : oauthError("invalid_grant");
}

// clientId is the client_id as the app sent it; dbId is its oauth_clients row,
// which a metadata-document app only gets once someone approves it
type RequestData = { clientId: string; dbId?: string; redirect: string; state: string; scope: "read" | "write"; challenge: string; name: string; owner: string | null; icon: string | null };

async function authorization(values: URLSearchParams | FormData): Promise<RequestData | undefined> {
	const get = (key: string) => String(values.get(key) ?? "");
	const clientId = get("client_id"), redirect = get("redirect_uri"), state = get("state"), challenge = get("code_challenge");
	const scope = get("scope");
	if (get("response_type") !== "code" || get("code_challenge_method") !== "S256" || !(isId(clientId) || metadataClientId(clientId)) || !validRedirect(redirect) ||
		!/^[A-Za-z0-9_-]{43}$/.test(challenge) || state.length < 8 || state.length > 512 || !["read", "write"].includes(scope)) return undefined;
	if (!isId(clientId)) {
		const doc = await clientMetadata(clientId);
		if (!doc || !doc.redirects.includes(redirect)) return undefined;
		const [row] = await sql`select id::text, revoked from oauth_clients where metadata_url = ${clientId}`;
		if (row?.revoked) return undefined;
		return { clientId, dbId: row?.id, redirect, state, scope: scope as "read" | "write", challenge, name: doc.name, owner: null, icon: doc.logo };
	}
	const [client] = await sql`select c.name, c.redirect_uri, c.icon_at, u.screen_name as owner from oauth_clients c join users u on u.id = c.owner_id
		where c.id = ${clientId}::bigint and not c.revoked and u.status = 'active'`;
	if (!client || client.redirect_uri !== redirect) return undefined;
	return { clientId, dbId: clientId, redirect, state, scope: scope as "read" | "write", challenge, name: client.name, owner: client.owner, icon: client.icon_at ? iconUrl(clientId, client.icon_at) : null };
}

const redirectWith = (request: RequestData, params: Record<string, string>) => {
	const url = new URL(request.redirect);
	for (const [key, val] of Object.entries({ ...params, state: request.state })) url.searchParams.set(key, val);
	return new Response(null, { status: 303, headers: { location: url.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
};

// the request's parameters, to carry it through a form or back to this page
const requestParams = (request: RequestData) => ({ response_type: "code", client_id: request.clientId, redirect_uri: request.redirect, state: request.state, scope: request.scope, code_challenge: request.challenge, code_challenge_method: "S256" });
const hiddenFields = (fields: Record<string, string>) => Object.entries(fields).map(([key, val]) => `<input type="hidden" name="${key}" value="${esc(val)}">`).join("");
const backTo = (request: RequestData, cookies: string[]) => {
	const headers = new Headers({ location: `/oauth/authorize?${new URLSearchParams(requestParams(request))}`, "cache-control": "no-store" });
	for (const c of cookies) headers.append("set-cookie", c);
	return new Response(null, { status: 303, headers });
};

const appCard = (request: RequestData) => {
	const initial = esc([...request.name.trim()][0]?.toUpperCase() ?? "?");
	const mark = request.icon ? `<img class="mark" src="${esc(request.icon)}" alt="" referrerpolicy="no-referrer">` : `<span class="mark" aria-hidden="true">${initial}</span>`;
	return `<div class="app">${mark}<div><b>${esc(request.name)}</b><div class="dim">${request.owner ? `By @${esc(request.owner)} · ` : "From "}${esc(new URL(request.redirect).host)}</div></div><span class="pill">${request.scope === "write" ? "Read and write" : "Read only"}</span></div>`;
};

// Signed out, the authorize page signs you in itself (password, then a
// second-factor code if the account has one) and comes back to the request.
async function signInFirst(req: Request, url: URL): Promise<Response> {
	const ip = requestIp(req) ?? "unknown";
	const f = req.method === "POST" ? await form(req) : undefined;
	// a sign-in form posted from another site would sign you in as someone else
	if (req.method === "POST" && (!f || req.headers.get("origin") !== PUBLIC_ORIGIN)) return new Response("Invalid sign-in form.", { status: 403 });
	if (!f && metadataClientId(url.searchParams.get("client_id") ?? "")) {
		const limit = hit("endpoint", `oauth-metadata:${ip}`);
		if (!limit.ok) return limitedResponse(limit);
	}
	const request = await authorization(f ?? url.searchParams);
	if (!request) return new Response("Invalid app authorization request.", { status: 400 });
	let error = "", challenge = "", typed = "";
	if (f) {
		if (value(f, "decision") === "deny") return redirectWith(request, { error: "access_denied" });
		const limit = hit("auth", ip);
		if (!limit.ok) return limitedResponse(limit);
		const signedIn = async (session: { token: string; csrf: string; userId: string }) =>
			backTo(request, [...(await signInCookies(req, session)), ...nightModeCookies(await loadLook(session.userId))]);
		if (value(f, "challenge")) {
			const answer = await answerChallenge(value(f, "challenge"), value(f, "code"));
			if (answer.session) return signedIn(answer.session);
			if (answer.unknown) error = "That sign-in took too long. Enter your password again.";
			else {
				error = answer.error ?? "That code isn't right.";
				// after too many wrong codes the challenge is spent: back to the password
				if (!answer.error?.startsWith("Too many")) challenge = value(f, "challenge");
			}
		} else {
			typed = value(f, "username");
			const step = await passwordStep(typed, value(f, "password"));
			if ("session" in step) return signedIn(step.session);
			if ("challenge" in step) challenge = step.challenge;
			else error = step.error;
		}
	}
	const name = settings().instance_name;
	const params = hiddenFields(requestParams(request));
	const fields = challenge
		? `<input type="hidden" name="challenge" value="${esc(challenge)}"><label>Code from your authenticator app<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="20" required autofocus></label>`
		: `<label>Username or email<input name="username" value="${esc(typed)}" autocomplete="username" autocapitalize="off" spellcheck="false" maxlength="320" required${typed ? "" : " autofocus"}></label>
<label>Password<input name="password" type="password" autocomplete="current-password" maxlength="1024" required${typed ? " autofocus" : ""}></label>`;
	return accountPage({ req, title: "Sign in", referrer: "same-origin", status: error ? 401 : 200, css: CONSENT_CSS, body: `${appCard(request)}
<h1>Sign in to ${esc(name)} to continue to ${esc(request.name)}</h1>
<p class="dim">${challenge ? "Your account has two-factor authentication." : `You'll see what ${esc(request.name)} can do before anything is shared.`}</p>
${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}<form method="post" class="signin">${params}${fields}
<button>${challenge ? "Verify" : "Sign in"}</button></form>
<form method="post" class="decide">${params}<button name="decision" value="deny" class="secondary">Cancel</button></form>
<p class="fine">New here, or forgot your password? Go to <a href="/">${esc(name)}</a>, then reopen this link from ${esc(request.name)}.</p>` });
}

export async function oauthAuthorize(req: Request, url: URL, viewer: Viewer | undefined): Promise<Response> {
	if (!viewer) return signInFirst(req, url);
	if (viewer.status !== "active") return new Response("This account cannot authorize apps.", { status: 403 });
	const f = req.method === "POST" ? await form(req) : undefined;
	if (req.method === "POST" && (!f || value(f, "csrf") !== viewer.csrf || (req.headers.get("origin") && req.headers.get("origin") !== PUBLIC_ORIGIN))) return new Response("Invalid authorization form.", { status: 403 });
	// opening the page may fetch an app's metadata document; keep that bounded
	if (!f && metadataClientId(url.searchParams.get("client_id") ?? "")) {
		const limit = hit("endpoint", `oauth-metadata:${viewer.id}`);
		if (!limit.ok) return limitedResponse(limit);
	}
	const request = await authorization(f ?? url.searchParams);
	if (!request) return new Response("Invalid app authorization request.", { status: 400 });
	if (f) {
		const limit = hit("auth", viewer.id);
		if (!limit.ok) return limitedResponse(limit);
		if (value(f, "decision") === "switch") {
			// make another signed-in account active, then show this same request to it
			const cookies = await switchCookies(req, viewer, value(f, "user_id"));
			if (!cookies) return new Response("That account isn't signed in here.", { status: 400 });
			return backTo(request, cookies);
		}
		if (value(f, "decision") !== "approve") return redirectWith(request, { error: "access_denied" });
		const fresh = code();
		await sql.begin(async (tx) => {
			const [account] = await tx`select id from users where id = ${viewer.id}::bigint and status = 'active' and deactivated_at is null and instance is null for update`;
			if (!account) throw new Error("Account cannot authorize apps.");
			await tx`delete from oauth_codes where expires_at < now()`;
			let clientId = request.dbId;
			if (!isId(request.clientId)) {
				const [row] = await tx`insert into oauth_clients(id, owner_id, name, redirect_uri, metadata_url, logo_uri) values(${newId()}::bigint, null, ${request.name}, ${request.redirect}, ${request.clientId}, ${request.icon})
					on conflict (metadata_url) do update set name = excluded.name, redirect_uri = excluded.redirect_uri, logo_uri = excluded.logo_uri returning id::text, revoked`;
				if (row.revoked) throw new Error("This app has been revoked.");
				clientId = row.id;
			}
			await tx`insert into oauth_codes(code_hash, client_id, user_id, redirect_uri, scope, code_challenge, expires_at)
				values(${digest(fresh)}, ${clientId}::bigint, ${viewer.id}::bigint, ${request.redirect}, ${request.scope}, ${request.challenge}, now() + interval '5 minutes')`;
		});
		return redirectWith(request, { code: fresh });
	}
	const hidden = hiddenFields({ ...requestParams(request), csrf: viewer.csrf });
	// what public-api.ts lets a token of this scope do; keep the two in step
	const reads = ["Read posts, profiles, and timelines your account can see", "See who you follow and who follows you", "Search posts and people"];
	const can = request.scope === "write"
		? [...reads, "Post and delete posts as you", "Like, repost, bookmark, and follow as you", "Upload photos and videos"]
		: reads;
	const cannot = ["See your password or email address", "Read your Direct Messages", "Change your account settings"];
	const list = (items: string[], icon: string, cls: string) => `<ul class="perms ${cls}">${items.map((t) => `<li><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icon}"/></svg>${esc(t)}</li>`).join("")}</ul>`;
	const initial = (s: string) => esc([...s.trim()][0]?.toUpperCase() ?? "?");
	const avatar = (u: { avatar_url: string | null; name: string; screen_name: string }) => u.avatar_url ? `<img class="avatar" src="${esc(u.avatar_url)}" alt="">` : `<span class="avatar">${initial(u.name || u.screen_name)}</span>`;
	const others = await otherAccounts(req, viewer);
	// a details menu, so switching works without scripts
	const accounts = others.length
		? `<form method="post" class="accounts">${hidden}<input type="hidden" name="decision" value="switch">${others.map((u) => `<button name="user_id" value="${esc(u.id)}" class="account">${avatar(u)}<span><b>${esc(u.name || u.screen_name)}</b><span class="dim">@${esc(u.screen_name)}</span></span></button>`).join("")}</form>`
		: `<p class="dim none">No other accounts are signed in on this browser. Add one from the account menu on the home page, then reopen this link.</p>`;
	return accountPage({ req, viewer, title: "Authorize app", referrer: "same-origin", css: CONSENT_CSS, body: `<div class="who">${avatar(viewer)}<div class="name"><div class="dim">Signed in as</div><b>${esc(viewer.name || viewer.screen_name)}</b> <span class="dim">@${esc(viewer.screen_name)}</span></div><details class="switch"><summary>Switch account</summary><div class="menu">${accounts}</div></details></div>
${appCard(request)}
<h1>Authorize ${esc(request.name)} to access your account?</h1>
<section><h2>This app will be able to:</h2>${list(can, CHECK, "yes")}</section>
<section><h2>It won't be able to:</h2>${list(cannot, CROSS, "no")}</section>
<form method="post" class="decide">${hidden}<button name="decision" value="approve">Authorize app</button><button name="decision" value="deny" type="submit" class="secondary">Cancel</button></form>
<p class="fine">After approval you'll return to <code>${esc(request.redirect)}</code>. Access expires after 30 days, and you can remove it any time at <a href="/account/apps">Connected apps</a>.</p>` });
}

const CHECK = "M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z";
const CROSS = "M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z";
const appIcon = (name: string, src: string | null) =>
	src ? `<img class="icon" src="${esc(src)}" alt="" referrerpolicy="no-referrer">` : `<span class="icon" aria-hidden="true">${esc([...name.trim()][0]?.toUpperCase() ?? "?")}</span>`;
const ICON_CSS = `
.named{display:flex;align-items:center;gap:12px;min-width:0}
.named>div{min-width:0}
.icon{width:40px;height:40px;border-radius:10px;flex:none;display:grid;place-items:center;background:var(--accent-fill,var(--accent));color:var(--accent-text,#fff);font-weight:800;object-fit:cover}
img.icon{background:var(--surface)}
.list{border:1px solid var(--border);border-radius:16px;overflow:hidden}
.list>*+*{border-top:1px solid var(--border)}
.item{padding:12px 16px;display:grid;gap:12px}
.item.split{display:flex}
.item .split>:first-child,.item.split>:first-child{flex-basis:200px}
.facts{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;margin:0;font-size:14px}
.facts dt{color:var(--muted)}
.facts dd{margin:0;min-width:0}
.facts code{word-break:break-all}
.pill{border:1px solid var(--outline);border-radius:9999px;padding:1px 10px;font-size:13px;font-weight:700;white-space:nowrap}
.pill.on{border-color:var(--success);color:var(--success)}
.actions{display:flex;gap:8px;align-items:flex-start}
.actions>form{display:contents}
.actions .end{margin-left:auto}
details.edit{flex:1;min-width:0}
details.edit>summary{display:inline-flex;align-items:center;min-height:32px;padding:0 14px;border:1px solid var(--outline);border-radius:9999px;font-size:14px;font-weight:700;cursor:pointer;list-style:none}
details.edit>summary::-webkit-details-marker{display:none}
details.edit[open]>summary{background:var(--hover)}
details.edit>form{margin-top:12px;max-width:100%;display:grid;gap:12px;justify-items:start}
details.edit .hint{font-size:13px}
.panel{border:1px solid var(--border);border-radius:16px;padding:16px;display:grid;gap:12px}
.panel h2{margin:0;font-size:17px;line-height:20px}
.panel form{justify-items:stretch}
.panel form button{justify-self:start}
.panel label{display:grid;gap:6px;margin:0}
.hint{color:var(--muted);font-size:13px;line-height:16px}
.section{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin-top:8px}
.section h2{margin:0;font-size:17px;line-height:20px}
details.past>summary{cursor:pointer;color:var(--muted);font-size:14px;font-weight:700;padding:4px 0}
details.past .list{margin-top:8px}
.empty{padding:24px 16px;text-align:center;color:var(--muted);border:1px dashed var(--border);border-radius:16px}
.cta{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
@media (hover:hover){details.edit>summary:hover{background:var(--hover)}}
`;

const CONSENT_CSS = `
.who,.app{display:flex;align-items:center;gap:12px}
.who{padding-bottom:12px;border-bottom:1px solid var(--border)}
.who b,.app b{font-size:15px}
.who{position:relative}
.who .name{flex:1;min-width:0}
.switch summary{list-style:none;cursor:pointer;min-height:32px;padding:0 14px;display:flex;align-items:center;border:1px solid var(--outline);border-radius:9999px;font-size:14px;font-weight:700;white-space:nowrap}
.switch summary::-webkit-details-marker{display:none}
.switch summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.switch .menu{position:absolute;right:0;top:calc(100% - 4px);z-index:3;width:min(300px,100%);background:var(--bg);border:1px solid var(--border);border-radius:16px;box-shadow:0 0 15px rgb(101 119 134 / .2),0 0 3px 1px rgb(101 119 134 / .15);overflow:hidden}
.accounts{gap:0;justify-items:stretch}
button.account{display:flex;align-items:center;gap:12px;width:100%;min-height:64px;padding:12px 16px;border:0;border-radius:0;background:transparent;color:var(--text);font-weight:400;text-align:left}
button.account>span:last-child{display:flex;flex-direction:column;min-width:0}
.menu .none{padding:12px 16px}
@media (hover:hover){.switch summary:hover,button.account:hover:not(:disabled){background:var(--hover)}}
.avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:none;display:grid;place-items:center;background:var(--surface);font-weight:700}
.app{border:1px solid var(--border);border-radius:16px;padding:12px 16px;flex-wrap:wrap}
.app>div{flex:1 1 160px;min-width:0}
img.mark{object-fit:cover;background:var(--surface)}
.mark{width:48px;height:48px;border-radius:12px;flex:none;display:grid;place-items:center;background:var(--accent-fill,var(--accent));color:var(--accent-text,#fff);font-size:22px;font-weight:800}
.pill{border:1px solid var(--outline);border-radius:9999px;padding:2px 10px;font-size:13px;font-weight:700;white-space:nowrap}
main h1{margin-top:4px}
section h2{margin:4px 0 8px;font-size:17px;line-height:20px}
.perms{list-style:none;margin:0;padding:0;display:grid;gap:10px}
.perms li{display:flex;gap:10px;align-items:flex-start}
.perms svg{width:20px;height:20px;flex:none}
.perms.yes svg{fill:var(--success)}
.perms.no svg{fill:var(--muted)}
.perms.no li{color:var(--muted)}
form.decide{display:flex;gap:12px;margin-top:8px}
form.decide button{flex:1 1 0;min-width:0;min-height:44px;font-size:16px}
.fine{color:var(--muted);font-size:13px;line-height:16px}
form.signin{justify-items:stretch}
.signin label{display:grid;gap:6px;margin:0}
.signin input{color:var(--text)}
.signin button{min-height:44px;font-size:16px}
.fine code{word-break:break-all}
`;

async function appsPage(req: Request, viewer: Viewer, message = ""): Promise<Response> {
	const grants = await sql`select t.id::text, t.scope, t.created_at, t.last_used_at, t.expires_at, c.name, c.id::text as client_id, c.metadata_url, c.icon_at, c.logo_uri
		from api_tokens t join oauth_clients c on c.id = t.client_id where t.user_id = ${viewer.id}::bigint order by t.created_at desc`;
	const hidden = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
	const date = (d: string | Date) => esc(new Date(d).toLocaleDateString());
	const rows = grants
		.map((g) => `<div class="item split"><div class="named">${appIcon(g.name, g.icon_at ? iconUrl(g.client_id, g.icon_at) : g.logo_uri)}<div><b>${esc(g.name)}</b><div class="dim">${g.metadata_url ? `${esc(new URL(g.metadata_url).host)} · ` : ""}${g.scope === "write" ? "Read and write" : "Read only"}</div><div class="hint">${g.last_used_at ? `Last used ${date(g.last_used_at)} · ` : ""}Expires ${date(g.expires_at)}</div></div></div><form method="post">${hidden}<input type="hidden" name="id" value="${g.id}"><button class="secondary small">Remove</button></form></div>`)
		.join("");
	return accountPage({ req, viewer, title: "Connected apps", referrer: "same-origin", css: ICON_CSS, body: `<h1>Connected apps</h1><p class="dim">Apps you've let use your account. Removing one signs it out straight away.</p>
${message ? `<p class="notice" role="status">${esc(message)}</p>` : ""}${grants.length ? `<div class="list">${rows}</div>` : `<p class="empty">No apps are connected to your account.</p>`}
<div class="box cta"><div><b>Building an app?</b><div class="dim">Register it so people can sign in with their account.</div></div><a href="/account/apps/developer">Developer apps</a></div>` });
}

export async function connectedAppsRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return appsPage(req, viewer);
	const limit = hit("write", viewer.id);
	if (!limit.ok) return limitedResponse(limit);
	const f = await form(req);
	if (!f || value(f, "csrf") !== viewer.csrf || (req.headers.get("origin") && req.headers.get("origin") !== PUBLIC_ORIGIN)) return new Response("Invalid form.", { status: 403 });
	const id = value(f, "id");
	if (!isId(id)) return new Response("Invalid grant.", { status: 400 });
	await sql`delete from api_tokens where id = ${id}::bigint and user_id = ${viewer.id}::bigint and client_id is not null`;
	return appsPage(req, viewer, "App access removed.");
}

async function developerPage(req: Request, viewer: Viewer, message = ""): Promise<Response> {
	const clients = await sql`select id::text, name, redirect_uri, revoked, icon_at from oauth_clients where owner_id = ${viewer.id}::bigint order by created_at desc`;
	const hidden = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
	const action = (name: string, id: string) => `${hidden}<input type="hidden" name="action" value="${name}"><input type="hidden" name="id" value="${id}">`;
	const facts = (c: Record<string, string>) => `<dl class="facts"><dt>Client ID</dt><dd><code>${c.id}</code></dd><dt>Redirect</dt><dd><code>${esc(c.redirect_uri)}</code></dd></dl>`;
	const active = clients.filter((c) => !c.revoked);
	const revoked = clients.filter((c) => c.revoked);
	const card = (c: Record<string, string>) => `<div class="item"><div class="split"><div class="named">${appIcon(c.name, c.icon_at ? iconUrl(c.id, c.icon_at) : null)}<b>${esc(c.name)}</b></div><span class="pill on">Active</span></div>${facts(c)}
<div class="actions"><details class="edit"><summary>${c.icon_at ? "Change icon" : "Add icon"}</summary><form method="post" enctype="multipart/form-data">${action("icon", c.id)}<input type="file" name="icon" accept="image/png,image/jpeg,image/webp,image/gif" required><span class="hint">PNG, JPEG, WebP or GIF, up to 256 KB. Square works best.</span><button class="small">Save icon</button></form>${c.icon_at ? `<form method="post">${action("removeIcon", c.id)}<button class="secondary small">Remove icon</button></form>` : ""}</details>
<form method="post" onsubmit="return confirm('Revoke this app? Everyone signed in to it loses access, and it cannot be undone.')">${action("revoke", c.id)}<button class="danger small end">Revoke</button></form></div></div>`;
	const past = (c: Record<string, string>) => `<div class="item"><div class="split"><div class="named">${appIcon(c.name, null)}<b>${esc(c.name)}</b></div><span class="pill">Revoked</span></div>${facts(c)}</div>`;
	return accountPage({ req, viewer, title: "Developer apps", referrer: "same-origin", back: { href: "/account/apps", label: "Back to Connected apps" }, css: ICON_CSS, body: `<h1>Developer apps</h1>
<p class="dim">Apps you build that people sign in to with their account, using OAuth with PKCE (S256). See the <a href="/api">API and OAuth documentation</a>.</p>
${message ? `<p class="notice" role="status">${esc(message)}</p>` : ""}<div class="panel"><h2>Register an app</h2><form method="post">${hidden}<input type="hidden" name="action" value="register"><label>App name<input name="name" maxlength="80" required></label><label>Redirect URL<input name="redirect_uri" type="url" maxlength="2048" placeholder="https://example.com/callback" required><span class="hint">Must match exactly. HTTPS, or a local loopback address such as http://127.0.0.1:8080/callback.</span></label><button>Register</button></form></div>
<div class="section"><h2>Your apps</h2><span class="meta">${active.length} of 10</span></div>
${active.length ? `<div class="list">${active.map(card).join("")}</div>` : `<p class="empty">You haven't registered any apps yet.</p>`}
${revoked.length ? `<details class="past"><summary>Revoked (${revoked.length})</summary><div class="list">${revoked.map(past).join("")}</div></details>` : ""}` });
}

export async function developerAppsRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return developerPage(req, viewer);
	const f = await form(req, ICON_BYTES + 16 * 1024);
	if (!f || value(f, "csrf") !== viewer.csrf || (req.headers.get("origin") && req.headers.get("origin") !== PUBLIC_ORIGIN)) return new Response("Invalid form.", { status: 403 });
	if (viewer.status !== "active") return new Response("This account cannot register apps.", { status: 403 });
	const limit = hit("write", viewer.id);
	if (!limit.ok) return limitedResponse(limit);
	if (value(f, "action") === "revoke") {
		const id = value(f, "id");
		if (!isId(id)) return new Response("Invalid app.", { status: 400 });
		await sql.begin(async (tx) => {
			await tx`update oauth_clients set revoked = true where id = ${id}::bigint and owner_id = ${viewer.id}::bigint`;
			await tx`delete from api_tokens where client_id = ${id}::bigint and exists(select 1 from oauth_clients where id = ${id}::bigint and owner_id = ${viewer.id}::bigint)`;
			await tx`delete from oauth_codes where client_id = ${id}::bigint and exists(select 1 from oauth_clients where id = ${id}::bigint and owner_id = ${viewer.id}::bigint)`;
		});
		return developerPage(req, viewer, "App revoked.");
	}
	if (value(f, "action") === "icon" || value(f, "action") === "removeIcon") {
		const id = value(f, "id");
		if (!isId(id)) return new Response("Invalid app.", { status: 400 });
		if (value(f, "action") === "removeIcon") {
			await sql`update oauth_clients set icon = null, icon_mime = null, icon_at = null where id = ${id}::bigint and owner_id = ${viewer.id}::bigint`;
			return developerPage(req, viewer, "Icon removed.");
		}
		const file = f.get("icon");
		const bytes = file instanceof Blob && file.size <= ICON_BYTES ? Buffer.from(await file.arrayBuffer()) : undefined;
		const image = bytes && sniffImage(bytes);
		if (!bytes || !image || image.width < 16 || image.height < 16 || image.width > 1024 || image.height > 1024)
			return developerPage(req, viewer, "Use a PNG, JPEG, WebP or GIF of up to 256 KB, between 16 and 1024 pixels on each side.");
		const done = await sql`update oauth_clients set icon = ${bytes}, icon_mime = ${image.mime}, icon_at = now() where id = ${id}::bigint and owner_id = ${viewer.id}::bigint and not revoked returning id`;
		return developerPage(req, viewer, done.length ? "Icon saved." : "No such app.");
	}
	if (value(f, "action") !== "register") return new Response("Invalid action.", { status: 400 });
	const name = value(f, "name").trim(), redirect = value(f, "redirect_uri").trim();
	if (!name || [...name].length > 80 || !validRedirect(redirect)) return developerPage(req, viewer, "Use a name and an exact HTTPS or local loopback redirect URL.");
	const made = await sql.begin(async (tx) => {
		await tx`select id from users where id = ${viewer.id}::bigint for update`;
		const [{ count }] = await tx`select count(*)::int as count from oauth_clients where owner_id = ${viewer.id}::bigint and not revoked`;
		if (count >= 10) return false;
		await tx`insert into oauth_clients(id, owner_id, name, redirect_uri) values(${newId()}::bigint, ${viewer.id}::bigint, ${name}, ${redirect})`;
		return true;
	});
	return developerPage(req, viewer, made ? "App registered. Use its client ID to request authorization." : "You can have up to ten active apps.");
}
