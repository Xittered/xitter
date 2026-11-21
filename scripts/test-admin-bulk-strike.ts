import assert from "node:assert/strict";
import { createUser } from "../src/auth";
import { sql } from "../src/db";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const password = "bulk-strike-test-only";
const created: string[] = [];
let checks = 0;
function check(ok: unknown, label: string) {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok", label);
}
async function make(role: string | null = null) {
	const name = "bs" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
	const id = await createUser(name, name, password);
	created.push(id);
	if (role) await sql`update users set role = ${role} where id = ${id}::bigint`;
	return { id, name };
}
async function session(name: string) {
	const r = await fetch(origin + "/login", { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))!.slice(4), "content-type": "application/json" };
	return async (action: string, body: object) => {
		const response = await fetch(origin + "/admin/api/" + action, { method: "POST", headers, body: JSON.stringify(body) });
		return { status: response.status, data: await response.json() as any };
	};
}
try {
	const mod = await make("moderator"), peer = await make("moderator"), user = await make(), alt = await make(), old = await make(), support = await make("support");
	const run = await session(mod.name), denied = await session(support.name);
	check((await denied("bulkStrike", { ids: [user.id], body: "test" })).status === 403, "messages permission required");
	check((await run("bulkStrike", { ids: Array(51).fill(user.id), body: "test" })).status === 400, "51 ids rejected before mutation");
	check((await run("bulkStrike", { ids: Array(25).fill(user.id), handles: Array(26).fill(user.name), body: "test" })).status === 400, "combined input bound enforced");
	check((await run("bulkStrike", { ids: [user.id], body: " " })).status === 400, "empty message rejected");
	check((await run("bulkStrike", { handles: [42], body: "test" })).status === 400, "non-text handles rejected");
	const result = await run("bulkStrike", { ids: [user.id, mod.id, peer.id], handles: ["@" + user.name.toUpperCase(), user.name, "missing_bulk_test"], body: "first strike" });
	check(result.status === 200 && result.data.results.length === 3 && result.data.results.filter((r: any) => r.ok).length === 1, "duplicates normalized, self and protected staff skipped");
	check(result.data.missing[0] === "missing_bulk_test", "missing handle reported");
	check(result.data.results.find((r: any) => r.id === user.id).strikes === 1, "normal ladder receives first strike");
	const missing = await run("bulkStrike", { handles: ["missing_bulk_test"], body: "test" });
	check(missing.status === 200 && !missing.data.results.length && missing.data.missing.length === 1, "all-missing operation reported honestly");
	const [{ count }] = await sql`select count(*)::int as count from audit_log where actor_id = ${mod.id}::bigint and action = 'bulk_strike'`;
	check(count === 2, "one bulk audit row per completed operation");
	await sql`insert into login_events (id, user_id, ip, app, created_at) values
		(${BigInt(user.id) + 1n}, ${user.id}::bigint, '192.0.2.44', 'test', now()),
		(${BigInt(user.id) + 2n}, ${alt.id}::bigint, '192.0.2.44', 'test', now()),
		(${BigInt(user.id) + 3n}, ${old.id}::bigint, '192.0.2.44', 'test', now() - interval '91 days')`;
	const alts = await run("bulkStrike", { ids: [user.id], body: "alt strike", include_alts: true, escalate: false });
	check(alts.status === 200 && alts.data.results.some((r: any) => r.id === alt.id) && !alts.data.results.some((r: any) => r.id === old.id), "alts limited to 90 days");
	const extra = await make();
	await sql`insert into login_events (id, user_id, ip, app) values (${BigInt(extra.id) + 1n}, ${extra.id}::bigint, '192.0.2.44', 'test')`;
	check((await run("bulkStrike", { ids: Array(49).fill(user.id), handles: [alt.name], body: "test", include_alts: true })).status === 200, "duplicate inputs do not multiply expansion");
	for (let i = 0; i < 49; i++) {
		const extra = await make();
		await sql`insert into login_events (id, user_id, ip, app) values (${BigInt(extra.id) + 1n}, ${extra.id}::bigint, '192.0.2.44', 'test')`;
	}
	const [{ before }] = await sql`select count(*)::int as before from staff_messages where actor_id = ${mod.id}::bigint`;
	check((await run("bulkStrike", { ids: [user.id], body: "overflow", include_alts: true })).status === 400, "alt expansion cannot exceed 50 accounts");
	const [{ after }] = await sql`select count(*)::int as after from staff_messages where actor_id = ${mod.id}::bigint`;
	check(before === after, "overflow produces no partial strikes");
	const target = await make();
	check((await run("bulkStrike", { ids: [target.id], body: "x", action: "nuke" })).status === 400, "unknown action rejected");
	check((await run("bulkStrike", { ids: [target.id], body: "x", action: "limited", hours: 9999 })).status === 400, "hours bounded");
	const warned = await run("bulkStrike", { ids: [target.id], body: "careful", action: "warning" });
	check(warned.status === 200, "warning accepted");
	const [w] = await sql`select kind from staff_messages where user_id = ${target.id}::bigint order by id desc limit 1`;
	check(w?.kind === "warning", "warning stored as warning");
	check((await run("bulkStrike", { ids: [target.id], body: "cool off", action: "limited", hours: 24 })).status === 200, "temporary limit accepted");
	const [lim] = await sql`select status, status_until is not null as timed, status_restore from users where id = ${target.id}::bigint`;
	check(lim.status === "limited" && lim.timed && lim.status_restore === "active", "temporary limit restores later");
	check((await run("bulkStrike", { ids: [target.id], body: "gone", action: "suspended" })).status === 200, "suspension accepted");
	const [sus] = await sql`select status, status_until from users where id = ${target.id}::bigint`;
	check(sus.status === "suspended" && sus.status_until === null, "suspension until lifted");
	const [{ strikes }] = await sql`select count(*)::int as strikes from staff_messages where user_id = ${target.id}::bigint and kind = 'strike'`;
	check(strikes === 0, "sanctions don't add strikes");
	console.log(`${checks} bulk strike checks passed`);
} finally {
	await sql`delete from audit_log where actor_id = any(${sql.array(created, "BIGINT")})`;
	for (const id of created) await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
