// /account/organisation: an organisation (a gold-badge account) and the
// affiliates it makes managers add and remove its affiliates. Being added puts
// the organisation's badge on a profile, so it is a request the account
// accepts here first; the request shows in its notifications (notifications.ts).
// Staff still add affiliates directly from the admin panel.

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";

type Org = { id: string; screen_name: string; name: string; self: boolean };

// the organisation this account runs: itself, or the one it manages
async function managedOrg(viewer: Viewer): Promise<Org | undefined> {
	const [org] = await sql`select u.id::text, u.screen_name, u.name, u.id = ${viewer.id}::bigint as self from users u
		where u.verified_type in ('business', 'government') and (u.id = ${viewer.id}::bigint
			or u.id = (select org_id from affiliations where user_id = ${viewer.id}::bigint and manager))`;
	return org as Org | undefined;
}

const form = (action: string, fields: Record<string, string>, label: string, cls = "secondary") =>
	`<form method="post" class="inline"><input type="hidden" name="do" value="${action}">${Object.entries(fields)
		.map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
		.join("")}<button class="small ${cls}">${label}</button></form>`;

async function view(req: Request, viewer: Viewer, error = "", notice = "") {
	const org = await managedOrg(viewer);
	const [mine] = await sql`select o.screen_name, a.manager from affiliations a join users o on o.id = a.org_id where a.user_id = ${viewer.id}::bigint`;
	const asked = await sql`select o.id::text, o.screen_name, o.name from affiliation_requests r join users o on o.id = r.org_id
		where r.user_id = ${viewer.id}::bigint and o.verified_type in ('business', 'government') order by r.created_at`;
	let body = `<h1>Organisation</h1>${notice ? `<p>${esc(notice)}</p>` : ""}${error ? `<p class="error">${esc(error)}</p>` : ""}`;

	if (asked.length)
		body += `<h2>Requests for you</h2>${asked
			.map(
				(o: any) => `<div class="card split"><span><b>${esc(o.name)}</b> <a href="/${esc(o.screen_name)}">@${esc(o.screen_name)}</a> asked to add you as an affiliate: their badge would show next to your name.${mine && mine.screen_name !== o.screen_name ? ` You'd leave @${esc(mine.screen_name)}.` : ""}</span>
<span class="row">${form("accept", { org: o.id }, "Accept", "")}${form("decline", { org: o.id }, "Decline")}</span></div>`,
			)
			.join("")}`;

	if (mine && !org)
		body += `<p>You are an affiliate of <a href="/${esc(mine.screen_name)}">@${esc(mine.screen_name)}</a>.</p>${form("leave", {}, "Leave the organisation", "danger")}`;

	if (org) {
		const people = await sql`select u.id::text, u.screen_name, u.name, a.manager from affiliations a join users u on u.id = a.user_id
			where a.org_id = ${org.id}::bigint order by a.manager desc, a.created_at`;
		const pending = await sql`select u.id::text, u.screen_name, u.name from affiliation_requests r join users u on u.id = r.user_id
			where r.org_id = ${org.id}::bigint order by r.created_at`;
		body += `<p>${org.self ? "You" : `As a manager of <a href="/${esc(org.screen_name)}">@${esc(org.screen_name)}</a>, you`} can add people to the organisation; they accept first. ${org.self ? "Managers can do the same." : ""}</p>
<form method="post" class="row"><input type="hidden" name="do" value="add"><input name="handle" placeholder="@handle" required><button>Ask to add</button></form>
<h2>Affiliates</h2>${
			people.length
				? people
						.map(
							(p: any) => `<div class="card split"><span><b>${esc(p.name)}</b> <a href="/${esc(p.screen_name)}">@${esc(p.screen_name)}</a>${p.manager ? ' <span class="dim">· manager</span>' : ""}</span>
<span class="row">${org.self ? form("manager", { user: p.id, on: p.manager ? "" : "1" }, p.manager ? "Not a manager" : "Make manager") : ""}${p.id !== viewer.id ? form("remove", { user: p.id }, "Remove", "danger") : ""}</span></div>`,
						)
						.join("")
				: '<p class="dim">No affiliates yet.</p>'
		}${
			pending.length
				? `<h2>Waiting to accept</h2>${pending
						.map((p: any) => `<div class="card split"><span><b>${esc(p.name)}</b> <a href="/${esc(p.screen_name)}">@${esc(p.screen_name)}</a></span>${form("cancel", { user: p.id }, "Withdraw")}</div>`)
						.join("")}`
				: ""
		}`;
	}

	if (!org && !mine && !asked.length) body += '<p class="dim">This page is for organisations (accounts with the gold or grey government badge) and the people they add.</p>';
	return accountPage({ req, viewer, title: "Organisation", body });
}

