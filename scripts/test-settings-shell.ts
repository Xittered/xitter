import { expect, test } from "bun:test";
import { clientRouteFor, FRAMED_HEADERS, FRAMED_ROOTS, framedPathFor, opensInTab, settingsChrome } from "../src/owned-paths";
import { renderSettingsShell, SHELL_CSS } from "../src/settings-shell";
import { FRESH_SCRIPT, hideCss, tidyData, TIDY_SCRIPT } from "../src/tidy";
import { xitterSections, type MenuFacts } from "../src/xitter-menu";

function facts(over: Partial<MenuFacts> = {}): MenuFacts {
	return {
		role: null,
		localSuperadmin: false,
		instance: null,
		org: false,
		gold: false,
		notices: false,
		invitesOpen: false,
		federation: false,
		archiveImport: false,
		staffGate: null,
		instanceName: "Xitter",
		...over,
	};
}

function shell(path: string, sections = xitterSections(facts())) {
	return renderSettingsShell({
		path,
		title: "Theme",
		body: "<h1>Theme</h1>",
		back: { href: "/account/xitter", label: "Xitter" },
		sections,
		sourceName: "Xitter",
		sourceUrl: "https://example.com",
	});
}

test("the framed pages are ours, and X's own account screens stay the client's", () => {
	for (const path of ["/account/xitter", "/account/theme", "/account/email", "/account/email/confirm", "/account/apps/developer", "/account/2fa/setup", "/account/notes/appeals", "/account/passkeys/remove", "/federation/superadmin"]) expect(settingsChrome(path)).toBe(true);
	for (const path of ["/account", "/account/switch", "/account/forgot", "/account/reset", "/account/passkey", "/appeal", "/federation/superadminx", "/settings/xitter"]) expect(settingsChrome(path)).toBe(false);
});

test("a tab address and its framed address trade places", () => {
	expect(clientRouteFor("/account/xitter")).toBe("/settings/xitter");
	expect(clientRouteFor("/account/theme")).toBe("/settings/xitter/theme");
	expect(clientRouteFor("/account/email")).toBe("/settings/xitter/email");
	expect(clientRouteFor("/account/2fa/setup")).toBe("/settings/xitter/2fa/setup");
	expect(clientRouteFor("/federation/superadmin")).toBe("/settings/xitter/superadmin");
	// pages the client does not frame keep their own address
	for (const path of ["/account", "/account/switch", "/settings/account", "/home"]) expect(clientRouteFor(path)).toBe(null);
	expect(framedPathFor("/settings/xitter")).toBe("/account/xitter");
	expect(framedPathFor("/settings/xitter/theme")).toBe("/account/theme");
	expect(framedPathFor("/settings/xitter/superadmin")).toBe("/federation/superadmin");
	expect(framedPathFor("/settings/xitter/email")).toBe("/account/email");
	for (const path of ["/settings/xitter/unknown", "/settings/account", "/home", "/settings/xitterx"]) expect(framedPathFor(path)).toBe(null);
	// every framed root survives the round trip
	for (const root of FRAMED_ROOTS) {
		const route = clientRouteFor(root);
		expect(route).not.toBe(null);
		expect(framedPathFor(route!)).toBe(root);
	}
});

test("only a browser tab is sent to the framed address", () => {
	const tab = new Request("http://x/account/theme", { headers: { "sec-fetch-dest": "document" } });
	const frame = new Request("http://x/account/theme", { headers: { "sec-fetch-dest": "iframe" } });
	const bare = new Request("http://x/account/theme");
	expect(opensInTab(tab)).toBe(true);
	expect(opensInTab(frame)).toBe(false);
	expect(opensInTab(bare)).toBe(false);
});

test("framed pages may only be framed by this site itself", () => {
	expect(FRAMED_HEADERS["x-frame-options"]).toBe("SAMEORIGIN");
	expect(FRAMED_HEADERS["content-security-policy"]).toBe("frame-ancestors 'self'");
});

