// The admin panel's API: POST /admin/api/<action> with a JSON body, from a
// signed-in staff account, with the csrf header like every other write.
//
// Roles: support reads everything and can reset passwords and sign people
// out; moderators also change an account's standing and delete posts; admins
// do everything else (profiles, badges, roles, organisations, invites,
// instance settings). Every change is written to the audit log.

import type { Viewer } from "./auth";
import { sql } from "./db";
import { isFlag } from "./flags";
import { isId, newId } from "./ids";
import { createInvite } from "./invites";
import { REASONS } from "./reports";
import { FEATURES, type Feature, type SignupMode, allSettings, setSetting, settings } from "./settings";
import { SLOTS, brandingState, resetBranding, saveBranding } from "./branding";
import { createPlatform, renameWebSource } from "./platforms";
import { TopicError, deleteTopic, listTopics, saveTopic } from "./topics";
import { CardError, deleteCard, listCards, saveCard } from "./explore-cards";
import { mailEnabled, mailFrom, sendMail } from "./mail";
import { mailDigests } from "./mail-digest";
import { toolActions } from "./admin-tools";
import { stickerActions } from "./stickers";
import { hashflagActions } from "./hashflags";
import { switchActions } from "./feature-switches";
import { staffGate } from "./staff-access";

type Role = "admin" | "moderator" | "support";
const RANK: Record<Role, number> = { support: 1, moderator: 2, admin: 3 };

export class AdminError extends Error {
	constructor(
		message: string,
		public status = 400,
	) {
		super(message);
	}
}

type Body = Record<string, any>;
export type Action = { role: Role; run: (actor: Viewer, b: Body, req?: Request) => Promise<unknown> };

export async function audit(actor: Viewer, action: string, target: string | null, detail: unknown = null) {
	await sql`insert into audit_log (id, actor_id, action, target, detail)
		values (${newId()}::bigint, ${actor.id}::bigint, ${action}, ${target}, ${detail === null ? null : JSON.stringify(detail)}::text::jsonb)`;
}

export const idOf = (v: unknown, what = "id") => {
	if (typeof v === "number") v = String(v);
	if (!isId(v) || BigInt(v) > 9223372036854775807n) throw new AdminError(`Missing or bad ${what}.`);
	return v as string;
};

async function userRow(id: string) {
	const [u] = await sql`select id, screen_name, role, status from users where id = ${id}::bigint`;
	if (!u) throw new AdminError("No such account.", 404);
	return u;
}

// nobody acts on an account ranked at or above their own, except on themselves
// The owner, the longest-standing admin, outranks the other admins: they can't
// change the owner's account, the owner can change theirs. Admins otherwise
// can't touch each other.
const ownerId = async () => (await sql`select id::text from users where role = 'admin' order by created_at, id limit 1`)[0]?.id as string | undefined;
const rankOf = (role: string | null, isOwner: boolean) => (isOwner ? 4 : role ? RANK[role as Role] : 0);

export async function guard(actor: Viewer, targetId: string) {
	const u = await userRow(targetId);
	if (targetId === actor.id || !u.role) return u;
	const owner = await ownerId();
	if (rankOf(u.role, targetId === owner) >= rankOf(actor.role ?? null, actor.id === owner))
		throw new AdminError(targetId === owner ? "That account is the instance owner." : "That account is staff at your level or above.", 403);
	return u;
}

const randomPassword = () => {
	const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
	return [...crypto.getRandomValues(new Uint8Array(14))].map((b) => alphabet[b % alphabet.length]).join("");
};

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const userListCols = sql`u.id::text as id, u.screen_name, u.name, u.avatar_url, u.verified_type, u.translator, u.flag, u.status, u.role,
	u.created_at, u.last_seen_at, u.invite_code,
	(select count(*)::int from posts p where p.user_id = u.id) as posts,
	(select count(*)::int from follows f where f.followee_id = u.id) as followers,
	(select o.screen_name from affiliations af join users o on o.id = af.org_id where af.user_id = u.id) as org,
	(select count(*)::int from affiliations af where af.org_id = u.id) as affiliates`;

