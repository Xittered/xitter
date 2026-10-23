import { allows, type Role } from "./staff-permissions";

export type MenuLink = {
	href: string;
	text: string;
	description: string;
	icon: string;
	viewBox?: string;
	where: "menu" | "settings" | "both" | "tabs";
};

export type MenuFacts = {
	role: Role | null;
	localSuperadmin: boolean;
	instance: string | null;
	org: boolean;
	gold: boolean;
	notices: boolean;
	invitesOpen: boolean;
	federation: boolean;
	archiveImport: boolean;
	staffGate: string | null;
	instanceName: string;
};

export type StaffTool =
	| { kind: "link"; href: string; text: string; description: string }
	| { kind: "note"; text: string };

export type XitterRow = { href: string; text: string; description: string; icon: string; viewBox?: string };
export type XitterSection = { id: string; title: string; rows: XitterRow[]; notes?: string[] };

const TICKET = "M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5V10a2 2 0 0 0 0 4v3.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5V14a2 2 0 0 0 0-4V6.5zM5 7v1.8a4 4 0 0 1 0 6.4V17h14v-1.8a4 4 0 0 1 0-6.4V7H5z";
const CODE = "M320-240 80-480l240-240 57 57-184 184 183 183-56 56Zm320 0-57-57 184-184-183-183 56-56 240 240-240 240Z";
const MOVE = "M3 11h13.2l-4.6-4.6L13 5l7 7-7 7-1.4-1.4 4.6-4.6H3v-2z";
const BUILDING = "M4 21V3h11v4h5v14H4zm2-2h3v-3h2v3h2V5H6v14zm9 0h3V9h-3v10zM8 7h3v2H8V7zm0 4h3v2H8v-2z";
const SHIELD = "M12 1.5 3.5 5v6c0 5.2 3.6 10 8.5 11.5 4.9-1.5 8.5-6.3 8.5-11.5V5L12 1.5zm0 2.2 6.5 2.7V11c0 4.2-2.8 8.2-6.5 9.4-3.7-1.2-6.5-5.2-6.5-9.4V6.4L12 3.7zM11 7h2v6h-2V7zm0 8h2v2h-2v-2z";
const ROBOT = "M11 2h2v3h5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5V2zM6 7v11h12V7H6zm3 3a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm-6 5h6v1.5H9V15z";
const UPLOAD = "M440-320v-326L336-542l-56-58 200-200 200 200-56 58-104-104v326h-80ZM240-160q-33 0-56.5-23.5T160-240v-120h80v120h480v-120h80v120q0 33-23.5 56.5T720-160H240Z";
const PALETTE = "M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80Zm0-400Zm-220 40q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120-160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm200 0q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17Zm120 160q26 0 43-17t17-43q0-26-17-43t-43-17q-26 0-43 17t-17 43q0 26 17 43t43 17ZM480-160q9 0 14.5-5t5.5-13q0-14-15-33t-15-57q0-42 29-67t71-25h70q66 0 113-38.5T800-518q0-121-92.5-201.5T488-800q-136 0-232 93t-96 227q0 133 93.5 226.5T480-160Z";
const TONE = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 1.8v14.4a7.2 7.2 0 0 0 0-14.4z";
const CAT = "M5 3.5 9.2 7.6A9 9 0 0 1 12 7.2a9 9 0 0 1 2.8.4L19 3.5V12a7 7 0 0 1-14 0V3.5Zm4.5 8.3a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Zm5 0a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z";
const KEY = "M280-400q-33 0-56.5-23.5T200-480q0-33 23.5-56.5T280-560q33 0 56.5 23.5T360-480q0 33-23.5 56.5T280-400Zm0 160q-100 0-170-70T40-480q0-100 70-170t170-70q67 0 121.5 33t86.5 87h352l120 120-180 180-80-60-80 60-85-60h-47q-32 54-86.5 87T280-240Zm0-80q56 0 98.5-34t56.5-86h125l58 41 82-61 71 55 75-75-40-40H435q-14-52-56.5-86T280-640q-66 0-113 47t-47 113q0 66 47 113t113 47Z";
const GLOBE = "M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm-40-82v-78q-33 0-56.5-23.5T360-320v-40L168-552q-3 18-5.5 36t-2.5 36q0 121 79.5 212T440-162Zm276-102q41-45 62.5-100.5T800-480q0-98-54.5-179T600-776v16q0 33-23.5 56.5T520-680h-80v80q0 17-11.5 28.5T400-560h-80v80h240q17 0 28.5 11.5T600-440v120h40q26 0 47 15.5t29 40.5Z";
const LOCK = "M12 1a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-1V6a5 5 0 0 0-5-5zm-3 8V6a3 3 0 0 1 6 0v3H9z";

