import assert from "node:assert/strict";
import { createUser } from "../src/auth";
import { sql } from "../src/db";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const password = "suspended-appeal-test-only";
const created: string[] = [];
let checks = 0;
function check(ok: unknown, label: string) {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok", label);
}
async function signIn(name: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	return csrf ? { cookie: cookies.join("; "), csrf } : undefined;
}
try {
	const name = `sa${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const id = await createUser(name, name, password);
	created.push(id);
	await sql`update users set status = 'suspended' where id = ${id}::bigint`;
	await sql`insert into staff_messages (id, user_id, kind, body) values (${Date.now()}::bigint, ${id}::bigint, 'strike', 'Spamming replies.')`;
	const s = await signIn(name);
	check(s, "a suspended account signs in");
	const get = (path: string) => fetch(origin + path, { headers: { cookie: s!.cookie }, redirect: "manual" });
	const home = await get("/home");
	check(home.status === 302 && home.headers.get("location")?.endsWith("/account/suspended"), "every page sends it to the appeal screen");
	const api = await fetch(`${origin}/i/api/1.1/statuses/update.json`, { method: "POST", headers: { cookie: s!.cookie, "x-csrf-token": s!.csrf }, body: new URLSearchParams({ status: "hi" }) });
	check(api.status === 403, "the api refuses it");
	const page = await (await get("/account/suspended")).text();
	check(page.includes("Your account is suspended") && page.includes("Spamming replies."), "the screen shows the reason");
	const post = (body: Record<string, string>) => fetch(`${origin}/account/suspended`, { method: "POST", headers: { cookie: s!.cookie }, body: new URLSearchParams(body), redirect: "manual" });
	check((await post({ csrf: "nope", body: "please" })).status === 400, "a stale form is refused");
	check((await post({ csrf: s!.csrf, body: "It was a misunderstanding." })).status === 303, "it sends an appeal");
	const [appeal] = await sql`select status, body from moderation_appeals where user_id = ${id}::bigint`;
	check(appeal?.status === "open" && appeal.body === "It was a misunderstanding.", "the appeal is stored for staff");
	const after = await (await get("/account/suspended")).text();
	check(after.includes("Waiting for staff") && !after.includes("Send appeal"), "the screen shows it's waiting and hides the form");
	await sql`update users set status = 'active' where id = ${id}::bigint`;
	const lifted = await get("/account/suspended");
	check(lifted.status === 302 && lifted.headers.get("location")?.endsWith("/home"), "lifting the suspension lets the same session in");
	await sql`update users set status = 'suspended' where id = ${id}::bigint`;
	const out = await post({ csrf: s!.csrf, action: "signout" });
	check(out.status === 303 && (await get("/account/suspended")).status === 302, "sign out ends the session");
	const deactivated = `sd${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const did = await createUser(deactivated, deactivated, password);
	created.push(did);
	await sql`update users set status = 'suspended', deactivated_at = now() - interval '40 days' where id = ${did}::bigint`;
	check(!(await signIn(deactivated)), "a long-deactivated account still can't sign in");
	console.log(`${checks} checks passed`);
} finally {
	await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}
