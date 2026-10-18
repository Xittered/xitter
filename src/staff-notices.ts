// What staff sent an account (messages, warnings, strikes) and its appeals.
// New ones arrive in the Notifications tab (notifications.ts), which links
// here. A suspended account can't sign in, so /appeal also takes the
// handle and password.

import { hit, used } from "./ratelimit";
import { randomBytes } from "node:crypto";
import type { Viewer } from "./auth";
import { SECURE } from "./auth";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { esc, html, layout } from "./login";
import { settings } from "./settings";

const KIND = { message: "Message", warning: "Warning", strike: "Strike" } as Record<string, string>;
const OUTCOME = { open: "Waiting for staff", accepted: "Accepted", rejected: "Turned down" } as Record<string, string>;
const date = (d: Date) => new Date(d).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

async function submitAppeal(userId: string, body: unknown, messageId?: unknown) {
	const text = typeof body === "string" ? body.trim() : "";
	if (!text || [...text].length > 2000) throw new Error("Write an appeal of 1–2000 characters.");
	let message: string | null = null;
	if (messageId) {
		if (!isId(messageId)) throw new Error("Invalid message.");
		const [row] = await sql`select id::text from staff_messages where id = ${messageId}::bigint and user_id = ${userId}::bigint and revoked_at is null`;
		if (!row) throw new Error("No such message.");
		message = row.id;
	}
	const rows = await sql`insert into moderation_appeals (id, user_id, message_id, body) values (${newId()}::bigint, ${userId}::bigint, ${message}::bigint, ${text})
		on conflict (user_id) where status = 'open' do nothing returning id::text`;
	if (!rows.length) throw new Error("You already have an open appeal.");
	return { id: rows[0].id };
}

const messagesOf = (userId: string) =>
	sql`select id::text, kind, body, created_at, read_at, revoked_at from staff_messages where user_id = ${userId}::bigint order by id desc limit 100`;
const appealsOf = (userId: string) =>
	sql`select id::text, body, status, staff_reply, created_at, resolved_at from moderation_appeals where user_id = ${userId}::bigint order by id desc limit 30`;

// GET: the viewer's messages and appeals; POST: appeal, or mark a message read
export async function noticesApi(req: Request, v: Viewer) {
	if (req.method === "GET") return Response.json({ messages: await messagesOf(v.id), appeals: await appealsOf(v.id) }, { headers: { "cache-control": "no-store" } });
	if (req.method !== "POST") return new Response(null, { status: 405 });
	const b = await req.json().catch(() => ({}));
	try {
		if (b.action === "appeal") return Response.json(await submitAppeal(v.id, b.body, b.messageId));
		if (b.action === "read" && isId(b.id)) {
			await sql`update staff_messages set read_at = coalesce(read_at, now()) where id = ${b.id}::bigint and user_id = ${v.id}::bigint`;
			return Response.json({});
		}
		return Response.json({ error: "Unknown action." }, { status: 400 });
	} catch (e) {
		return Response.json({ error: (e as Error).message }, { status: 400 });
	}
}

export async function noticesPage(v: Viewer) {
	const [messages, appeals] = await Promise.all([messagesOf(v.id), appealsOf(v.id)]);
	// opening the page reads them
	await sql`update staff_messages set read_at = now() where user_id = ${v.id}::bigint and read_at is null`;
	const open = appeals.some((a: any) => a.status === "open");
	const list = messages.length
		? messages.map((m: any) => `<div class="item ${esc(m.kind)}">
		<div class="meta">${esc(KIND[m.kind] ?? m.kind)}${m.revoked_at ? " · withdrawn by staff" : ""} · ${esc(date(m.created_at))}</div>
		<p>${esc(m.body)}</p>
		${m.kind !== "message" && !m.revoked_at && !open ? `<button class="ghost" type="button" data-appeal="${m.id}">Appeal</button>` : ""}
	</div>`).join("")
		: `<p class="alt">Nothing from staff.</p>`;
	const appealList = appeals.map((a: any) => `<div class="item">
		<div class="meta">${esc(OUTCOME[a.status] ?? a.status)} · ${esc(date(a.created_at))}</div>
		<p>${esc(a.body)}</p>
		${a.staff_reply ? `<div class="meta">Staff replied</div><p>${esc(a.staff_reply)}</p>` : ""}
	</div>`).join("");
	const body = `<main style="width:min(560px,calc(100vw - 32px));display:grid;gap:12px;padding:32px 0 64px">
	<p><a href="/notifications">← Back</a></p>
	<h1>From the ${esc(settings().instance_name)} team</h1>
	${list}
	${appealList ? `<h2>Your appeals</h2>${appealList}` : ""}
	${open ? "" : `<form id="appeal" hidden style="padding:0">
		<label for="appeal-body">Why should staff reconsider?</label>
		<textarea id="appeal-body" maxlength="2000" required></textarea>
		<p class="error" id="appeal-error" role="alert"></p>
		<button type="submit">Send appeal</button>
	</form>`}
</main>
<script>
(function(){
	var csrf=(document.cookie.match(/(?:^|;\\s*)ct0=([^;]+)/)||[])[1]||"",form=document.getElementById("appeal"),message;
	document.querySelectorAll("[data-appeal]").forEach(function(b){b.onclick=function(){message=b.dataset.appeal;form.hidden=false;form.querySelector("textarea").focus()}});
	if(form)form.onsubmit=function(e){
		e.preventDefault();
		var button=form.querySelector("button");button.disabled=true;
		fetch("/i/api/xitter/moderation",{method:"POST",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({action:"appeal",messageId:message,body:form.querySelector("textarea").value})})
			.then(function(r){return r.json().then(function(d){if(!r.ok)throw new Error(d.error);location.reload()})})
			.catch(function(err){document.getElementById("appeal-error").textContent=err.message;button.disabled=false});
	};
})();
</script>`;
	return html(layout("From staff", body));
}

