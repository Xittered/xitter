// The admin panel's moderation and instance tools: custom badges, private staff
// notes, messages and strikes, appeals, temporary sanctions, sessions, post
// and article visibility, media, instance controls and server health.
// Registered into admin.ts's actions; the same role rules apply.

import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { type Action, AdminError, audit, guard, idOf } from "./admin";
import { loadBuild } from "./build";
import { sql } from "./db";
import { newId } from "./ids";
import { MEDIA_DIR, sniffImage } from "./media";
import { NOTICE_TYPES } from "./model";
import { hateIn, hateInName } from "./hate";
import { forgetHeld } from "./held";
import { escalate, shutOut } from "./moderation";
import { blockedNameIn, blockedWordIn, suspendForName } from "./names";
import { setSetting, settings } from "./settings";
import { clientIp, ipAllowed, parseRange } from "./staff-access";
import { BACKUP_DIR, createBackup, deleteBackup, listBackups } from "./backups";
import { clientStatus, latestSha, rollbackClient, updateClient } from "./client-update";

const STANDINGS = ["active", "restricted", "limited", "suspended"];

// whole numbers from 0 up for the given keys; blanks dropped, nothing left is null
function countsOf(value: unknown, keys: string[]) {
	const out: Record<string, number> = {};
	const given = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
	for (const k of keys) {
		const v = given[k];
		if (v === undefined || v === null || v === "") continue;
		const n = Number(v);
		if (!Number.isInteger(n) || n < 0 || n > 2_000_000_000) throw new AdminError(`${k} must be a whole number from 0.`);
		out[k] = n;
	}
	return Object.keys(out).length ? out : null;
}

function optionalText(value: unknown, max: number) {
	const text = typeof value === "string" ? value.trim() : "";
	if ([...text].length > max) throw new AdminError(`Up to ${max} characters.`);
	return text;
}

function textOf(value: unknown, max = 2000) {
	const text = typeof value === "string" ? value.trim() : "";
	if (!text || [...text].length > max) throw new AdminError(`Enter 1–${max} characters.`);
	return text;
}

