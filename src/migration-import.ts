// Moving an account here from another instance, the new instance's half (the
// old instance's is migration.ts). The account gives the old instance's
// address and the migration code it made there; this instance then:
//   1. checks: asks the old instance what it runs and what the account holds,
//      and refuses (blockers) or asks for a confirmation (warnings) first;
//   2. imports in the background: files, polls, articles, posts with their
//      replies, quotes and edit history, drafts, the profile (with pronouns), follows, blocks,
//      mutes, lists, likes, bookmarks and the rest, each mapped in
//      migration_objects so a failed or repeated import picks up where it was;
//   3. tells the old instance the move is done, if asked to.
// Followers can't be moved: they follow the old account until they follow the
// new one. Encrypted chats stay too, since their keys never leave the browser.

import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { putFile } from "./disk";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Viewer } from "./auth";
import { isBlockedEitherWay, replyLimited } from "./blocks";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { FEDERATION_ON, INSTANCE_ID, isPeer, readLimited } from "./federation";
import { lookupRemoteUser } from "./federation-sync";
import { flagValue } from "./flags";
import { isId, newId, newIdAt } from "./ids";
import { saveMentions } from "./mentions";
import { checkLength, PostError, seenBy } from "./posts";
import { MEDIA_DIR, sniffImage } from "./media";
import { FORMAT, FORMAT_VERSION, type VersionInfo, versionInfo } from "./migration";
import { blockedNameIn, forbiddenText } from "./names";
import { pronounsProblem } from "./pronouns";
import { recordError } from "./errors";
import { settings } from "./settings";
import { maxVideoBytes, posterFile } from "./video";

const ALLOW_HTTP = !!(process.env.MIGRATION_ALLOW_HTTP || process.env.FEDERATION_ALLOW_HTTP);
// for test instances on one machine; never on a public instance, since the
// address is the person's to choose
const ALLOW_PRIVATE = !!process.env.MIGRATION_ALLOW_PRIVATE;
const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_GIF = 15 * 1024 * 1024;
const MAX_RUNNING = 2;

export class MigrationError extends Error {}

export type Source = { origin: string; host: string };

// "xit.example.org", "https://xit.example.org/" or, for test instances,
// "http://localhost:3001"
export function parseSource(input: string): Source {
	let text = input.trim().replace(/\/+$/, "");
	if (!text) throw new MigrationError("Enter the address of the instance your account is on now.");
	if (!/^[a-z]+:\/\//i.test(text)) text = `${ALLOW_HTTP && /^(localhost|127\.|\[::1\])/i.test(text) ? "http" : "https"}://${text}`;
	let url: URL;
	try {
		url = new URL(text);
	} catch {
		throw new MigrationError("That isn't an address. Enter it like xit.example.org.");
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && ALLOW_HTTP)) throw new MigrationError("The other instance must be reached over HTTPS.");
	if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) throw new MigrationError("Enter only the instance's address, without a path.");
	return { origin: url.origin, host: url.host.toLowerCase() };
}

export function privateAddress(ip: string): boolean {
	if (isIP(ip) === 4) {
		const [a, b] = ip.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || a >= 224;
	}
	const v6 = ip.toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
	if (mapped) return privateAddress(mapped[1]);
	return v6 === "::" || v6 === "::1" || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || /^ff/.test(v6);
}

// The address is the person's to choose, so it may only lead to the public
// internet: not to this instance's database or anything else beside it.
async function checkReachable(source: Source) {
	if (ALLOW_PRIVATE) return;
	const hostname = new URL(source.origin).hostname.replace(/^\[|\]$/g, "");
	const addresses = isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true }).catch(() => [])).map((a) => a.address);
	if (!addresses.length) throw new MigrationError(`${source.host} couldn't be found.`);
	if (addresses.some(privateAddress)) throw new MigrationError(`${source.host} is on a private network, which this instance doesn't reach.`);
}

type Call = { method?: "GET" | "POST"; body?: unknown; max?: number; timeout?: number };

async function call(source: Source, code: string, path: string, opts: Call = {}): Promise<Response> {
	await checkReachable(source);
	const r = await fetch(`${source.origin}/migration/v1/${path}`, {
		method: opts.method ?? "GET",
		redirect: "manual",
		signal: AbortSignal.timeout(opts.timeout ?? 30_000),
		headers: { authorization: `Bearer ${code}`, "content-type": "application/json", "x-xitter-migration-to": INSTANCE_ID, "user-agent": `xitter-migration (+${PUBLIC_ORIGIN})` },
		body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
	}).catch((e) => {
		throw new MigrationError(`${source.host} didn't answer (${e?.name === "TimeoutError" ? "it took too long" : "it couldn't be reached"}).`);
	});
	return r;
}

async function callJson(source: Source, code: string, path: string, opts: Call = {}): Promise<any> {
	const r = await call(source, code, path, opts);
	const bytes = await readLimited(r, opts.max ?? 1024 * 1024).catch(() => {
		throw new MigrationError(`${source.host} sent more than this instance takes.`);
	});
	let body: any;
	try {
		body = JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new MigrationError(r.status === 404 ? `${source.host} doesn't support moving accounts. It may run an older Xitter, or not Xitter at all.` : `${source.host} didn't answer like a Xitter instance (${r.status}).`);
	}
	if (!r.ok) throw new MigrationError(typeof body?.error === "string" ? `${source.host}: ${body.error.slice(0, 300)}` : `${source.host} refused (${r.status}).`);
	return body;
}

