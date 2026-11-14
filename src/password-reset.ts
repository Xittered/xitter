// Forgot password: a mailed link opens a page that sets a new one. Tokens are
// stored hashed, last an hour and work once.
import { createHash } from "node:crypto";
import { accountPage, esc } from "./account-page";
import { sql } from "./db";
import { PUBLIC_ORIGIN } from "./config";
import { mailEnabled, sendMail } from "./mail";
import { settings } from "./settings";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

// always answers the same, so the dialog can't be used to find out who has an account
export async function requestReset(usernameOrEmail: string): Promise<void> {
	const who = usernameOrEmail.trim().replace(/^@/, "");
	if (!who || !mailEnabled()) return;
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
	const u = await sql.begin(async (tx) => {
		// Lock before reading the recipient and issuing the token. Changing the
		// verified email uses the same lock and invalidates previously issued links.
		const [account] = await tx`select id::text, screen_name, email from users
			where (lower(screen_name) = lower(${who}) or lower(email) = lower(${who}))
			and email is not null and status <> 'suspended' and instance is null for update`;
		if (!account) return undefined;
		const [recent] = await tx`select 1 from password_resets where user_id = ${account.id}::bigint and created_at > now() - interval '2 minutes'`;
		if (recent) return undefined;
		await tx`insert into password_resets (token_hash, user_id) values (${hash(token)}, ${account.id}::bigint)`;
		return account;
	});
	if (!u) return;
	const name = settings().instance_name;
	// not awaited: the answer must take as long whether or not there was an account to mail
	void sendMail(
		u.email,
		`Reset your ${name} password`,
		`Hi @${u.screen_name},\n\nSomeone asked to reset the password of your ${name} account. Open this link within an hour to choose a new one:\n\n${PUBLIC_ORIGIN}/account/reset?token=${token}\n\nIf this wasn't you, ignore this message: your password stays as it is.`,
		{ kind: "password_reset", userId: u.id },
	).catch((e) => console.error("password reset mail:", e.message));
}

async function valid(token: string): Promise<{ user_id: string } | undefined> {
	if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
	const [row] = await sql`select user_id::text from password_resets
		where token_hash = ${hash(token)} and not used and created_at > clock_timestamp() - interval '1 hour'`;
	return row;
}

const page = (req: Request, body: string, status = 200) => accountPage({ req, title: "Reset password", body, status });

const form = (req: Request, token: string, error = "") =>
	page(
		req,
		`<h1>Choose a new password</h1>${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post" action="/account/reset"><input type="hidden" name="token" value="${esc(token)}">
<input type="password" name="password" placeholder="New password (8+ characters)" autocomplete="new-password" required minlength="8">
<input type="password" name="confirm" placeholder="Repeat it" autocomplete="new-password" required minlength="8">
<button type="submit">Change password</button></form>`,
	);

export async function resetRoute(req: Request, url: URL): Promise<Response> {
	if (req.method === "GET") {
		const token = url.searchParams.get("token") ?? "";
		return (await valid(token)) ? form(req, token) : page(req, `<h1>Link expired</h1><p>This reset link is invalid or has been used. <a href="/">Back to sign in</a>, then ask for a new one.</p>`, 410);
	}
	const f = await req.formData().catch(() => undefined);
	const token = String(f?.get("token") ?? "");
	const row = await valid(token);
	if (!row) return page(req, `<h1>Link expired</h1><p>This reset link is invalid or has been used. <a href="/">Back to sign in</a>, then ask for a new one.</p>`, 410);
	const password = String(f?.get("password") ?? "");
	if (password.length < 8) return form(req, token, "Your password needs to be at least 8 characters.");
	if (password.length > 256) return form(req, token, "Passwords are at most 256 characters.");
	if (password !== String(f?.get("confirm") ?? "")) return form(req, token, "The two passwords don't match.");
	const passwordHash = await Bun.password.hash(password);
	const changed = await sql.begin(async (tx) => {
		// Serialize resets for this account, including requests using different links.
		await tx`select id from users where id = ${row.user_id}::bigint for update`;
		// Transaction-start time must not extend a link's life while this waits.
		const [claimed] = await tx`update password_resets set used = true
			where token_hash = ${hash(token)} and not used and created_at > clock_timestamp() - interval '1 hour'
			returning user_id`;
		if (!claimed) return false;
		await tx`update users set password_hash = ${passwordHash} where id = ${row.user_id}::bigint`;
		// Older links must not be able to replace the newly chosen password either.
		await tx`update password_resets set used = true where user_id = ${row.user_id}::bigint and not used`;
		await tx`delete from sessions where user_id = ${row.user_id}::bigint`;
		await tx`delete from api_tokens where user_id = ${row.user_id}::bigint`;
		// an app approved just before would otherwise trade its code for a new token
		await tx`delete from oauth_codes where user_id = ${row.user_id}::bigint`;
		await tx`delete from login_challenges where user_id = ${row.user_id}::bigint`;
		await tx`delete from passkeys where user_id = ${row.user_id}::bigint`;
		await tx`delete from passkey_challenges where user_id = ${row.user_id}::bigint`;
		await tx`update email_confirmations set used = true where user_id = ${row.user_id}::bigint and not used`;
		return true;
	});
	if (!changed) return page(req, `<h1>Link expired</h1><p>This reset link is invalid or has been used. <a href="/">Back to sign in</a>, then ask for a new one.</p>`, 410);
	return page(req, `<h1>Password changed</h1><p>You can now <a href="/">sign in</a> with it. Every device was signed out and your passkeys were removed.</p>`);
}

// the sign-in dialog's "Forgot password?" leads here
export async function forgotRoute(req: Request, url: URL): Promise<Response> {
	const ask = (value = "") =>
		page(
			req,
			`<h1>Reset your password</h1><p>Enter your username or the email you signed up with. We'll mail you a link.</p>
<form method="post" action="/account/forgot"><input name="who" value="${esc(value)}" placeholder="Username or email" autocomplete="username" required>
<button type="submit">Send reset link</button></form>`,
		);
	if (req.method === "GET") return ask(url.searchParams.get("u") ?? "");
	const f = await req.formData().catch(() => undefined);
	await requestReset(String(f?.get("who") ?? ""));
	return page(req, `<h1>Check your email</h1><p>If that account has an email on file, a reset link is on its way. It works for an hour.</p><p><a href="/">Back to sign in</a></p>`);
}
