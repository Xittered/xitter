// Forgot password: a mailed link opens a page that sets a new one. Tokens are
// stored hashed, last an hour and work once.
import { createHash } from "node:crypto";
import { sql } from "./db";
import { PUBLIC_ORIGIN } from "./config";
import { mailEnabled, sendMail } from "./mail";
import { settings } from "./settings";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

// always answers the same, so the dialog can't be used to find out who has an account
export async function requestReset(usernameOrEmail: string): Promise<void> {
	const who = usernameOrEmail.trim().replace(/^@/, "");
	if (!who || !mailEnabled()) return;
	const [u] = await sql`select id::text, screen_name, email from users
		where (lower(screen_name) = lower(${who}) or lower(email) = lower(${who})) and email is not null and status <> 'suspended'`;
	if (!u) return;
	const [recent] = await sql`select 1 from password_resets where user_id = ${u.id}::bigint and created_at > now() - interval '2 minutes'`;
	if (recent) return;
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
	await sql`insert into password_resets (token_hash, user_id) values (${hash(token)}, ${u.id}::bigint)`;
	const name = settings().instance_name;
	await sendMail(
		u.email,
		`Reset your ${name} password`,
		`Hi @${u.screen_name},\n\nSomeone asked to reset the password of your ${name} account. Open this link within an hour to choose a new one:\n\n${PUBLIC_ORIGIN}/account/reset?token=${token}\n\nIf this wasn't you, ignore this message: your password stays as it is.`,
		{ kind: "password_reset", userId: u.id },
	).catch((e) => console.error("password reset mail:", e.message));
}

async function valid(token: string): Promise<{ user_id: string } | undefined> {
	if (!/^[0-9a-f]{64}$/.test(token)) return undefined;
	const [row] = await sql`select user_id::text from password_resets
		where token_hash = ${hash(token)} and not used and created_at > now() - interval '1 hour'`;
	return row;
}

const page = (body: string, status = 200) =>
	new Response(
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Reset password</title>
<style>body{margin:0;background:#000;color:#e7e9ea;font:16px/1.4 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{width:min(380px,90vw)}h1{font-size:28px;margin:0 0 16px}input,button{width:100%;box-sizing:border-box;padding:14px;border-radius:8px;font:inherit;margin:6px 0}
input{background:#000;border:1px solid #333;color:inherit}button{background:#eff3f4;color:#0f1419;border:0;font-weight:700;cursor:pointer}.err{color:#f4212e}a{color:#1d9bf0}</style></head>
<body><main>${body}</main></body></html>`,
		{ status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } },
	);

const form = (token: string, error = "") =>
	page(`<h1>Choose a new password</h1>${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/account/reset"><input type="hidden" name="token" value="${esc(token)}">
<input type="password" name="password" placeholder="New password (8+ characters)" autocomplete="new-password" required minlength="8">
<input type="password" name="confirm" placeholder="Repeat it" autocomplete="new-password" required minlength="8">
<button type="submit">Change password</button></form>`);

export async function resetRoute(req: Request, url: URL): Promise<Response> {
	if (req.method === "GET") {
		const token = url.searchParams.get("token") ?? "";
		return (await valid(token)) ? form(token) : page(`<h1>Link expired</h1><p>This reset link is invalid or has been used. <a href="/">Back to sign in</a>, then ask for a new one.</p>`, 410);
	}
	const f = await req.formData().catch(() => undefined);
	const token = String(f?.get("token") ?? "");
	const row = await valid(token);
	if (!row) return page(`<h1>Link expired</h1><p>This reset link is invalid or has been used. <a href="/">Back to sign in</a>, then ask for a new one.</p>`, 410);
	const password = String(f?.get("password") ?? "");
	if (password.length < 8) return form(token, "Your password needs to be at least 8 characters.");
	if (password.length > 256) return form(token, "Passwords are at most 256 characters.");
	if (password !== String(f?.get("confirm") ?? "")) return form(token, "The two passwords don't match.");
	await sql`update users set password_hash = ${await Bun.password.hash(password)} where id = ${row.user_id}::bigint`;
	await sql`update password_resets set used = true where token_hash = ${hash(token)}`;
	await sql`delete from sessions where user_id = ${row.user_id}::bigint`;
	return page(`<h1>Password changed</h1><p>You can now <a href="/">sign in</a> with it. Every device was signed out.</p>`);
}

// the sign-in dialog's "Forgot password?" leads here
export async function forgotRoute(req: Request, url: URL): Promise<Response> {
	const ask = (value = "") =>
		page(`<h1>Reset your password</h1><p>Enter your username or the email you signed up with. We'll mail you a link.</p>
<form method="post" action="/account/forgot"><input name="who" value="${esc(value)}" placeholder="Username or email" autocomplete="username" required>
<button type="submit">Send reset link</button></form>`);
	if (req.method === "GET") return ask(url.searchParams.get("u") ?? "");
	const f = await req.formData().catch(() => undefined);
	await requestReset(String(f?.get("who") ?? ""));
	return page(`<h1>Check your email</h1><p>If that account has an email on file, a reset link is on its way. It works for an hour.</p><p><a href="/">Back to sign in</a></p>`);
}
