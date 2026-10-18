// Sign-up by invite. Codes come from scripts/invite.ts for now and from the
// admin panel later. A code is spent in the same transaction that creates the
// account, so two people can't both use its last use.

import { hateInName } from "./hate";
import { handleHeld } from "./held";
import { blockedNameIn } from "./names";
import { sql } from "./db";
import { isFlag } from "./flags";
import { newId } from "./ids";
import { getSetting, settings } from "./settings";

// Eight digits ("4821-0937"): X's sign-up dialog takes the code in digit boxes,
// and digits are easy to read out and type on a phone.
export const CODE_DIGITS = 8;

export function newCode(): string {
	const digits = [...crypto.getRandomValues(new Uint32Array(CODE_DIGITS))].map((n) => n % 10).join("");
	return `${digits.slice(0, 4)}-${digits.slice(4)}`;
}

export const normalizeCode = (code: string) => code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{4})(?=.)/g, "$1-");

export async function createInvite(opts: { createdBy?: string; maxUses?: number; expiresAt?: Date; orgId?: string } = {}): Promise<string> {
	const code = newCode();
	await sql`insert into invites (code, created_by, max_uses, expires_at, org_id)
		values (${code}, ${opts.createdBy ?? null}::bigint, ${opts.maxUses ?? 1}, ${opts.expiresAt ?? null}, ${opts.orgId ?? null}::bigint)`;
	return code;
}

// Handles that would clash with the client's own pages (x.com/<name> is a
// profile, so /home or /settings can't be one) or pretend to be staff.
const RESERVED = new Set(
	"all home explore notifications messages chat settings search compose i login logout signup signin register admin root api public media abs abouts about tos privacy help support account accounts verified premium jobs grok lists bookmarks communities topics hashtag intent share oauth xitter twitter x moderator mod staff system".split(" "),
);

export const isReserved = (name: string) => RESERVED.has(name.toLowerCase());

