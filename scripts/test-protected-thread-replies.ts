import assert from "node:assert/strict";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { createPost, feed, getPost } from "../src/posts";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const created: string[] = [];
const make = async (prefix: string) => {
	const name = `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
	const id = await createUser(name, name, "protected-thread-test-only");
	created.push(id);
	return id;
};
const allTab = async (viewerId: string) => (await feed({ viewerId, authors: { all: true }, replies: true, kinds: "both", limit: 100 })).map((i) => i.post.id);

try {
	const owner = await make("pt");
	const follower = await make("pf");
	const stranger = await make("ps");
	await sql`update users set protected = true where id = ${owner}::bigint`;
	await sql`insert into follows (follower_id, followee_id) values (${follower}::bigint, ${owner}::bigint) on conflict do nothing`;
	const root = await createPost(owner, "only for my followers");
	const reply = await createPost(follower, "replying inside a protected thread", { replyToId: root });
	const nested = await createPost(owner, "answering the follower", { replyToId: reply });
	const deeper = await createPost(follower, "and back again", { replyToId: nested });

	for (const id of [reply, deeper]) {
		assert.equal(await getPost(stranger, id), undefined, "a stranger can't open a reply inside a protected thread");
		assert(!(await allTab(stranger)).includes(id), "a stranger's All tab leaves out replies inside a protected thread");
		assert(await getPost(follower, id), "the reply's author still sees it");
		assert(await getPost(owner, id), "the protected account sees replies in its own thread");
		assert((await allTab(follower)).includes(id), "an approved follower sees the reply on the All tab");
	}
	await sql`delete from follows where follower_id = ${follower}::bigint and followee_id = ${owner}::bigint`;
	assert(await getPost(follower, reply), "the author keeps their own reply after unfollowing");

	const open = await make("po");
	const openRoot = await createPost(open, "a public post");
	const openReply = await createPost(follower, "a public reply", { replyToId: openRoot });
	assert(await getPost(stranger, openReply), "replies in public threads stay visible");
	assert((await allTab(stranger)).includes(openReply), "and stay on the All tab");
	console.log("protected thread replies: 9 checks passed");
} finally {
	await sql`delete from users where id = any(${sql.array(created, "INT8")})`;
	await sql.close();
}
