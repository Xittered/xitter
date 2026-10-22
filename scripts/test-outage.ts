import { expect, test } from "bun:test";
import { DATABASE_SENTENCE, DatabaseOutage, databaseOutage, migrate, sql } from "../src/db";
import { STORAGE_SENTENCE, StorageFailure } from "../src/disk";
import { failFor } from "../src/failure";
import { failOperation, runOperation } from "../src/graphql";
import { recordError } from "../src/errors";
import { NOTICE_HEADER } from "../src/notices";

const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432 /var/lib/postgresql"), { code: "ECONNREFUSED" });

test("databaseOutage classifies connect, capacity and timeout failures", () => {
	const yes = [
		"ECONNREFUSED",
		"ECONNRESET",
		"ETIMEDOUT",
		"ERR_POSTGRES_CONNECTION_CLOSED",
		"ERR_POSTGRES_CONNECTION_REFUSED",
		"ERR_POSTGRES_CONNECTION_TIMEOUT",
		"53300",
		"57P01",
		"57P02",
		"57P03",
		"57014",
		"55P03",
		"08000",
		"08006",
		"08P01",
	];
	for (const code of yes) {
		const out = databaseOutage(Object.assign(new Error(`db ${code} at /tmp/socket`), { code }));
		expect(out, code).toBeInstanceOf(DatabaseOutage);
		expect(out?.message).toBe(DATABASE_SENTENCE);
	}
	const wrapped = databaseOutage(new Error("outer", { cause: Object.assign(new Error("inner"), { sqlState: "53300" }) }));
	expect(wrapped).toBeInstanceOf(DatabaseOutage);
	expect(databaseOutage(new Error("the database system is shutting down"))?.message).toBe(DATABASE_SENTENCE);
	expect(databaseOutage(new DatabaseOutage())).toBeInstanceOf(DatabaseOutage);
	expect(databaseOutage(Object.assign(new Error("duplicate key value violates users_pkey"), { code: "23505" }))).toBeUndefined();
	expect(databaseOutage(new Error("Your post is empty."))).toBeUndefined();
});

test("a dead database becomes a 503 page or JSON without internals", async () => {
	const err = databaseOutage(refused);
	const page = failFor(new Request("http://localhost/home"), err)!;
	expect(page.status).toBe(503);
	expect(page.headers.get("retry-after")).toBe("60");
	expect(page.headers.get("content-type")).toContain("text/html");
	const html = await page.text();
	expect(html).toContain("Xitter is having trouble right now");
	expect(html).toContain("Retry");
	expect(html).toContain('href="/"');
	expect(html).toContain("Retry");
	expect(html).toContain(DATABASE_SENTENCE);
	expect(html).not.toContain("ECONNREFUSED");
	expect(html).not.toContain("127.0.0.1");
	expect(html).not.toContain("/var/lib");
	const api = failFor(new Request("http://localhost/i/api/graphql/CreateTweet", { method: "POST" }), err)!;
	expect(api.status).toBe(503);
	expect(api.headers.get(NOTICE_HEADER)).toBe(DATABASE_SENTENCE);
	expect(api.headers.get("retry-after")).toBe("60");
	expect(await api.json()).toEqual({ errors: [{ code: 130, message: DATABASE_SENTENCE }] });
	const poisoned = failFor(new Request("http://localhost/home"), new DatabaseOutage())!;
	expect(await poisoned.text()).not.toContain("<script>");
});

test("CreateTweet reports storage and database failures as code 85", async () => {
	const viewer = { id: "1" } as any;
	const storage = await failOperation(new StorageFailure(refused), () => runOperation("CreateTweet", viewer, { tweet_text: "hello" }));
	expect(storage.status).toBe(200);
	expect(await storage.json()).toEqual({
		errors: [{ message: `Error: ${STORAGE_SENTENCE}`, code: 85, kind: "Validation",
			extensions: { name: "GenericError", source: "Server", code: 85, kind: "Validation" } }],
		data: {},
	});
	const down = await failOperation(refused, () => runOperation("CreateNoteTweet", viewer, { tweet_text: "hello" }));
	expect(down.status).toBe(200);
	const body = await down.json();
	expect(body.errors[0].extensions.code).toBe(85);
	expect(body.errors[0].message).toBe(`Error: ${DATABASE_SENTENCE}`);
	expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
	expect(JSON.stringify(body)).not.toContain("127.0.0.1");
});

test("recording an outage does not write a row", async () => {
	// unit tests run before CI migrates its database, so make sure error_log exists
	await migrate();
	const [before] = await sql`select count(*)::int as n from error_log`;
	await recordError("server", new DatabaseOutage(refused), { path: "POST /i/api/graphql/CreateTweet" });
	const [after] = await sql`select count(*)::int as n from error_log`;
	expect(after.n).toBe(before.n);
});
