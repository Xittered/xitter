// The rest of the admin list: the error log, more stats, staff security (two-factor,
// address allowlist, staff sessions), backups, the client page, members' invites
// and organisations managing their own affiliates. Settings are put back afterwards.
// usage: bun scripts/test-admin-more.ts <admin> <org> <password>
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { recordError } from "../src/errors";
import { ipAllowed, parseRange } from "../src/staff-access";

const [adminName = "pozo", orgName = "goldcorp", password = "testpass123"] = process.argv.slice(2);
const origin = "http://localhost:3000";
let checks = 0;
const check = (ok: unknown, label: string) => {
	if (!ok) throw new Error(label);
	checks++;
};
async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))!.slice(4), "content-type": "application/json" };
	return {
		headers,
		admin: async (action: string, body: any = {}) => {
			const r = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
			return { status: r.status, data: (await r.json()) as any };
		},
		gql: async (op: string, vars: any) => (await (await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers, body: JSON.stringify({ variables: vars }) })).json()) as any,
		page: async (path: string, form?: Record<string, string>) => {
			const r = await fetch(origin + path, form ? { method: "POST", headers: { cookie: headers.cookie }, body: new URLSearchParams({ csrf: headers["x-csrf-token"], ...form }) } : { headers: { cookie: headers.cookie } });
			return { status: r.status, text: await r.text() };
		},
	};
}

const created: string[] = [];
const names: string[] = [];
const admin = await session(adminName);
const { settings: before } = (await admin.admin("settings")).data;
const [adminRow] = await sql`select id::text, totp_enabled from users where screen_name = ${adminName}`;
const [orgRow] = await sql`select id::text from users where screen_name = ${orgName}`;
let backup: string | undefined;

