// Rate limits: fixed windows kept in memory, per account when signed in and per
// address when not. Over a limit the API answers like X (429, code 88, the
// x-rate-limit headers), which the client shows as its own "try again later".
// Staff are not limited. A restart clears every window.

import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import type { Viewer } from "./auth";
import { CLIENT_DIR } from "./client-cache";
import { settings } from "./settings";

const MIN = 60_000;
// for development: the test scripts post far faster than a person
const OFF = process.env.RATE_LIMITS === "off";

type Rule = { limit: number; window: number };

// The per-account buckets take their limit from settings (Admin > Settings),
// so `limit` there is only the fallback.
export const RULES = {
	// any API call but the client's background posts. A page load makes about
	// 30, clicking through a page every two seconds about 100 a minute.
	read: { limit: 6000, window: 15 * MIN },
	// calls to one endpoint (a GraphQL operation or a REST path), background
	// posts included, as X limits them: a client stuck re-asking for one thing
	// loses only that, not the whole site
	endpoint: { limit: 1000, window: 15 * MIN },
	// any write not covered below
	write: { limit: 1500, window: 15 * MIN },
	post: { limit: 150, window: 15 * MIN },
	// likes, reposts, bookmarks, follows and their undos
	engage: { limit: 1000, window: 15 * MIN },
	dm: { limit: 1500, window: 15 * MIN },
	// started uploads (each file's INIT), not its chunks
	upload: { limit: 150, window: 15 * MIN },
	// sign-in and sign-up screens, per address
	auth: { limit: 40, window: 15 * MIN },
	// passkey challenges, per address: the sign-in dialog asks for one each time it opens
	passkey: { limit: 200, window: 15 * MIN },
	// password tries on one account, from anywhere
	password: { limit: 100, window: 15 * MIN },
	password_address: { limit: 10, window: 15 * MIN },
	// second-factor codes tried on one account, from anywhere: each right
	// password opened a new five-guess challenge, so the guesses never ran out
	code: { limit: 10, window: 60 * MIN },
	// codes and links mailed (sign-up, password reset), per address
	mail: { limit: 5, window: 60 * MIN },
	federation: { limit: 30_000, window: 15 * MIN },
	translate: { limit: 150, window: 15 * MIN },
	// calls an instance importing an account makes with its migration code (migration.ts)
	migration: { limit: 20_000, window: 15 * MIN },
} satisfies Record<string, Rule>;

export type Bucket = keyof typeof RULES;

// noted: the refusal was logged, once per window
type Window = { count: number; reset: number; noted?: boolean };
const windows = new Map<string, Window>();

setInterval(() => {
	const now = Date.now();
	for (const [k, w] of windows) if (w.reset <= now) windows.delete(k);
}, 5 * MIN).unref();

export type Hit = { ok: boolean; limit: number; remaining: number; reset: number };

export function limitOf(bucket: Bucket): number {
	const set = (settings().rate_limits as Record<string, number>)[bucket];
	return Number.isInteger(set) && set > 0 ? set : RULES[bucket].limit;
}

function current(bucket: Bucket, who: string, now: number): Window {
	const key = `${bucket}:${who}`;
	let w = windows.get(key);
	if (!w || w.reset <= now) windows.set(key, (w = { count: 0, reset: now + RULES[bucket].window }));
	return w;
}

// Counts one request against each of `keys` (bucket, then an account id or an
// address), or against none when one of them is used up: a refused request
// isn't counted, or a client retrying while limited would keep its windows
// full for good. The answer is the first full window, else the tightest.
export function take(keys: [Bucket, string][], onRefused?: (bucket: Bucket, first: boolean) => void): Hit {
	const now = Date.now();
	if (OFF || !keys.length) {
		const bucket = keys[0]?.[0] ?? "read";
		const limit = limitOf(bucket);
		return { ok: true, limit, remaining: limit, reset: now + RULES[bucket].window };
	}
	const limits = keys.map(([bucket]) => limitOf(bucket));
	const ws = keys.map(([bucket, who]) => current(bucket, who, now));
	const full = ws.findIndex((w, i) => w.count >= limits[i]);
	if (full >= 0) {
		const w = ws[full];
		onRefused?.(keys[full][0], !w.noted);
		w.noted = true;
		return { ok: false, limit: limits[full], remaining: 0, reset: w.reset };
	}
	let tightest: Hit | undefined;
	ws.forEach((w, i) => {
		w.count++;
		if (!tightest || limits[i] - w.count < tightest.remaining) tightest = { ok: true, limit: limits[i], remaining: limits[i] - w.count, reset: w.reset };
	});
	return tightest!;
}

// A thread already spends one post token in the request middleware. Charge
// its additional posts only after validation, using the same shared window.
export class RateLimitError extends Error {
	constructor(public hit: Hit) {
		super("Rate limit exceeded.");
	}
}

