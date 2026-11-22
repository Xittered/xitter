// Gold organisations can be created or toggled without self-service affiliate
// adding: they keep their gold badge and square avatar, lose the Organisation
// menu and /account/organisation add form (for both the org and its managers),
// pending requests are cleared when turned off, and staff can still manage
// affiliates from the admin panel.
import assert from "node:assert/strict";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { menuLinks } from "../src/tidy";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const origin = process.env.TEST_ORIGIN ?? `http://localhost:${process.env.PORT ?? 3000}`;
const password = "org-affiliates-test-only";
const created: string[] = [];
let checks = 0;
function check(ok: unknown, label: string) {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok", label);
}
async function make(role: string | null = null) {
	const name = `oa${crypto.randomUUID().replaceAll("-", "").slice(0, 11)}`;
	const id = await createUser(name, name, password);
	created.push(id);
	if (role) await sql`update users set role = ${role} where id = ${id}::bigint`;
	return { id, name };
}
async function session(username: string, pass = password) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password: pass }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))!.slice(4);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" };
	return {
		admin: async (action: string, body: object = {}) => {
			const res = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
			return { status: res.status, data: (await res.json()) as any };
		},
		get: async (op: string, variables: object) =>
			(await (await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json()) as any,
		page: async (path: string, form?: Record<string, string>) => {
			const res = await fetch(origin + path, form ? { method: "POST", headers: { cookie: headers.cookie }, body: new URLSearchParams(form) } : { headers: { cookie: headers.cookie } });
			return { status: res.status, text: await res.text() };
		},
	};
}

try {
	const adminUser = await make("admin"), supportUser = await make("support"), alice = await make(), bob = await make();
	const admin = await session(adminUser.name), support = await session(supportUser.name);
	const orgName = `go${crypto.randomUUID().replaceAll("-", "").slice(0, 11)}`;

	// Create a gold organisation with self-service affiliate adding turned off
	const made = await admin.admin("createOrg", { screen_name: orgName, name: "Solo Gold Org", allow_affiliates: false });
	check(made.status === 200 && made.data.id && made.data.password, "createOrg accepts allow_affiliates: false");
	const orgId = made.data.id as string;
	created.push(orgId);

	const detail = (await admin.admin("user", { id: orgId })).data.user;
	check(detail?.verified_type === "business" && detail?.allow_affiliates === false, "admin user shows gold badge with allow_affiliates false");

	const profile = (await admin.get("UserByScreenName", { screen_name: orgName })).data?.user?.result;
	check(profile?.verification?.verified_type === "Business" && profile?.profile_image_shape === "Square" && profile?.is_blue_verified === true, "keeps gold badge and square avatar");

	const org = await session(orgName, made.data.password);
	check(!(await menuLinks(orgId)).some((l) => l.href === "/account/organisation"), "Organisation menu link is hidden when allow_affiliates is false and it has no affiliates");
	check(!(await org.page("/account/api")).text.includes("/account/organisation"), "account navigation omits /account/organisation");

	const orgPage = await org.page("/account/organisation");
	check(orgPage.status === 200 && !orgPage.text.includes('value="add"') && orgPage.text.includes("Adding affiliates is turned off"), "Organisation page hides the add form");

	const addAttempt = await org.page("/account/organisation", { do: "add", handle: alice.name });
	check(addAttempt.text.includes("Adding affiliates is turned off"), "POST do=add is refused");
	check(!(await sql`select 1 from affiliation_requests where org_id = ${orgId}::bigint`).length, "no affiliation request was created");

	// Staff can still add affiliates in /admin; managers of the org still cannot add new ones
	check((await admin.admin("addAffiliate", { orgId, screen_name: alice.name })).status === 200, "staff can still add an affiliate");
	check((await menuLinks(orgId)).some((l) => l.href === "/account/organisation"), "Organisation menu appears once staff adds an affiliate");
	check((await org.page("/account/organisation", { do: "manager", user: alice.id, on: "1" })).text.includes("can now manage"), "org can mark an existing affiliate as manager");
	const aliceSession = await session(alice.name);
	check((await aliceSession.page("/account/organisation", { do: "add", handle: bob.name })).text.includes("Adding affiliates is turned off"), "manager is also blocked from adding affiliates");
	check((await org.page("/account/organisation", { do: "remove", user: alice.id })).text.includes("Removed"), "org can still remove an existing affiliate");

	// Staff permissions and toggling on/off
	check((await support.admin("setAllowAffiliates", { id: orgId, enabled: true })).status === 403, "support cannot change allow_affiliates");
	check((await admin.admin("setAllowAffiliates", { id: orgId, enabled: true })).status === 200, "admin turns allow_affiliates on");
	check((await org.page("/account/organisation", { do: "add", handle: bob.name })).text.includes(`Asked @${bob.name}`), "once enabled, org can request affiliates");
	check((await sql`select 1 from affiliation_requests where org_id = ${orgId}::bigint and user_id = ${bob.id}::bigint`).length === 1, "pending request exists");

	// Turning it back off clears pending requests and audits the change
	check((await admin.admin("setAllowAffiliates", { id: orgId, enabled: false })).status === 200, "admin turns allow_affiliates back off");
	check(!(await sql`select 1 from affiliation_requests where org_id = ${orgId}::bigint`).length, "disabling clears pending affiliation requests");
	const bobSession = await session(bob.name);
	check((await bobSession.page("/account/organisation", { do: "accept", org: orgId })).text.includes("gone"), "cleared request cannot be accepted");
	const [log] = await sql`select detail from audit_log where action = 'set_allow_affiliates' and target = ${orgId} order by id desc limit 1`;
	check(log?.detail?.enabled === false, "change is recorded in the audit log");

	console.log(`${checks} checks passed`);
} finally {
	await sql`delete from audit_log where target = any(${sql.array(created, "TEXT")}) or actor_id = any(${sql.array(created, "INT8")})`;
	await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}
