import { randomBytes } from "node:crypto";
import { accountPage, esc } from "./account-page";
import { type Viewer, sessionCookies } from "./auth";
import { sql } from "./db";
import { FEDERATION_ON, INSTANCE_ID, type Incoming, b64url, baseUrl, keyFor, liftBlock, listed, listedInstance, open, seal, setBlock, signedAnswer, signedFetch } from "./federation";
import { newId } from "./ids";
import { hit, limitedResponse } from "./ratelimit";
import { SUPERADMINS, isSuperadminHome, superadminOf } from "./superadmins";
import { codeAccepted } from "./two-factor";

const TICKET_SECONDS = 60;
const SESSION_MINUTES = 60;
const usedCodes = new Map<string, number>();

export const isSuperadminViewer = (viewer: Pick<Viewer, "screen_name"> & { instance?: string | null }) =>
	!!(viewer.instance ? superadminOf(viewer.instance, viewer.screen_name.replace(/@[^@]*$/, "")) : superadminOf(INSTANCE_ID, viewer.screen_name));

async function localSuperadmin(viewer: Viewer | undefined) {
	if (!viewer || !superadminOf(INSTANCE_ID, viewer.screen_name, viewer.id)) return undefined;
	const [u] = await sql`select id::text, password_hash, totp_enabled, role from users where id = ${viewer.id}::bigint and instance is null`;
	return u?.role === "admin" ? u : undefined;
}

async function reauthenticate(u: { id: string; password_hash: string; totp_enabled: boolean }, form: FormData): Promise<string | undefined> {
	const h = hit("password", `superadmin:${u.id}`);
	if (!h.ok) return "Too many tries. Wait a few minutes.";
	if (!u.totp_enabled) return "Turn on two-factor authentication first, at /account/2fa.";
	const password = String(form.get("password") ?? "").slice(0, 1024);
	const code = String(form.get("code") ?? "").replace(/\s/g, "").slice(0, 20);
	if (!(await Bun.password.verify(password, u.password_hash).catch(() => false))) return "The password or the code isn't right.";
	const now = Date.now();
	for (const [k, at] of usedCodes) if (now - at > 120_000) usedCodes.delete(k);
	if (usedCodes.has(`${u.id}:${code}`)) return "That code was already used. Wait for the next one.";
	if (!(await codeAccepted(u.id, code))) return "The password or the code isn't right.";
	usedCodes.set(`${u.id}:${code}`, now);
	return undefined;
}

async function auditHome(actorId: string, action: string, target: string, detail: unknown) {
	await sql`insert into audit_log (id, actor_id, action, target, detail) values (${newId()}::bigint, ${actorId}::bigint, ${action}, ${target}, ${JSON.stringify(detail)}::text::jsonb)`;
}

const targets = () => listed().filter((i) => i.id !== INSTANCE_ID);

const activeHome = (instance: string) => isSuperadminHome(instance) && listedInstance(instance)?.state !== "blocked";

function homePage(req: Request, viewer: Viewer, message = "") {
	const options = targets()
		.map((i) => `<option value="${esc(i.id)}">${esc(i.name)} (${esc(i.id)})</option>`)
		.join("");
	return accountPage({
		req,
		viewer,
		title: "Superadmin",
		body: `${message ? `<p class="box">${esc(message)}</p>` : ""}
<h1>Open another instance's admin panel</h1>
<p>You get a temporary admin session there for up to ${SESSION_MINUTES} minutes. It's deleted when it runs out or you sign out. Changes you make show in that instance's own audit log.</p>
<form method="post" action="/federation/superadmin/enter">
<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
<label>Instance <select name="instance" required>${options}</select></label>
<button>Open admin panel</button>
</form>
<h1>Emergency defederation</h1>
<p>Every instance that federates stops talking to the instance you name within a minute. Lifting it works the same way.</p>
<form method="post" action="/federation/superadmin/emergency">
<label>Instance <select name="instance" required>${options}</select></label>
<label>Action <select name="action"><option value="block">Defederate</option><option value="lift">Lift</option></select></label>
<label>Reason <input name="reason" maxlength="500" required></label>
<label>Password <input type="password" name="password" autocomplete="current-password" required></label>
<label>Two-factor code <input name="code" inputmode="numeric" autocomplete="one-time-code" required></label>
<button>Send to every instance</button>
</form>
<p><a href="/admin#federation">Back to the admin panel</a></p>`,
	});
}

