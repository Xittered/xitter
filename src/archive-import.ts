// Settings > Import from X (/account/import): someone uploads the archive they
// downloaded from x.com (Settings > Your account > Download an archive), and
// their posts, photos, videos and profile come over with their original dates.
// It's off until an admin turns it on (Admin > Settings, feature switches),
// and then open to accounts at least min_age_days old, each import waiting
// for staff to approve it unless an admin turned that off (Admin > Settings,
// Import from X). Staff accounts skip both.
//
// The zip can be gigabytes, past the server's request size, so the page sends
// it in pieces (POST /account/import/upload?offset=n) to ARCHIVE_DIR, then
// starts the import. A few run at a time, in the background; the page shows
// their progress, and one cut off by a restart carries on. An upload nobody
// started importing is deleted after a day, one staff didn't approve after a week.
//
// Imported posts go through what a post written here does: the length limit,
// automod (a hit is a strike, once per import), the admin's blocked phrases,
// and the account's post rate limit, which the import waits on. Posts that
// fail are left out and counted.
//
// Posts keep their X ids when they can: ids sort by time, X's use the same
// layout and epoch, so an imported post sits at its date in every timeline,
// a thread's replies find their parents, and importing again skips what's
// there. They stay on this instance (other instances aren't sent years of old
// posts), @mentions are left as text (an X name here may be someone else), and
// retweets and likes aren't imported (they're other people's posts).

import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { truncate } from "node:fs/promises";
import { appendBytes, StorageFailure, putFile } from "./disk";
import { STORAGE_SENTENCE } from "./notices";
import { join } from "node:path";
import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { hateIn, hateInName } from "./hate";
import { idTime, isId, newId } from "./ids";
import { MEDIA_DIR, sniffImage } from "./media";
import { automodStrike } from "./moderation";
import { blockedNameIn, blockedWordIn } from "./names";
import { RateLimitError, chargePostCost, limitOf } from "./ratelimit";
import { feature, hasBlockedPhrase, settings } from "./settings";
import { cleanText, oneLine } from "./text-clean";
import { postLimitFor, weightedLength } from "./textlen";
import { queueVideo, sourceFile } from "./video";
import { Zip, ZipError, type ZipEntry } from "./zip";

const DIR = process.env.ARCHIVE_DIR ?? "data/imports";
const MB = 1024 * 1024;
const MAX_BYTES = Number(process.env.ARCHIVE_MAX_MB ?? 1024) * MB;
// one of the archive's JSON files, read and parsed in memory; X splits a big
// tweets.js into parts (tweets-part1.js…)
const MAX_JSON = Number(process.env.ARCHIVE_MAX_JSON_MB ?? 64) * MB;
const CHUNK_BYTES = 8 * MB;
// imports running at once; each holds one archive's posts in memory
const AT_ONCE = 2;
const EPOCH = 1288834974657n;

const fileOf = (userId: string) => join(DIR, `${userId}.zip`);

type Options = { replies: boolean; profile: boolean };
type State = "uploading" | "pending" | "queued" | "running" | "done" | "failed";
type Row = { state: State; size: number; options: Options; total: number; posts: number; media: number; skipped: number; refused: number; waiting_until: Date | null; error: string | null };

async function row(userId: string): Promise<Row | undefined> {
	const [r] = await sql`select state, size::float8 as size, options, total, posts, media, skipped, refused, waiting_until, error from archive_imports where user_id = ${userId}::bigint`;
	return r as Row | undefined;
}

class ImportError extends Error {}

// ── reading the archive ────────────────────────────────────────────────────

// data/tweets.js is "window.YTD.tweets.part0 = [...]": JSON after the "="
function ytd(text: string, name: string): any[] {
	const at = text.indexOf("=");
	try {
		const value = JSON.parse(at >= 0 ? text.slice(at + 1) : text);
		return Array.isArray(value) ? value : [];
	} catch {
		throw new ImportError(`${name.slice(name.lastIndexOf("/") + 1)} in the archive couldn't be read.`);
	}
}

