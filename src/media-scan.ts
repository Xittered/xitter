// Cloudflare's CSAM Scanning Tool only looks at what passes through its cache,
// and /media/ never does: it is per-viewer and private. So every photo also
// gets a signed copy URL that is public and cacheable, and a job fetches it
// once through the instance's public origin to put it in the cache. Nobody but
// the server knows the signature, so this exposes nothing new.
//
// Off unless MEDIA_SCAN=1: only an instance behind Cloudflare with the tool on
// gains anything. Matches arrive as Cloudflare's daily email (paths are
// /media-scan/<id>.<ext>); the recheck below also catches a block the moment it
// shows up as a 451 and hides the media, but it never suspends anyone.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { recordError } from "./errors";
import { newId } from "./ids";
import { MEDIA_DIR, MEDIA_CSP } from "./media";

const TYPES: Record<string, string> = { png: "image/png", gif: "image/gif", webp: "image/webp", jpg: "image/jpeg" };
const EXT: Record<string, string> = { "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/jpeg": "jpg" };
const WARM_BATCH = 50;
const RECHECK_DAYS = 7;

export const scanEnabled = () => process.env.MEDIA_SCAN === "1";

let key: Buffer | undefined;
function scanKey(): Buffer {
	if (key) return key;
	const file = join(MEDIA_DIR, ".scan-key");
	if (process.env.MEDIA_SCAN_SECRET) key = Buffer.from(process.env.MEDIA_SCAN_SECRET);
	else if (existsSync(file)) key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
	else {
		key = randomBytes(32);
		mkdirSync(MEDIA_DIR, { recursive: true });
		writeFileSync(file, key.toString("hex"), { mode: 0o600 });
	}
	return key;
}

const sign = (id: string) => createHmac("sha256", scanKey()).update(`media-scan:${id}`).digest("base64url").slice(0, 32);

export const scanPath = (id: string, mime: string) => (EXT[mime] ? `/media-scan/${id}.${EXT[mime]}?s=${sign(id)}` : undefined);

// /media-scan/<id>.<ext>?s=<sig>; anything off answers a plain 404, cacheable
// for a short while so a wrong guess can't be used to load the origin
export async function serveScanCopy(path: string, url: URL): Promise<Response> {
	const none = () => new Response("not found", { status: 404, headers: { "cache-control": "public, max-age=60" } });
	if (!scanEnabled()) return none();
	const m = /^\/media-scan\/(\d{1,19})\.(png|gif|webp|jpg)$/.exec(path);
	const s = url.searchParams.get("s") ?? "";
	if (!m || s.length !== 32) return none();
	const want = Buffer.from(sign(m[1]));
	if (!timingSafeEqual(want, Buffer.from(s.padEnd(32).slice(0, 32)))) return none();
	const [row] = await sql`select mime from media where id = ${m[1]}::bigint and kind = 'photo' and scan_blocked_at is null`;
	const file = join(MEDIA_DIR, m[1]);
	if (!row || TYPES[m[2]] !== row.mime || !existsSync(file)) return none();
	return new Response(Bun.file(file), {
		headers: {
			"content-type": row.mime,
			"cache-control": "public, max-age=31536000, immutable",
			"x-content-type-options": "nosniff",
			"content-security-policy": MEDIA_CSP,
			"x-xitter-scan": "1",
		},
	});
}

async function fetchCopy(id: string, mime: string): Promise<{ status: number; ours: boolean; cache: string } | undefined> {
	const path = scanPath(id, mime);
	if (!path) return;
	const res = await fetch(PUBLIC_ORIGIN + path, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
	// the body has to be read for the edge to finish storing it
	await res.arrayBuffer().catch(() => {});
	return { status: res.status, ours: res.headers.get("x-xitter-scan") === "1", cache: res.headers.get("cf-cache-status") ?? "" };
}

// Cloudflare answers a legal block with 451. The file stays on disk (it has to
// be kept for the report), but nobody is served it any more; staff gets a
// report with what to do next.
async function blocked(id: string) {
	const [m] = await sql`update media set scan_blocked_at = now() where id = ${id}::bigint and scan_blocked_at is null
		returning user_id::text, post_id::text`;
	if (!m) return;
	if (m.post_id) await sql`update posts set hidden = true where id = ${m.post_id}::bigint`;
	const details =
		`Cloudflare's CSAM Scanning Tool blocked media ${id}. The post (if any) is hidden and the file is no longer served. ` +
		"Do not open or download it. Report it to NCMEC (CyberTipline), keep the file and the account data for a year, " +
		"then decide about the account. A false match is reviewed under Security Center > Blocked Content.";
	await sql`insert into reports (id, reporter_id, post_id, user_id, reason, details)
		values (${newId()}::bigint, null, ${m.post_id ?? null}::bigint, ${m.user_id}::bigint, 'csam_match', ${details})`;
	await sql`insert into audit_log (id, action, target, detail)
		values (${newId()}::bigint, 'media_scan_block', ${id}, ${JSON.stringify({ post: m.post_id, user: m.user_id })}::text::jsonb)`;
	console.error(`media scan: Cloudflare blocked media ${id}`);
}

async function check(id: string, mime: string): Promise<"ok" | "blocked" | "error"> {
	const r = await fetchCopy(id, mime).catch((e) => {
		console.error(`media scan: ${id}: ${e.message}`);
		return undefined;
	});
	if (!r) return "error";
	if (r.status === 451) {
		await blocked(id);
		return "blocked";
	}
	// our own 404 means the file is gone; nothing to scan then
	if (r.ours || r.status === 404) return "ok";
	console.error(`media scan: ${id}: got ${r.status} from the edge`);
	return "error";
}

// new photos (and, the first time, the whole library), newest first
export async function warmScanCopies(): Promise<number> {
	if (!scanEnabled()) return 0;
	const rows = await sql`select id::text, mime from media where kind = 'photo' and state = 'ready'
		and scan_warmed_at is null and scan_blocked_at is null order by id desc limit ${WARM_BATCH}`;
	let done = 0;
	for (const r of rows) {
		const res = await check(r.id, r.mime);
		if (res === "error") continue;
		await sql`update media set scan_warmed_at = now(), scan_checked_at = now() where id = ${r.id}::bigint`;
		done++;
	}
	return done;
}

// once a day, recent photos are asked for again: a block placed after the
// first fetch shows up as a 451 here, well before staff reads the email
export async function recheckScanCopies(): Promise<void> {
	if (!scanEnabled()) return;
	const rows = await sql`select id::text, mime from media where kind = 'photo' and scan_blocked_at is null
		and scan_warmed_at > now() - make_interval(days => ${RECHECK_DAYS})
		and scan_checked_at < now() - interval '20 hours' order by id desc limit 2000`;
	for (const r of rows) if ((await check(r.id, r.mime)) !== "error") await sql`update media set scan_checked_at = now() where id = ${r.id}::bigint`;
}

export function startMediaScan() {
	if (!scanEnabled()) return;
	const job = (name: string, f: () => Promise<unknown>) => () =>
		f().catch((e) => {
			console.error(`${name} failed`, e.message);
			recordError("job", e, { path: name });
		});
	setInterval(job("media scan warm", warmScanCopies), 2 * 60_000).unref();
	setInterval(job("media scan recheck", recheckScanCopies), 6 * 3600_000).unref();
}
