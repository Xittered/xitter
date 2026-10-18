// Two-factor sign-in with an authenticator app. Set-up lives on /account/2fa
// (the settings page links to it); the code is asked for in the sign-in dialog.
import { createHash, randomInt } from "node:crypto";
import { accountPage, esc } from "./account-page";
import { sql } from "./db";
import { settings } from "./settings";
import { newSecret, otpauthUrl, verifyCode } from "./totp";
import type { Viewer } from "./auth";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

async function state(userId: string) {
	const [u] = await sql`select totp_enabled, totp_pending, password_hash from users where id = ${userId}::bigint`;
	return u as { totp_enabled: boolean; totp_pending: string | null; password_hash: string };
}

// a six-digit app code, or one of the one-time backup codes (spent when used)
export async function codeAccepted(userId: string, input: string): Promise<boolean> {
	const [u] = await sql`select totp_secret, totp_backup from users where id = ${userId}::bigint and totp_enabled`;
	if (!u?.totp_secret) return false;
	if (verifyCode(u.totp_secret, input)) return true;
	const clean = input.replace(/[\s-]/g, "").toLowerCase();
	const hashes: string[] = u.totp_backup ?? [];
	const hit = hashes.indexOf(sha(clean));
	if (!/^\d{6}$/.test(clean) || hit < 0) return false;
	hashes.splice(hit, 1);
	await sql`update users set totp_backup = ${JSON.stringify(hashes)}::text::jsonb where id = ${userId}::bigint`;
	return true;
}

// Sign-in with the right password but a second factor still to come: a
// 15 minute, five-guess challenge the code screen answers.
export async function startChallenge(screenName: string, password: string): Promise<string | undefined> {
	if (password.length > 1024 || screenName.length > 64) return undefined;
	const [u] = await sql`select id::text, password_hash, totp_enabled from users where lower(screen_name) = lower(${screenName})
		and (status <> 'suspended' or deactivated_at > now() - interval '30 days')`;
	if (!u?.totp_enabled) return undefined;
	if (!(await Bun.password.verify(password, u.password_hash).catch(() => false))) return undefined;
	const token = crypto.randomUUID();
	await sql`delete from login_challenges where created_at < now() - interval '15 minutes'`;
	await sql`insert into login_challenges (token, user_id) values (${token}::uuid, ${u.id}::bigint)`;
	return token;
}

export async function answerChallenge(token: string, code: string): Promise<{ userId?: string; error?: string; unknown?: boolean }> {
	if (!/^[0-9a-f-]{36}$/i.test(token)) return { unknown: true };
	const [c] = await sql`select user_id::text, attempts from login_challenges where token = ${token}::uuid and created_at > now() - interval '15 minutes'`;
	if (!c) return { unknown: true };
	if (c.attempts >= 5) {
		await sql`delete from login_challenges where token = ${token}::uuid`;
		return { error: "Too many wrong codes. Start signing in again." };
	}
	if (!(await codeAccepted(c.user_id, code))) {
		await sql`update login_challenges set attempts = attempts + 1 where token = ${token}::uuid`;
		return { error: "That code isn't right. Check your authenticator app and try again." };
	}
	await sql`delete from login_challenges where token = ${token}::uuid`;
	const [u] = await sql`select status, deactivated_at > now() - interval '30 days' as returning from users where id = ${c.user_id}::bigint`;
	if (u?.returning) await sql`update users set status = 'active', deactivated_at = null where id = ${c.user_id}::bigint`;
	else if (!u || u.status === "suspended") return { error: "This account is suspended." };
	return { userId: c.user_id };
}

const page = (req: Request, viewer: Viewer, body: string) => accountPage({ req, viewer, title: "Two-factor authentication", body });

const status = (req: Request, viewer: Viewer, enabled: boolean, error = "") =>
	page(
		req,
		viewer,
		enabled
			? `<h1>Two-factor authentication</h1><p>Signing in asks for a code from your authenticator app.</p>${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post" action="/account/2fa/disable"><input type="password" name="password" placeholder="Your password" autocomplete="current-password" required>
<input name="code" placeholder="Code from the app, or a backup code" autocomplete="one-time-code" required><button class="danger" type="submit">Turn off</button></form>`
			: `<h1>Two-factor authentication</h1><p>Use an authenticator app (Aegis, Google Authenticator, 1Password, ...) to get a code each time you sign in.</p>
<form method="post" action="/account/2fa/start"><button type="submit">Set up an authenticator app</button></form>`,
	);

const setup = (req: Request, secret: string, viewer: Viewer, error = "") =>
	page(
		req,
		viewer,
		`<h1>Set up your app</h1><p>Add a new time-based account in your authenticator app with this key (or open the link on a phone):</p>
<div class="box code">${secret.replace(/(.{4})/g, "$1 ").trim()}</div>
<p><a href="${esc(otpauthUrl(secret, viewer.screen_name, settings().instance_name))}">Open in my authenticator app</a></p>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post" action="/account/2fa/confirm"><input name="code" placeholder="6-digit code from the app" inputmode="numeric" autocomplete="one-time-code" required><button type="submit">Turn on</button></form>`,
	);

export async function twoFactorRoute(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	const u = await state(viewer.id);
	const form = req.method === "POST" ? await req.formData().catch(() => undefined) : undefined;
	const field = (k: string) => String(form?.get(k) ?? "");
	const sub = url.pathname.slice("/account/2fa".length);

	if (req.method === "POST" && sub === "/start" && !u.totp_enabled) {
		const secret = newSecret();
		await sql`update users set totp_pending = ${secret} where id = ${viewer.id}::bigint`;
		return setup(req, secret, viewer);
	}
	if (req.method === "POST" && sub === "/confirm" && !u.totp_enabled && u.totp_pending) {
		if (!verifyCode(u.totp_pending, field("code"))) return setup(req, u.totp_pending, viewer, "That code isn't right. Try the next one your app shows.");
		const backups = Array.from({ length: 8 }, () => String(randomInt(0, 1_000_000)).padStart(6, "0"));
		await sql`update users set totp_enabled = true, totp_secret = totp_pending, totp_pending = null,
			totp_backup = ${JSON.stringify(backups.map(sha))}::text::jsonb where id = ${viewer.id}::bigint`;
		return page(
			req,
			viewer,
			`<h1>Two-factor is on</h1><p>Save these backup codes somewhere safe. Each works once if you lose your app. They are shown only now.</p>
<div class="box code">${backups.join("<br>")}</div><p><a href="/settings/account/login_verification">Back to settings</a></p>`,
		);
	}
	if (req.method === "POST" && sub === "/disable" && u.totp_enabled) {
		const ok = await Bun.password.verify(field("password"), u.password_hash).catch(() => false);
		if (!ok || !(await codeAccepted(viewer.id, field("code")))) return status(req, viewer, true, "The password or the code isn't right.");
		await sql`update users set totp_enabled = false, totp_secret = null, totp_pending = null, totp_backup = '[]'::jsonb where id = ${viewer.id}::bigint`;
		return status(req, viewer, false);
	}
	return status(req, viewer, u.totp_enabled);
}