export type Finding = { code: string; text: string };
export type Check = {
	source: Source;
	info: VersionInfo & { account: any };
	here: VersionInfo;
	blockers: Finding[];
	warnings: Finding[];
	notes: Finding[];
	// confirms the warnings someone saw are the ones still there when they start
	ack: string;
};

const CODE_RE = /^xmig_[A-Za-z0-9_-]{43}$/;
// the same accounts createPost refuses
async function canPost(userId: string) {
	const [u] = await sql`select status, deactivated_at from users where id = ${userId}::bigint`;
	return !!u && u.status !== "restricted" && u.status !== "suspended" && !u.deactivated_at;
}
const sourceKey = (instance: string, userId: string) => `${instance}#${userId}`;
const fileLimit = (kind: string, mime: string) => (kind === "video" ? maxVideoBytes() : mime === "image/gif" ? MAX_GIF : settings().limits.image_mb * 1024 * 1024);
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

export async function check(viewer: Viewer, sourceInput: string, codeInput: string): Promise<Check> {
	const source = parseSource(sourceInput);
	const code = codeInput.trim();
	if (!CODE_RE.test(code)) throw new MigrationError("That isn't a migration code. It starts with xmig_; make one on your old instance under Move account.");
	if (source.host === INSTANCE_ID || source.origin === PUBLIC_ORIGIN) throw new MigrationError("That's this instance. Enter the one your account is on now.");
	const info = await callJson(source, code, "info");
	const here = versionInfo();
	const blockers: Finding[] = [];
	const warnings: Finding[] = [];
	const notes: Finding[] = [];
	if (info?.software !== "xitter" || info?.format !== FORMAT || typeof info?.account?.id !== "string") throw new MigrationError(`${source.host} didn't answer like a Xitter instance.`);
	if (!Number.isInteger(info.format_version) || info.format_version > FORMAT_VERSION)
		blockers.push({ code: "format", text: `${source.host} exports accounts in a newer format (${info.format_version}) than this instance reads (${FORMAT_VERSION}). This instance has to be updated first.` });
	if (typeof info.instance !== "string" || info.instance === INSTANCE_ID) blockers.push({ code: "same", text: "That's this instance." });
	if (info.account.status === "suspended") blockers.push({ code: "suspended", text: "The account is suspended or deactivated on the old instance." });
	const [running] = await sql`select 1 from account_migrations where user_id = ${viewer.id}::bigint and state = 'running'`;
	if (running) blockers.push({ code: "running", text: "An import into this account is already running. Wait for it to finish." });
	if (!(await canPost(viewer.id))) blockers.push({ code: "restricted", text: "This account can't post right now, so nothing can be moved into it." });

	if (info.version !== here.version)
		warnings.push({ code: "version", text: `Version mismatch: ${source.host} runs Xitter ${info.version}, this instance runs ${here.version}. Anything one of them stores differently may be skipped or come over incomplete.` });
	else if (info.schema !== here.schema)
		warnings.push({ code: "schema", text: `Both run Xitter ${here.version}, but their databases differ (${String(info.schema).slice(0, 16)} there, ${here.schema} here), so one of them is modified. Some things may not come over.` });
	// Unfederated, neither instance knows the other's accounts and posts: what
	// the account follows, likes or answers there can't be matched here, and
	// its followers there can't follow it here.
	const why = !FEDERATION_ON
		? "federation is off on this instance"
		: info.federation?.enabled === false
			? `federation is off on ${source.host}`
			: !isPeer(info.instance)
				? `${info.instance} isn't an instance this one federates with`
				: info.federation?.with_you === false
					? `${source.host} doesn't federate with this instance`
					: "";
	if (why)
		warnings.push({ code: "unfederated", text: `The two instances don't federate (${why}). Accounts and posts from ${source.host} aren't known here, so follows, lists, likes, reposts, bookmarks, replies and quotes involving them can't be matched and are left out (the report lists the accounts). Your followers there won't see your new account either.` });
	if (info.format_version < FORMAT_VERSION) warnings.push({ code: "older-format", text: `${source.host} exports an older format (${info.format_version}); things added since won't come over.` });
	const [mine] = await sql`select (select count(*)::int from posts where user_id = ${viewer.id}::bigint) as posts,
		(select count(*)::int from follows where follower_id = ${viewer.id}::bigint) as following`;
	const [before] = await sql`select count(*)::int as n from migration_objects where user_id = ${viewer.id}::bigint and source = ${sourceKey(info.instance, info.account.id)}`;
	if (before.n) notes.push({ code: "resume", text: `${before.n} things were already brought over from this account before; they're skipped, so running it again only adds what's missing.` });
	else if (mine.posts || mine.following)
		warnings.push({ code: "not-empty", text: `@${viewer.screen_name} already has ${mine.posts} posts and follows ${mine.following} accounts here. The old account's are added to them, and its profile replaces this one's.` });
	const media = Array.isArray(info.account.media) ? info.account.media : [];
	const big = media.filter((m: any) => Number(m?.size) > fileLimit(String(m?.kind), m?.kind === "video" ? "video/mp4" : "image/jpeg"));
	if (big.length) warnings.push({ code: "media-limits", text: `${big.length} of the account's ${media.length} files are larger than this instance allows (${settings().limits.image_mb} MB for images, ${mb(maxVideoBytes())} for videos) and will be left out.` });
	if (info.account.moved_to) warnings.push({ code: "moved", text: `The old account was already moved to @${info.account.moved_to}.` });
	if (Number(info.account.conversations) > 0) notes.push({ code: "chat", text: `${info.account.conversations} direct message conversations stay on ${source.host}: they're end-to-end encrypted and their keys never leave your browser.` });
	if (Number(info.account.followers) > 0) notes.push({ code: "followers", text: `${info.account.followers} followers can't be moved for them; they keep following the old account until they follow the new one.` });
	if (info.account.screen_name?.toLowerCase() !== viewer.screen_name.toLowerCase()) notes.push({ code: "handle", text: `The account is @${info.account.screen_name} there and @${viewer.screen_name} here. Posts keep their text, so mentions of the old handle stay as written.` });
	const ack = createHash("sha256").update(JSON.stringify([source.origin, info.account.id, warnings.map((w) => w.code)])).digest("base64url").slice(0, 22);
	return { source, info, here, blockers, warnings, notes, ack };
}

