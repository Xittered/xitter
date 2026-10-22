import { type KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { settings } from "./settings";
import { isSuperadminHome, pinnedHomeKey } from "./superadmins";
import { MIGRATION_FORMAT_VERSION, SCHEMA, VERSION } from "./version";

export const PROTOCOL = 1;
export const INSTANCE_ID = new URL(PUBLIC_ORIGIN).host.toLowerCase();
export const FEDERATION_ON = process.env.FEDERATION !== "off";
const KEY_FILE = process.env.FEDERATION_KEY_FILE ?? "data/federation-key.json";
const REGISTRY_URL = process.env.FEDERATION_REGISTRY_URL ?? "https://raw.githubusercontent.com/Xittered/xitter/main/instances.json";
const BUNDLED_REGISTRY = join(import.meta.dir, "..", "instances.json");
const SCHEME = process.env.FEDERATION_ALLOW_HTTP ? "http" : "https";
const CLOCK_SKEW_MS = 5 * 60_000;
const MAX_BODY = 4 * 1024 * 1024;

export const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();

let signingKey: KeyObject | undefined;
function key(): KeyObject {
	if (signingKey) return signingKey;
	if (existsSync(KEY_FILE)) {
		signingKey = createPrivateKey(JSON.parse(readFileSync(KEY_FILE, "utf8")).private);
		return signingKey;
	}
	const { privateKey } = generateKeyPairSync("ed25519");
	mkdirSync(dirname(KEY_FILE), { recursive: true });
	writeFileSync(KEY_FILE, JSON.stringify({ private: privateKey.export({ type: "pkcs8", format: "pem" }) }), { mode: 0o600 });
	signingKey = privateKey;
	return privateKey;
}

export const publicKey = () => createPublicKey(key()).export({ format: "jwk" }).x as string;

const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const keyObjects = new Map<string, KeyObject>();
function publicKeyObject(x: string): KeyObject | undefined {
	if (!KEY_RE.test(x)) return undefined;
	let k = keyObjects.get(x);
	if (!k) {
		k = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
		if (keyObjects.size > 1000) keyObjects.clear();
		keyObjects.set(x, k);
	}
	return k;
}

export const signBytes = (bytes: Uint8Array | string) => b64url(sign(null, Buffer.from(bytes), key()));

export function verifyBytes(publicKeyB64: string, bytes: Uint8Array | string, signature: string): boolean {
	const k = publicKeyObject(publicKeyB64);
	if (!k || !/^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
	try {
		return verify(null, Buffer.from(bytes), k, Buffer.from(signature, "base64url"));
	} catch {
		return false;
	}
}

export type InstanceState = "active" | "suspended" | "blocked";
export type Listed = { id: string; name: string; source_url: string | null; public_key: string | null; state: InstanceState };
type Registry = { version: 1; sequence: number; instances: Listed[] };

export const ID_RE = /^(?=.{1,253}(?::\d{1,5})?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/;
export const baseUrl = (id: string) => `${SCHEME}://${id}`;

function parseRegistry(raw: unknown): Registry | undefined {
	const r = raw as Registry;
	if (!r || r.version !== 1 || !Number.isSafeInteger(r.sequence) || r.sequence < 0 || !Array.isArray(r.instances) || r.instances.length > 10_000) return undefined;
	const seen = new Set<string>();
	const instances: Listed[] = [];
	for (const i of r.instances) {
		if (typeof i?.id !== "string" || !ID_RE.test(i.id) || seen.has(i.id)) return undefined;
		if (!["active", "suspended", "blocked"].includes(i.state)) return undefined;
		if (i.public_key !== null && (typeof i.public_key !== "string" || !KEY_RE.test(i.public_key))) return undefined;
		seen.add(i.id);
		instances.push({
			id: i.id,
			name: typeof i.name === "string" ? i.name.slice(0, 50) : i.id,
			source_url: typeof i.source_url === "string" && /^https:\/\//.test(i.source_url) ? i.source_url.slice(0, 300) : null,
			public_key: i.public_key,
			state: i.state,
		});
	}
	return { version: 1, sequence: r.sequence, instances };
}

let registry: Registry = parseRegistry(JSON.parse(readFileSync(BUNDLED_REGISTRY, "utf8"))) ?? { version: 1, sequence: 0, instances: [] };
export let registryCheckedAt = 0;
export let registryError: string | null = null;

export const listed = () => registry.instances;
export const registrySequence = () => registry.sequence;
export const listedInstance = (id: string) => registry.instances.find((i) => i.id === id);

async function fetchRegistry(): Promise<unknown> {
	if (REGISTRY_URL.startsWith("/")) return JSON.parse(readFileSync(REGISTRY_URL, "utf8"));
	const r = await fetch(REGISTRY_URL, { redirect: "error", signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } });
	if (!r.ok) throw new Error(`registry answered ${r.status}`);
	return JSON.parse(new TextDecoder().decode(await readLimited(r, 2 * 1024 * 1024)));
}

export async function refreshRegistry() {
	try {
		const next = parseRegistry(await fetchRegistry());
		if (!next) throw new Error("the registry document isn't valid");
		if (next.sequence < registry.sequence) throw new Error(`the registry went back from sequence ${registry.sequence} to ${next.sequence}`);
		registry = next;
		await sql`insert into federation_state (key, value) values ('registry', ${JSON.stringify(next)}::text::jsonb)
			on conflict (key) do update set value = excluded.value, updated_at = now()`;
		registryError = null;
	} catch (e) {
		registryError = e instanceof Error ? e.message : String(e);
	}
	registryCheckedAt = Date.now();
	await syncRegistryBlocks();
}

export async function loadRegistry() {
	const [stored] = await sql`select value from federation_state where key = 'registry'`;
	const saved = stored && parseRegistry(stored.value);
	if (saved && saved.sequence >= registry.sequence) registry = saved;
	await syncRegistryBlocks();
}

export type Block = { instance: string; source: "local" | "emergency" | "registry"; reason: string; by_name: string | null; created_at: Date };
let blocked = new Set<string>();

export async function reloadBlocks() {
	blocked = new Set((await sql`select instance from federation_blocks`).map((r: any) => r.instance as string));
	await sql`update users set instance_blocked = (instance in (select instance from federation_blocks))
		where instance is not null and instance_blocked is distinct from (instance in (select instance from federation_blocks))`;
}

async function syncRegistryBlocks() {
	const active = registry.instances.filter((i) => i.state === "active").map((i) => i.id);
	const known = (await sql`select distinct instance from users where instance is not null`).map((r: any) => r.instance as string);
	const off = [...new Set([...registry.instances.filter((i) => i.state !== "active").map((i) => i.id), ...known.filter((i: string) => !active.includes(i))])];
	await sql`delete from federation_blocks where source = 'registry' and not (instance = any(${sql.array(off, "TEXT")}))`;
	if (off.length)
		await sql`insert into federation_blocks (instance, source, reason)
			select x, 'registry', 'Not active on the instance list' from unnest(${sql.array(off, "TEXT")}::text[]) x on conflict (instance) do nothing`;
	await reloadBlocks();
}

export const isBlocked = (instance: string) => blocked.has(instance);

export async function setBlock(instance: string, source: "local" | "emergency", reason: string, by: { id?: string | null; name?: string | null }) {
	await sql`insert into federation_blocks (instance, source, reason, by_id, by_name) values (${instance}, ${source}, ${reason.slice(0, 500)}, ${by.id ?? null}::bigint, ${by.name ?? null})
		on conflict (instance) do update set
			kept_local = case
				when federation_blocks.source = 'emergency' and excluded.source = 'local' then jsonb_build_object('reason', excluded.reason, 'by_id', excluded.by_id::text, 'by_name', excluded.by_name)
				when federation_blocks.source = 'local' and excluded.source = 'emergency' then jsonb_build_object('reason', federation_blocks.reason, 'by_id', federation_blocks.by_id::text, 'by_name', federation_blocks.by_name)
				else federation_blocks.kept_local end,
			source = case when federation_blocks.source = 'emergency' then 'emergency' else excluded.source end,
			reason = case when federation_blocks.source = 'emergency' and excluded.source = 'local' then federation_blocks.reason else excluded.reason end,
			by_id = case when federation_blocks.source = 'emergency' and excluded.source = 'local' then federation_blocks.by_id else excluded.by_id end,
			by_name = case when federation_blocks.source = 'emergency' and excluded.source = 'local' then federation_blocks.by_name else excluded.by_name end,
			created_at = case when federation_blocks.source = 'emergency' and excluded.source = 'local' then federation_blocks.created_at else now() end`;
	await reloadBlocks();
}

export async function liftBlock(instance: string, source: "local" | "emergency") {
	if (source === "emergency")
		await sql`update federation_blocks set source = 'local', reason = coalesce(kept_local->>'reason', ''), by_id = (kept_local->>'by_id')::bigint,
			by_name = kept_local->>'by_name', kept_local = null, created_at = now() where instance = ${instance} and source = 'emergency' and kept_local is not null`;
	await sql`delete from federation_blocks where instance = ${instance} and source = ${source}`;
	await syncRegistryBlocks();
}

export const listBlocks = async () => (await sql`select instance, source, reason, by_name, created_at from federation_blocks order by created_at desc`) as Block[];

export function peers(): Listed[] {
	if (!FEDERATION_ON) return [];
	return registry.instances.filter((i) => i.state === "active" && i.id !== INSTANCE_ID && !blocked.has(i.id));
}

export const isPeer = (id: string) => peers().some((p) => p.id === id);

export class CappedRead extends Error {
	readonly kind = "capped" as const;
	constructor() {
		super("the answer is too large");
		this.name = "CappedRead";
	}
}

// a streamed body with no length is not a file we can pass through
export function declaredLength(header: string | null, max: number): number | undefined {
	if (header === null || header.trim() === "") return undefined;
	const n = Number(header);
	if (!Number.isFinite(n) || n < 1 || n > max) return undefined;
	return n;
}

export async function readLimited(r: Response, max: number): Promise<Uint8Array> {
	const declared = Number(r.headers.get("content-length") ?? "0");
	if (declared > max) throw new CappedRead();
	const reader = r.body?.getReader();
	if (!reader) return new Uint8Array();
	const parts: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.length;
		if (size > max) {
			await reader.cancel().catch(() => {});
			throw new CappedRead();
		}
		parts.push(value);
	}
	return Buffer.concat(parts);
}

export async function readJson(r: Response, max: number): Promise<any> {
	return JSON.parse(new TextDecoder().decode(await readLimited(r, max)));
}

const wellKnownKeys = new Map<string, { key: string; at: number }>();

async function wellKnownKey(id: string): Promise<string | undefined> {
	const hit = wellKnownKeys.get(id);
	if (hit && Date.now() - hit.at < 5 * 60_000) return hit.key;
	const r = await fetch(`${baseUrl(id)}/.well-known/xitter`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
	if (!r?.ok) return undefined;
	const doc = JSON.parse(new TextDecoder().decode(await readLimited(r, 64 * 1024)).trim() || "{}");
	if (doc.id !== id || typeof doc.public_key !== "string" || !KEY_RE.test(doc.public_key)) return undefined;
	wellKnownKeys.set(id, { key: doc.public_key, at: Date.now() });
	return doc.public_key;
}

export async function keyFor(id: string): Promise<string | undefined> {
	const hardcoded = pinnedHomeKey(id);
	if (hardcoded) return hardcoded;
	const listedKey = listedInstance(id)?.public_key;
	const home = isSuperadminHome(id);
	if (listedKey && !home) return listedKey;
	const [pinned] = await sql`select key from federation_peers where instance = ${id}`;
	if (pinned?.key) return pinned.key;
	const live = await wellKnownKey(id).catch(() => undefined);
	const seen = home ? (listedKey && live !== listedKey ? undefined : live) : (listedKey ?? live);
	if (!seen) return undefined;
	await sql`insert into federation_peers (instance, key) values (${id}, ${seen}) on conflict (instance) do update set key = coalesce(federation_peers.key, excluded.key)`;
	const [kept] = await sql`select key from federation_peers where instance = ${id}`;
	return kept?.key ?? undefined;
}

export async function pendingKeyChange(id: string): Promise<string | undefined> {
	if (pinnedHomeKey(id)) return undefined;
	const listedKey = listedInstance(id)?.public_key;
	if (listedKey && !isSuperadminHome(id)) return undefined;
	const [pinned] = await sql`select key from federation_peers where instance = ${id}`;
	const live = listedKey ?? (await wellKnownKey(id).catch(() => undefined));
	return pinned?.key && live && live !== pinned.key ? live : undefined;
}

export async function acceptKeyChange(id: string) {
	wellKnownKeys.delete(id);
	const next = (isSuperadminHome(id) && listedInstance(id)?.public_key) || (await wellKnownKey(id));
	if (!next) throw new Error("that instance doesn't publish a key");
	await sql`update federation_peers set key = ${next} where instance = ${id}`;
}

const requestText = (method: string, path: string, from: string, to: string, ts: string, nonce: string, body: Uint8Array) =>
	`xitter-federation-v${PROTOCOL}\nrequest\n${method}\n${path}\n${from}\n${to}\n${ts}\n${nonce}\n${b64url(sha256(body))}`;
const responseText = (from: string, to: string, nonce: string, status: number, body: Uint8Array) =>
	`xitter-federation-v${PROTOCOL}\nresponse\n${from}\n${to}\n${nonce}\n${status}\n${b64url(sha256(body))}`;

export class FederationError extends Error {}

export async function signedFetch(to: string, method: "GET" | "POST", path: string, body?: unknown, max = MAX_BODY, opts: { anyListed?: boolean } = {}): Promise<{ status: number; body: Uint8Array; json: () => any }> {
	if (!isPeer(to) && !(isSuperadminHome(to) && listedInstance(to)?.state !== "blocked") && !(opts.anyListed && listedInstance(to)?.state === "active" && FEDERATION_ON)) throw new FederationError(`${to} isn't an instance this one federates with`);
	const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(JSON.stringify(body));
	const ts = String(Date.now());
	const nonce = b64url(randomBytes(16));
	const r = await fetch(`${baseUrl(to)}${path}`, {
		method,
		redirect: "manual",
		signal: AbortSignal.timeout(20_000),
		headers: {
			"content-type": "application/json",
			"x-xitter-from": INSTANCE_ID,
			"x-xitter-to": to,
			"x-xitter-timestamp": ts,
			"x-xitter-nonce": nonce,
			"x-xitter-signature": signBytes(requestText(method, path, INSTANCE_ID, to, ts, nonce, bytes)),
		},
		body: method === "POST" ? bytes : undefined,
	});
	const answer = await readLimited(r, max);
	const theirKey = await keyFor(to);
	const signature = r.headers.get("x-xitter-signature") ?? "";
	if (!theirKey || !verifyBytes(theirKey, responseText(to, INSTANCE_ID, nonce, r.status, answer), signature)) throw new FederationError(`${to} sent an answer without a valid signature (${r.status})`);
	return { status: r.status, body: answer, json: () => JSON.parse(new TextDecoder().decode(answer)) };
}

const nonces = new Map<string, number>();
setInterval(() => {
	const now = Date.now();
	for (const [n, at] of nonces) if (now - at > 2 * CLOCK_SKEW_MS) nonces.delete(n);
}, 60_000).unref();

export type Incoming = { from: string; nonce: string; body: Uint8Array; json: () => any };

export async function verifyIncoming(req: Request, path: string, opts: { allowSuperadminHome?: boolean; allowListed?: boolean } = {}): Promise<Incoming | Response> {
	const fail = (status: number, error: string) => Response.json({ error }, { status });
	const from = req.headers.get("x-xitter-from") ?? "";
	const to = req.headers.get("x-xitter-to") ?? "";
	const ts = req.headers.get("x-xitter-timestamp") ?? "";
	const nonce = req.headers.get("x-xitter-nonce") ?? "";
	const signature = req.headers.get("x-xitter-signature") ?? "";
	if (!FEDERATION_ON) return fail(404, "Federation is off here.");
	if (to !== INSTANCE_ID) return fail(421, "This request is for another instance.");
	if (!ID_RE.test(from) || !/^\d{13}$/.test(ts) || !/^[A-Za-z0-9_-]{22}$/.test(nonce)) return fail(400, "Malformed federation headers.");
	if (!isPeer(from) && !(opts.allowSuperadminHome && isSuperadminHome(from) && listedInstance(from)?.state !== "blocked") && !(opts.allowListed && listedInstance(from)?.state === "active"))
		return fail(403, `${INSTANCE_ID} doesn't federate with ${from}.`);
	if (Math.abs(Date.now() - Number(ts)) > CLOCK_SKEW_MS) return fail(401, "The request's clock is too far off.");
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY) return fail(413, "The request is too large.");
	const body = new Uint8Array(await req.arrayBuffer());
	if (body.length > MAX_BODY) return fail(413, "The request is too large.");
	const theirKey = await keyFor(from);
	if (!theirKey) return fail(401, `No key is known for ${from}.`);
	if (!verifyBytes(theirKey, requestText(req.method, path, from, to, ts, nonce, body), signature)) return fail(401, "The signature doesn't match.");
	const seen = `${from} ${nonce}`;
	if (nonces.has(seen)) return fail(409, "That request was already used.");
	nonces.set(seen, Date.now());
	return { from, nonce, body, json: () => JSON.parse(new TextDecoder().decode(body) || "{}") };
}

export function signedAnswer(incoming: Incoming, status: number, value: unknown): Response {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return new Response(bytes, {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", "x-xitter-signature": signBytes(responseText(INSTANCE_ID, incoming.from, incoming.nonce, status, bytes)) },
	});
}

export function signedRawAnswer(incoming: Incoming, status: number, bytes: Uint8Array, type: string): Response {
	return new Response(bytes, {
		status,
		headers: { "content-type": type, "cache-control": "no-store", "x-xitter-signature": signBytes(responseText(INSTANCE_ID, incoming.from, incoming.nonce, status, bytes)) },
	});
}

let peerStatus: { at: number; peers: { id: string; federating: boolean; last_sync_at: string | null }[] } = { at: 0, peers: [] };

export async function wellKnown(): Promise<Response> {
	if (FEDERATION_ON && Date.now() - peerStatus.at > 30_000) {
		const rows = await sql`select instance, last_ok_at from federation_peers`.catch(() => []);
		const synced = new Map<string, Date | null>(rows.map((r: { instance: string; last_ok_at: Date | null }) => [r.instance, r.last_ok_at]));
		peerStatus = {
			at: Date.now(),
			peers: listed()
				.filter((i) => i.id !== INSTANCE_ID)
				.map((i) => ({ id: i.id, federating: isPeer(i.id), last_sync_at: synced.get(i.id)?.toISOString() ?? null })),
		};
	}
	return Response.json(
		{ protocol: PROTOCOL, software: "xitter", version: VERSION, schema: SCHEMA, migration: { format_version: MIGRATION_FORMAT_VERSION }, id: INSTANCE_ID, url: PUBLIC_ORIGIN, public_key: publicKey(), rules: !!settings().rules.trim(), rules_url: `${PUBLIC_ORIGIN}/rules`, federation: { enabled: FEDERATION_ON, peers: FEDERATION_ON ? peerStatus.peers : [] } },
		{ headers: { "cache-control": "public, max-age=60", "access-control-allow-origin": "*" } },
	);
}

export const sameText = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export type Envelope = { payload: string; signature: string; key_id: string };

export function seal(value: unknown): Envelope {
	const payload = Buffer.from(JSON.stringify(value));
	return { payload: b64url(payload), signature: signBytes(Buffer.concat([Buffer.from("xitter-envelope-v1\n"), payload])), key_id: INSTANCE_ID };
}

export function open(envelope: unknown, publicKeyB64: string): any {
	const e = envelope as Envelope;
	if (typeof e?.payload !== "string" || typeof e.signature !== "string" || e.payload.length > 64 * 1024) return undefined;
	const payload = Buffer.from(e.payload, "base64url");
	if (!verifyBytes(publicKeyB64, Buffer.concat([Buffer.from("xitter-envelope-v1\n"), payload]), e.signature)) return undefined;
	try {
		return JSON.parse(payload.toString("utf8"));
	} catch {
		return undefined;
	}
}

