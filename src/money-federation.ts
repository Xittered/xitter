// Home instances hold wallets. Cross-instance payments use a durable outbox:
// the sender debits once, and the recipient credits once after a signed request.
import { sql } from "./db";
import { INSTANCE_ID, isPeer, peers, signedAnswer, signedFetch, type Incoming } from "./federation";
import { newId } from "./ids";
import { BADGE_TYPES, sniffImage } from "./media";
import { hateIn } from "./hate";
import { feature, hasBlockedPhrase, settings } from "./settings";

let pumping = false;
// a moved balance is taken up to this many times the largest payment
const MOVE_CAP = 100;
// and all of one peer's moves in a day, in full-size moves (most are far smaller)
// a transfer the peer hasn't taken after this long fails and goes back to the sender
const GIVE_UP_AFTER = "3 days";

export async function discoverMoneyAccount(value: string): Promise<void> {
	const m = /^([A-Za-z0-9_]{1,15})@([a-z0-9.-]{1,253}(?::\d{1,5})?)$/i.exec(value);
	if (!m || !isPeer(m[2].toLowerCase())) return;
	const response = await signedFetch(m[2].toLowerCase(), "GET", `/federation/v1/users/by-name/${encodeURIComponent(m[1])}`, undefined, 512 * 1024);
	if (response.status === 200) await import("./federation-sync").then(({ applyUser }) => applyUser(m[2].toLowerCase(), response.json()));
}

