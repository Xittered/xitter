import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { loadSettings, settings } from "../src/settings";

export async function loosenTrends(origin: string): Promise<() => Promise<void>> {
	await loadSettings();
	const saved = structuredClone(settings().operations);
	const name = `lt${Date.now().toString(36)}`;
	const id = await createUser(name, name, "testpass123");
	await sql`update users set role = 'admin' where id = ${id}::bigint`;
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "";
	const save = (ops: object) =>
		fetch(`${origin}/admin/api/saveOperations`, { method: "POST", headers: { cookie: cookies.join("; "), "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(ops) });
	const res = await save({ ...saved, trend_min_people: 1, trend_min_account_days: 0 });
	if (!res.ok) throw new Error(`couldn't loosen trends: ${await res.text()}`);
	return async () => {
		await save(saved);
		await sql`delete from audit_log where actor_id = ${id}::bigint`;
		await sql`delete from users where id = ${id}::bigint`;
	};
}