// one entry per line, trimmed and lower-cased, without repeats
function lines(value: unknown, what: string, tags = false) {
	if (!Array.isArray(value) || value.length > 500 || value.some((x) => typeof x !== "string" || x.length > 80)) throw new AdminError(`Invalid ${what} list.`);
	const out = [...new Set((value as string[]).map((x) => x.trim().toLowerCase()).filter(Boolean))];
	if (tags && out.some((x) => !/^#?[\p{L}\p{N}_]+$/u.test(x))) throw new AdminError("Trends must be hashtag names.");
	return tags ? out.map((x) => x.replace(/^#/, "")) : out;
}

async function badgeExists(id: string | null) {
	if (id && !(await sql`select 1 from custom_badges where id = ${id}::bigint`).length) throw new AdminError("No such badge.");
}

export const toolActions: Record<string, Action> = {
	// custom badges: an image shown in the badge slot after a name
	badges: { role: "support", run: async () => ({ badges: await sql`select id::text, name, mime, created_at,
		(select count(*)::int from users u where u.org_badge_id = b.id or exists (select 1 from user_badges ub where ub.user_id = u.id and ub.badge_id = b.id)) as users
		from custom_badges b order by name` }) },
	createBadge: {
		role: "admin",
		run: async (a, b) => {
			const name = textOf(b.name, 60);
			const encoded = typeof b.image === "string" ? b.image : "";
			if (!encoded || encoded.length > 350_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AdminError("Upload an image up to 256 KB.");
			const image = Buffer.from(encoded, "base64");
			const info = sniffImage(image);
			if (image.length > 256 * 1024 || !info || !["image/png", "image/jpeg", "image/webp"].includes(info.mime) || info.width > 1024 || info.height > 1024)
				throw new AdminError("Use a PNG, JPEG or WebP up to 1024×1024 and 256 KB.");
			const id = newId();
			await sql`insert into custom_badges (id, name, image, mime) values (${id}::bigint, ${name}, ${image}, ${info.mime})`;
			await audit(a, "create_badge", id, { name });
			return { id };
		},
	},
	deleteBadge: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await sql`delete from custom_badges where id = ${id}::bigint`;
			await audit(a, "delete_badge", id);
			return {};
		},
	},
	// profile labels: text where X shows "Parody account", with a badge as the icon
	labels: { role: "support", run: async () => ({ labels: await sql`select l.id::text, l.text, l.badge_id::text, l.url, l.created_at,
		(select count(*)::int from users u where u.label_id = l.id) as users
		from account_labels l order by l.text` }) },
	createLabel: {
		role: "admin",
		run: async (a, b) => {
			const text = textOf(b.text, 40);
			const badge = b.badgeId ? idOf(b.badgeId, "badge") : null;
			await badgeExists(badge);
			const url = optionalText(b.url, 500);
			if (url && !/^https?:\/\/\S+$/.test(url)) throw new AdminError("The link must be an http or https address.");
			const id = newId();
			await sql`insert into account_labels (id, text, badge_id, url) values (${id}::bigint, ${text}, ${badge}::bigint, ${url || null})`;
			await audit(a, "create_label", id, { text });
			return { id };
		},
	},
	deleteLabel: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await sql`delete from account_labels where id = ${id}::bigint`;
			await audit(a, "delete_label", id);
			return {};
		},
	},
	// an account's profile label: X's Parody, Commentary or Fan, a staff-made one, or None
	setProfileLabel: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const pick = typeof b.label === "string" ? b.label : "None";
			if (["None", "Parody", "Commentary", "Fan"].includes(pick)) {
				await sql`update users set parody_label = ${pick}, label_id = null where id = ${id}::bigint`;
			} else {
				const labelId = idOf(pick, "label");
				if (!(await sql`select 1 from account_labels where id = ${labelId}::bigint`).length) throw new AdminError("No such label.");
				await sql`update users set parody_label = 'None', label_id = ${labelId}::bigint where id = ${id}::bigint`;
			}
			await audit(a, "set_profile_label", id, { label: pick });
			return {};
		},
	},
	// an account's custom badges, in the order they show
	setBadges: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			if (!Array.isArray(b.badgeIds) || b.badgeIds.length > 10) throw new AdminError("Choose up to 10 badges.");
			const badges = [...new Set(b.badgeIds.map((x: unknown) => idOf(x, "badge")))] as string[];
			for (const badge of badges) await badgeExists(badge);
			await sql.begin(async (tx) => {
				await tx`delete from user_badges where user_id = ${id}::bigint`;
				for (const [position, badge] of badges.entries())
					await tx`insert into user_badges (user_id, badge_id, position) values (${id}::bigint, ${badge}::bigint, ${position})`;
			});
			await audit(a, "set_badges", id, { badges });
			return {};
		},
	},
	// an organisation's badge for its affiliates, instead of its profile picture
	setOrgBadge: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const badge = b.badgeId ? idOf(b.badgeId) : null;
			await badgeExists(badge);
			const rows = await sql`update users set org_badge_id = ${badge}::bigint where id = ${id}::bigint and verified_type in ('business', 'government') returning id`;
			if (!rows.length) throw new AdminError("Only organisations have an organisation badge.");
			await audit(a, "org_badge", id, { badge });
			return {};
		},
	},

	// notes about an account that only staff see
	staffNotes: { role: "support", run: async (_a, b) => ({ notes: await sql`select n.id::text, n.body, n.created_at, u.screen_name as actor
		from staff_notes n left join users u on u.id = n.actor_id where n.user_id = ${idOf(b.id)}::bigint order by n.id desc limit 100` }) },
	addStaffNote: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			await sql`insert into staff_notes (id, user_id, actor_id, body) values (${newId()}::bigint, ${id}::bigint, ${a.id}::bigint, ${textOf(b.body)})`;
			await audit(a, "add_staff_note", id);
			return {};
		},
	},

	// messages, warnings and strikes: the account sees them in its notifications
	staffMessages: { role: "support", run: async (_a, b) => ({ messages: await sql`select m.id::text, m.kind, m.body, m.created_at, m.read_at, m.revoked_at, u.screen_name as actor
		from staff_messages m left join users u on u.id = m.actor_id where m.user_id = ${idOf(b.id)}::bigint order by m.id desc limit 100` }) },
	sendStaffMessage: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const kind = b.kind ?? "message";
			if (!["message", "warning", "strike"].includes(kind)) throw new AdminError("Unknown message type.");
			const message = newId();
			await sql`insert into staff_messages (id, user_id, actor_id, kind, body) values (${message}::bigint, ${id}::bigint, ${a.id}::bigint, ${kind}, ${textOf(b.body)})`;
			await audit(a, "send_staff_message", id, { kind, message });
			const escalation = kind === "strike" && b.escalate !== false ? await escalate(id, a.id, `strike from @${a.screen_name}`) : undefined;
			return { id: message, escalation };
		},
	},
	revokeStrike: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [m] = await sql`select user_id::text from staff_messages where id = ${id}::bigint and kind = 'strike'`;
			if (!m) throw new AdminError("No such strike.");
			await guard(a, m.user_id);
			await sql`update staff_messages set revoked_at = now() where id = ${id}::bigint`;
			await audit(a, "revoke_strike", m.user_id, { message: id });
			return {};
		},
	},

	appeals: {
		role: "moderator",
		run: async (_a, b) => ({ appeals: await sql`select ap.id::text, ap.user_id::text, u.screen_name, u.name, u.avatar_url, u.status as user_status, ap.body, ap.status, ap.created_at, ap.staff_reply, ap.resolved_at,
			m.kind as message_kind, m.body as message_body, r.screen_name as reviewer
			from moderation_appeals ap join users u on u.id = ap.user_id left join staff_messages m on m.id = ap.message_id left join users r on r.id = ap.reviewer_id
			where ${b.status === "closed" ? sql`ap.status <> 'open'` : sql`ap.status = 'open'`} order by ap.id desc limit 100` }),
	},
	resolveAppeal: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [ap] = await sql`select user_id::text from moderation_appeals where id = ${id}::bigint and status = 'open'`;
			if (!ap) throw new AdminError("No such open appeal.", 404);
			await guard(a, ap.user_id);
			if (!["accepted", "rejected"].includes(b.status)) throw new AdminError("Choose an outcome.");
			await sql`update moderation_appeals set status = ${b.status}, staff_reply = ${textOf(b.reply)}, reviewer_id = ${a.id}::bigint, resolved_at = now() where id = ${id}::bigint`;
			await audit(a, "resolve_appeal", ap.user_id, { appeal: id, status: b.status });
			return {};
		},
	},

	// a standing that goes back to the previous one after some hours
	setTemporaryStatus: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			if (id === a.id) throw new AdminError("You can't change your own standing.");
			const user = await guard(a, id);
			if (!["restricted", "limited", "suspended"].includes(b.status)) throw new AdminError("Choose a sanction.");
			const [current] = await sql`select status_until from users where id = ${id}::bigint`;
			const SEVERITY: Record<string, number> = { active: 0, limited: 1, restricted: 2, suspended: 3 };
			if (!current.status_until && SEVERITY[user.status] > SEVERITY[b.status]) throw new AdminError(`The account is already ${user.status} until lifted. Reinstate it first.`);
			const hours = Number(b.hours);
			if (!Number.isFinite(hours) || hours < 1 || hours > 8760) throw new AdminError("Choose 1–8760 hours.");
			await sql`update users set status_restore = coalesce(status_restore, status), status = ${b.status}, status_until = now() + ${hours} * interval '1 hour', deactivated_at = null where id = ${id}::bigint`;
			if (b.status === "suspended") await shutOut(id);
			await audit(a, "temporary_status", id, { status: b.status, hours, previous: user.status, reason: String(b.reason ?? "").slice(0, 500) || undefined });
			return {};
		},
	},
	bulkStatus: {
		role: "moderator",
		run: async (a, b) => {
			if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 50 || !STANDINGS.includes(b.status)) throw new AdminError("Choose up to 50 accounts and a standing.");
			const ids = [...new Set(b.ids.map((x: unknown) => idOf(x)))] as string[];
			for (const id of ids) {
				if (id === a.id) throw new AdminError("You can't change your own standing.");
				await guard(a, id);
			}
			await sql.begin(async (tx) => {
				await tx`update users set status = ${b.status}, status_until = null, status_restore = null, deactivated_at = null where id = any(${tx.array(ids, "INT8")})`;
			});
			if (b.status === "suspended") await shutOut(...ids);
			await audit(a, "bulk_status", null, { ids, status: b.status });
			return { count: ids.length };
		},
	},

	// earlier handles, newest first; old links to them stop working once changed
	handleHistory: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			return { changes: await sql`select old_name, new_name, changed_at from username_changes where user_id = ${id}::bigint order by changed_at desc limit 50` };
		},
	},
	// signed-in browsers; the token itself never leaves the server
	userSessions: {
		role: "support",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			return { sessions: await sql`select id::text, created_at, last_seen_at, user_agent, ip, token = ${a.token} as current from sessions where user_id = ${id}::bigint order by last_seen_at desc` };
		},
	},
	revokeSession: {
		role: "support",
		run: async (a, b) => {
			if (typeof b.sessionId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(b.sessionId)) throw new AdminError("Invalid session id.");
			const [s] = await sql`select user_id::text from sessions where id = ${b.sessionId}::uuid`;
			if (!s) throw new AdminError("No such session.", 404);
			await guard(a, s.user_id);
			await sql`delete from sessions where id = ${b.sessionId}::uuid`;
			await audit(a, "revoke_session", s.user_id, { session: b.sessionId });
			return {};
		},
	},

	// hidden: only staff see it; sensitive: media behind X's content warning
	setPostVisibility: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [p] = await sql`select user_id::text from posts where id = ${id}::bigint`;
			if (!p) throw new AdminError("No such post.", 404);
			await guard(a, p.user_id);
			if (typeof b.hidden !== "boolean" || typeof b.sensitive !== "boolean") throw new AdminError("Provide visibility and sensitivity settings.");
			await sql`update posts set hidden = ${b.hidden}, sensitive = ${b.sensitive} where id = ${id}::bigint`;
			await audit(a, "set_post_visibility", p.user_id, { post: id, hidden: b.hidden, sensitive: b.sensitive });
			return {};
		},
	},
	// accounts whose handle, name, bio, location or website holds a blocked word now: listed, and
	// suspended when `suspend` is set (staff are listed, never suspended)
	blockedNameAccounts: {
		role: "admin",
		run: async (a, b) => {
			const rows = await sql`select id::text, screen_name, name, bio, location, website, role, status from users where status <> 'suspended'`;
			const hits = rows.filter((u: any) => blockedNameIn(u.screen_name, u.name) || blockedWordIn(u.bio ?? "", u.location ?? "", u.website ?? ""));
			if (b.suspend) for (const u of hits) if (!u.role) await suspendForName(u.id, u.screen_name);
			if (b.suspend) await audit(a, "suspend_blocked_names", null, { count: hits.filter((u: any) => !u.role).length });
			return { accounts: hits.map((u: any) => ({ id: u.id, screen_name: u.screen_name, name: u.name, staff: !!u.role })) };
		},
	},
	// a label under the post (X's soft interventions); type null takes it off
	setPostNotice: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [p] = await sql`select user_id::text from posts where id = ${id}::bigint`;
			if (!p) throw new AdminError("No such post.", 404);
			await guard(a, p.user_id);
			const type = b.type || null;
			if (type !== null && !(type in NOTICE_TYPES)) throw new AdminError("Unknown label.");
			const text = optionalText(b.text, 280);
			const url = optionalText(b.url, 500);
			if (url && !/^https?:\/\/\S+$/.test(url)) throw new AdminError("The link must be an http or https address.");
			const notice = type ? { type, text: text || NOTICE_TYPES[type as keyof typeof NOTICE_TYPES], ...(url ? { url } : {}) } : null;
			await sql`update posts set notice = ${notice ? sql`${JSON.stringify(notice)}::text::jsonb` : null} where id = ${id}::bigint`;
			await audit(a, "set_post_notice", p.user_id, { post: id, notice });
			return {};
		},
	},
	// the counts a post shows; a blank one goes back to the real count
	setPostCounts: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [p] = await sql`select user_id::text from posts where id = ${id}::bigint`;
			if (!p) throw new AdminError("No such post.", 404);
			const counts = countsOf(b.counts, ["likes", "replies", "reposts", "quotes", "bookmarks", "views"]);
			await sql`update posts set count_overrides = ${counts ? sql`${JSON.stringify(counts)}::text::jsonb` : null} where id = ${id}::bigint`;
			await audit(a, "set_post_counts", p.user_id, { post: id, counts });
			return {};
		},
	},
	setUserCounts: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			await guard(a, id);
			const counts = countsOf(b.counts, ["followers", "following"]);
			await sql`update users set count_overrides = ${counts ? sql`${JSON.stringify(counts)}::text::jsonb` : null} where id = ${id}::bigint`;
			await audit(a, "set_user_counts", id, { counts });
			return {};
		},
	},
	articles: { role: "support", run: async () => ({ articles: await sql`select a.id::text, a.user_id::text, u.screen_name, a.title, a.state, a.hidden, a.modified_at,
		(select p.id::text from posts p where p.article_id = a.id order by p.id desc limit 1) as post_id
		from articles a join users u on u.id = a.user_id order by a.id desc limit 100` }) },
	setArticleVisibility: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [article] = await sql`select user_id::text from articles where id = ${id}::bigint`;
			if (!article) throw new AdminError("No such article.", 404);
			await guard(a, article.user_id);
			if (typeof b.hidden !== "boolean") throw new AdminError("Choose visibility.");
			await sql.begin(async (tx) => {
				await tx`update articles set hidden = ${b.hidden} where id = ${id}::bigint`;
				await tx`update posts set hidden = ${b.hidden} where article_id = ${id}::bigint`;
			});
			await audit(a, "article_visibility", article.user_id, { article: id, hidden: b.hidden });
			return {};
		},
	},

	media: {
		role: "support",
		run: async (_a, b) => ({ media: await sql`select m.id::text, m.user_id::text, u.screen_name, m.kind, m.mime, m.size, m.state, m.created_at, m.post_id::text
			from media m join users u on u.id = m.user_id order by m.id desc limit 60 offset ${Math.max(0, Number(b.offset) || 0)}` }),
	},
	deleteMedia: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id);
			const [m] = await sql`select user_id::text, state from media where id = ${id}::bigint`;
			if (!m) throw new AdminError("No such media.", 404);
			await guard(a, m.user_id);
			if (m.state === "processing") throw new AdminError("Wait until processing finishes.");
			const root = realpathSync(resolve(MEDIA_DIR));
			for (const name of [id, `${id}.mp4`, `${id}.upload`, `poster/${id}.jpg`]) {
				const path = resolve(root, name);
				if (!existsSync(path)) continue;
				const parent = realpathSync(dirname(path));
				if (parent !== root && !parent.startsWith(root + sep)) throw new AdminError("Invalid media path.");
				unlinkSync(path);
			}
			await sql`delete from media where id = ${id}::bigint`;
			await sql`update users set avatar_url = null where avatar_url = ${`/media/${id}`}`;
			await sql`update users set banner_url = null where banner_url = ${`/media/banner/${id}`}`;
			await audit(a, "delete_media", m.user_id, { media: id });
			return {};
		},
	},

	// maintenance mode, blocked phrases, trend controls and the pinned post
	operations: { role: "support", run: async () => ({ operations: settings().operations, automod: settings().automod }) },
	heldIdentities: {
		role: "moderator",
		run: async () => ({ held: await sql`select kind, value, reason, created_at from retired_identities order by created_at desc limit 500` }),
	},
	releaseIdentity: {
		role: "admin",
		run: async (a, b) => {
			if (!["handle", "email", "ip"].includes(b.kind) || typeof b.value !== "string" || b.value.length > 320) throw new AdminError("Choose an entry.");
			const rows = await sql`delete from retired_identities where kind = ${b.kind} and value = ${b.value} returning value`;
			if (!rows.length) throw new AdminError("No such entry.", 404);
			forgetHeld();
			await audit(a, "release_identity", null, { kind: b.kind, value: b.value });
			return {};
		},
	},
	automodScan: {
		role: "moderator",
		run: async (_a, b) => {
			const before = b.before ? idOf(b.before, "cursor") : null;
			const batch = Math.max(100, Math.min(Number(b.batch) || 3000, 10_000));
			const posts = await sql`select p.id::text, p.text, p.sensitive, u.id::text as user_id, u.screen_name, u.status from posts p join users u on u.id = p.user_id
				where not p.hidden and u.status <> 'suspended' and u.role is null ${before ? sql`and p.id < ${before}::bigint` : sql``}
				order by p.id desc limit ${batch}`;
			const hits: Record<string, unknown>[] = [];
			for (const p of posts) {
				const hit = hateIn(p.text);
				if (hit) hits.push({ kind: "post", id: p.id, user_id: p.user_id, screen_name: p.screen_name, status: p.status, sensitive: p.sensitive, text: [...p.text].slice(0, 280).join(""), ...hit });
			}
			if (!before) {
				const people = await sql`select id::text, screen_name, name, bio, location, website, status from users where status <> 'suspended' and role is null order by id desc limit 50000`;
				for (const u of people) {
					const hit = hateInName(u.screen_name, u.name) ?? hateIn(u.bio, u.location, u.website);
					if (hit) hits.push({ kind: "profile", id: u.id, user_id: u.id, screen_name: u.screen_name, status: u.status, text: [u.name, u.bio, u.location].filter(Boolean).join(" · "), ...hit });
				}
			}
			return { hits, scanned: posts.length, next: posts.length === batch ? posts[posts.length - 1].id : null };
		},
	},
	saveAutomod: {
		role: "admin",
		run: async (a, b) => {
			const days = Number(b.strike_days);
			if (typeof b.enabled !== "boolean" || !Number.isInteger(days) || days < 1 || days > 3650) throw new AdminError("Strikes count for 1–3650 days.");
			if (!Array.isArray(b.ladder) || !b.ladder.length || b.ladder.length > 10) throw new AdminError("Give 1–10 steps.");
			const ladder = b.ladder.map(Number);
			if (ladder.some((h: number) => !Number.isInteger(h) || h < -1 || h > 87_600)) throw new AdminError("Each step is 0 (a warning), hours of suspension, or -1 (permanent).");
			await setSetting("automod", { enabled: b.enabled, strike_days: days, ladder });
			await audit(a, "save_automod", null, { enabled: b.enabled, strike_days: days, ladder });
			return {};
		},
	},
	saveOperations: {
		role: "admin",
		run: async (a, b) => {
			if (typeof b.maintenance !== "boolean" || typeof b.message !== "string" || b.message.length > 500) throw new AdminError("Invalid maintenance settings.");
			const pin = b.global_pin ? idOf(String(b.global_pin).trim(), "post id") : null;
			if (pin && !(await sql`select 1 from posts where id = ${pin}::bigint and not hidden`).length) throw new AdminError("Pin an existing visible post.");
			await setSetting("operations", {
				maintenance: b.maintenance,
				message: b.message.trim() || "The instance is undergoing maintenance.",
				blocked_phrases: lines(b.blocked_phrases, "phrase"),
				blocked_names: lines(b.blocked_names ?? [], "name"),
				hidden_trends: lines(b.hidden_trends, "trend", true),
				promoted_trends: lines(b.promoted_trends, "trend", true),
				global_pin: pin,
			});
			await audit(a, "save_operations", null, { maintenance: b.maintenance, pin });
			return {};
		},
	},

	health: {
		role: "support",
		run: async () => {
			const started = performance.now();
			const [db] = await sql`select pg_database_size(current_database())::text as bytes`;
			return {
				runtime: Bun.version,
				uptime: Math.floor(process.uptime()),
				memory: process.memoryUsage().rss,
				database: { bytes: db.bytes, latency_ms: Math.round(performance.now() - started) },
				client_build: loadBuild()?.build.sha ?? null,
			};
		},
	},

	// Admin > Security: who reaches the panel (staff-access.ts), and staff sessions
	security: {
		role: "admin",
		run: async (a, b, req) => ({
			security: settings().security,
			your_ip: req ? clientIp(req) : null,
			without_2fa: await sql`select id::text, screen_name, role from users where role is not null and not totp_enabled order by screen_name`,
			sessions: await sql`select s.id::text, s.created_at, s.last_seen_at, s.user_agent, s.ip, s.token = ${a.token} as current,
				u.id::text as user_id, u.screen_name, u.role
				from sessions s join users u on u.id = s.user_id where u.role is not null order by s.last_seen_at desc limit 200`,
		}),
	},
	saveSecurity: {
		role: "admin",
		run: async (a, b, req) => {
			if (typeof b.staff_2fa !== "boolean" || !Array.isArray(b.admin_ips) || b.admin_ips.length > 100) throw new AdminError("Invalid security settings.");
			const ips = [...new Set(b.admin_ips.map((x: unknown) => String(x).trim()).filter(Boolean))] as string[];
			const bad = ips.find((x) => !parseRange(x));
			if (bad) throw new AdminError(`"${bad}" isn't an address or a range like 10.0.0.0/8.`);
			// saving a list that leaves you out would close the panel behind you
			const ip = req ? clientIp(req) : null;
			if (ips.length && !ipAllowed(ip, ips)) throw new AdminError(`The list must include your own address (${ip ?? "unknown"}).`);
			if (b.staff_2fa && !(await sql`select 1 from users where id = ${a.id}::bigint and totp_enabled`).length)
				throw new AdminError("Turn on two-factor for your own account first (/account/2fa).");
			await setSetting("security", { staff_2fa: b.staff_2fa, admin_ips: ips });
			await audit(a, "save_security", null, { staff_2fa: b.staff_2fa, admin_ips: ips });
			return {};
		},
	},

	// backups.ts; restoring is pg_restore on the server, not something done from a browser
	backups: { role: "admin", run: async () => ({ backups: listBackups(), schedule: settings().backups, dir: BACKUP_DIR }) },
	createBackup: {
		role: "admin",
		run: async (a) => {
			const made = await createBackup().catch((e: Error) => {
				throw new AdminError(e.message);
			});
			await audit(a, "create_backup", null, made);
			return made;
		},
	},
	deleteBackup: {
		role: "admin",
		run: async (a, b) => {
			if (!deleteBackup(String(b.name ?? ""))) throw new AdminError("No such backup.", 404);
			await audit(a, "delete_backup", null, { name: b.name });
			return {};
		},
	},
	saveBackupSchedule: {
		role: "admin",
		run: async (a, b) => {
			const keep = Number(b.keep);
			if (typeof b.daily !== "boolean" || !Number.isInteger(keep) || keep < 1 || keep > 90) throw new AdminError("Keep 1 to 90 backups.");
			await setSetting("backups", { daily: b.daily, keep });
			await audit(a, "backup_schedule", null, { daily: b.daily, keep });
			return {};
		},
	},

	// member-invites.ts
	saveInviteQuota: {
		role: "admin",
		run: async (a, b) => {
			const n = (v: unknown, lo: number, hi: number, what: string) => {
				const x = Number(v);
				if (!Number.isInteger(x) || x < lo || x > hi) throw new AdminError(`${what} is ${lo} to ${hi}.`);
				return x;
			};
			if (typeof b.enabled !== "boolean") throw new AdminError("Choose whether members make invites.");
			const quota = { enabled: b.enabled, per_month: n(b.per_month, 1, 100, "Invites a month"), uses: n(b.uses, 1, 100, "Uses each"), min_age_days: n(b.min_age_days, 0, 3650, "Account age") };
			await setSetting("invite_quota", quota);
			await audit(a, "invite_quota", null, quota);
			return {};
		},
	},

	// client-update.ts
	client: { role: "admin", run: async () => clientStatus() },
	checkClient: {
		role: "admin",
		run: async () => ({ latest: await latestSha().catch((e: Error) => { throw new AdminError(e.message); }), ...clientStatus() }),
	},
	updateClient: {
		role: "admin",
		run: async (a) => {
			const before = clientStatus().sha;
			const done = await updateClient().catch((e: Error) => { throw new AdminError(e.message); });
			if (done.changed) await audit(a, "update_client", null, { from: before, to: done.sha });
			return done;
		},
	},
	rollbackClient: {
		role: "admin",
		run: async (a) => {
			const before = clientStatus().sha;
			let sha: string;
			try {
				sha = rollbackClient();
			} catch (e: any) {
				throw new AdminError(e.message);
			}
			await audit(a, "rollback_client", null, { from: before, to: sha });
			return { sha };
		},
	},

	// errors.ts: distinct errors, the latest first
	errors: {
		role: "support",
		run: async (_a, b) => ({
			errors: await sql`select e.fingerprint, e.source, e.message, e.stack, e.path, e.count, e.first_at, e.last_at, e.resolved, e.user_id::text as user_id, u.screen_name
				from error_log e left join users u on u.id = e.user_id
				where ${b.resolved ? sql`e.resolved` : sql`not e.resolved`} and (${b.source ?? null}::text is null or e.source = ${b.source ?? null})
				order by e.last_at desc limit 100`,
		}),
	},
	resolveErrors: {
		role: "admin",
		run: async (a, b) => {
			if (b.all) {
				const rows = await sql`update error_log set resolved = true where not resolved returning fingerprint`;
				await audit(a, "resolve_errors", null, { count: rows.length });
				return { count: rows.length };
			}
			if (typeof b.fingerprint !== "string" || !/^[0-9a-f]{32}$/.test(b.fingerprint)) throw new AdminError("No such error.");
			const rows = await sql`update error_log set resolved = true where fingerprint = ${b.fingerprint} returning fingerprint`;
			if (!rows.length) throw new AdminError("No such error.", 404);
			await audit(a, "resolve_errors", null, { count: 1 });
			return { count: 1 };
		},
	},

	inviteTree: {
		role: "support",
		run: async () => ({
			tree: await sql`with recursive tree as (
				select u.id, u.screen_name, null::bigint as parent, 0 as depth, array[u.id] as path from users u
					where u.invite_code is null or not exists (select 1 from invites i where i.code = u.invite_code and i.created_by is not null)
				union all
				select u.id, u.screen_name, t.id, t.depth + 1, t.path || u.id from tree t
					join invites i on i.created_by = t.id join users u on u.invite_code = i.code
					where t.depth < 10 and not u.id = any(t.path)
			) select id::text, screen_name, parent::text, depth from tree order by path limit 1000`,
		}),
	},
};
