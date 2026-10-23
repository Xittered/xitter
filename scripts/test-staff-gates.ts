import { expect, test } from "bun:test";
import { allows, mayRun, PERMISSIONS } from "../src/staff-permissions";

test("note appeal review defaults to moderator and admin", () => {
	expect(PERMISSIONS.note_appeals.group).toBe("Moderation");
	expect(PERMISSIONS.note_appeals.role).toBe("moderator");
	expect(allows("admin", "note_appeals")).toBe(true);
	expect(allows("moderator", "note_appeals")).toBe(true);
	expect(allows("support", "note_appeals")).toBe(false);
	expect(allows(null, "note_appeals")).toBe(false);
	expect(allows(undefined, "note_appeals")).toBe(false);
});

test("client apps stay admin-only on the same actions the panel lists", async () => {
	for (const action of ["platforms", "createPlatform", "revokePlatform"]) {
		expect(mayRun("admin", action, "admin")).toBe(true);
		expect(mayRun("moderator", action, "admin")).toBe(false);
		expect(mayRun("support", action, "admin")).toBe(false);
		expect(mayRun(null, action, "admin")).toBe(false);
	}
	const html = await Bun.file(new URL("../src/admin.html", import.meta.url)).text();
	expect(html).toContain('apps: { icon: "devices", title: "Client apps", needs: "platforms" }');
	expect(html).toContain('allow("createPlatform"');
	expect(html).toContain('allow("revokePlatform"');
});
