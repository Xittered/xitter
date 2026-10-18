// Several accounts signed in at once, as X does it: the active session is in
// auth_token, the others in auth_multi (their session tokens, comma separated).
// Signing in to another account keeps the one before it; the account menu
// lists them and switches between them.
//
//   GET  /1.1/account/multi/list.json        the other signed-in accounts
//   POST /1.1/account/multi/switch.json      user_id: make that one active
//   POST /1.1/account/multi/clean.json       forget sessions that ended
//   POST /1.1/account/multi/logout_all.json  sign every one of them out
//   POST /1.1/account/logout.json            sign out the active one; the next
//                                            one, if any, takes its place

import { recordSignIn } from "./login-history";
import { SECURE, type Viewer, clearedCookies, logout, parseCookies, sessionCookies } from "./auth";
import { sql } from "./db";
import { avatarUrl } from "./model";
import { settings } from "./settings";

// X keeps five accounts at most; an admin can raise the client's limit
// (responsive_web_multiple_account_limit), and the cookie follows it. Every
// token shares one cookie, so it stops at 50.
const max = () => Math.min(Math.max(Math.trunc(Number(settings().switch_overrides.responsive_web_multiple_account_limit)) || 5, 1), 50);

type Session = { token: string; csrf: string; userId: string };

const multiCookie = (tokens: string[]) =>
	tokens.length ? `auth_multi=${tokens.join(",")}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax${SECURE}` : `auth_multi=; Path=/; Max-Age=0; SameSite=Lax${SECURE}`;

const multiTokens = (req: Request) => (parseCookies(req).auth_multi ?? "").split(",").filter(Boolean);

// The given tokens' sessions that still exist, in that order, one per account
// and none of `except`'s.
async function live(tokens: string[], except?: string): Promise<Session[]> {
	if (!tokens.length) return [];
	const rows = await sql`select s.token, s.csrf, s.user_id::text as "userId" from sessions s join users u on u.id = s.user_id
		where s.token = any(${sql.array(tokens, "TEXT")}) and u.status <> 'suspended'`;
	const seen = new Set(except ? [except] : []);
	const out: Session[] = [];
	for (const t of tokens) {
		const s = rows.find((r: Session) => r.token === t);
		if (!s || seen.has(s.userId)) continue;
		seen.add(s.userId);
		out.push(s);
	}
	return out;
}

// Cookies for a new sign-in from this browser: the session it was using, and
// the others it had, stay signed in behind the new one.
export async function signInCookies(req: Request, session: Session): Promise<string[]> {
	await recordSignIn(req, session);
	const before = parseCookies(req).auth_token;
	const others = await live([...(before ? [before] : []), ...multiTokens(req)], session.userId);
	return [...sessionCookies(session), multiCookie(others.slice(0, max() - 1).map((s) => s.token))];
}

function withCookies(body: unknown, cookies: string[]): Response {
	const headers = new Headers({ "content-type": "application/json" });
	for (const c of cookies) headers.append("set-cookie", c);
	return new Response(JSON.stringify(body), { headers });
}

export async function accountsRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	if (path === "/1.1/account/multi/list.json") {
		const others = await live(multiTokens(req), viewer.id);
		const users = others.length
			? await sql`select id::text, screen_name, name, avatar_url, verified_type from users where id = any(${sql.array(others.map((s) => s.userId), "INT8")})`
			: [];
		return Response.json({
			users: others.map((s) => {
				const u = users.find((x: { id: string }) => x.id === s.userId);
				return {
					user_id: s.userId,
					name: u.name,
					screen_name: u.screen_name,
					avatar_image_url: avatarUrl(u.avatar_url),
					is_suspended: false,
					is_verified: !!u.verified_type,
					is_protected: false,
					is_auth_valid: true,
				};
			}),
		});
	}
	if (method !== "POST") return undefined;

	if (path === "/1.1/account/multi/switch.json") {
		const f = await req.formData().catch(() => undefined);
		const userId = String(f?.get("user_id") ?? "");
		const others = await live(multiTokens(req), viewer.id);
		const target = others.find((s) => s.userId === userId);
		if (!target) return Response.json({ errors: [{ code: 32, message: "That account isn't signed in here." }] }, { status: 400 });
		const rest = [viewer.token, ...others.filter((s) => s !== target).map((s) => s.token)];
		return withCookies({}, [...sessionCookies(target), multiCookie(rest)]);
	}
	if (path === "/1.1/account/multi/clean.json") {
		return withCookies({}, [multiCookie((await live(multiTokens(req), viewer.id)).map((s) => s.token))]);
	}
	if (path === "/1.1/account/multi/logout_all.json") {
		for (const t of [viewer.token, ...multiTokens(req)]) await logout(t);
		return withCookies({ status: "ok" }, [...clearedCookies(), multiCookie([])]);
	}
	if (path === "/1.1/account/logout.json") {
		await logout(viewer.token);
		const [next, ...rest] = await live(multiTokens(req), viewer.id);
		if (!next) return withCookies({ status: "ok" }, [...clearedCookies(), multiCookie([])]);
		return withCookies({ status: "ok" }, [...sessionCookies(next), multiCookie(rest.map((s) => s.token))]);
	}
	return undefined;
}
