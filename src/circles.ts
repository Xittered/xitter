// Circles, as Twitter Circle had them: an account picks up to 150 people, and
// a post it sends to its Circle is for them alone. Replies in such a thread
// stay in the same Circle. Circle posts can't be reposted or quoted, never
// leave this instance (federation-sync.ts publicPost) and show only to the
// owner and members (circleSeen, in every post query that matters).
//
// The client still shows Circle posts, with X's "Only people in @name's
// Circle can see this post" label, and links "Edit Circle" to /i/circles,
// which shows the page here (tidy.ts). Its composer no longer offers a
// Circle, so the audience menu's Subscribers choice (super follows) becomes
// it (patchCircleComposer); choosing it sends exclusive_tweet_control_options.

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { holdLock, sql } from "./db";
import { feature } from "./settings";
import { staffViewer } from "./staff-access";

export const MAX_CIRCLE = 150;

// whether a post (aliased `p` unless named) is outside any Circle, or in one
// the viewer owns or is in: what reaches their home timeline and notifications
export const circleMember = (viewerId: string, p: unknown = sql`p`) =>
	sql`(${p}.circle_owner_id is null or ${p}.circle_owner_id = ${viewerId}::bigint
		or exists (select 1 from circle_members cm where cm.owner_id = ${p}.circle_owner_id and cm.member_id = ${viewerId}::bigint))`;

// whether the viewer may see a post where they go looking (the post itself,
// a profile, search): staff see every Circle's, as they see hidden posts, so
// they can moderate them
export const circleSeen = (viewerId: string, p: unknown = sql`p`) => sql`(${circleMember(viewerId, p)} or ${staffViewer(viewerId)})`;

// the client's audience menu: its Subscribers choice, named Circle, for every
// account while Circles are on (shell.ts sets window.__XITTER__.circles)
export function patchCircleComposer(text: string): string {
	if (!text.includes("exclusivityControlValue") && !text.includes("isSuperFollowsCreator:")) return text;
	return text
		.replace(/isSuperFollowsCreator:[\w$]+\.[\w$]+(?=,positionCursorAtBeginning:)/g, "isSuperFollowsCreator:()=>!!window.__XITTER__?.circles")
		.replace(/([\w$]+)=([\w$]+)\(\)\.d52a1caa(?=[,;])/g, (all, name, i18n) => (text.includes("exclusivityControlValue") ? `${name}="Circle"` : all));
}

async function members(ownerId: string) {
	return sql`select u.id::text, u.screen_name, u.name, u.avatar_url from circle_members c join users u on u.id = c.member_id
		where c.owner_id = ${ownerId}::bigint order by c.created_at desc, u.screen_name`;
}

async function page(req: Request, viewer: Viewer, notice = "", error = "") {
	const list = await members(viewer.id);
	const form = (fields: string, label: string, kind = "") =>
		`<form method="post" action="/account/circle" class="inline"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}">${fields}<button type="submit"${kind ? ` class="${kind}"` : ""}>${esc(label)}</button></form>`;
	const rows = list
		.map(
			(m: any) =>
				`<div class="card split"><div><b>${esc(m.name || m.screen_name)}</b><div class="meta">@${esc(m.screen_name)}</div></div>${form(`<input type="hidden" name="remove" value="${esc(m.id)}">`, "Remove", "small secondary")}</div>`,
		)
		.join("");
	return accountPage({
		req,
		viewer,
		title: "Circle",
		status: error ? 400 : 200,
		body: `<h1>Circle</h1>
	<p class="dim">Choose who sees the posts you send to your Circle: pick <b>Circle</b> instead of Everyone above the composer. Only you and the people here can see those posts and their replies; they can't be reposted or quoted, and they stay on this instance. People aren't told when you add or remove them.</p>
	${feature("circles") ? "" : `<p class="dim">Circles are switched off on this instance: you can't send new Circle posts, but the ones you sent still show only to your Circle.</p>`}
	${notice ? `<p role="status">${esc(notice)}</p>` : ""}
	${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
	${list.length < MAX_CIRCLE ? form(`<input name="add" placeholder="@username" aria-label="Add someone by username" autocomplete="off" required>`, "Add to Circle") : `<p class="dim">Your Circle is full (${MAX_CIRCLE} people).</p>`}
	<h2>${list.length === 1 ? "1 person" : `${list.length} people`}</h2>
	${rows || '<p class="dim">No one is in your Circle yet.</p>'}`,
	});
}

export async function circleRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return page(req, viewer);
	const f = await req.formData().catch(() => undefined);
	if (String(f?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, "", "That form is out of date. Try again.");
	const remove = String(f?.get("remove") ?? "");
	if (remove) {
		if (/^\d{1,19}$/.test(remove)) await sql`delete from circle_members where owner_id = ${viewer.id}::bigint and member_id = ${remove}::bigint`;
		return new Response(null, { status: 303, headers: { location: "/account/circle" } });
	}
	const name = String(f?.get("add") ?? "").trim().replace(/^@/, "");
	if (!name) return page(req, viewer, "", "Enter a username.");
	// accounts on this instance: a Circle post never leaves it
	const [u] = await sql`select id::text, screen_name, instance from users where lower(screen_name) = lower(${name}) and status <> 'suspended' and deactivated_at is null`;
	if (!u || u.instance) return page(req, viewer, "", u ? "Only accounts on this instance can be in your Circle." : `No account @${name}.`);
	if (u.id === viewer.id) return page(req, viewer, "", "You're always in your own Circle.");
	const [blocked] = await sql`select 1 from blocks where (blocker_id = ${viewer.id}::bigint and blocked_id = ${u.id}::bigint) or (blocker_id = ${u.id}::bigint and blocked_id = ${viewer.id}::bigint)`;
	if (blocked) return page(req, viewer, "", `You can't add @${u.screen_name}.`);
	const added = await sql.begin(async (tx) => {
		await holdLock(tx, `circle:${viewer.id}`);
		return tx`insert into circle_members (owner_id, member_id)
			select ${viewer.id}::bigint, ${u.id}::bigint where (select count(*) from circle_members where owner_id = ${viewer.id}::bigint) < ${MAX_CIRCLE}
			on conflict do nothing returning member_id`;
	});
	const [already] = added.length ? [] : await sql`select 1 from circle_members where owner_id = ${viewer.id}::bigint and member_id = ${u.id}::bigint`;
	if (!added.length && !already) return page(req, viewer, "", `Your Circle is full (${MAX_CIRCLE} people).`);
	return page(req, viewer, already ? `@${u.screen_name} is already in your Circle.` : `Added @${u.screen_name}.`);
}
