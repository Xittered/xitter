import type { Viewer } from "./auth";
import { accountPage, esc } from "./account-page";
import { sql } from "./db";
import { knownChatOperation } from "./chat";
import { bucketsFor } from "./ratelimit";

// A restricted account still reads, blocks and mutes, and keeps its direct
// messages (chat.ts lets it write to people who follow it). The client's
// background calls (ratelimit.ts BACKGROUND) aren't in any bucket, so they go
// through too; what posts, engages or writes is refused.
const KEPT = /^\/(1\.1\/(blocks|mutes\/(users|keywords))\/|xitter\/money\/payme$)/;
export const restrictedRefuses = (method: string, path: string, operation: string | undefined, url: URL) =>
	!KEPT.test(path) && !(operation && knownChatOperation(operation)) && bucketsFor(method, path, operation, url).some((b) => b === "post" || b === "engage" || b === "write");

type Dated = { created_at: Date | string };
export const newerReason = (message?: Dated & { body: string }, sanction?: Dated & { reason: string }) => {
	if (!message) return sanction?.reason;
	if (!sanction) return message.body;
	return new Date(message.created_at) > new Date(sanction.created_at) ? message.body : sanction.reason;
};

export const restrictedReason = (message?: string | null, sanction?: string | null) =>
	message || sanction || "The instance team has restricted this account.";

export const restrictedBody = (reason: string) => `<h1>Your account is restricted</h1>
	<p>You can still read Xitter, but you can't interact with posts, message people who don't follow you, or change account data while this restriction is active.</p>
	<div class="card strike"><strong>Reason</strong><p>${esc(reason)}</p></div>
	<p>If you think this restriction was made in error, <a href="/appeal">submit an appeal</a>. Include any context that may help the instance team review the decision.</p>`;

export async function restrictedPage(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "GET") return new Response(null, { status: 405 });

	const [[message], [sanction]] = await Promise.all([
		sql`select body, created_at from staff_messages
			where user_id = ${viewer.id}::bigint and revoked_at is null
			order by id desc limit 1`,
		sql`select detail->>'reason' as reason, created_at from audit_log
			where target = ${viewer.id} and action in ('set_status', 'temporary_status', 'escalate')
				and detail->>'reason' is not null
			order by id desc limit 1`,
	]);
	const body = restrictedBody(restrictedReason(newerReason(message, sanction)));
	return accountPage({
		req,
		viewer,
		title: "Account restricted",
		status: 403,
		body,
		back: { href: "/home", label: "Back to home" },
	});
}
