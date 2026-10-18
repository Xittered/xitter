// Two-factor sign-in against a running server: set-up on /account/2fa, the
// code step in the dialog, a wrong code, a backup code, turning it off.
// Makes its own account and removes it.
// usage: bun scripts/test-two-factor.ts

import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { decode } from "../src/jetfuel";
import { codeAt } from "../src/totp";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const name = `f${Date.now() % 1e8}`;
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

async function step(action: string, f: Record<string, string>) {
	const r = await fetch(`${origin}/i/jfapi/onboarding/web/actions/${action}`, { method: "POST", body: new URLSearchParams(f) });
	const messages = decode(new Uint8Array(await r.arrayBuffer()));
	const out = { texts: [] as string[], errors: {} as Record<string, string>, fields: {} as Record<string, string>, cookies: r.headers.getSetCookie().map((c) => c.split(";")[0]) };
	for (const [tag, m] of messages) {
		if (tag !== 0) continue;
		for (const p of m.props) {
			if (p[0] === 0) out.texts.push(p[1]);
			if (p[0] === 17) Object.assign(out.errors, Object.fromEntries(p[1]));
			if (p[0] === 30) {
				Object.assign(out.fields, Object.fromEntries(p[1][1]));
				Object.assign(out.errors, Object.fromEntries(p[1][2]));
			}
		}
	}
	return out;
}

const id = await createUser(name, "Two Factor", "testpass123");
try {
	const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	const post = (path: string, body: Record<string, string> = {}) =>
		fetch(`${origin}/account/2fa${path}`, { method: "POST", body: new URLSearchParams(body), headers: { cookie: cookies } });

	const start = await (await post("/start")).text();
	const secret = /<div class="box code">([A-Z2-7 ]+)<\/div>/.exec(start)?.[1].replace(/ /g, "");
	check("set-up shows a key", !!secret && secret.length === 32, secret);
	const step0 = Math.floor(Date.now() / 30000);
	check("a wrong code doesn't turn it on", (await (await post("/confirm", { code: "000000" })).text()).includes("isn't right"));
	const confirmed = await (await post("/confirm", { code: codeAt(secret!, step0) })).text();
	const backups = [...confirmed.matchAll(/(\d{6})<br>|(\d{6})<\/div>/g)].map((m) => m[1] ?? m[2]);
	check("the right code turns it on and shows 8 backup codes", confirmed.includes("Two-factor is on") && backups.length === 8, backups.length);

	check("the old /login no longer works for it", !(await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" })).headers.getSetCookie().some((c) => c.startsWith("ct0=")));

	let s = await step("login_enter_password", { username: name, password: "testpass123" });
	check("the dialog asks for a code instead of signing in", !s.cookies.some((c) => c.startsWith("auth_token=")) && s.fields.session_token !== undefined, s.fields);
	const token = s.fields.session_token;
	s = await step("finish_verification", { session_token: token, code: "123456" });
	check("a wrong code is refused under its field", /isn't right/.test(s.errors.code ?? ""), s.errors);
	s = await step("finish_verification", { session_token: token, code: codeAt(secret!, Math.floor(Date.now() / 30000)) });
	check("the right code signs in", s.cookies.some((c) => c.startsWith("auth_token=")));

	s = await step("login_enter_password", { username: name, password: "testpass123" });
	s = await step("finish_verification", { session_token: s.fields.session_token, code: backups[0] });
	check("a backup code signs in", s.cookies.some((c) => c.startsWith("auth_token=")));
	s = await step("login_enter_password", { username: name, password: "testpass123" });
	s = await step("finish_verification", { session_token: s.fields.session_token, code: backups[0] });
	check("and only once", !s.cookies.some((c) => c.startsWith("auth_token=")));

	s = await step("login_enter_password", { username: name, password: "wrong" });
	check("a wrong password never gets to the code", /Wrong/.test(s.errors.password ?? ""));

	const off = await (await post("/disable", { password: "testpass123", code: codeAt(secret!, Math.floor(Date.now() / 30000)) })).text();
	check("turning it off needs the password and a code", off.includes("Set up an authenticator app"));
	s = await step("login_enter_password", { username: name, password: "testpass123" });
	check("then the password is enough again", s.cookies.some((c) => c.startsWith("auth_token=")));
} finally {
	await sql`delete from users where id = ${id}::bigint`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
