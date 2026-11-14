// Equicoins wallets live on each account's home instance. Signed, idempotent
// transfers move money between peers; a local author can earn from remote
// likes on their posts. A new wallet starts with its home instance's balance.
// The pages are money-page.ts; the client's side is money-ui.ts.

import { audit } from "./admin";
import { esc } from "./account-page";
import type { Viewer } from "./auth";
import { blockedFor, isBlockedEitherWay, protectedFor, suspendedFor } from "./blocks";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { hateIn } from "./hate";
import { newId } from "./ids";
import { linksIn } from "./links";
import { absolute } from "./media";
import { avatarUrl, remoteCheckHidden } from "./model";
import { feature, hasBlockedPhrase, settings } from "./settings";
import { MONEY_ICON } from "./tidy";
import { isPeer } from "./federation";

export const NOTE_MAX = 140;
// a requester's requests of other accounts still waiting at once
const OPEN_REQUESTS_MAX = 20;

export class MoneyError extends Error {}

// "$12.50", "12.5" or "12" in cents; null when it isn't an amount
export function parseAmount(text: string): number | null {
	const m = /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text.trim().replace(/,/g, ""));
	if (!m) return null;
	return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export const formatCents = (cents: number | bigint) => {
	const n = Number(cents);
	const dollars = Math.floor(n / 100).toLocaleString("en-US");
	return `$${dollars}.${String(n % 100).padStart(2, "0")}`;
};
// whole amounts without their cents, as X shows them ("$100", "$3.52")
export const shortCents = (cents: number) => (cents % 100 ? formatCents(cents) : `$${(cents / 100).toLocaleString("en-US")}`);

export const date = (d: Date) => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(new Date(d).getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });

// The economy in force. With money.follow_network on, the starting balance,
// like reward and largest payment are xitter.space's (money-federation.ts
// fetches them), so every instance that follows it makes money at one rate.
type Economy = { starting_cents: number; max_transfer_cents: number; like_cents: number };
let network: Economy | null = null;
export const networkEconomy = () => network;
export function setNetworkEconomy(e: Economy) {
	network = e;
}
export function economy(): Economy {
	const m = settings().money;
	return m.follow_network && network ? network : m;
}

// What one peer brought in over the last day, its transfers and the rewards for
// its accounts' likes, held to money.peer_daily_cents. Callers take lockPeer in
// their transaction first, so two arrivals can't both fit under the limit.
export async function lockPeer(db: typeof sql, origin: string) {
	await db`select pg_advisory_xact_lock(hashtext(${`money-peer:${origin}`}))`;
}
export async function peerHasRoom(db: typeof sql, origin: string, cents: number) {
	const cap = settings().money.peer_daily_cents;
	if (!(cap > 0)) return true;
	const [r] = await db`select
		(select coalesce(sum(amount_cents), 0) from money_federation_receipts where origin = ${origin} and not move and created_at > now() - interval '1 day') +
		(select coalesce(sum(w.cents), 0) from money_like_rewards w join users u on u.id = w.liker_id where u.instance = ${origin} and w.created_at > now() - interval '1 day') as n`;
	return Number(r.n) + cents <= cap;
}

// the wallet's row, made with the starting balance the first time
async function ensureWallet(userId: string, db: typeof sql = sql) {
	await db`insert into money_wallets (user_id, balance_cents) values (${userId}::bigint, ${economy().starting_cents})
		on conflict (user_id) do nothing`;
}

export async function balanceOf(userId: string): Promise<number> {
	await ensureWallet(userId);
	const [w] = await sql`select balance_cents from money_wallets where user_id = ${userId}::bigint`;
	return Number(w.balance_cents);
}

// what an account accepts before Equicoins opens, on the page and through the API
export const disclaimerText = () => {
	const instance = settings().instance_name, name = `${instance} Equicoins`;
	return `${name} is virtual currency for use on this instance and participating Xitter instances. It has no real-world monetary value, is not legal tender, and cannot be exchanged for real money, cryptocurrency, or other monetary assets. It is for entertainment and platform use only.`;
};

// the disclaimer, accepted once per account before Equicoins opens (money-page.ts)
export async function disclaimerAccepted(userId: string): Promise<boolean> {
	await ensureWallet(userId);
	const [w] = await sql`select disclaimer_at is not null as ok from money_wallets where user_id = ${userId}::bigint`;
	return !!w?.ok;
}
export async function acceptDisclaimer(userId: string) {
	await ensureWallet(userId);
	await sql`update money_wallets set disclaimer_at = coalesce(disclaimer_at, now()) where user_id = ${userId}::bigint`;
}

