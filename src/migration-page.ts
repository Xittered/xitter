// /account/migrate: moving an account between instances. The old instance's
// side makes a migration code (migration.ts); the new instance's side checks
// the old one with it, shows what doesn't line up, and runs the import
// (migration-import.ts), whose progress and report show here too.

import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { INSTANCE_ID } from "./federation";
import { type Check, type Finding, MigrationError, check, jobs, start } from "./migration-import";
import { codeState, createCode, revokeCodes, versionInfo } from "./migration";
import { hit, passwordTry } from "./ratelimit";
import { feature } from "./settings";

const CSS = `
.versions{display:grid;grid-template-columns:auto 1fr 1fr;gap:4px 16px;font-size:14px}
.versions .head{color:var(--muted);font-size:13px}
.versions .bad{color:var(--danger);font-weight:700}
.counts{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:14px}
.counts b{font-weight:700}
.check{display:flex;gap:10px;align-items:flex-start;color:var(--text);font-size:15px;line-height:20px;margin:0}
.check input{width:20px;min-height:20px;height:20px;margin:0;flex:none}
.bar-track{height:6px;border-radius:9999px;background:var(--border);overflow:hidden}
.bar-fill{height:100%;background:var(--accent)}
ul{margin:0;padding-left:20px;display:grid;gap:4px}
details summary{cursor:pointer;color:var(--accent)}
`;

const when = (d: Date | string | null) => (d ? new Date(d).toUTCString().replace(/:\d\d GMT$/, " UTC") : "");
const versionLine = (v: { version: string; schema: string; commit: string | null }) => `Xitter ${esc(v.version)} · schema <code>${esc(v.schema)}</code>${v.commit ? ` · commit <code>${esc(v.commit)}</code>` : ""}`;

function findings(list: Finding[], kind: "strike" | "warning" | "", title: string) {
	if (!list.length) return "";
	return `<div class="card ${kind}"><b>${esc(title)}</b><ul>${list.map((f) => `<li>${esc(f.text)}</li>`).join("")}</ul></div>`;
}

function counts(c: Record<string, { done: number; skipped: number }> | undefined) {
	const entries = Object.entries(c ?? {});
	if (!entries.length) return "";
	return `<div class="counts">${entries.map(([k, v]) => `<span><b>${v.done}</b> ${esc(k)}${v.skipped ? ` <span class="dim">(${v.skipped} not brought over)</span>` : ""}</span>`).join("")}</div>`;
}

