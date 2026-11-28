import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const sql = new SQL(process.env.DATABASE_URL ?? "postgres://dev@localhost:5432/xitter", {
	max: Number(process.env.DB_POOL_MAX ?? 20),
	connection: {
		statement_timeout: process.env.DB_STATEMENT_TIMEOUT ?? "30s",
		lock_timeout: process.env.DB_LOCK_TIMEOUT ?? "10s",
		idle_in_transaction_session_timeout: "60s",
		// No JIT: the feed queries' correlated subqueries push their estimated cost
		// far past the JIT threshold, and compiling them took seconds on every
		// call, several times longer than running them.
		jit: "off",
	},
});

// schema.sql is idempotent, so it doubles as the migration
export async function migrate() {
	await sql.begin(async (tx) => {
		await tx`set local statement_timeout = 0`;
		await tx`set local lock_timeout = 0`;
		await tx.unsafe(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
	});
}

export const holdLock = (db: typeof sql, key: string) => db`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