// handles staff may give an account in the admin panel: any characters up to
// 50, except what would break a profile address, a list of names or a mention
export const STAFF_HANDLE = /^[^\s\p{C}/\\?#@%,:]{1,50}$/u;
export const staffHandleProblem = (name: string): string | null =>
	!STAFF_HANDLE.test(name) || /^\.+$/.test(name) ? "Handles are up to 50 characters, with no spaces or / \\ ? # @ % , :" : null;

export class SignupError extends Error {}

// what's wrong with a new username, said plainly: "letters, digits and
// underscores" alone reads as if the underscore were the problem
export function usernameProblem(name: string): string | null {
	if (/[^A-Za-z0-9_]/.test(name)) return "Usernames can only have letters, digits and underscores.";
	if (name.length > 15) return `Usernames are at most 15 characters; this one has ${name.length}.`;
	if (name.length < 4) return "Usernames are at least 4 characters.";
	return null;
}

// for the check while typing: same rules as signUp below
export async function usernameState(raw: string): Promise<"available" | "taken" | "invalid"> {
	const screenName = raw.trim().replace(/^@/, "");
	if (!/^[A-Za-z0-9_]{4,15}$/.test(screenName)) return "invalid";
	if (RESERVED.has(screenName.toLowerCase())) return "taken";
	const [taken] = await sql`select 1 from users where lower(screen_name) = lower(${screenName})`;
	return taken || (await handleHeld(screenName)) ? "taken" : "available";
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

type SignupForm = { code: string; screenName: string; name: string; password: string; email: string; flag?: string; ip?: string | null };

const CANONICAL_EMAIL = (column: ReturnType<typeof sql>) => sql`case when split_part(lower(${column}), '@', 2) in ('gmail.com', 'googlemail.com')
	then replace(regexp_replace(split_part(lower(${column}), '@', 1), '[+].*$', ''), '.', '') || '@gmail.com'
	else regexp_replace(split_part(lower(${column}), '@', 1), '[+].*$', '') || '@' || split_part(lower(${column}), '@', 2) end`;

const SUSPENDED_MEMBER = sql`u.status = 'suspended' and u.deactivated_at is null and u.role is null`;

export async function evadedSuspension(email: string, ip: string | null | undefined): Promise<{ user: string; by: "email" | "address" } | undefined> {
	const [byEmail] = await sql`select u.id::text from users u where ${SUSPENDED_MEMBER} and u.email is not null
		and ${CANONICAL_EMAIL(sql`u.email`)} = ${CANONICAL_EMAIL(sql`${email}::text`)} limit 1`;
	if (byEmail) return { user: byEmail.id, by: "email" };
	const [retiredEmail] = await sql`select user_id::text from retired_identities where kind = 'email'
		and ${CANONICAL_EMAIL(sql`value`)} = ${CANONICAL_EMAIL(sql`${email}::text`)} limit 1`;
	if (retiredEmail) return { user: retiredEmail.user_id ?? "", by: "email" };
	if (!ip) return undefined;
	const [retiredIp] = await sql`select user_id::text from retired_identities where kind = 'ip' and value = ${ip} and created_at > now() - interval '30 days'`;
	if (retiredIp) return { user: retiredIp.user_id ?? "", by: "address" };
	const [byIp] = await sql`select u.id::text from login_events e join users u on u.id = e.user_id
		where e.ip = ${ip} and e.created_at > now() - interval '30 days' and ${SUSPENDED_MEMBER} limit 1`;
	return byIp ? { user: byIp.id, by: "address" } : undefined;
}

// The checks sign-up makes before anything is stored, so the emailed-code step
// (onboarding.ts) can refuse a bad form before sending a code.
export async function checkSignup(f: SignupForm) {
	const email = f.email.trim().toLowerCase();
	if (!EMAIL.test(email) || email.length > 254) throw new SignupError("Enter a valid email address.");
	const screenName = f.screenName.trim().replace(/^@/, "");
	const name = f.name.trim() || screenName;
	const problem = usernameProblem(screenName);
	if (problem) throw new SignupError(problem);
	if (RESERVED.has(screenName.toLowerCase())) throw new SignupError("That username is reserved.");
	if (await handleHeld(screenName)) throw new SignupError("That username isn't available.");
	// a blocked word in the handle or name (names.ts): no account at all
	if (blockedNameIn(screenName, name) || hateInName(screenName, name)) throw new SignupError("That username isn't allowed here.");
	if ([...name].length > 50) throw new SignupError("Names are at most 50 characters.");
	if (f.password.length < 8) throw new SignupError("Passwords are at least 8 characters.");
	if (f.password.length > 256) throw new SignupError("Passwords are at most 256 characters.");
	if ((await getSetting("signup_mode")) === "closed") throw new SignupError("Sign-up is closed on this instance.");
	if ((await sql`select 1 from users where lower(screen_name) = lower(${screenName})`).length) throw new SignupError("That username is taken.");
	if ((await sql`select 1 from users where lower(email) = ${email}`).length) throw new SignupError("That email is already used by another account.");
	const evaded = await evadedSuspension(email, f.ip);
	if (evaded) {
		await sql`insert into audit_log (id, actor_id, action, target, detail) values (${newId()}::bigint, null, 'evasion_signup_refused', ${evaded.user},
			${JSON.stringify({ by: evaded.by, screen_name: screenName, ip: f.ip ?? null })}::text::jsonb)`;
		throw new SignupError("Sign-up isn't available for you right now. If you think this is a mistake, contact this instance's staff.");
	}
	return { email, screenName, name };
}

// `source`, `country`: the app and country of the sign-up, for "About this account".
// `passwordHash`: the password, already hashed, when the form was checked and
// kept while the emailed code was entered; `emailVerified` then too.
export async function signUp(
	f: Omit<SignupForm, "password"> & { password?: string; passwordHash?: string; emailVerified?: boolean; source?: string | null; country?: string | null },
): Promise<string> {
	const { email, screenName, name } = await checkSignup({ ...f, password: f.passwordHash ? "--------" : (f.password ?? "") });
	const flag = isFlag(f.flag) ? f.flag : null;
	const mode = await getSetting("signup_mode");
	const hash = f.passwordHash ?? (await Bun.password.hash(f.password ?? ""));
	const code = normalizeCode(f.code);
	const id = newId();
	await sql.begin(async (tx) => {
		const [taken] = await tx`select 1 from users where lower(screen_name) = lower(${screenName})`;
		if (taken) throw new SignupError("That username is taken.");
		const [mailTaken] = await tx`select 1 from users where lower(email) = ${email}`;
		if (mailTaken) throw new SignupError("That email is already used by another account.");
		// with open sign-up a code is optional, but one that is given must be good
		const [invite] =
			mode === "open" && !code
				? [undefined]
				: await tx`update invites set uses = uses + 1
					where code = ${code} and not revoked and uses < max_uses and (expires_at is null or expires_at > now())
						and not exists (select 1 from users c where c.id = invites.created_by and c.status = 'suspended' and c.deactivated_at is null) returning code, org_id`;
		if (!invite && !(mode === "open" && !code)) throw new SignupError("That invite code is not valid or has been used up.");
		await tx`insert into users (id, screen_name, name, password_hash, invite_code, flag, email, email_verified, signup_source, signup_country)
			values (${id}::bigint, ${screenName}, ${name}, ${hash}, ${invite ? code : null}, ${flag}, ${email}, ${!!f.emailVerified}, ${f.source ?? null}, ${f.country ?? null})`;
		// an organisation's invite makes the new account its affiliate
		if (invite?.org_id) await tx`insert into affiliations (org_id, user_id) values (${invite.org_id}::bigint, ${id}::bigint)`;
		// the accounts the admin panel says everyone starts out following
		const follows = settings().default_follows.map((h) => h.toLowerCase());
		if (follows.length)
			await tx`insert into follows (follower_id, followee_id)
				select ${id}::bigint, u.id from users u where lower(u.screen_name) = any(${sql.array(follows, "TEXT")}) and u.status <> 'suspended'
				on conflict do nothing`;
	});
	return id;
}
