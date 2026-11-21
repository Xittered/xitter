// Two-factor sign-in with an authenticator app. Set-up lives on /account/2fa
// (the settings page links to it); the code is asked for in the sign-in dialog.
import { createHash, randomInt } from "node:crypto";
import { accountPage, esc } from "./account-page";
import { sql } from "./db";
import { hit, passwordTry } from "./ratelimit";
import { settings } from "./settings";
import { matchingStep, newSecret, otpauthUrl } from "./totp";
import { startSession, type Session, type Viewer } from "./auth";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ten from 31 letters and digits that can't be mistaken for each other (about
// 49 bits; six digits were 20), shown as two groups of five
const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const backupCode = () => {
	const s = Array.from({ length: 10 }, () => BACKUP_ALPHABET[randomInt(0, BACKUP_ALPHABET.length)]).join("");
	return `${s.slice(0, 5)}-${s.slice(5)}`;
};

async function state(userId: string) {
	const [u] = await sql`select totp_enabled, totp_pending, password_hash from users where id = ${userId}::bigint`;
	return u as { totp_enabled: boolean; totp_pending: string | null; password_hash: string };
}

// a six-digit app code, or one of the one-time backup codes (spent when used)
export async function codeAccepted(userId: string, input: string): Promise<boolean> {
	const [u] = await sql`select totp_secret from users where id = ${userId}::bigint and totp_enabled`;
	if (!u?.totp_secret) return false;
	const step = matchingStep(u.totp_secret, input);
	if (step !== undefined) {
		// A code is good once: the step it came from is kept, and nothing from
		// that step or before passes again, however long the drift window.
		const spent = await sql`update users set totp_last_step = ${step} where id = ${userId}::bigint and totp_enabled
			and (totp_last_step is null or totp_last_step < ${step}) returning id`;
		return spent.length > 0;
	}
	// backup codes: ten letters and digits, or six digits for ones made before
	const clean = input.replace(/[\s-]/g, "").toLowerCase();
	if (!/^(\d{6}|[a-z0-9]{10})$/.test(clean)) return false;
	const hash = sha(clean);
	// Remove only this code, and only if it is still present. Replacing a
	// previously read array lets parallel requests reuse a code or restore one.
	const used = await sql`update users set totp_backup = totp_backup - ${hash}
		where id = ${userId}::bigint and totp_enabled and totp_backup ? ${hash} returning id`;
	return used.length > 0;
}

// Sign-in with the right password but a second factor still to come: a
// 15 minute, five-guess challenge the code screen answers.
export async function startChallenge(screenName: string, password: string): Promise<string | undefined> {
	if (password.length > 1024 || screenName.length > 64) return undefined;
	const [u] = await sql`select id::text, password_hash, totp_enabled from users where lower(screen_name) = lower(${screenName}) and instance is null
		and (deactivated_at is null or deactivated_at > now() - interval '30 days')`;
	if (!u?.totp_enabled) return undefined;
	if (!(await Bun.password.verify(password, u.password_hash).catch(() => false))) return undefined;
	const token = crypto.randomUUID();
	await sql`delete from login_challenges where created_at < now() - interval '15 minutes'`;
	const made = await sql.begin(async (tx) => {
		// The password check was asynchronous. Serialize challenge creation with
		// credential changes, then verify that the checked hash is still current.
		const [current] = await tx`select id from users where id = ${u.id}::bigint
			and password_hash = ${u.password_hash} and totp_enabled and instance is null
			and (deactivated_at is null or deactivated_at > now() - interval '30 days') for update`;
		if (!current) return false;
		await tx`insert into login_challenges (token, user_id) values (${token}::uuid, ${u.id}::bigint)`;
		return true;
	});
	return made ? token : undefined;
}

