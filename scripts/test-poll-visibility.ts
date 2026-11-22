// Real Postgres checks: knowing a poll's id must not bypass post visibility.
// DATABASE_URL=postgres://localhost/xitter_test bun scripts/test-poll-visibility.ts
import { strict as assert } from "node:assert";
import { randomBytes } from "node:crypto";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { createCard, attachPoll, pollsByIds, vote, PollError } from "../src/polls";
import { asRequest, markStaff } from "../src/staff-access";

const users: string[] = [];
try {
	for (const role of ["owner", "follower", "stranger", "staff"]) users.push(await createUser(`p${randomBytes(6).toString("hex")}`, role, "testpass123"));
	const [owner, follower, stranger, staff] = users;
	await sql`update users set role = 'admin' where id = ${staff}::bigint`;
	await sql`update users set protected = true where id = ${owner}::bigint`;
	await sql`insert into follows (follower_id, followee_id) values (${follower}::bigint, ${owner}::bigint)`;
	const card = await createCard(owner, JSON.stringify({
		"twitter:card": "poll2choice_text_only", "twitter:string:choice1_label": "Private choice", "twitter:string:choice2_label": "Other choice",
	}));
	const pollId = card.card_uri.slice("card://".length);
	const post = newId();
	await sql`insert into posts (id, user_id, text, conversation_id) values (${post}::bigint, ${owner}::bigint, 'private poll', ${post}::bigint)`;
	await attachPoll(owner, post, card.card_uri);
	const form = () => {
		const f = new FormData();
		f.set("twitter:string:card_uri", card.card_uri);
		f.set("twitter:string:selected_choice", "1");
		return f;
	};
	const refused = async (who: string, label: string) => {
		await assert.rejects(() => vote(who, form()), (e: unknown) => e instanceof PollError && e.status === 404, label);
		assert.equal((await pollsByIds(who, [pollId])).size, 0, `${label}: no poll labels or counts`);
		assert.equal((await sql`select 1 from poll_votes where poll_id = ${pollId}::bigint and user_id = ${who}::bigint`).length, 0, `${label}: no vote stored`);
		console.log(`ok: ${label}`);
	};
	await refused(stranger, "a stranger cannot read or vote on a protected poll");
	await refused(staff, "a staff role alone does not bypass the request's staff gate");
	assert.equal((await pollsByIds(owner, [pollId])).size, 1);
	await vote(follower, form());
	await vote(follower, form());
	assert.equal((await sql`select 1 from poll_votes where poll_id = ${pollId}::bigint and user_id = ${follower}::bigint`).length, 1);
	await sql`delete from poll_votes where poll_id = ${pollId}::bigint`;
	await sql`update users set protected = false where id = ${owner}::bigint`;
	await sql`insert into blocks (blocker_id, blocked_id) values (${owner}::bigint, ${stranger}::bigint)`;
	await refused(stranger, "a blocked account cannot read or vote on a poll");
	await sql`delete from blocks where blocker_id = ${owner}::bigint`;
	await sql`insert into blocks (blocker_id, blocked_id) values (${stranger}::bigint, ${owner}::bigint)`;
	await refused(stranger, "blocking the author also prevents voting");
	await sql`delete from blocks where blocker_id = ${stranger}::bigint`;
	await sql`update posts set hidden = true where id = ${post}::bigint`;
	await refused(stranger, "a hidden post's poll stays private");
	await asRequest(async () => {
		markStaff();
		assert.equal((await pollsByIds(staff, [pollId])).size, 1);
	});
	await sql`update posts set hidden = false where id = ${post}::bigint`;
	await sql`update users set status = 'suspended' where id = ${owner}::bigint`;
	await refused(stranger, "a suspended author's poll stays private");
	await sql`update users set status = 'active' where id = ${owner}::bigint`;
	await sql`update posts set circle_owner_id = ${owner}::bigint where id = ${post}::bigint`;
	await sql`insert into circle_members (owner_id, member_id) values (${owner}::bigint, ${follower}::bigint)`;
	await refused(stranger, "a Circle post's poll stays inside the Circle");
	assert.equal((await pollsByIds(follower, [pollId])).size, 1, "a Circle member still sees the poll");
	await sql`delete from circle_members where owner_id = ${owner}::bigint`;
	await sql`update posts set circle_owner_id = null where id = ${post}::bigint`;
	await sql`delete from posts where id = ${post}::bigint`;
	await refused(stranger, "a deleted post's poll is no longer accessible");
	console.log("ok: owner and follower access, one vote per person, and authorized staff review are preserved");
} finally {
	for (const id of users) await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
