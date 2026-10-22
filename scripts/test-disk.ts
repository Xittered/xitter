import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEDIA_DIR, mediaUpload } from "../src/media";
import { STORAGE_SENTENCE, putFile, useDisk, useStatfs } from "../src/disk";
import { failFor } from "../src/failure";
import { allowedNotice, NOTICE_HEADER, noticeHeaders } from "../src/notices";
import { newId } from "../src/ids";

const low = () => ({ bavail: 0n, blocks: 1000n, bsize: 4096 });
const viewer = { id: newId() } as any;

function pendingNames(): string[] {
	const dir = join(MEDIA_DIR, ".pending");
	return existsSync(dir) ? readdirSync(dir) : [];
}

async function answered(req: Request) {
	try {
		return await mediaUpload(req, new URL(req.url), viewer);
	} catch (e) {
		const res = failFor(req, e);
		if (res) return res;
		throw e;
	}
}

test("low space refuses INIT with the storage sentence and leaves no pending dir", async () => {
	const before = pendingNames();
	const req = new Request("http://localhost/i/media/upload.json?command=INIT&total_bytes=1000&media_type=image/jpeg", { method: "POST" });
	const res = await useStatfs(low, () => answered(req));
	expect(res.status).toBe(503);
	expect(res.headers.get(NOTICE_HEADER)).toBe(STORAGE_SENTENCE);
	expect(res.headers.get("retry-after")).toBe("60");
	const body = await res.json();
	expect(body).toEqual({ error: STORAGE_SENTENCE, errors: [{ code: 130, message: STORAGE_SENTENCE }] });
	expect(JSON.stringify(body)).not.toMatch(/ENOSPC|errno|postgres|\.pending/i);
	expect(pendingNames()).toEqual(before);
});

test("ENOSPC during APPEND removes the temp file and the pending upload", async () => {
	const bytes = Buffer.alloc(32, 7);
	const init = new Request("http://localhost/i/media/upload.json?command=INIT&total_bytes=32&media_type=image/jpeg", { method: "POST" });
	const started = await answered(init);
	expect(started.status).toBe(202);
	const id = (await started.json()).media_id_string as string;
	const form = new FormData();
	form.set("media", new Blob([bytes]), "a.jpg");
	const append = new Request(`http://localhost/i/media/upload.json?command=APPEND&media_id=${id}&segment_index=0`, { method: "POST", body: form });
	const res = await useDisk({
		write() {
			const e = new Error("no space") as NodeJS.ErrnoException;
			e.code = "ENOSPC";
			throw e;
		},
	}, () => answered(append));
	expect(res.status).toBe(503);
	expect(res.headers.get(NOTICE_HEADER)).toBe(STORAGE_SENTENCE);
	expect((await res.json()).errors[0].message).toBe(STORAGE_SENTENCE);
	expect(existsSync(join(MEDIA_DIR, ".pending", id))).toBe(false);
	expect(existsSync(join(MEDIA_DIR, id))).toBe(false);
	const again = await answered(new Request(`http://localhost/i/media/upload.json?command=APPEND&media_id=${id}&segment_index=0`, { method: "POST" }));
	expect(again.status).toBe(404);
});

test("a storage failure never publishes a short file", async () => {
	const dir = mkdtempSync(join(tmpdir(), "xitter-disk-"));
	const dest = join(dir, "photo.bin");
	const extra = join(dir, "pending");
	mkdirSync(extra);
	writeFileSync(join(extra, "seg"), "partial");
	await expect(useDisk({
		write(path, bytes) {
			writeFileSync(path, bytes);
			const e = new Error("quota") as NodeJS.ErrnoException;
			e.code = "EDQUOT";
			throw e;
		},
	}, () => putFile(dest, Buffer.from("hello"), [extra]))).rejects.toMatchObject({ name: "StorageFailure", message: STORAGE_SENTENCE });
	expect(existsSync(dest)).toBe(false);
	expect(existsSync(extra)).toBe(false);
	expect(readdirSync(dir).some((name) => name.endsWith(".tmp"))).toBe(false);
	await putFile(dest, Buffer.from("hello"));
	expect(readFileSync(dest).toString()).toBe("hello");
	expect(readdirSync(dir)).toEqual(["photo.bin"]);
	rmSync(dir, { recursive: true, force: true });
});

test("a bad multipart upload is a 400", async () => {
	const req = new Request("http://localhost/i/media/upload.json?command=INIT", {
		method: "POST",
		headers: { "content-type": "multipart/form-data; boundary=----nope" },
		body: "this is not a body",
	});
	const res = await mediaUpload(req, new URL(req.url), viewer);
	expect(res.status).toBe(400);
	expect(await res.json()).toEqual({ error: "That upload could not be read.", errors: [{ code: 324, message: "That upload could not be read." }] });
});

test("the notice allowlist rejects arbitrary text", () => {
	expect(allowedNotice(STORAGE_SENTENCE)).toBe(true);
	expect(allowedNotice("Videos can be up to 10 minutes long.")).toBe(true);
	expect(allowedNotice("Videos can be up to 10 minutes long. /etc/passwd")).toBe(false);
	expect(allowedNotice("ENOSPC on /tmp/media")).toBe(false);
	expect(noticeHeaders("ENOSPC on /tmp/media").has(NOTICE_HEADER)).toBe(false);
	expect(noticeHeaders(STORAGE_SENTENCE).get(NOTICE_HEADER)).toBe(STORAGE_SENTENCE);
	const res = failFor(new Request("http://localhost/i/api/graphql/CreateTweet", { method: "POST" }), new Error("/var/lib/postgres"));
	expect(res).toBeUndefined();
});
