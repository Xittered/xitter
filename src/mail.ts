// Outgoing mail: over SMTP when SMTP_URL is set (an own mail server, e.g.
// smtp://user:pass@host:587 with STARTTLS or smtps://...:465), else through
// Resend. With both set, Resend is the fallback for a send SMTP refused. The
// host in SMTP_URL must be the name on the server's certificate.
// Every attempt is kept in mail_log (Admin > Settings > Email), including the
// ones skipped for want of a transport, so it shows whether mail would have gone out.
import nodemailer from "nodemailer";
import addressparser from "nodemailer/lib/addressparser";
import { sql } from "./db";
import { newId } from "./ids";
import { settings } from "./settings";

const KEY = process.env.RESEND_API_KEY;
const SMTP_URL = process.env.SMTP_URL;
const FROM_ADDRESS = "noreply@xit.chococat.lol";
// without MAIL_FROM the sender is named after the instance; quoted, as a name may hold commas
export const mailFrom = () => process.env.MAIL_FROM ?? `${JSON.stringify(settings().instance_name)} <${FROM_ADDRESS}>`;

export const mailEnabled = () => !!(SMTP_URL || KEY);

const BARE_ADDRESS = /^[^\s\x00-\x1f\x7f@<>()[\]\\,;:"]{1,64}@[^\s\x00-\x1f\x7f@<>()[\]\\,;:"]{1,253}\.[^\s\x00-\x1f\x7f@<>()[\]\\,;:".]{2,}$/;

export function validEmail(email: string): boolean {
	if (email.length > 254 || !BARE_ADDRESS.test(email)) return false;
	const parsed = addressparser(email);
	return parsed.length === 1 && !("group" in parsed[0]) && parsed[0].address === email;
}

const smtp = SMTP_URL
	? nodemailer.createTransport(SMTP_URL, {
			pool: true,
			maxConnections: 3,
			connectionTimeout: 15_000,
			greetingTimeout: 15_000,
			socketTimeout: 30_000,
		})
	: undefined;

async function log(to: string, kind: string, subject: string, status: "sent" | "failed" | "skipped", error: string | null, userId?: string) {
	await sql`insert into mail_log (id, user_id, to_addr, kind, subject, status, error)
		values (${newId()}::bigint, ${userId ?? null}, ${to}, ${kind}, ${subject}, ${status}, ${error})`.catch(() => {});
}

async function viaSmtp(to: string, subject: string, text: string): Promise<string | undefined> {
	try {
		await smtp!.sendMail({ from: mailFrom(), to, subject, text });
		return undefined;
	} catch (e) {
		return `SMTP: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
	}
}

async function viaResend(to: string, subject: string, text: string): Promise<string | undefined> {
	const r = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
		body: JSON.stringify({ from: mailFrom(), to: [to], subject, text }),
		signal: AbortSignal.timeout(15_000),
	}).catch((e: Error) => e);
	if (r instanceof Error) return r.message;
	// Resend explains itself, e.g. that the sending domain isn't verified yet
	return r.ok ? undefined : `Resend ${r.status}: ${(await r.text()).slice(0, 300)}`;
}

export async function sendMail(to: string, subject: string, text: string, meta: { kind?: string; userId?: string } = {}): Promise<void> {
	const kind = meta.kind ?? "other";
	if (!validEmail(to)) throw new Error("that isn't a single email address");
	if (!mailEnabled()) {
		await log(to, kind, subject, "skipped", "neither SMTP_URL nor RESEND_API_KEY is set", meta.userId);
		throw new Error("mail isn't configured (SMTP_URL or RESEND_API_KEY)");
	}
	let error = smtp ? await viaSmtp(to, subject, text) : undefined;
	if ((!smtp || error) && KEY) {
		const fallback = await viaResend(to, subject, text);
		error = fallback && error ? `${error}; ${fallback}` : fallback;
	}
	if (error) {
		await log(to, kind, subject, "failed", error, meta.userId);
		throw new Error(error);
	}
	await log(to, kind, subject, "sent", null, meta.userId);
}