export async function answerChallenge(token: string, code: string): Promise<{ userId?: string; session?: Session; error?: string; unknown?: boolean }> {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) return { unknown: true };
	// Reserve an attempt before checking the code, including parallel guesses.
	const [c] = await sql`update login_challenges set attempts = attempts + 1
		where token = ${token}::uuid and created_at > clock_timestamp() - interval '15 minutes' and attempts < 5
		returning user_id::text`;
	if (!c) {
		const exhausted = await sql`select 1 from login_challenges where token = ${token}::uuid
			and created_at > clock_timestamp() - interval '15 minutes' and attempts >= 5`;
		return exhausted.length ? { error: "Too many wrong codes. Start signing in again." } : { unknown: true };
	}
	if (!hit("code", c.user_id).ok) return { error: "Too many codes tried for this account. Wait an hour." };
	if (!(await codeAccepted(c.user_id, code))) {
		return { error: "That code isn't right. Check your authenticator app and try again." };
	}
	return sql.begin(async (tx) => {
		// Always lock the account before the challenge, matching password changes.
		// They revoke challenges and sessions under this same account lock.
		const [u] = await tx`select status, totp_enabled, deactivated_at,
			deactivated_at > now() - interval '30 days' as returning
			from users where id = ${c.user_id}::bigint for update`;
		// Waiting for the account lock must not extend this challenge's lifetime.
		const used = await tx`delete from login_challenges where token = ${token}::uuid
			and created_at > clock_timestamp() - interval '15 minutes' returning token`;
		if (!used.length || !u?.totp_enabled) return { unknown: true };
		if (u.returning) await tx`update users set status = 'active', deactivated_at = null where id = ${c.user_id}::bigint`;
		else if (u.deactivated_at) return { error: "This account was deactivated." };
		const session = await startSession(c.user_id, tx);
		return { userId: c.user_id, session };
	});
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
<form method="post" action="/account/2fa/confirm"><input type="password" name="password" placeholder="Your password" autocomplete="current-password" required>
<input name="code" placeholder="6-digit code from the app" inputmode="numeric" autocomplete="one-time-code" required><button type="submit">Turn on</button></form>`,
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
		// the password too: a session someone took mustn't lock the owner out
		// behind an authenticator only the taker has
		const refund = passwordTry(viewer.screen_name.toLowerCase());
		if (!refund) return setup(req, u.totp_pending, viewer, "Too many tries for this account. Wait 15 minutes.");
		if (!(await Bun.password.verify(field("password"), u.password_hash).catch(() => false))) return setup(req, u.totp_pending, viewer, "That password isn't right.");
		refund();
		const step = matchingStep(u.totp_pending, field("code"));
		if (step === undefined) return setup(req, u.totp_pending, viewer, "That code isn't right. Try the next one your app shows.");
		const backups = Array.from({ length: 8 }, backupCode);
		// the code that turned it on is spent too
		await sql`update users set totp_enabled = true, totp_secret = totp_pending, totp_pending = null, totp_last_step = ${step},
			totp_backup = ${JSON.stringify(backups.map((b) => sha(b.replace("-", ""))))}::text::jsonb where id = ${viewer.id}::bigint`;
		return page(
			req,
			viewer,
			`<h1>Two-factor is on</h1><p>Save these backup codes somewhere safe. Each works once if you lose your app. They are shown only now.</p>
<div class="box code">${backups.join("<br>")}</div><p><a href="/settings/account/login_verification">Back to settings</a></p>`,
		);
	}
	if (req.method === "POST" && sub === "/disable" && u.totp_enabled) {
		const refund = passwordTry(viewer.screen_name.toLowerCase());
		if (!refund) return status(req, viewer, true, "Too many tries for this account. Wait 15 minutes.");
		const ok = await Bun.password.verify(field("password"), u.password_hash).catch(() => false);
		if (ok) refund();
		if (!ok || !(await codeAccepted(viewer.id, field("code")))) return status(req, viewer, true, "The password or the code isn't right.");
		await sql`update users set totp_enabled = false, totp_secret = null, totp_pending = null, totp_last_step = null, totp_backup = '[]'::jsonb where id = ${viewer.id}::bigint`;
		return status(req, viewer, false);
	}
	return status(req, viewer, u.totp_enabled);
}
