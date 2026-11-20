import { AdminError, type Action, audit, idOf } from "./admin";
import { sql } from "./db";
import { newId } from "./ids";
import { blockedFor, outOfView } from "./blocks";
import { formatCents } from "./money";
import { createPost } from "./posts";
import { settings } from "./settings";

export class AdError extends Error {}

export type AdStatus = "pending" | "running" | "paused" | "ended" | "rejected" | "cancelled";

const AD_TEXT_MAX = 280;
const AD_URL_MAX = 500;

const adCols = sql`id::text, user_id::text, text, url, budget_cents::bigint as budget_cents, spent_cents::bigint as spent_cents,
	refunded_cents::bigint as refunded_cents, days, status, reject_reason, created_at, reviewed_at, starts_at, ends_at,
	ad_only, post_id::text as post_id, views`;

const toAd = (r: any) => ({
	id: r.id as string,
	userId: r.user_id as string,
	text: r.text as string,
	url: (r.url as string | null) ?? null,
	budgetCents: Number(r.budget_cents),
	spentCents: Number(r.spent_cents),
	refundedCents: Number(r.refunded_cents),
	days: Number(r.days),
	status: r.status as AdStatus,
	rejectReason: (r.reject_reason as string | null) ?? null,
	createdAt: r.created_at as Date,
	reviewedAt: (r.reviewed_at as Date | null) ?? null,
	startsAt: (r.starts_at as Date | null) ?? null,
	endsAt: (r.ends_at as Date | null) ?? null,
	adOnly: !!r.ad_only,
	postId: (r.post_id as string | null) ?? null,
	views: Number(r.views ?? 0),
});

export type Ad = ReturnType<typeof toAd>;

export type Economy = { supplyCents: number; weeklyMintCents: number; projectedCents: number };

export function priceFor(runningCents: number, economy: Pick<Economy, "projectedCents">) {
	const { base_cpm_cents, price_scale_cents, economy_cpm_ppm, demand_share_pct } = settings().ads;
	const base = Math.max(base_cpm_cents, Math.round((economy.projectedCents * economy_cpm_ppm) / 1_000_000));
	const scale = Math.max(price_scale_cents, (economy.projectedCents * demand_share_pct) / 100);
	return Math.max(1, Math.round(base * (1 + Math.log2(1 + runningCents / scale))));
}

let economyCache: { at: number; value: Economy } | undefined;

export async function economyNow(db: typeof sql = sql): Promise<Economy> {
	if (economyCache && Date.now() - economyCache.at < 5 * 60_000) return economyCache.value;
	const [row] = await db`select
		(select coalesce(sum(balance_cents), 0) from money_wallets w join users u on u.id = w.user_id where u.instance is null)::bigint as supply,
		(select count(*) from money_wallets where created_at > now() - interval '7 days')::bigint as wallets,
		(select coalesce(sum(cents), 0) from money_like_rewards where created_at > now() - interval '7 days')::bigint as likes,
		(select coalesce(sum(budget_cents - spent_cents), 0) from ads where status in ('pending', 'running', 'paused'))::bigint as held`;
	const supplyCents = Number(row.supply) + Number(row.held);
	const weeklyMintCents = Number(row.wallets) * settings().money.starting_cents + Number(row.likes);
	const value = { supplyCents, weeklyMintCents, projectedCents: supplyCents + Math.round((weeklyMintCents * settings().ads.max_days) / 7) };
	economyCache = { at: Date.now(), value };
	return value;
}

export async function currentPrice(db: typeof sql = sql) {
	const [row] = await db`select coalesce(sum(budget_cents - spent_cents), 0)::bigint as cents from ads where status = 'running' and ends_at > now()`;
	return priceFor(Number(row.cents), await economyNow(db));
}

export const estimateViews = (budgetCents: number, cpmCents: number) => Math.floor((budgetCents * 1000) / cpmCents);

async function refund(tx: typeof sql, userId: string, cents: number) {
	if (cents <= 0) return;
	await tx`insert into money_wallets (user_id, balance_cents) values (${userId}::bigint, 0) on conflict do nothing`;
	await tx`update money_wallets set balance_cents = balance_cents + ${cents} where user_id = ${userId}::bigint`;
}

