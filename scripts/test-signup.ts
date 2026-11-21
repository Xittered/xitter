// End-to-end check of sign-in and invite sign-up in X's own dialog, against a
// running server: posts what the dialog posts and reads the Jetfuel screens
// that come back. Makes its own invites and removes the accounts it creates.
// usage: bun scripts/test-signup.ts

import { sql } from "../src/db";
import { createInvite } from "../src/invites";
import { decode } from "../src/jetfuel";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const name = `t${Date.now() % 1e9}`;

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

type Screen = { texts: string[]; errors: Record<string, string>; fields: Record<string, string>; cookies: string[] };

// a dialog step: the screen it answers with, its form's field errors and values
async function step(action: string, f: Record<string, string>, cookie = ""): Promise<Screen> {
	const r = await fetch(`${origin}/i/jfapi/onboarding/web/actions/${action}`, { method: "POST", body: new URLSearchParams(f), headers: { cookie } });
	const messages = decode(new Uint8Array(await r.arrayBuffer()));
	const s: Screen = { texts: [], errors: {}, fields: {}, cookies: r.headers.getSetCookie().map((c) => c.split(";")[0]) };
	for (const [tag, m] of messages) {
		if (tag !== 0) continue;
		for (const p of m.props) {
			if (p[0] === 0) s.texts.push(p[1]);
			// an error reply (ActionResponder): field name to text
			if (p[0] === 17) Object.assign(s.errors, Object.fromEntries(p[1]));
			if (p[0] === 30) {
				Object.assign(s.fields, Object.fromEntries(p[1][1]));
				Object.assign(s.errors, Object.fromEntries(p[1][2]));
			}
		}
	}
	return s;
}
const shows = (s: Screen, text: string) => s.texts.some((t) => t.includes(text));
const digits = (code: string) => code.replace(/\D/g, "");

// signed out, the client's own home page is the way in
const root = await fetch(`${origin}/`, { redirect: "manual" });
check("signed out, / is the client's home page, signed out", root.status === 200 && (await root.text()).includes('"isLoggedIn":false'));
const home = await fetch(`${origin}/home`, { redirect: "manual" });
check("other pages send you there", home.status === 302 && home.headers.get("location") === "/");
const oldLogin = await fetch(`${origin}/login`, { redirect: "manual" });
check("so does the old /login", oldLogin.status === 302 && oldLogin.headers.get("location") === "/?signin=1");

// sign-in
let s = await step("begin_login", { username_or_email: "pozo" });
check("a known username goes on to its password", s.fields.username === "pozo" && "password" in s.fields, s.fields);
s = await step("login_enter_password", { username: "pozo", password: "wrong" });
check("a wrong password is refused under its field", /Wrong/.test(s.errors.password ?? ""), s.errors);
s = await step("login_enter_password", { username: "pozo", password: "testpass123" });
check("the right one signs in", s.cookies.some((c) => c.startsWith("auth_token=")));

// sign-up by invite code
const code = await createInvite();
s = await step("begin_login", { username_or_email: name });
const token = s.fields.session_token;
check("an unknown username asks for an invite", shows(s, "Enter your invite code") && !!token);
s = await step("finish_verification", { session_token: token, code: "11112222" });
check("an unknown code is refused", /not valid/.test(s.errors.code ?? ""), s.errors);
s = await step("finish_verification", { session_token: token, code: digits(code) });
check("a good one opens account setup with the username filled in", shows(s, "Set up your account") && s.fields.username === name, s.fields);

// the check while typing: its reply sets the screen's "available" or "taken" state
const AVAILABLE = 5843147273490502584n, TAKEN = 1165880133285406392n;
async function typing(username: string) {
	const r = await fetch(`${origin}/i/jfapi/onboarding/web/remotes/suggest_username?form_atom_id=x`, { method: "POST", body: new URLSearchParams({ username, name: "", session_token: token }) });
	const states = new Map<bigint, boolean>();
	for (const [tag, m] of decode(new Uint8Array(await r.arrayBuffer())))
		if (tag === 0) for (const p of m.props) if (p[0] === 18 && !p[1].is_default) states.set(p[1].ref[1].id, m.props[p[1].prop_ref][1]);
	return states;
}
let states = await typing(name);
check("while typing, a free name shows as available", states.get(AVAILABLE) === true && states.get(TAKEN) === false);
states = await typing("Pozo");
check("and a taken one as taken", states.get(AVAILABLE) === false && states.get(TAKEN) === true);
states = await typing("ab");
check("and one too short as neither", states.get(AVAILABLE) === false && states.get(TAKEN) === false);

