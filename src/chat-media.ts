import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { holdLock, sql } from "./db";
import { newId } from "./ids";

const directory = join(process.env.MEDIA_DIR ?? "media", "chat");
const maxBytes = Number(process.env.MAX_CHAT_MEDIA_MB ?? 200) * 1024 * 1024;
const MAX_OPEN = 20;
const MAX_OPEN_BYTES = 1024 ** 3;
const DAY = 24 * 60 * 60_000;
type Authorize = (viewerId: string, conversationId: string) => Promise<string[]>;

export function chatMedia(authorize: Authorize, create: Authorize = authorize) {
	const handlers = {
		InitializeXChatMediaUploadMutation: async (v: Viewer, vars: Record<string, any>) => {
			const size = Number(vars.total_bytes);
			if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes || vars.is_public)
				return { data: { xchat_initialize_media_upload: { __typename: "InitializeMediaUploadError", upload_error: "InvalidRequest" } } };
			await create(v.id, String(vars.conversation_id));
			// what one account may hold unfinished: each upload reserves its disk
			// until it is sealed or swept (sweepChatUploads)
			const hash = randomBytes(24).toString("hex");
			const resume = newId();
			const taken = await sql.begin(async (tx) => {
				await holdLock(tx, `chat-uploads:${v.id}`);
				const [open] = await tx`select count(*)::int as n, coalesce(sum(total_bytes), 0)::bigint as bytes from chat_uploads
					where uploader_id = ${v.id}::bigint and not ready`;
				if (open.n >= MAX_OPEN || Number(open.bytes) + size > Math.max(MAX_OPEN_BYTES, maxBytes)) return false;
				await tx`insert into chat_uploads (hash, resume_id, conversation_id, message_id, uploader_id, total_bytes)
					values (${hash}, ${resume}::bigint, ${String(vars.conversation_id)}, ${String(vars.message_id)}, ${v.id}::bigint, ${size})`;
				return true;
			});
			if (!taken) return { data: { xchat_initialize_media_upload: { __typename: "InitializeMediaUploadError", upload_error: "InvalidRequest" } } };
			await mkdir(join(directory, hash), { recursive: true });
			return { data: { xchat_initialize_media_upload: {
				__typename: "InitializeMediaUploadResult", media_hash_key: hash, resume_id: resume,
				resume_upload_url: `${PUBLIC_ORIGIN}/i/ton/data/xchat_media/${encodeURIComponent(vars.conversation_id)}/${hash}`,
			} } };
		},
		FinalizeXChatMediaUploadMutation: async (v: Viewer, vars: Record<string, any>) => {
			await authorize(v.id, String(vars.conversation_id));
			// the parts go once the sealed file is committed (until then they are
			// what a retried finalize reads)
			const sealedParts: string[] = [];
			const answer = await sql.begin(async (tx) => {
				const [upload] = await tx`select * from chat_uploads where hash = ${String(vars.media_hash_key)} and uploader_id = ${v.id}::bigint
					and conversation_id = ${String(vars.conversation_id)} and message_id = ${String(vars.message_id)} and resume_id::text = ${String(vars.resume_id)} for update`;
				const count = Number(vars.num_parts);
				let error: string | null = null;
				if (!upload || !Number.isInteger(count) || count < 1 || count > 1024 || vars.is_public) error = "InvalidRequest";
				else if (!upload.ready) {
					const parts: Blob[] = [];
					for (let i = 0; i < count; i++) {
						const file = Bun.file(join(directory, upload.hash, `${i}.part`));
						if (!(await file.exists())) { error = "MissingPart"; break; }
						parts.push(file);
					}
					if (!error && parts.reduce((sum, part) => sum + part.size, 0) !== Number(upload.total_bytes)) error = "SizeMismatch";
					if (!error) {
						const ttl = vars.ttl_msec == null ? null : Number(vars.ttl_msec);
						if (ttl !== null && (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 31536000000)) error = "InvalidRequest";
						else {
							const sink = Bun.file(join(directory, upload.hash, "sealed")).writer();
							try {
								for (const part of parts) {
									sink.write(new Uint8Array(await part.arrayBuffer()));
									await sink.flush();
								}
							} finally { await sink.end(); }
							await tx`update chat_uploads set ready = true, expires_at = ${ttl === null ? null : new Date(Date.now() + ttl)} where hash = ${upload.hash}`;
							for (let i = 0; i < count; i++) sealedParts.push(join(directory, upload.hash, `${i}.part`));
						}
					}
				}
				return { data: { xchat_finalize_media_upload: { __typename: "FinalizeMediaUploadResponse", upload_error: error } } };
			});
			await Promise.all(sealedParts.map((file) => rm(file, { force: true })));
			return answer;
		},
	};
	async function route(req: Request, viewer: Viewer | null, url: URL): Promise<Response> {
		if (!viewer) return new Response("unauthorized", { status: 401 });
		const match = /^\/i\/ton\/data\/xchat_media\/([^/]+)\/([a-f0-9]{48})$/.exec(url.pathname);
		if (!match) return new Response("not found", { status: 404 });
		const conversation = decodeURIComponent(match[1]);
		try { await authorize(viewer.id, conversation); } catch { return new Response("forbidden", { status: 403 }); }
		const [upload] = await sql`select * from chat_uploads where hash = ${match[2]} and conversation_id = ${conversation}
			and (expires_at is null or expires_at > now())`;
		if (!upload) return new Response("not found", { status: 404 });
		if (req.method === "GET" || req.method === "HEAD") {
			if (!upload.ready) return new Response("not found", { status: 404 });
			return new Response(req.method === "HEAD" ? null : Bun.file(join(directory, upload.hash, "sealed")), {
				headers: { "content-type": "application/octet-stream", "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-length": String(upload.total_bytes) },
			});
		}
		if (req.method !== "POST" && req.method !== "PUT") return new Response(null, { status: 405 });
		const sameOrigin = req.headers.get("origin") === PUBLIC_ORIGIN && req.headers.get("sec-fetch-site") === "same-origin";
		if ((!sameOrigin && req.headers.get("x-csrf-token") !== viewer.csrf) || upload.uploader_id.toString() !== viewer.id || upload.ready)
			return new Response("forbidden", { status: 403 });
		const index = url.searchParams.get("partNumber") ?? "0";
		if (!/^\d{1,4}$/.test(index) || Number(index) > 1023 || url.searchParams.get("resumeId") !== upload.resume_id.toString())
			return new Response("invalid part", { status: 400 });
		const reader = req.body?.getReader();
		if (!reader) return new Response("empty part", { status: 400 });
		const chunks: Uint8Array[] = [];
		let size = 0;
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			size += result.value.length;
			if (size > Math.min(Number(upload.total_bytes), 8 * 1024 * 1024)) { await reader.cancel(); return new Response("too large", { status: 413 }); }
			chunks.push(result.value);
		}
		return sql.begin(async (tx) => {
			const [current] = await tx`select ready from chat_uploads where hash = ${upload.hash} for update`;
			if (!current || current.ready) return new Response("upload finalized", { status: 409 });
			const folder = join(directory, upload.hash);
			const other = (await readdir(folder)).filter((name) => /^\d+\.part$/.test(name) && name !== `${Number(index)}.part`);
			const stored = (await Promise.all(other.map((name) => Bun.file(join(folder, name)).size))).reduce((a, b) => a + b, 0);
			if (!size || stored + size > Number(upload.total_bytes)) return new Response("too large", { status: 413 });
			const temp = join(folder, `${crypto.randomUUID()}.tmp`);
			await writeFile(temp, Buffer.concat(chunks));
			await rename(temp, join(folder, `${Number(index)}.part`));
			return new Response(null, { status: 204 });
		});
	}
	return { handlers, route };
}

// Uploads never finished within a day, ones past their message's time to live,
// and folders whose row went with its account (chat_uploads cascades on users).
// A folder is made just before its row, so only day-old strays are taken.
export async function sweepChatUploads() {
	const gone = await sql`delete from chat_uploads where (not ready and created_at < now() - interval '1 day') or expires_at < now() returning hash`;
	for (const { hash } of gone) await rm(join(directory, hash), { recursive: true, force: true });
	const folders = (await readdir(directory).catch(() => [] as string[])).filter((name) => /^[a-f0-9]{48}$/.test(name));
	if (!folders.length) return;
	const known = new Set((await sql`select hash from chat_uploads where hash = any(${sql.array(folders, "TEXT")})`).map((r: any) => r.hash as string));
	for (const name of folders) {
		if (known.has(name)) continue;
		const made = await stat(join(directory, name)).then((s) => s.mtimeMs, () => Date.now());
		if (made < Date.now() - DAY) await rm(join(directory, name), { recursive: true, force: true });
	}
}
