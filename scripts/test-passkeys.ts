// Passkeys against a running server (PUBLIC_ORIGIN must be its address):
// adding one on /account/passkeys, signing in with it, a reused challenge, a
// copied authenticator, removing it (with the form's csrf token), and a
// password change or reset removing them all. Makes its own account and removes it.
// usage: bun scripts/test-passkeys.ts

import { createHash } from "node:crypto";
import { createUser } from "../src/auth";
import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "../src/config";
import { sql } from "../src/db";
import { b64url } from "../src/webauthn";
import { KINDS, authenticator } from "./fake-authenticator";

const origin = PUBLIC_ORIGIN;
const name = `p${Date.now() % 1e8}`;
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const encode = (r: Record<string, Uint8Array | string>) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? v : b64url(v)]));
const post = (path: string, body: unknown, cookie = "") =>
	fetch(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify(body) });

const id = await createUser(name, "Pass Key", "testpass123");
try {
	const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

	check("the page lists none", (await (await fetch(`${origin}/account/passkeys`, { headers: { cookie: cookies } })).text()).includes("haven't added any passkeys"));
	check("adding needs the password", (await post("/account/passkeys/options", { password: "wrong" }, cookies)).status === 400);
	check("another site can't ask", (await fetch(`${origin}/account/passkeys/options`, { method: "POST", headers: { origin: "https://evil.example", cookie: cookies }, body: "{}" })).status === 403);
	const options = await (await post("/account/passkeys/options", { password: "testpass123" }, cookies)).json();
	check("options name the site and account", options.rp?.id === PUBLIC_HOSTNAME && Buffer.from(options.user.id, "base64url").toString() === id, options.rp);

	const key = authenticator(KINDS.ES256!, { challenge: options.challenge, origin, rpId: PUBLIC_HOSTNAME });
	const added = await post("/account/passkeys/add", { ...encode(key.create()), name: "Test phone", transports: ["internal"] }, cookies);
	check("adds it", added.ok, await added.json());
	check("the challenge is used up", !(await post("/account/passkeys/add", encode(key.create()), cookies)).ok);
	check("the page lists it", (await (await fetch(`${origin}/account/passkeys`, { headers: { cookie: cookies } })).text()).includes("Test phone"));

	const signIn = async (count: number, over: Record<string, unknown> = {}) => {
		const o = await (await post("/account/passkey/options", {})).json();
		const r = key.get(count, 0x05, { challenge: o.challenge, ...over });
		return post("/account/passkey/signin", { id: key.id, ...encode(r), userHandle: b64url(new TextEncoder().encode(id)) });
	};
	const ok = await signIn(1);
	const set = ok.headers.getSetCookie().map((c) => c.split(";")[0]);
	check("signs in", ok.ok && set.some((c) => c.startsWith("auth_token=")), await ok.json());
	const me = await fetch(`${origin}/account/passkeys`, { headers: { cookie: set.join("; ") } });
	check("the new session works", (await me.text()).includes("Test phone"));
	check("a counter that didn't move is refused", (await signIn(1)).status === 403);
	check("a wrong origin is refused", (await signIn(5, { origin: "https://evil.example" })).status === 400);
	const o = await (await post("/account/passkey/options", {})).json();
	const once = { id: key.id, ...encode(key.get(9, 0x05, { challenge: o.challenge })) };
	check("signs in again", (await post("/account/passkey/signin", once)).ok);
	check("an answer can't be replayed", (await post("/account/passkey/signin", once)).status === 400);
	const [{ n }] = await sql`select count(*)::int as n from login_events where user_id = ${id}::bigint`;
	check("sign-ins are in the access history", n >= 3, n);

	await sql`update users set status = 'suspended' where id = ${id}::bigint`;
	check("a suspended account signs in to its appeal page", (await signIn(20)).ok);
	await sql`update users set status = 'active' where id = ${id}::bigint`;

	const csrf = /(?:^|; )ct0=([^;]+)/.exec(cookies)![1]!;
	const remove = (body: Record<string, string>) => fetch(`${origin}/account/passkeys/remove`, { method: "POST", body: new URLSearchParams(body), headers: { cookie: cookies }, redirect: "manual" });
	check("removing needs the form's csrf token", (await remove({ id: key.id })).status === 403 && (await signIn(25)).ok);
	check("removes it", (await remove({ id: key.id, csrf })).status === 303 && (await signIn(30)).status === 400);

	// changing the password keeps the passkeys
	const again = await (await post("/account/passkeys/options", { password: "testpass123" }, cookies)).json();
	const second = authenticator(KINDS.EdDSA!, { challenge: again.challenge, origin, rpId: PUBLIC_HOSTNAME });
	check("adds another", (await post("/account/passkeys/add", encode(second.create()), cookies)).ok);
	const changed = await fetch(`${origin}/i/api/i/account/change_password.json`, {
		method: "POST",
		headers: { cookie: cookies, "x-csrf-token": csrf },
		body: new URLSearchParams({ current_password: "testpass123", new_password: "newpass456", password_confirmation: "newpass456" }),
	});
	const [{ left }] = await sql`select count(*)::int as left from passkeys where user_id = ${id}::bigint`;
	check("a password change keeps the passkeys", changed.ok && left === 1, { status: changed.status, left });

	// and so does a reset by email link
	const fresh = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "newpass456" }), redirect: "manual" });
	const cookies2 = fresh.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	const third = await (await post("/account/passkeys/options", { password: "newpass456" }, cookies2)).json();
	check("adds a third", (await post("/account/passkeys/add", encode(authenticator(KINDS.ES256!, { challenge: third.challenge, origin, rpId: PUBLIC_HOSTNAME }).create()), cookies2)).ok);
	const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
	await sql`insert into password_resets (token_hash, user_id) values (${createHash("sha256").update(token).digest("hex")}, ${id}::bigint)`;
	const reset = await fetch(`${origin}/account/reset`, { method: "POST", body: new URLSearchParams({ token, password: "another789", confirm: "another789" }) });
	const [{ after }] = await sql`select count(*)::int as after from passkeys where user_id = ${id}::bigint`;
	check("a password reset keeps the passkeys", reset.ok && after === 2, { status: reset.status, after });
} finally {
	await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
if (failures) process.exit(1);
