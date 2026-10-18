// An account's email: Settings > Your account > Account information > Email
// reads it (users/email_phone_info), "Update email address" opens our page
// (/account/email: the client's own /i/flow/add_email is X's flow), and a new
// address counts once its link is clicked. Sign-up proves the address with a
// 6-digit code on X's code screen (onboarding.ts) when mail is configured.

import { createHash } from "node:crypto";
import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { mailEnabled, sendMail } from "./mail";
import { settings } from "./settings";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,}$/;
const randomToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

// users/email_phone_info: the client keeps this as its "devices" data
export async function emailInfo(userId: string) {
	const [u] = await sql`select email, email_verified,
		(select c.email from email_confirmations c where c.user_id = u.id and not c.used and c.created_at > now() - interval '1 day' order by c.created_at desc limit 1) as pending
		from users u where u.id = ${userId}::bigint`;
	const emails = [];
	if (u?.email) emails.push({ email: u.email, email_verified: !!u.email_verified });
	if (u?.pending && u.pending !== u.email) emails.push({ email: u.pending, email_verified: false });
	return { emails, phone_numbers: [] };
}

async function sendConfirmation(userId: string, screenName: string, email: string) {
	const token = randomToken();
	await sql`insert into email_confirmations (token_hash, user_id, email) values (${hash(token)}, ${userId}::bigint, ${email})`;
	const name = settings().instance_name;
	await sendMail(
		email,
		`Confirm your email for ${name}`,
		`Hi @${screenName},\n\nOpen this link within a day to use this address for your ${name} account:\n\n${PUBLIC_ORIGIN}/account/email/confirm?token=${token}\n\nIf you didn't ask for this, ignore this message.`,
		{ kind: "email_confirmation", userId },
	);
}

// Settings > Email's "Resend confirmation" for an address that isn't confirmed yet
export async function resendConfirmation(viewer: Viewer): Promise<string | null> {
	const info = await emailInfo(viewer.id);
	const unconfirmed = info.emails.find((e) => !e.email_verified);
	if (!unconfirmed) return "There's no address waiting to be confirmed.";
	if (!mailEnabled()) return "This instance can't send mail.";
	const [recent] = await sql`select 1 from email_confirmations where user_id = ${viewer.id}::bigint and created_at > now() - interval '1 minute'`;
	if (recent) return "A confirmation was just sent. Wait a minute before asking again.";
	await sendConfirmation(viewer.id, viewer.screen_name, unconfirmed.email);
	return null;
}

function emailPage(req: Request, viewer: Viewer, current: { email: string | null; verified: boolean }, message = "", error = "") {
	return accountPage({
		req,
		viewer,
		title: "Email",
		referrer: null,
		status: error ? 400 : 200,
		body: `<form method="post" action="/account/email">
	<h1>Email</h1>
	<p class="dim">${current.email ? `Your account's email is <b>${esc(current.email)}</b>${current.verified ? "" : " (not confirmed yet)"}.` : "Your account has no email yet. Add one so you can reset your password and get the mail you ask for."}</p>
	${message ? `<p>${esc(message)}</p>` : ""}${error ? `<p class="error">${esc(error)}</p>` : ""}
	<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
	<label for="email">New email</label><input id="email" name="email" type="email" autocomplete="email" required>
	<label for="password">Your password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
	<button type="submit">Send confirmation link</button>
	<p class="dim">The new address is used once you open the link we mail to it. <a href="/settings/email">Back to settings</a></p>
</form>`,
	});
}

export async function emailRoute(req: Request, url: URL, viewer: Viewer | undefined): Promise<Response> {
	if (url.pathname === "/account/email/confirm") {
		const token = url.searchParams.get("token") ?? "";
		const [c] = /^[0-9a-f]{64}$/.test(token)
			? await sql`update email_confirmations set used = true where token_hash = ${hash(token)} and not used and created_at > now() - interval '1 day' returning user_id::text, email`
			: [];
		const done = c && (await sql`update users set email = ${c.email}, email_verified = true where id = ${c.user_id}::bigint
			and not exists (select 1 from users o where lower(o.email) = lower(${c.email}) and o.id <> ${c.user_id}::bigint) returning id`).length;
		return accountPage({
			req,
			viewer,
			title: "Email",
			referrer: null,
			status: done ? 200 : 410,
			body: done
				? `<form><h1>Email confirmed</h1><p class="dim">${esc(c.email)} is now your account's email.</p><a href="/settings/email">Back to settings</a></form>`
				: `<form><h1>Link expired</h1><p class="dim">This link is invalid, was used already, or the address belongs to another account now. <a href="/account/email">Try again</a></p></form>`,
		});
	}
	if (!viewer) return Response.redirect("/", 302);
	const [u] = await sql`select email, email_verified, password_hash from users where id = ${viewer.id}::bigint`;
	const current = { email: u.email as string | null, verified: !!u.email_verified };
	if (req.method !== "POST") return emailPage(req, viewer, current);
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return emailPage(req, viewer, current, "", "That form is out of date. Try again.");
	const email = String(f?.get("email") ?? "").trim().toLowerCase();
	if (!EMAIL.test(email) || email.length > 254) return emailPage(req, viewer, current, "", "Enter a valid email address.");
	if (!(await Bun.password.verify(String(f?.get("password") ?? ""), u.password_hash).catch(() => false))) return emailPage(req, viewer, current, "", "That password isn't right.");
	if ((await sql`select 1 from users where lower(email) = ${email} and id <> ${viewer.id}::bigint`).length) return emailPage(req, viewer, current, "", "That email is already used by another account.");
	if (!mailEnabled()) return emailPage(req, viewer, current, "", "This instance can't send mail, so it can't confirm a new address. Ask its staff.");
	try {
		await sendConfirmation(viewer.id, viewer.screen_name, email);
	} catch (e: any) {
		return emailPage(req, viewer, current, "", `The mail couldn't be sent: ${e.message}`);
	}
	return emailPage(req, viewer, current, `We sent a link to ${email}. Open it within a day to switch.`);
}

// Sign-up: the code mailed to the address the account is being made with.
// Five tries, fifteen minutes.
export async function sendSignupCode(token: string, email: string) {
	const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
	await sql`update signup_sessions set email_code_hash = ${hash(`${token}:${code}`)}, email_code_at = now(), email_attempts = 0 where token = ${token}::uuid`;
	const name = settings().instance_name;
	await sendMail(email, `${code} is your ${name} code`, `Enter ${code} to confirm this address and finish making your ${name} account. It works for 15 minutes.\n\nIf you didn't sign up, ignore this message.`, { kind: "signup_code" });
}

export async function checkSignupCode(token: string, code: string): Promise<"ok" | "wrong" | "expired"> {
	const [s] = await sql`update signup_sessions set email_attempts = email_attempts + 1 where token = ${token}::uuid and email_code_hash is not null
		returning email_code_hash, email_code_at, email_attempts`;
	if (!s || s.email_attempts > 5 || new Date(s.email_code_at).getTime() < Date.now() - 15 * 60_000) return "expired";
	return s.email_code_hash === hash(`${token}:${code.replace(/\D/g, "")}`) ? "ok" : "wrong";
}