export async function moneyFederationApi(incoming: Incoming, method: string, path: string): Promise<Response | undefined> {
	const [route, query = ""] = path.split("?", 2);
	if (method === "GET" && route === "/federation/v1/money/shop") {
		if (!feature("money") || !settings().money_shop.enabled) return signedAnswer(incoming, 200, { items: [], next: null });
		const after = new URLSearchParams(query).get("after") ?? "";
		if (after && !/^\d{1,19}$/.test(after)) return signedAnswer(incoming, 400, { error: "Invalid catalog cursor." });
		const items = await sql`select i.id::text, i.name, i.description, i.price_cents::bigint as price, i.kind, i.days,
			b.name as badge_name, b.image as badge_image, b.mime as badge_mime
			from money_shop_items i left join custom_badges b on b.id = i.badge_id
			where i.status = 'approved' and i.active and (i.kind <> 'badge' or b.id is not null)
			${after ? sql`and i.id < ${after}::bigint` : sql``}
			order by i.id desc limit 8`;
		const shared: any[] = [];
		for (const i of items as any[]) {
			let badge = null;
			if (i.kind === "badge") {
				const image = Buffer.from(i.badge_image);
				badge = { name: i.badge_name, mime: i.badge_mime, image: image.toString("base64") };
			}
			shared.push({ id: i.id, name: i.name, description: i.description, price: Number(i.price), kind: i.kind, days: i.days, badge });
		}
		return signedAnswer(incoming, 200, { items: shared, next: items.length === 8 ? items[items.length - 1].id : null });
	}
	if (method === "GET" && route === "/federation/v1/money/economy") {
		if (INSTANCE_ID !== ECONOMY_HOME || !feature("money")) return signedAnswer(incoming, 404, { error: "This instance doesn't set the network's economy." });
		const m = settings().money;
		return signedAnswer(incoming, 200, { starting_cents: m.starting_cents, max_transfer_cents: m.max_transfer_cents, like_cents: m.like_cents });
	}
	if (method === "GET" && route === "/federation/v1/money/totals") {
		if (!feature("money") || !settings().money.network_totals) return signedAnswer(incoming, 404, { error: "This instance doesn't share its totals." });
		return signedAnswer(incoming, 200, await localTotals());
	}
	if (method !== "POST" || route !== "/federation/v1/money/transfer") return undefined;
	if (!feature("money")) return signedAnswer(incoming, 404, { error: "Equicoins is not enabled here." });
	if (!isPeer(incoming.from)) return signedAnswer(incoming, 403, { error: "This instance does not accept Equicoins transfers from that peer." });
	let body: any;
	try { body = incoming.json(); } catch { return signedAnswer(incoming, 400, { error: "Invalid transfer." }); }
	const { economy, lockPeer, peerHasRoom } = await import("./money");
	const transferId = String(body?.transferId ?? "");
	const senderRef = String(body?.sender ?? "");
	const senderMatch = /^(\d{1,19})@([a-z0-9.-]{1,253}(?::\d{1,5})?)$/i.exec(senderRef);
	const recipientId = String(body?.recipient ?? "");
	const amount = Number(body?.amount);
	const note = typeof body?.note === "string" ? body.note : "";
	// a moved account's balance: all of it, past the daily cap, once the move is
	// found here. Only the peer knows the real balance, so a move is taken once
	// per migration and never above MOVE_CAP times the largest payment.
	const move = body?.move === true;
	const cap = move ? MOVE_CAP * economy().max_transfer_cents : economy().max_transfer_cents;
	if (!/^\d{1,19}$/.test(transferId) || !senderMatch || senderMatch[2].toLowerCase() !== incoming.from || !/^\d{1,19}$/.test(recipientId) ||
		!Number.isSafeInteger(amount) || amount <= 0 || amount > cap || note.length > 140)
		return signedAnswer(incoming, 400, { error: "Invalid transfer." });
	// the same rule as a local payment's note; refusing sends the money back to the sender
	if (note && (hateIn(note) || hasBlockedPhrase(note))) return signedAnswer(incoming, 422, { error: "That note can't be sent." });
	const [recipient] = await sql`select id::text, status from users where id = ${recipientId}::bigint and instance is null and deactivated_at is null`;
	if (!recipient || recipient.status === "suspended") return signedAnswer(incoming, 404, { error: "The recipient account is unavailable." });
	// the old account may be deactivated by the move, so it isn't looked up for one
	let senderId: string | undefined;
	let migrationId: string | undefined;
	const sources = [`https://${incoming.from}`, `http://${incoming.from}`];
	if (move) {
		// the peer answers the import's checks itself, so a failed import (or one
		// it made fail on purpose) doesn't count as a move
		const [moved] = await sql`select id::text from account_migrations where user_id = ${recipientId}::bigint and source_user_id = ${senderMatch[1]}::bigint
			and source = any(${sql.array(sources, "TEXT")}) and state <> 'failed' order by created_at desc limit 1`;
		if (!moved) return signedAnswer(incoming, 403, { error: "That account didn't move here." });
		migrationId = moved.id;
		senderId = await import("./federation-sync").then(({ resolveUser }) => resolveUser(senderRef)).catch(() => undefined);
	} else {
		senderId = await import("./federation-sync").then(({ resolveUser }) => resolveUser(senderRef)).catch(() => undefined);
		if (!senderId) return signedAnswer(incoming, 404, { error: "The sender account could not be verified." });
		const [sender] = await sql`select status from users where id = ${senderId}::bigint`;
		if (!sender || sender.status === "suspended") return signedAnswer(incoming, 403, { error: "The sender account is unavailable." });
		const [blocked] = await sql`select 1 from blocks where (blocker_id = ${senderId}::bigint and blocked_id = ${recipientId}::bigint) or (blocker_id = ${recipientId}::bigint and blocked_id = ${senderId}::bigint) limit 1`;
		if (blocked) return signedAnswer(incoming, 403, { error: "This transfer is blocked." });
	}
	try {
		const result = await sql.begin(async (tx) => {
			await lockPeer(tx, incoming.from);
			const [seen] = await tx`select 1 from money_federation_receipts where origin = ${incoming.from} and transfer_id = ${transferId}::bigint`;
			if (seen) return "duplicate";
			if (!move && !(await peerHasRoom(tx, incoming.from, amount))) return "full";
			if (move) {
				// One move per old account ever, however many imports it was the source
				// of; and a peer's moves together take at most money.peer_daily_move_cents
				// a day. Over that it is answered 429, which the peer retries for
				// GIVE_UP_AFTER, so an instance closing down still gets its people over.
				const [already] = await tx`select 1 from account_migrations where source = any(${sql.array(sources, "TEXT")})
					and source_user_id = ${senderMatch[1]}::bigint and balance_moved_at is not null limit 1`;
				if (already) return "moved";
				const [before] = await tx`select 1 from account_migrations where user_id = ${recipientId}::bigint and balance_moved_at is not null limit 1`;
				if (before) return "received";
				const daily = settings().money.peer_daily_move_cents;
				const [day] = await tx`select coalesce(sum(amount_cents), 0)::bigint as n from money_federation_receipts
					where origin = ${incoming.from} and move and created_at > now() - interval '1 day'`;
				if (daily > 0 && Number(day.n) + amount > daily) return "busy";
				const took = await tx`update account_migrations set balance_moved_at = now() where id = ${migrationId}::bigint and balance_moved_at is null returning 1`;
				if (!took.length) return "moved";
			}
			await tx`insert into money_federation_receipts (origin, transfer_id, amount_cents, move) values (${incoming.from}, ${transferId}::bigint, ${amount}, ${move})`;
			await tx`insert into money_wallets (user_id, balance_cents) values (${recipientId}::bigint, ${economy().starting_cents}) on conflict (user_id) do nothing`;
			await tx`update money_wallets set balance_cents = balance_cents + ${amount} where user_id = ${recipientId}::bigint`;
			if (senderId && senderId !== recipientId)
				await tx`insert into money_transfers (id, sender_id, recipient_id, amount_cents, note, idem, federation_status)
					values (${newId()}::bigint, ${senderId}::bigint, ${recipientId}::bigint, ${amount}, ${note}, ${`federation:${incoming.from}:${transferId}`}, 'complete')`;
			return "taken";
		});
		if (result === "full") return signedAnswer(incoming, 422, { error: "This instance has taken all it accepts from yours today." });
		if (result === "busy") return signedAnswer(incoming, 429, { error: "This instance has taken all the moved balances it accepts from yours today. Try again later." });
		if (result === "moved") return signedAnswer(incoming, 403, { error: "That account's balance already moved here." });
		if (result === "received") return signedAnswer(incoming, 403, { error: "The recipient already took in a moved balance." });
		return signedAnswer(incoming, 200, { accepted: true, duplicate: result === "duplicate" });
	} catch (e) {
		console.error("Equicoins federation transfer failed:", e instanceof Error ? e.message : e);
		return signedAnswer(incoming, 500, { error: "The transfer could not be recorded." });
	}
}

