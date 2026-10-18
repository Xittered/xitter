import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { expireSanctions } from "../src/moderation";
import { loadSettings, setSetting, settings } from "../src/settings";

const origin = "http://localhost:3000", password = "testpass123";
let checks = 0;
const check = (ok: unknown, label: string) => {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok  ", label);
};
async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "";
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	return {
		ok: r.status < 400 && !!csrf,
		headers,
		gql: async (op: string, variables: any) => {
			const r = await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) });
			return { status: r.status, data: (await r.json().catch(() => ({}))) as any };
		},
		form: async (path: string, f: Record<string, string>) => {
			const r = await fetch(`${origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(f) });
			return { status: r.status, text: await r.text() };
		},
		admin: async (action: string, body: any = {}) => {
			const r = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body) });
			return { status: r.status, data: (await r.json()) as any };
		},
	};
}
const standing = async (id: string) => (await sql`select status, status_until, status_restore from users where id = ${id}::bigint`)[0];
const strikes = async (id: string) => (await sql`select count(*)::int as n from staff_messages where user_id = ${id}::bigint and kind = 'strike' and revoked_at is null`)[0].n;
const ageStrikes = (id: string) => sql`update staff_messages set created_at = created_at - interval '10 minutes' where user_id = ${id}::bigint`;
const tweet = (s: Awaited<ReturnType<typeof session>>, text: string) => s.gql("CreateTweet", { tweet_text: text });
const created: string[] = [];
const name = (p: string) => `${p}${Date.now().toString().slice(-8)}`;
const before = structuredClone(settings().automod);
await loadSettings();
const saved = structuredClone(settings().automod);

try {
	const adminName = name("am_adm");
	const adminId = await createUser(adminName, adminName, password);
	created.push(adminId);
	await sql`update users set role = 'admin' where id = ${adminId}::bigint`;
	const admin = await session(adminName);
	check(admin.ok, "admin signs in");
	check((await admin.admin("saveAutomod", { enabled: true, strike_days: 365, ladder: [0, 24, 168, -1] })).status === 200, "ladder saved: warning, 1 day, 1 week, permanent");
	await loadSettings();

	const userName = name("am_usr");
	const userId = await createUser(userName, userName, password);
	created.push(userId);
	let user = await session(userName);
	check(user.ok, "member signs in");

	const ok = await tweet(user, "trans women are women and the yuri account is great");
	check(ok.data.data?.create_tweet?.tweet_results?.result?.rest_id, "pro-trans post goes through");
	const nsfw = await tweet(user, "she sat on my face and i came so hard");
	check(nsfw.data.data?.create_tweet, "NSFW text goes through");

	const first = await tweet(user, "you dumb n1gg3r");
	check(first.data.errors?.[0]?.code === 186, "slur post refused");
	check((await strikes(userId)) === 1 && (await standing(userId)).status === "active", "first strike is a warning");
	check((await sql`select 1 from audit_log where action = 'automod_strike' and target = ${userId} and actor_id is null`).length === 1, "automod strike in the audit log");
	const again = await tweet(user, "n i g g e r");
	check(again.data.errors?.[0]?.code === 186 && (await strikes(userId)) === 1, "a quick retry is refused without a second strike");

	await ageStrikes(userId);
	const second = await tweet(user, "trans women are men");
	check(second.data.errors?.[0]?.code === 186, "transphobic post refused");
	let s = await standing(userId);
	check(s.status === "suspended" && s.status_until && new Date(s.status_until).getTime() - Date.now() > 23 * 3600_000, "second strike suspends for a day");
	check(s.status_restore === "active", "and remembers the earlier standing");
	check((await tweet(user, "hello")).status === 401, "the old session can't post");
	check(!(await session(userName)).ok, "a suspended account can't sign in");
	check((await sql`select 1 from audit_log where action = 'escalate' and target = ${userId}`).length >= 1, "escalation in the audit log");

	const due = await sql`insert into scheduled_posts (id, user_id, kind, execute_at, request) values (${Date.now()}::bigint, ${userId}::bigint, 'scheduled', now() - interval '1 minute', ${JSON.stringify({ status: "scheduled while suspended" })}::text::jsonb) returning id`;
	const { runDue } = await import("../src/scheduled");
	await runDue();
	check(!(await sql`select 1 from posts where user_id = ${userId}::bigint and text = 'scheduled while suspended'`).length && due.length, "a suspended account's scheduled post doesn't publish");

	await sql`update users set status_until = now() - interval '1 second' where id = ${userId}::bigint`;
	await expireSanctions();
	s = await standing(userId);
	check(s.status === "active" && !s.status_until && !s.status_restore, "the suspension runs out back to active");
	user = await session(userName);
	check(user.ok, "and they can sign in again");

	await ageStrikes(userId);
	const bio = await user.form("/1.1/account/update_profile.json", { description: "gas the jews" });
	check(bio.status >= 400 && (await strikes(userId)) === 3, "hate in a bio is refused and struck");
	s = await standing(userId);
	check(s.status === "suspended" && new Date(s.status_until).getTime() - Date.now() > 6 * 86400_000, "third strike suspends for a week");

	await sql`update users set status_until = now() - interval '1 second' where id = ${userId}::bigint`;
	await expireSanctions();
	user = await session(userName);
	await ageStrikes(userId);
	const rename = await user.form("/1.1/account/settings.json", { screen_name: `kike_${Date.now().toString().slice(-6)}` });
	check(rename.status === 400, "a slur username is refused");
	s = await standing(userId);
	check(s.status === "suspended" && !s.status_until, "fourth strike suspends for good");
	await sql`update users set status_until = now() - interval '1 second' where id = ${userId}::bigint and status_until is not null`;
	await expireSanctions();
	check((await standing(userId)).status === "suspended", "a permanent suspension doesn't expire");

	const modName = name("am_mod");
	const modId = await createUser(modName, modName, password);
	created.push(modId);
	const mod = await session(modName);
	check((await mod.form("/1.1/account/update_profile.json", { name: "I'm a dyke and proud" })).status === 200, "reclaimed word in a display name passes");
	const strike = await admin.admin("sendStaffMessage", { id: modId, kind: "strike", body: "test strike" });
	check(strike.data.escalation?.outcome === "warning", "a staff strike goes through the ladder");
	await admin.admin("sendStaffMessage", { id: modId, kind: "strike", body: "test strike 2" });
	check((await standing(modId)).status === "suspended", "the second staff strike suspends");
	const noEsc = await admin.admin("sendStaffMessage", { id: adminId, kind: "message", body: "hi" });
	check(noEsc.status === 200 && !noEsc.data.escalation, "a message doesn't escalate");
	const view = await admin.admin("user", { id: modId });
	check(view.data.strikes === 2 && view.data.next_step === 168, "the admin view shows strikes and the next step");
	const audit = await admin.admin("audit", { automatic: true, action: "automod_strike" });
	check(audit.data.entries.some((e: any) => e.target === userId && e.automatic), "the audit log filters automatic entries");

	const rName = name("am_res");
	const rId = await createUser(rName, rName, password);
	created.push(rId);
	const r = await session(rName);
	await sql`update users set status = 'restricted' where id = ${rId}::bigint`;
	check((await tweet(r, "can i post")).status === 403, "a restricted account can't post");
	check((await r.gql("SendMessageCreateMutation", {})).status === 403, "or send DMs");
	check((await r.form("/1.1/account/deactivate.json", { password })).status >= 400, "or deactivate its way out of the sanction");
	await sql`update users set status = 'active' where id = ${rId}::bigint`;

	const huge = await fetch(`${origin}/i/api/graphql/q/CreateTweet`, { method: "POST", headers: { ...r.headers, "content-type": "application/json" }, body: "x".repeat(3 * 1024 * 1024) });
	check(huge.status === 413, "a 3 MB request body is refused");
	let deep: any = "x";
	for (let i = 0; i < 50; i++) deep = { a: deep };
	check((await r.gql("CreateTweet", { tweet_text: "deep", deep })).status === 413, "deeply nested variables are refused");
	check((await r.gql("CreateTweet", { tweet_text: "wide", ids: Array(6000).fill(1) })).status === 413, "huge arrays are refused");
	const tooLong = await r.form("/1.1/account/update_profile.json", { description: "a".repeat(161) });
	check(tooLong.status >= 400, "a 161 character bio is refused");
	const pw = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: rName, password: "a".repeat(5000) }), redirect: "manual" });
	check(pw.status === 401, "a 5000 character password is refused without hashing");

	console.log(`all passed (${checks})`);
} finally {
	await setSetting("automod", saved.enabled === undefined ? before : saved);
	for (const id of created) {
		await sql`delete from audit_log where target = ${id}`;
		await sql`delete from scheduled_posts where user_id = ${id}::bigint`;
		await sql`delete from users where id = ${id}::bigint`;
	}
	await sql.end();
}