export async function createAd(userId: string, input: { text?: unknown; url?: unknown; budgetCents?: unknown; days?: unknown; adOnly?: unknown }): Promise<Ad> {
	const rules = settings().ads;
	if (!rules.enabled) throw new AdError("Ads aren't open on this instance.");
	const text = typeof input.text === "string" ? input.text.trim() : "";
	if (!text) throw new AdError("Write what the ad says.");
	if ([...text].length > AD_TEXT_MAX) throw new AdError(`An ad is at most ${AD_TEXT_MAX} characters.`);
	const url = typeof input.url === "string" && input.url.trim() ? input.url.trim() : null;
	if (url && (url.length > AD_URL_MAX || !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url))) throw new AdError("The link must be an http or https address.");
	const budget = Number(input.budgetCents);
	if (!Number.isSafeInteger(budget) || budget < rules.min_spend_cents) throw new AdError(`The budget is at least ${formatCents(rules.min_spend_cents)} Equicoins.`);
	const days = Number(input.days);
	if (!Number.isInteger(days) || days < 1 || days > rules.max_days) throw new AdError(`An ad runs for 1 to ${rules.max_days} days.`);
	const row = await sql.begin(async (tx) => {
		const [user] = await tx`select status, deactivated_at, instance from users where id = ${userId}::bigint`;
		if (!user || user.instance || user.deactivated_at || user.status === "suspended" || user.status === "restricted") throw new AdError("Your account can't run ads right now.");
		const [pending] = await tx`select count(*)::int as n from ads where user_id = ${userId}::bigint and status = 'pending'`;
		if (Number(pending.n) >= rules.max_pending) throw new AdError(`You have ${rules.max_pending} ads waiting for review. Wait for those first.`);
		const [wallet] = await tx`select balance_cents::bigint as cents from money_wallets where user_id = ${userId}::bigint for update`;
		if (!wallet || Number(wallet.cents) < budget) throw new AdError("You don't have enough Equicoins for that budget.");
		await tx`update money_wallets set balance_cents = balance_cents - ${budget} where user_id = ${userId}::bigint`;
		const [made] = await tx`insert into ads (id, user_id, text, url, budget_cents, days, status, ad_only)
			values (${newId()}::bigint, ${userId}::bigint, ${text}, ${url}, ${budget}, ${days}, 'pending', ${input.adOnly !== false}) returning ${adCols}`;
		return made;
	});
	return toAd(row);
}

export async function myAds(userId: string): Promise<Ad[]> {
	await endExpiredAds();
	const rows = await sql`select ${adCols} from ads where user_id = ${userId}::bigint order by id desc limit 200`;
	return rows.map(toAd);
}

export async function cancelAd(userId: string, adId: string): Promise<Ad> {
	const row = await sql.begin(async (tx) => {
		const [ad] = await tx`select ${adCols} from ads where id = ${adId}::bigint and user_id = ${userId}::bigint for update`;
		if (!ad) throw new AdError("No such ad.");
		if (!["pending", "running", "paused"].includes(ad.status)) throw new AdError("That ad has already finished.");
		const back = Number(ad.budget_cents) - Number(ad.spent_cents);
		await refund(tx, userId, back);
		const [done] = await tx`update ads set status = 'cancelled', refunded_cents = ${back}, ends_at = least(coalesce(ends_at, now()), now())
			where id = ${adId}::bigint returning ${adCols}`;
		return done;
	});
	return toAd(row);
}

export async function endExpiredAds() {
	await sql.begin(async (tx) => {
		const done = await tx`update ads set status = 'ended', refunded_cents = budget_cents - spent_cents
			where status in ('running', 'paused') and ends_at <= now() returning user_id::text, (budget_cents - spent_cents)::bigint as back`;
		for (const ad of done) await refund(tx, ad.user_id, Number(ad.back));
	});
}

export const VIEWS_PER_DAY = 3;
const RECHARGE = "1 hour";