export function chargePostCost(viewer: Pick<Viewer, "id" | "role">, cost: number): void {
	if (!Number.isSafeInteger(cost) || cost < 0) throw new RangeError("Post cost must be a nonnegative integer.");
	if (OFF || viewer.role || cost === 0) return;
	const w = current("post", viewer.id, Date.now());
	const limit = limitOf("post");
	// No await between checking and spending: simultaneous requests cannot
	// oversubscribe the budget, and a rejected thread spends no partial cost.
	if (cost > limit - w.count) {
		throw new RateLimitError({ ok: false, limit, remaining: Math.max(0, limit - w.count), reset: w.reset });
	}
	w.count += cost;
}

// counts one request against `bucket` for `who` (an account id or an address)
export const hit = (bucket: Bucket, who: string): Hit => take([[bucket, who]]);

// whether `bucket` is used up for `who`, without counting anything
export function used(bucket: Bucket, who: string): boolean {
	if (OFF) return false;
	const w = windows.get(`${bucket}:${who}`);
	return !!w && w.reset > Date.now() && w.count >= limitOf(bucket);
}

// A password check takes a moment, so its try counts before it runs: checked
// with `used` and counted only once found wrong, tries sent all at once got
// past the limit together. A right password gives its try back.
export function passwordTry(who: string, from: string | null | undefined): (() => void) | undefined {
	const account = who.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
	const keys: [Bucket, string][] = [["password", account], ["password_address", `${account}:${addressKey(from)}`]];
	if (!take(keys).ok) return undefined;
	return () => {
		for (const [bucket, key] of keys) {
			const w = windows.get(`${bucket}:${key}`);
			if (w && w.count > 0) w.count--;
		}
	};
}