async function localTotals() {
	const [t] = await sql`select (select coalesce(sum(balance_cents), 0)::bigint from money_wallets) as circulation,
		(select count(*)::int from money_wallets) as wallets,
		(select count(*)::int from money_transfers where reversed_at is null) as payments`;
	return { circulation: Number(t.circulation), wallets: Number(t.wallets), payments: Number(t.payments) };
}

// The instance whose starting balance, like reward and largest payment the
// others follow with money.follow_network (money.ts economy()).
export const ECONOMY_HOME = "xitter.space";
export const isEconomyHome = () => INSTANCE_ID === ECONOMY_HOME;

async function syncEconomy() {
	if (!feature("money") || !settings().money.follow_network || INSTANCE_ID === ECONOMY_HOME) return;
	const response = await signedFetch(ECONOMY_HOME, "GET", "/federation/v1/money/economy", undefined, 16 * 1024);
	if (response.status !== 200) throw new Error(`${ECONOMY_HOME} answered ${response.status}`);
	const e = response.json();
	const ok = (v: unknown, min: number, max: number) => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
	if (!ok(e?.starting_cents, 0, 100_000_000) || !ok(e?.max_transfer_cents, 1, 10_000_000_000) || !ok(e?.like_cents, 0, 100_000)) throw new Error("invalid economy");
	(await import("./money")).setNetworkEconomy({ starting_cents: e.starting_cents, max_transfer_cents: e.max_transfer_cents, like_cents: e.like_cents });
}

// every peer that shares its totals, as last heard, for Admin > Equicoins
const peerTotals = new Map<string, { circulation: number; wallets: number; payments: number }>();
export async function networkTotals() {
	if (!settings().money.network_totals) return null;
	const sum = await localTotals();
	for (const t of peerTotals.values()) {
		sum.circulation += t.circulation;
		sum.wallets += t.wallets;
		sum.payments += t.payments;
	}
	return { ...sum, instances: peerTotals.size + 1 };
}
async function syncTotals() {
	if (!feature("money") || !settings().money.network_totals) return peerTotals.clear();
	const live = new Set(peers().map((p) => p.id));
	for (const id of peerTotals.keys()) if (!live.has(id)) peerTotals.delete(id);
	await Promise.all([...live].map(async (id) => {
		const response = await signedFetch(id, "GET", "/federation/v1/money/totals", undefined, 16 * 1024).catch(() => undefined);
		const t = response?.status === 200 ? response.json() : undefined;
		const n = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
		// a peer that stopped sharing, or never did, drops out of the sum
		if (t && n(t.circulation) && n(t.wallets) && n(t.payments)) peerTotals.set(id, { circulation: t.circulation, wallets: t.wallets, payments: t.payments });
		else peerTotals.delete(id);
	}));
}