function jobCard(j: any, open: boolean) {
	const p = j.progress ?? {};
	const r = j.report ?? {};
	const pct = p.total ? Math.min(100, Math.round((100 * (p.done ?? 0)) / p.total)) : null;
	const state = j.state === "running" ? "Running" : j.state === "done" ? "Finished" : "Stopped";
	const finished = r.finished
		? r.finished.ok
			? `<p class="dim">The old instance recorded the move${r.finished.deactivated ? " and deactivated the old account" : ""}.</p>`
			: `<p class="error">The old instance couldn't record the move: ${esc(r.finished.error ?? "")}</p>`
		: "";
	const unresolved: string[] = r.unresolved ?? [];
	return `<div class="card${j.state === "failed" ? " strike" : j.state === "done" ? " success" : ""}">
	<div class="split"><b>From @${esc(j.source_handle)} on ${esc(new URL(j.source).host)}</b><span class="meta">${state} · ${esc(when(j.created_at))}</span></div>
	${j.state === "running" ? `<p>${esc(p.step ?? "")}${p.total ? ` (${p.done ?? 0} of ${p.total})` : ""}</p>${pct !== null ? `<div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>` : ""}` : ""}
	${j.error ? `<p class="error">${esc(j.error)}</p>` : ""}
	${counts(j.state === "running" ? p.counts : (r.counts ?? p.counts))}
	${finished}
	${(r.skipped ?? []).length ? `<details${open ? " open" : ""}><summary>What wasn't brought over (${r.skipped.length})</summary><ul>${r.skipped.map((s: string) => `<li>${esc(s)}</li>`).join("")}</ul></details>` : ""}
	${unresolved.length ? `<details><summary>Accounts this instance couldn't find (${r.unresolved_total ?? unresolved.length})</summary><p class="dim">They aren't known here yet. Follow them again once they are, or search for their full handle.</p><ul>${unresolved.map((u) => `<li>${esc(u)}</li>`).join("")}</ul></details>` : ""}
</div>`;
}

async function home(req: Request, viewer: Viewer, opts: { notice?: string; error?: string; code?: string; status?: number } = {}) {
	const here = versionInfo();
	const [me] = await sql`select moved_to, moved_at from users where id = ${viewer.id}::bigint`;
	const state = await codeState(viewer.id);
	const recent = await jobs(viewer.id);
	const running = recent.some((j: any) => j.state === "running");
	const on = feature("migration");
	const csrf = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
	const codeCard = opts.code
		? `<div class="card success"><b>Your migration code</b>
	<p>On the new instance, sign in to the account you're moving to, open <b>Move account</b> and enter:</p>
	<label>Address</label><p class="box code">${esc(INSTANCE_ID)}</p>
	<label>Code</label><p class="box code">${esc(opts.code)}</p>
	<p class="dim">It's shown only now and works for 24 hours. Anyone with it can copy your account's data, so don't share it.</p></div>`
		: state
			? `<div class="card"><b>A migration code is ${state.expired ? "expired" : "active"}</b>
	<p class="meta">Made ${esc(when(state.created_at))}, ${state.expired ? "expired" : "expires"} ${esc(when(state.expires_at))}${state.used_by ? ` · last used by ${esc(state.used_by)} ${esc(when(state.used_at))}` : " · not used yet"}</p>
	<form method="post" action="/account/migrate" class="inline">${csrf}<input type="hidden" name="action" value="revoke"><button class="secondary small" type="submit">Withdraw it</button></form></div>`
			: "";
	return accountPage({
		req,
		viewer,
		title: "Move account",
		referrer: null,
		status: opts.status ?? 200,
		css: CSS,
		body: `<h1>Move your account</h1>
<p class="dim">Bring @${esc(viewer.screen_name)} over from another Xitter instance, or take it from here to another one. Posts, files, polls, articles, drafts, your profile, follows, blocks, mutes, lists, likes and bookmarks come along.</p>
<p class="meta">${esc(here.name)} (${esc(INSTANCE_ID)}) runs ${versionLine(here)}.</p>
${opts.notice ? `<p class="card success">${esc(opts.notice)}</p>` : ""}
${opts.error ? `<p class="error">${esc(opts.error)}</p>` : ""}
${on ? "" : `<p class="card warning">Moving accounts is turned off on ${esc(here.name)}. Imports already running still finish, and a code made earlier can still be withdrawn.</p>`}
${me?.moved_to ? `<div class="card warning"><b>This account moved to @${esc(me.moved_to)}</b><p class="meta">${esc(when(me.moved_at))}</p></div>` : ""}

${on ? `<h2>Move here from another instance</h2>
<p class="dim">First make a migration code on the instance your account is on now, under Move account there. Then sign in here with the account it should move into.</p>
<form method="post" action="/account/migrate">
	${csrf}<input type="hidden" name="action" value="check">
	<label for="source">Old instance's address</label><input id="source" name="source" placeholder="xit.example.org" autocomplete="off" required>
	<label for="code">Migration code</label><input id="code" name="code" placeholder="xmig_…" autocomplete="off" spellcheck="false" required>
	<button type="submit"${running ? " disabled" : ""}>Check</button>
	<p class="dim">Nothing is copied yet: the next step shows whether the two instances line up.</p>
</form>` : ""}
${recent.length ? `<h2>Imports</h2>${recent.map((j: any, i: number) => jobCard(j, i === 0)).join("")}` : ""}
${running ? `<script>setTimeout(function(){location.reload()},2000)</script>` : ""}

${on || codeCard ? `<h2>Move to another instance</h2>` : ""}
${on ? `<p class="dim">A migration code lets the new instance copy this account's data. When the move is done there, this account can leave a note on its profile pointing to the new one, and be deactivated. Followers can't be moved for them, and encrypted chats stay here.</p>` : ""}
${codeCard}
${on ? `<form method="post" action="/account/migrate">
	${csrf}<input type="hidden" name="action" value="code">
	<label for="password">Your password</label><input id="password" name="password" type="password" autocomplete="current-password" required>
	<button type="submit">${state && !state.expired ? "Make a new code" : "Make a migration code"}</button>
	${state && !state.expired ? `<p class="dim">A new code replaces the one above.</p>` : ""}
</form>` : ""}
<p class="dim"><a href="/settings/account">Back to settings</a></p>`,
	});
}