test("the Xitter list is our pages only; the client draws everything around it", () => {
	const home = shell("/account/xitter");
	expect(home).toContain('data-depth="1"');
	expect(home).toContain('data-pane="xitter"');
	expect(home).toContain('href="/settings"');
	expect(home).toContain('aria-label="Search Xitter"');
	expect(home).toContain("Appearance");
	expect(home).toContain('href="/account/theme"');
	expect(home).toContain("Theme");
	expect(home).toContain("open source");
	// no imitation of X: no app rail, no Settings list of X's own
	for (const fake of ['aria-label="Primary"', 'href="/home"', 'href="/explore"', 'href="/notifications"', 'href="/compose/post"', "Your account", "Monetization", 'class="tabs"', 'data-pane="settings"', 'class="xrail"']) expect(home).not.toContain(fake);
	expect(SHELL_CSS).not.toContain(".xrail");
	expect(SHELL_CSS).toContain("html[data-framed]");
	expect(SHELL_CSS).toContain(".xembed{min-height:100vh}");
	const page = shell("/account/theme");
	expect(page).toContain('data-depth="2"');
	expect(page).toContain('data-pane="page"');
	expect(page).toContain("<h1>Theme</h1>");
	expect(page).toContain('href="/account/xitter"');
	expect(page).not.toContain('data-pane="xitter"');
	// inside the frame, links move the client, not just the frame
	for (const out of [home, page]) {
		expect(out).toContain("postMessage");
		expect(out).toContain('type:"go"');
		expect(out).toContain("data-framed");
	}
});

test("the sections follow the viewer's role, and staff tools stay staff-only", () => {
	const member = xitterSections(facts());
	expect(member.map((s) => s.title)).toEqual(["Appearance", "Account", "Security and apps", "Staff and notes"]);
	expect(JSON.stringify(member)).not.toContain("/admin");
	expect(shell("/account/xitter", member)).not.toContain('href="/admin"');
	const staff = xitterSections(facts({ role: "admin", localSuperadmin: true }));
	const tools = staff.find((s) => s.id === "staff");
	expect(tools?.title).toBe("Staff tools");
	const hrefs = tools?.rows.map((r) => r.href) ?? [];
	for (const href of ["/admin", "/admin#reports", "/admin#appeals", "/account/notes/appeals", "/admin#users", "/federation/superadmin"]) expect(hrefs).toContain(href);
	const support = xitterSections(facts({ role: "support" }));
	const supportHrefs = support.find((s) => s.id === "staff")?.rows.map((r) => r.href) ?? [];
	expect(supportHrefs).toContain("/admin");
	expect(supportHrefs).not.toContain("/federation/superadmin");
	// a staff member the instance gate holds back sees the note, not the tools
	const gated = xitterSections(facts({ role: "support", staffGate: "Staff tools are off for now." }));
	const gate = gated.find((s) => s.id === "staff");
	expect(gate?.rows).toEqual([]);
	expect(gate?.notes).toEqual(["Staff tools are off for now."]);
	const gatedHtml = shell("/account/xitter", gated);
	expect(gatedHtml).toContain("Staff tools are off for now.");
	expect(gatedHtml).not.toContain('href="/admin"');
});

test("a member payload has the Xitter row and the framed roots, and no staff key", () => {
	const data = tidyData([]);
	expect(data.xitter.href).toBe("/settings/xitter");
	expect(data.xitter.text).toBe("Xitter");
	expect(data.framed).toEqual(FRAMED_ROOTS);
	expect("staff" in data).toBe(false);
	expect(JSON.stringify(data)).not.toContain("/admin");
	const staff = tidyData([], { nav: { href: "/admin", text: "Admin" }, tools: [] });
	expect(staff.staff?.nav).toEqual({ href: "/admin", text: "Admin" });
});

test("the client frames our pages over the columns it leaves empty", () => {
	// settings pages go over the details column; on a phone, over the main column
	expect(TIDY_SCRIPT).toContain("Section details");
	expect(TIDY_SCRIPT).toContain('frame.id="xitter-frame"');
	expect(TIDY_SCRIPT).toContain('kind="admin"');
	expect(TIDY_SCRIPT).toContain('"/admin"&&T.staff');
	expect(TIDY_SCRIPT).toContain('d.type==="back"');
	expect(TIDY_SCRIPT).toContain('sessionStorage.getItem("xitter-admin-from")');
	expect(FRESH_SCRIPT).toContain('sessionStorage.setItem("xitter-admin-from"');
	expect(TIDY_SCRIPT).toContain('var weight=active?"700":"400"');
	expect(TIDY_SCRIPT).toContain('a[href="/explore"]');
	const css = hideCss();
	expect(css).toContain("#xitter-frame{position:fixed");
	expect(css).toContain('html[data-xitter-host="settings"]');
	expect(css).toContain('html[data-xitter-host="settings-phone"]');
	expect(css).toContain('html[data-xitter-host="admin"]');
	expect(TIDY_SCRIPT).toContain('html.setAttribute("data-xitter-host",mode)');
	// decor rings are [data-xitter-frame] and their CSS (absolute, -11% offsets,
	// 122% size) would match the page's <html> if the host mode used that name
	expect(TIDY_SCRIPT).not.toContain('"data-xitter-frame"');
	expect(css).not.toContain("[data-xitter-frame");
});
