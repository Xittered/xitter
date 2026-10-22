import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import "../src/admin";
import { toolActions } from "../src/admin-tools";
import { diskEdge, space, useStatfs } from "../src/disk";

const mb = 1024n * 1024n;

test("free space under the reserve or under ten percent warns", async () => {
	const low = await useStatfs(() => ({ bavail: 1024n, blocks: 20_000n, bsize: mb }), () => space());
	expect(low.warn).toBe(true);
	expect(low.free).toBe(1024n * mb);
	const plenty = await useStatfs(() => ({ bavail: 15_000n, blocks: 20_000n, bsize: mb }), () => space());
	expect(plenty.warn).toBe(false);
});

test("the low-space warning is edge triggered", () => {
	expect(diskEdge(false, true)).toEqual({ next: true, event: "low" });
	expect(diskEdge(true, true)).toEqual({ next: true });
	expect(diskEdge(true, false)).toEqual({ next: false, event: "ok" });
	expect(diskEdge(false, false)).toEqual({ next: false });
});

test("admin health reports disk free space and the overview shows it", async () => {
	const health = await useStatfs(() => ({ bavail: 1024n, blocks: 20_000n, bsize: mb }), () => toolActions.health.run(null as any, {}, undefined as any)) as { disk: { free: number; total: number; warn: boolean } };
	expect(health.disk).toEqual({ free: 1024 * 1024 * 1024, total: 20_000 * 1024 * 1024, warn: true });
	const page = readFileSync(new URL("../src/admin.html", import.meta.url), "utf8");
	expect(page).toContain("Disk free");
	expect(page).toContain("Disk total");
	expect(page).toContain("Storage is low");
	expect(page).toContain("· low");
});