async function syncRemoteShop(instance: string) {
	const { SHOP_KINDS } = await import("./money-shop");
	const catalogItems: any[] = [];
	let after = "";
	for (let page = 0; page < 100; page++) {
		const response = await signedFetch(instance, "GET", `/federation/v1/money/shop${after ? `?after=${after}` : ""}`, undefined, 4 * 1024 * 1024);
		// a peer on a version without Equicoins has no shop to share
		if (response.status === 404 && !after) break;
		if (response.status !== 200) throw new Error(`shop catalog answered ${response.status}`);
		const catalog = response.json();
		if (!Array.isArray(catalog?.items) || catalog.items.length > 8 || (catalog.next !== null && !/^\d{1,19}$/.test(String(catalog.next)))) throw new Error("invalid shop catalog");
		catalogItems.push(...catalog.items);
		if (catalog.next === null) break;
		after = String(catalog.next);
	}
	if (catalogItems.length >= 800) throw new Error("shop catalog is over the sync limit");
	const valid: any[] = [];
	for (const raw of catalogItems) {
		if (!/^\d{1,19}$/.test(String(raw?.id ?? "")) || typeof raw.name !== "string" || !raw.name.trim() || [...raw.name].length > 60 ||
			typeof raw.description !== "string" || [...raw.description].length > 240 || !Number.isSafeInteger(raw.price) || raw.price <= 0 || raw.price > 1_000_000_000 ||
			!SHOP_KINDS.includes(raw.kind)) continue;
		let badge: { name: string; mime: string; image: Buffer } | undefined;
		if (raw.kind === "badge") {
			const item = raw.badge;
			if (typeof item?.name !== "string" || !item.name.trim() || [...item.name].length > 60 || typeof item.image !== "string" || item.image.length > 350_000 ||
				!BADGE_TYPES.includes(item.mime) || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.image)) continue;
			const image = Buffer.from(item.image, "base64");
			const info = sniffImage(image);
			if (image.length > 256 * 1024 || !info || info.mime !== item.mime || info.width > 1024 || info.height > 1024) continue;
			badge = { name: item.name.trim(), mime: item.mime, image };
		}
		const days = Number.isSafeInteger(raw.days) && raw.days >= 1 && raw.days <= 365 ? raw.days : null;
		valid.push({ id: String(raw.id), name: raw.name.trim(), description: raw.description, price: raw.price, kind: raw.kind, days, badge });
	}
	await sql.begin(async (tx) => {
		const ids = valid.map((i) => i.id);
		await tx`update money_remote_shop_items set source_active = false, updated_at = now() where origin = ${instance}`;
		for (const item of valid) {
			const badge = item.badge;
			await tx`insert into money_remote_shop_items (origin, remote_id, name, description, price_cents, kind, days, badge_name, badge_image, badge_mime, source_active)
				values (${instance}, ${item.id}::bigint, ${item.name}, ${item.description}, ${item.price}, ${item.kind}, ${item.days}, ${badge?.name ?? null}, ${badge?.image ?? null}, ${badge?.mime ?? null}, true)
				on conflict (origin, remote_id) do update set
					status = case when (money_remote_shop_items.name, money_remote_shop_items.description, money_remote_shop_items.price_cents, money_remote_shop_items.kind,
						money_remote_shop_items.badge_name, money_remote_shop_items.badge_image, money_remote_shop_items.badge_mime, money_remote_shop_items.days)
						is distinct from (excluded.name, excluded.description, excluded.price_cents, excluded.kind, excluded.badge_name, excluded.badge_image, excluded.badge_mime, excluded.days)
						then 'pending' else money_remote_shop_items.status end,
					active = case when (money_remote_shop_items.name, money_remote_shop_items.description, money_remote_shop_items.price_cents, money_remote_shop_items.kind,
						money_remote_shop_items.badge_name, money_remote_shop_items.badge_image, money_remote_shop_items.badge_mime, money_remote_shop_items.days)
						is distinct from (excluded.name, excluded.description, excluded.price_cents, excluded.kind, excluded.badge_name, excluded.badge_image, excluded.badge_mime, excluded.days)
						then false else money_remote_shop_items.active end,
					reviewed_by = case when (money_remote_shop_items.name, money_remote_shop_items.description, money_remote_shop_items.price_cents, money_remote_shop_items.kind,
						money_remote_shop_items.badge_name, money_remote_shop_items.badge_image, money_remote_shop_items.badge_mime, money_remote_shop_items.days)
						is distinct from (excluded.name, excluded.description, excluded.price_cents, excluded.kind, excluded.badge_name, excluded.badge_image, excluded.badge_mime, excluded.days)
						then null else money_remote_shop_items.reviewed_by end,
					reviewed_at = case when (money_remote_shop_items.name, money_remote_shop_items.description, money_remote_shop_items.price_cents, money_remote_shop_items.kind,
						money_remote_shop_items.badge_name, money_remote_shop_items.badge_image, money_remote_shop_items.badge_mime, money_remote_shop_items.days)
						is distinct from (excluded.name, excluded.description, excluded.price_cents, excluded.kind, excluded.badge_name, excluded.badge_image, excluded.badge_mime, excluded.days)
						then null else money_remote_shop_items.reviewed_at end,
					name = excluded.name, description = excluded.description, price_cents = excluded.price_cents, kind = excluded.kind,
					days = excluded.days, badge_name = excluded.badge_name, badge_image = excluded.badge_image, badge_mime = excluded.badge_mime,
					source_active = true, updated_at = now()`;
		}
		if (ids.length) await tx`update money_remote_shop_items set source_active = false where origin = ${instance} and not (remote_id = any(${sql.array(ids, "INT8")}))`;
	});
}

