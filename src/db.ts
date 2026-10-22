import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StorageFailure } from "./disk";
import { DATABASE_SENTENCE } from "./notices";

export { DATABASE_SENTENCE };

export class DatabaseOutage extends Error {
	readonly kind = "outage" as const;
	constructor(cause?: unknown) {
		super(DATABASE_SENTENCE, cause === undefined ? undefined : { cause });
		this.name = "DatabaseOutage";
	}
}

const CONNECT = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"EPIPE",
	"ERR_POSTGRES_CONNECTION_CLOSED",
	"ERR_POSTGRES_CONNECTION_REFUSED",
	"ERR_POSTGRES_CONNECTION_TIMEOUT",
]);
const SQLSTATE = new Set(["53300", "57P01", "57P02", "57P03", "57014", "55P03"]);

function codesOf(e: unknown): string[] {
	const out: string[] = [];
	const seen = new Set<unknown>();
	let cur: unknown = e;
	while (cur && typeof cur === "object" && !seen.has(cur)) {
		seen.add(cur);
		const o = cur as Record<string, unknown>;
		for (const key of ["code", "errno", "sqlState"]) {
			const value = o[key];
			if (typeof value === "string" && value) out.push(value);
		}
		cur = o.cause;
	}
	return out;
}

export function databaseOutage(e: unknown): DatabaseOutage | undefined {
	if (e instanceof DatabaseOutage) return e;
	if (e instanceof StorageFailure) return undefined;
	const codes = codesOf(e);
	const message = e instanceof Error ? e.message : "";
	const hit = codes.some((code) => CONNECT.has(code) || SQLSTATE.has(code) || /^08[0-9A-Z]{3}$/.test(code))
		|| /connection (?:refused|terminated|timed out|timeout)|too many clients|the database system is (?:shutting down|starting up|in recovery)/i.test(message);
	if (!hit) return undefined;
		console.error(e instanceof Error ? e.stack ?? e.message : e);
		return new DatabaseOutage(e);
}

export const sql = new SQL(process.env.DATABASE_URL ?? "postgres://dev@localhost:5432/xitter", {
	max: Number(process.env.DB_POOL_MAX ?? 20),
	// bun's option is seconds. There is no pool-acquire timeout on SQL options.
	connectionTimeout: Number(process.env.DB_CONNECT_TIMEOUT ?? 5),
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
