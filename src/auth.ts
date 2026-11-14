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
	pronouns?: string | null;
	// custom badges in order (admin panel); see badgeList in model.ts
	badges?: { id: string; name: string }[];
	remote_badges?: { name: string; url: string }[];
	// see schema.sql: active, restricted, limited or suspended
	status?: "active" | "restricted" | "limited" | "suspended";
	// staff only: admin, moderator or support
	role?: "admin" | "moderator" | "support" | null;
	// the organisation this account is an affiliate of
	// Settings > Discoverability: people with this email in their contacts may find the account
	discoverable_by_email?: boolean;
	// Settings > Post details (classic-detail.ts)
	classic_post_details?: boolean;
	// the translator globe: blue, gold (moderator) or yellow (approver)
	translator?: "translator" | "moderator" | "approver" | null;
	// when the badge was given ("Verified since")
	verified_at?: Date | null;
	// `since`: when the account joined the organisation
	org?: { id: string; name: string; screen_name: string; avatar_url: string | null; since?: string } | null;
	// the other organisations it is an affiliate of, up to three, after `org`
	more_orgs?: { id: string; name: string; screen_name: string; avatar_url: string | null }[];
	// for organisations: how many affiliates they have
	affiliates?: number;
	// the screen name of the account that runs this one (X's automated label)
	automated_by?: string | null;
	// X's profile label: Parody, Commentary or Fan account (or None)
	parody_label?: string;
	// a profile label staff made (account_labels), in the same place
	label?: { text: string; badge_id: string | null; url: string | null } | null;
	// posts only for approved followers
	protected?: boolean;
	language?: string;
	// two-letter code: detected at sign-in, or picked in Settings > Country
	country?: string | null;
	// the instance the account lives on; null for this one
	instance?: string | null;
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
	instance?: string | null;
	superadmin?: boolean;
	// set while a delegate acts as this account (delegation.ts): who they are
	actor?: { id: string; screen_name: string; role: "Admin" | "Contributor" };
};

export const SECURE = PUBLIC_ORIGIN.startsWith("https:") ? "; Secure" : "";
// A site on a sibling subdomain can set a cookie for the whole domain, and so
// plant its own session in a visitor's browser. Browsers refuse a __Host-
// cookie from anywhere but this exact host, so the session cookies carry the
// prefix wherever they can (it needs Secure, so not on plain http).
const HOST_ONLY = SECURE ? "__Host-" : "";
export const SESSION_COOKIE = `${HOST_ONLY}auth_token`;
export const MULTI_COOKIE = `${HOST_ONLY}auth_multi`;
const YEAR = 60 * 60 * 24 * 365;
// a session unused this long is over, whatever its cookie's Max-Age says
export const SESSION_IDLE_DAYS = 90;
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
	const [u] = await sql`select id, password_hash from users where lower(screen_name) = lower(${screenName}) and not totp_enabled and instance is null
		and (status <> 'suspended' or deactivated_at > now() - interval '30 days')`;
	// verify against a dummy hash when the user is unknown so timing does not reveal it
	const ok = await Bun.password.verify(password, u?.password_hash ?? DUMMY_HASH).catch(() => false);
	if (!u || !ok) return undefined;
	const token = randomHex(20);
	const csrf = randomHex(32);
	const made = await sql.begin(async (tx) => {
		// Hash verification runs without a lock. Recheck under the same account
		// lock as password resets, so revoking sessions cannot miss this sign-in.
		const [current] = await tx`select status, deactivated_at from users
			where id = ${u.id}::bigint and password_hash = ${u.password_hash} and not totp_enabled and instance is null for update`;
		if (!current) return false;
		// Signing in within 30 days of deactivating brings the account back.
		if (current.deactivated_at) {
			const back = await tx`update users set status = 'active', deactivated_at = null
				where id = ${u.id}::bigint and deactivated_at > now() - interval '30 days' returning id`;
			if (!back.length) return false;
		} else if (current.status === "suspended") return false;
		await tx`insert into sessions (token, user_id, csrf) values (${token}, ${u.id}::bigint, ${csrf})`;
		await tx`update users set last_seen_at = now() where id = ${u.id}::bigint`;
		return true;
	});
	return made ? { token, csrf, userId: u.id } : undefined;
}

export type Session = { token: string; csrf: string; userId: string };

// Pass the existing transaction when consuming a second-factor challenge, so
// password resets cannot slip between the proof and the session insertion.
export async function startSession(userId: string, executor: typeof sql = sql): Promise<Session> {
	const token = randomHex(20);
	const csrf = randomHex(32);
	const made = await executor`insert into sessions (token, user_id, csrf) select ${token}, id, ${csrf} from users where id = ${userId}::bigint and status <> 'suspended' returning token`;
	if (!made.length) throw new Error("account suspended");
	await executor`update users set last_seen_at = now() where id = ${userId}::bigint`;
	return { token, csrf, userId };
}

