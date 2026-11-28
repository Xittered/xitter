import assert from "node:assert/strict";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { createToken, publicApi } from "../src/public-api";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const fan = newId();
const ids = { active: newId(), suspended: newId(), limited: newId(), deactivated: newId() };
const all = [fan, ...Object.values(ids)];
const add = (id: string, name: string) => sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${name}, ${name}, 'unusable')`;
await add(fan, `fb_fan_${fan}`);
for (const [kind, id] of Object.entries(ids)) await add(id, `fb_${kind}_${id}`);
await sql`update users set status = 'suspended' where id = ${ids.suspended}::bigint`;
await sql`update users set status = 'limited' where id = ${ids.limited}::bigint`;
await sql`update users set deactivated_at = now() where id = ${ids.deactivated}::bigint`;
try {
	const token = await createToken(fan, "follow banned regression", "write");
	const follow = async (id: string) => {
		const [{ screen_name }] = await sql`select screen_name from users where id = ${id}::bigint`;
		const url = new URL(`https://example.test/api/v1/users/${screen_name}/follow`);
		return publicApi(new Request(url, { method: "POST", headers: { authorization: `Bearer ${token}` } }), url);
	};
	const follows = async (id: string) => (await sql`select 1 from follows where follower_id = ${fan}::bigint and followee_id = ${id}::bigint`).length > 0;
	assert.equal((await follow(ids.active)).status, 200);
	assert(await follows(ids.active));
	for (const kind of ["suspended", "limited", "deactivated"] as const) {
		const res = await follow(ids[kind]);
		assert.notEqual(res.status, 200, `${kind} follow answered 200`);
		assert(!(await follows(ids[kind])), `${kind} account got followed`);
	}
	console.log("Follow regression passed: active followed, suspended/limited/deactivated refused.");
} finally {
	await sql`delete from users where id = any(${sql.array(all, "INT8")})`;
	await sql.close();
}
