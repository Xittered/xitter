// Settings > Your account: password, deactivation. Username and language go
// through account/settings.json (rest.ts) and use the helpers here.
import { hateInName } from "./hate";
import { forgetHeld, handleHeld } from "./held";
import { automodStrike, shutOut } from "./moderation";
import { blockedNameIn, suspendForName } from "./names";
import { isReserved, usernameProblem } from "./invites";
import { superadminNameHere } from "./superadmins";
import { sql } from "./db";
import { type Viewer, clearedCookies } from "./auth";
import { passwordTry } from "./ratelimit";

const error = (code: number, message: string, status = 400) => Response.json({ errors: [{ code, message }] }, { status });

async function body(req: Request): Promise<Record<string, string>> {
	const out: Record<string, string> = {};
	const type = req.headers.get("content-type") ?? "";
	if (type.includes("json")) {
		const j = await req.json().catch(() => ({}));
		for (const [k, v] of Object.entries(j as Record<string, unknown>)) if (typeof v === "string") out[k] = v;
		return out;
	}
	const f = await req.formData().catch(() => undefined);
	if (f) for (const [k, v] of f) if (typeof v === "string") out[k] = v;
	return out;
}

// counted with signing in's tries for the account: from inside a session the
// password could otherwise be guessed without end
async function passwordCheck(viewer: Viewer, password: string | undefined): Promise<"ok" | "wrong" | "limited"> {
	const refund = passwordTry(viewer.screen_name.toLowerCase());
	if (!refund) return "limited";
	if (!password) return "wrong";
	const [u] = await sql`select password_hash from users where id = ${viewer.id}::bigint`;
	if (!u || !(await Bun.password.verify(password, u.password_hash).catch(() => false))) return "wrong";
	refund();
	return "ok";
}
const tooMany = () => error(88, "Too many tries for this account. Wait 15 minutes.", 429);

export async function changeUsername(viewer: Viewer, wanted: string): Promise<string | undefined> {
	if (wanted === viewer.screen_name) return undefined;
	const problem = usernameProblem(wanted);
	if (problem) return problem;
	if (superadminNameHere(viewer.screen_name)) return "A superadmin's username can't change.";
	if (isReserved(wanted)) return "That username is reserved.";
	if (await handleHeld(wanted, viewer.id)) return "That username isn't available.";
	const [renames] = await sql`select count(*)::int as n from username_changes where user_id = ${viewer.id}::bigint and changed_at > now() - interval '1 day'`;
	if (renames.n >= 5) return "You've changed your username too often today. Try again tomorrow.";
	const [taken] = await sql`select 1 from users where lower(screen_name) = lower(${wanted}) and id <> ${viewer.id}::bigint`;
	if (taken) return "That username has been taken. Please choose another.";
	const hate = hateInName(wanted);
	if (hate) {
		await automodStrike(viewer.id, hate, "name", wanted);
		return "That username isn't allowed here.";
	}
	// a blocked word (names.ts): staff are only refused, anyone else is suspended
	const blocked = blockedNameIn(wanted);
	if (blocked) {
		if (!viewer.role) await suspendForName(viewer.id, wanted);
		return "That username isn't allowed here.";
	}
	await sql`insert into username_changes (user_id, old_name, new_name) values (${viewer.id}::bigint, ${viewer.screen_name}, ${wanted})`;
	await sql`update users set screen_name = ${wanted} where id = ${viewer.id}::bigint`;
	forgetHeld();
	return undefined;
}

export async function usernameAvailable(userId: string, wanted: string): Promise<{ available: boolean; suggestions: string[] }> {
	const valid = !usernameProblem(wanted) && !isReserved(wanted) && !(await handleHeld(wanted, userId));
	const [taken] = valid ? await sql`select 1 from users where lower(screen_name) = lower(${wanted}) and id <> ${userId}::bigint` : [{}];
	if (valid && !taken) return { available: true, suggestions: [] };
	const base = wanted.replace(/[^A-Za-z0-9_]/g, "").slice(0, 11) || "user";
	const suggestions: string[] = [];
	for (let i = 0; suggestions.length < 3 && i < 20; i++) {
		const candidate = `${base}${Math.floor(Math.random() * 9000) + 100}`.slice(0, 15);
		const [used] = await sql`select 1 from users where lower(screen_name) = lower(${candidate})`;
		if (!used && !suggestions.includes(candidate)) suggestions.push(candidate);
	}
	return { available: false, suggestions };
}

