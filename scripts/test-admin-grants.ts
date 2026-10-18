import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin = "http://localhost:3000";
const password = "testpass123";
let checks = 0;
const check = (ok: unknown, label: string) => {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok  ", label);
};
async function admin(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "";
	return async (action: string, body: Record<string, unknown> = {}) =>
		(await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
}
const stamp = Date.now().toString(36);
const created: string[] = [];
const make = async (p: string, role: string | null) => {
	const name = `${p}${stamp}`;
	const id = await createUser(name, name, password);
	created.push(id);
	if (role) await sql`update users set role = ${role} where id = ${id}::bigint`;
	return { id, name };
};
try {
	const a = await make("ga_", "admin");
	const other = await make("gc_", "admin");
	const b = await make("gb_", null);
	const asA = await admin(a.name);
	check((await asA("setRole", { id: b.id, role: "admin" })) === 200, "an admin makes another account an admin");
	check((await asA("userSessions", { id: b.id })) === 200, "and can still see that admin's sessions");
	check((await asA("setTemporaryStatus", { id: b.id, status: "restricted", hours: 1 })) === 200, "and act on them");
	check((await asA("setRole", { id: b.id, role: "moderator" })) === 200, "and demote them");
	check((await asA("setRole", { id: b.id, role: null })) === 200, "and take the role away");
	check((await asA("setRole", { id: other.id, role: null })) === 403, "an admin someone else made stays out of reach");
	await asA("setRole", { id: b.id, role: "admin" });
	const asB = await admin(b.name);
	check((await asB("setRole", { id: a.id, role: null })) === 403, "the new admin can't demote the one who promoted them");
	console.log(`all passed (${checks})`);
} finally {
	for (const id of created) {
		await sql`delete from audit_log where target = ${id} or actor_id = ${id}::bigint`;
		await sql`delete from users where id = ${id}::bigint`;
	}
	await sql.end();
}