// failed attempts per address, so the password field can't be guessed at
const dummyHash = Bun.password.hash(randomBytes(32).toString("hex"));
const attempts = new Map<string, { count: number; until: number }>();

const appealForm = (csrf: string, error = "") => `<form method="post" action="/appeal">
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Appeal a decision</h1>
	<p class="alt" style="margin:0">If your account was suspended, sign in here to ask staff to look again.</p>
	<input type="hidden" name="csrf" value="${csrf}">
	<label for="handle">Handle</label><input id="handle" name="username" autocomplete="username" required maxlength="15">
	<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
	<label for="body">Why should staff reconsider?</label><textarea id="body" name="body" maxlength="2000" required></textarea>
	${error ? `<p class="error" role="alert">${esc(error)}</p>` : ""}
	<button type="submit">Send appeal</button>
	<p class="alt"><a href="/">Back</a></p>
</form>`;

export async function appealRoute(req: Request, address: string) {
	const page = (error = "", status = 200) => {
		const csrf = randomBytes(24).toString("hex");
		const res = html(layout("Appeal", appealForm(csrf, error)), status);
		res.headers.set("set-cookie", `appeal_csrf=${csrf}; Path=/appeal; Max-Age=1800; HttpOnly; SameSite=Lax${SECURE}`);
		return res;
	};
	if (req.method === "GET") return page();
	if (req.method !== "POST") return new Response(null, { status: 405 });
	if (req.headers.get("origin") !== PUBLIC_ORIGIN) return new Response("Invalid origin.", { status: 403 });

	const key = address || "unknown";
	const old = attempts.get(key);
	const bucket = old && old.until > Date.now() ? old : { count: 0, until: Date.now() + 5 * 60_000 };
	if (bucket.count++ >= 5) return page("Too many tries. Wait five minutes.", 429);
	attempts.set(key, bucket);
	if (attempts.size > 10_000) for (const [k, b] of attempts) if (b.until < Date.now()) attempts.delete(k);

	if (Number(req.headers.get("content-length") ?? Infinity) > 8192) return page("That's too long.", 413);
	const raw = await req.text();
	const form = new URLSearchParams(raw);
	const cookie = /(?:^|;\s*)appeal_csrf=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
	if (!cookie || form.get("csrf") !== cookie) return page("The form expired. Try again.", 403);
	const handle = String(form.get("username") ?? "").trim().replace(/^@/, "").toLowerCase().slice(0, 15);
	if (used("password", handle)) return page("Too many tries for that account. Wait 15 minutes.", 429);
	const [user] = await sql`select id::text, password_hash from users where lower(screen_name) = ${handle}`;
	const valid = await Bun.password.verify(String(form.get("password") ?? "").slice(0, 1024), user?.password_hash ?? (await dummyHash)).catch(() => false);
	if (!user || !valid) {
		hit("password", handle);
		return page("Wrong handle or password.", 400);
	}
	try {
		await submitAppeal(user.id, form.get("body"));
	} catch (e) {
		return page((e as Error).message, 400);
	}
	return html(layout("Appeal sent", `<form>
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>Appeal sent</h1>
	<p class="alt" style="margin:0">Staff will look at it. If they lift the suspension, you can sign in again.</p>
	<p class="alt"><a href="/">Back</a></p>
</form>`));
}
