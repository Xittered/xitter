// Invites made by members, at /account/invites (the side bar's More menu links
// it, tidy.ts). Admin > Invites sets how many a month; staff make theirs in the
// panel without a limit. Only while sign-up is by invite.

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { createInvite } from "./invites";
import { settings } from "./settings";

// what stops this account from making an invite now, or null
async function blocker(viewer: Viewer): Promise<{ reason: string | null; made: number }> {
	const q = settings().invite_quota;
	const [u] = await sql`select status, created_at,
		(select count(*)::int from invites i where i.created_by = users.id and i.created_at > now() - interval '30 days') as made
		from users where id = ${viewer.id}::bigint`;
	const made: number = u?.made ?? 0;
	if (settings().signup_mode === "open") return { reason: "Anyone can sign up here right now, so there's no need for an invite.", made };
	if (settings().signup_mode === "closed") return { reason: "Sign-up is closed, so invites can't be used.", made };
	if (!q.enabled) return { reason: "Members can't make invites on this instance.", made };
	if (u.status !== "active") return { reason: "Accounts with a restriction can't make invites.", made };
	const ageDays = (Date.now() - new Date(u.created_at).getTime()) / 86400e3;
	if (ageDays < q.min_age_days) return { reason: `Accounts can make invites once they are ${q.min_age_days} days old.`, made };
	if (made >= q.per_month) return { reason: `You've made ${made} of ${q.per_month} invites in the last 30 days.`, made };
	return { reason: null, made };
}

async function view(req: Request, viewer: Viewer, notice = "", error = "") {
	const q = settings().invite_quota;
	const { reason, made } = await blocker(viewer);
	const mine = await sql`select i.code, i.uses, i.max_uses, i.expires_at, i.revoked, i.created_at,
		(select coalesce(json_agg(u.screen_name order by u.created_at), '[]') from users u where u.invite_code = i.code) as used_by
		from invites i where i.created_by = ${viewer.id}::bigint order by i.created_at desc limit 50`;
	const state = (i: any) =>
		i.revoked ? "withdrawn" : i.uses >= i.max_uses ? "used" : i.expires_at && new Date(i.expires_at) < new Date() ? "expired" : `open until ${new Date(i.expires_at ?? Date.now()).toDateString()}`;
	return accountPage({
		req,
		viewer,
		title: "Invites",
		body: `<h1>Invites</h1>
<p>Invite people you know to ${esc(settings().instance_name)}. ${q.enabled ? `You can make ${q.per_month} a month${q.uses > 1 ? `, each good for ${q.uses} people` : ""}; each is open for 30 days.` : ""}</p>
${notice ? `<p>${notice}</p>` : ""}${error ? `<p class="error">${esc(error)}</p>` : ""}
<form method="post"><button type="submit"${reason ? " disabled" : ""}>Make an invite</button></form>
${reason ? `<p class="dim">${esc(reason)}</p>` : q.enabled ? `<p class="dim">${q.per_month - made} left this month.</p>` : ""}
${mine
	.map(
		(i: any) => `<div class="card"><div class="code">${esc(i.code)}</div>
<div class="dim">${esc(state(i))} · ${i.uses}/${i.max_uses} used${i.used_by.length ? ` by ${i.used_by.map((n: string) => `<a href="/${esc(n)}">@${esc(n)}</a>`).join(", ")}` : ""}</div>
${!i.revoked && i.uses < i.max_uses ? `<div class="dim">Link: <a href="${esc(`${PUBLIC_ORIGIN}/signup?code=${encodeURIComponent(i.code)}`)}">${esc(`${PUBLIC_ORIGIN}/signup?code=${i.code}`)}</a></div>` : ""}</div>`,
	)
	.join("")}`,
	});
}

export async function memberInvitesRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return view(req, viewer);
	const { reason } = await blocker(viewer);
	if (reason) return view(req, viewer, "", reason);
	const q = settings().invite_quota;
	const code = await createInvite({ createdBy: viewer.id, maxUses: q.uses, expiresAt: new Date(Date.now() + 30 * 86400e3) });
	return view(req, viewer, `Your invite is <b>${esc(code)}</b>. Send the code or the link below.`);
}
