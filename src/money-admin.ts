// Admin > Equicoins (admin.html): settings, how much money there is and
// where it went, and the tools to put it right: adjusting a balance and
// reversing a payment. Every change is in the audit log.

import { AdminError, type Action, audit, guard, idOf } from "./admin";
import { sql } from "./db";
import { newId } from "./ids";
import { MoneyError, accountFor, adjust, formatCents, networkEconomy, parseAmount, unannouncePayment } from "./money";
import { feature, setSetting, settings } from "./settings";
import { allows } from "./staff-permissions";
import { SHOP_DAYS, SHOP_KINDS, shopItems } from "./money-shop";
import { BADGE_TYPES, sniffImage } from "./media";

// what staff below admin may deliver from the shop's queue (admin.html hides Approve for the rest)
export const MODERATOR_DELIVERS = ["badge", "custom_badge"];

// dollars typed in the panel ("100", "0.50") as cents, within limits
function cents(v: unknown, what: string, min: number, max: number) {
	const c = typeof v === "number" ? Math.round(v * 100) : parseAmount(String(v ?? ""));
	if (c === null || !Number.isSafeInteger(c) || c < min || c > max) throw new AdminError(`${what} is an amount from ${formatCents(min)} to ${formatCents(max)}.`);
	return c;
}

const handleOf = (u: string) => `@${u}`;

