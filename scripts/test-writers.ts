import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveBranding } from "../src/branding";
import { STORAGE_SENTENCE, StorageFailure, appendBytes, putStream, useDisk } from "../src/disk";
import { enqueueVideo } from "../src/video";

const full = () => {
	const e = new Error("no space") as NodeJS.ErrnoException;
	e.code = "ENOSPC";
	throw e;
};

test("an archive chunk rewinds when the disk fills", async () => {
	const dir = mkdtempSync(join(tmpdir(), "xitter-archive-"));
	const file = join(dir, "archive.zip");
	writeFileSync(file, "hello");
	try {
		await expect(useDisk({ write: full }, () => appendBytes(file, Buffer.from(" more"), 5))).rejects.toMatchObject({ name: "StorageFailure", message: STORAGE_SENTENCE });
		expect(readFileSync(file, "utf8")).toBe("hello");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a logo stays as it was when a replacement cannot be stored", async () => {
	const dir = mkdtempSync(join(tmpdir(), "xitter-brand-"));
	const prev = process.env.BRANDING_DIR;
	process.env.BRANDING_DIR = dir;
	const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
	try {
		expect(await saveBranding("logo-dark", png)).toBeUndefined();
		expect(await useDisk({ write: full }, () => saveBranding("logo-dark", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 9])))).toBe(STORAGE_SENTENCE);
		expect(Uint8Array.from(readFileSync(join(dir, "logo-dark")))).toEqual(png);
		expect(readdirSync(dir).some((name) => /\.tmp(\.|$)/.test(name))).toBe(false);
	} finally {
		if (prev === undefined) delete process.env.BRANDING_DIR;
		else process.env.BRANDING_DIR = prev;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a video that cannot be stored does not stop the next one", async () => {
	let ran = false;
	await enqueueVideo(async () => { throw new StorageFailure(); });
	await enqueueVideo(async () => { ran = true; });
	expect(ran).toBe(true);
});

const hasFfmpeg = Bun.spawnSync(["ffmpeg", "-version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

// ffmpeg picks the output format from the file name, so the temp file must keep
// the final extension or every video poster fails
test.skipIf(!hasFfmpeg)("ffmpeg can write a poster through putStream", async () => {
	const dir = mkdtempSync(join(tmpdir(), "xitter-poster-"));
	try {
		const poster = join(dir, "1.poster.jpg");
		let seen = "";
		await putStream(poster, async (tmp) => {
			seen = tmp;
			const p = Bun.spawn(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", "-q:v", "3", tmp], { stdout: "ignore", stderr: "pipe" });
			expect(await p.exited).toBe(0);
		});
		expect(seen.endsWith(".jpg")).toBe(true);
		expect(readFileSync(poster).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
		expect(readdirSync(dir)).toEqual(["1.poster.jpg"]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
