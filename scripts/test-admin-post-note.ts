import assert from "node:assert/strict";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { createPost, getPost } from "../src/posts";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const password = "post-note-test-only";
const created: string[] = [];
let checks = 0;
function check(ok: unknown, label: string) {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok", label);
}
async function make(role: string | null = null) {
	const name = "pn" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
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
try {
	const admin = await make("admin"), other = await make("admin"), mod = await make("moderator"), user = await make();
	const post = await createPost(user.id, "the moon is cheese", { skipPreview: true, skipReview: true });
	const run = await session(admin.name), run2 = await session(other.name), denied = await session(mod.name);
	check((await denied("setPostNote", { id: post, text: "no" })).status === 403, "moderators can't add community notes");
	check((await run("setPostNote", { id: post, text: "It isn't." })).status === 200, "admin adds a note");
	check((await getPost(user.id, post))?.communityNote?.text === "It isn't.", "note shows without any ratings");
	check((await run("setPostNote", { id: post, text: "It is rock." })).status === 200, "admin edits the note");
	check((await getPost(user.id, post))?.communityNote?.text === "It is rock.", "edited text shows");
	check((await run2("setPostNote", { id: post, text: "Rock, per NASA." })).status === 200, "another admin replaces it");
	const [{ count }] = await sql`select count(*)::int from community_notes where post_id = ${post}::bigint and staff`;
	check(count === 1, "only one staff note per post");
	check((await run("posts", {})).data.posts?.find((p: any) => p.id === post)?.staff_note === "Rock, per NASA.", "panel sees the current note");
	check((await run("setPostNote", { id: post, text: "" })).status === 200, "blank removes it");
	check(!(await getPost(user.id, post))?.communityNote, "note is gone");
	console.log(`${checks} checks passed`);
} finally {
	await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}