function checkPage(req: Request, viewer: Viewer, c: Check, code: string, error = "") {
	const a = c.info.account;
	const csrf = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
	const differs = (k: "version" | "schema" | "format_version") => (String(c.info[k]) !== String(c.here[k]) ? ' class="bad"' : "");
	const media = Array.isArray(a.media) ? a.media : [];
	const bytes = media.reduce((n: number, m: any) => n + (Number(m?.size) || 0), 0);
	const option = (name: string, label: string, on = true, hint = "") =>
		`<label class="check"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""}><span>${label}${hint ? `<br><span class="dim">${hint}</span>` : ""}</span></label>`;
	return accountPage({
		req,
		viewer,
		title: "Move account",
		referrer: null,
		status: error ? 400 : 200,
		css: CSS,
		back: { href: "/account/migrate", label: "Back to Move account" },
		body: `<h1>Move @${esc(a.screen_name)} from ${esc(c.source.host)}</h1>
${error ? `<p class="error">${esc(error)}</p>` : ""}
<div class="versions">
	<span class="head"></span><span class="head">${esc(c.source.host)}</span><span class="head">${esc(INSTANCE_ID)} (here)</span>
	<span>Version</span><span${differs("version")}>${esc(c.info.version)}</span><span>${esc(c.here.version)}</span>
	<span>Schema</span><span${differs("schema")}><code>${esc(String(c.info.schema).slice(0, 16))}</code></span><span><code>${esc(c.here.schema)}</code></span>
	<span>Archive format</span><span${differs("format_version")}>${esc(String(c.info.format_version))}</span><span>${c.here.format_version}</span>
	${c.info.commit || c.here.commit ? `<span>Commit</span><span>${esc(c.info.commit ?? "unknown")}</span><span>${esc(c.here.commit ?? "unknown")}</span>` : ""}
</div>
${findings(c.blockers, "strike", "This move can't go ahead")}
${findings(c.warnings, "warning", "Check these before you continue")}
${findings(c.notes, "", "Good to know")}
<div class="card"><b>@${esc(a.screen_name)} · ${esc(a.name ?? "")}</b>
	<div class="counts"><span><b>${a.posts}</b> posts</span><span><b>${media.length}</b> files (${(bytes / 1024 / 1024).toFixed(1)} MB)</span><span><b>${a.following}</b> following</span><span><b>${a.likes}</b> likes</span><span><b>${a.bookmarks}</b> bookmarks</span><span><b>${a.lists}</b> lists</span><span><b>${a.drafts}</b> drafts and scheduled</span><span><b>${a.articles}</b> articles</span></div>
</div>
${c.blockers.length ? `<p><a href="/account/migrate">Back</a></p>` : `<form method="post" action="/account/migrate">
	${csrf}<input type="hidden" name="action" value="start">
	<input type="hidden" name="source" value="${esc(c.source.origin)}"><input type="hidden" name="code" value="${esc(code)}"><input type="hidden" name="ack" value="${esc(c.ack)}">
	<h2>Bring over</h2>
	${option("profile", "Profile", true, "Name, bio, location, website, avatar, banner, pinned post and settings. They replace this account's.")}
	${option("content", "Posts and files", true, "With replies, quotes, polls, articles, edit history, drafts and scheduled posts.")}
	${option("connections", "Connections", true, "Follows, follow requests, blocks, mutes, muted words, lists, likes, reposts, bookmarks and their folders.")}
	<h2>Afterwards, on ${esc(c.source.host)}</h2>
	${option("finish", "Record the move there", true, `Its scheduled posts are cancelled (they're scheduled here now) and the code stops working.`)}
	${option("note", `Leave “Moved to @${esc(viewer.screen_name)}@${esc(INSTANCE_ID)}” as the old profile's bio`, true)}
	${option("deactivate", "Deactivate the old account", false, "It can be brought back by signing in there within 30 days.")}
	${c.warnings.length ? `<h2>Confirm</h2>${option("accept", "I've read the warnings above and want to move anyway", false)}` : ""}
	<button type="submit">Start moving</button>
	<p class="dim">The import runs in the background; you can leave this page. Running it again later only adds what's missing.</p>
</form>`}`,
	});
}

