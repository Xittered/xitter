import { type Action, AdminError, audit, idOf } from "./admin";
import { adCols, currentPrice, economyNow, endExpiredAds, refund, toAd } from "./ads";
import { sql } from "./db";
import { createPost } from "./posts";
import { settings } from "./settings";

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
				if (approve && row.existing_post) {
					if (!row.post_id) throw new AdminError("The promoted post was deleted. Reject the ad to refund it.");
					const [done] = await tx`update ads set status = 'running', reviewed_at = now(), reviewed_by = ${a.id}::bigint,
						starts_at = now(), ends_at = now() + days * interval '1 day' where id = ${id}::bigint returning ${adCols}`;
					return done;
				}
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
				const back = Math.floor((Number(row.budget_cents) * Math.min(100, Math.max(0, settings().ads.reject_refund_pct))) / 100);
				await refund(tx, row.user_id, back);
				const [done] = await tx`update ads set status = 'rejected', reviewed_at = now(), reviewed_by = ${a.id}::bigint,
					reject_reason = ${reason}, refunded_cents = ${back} where id = ${id}::bigint returning ${adCols}`;
				return done;
			});
			await audit(a, approve ? "ad_approve" : "ad_reject", ad.user_id, { ad: id, budget: Number(ad.budget_cents), refunded: Number(ad.refunded_cents), ...(reason ? { reason } : {}) });
			return { ad: toAd(ad) };
		},
	},
	stopAd: {
		role: "moderator",
		run: async (a, b) => {
			const id = idOf(b.id, "ad");
			const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
			if (!reason) throw new AdminError("Say why the ad is stopped; the advertiser sees it.");
			const ad = await sql.begin(async (tx) => {
				const [row] = await tx`select ${adCols} from ads where id = ${id}::bigint for update`;
				if (!row) throw new AdminError("No such ad.", 404);
				if (!["pending", "running", "paused"].includes(row.status)) throw new AdminError("That ad has already finished.");
				const back = Number(row.budget_cents) - Number(row.spent_cents);
				await refund(tx, row.user_id, back);
				const [done] = await tx`update ads set status = 'cancelled', refunded_cents = ${back}, reject_reason = ${reason},
					reviewed_by = coalesce(reviewed_by, ${a.id}::bigint), ends_at = least(coalesce(ends_at, now()), now())
					where id = ${id}::bigint returning ${adCols}`;
				return done;
			});
			await audit(a, "ad_stop", ad.user_id, { ad: id, refunded: Number(ad.refunded_cents), reason });
			return { ad: toAd(ad) };
		},
	},
};