export type Options = { profile: boolean; content: boolean; connections: boolean; finish: boolean; note: boolean; deactivate: boolean };

const running = new Set<string>();

export async function start(viewer: Viewer, sourceInput: string, code: string, ack: string, options: Options): Promise<string> {
	if (running.size >= MAX_RUNNING) throw new MigrationError("This instance is busy with other imports. Try again in a few minutes.");
	const checked = await check(viewer, sourceInput, code);
	if (checked.blockers.length) throw new MigrationError(checked.blockers[0].text);
	if (checked.warnings.length && ack !== checked.ack) throw new MigrationError("The checks changed since you looked at them. Review them again before you start.");
	const id = newId();
	try {
		await sql`insert into account_migrations (id, user_id, source, source_user_id, source_handle, state, progress)
			values (${id}::bigint, ${viewer.id}::bigint, ${checked.source.origin}, ${checked.info.account.id}::bigint, ${checked.info.account.screen_name}, 'running', ${JSON.stringify({ step: "Starting" })}::text::jsonb)`;
	} catch {
		throw new MigrationError("An import into this account is already running. Wait for it to finish.");
	}
	running.add(id);
	void run(id, viewer, checked, code.trim(), options).finally(() => running.delete(id));
	return id;
}

// imports that were running when the server stopped; started again they resume
export async function failInterrupted() {
	await sql`update account_migrations set state = 'failed', error = 'The server restarted during the import. Start it again with a new check; what was already brought over is kept.', finished_at = now()
		where state = 'running'`;
}

export async function jobs(userId: string, limit = 5) {
	return sql`select id::text, source, source_handle, state, progress, report, error, created_at, finished_at from account_migrations
		where user_id = ${userId}::bigint order by created_at desc limit ${limit}`;
}

type Ref = { i?: unknown; id?: unknown; h?: unknown };
type Counts = Record<string, { done: number; skipped: number }>;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const date = (v: unknown, fallback: Date | null = new Date()) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : fallback);
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