// A bare handle is local; a handle@instance resolves to a federated account.
export async function accountFor(handle: string) {
	const name = handle.trim().replace(/^@/, "");
	if (!/^[A-Za-z0-9_]{1,15}(?:@[a-z0-9.-]{1,253}(?::\d{1,5})?)?$/i.test(name)) return null;
	let [u] = await sql`select id::text, screen_name, name, instance, remote_id::text from users
		where lower(screen_name) = lower(${name}) and status <> 'suspended' and deactivated_at is null`;
	if (!u && name.includes("@")) {
		await import("./money-federation").then(({ discoverMoneyAccount }) => discoverMoneyAccount(name)).catch(() => undefined);
		[u] = await sql`select id::text, screen_name, name, instance, remote_id::text from users
			where lower(screen_name) = lower(${name}) and status <> 'suspended' and deactivated_at is null`;
	}
	if (u?.instance && !isPeer(u.instance)) return null;
	return u ?? null;
}

function checkNote(note: string) {
	note = note.trim();
	if ([...note].length > NOTE_MAX) throw new MoneyError(`Notes are up to ${NOTE_MAX} characters.`);
	if (note && (hateIn(note) || hasBlockedPhrase(note))) throw new MoneyError("That note can't be sent.");
	return note;
}

// Moves the money in one transaction. Both wallets are locked in id order, so
// two people paying each other at once can't deadlock. A repeated `idem`
// returns the transfer it already made. Paying a request checks it is still
// open, for this payer, to its requester, for its amount.
export async function sendMoney(senderId: string, handle: string, amountCents: number, note: string, idem: string, requestId?: string): Promise<{ id: string; to: string; repeated: boolean }> {
	const [me] = await sql`select status from users where id = ${senderId}::bigint`;
	if (me?.status === "restricted") throw new MoneyError("Your account can't send money right now.");
	if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new MoneyError("Enter an amount over $0.");
	const max = economy().max_transfer_cents;
	if (amountCents > max) throw new MoneyError(`You can send up to ${formatCents(max)} at a time.`);
	note = checkNote(note);
	if (!/^[\w-]{8,64}$/.test(idem)) throw new MoneyError("The form expired. Try again.");
	if (requestId !== undefined && !/^\d{1,19}$/.test(requestId)) throw new MoneyError("That request doesn't exist.");
	const to = await accountFor(handle);
	if (!to) throw new MoneyError("There's no account here with that username.");
	if (to.id === senderId) throw new MoneyError("You can't send money to yourself.");
	if (requestId && to.instance) throw new MoneyError("You can't pay a request from another instance yet.");
	if (await isBlockedEitherWay(senderId, to.id)) throw new MoneyError(`You can't send money to @${to.screen_name}.`);
	const sent = await sql.begin(async (tx) => {
		const [done] = await tx`select id from money_transfers where sender_id = ${senderId}::bigint and idem = ${idem}`;
		if (done) return { id: String(done.id), to: to.screen_name, repeated: true };
		if (requestId) {
			const [rq] = await tx`select requester_id::text, payer_id::text, amount_cents, status from money_requests where id = ${requestId}::bigint for update`;
			if (!rq || rq.status !== "open" || rq.requester_id !== to.id || (rq.payer_id && rq.payer_id !== senderId)) throw new MoneyError("That request isn't open to you any more.");
			if (rq.amount_cents && Number(rq.amount_cents) !== amountCents) throw new MoneyError(`That request is for ${formatCents(Number(rq.amount_cents))}.`);
			if (rq.payer_id) await tx`update money_requests set status = 'paid', resolved_at = now() where id = ${requestId}::bigint`;
		}
		await ensureWallet(senderId, tx);
		if (!to.instance) await ensureWallet(to.id, tx);
		const wallets = to.instance
			? await tx`select user_id::text, balance_cents from money_wallets where user_id = ${senderId}::bigint for update`
			: await tx`select user_id::text, balance_cents from money_wallets where user_id in (${senderId}::bigint, ${to.id}::bigint) order by user_id for update`;
		// a second press of Send waited here for the first: it finds what that made
		const [made] = await tx`select id from money_transfers where sender_id = ${senderId}::bigint and idem = ${idem}`;
		if (made) return { id: String(made.id), to: to.screen_name, repeated: true };
		const mine = wallets.find((w: any) => w.user_id === senderId);
		if (Number(mine.balance_cents) < amountCents) throw new MoneyError("You don't have enough money for that.");
		const id = newId();
		await tx`update money_wallets set balance_cents = balance_cents - ${amountCents} where user_id = ${senderId}::bigint`;
		if (!to.instance) await tx`update money_wallets set balance_cents = balance_cents + ${amountCents} where user_id = ${to.id}::bigint`;
		await tx`insert into money_transfers (id, sender_id, recipient_id, amount_cents, note, idem, request_id, federation_status)
			values (${id}::bigint, ${senderId}::bigint, ${to.id}::bigint, ${amountCents}, ${note}, ${idem}, ${requestId ?? null}, ${to.instance ? "pending" : "complete"})`;
		if (to.instance) await tx`insert into money_federation_outbox (transfer_id, destination, sender_id, recipient_id, amount_cents, note)
			values (${id}::bigint, ${to.instance}, ${senderId}::bigint, ${to.remote_id}::bigint, ${amountCents}, ${note})`;
		return { id, to: to.screen_name, repeated: false };
	});
	if (!sent.repeated) void announcePayment(sent.id);
	return sent;
}