const ACTIONS: Record<string, Action> = {
	setNotesAccess: { role: "admin", run: async (a, b) => {
		const id = idOf(b.id);
		await guard(a, id);
		if (typeof b.enabled !== "boolean") throw new AdminError("Provide a boolean access setting.");
		await sql`update users set notes_writer = ${b.enabled} where id = ${id}::bigint`;
		await audit(a, "set_notes_access", id, { enabled: b.enabled });
		return {};
	} },
	platforms: { role: "admin", run: async () => ({ platforms: await sql`select id::text, label, revoked, created_at from client_platforms order by id desc` }) },
	createPlatform: { role: "admin", run: async (a, b) => {
		const label = typeof b.label === "string" ? b.label.trim() : "";
		if (!label || [...label].length > 80 || /[\x00-\x1f\x7f]/.test(label)) throw new AdminError("Enter a platform label of 1–80 characters.");
		const result = await createPlatform(label, a.id);
		await audit(a, "create_platform", result.id, { label });
		return result;
	} },
	revokePlatform: { role: "admin", run: async (a, b) => {
		const id = idOf(b.id);
		const rows = await sql`update client_platforms set revoked = true where id = ${id}::bigint returning id`;
		if (!rows.length) throw new AdminError("No such platform.", 404);
		await audit(a, "revoke_platform", id);
		return {};
	} },
	mail: { role: "support", run: async () => ({
		enabled: mailEnabled(),
		from: mailFrom(),
		log: await sql`select m.id::text, m.to_addr, m.kind, m.subject, m.status, m.error, m.created_at, u.screen_name
			from mail_log m left join users u on u.id = m.user_id order by m.created_at desc limit 50`,
	}) },
	// what Resend says to a test mail answers whether the sending domain is verified
	sendTestMail: { role: "admin", run: async (a, b) => {
		const to = typeof b.to === "string" ? b.to.trim() : "";
		if (!/^[^\s@]{1,64}@[^\s@]{1,253}$/.test(to)) throw new AdminError("Enter an email address.");
		const name = settings().instance_name;
		try {
			await sendMail(to, `Test mail from ${name}`, `This is a test from the ${name} admin panel, sent by @${a.screen_name}. If you can read it, mail works.`, { kind: "test", userId: a.id });
		} catch (e: any) {
			throw new AdminError(`Not sent: ${e.message}`);
		}
		await audit(a, "send_test_mail", null, { to });
		return { sent: true };
	} },
	runMailDigests: { role: "admin", run: async () => ({ sent: await mailDigests() }) },
	cards: { role: "support", run: async () => ({ cards: await listCards() }) },
	saveCard: { role: "admin", run: async (a, b) => {
		const id = await saveCard(b).catch((e) => {
			throw e instanceof CardError ? new AdminError(e.message) : e;
		});
		await audit(a, b.id ? "edit_explore_card" : "create_explore_card", id, { title: b.title, kind: b.kind });
		return { id };
	} },
	deleteCard: { role: "admin", run: async (a, b) => {
		const id = idOf(b.id);
		await deleteCard(id).catch((e) => {
			throw e instanceof CardError ? new AdminError(e.message, 404) : e;
		});
		await audit(a, "delete_explore_card", id);
		return {};
	} },
	topics: { role: "support", run: async () => ({ topics: await listTopics() }) },
	saveTopic: { role: "admin", run: async (a, b) => {
		const id = await saveTopic({ ...b, id: b.id ? idOf(b.id) : undefined }).catch((e) => {
			throw e instanceof TopicError ? new AdminError(e.message) : e;
		});
		await audit(a, b.id ? "edit_topic" : "create_topic", id, { name: b.name, keywords: b.keywords });
		return { id };
	} },
	deleteTopic: { role: "admin", run: async (a, b) => {
		const id = idOf(b.id);
		await deleteTopic(id).catch((e) => {
			throw e instanceof TopicError ? new AdminError(e.message, 404) : e;
		});
		await audit(a, "delete_topic", id);
		return {};
	} },
	me: { role: "support", run: async (a) => ({ id: a.id, screen_name: a.screen_name, role: a.role }) },

	stats: {
		role: "support",
		run: async () => {
			const [s] = await sql`select
				(select count(*)::int from users) as users,
				(select count(*)::int from users where status <> 'active') as sanctioned,
				(select count(*)::int from users where last_seen_at > now() - interval '1 day') as active_day,
				(select count(*)::int from users where last_seen_at > now() - interval '7 days') as active_week,
				(select count(*)::int from users where last_seen_at > now() - interval '30 days') as active_month,
				(select count(*)::int from follows) as follows,
				(select count(*)::int from reposts) as reposts,
				(select count(*)::int from bookmarks) as bookmarks,
				(select count(*)::int from posts) as posts,
				(select count(*)::int from posts where created_at > now() - interval '1 day') as posts_today,
				(select count(*)::int from likes) as likes,
				(select count(*)::int from media) as media,
				(select coalesce(sum(size), 0)::bigint::text from media) as media_bytes,
				(select count(*)::int from media where state = 'processing') as videos_processing,
				(select count(*)::int from invites where not revoked and uses < max_uses and (expires_at is null or expires_at > now())) as open_invites,
				(select count(*)::int from reports where status = 'open') as open_reports,
				(select count(*)::int from error_log where not resolved) as open_errors`;
			const days = await sql`select to_char(d, 'YYYY-MM-DD') as day,
				(select count(*)::int from posts p where p.created_at >= d and p.created_at < d + interval '1 day') as posts,
				(select count(*)::int from users u where u.created_at >= d and u.created_at < d + interval '1 day') as signups,
				(select count(*)::int from likes l where l.created_at >= d and l.created_at < d + interval '1 day') as likes,
				(select count(*)::int from follows f where f.created_at >= d and f.created_at < d + interval '1 day') as follows,
				(select count(*)::int from reports r where r.created_at >= d and r.created_at < d + interval '1 day') as reports
				from generate_series(date_trunc('day', now()) - interval '13 days', date_trunc('day', now()), interval '1 day') d order by d`;
			// this week's movers: new followers, liked posts
			const risers = await sql`select u.id::text as id, u.screen_name, u.name, u.avatar_url, u.verified_type, count(*)::int as gained
				from follows f join users u on u.id = f.followee_id where f.created_at > now() - interval '7 days'
				group by u.id order by gained desc, u.id limit 5`;
			const liked = await sql`select p.id::text as id, p.text, u.screen_name, count(*)::int as likes
				from likes l join posts p on p.id = l.post_id join users u on u.id = p.user_id
				where l.created_at > now() - interval '7 days' and not p.hidden
				group by p.id, u.screen_name order by likes desc, p.id desc limit 5`;
			const storage = await sql`select kind, count(*)::int as files, coalesce(sum(size), 0)::bigint::text as bytes from media group by kind order by kind`;
			const sources = await sql`select coalesce(signup_source, 'unknown') as source, count(*)::int as users from users group by 1 order by users desc limit 8`;
			return { ...s, days, risers, liked, storage, sources };
		},
	},

	users: {
		role: "support",
		run: async (_a, b) => {
			const q = String(b.q ?? "").trim().replace(/^@/, "");
			const status = ["active", "restricted", "limited", "suspended"].includes(b.status) ? b.status : null;
			const staff = !!b.staff;
			const match = sql`(${q} = '' or u.screen_name ilike ${like(q)} or u.name ilike ${like(q)})
					and (${status}::text is null or u.status = ${status})
					and (not ${staff} or u.role is not null)`;
			const rows = await sql`select ${userListCols} from users u where ${match}
				order by u.created_at desc, u.id desc limit ${Math.min(Math.max(Number(b.limit) || 50, 1), 500)} offset ${Math.max(Number(b.offset) || 0, 0)}`;
			const [{ total }] = await sql`select count(*)::int as total from users u where ${match}`;
			return { users: rows, total };
		},
	},

	user: {
		role: "support",
		run: async (_a, b) => {
			const id = idOf(b.id);
			const [u] = await sql`select ${userListCols}, u.bio, u.location, u.website, u.based_in_override, u.country, u.count_overrides, u.notes_writer, u.org_badge_id::text, u.status_until,
				(select coalesce(json_agg(ub.badge_id::text order by ub.position), '[]') from user_badges ub where ub.user_id = u.id) as badge_ids,
				(select count(*)::int from sessions s where s.user_id = u.id) as sessions,
				(select c.screen_name from invites i join users c on c.id = i.created_by where i.code = u.invite_code) as invited_by
				from users u where u.id = ${id}::bigint`;
			if (!u) throw new AdminError("No such account.", 404);
			const invited = await sql`select u.id::text as id, u.screen_name from users u join invites i on i.code = u.invite_code
				where i.created_by = ${id}::bigint order by u.created_at`;
			const log = await sql`select l.action, l.detail, l.created_at, a.screen_name as actor from audit_log l
				left join users a on a.id = l.actor_id where l.target = ${id} order by l.id desc limit 50`;
			return { user: u, invited, log };
		},
	},

	updateUser: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const limits: Record<string, [string, number]> = { name: ["name", 50], screen_name: ["screen_name", 15], bio: ["bio", 160], location: ["location", 30], website: ["website", 100], based_in: ["based_in_override", 50] };
			const changes: Record<string, string | null> = {};
			for (const [field, [column, max]] of Object.entries(limits)) {
				if (typeof b[field] !== "string") continue;
				const value = b[field].trim();
				if ([...value].length > max) throw new AdminError(`${field} is at most ${max} characters.`);
				if (field === "screen_name" && !/^[A-Za-z0-9_]{1,15}$/.test(value)) throw new AdminError("Handles are letters, digits and underscores.");
				if (field === "name" && !value) throw new AdminError("Name can't be blank.");
				if (field === "website" && value && !/^https?:\/\/\S+$/.test(value)) throw new AdminError("Website must be an http or https address.");
				// a blank "based in" goes back to the detected region
				changes[column] = field === "based_in" && !value ? null : value;
			}
			if (!Object.keys(changes).length) return {};
			if (changes.screen_name) {
				const [taken] = await sql`select 1 from users where lower(screen_name) = lower(${changes.screen_name}) and id <> ${id}::bigint`;
				if (taken) throw new AdminError("That handle is taken.");
			}
			const [old] = await sql`select screen_name from users where id = ${id}::bigint`;
			await sql`update users set ${sql(changes)} where id = ${id}::bigint`;
			if (changes.screen_name && changes.screen_name !== old.screen_name)
				await sql`insert into username_changes (user_id, old_name, new_name) values (${id}::bigint, ${old.screen_name}, ${changes.screen_name})`;
			await audit(a, "edit_profile", id, changes);
			return {};
		},
	},

	setTranslator: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const kind = b.translator || null;
			if (kind !== null && !["translator", "moderator", "approver"].includes(kind)) throw new AdminError("Unknown translator badge.");
			await guard(a, id);
			await sql`update users set translator = ${kind} where id = ${id}::bigint`;
			await audit(a, "set_translator", id, { translator: kind });
			return {};
		},
	},
	setBadge: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const badge = b.badge || null;
			if (badge !== null && !["blue", "business", "government", "government_individual"].includes(badge)) throw new AdminError("Unknown badge.");
			await guard(a, id);
			// an account stops being an organisation when it loses the gold or grey (government) badge
			if (badge !== "business" && badge !== "government") {
				await sql`delete from affiliations where org_id = ${id}::bigint`;
				await sql`delete from affiliation_requests where org_id = ${id}::bigint`;
			}
			// verified_at: "Verified since" on the About page; a new badge type starts it again
			await sql`update users set verified_at = case when ${badge}::text is null then null when verified_type is distinct from ${badge}::text then now() else verified_at end,
				verified_type = ${badge} where id = ${id}::bigint`;
			await audit(a, "set_badge", id, { badge });
			return {};
		},
	},

	setFlag: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const flag = b.flag || null;
			if (flag !== null && !isFlag(flag)) throw new AdminError("Unknown flag.");
			await guard(a, id);
			await sql`update users set flag = ${flag} where id = ${id}::bigint`;
			await audit(a, "set_flag", id, { flag });
			return {};
		},
	},

	setStatus: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const status = b.status;
			if (!["active", "restricted", "limited", "suspended"].includes(status)) throw new AdminError("Unknown standing.");
			if (id === a.id) throw new AdminError("You can't change your own standing.");
			await guard(a, id);
			await sql`update users set status = ${status}, status_until = null, status_restore = null where id = ${id}::bigint`;
			if (status === "suspended") await sql`delete from sessions where user_id = ${id}::bigint`;
			await audit(a, "set_status", id, { status, reason: String(b.reason ?? "").slice(0, 500) || undefined });
			return {};
		},
	},

	setRole: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const role = b.role || null;
			if (role !== null && !(role in RANK)) throw new AdminError("Unknown role.");
			if (id === a.id && role !== "admin") {
				const [{ n }] = await sql`select count(*)::int as n from users where role = 'admin'`;
				if (n <= 1) throw new AdminError("You are the last admin.");
			}
			// nobody demotes staff at or above their own rank, the owner included
			await guard(a, id);
			await sql`update users set role = ${role} where id = ${id}::bigint`;
			await audit(a, "set_role", id, { role });
			return {};
		},
	},

	resetPassword: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const password = randomPassword();
			await sql`update users set password_hash = ${await Bun.password.hash(password)} where id = ${id}::bigint`;
			await sql`delete from sessions where user_id = ${id}::bigint`;
			await audit(a, "reset_password", id);
			return { password };
		},
	},

	signOut: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const rows = await sql`delete from sessions where user_id = ${id}::bigint returning token`;
			await audit(a, "sign_out", id, { sessions: rows.length });
			return { sessions: rows.length };
		},
	},

	deleteUser: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			if (id === a.id) throw new AdminError("You can't delete your own account here.");
			const u = await guard(a, id);
			if (String(b.confirm ?? "").toLowerCase() !== u.screen_name.toLowerCase()) throw new AdminError("Type the handle to confirm.");
			await sql`delete from users where id = ${id}::bigint`;
			await audit(a, "delete_account", id, { screen_name: u.screen_name });
			return {};
		},
	},

	orgs: {
		role: "support",
		run: async () => ({
			orgs: await sql`select ${userListCols} from users u where u.verified_type in ('business', 'government') order by u.name`,
		}),
	},

	createOrg: {
		role: "admin",
		run: async (a, b) => {
			const screenName = String(b.screen_name ?? "").trim().replace(/^@/, "");
			const name = String(b.name ?? "").trim() || screenName;
			if (!/^[A-Za-z0-9_]{4,15}$/.test(screenName)) throw new AdminError("Handles are 4 to 15 letters, digits or underscores.");
			const [taken] = await sql`select 1 from users where lower(screen_name) = lower(${screenName})`;
			if (taken) throw new AdminError("That handle is taken.");
			const password = randomPassword();
			const id = newId();
			await sql`insert into users (id, screen_name, name, password_hash, verified_type)
				values (${id}::bigint, ${screenName}, ${name}, ${await Bun.password.hash(password)}, 'business')`;
			await audit(a, "create_org", id, { screen_name: screenName });
			return { id, password };
		},
	},

	affiliates: {
		role: "support",
		run: async (_a, b) => ({
			affiliates: await sql`select ${userListCols} from affiliations af join users u on u.id = af.user_id
				where af.org_id = ${idOf(b.orgId, "organisation")}::bigint order by af.created_at desc`,
		}),
	},

	addAffiliate: {
		role: "admin",
		run: async (a, b) => {
			const orgId = idOf(b.orgId, "organisation");
			const [org] = await sql`select verified_type from users where id = ${orgId}::bigint`;
			if (org?.verified_type !== "business" && org?.verified_type !== "government") throw new AdminError("Only accounts with the gold or grey organisation badge are organisations.");
			const [u] = await sql`select id::text as id from users where lower(screen_name) = lower(${String(b.screen_name ?? "").replace(/^@/, "")})`;
			if (!u) throw new AdminError("No account with that handle.");
			if (u.id === orgId) throw new AdminError("An organisation can't be its own affiliate.");
			// one organisation per person; adding moves them
			await sql`insert into affiliations (org_id, user_id) values (${orgId}::bigint, ${u.id}::bigint)
				on conflict (user_id) do update set org_id = excluded.org_id, created_at = now()`;
			await audit(a, "add_affiliate", u.id, { org: orgId });
			return {};
		},
	},

	removeAffiliate: {
		role: "admin",
		run: async (a, b) => {
			const orgId = idOf(b.orgId, "organisation");
			const userId = idOf(b.userId, "account");
			await sql`delete from affiliations where org_id = ${orgId}::bigint and user_id = ${userId}::bigint`;
			await audit(a, "remove_affiliate", userId, { org: orgId });
			return {};
		},
	},

	posts: {
		role: "support",
		run: async (_a, b) => {
			const q = String(b.q ?? "").trim();
			const author = String(b.author ?? "").trim().replace(/^@/, "");
			const match = sql`(${q} = '' or p.text ilike ${like(q)}) and (${author} = '' or lower(u.screen_name) = lower(${author}))`;
			const rows = await sql`select p.id::text as id, p.text, p.created_at, p.hidden, p.sensitive, p.notice, p.count_overrides, p.reply_to_id::text as reply_to_id, u.screen_name, u.name,
				(select count(*)::int from likes l where l.post_id = p.id) as likes,
				(select count(*)::int from media m where m.post_id = p.id) as media
				from posts p join users u on u.id = p.user_id
				where ${match}
				order by p.id desc limit ${Math.min(Math.max(Number(b.limit) || 50, 1), 500)} offset ${Math.max(Number(b.offset) || 0, 0)}`;
			const [{ total }] = await sql`select count(*)::int as total from posts p join users u on u.id = p.user_id where ${match}`;
			return { posts: rows, total };
		},
	},

	deletePost: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id, "post");
			const [p] = await sql`select p.text, p.user_id::text as user_id from posts p where p.id = ${id}::bigint`;
			if (!p) throw new AdminError("No such post.", 404);
			await guard(a, p.user_id);
			await sql`delete from posts where id = ${id}::bigint`;
			await audit(a, "delete_post", p.user_id, { post: id, text: p.text.slice(0, 280) });
			return {};
		},
	},

	reports: {
		role: "support",
		run: async (_a, b) => {
			const status = ["open", "dismissed", "actioned"].includes(b.status) ? b.status : "open";
			const rows = await sql`select r.id::text as id, r.reason, r.details, r.status, r.note, r.created_at, r.handled_at,
				r.post_id::text as post_id, p.text as post_text, p.created_at as post_created_at,
				(select count(*)::int from media m where m.post_id = r.post_id) as post_media,
				rep.screen_name as reporter, h.screen_name as handled_by,
				u.id::text as user_id, u.screen_name, u.name, u.avatar_url, u.verified_type, u.flag, u.status as user_status, u.role,
				(select count(*)::int from reports o where o.user_id = r.user_id and o.status = 'open' and o.id <> r.id) as other_open,
				(select count(*)::int from reports o where o.user_id = r.user_id and o.status = 'actioned') as actioned_before
				from reports r left join users u on u.id = r.user_id left join posts p on p.id = r.post_id
				left join users rep on rep.id = r.reporter_id left join users h on h.id = r.handled_by
				where r.status = ${status} order by r.id ${status === "open" ? sql`asc` : sql`desc`} limit 100`;
			return { reports: rows, reasons: REASONS };
		},
	},

	resolveReport: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id, "report");
			const status = b.status === "dismissed" ? "dismissed" : "actioned";
			const note = String(b.note ?? "").slice(0, 1000);
			const rows = await sql`update reports set status = ${status}, note = ${note}, handled_by = ${a.id}::bigint, handled_at = now()
				where id = ${id}::bigint returning user_id::text as user_id`;
			if (!rows.length) throw new AdminError("No such report.", 404);
			// other open reports about the same post close with it
			if (b.samePost) await sql`update reports set status = ${status}, note = ${note}, handled_by = ${a.id}::bigint, handled_at = now()
				where status = 'open' and post_id = (select post_id from reports where id = ${id}::bigint)`;
			await audit(a, status === "dismissed" ? "dismiss_report" : "action_report", rows[0].user_id, { report: id, note: note || undefined });
			return {};
		},
	},

	invites: {
		role: "support",
		run: async () => ({
			invites: await sql`select i.code, i.max_uses, i.uses, i.expires_at, i.revoked, i.created_at,
				c.screen_name as created_by, o.screen_name as org,
				(select coalesce(json_agg(u.screen_name order by u.created_at), '[]') from users u where u.invite_code = i.code) as used_by
				from invites i left join users c on c.id = i.created_by left join users o on o.id = i.org_id
				order by i.created_at desc limit 200`,
		}),
	},

	createInvite: {
		role: "admin",
		run: async (a, b) => {
			const count = Math.min(Math.max(Number(b.count) || 1, 1), 50);
			const maxUses = Math.min(Math.max(Number(b.uses) || 1, 1), 10000);
			const days = Number(b.days) || 0;
			const orgId = b.orgId ? idOf(b.orgId, "organisation") : undefined;
			const codes: string[] = [];
			for (let i = 0; i < count; i++)
				codes.push(await createInvite({ createdBy: a.id, maxUses, expiresAt: days > 0 ? new Date(Date.now() + days * 86400e3) : undefined, orgId }));
			await audit(a, "create_invites", null, { count, maxUses, days: days || undefined, org: orgId });
			return { codes };
		},
	},

	revokeInvite: {
		role: "admin",
		run: async (a, b) => {
			const code = String(b.code ?? "");
			await sql`update invites set revoked = true where code = ${code}`;
			await audit(a, "revoke_invite", null, { code });
			return {};
		},
	},

	settings: {
		role: "support",
		run: async () => ({ settings: await allSettings(), features: FEATURES, branding: brandingState(), slots: SLOTS }),
	},

	saveSettings: {
		role: "admin",
		run: async (a, b) => {
			const s = settings();
			const changed: string[] = [];
			if (typeof b.instance_name === "string") {
				const name = b.instance_name.trim();
				if (!name || [...name].length > 30) throw new AdminError("The name is 1 to 30 characters.");
				// it goes into the client's ICU messages (patch.ts), where these are syntax
				if (/[{}<>#\p{Cc}]/u.test(name)) throw new AdminError("The name can't contain { } < > or #.");
				await renameWebSource(s.instance_name, name);
				await setSetting("instance_name", name);
				changed.push("instance_name");
			}
			if (b.features && typeof b.features === "object") {
				const next = { ...s.features };
				for (const k of Object.keys(FEATURES) as Feature[]) if (typeof b.features[k] === "boolean") next[k] = b.features[k];
				await setSetting("features", next);
				changed.push("features");
			}
			if (b.limits && typeof b.limits === "object") {
				const n = (v: unknown, lo: number, hi: number, what: string) => {
					const x = Number(v);
					if (!Number.isFinite(x) || x < lo || x > hi) throw new AdminError(`${what} must be between ${lo} and ${hi}.`);
					return Math.round(x);
				};
				await setSetting("limits", {
					image_mb: n(b.limits.image_mb, 1, 50, "Image size"),
					video_mb: n(b.limits.video_mb, 1, 4096, "Video size"),
					video_seconds: n(b.limits.video_seconds, 5, 7200, "Video length"),
				});
				changed.push("limits");
			}
			if (b.rate_limits && typeof b.rate_limits === "object") {
				const next = { ...s.rate_limits };
				for (const k of Object.keys(next) as (keyof typeof next)[]) {
					if (b.rate_limits[k] === undefined) continue;
					const x = Number(b.rate_limits[k]);
					if (!Number.isInteger(x) || x < 1 || x > 1_000_000) throw new AdminError(`The ${k} limit must be a whole number from 1 to 1000000.`);
					next[k] = x;
				}
				await setSetting("rate_limits", next);
				changed.push("rate_limits");
			}
			if (b.post_limits && typeof b.post_limits === "object") {
				const next = { ...s.post_limits };
				for (const k of Object.keys(next) as (keyof typeof next)[]) {
					if (b.post_limits[k] === undefined) continue;
					const x = Number(b.post_limits[k]);
					if (!Number.isInteger(x) || x < 1 || x > 1_000_000) throw new AdminError("Post lengths must be whole numbers from 1 to 1000000.");
					next[k] = x;
				}
				await setSetting("post_limits", next);
				changed.push("post_limits");
			}
			if (b.announcement && typeof b.announcement === "object") {
				const text = String(b.announcement.text ?? "").trim().slice(0, 500);
				const link = String(b.announcement.link ?? "").trim();
				if (link && !/^https?:\/\/\S+$/.test(link)) throw new AdminError("The announcement link must be an http or https address.");
				// a new id brings the banner back for people who closed the old one
				await setSetting("announcement", { id: text ? newId() : "", text, link });
				changed.push("announcement");
			}
			if (Array.isArray(b.default_follows)) {
				const handles = [...new Set(b.default_follows.map((h: unknown) => String(h).trim().replace(/^@/, "")).filter(Boolean))] as string[];
				const found = handles.length ? await sql`select screen_name from users where lower(screen_name) = any(${sql.array(handles.map((h) => h.toLowerCase()), "TEXT")})` : [];
				const missing = handles.filter((h) => !found.some((f: any) => f.screen_name.toLowerCase() === h.toLowerCase()));
				if (missing.length) throw new AdminError(`No account named ${missing.map((m) => `@${m}`).join(", ")}.`);
				await setSetting("default_follows", found.map((f: any) => f.screen_name));
				changed.push("default_follows");
			}
			if (typeof b.source_url === "string") {
				const url = b.source_url.trim();
				if (!/^https?:\/\/\S+$/.test(url)) throw new AdminError("The source link must be an http or https address.");
				await setSetting("source_url", url);
				changed.push("source_url");
			}
			if (typeof b.rules === "string") {
				await setSetting("rules", b.rules.slice(0, 20000));
				changed.push("rules");
			}
			await audit(a, "save_settings", null, { changed });
			return {};
		},
	},

	resetBranding: {
		role: "admin",
		run: async (a, b) => {
			resetBranding(String(b.slot));
			await audit(a, "reset_branding", null, { slot: b.slot });
			return {};
		},
	},

	setSignupMode: {
		role: "admin",
		run: async (a, b) => {
			const mode = b.mode as SignupMode;
			if (!["invite", "open", "closed"].includes(mode)) throw new AdminError("Unknown sign-up mode.");
			await setSetting("signup_mode", mode);
			await audit(a, "set_signup_mode", null, { mode });
			return {};
		},
	},

	audit: {
		role: "support",
		run: async (_a, b) => ({
			entries: await sql`select l.id::text as id, l.action, l.target, l.detail, l.created_at, a.screen_name as actor,
				t.screen_name as target_name
				from audit_log l left join users a on a.id = l.actor_id
				left join users t on l.target ~ '^[0-9]+$' and t.id = l.target::bigint
				order by l.id desc limit 100 offset ${Number(b.offset) || 0}`,
		}),
	},
};

Object.assign(ACTIONS, toolActions);
Object.assign(ACTIONS, stickerActions);
Object.assign(ACTIONS, hashflagActions);
Object.assign(ACTIONS, switchActions);

export async function adminApi(req: Request, action: string, viewer: Viewer | undefined): Promise<Response> {
	const fail = (message: string, status: number) => Response.json({ error: message }, { status });
	if (!viewer?.role) return fail("Staff only.", 403);
	if (req.method !== "POST") return fail("Use POST.", 405);
	if (req.headers.get("x-csrf-token") !== viewer.csrf) return fail("Missing csrf token.", 403);
	const blocked = await staffGate(req, viewer);
	if (blocked) return fail(blocked, 403);
	// a logo or icon upload: the image itself is the body
	if (action === "uploadBranding") {
		if (viewer.role !== "admin") return fail("Needs the admin role.", 403);
		const slot = new URL(req.url).searchParams.get("slot") ?? "";
		const error = await saveBranding(slot, new Uint8Array(await req.arrayBuffer()));
		if (error) return fail(error, 400);
		await audit(viewer, "upload_branding", null, { slot });
		return Response.json({});
	}
	const a = ACTIONS[action];
	if (!a) return fail("Unknown action.", 404);
	if (RANK[viewer.role as Role] < RANK[a.role]) return fail(`Needs the ${a.role} role.`, 403);
	const body = await req.json().catch(() => ({}));
	try {
		return Response.json((await a.run(viewer, body ?? {}, req)) ?? {});
	} catch (e) {
		if (e instanceof AdminError) return fail(e.message, e.status);
		throw e;
	}
}
