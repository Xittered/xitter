import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { actionNeed } from "../src/staff-permissions";
import { settingsChrome } from "../src/owned-paths";
import { FRESH_SCRIPT, hideCss, TIDY_SCRIPT } from "../src/tidy";

test("an action the role cannot run names the permission", () => {
	expect(actionNeed("deletePost", "moderator")).toBe("Delete posts");
	expect(actionNeed("appeals", "moderator")).toBe("See and answer appeals");
	expect(actionNeed("createPlatform", "admin")).toBe("the admin role");
});

test("the admin panel is a searchable grouped list with a detail column", () => {
	const html = readFileSync(new URL("../src/admin.html", import.meta.url), "utf8");
	expect(html).toContain('aria-label="Search admin"');
	for (const group of ["Moderation", "Accounts", "Content", "Instance", "Staff"]) expect(html).toContain(`"${group}"`);
	expect(html).toContain('id="back"');
	expect(html).toContain('data-depth="0"');
	expect(html).toContain("function allow(action, html)");
	expect(html).toContain('allow("createBadge"');
	expect(html).toContain('allow("deletePost"');
	expect(html).toContain('allow("createInvite"');
	expect(html).toContain('need("createStickerPack")');
	expect(html).not.toContain('can("createBadge") ?');
	expect(html).not.toContain('can("deletePost") ?');
	expect(html).toContain('needs: "platforms"');
	expect(html).toContain(".table, .table tbody { display: block;");
	expect(html).toContain("overflow-wrap: anywhere");
});

test("the admin layout is flush against the client rail and grows the detail column", () => {
	const html = readFileSync(new URL("../src/admin.html", import.meta.url), "utf8");
	expect(html).toContain(".app { display: flex; align-items: flex-start; min-height: 100vh; }");
	expect(html).not.toContain(".app { display: flex; justify-content: center;");
	expect(html).toContain("main { flex: 1 1 auto; min-width: 0;");
	expect(html).toContain("@media (max-width: 700px)");
	expect(html).toContain(".app { display: block; }");
	expect(html).toContain("nav, main { width: 100%; border-right: 0; }");
	expect(html).toContain("nav { width: 280px; }");
});

test("card grids keep even padding and a gap before the next section", () => {
	const html = readFileSync(new URL("../src/admin.html", import.meta.url), "utf8");
	expect(html).toContain(".cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(160px, 100%), 1fr)); gap: 10px; margin-bottom: 16px; }");
	expect(html).toContain(".card { background: var(--panel); border-radius: 12px; padding: 16px; }");
	expect(html).toContain(".box { background: var(--panel); border-radius: 12px; padding: 16px; }");
	expect(html).toContain(".grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 16px; }");
});

test("the admin panel has a way back out", () => {
	const html = readFileSync(new URL("../src/admin.html", import.meta.url), "utf8");
	// no hand-made rail any more: in a tab the client draws its own nav and
	// frames the panel over its main column (tidy.ts), so nothing here imitates it
	expect(html).not.toContain("{{rail}}");
	expect(html).not.toContain("{{railcss}}");
	// standing alone, the panel's own head has a back arrow and a logo home
	expect(html).toContain('id="navback" href="/account/xitter"');
	expect(html).toContain('<a class="home" href="/home"');
	// and its list ends with the way home, and Superadmin for a superadmin
	expect(html).toContain("leaveTo(\\'/home\\')");
	expect(html).toContain("Back to {{instance}}");
	expect(html).toContain("leaveTo(\\'/federation/superadmin\\')");
	// framed, leaving moves the client, not the frame: the back arrow asks the
	// client for the place the panel was opened from, links out are handed over
	expect(html).toContain("parent.postMessage");
	expect(html).toContain('if (a.id === "navback") tell({ type: "back" });');
	expect(html).toContain('tell({ type: "go", path');
	expect(html).toContain('document.documentElement.setAttribute("data-framed", "")');
	// the client remembers where the panel was opened from, answers "back" with
	// it, and hosts the panel under its own frame mode
	expect(FRESH_SCRIPT).toContain('sessionStorage.setItem("xitter-admin-from"');
	expect(TIDY_SCRIPT).toContain('d.type==="back"');
	expect(TIDY_SCRIPT).toContain('sessionStorage.getItem("xitter-admin-from")');
	expect(TIDY_SCRIPT).toContain('kind="admin"');
	expect(hideCss()).toContain('html[data-xitter-host="admin"]');
	// Superadmin is one of the framed pages, and only the real path is
	expect(settingsChrome("/federation/superadmin")).toBe(true);
	expect(settingsChrome("/federation/superadminx")).toBe(false);
});