type Draft = XitterRow & { where: MenuLink["where"]; see: (f: MenuFacts) => boolean };

const ROWS: Draft[] = [
	{ href: "/account/apps", text: "Connected apps", description: "Review and remove apps authorized to use your account.", icon: CODE, viewBox: "0 -960 960 960", where: "settings", see: () => true },
	{ href: "/account/invites", text: "Invites", description: "", icon: TICKET, where: "both", see: (f) => f.invitesOpen },
	{ href: "/account/organisation", text: "Organisation", description: "Manage affiliates, or answer an organisation that asked to add you.", icon: BUILDING, where: "both", see: (f) => f.org },
	{ href: "/account/decor", text: "Profile decor", description: "Dress your profile with a theme, background and avatar frame from Steam.", icon: PALETTE, viewBox: "0 -960 960 960", where: "settings", see: (f) => f.gold },
	{ href: "/account/theme", text: "Theme", description: "Dim, a preset, or your own colours for the client.", icon: TONE, where: "settings", see: () => true },
	{ href: "/account/decoration", text: "Avatar decoration", description: "Put cat ears or a decoration around your avatar.", icon: CAT, where: "both", see: () => true },
	{ href: "/account/automation", text: "Automation", description: "Name the account that runs this one.", icon: ROBOT, where: "tabs", see: () => true },
	{ href: "/account/notices", text: "Staff notices", description: "", icon: SHIELD, where: "both", see: (f) => f.notices },
	{ href: "/account/instances", text: "Other instances", description: "Hide accounts and organisations from other instances.", icon: GLOBE, viewBox: "0 -960 960 960", where: "settings", see: (f) => f.federation },
	{ href: "/account/passkeys", text: "Passkeys", description: "Sign in with your fingerprint, face or screen lock instead of a password.", icon: KEY, viewBox: "0 -960 960 960", where: "settings", see: (f) => f.instance === null },
	{ href: "/account/2fa", text: "Two-factor", description: "Ask for a code from an authentication app when you log in.", icon: LOCK, where: "settings", see: (f) => f.instance === null },
	{ href: "/account/import", text: "Import from X", description: "Bring your posts, photos and videos over from your X archive.", icon: UPLOAD, viewBox: "0 -960 960 960", where: "settings", see: (f) => f.archiveImport },
	{ href: "/account/migrate", text: "Move account", description: "Bring your account here from another instance, or take it to another one.", icon: MOVE, where: "settings", see: () => true },
	{ href: "/account/api", text: "API", description: "Make tokens that let scripts and bots use your account.", icon: CODE, viewBox: "0 -960 960 960", where: "settings", see: () => true },
	{ href: "/account/notes/appeals", text: "Note appeals", description: "Appeal a Community Note or review appeals as staff.", icon: SHIELD, where: "settings", see: () => true },
];

function fill(row: Draft, facts: MenuFacts): MenuLink {
	let description = row.description;
	if (row.href === "/account/invites") description = `Invite people you know to ${facts.instanceName}.`;
	if (row.href === "/account/notices") description = `Messages, warnings and strikes from the ${facts.instanceName} team, and your appeals.`;
	return { href: row.href, text: row.text, description, icon: row.icon, viewBox: row.viewBox, where: row.where };
}