const isId = (v: string) => /^\d{1,19}$/.test(v);

export async function orgRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (req.method !== "POST") return view(req, viewer);
	const f = await req.formData().catch(() => undefined);
	const field = (k: string) => String(f?.get(k) ?? "").trim();
	const action = field("do");

	if (action === "accept" || action === "decline") {
		const orgId = field("org");
		if (!isId(orgId)) return view(req, viewer, "No such request.");
		const [r] = await sql`delete from affiliation_requests r using users o
			where r.org_id = ${orgId}::bigint and r.user_id = ${viewer.id}::bigint and o.id = r.org_id and o.verified_type in ('business', 'government') returning o.screen_name`;
		if (!r) return view(req, viewer, "That request is gone.");
		if (action === "decline") return view(req, viewer, "", `You declined @${r.screen_name}.`);
		// one organisation per person; accepting moves them
		await sql`insert into affiliations (org_id, user_id) values (${orgId}::bigint, ${viewer.id}::bigint)
			on conflict (user_id) do update set org_id = excluded.org_id, manager = false, created_at = now()`;
		return view(req, viewer, "", `You are now an affiliate of @${r.screen_name}.`);
	}
	if (action === "leave") {
		await sql`delete from affiliations where user_id = ${viewer.id}::bigint`;
		return view(req, viewer, "", "You left the organisation.");
	}

	const org = await managedOrg(viewer);
	if (!org) return view(req, viewer, "Only an organisation and its managers can do that.");
	const userId = field("user");
	if (action === "add") {
		const handle = field("handle").replace(/^@/, "");
		const [u] = await sql`select id::text, screen_name, verified_type, status from users where lower(screen_name) = lower(${handle})`;
		if (!u || u.status === "suspended") return view(req, viewer, "No account with that handle.");
		if (u.id === org.id) return view(req, viewer, "An organisation can't be its own affiliate.");
		if (u.verified_type === "business" || u.verified_type === "government") return view(req, viewer, "Organisations can't be affiliates.");
		if ((await sql`select 1 from affiliations where org_id = ${org.id}::bigint and user_id = ${u.id}::bigint`).length) return view(req, viewer, `@${u.screen_name} is already an affiliate.`);
		// a block either way keeps the request from reaching them
		if ((await sql`select 1 from blocks where (blocker_id = ${u.id}::bigint and blocked_id in (${org.id}::bigint, ${viewer.id}::bigint)) or (blocked_id = ${u.id}::bigint and blocker_id in (${org.id}::bigint, ${viewer.id}::bigint))`).length)
			return view(req, viewer, `You can't add @${u.screen_name}.`);
		await sql`insert into affiliation_requests (org_id, user_id, requested_by) values (${org.id}::bigint, ${u.id}::bigint, ${viewer.id}::bigint) on conflict do nothing`;
		return view(req, viewer, "", `Asked @${u.screen_name}. They become an affiliate when they accept.`);
	}
	if (!isId(userId)) return view(req, viewer, "Choose an account.");
	if (action === "cancel") {
		await sql`delete from affiliation_requests where org_id = ${org.id}::bigint and user_id = ${userId}::bigint`;
		return view(req, viewer, "", "Request withdrawn.");
	}
	if (action === "remove") {
		if (userId === viewer.id) return view(req, viewer, "Leave from your own page instead.");
		// managers can't remove the people who can remove them; the organisation can
		const [target] = await sql`select manager from affiliations where org_id = ${org.id}::bigint and user_id = ${userId}::bigint`;
		if (!target) return view(req, viewer, "Not an affiliate.");
		if (target.manager && !org.self) return view(req, viewer, "Only the organisation's own account removes a manager.");
		await sql`delete from affiliations where org_id = ${org.id}::bigint and user_id = ${userId}::bigint`;
		return view(req, viewer, "", "Removed.");
	}
	if (action === "manager") {
		if (!org.self) return view(req, viewer, "Only the organisation's own account chooses managers.");
		const rows = await sql`update affiliations set manager = ${field("on") === "1"} where org_id = ${org.id}::bigint and user_id = ${userId}::bigint returning user_id`;
		return rows.length ? view(req, viewer, "", field("on") === "1" ? "They can now manage affiliates." : "They no longer manage affiliates.") : view(req, viewer, "Not an affiliate.");
	}
	return view(req, viewer);
}