export async function superadminHomeRoute(req: Request, url: URL, viewer: Viewer | undefined): Promise<Response> {
	const u = await localSuperadmin(viewer);
	if (!u || !viewer) return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
	if (req.method !== "POST") return homePage(req, viewer);
	if (req.headers.get("sec-fetch-site") && req.headers.get("sec-fetch-site") !== "same-origin") return new Response("This request came from another site.", { status: 403 });
	const form = await req.formData().catch(() => new FormData());
	const instance = String(form.get("instance") ?? "");
	if (!targets().some((i) => i.id === instance)) return homePage(req, viewer, "Pick an instance from the list.");

	if (url.pathname === "/federation/superadmin/enter") {
		if (String(form.get("csrf") ?? "") !== viewer.csrf) return homePage(req, viewer, "That form is out of date. Try again.");
		const h = hit("auth", `superadmin:${viewer.id}`);
		if (!h.ok) return limitedResponse(h);
		const now = Math.floor(Date.now() / 1000);
		const ticket = seal({ typ: "xitter-superadmin-v1", iss: INSTANCE_ID, aud: instance, sub: viewer.screen_name, sub_id: viewer.id, name: viewer.name, iat: now, exp: now + TICKET_SECONDS, nonce: b64url(randomBytes(18)) });
		return accountPage({
			req,
			viewer,
			title: "Superadmin",
			body: `<h1>Opening ${esc(instance)}</h1><p>If nothing happens, press the button. The link works once, within ${TICKET_SECONDS} seconds.</p>
<form method="post" action="${esc(baseUrl(instance))}/federation/superadmin/accept" id="enter"><input type="hidden" name="ticket" value="${esc(JSON.stringify(ticket))}"><button>Open ${esc(instance)}</button></form>
<script>document.getElementById("enter").submit()</script>`,
		});
	}
	const refused = await reauthenticate(u, form);
	if (refused) return homePage(req, viewer, refused);
	if (url.pathname === "/federation/superadmin/emergency") {
		const action = form.get("action") === "lift" ? "lift" : "block";
		const reason = String(form.get("reason") ?? "").trim().slice(0, 500);
		if (!reason) return homePage(req, viewer, "Give a reason.");
		if (isSuperadminHome(instance)) return homePage(req, viewer, "A superadmin's home can't be defederated in an emergency. Mark it blocked in instances.json instead.");
		const seq = Date.now();
		const envelope = seal({ typ: "xitter-emergency-v1", iss: INSTANCE_ID, seq, instance, action, reason, by: viewer.screen_name, at: new Date(seq).toISOString() });
		await sql`insert into federation_emergencies (seq, instance, action, reason, by_name, issuer, envelope)
			values (${seq}, ${instance}, ${action}, ${reason}, ${viewer.screen_name}, ${INSTANCE_ID}, ${JSON.stringify(envelope)}::text::jsonb)`;
		await auditHome(viewer.id, `superadmin_emergency_${action}`, instance, { reason });
		if (action === "block") await setBlock(instance, "emergency", reason, { id: viewer.id, name: viewer.screen_name });
		else await liftBlock(instance, "emergency");
		const results = await Promise.all(
			listed()
				.filter((i) => i.id !== INSTANCE_ID && i.id !== instance && i.state === "active")
				.map(async (i) => `${i.id}: ${(await signedFetch(i.id, "POST", "/federation/v1/emergency", envelope, undefined, { anyListed: true }).catch(() => undefined))?.status ?? "unreachable"}`),
		);
		return homePage(req, viewer, `Sent. ${results.join(", ") || "No other instance to tell."} Instances that missed it pick it up within a minute.`);
	}
	return new Response("not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}

export async function endSuperadminVisits() {
	await sql`delete from sessions where superadmin and expires_at <= now()`;
	await sql`update users set role = null where instance is not null and role is not null
		and not exists (select 1 from sessions s where s.user_id = users.id and s.superadmin and s.expires_at > now())`;
}

type Emergency = { typ: string; iss: string; seq: number; instance: string; action: "block" | "lift"; reason: string; by: string; at: string };

async function applyEmergency(envelope: unknown): Promise<boolean> {
	const e = envelope as { payload?: string; key_id?: string };
	const issuer = typeof e?.key_id === "string" ? e.key_id : "";
	if (!activeHome(issuer)) return false;
	const key = await keyFor(issuer);
	const notice = key ? (open(envelope, key) as Emergency | undefined) : undefined;
	if (!notice || notice.typ !== "xitter-emergency-v1" || notice.iss !== issuer || !Number.isSafeInteger(notice.seq) || notice.seq > Date.now() + 5 * 60_000) return false;
	if (typeof notice.instance !== "string" || isSuperadminHome(notice.instance) || !["block", "lift"].includes(notice.action) || !SUPERADMINS.some((s) => s.instance === issuer && s.screen_name === notice.by))
		return false;
	const [newer] = await sql`select 1 from federation_emergencies where instance = ${notice.instance} and issuer = ${issuer} and seq >= ${notice.seq}`;
	if (newer) return true;
	await sql`insert into federation_emergencies (seq, instance, action, reason, by_name, issuer, envelope)
		values (${notice.seq}, ${notice.instance}, ${notice.action}, ${String(notice.reason).slice(0, 500)}, ${notice.by}, ${issuer}, ${JSON.stringify(envelope)}::text::jsonb) on conflict (seq) do nothing`;
	if (notice.instance === INSTANCE_ID) return true;
	if (notice.action === "block") await setBlock(notice.instance, "emergency", `Emergency: ${String(notice.reason).slice(0, 480)}`, { name: `${notice.by}@${issuer}` });
	else await liftBlock(notice.instance, "emergency");
	return true;
}

export async function emergencyApi(incoming: Incoming, method: string, path: string): Promise<Response | undefined> {
	if (method === "POST" && path === "/federation/v1/emergency") {
		if (!activeHome(incoming.from)) return signedAnswer(incoming, 403, { error: "Only a superadmin's home sends these." });
		return signedAnswer(incoming, (await applyEmergency(incoming.json())) ? 200 : 400, {});
	}
	if (method === "GET" && path === "/federation/v1/emergencies") {
		if (!isSuperadminHome(INSTANCE_ID)) return signedAnswer(incoming, 404, { error: "This instance issues none." });
		const rows = await sql`select envelope from federation_emergencies where issuer = ${INSTANCE_ID} order by seq desc limit 500`;
		return signedAnswer(incoming, 200, { emergencies: rows.map((r: any) => r.envelope) });
	}
	return undefined;
}

export async function pollEmergencies() {
	for (const s of new Set(SUPERADMINS.map((x) => x.instance))) {
		if (s === INSTANCE_ID || !activeHome(s)) continue;
		const r = await signedFetch(s, "GET", "/federation/v1/emergencies").catch(() => undefined);
		if (r?.status !== 200) continue;
		const list = r.json()?.emergencies;
		if (!Array.isArray(list)) continue;
		for (const envelope of [...list].reverse()) await applyEmergency(envelope).catch(() => false);
	}
}

type Ticket = { typ: string; iss: string; aud: string; sub: string; sub_id: string; name: string; iat: number; exp: number; nonce: string };

export async function acceptTicket(req: Request, ip: string): Promise<Response> {
	const refuse = (why: string, status = 403) => new Response(why, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
	if (req.method !== "POST") return refuse("Use the button on your home instance.", 405);
	const h = hit("auth", ip);
	if (!h.ok) return limitedResponse(h);
	const form = await req.formData().catch(() => new FormData());
	let envelope: { key_id?: string } | undefined;
	try {
		envelope = JSON.parse(String(form.get("ticket") ?? "").slice(0, 8192));
	} catch {
		return refuse("That ticket isn't readable.", 400);
	}
	const issuer = typeof envelope?.key_id === "string" ? envelope.key_id : "";
	if (!FEDERATION_ON) return refuse("This instance doesn't federate.", 404);
	if (!activeHome(issuer)) return refuse("That ticket wasn't issued by a superadmin's home instance.");
	const key = await keyFor(issuer);
	const t = key ? (open(envelope, key) as Ticket | undefined) : undefined;
	const now = Math.floor(Date.now() / 1000);
	if (!t || t.typ !== "xitter-superadmin-v1" || t.iss !== issuer || t.aud !== INSTANCE_ID) return refuse("That ticket isn't valid here.");
	if (!Number.isSafeInteger(t.iat) || !Number.isSafeInteger(t.exp) || t.exp < now || t.exp - t.iat > 2 * TICKET_SECONDS || t.iat > now + 60) return refuse("That ticket has expired.");
	if (typeof t.sub !== "string" || typeof t.sub_id !== "string" || !/^\d{1,19}$/.test(t.sub_id) || !superadminOf(issuer, t.sub, t.sub_id)) return refuse("That account isn't a superadmin.");
	if (typeof t.nonce !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(t.nonce)) return refuse("That ticket isn't valid here.");
	const [fresh] = await sql`insert into superadmin_tickets (nonce) values (${t.nonce}) on conflict do nothing returning nonce`;
	if (!fresh) return refuse("That ticket was already used.");

	const handle = `${t.sub}@${issuer}`;
	const [known] = await sql`select id::text from users where instance = ${issuer} and remote_id = ${t.sub_id}::bigint`;
	const id = known?.id ?? newId();
	if (!known) {
		await sql`update users set screen_name = screen_name || '~' || remote_id::text where lower(screen_name) = lower(${handle}) and instance = ${issuer}`;
		await sql`insert into users (id, screen_name, name, password_hash, instance, remote_id) values (${id}::bigint, ${handle}, ${String(t.name ?? t.sub).slice(0, 50)}, '!', ${issuer}, ${t.sub_id}::bigint)`;
		await sql`insert into federated_objects (instance, kind, remote_id, local_id) values (${issuer}, 'user', ${t.sub_id}::bigint, ${id}::bigint) on conflict do nothing`;
	}
	await sql`update users set role = 'admin', status = 'active', deactivated_at = null where id = ${id}::bigint`;
	const token = b64url(randomBytes(32));
	const csrf = b64url(randomBytes(24));
	await sql`insert into sessions (token, user_id, csrf, superadmin, expires_at, ip) values (${token}, ${id}::bigint, ${csrf}, true, now() + make_interval(mins => ${SESSION_MINUTES}), ${ip})`;
	const headers = new Headers({ location: "/admin" });
	for (const c of sessionCookies({ token, csrf, userId: id })) headers.append("set-cookie", c);
	return new Response(null, { status: 303, headers });
}