export async function migrateRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (viewer.actor) return home(req, viewer, { error: "Delegates can't move the account they act for.", status: 403 });
	if (req.method !== "POST") return home(req, viewer);
	const f = await req.formData().catch(() => undefined);
	const field = (k: string) => String(f?.get(k) ?? "");
	if (field("csrf") !== viewer.csrf) return home(req, viewer, { error: "That form is out of date. Try again.", status: 400 });
	const action = field("action");
	if (!feature("migration") && action !== "revoke") return home(req, viewer, { error: "Moving accounts is turned off on this instance.", status: 403 });
	if (action === "code") {
		const account = viewer.screen_name.toLowerCase();
		const refund = passwordTry(account);
		if (!refund) return home(req, viewer, { error: "Too many tries. Wait 15 minutes.", status: 429 });
		const [u] = await sql`select password_hash from users where id = ${viewer.id}::bigint`;
		if (!u || !(await Bun.password.verify(field("password"), u.password_hash).catch(() => false)))
			return home(req, viewer, { error: "That password isn't right.", status: 400 });
		refund();
		return home(req, viewer, { code: await createCode(viewer.id) });
	}
	if (action === "revoke") {
		await revokeCodes(viewer.id);
		return home(req, viewer, { notice: "The migration code doesn't work any more." });
	}
	if (action === "check" || action === "start") {
		const h = hit("endpoint", `${viewer.id}:migrate`);
		if (!h.ok) return home(req, viewer, { error: "Too many tries. Wait a few minutes.", status: 429 });
		try {
			if (action === "check") {
				const code = field("code").trim();
				return checkPage(req, viewer, await check(viewer, field("source"), code), code);
			}
			const yes = (k: string) => field(k) === "1";
			const options = { profile: yes("profile"), content: yes("content"), connections: yes("connections"), finish: yes("finish"), note: yes("note") && yes("finish"), deactivate: yes("deactivate") && yes("finish") };
			if (!options.profile && !options.content && !options.connections) {
				const code = field("code").trim();
				return checkPage(req, viewer, await check(viewer, field("source"), code), code, "Pick at least one thing to bring over.");
			}
			const ack = yes("accept") ? field("ack") : "";
			await start(viewer, field("source"), field("code"), ack, options);
			return new Response(null, { status: 303, headers: { location: "/account/migrate" } });
		} catch (e) {
			if (!(e instanceof MigrationError)) throw e;
			if (action === "start" && /warnings|checks changed/.test(e.message)) {
				const code = field("code").trim();
				const again = await check(viewer, field("source"), code).catch(() => undefined);
				if (again) return checkPage(req, viewer, again, code, field("accept") ? e.message : "Tick the box to confirm you've read the warnings.");
			}
			return home(req, viewer, { error: e.message, status: 400 });
		}
	}
	return home(req, viewer);
}
