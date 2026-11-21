// Real Postgres regression checks; use a dedicated migrated test database.
// DATABASE_URL=postgres://localhost/xitter_test bun scripts/test-password-reset-concurrency.ts
import { createHash, randomBytes } from "node:crypto";
import { strict as assert } from "node:assert";
import { createUser, sessionKey } from "../src/auth";
import { sql } from "../src/db";
import { resetRoute } from "../src/password-reset";

const id = await createUser(`r${randomBytes(6).toString("hex")}`, "Reset concurrency test", "original123");
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const token = async () => {
	const value = randomBytes(32).toString("hex");
	await sql`insert into password_resets (token_hash, user_id) values (${digest(value)}, ${id}::bigint)`;
	return value;
};
const reset = (value: string, password: string) => {
	const req = new Request("http://localhost/account/reset", {
		method: "POST", body: new URLSearchParams({ token: value, password, confirm: password }),
	});
	return resetRoute(req, new URL(req.url));
};
try {
	for (const differentLinks of [false, true]) {
		const first = await token();
		const second = differentLinks ? await token() : first;
		const old = await token();
		const session = randomBytes(20).toString("hex");
		await sql`insert into sessions (token, user_id, csrf) values (${sessionKey(session)}, ${id}::bigint, 'test')`;
		const responses = await Promise.all([reset(first, "firstpass123"), reset(second, "secondpass456")]);
		assert.deepEqual(responses.map((r) => r.status).sort(), [200, 410]);
		const [user] = await sql`select password_hash from users where id = ${id}::bigint`;
		assert(await Bun.password.verify(responses[0].status === 200 ? "firstpass123" : "secondpass456", user.password_hash));
		assert.equal((await reset(old, "stalePassword123")).status, 410);
		assert.equal((await sql`select 1 from sessions where user_id = ${id}::bigint`).length, 0);
		assert.equal((await sql`select 1 from password_resets where user_id = ${id}::bigint and not used`).length, 0);
		console.log(`ok: concurrent resets with ${differentLinks ? "different links" : "the same link"} accept one password and revoke old links and sessions`);
	}
	const expired = await token();
	await sql`update password_resets set created_at = now() - interval '2 hours' where token_hash = ${digest(expired)}`;
	assert.equal((await reset(expired, "expiredPass123")).status, 410);
	const unused = await token();
	assert.equal((await reset(unused, "short")).status, 200);
	assert.equal((await sql`select used from password_resets where token_hash = ${digest(unused)}`)[0].used, false);
	assert.equal((await reset(unused, "validPassword123")).status, 200);
	console.log("ok: expired tokens fail and invalid passwords do not consume a valid link");
} finally {
	await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
