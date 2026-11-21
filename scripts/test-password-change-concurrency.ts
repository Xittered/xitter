// Real Postgres checks for password changes racing each other or a reset.
// DATABASE_URL=postgres://localhost/xitter_test bun scripts/test-password-change-concurrency.ts
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { createUser, sessionKey, startSession, viewerById, type Viewer } from "../src/auth";
import { accountSettingsRoute } from "../src/account-settings";
import { resetRoute } from "../src/password-reset";
import { sql } from "../src/db";

const id = await createUser(`c${randomBytes(6).toString("hex")}`, "Password change test", "original123");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const change = async (viewer: Viewer, password: string) => {
	const path = "/1.1/account/change_password.json";
	return (await accountSettingsRoute("POST", path, viewer, new Request(`http://localhost${path}`, {
		method: "POST", body: new URLSearchParams({ current_password: "original123", new_password: password }),
	})))!;
};
const reset = (token: string) => {
	const req = new Request("http://localhost/account/reset", {
		method: "POST", body: new URLSearchParams({ token, password: "resetPassword123", confirm: "resetPassword123" }),
	});
	return resetRoute(req, new URL(req.url));
};
try {
	for (const racingReset of [false, true]) {
		await sql`update users set password_hash = ${await Bun.password.hash("original123")} where id = ${id}::bigint`;
		const session = await startSession(id);
		const viewer = { ...(await viewerById(id)), ...session, token: sessionKey(session.token) } as Viewer;
		const other = await startSession(id);
		const token = randomBytes(32).toString("hex");
		await sql`insert into password_resets (token_hash, user_id) values (${digest(token)}, ${id}::bigint)`;
		const responses = await Promise.all([change(viewer, "firstPassword123"), racingReset ? reset(token) : change(viewer, "secondPassword123")]);
		assert.equal(responses.filter((r) => r.status === 200).length, 1);
		assert(responses.every((r) => [200, 403, 410].includes(r.status)));
		const winner = responses[0].status === 200 ? "firstPassword123" : racingReset ? "resetPassword123" : "secondPassword123";
		const [user] = await sql`select password_hash from users where id = ${id}::bigint`;
		assert(await Bun.password.verify(winner, user.password_hash));
		assert.equal((await reset(token)).status, 410);
		assert.equal((await sql`select 1 from sessions where token = ${sessionKey(other.token)}`).length, 0);
		assert.equal((await sql`select 1 from sessions where token = ${sessionKey(session.token)}`).length, racingReset && responses[1].status === 200 ? 0 : 1);
		console.log(`ok: password change racing ${racingReset ? "a reset" : "another change"} accepts one password and revokes old reset links and other sessions`);
	}
} finally {
	await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
