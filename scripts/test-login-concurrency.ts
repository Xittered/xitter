// Hold password verification open while credentials change in real Postgres.
// DATABASE_URL=postgres://localhost/xitter_test bun scripts/test-login-concurrency.ts
import { strict as assert } from "node:assert";
import { createHash, randomBytes } from "node:crypto";
import { createUser, login, sessionKey, startSession, viewerById, type Viewer } from "../src/auth";
import { accountSettingsRoute } from "../src/account-settings";
import { resetRoute } from "../src/password-reset";
import { sql } from "../src/db";

const nativeVerify = Bun.password.verify;
try {
	for (const action of ["reset", "change", "two-factor"]) {
		const name = `l${randomBytes(6).toString("hex")}`;
		const id = await createUser(name, "Login concurrency test", "original123");
		const verified = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		let paused = false;
		let pending: ReturnType<typeof login> | undefined;
		try {
			const session = await startSession(id);
			const viewer = { ...(await viewerById(id)), ...session, token: sessionKey(session.token) } as Viewer;
			Bun.password.verify = async (password, hash, algorithm) => {
				const ok = await nativeVerify(password, hash, algorithm);
				if (!paused && password === "original123" && ok) {
					paused = true;
					verified.resolve();
					await resume.promise;
				}
				return ok;
			};
			pending = login(name, "original123");
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([verified.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Login did not reach password verification")), 10_000); })]);
			} finally { clearTimeout(timeout); }
			if (action === "reset") {
				const token = randomBytes(32).toString("hex");
				const hash = createHash("sha256").update(token).digest("hex");
				await sql`insert into password_resets (token_hash, user_id) values (${hash}, ${id}::bigint)`;
				const req = new Request("http://localhost/account/reset", { method: "POST", body: new URLSearchParams({ token, password: "newPassword123", confirm: "newPassword123" }) });
				assert.equal((await resetRoute(req, new URL(req.url))).status, 200);
			} else if (action === "change") {
				const path = "/1.1/account/change_password.json";
				const req = new Request(`http://localhost${path}`, { method: "POST", body: new URLSearchParams({ current_password: "original123", new_password: "newPassword123" }) });
				assert.equal((await accountSettingsRoute("POST", path, viewer, req))?.status, 200);
			} else await sql`update users set totp_enabled = true where id = ${id}::bigint`;
			resume.resolve();
			assert.equal(await pending, undefined, `an in-flight sign-in cannot survive ${action}`);
			assert.equal((await sql`select 1 from sessions where user_id = ${id}::bigint and token <> ${sessionKey(session.token)}`).length, 0);
			console.log(`ok: an in-flight password sign-in cannot bypass ${action}`);
			if (action !== "two-factor") assert(await login(name, "newPassword123"));
		} finally {
			resume.resolve();
			await pending?.catch(() => undefined);
			Bun.password.verify = nativeVerify;
			await sql`delete from users where id = ${id}::bigint`;
		}
	}
} finally {
	Bun.password.verify = nativeVerify;
	await sql.close();
}
