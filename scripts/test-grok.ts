import { sql } from "../src/db";
import { newId } from "../src/ids";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
if (!/test/.test(new URL(process.env.DATABASE_URL ?? "").pathname)) throw new Error("DATABASE_URL must point at a *test* database");

const ok = (cond: unknown, what: string) => {
	if (!cond) throw new Error(`FAIL: ${what}`);
	console.log(`ok   ${what}`);
};

const name = `grok_${Date.now().toString(36)}`;
const password = "grok-test-password";
const userId = newId();
await sql`insert into users (id, screen_name, name, password_hash) values (${userId}::bigint, ${name}, ${name}, ${await Bun.password.hash(password)})`;

try {
	const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
	const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	ok(csrf, "signed in");
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf!, "content-type": "application/json" };

	const ask = async (responses: object[], conversationId?: string) => {
		const r = await fetch(`${origin}/2/grok/add_response.json`, { method: "POST", headers, body: JSON.stringify({ responses, conversationId }) });
		const lines = (await r.text()).trim().split("\n").map((l) => JSON.parse(l));
		return { conversationId: lines[0].conversationId as string, reply: lines.slice(1).map((l) => l.result?.message ?? "").join("") };
	};

	const first = await ask([{ message: "hello", sender: 1 }]);
	ok(first.reply === "you said: hello", `first answer (${first.reply})`);

	const second = await ask(
		[
			{ message: "hello", sender: 1 },
			{ message: first.reply, sender: 2 },
			{ message: "what is the capital of france", sender: 1 },
		],
		first.conversationId,
	);
	ok(second.reply === "you said: what is the capital of france", `answers the newest message (${second.reply})`);

	const third = await ask([{ message: "just the new one", sender: 1 }], first.conversationId);
	ok(third.reply === "you said: just the new one", "a single message still works");

	const stored = await sql`select message from grok_items where conversation_id = ${first.conversationId}::bigint and sender = 'User' order by id`;
	ok(stored.map((r: any) => r.message).join("|") === "hello|what is the capital of france|just the new one", "history stores what was asked");
} finally {
	await sql`delete from grok_conversations where user_id = ${userId}::bigint`;
	await sql`delete from users where id = ${userId}::bigint`;
	await sql.close();
}
console.log("all good");
