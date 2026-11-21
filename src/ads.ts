import { sql } from "./db";
import { newId } from "./ids";
import { blockedFor, outOfView, shadowedFor } from "./blocks";
import { formatCents } from "./money";
import { settings } from "./settings";

export class AdError extends Error {}

export type AdStatus = "pending" | "running" | "paused" | "ended" | "rejected" | "cancelled";

const AD_TEXT_MAX = 280;
const AD_URL_MAX = 500;
const AD_NAME_MAX = 60;

export const adCols = sql`id::text, user_id::text, text, url, budget_cents::bigint as budget_cents, spent_cents::bigint as spent_cents,
	refunded_cents::bigint as refunded_cents, days, status, reject_reason, created_at, reviewed_at, starts_at, ends_at, extract(epoch from paused_left)::float8 as paused_left_s,
	ad_only, post_id::text as post_id, views, name, existing_post`;

export const toAd = (r: any) => ({
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
	pausedLeftMs: r.paused_left_s == null ? null : Number(r.paused_left_s) * 1000,
	adOnly: !!r.ad_only,
	postId: (r.post_id as string | null) ?? null,
	views: Number(r.views ?? 0),
	name: (r.name as string | null) ?? null,
	existingPost: !!r.existing_post,
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
	const economy = await economyNow(db);
	const { price_scale_cents, demand_share_pct } = settings().ads;
	const cap = Math.max(price_scale_cents, Math.round((economy.projectedCents * demand_share_pct) / 100));
	const [row] = await db`select coalesce(sum(least(budget_cents - spent_cents, ${cap})), 0)::bigint as cents from ads where status = 'running' and ends_at > now()`;
	return priceFor(Number(row.cents), economy);
}

export const estimateViews = (budgetCents: number, cpmCents: number) => Math.floor((budgetCents * 1000) / cpmCents);

export async function refund(tx: typeof sql, userId: string, cents: number) {
	if (cents <= 0) return;
	await tx`insert into money_wallets (user_id, balance_cents) values (${userId}::bigint, 0) on conflict do nothing`;
	await tx`update money_wallets set balance_cents = balance_cents + ${cents} where user_id = ${userId}::bigint`;
}

export async function createAd(
	userId: string,
	input: { text?: unknown; url?: unknown; budgetCents?: unknown; days?: unknown; adOnly?: unknown; postId?: unknown; name?: unknown },
): Promise<Ad> {
	const rules = settings().ads;
	if (!rules.enabled) throw new AdError("Ads aren't open on this instance.");
	const postId = typeof input.postId === "string" && /^\d{1,19}$/.test(input.postId) ? input.postId : null;
	const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : null;
	if (name && [...name].length > AD_NAME_MAX) throw new AdError(`A campaign name is at most ${AD_NAME_MAX} characters.`);
	const text = typeof input.text === "string" ? input.text.trim() : "";
	const url = !postId && typeof input.url === "string" && input.url.trim() ? input.url.trim() : null;
	if (!postId) {
		if (!text) throw new AdError("Write what the ad says.");
		if ([...text].length > AD_TEXT_MAX) throw new AdError(`An ad is at most ${AD_TEXT_MAX} characters.`);
		if (url && (url.length > AD_URL_MAX || !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(url))) throw new AdError("The link must be an http or https address.");
	}
	const budget = Number(input.budgetCents);
	if (!Number.isSafeInteger(budget) || budget < rules.min_spend_cents) throw new AdError(`The budget is at least ${formatCents(rules.min_spend_cents)} Equicoins.`);
	const days = Number(input.days);
	if (!Number.isInteger(days) || days < 1 || days > rules.max_days) throw new AdError(`An ad runs for 1 to ${rules.max_days} days.`);
	const row = await sql.begin(async (tx) => {
		const [user] = await tx`select status, deactivated_at, instance, protected from users where id = ${userId}::bigint for update`;
		if (!user || user.instance || user.deactivated_at || user.status === "suspended" || user.status === "restricted") throw new AdError("Your account can't run ads right now.");
		let body = text;
		if (postId) {
			if (user.protected) throw new AdError("Posts from a protected account can't be promoted, since only your followers can see them.");
			const [post] = await tx`select text from posts where id = ${postId}::bigint and user_id = ${userId}::bigint
				and not hidden and not ad_only and circle_owner_id is null and community_id is null`;
			if (!post) throw new AdError("That post can't be promoted. Pick one of your own public posts.");
			const [busy] = await tx`select 1 from ads where post_id = ${postId}::bigint and status in ('pending', 'running', 'paused')`;
			if (busy) throw new AdError("That post is already in a campaign. Extend that one instead.");
			body = post.text || "Post";
		}
		const [pending] = await tx`select count(*)::int as n from ads where user_id = ${userId}::bigint and status = 'pending'`;
		if (Number(pending.n) >= rules.max_pending) throw new AdError(`You have ${rules.max_pending} ads waiting for review. Wait for those first.`);
		const [wallet] = await tx`select balance_cents::bigint as cents from money_wallets where user_id = ${userId}::bigint for update`;
		if (!wallet || Number(wallet.cents) < budget) throw new AdError("You don't have enough Equicoins for that budget.");
		await tx`update money_wallets set balance_cents = balance_cents - ${budget} where user_id = ${userId}::bigint`;
		const [made] = await tx`insert into ads (id, user_id, text, url, budget_cents, days, status, ad_only, post_id, existing_post, name)
			values (${newId()}::bigint, ${userId}::bigint, ${body}, ${url}, ${budget}, ${days}, 'pending', ${!postId && input.adOnly !== false},
				${postId}::bigint, ${!!postId}, ${name}) returning ${adCols}`;
		return made;
	});
	return toAd(row);
}

export async function renameAd(userId: string, adId: string, input: unknown): Promise<Ad> {
	const name = typeof input === "string" && input.trim() ? input.trim() : null;
	if (name && [...name].length > AD_NAME_MAX) throw new AdError(`A campaign name is at most ${AD_NAME_MAX} characters.`);
	const [row] = await sql`update ads set name = ${name} where id = ${adId}::bigint and user_id = ${userId}::bigint returning ${adCols}`;
	if (!row) throw new AdError("No such ad.");
	return toAd(row);
}

export async function promotablePosts(userId: string) {
	const rows = await sql`select p.id::text, p.text, p.created_at, p.reply_to_id is not null as reply,
		exists (select 1 from media m where m.post_id = p.id) as media
		from posts p where p.user_id = ${userId}::bigint and not p.hidden and not p.ad_only and p.circle_owner_id is null and p.community_id is null
			and not exists (select 1 from ads a where a.post_id = p.id and a.status in ('pending', 'running', 'paused'))
		order by p.id desc limit 300`;
	return rows.map((r: any) => ({ id: r.id as string, text: r.text as string, createdAt: r.created_at as Date, reply: !!r.reply, media: !!r.media }));
}

export async function userAdDays(userId: string, days: number) {
	const rows = await sql`select to_char(v.day, 'YYYY-MM-DD') as day, sum(v.n)::int as views from ad_views v join ads a on a.id = v.ad_id
		where a.user_id = ${userId}::bigint and v.day > (now() at time zone 'utc')::date - ${days}::int group by v.day`;
	const [reach] = await sql`select count(distinct v.viewer_id)::int as n from ad_views v join ads a on a.id = v.ad_id
		where a.user_id = ${userId}::bigint and v.n > 0`;
	return { byDay: new Map(rows.map((r: any) => [r.day as string, Number(r.views)])), reach: Number(reach?.n ?? 0) };
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

export async function pauseAd(userId: string, adId: string, pause: boolean): Promise<Ad> {
	const [row] = pause
		? await sql`update ads set status = 'paused', paused_left = ends_at - now(), paused_at = now()
			where id = ${adId}::bigint and user_id = ${userId}::bigint and status = 'running' and ends_at > now() returning ${adCols}`
		: await sql`update ads set status = 'running', ends_at = now() + paused_left, paused_left = null, paused_at = null
			where id = ${adId}::bigint and user_id = ${userId}::bigint and status = 'paused' returning ${adCols}`;
	if (!row) throw new AdError(pause ? "Only a running ad can be paused." : "Only a paused ad can be resumed.");
	return toAd(row);
}

export async function extendAd(userId: string, adId: string, input: { budgetCents?: unknown; days?: unknown }): Promise<Ad> {
	const rules = settings().ads;
	const add = Number(input.budgetCents ?? 0);
	const days = Number(input.days ?? 0);
	if (!Number.isSafeInteger(add) || add < 0 || !Number.isInteger(days) || days < 0) throw new AdError("Add a whole number of days or an amount of Equicoins.");
	if (!add && !days) throw new AdError("Add days or Equicoins to extend an ad.");
	const row = await sql.begin(async (tx) => {
		const [ad] = await tx`select ${adCols}, extract(epoch from coalesce(paused_left, ends_at - now()))::float8 as left_s from ads where id = ${adId}::bigint and user_id = ${userId}::bigint for update`;
		if (!ad) throw new AdError("No such ad.");
		if (!["running", "paused"].includes(ad.status) || Number(ad.left_s) <= 0) throw new AdError("Only a running or paused ad can be extended.");
		if (Number(ad.left_s) + days * 86_400 > rules.max_days * 86_400) throw new AdError(`An ad can't run more than ${rules.max_days} days ahead.`);
		if (add) {
			const [wallet] = await tx`select balance_cents::bigint as cents from money_wallets where user_id = ${userId}::bigint for update`;
			if (!wallet || Number(wallet.cents) < add) throw new AdError("You don't have enough Equicoins for that.");
			await tx`update money_wallets set balance_cents = balance_cents - ${add} where user_id = ${userId}::bigint`;
		}
		const [done] = await tx`update ads set budget_cents = budget_cents + ${add}, days = days + ${days},
			ends_at = case when status = 'paused' then ends_at else ends_at + make_interval(days => ${days}) end,
			paused_left = paused_left + make_interval(days => ${days})
			where id = ${adId}::bigint returning ${adCols}`;
		return done;
	});
	return toAd(row);
}

export type AdStats = { reach: number; days: { day: string; views: number }[] };

export async function adStats(adIds: string[]): Promise<Map<string, AdStats>> {
	const out = new Map<string, AdStats>();
	if (!adIds.length) return out;
	const reach = await sql`select ad_id::text, count(distinct viewer_id) filter (where n > 0)::int as n from ad_views where ad_id in ${sql(adIds)} group by ad_id`;
	for (const r of reach) out.set(r.ad_id, { reach: Number(r.n), days: [] });
	const days = await sql`select ad_id::text, to_char(day, 'YYYY-MM-DD') as day, sum(n)::int as views from ad_views where ad_id in ${sql(adIds)} group by ad_id, day order by day`;
	for (const d of days) out.get(d.ad_id)?.days.push({ day: d.day, views: Number(d.views) });
	return out;
}

export async function endExpiredAds() {
	await sql.begin(async (tx) => {
		const done = await tx`update ads set status = 'ended', refunded_cents = budget_cents - spent_cents
			where (status = 'running' and ends_at <= now()) or (status = 'paused' and paused_at <= now() - make_interval(days => ${settings().ads.max_days}))
			returning user_id::text, (budget_cents - spent_cents)::bigint as back`;
		for (const ad of done) await refund(tx, ad.user_id, Number(ad.back));
	});
}

export const VIEWS_PER_DAY = 3;
const RECHARGE = "1 hour";

export async function pickAd(viewerId: string, onPage: string[]): Promise<{ adId: string; postId: string } | undefined> {
	if (!settings().ads.enabled) return undefined;
	const [ad] = await sql`select a.id::text as ad_id, a.post_id::text as post_id from ads a join posts p on p.id = a.post_id
		join users au on au.id = p.user_id
		where a.status = 'running' and a.ends_at > now() and a.spent_milli < a.budget_cents * 1000
			and au.status <> 'suspended' and au.deactivated_at is null
			and not p.hidden and p.user_id <> ${viewerId}::bigint
			and p.user_id not in ${blockedFor(viewerId)} and p.user_id not in ${outOfView(viewerId)} and p.user_id not in ${shadowedFor(viewerId)}
			and not (a.post_id = any(${sql.array(onPage, "INT8")}))
			and not exists (select 1 from users me where me.id = ${viewerId}::bigint and me.preferences->>'hide_ads' = 'true')
			and coalesce((select v.shown from ad_views v where v.ad_id = a.id and v.viewer_id = ${viewerId}::bigint and v.day = (now() at time zone 'utc')::date), 0) < ${VIEWS_PER_DAY}
		order by -ln(1 - random()) / (a.budget_cents * 1000 - a.spent_milli) limit 1`;
	return ad ? { adId: ad.ad_id, postId: ad.post_id } : undefined;
}

export async function chargeView(adId: string, viewerId: string) {
	await sql.begin(async (tx) => {
		const [seen] = await tx`insert into ad_views (ad_id, viewer_id, shown) values (${adId}::bigint, ${viewerId}::bigint, 1)
			on conflict (ad_id, viewer_id, day) do update set shown = ad_views.shown + 1
			returning last_at < now() - ${RECHARGE}::interval as due`;
		if (!seen?.due) return;
		const [viewer] = await tx`select 1 from users where id = ${viewerId}::bigint and status <> 'suspended' and instance is null
			and created_at <= now() - make_interval(days => ${settings().ads.min_viewer_age_days})`;
		if (!viewer) return;
		await tx`update ad_views set n = n + 1, last_at = now() where ad_id = ${adId}::bigint and viewer_id = ${viewerId}::bigint and day = (now() at time zone 'utc')::date`;
		const price = await currentPrice(tx);
		const [ad] = await tx`update ads set views = views + 1, spent_milli = least(budget_cents * 1000, spent_milli + ${price}),
			spent_cents = least(budget_cents, (least(budget_cents * 1000, spent_milli + ${price}) + 999) / 1000)
			where id = ${adId}::bigint and status = 'running' returning spent_milli, budget_cents`;
		if (ad && Number(ad.spent_milli) >= Number(ad.budget_cents) * 1000) await tx`update ads set status = 'ended', ends_at = now() where id = ${adId}::bigint`;
	});
}
