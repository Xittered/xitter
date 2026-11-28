// Browser push (Settings > Notifications > Push notifications).
//
// The client subscribes with a hard-coded VAPID key, X's; patch.ts swaps it for
// this instance's own (data/push-vapid.json, made on first start), and /sw.js
// is our service worker, which only shows what we push. Subscriptions arrive
// through notifications/settings/{login,checkin,save,logout} with their
// endpoint and keys, and keep the per-type switches of the settings screen.
// Messages are encrypted for the browser (RFC 8291, aes128gcm) and signed for
// its push service (RFC 8292, VAPID).

import { createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, createCipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PUBLIC_HOSTNAME, PUBLIC_ORIGIN } from "./config";
import { holdLock, sql } from "./db";
import { newId } from "./ids";
import { mailFrom } from "./mail";
import { type PushItem, pushItems, unreadCount } from "./notifications";
import { OFFLINE_PAGE } from "./pwa";
import { settings } from "./settings";

const KEY_FILE = "data/push-vapid.json";
const b64url = (b: Buffer | Uint8Array) => Buffer.from(b).toString("base64url");

function loadKeys(): { publicKey: Buffer; privatePem: string } {
	if (existsSync(KEY_FILE)) {
		const k = JSON.parse(readFileSync(KEY_FILE, "utf8"));
		return { publicKey: Buffer.from(k.publicKey, "base64url"), privatePem: k.privatePem };
	}
	const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
	const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
	const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
	const privatePem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
	mkdirSync("data", { recursive: true });
	writeFileSync(KEY_FILE, JSON.stringify({ publicKey: b64url(raw), privatePem }, null, "\t"), { mode: 0o600 });
	return { publicKey: raw, privatePem };
}

const keys = loadKeys();
// the 65-byte uncompressed point the client passes to pushManager.subscribe
export const vapidPublicKey = keys.publicKey;

