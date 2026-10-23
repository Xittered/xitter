import type { Viewer } from "./auth";
import { accountPage, esc } from "./account-page";
import { audit } from "./admin";
import { boundedBody } from "./api-input";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { isId } from "./ids";
import { noteStatus } from "./note-score";
import { hit, limitedResponse } from "./ratelimit";
import { staffGate } from "./staff-access";
import { allows } from "./staff-permissions";

const canReviewNotes = (v: Viewer) => allows(v.role, "note_appeals");

export async function noteAppealsRoute(req: Request, viewer: Viewer): Promise<Response> {
	let message = "";
	const canReview = canReviewNotes(viewer) && !(await staffGate(req, viewer));
	if (req.method === "POST") {
		const limit = hit("write", viewer.id);
		if (!limit.ok) return limitedResponse(limit);
		const origin = req.headers.get("origin");
		if (origin && origin !== PUBLIC_ORIGIN) return new Response("Wrong origin.", { status: 403 });
		let form: FormData;
		try {
			const bytes = await boundedBody(req, 16_384);
			form = await new Response(bytes, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
		} catch {
			return new Response("Invalid form.", { status: 400 });
		}
		if (String(form.get("csrf") ?? "") !== viewer.csrf) return new Response("Form expired.", { status: 403 });
		const noteId = String(form.get("note_id") ?? "");
		if (!isId(noteId)) return new Response("Invalid note.", { status: 400 });
		if (form.get("action") === "appeal") {
			const reason = String(form.get("reason") ?? "").trim();
			if (reason.length < 20 || reason.length > 1000) return new Response("Give a reason of 20–1000 characters.", { status: 400 });
			const [note] = await sql`select n.id, count(voter.id)::int as ratings,
				count(voter.id) filter(where r.rating = 'Helpful')::int as helpful,
				count(voter.id) filter(where r.rating = 'NotHelpful')::int as not_helpful
				from community_notes n left join community_note_ratings r on r.note_id = n.id
				left join users voter on voter.id = r.user_id and voter.status = 'active'
				where n.id = ${noteId}::bigint and n.author_id = ${viewer.id}::bigint and ${viewer.status === "active"}
				group by n.id`;
			if (!note || noteStatus(note.ratings, note.helpful, note.not_helpful) !== "NotHelpful") return new Response("This note cannot be appealed.", { status: 403 });
			const made = await sql`insert into community_note_appeals(note_id, author_id, reason) values(${noteId}::bigint, ${viewer.id}::bigint, ${reason}) on conflict do nothing returning note_id`;
			if (!made.length) return new Response("This note has already been appealed.", { status: 409 });
			message = "Your appeal was sent to staff.";
		} else if (form.get("action") === "review" && canReview) {
			const outcome = String(form.get("outcome") ?? "");
			const resolution = String(form.get("resolution") ?? "").trim();
			if (!["accepted", "rejected"].includes(outcome) || resolution.length < 10 || resolution.length > 1000) return new Response("Give an outcome and a 10–1000 character explanation.", { status: 400 });
			const decided = await sql`update community_note_appeals set status = ${outcome}, resolution = ${resolution}, reviewed_by = ${viewer.id}::bigint, reviewed_at = now()
				where note_id = ${noteId}::bigint and status = 'open' and author_id <> ${viewer.id}::bigint returning note_id`;
			if (!decided.length) return new Response("No open appeal to review.", { status: 404 });
			await audit(viewer, "review_community_note_appeal", noteId, { outcome });
			message = "Appeal reviewed.";
		} else return new Response("Action not allowed.", { status: 403 });
	}
	const own = await sql`select n.id::text, n.post_id::text, n.text, a.status, a.reason, a.resolution,
		count(r.user_id)::int as ratings, count(r.user_id) filter(where r.rating = 'Helpful')::int as helpful,
		count(r.user_id) filter(where r.rating = 'NotHelpful')::int as not_helpful
		from community_notes n left join community_note_appeals a on a.note_id = n.id
		left join (select x.* from community_note_ratings x join users voter on voter.id = x.user_id and voter.status = 'active') r on r.note_id = n.id
		where n.author_id = ${viewer.id}::bigint group by n.id, a.status, a.reason, a.resolution order by n.id desc limit 100`;
	const queue = canReview ? await sql`select a.note_id::text, n.post_id::text, n.text, a.reason, a.created_at from community_note_appeals a
		join community_notes n on n.id = a.note_id where a.status = 'open' and a.author_id <> ${viewer.id}::bigint order by a.created_at limit 100` : [];
	const csrf = `<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">`;
	const body = `<h1>Community Notes appeals</h1><p class="dim">Appeals ask staff to review a note rated Not Helpful. A staff decision is recorded separately from readers' ratings.</p>
${message ? `<p class="success">${esc(message)}</p>` : ""}
<h2>Your notes</h2>${own.length ? own.map((n) => {
		const rating = noteStatus(n.ratings, n.helpful, n.not_helpful);
		return `<div class="card"><a href="/i/birdwatch/n/${n.id}">Note ${n.id}</a><p>${esc(n.text)}</p><p class="dim">${esc(rating)} · ${n.ratings} active ratings${n.status ? ` · appeal ${esc(n.status)}` : ""}</p>
${n.resolution ? `<p>Staff response: ${esc(n.resolution)}</p>` : ""}
${rating === "NotHelpful" && !n.status && viewer.status === "active" ? `<form method="post">${csrf}<input type="hidden" name="action" value="appeal"><input type="hidden" name="note_id" value="${n.id}"><label>Why should this be reviewed?<textarea name="reason" minlength="20" maxlength="1000" required></textarea></label><button>Appeal note</button></form>` : ""}</div>`;
	}).join("") : `<p class="dim">You have not written any notes.</p>`}
${canReview ? `<h2>Open appeals</h2>${queue.length ? queue.map((a) => `<div class="card"><a href="/i/birdwatch/n/${a.note_id}">Note ${a.note_id}</a><p>${esc(a.text)}</p><p>Reason: ${esc(a.reason)}</p><form method="post">${csrf}<input type="hidden" name="action" value="review"><input type="hidden" name="note_id" value="${a.note_id}"><select name="outcome"><option value="accepted">Accept appeal</option><option value="rejected">Reject appeal</option></select><textarea name="resolution" minlength="10" maxlength="1000" required placeholder="Explain your decision"></textarea><button>Save decision</button></form></div>`).join("") : `<p class="dim">No open appeals.</p>`}` : ""}`;
	return accountPage({ req, viewer, title: "Community Notes appeals", body, referrer: "same-origin" });
}
