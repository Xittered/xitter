// Pronouns for local and federated accounts: the client asks with a bare
// handle for a local account and handle@instance for a remote one, and reads
// the answer under the same key. Makes two accounts and removes them.
// usage: bun scripts/test-pronouns.ts

import { strict as assert } from "node:assert";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { pronounsFor } from "../src/pronouns";

const tag = `p${Date.now() % 1e8}`;
const remoteName = `r${tag}`;
const local = await createUser(tag, "Pronoun Local", "testpass123");
const remote = await createUser(remoteName, "Pronoun Remote", "testpass123");
try {
	await sql`update users set pronouns = ${"they/them"} where id = ${local}::bigint`;
	await sql`update users set instance = ${"remote.example"}, pronouns = ${"she/her"} where id = ${remote}::bigint`;

	const localAnswer = await (await pronounsFor(new URL(`http://localhost/i/api/xitter/pronouns?names=${tag}`))).json();
	assert.deepEqual(localAnswer, { [tag]: "they/them" });

	const remoteAnswer = await (await pronounsFor(new URL(`http://localhost/i/api/xitter/pronouns?names=${remoteName}@remote.example`))).json();
	assert.deepEqual(remoteAnswer, { [`${remoteName}@remote.example`]: "she/her" });
} finally {
	await sql`delete from users where id in (${local}::bigint, ${remote}::bigint)`;
	await sql.close();
}
console.log("pronoun checks passed");