// RFC 8291: one aes128gcm record for the subscriber's keys
// (`fixed`: the sender key and salt, only for the RFC's worked example in scripts/test-push-crypto.ts)
export function encryptPayload(payload: Buffer, p256dh: Buffer, auth: Buffer, fixed?: { privateKey: Buffer; salt: Buffer }): Buffer {
	const ecdh = createECDH("prime256v1");
	if (fixed) ecdh.setPrivateKey(fixed.privateKey);
	const asPublic = fixed ? ecdh.getPublicKey() : ecdh.generateKeys();
	const shared = ecdh.computeSecret(p256dh);
	const ikm = Buffer.from(hkdfSync("sha256", shared, auth, Buffer.concat([Buffer.from("WebPush: info\0"), p256dh, asPublic]), 32));
	const salt = fixed?.salt ?? randomBytes(16);
	const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
	const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	// 0x02 marks the last (only) record
	const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
	const rs = Buffer.alloc(4);
	rs.writeUInt32BE(4096);
	return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

const signingKey = createPrivateKey(keys.privatePem);
// one token per push service, reused while it has hours left (it is good for 12)
const tokens = new Map<string, { header: string; until: number }>();

// RFC 8292: a short-lived token for the push service the endpoint belongs to
function vapidHeader(endpoint: string): string {
	const aud = new URL(endpoint).origin;
	const cached = tokens.get(aud);
	if (cached && cached.until > Date.now()) return cached.header;
	const from = mailFrom();
	const mail = /<([^>]+)>/.exec(from)?.[1] ?? from;
	const claims = { aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: mail.includes("@") ? `mailto:${mail}` : PUBLIC_ORIGIN };
	const unsigned = `${b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${b64url(Buffer.from(JSON.stringify(claims)))}`;
	const signature = sign("sha256", Buffer.from(unsigned), { key: signingKey, dsaEncoding: "ieee-p1363" });
	const header = `vapid t=${unsigned}.${b64url(signature)}, k=${b64url(keys.publicKey)}`;
	tokens.set(aud, { header, until: Date.now() + 6 * 3600_000 });
	return header;
}

type Subscription = { id: string; user_id: string; endpoint: string; p256dh: string; auth: string; settings: Record<string, string>; last_pushed_at: Date };

// Sends one message; a subscription the push service says is gone is dropped.
export function subscriptionKeysValid(p256dh: string, auth: string): boolean {
	const point = Buffer.from(p256dh, "base64url");
	if (point.length !== 65 || point[0] !== 4 || Buffer.from(auth, "base64url").length !== 16) return false;
	try {
		const ecdh = createECDH("prime256v1");
		ecdh.generateKeys();
		ecdh.computeSecret(point);
		return true;
	} catch {
		return false;
	}
}

export async function pushTo(sub: Pick<Subscription, "id" | "endpoint" | "p256dh" | "auth">, message: { title: string; body: string; url: string; tag?: string; count?: number }): Promise<boolean> {
	let body: Buffer;
	try {
		body = encryptPayload(Buffer.from(JSON.stringify({ ...message, icon: `${PUBLIC_ORIGIN}/public/app-icon.png`, badge: `${PUBLIC_ORIGIN}/public/notification-badge.png` })), Buffer.from(sub.p256dh, "base64url"), Buffer.from(sub.auth, "base64url"));
	} catch {
		await sql`delete from push_subscriptions where id = ${sub.id}::bigint`;
		return false;
	}
	const r = await fetch(sub.endpoint, {
		method: "POST",
		headers: { authorization: vapidHeader(sub.endpoint), "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "normal" },
		body,
		signal: AbortSignal.timeout(10_000),
	}).catch(() => undefined);
	if (r && (r.status === 404 || r.status === 410)) await sql`delete from push_subscriptions where id = ${sub.id}::bigint`;
	return !!r?.ok;
}

// The settings screen's switches, X's template format. Values are "on"/"off".
const TEMPLATE = {
	checksum: "xitter-2",
	template: {
		settings: [
			{
				section_header: "Related to you and your posts",
				section_entries: [
					{ id: "mentions", name: "Mentions and replies", control_type: "on_off", scribe_component: "mentions" },
					{ id: "retweets", name: "Reposts", control_type: "on_off", scribe_component: "retweets" },
					{ id: "favorites", name: "Likes", control_type: "on_off", scribe_component: "favorites" },
					{ id: "followed", name: "New followers", control_type: "on_off", scribe_component: "followed" },
					{ id: "tweets", name: "Posts", control_type: "tweet_control", scribe_component: "tweets" },
					{ id: "direct_messages", name: "Direct messages", control_type: "on_off", scribe_component: "direct_messages" },
					{ id: "money", name: "Equicoins", control_type: "on_off", scribe_component: "money" },
				],
			},
			{
				section_header: `From ${settings().instance_name}`,
				section_entries: [{ id: "staff", name: "Messages from the team", control_type: "on_off", scribe_component: "staff" }],
			},
		],
	},
};
const DEFAULTS: Record<string, string> = { mentions: "on", retweets: "on", favorites: "on", followed: "on", tweets: "on", direct_messages: "on", money: "on", staff: "on" };
// which switch each kind of notification answers to
const SWITCH: Record<PushItem["kind"], string> = { reply: "mentions", mention: "mentions", quote: "mentions", repost: "retweets", like: "favorites", follow: "followed", bell: "tweets", staff: "staff", money: "money" };

const settingsReply = (current: Record<string, string>) => ({
	push_settings: { ...DEFAULTS, ...current },
	push_settings_template: TEMPLATE,
	checkin_time: Date.now() + 24 * 3600_000,
});

// The server POSTs to whatever endpoint a browser hands it, so only the
// browsers' own push services are taken (Chrome, Firefox, Edge, Safari); on a
// local instance also local ones, for scripts/test-push.ts.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
function pushService(url: string): boolean {
	try {
		const u = new URL(url);
		if (u.protocol === "https:" && PUSH_HOSTS.some((re) => re.test(u.hostname))) return true;
		return PUBLIC_HOSTNAME === "localhost" && u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
	} catch {
		return false;
	}
}

type DeviceInfo = { token?: string; encryption_key1?: string; encryption_key2?: string; settings?: Record<string, unknown> };
const deviceInfo = (body: any): DeviceInfo => body?.push_device_info ?? body?.web_device_info ?? body ?? {};
const cleanSettings = (s: Record<string, unknown> = {}) =>
	Object.fromEntries(Object.entries(s).filter(([k, v]) => k in DEFAULTS && (v === "on" || v === "off")) as [string, string][]);

// `path` is notifications/settings/<action>
export async function pushSettingsRoute(viewerId: string, action: string, body: unknown): Promise<Response | undefined> {
	const d = deviceInfo(body);
	const endpoint = typeof d.token === "string" && pushService(d.token) ? d.token : null;
	if (action === "logout") {
		if (endpoint) await sql`delete from push_subscriptions where user_id = ${viewerId}::bigint and endpoint = ${endpoint}`;
		return Response.json({});
	}
	const keysFit = [d.encryption_key1, d.encryption_key2].every((k) => typeof k === "string" && k.length <= 256) && (endpoint?.length ?? 0) <= 2048 && subscriptionKeysValid(d.encryption_key1 as string, d.encryption_key2 as string);
	if (action === "login" && endpoint && keysFit && d.encryption_key1 && d.encryption_key2) {
		await sql.begin(async (tx) => {
			await holdLock(tx, `push:${viewerId}`);
			const [subs] = await tx`select count(*)::int as n from push_subscriptions where user_id = ${viewerId}::bigint`;
			if (subs.n >= 50) return;
			await tx`insert into push_subscriptions (id, user_id, endpoint, p256dh, auth) values (${newId()}::bigint, ${viewerId}::bigint, ${endpoint}, ${d.encryption_key1}, ${d.encryption_key2})
				on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`;
		});
	}
	if (action === "save" && endpoint)
		await sql`update push_subscriptions set settings = settings || ${JSON.stringify(cleanSettings(d.settings as Record<string, unknown>))}::text::jsonb
			where user_id = ${viewerId}::bigint and endpoint = ${endpoint}`;
	if (!["login", "checkin", "save"].includes(action)) return undefined;
	const [sub] = endpoint ? await sql`select settings from push_subscriptions where user_id = ${viewerId}::bigint and endpoint = ${endpoint}` : [];
	return Response.json(settingsReply(sub?.settings ?? {}));
}

// More than this at once becomes one "N new notifications" push.
const BURST = 3;

// a pass that outlasts the interval would otherwise start again on top of itself
let pushing = false;

export async function pushDue(): Promise<number> {
	if (pushing) return 0;
	pushing = true;
	try {
		const subs = (await sql`select id::text, user_id::text, endpoint, p256dh, auth, settings, last_pushed_at from push_subscriptions`) as Subscription[];
		let sent = 0;
		// an account's notifications are worked out once for all its browsers,
		// from the one pushed to longest ago (items newest first, so each
		// browser's share is what it would have got on its own)
		for (const [userId, own] of Map.groupBy(subs, (s) => s.user_id)) {
			const found = await pushItems(userId, Math.min(...own.map((s) => new Date(s.last_pushed_at).getTime()))).catch((e) => {
				console.error(`push: notifications for ${userId} failed:`, e instanceof Error ? e.message : e);
				return undefined;
			});
			if (!found) continue;
			for (const sub of own) {
				try {
					sent += await pushOne(sub, found);
				} catch (e) {
					console.error(`push: subscription ${sub.id} failed:`, e instanceof Error ? e.message : e);
				}
			}
		}
		return sent;
	} finally {
		pushing = false;
	}
}

async function pushOne(sub: Subscription, found: Awaited<ReturnType<typeof pushItems>>): Promise<number> {
	let sent = 0;
	const on = (k: string) => ({ ...DEFAULTS, ...sub.settings })[k] !== "off";
	const since = new Date(sub.last_pushed_at).getTime();
	const items = found.filter((i) => i.at > since && on(SWITCH[i.kind]));
	const messages = on("direct_messages") ? await newMessages(sub.user_id, sub.last_pushed_at) : [];
	const all = [...items, ...messages].sort((a, b) => a.at - b.at);
	if (!all.length) return 0;
	await sql`update push_subscriptions set last_pushed_at = ${new Date(Math.max(...all.map((i) => i.at)) + 1)} where id = ${sub.id}::bigint`;
	const name = settings().instance_name;
	// for the installed app's icon badge
	const count = await unreadCount(sub.user_id);
	const out = all.length > BURST ? [{ title: name, body: `${all.length} new notifications`, url: "/notifications", tag: "summary", count }] : all.map((i) => ({ title: name, body: i.text, url: i.url, tag: i.key, count }));
	for (const m of out) if (await pushTo(sub, m)) sent++;
	return sent;
}

// who wrote since `after` (chat is end-to-end encrypted: never what)
async function newMessages(userId: string, after: Date): Promise<(PushItem & { kind: "staff" })[]> {
	const rows = await sql`select e.seq::text, s.screen_name, s.name, e.created_at from chat_events e
		join chat_members m on m.conversation_id = e.conversation_id and m.user_id = ${userId}::bigint and m.accepted and not m.muted
		join users s on s.id = e.sender_id
		where e.kind = 1 and e.sender_id <> ${userId}::bigint and e.created_at > ${after}
			and not exists (select 1 from blocks b where b.blocker_id = ${userId}::bigint and b.blocked_id = e.sender_id)
		order by e.created_at limit 20`;
	return rows.map((r: any) => ({ kind: "staff" as const, key: `dm-${r.seq}`, at: new Date(r.created_at).getTime(), text: `${r.name || r.screen_name} sent you a message`, url: "/i/chat" }));
}

export function startPush() {
	setInterval(() => void pushDue().catch((e) => console.error("push:", e)), 15_000).unref();
}

// Our service worker, at /sw.js where the client registers it. Pages come from
// the network as before; only when that fails (no connection) does it answer
// with a page saying so, so the installed app doesn't show the browser's error.
export const SERVICE_WORKER = `const OFFLINE = ${JSON.stringify(OFFLINE_PAGE)};
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(Promise.all([self.clients.claim(), self.registration.navigationPreload && self.registration.navigationPreload.enable()])));
self.addEventListener("fetch", (e) => {
	if (e.request.mode !== "navigate" || e.request.method !== "GET") return;
	e.respondWith((async () => {
		try {
			return (await e.preloadResponse) || (await fetch(e.request));
		} catch {
			return new Response(OFFLINE, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } });
		}
	})());
});
self.addEventListener("push", (e) => {
	let d = {};
	try { d = e.data ? e.data.json() : {}; } catch {}
	const badge = typeof d.count === "number" && self.navigator.setAppBadge ? (d.count ? self.navigator.setAppBadge(d.count) : self.navigator.clearAppBadge()).catch(() => {}) : Promise.resolve();
	e.waitUntil(Promise.all([badge, self.registration.showNotification(d.title || "New notification", { body: d.body || "", icon: d.icon, badge: d.badge, tag: d.tag, timestamp: Date.now(), data: { url: d.url || "/notifications" } })]));
});
self.addEventListener("notificationclick", (e) => {
	e.notification.close();
	const url = new URL((e.notification.data && e.notification.data.url) || "/notifications", self.location.origin).href;
	e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
		for (const w of wins) if (w.url.startsWith(self.location.origin) && "focus" in w) { w.navigate(url); return w.focus(); }
		return self.clients.openWindow(url);
	}));
});
`;