// The payments feed (Admin > Money): a local account that posts every
// payment, once it has gone through, as "Alice sent $5 to Liza! #Money"
// over its card (the link closing the text is the card's): names, not
// handles, so nobody is mentioned. The card leaves the note out: that stays
// between the two sides.
export async function feedAccount(): Promise<{ id: string; screen_name: string } | null> {
	const handle = settings().money.feed;
	const account = handle ? await accountFor(handle) : null;
	return account && !account.instance ? account : null;
}
// a payment to another instance is announced once that instance takes it (money-federation.ts)
export async function announcePayment(id: string) {
	try {
		if (!feature("money")) return;
		const feed = await feedAccount();
		if (!feed) return;
		const t = (await payments([id])).get(id);
		if (!t || t.status !== "complete") return;
		const { createPost } = await import("./posts");
		// a name that would read as a mention or a link keeps the @ and dots out of it
		const name = (p: Party) => (p.merchant?.name ?? p.name).replace(/[@＠]/g, "").replace(/\./g, "\u2024").trim() || p.screen_name;
		await createPost(feed.id, `${name(t.sender)} sent ${shortCents(t.amount)} to ${name(t.recipient)}! #Money ${paymentUrl(id)}`, { skipPreview: true });
	} catch (e) {
		console.error("money feed:", e instanceof Error ? e.message : e);
	}
}
// a reversed payment's feed post goes
export async function unannouncePayment(id: string) {
	const feed = await feedAccount();
	if (!feed) return;
	const { deletePost } = await import("./posts");
	for (const p of await sql`select id::text from posts where user_id = ${feed.id}::bigint and text ~ ${`/i/xmoney/p/${id}([^0-9]|$)`}`) await deletePost(feed.id, p.id);
}

// Asks for money: of one account (it gets a notification, and pays or
// declines), or of anyone when `from` is empty (a "Pay @name" card, with or
// without an amount).
export async function requestMoney(requesterId: string, from: string, amountText: string, note: string): Promise<string> {
	const [me] = await sql`select status from users where id = ${requesterId}::bigint`;
	if (me?.status === "restricted") throw new MoneyError("Your account can't ask for money right now.");
	note = checkNote(note);
	const amount = amountText.trim() ? parseAmount(amountText) : null;
	if (amountText.trim() && !amount) throw new MoneyError("Enter an amount, like 5 or 12.50.");
	if (amount && amount > economy().max_transfer_cents) throw new MoneyError(`You can ask for up to ${formatCents(economy().max_transfer_cents)} at a time.`);
	let payer: { id: string; screen_name: string } | null = null;
	if (from.trim()) {
		payer = await accountFor(from);
		if (!payer) throw new MoneyError("There's no account here with that username.");
		if (payer.instance) throw new MoneyError("Money requests are only available between accounts on this instance.");
		if (payer.id === requesterId) throw new MoneyError("You can't ask yourself for money.");
		if (!amount) throw new MoneyError(`Say how much you're asking @${payer.screen_name} for.`);
		if (await isBlockedEitherWay(requesterId, payer.id)) throw new MoneyError(`You can't ask @${payer.screen_name} for money.`);
		const [{ n }] = await sql`select count(*)::int as n from money_requests where requester_id = ${requesterId}::bigint and payer_id is not null and status = 'open'`;
		if (n >= OPEN_REQUESTS_MAX) throw new MoneyError(`You have ${n} requests waiting. Cancel some first.`);
		const [dup] = await sql`select id::text from money_requests where requester_id = ${requesterId}::bigint and payer_id = ${payer.id}::bigint and status = 'open'
			and amount_cents = ${amount} and note = ${note}`;
		if (dup) return dup.id;
	} else {
		// one plain "Pay me" card each: asking again gives the same one
		const [same] = await sql`select id::text from money_requests where requester_id = ${requesterId}::bigint and payer_id is null and status = 'open'
			and amount_cents is not distinct from ${amount} and note = ${note}`;
		if (same) return same.id;
	}
	const id = newId();
	await sql`insert into money_requests (id, requester_id, payer_id, amount_cents, note) values (${id}::bigint, ${requesterId}::bigint, ${payer?.id ?? null}, ${amount}, ${note})`;
	return id;
}

