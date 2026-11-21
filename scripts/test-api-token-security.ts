// Actual application HTTP + PostgreSQL credential/token revocation races.
// Uses disposable local fixtures and a scoped lock barrier; no external services.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const dir = await mkdtemp(join(tmpdir(), "xitter-token-security-"));
process.env.MEDIA_DIR = dir;
const { sql, migrate } = await import("../src/db");
const { createUser, startSession, sessionCookies, sessionKey } = await import("../src/auth");
await migrate();
const fixtureIds: string[] = [];
async function fixture(admin = false) {
	const name = `tk${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
	const id = await createUser(name, "Token security fixture", "original123"); fixtureIds.push(id);
	if (admin) await sql`update users set role='admin',totp_enabled=true where id=${id}::bigint`;
	const session = await startSession(id);
	return { id, name, session, cookie: sessionCookies(session).map((c) => c.split(";")[0]).join("; ") };
}
const probe = Bun.serve({ port: 0, fetch: () => new Response() }); const port = probe.port; probe.stop(true);
const origin = `http://localhost:${port}`;
const server = Bun.spawn([process.execPath, "src/server.ts"], { cwd: join(import.meta.dir, ".."),
	env: { ...process.env, DATABASE_URL: database.href, PORT: String(port), PUBLIC_ORIGIN: origin, MEDIA_DIR: dir, RATE_LIMITS: "off" }, stdout: "ignore", stderr: "pipe" });
const diagnostics = new Response(server.stderr).text();
const form = (cookie: string, data: Record<string, string>) => fetch(`${origin}/account/api`, { method: "POST", headers: { cookie, origin }, body: new URLSearchParams(data) });
const bearer = (token: string, path = "/me", init: RequestInit = {}) => fetch(`${origin}/api/v1${path}`, { ...init,
	headers: { ...Object.fromEntries(new Headers(init.headers)), authorization: `Bearer ${token}` } });
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
async function token(cookie: string, scope = "write") {
	const res = await form(cookie, { do: "create", name: "Security regression", scope }); assert.equal(res.status, 200);
	const value = /xit_[0-9a-f]{48}/.exec(await res.text())?.[0]; assert(value); return value;
}
async function waitFor(check: () => Promise<boolean>, description: string) {
	const deadline = Date.now() + 10_000;
	while (!(await check())) { assert(Date.now() < deadline, description); await Bun.sleep(10); }
}
async function resetToken(id: string) {
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
	await sql`insert into password_resets(token_hash,user_id) values(${digest(token)},${id}::bigint)`; return token;
}
const reset = (token: string) => fetch(`${origin}/account/reset`, { method: "POST", body: new URLSearchParams({ token, password: "replacement123", confirm: "replacement123" }) });
try {
	const deadline = Date.now() + 15_000;
	while (true) { try { if ((await fetch(`${origin}/api/v1/me`)).status === 401) break; } catch {} assert(Date.now() < deadline, "Server failed to start"); await Bun.sleep(20); }
	const cap = await fixture();
	const capResponses = await Promise.all(Array.from({ length: 20 }, () => form(cap.cookie, { do: "create", name: "Parallel token", scope: "write" })));
	assert.equal(capResponses.filter((r) => r.status === 200).length, 10);
	assert.equal(capResponses.filter((r) => r.status === 400).length, 10);
	assert.equal(Number((await sql`select count(*) as n from api_tokens where user_id=${cap.id}::bigint`)[0].n), 10);
	const owner = await fixture(), stranger = await fixture(), admin = await fixture(true);
	const write = await token(owner.cookie), read = await token(owner.cookie, "read"), foreign = await token(stranger.cookie);
	assert.equal((await bearer(read)).status, 200);
	assert.equal((await bearer(read, "/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "denied" }) })).status, 403);
	const [otherRow] = await sql`select id::text from api_tokens where user_id=${stranger.id}::bigint`;
	await form(owner.cookie, { do: "delete", id: otherRow.id }); assert.equal((await bearer(foreign)).status, 200);
	const [ownRow] = await sql`select id::text from api_tokens where token_hash=${digest(write)}`;
	await form(owner.cookie, { do: "delete", id: ownRow.id }); assert.equal((await bearer(write)).status, 401);
	assert.equal((await fetch(`${origin}/account/api`, { headers: { cookie: owner.cookie } })).headers.get("cache-control"), "no-store");
	console.log("ok: concurrent token cap, read scope, revocation ownership, immediate revocation and private token page");
	for (const action of ["reset", "change", "admin"]) {
		const f = await fixture(), old = await token(f.cookie);
		if (action === "reset") assert.equal((await reset(await resetToken(f.id))).status, 200);
		else if (action === "change") {
			const res = await fetch(`${origin}/i/api/1.1/account/change_password.json`, { method: "POST", headers: { cookie: f.cookie, "x-csrf-token": f.session.csrf },
				body: new URLSearchParams({ current_password: "original123", new_password: "replacement123" }) }); assert.equal(res.status, 200);
		} else {
			const res = await fetch(`${origin}/admin/api/resetPassword`, { method: "POST", headers: { cookie: admin.cookie, "x-csrf-token": admin.session.csrf, "content-type": "application/json" }, body: JSON.stringify({ id: f.id }) }); assert.equal(res.status, 200);
		}
		assert.equal((await bearer(old)).status, 401, `${action} leaves an old token usable`);
		assert.equal((await bearer(old, "/posts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "must stay denied" }) })).status, 401);
		assert.equal(Number((await sql`select count(*) as n from api_tokens where user_id=${f.id}::bigint`)[0].n), 0);
		if (action === "change") assert.equal((await bearer(await token(f.cookie))).status, 200, "retained current session can issue replacement tokens");
	}
	console.log("ok: password change, password recovery and admin reset revoke old read/write API credentials");
	{
		const f = await fixture(), first = await token(f.cookie), second = await token(f.cookie, "read");
		const revoke = (who: { cookie: string; session: { csrf: string } }) => fetch(`${origin}/admin/api/revokeApiTokens`, { method: "POST",
			headers: { cookie: who.cookie, "x-csrf-token": who.session.csrf, "content-type": "application/json" }, body: JSON.stringify({ id: f.id }) });
		assert.equal((await revoke(stranger)).status, 403, "non-staff revoked someone's tokens");
		assert.equal((await bearer(first)).status, 200);
		const res = await revoke(admin); assert.equal(res.status, 200);
		assert.equal((await res.json()).tokens, 2);
		assert.equal((await bearer(first)).status, 401); assert.equal((await bearer(second)).status, 401);
		assert.equal((await fetch(`${origin}/account/api`, { headers: { cookie: f.cookie } })).status, 200, "revoking tokens signed the account out");
		const [entry] = await sql`select detail from audit_log where action = 'revoke_api_tokens' and target = ${f.id} order by id desc limit 1`;
		assert.equal(entry?.detail?.tokens, 2);
	}
	console.log("ok: staff revoke every API token of an account, keep its sessions, and it is audited");
	// Transaction-start time must not extend a session's validity while its
	// token request waits for another account mutation to release the row lock.
	const expiring = await fixture(), locked = Promise.withResolvers<void>(), expire = Promise.withResolvers<void>();
	let staleExpiry: Promise<Response> | undefined;
	const expiryHolder = sql.begin(async (tx) => {
		await tx`select id from users where id=${expiring.id}::bigint for update`;
		locked.resolve(); await expire.promise;
		await tx`update sessions set expires_at=clock_timestamp() where token=${sessionKey(expiring.session.token)}`;
	});
	try {
		await locked.promise;
		staleExpiry = form(expiring.cookie, { do: "create", name: "Expiring session", scope: "write" });
		await waitFor(async () => (await sql`select 1 from pg_stat_activity where datname=current_database() and wait_event='transactionid' and query like '%select id from users where id =%and status%for update%'`).length > 0, "Expiring token request never reached account lock");
		expire.resolve(); await expiryHolder;
		assert.equal((await staleExpiry).status, 401, "transaction-start time cannot keep an expired issuing session valid");
		assert.equal(Number((await sql`select count(*) as n from api_tokens where user_id=${expiring.id}::bigint`)[0].n), 0);
	} finally { expire.resolve(); await expiryHolder; await staleExpiry?.catch(() => undefined); }
	console.log("ok: a session expiring during the account lock wait cannot issue a persistent token");
	// Pause a real password reset while it owns the users lock but before its
	// session deletion, so an old session authenticates an in-flight mint request.
	const f = await fixture(), old = await token(f.cookie), resetValue = await resetToken(f.id);
	const fn = `test_token_recovery_${f.id}`, lock = Number(BigInt(f.id) % 2147483647n) + 1;
	const held = await sql.reserve(); let resetting: Promise<Response> | undefined, minting: Promise<Response> | undefined;
	try {
		await sql.unsafe(`create function ${fn}() returns trigger language plpgsql as $$ begin if NEW.id=${f.id} and NEW.password_hash<>OLD.password_hash then perform pg_advisory_xact_lock(${lock}); end if; return NEW; end $$`);
		await sql.unsafe(`create trigger ${fn} before update on users for each row execute function ${fn}()`);
		await held`select pg_advisory_lock(${lock})`;
		resetting = reset(resetValue);
		await waitFor(async () => (await sql`select 1 from pg_locks where locktype='advisory' and objid=${lock}::oid and not granted`).length > 0, "Reset never reached password barrier");
		minting = form(f.cookie, { do: "create", name: "Stale session", scope: "write" });
		await waitFor(async () => (await sql`select 1 from pg_stat_activity where datname=current_database() and wait_event='transactionid' and query like '%select id from users where id =%and status%for update%'`).length > 0, "Token issuance never reached account lock");
		await held`select pg_advisory_unlock(${lock})`;
		assert.equal((await resetting).status, 200); assert.equal((await minting).status, 401);
		assert.equal(Number((await sql`select count(*) as n from api_tokens where user_id=${f.id}::bigint`)[0].n), 0);
		assert.equal((await bearer(old)).status, 401);
		const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: f.name, password: "replacement123" }), redirect: "manual" });
		const freshCookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		assert.equal((await bearer(await token(freshCookie))).status, 200);
	} finally {
		await held`select pg_advisory_unlock(${lock})`; held.release();
		await resetting?.catch(() => undefined); await minting?.catch(() => undefined);
		await sql.unsafe(`drop trigger if exists ${fn} on users`); await sql.unsafe(`drop function if exists ${fn}()`);
	}
	console.log("ok: in-flight token creation cannot outlive recovery, while a fresh sign-in can issue a working token");
} finally {
	server.kill(); await server.exited; await diagnostics;
	for (const id of fixtureIds) { await sql`delete from audit_log where actor_id=${id}::bigint or target=${id}`; await sql`delete from users where id=${id}::bigint`; }
	await sql.close(); await rm(dir, { recursive: true, force: true });
}
