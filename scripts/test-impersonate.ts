import assert from "node:assert/strict";
import { SESSION_COOKIE, createUser, sessionCookies, startSession } from "../src/auth";
import { sql } from "../src/db";
import { codeAt, newSecret } from "../src/totp";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const boss = process.env.XITTER_TEST_SUPERADMINS?.split("@")[0];
assert(boss, "Start the server and this script with XITTER_TEST_SUPERADMINS=<handle>@<host> and FEDERATION_ALLOW_HTTP=1.");

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const password = "impersonate-test-only";
const created: string[] = [];
let checks = 0;
function check(ok: unknown, label: string) {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok", label);
}
const jar = (cookies: string[]) => Object.fromEntries(cookies.map((c) => c.split(";")[0]!.split("=")).map(([k, ...v]) => [k, v.join("=")]));
const header = (j: Record<string, string>) => Object.entries(j).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join("; ");
async function staffSession(id: string) {
	const s = await startSession(id);
	const j = jar(sessionCookies(s));
	return { j, api: async (action: string, body: object = {}) => {
		const r = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { cookie: header(j), "x-csrf-token": s.csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, data: (await r.json()) as any };
	} };
}
async function make(name: string, role: string | null = null) {
	const id = await createUser(name, name, password);
	created.push(id);
	if (role) await sql`update users set role = ${role} where id = ${id}::bigint`;
	return id;
}
try {
	await sql`delete from users where lower(screen_name) = lower(${boss})`;
	const secret = newSecret();
	const bossId = await make(boss, "admin");
	await sql`update users set totp_enabled = true, totp_secret = ${secret} where id = ${bossId}::bigint`;
	const otherAdmin = await make(`im${crypto.randomUUID().slice(0, 8)}`, "admin");
	const mod = await make(`im${crypto.randomUUID().slice(0, 8)}`, "moderator");
	const target = await make(`im${crypto.randomUUID().slice(0, 8)}`);
	const code = () => codeAt(secret, Math.floor(Date.now() / 30_000));
	const b = await staffSession(bossId), o = await staffSession(otherAdmin);
	check((await o.api("impersonate", { id: target, password, code: code() })).status === 403, "a plain admin can't");
	check((await b.api("impersonate", { id: mod, password, code: code() })).status === 400, "staff can't be impersonated");
	check((await b.api("impersonate", { id: target, password: "wrong", code: code() })).status === 403, "a wrong password is refused");
	await Bun.sleep(31_000);
	const made = await b.api("impersonate", { id: target, password, code: code(), reason: "support ticket 12" });
	check(made.status === 200 && made.data.url?.startsWith("/account/impersonate/"), "a superadmin gets a one-time link");
	check((await fetch(origin + made.data.url, { redirect: "manual" })).status === 403, "the link needs the superadmin's own session");
	const made2 = await b.api("impersonate", { id: target, password, code: code() });
	check(made2.status === 403, "a two-factor code works once");
	await Bun.sleep(31_000);
	const made3 = await b.api("impersonate", { id: target, password, code: code() });
	const enter = await fetch(origin + made3.data.url, { headers: { cookie: header(b.j) }, redirect: "manual" });
	check(enter.status === 303 && enter.headers.get("location") === "/home", "opening it signs the browser in as them");
	const as = { ...b.j, ...jar(enter.headers.getSetCookie()) };
	check((await fetch(origin + made3.data.url, { headers: { cookie: header(b.j) }, redirect: "manual" })).status === 403, "the link works once");
	const home = await (await fetch(`${origin}/home`, { headers: { cookie: header(as) } })).text();
	if (home.startsWith("no pinned client build")) console.log("skip the app shows a banner (no client build here)");
	else check(home.includes("xitter-impersonating") && home.includes(`by @${boss}`), "the app shows a banner");
	check((await fetch(`${origin}/account/2fa`, { headers: { cookie: header(as) }, redirect: "manual" })).status === 403, "two-factor settings are out of reach");
	check((await fetch(`${origin}/account/money`, { headers: { cookie: header(as) }, redirect: "manual" })).status === 403, "money is out of reach");
	check((await fetch(`${origin}/i/api/1.1/account/change_password.json`, { method: "POST", headers: { cookie: header(as), "x-csrf-token": as.ct0! }, redirect: "manual" })).status === 403, "changing the password is refused");
	const [sess] = await sql`select expires_at < now() + interval '61 minutes' as short from sessions where user_id = ${target}::bigint and impersonator_id = ${bossId}::bigint`;
	check(sess?.short, "the session lasts an hour");
	const [log] = await sql`select detail->>'reason' as reason from audit_log where action = 'impersonate' and target = ${target} and detail->>'reason' is not null limit 1`;
	check(log?.reason === "support ticket 12", "audited with the reason");
	const exit = await fetch(`${origin}/account/impersonate/exit`, { headers: { cookie: header(as) }, redirect: "manual" });
	const back = { ...as, ...jar(exit.headers.getSetCookie()) };
	check(exit.headers.get("location") === "/admin" && back[SESSION_COOKIE] === b.j[SESSION_COOKIE], "going back restores the superadmin's session");
	const [{ n }] = await sql`select count(*)::int as n from sessions where impersonator_id = ${bossId}::bigint`;
	check(n === 1, "only the unused link's session is left");
	console.log(`${checks} checks passed`);
} finally {
	await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}