// the payer declines a request of them, the requester cancels their own
export async function closeRequest(viewerId: string, id: string, action: "decline" | "cancel"): Promise<boolean> {
	const rows =
		action === "decline"
			? await sql`update money_requests set status = 'declined', resolved_at = now() where id = ${id}::bigint and payer_id = ${viewerId}::bigint and status = 'open' returning 1`
			: await sql`update money_requests set status = 'cancelled', resolved_at = now() where id = ${id}::bigint and requester_id = ${viewerId}::bigint and status = 'open' returning 1`;
	return rows.length > 0;
}

// staff adding to an account's balance (or taking from it, never below zero)
export async function adjust(viewer: Viewer, handle: string, cents: number) {
	const to = await accountFor(handle);
	if (!to) throw new MoneyError("There's no account here with that username.");
	if (to.instance) throw new MoneyError("Only the account's home instance can adjust its balance.");
	await ensureWallet(to.id);
	const [w] = await sql`update money_wallets set balance_cents = greatest(balance_cents + ${cents}, 0)
		where user_id = ${to.id}::bigint returning balance_cents`;
	await audit(viewer, "money_adjust", to.id, { cents, balance: Number(w.balance_cents) });
	return { to: to.screen_name, balance: Number(w.balance_cents) };
}

// A like on a local post earns its author money.like_cents, once per post and
// account, including likes relayed from a peer. Unliking and liking again pays
// nothing more. Likes from suspended accounts don't count, and a peer's likes
// stop paying once it reaches money.peer_daily_cents for the day.
export async function rewardLike(likerId: string, postId: string, likerInstance?: string) {
	const cents = economy().like_cents;
	if (!feature("money") || !(cents > 0)) return;
	await sql.begin(async (tx) => {
		const [p] = likerInstance
			? await tx`select p.user_id::text as author from posts p join users a on a.id = p.user_id join users l on l.id = ${likerId}::bigint
				where p.id = ${postId}::bigint and a.instance is null and l.instance = ${likerInstance} and l.status <> 'suspended'`
			: await tx`select p.user_id::text as author from posts p join users a on a.id = p.user_id join users l on l.id = ${likerId}::bigint
				where p.id = ${postId}::bigint and a.instance is null and l.instance is null and l.status <> 'suspended'`;
		if (!p || p.author === likerId) return;
		if (likerInstance) {
			await lockPeer(tx, likerInstance);
			if (!(await peerHasRoom(tx, likerInstance, cents))) return;
		}
		const paid = await tx`insert into money_like_rewards (post_id, liker_id, author_id, cents) values (${postId}::bigint, ${likerId}::bigint, ${p.author}::bigint, ${cents})
			on conflict do nothing returning 1`;
		if (!paid.length) return;
		await ensureWallet(p.author, tx);
		await tx`update money_wallets set balance_cents = balance_cents + ${cents} where user_id = ${p.author}::bigint`;
	});
}

// An account that moved to another instance (migration.ts) takes its balance
// along when money.move_balance is on: all of it in one transfer marked as a
// move, which the new instance takes past its limits once it finds the move.
// Refused, it comes back here like any failed transfer.
export async function moveBalance(userId: string, to: string) {
	if (!feature("money") || !settings().money.move_balance) return;
	const dest = await accountFor(to);
	if (!dest?.instance || !dest.remote_id) {
		console.error(`Equicoins: no account @${to} to move a balance to`);
		return;
	}
	await sql.begin(async (tx) => {
		const [w] = await tx`select balance_cents from money_wallets where user_id = ${userId}::bigint for update`;
		const amount = Number(w?.balance_cents ?? 0);
		if (amount <= 0) return;
		const id = newId();
		await tx`update money_wallets set balance_cents = 0 where user_id = ${userId}::bigint`;
		await tx`insert into money_transfers (id, sender_id, recipient_id, amount_cents, note, idem, federation_status)
			values (${id}::bigint, ${userId}::bigint, ${dest.id}::bigint, ${amount}, ${`Moved to @${to}`}, ${`move:${id}`}, 'pending')`;
		await tx`insert into money_federation_outbox (transfer_id, destination, sender_id, recipient_id, amount_cents, note, move)
			values (${id}::bigint, ${dest.instance}, ${userId}::bigint, ${dest.remote_id}::bigint, ${amount}, '', true)`;
	});
}

// Merchant mode (Settings > Equicoins): for gold organisations, payments to them
// read as purchases, with the name they choose and, if they like, their banner
export async function merchantOf(userId: string) {
	const [m] = await sql`select u.verified_type = 'business' as gold, m.user_id is not null as on, coalesce(m.name, '') as name, coalesce(m.show_banner, true) as show_banner
		from users u left join money_merchants m on m.user_id = u.id where u.id = ${userId}::bigint`;
	return { gold: !!m?.gold, on: !!m?.on, name: (m?.name as string) ?? "", showBanner: (m?.show_banner as boolean) ?? true };
}
export async function setMerchant(userId: string, on: boolean, name: string, showBanner: boolean) {
	if (!on) return void (await sql`delete from money_merchants where user_id = ${userId}::bigint`);
	name = name.trim();
	if ([...name].length > 50) throw new MoneyError("Merchant names are up to 50 characters.");
	if (name && (hateIn(name) || hasBlockedPhrase(name))) throw new MoneyError("That name can't be used.");
	await sql`insert into money_merchants (user_id, name, show_banner) values (${userId}::bigint, ${name}, ${showBanner})
		on conflict (user_id) do update set name = excluded.name, show_banner = excluded.show_banner, updated_at = now()`;
}

