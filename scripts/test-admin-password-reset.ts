// Real admin API + PostgreSQL credential reset regression; uses disposable fixtures only.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { adminApi } from "../src/admin";
import { createUser, login, sessionKey, startSession, viewerById, type Viewer } from "../src/auth";
import { sql } from "../src/db";
const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");
const suffix = randomBytes(5).toString("hex");
const ids: string[] = [];
const originalVerify = Bun.password.verify;
let pending: ReturnType<typeof login> | undefined;
let resume: (() => void) | undefined;
const make = async (prefix: string, role: string | null = null) => {
 const name = `${prefix}${suffix}`;
 const id = await createUser(name, name, "OriginalFixture123"); ids.push(id);
 await sql`update users set role=${role}, totp_enabled=${role === "admin"} where id=${id}::bigint`;
 const session = await startSession(id);
 return { name, id, viewer: { ...(await viewerById(id)), ...session, token: sessionKey(session.token) } as Viewer };
};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
let triggerCreated = false;
const trigger = `admin_reset_fail_${suffix}`;
try {
 const actor = await make("a", "admin"), target = await make("t"), remote = await make("r"), plain = await make("p"), support = await make("s", "support");
 await sql`update users set instance='remote.example' where id=${remote.id}::bigint`;
 const call = (viewer: Viewer, id: string, csrf = viewer.csrf) => adminApi(new Request("http://localhost/admin/api/resetPassword", {
  method:"POST", headers:{"content-type":"application/json","x-csrf-token":csrf}, body:JSON.stringify({id}),
 }), "resetPassword", viewer);
 assert.equal((await call(plain.viewer,target.id)).status,403,"ordinary users cannot reset passwords");
 assert.equal((await call(support.viewer,target.id)).status,403,"support cannot reset passwords without the passwords permission");
 assert.equal((await call(actor.viewer,target.id,"wrong")).status,403,"CSRF is required");
 const remoteHash = (await sql`select password_hash from users where id=${remote.id}::bigint`)[0].password_hash;
 assert.equal((await call(actor.viewer,remote.id)).status,403,"remote credentials belong to their home server");
 assert.equal((await sql`select password_hash from users where id=${remote.id}::bigint`)[0].password_hash,remoteHash);
 const resetToken=randomBytes(32).toString("hex"), emailToken=randomBytes(32).toString("hex"), challenge=crypto.randomUUID();
 await sql`insert into password_resets(token_hash,user_id) values (${digest(resetToken)},${target.id}::bigint)`;
 await sql`insert into email_confirmations(token_hash,user_id,email) values (${digest(emailToken)},${target.id}::bigint,'unused@example.test')`;
 await sql`insert into login_challenges(token,user_id) values (${challenge}::uuid,${target.id}::bigint)`;
 await sql`insert into passkeys(id,user_id,public_key,alg,name) values (${`pk${suffix}`},${target.id}::bigint,'fixture',-7,'fixture')`;
 const oldHash=(await sql`select password_hash from users where id=${target.id}::bigint`)[0].password_hash;
 // Force the last revocation step to fail, proving earlier hash/session/token
 // mutations roll back rather than leaving a partially reset account.
 await sql.unsafe(`create function ${trigger}() returns trigger language plpgsql as $$ begin if old.user_id = ${target.id} then raise exception 'fixture revocation failure'; end if; return new; end $$`);
 await sql.unsafe(`create trigger ${trigger} before update on email_confirmations for each row execute function ${trigger}()`);
 triggerCreated=true;
 await assert.rejects(()=>call(actor.viewer,target.id), /fixture revocation failure/);
 assert.equal((await sql`select password_hash from users where id=${target.id}::bigint`)[0].password_hash,oldHash);
 assert.equal((await sql`select count(*)::int n from sessions where user_id=${target.id}::bigint`)[0].n,1);
 assert.equal((await sql`select used from password_resets where user_id=${target.id}::bigint`)[0].used,false);
 assert.equal((await sql`select count(*)::int n from login_challenges where user_id=${target.id}::bigint`)[0].n,1);
 assert.equal((await sql`select count(*)::int n from passkeys where user_id=${target.id}::bigint`)[0].n,1);
 assert.equal((await sql`select used from email_confirmations where user_id=${target.id}::bigint`)[0].used,false);
 await sql.unsafe(`drop trigger ${trigger} on email_confirmations`);
 await sql.unsafe(`drop function ${trigger}()`); triggerCreated=false;
 const verified=Promise.withResolvers<void>(), released=Promise.withResolvers<void>(); resume=()=>released.resolve();
 Bun.password.verify=async (password,hash,algorithm)=>{
  const ok=await originalVerify(password,hash,algorithm);
  if(password === "OriginalFixture123" && hash === oldHash && ok) {verified.resolve();await released.promise;}
  return ok;
 };
 pending=login(target.name,"OriginalFixture123");
 let timeout: ReturnType<typeof setTimeout> | undefined;
 try {await Promise.race([verified.promise,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error("Sign-in did not reach verification")),10_000);})]);} finally {clearTimeout(timeout);}
 const response=await call(actor.viewer,target.id); assert.equal(response.status,200);
 const {password}=await response.json(); assert.equal(typeof password,"string");
 resume(); assert.equal(await pending,undefined,"in-flight old password sign-in cannot survive admin reset");
 Bun.password.verify=originalVerify;
 assert.equal((await sql`select count(*)::int n from sessions where user_id=${target.id}::bigint`)[0].n,0);
 assert.equal((await sql`select used from password_resets where user_id=${target.id}::bigint`)[0].used,true);
 assert.equal((await sql`select used from email_confirmations where user_id=${target.id}::bigint`)[0].used,true);
 assert.equal((await sql`select count(*)::int n from login_challenges where user_id=${target.id}::bigint`)[0].n,0);
 assert.equal((await sql`select count(*)::int n from passkeys where user_id=${target.id}::bigint`)[0].n,0,"passkeys someone else added go with the reset");
 assert.equal(await login(target.name,"OriginalFixture123"),undefined);
 assert(await login(target.name,password),"only newly issued password works");
 assert.equal((await sql`select count(*)::int n from audit_log where actor_id=${actor.id}::bigint and target=${target.id} and action='reset_password'`)[0].n,1);
 console.log("Admin password reset passed: authorization, CSRF, remote account protection, atomic rollback, complete credential revocation, in-flight login rejection and new password");
} finally {
 resume?.(); await pending?.catch(()=>undefined); Bun.password.verify=originalVerify;
 if(triggerCreated) {await sql.unsafe(`drop trigger if exists ${trigger} on email_confirmations`);await sql.unsafe(`drop function if exists ${trigger}()`);}
 for(const id of ids) {await sql`delete from audit_log where actor_id=${id}::bigint or target=${id}`;await sql`delete from users where id=${id}::bigint`;}
 await sql.close();
}