const DUMMY_HASH = await Bun.password.hash(randomHex(16));

export async function logout(token: string) {
	const [s] = await sql`delete from sessions where token = ${token} returning user_id, superadmin`;
	if (s?.superadmin)
		await sql`update users set role = null where id = ${s.user_id} and instance is not null
			and not exists (select 1 from sessions x where x.user_id = users.id and x.superadmin and x.expires_at > now())`;
}

export async function expireSessions() {
	await sql`delete from sessions where last_seen_at < now() - make_interval(days => ${SESSION_IDLE_DAYS})`;
}

export function parseCookies(req: Request): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (req.headers.get("cookie") ?? "").split(/;\s*/)) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
	}
	return out;
}

import { requestCountry } from "./login-history";

const viewerCols = () => sql`u.id, u.screen_name, u.name, u.bio, u.location, u.website, u.avatar_url, u.banner_url, u.verified_type, u.flag, u.pronouns, u.status, u.role, u.protected, u.language, u.country, u.created_at, u.instance,
	u.preferences->>'discoverable_by_email' = 'true' as discoverable_by_email,
	u.preferences->>'classic_post_details' = 'true' as classic_post_details,
	(select coalesce(json_agg(json_build_object('id', b.id::text, 'name', b.name) order by ub.position, b.name), '[]')
		from user_badges ub join custom_badges b on b.id = ub.badge_id where ub.user_id = u.id) as badges`;

// an account as a viewer without a session of its own (a delegate acting as it)
export async function viewerById(id: string): Promise<Omit<Viewer, "csrf" | "token"> | undefined> {
	const [row] = await sql`select ${viewerCols()} from users u where u.id = ${id}::bigint and u.status <> 'suspended'`;
	return row as Viewer | undefined;
}

const TOUCH_MS = 60_000;
const MAX_TOUCHED = 50_000;
const touched = new Map<string, number>();

async function loadViewer(req: Request): Promise<Viewer | undefined> {
	const token = parseCookies(req)[SESSION_COOKIE];
	if (!token) return undefined;
	const [row] = await sql`select ${viewerCols()}, s.csrf, s.token, s.superadmin
		from sessions s join users u on u.id = s.user_id
		where s.token = ${token} and u.status <> 'suspended' and (s.expires_at is null or s.expires_at > now())
			and s.last_seen_at > now() - make_interval(days => ${SESSION_IDLE_DAYS})
			and (u.instance is null or (s.superadmin and s.expires_at is not null))`;
	// for the admin panel's session list; written at most once a minute, and a
	// session this server touched within the minute isn't asked again
	if (row && Date.now() - (touched.get(token) ?? 0) >= TOUCH_MS) {
		await sql`update sessions set last_seen_at = now(), user_agent = ${(req.headers.get("user-agent") ?? "").slice(0, 500)}
			where token = ${token} and (last_seen_at < now() - interval '1 minute' or user_agent is null)`;
		if (touched.size >= MAX_TOUCHED) touched.clear();
		touched.set(token, Date.now());
	}
	// where the account is based, from the edge's country header; kept from the first request that has one
	const country = row && !row.country ? requestCountry(req) : undefined;
	if (country) await sql`update users set country = ${country} where id = ${row.id}::bigint and country is null`;
	return row as Viewer | undefined;
}

const viewers = new WeakMap<Request, Promise<Viewer | undefined>>();

export function getViewer(req: Request): Promise<Viewer | undefined> {
	const known = viewers.get(req);
	if (known) return known;
	const loading = loadViewer(req);
	viewers.set(req, loading);
	return loading;
}

export function csrfCookie(csrf: string): string {
	return `ct0=${csrf}; Path=/; Max-Age=${YEAR}; SameSite=Lax${SECURE}`;
}

export function sessionCookies(s: { token: string; csrf: string; userId: string }): string[] {
	const base = `Path=/; Max-Age=${YEAR}; SameSite=Lax${SECURE}`;
	return [
		`${SESSION_COOKIE}=${s.token}; HttpOnly; ${base}`,
		// the client reads these two itself
		csrfCookie(s.csrf),
		`twid=u%3D${s.userId}; ${base}`,
	];
}

export function clearedCookies(): string[] {
	// the unprefixed name too: a session cookie from before the prefix
	return [...new Set([SESSION_COOKIE, "auth_token", "ct0", "twid"])].map((n) => `${n}=; Path=/; Max-Age=0; SameSite=Lax${SECURE}`);
}
