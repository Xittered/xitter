import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { trendingHashtags } from "../src/search";

let checks = 0;
const check = (ok: unknown, label: string) => {
	if (!ok) throw new Error(label);
	checks++;
	console.log("ok  ", label);
};
const stamp = Date.now().toString(36);
const created: string[] = [];
const person = async (ip: string, ageDays = 30) => {
	const name = `tr${created.length}_${stamp}`;
	const id = await createUser(name, name, "testpass123");
	created.push(id);
	await sql`update users set created_at = now() - make_interval(days => ${ageDays}) where id = ${id}::bigint`;
	await sql`insert into login_events (id, user_id, ip, app) values (${newId()}::bigint, ${id}::bigint, ${ip}, 'test')`;
	return id;
};
const post = async (userId: string, text: string, times = 1) => {
	for (let i = 0; i < times; i++) {
		const id = newId();
		await sql`insert into posts (id, user_id, text, conversation_id) values (${id}::bigint, ${userId}::bigint, ${text}, ${id}::bigint)`;
	}
};
const trends = async (tag: string) => (await trendingHashtags(1, 500)).some((t) => t.tag === `#${tag}`);
try {
	const spam = `spam${stamp}`;
	const loner = await person("198.51.100.1");
	await post(loner, `buy now #${spam}`, 50);
	check(!(await trends(spam)), "one person posting a tag 50 times doesn't make it trend");

	const puppets = [await person("198.51.100.2"), await person("198.51.100.2"), await person("198.51.100.2")];
	for (const p of puppets) await post(p, `#${spam} again`);
	check(!(await trends(spam)), "accounts behind one address count once");

	const fresh = [await person("198.51.100.3", 0), await person("198.51.100.4", 0)];
	for (const p of fresh) await post(p, `#${spam}`);
	check(!(await trends(spam)), "brand new accounts don't count");

	const real = `real${stamp}`;
	const people = [await person("198.51.100.5"), await person("198.51.100.6"), await person("198.51.100.7")];
	for (const p of people) await post(p, `talking about #${real}`);
	check(await trends(real), "three separate people make a tag trend");
	await sql`update users set status = 'suspended' where id = ${people[0]}::bigint`;
	check(!(await trends(real)), "a suspended account stops counting");
	console.log(`all passed (${checks})`);
} finally {
	for (const id of created) {
		await sql`delete from login_events where user_id = ${id}::bigint`;
		await sql`delete from posts where user_id = ${id}::bigint`;
		await sql`delete from users where id = ${id}::bigint`;
	}
	await sql.end();
}