export function addressKey(ip: string | null | undefined): string {
	if (!ip) return "unknown";
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
	if (mapped) return mapped[1];
	if (isIP(ip) !== 6) return ip;
	const [head, tail] = ip.split("::");
	const left = head ? head.split(":") : [];
	const right = tail ? tail.split(":") : [];
	const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
	return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(":")}::/64`;
}

export const limitHeaders = (h: Hit) => ({
	"x-rate-limit-limit": String(h.limit),
	"x-rate-limit-remaining": String(h.remaining),
	"x-rate-limit-reset": String(Math.ceil(h.reset / 1000)),
});

export const limitedResponse = (h: Hit) =>
	Response.json({ errors: [{ code: 88, message: "Rate limit exceeded." }] }, { status: 429, headers: { ...limitHeaders(h), "retry-after": String(Math.max(1, Math.ceil((h.reset - Date.now()) / 1000))) } });

const POST_OPS = /^(CreateTweet|CreateNoteTweet|CreateScheduledTweet|CreateDraftTweet|ArticleEntityPublish)$/;
const ENGAGE_OPS = /^(FavoriteTweet|UnfavoriteTweet|CreateRetweet|DeleteRetweet|CreateBookmark|DeleteBookmark|bookmarkTweetToFolder|PinTweet|UnpinTweet)$/;
const ENGAGE_REST = /^\/1\.1\/(friendships\/(create|destroy)|favorites\/(create|destroy)|statuses\/(retweet|unretweet)|bookmark\/entries\/(add|remove))/;
// the 2020 client (adaptive.ts) posts here
const POST_REST = /^\/1\.1\/statuses\/update\.json$/;
const DM_OPS = /XChat|SendMessage|ConversationEvent|GroupConversation/;
// what the client posts on its own all the time (event logging, its error
// reports, read markers): about 40 a minute, which would use up "write" in a
// quarter of an hour of reading
const BACKGROUND = /^\/(1\.1\/(jot|flow|graphql\/app_context|keyregistry)|2\/notifications\/[^/]+\/last_seen_cursor|xitter\/client_error|live_pipeline)/;
const BACKGROUND_OPS = /^(viewer_context\.json|app_context\.json|p2)$/;

// GraphQL reads the client sends as POST (HomeTimeline among them) aren't
// writes. The bundle names each operation's type; chunks arrive lazily from
// the CDN, so the folder is read again now and then.
type OperationFile = {
        version: string;
        queries: Set<string>;
        mutations: Set<string>;
};

type OperationTypes = {
        queries: Set<string>;
        mutations: Set<string>;
};

let scanned = new Map<string, OperationFile>();
let operationTypes: OperationTypes = {
        queries: new Set<string>(),
        mutations: new Set<string>(),
};

const operationPattern = /operationName:"(\w+)",operationType:"(query|mutation)"/g;
let scanning = false;

async function readOperationTypes() {
        if (scanning) return;
        scanning = true;

        try {
                const dir = join(CLIENT_DIR, "abs", "responsive-web", "client-web");
				let files: string[];
				try {
					files = (await readdir(dir)).filter((f) => f.endsWith(".js"));
				} catch (error) {
					// CI and a fresh install have no pinned client yet.
					if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
					throw error;
				}
				
                if (files.length === 0) return;

                const nextScanned = new Map<string, OperationFile>();

                for (const file of files) {
                        const path = join(dir, file);
                        const info = await stat(path);
                        const version = `${info.size}:${info.mtimeMs}`;
                        const cached = scanned.get(path);

                        if (cached?.version === version) {
                                nextScanned.set(path, cached);
                                continue;
                        }

                        const queries = new Set<string>();
                        const mutations = new Set<string>();
                        const decoder = new TextDecoder();
                        let tail = "";

                        for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
                                const text = tail + decoder.decode(chunk, { stream: true });

                                for (const match of text.matchAll(operationPattern)) {
                                        (match[2] === "query" ? queries : mutations).add(match[1]);
                                }

                                tail = text.slice(-512);
                        }

                        const remaining = tail + decoder.decode();

                        for (const match of remaining.matchAll(operationPattern)) {
                                (match[2] === "query" ? queries : mutations).add(match[1]);
                        }

                        nextScanned.set(path, { version, queries, mutations });
                }

                const nextQueries = new Set<string>();
                const nextMutations = new Set<string>();

                for (const file of nextScanned.values()) {
                        for (const operation of file.queries) nextQueries.add(operation);
                        for (const operation of file.mutations) nextMutations.add(operation);
                }

                scanned = nextScanned;
                operationTypes = {
                        queries: nextQueries,
                        mutations: nextMutations,
                };
        } catch (error) {
                console.error("Failed to refresh GraphQL operation types:", error);
        } finally {
                scanning = false;
        }
}

void readOperationTypes().catch((e) => console.error("operation types:", e));

export const isMutation = (operation: string) =>
        operationTypes.mutations.has(operation) ||
        (/Mutation$/.test(operation) && !operationTypes.queries.has(operation));

export const isQuery = (operation: string) => operationTypes.queries.has(operation) && !operationTypes.mutations.has(operation);

setInterval(() => void readOperationTypes().catch((e) => console.error("operation types:", e)), 10 * MIN).unref();

// what the client calls an endpoint for limits: the GraphQL operation, or the
// REST path with its ids folded so one user's calls share a window
const endpointOf = (path: string, operation: string | undefined) => operation ?? path.replace(/\d+/g, "#");

const UPLOAD = /^\/(i|1\.1)\/media\/upload2?\.json$/;

// The buckets one API request counts against, beside "endpoint" for every call
// but upload chunks (a long video sends hundreds) and "read" for every call but
// the background ones.
export function bucketsFor(method: string, path: string, operation: string | undefined, url: URL): Bucket[] {
	if (UPLOAD.test(path)) return url.searchParams.get("command") === "INIT" ? ["read", "upload"] : ["read"];
	if (BACKGROUND.test(path) || (operation && BACKGROUND_OPS.test(operation))) return [];
	if (operation) {
		if (POST_OPS.test(operation)) return ["read", "post"];
		if (ENGAGE_OPS.test(operation)) return ["read", "engage"];
		if (DM_OPS.test(operation)) return method === "GET" ? ["read"] : ["read", "dm"];
		return method === "GET" || (operationTypes.queries.has(operation) && !operationTypes.mutations.has(operation)) ? ["read"] : ["read", "write"];
	}
	if (POST_REST.test(path)) return ["read", "post"];
	if (ENGAGE_REST.test(path)) return ["read", "engage"];
	if (/\/translation\/service\/translate(Tweet|Profile)$/.test(path)) return ["read", "translate"];
	return method === "GET" ? ["read"] : ["read", "write"];
}

// Counts an API request; a response when one of its limits is used up.
export function limitApi(viewer: Viewer, method: string, path: string, operation: string | undefined, url: URL): Response | undefined {
	if (viewer.role) return undefined;
	const endpoint = endpointOf(path, operation);
	const keys = bucketsFor(method, path, operation, url).map((b): [Bucket, string] => [b, viewer.id]);
	if (!UPLOAD.test(path)) keys.unshift(["endpoint", `${viewer.id}:${endpoint}`]);
	const h = take(keys, (bucket, first) => {
		if (first) noteRefusal(bucket, endpoint, viewer.id);
	});
	if (!h.ok) return limitedResponse(h);
}

// The server log and Admin > Errors get one line per used-up bucket and
// endpoint, once per window, so staff can see which limit people run into and on what.
export function noteRefusal(bucket: Bucket, endpoint: string, userId: string) {
	const per = `${limitOf(bucket)} per ${RULES[bucket].window / MIN} minutes`;
	console.log(`rate limit: ${bucket} used up by ${userId} on ${endpoint} (${per})`);
	// imported here so the limits stay free of the database for scripts that read RULES
	void import("./errors").then(({ recordError }) => recordError("server", new Error(`Rate limit ${bucket} (${per}) used up, on ${endpoint}`), { path: endpoint, userId })).catch((e) => console.error("rate limit error log:", e));
}