// ---- who a payment involves, as cards and lists show them

export type Party = {
	id: string;
	screen_name: string;
	name: string;
	avatar: string;
	// X's checkmark: the account's own, or blue for an organisation's affiliate
	badge: string | null;
	// the organisation an affiliate wears after its name
	org: { name: string; screen_name: string; avatar: string } | null;
	// organisations have square pictures
	square: boolean;
	// set while merchant mode is on: the name purchases read and the banner they show
	merchant: { name: string; banner: string | null } | null;
};

// an address that can sit inside a style's url("...") as it is
const plainUrl = (u: string | null) => (u && /^(https?:\/\/|\/)[^\s"'()\\<>]+$/.test(u) ? u : null);

export async function parties(ids: string[]): Promise<Map<string, Party>> {
	if (!ids.length) return new Map();
	const rows = await sql`select u.id::text, u.screen_name, u.name, u.avatar_url, u.banner_url, u.verified_type, u.instance,
			(select json_build_object('name', o.name, 'screen_name', o.screen_name, 'avatar', o.avatar_url) from affiliations af join users o on o.id = af.org_id
				where af.user_id = u.id order by af.created_at, af.org_id limit 1) as org,
			m.user_id is not null and u.verified_type = 'business' as merchant, m.name as m_name, m.show_banner
		from users u left join money_merchants m on m.user_id = u.id where u.id = any(${sql.array([...new Set(ids)], "INT8")})`;
	return new Map(
		rows.map((r: any) => [
			r.id,
			{
				id: r.id,
				screen_name: r.screen_name,
				name: r.name || r.screen_name,
				avatar: avatarUrl(r.avatar_url),
				badge: remoteCheckHidden(r) ? null : (r.verified_type ?? (r.org && feature("affiliate_checkmarks") ? "blue" : null)),
				org: r.org ? { name: r.org.name, screen_name: r.org.screen_name, avatar: avatarUrl(r.org.avatar) } : null,
				square: r.verified_type === "business" || r.verified_type === "government",
				merchant: r.merchant ? { name: r.m_name || r.name || r.screen_name, banner: r.show_banner && r.banner_url ? plainUrl(absolute(r.banner_url)) : null } : null,
			} satisfies Party,
		]),
	);
}

// X's verified badge, in the account's colour, and an affiliate's organisation after it
const BADGE_PATH = "M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.67.88-3.33 2.19c-1.4-.46-2.91-.2-3.92.81s-1.26 2.52-.8 3.91c-1.31.67-2.2 1.91-2.2 3.34s.89 2.67 2.2 3.34c-.46 1.39-.21 2.9.8 3.91s2.52 1.26 3.91.81c.67 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.45 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.67 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z";
const BADGE_COLOR: Record<string, string> = { blue: "#1d9bf0", business: "#e2b719", government: "#829aab", government_individual: "#829aab" };
const BADGE_LABEL: Record<string, string> = { blue: "Verified account", business: "Verified organisation", government: "Government organisation", government_individual: "Government official" };
export const badges = (p: Pick<Party, "badge" | "org">) =>
	(p.badge && BADGE_COLOR[p.badge] ? `<svg class="xm-badge" viewBox="0 0 22 22" role="img" aria-label="${BADGE_LABEL[p.badge]}"><path fill="${BADGE_COLOR[p.badge]}" d="${BADGE_PATH}"/></svg>` : "") +
	(p.org ? `<img class="xm-org" src="${esc(p.org.avatar)}" alt="${esc(p.org.name)}" title="${esc(p.org.name)}">` : "");
export const face = (p: Party, cls = "") => `<img class="${cls}${p.square ? " xm-sq" : ""}" src="${esc(p.avatar)}" alt="">`;
// "with [$] Equicoins", where X writes "with my X Card"
export const MONEY_WORDMARK = `<span class="xm-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${MONEY_ICON}"/></svg>Equicoins</span>`;

// ---- payments

// reversed: staff sent the money back (Admin > Money)
export type Payment = { id: string; amount: number; note: string; at: Date; sender: Party; recipient: Party; reversed?: boolean; status: string };

// a post (p) that names a payment or request shows it only to those who can see that post
const postSeenBy = (viewerId: string) =>
	sql`not p.hidden and p.user_id not in ${protectedFor(viewerId)} and p.user_id not in ${suspendedFor(viewerId)} and p.user_id not in ${blockedFor(viewerId)}`;

// payments by id, with both sides; `visibleTo` keeps the ones that account is
// part of or that one side put in a post
export async function payments(ids: string[], visibleTo?: string): Promise<Map<string, Payment>> {
	if (!ids.length) return new Map();
	const feed = visibleTo ? ((await feedAccount())?.id ?? null) : null;
	const rows = await sql`select t.id::text, t.amount_cents, t.note, t.created_at, t.sender_id::text, t.recipient_id::text, t.reversed_at is not null as reversed, t.federation_status from money_transfers t
		where t.id = any(${sql.array(ids, "INT8")})
		${
			visibleTo
				? sql`and (${visibleTo}::bigint in (t.sender_id, t.recipient_id) or exists (select 1 from posts p
				where p.user_id in (t.sender_id, t.recipient_id, ${feed}::bigint) and ${postSeenBy(visibleTo)} and p.text ~ ('/i/xmoney/p/' || t.id::text || '([^0-9]|$)')))`
				: sql``
		}`;
	const who = await parties(rows.flatMap((r: any) => [r.sender_id, r.recipient_id]));
	return new Map(
		rows
			.filter((r: any) => who.has(r.sender_id) && who.has(r.recipient_id))
			.map((r: any) => [r.id, { id: r.id, amount: Number(r.amount_cents), note: r.note, at: new Date(r.created_at), sender: who.get(r.sender_id)!, recipient: who.get(r.recipient_id)!, reversed: r.reversed, status: r.federation_status }]),
	);
}

// ---- requests

export type Request = { id: string; amount: number | null; note: string; status: string; at: Date; requester: Party; payer: Party | null; paidCount: number; paidCents: number };

// requests by id; `visibleTo` keeps the ones of anyone, the ones that account
// is part of, and the ones its requester put in a post
export async function requests(ids: string[], visibleTo?: string): Promise<Map<string, Request>> {
	if (!ids.length) return new Map();
	const rows = await sql`select q.id::text, q.amount_cents, q.note, q.status, q.created_at, q.requester_id::text, q.payer_id::text,
			(select count(*)::int from money_transfers t where t.request_id = q.id and t.reversed_at is null) as paid_count,
			(select coalesce(sum(t.amount_cents), 0)::bigint from money_transfers t where t.request_id = q.id and t.reversed_at is null) as paid_cents
		from money_requests q where q.id = any(${sql.array(ids, "INT8")})
		${
			visibleTo
				? sql`and (q.payer_id is null or ${visibleTo}::bigint in (q.requester_id, q.payer_id) or exists (select 1 from posts p
				where p.user_id = q.requester_id and ${postSeenBy(visibleTo)} and p.text ~ ('/i/xmoney/r/' || q.id::text || '([^0-9]|$)')))`
				: sql``
		}`;
	const who = await parties(rows.flatMap((r: any) => [r.requester_id, ...(r.payer_id ? [r.payer_id] : [])]));
	return new Map(
		rows
			.filter((r: any) => who.has(r.requester_id))
			.map((r: any) => [
				r.id,
				{
					id: r.id,
					amount: r.amount_cents ? Number(r.amount_cents) : null,
					note: r.note,
					status: r.status,
					at: new Date(r.created_at),
					requester: who.get(r.requester_id)!,
					payer: r.payer_id ? (who.get(r.payer_id) ?? null) : null,
					paidCount: r.paid_count,
					paidCents: Number(r.paid_cents),
				},
			]),
	);
}

// ---- addresses and cards

export const paymentUrl = (id: string) => `${PUBLIC_ORIGIN}/i/xmoney/p/${id}`;
export const requestUrl = (id: string) => `${PUBLIC_ORIGIN}/i/xmoney/r/${id}`;
const OWN_HOST = new URL(PUBLIC_ORIGIN).host;
const MONEY_PATH = /^\/i\/xmoney\/([pr])\/(\d{1,19})\/?$/;
// "p<id>" for a payment's address, "r<id>" for a request's
export function moneyKeyOf(url: string): string | undefined {
	try {
		const u = new URL(url);
		const m = u.host === OWN_HOST ? MONEY_PATH.exec(u.pathname) : null;
		return m ? m[1] + m[2] : undefined;
	} catch {
		return undefined;
	}
}

// The card as X draws a payment in a post: a person paid shows the amount, both
// faces and the note; a merchant is a purchase, with its banner and logo when
// it shows a banner. `by` is the handle of the account the card speaks for.
// The card leads to the account that was paid.
// From the payments feed (`fromFeed`) it names both sides and leaves the note out.
export function paymentCard(t: Payment, by: string, fromFeed = false) {
	const go = `data-xm-go="/${esc(t.recipient.screen_name)}"`;
	const r = t.recipient;
	if (r.merchant) {
		const name = `<span class="xm-who"><b>${esc(r.merchant.name)}</b>${badges(r)}</span>`;
		if (r.merchant.banner)
			return `<div class="xm-card xm-shop" role="link" tabindex="0" ${go}><div class="xm-banner" style="background-image:url(&quot;${esc(r.merchant.banner)}&quot;)"></div>
<div class="xm-body">${face(r, "xm-logo")}<div class="xm-row">${name}<span class="xm-dim">${date(t.at)}</span></div>
<div class="xm-rule"></div><div class="xm-amt">${shortCents(t.amount)}</div><div class="xm-dim">with ${MONEY_WORDMARK}</div></div></div>`;
		return `<div class="xm-card xm-buy" role="link" tabindex="0" ${go}>${face(r, "xm-logo")}
<div class="xm-grow"><div class="xm-line"><b>${shortCents(t.amount)}</b> <span class="xm-dim">at</span> ${name}</div><div class="xm-dim">with ${MONEY_WORDMARK}</div></div><span class="xm-dim xm-end">${date(t.at)}</span></div>`;
	}
	const sent = by !== r.screen_name.toLowerCase();
	const other = sent ? r : t.sender;
	return `<div class="xm-card xm-p2p" role="link" tabindex="0" ${go}><div class="xm-row"><div class="xm-amt">${shortCents(t.amount)}</div>
<div class="xm-faces">${face(t.sender)}${face(r)}</div></div>
<div class="xm-line">${
		fromFeed
			? `<span class="xm-who"><b>${esc(t.sender.name)}</b>${badges(t.sender)}</span> <span class="xm-dim">sent to</span> <span class="xm-who"><b>${esc(r.name)}</b>${badges(r)}</span>`
			: `<span class="xm-dim">${sent ? "sent to" : "from"}</span> <span class="xm-who"><b>${esc(other.name)}</b>${badges(other)}</span>`
	}</div>
<div class="xm-row">${t.note && !fromFeed ? `<span class="xm-dim xm-note">"${esc(t.note)}"</span>` : "<span></span>"}<span class="xm-dim">${date(t.at)}</span></div></div>`;
}

// A request in a post, as X's "Pay @name" card: who to pay, with Money, and a
// Pay button while it's open. A request of one account names both. The Pay
// button pays it, for whoever may; for anyone else (its own requester, say)
// it opens the request. The card leads to the account to pay.
export function requestCard(q: Request, viewerId: string) {
	const r = q.requester;
	const payable = r.id !== viewerId && (!q.payer || q.payer.id === viewerId);
	const to = payable ? `/account/money/send?request=${q.id}` : `/account/money/r/${q.id}`;
	// with Money switched off the card stays, without a way to pay
	const button = !feature("money")
		? ""
		: q.status === "open"
			? `<a class="xm-pay" href="${to}" data-xm-go="${to}">Pay</a>`
			: `<span class="xm-state">${q.status === "paid" ? "Paid" : q.status === "declined" ? "Declined" : "Closed"}</span>`;
	const who = r.merchant ? esc(r.merchant.name) : `@${esc(r.screen_name)}`;
	const line = q.payer
		? `<b>${who}</b>${badges(r)} <span class="xm-dim">requested</span> <b>${q.amount ? shortCents(q.amount) : ""}</b>`
		: `<b>Pay ${who}</b>${badges(r)}${q.amount ? ` <span class="xm-dim">·</span> <b>${shortCents(q.amount)}</b>` : ""}`;
	const sub = q.payer ? `from @${esc(q.payer.screen_name)}${q.note ? ` · ${esc(q.note)}` : ""}` : q.note ? esc(q.note) : `with ${MONEY_WORDMARK}`;
	return `<div class="xm-card xm-req" role="link" tabindex="0" data-xm-go="/${esc(r.screen_name)}">${r.merchant ? face(r, "xm-logo") : ""}
<div class="xm-grow"><div class="xm-line">${line}</div><div class="xm-dim xm-sub">${sub}</div></div>${button}</div>`;
}

// Posts carrying one of their own payments' or requests' links get its card.
// The card is X's plain summary card, which the client script draws over.
export async function paymentCards(posts: { authorId: string; text: string }[]): Promise<(Record<string, unknown> | undefined)[]> {
	const wanted = posts.map((p, index) => ({ ...p, index, key: linksIn(p.text).map((l) => moneyKeyOf(l.url)).find((k) => !!k) })).filter((p) => p.key);
	const ids = (kind: string) => [...new Set(wanted.filter((p) => p.key![0] === kind).map((p) => p.key!.slice(1)))];
	const [paid, asked, feed] = await Promise.all([payments(ids("p")), requests(ids("r")), feedAccount()]);
	const out: (Record<string, unknown> | undefined)[] = posts.map(() => undefined);
	for (const p of wanted) {
		const id = p.key!.slice(1);
		let title: string, description: string, image: string, url: string;
		if (p.key![0] === "p") {
			const t = paid.get(id);
			const byFeed = p.authorId === feed?.id;
			if (!t || (p.authorId !== t.sender.id && p.authorId !== t.recipient.id && !byFeed)) continue;
			const mine = p.authorId === t.sender.id;
			title = byFeed
				? `${t.sender.name} sent ${shortCents(t.amount)} to ${t.recipient.merchant?.name ?? t.recipient.name}`
				: t.recipient.merchant ? `${shortCents(t.amount)} at ${t.recipient.merchant.name}` : mine ? `${shortCents(t.amount)} sent to ${t.recipient.name}` : `${shortCents(t.amount)} from ${t.sender.name}`;
			description = t.note && !byFeed ? `“${t.note}”` : `${settings().instance_name} Equicoins · ${date(t.at)}`;
			image = mine ? t.recipient.avatar : t.sender.avatar;
			url = paymentUrl(id);
		} else {
			const q = asked.get(id);
			if (!q || p.authorId !== q.requester.id) continue;
			title = `Pay ${q.requester.merchant ? q.requester.merchant.name : `@${q.requester.screen_name}`}${q.amount ? ` ${shortCents(q.amount)}` : ""}`;
			description = q.note || `with ${settings().instance_name} Equicoins`;
			image = q.requester.avatar;
			url = requestUrl(id);
		}
		const str = (v: string) => ({ string_value: v, type: "STRING" });
		const img = { image_value: { url: image, width: 400, height: 400, alt: null }, type: "IMAGE" };
		const values: Record<string, unknown> = {
			title: str(title),
			description: str(description),
			domain: str(OWN_HOST),
			vanity_url: { ...str(OWN_HOST), scribe_key: "vanity_url" },
			card_url: { ...str(url), scribe_key: "card_url" },
			thumbnail_image: img,
			thumbnail_image_large: img,
			thumbnail_image_original: img,
		};
		out[p.index] = {
			rest_id: url,
			legacy: {
				binding_values: Object.entries(values).map(([key, value]) => ({ key, value })),
				card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
				name: "summary",
				url,
				user_refs_results: [],
			},
		};
	}
	return out;
}

// ---- the client's calls (/i/api/xitter/money/...)

// GET cards?ids=p1,r2&by=<handle>: the cards the viewer may see, as HTML;
// with preview=1, a request's as others see it (the composer's mockup)
export async function cardsApi(viewer: Viewer, url: URL): Promise<Response> {
	const keys = (url.searchParams.get("ids") ?? "").split(",").filter((k) => /^[pr]\d{1,19}$/.test(k)).slice(0, 40);
	const by = (url.searchParams.get("by") ?? "").toLowerCase();
	const [paid, asked] = await Promise.all([
		payments(keys.filter((k) => k[0] === "p").map((k) => k.slice(1)), viewer.id),
		requests(keys.filter((k) => k[0] === "r").map((k) => k.slice(1)), viewer.id),
	]);
	const out: Record<string, string> = {};
	const feed = settings().money.feed.toLowerCase().replace(/^@/, "");
	for (const [id, t] of paid) out[`p${id}`] = paymentCard(t, by, !!feed && by === feed);
	const preview = url.searchParams.has("preview");
	for (const [id, q] of asked) out[`r${id}`] = requestCard(q, preview ? "" : viewer.id);
	return Response.json(out, { headers: { "cache-control": "private, no-store" } });
}

// GET recent: the viewer's latest payments for the composer's picker
export async function recentApi(viewer: Viewer): Promise<Response> {
	if (!feature("money")) return Response.json([]);
	const rows = await sql`select id::text from money_transfers where sender_id = ${viewer.id}::bigint or recipient_id = ${viewer.id}::bigint order by id desc limit 12`;
	const found = await payments(rows.map((r: any) => r.id));
	return Response.json(
		rows
			.map((r: any) => found.get(r.id))
			.filter((t: Payment | undefined): t is Payment => !!t)
			.map((t: Payment) => {
				const sent = t.sender.id === viewer.id;
				const other = sent ? t.recipient : t.sender;
				return { id: t.id, url: paymentUrl(t.id), amount: shortCents(t.amount), sent, shop: sent && !!other.merchant, name: other.merchant?.name ?? other.name, avatar: other.avatar, note: t.note, date: date(t.at) };
			}),
	);
}

// POST payme: the viewer's plain "Pay @name" card, made the first time
export async function payMeApi(viewer: Viewer): Promise<Response> {
	if (!feature("money") || viewer.actor || viewer.instance) return Response.json({ error: "Equicoins isn't available." }, { status: 403 });
	try {
		return Response.json({ url: requestUrl(await requestMoney(viewer.id, "", "", "")) });
	} catch (e) {
		if (e instanceof MoneyError) return Response.json({ error: e.message }, { status: 403 });
		throw e;
	}
}
