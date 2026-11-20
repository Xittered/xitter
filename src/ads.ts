import { AdminError, type Action, audit, idOf } from "./admin";
import { sql } from "./db";
import { newId } from "./ids";
import { formatCents } from "./money";
import { settings } from "./settings";

export class AdError extends Error {}

export type AdStatus = "pending" | "running" | "paused" | "ended" | "rejected" | "cancelled";

const AD_TEXT_MAX = 280;
const AD_URL_MAX = 500;

const adCols = sql`id::text, user_id::text, text, url, budget_cents::bigint as budget_cents, spent_cents::bigint as spent_cents,
	refunded_cents::bigint as refunded_cents, days, status, reject_reason, created_at, reviewed_at, starts_at, ends_at`;

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
});

export type Ad = ReturnType<typeof toAd>;

export function priceFor(runningCents: number) {
	const { base_cpm_cents, price_scale_cents } = settings().ads;
	return Math.max(1, Math.round(base_cpm_cents * (1 + Math.log2(1 + runningCents / price_scale_cents))));
}

export async function currentPrice(db: typeof sql = sql) {
	const [row] = await db`select coalesce(sum(budget_cents - spent_cents), 0)::bigint as cents from ads where status = 'running' and ends_at > now()`;
	return priceFor(Number(row.cents));
}

export const estimateViews = (budgetCents: number, cpmCents: number) => Math.floor((budgetCents * 1000) / cpmCents);

async function refund(tx: typeof sql, userId: string, cents: number) {
	if (cents <= 0) return;
	await tx`insert into money_wallets (user_id, balance_cents) values (${userId}::bigint, 0) on conflict do nothing`;
	await tx`update money_wallets set balance_cents = balance_cents + ${cents} where user_id = ${userId}::bigint`;
}

export async function createAd(userId: string, input: { text?: unknown; url?: unknown; budgetCents?: unknown; days?: unknown }): Promise<Ad> {
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
		const [made] = await tx`insert into ads (id, user_id, text, url, budget_cents, days, status)
			values (${newId()}::bigint, ${userId}::bigint, ${text}, ${url}, ${budget}, ${days}, 'pending') returning ${adCols}`;
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

export const adActions: Record<string, Action> = {
	ads: {
		role: "moderator",
		run: async (_a, b) => {
			await endExpiredAds();
			const status = ["pending", "running", "paused", "ended", "rejected", "cancelled"].includes(String(b.status)) ? String(b.status) : "pending";
			const rows = await sql`select ${adCols}, (select screen_name from users u where u.id = ads.user_id) as screen_name
				from ads where status = ${status} order by id ${status === "pending" ? sql`asc` : sql`desc`} limit 200`;
			return { ads: rows.map((r: any) => ({ ...toAd(r), screenName: r.screen_name })), price: await currentPrice() };
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
					const [done] = await tx`update ads set status = 'running', reviewed_at = now(), reviewed_by = ${a.id}::bigint,
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
