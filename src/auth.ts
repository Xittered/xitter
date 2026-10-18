import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { newId } from "./ids";
import { expireSanctions } from "./moderation";

export type User = {
	id: string;
	screen_name: string;
	name: string;
	bio: string;
	location: string;
	website?: string;
	avatar_url: string | null;
	banner_url: string | null;
	pinned_post_id?: string | null;
	verified_type: "blue" | "business" | "government" | "government_individual" | null;
	flag?: string | null;
	// custom badges in order (admin panel); see badgeList in model.ts
	badges?: { id: string; name: string }[];
	// see schema.sql: active, restricted, limited or suspended
	status?: "active" | "restricted" | "limited" | "suspended";
	// staff only: admin, moderator or support
	role?: "admin" | "moderator" | "support" | null;
	// the organisation this account is an affiliate of
	// Settings > Discoverability: people with this email in their contacts may find the account
	discoverable_by_email?: boolean;
	// the translator globe: blue, gold (moderator) or yellow (approver)
	translator?: "translator" | "moderator" | "approver" | null;
	// when the badge was given ("Verified since")
	verified_at?: Date | null;
	// `since`: when the account joined the organisation
	org?: { id: string; name: string; screen_name: string; avatar_url: string | null; since?: string } | null;
	// for organisations: how many affiliates they have
	affiliates?: number;
	// the screen name of the account that runs this one (X's automated label)
	automated_by?: string | null;
	// X's profile label: Parody, Commentary or Fan account (or None)
	parody_label?: string;
	// posts only for approved followers
	protected?: boolean;
	language?: string;
	created_at: Date;
	// present when the row was loaded through users.ts
	stats?: {
		posts: number;
		mediaPosts: number;
		// posts carrying an article; the profile shows its Articles tab when there are any
		articles: number;
		highlights?: number;
		likes: number;
		followers: number;
		following: number;
		followedByViewer: boolean;
		followsViewer: boolean;
		// the viewer asked to follow and waits for approval
		requestedByViewer?: boolean;
		blocking?: boolean;
		blockedBy?: boolean;
		muting?: boolean;
		// the viewer's bell for this account, and whether they turned its reposts off
		notifying?: boolean;
		repostsMuted?: boolean;
	};
};

export type Viewer = User & {
	csrf: string;
	token: string;
	postSource?: string;
	// set while a delegate acts as this account (delegation.ts): who they are
	actor?: { id: string; screen_name: string; role: "Admin" | "Contributor" };
};

export const SECURE = PUBLIC_ORIGIN.startsWith("https:") ? "; Secure" : "";
const YEAR = 60 * 60 * 24 * 365;
const randomHex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");

export async function createUser(screenName: string, name: string, password: string): Promise<string> {
	if (!/^[A-Za-z0-9_]{1,15}$/.test(screenName)) throw new Error("screen name: 1-15 letters, digits or underscores");
	if (password.length < 8) throw new Error("password: at least 8 characters");
	const id = newId();
	const hash = await Bun.password.hash(password);
	await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${screenName}, ${name}, ${hash})`;
	return id;
}

export async function login(screenName: string, password: string): Promise<{ token: string; csrf: string; userId: string } | undefined> {
	if (password.length > 1024 || screenName.length > 64) return undefined;
	await expireSanctions();
	// accounts with a second factor sign in through the dialog's code step (startSession)
	const [u] = await sql`select id, password_hash, deactivated_at from users where lower(screen_name) = lower(${screenName}) and not totp_enabled
		and (status <> 'suspended' or deactivated_at > now() - interval '30 days')`;
	// verify against a dummy hash when the user is unknown so timing does not reveal it
	const ok = await Bun.password.verify(password, u?.password_hash ?? DUMMY_HASH).catch(() => false);
	if (!u || !ok) return undefined;
	// signing in within 30 days of deactivating brings the account back
	if (u.deactivated_at) await sql`update users set status = 'active', deactivated_at = null where id = ${u.id}::bigint`;
	const token = randomHex(20);
	const csrf = randomHex(32);
	await sql`insert into sessions (token, user_id, csrf) values (${token}, ${u.id}::bigint, ${csrf})`;
	await sql`update users set last_seen_at = now() where id = ${u.id}::bigint`;
	return { token, csrf, userId: u.id };
}

// a session for an account whose password and second factor were both checked
export async function startSession(userId: string): Promise<{ token: string; csrf: string; userId: string }> {
	const token = randomHex(20);
	const csrf = randomHex(32);
	await sql`insert into sessions (token, user_id, csrf) values (${token}, ${userId}::bigint, ${csrf})`;
	await sql`update users set last_seen_at = now() where id = ${userId}::bigint`;
	return { token, csrf, userId };
}

const DUMMY_HASH = await Bun.password.hash(randomHex(16));

export async function logout(token: string) {
	await sql`delete from sessions where token = ${token}`;
}

export function parseCookies(req: Request): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
	}
	return out;
}

import { countryFromHeader } from "./countries";

const viewerCols = () => sql`u.id, u.screen_name, u.name, u.bio, u.location, u.website, u.avatar_url, u.banner_url, u.verified_type, u.flag, u.status, u.role, u.protected, u.language, u.created_at,
	u.preferences->>'discoverable_by_email' = 'true' as discoverable_by_email,
	(select coalesce(json_agg(json_build_object('id', b.id::text, 'name', b.name) order by ub.position, b.name), '[]')
		from user_badges ub join custom_badges b on b.id = ub.badge_id where ub.user_id = u.id) as badges`;

// an account as a viewer without a session of its own (a delegate acting as it)
export async function viewerById(id: string): Promise<Omit<Viewer, "csrf" | "token"> | undefined> {
	const [row] = await sql`select ${viewerCols()} from users u where u.id = ${id}::bigint and u.status <> 'suspended'`;
	return row as Viewer | undefined;
}

export async function getViewer(req: Request): Promise<Viewer | undefined> {
	const token = parseCookies(req).auth_token;
	if (!token) return undefined;
	const [row] = await sql`select ${viewerCols()}, s.csrf, s.token
		from sessions s join users u on u.id = s.user_id
		where s.token = ${token} and u.status <> 'suspended'`;
	// for the admin panel's session list; written at most once a minute
	if (row)
		await sql`update sessions set last_seen_at = now(), user_agent = ${(req.headers.get("user-agent") ?? "").slice(0, 500)}
			where token = ${token} and (last_seen_at < now() - interval '1 minute' or user_agent is null)`;
	// where the account is based, from the edge's country header; kept from the first request that has one
	const country = row ? countryFromHeader(req.headers.get("cf-ipcountry")) : undefined;
	if (country) await sql`update users set country = ${country} where id = ${row.id}::bigint and country is null`;
	return row as Viewer | undefined;
}

export function sessionCookies(s: { token: string; csrf: string; userId: string }): string[] {
	const base = `Path=/; Max-Age=${YEAR}; SameSite=Lax${SECURE}`;
	return [
		`auth_token=${s.token}; HttpOnly; ${base}`,
		// the client reads these two itself
		`ct0=${s.csrf}; ${base}`,
		`twid=u%3D${s.userId}; ${base}`,
	];
}

export function clearedCookies(): string[] {
	return ["auth_token", "ct0", "twid"].map((n) => `${n}=; Path=/; Max-Age=0; SameSite=Lax${SECURE}`);
}
