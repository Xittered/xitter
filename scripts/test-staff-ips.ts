import assert from "node:assert/strict";
import { createUser } from "../src/auth";
import { sql } from "../src/db";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const password = "staff-ips-test-only";
const created: string[] = [];
let checks = 0;
function check(ok: unknown, label: string) {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok", label);
}
async function make(role: string | null = null) {
	const name = `ip${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const id = await createUser(name, name, password);
	created.push(id);
	if (role) await sql`update users set role = ${role} where id = ${id}::bigint`;
	return { id, name };
}
async function session(name: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))!.slice(4), "content-type": "application/json" };
	return async (action: string, body: object = {}) => {
		const response = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
		return { status: response.status, data: (await response.json()) as any };
	};
}
try {
	const admin = await make("admin"), mod = await make("moderator"), user = await make();
	await session(mod.name);
	await session(user.name);
	await sql`update sessions set ip = '203.0.113.9' where user_id = any(${sql.array([mod.id, user.id], "INT8")})`;
	const run = await session(admin.name);
	await sql`update sessions set ip = '198.51.100.4' where user_id = ${admin.id}::bigint`;
	const plain = (await run("userSessions", { id: user.id })).data;
	check(plain.sessions[0].ip === "203.0.113.9" && !plain.ips_hidden, "a regular account's IPs show");
	const staff = (await run("userSessions", { id: mod.id })).data;
	check(staff.sessions[0].ip === null && staff.ips_hidden, "another staff member's IPs are hidden");
	const shown = (await run("userSessions", { id: mod.id, reveal: true })).data;
	check(shown.sessions[0].ip === "203.0.113.9" && !shown.ips_hidden, "revealing shows them");
	const [log] = await sql`select actor_id::text from audit_log where action = 'reveal_staff_ips' and target = ${mod.id} order by id desc limit 1`;
	check(log?.actor_id === admin.id, "revealing is in the audit log");
	check((await run("userSessions", { id: admin.id })).data.sessions[0].ip === "198.51.100.4", "your own IPs show");
	const sec = (await run("security")).data;
	const mine = sec.sessions.find((x: any) => x.user_id === admin.id), theirs = sec.sessions.find((x: any) => x.user_id === mod.id);
	check(mine.ip === "198.51.100.4" && theirs.ip === null && sec.ips_hidden, "security lists other staff without IPs");
	check((await run("security", { reveal: true })).data.sessions.find((x: any) => x.user_id === mod.id).ip === "203.0.113.9", "and shows them when revealed");
	console.log(`${checks} checks passed`);
} finally {
	await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}