export async function accountSettingsRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	if (method !== "POST") return undefined;

	if (/^\/(?:i|1\.1)\/account\/change_password(?:\.json)?$/.test(path)) {
		const f = await body(req);
		// the hash read here is the one the update below must still find
		const [account] = await sql`select password_hash from users where id = ${viewer.id}::bigint`;
		const checked = await passwordCheck(viewer, f.current_password);
		if (checked === "limited") return tooMany();
		if (!account || checked !== "ok") return error(231, "Your current password is incorrect.", 403);
		const next = f.new_password ?? f.password ?? "";
		if (next.length < 8) return error(214, "Your password needs to be at least 8 characters.");
		if (next.length > 256) return error(214, "Passwords are at most 256 characters.");
		if (next !== (f.password_confirmation ?? next)) return error(214, "The two passwords don't match.");
		if (next === f.current_password) return error(214, "Your new password must be different from your current one.");
		const passwordHash = await Bun.password.hash(next);
		const changed = await sql.begin(async (tx) => {
			// Recheck the hash while taking the account lock: another password change
			// or reset may have completed since the current password was verified.
			const rows = await tx`update users set password_hash = ${passwordHash}
				where id = ${viewer.id}::bigint and password_hash = ${account.password_hash} returning id`;
			if (!rows.length) return false;
			await tx`update password_resets set used = true where user_id = ${viewer.id}::bigint and not used`;
			// Other devices have to sign in again with the new password.
			await tx`delete from sessions where user_id = ${viewer.id}::bigint and token <> ${viewer.token}`;
			await tx`delete from api_tokens where user_id = ${viewer.id}::bigint`;
			await tx`delete from oauth_codes where user_id = ${viewer.id}::bigint`;
			await tx`delete from login_challenges where user_id = ${viewer.id}::bigint`;
			// a passkey someone else added mustn't outlast the new password
			await tx`delete from passkeys where user_id = ${viewer.id}::bigint`;
			await tx`delete from passkey_challenges where user_id = ${viewer.id}::bigint`;
			await tx`update email_confirmations set used = true where user_id = ${viewer.id}::bigint and not used`;
			return true;
		});
		if (!changed) return error(231, "Your current password is incorrect.", 403);
		return Response.json({ status: "ok" });
	}

	if (path === "/1.1/account/verify_password.json") {
		const checked = await passwordCheck(viewer, (await body(req)).password);
		if (checked === "limited") return tooMany();
		return checked === "ok" ? Response.json({ status: "ok" }) : error(231, "Your password is incorrect.", 403);
	}

	if (path === "/1.1/account/deactivate.json") {
		const f = await body(req);
		const checked = await passwordCheck(viewer, f.current_password ?? f.password);
		if (checked === "limited") return tooMany();
		if (checked !== "ok") return error(231, "Your password is incorrect.", 403);
		if (viewer.role) return error(214, "Staff accounts can't be deactivated here.");
		const [standing] = await sql`select status, status_until from users where id = ${viewer.id}::bigint`;
		if (standing?.status !== "active" || standing.status_until) return error(214, "Your account can't be deactivated while a sanction is in effect.");
		await sql`update users set status = 'suspended', deactivated_at = now() where id = ${viewer.id}::bigint`;
		await shutOut(viewer.id);
		const headers = new Headers();
		for (const c of clearedCookies()) headers.append("set-cookie", c);
		return Response.json({ status: "ok" }, { headers });
	}
	return undefined;
}

// Settings > Security > Apps and sessions. The client names a session by a hash
// of its token, so the real token never leaves the server.
import { createHash } from "node:crypto";

const hashed = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 32);

function describeAgent(ua: string | null): { name: string; icon: string } {
	const text = ua ?? "";
	const browser = /Edg\//.test(text) ? "Edge" : /OPR\//.test(text) ? "Opera" : /Firefox\//.test(text) ? "Firefox" : /Chrome\//.test(text) ? "Chrome" : /Safari\//.test(text) ? "Safari" : "Browser";
	const os = /Android/.test(text) ? "Android" : /iPhone|iPad|iOS/.test(text) ? "iOS" : /Windows/.test(text) ? "Windows" : /Mac OS X/.test(text) ? "macOS" : /Linux/.test(text) ? "Linux" : "an unknown device";
	return { name: `${browser} on ${os}`, icon: /Android|iPhone|iPad/.test(text) ? "mobile" : "desktop" };
}

export async function sessionsList(viewer: Viewer) {
	const rows = await sql`select token, user_agent, last_seen_at from sessions where user_id = ${viewer.id}::bigint order by last_seen_at desc`;
	return rows.map((r: any) => {
		const d = describeAgent(r.user_agent);
		return {
			__typename: "UserSession",
			token: hashed(r.token),
			hashed_token: hashed(r.token),
			device_name: d.name,
			name: d.name,
			device_summary: d.name,
			summary: d.name,
			icon_type: d.icon === "mobile" ? "Mobile" : "Desktop",
			is_current_session: r.token === viewer.token,
			location: "",
			last_seen_at: new Date(r.last_seen_at).getTime(),
			last_seen_time_ms: new Date(r.last_seen_at).getTime(),
		};
	});
}

export async function revokeSessionsRoute(method: string, path: string, viewer: Viewer, req: Request): Promise<Response | undefined> {
	if (method !== "POST") return undefined;
	if (path === "/account/sessions/revoke_all") {
		await sql`delete from sessions where user_id = ${viewer.id}::bigint and token <> ${viewer.token}`;
		return Response.json({ status: "ok" });
	}
	if (path === "/account/sessions/revoke") {
		const f = await body(req);
		const wanted = f.hashed_token ?? f.token ?? f.session_token ?? "";
		const rows = await sql`select token from sessions where user_id = ${viewer.id}::bigint`;
		const hit = rows.find((r: any) => hashed(r.token) === wanted && r.token !== viewer.token);
		if (hit) await sql`delete from sessions where token = ${hit.token}`;
		return Response.json({ status: "ok" });
	}
	return undefined;
}