const setup = (o: Record<string, string>) => step("verify_signup", { session_token: token, name: "Signup Test", username: name, password: "testpass123", email: `${name.toLowerCase()}@example.com`, ...o });
s = await setup({ username: "settings" });
check("reserved names are refused", /reserved/.test(s.errors.username ?? ""), s.errors);
s = await setup({ username: "ab" });
check("short names are refused", /at least 4/.test(s.errors.username ?? ""), s.errors);
s = await setup({ username: "POZO" });
check("taken names are refused, whatever the case", /taken/.test(s.errors.username ?? ""), s.errors);
s = await setup({ password: "short" });
check("short passwords are refused", /8 characters/.test(s.errors.password ?? ""), s.errors);
s = await setup({});
const cookies = s.cookies.filter((c) => !c.startsWith("xitter_invite"));
check("sign-up makes the account and signs it in", cookies.some((c) => c.startsWith("auth_token=")));
const [made] = await sql`select signup_source from users where screen_name = ${name}`;
check("and notes the app it signed up from", made?.signup_source === "Xitter for Web", made);

const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "";
const vars = encodeURIComponent(JSON.stringify({ screen_name: name }));
const lookup = async () =>
	(await (await fetch(`${origin}/i/api/graphql/q/UserByScreenName?variables=${vars}`, { headers: { cookie: cookies.join("; "), "x-csrf-token": csrf } })).json()).data?.user?.result;
check("the new account is signed in and visible", (await lookup())?.core?.screen_name === name);
// the client reads its own account from the page's start-up state
const page = await (await fetch(`${origin}/home`, { headers: { cookie: cookies.join("; ") } })).text();
check("new accounts get Edit profile, not the onboarding flow", page.includes('"default_profile_image":false'));

// the flag picker in the Edit profile dialog posts here
const setFlag = (flag: string) =>
	fetch(`${origin}/i/api/1.1/account/update_flag.json`, { method: "POST", headers: { cookie: cookies.join("; "), "x-csrf-token": csrf }, body: new URLSearchParams({ flag }) });
check("an unknown flag is refused", (await setFlag("nope")).status === 403);
check("a flag can be set", (await setFlag("pan")).ok);
check("and shows as the badge", /flag-pan\.svg$/.test((await lookup())?.affiliates_highlighted_label?.label?.badge?.url ?? ""));
check("and can be removed", (await setFlag("")).ok);

s = await step("begin_login", { username_or_email: `${name}b` });
s = await step("finish_verification", { session_token: s.fields.session_token, code: digits(code) });
check("a used-up code is refused", /used up/.test(s.errors.code ?? ""), s.errors);

// an invite link keeps its code, and the dialog skips asking for it
const linked = await createInvite();
const link = await fetch(`${origin}/signup?code=${linked}`, { redirect: "manual" });
const inviteCookie = link.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith("xitter_invite=")) ?? "";
check("an invite link leads to the home page and keeps the code", link.status === 302 && link.headers.get("location") === "/?signin=1" && !!inviteCookie);
s = await step("begin_login", { username_or_email: `${name}c` }, inviteCookie);
check("then a new username goes straight to account setup", shows(s, "Set up your account"));
check("which says signing up agrees to the terms and privacy policy", shows(s, "By signing up, you agree to our ") && shows(s, "Terms of Service") && shows(s, "Privacy Policy"));
s = await step("verify_signup", { session_token: s.fields.session_token, name: "", username: `${name}c`, password: "testpass123", email: `${name.toLowerCase()}c@example.com` }, inviteCookie);
check("and signing up spends the code and clears it", s.cookies.some((c) => c.startsWith("auth_token=")) && s.cookies.includes("xitter_invite="));
const [spent] = await sql`select uses from invites where code = ${linked}`;
check("the linked code is used", spent?.uses === 1, spent);

await sql`delete from users where screen_name in (${name}, ${`${name}c`})`;
await sql`delete from invites where code in (${code}, ${linked})`;
await sql.close();
console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