// archives sit at the top of the zip or inside one folder ("twitter-2024-…/data/…")
const inData = (e: ZipEntry, pattern: RegExp) => pattern.test(e.name.replace(/^[^/]*\/(?=data\/)/, ""));

// each file matching `pattern`, in order, as its parsed rows
async function* jsFiles(zip: Zip, pattern: RegExp): AsyncGenerator<any[]> {
	for (const e of zip.entries.filter((x) => inData(x, pattern)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
		if (e.size > MAX_JSON || e.compressed > MAX_JSON)
			throw new ImportError(`${e.name.slice(e.name.lastIndexOf("/") + 1)} is larger than this instance reads (${MAX_JSON / MB} MB; an admin can raise ARCHIVE_MAX_JSON_MB).`);
		yield ytd((await zip.read(e, MAX_JSON)).toString("utf8"), e.name);
	}
}

async function readJs(zip: Zip, pattern: RegExp): Promise<any[]> {
	const out: any[] = [];
	for await (const rows of jsFiles(zip, pattern)) out.push(...rows);
	return out;
}

// the files in a media folder by name ("1234-abc.jpg"), wherever the folder sits
function mediaFiles(zip: Zip, folder: RegExp): Map<string, ZipEntry> {
	const out = new Map<string, ZipEntry>();
	for (const e of zip.entries) if (inData(e, folder) && !e.name.endsWith("/")) out.set(e.name.slice(e.name.lastIndexOf("/") + 1), e);
	return out;
}

const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// "Wed Oct 10 20:19:24 +0000 2018"
function xDate(s: unknown): Date | undefined {
	const m = typeof s === "string" ? /^\w{3} (\w{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(s) : null;
	if (!m || MONTHS[m[1]] === undefined) return typeof s === "string" && !Number.isNaN(Date.parse(s)) ? new Date(s) : undefined;
	const offset = (m[6] === "-" ? -1 : 1) * (Number(m[7]) * 60 + Number(m[8])) * 60_000;
	return new Date(Date.UTC(Number(m[9]), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])) - offset);
}

// an id for a moment, when the X id can't be used
function idAt(date: Date): string {
	const random = BigInt(Math.floor(Math.random() * 0x3fffff));
	return (((BigInt(date.getTime()) - EPOCH) << 22n) | random).toString();
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const basename = (url: unknown) => (typeof url === "string" ? (url.split("?")[0].split("/").pop() ?? "") : "");

// the post's text as written: no "@name" a reply starts with, no t.co links
function postText(t: any, note: any | undefined): string {
	if (note?.core?.text) {
		let text = String(note.core.text);
		for (const u of note.core.urls ?? []) if (u?.shortUrl && u?.expandedUrl) text = text.split(u.shortUrl).join(u.expandedUrl);
		return text.trim();
	}
	// the range counts the text as X sends it, with &amp; still escaped
	const chars = [...String(t.full_text ?? t.text ?? "")];
	const range = Array.isArray(t.display_text_range) ? t.display_text_range.map(Number) : [0, chars.length];
	let text = decode(chars.slice(range[0] || 0, range[1] || chars.length).join(""));
	for (const u of t.entities?.urls ?? []) if (u?.url && u?.expanded_url) text = text.split(u.url).join(u.expanded_url);
	for (const m of t.extended_entities?.media ?? t.entities?.media ?? []) if (m?.url) text = text.split(m.url).join("");
	return text.trim();
}

const appName = (source: unknown) => (typeof source === "string" ? source.replace(/<[^>]*>/g, "").trim().slice(0, 60) : "") || "Twitter";

// what the import uses of a tweet: X's own rows carry far more, and an archive
// holds years of them, so only this much stays in memory
type Tweet = { id: string; date: Date | undefined; text: string; replyTo: string | null; toSelf: boolean; source: string; media: { video: boolean; file: string }[] };

// the account's own tweets, oldest first, so a reply's parent comes before it;
// retweets are only counted
async function readTweets(zip: Zip, xUserId: string, notes: Map<number, any>): Promise<{ tweets: Tweet[]; retweets: number }> {
	const tweets: Tweet[] = [];
	let retweets = 0;
	for await (const rows of jsFiles(zip, /^data\/tweets?(-part\d+)?\.js$/))
		for (const raw of rows) {
			const t = raw?.tweet ?? raw;
			if (!isId(t?.id_str)) continue;
			if (t.retweeted === true || /^RT @\w+:/.test(String(t.full_text ?? ""))) {
				retweets++;
				continue;
			}
			const date = xDate(t.created_at);
			const replyTo = isId(t.in_reply_to_status_id_str) ? t.in_reply_to_status_id_str : null;
			const media = (t.extended_entities?.media ?? t.entities?.media ?? []).slice(0, 4).map((m: any) => {
				const video = m?.type === "video" || m?.type === "animated_gif";
				const best = video ? [...(m.video_info?.variants ?? [])].filter((v: any) => v?.content_type === "video/mp4").sort((a: any, b: any) => Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0))[0] : null;
				return { video, file: `${t.id_str}-${basename(video ? best?.url : m?.media_url_https)}` };
			});
			tweets.push({
				id: t.id_str,
				date,
				text: postText(t, date && notes.get(Math.floor(date.getTime() / 1000))),
				replyTo,
				toSelf: !!replyTo && (!t.in_reply_to_user_id_str || String(t.in_reply_to_user_id_str) === xUserId),
				source: appName(t.source),
				media,
			});
		}
	tweets.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
	return { tweets, retweets };
}

// ── importing ──────────────────────────────────────────────────────────────

// the fields given change; the others keep their value
async function progress(userId: string, set: Partial<Row>) {
	await sql`update archive_imports set state = coalesce(${set.state ?? null}::text, state), total = coalesce(${set.total ?? null}::int, total),
		posts = coalesce(${set.posts ?? null}::int, posts), media = coalesce(${set.media ?? null}::int, media), skipped = coalesce(${set.skipped ?? null}::int, skipped),
		refused = coalesce(${set.refused ?? null}::int, refused),
		waiting_until = case when ${"waiting_until" in set}::boolean then ${set.waiting_until ?? null}::timestamptz else waiting_until end,
		error = case when ${"error" in set}::boolean then ${set.error ?? null}::text else error end, updated_at = now()
		where user_id = ${userId}::bigint`;
}

// the same limits an upload from the composer has (Admin > Settings)
const photoMax = () => settings().limits.image_mb * MB;
const videoMax = () => settings().limits.video_mb * MB;

async function savePhoto(userId: string, data: Buffer, post: { id: string; position: number } | null): Promise<string | undefined> {
	const image = sniffImage(data);
	if (!image || data.length > photoMax()) return undefined;
	const id = newId();
	await putFile(join(MEDIA_DIR, id), data);
	await sql`insert into media (id, user_id, kind, mime, size, width, height, post_id, position)
		values (${id}::bigint, ${userId}::bigint, 'photo', ${image.mime}, ${data.length}, ${image.width}, ${image.height}, ${post?.id ?? null}::bigint, ${post?.position ?? null})`;
	return id;
}

// the video goes straight from the zip to disk, then through the same
// conversion as an upload (video.ts)
async function saveVideo(userId: string, zip: Zip, entry: ZipEntry, post: { id: string; position: number }) {
	const id = newId();
	mkdirSync(MEDIA_DIR, { recursive: true });
	const size = await zip.extract(entry, videoMax(), sourceFile(MEDIA_DIR, id));
	await sql`insert into media (id, user_id, kind, mime, size, width, height, state, post_id, position)
		values (${id}::bigint, ${userId}::bigint, 'video', 'video/mp4', ${size}, 0, 0, 'processing', ${post.id}::bigint, ${post.position})`;
	queueVideo(MEDIA_DIR, id);
}

// a profile field the editor would refuse stays as it is here
const allowed = (value: string, name = false) =>
	!(name ? hateInName(value) : hateIn(value)) && !(name ? blockedNameIn(value) : blockedWordIn(value)) && !hasBlockedPhrase(value);

async function importProfile(userId: string, zip: Zip) {
	const [account] = (await readJs(zip, /^data\/account\.js$/)).map((a) => a.account ?? a);
	const [profile] = (await readJs(zip, /^data\/profile\.js$/)).map((p) => p.profile ?? p);
	const field = (v: unknown, max: number, name = false) => {
		const value = typeof v === "string" ? (max > 100 ? cleanText(v, { lines: 6 }) : oneLine(v)).slice(0, max) : "";
		return value && allowed(value, name) ? value : null;
	};
	const d = profile?.description ?? {};
	const name = field(account?.accountDisplayName, 50, true);
	const bio = field(d.bio, 160);
	const location = field(d.location, 30);
	const website = typeof d.website === "string" && /^https?:\/\/\S+$/.test(d.website) ? field(d.website, 100) : null;
	await sql`update users set name = coalesce(${name}, name), bio = coalesce(${bio}, bio), location = coalesce(${location}, location),
		website = coalesce(${website}, website) where id = ${userId}::bigint`;
	const files = mediaFiles(zip, /^data\/profile_media\//);
	const find = (url: unknown) => [...files.entries()].find(([n]) => basename(url) && n.endsWith(`-${basename(url)}`))?.[1];
	const avatar = find(profile?.avatarMediaUrl);
	const banner = find(profile?.headerMediaUrl);
	if (avatar) {
		const id = await savePhoto(userId, await zip.read(avatar, photoMax()), null);
		if (id) await sql`update users set avatar_url = ${`/media/${id}`} where id = ${userId}::bigint`;
	}
	if (banner) {
		const id = await savePhoto(userId, await zip.read(banner, photoMax()), null);
		if (id) await sql`update users set banner_url = ${`/media/banner/${id}`} where id = ${userId}::bigint`;
	}
}

const canPost = (u: any) => !!u && u.status === "active" && !u.deactivated_at;

// why this account can't import yet, if it can't: too new (Admin > Settings)
async function tooNew(viewer: Viewer): Promise<string | undefined> {
	const days = settings().archive_import.min_age_days;
	if (viewer.role || !days) return undefined;
	const [u] = await sql`select created_at from users where id = ${viewer.id}::bigint`;
	const from = new Date(new Date(u?.created_at ?? Date.now()).getTime() + days * 86_400_000);
	if (from.getTime() <= Date.now()) return undefined;
	return `Accounts can import from X once they're ${plural(days, "day", "days")} old. Yours can from ${from.toISOString().slice(0, 10)}.`;
}

// the import of the archive waiting in ARCHIVE_DIR for this account, with the
// options its archive_imports row holds (scripts/test-archive-import.ts calls it)
export async function runImport(userId: string) {
	const r = await row(userId);
	if (!r || !existsSync(fileOf(userId))) return;
	await progress(userId, { state: "running", error: null, waiting_until: null });
	try {
		if (!feature("archive_import")) throw new ImportError("Importing from X was turned off on this instance.");
		const me = async () => (await sql`select role, status, deactivated_at, verified_type from users where id = ${userId}::bigint`)[0];
		const author = await me();
		if (!canPost(author)) throw new ImportError("Your account can't post right now, so it can't import posts either.");
		const limit = postLimitFor(author.verified_type);
		const zip = await Zip.open(fileOf(userId));
		const [account] = (await readJs(zip, /^data\/account\.js$/)).map((a) => a.account ?? a);
		// long posts: the tweet holds the first 280 characters, the note the rest
		const notes = new Map<number, any>();
		for (const n of (await readJs(zip, /^data\/note-tweet(-part\d+)?\.js$/)).map((x) => x.noteTweet ?? x)) {
			const at = Date.parse(n?.createdAt);
			if (!Number.isNaN(at)) notes.set(Math.floor(at / 1000), n);
		}
		const { tweets, retweets } = await readTweets(zip, String(account?.accountId ?? ""), notes);
		notes.clear();
		if (!tweets.length && !retweets && !account) throw new ImportError("This doesn't look like an X archive: it has no data/tweets.js.");
		const media = mediaFiles(zip, /^data\/tweets?_media\//);
		if (r.options.profile) await importProfile(userId, zip);

		await progress(userId, { total: tweets.length + retweets });
		const now = Date.now();
		let posts = 0;
		let mediaCount = 0;
		let skipped = retweets;
		let refused = 0;
		let struck = false;
		for (const [i, t] of tweets.entries()) {
			if (i % 50 === 0) {
				await progress(userId, { posts, media: mediaCount, skipped, refused });
				// suspended (an automod strike below can do it), restricted or gone mid-import
				if (!canPost(await me())) throw new ImportError("Your account can't post right now, so the import stopped.");
			}
			if (!t.date || t.date.getTime() > now || (t.replyTo && !t.toSelf && !r.options.replies)) {
				skipped++;
				continue;
			}
			const text = cleanText(t.text, { blankLines: 2 });
			if (!text && !t.media.length) {
				skipped++;
				continue;
			}
			// what a post written here must pass (posts.ts createPost)
			const hate = hateIn(text);
			if (hate || weightedLength(text) > limit || hasBlockedPhrase(text)) {
				refused++;
				if (hate && !struck) {
					struck = true;
					await automodStrike(userId, hate, "post", text);
				}
				continue;
			}
			// the X id, unless it doesn't match the post's date (a hand-made archive)
			const id = Math.abs(idTime(t.id).getTime() - t.date.getTime()) < 86_400_000 ? t.id : idAt(t.date);
			if ((await sql`select 1 from posts where id = ${id}::bigint`).length) {
				skipped++;
				continue;
			}
			// the account's post limit, as when posting: the import waits for room
			for (;;) {
				try {
					chargePostCost({ id: userId, role: author.role }, 1);
					break;
				} catch (e) {
					if (!(e instanceof RateLimitError)) throw e;
					await progress(userId, { posts, media: mediaCount, skipped, refused, waiting_until: new Date(e.hit.reset) });
					await Bun.sleep(Math.max(1000, e.hit.reset - Date.now()));
					await progress(userId, { waiting_until: null });
				}
			}
			const [parent] = t.replyTo && t.toSelf ? await sql`select id::text, conversation_id::text from posts where id = ${t.replyTo}::bigint and user_id = ${userId}::bigint` : [];
			const inserted = await sql.begin(async (tx) => {
				const rows = await tx`insert into posts (id, user_id, text, reply_to_id, reply_to_user_id, conversation_id, source, created_at, received_at)
					values (${id}::bigint, ${userId}::bigint, ${text}, ${parent?.id ?? null}::bigint, ${parent ? userId : null}::bigint,
						${parent?.conversation_id ?? id}::bigint, ${t.source}, ${t.date}, ${t.date})
					on conflict (id) do nothing returning id`;
				// years of old posts aren't news to other instances
				if (rows.length) await tx`delete from federation_outbox where kind = 'post' and a = ${id}::bigint`;
				return rows.length > 0;
			});
			if (!inserted) {
				skipped++;
				continue;
			}
			posts++;
			for (const [position, m] of t.media.entries()) {
				const entry = media.get(m.file);
				if (!entry) continue;
				try {
					if (m.video) {
						await saveVideo(userId, zip, entry, { id, position });
						mediaCount++;
					} else if (await savePhoto(userId, await zip.read(entry, photoMax()), { id, position })) mediaCount++;
				} catch (e) {
					if (!(e instanceof ZipError)) throw e;
				}
			}
		}
		await progress(userId, { state: "done", posts, media: mediaCount, skipped, refused, waiting_until: null });
	} catch (e) {
		const message = e instanceof StorageFailure ? STORAGE_SENTENCE : e instanceof ImportError || e instanceof ZipError ? e.message : "The import stopped with an error. Try again, or ask an admin to check the server log.";
		if (!(e instanceof ImportError || e instanceof ZipError)) console.error(`archive import for ${userId}:`, e);
		await progress(userId, { state: "failed", error: message, waiting_until: null });
	} finally {
		rmSync(fileOf(userId), { force: true });
	}
}

// AT_ONCE imports run; the others wait their turn
const waiting: string[] = [];
let running = 0;
function next() {
	while (running < AT_ONCE && waiting.length) {
		const userId = waiting.shift()!;
		running++;
		runImport(userId)
			.catch((e) => console.error("archive import:", e))
			.finally(() => {
				running--;
				next();
			});
	}
}
const enqueue = (userId: string) => {
	if (!waiting.includes(userId)) waiting.push(userId);
	next();
};

// Uploads left unfinished or never imported for a day are deleted, and ones
// staff haven't approved in a week, with any
// zip no import is waiting on (one whose account was deleted, say); an hour's
// grace keeps an upload that just started from being taken for one of those
export async function tidyImports() {
	for (const r of await sql`update archive_imports set state = 'failed', updated_at = now(),
			error = 'The upload wasn''t imported within a day, so it was deleted. Upload it again.'
		where state = 'uploading' and updated_at < now() - interval '1 day' returning user_id::text`)
		rmSync(fileOf(r.user_id), { force: true });
	for (const r of await sql`update archive_imports set state = 'failed', updated_at = now(),
			error = 'No one on staff approved the import within a week, so the archive was deleted. Upload it again, or ask the staff.'
		where state = 'pending' and updated_at < now() - interval '7 days' returning user_id::text`)
		rmSync(fileOf(r.user_id), { force: true });
	if (!existsSync(DIR)) return;
	const live = new Set((await sql`select user_id::text from archive_imports where state in ('uploading', 'pending', 'queued', 'running')`).map((r: any) => r.user_id));
	for (const name of readdirSync(DIR)) {
		const m = /^(\d+)\.zip$/.exec(name);
		if (!m || live.has(m[1])) continue;
		const path = join(DIR, name);
		if (Date.now() - statSync(path).mtimeMs > 60 * 60_000) rmSync(path, { force: true });
	}
}

// imports a restart cut off; and the tidying, now and every hour
export async function resumeImports() {
	await tidyImports();
	setInterval(() => void tidyImports().catch((e) => console.error("archive import tidy:", e)), 60 * 60_000).unref();
	for (const r of await sql`select user_id::text from archive_imports where state in ('queued', 'running') order by updated_at`) {
		if (existsSync(fileOf(r.user_id))) enqueue(r.user_id);
		else await sql`update archive_imports set state = 'failed', error = 'The archive was lost when the server restarted. Upload it again.' where user_id = ${r.user_id}::bigint`;
	}
}

// ── staff approval (Admin > Settings, Import from X) ──────────────────────

export async function pendingImports() {
	return sql`select a.user_id::text, u.screen_name, u.name, u.created_at, a.size::float8 as size, a.options, a.updated_at
		from archive_imports a join users u on u.id = a.user_id where a.state = 'pending' order by a.updated_at`;
}

// true when it was waiting: approved, it joins the queue; declined, the zip goes
export async function decideImport(userId: string, approve: boolean, reason = ""): Promise<boolean> {
	const error = `The staff didn't approve this import${reason ? `: ${reason}` : "."}`;
	const [r] = approve
		? await sql`update archive_imports set state = 'queued', updated_at = now() where user_id = ${userId}::bigint and state = 'pending' returning 1`
		: await sql`update archive_imports set state = 'failed', error = ${error}, updated_at = now() where user_id = ${userId}::bigint and state = 'pending' returning 1`;
	if (!r) return false;
	if (approve) enqueue(userId);
	else rmSync(fileOf(userId), { force: true });
	return true;
}

// ── the page ───────────────────────────────────────────────────────────────

const plural = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

async function page(req: Request, viewer: Viewer, r: Row | undefined, error = "") {
	const busy = r?.state === "pending" || r?.state === "queued" || r?.state === "running";
	const notYet = busy ? undefined : await tooNew(viewer);
	const summary =
		r &&
		`${plural(r.posts, "post", "posts")} and ${plural(r.media, "photo or video", "photos and videos")} imported` +
			(r.skipped ? `, ${plural(r.skipped, "post", "posts")} skipped (retweets, replies to others, or already here)` : "") +
			(r.refused ? `, ${plural(r.refused, "post", "posts")} left out by this instance's rules (too long, a blocked phrase or automod)` : "");
	const waitingUntil = r?.waiting_until ? new Date(r.waiting_until) : null;
	const wait = waitingUntil && waitingUntil.getTime() > Date.now() ? ` Waiting for your post limit (${limitOf("post")} posts every 15 minutes) until ${waitingUntil.toISOString().slice(11, 16)} UTC.` : "";
	const status = r?.state === "pending"
		? `<div class="card"><b>Waiting for the staff to approve the import</b><div class="meta">Imports on this instance are checked by a person first. This page shows when it starts; if no one approves it within a week, the archive is deleted.</div></div>`
		: busy
		? `<div class="card"><b>${r!.state === "queued" ? "Waiting for other imports to finish…" : "Importing…"}</b><div class="meta">${r!.total ? `${(r!.posts + r!.skipped + r!.refused).toLocaleString("en-US")} of ${plural(r!.total, "post", "posts")} done. ` : ""}${summary}.${wait} Videos are converted after the posts are in.</div></div>`
		: r?.state === "done"
			? `<div class="card success"><b>Import finished</b><div class="meta">${summary}. Videos may take a while longer to appear.</div></div>`
			: r?.state === "failed"
				? `<div class="card strike"><b>The import didn't finish</b><div class="meta">${esc(r.error ?? "")}</div></div>`
				: "";
	const form = busy
		? ""
		: notYet
		? `<p class="dim">${esc(notYet)}</p>`
		: `<form id="import" method="post" action="/account/import">
	<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
	<label for="file">Your X archive (.zip, up to ${Math.round(MAX_BYTES / MB)} MB)</label>
	<input id="file" type="file" accept=".zip,application/zip" required>
	<label class="row" style="margin:0;color:inherit"><input type="checkbox" name="profile" value="1" style="width:auto;min-height:0" checked> Also bring over my name, bio, location, website, profile photo and header</label>
	<label class="row" style="margin:0;color:inherit"><input type="checkbox" name="replies" value="1" style="width:auto;min-height:0"> Include my replies to other people (they become posts of their own)</label>
	<p class="dim" id="progress" hidden></p>
	<button type="submit">Upload and import</button>
</form>
<script>
(function(){
	var form=document.getElementById("import"),file=document.getElementById("file"),out=document.getElementById("progress"),csrf=form.csrf.value,CHUNK=${CHUNK_BYTES};
	form.addEventListener("submit",async function(e){
		e.preventDefault();
		var f=file.files[0];if(!f)return;
		var button=form.querySelector("button");button.disabled=true;out.hidden=false;
		try{
			for(var at=0;at<f.size||at===0;at+=CHUNK){
				out.textContent="Uploading… "+Math.floor(at/Math.max(f.size,1)*100)+"%";
				var r=await fetch("/account/import/upload?offset="+at,{method:"POST",headers:{"x-csrf-token":csrf},body:f.slice(at,at+CHUNK)});
				if(!r.ok)throw new Error((await r.json().catch(function(){return{}})).error||"The upload failed.");
				if(f.size===0)break;
			}
			out.textContent="Uploaded. Starting the import…";
			form.submit();
		}catch(err){out.textContent=err.message;button.disabled=false}
	});
})();
</script>`;
	const res = await accountPage({
		req,
		viewer,
		title: "Import from X",
		status: error ? 400 : 200,
		body: `<h1>Import from X</h1>
	<p class="dim">Bring your posts over from X with their original dates, photos and videos, and threads kept together. On x.com, go to Settings, Your account, Download an archive of your data. X emails you when it's ready, then upload the zip here.</p>
	<p class="dim">Retweets and likes aren't imported, @mentions stay as plain text (the name here may belong to someone else), and imported posts stay on this instance. They go through the same rules as a post written here, and count toward your post limit, so a big archive takes a while. Importing the same archive again skips posts that are already here.</p>
	${error ? `<p class="error">${esc(error)}</p>` : ""}
	${status}
	${form}`,
	});
	// while it runs, the page reloads itself to show the progress
	if (busy) res.headers.set("refresh", r?.state === "pending" ? "60" : "5");
	return res;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function importRoute(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	const p = url.pathname;
	if (!feature("archive_import")) {
		if (p === "/account/import/upload") return json({ error: "Importing from X is turned off on this instance." }, 404);
		return accountPage({ req, viewer, title: "Import from X", status: 404, body: `<h1>Import from X</h1><p class="dim">Importing from X is turned off on this instance.</p>` });
	}
	const r = await row(viewer.id);
	const busy = r?.state === "pending" || r?.state === "queued" || r?.state === "running";
	if (p === "/account/import/upload") {
		if (req.method !== "POST") return json({ error: "Use POST." }, 405);
		if (req.headers.get("x-csrf-token") !== viewer.csrf) return json({ error: "That page is out of date. Reload it and try again." }, 403);
		if (busy) return json({ error: "An import is already running." }, 409);
		const young = await tooNew(viewer);
		if (young) return json({ error: young }, 403);
		const offset = Number(url.searchParams.get("offset"));
		const data = new Uint8Array(await req.arrayBuffer());
		if (!Number.isSafeInteger(offset) || offset < 0 || data.length > CHUNK_BYTES) return json({ error: "Bad upload piece." }, 400);
		mkdirSync(DIR, { recursive: true });
		const file = fileOf(viewer.id);
		if (offset === 0) {
			await sql`insert into archive_imports (user_id, state, size) values (${viewer.id}::bigint, 'uploading', 0)
				on conflict (user_id) do update set state = 'uploading', size = 0, total = 0, posts = 0, media = 0, skipped = 0, refused = 0, waiting_until = null, error = null, updated_at = now()`;
			await putFile(file, Buffer.alloc(0));
		}
		const size = existsSync(file) ? statSync(file).size : -1;
		if (size !== offset) return json({ error: "The upload got out of step. Start again." }, 409);
		if (size + data.length > MAX_BYTES) {
			await truncate(file, 0);
			return json({ error: `Archives up to ${Math.round(MAX_BYTES / MB)} MB can be imported.` }, 413);
		}
		await appendBytes(file, data, size);
		await sql`update archive_imports set size = ${size + data.length}, updated_at = now() where user_id = ${viewer.id}::bigint`;
		return json({ size: size + data.length });
	}
	if (req.method !== "POST") return page(req, viewer, r);
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, r, "That form is out of date. Try again.");
	if (busy) return page(req, viewer, r, "An import is already running.");
	if (r?.state !== "uploading" || !existsSync(fileOf(viewer.id))) return page(req, viewer, r, "Upload your archive first.");
	const [me] = await sql`select status, deactivated_at from users where id = ${viewer.id}::bigint`;
	if (!canPost(me)) return page(req, viewer, r, "Your account can't post right now, so it can't import posts either.");
	const young = await tooNew(viewer);
	if (young) return page(req, viewer, r, young);
	try {
		await Zip.open(fileOf(viewer.id));
	} catch (e) {
		rmSync(fileOf(viewer.id), { force: true });
		await sql`update archive_imports set state = 'failed', error = ${e instanceof ZipError ? e.message : "That file couldn't be read."} where user_id = ${viewer.id}::bigint`;
		return new Response(null, { status: 303, headers: { location: "/account/import" } });
	}
	const options: Options = { replies: f?.get("replies") === "1", profile: f?.get("profile") === "1" };
	// staff approve each import first, unless an admin turned that off
	const approval = settings().archive_import.approval && !viewer.role;
	await sql`update archive_imports set state = ${approval ? "pending" : "queued"}, options = ${JSON.stringify(options)}::text::jsonb, updated_at = now() where user_id = ${viewer.id}::bigint`;
	if (!approval) enqueue(viewer.id);
	return new Response(null, { status: 303, headers: { location: "/account/import" } });
}