const LEGACY_ORDER = ["/account/apps", "/account/invites", "/account/organisation", "/account/decor", "/account/theme", "/account/decoration", "/account/automation", "/account/notices", "/account/instances", "/account/passkeys", "/account/import", "/account/migrate", "/account/api", "/account/notes/appeals"];

export function publicMenuLinks(facts: MenuFacts): MenuLink[] {
	const byHref = new Map(ROWS.filter((r) => r.href !== "/account/2fa" && r.see(facts)).map((r) => [r.href, fill(r, facts)]));
	return LEGACY_ORDER.filter((href) => byHref.has(href)).map((href) => byHref.get(href)!);
}

const GROUP_ORDER = [
	{ id: "appearance", title: "Appearance", hrefs: ["/account/theme", "/account/decor", "/account/decoration"] },
	{ id: "account", title: "Account", hrefs: ["/account/organisation", "/account/automation", "/account/import", "/account/invites", "/account/migrate"] },
	{ id: "security", title: "Security and apps", hrefs: ["/account/passkeys", "/account/2fa", "/account/apps", "/account/api"] },
	{ id: "federation", title: "Federation", hrefs: ["/account/instances"] },
	{ id: "notes", title: "Staff and notes", hrefs: ["/account/notices", "/account/notes/appeals"] },
] as const;

export function xitterSections(facts: MenuFacts): XitterSection[] {
	const visible = new Map(ROWS.filter((r) => r.see(facts)).map((r) => [r.href, r]));
	const sections: XitterSection[] = [];
	for (const group of GROUP_ORDER) {
		const rows = group.hrefs.flatMap((href) => {
			const row = visible.get(href);
			if (!row) return [];
			const link = fill(row, facts);
			return [{ href: link.href, text: link.text, description: link.description, icon: link.icon, viewBox: link.viewBox }];
		});
		if (rows.length) sections.push({ id: group.id, title: group.title, rows });
	}
	const tools = staffTools(facts);
	if (tools.length) {
		sections.push({
			id: "staff",
			title: "Staff tools",
			rows: tools.flatMap((t) => (t.kind === "link" ? [{ href: t.href, text: t.text, description: t.description, icon: SHIELD }] : [])),
			notes: tools.flatMap((t) => (t.kind === "note" ? [t.text] : [])),
		});
	}
	return sections;
}

export function staffTools(facts: MenuFacts): StaffTool[] {
	if (!facts.role) return [];
	if (facts.staffGate) return [{ kind: "note", text: facts.staffGate }];
	const role = facts.role;
	const tools: StaffTool[] = [
		{ kind: "link", href: "/admin", text: "Admin panel", description: "Reports, accounts, and instance tools." },
		{ kind: "link", href: "/admin#reports", text: "Reports", description: "Review posts and accounts that people reported." },
	];
	if (allows(role, "appeals")) tools.push({ kind: "link", href: "/admin#appeals", text: "Appeals", description: "Read and answer account appeals." });
	if (allows(role, "note_appeals")) tools.push({ kind: "link", href: "/account/notes/appeals", text: "Review note appeals", description: "Open Community Notes appeals waiting for staff." });
	tools.push({ kind: "link", href: "/admin#users", text: "Users", description: "Find an account, change its role, or review its history." });
	if (role === "admin" && facts.localSuperadmin) tools.push({ kind: "link", href: "/federation/superadmin", text: "Superadmin", description: "Open another instance's admin panel, or defederate everywhere." });
	return tools;
}

export type ClientPayload = {
	links: MenuLink[];
	staff?: { nav?: { href: "/admin"; text: "Admin" }; tools: StaffTool[] };
};

export function clientPayload(facts: MenuFacts): ClientPayload {
	const links = publicMenuLinks(facts);
	if (!facts.role) return { links };
	const tools = staffTools(facts);
	const nav = facts.staffGate ? undefined : { href: "/admin" as const, text: "Admin" as const };
	return nav ? { links, staff: { nav, tools } } : { links, staff: { tools } };
}
