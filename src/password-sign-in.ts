// The password step of signing in, shared by X's sign-in dialog
// (onboarding.ts) and the OAuth authorize page's own form (oauth.ts): a
// username or email and a password give a session, a second-factor challenge
// to answer, or an error to show under the field.

import { login } from "./auth";
import { sql } from "./db";
import { passwordTry } from "./ratelimit";
import { startChallenge } from "./two-factor";

type Session = { token: string; csrf: string; userId: string };

// an email signs in as the one account that has it, unless it's some account's handle
export async function byEmail(typed: string): Promise<string | undefined> {
	if (!typed.includes("@")) return undefined;
	const [taken] = await sql`select 1 from users where lower(screen_name) = lower(${typed}) and instance is null`;
	if (taken) return undefined;
	const rows = await sql`select screen_name, email_verified, status from users where lower(email) = lower(${typed}) and instance is null order by email_verified desc limit 2`;
	const owner = rows[0]?.email_verified || rows.length === 1 ? rows[0] : undefined;
	return owner && owner.status !== "suspended" ? owner.screen_name : undefined;
}

export async function passwordStep(typed: string, password: string, from: string | null): Promise<{ session: Session } | { challenge: string } | { error: string }> {
	typed = typed.trim().replace(/^@/, "");
	const username = (await byEmail(typed)) ?? typed;
	// guessing one account's password from many addresses still runs out;
	// only wrong passwords count, so signing in on several devices doesn't
	const account = username.toLowerCase();
	const refund = username ? passwordTry(account, from) : () => {};
	if (!refund) return { error: "Too many tries for this account. Wait 15 minutes." };
	const challenge = username && password ? await startChallenge(username, password) : undefined;
	if (challenge) {
		refund();
		return { challenge };
	}
	const session = username && password ? await login(username, password) : undefined;
	if (!session) return { error: "Wrong username or password." };
	refund();
	return { session };
}
