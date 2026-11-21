import { randomBytes } from "node:crypto";
import { type Action, AdminError, audit, idOf } from "./admin";
import { SECURE, SESSION_COOKIE, type Viewer, parseCookies, sessionCookies, sessionKey } from "./auth";
import { sql } from "./db";
import { INSTANCE_ID } from "./federation";
import { reauthenticate } from "./superadmin";
import { superadminOf } from "./superadmins";

const MINUTES = 60;
const RETURN_COOKIE = "xitter_impersonating";
const tickets = new Map<string, { actorId: string; token: string; csrf: string; userId: string; until: number }>();

const localSuperadmin = (a: Viewer) => !a.instance && !a.superadmin && a.role === "admin" && !!superadminOf(INSTANCE_ID, a.screen_name, a.id);

// Pages that would let an impersonator take the account over or move its money.
const KEPT_FROM_IMPERSONATORS =
	/^\/(account\/(2fa|email|passkey|passkeys|sessions|money|migrate|api|apps|import|merchant|reset|organisation|automation|delete)(\/|$)|admin(\/|$)|(i|1\.1)\/account\/(change_password|deactivate)|i\/api\/xitter\/money|xitter\/money)/;
export const impersonationRefuses = (viewer: Viewer | undefined, path: string) => !!viewer?.impersonator && KEPT_FROM_IMPERSONATORS.test(path.replace(/^\/i\/api(?=\/(1\.1|i)\/)/, ""));

export const impersonateActions: Record<string, Action> = {
	impersonate: {
		role: "admin",
		run: async (a, b) => {
			if (!localSuperadmin(a)) throw new AdminError("Only superadmins can sign in as someone.", 403);
			const id = idOf(b.id);
			if (id === a.id) throw new AdminError("That's you.");
			const [u] = await sql`select id::text, screen_name, role, instance, status, deactivated_at from users where id = ${id}::bigint`;
			if (!u) throw new AdminError("No such account.", 404);
			if (u.instance) throw new AdminError("Only accounts from this instance.");
			if (u.role || superadminOf(INSTANCE_ID, u.screen_name, u.id)) throw new AdminError("Staff can't be impersonated.");
			if (u.status === "suspended" || u.deactivated_at) throw new AdminError("That account is suspended or deactivated.");
			const [me] = await sql`select id::text, password_hash, totp_enabled from users where id = ${a.id}::bigint`;
			const refused = await reauthenticate(me, b.password, b.code);
			if (refused) throw new AdminError(refused, 403);
			const token = randomBytes(20).toString("hex"), csrf = randomBytes(32).toString("hex");
			await sql`insert into sessions (token, user_id, csrf, impersonator_id, expires_at)
				values (${sessionKey(token)}, ${id}::bigint, ${csrf}, ${a.id}::bigint, now() + make_interval(mins => ${MINUTES}))`;
			const ticket = randomBytes(24).toString("hex");
			for (const [k, t] of tickets) if (t.until < Date.now()) tickets.delete(k);
			tickets.set(ticket, { actorId: a.id, token, csrf, userId: id, until: Date.now() + 60_000 });
			await audit(a, "impersonate", id, { reason: String(b.reason ?? "").slice(0, 500) || undefined, minutes: MINUTES });
			return { url: `/account/impersonate/${ticket}` };
		},
	},
};

export async function impersonateRoute(req: Request, path: string, viewer: Viewer | undefined): Promise<Response | undefined> {
	if (path === "/account/impersonate/exit") {
		const back = parseCookies(req)[RETURN_COOKIE];
		const headers = new Headers({ location: "/admin" });
		if (viewer?.impersonator) await sql`delete from sessions where token = ${viewer.token}`;
		const [own] = back ? await sql`select s.csrf, s.user_id::text from sessions s join users u on u.id = s.user_id where s.token = ${sessionKey(back)} and s.impersonator_id is null` : [];
		if (own) for (const c of sessionCookies({ token: back!, csrf: own.csrf, userId: own.user_id })) headers.append("set-cookie", c);
		else headers.set("location", "/");
		headers.append("set-cookie", `${RETURN_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${SECURE}`);
		return new Response(null, { status: 303, headers });
	}
	const m = /^\/account\/impersonate\/([0-9a-f]{48})$/.exec(path);
	if (!m) return undefined;
	const t = tickets.get(m[1]!);
	tickets.delete(m[1]!);
	const own = parseCookies(req)[SESSION_COOKIE];
	if (!t || t.until < Date.now() || !viewer || viewer.id !== t.actorId || viewer.impersonator || !own) return new Response("That link has expired.", { status: 403 });
	const headers = new Headers({ location: "/home" });
	for (const c of sessionCookies({ token: t.token, csrf: t.csrf, userId: t.userId })) headers.append("set-cookie", c);
	headers.append("set-cookie", `${RETURN_COOKIE}=${own}; Path=/; Max-Age=${MINUTES * 60}; HttpOnly; SameSite=Lax${SECURE}`);
	return new Response(null, { status: 303, headers });
}