let syncingShop = false;
async function syncShops() {
	if (syncingShop || !feature("money") || !settings().money_shop.enabled) return;
	syncingShop = true;
	try {
		await Promise.all(peers().map((peer) => syncRemoteShop(peer.id).catch((e) => console.error(`Equicoins shop sync ${peer.id}:`, e instanceof Error ? e.message : e))));
		const active = peers().map((p) => p.id);
		await sql`update money_remote_shop_items set source_active = false where not (origin = any(${sql.array(active, "TEXT")}))`;
	} finally { syncingShop = false; }
}

// the peer refused, or never answered: the money goes back to the sender
async function failTransfer(transferId: string) {
	await sql.begin(async (tx) => {
		const [sent] = await tx`update money_transfers set federation_status = 'failed' where id = ${transferId}::bigint and federation_status = 'pending' returning sender_id::text, amount_cents`;
		if (sent) await tx`update money_wallets set balance_cents = balance_cents + ${Number(sent.amount_cents)} where user_id = ${sent.sender_id}::bigint`;
		await tx`delete from money_federation_outbox where transfer_id = ${transferId}::bigint`;
	});
}

export async function pumpOnce() {
	if (pumping) return;
	pumping = true;
	try {
		const rows = await sql`select o.transfer_id::text, o.destination, o.sender_id::text, o.recipient_id::text, o.amount_cents::bigint as amount,
			o.note, o.attempts, o.move, o.created_at < now() - ${GIVE_UP_AFTER}::interval as expired
			from money_federation_outbox o join money_transfers t on t.id = o.transfer_id
			where o.next_attempt <= now() and t.federation_status = 'pending' order by o.next_attempt limit 10`;
		for (const r of rows) {
			let status = 0, accepted = false, error = "";
			try {
				const response = await signedFetch(r.destination, "POST", "/federation/v1/money/transfer", {
					transferId: r.transfer_id,
					sender: `${r.sender_id}@${INSTANCE_ID}`,
					recipient: r.recipient_id,
					amount: Number(r.amount),
					note: r.note,
					move: r.move,
				}, 64 * 1024);
				status = response.status;
				accepted = status >= 200 && status < 300 && response.json()?.accepted === true;
				error = `remote status ${status}`;
			} catch (e) {
				error = String(e).slice(0, 300);
			}
			if (accepted) {
				await sql.begin(async (tx) => {
					await tx`update money_transfers set federation_status = 'complete' where id = ${r.transfer_id}::bigint and federation_status = 'pending'`;
					await tx`delete from money_federation_outbox where transfer_id = ${r.transfer_id}::bigint`;
				});
				void import("./money").then(({ announcePayment }) => announcePayment(r.transfer_id)).catch((e) => console.error("Equicoins announcement:", e));
			} else if ((status >= 400 && status < 500 && status !== 429) || r.expired) {
				await failTransfer(r.transfer_id);
			} else {
				const delay = status ? Math.min(60, 2 ** Math.min(Number(r.attempts) + 1, 6)) : 1;
				await sql`update money_federation_outbox set attempts = attempts + 1, next_attempt = now() + ${delay} * interval '1 minute', last_error = ${error}
					where transfer_id = ${r.transfer_id}::bigint`;
			}
		}
	} finally { pumping = false; }
}

export function startMoneyFederation() {
	void pumpOnce().catch((e) => console.error("Equicoins federation queue:", e));
	setInterval(() => void pumpOnce().catch((e) => console.error("Equicoins federation queue:", e)), 15_000).unref();
	void syncShops().catch((e) => console.error("Equicoins shop sync:", e));
	setInterval(() => void syncShops().catch((e) => console.error("Equicoins shop sync:", e)), 5 * 60_000).unref();
	const economyAndTotals = () => {
		void syncEconomy().catch((e) => console.error("Equicoins economy:", e instanceof Error ? e.message : e));
		void syncTotals().catch((e) => console.error("Equicoins totals:", e instanceof Error ? e.message : e));
	};
	economyAndTotals();
	setInterval(economyAndTotals, 10 * 60_000).unref();
}