async function run(jobId: string, viewer: Viewer, checked: Check, code: string, options: Options) {
	const { source } = checked;
	const srcInstance = checked.info.instance;
	const key = sourceKey(srcInstance, checked.info.account.id);
	const me = viewer.id;
	const counts: Counts = {};
	const skipped: string[] = [];
	const unresolved = new Set<string>();
	const count = (kind: string, ok: boolean) => {
		counts[kind] ??= { done: 0, skipped: 0 };
		counts[kind][ok ? "done" : "skipped"]++;
	};
	const skip = (kind: string, why: string) => {
		count(kind, false);
		if (skipped.length < 200) skipped.push(why);
	};
	let capped = false;
	let lastSaved = 0;
	const progress = async (step: string, done?: number, total?: number, force = false) => {
		if (!force && Date.now() - lastSaved < 1000) return;
		lastSaved = Date.now();
		await sql`update account_migrations set progress = ${JSON.stringify({ step, done, total, counts })}::text::jsonb where id = ${jobId}::bigint`;
	};

	// what was already brought over, by kind and old id
	const maps = new Map<string, Map<string, string>>();
	for (const row of await sql`select kind, remote_id, local_id::text from migration_objects where user_id = ${me}::bigint and source = ${key}`) {
		if (!maps.has(row.kind)) maps.set(row.kind, new Map());
		maps.get(row.kind)!.set(row.remote_id, row.local_id);
	}
	const mapped = (kind: string, id: unknown) => (typeof id === "string" ? maps.get(kind)?.get(id) : undefined);
	const remember = async (kind: string, remoteId: string, localId: string, db = sql) => {
		await db`insert into migration_objects (user_id, source, kind, remote_id, local_id) values (${me}::bigint, ${key}, ${kind}, ${remoteId}, ${localId}::bigint) on conflict do nothing`;
		if (!maps.has(kind)) maps.set(kind, new Map());
		maps.get(kind)!.set(remoteId, localId);
	};

	// an account or post from the archive, found here however this instance
	// knows it: as its own, as a copy from another instance, or (for accounts
	// on instances this one federates with) by asking that instance
	const resolveUser = async (ref: Ref): Promise<string | undefined> => {
		if (typeof ref?.i !== "string" || !isId(ref.id)) return undefined;
		if (ref.i === srcInstance && ref.id === checked.info.account.id) return undefined;
		const [row] = ref.i === INSTANCE_ID
			? await sql`select id::text from users where id = ${ref.id}::bigint and instance is null`
			: await sql`select id::text from users where instance = ${ref.i} and remote_id = ${ref.id}::bigint`;
		if (row) return row.id === me ? undefined : row.id;
		const name = str(ref.h, 80).split("@")[0];
		if (FEDERATION_ON && name && isPeer(ref.i)) {
			const found = await lookupRemoteUser(`${name}@${ref.i}`).catch(() => undefined);
			if (found && found !== me) return found;
		}
		if (name) unresolved.add(`@${name}@${ref.i}`);
		return undefined;
	};
	const resolvePost = async (ref: Ref): Promise<string | undefined> => {
		if (typeof ref?.i !== "string" || !isId(ref.id)) return undefined;
		if (ref.i === srcInstance) {
			const own = mapped("post", ref.id);
			if (own) return own;
		}
		const [row] = ref.i === INSTANCE_ID
			? await sql`select p.id::text from posts p join users u on u.id = p.user_id where p.id = ${ref.id}::bigint and u.instance is null`
			: await sql`select local_id::text as id from federated_objects where instance = ${ref.i} and kind = 'post' and remote_id = ${ref.id}::bigint`;
		return row?.id;
	};
	// media ids inside drafts and article bodies, as the composer and editor keep them
	const remapMedia = (value: any, depth = 0): any => {
		if (depth > 12) return value;
		if (Array.isArray(value)) return value.map((v) => remapMedia(v, depth + 1));
		if (!value || typeof value !== "object") return value;
		const out: Record<string, any> = {};
		for (const [k, v] of Object.entries(value)) {
			if (/^media_?ids?$|^mediaIds?$|^media_id_str$/i.test(k)) out[k] = Array.isArray(v) ? v.map((x) => mapped("media", String(x)) ?? null).filter(Boolean) : (mapped("media", String(v)) ?? v);
			else out[k] = remapMedia(v, depth + 1);
		}
		return out;
	};

	try {
		await progress("Downloading the archive", undefined, undefined, true);
		const r = await call(source, code, "archive", { timeout: 10 * 60_000 });
		if (!r.ok) throw new MigrationError(`${source.host} refused to send the archive (${r.status}).`);
		const archive = JSON.parse(new TextDecoder().decode(await readLimited(r, MAX_ARCHIVE)));
		if (archive?.format !== FORMAT || !(archive.format_version <= FORMAT_VERSION) || archive.account?.id !== checked.info.account.id)
			throw new MigrationError(`${source.host} sent an archive this instance can't read.`);

		if (options.content) {
			// files first: posts, polls, articles and the profile point at them
			const media = arr(archive.media).filter((m) => isId(m?.id));
			mkdirSync(MEDIA_DIR, { recursive: true });
			let n = 0;
			for (const m of media) {
				await progress("Copying files", ++n, media.length);
				if (mapped("media", m.id)) continue;
				const kind = m.kind === "video" ? "video" : "photo";
				const limit = fileLimit(kind, String(m.mime));
				if (Number(m.size) > limit) {
					skip("media", `A ${kind} of ${mb(Number(m.size))} is over this instance's limit.`);
					continue;
				}
				const id = newId();
				const file = join(MEDIA_DIR, id);
				try {
					const res = await call(source, code, `media/${m.id}`, { timeout: 10 * 60_000 });
					if (!res.ok) throw new MigrationError(`answered ${res.status}`);
					const bytes = Buffer.from(await readLimited(res, limit));
					let mime = "video/mp4", width = Number(m.width) || 0, height = Number(m.height) || 0;
					if (kind === "photo") {
						const image = sniffImage(bytes);
						if (!image) throw new MigrationError("not an image this instance takes");
						({ mime, width, height } = image);
					} else if (bytes.toString("latin1", 4, 8) !== "ftyp") throw new MigrationError("not an MP4 video");
					await putFile(file, bytes);
					if (kind === "video") {
						const poster = await call(source, code, `media/${m.id}?poster=1`).catch(() => undefined);
						if (poster?.ok) await putFile(posterFile(MEDIA_DIR, id), Buffer.from(await readLimited(poster, 10 * 1024 * 1024)));
					}
					const warning = arr(m.sensitive_warning).filter((w) => ["adult_content", "graphic_violence", "other"].includes(w));
					await sql.begin(async (tx) => {
						await tx`insert into media (id, user_id, kind, mime, size, width, height, duration_ms, alt_text, sensitive_warning, created_at)
							values (${id}::bigint, ${me}::bigint, ${kind}, ${mime}, ${bytes.length}, ${width}, ${height}, ${Number.isInteger(m.duration_ms) ? m.duration_ms : null},
								${str(m.alt_text, 1000) || null}, ${warning.length ? sql.array(warning, "TEXT") : null}, ${date(m.created_at)})`;
						await remember("media", m.id, id, tx);
					});
					count("media", true);
				} catch (e) {
					rmSync(file, { force: true });
					rmSync(posterFile(MEDIA_DIR, id), { force: true });
					skip("media", `A ${kind} couldn't be copied: ${e instanceof Error ? e.message : String(e)}.`);
				}
			}

			for (const p of arr(archive.polls)) {
				if (!isId(p?.id) || mapped("poll", p.id)) continue;
				const choices = arr(p.choices).filter((c) => typeof c === "string").map((c) => c.slice(0, 100)).slice(0, 4);
				if (choices.length < 2) {
					skip("polls", "A poll without choices.");
					continue;
				}
				const choiceMedia = p.choice_media ? arr(p.choice_media).map((c) => mapped("media", String(c))) : null;
				const id = newId();
				await sql.begin(async (tx) => {
					await tx`insert into polls (id, user_id, choices, duration_minutes, ends_at, created_at, choice_media)
						values (${id}::bigint, ${me}::bigint, ${sql.array(choices, "TEXT")}, ${Math.max(5, Math.min(10080, Number(p.duration_minutes) || 1440))},
							${date(p.ends_at, null)}, ${date(p.created_at)}, ${choiceMedia && choiceMedia.every(Boolean) ? sql.array(choiceMedia as string[], "INT8") : null})`;
					await remember("poll", p.id, id, tx);
				});
				count("polls", true);
			}

			for (const a of arr(archive.articles)) {
				if (!isId(a?.id) || mapped("article", a.id)) continue;
				if (forbiddenText(str(a.title, 300), str(a.plain_text, 200_000))) {
					skip("articles", `The article "${str(a.title, 60)}" has words this instance doesn't allow.`);
					continue;
				}
				const id = newId();
				const body = a.content_state && typeof a.content_state === "object" ? JSON.stringify(remapMedia(a.content_state)) : null;
				if (body && body.length > 4 * 1024 * 1024) {
					skip("articles", `The article "${str(a.title, 60)}" is too large.`);
					continue;
				}
				await sql.begin(async (tx) => {
					await tx`insert into articles (id, user_id, title, content_state, plain_text, cover_media_id, state, created_at, modified_at, first_published_at)
						values (${id}::bigint, ${me}::bigint, ${str(a.title, 300)}, ${body}::text::jsonb, ${str(a.plain_text, 200_000)}, ${mapped("media", a.cover_media_id) ?? null}::bigint,
							${a.state === "Published" ? "Published" : "Draft"}, ${date(a.created_at)}, ${date(a.modified_at)}, ${date(a.first_published_at, null)})`;
					await remember("article", a.id, id, tx);
				});
				count("articles", true);
			}

			// oldest first, so a reply finds the post it answers already here
			const posts = arr(archive.posts).filter((p) => isId(p?.id)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
			const orphans = { replies: 0, quotes: 0 };
			// posts brought over don't count against the daily caps (their ids are
			// backdated), so a move gets its own allowance per day; the rest waits
			// for the next run, which resumes
			const caps = settings().daily_caps;
			const [{ role }] = await sql`select role from users where id = ${me}::bigint`;
			const [today] = await sql`select count(*)::int as n from migration_objects where user_id = ${me}::bigint and kind = 'post' and created_at > now() - interval '1 day'`;
			let allowance = caps.enabled && !role ? caps.posts + caps.replies - today.n : Infinity;
			n = 0;
			for (const p of posts) {
				await progress("Bringing over posts", ++n, posts.length);
				if (mapped("post", p.id)) continue;
				if (allowance <= 0) {
					capped = true;
					break;
				}
				if (n % 50 === 0 && !(await canPost(me))) throw new MigrationError("This account can't post right now, so the import stopped.");
				const text = str(p.text, 100_000);
				if (text && forbiddenText(text)) {
					skip("posts", `"${text.slice(0, 60)}${text.length > 60 ? "…" : ""}" has words this instance doesn't allow.`);
					continue;
				}
				try {
					await checkLength(me, text);
				} catch (e) {
					if (!(e instanceof PostError)) throw e;
					skip("posts", `"${text.slice(0, 60)}…" is longer than this instance allows.`);
					continue;
				}
				// replies and quotes follow createPost's rules: the post must be one
				// this account may see, and the thread must let it answer
				let replyTo: string | null = null, replyToUser: string | null = null, conversation: string | null = null;
				if (p.reply_to) {
					const parent = await resolvePost(p.reply_to);
					const [row] = parent ? await sql`select p.user_id::text, p.conversation_id::text from posts p join users u on u.id = p.user_id where p.id = ${parent}::bigint and ${seenBy(me)}` : [];
					const ok =
						row &&
						!(row.user_id !== me && (await isBlockedEitherWay(me, row.user_id))) &&
						!(await sql`select 1 from posts p join users u on u.id = p.user_id where p.id = ${row.conversation_id}::bigint and not ${seenBy(me)}`).length &&
						!(await replyLimited(row.conversation_id, me));
					if (ok) {
						replyTo = parent!;
						replyToUser = row.user_id;
						conversation = row.conversation_id;
					} else orphans.replies++;
				}
				let quote = p.quote ? ((await resolvePost(p.quote)) ?? null) : null;
				if (quote) {
					const [q] = await sql`select p.user_id::text, u.protected from posts p join users u on u.id = p.user_id where p.id = ${quote}::bigint and ${seenBy(me)}`;
					if (!q || (q.user_id !== me && (q.protected || (await isBlockedEitherWay(me, q.user_id))))) quote = null;
				}
				if (p.quote && !quote) orphans.quotes++;
				const poll = mapped("poll", p.poll_id) ?? null;
				const article = mapped("article", p.article_id) ?? null;
				if (!text && !poll && !article && !arr(archive.media).some((m) => m?.post_id === p.id && mapped("media", m.id))) {
					skip("posts", "A post whose files or poll couldn't be brought over.");
					continue;
				}
				const created = date(p.created_at)!;
				const replyPolicy = ["Community", "ByInvitation", "Verified"].includes(p.reply_policy) ? p.reply_policy : null;
				let id: string | undefined;
				await sql.begin(async (tx) => {
					for (let attempt = 0; attempt < 8 && !id; attempt++) {
						const tryId = newIdAt(created);
						const rows = await tx`insert into posts (id, user_id, text, reply_to_id, reply_to_user_id, conversation_id, quote_id, poll_id, article_id, sensitive,
								reply_policy, place_id, source, created_at, edit_count, edited_at)
							values (${tryId}::bigint, ${me}::bigint, ${text}, ${replyTo}::bigint, ${replyToUser}::bigint, ${conversation ?? tryId}::bigint, ${quote}::bigint, ${poll}::bigint,
								${article}::bigint, ${!!p.sensitive}, ${replyTo ? null : replyPolicy}, ${str(p.place_id, 100) || null}, ${str(p.source, 60) || "Xitter for Web"}, ${created},
								${Math.max(0, Number(p.edit_count) || 0)}, ${date(p.edited_at, null)})
							on conflict (id) do nothing returning id::text`;
						id = rows[0]?.id;
					}
					if (!id) throw new MigrationError("no free id for a post");
					for (const v of arr(p.versions))
						await tx`insert into post_versions (version_id, post_id, seq, text, created_at) values (${newId()}::bigint, ${id}::bigint, ${Number(v?.seq) || 0}, ${str(v?.text, 100_000)}, ${date(v?.created_at)})`;
					await tx`update media set post_id = ${id}::bigint, position = x.position from (
							select (e->>'local')::bigint as id, (e->>'position')::smallint as position from jsonb_array_elements(${JSON.stringify(
								arr(archive.media).filter((m) => m?.post_id === p.id && mapped("media", m.id)).map((m) => ({ local: mapped("media", m.id), position: Number(m.position) || 0 })),
							)}::text::jsonb) e) x
						where media.id = x.id and media.user_id = ${me}::bigint`;
					await remember("post", p.id, id, tx);
				});
				// the text was written there, so a bare @name is an account on the
				// old instance; ones this instance doesn't know yet aren't looked up
				if (text.includes("@")) await saveMentions(id!, text, srcInstance).catch(() => {});
				count("posts", true);
				allowance--;
			}
			if (capped) skipped.push(`This instance brings over at most ${caps.posts + caps.replies} posts a day. Start the move again tomorrow with a new code to bring over the rest; it resumes where it stopped.`);
			if (orphans.replies) skipped.push(`${orphans.replies} replies answer posts this instance doesn't have, so they came over as posts of their own.`);
			if (orphans.quotes) skipped.push(`${orphans.quotes} quoted posts aren't on this instance, so those posts came over without the quote.`);
			for (const p of posts) {
				const post = mapped("post", p.id);
				const reply = mapped("post", p.pinned_reply_id);
				if (post && reply) await sql`update posts set pinned_reply_id = ${reply}::bigint where id = ${post}::bigint and user_id = ${me}::bigint`;
			}

			await progress("Drafts and scheduled posts", undefined, undefined, true);
			for (const d of arr(archive.drafts)) {
				if (!isId(d?.id) || mapped("draft", d.id) || (d.kind !== "draft" && d.kind !== "scheduled") || !d.request || typeof d.request !== "object") continue;
				const request = remapMedia(d.request);
				if (isId(request.in_reply_to_status_id)) {
					const parent = await resolvePost({ i: srcInstance, id: request.in_reply_to_status_id });
					if (parent) request.in_reply_to_status_id = parent;
					else delete request.in_reply_to_status_id;
				}
				const body = JSON.stringify(request);
				if (body.length > 256 * 1024) continue;
				const id = newId();
				await sql.begin(async (tx) => {
					await tx`insert into scheduled_posts (id, user_id, kind, execute_at, request, created_at)
						values (${id}::bigint, ${me}::bigint, ${d.kind}, ${d.kind === "scheduled" ? date(d.execute_at) : null}, ${body}::text::jsonb, ${date(d.created_at)})`;
					await remember("draft", d.id, id, tx);
				});
				count(d.kind === "draft" ? "drafts" : "scheduled", true);
			}
		}

		if (options.profile) {
			await progress("Profile", undefined, undefined, true);
			const a = archive.account;
			const changes: Record<string, unknown> = {};
			const name = str(a.name, 50).replace(/\s+/g, " ").trim();
			if (name && !blockedNameIn(name) && !forbiddenText(name)) changes.name = name;
			else if (name) skipped.push("The display name has words this instance doesn't allow, so it wasn't changed.");
			for (const [field, max] of [["bio", 160], ["location", 30]] as const) {
				const value = str(a[field], max);
				if (!value || !forbiddenText(value)) changes[field] = value;
				else skipped.push(`The ${field} has words this instance doesn't allow, so it wasn't changed.`);
			}
			const pronouns = str(a.pronouns, 100).replace(/\s+/g, " ").trim();
			if (!pronouns || (!pronounsProblem(pronouns) && !forbiddenText(pronouns))) changes.pronouns = pronouns || null;
			else skipped.push("The pronouns aren't allowed here, so they weren't changed.");
			if (typeof a.website === "string" && (a.website === "" || /^https?:\/\/[^\s<>"]{1,200}$/.test(a.website))) changes.website = a.website;
			changes.protected = !!a.protected;
			if (typeof a.language === "string" && /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(a.language)) changes.language = a.language;
			changes.flag = flagValue(a.flag);
			if (["None", "Parody", "Commentary", "Fan"].includes(a.parody_label)) changes.parody_label = a.parody_label;
			changes.never_sensitive = !!a.never_sensitive;
			const avatar = mapped("media", a.avatar_media_id);
			const banner = mapped("media", a.banner_media_id);
			if (avatar) changes.avatar_url = `/media/${avatar}`;
			if (banner) changes.banner_url = `/media/banner/${banner}`;
			const pinned = mapped("post", a.pinned_post_id);
			if (pinned) changes.pinned_post_id = pinned;
			await sql`update users set ${sql(changes)} where id = ${me}::bigint`;
			const prefs = a.preferences && typeof a.preferences === "object" && !Array.isArray(a.preferences) ? JSON.stringify(a.preferences) : "{}";
			if (prefs.length < 64 * 1024) await sql`update users set preferences = preferences || ${prefs}::text::jsonb where id = ${me}::bigint`;
			count("profile", true);
		}

		if (options.connections) {
			const users = [...arr(archive.following), ...arr(archive.follow_requests), ...arr(archive.blocked), ...arr(archive.muted)];
			let n = 0;
			const step = async () => progress("Follows, blocks and mutes", ++n, users.length);
			for (const f of arr(archive.following)) {
				await step();
				const target = await resolveUser(f?.user);
				if (!target || (await isBlockedEitherWay(me, target))) {
					count("following", false);
					continue;
				}
				const [t] = await sql`select protected from users where id = ${target}::bigint`;
				if (t?.protected && !(await sql`select 1 from follows where follower_id = ${me}::bigint and followee_id = ${target}::bigint`).length) {
					await sql`insert into follow_requests (requester_id, target_id) values (${me}::bigint, ${target}::bigint) on conflict do nothing`;
					count("follow requests", true);
				} else {
					await sql`insert into follows (follower_id, followee_id, created_at) values (${me}::bigint, ${target}::bigint, ${date(f.created_at)}) on conflict do nothing`;
					count("following", true);
				}
			}
			for (const f of arr(archive.follow_requests)) {
				await step();
				const target = await resolveUser(f?.user);
				if (!target || (await isBlockedEitherWay(me, target))) continue;
				await sql`insert into follow_requests (requester_id, target_id) values (${me}::bigint, ${target}::bigint) on conflict do nothing`;
				count("follow requests", true);
			}
			for (const [list, table, column, label] of [["blocked", sql`blocks`, sql`blocker_id, blocked_id`, "blocked"], ["muted", sql`mutes`, sql`muter_id, muted_id`, "muted"]] as const) {
				for (const b of arr(archive[list])) {
					await step();
					const target = await resolveUser(b?.user);
					if (!target) {
						count(label, false);
						continue;
					}
					await sql`insert into ${table} (${column}) values (${me}::bigint, ${target}::bigint) on conflict do nothing`;
					if (list === "blocked") await sql`delete from follows where (follower_id = ${me}::bigint and followee_id = ${target}::bigint) or (follower_id = ${target}::bigint and followee_id = ${me}::bigint)`;
					count(label, true);
				}
			}
			for (const k of arr(archive.muted_keywords)) {
				const word = str(k?.keyword, 100).trim();
				const surfaces = arr(k?.surfaces).filter((s) => ["home_timeline", "tweet_replies", "notifications"].includes(s));
				if (!word || !surfaces.length) continue;
				const rows = await sql`insert into muted_keywords (id, user_id, keyword, surfaces, exclude_following, valid_until, created_at)
					values (${newId()}::bigint, ${me}::bigint, ${word}, ${sql.array(surfaces, "TEXT")}, ${!!k.exclude_following}, ${date(k.valid_until, null)}, ${date(k.created_at)})
					on conflict do nothing returning id`;
				count("muted words", rows.length > 0);
			}
			await progress("Lists", undefined, undefined, true);
			for (const l of arr(archive.lists)) {
				if (!isId(l?.id)) continue;
				let id = mapped("list", l.id);
				if (!id) {
					const name = str(l.name, 25).trim();
					if (!name || forbiddenText(name, str(l.description, 100))) {
						skip("lists", `The list "${name}" has words this instance doesn't allow.`);
						continue;
					}
					id = newId();
					await sql.begin(async (tx) => {
						await tx`insert into lists (id, owner_id, name, description, is_private, banner_media_id, created_at)
							values (${id}::bigint, ${me}::bigint, ${name}, ${str(l.description, 100)}, ${!!l.is_private}, ${mapped("media", l.banner_media_id) ?? null}::bigint, ${date(l.created_at)})`;
						await remember("list", l.id, id!, tx);
					});
					count("lists", true);
				}
				for (const member of arr(l.members)) {
					const user = await resolveUser(member);
					if (user) await sql`insert into list_members (list_id, user_id) values (${id}::bigint, ${user}::bigint) on conflict do nothing`;
				}
			}
			const marks = [["likes", sql`likes`], ["bookmarks", sql`bookmarks`], ["highlights", sql`highlights`]] as const;
			for (const [list, table] of marks) {
				const items = arr(archive[list]);
				n = 0;
				for (const item of items) {
					await progress(`Bringing over ${list}`, ++n, items.length);
					const post = await resolvePost(item?.post);
					if (!post) {
						count(list, false);
						continue;
					}
					if (list === "highlights" && !(await sql`select 1 from posts where id = ${post}::bigint and user_id = ${me}::bigint`).length) continue;
					await sql`insert into ${table} (user_id, post_id, created_at) values (${me}::bigint, ${post}::bigint, ${date(item.created_at)}) on conflict do nothing`;
					count(list, true);
				}
			}
			const reposts = arr(archive.reposts);
			n = 0;
			for (const item of reposts) {
				await progress("Bringing over reposts", ++n, reposts.length);
				const post = await resolvePost(item?.post);
				if (!post) {
					count("reposts", false);
					continue;
				}
				const [owner] = await sql`select user_id::text from posts where id = ${post}::bigint`;
				if (owner && owner.user_id !== me && (await isBlockedEitherWay(me, owner.user_id))) continue;
				const created = date(item.created_at)!;
				// the id places the repost in timelines, so it keeps its time; it
				// isn't unique by itself, so a clash is retried
				for (let attempt = 0; attempt < 8; attempt++) {
					if ((await sql`select 1 from reposts where user_id = ${me}::bigint and post_id = ${post}::bigint`).length) break;
					const tryId = newIdAt(created);
					await sql`insert into reposts (id, user_id, post_id, created_at) select ${tryId}::bigint, ${me}::bigint, ${post}::bigint, ${created}
						where not exists (select 1 from reposts where id = ${tryId}::bigint) on conflict do nothing`;
				}
				count("reposts", true);
			}
			for (const f of arr(archive.bookmark_folders)) {
				if (!isId(f?.id)) continue;
				let id = mapped("folder", f.id);
				if (!id) {
					id = newId();
					await sql.begin(async (tx) => {
						await tx`insert into bookmark_folders (id, user_id, name, created_at) values (${id}::bigint, ${me}::bigint, ${str(f.name, 25) || "Bookmarks"}, ${date(f.created_at)})`;
						await remember("folder", f.id, id!, tx);
					});
					count("bookmark folders", true);
				}
				for (const ref of arr(f.posts)) {
					const post = await resolvePost(ref);
					if (post && (await sql`select 1 from bookmarks where user_id = ${me}::bigint and post_id = ${post}::bigint`).length)
						await sql`insert into bookmark_folder_posts (folder_id, post_id) values (${id}::bigint, ${post}::bigint) on conflict do nothing`;
				}
			}
		}

		let finished: { ok: boolean; deactivated?: boolean; error?: string } | undefined;
		// a move that hit the daily allowance isn't finished: the old instance
		// keeps the account (and the code) until the rest has come over
		if (options.finish && !capped) {
			await progress("Finishing on the old instance", undefined, undefined, true);
			const to = `${viewer.screen_name}@${INSTANCE_ID}`;
			finished = await callJson(source, code, "complete", { method: "POST", body: { to, note: options.note, deactivate: options.deactivate } })
				.then((r) => ({ ok: true, deactivated: !!r.deactivated }))
				.catch((e) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
		}
		const report = { counts, skipped, unresolved: [...unresolved].slice(0, 500), unresolved_total: unresolved.size, finished };
		await sql`update account_migrations set state = 'done', progress = ${JSON.stringify({ step: "Done", counts })}::text::jsonb,
			report = ${JSON.stringify(report)}::text::jsonb, finished_at = now() where id = ${jobId}::bigint`;
	} catch (e) {
		const message = e instanceof MigrationError ? e.message : "Something went wrong during the import. What was already brought over is kept; start it again to continue.";
		if (!(e instanceof MigrationError)) await recordError("job", e, { path: "account migration", userId: me }).catch(() => {});
		const report = { counts, skipped, unresolved: [...unresolved].slice(0, 500), unresolved_total: unresolved.size };
		await sql`update account_migrations set state = 'failed', error = ${message}, report = ${JSON.stringify(report)}::text::jsonb, finished_at = now() where id = ${jobId}::bigint`.catch(() => {});
	}
}
