import assert from "node:assert/strict";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { createPost, feed, getPost } from "../src/posts";
import { freshAsOf, rankedFeed } from "../src/ranking";
import { setFollow, suggestedUsers } from "../src/users";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const password = "shadow-ban-test-only";
const created: string[] = [];
let checks = 0;
function check(ok: unknown, label: string) {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok", label);
}
async function make(role: string | null = null) {
	const name = `sb${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
	const id = await createUser(name, name, password);
	created.push(id);
	if (role) await sql`update users set role = ${role} where id = ${id}::bigint`;
	return { id, name };
}
async function session(name: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))!.slice(4), "content-type": "application/json" };
	return async (action: string, body: object) => {
		const response = await fetch(`${origin}/admin/api/${action}`, { method: "POST", headers, body: JSON.stringify(body) });
		return { status: response.status, data: (await response.json()) as any };
	};
}
const ids = (items: { post: { id: string } }[]) => items.map((i) => i.post.id);
const following = (viewerId: string) => feed({ viewerId, authors: { following: true }, replies: false, limit: 50 } as any).then(ids);
const forYou = async (viewerId: string) => ids((await rankedFeed(viewerId, { asOf: await freshAsOf(viewerId), offset: 0, limit: 50 })).items);
try {
	const mod = await make("moderator"), support = await make("support"), banned = await make(), fan = await make(), stranger = await make();
	await setFollow(fan.id, banned.id, true);
	const post = await createPost(banned.id, "shadow test post #shadowtag", { skipPreview: true, skipReview: true });
	check((await following(fan.id)).includes(post), "before: a follower sees the post");
	check((await suggestedUsers(stranger.id, 200)).some((u) => u.id === banned.id), "before: suggested as a follow");
	const run = await session(mod.name), denied = await session(support.name);
	check((await denied("setShadowBan", { id: banned.id, on: true })).status === 403, "support can't shadow ban");
	check((await run("setShadowBan", { id: mod.id, on: true })).status === 400, "nobody shadow bans themselves");
	check((await run("setShadowBan", { id: banned.id, on: true, reason: "spam ring" })).status === 200, "a moderator shadow bans");
	check(!(await following(fan.id)).includes(post), "gone from a follower's Following timeline");
	check(!(await forYou(fan.id)).includes(post), "gone from a follower's For you");
	check(!(await forYou(stranger.id)).includes(post), "gone from a stranger's For you");
	check((await following(banned.id)).includes(post), "they still see it in their own timeline");
	check((await feed({ viewerId: stranger.id, authors: { user: banned.id }, replies: false, limit: 20 } as any).then(ids)).includes(post), "still on their profile");
	check((await getPost(stranger.id, post))?.id === post, "the post itself still opens");
	check(!(await suggestedUsers(stranger.id, 200)).some((u) => u.id === banned.id), "never suggested as a follow");
	const [{ shadow_banned }] = await sql`select shadow_banned from users where id = ${banned.id}::bigint`;
	check(shadow_banned, "stored on the account");
	check((await run("user", { id: banned.id })).data.user?.shadow_banned === true, "the panel shows it");
	const [log] = await sql`select detail from audit_log where action = 'shadow_ban' and target = ${banned.id} order by id desc limit 1`;
	check(log?.detail?.reason === "spam ring", "audited with the reason");
	const me = await fetch(`${origin}/i/api/1.1/account/verify_credentials.json`, { headers: { cookie: (await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: banned.name, password }), redirect: "manual" })).headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") } });
	check(!(await me.text()).includes("shadow"), "nothing in their own account data says so");
	check((await run("setShadowBan", { id: banned.id, on: false })).status === 200, "lifting it");
	check((await following(fan.id)).includes(post), "brings the post back");
	console.log(`${checks} checks passed`);
} finally {
	await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}
