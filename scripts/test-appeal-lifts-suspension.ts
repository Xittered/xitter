import { strict as assert } from "node:assert";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import type { Viewer } from "../src/auth";
import { createUser } from "../src/auth";
import "../src/admin";
import { toolActions } from "../src/admin-tools";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const created: string[] = [];
const fresh = (p: string) => `${p}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
let checks = 0;
const check = (ok: unknown, label: string) => {
	assert(ok, label);
	checks++;
	console.log("ok", label);
};
try {
	const modName = fresh("am");
	const modId = await createUser(modName, modName, "appeal-lift-test-only");
	created.push(modId);
	await sql`update users set role = 'moderator' where id = ${modId}::bigint`;
	const mod = { id: modId, screen_name: modName, status: "active", role: "moderator", csrf: "x" } as Viewer;

	const appealFor = async (status: string, messageId: string | null = null) => {
		const name = fresh("as");
		const id = await createUser(name, name, "appeal-lift-test-only");
		created.push(id);
		await sql`update users set status = ${status}, status_until = now() + interval '1 day', status_restore = 'active' where id = ${id}::bigint`;
		const appeal = newId();
		await sql`insert into moderation_appeals (id, user_id, message_id, body) values (${appeal}::bigint, ${id}::bigint, ${messageId}::bigint, 'please')`;
		return { id, appeal };
	};
	const standing = async (id: string) => (await sql`select status, status_until from users where id = ${id}::bigint`)[0];

	const s = await appealFor("suspended");
	await toolActions.resolveAppeal!.run(mod, { id: s.appeal, status: "accepted", reply: "ok" });
	const after = await standing(s.id);
	check(after.status === "active" && after.status_until === null, "accepting a suspension appeal lifts the suspension");

	const r = await appealFor("restricted");
	await toolActions.resolveAppeal!.run(mod, { id: r.appeal, status: "accepted", reply: "ok" });
	check((await standing(r.id)).status === "active", "accepting a restriction appeal lifts the restriction");

	const n = await appealFor("suspended");
	await toolActions.resolveAppeal!.run(mod, { id: n.appeal, status: "rejected", reply: "no" });
	check((await standing(n.id)).status === "suspended", "turning an appeal down keeps the suspension");

	const name = fresh("ak");
	const kid = await createUser(name, name, "appeal-lift-test-only");
	created.push(kid);
	await sql`update users set status = 'restricted' where id = ${kid}::bigint`;
	const strike = newId();
	await sql`insert into staff_messages (id, user_id, kind, body) values (${strike}::bigint, ${kid}::bigint, 'strike', 'spam')`;
	const sa = newId();
	await sql`insert into moderation_appeals (id, user_id, message_id, body) values (${sa}::bigint, ${kid}::bigint, ${strike}::bigint, 'please')`;
	await toolActions.resolveAppeal!.run(mod, { id: sa, status: "accepted", reply: "ok" });
	const [msg] = await sql`select revoked_at from staff_messages where id = ${strike}::bigint`;
	check(msg.revoked_at && (await standing(kid)).status === "restricted", "accepting a strike appeal revokes the strike but leaves the standing alone");
	console.log(`${checks} checks passed`);
} finally {
	await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}
