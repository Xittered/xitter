// Temporary sanctions running out, and custom badge images.

import { sql } from "./db";
import type { HateHit } from "./hate";
import { forgetHeld } from "./held";
import { newId } from "./ids";
import { settings } from "./settings";

// an account whose sanction has ended goes back to its earlier standing
export async function expireSanctions() {
	await sql.begin(async (tx) => {
		const users = await tx`update users set status = coalesce(status_restore, 'active'), status_until = null, status_restore = null
			where status_until <= now() returning id::text, status`;
		for (const user of users) await tx`insert into audit_log (id, action, target, detail) values (${newId()}::bigint, 'expire_sanction', ${user.id}, ${JSON.stringify({ restored: user.status })}::text::jsonb)`;
	});
}

export async function shutOut(...userIds: string[]) {
	if (!userIds.length) return;
	const ids = sql.array(userIds, "INT8");
	await sql`delete from sessions where user_id = any(${ids})`;
	await sql`delete from login_challenges where user_id = any(${ids})`;
	await sql`delete from push_subscriptions where user_id = any(${ids})`;
	await sql`update invites set revoked = true where created_by = any(${ids}) and not revoked and uses < max_uses`;
	forgetHeld();
	const chat = await import("./chat");
	for (const id of userIds) chat.closeSockets(id);
}

export type Escalation = { strikes: number; outcome: "warning" | "suspended" | "permanent" | "staff"; hours?: number };

export async function activeStrikes(userId: string): Promise<number> {
	const days = Math.max(1, settings().automod.strike_days);
	const [row] = await sql`select count(*)::int as n from staff_messages where user_id = ${userId}::bigint and kind = 'strike' and revoked_at is null
		and created_at > now() - ${days} * interval '1 day'`;
	return row.n;
}

const ladderStep = (strikes: number) => {
	const ladder = settings().automod.ladder;
	return ladder.length ? ladder[Math.min(strikes, ladder.length) - 1] : 0;
};

export async function escalate(userId: string, actorId: string | null, reason: string): Promise<Escalation> {
	const [user] = await sql`select role, status, status_until from users where id = ${userId}::bigint`;
	const strikes = await activeStrikes(userId);
	if (!user || user.role) return { strikes, outcome: "staff" };
	const step = ladderStep(strikes);
	let result: Escalation = { strikes, outcome: "warning" };
	if (step < 0) {
		await sql`update users set status = 'suspended', status_until = null, status_restore = null, deactivated_at = null where id = ${userId}::bigint`;
		result = { strikes, outcome: "permanent" };
	} else if (step > 0) {
		const permanent = user.status === "suspended" && !user.status_until;
		if (!permanent) {
			await sql`update users set status_restore = case when status = 'suspended' then status_restore else coalesce(status_restore, status) end, status = 'suspended',
				status_until = greatest(coalesce(status_until, now()), now() + ${step} * interval '1 hour'), deactivated_at = null where id = ${userId}::bigint`;
		}
		result = { strikes, outcome: permanent ? "permanent" : "suspended", hours: step };
	}
	if (result.outcome !== "warning") await shutOut(userId);
	await sql`insert into audit_log (id, actor_id, action, target, detail) values (${newId()}::bigint, ${actorId}::bigint, 'escalate', ${userId},
		${JSON.stringify({ ...result, reason: reason.slice(0, 500) })}::text::jsonb)`;
	return result;
}

const PLACE: Record<string, string> = { post: "a post", profile: "your profile", name: "your name", list: "a list", community: "a community", poll: "a poll", alt: "an image description", article: "an article", note: "a note", other: "something you wrote" };
const WHAT: Record<string, string> = { slur: "a slur", hate: "hate speech", transphobia: "transphobic content", abuse: "abuse aimed at someone" };

export async function automodStrike(userId: string, hit: HateHit, where: keyof typeof PLACE, sample: string): Promise<Escalation | undefined> {
	if (!settings().automod.enabled) return undefined;
	const [recent] = await sql`select 1 from staff_messages where user_id = ${userId}::bigint and kind = 'strike' and actor_id is null and created_at > now() - interval '2 minutes'`;
	if (recent) return undefined;
	const body = `Automatic strike: ${PLACE[where] ?? PLACE.other} contained ${WHAT[hit.category] ?? "content"} this instance doesn't allow. It wasn't published. Repeated strikes lead to suspension. If this was a mistake, you can appeal.`;
	const message = newId();
	await sql`insert into staff_messages (id, user_id, actor_id, kind, body) values (${message}::bigint, ${userId}::bigint, null, 'strike', ${body})`;
	await sql`insert into audit_log (id, actor_id, action, target, detail) values (${newId()}::bigint, null, 'automod_strike', ${userId},
		${JSON.stringify({ message, where, category: hit.category, term: hit.term, sample: [...sample].slice(0, 300).join("") })}::text::jsonb)`;
	return escalate(userId, null, `automod ${hit.category} in ${where}`);
}

export async function badgeImage(id: string) {
	if (BigInt(id) > 9223372036854775807n) return new Response(null, { status: 404 });
	const [badge] = await sql`select image, mime from custom_badges where id = ${id}::bigint`;
	if (!badge) return new Response(null, { status: 404 });
	return new Response(new Uint8Array(badge.image), { headers: { "content-type": badge.mime, "cache-control": "no-cache", "x-content-type-options": "nosniff" } });
}
