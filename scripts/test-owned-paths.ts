import { expect, test } from "bun:test";
import { blocksClientShell, trailingSlashTarget, xitterNotFoundPage } from "../src/owned-paths";

const PAGES = [
	"/account/apps",
	"/account/apps/developer",
	"/account/reset",
	"/account/forgot",
	"/account/email",
	"/account/email/confirm",
	"/account/2fa",
	"/account/passkeys",
	"/account/passkey",
	"/account/notices",
	"/account/invites",
	"/account/api",
	"/account/notes/appeals",
	"/account/automation",
	"/account/instances",
	"/account/import",
	"/account/import/upload",
	"/account/decoration",
	"/account/organisation",
	"/account/decor",
	"/account/theme",
	"/account/migrate",
	"/admin",
	"/federation/superadmin",
];

test("a trailing slash on an owned path redirects to the exact path", () => {
	for (const path of PAGES) expect(trailingSlashTarget(path + "/")).toBe(path);
	expect(trailingSlashTarget("/account/theme")).toBeNull();
	expect(trailingSlashTarget("/account/2fa/setup/")).toBe("/account/2fa/setup");
	expect(trailingSlashTarget("/admin/api/me/")).toBe("/admin/api/me");
	expect(trailingSlashTarget("/home/")).toBeNull();
	expect(trailingSlashTarget("/settings/")).toBeNull();
});

test("X's own account screens are not claimed", () => {
	expect(trailingSlashTarget("/account/")).toBe("/account");
	expect(trailingSlashTarget("/account/switch/")).toBe("/account/switch");
	expect(blocksClientShell("/account")).toBe(false);
	expect(blocksClientShell("/account/switch")).toBe(false);
	expect(blocksClientShell("/account/not_my_account/coah/secret")).toBe(false);
	expect(blocksClientShell("/home")).toBe(false);
	expect(blocksClientShell("/settings")).toBe(false);
});

test("a signed-in miss under our prefixes cannot become the client shell", () => {
	for (const path of PAGES) expect(blocksClientShell(path)).toBe(true);
	expect(blocksClientShell("/account/no-such-page")).toBe(true);
	expect(blocksClientShell("/admin/nope")).toBe(true);
	expect(blocksClientShell("/federation/superadmin/enter")).toBe(true);
	const res = xitterNotFoundPage();
	expect(res.status).toBe(404);
	expect(res.headers.get("cache-control")).toBe("no-store");
	return res.text().then((body) => {
		expect(body).toContain('data-xitter-page="missing"');
		expect(body).not.toContain("react-root");
		expect(body).not.toContain("Hmm");
	});
});
