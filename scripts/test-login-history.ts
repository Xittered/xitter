// Account access history and connected apps: each sign-in is listed with its
// app and address; there are no connected apps. Uses one account.
// usage: bun scripts/test-login-history.ts <user> <password>

import { sql } from "../src/db";
import { sessionKey } from "../src/auth";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [username, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-login-history.ts <user> <password>");

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual", headers: { "user-agent": "login-history-test" } });
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))!.slice(4);
const token = cookies.find((c) => c.startsWith("auth_token="))!.slice("auth_token=".length);
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };

const data = await (await fetch(`${origin}/i/api/1.1/account/personalization/p13n_data.json`, { headers })).json();
const last = data.login_history?.[0];
check("the sign-in is listed first", last?.app_name === "Xitter for Web" && Date.now() - new Date(last.time).getTime() < 60_000, last);
check("with the address it came from", typeof last?.ip === "string" && last.ip.length > 0, last?.ip);
const [session] = await sql`select ip from sessions where token = ${sessionKey(token)}`;
check("and the session keeps that address", session?.ip === last?.ip, session);
const apps = await (await fetch(`${origin}/i/api/1.1/oauth/list.json`, { headers })).json();
check("there are no connected apps", Array.isArray(apps.applications) && apps.applications.length === 0, apps);

console.log(failures ? `${failures} failed` : "all checks passed");
await sql.close();
process.exit(failures ? 1 : 0);
