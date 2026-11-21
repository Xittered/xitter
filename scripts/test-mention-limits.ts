import assert from "node:assert/strict";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { createPost, editPost } from "../src/posts";
import { loadSettings, setSetting, settings } from "../src/settings";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const created: string[] = [];
let checks = 0;
function check(ok: unknown, label: string) {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok", label);
}
const refused = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);
await loadSettings();
const before = settings().mention_limits;
try {
	check(before.enabled && before.per_post === 10 && before.per_day === 300, "on by default: 10 per post, 300 a day");
	const make = async (role: string | null = null) => {
		const name = `ml${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
		const id = await createUser(name, name, "mention-limit-test-only");
		created.push(id);
		if (role) await sql`update users set role = ${role} where id = ${id}::bigint`;
		return { id, name };
	};
	const author = await make(), staff = await make("moderator");
	const targets = await Promise.all(Array.from({ length: 12 }, () => make()));
	const at = (n: number) => targets.slice(0, n).map((t) => `@${t.name}`).join(" ");
	check(await createPost(author.id, `hi ${at(10)}`, { skipPreview: true, skipReview: true }), "10 mentions go through");
	check((await refused(createPost(author.id, `hi ${at(11)}`, { skipPreview: true, skipReview: true }))).includes("up to 10"), "11 are refused");
	check(await createPost(author.id, `${at(10)} @${author.name} ${at(10)}`, { skipPreview: true, skipReview: true }), "repeats and yourself don't count");
	check(await createPost(staff.id, `hi ${at(12)}`, { skipPreview: true, skipReview: true }), "staff have no limit");
	const post = await createPost(author.id, "plain", { skipPreview: true, skipReview: true });
	check((await refused(editPost(author.id, post, `edit ${at(11)}`))).includes("up to 10"), "edits are held to it too");
	await setSetting("mention_limits", { enabled: true, per_post: 10, per_day: 25 });
	check((await refused(createPost(author.id, `more ${at(6)}`, { skipPreview: true, skipReview: true }))).includes("25 mentions a day"), "the daily limit counts earlier posts");
	check(await createPost(author.id, `ok ${at(5)}`, { skipPreview: true, skipReview: true }), "up to the daily limit is fine");
	await setSetting("mention_limits", { enabled: false, per_post: 10, per_day: 25 });
	check(await createPost(author.id, `off ${at(12)}`, { skipPreview: true, skipReview: true }), "switching it off lifts both");
	console.log(`${checks} checks passed`);
} finally {
	await setSetting("mention_limits", before);
	await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}