try {
	for (let i = 0; i < 3; i++) {
		const name = `am${Date.now().toString().slice(-9)}${i}`;
		names.push(name);
		created.push(await createUser(name, name, password));
	}
	await sql`update users set role = 'support' where id = ${created[2]}::bigint`;
	const [one, two, support] = [await session(names[0]), await session(names[1]), await session(names[2])];

	// error log
	check((await fetch(`${origin}/i/api/xitter/client_error`, { method: "POST", headers: one.headers, body: JSON.stringify({ message: `TestError ${names[0]}`, stack: "TestError\n    at t (main.js:1:1)", page: `${origin}/home` }) })).status === 204, "browser error accepted");
	await fetch(`${origin}/i/api/xitter/client_error`, { method: "POST", headers: one.headers, body: JSON.stringify({ message: `TestError ${names[0]}`, stack: "TestError\n    at t (main.js:1:1)", page: `${origin}/home` }) });
	await recordError("job", new Error(`job failed for ${names[0]}`), { path: "test job" });
	// stack traces show internals: admins only by default (staff-permissions.ts)
	check((await support.admin("errors")).status === 403, "support can't read errors");
	const open = (await admin.admin("errors")).data.errors;
	const mine = open.find((e: any) => e.message === `TestError ${names[0]}`);
	check(mine?.count === 2 && mine.path === "/home" && mine.screen_name === names[0], "repeats count on one row, with page and account");
	check(open.some((e: any) => e.source === "job" && e.path === "test job"), "background job errors kept");
	check((await support.admin("resolveErrors", { all: true })).status === 403, "support can't resolve");
	check((await admin.admin("resolveErrors", { fingerprint: mine.fingerprint })).status === 200, "resolve one");
	check((await admin.admin("errors", { resolved: true })).data.errors.some((e: any) => e.fingerprint === mine.fingerprint), "resolved list");
	await fetch(`${origin}/i/api/xitter/client_error`, { method: "POST", headers: one.headers, body: JSON.stringify({ message: `TestError ${names[0]}`, stack: "TestError\n    at t (main.js:1:1)", page: `${origin}/home` }) });
	check((await admin.admin("errors")).data.errors.some((e: any) => e.fingerprint === mine.fingerprint && e.count === 3), "happening again reopens it");
	check((await admin.admin("stats")).data.open_errors >= 2, "overview counts open errors");

	// stats
	const stats = (await support.admin("stats")).data;
	check(typeof stats.active_day === "number" && Array.isArray(stats.risers) && Array.isArray(stats.storage) && stats.days[0].likes !== undefined, "more stats");

	// staff security
	check(parseRange("10.0.0.0/8") && parseRange("2001:db8::/32") && !parseRange("10.0.0.0/33") && !parseRange("example.org"), "ranges parsed");
	check(ipAllowed("10.1.2.3", ["10.0.0.0/8"]) && !ipAllowed("11.0.0.1", ["10.0.0.0/8"]) && ipAllowed(null, []), "addresses matched");
	check((await support.admin("security")).status === 403, "security is admin only");
	const sec = (await admin.admin("security")).data;
	check(sec.sessions.some((s: any) => s.current && s.screen_name === adminName) && sec.sessions.some((s: any) => s.screen_name === names[2]), "staff sessions listed");
	check((await admin.admin("saveSecurity", { staff_2fa: false, admin_ips: ["203.0.113.0/24"] })).status === 400, "a list without your address is refused");
	check((await admin.admin("saveSecurity", { staff_2fa: false, admin_ips: ["nonsense"] })).status === 400, "bad entries refused");
	check((await admin.admin("saveSecurity", { staff_2fa: false, admin_ips: [sec.your_ip] })).status === 200, "own address saved");
	check((await support.admin("stats")).status === 200, "allowed address gets in");
	await sql`update users set totp_enabled = false where id = ${adminRow.id}::bigint`;
	check((await admin.admin("saveSecurity", { staff_2fa: true, admin_ips: [] })).status === 400, "two-factor rule needs your own two-factor");
	await sql`update users set totp_enabled = true where id = ${adminRow.id}::bigint`;
	check((await admin.admin("saveSecurity", { staff_2fa: true, admin_ips: [] })).status === 200, "two-factor rule on");
	const shut = await support.admin("stats");
	check(shut.status === 403 && /two-factor/.test(shut.data.error), "staff without two-factor shut out");
	check((await support.page("/admin")).status === 403, "and the panel page too");
	check((await admin.admin("stats")).status === 200, "staff with two-factor carry on");
	const ended = (await admin.admin("security")).data.sessions.find((s: any) => s.screen_name === names[2]);
	check((await admin.admin("revokeSession", { sessionId: ended.id })).status === 200, "a staff session ended");
	check((await admin.admin("saveSecurity", { staff_2fa: false, admin_ips: [] })).status === 200, "security reset");

	// backups
	check((await support.admin("backups")).status === 403, "backups are admin only");
	const made = await admin.admin("createBackup");
	check(made.status === 200 && /^xitter-\d{8}-\d{6}\.dump$/.test(made.data.name) && made.data.bytes > 0, `backup made (${made.data.error ?? ""})`);
	backup = made.data.name;
	check((await admin.admin("backups")).data.backups.some((b: any) => b.name === backup), "backup listed");
	const download = await fetch(`${origin}/admin/backups/${backup}`, { headers: { cookie: admin.headers.cookie } });
	check(download.status === 200 && new Uint8Array(await download.arrayBuffer()).slice(0, 5).every((b, i) => b === "PGDMP".charCodeAt(i)), "backup downloads as a pg_dump archive");
	// everyone else gets the client's page, as for any address it doesn't know
	check(!(await (await fetch(`${origin}/admin/backups/${backup}`, { headers: { cookie: support.headers.cookie } })).text()).startsWith("PGDMP"), "support can't download");
	check((await fetch(`${origin}/admin/backups/..%2F..%2F.env`, { headers: { cookie: admin.headers.cookie } })).status === 404, "only backup names");
	check((await admin.admin("saveBackupSchedule", { daily: true, keep: 0 })).status === 400, "keep at least one");
	check((await admin.admin("saveBackupSchedule", { daily: false, keep: 7, every_hours: 3 })).status === 400, "only the listed intervals");
	check((await admin.admin("saveBackupSchedule", { daily: false, keep: 36, every_hours: 2 })).status === 200, "every two hours saves");
	const schedule = (await admin.admin("backups")).data.schedule;
	check(schedule.every_hours === 2 && schedule.keep === 36, "schedule kept");
	await admin.admin("saveBackupSchedule", { daily: false, keep: 7, every_hours: 24 });
	check((await admin.admin("deleteBackup", { name: backup })).status === 200, "backup deleted");
	backup = undefined;

	// client page (updating needs x.com, so only the status here)
	const client = (await admin.admin("client")).data;
	check(typeof client.sha === "string" && "previous" in client, "client status");
	check((await support.admin("client")).status === 403, "client is admin only");

	// members' invites
	check(!(await one.page("/home")).text.includes("/account/invites"), "no Invites link while off");
	check((await one.page("/account/invites", {})).text.includes("can't make invites"), "off: none made");
	check((await admin.admin("saveInviteQuota", { enabled: true, per_month: 0, uses: 1, min_age_days: 0 })).status === 400, "quota checked");
	check((await admin.admin("saveInviteQuota", { enabled: true, per_month: 1, uses: 2, min_age_days: 0 })).status === 200, "quota on");
	check((await one.page("/home")).text.includes("/account/invites"), "Invites in the More menu");
	const made1 = await one.page("/account/invites", {});
	const code = /Your invite is <b>(\d{4}-\d{4})<\/b>/.exec(made1.text)?.[1];
	check(code, "member made an invite");
	const [inv] = await sql`select created_by::text, max_uses, expires_at from invites where code = ${code}`;
	check(inv.created_by === created[0] && inv.max_uses === 2 && inv.expires_at, "invite belongs to the member, two uses, expires");
	check((await one.page("/account/invites", {})).text.includes("1 of 1"), "quota spent");
	check((await admin.admin("saveInviteQuota", { enabled: true, per_month: 5, uses: 1, min_age_days: 30 })).status === 200, "age rule");
	check((await two.page("/account/invites", {})).text.includes("30 days old"), "new accounts wait");

	// organisations
	const org = await session(orgName);
	check((await one.page("/account/organisation", { do: "add", handle: names[1] })).text.includes("Only an organisation"), "members can't add affiliates");
	check((await org.page("/account/organisation", { do: "add", handle: names[0] })).text.includes(`Asked @${names[0]}`), "organisation asks");
	const notes = JSON.stringify(await one.gql("NotificationsTimeline", { timeline_type: "All", count: 20 }));
	check(notes.includes(`@${orgName} asked to add you as an affiliate`) && notes.includes("/account/organisation"), "the request is a notification");
	check((await one.page("/home")).text.includes("/account/organisation"), "Organisation in the More menu");
	check((await one.page("/account/organisation", { do: "accept", org: orgRow.id })).text.includes(`affiliate of @${orgName}`), "accepted");
	check((await sql`select 1 from affiliations where org_id = ${orgRow.id}::bigint and user_id = ${created[0]}::bigint`).length === 1, "affiliation made");
	check((await one.page("/account/organisation", { do: "add", handle: names[1] })).text.includes("Only an organisation"), "affiliates aren't managers");
	check((await org.page("/account/organisation", { do: "manager", user: created[0], on: "1" })).text.includes("can now manage"), "made a manager");
	check((await one.page("/account/organisation", { do: "add", handle: names[1] })).text.includes(`Asked @${names[1]}`), "managers ask too");
	check((await two.page("/account/organisation", { do: "decline", org: orgRow.id })).text.includes("declined"), "declined");
	check(!(await sql`select 1 from affiliations where user_id = ${created[1]}::bigint`).length, "declining leaves no affiliation");
	check((await one.page("/account/organisation", { do: "manager", user: created[0], on: "" })).text.includes("Only the organisation"), "managers don't pick managers");
	check((await org.page("/account/organisation", { do: "add", handle: orgName })).text.includes("its own affiliate"), "not itself");
	check((await org.page("/account/organisation", { do: "remove", user: created[0] })).text.includes("Removed"), "organisation removes");
	check(!(await sql`select 1 from affiliations where user_id = ${created[0]}::bigint`).length, "affiliation gone");

	console.log(`all ${checks} admin checks passed`);
} finally {
	await admin.admin("saveInviteQuota", before.invite_quota);
	await admin.admin("saveSecurity", { staff_2fa: false, admin_ips: [] });
	await sql`update users set totp_enabled = ${adminRow.totp_enabled} where id = ${adminRow.id}::bigint`;
	if (backup) await admin.admin("deleteBackup", { name: backup });
	await sql`delete from error_log where message like ${`%${names[0]}%`}`;
	await sql`delete from invites where created_by = any(${sql.array(created, "INT8")})`;
	for (const id of created) await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