export async function pickAd(viewerId: string, onPage: string[]): Promise<{ adId: string; postId: string } | undefined> {
	if (!settings().ads.enabled) return undefined;
	const [ad] = await sql`select a.id::text as ad_id, a.post_id::text as post_id from ads a join posts p on p.id = a.post_id
		where a.status = 'running' and a.ends_at > now() and a.spent_milli < a.budget_cents * 1000
			and not p.hidden and p.user_id <> ${viewerId}::bigint
			and p.user_id not in ${blockedFor(viewerId)} and p.user_id not in ${outOfView(viewerId)}
			and not (a.post_id = any(${sql.array(onPage, "INT8")}))
			and not exists (select 1 from users me where me.id = ${viewerId}::bigint and me.preferences->>'hide_ads' = 'true')
			and coalesce((select v.n from ad_views v where v.ad_id = a.id and v.viewer_id = ${viewerId}::bigint and v.day = current_date), 0) < ${VIEWS_PER_DAY}
		order by -ln(1 - random()) / (a.budget_cents * 1000 - a.spent_milli) limit 1`;
	return ad ? { adId: ad.ad_id, postId: ad.post_id } : undefined;
}

export async function chargeView(adId: string, viewerId: string) {
	await sql.begin(async (tx) => {
		const [seen] = await tx`insert into ad_views (ad_id, viewer_id, n) values (${adId}::bigint, ${viewerId}::bigint, 1)
			on conflict (ad_id, viewer_id, day) do update set n = ad_views.n + 1, last_at = now()
				where ad_views.last_at < now() - ${RECHARGE}::interval
			returning n`;
		if (!seen) return;
		const price = await currentPrice(tx);
		const [ad] = await tx`update ads set views = views + 1, spent_milli = least(budget_cents * 1000, spent_milli + ${price}),
			spent_cents = least(budget_cents, (least(budget_cents * 1000, spent_milli + ${price})) / 1000)
			where id = ${adId}::bigint and status = 'running' returning spent_milli, budget_cents`;
		if (ad && Number(ad.spent_milli) >= Number(ad.budget_cents) * 1000) await tx`update ads set status = 'ended', ends_at = now() where id = ${adId}::bigint`;
	});
}

export const adActions: Record<string, Action> = {
	ads: {
		role: "moderator",
		run: async (_a, b) => {
			await endExpiredAds();
			const status = ["pending", "running", "paused", "ended", "rejected", "cancelled"].includes(String(b.status)) ? String(b.status) : "pending";
			const rows = await sql`select ${adCols}, (select screen_name from users u where u.id = ads.user_id) as screen_name
				from ads where status = ${status} order by id ${status === "pending" ? sql`asc` : sql`desc`} limit 200`;
			return { ads: rows.map((r: any) => ({ ...toAd(r), screenName: r.screen_name })), price: await currentPrice(), economy: await economyNow() };
		},
	},
	reviewAd: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id, "ad");
			const approve = b.approve === true;
			const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
			if (!approve && !reason) throw new AdminError("Say why the ad is rejected; the advertiser sees it.");
			const ad = await sql.begin(async (tx) => {
				const [row] = await tx`select ${adCols} from ads where id = ${id}::bigint for update`;
				if (!row) throw new AdminError("No such ad.", 404);
				if (row.status !== "pending") throw new AdminError("That ad has already been reviewed.");
				if (approve) {
					const postId = await createPost(row.user_id, row.url ? `${row.text}\n\n${row.url}` : row.text, { db: tx, skipReview: true });
					if (row.ad_only) {
						await tx`update posts set ad_only = true where id = ${postId}::bigint`;
						await tx`update user_stats set posts = greatest(posts - 1, 0) where user_id = ${row.user_id}::bigint`;
					}
					const [done] = await tx`update ads set status = 'running', reviewed_at = now(), reviewed_by = ${a.id}::bigint, post_id = ${postId}::bigint,
						starts_at = now(), ends_at = now() + days * interval '1 day' where id = ${id}::bigint returning ${adCols}`;
					return done;
				}
				const back = Math.floor((Number(row.budget_cents) * settings().ads.reject_refund_pct) / 100);
				await refund(tx, row.user_id, back);
				const [done] = await tx`update ads set status = 'rejected', reviewed_at = now(), reviewed_by = ${a.id}::bigint,
					reject_reason = ${reason}, refunded_cents = ${back} where id = ${id}::bigint returning ${adCols}`;
				return done;
			});
			await audit(a, approve ? "ad_approve" : "ad_reject", ad.user_id, { ad: id, budget: Number(ad.budget_cents), refunded: Number(ad.refunded_cents), ...(reason ? { reason } : {}) });
			return { ad: toAd(ad) };
		},
	},
};
