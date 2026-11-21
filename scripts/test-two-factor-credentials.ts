// Deterministic credential-change races against a disposable local Postgres DB.
// DATABASE_URL=postgres://localhost/xitter_test RATE_LIMITS=off bun scripts/test-two-factor-credentials.ts
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createUser, sessionKey, startSession, viewerById, type Viewer } from "../src/auth";
import { accountSettingsRoute } from "../src/account-settings";
import { resetRoute } from "../src/password-reset";
import { answerChallenge, startChallenge } from "../src/two-factor";
import { codeAt, newSecret } from "../src/totp";
import { sql } from "../src/db";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const nativeVerify = Bun.password.verify;
const nextPassword = "replacement123";
async function fixture() {
	const name = `c${randomBytes(6).toString("hex")}`;
	const id = await createUser(name, "Credential race test", "original123");
	const session = await startSession(id);
	const viewer = { ...(await viewerById(id)), ...session, token: sessionKey(session.token) } as Viewer;
	const secret = newSecret();
	await sql`update users set totp_enabled = true, totp_secret = ${secret} where id = ${id}::bigint`;
	return { id, name, viewer, code: () => codeAt(secret, Math.floor(Date.now() / 30_000)) };
}
async function change(f: Awaited<ReturnType<typeof fixture>>, action: string, resetToken?: string) {
	if (action === "reset") {
		const token = resetToken ?? randomBytes(32).toString("hex");
		const hash = createHash("sha256").update(token).digest("hex");
		if (!resetToken) await sql`insert into password_resets (token_hash, user_id) values (${hash}, ${f.id}::bigint)`;
		const req = new Request("http://localhost/account/reset", { method: "POST", body: new URLSearchParams({ token, password: nextPassword, confirm: nextPassword }) });
		assert.equal((await resetRoute(req, new URL(req.url))).status, 200);
	} else {
		const path = "/1.1/account/change_password.json";
		const req = new Request(`http://localhost${path}`, { method: "POST", body: new URLSearchParams({ current_password: "original123", new_password: nextPassword }) });
		assert.equal((await accountSettingsRoute("POST", path, f.viewer, req))?.status, 200);
	}
}
async function waitFor(check: () => Promise<boolean>, message: string) {
	const deadline = Date.now() + 10_000;
	while (!(await check())) {
		assert(Date.now() < deadline, message);
		await Bun.sleep(10);
	}
}
try {
	for (const action of ["reset", "change"]) {
		const f = await fixture();
		const resume = Promise.withResolvers<void>();
		let inFlight: ReturnType<typeof startChallenge> | undefined;
		try {
			const pending = await startChallenge(f.name, "original123");
			assert(pending);
			const verified = Promise.withResolvers<void>();
			let paused = false;
			Bun.password.verify = async (password, hash, algorithm) => {
				const ok = await nativeVerify(password, hash, algorithm);
				if (!paused && password === "original123" && ok) {
					paused = true;
					verified.resolve();
					await resume.promise;
				}
				return ok;
			};
			inFlight = startChallenge(f.name, "original123");
			await waitFor(async () => paused, "Challenge never reached password verification");
			await verified.promise;
			const emailHash = createHash("sha256").update(randomBytes(32)).digest("hex");
			await sql`insert into email_confirmations (token_hash, user_id, email) values (${emailHash}, ${f.id}::bigint, ${`pending-${f.id}@example.test`})`;
			const badPath = "/1.1/account/change_password.json";
			const badRequest = new Request(`http://localhost${badPath}`, { method: "POST", body: new URLSearchParams({ current_password: "incorrect", new_password: nextPassword }) });
			assert.equal((await accountSettingsRoute("POST", badPath, f.viewer, badRequest))?.status, 403);
			assert.equal((await sql`select 1 from email_confirmations where token_hash = ${emailHash} and not used`).length, 1);
			await change(f, action);
			assert.equal((await sql`select 1 from email_confirmations where user_id = ${f.id}::bigint and not used`).length, 0);
			resume.resolve();
			assert.equal(await inFlight, undefined, `in-flight challenge survives ${action}`);
			assert(!(await answerChallenge(pending, f.code())).userId, `pending challenge survives ${action}`);
			assert.equal((await sql`select 1 from login_challenges where user_id = ${f.id}::bigint`).length, 0);
			const fresh = await startChallenge(f.name, nextPassword);
			assert(fresh);
			const accepted = await answerChallenge(fresh, f.code());
			assert.equal(accepted.userId, f.id);
			assert(accepted.session, "challenge completion must issue its session atomically");
			assert.equal((await sql`select 1 from sessions where token = ${sessionKey(accepted.session.token)}`).length, 1);
			console.log(`ok: ${action} revokes pending challenges, denies in-flight old passwords, and accepts fresh credentials`);
		} finally {
			resume.resolve();
			await inFlight?.catch(() => undefined);
			Bun.password.verify = nativeVerify;
			await sql`delete from users where id = ${f.id}::bigint`;
		}
	}
	// Pause a successful challenge precisely inside session insertion. A reset
	// must wait for its account lock, then revoke that newly inserted session.
	const f = await fixture();
	const lock = Number.parseInt(randomBytes(3).toString("hex"), 16) + 1;
	const suffix = randomBytes(6).toString("hex");
	const fn = `test_challenge_session_${suffix}`;
	const trigger = `test_challenge_session_${suffix}`;
	const held = await sql.reserve();
	let answering: ReturnType<typeof answerChallenge> | undefined;
	let resetting: Promise<void> | undefined;
	try {
		await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin if NEW.user_id = ${f.id} then perform pg_advisory_xact_lock(${lock}); end if; return NEW; end $$`);
		await sql.unsafe(`create trigger ${trigger} before insert on sessions for each row execute function ${fn}()`);
		await held`select pg_advisory_lock(${lock})`;
		const resetToken = randomBytes(32).toString("hex");
		const resetHash = createHash("sha256").update(resetToken).digest("hex");
		await sql`insert into password_resets (token_hash, user_id) values (${resetHash}, ${f.id}::bigint)`;
		const challenge = await startChallenge(f.name, "original123");
		assert(challenge);
		answering = answerChallenge(challenge, f.code());
		await waitFor(async () => (await sql`select 1 from pg_locks where locktype = 'advisory' and objid = ${lock}::oid and not granted`).length > 0, "Session creation never reached the advisory barrier");
		resetting = change(f, "reset", resetToken);
		await waitFor(async () => (await sql`select 1 from pg_stat_activity where datname = current_database() and wait_event = 'transactionid' and query like '%select id from users where id = %for update%'`).length > 0, "Reset did not wait for the challenge's account lock");
		await held`select pg_advisory_unlock(${lock})`;
		assert((await answering).session);
		await resetting;
		assert.equal((await sql`select 1 from sessions where user_id = ${f.id}::bigint`).length, 0, "reset missed the challenge's session");
		console.log("ok: session insertion and challenge consumption are atomic with reset revocation");
	} finally {
		await held`select pg_advisory_unlock(${lock})`;
		held.release();
		await answering?.catch(() => undefined);
		await resetting?.catch(() => undefined);
		await sql.unsafe(`drop trigger if exists ${trigger} on sessions`);
		await sql.unsafe(`drop function if exists ${fn}()`);
		await sql`delete from users where id = ${f.id}::bigint`;
	}
} finally {
	Bun.password.verify = nativeVerify;
	await sql.close();
}
