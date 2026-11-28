// Real route + PostgreSQL regression; creates only isolated fixtures, sends no mail.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { emailRoute } from "../src/email-address";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const owner = newId(), other = newId();
const address = (name: string) => `${name}_${owner}@example.test`;
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
async function token(id: string, email: string) {
 const value = randomBytes(32).toString("hex");
 await sql`insert into email_confirmations (token_hash, user_id, email) values (${hash(value)}, ${id}::bigint, ${email})`;
 return value;
}
async function confirm(value: string) {
 const url = new URL(`http://localhost/account/email/confirm?token=${value}`);
 return emailRoute(new Request(url), url, undefined);
}
async function email(id = owner) {
 const [row] = await sql`select email from users where id = ${id}::bigint`;
 return row.email;
}
try {
 for (const id of [owner, other]) await sql`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${`email_${id}`}, 'Email test', 'unusable')`;
 const priorReset = randomBytes(32).toString("hex");
 await sql`insert into password_resets (token_hash, user_id) values (${hash(priorReset)}, ${owner}::bigint)`;
 const stale = await token(owner, address("stale"));
 const fresh = await token(owner, address("fresh"));
 assert.equal((await confirm(fresh)).status, 200);
 assert.equal((await sql`select used from password_resets where token_hash = ${hash(priorReset)}`)[0].used, true, "changing recovery address revokes prior password reset links");
 assert.equal((await confirm(stale)).status, 410, "confirming an address invalidates older outstanding links");
 assert.equal(await email(), address("fresh"), "stale link cannot change recovery address");
 assert.equal((await confirm(fresh)).status, 410, "confirmation link is single-use");
 const competingA = await token(owner, address("competing_a"));
 const competingB = await token(owner, address("competing_b"));
 const competing = await Promise.all([confirm(competingA), confirm(competingB)]);
 assert.deepEqual(competing.map(r => r.status).sort(), [200, 410], "only one outstanding address change can win concurrently");
 assert.equal(await email(), competing[0].status === 200 ? address("competing_a") : address("competing_b"));
 const simultaneous = await token(owner, address("simultaneous"));
 const statuses = await Promise.all(Array.from({ length: 8 }, async () => (await confirm(simultaneous)).status));
 assert.equal(statuses.filter(s => s === 200).length, 1, "one concurrent confirmation succeeds");
 assert(statuses.every(s => s === 200 || s === 410));
 const retryReset = randomBytes(32).toString("hex");
 await sql`insert into password_resets (token_hash, user_id) values (${hash(retryReset)}, ${owner}::bigint)`;
 const duplicate = await token(owner, address("claimed"));
 await sql`update users set email = ${address("claimed")}, email_verified = true where id = ${other}::bigint`;
 assert.equal((await confirm(duplicate)).status, 410, "another account owns the address");
 assert.equal(await email(), address("simultaneous"), "failed confirmation preserves recovery address");
 const [pending] = await sql`select used from email_confirmations where token_hash = ${hash(duplicate)}`;
 assert.equal(pending.used, false, "failed confirmation does not consume link");
 assert.equal((await sql`select used from password_resets where token_hash = ${hash(retryReset)}`)[0].used, false, "failed address change keeps existing password reset usable");
 await sql`update users set email = null where id = ${other}::bigint`;
 assert.equal((await confirm(duplicate)).status, 200, "valid link can retry once address is free");
 const common = address("racing");
 const a = await token(owner, common), b = await token(other, common);
 const race = await Promise.all([confirm(a), confirm(b)]);
 assert.deepEqual(race.map(r => r.status).sort(), [200, 410], "two accounts claiming same address never throw");
 assert.equal((await sql`select count(*)::int as n from users where lower(email) = ${common}`)[0].n, 1);
 const same = await token(owner, await email());
 assert.equal((await confirm(same)).status, 200, "confirming current address remains supported");
 assert.equal((await confirm(same)).status, 410);
 const expired = await token(owner, address("expired"));
 await sql`update email_confirmations set created_at = now() - interval '2 days' where token_hash = ${hash(expired)}`;
 assert.equal((await confirm(expired)).status, 410);
 assert.equal((await confirm("bad")).status, 410);
 console.log("Email confirmation stale-link, single-use, retry, uniqueness-race and expiry checks passed");
} finally {
 await sql`delete from users where id in (${owner}::bigint, ${other}::bigint)`;
 await sql.close();
}
