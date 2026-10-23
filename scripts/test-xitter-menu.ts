import { expect, test } from "bun:test";
import { clientPayload, publicMenuLinks, staffTools, xitterSections, type MenuFacts } from "../src/xitter-menu";

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

const hrefs = (rows: { href: string }[]) => rows.map((r) => r.href);
const staffHrefs = (role: MenuFacts["role"], over: Partial<MenuFacts> = {}) =>
	staffTools(facts({ role, ...over })).flatMap((t) => (t.kind === "link" ? [t.href] : []));

test("a member sees the pages menuLinks already allowed, and no staff data", () => {
	const member = facts();
	expect(publicMenuLinks(member).map((l) => [l.href, l.where])).toEqual([
		["/account/apps", "settings"],
		["/account/theme", "settings"],
		["/account/decoration", "both"],
		["/account/automation", "tabs"],
		["/account/passkeys", "settings"],
		["/account/migrate", "settings"],
		["/account/api", "settings"],
		["/account/notes/appeals", "settings"],
	]);
	const open = facts({ org: true, gold: true, notices: true, invitesOpen: true, federation: true, archiveImport: true });
	expect(hrefs(publicMenuLinks(open))).toEqual([
		"/account/apps",
		"/account/invites",
		"/account/organisation",
		"/account/decor",
		"/account/theme",
		"/account/decoration",
		"/account/automation",
		"/account/notices",
		"/account/instances",
		"/account/passkeys",
		"/account/import",
		"/account/migrate",
		"/account/api",
		"/account/notes/appeals",
	]);
	const payload = clientPayload(member);
	expect(payload.staff).toBeUndefined();
	expect(JSON.stringify(payload)).not.toContain("/admin");
	expect(JSON.stringify(payload)).not.toContain("/federation/superadmin");
	const sections = xitterSections(member);
	expect(sections.map((s) => s.id)).toEqual(["appearance", "account", "security", "notes"]);
	expect(hrefs(sections.find((s) => s.id === "security")!.rows)).toEqual(["/account/passkeys", "/account/2fa", "/account/apps", "/account/api"]);
	const remote = xitterSections(facts({ instance: "other.example" })).find((s) => s.id === "security")!.rows;
	expect(hrefs(remote)).not.toContain("/account/2fa");
	expect(hrefs(remote)).not.toContain("/account/passkeys");
	expect(hrefs(publicMenuLinks(facts({ instance: "other.example" })))).not.toContain("/account/passkeys");
});

test("staff tools follow what each role can open", () => {
	expect(staffHrefs("support")).toEqual(["/admin", "/admin#reports", "/admin#users"]);
	expect(staffHrefs("moderator")).toEqual(["/admin", "/admin#reports", "/admin#appeals", "/account/notes/appeals", "/admin#users"]);
	expect(staffHrefs("admin")).toEqual(["/admin", "/admin#reports", "/admin#appeals", "/account/notes/appeals", "/admin#users"]);
	expect(staffHrefs("admin", { localSuperadmin: true })).toEqual(["/admin", "/admin#reports", "/admin#appeals", "/account/notes/appeals", "/admin#users", "/federation/superadmin"]);
	expect(staffHrefs("moderator", { localSuperadmin: true })).not.toContain("/federation/superadmin");
	const support = staffTools(facts({ role: "support" })).flatMap((t) => (t.kind === "link" ? [t.description] : []));
	expect(support.some((d) => d.includes("Open this part"))).toBe(false);
	expect(support[1]).toBe("Review posts and accounts that people reported.");

	const gated = staffTools(facts({ role: "admin", localSuperadmin: true, staffGate: "Staff need two-factor authentication." }));
	expect(gated).toEqual([{ kind: "note", text: "Staff need two-factor authentication." }]);
	const payload = clientPayload(facts({ role: "admin", staffGate: "blocked" }));
	expect(payload.staff?.nav).toBeUndefined();
	expect(JSON.stringify(payload.staff)).not.toContain("/admin");
	expect(clientPayload(facts({ role: "support" })).staff?.nav).toEqual({ href: "/admin", text: "Admin" });
});