export const moneyActions: Record<string, Action> = {
	money: {
		role: "moderator",
		run: async (a, b) => {
			const q = typeof b.q === "string" ? b.q.trim().replace(/^@/, "") : "";
			const [totals] = await sql`select
					(select coalesce(sum(balance_cents), 0)::bigint from money_wallets) as circulation,
					(select count(*)::int from money_wallets) as wallets,
					(select count(*)::int from money_transfers where reversed_at is null) as payments,
					(select coalesce(sum(amount_cents), 0)::bigint from money_transfers where reversed_at is null) as volume,
					(select count(*)::int from money_transfers where reversed_at is null and created_at > now() - interval '7 days') as payments_week,
					(select coalesce(sum(amount_cents), 0)::bigint from money_transfers where reversed_at is null and created_at > now() - interval '7 days') as volume_week,
					(select coalesce(sum(cents), 0)::bigint from money_like_rewards) as likes_paid,
					(select count(*)::int from money_requests where status = 'open') as open_requests,
					(select count(*)::int from money_merchants) as merchants`;
			const top = await sql`select u.screen_name, u.name, u.avatar_url, u.verified_type, w.balance_cents::bigint as balance from money_wallets w join users u on u.id = w.user_id
				order by w.balance_cents desc, u.id limit 15`;
			const recent = await sql`select t.id::text, t.amount_cents::bigint as amount, t.note, t.created_at, t.reversed_at, s.screen_name as sender, r.screen_name as recipient
				from money_transfers t join users s on s.id = t.sender_id join users r on r.id = t.recipient_id
				${q ? sql`where lower(s.screen_name) = lower(${q}) or lower(r.screen_name) = lower(${q})` : sql``}
				order by t.id desc limit 50`;
			const [badges, items, pendingOrders, remotePending, [remotePendingCount], remoteItems] = await Promise.all([
				sql`select id::text, name from custom_badges order by name`,
				shopItems(),
				sql`select o.id::text, o.item_name, o.price_cents::bigint as price, o.kind, o.payload, o.days, o.created_at, u.id::text as user_id, u.screen_name,
					r.screen_name as gift_to, (select count(*)::int from money_shop_order_files f where f.order_id = o.id) as files
					from money_shop_orders o join users u on u.id = o.user_id left join users r on r.id = o.recipient_id where o.status = 'pending' order by o.created_at`,
				sql`select origin, remote_id::text as id, name, description, price_cents::bigint as price, kind, badge_name,
					case when badge_image is not null then encode(badge_image, 'base64') end as badge_data, badge_mime
					from money_remote_shop_items where source_active and status = 'pending' order by updated_at desc limit 4`,
				sql`select count(*)::int as n from money_remote_shop_items where source_active and status = 'pending'`,
				sql`select origin, remote_id::text as id, name, price_cents::bigint as price, kind, badge_name, active
					from money_remote_shop_items where source_active and status = 'approved' order by updated_at desc limit 500`,
			]);
			const n = (v: unknown) => Number(v);
			const { ECONOMY_HOME, isEconomyHome, networkTotals } = await import("./money-federation");
			return {
				enabled: feature("money"),
				settings: settings().money,
				economy: { home: ECONOMY_HOME, is_home: isEconomyHome(), network: networkEconomy() },
				network_totals: await networkTotals(),
				shop: {
					...settings().money_shop,
					items: items.map((i: any) => ({ ...i, price: Number(i.price), active: !!i.active })),
					remote_pending: remotePending.map((i: any) => ({ ...i, price: Number(i.price) })),
					remote_pending_count: remotePendingCount.n,
					remote_items: remoteItems.map((i: any) => ({ ...i, price: Number(i.price), active: !!i.active })),
					badges,
					pending: pendingOrders.map((o: any) => ({ ...o, price: Number(o.price) })),
				},
				totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, n(v)])),
				top: top.map((r: any) => ({ ...r, balance: n(r.balance) })),
				// what people wrote on their payments is theirs: only staff who may put payments right see it
				recent: recent.map((r: any) => ({ ...r, amount: n(r.amount), note: allows(a.role, "money") ? r.note : "" })),
				notes: allows(a.role, "money"),
			};
		},
	},
	saveMoney: {
		role: "admin",
		run: async (a, b) => {
			// the payments feed: an account here, or none
			const feedHandle = String(b.feed ?? "").trim().replace(/^@/, "");
			const feed = feedHandle ? await accountFor(feedHandle) : null;
			if (feedHandle && (!feed || feed.instance)) throw new AdminError(`There's no account here called @${feedHandle} to post the payments.`);
			const next = {
				starting_cents: cents(b.starting, "The starting balance", 0, 100_000_000),
				max_transfer_cents: cents(b.max_transfer, "The most one payment moves", 1, 10_000_000_000),
				like_cents: cents(b.like, "The like reward", 0, 100_000),
				feed: feed?.screen_name ?? "",
				follow_network: b.follow_network === true,
				peer_daily_cents: cents(String(b.peer_daily ?? "").trim() || "0", "The daily limit from one instance", 0, 10_000_000_000),
				peer_daily_move_cents: cents(String(b.peer_move_daily ?? "").trim() || "0", "The daily limit of moved balances from one instance", 0, 10_000_000_000),
				move_balance: b.move_balance !== false,
				network_totals: b.network_totals === true,
			};
			await setSetting("money", next);
			await audit(a, "money_settings", null, next);
			return { settings: next };
		},
	},
	adjustMoney: {
		role: "admin",
		run: async (a, b) => {
			const text = String(b.amount ?? "").trim();
			const c = parseAmount(text.replace(/^-/, ""));
			if (!c) throw new AdminError("Enter an amount, like 20 or -5.00.");
			try {
				return await adjust(a, String(b.handle ?? ""), text.startsWith("-") ? -c : c);
			} catch (e) {
				if (e instanceof MoneyError) throw new AdminError(e.message);
				throw e;
			}
		},
	},
	saveShop: {
		role: "admin",
		run: async (a, b) => {
			const next = { ...settings().money_shop, enabled: b.enabled === true };
			await setSetting("money_shop", next);
			await audit(a, "money_shop_settings", null, { enabled: next.enabled });
			return { shop: next };
		},
	},
	// the paid announcement comes down; the instance's own (Settings) shows again
	clearShopAnnouncement: {
		role: "admin",
		run: async (a) => {
			const was = settings().money_shop.announcement;
			if (!was) throw new AdminError("There's no paid announcement up.");
			await setSetting("money_shop", { ...settings().money_shop, announcement: null });
			await audit(a, "money_shop_announcement_clear", was.id, { text: was.text });
			return {};
		},
	},
	// An admin's listing goes up at once; one from staff below admin waits for an admin.
	createShopItem: {
		role: "moderator",
		run: async (a, b) => {
			const name = String(b.name ?? "").trim();
			const description = String(b.description ?? "").trim();
			if (!name || [...name].length > 60) throw new AdminError("Item names are 1 to 60 characters.");
			if ([...description].length > 240) throw new AdminError("Descriptions are up to 240 characters.");
			const price = cents(b.price, "The item price", 1, 1_000_000_000);
			const kind = SHOP_KINDS.includes(String(b.kind)) ? String(b.kind) : null;
			if (!kind) throw new AdminError("Choose an item type.");
			const days = SHOP_DAYS[kind] ? Math.trunc(Number(String(b.days ?? "").trim() || SHOP_DAYS[kind])) : null;
			if (days !== null && !(days >= 1 && days <= 365)) throw new AdminError("A listing lasts 1 to 365 days.");
			let badgeId: string | null = null;
			if (kind === "badge") {
				badgeId = idOf(b.badgeId, "badge");
				if (!(await sql`select 1 from custom_badges where id = ${badgeId}::bigint`).length) throw new AdminError("Choose an existing custom badge.");
			}
			const id = newId();
			const approved = a.role === "admin";
			await sql`insert into money_shop_items (id, name, description, price_cents, kind, badge_id, days, active, status, created_by, approved_by, approved_at)
				values (${id}::bigint, ${name}, ${description}, ${price}, ${kind}, ${badgeId}::bigint, ${days}, ${approved}, ${approved ? "approved" : "pending"}, ${a.id}::bigint,
					${approved ? a.id : null}::bigint, ${approved ? new Date() : null})`;
			await audit(a, "money_shop_item_create", id, { name, price, kind, badgeId, days, approved });
			return { id, approved };
		},
	},
	reviewShopItem: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id, "shop item");
			const approve = b.approve === true;
			const item = await sql.begin(async (tx) => {
				const [row] = await tx`select name, status, created_by::text from money_shop_items where id = ${id}::bigint for update`;
				if (!row) throw new AdminError("No such shop item.", 404);
				if (row.status !== "pending") throw new AdminError("That shop item has already been reviewed.");
				await tx`update money_shop_items set status = ${approve ? "approved" : "rejected"}, active = ${approve},
					approved_by = ${approve ? a.id : null}::bigint, approved_at = case when ${approve} then now() else null end
					where id = ${id}::bigint`;
				return row;
			});
			await audit(a, approve ? "money_shop_item_approve" : "money_shop_item_reject", id, { name: item.name });
			return {};
		},
	},
	reviewRemoteShopItem: {
		role: "moderator",
		run: async (a, b) => {
			const origin = String(b.origin ?? "").toLowerCase();
			if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(origin)) throw new AdminError("Choose a valid source instance.");
			const id = idOf(b.id, "remote shop item");
			const approve = b.approve === true;
			const rows = await sql`update money_remote_shop_items set status = ${approve ? "approved" : "rejected"}, active = ${approve},
				reviewed_by = ${a.id}::bigint, reviewed_at = now(), updated_at = now()
				where origin = ${origin} and remote_id = ${id}::bigint and source_active and status = 'pending' returning name, price_cents::bigint as price`;
			if (!rows.length) throw new AdminError("That imported listing is no longer waiting for review.");
			await audit(a, approve ? "money_remote_shop_approve" : "money_remote_shop_reject", `${origin}/${id}`, { name: rows[0].name, price: Number(rows[0].price) });
			return {};
		},
	},
	setShopItem: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			const rows = await sql`update money_shop_items set active = ${b.active === true} where id = ${id}::bigint and status = 'approved' returning name, active`;
			if (!rows.length) throw new AdminError("No such shop item.", 404);
			await audit(a, "money_shop_item_update", id, { active: rows[0].active });
			return {};
		},
	},
	setRemoteShopItem: {
		role: "admin",
		run: async (a, b) => {
			const origin = String(b.origin ?? "").toLowerCase();
			if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(origin)) throw new AdminError("Choose a valid source instance.");
			const id = idOf(b.id, "remote shop item");
			const rows = await sql`update money_remote_shop_items set active = ${b.active === true}, updated_at = now()
				where origin = ${origin} and remote_id = ${id}::bigint and source_active and status = 'approved' returning name, active`;
			if (!rows.length) throw new AdminError("No such approved imported listing.", 404);
			await audit(a, "money_remote_shop_update", `${origin}/${id}`, { name: rows[0].name, active: rows[0].active });
			return {};
		},
	},
	reviewShopOrder: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id, "order");
			const approve = b.approve === true;
			const result = await sql.begin(async (tx) => {
				const [order] = await tx`select id::text, user_id::text, recipient_id::text, item_name, price_cents::bigint as price, kind, payload, days, status
					from money_shop_orders where id = ${id}::bigint for update`;
				if (!order) throw new AdminError("No such shop request.", 404);
				if (order.status !== "pending") throw new AdminError("That shop request has already been reviewed.");
				// a badge is the shop's business; the rest hands out what only admins give elsewhere in the panel
				if (approve && !MODERATOR_DELIVERS.includes(order.kind) && a.role !== "admin" && !a.superadmin)
					throw new AdminError("Only an admin can deliver this kind of request.", 403);
				// a gift goes to its recipient; the buyer paid and gets any refund
				const target: string = order.recipient_id ?? order.user_id;
				const days = Number(order.days) || 1;
				const files = await tx`select position, name, image, mime from money_shop_order_files where order_id = ${id}::bigint order by position`;
				if (approve && order.kind === "custom_badge") {
					const name = String(order.payload?.name ?? "").trim();
					const encoded = typeof order.payload?.image === "string" ? order.payload.image : "";
					if (!name || [...name].length > 60 || !encoded || encoded.length > 350_000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AdminError("That badge request has invalid details; reject it to refund the user.");
					const image = Buffer.from(encoded, "base64");
					const info = sniffImage(image);
					if (image.length > 256 * 1024 || !info || !BADGE_TYPES.includes(info.mime) || info.width > 1024 || info.height > 1024) throw new AdminError("That badge image is invalid; reject it to refund the user.");
					const [count] = await tx`select count(*)::int as n from user_badges where user_id = ${target}::bigint`;
					if (Number(count.n) >= 10) throw new AdminError("The account already has 10 custom badges; reject this request to refund it.");
					const badgeId = newId();
					await tx`insert into custom_badges (id, name, image, mime) values (${badgeId}::bigint, ${name}, ${image}, ${info.mime})`;
					const [position] = await tx`select coalesce(max(position), -1) + 1 as n from user_badges where user_id = ${target}::bigint`;
					await tx`insert into user_badges (user_id, badge_id, position) values (${target}::bigint, ${badgeId}::bigint, ${Number(position.n)})`;
				}
				if (approve && order.kind === "badge") {
					const badgeId = idOf(order.payload?.badgeId, "badge");
					if (!(await tx`select 1 from custom_badges where id = ${badgeId}::bigint`).length) throw new AdminError("That badge was removed; reject this request to refund it.");
					const [exists] = await tx`select 1 from user_badges where user_id = ${target}::bigint and badge_id = ${badgeId}::bigint`;
					if (!exists) {
						const [position] = await tx`select coalesce(max(position), -1) + 1 as n from user_badges where user_id = ${target}::bigint`;
						await tx`insert into user_badges (user_id, badge_id, position) values (${target}::bigint, ${badgeId}::bigint, ${Number(position.n)}) on conflict do nothing`;
					}
				}
				if (approve && order.kind === "checkmark") {
					const [u] = await tx`select verified_type, shop_verified_until from users where id = ${target}::bigint for update`;
					if (u?.verified_type && !u.shop_verified_until) throw new AdminError("The account has a checkmark from staff already; reject this request to refund it.");
					// a second one adds its days to the first
					await tx`update users set verified_type = 'blue', verified_at = case when verified_type = 'blue' then verified_at else now() end,
						shop_verified_until = greatest(coalesce(shop_verified_until, now()), now()) + ${days} * interval '1 day' where id = ${target}::bigint`;
				}
				if (approve && order.kind === "hashflag") {
					const hashtag = String(order.payload?.hashtag ?? "");
					const [running] = await tx`select 1 from hashflags where lower(hashtag) = lower(${hashtag}) and ends_at > now()`;
					if (running) throw new AdminError(`#${hashtag} has a hashflag running already; reject this request to refund it.`);
					if (!files[0]) throw new AdminError("The emoji is missing; reject this request to refund it.");
					await tx`insert into hashflags (id, hashtag, starts_at, ends_at, emoji, emoji_mime)
						values (${newId()}::bigint, ${hashtag}, now(), now() + ${days} * interval '1 day', ${files[0].image}, ${files[0].mime})`;
				}
				if (approve && order.kind === "sticker_pack") {
					if (!files.length) throw new AdminError("The stickers are missing; reject this request to refund it.");
					const pack = newId();
					await tx`insert into sticker_packs (id, name, position) values (${pack}::bigint, ${String(order.payload?.name ?? "Stickers")}, (select coalesce(max(position), 0) + 1 from sticker_packs))`;
					for (const f of files)
						await tx`insert into stickers (id, pack_id, name, image, mime, position) values (${newId()}::bigint, ${pack}::bigint, ${f.name}, ${f.image}, ${f.mime}, ${f.position})`;
				}
				if (approve && order.kind === "explore_card") {
					const p = order.payload ?? {};
					const f = files[0];
					await tx`insert into explore_cards (id, kind, title, summary, category, query, image, image_mime, image_width, image_height, ends_at)
						values (${newId()}::bigint, 'news', ${String(p.title ?? "")}, ${String(p.summary ?? "")}, 'Featured', ${String(p.query ?? "")},
							${f?.image ?? null}, ${f?.mime ?? null}, ${f ? Number(p.width) : null}, ${f ? Number(p.height) : null}, now() + ${days} * interval '1 day')`;
				}
				if (approve && order.kind === "boost") {
					const [post] = await tx`select 1 from posts where id = ${String(order.payload?.postId ?? "0")}::bigint and user_id = ${order.user_id}::bigint and not hidden`;
					if (!post) throw new AdminError("That post is gone; reject this request to refund it.");
					await tx`insert into post_boosts (id, post_id, user_id, order_id, ends_at)
						values (${newId()}::bigint, ${String(order.payload.postId)}::bigint, ${order.user_id}::bigint, ${id}::bigint, now() + ${days} * interval '1 day')`;
				}
				await tx`delete from money_shop_order_files where order_id = ${id}::bigint`;
				if (!approve) {
					await tx`insert into money_wallets (user_id, balance_cents) values (${order.user_id}::bigint, 0) on conflict do nothing`;
					await tx`update money_wallets set balance_cents = balance_cents + ${Number(order.price)} where user_id = ${order.user_id}::bigint`;
				}
				await tx`update money_shop_orders set status = ${approve ? "approved" : "rejected"}, reviewed_at = now(), reviewed_by = ${a.id}::bigint where id = ${id}::bigint`;
				return order;
			});
			if (approve && result.kind === "announcement") {
				const text = String(result.payload?.text ?? "").trim();
				const link = String(result.payload?.link ?? "");
				await setSetting("money_shop", { ...settings().money_shop, announcement: { id, text, buttons: link ? [{ label: "Learn more", url: link }] : [] } });
			}
			await audit(a, approve ? "money_shop_approve" : "money_shop_reject", id, { user: result.user_id, item: result.item_name, refund: !approve });
			return {};
		},
	},
	// the money goes back from the recipient to the sender, if they still have it
	reverseTransfer: {
		role: "admin",
		run: async (a, b) => {
			const id = idOf(b.id);
			return sql.begin(async (tx) => {
				const [t] = await tx`select t.sender_id::text, t.recipient_id::text, t.amount_cents::bigint as amount, t.reversed_at, t.federation_status,
					r.screen_name as recipient, s.instance as sender_instance, r.instance as recipient_instance
					from money_transfers t join users r on r.id = t.recipient_id join users s on s.id = t.sender_id where t.id = ${id}::bigint for update of t`;
				if (!t) throw new AdminError("There's no such payment.", 404);
				if (t.reversed_at) throw new AdminError("That payment was already reversed.");
				if (t.federation_status === "pending") throw new AdminError("Wait for this federated transfer to settle before reversing it.");
				if (t.federation_status === "failed") throw new AdminError("That transfer failed and the money was already refunded.");
				if (t.sender_instance || t.recipient_instance) throw new AdminError("Federated payments cannot be reversed from this instance.");
				await guard(a, t.recipient_id);
				const amount = Number(t.amount);
				const wallets = await tx`select user_id::text, balance_cents from money_wallets where user_id in (${t.sender_id}::bigint, ${t.recipient_id}::bigint) order by user_id for update`;
				const theirs = Number(wallets.find((w: any) => w.user_id === t.recipient_id)?.balance_cents ?? 0);
				if (theirs < amount) throw new AdminError(`${handleOf(t.recipient)} has only ${formatCents(theirs)} left. Adjust their balance, or reverse less.`);
				await tx`update money_wallets set balance_cents = balance_cents - ${amount} where user_id = ${t.recipient_id}::bigint`;
				await tx`update money_wallets set balance_cents = balance_cents + ${amount} where user_id = ${t.sender_id}::bigint`;
				await tx`update money_transfers set reversed_at = now(), reversed_by = ${a.id}::bigint where id = ${id}::bigint`;
				// a request paid by this transfer is unpaid again, so its payer can retry
				await tx`update money_requests q set status = 'open', resolved_at = null
					where q.id = (select t.request_id from money_transfers t where t.id = ${id}::bigint)
						and q.payer_id is not null and q.status = 'paid'
						and not exists (select 1 from money_transfers t where t.request_id = q.id and t.reversed_at is null)`;
				await audit(a, "money_reverse", id, { amount, from: t.recipient_id, to: t.sender_id });
			}).then(async () => {
				await unannouncePayment(id);
				return {};
			});
		},
	},
};
