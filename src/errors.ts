// Errors for Admin > Errors: requests that threw, background jobs that failed,
// and what the browser reports (client_error below). The same error counts up
// on one row, so a loop of failures doesn't fill the table.

import { createHash } from "node:crypto";
import type { Viewer } from "./auth";
import { sql } from "./db";

type Source = "server" | "client" | "job";
const KEEP = 2000;

// ids, numbers and hashes vary between occurrences of one error
const shape = (s: string) => s.replace(/\b[0-9a-f]{8,}\b|\d+/gi, "#");

export async function recordError(source: Source, error: unknown, at: { path?: string; userId?: string } = {}) {
	const e = error instanceof Error ? error : new Error(String(error));
	const message = (e.message || e.name || "Error").slice(0, 1000);
	const stack = e.stack?.slice(0, 4000) ?? null;
	// the message and the first frame name the error; the rest of the stack may differ
	const frame = stack?.split("\n").find((l) => /^\s+at /.test(l))?.trim() ?? "";
	const fingerprint = createHash("sha256").update(`${source}\0${shape(message)}\0${frame}`).digest("hex").slice(0, 32);
	const path = at.path?.slice(0, 300) ?? null;
	try {
		await sql`insert into error_log (fingerprint, source, message, stack, path, user_id)
			values (${fingerprint}, ${source}, ${message}, ${stack}, ${path}, ${at.userId ?? null})
			on conflict (fingerprint) do update set count = error_log.count + 1, last_at = now(), resolved = false,
				message = excluded.message, stack = excluded.stack, path = excluded.path, user_id = excluded.user_id`;
		if (Math.random() < 0.02) await sql`delete from error_log where fingerprint in (select fingerprint from error_log order by last_at desc offset ${KEEP})`;
	} catch (failed) {
		// the database may be what failed
		console.error("couldn't record an error", failed);
	}
}

// What the page's script reports (shell.ts ERROR_SCRIPT). Bounded per account,
// since a broken page reports on every render.
const budget = new Map<string, { left: number; until: number }>();
let nextBudgetSweep = 0;
export async function clientError(req: Request, viewer: Viewer): Promise<Response> {
	const now = Date.now();
	if (now >= nextBudgetSweep) {
		for (const [id, entry] of budget) if (entry.until < now) budget.delete(id);
		nextBudgetSweep = now + 60_000;
	}
	let b = budget.get(viewer.id);
	if (!b || b.until < now) budget.set(viewer.id, (b = { left: 60, until: now + 3600e3 }));
	if (b.left-- > 0) {
		const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
		const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
		const e = new Error(text(body.message, 1000) || "Unknown error");
		e.stack = text(body.stack, 4000) || e.message;
		let path = text(body.page, 300);
		try {
			path = new URL(path).pathname;
		} catch {}
		await recordError("client", e, { path, userId: viewer.id });
	}
	return new Response(null, { status: 204 });
}

// the page's uncaught errors, a few per page load; the client's own telemetry
// goes to X's formats, which aren't kept
export const ERROR_SCRIPT = `(function(){
	var left=10,seen={};
	function send(message,stack){
		if(!message||left<=0||seen[message])return;
		left--;seen[message]=1;
		var csrf=(document.cookie.match(/(?:^|; )ct0=([^;]+)/)||[])[1]||"";
		try{fetch("/i/api/xitter/client_error",{method:"POST",credentials:"same-origin",keepalive:true,headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({message:String(message),stack:String(stack||""),page:location.href})})}catch(e){}
	}
	window.addEventListener("error",function(e){if(e.error||e.message)send(e.message,e.error&&e.error.stack)});
	window.addEventListener("unhandledrejection",function(e){var r=e.reason;send(r&&r.message||String(r),r&&r.stack)});
})();`;
