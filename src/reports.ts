// Reporting: the client's "Report post" / "Report account" screens run X's
// step-by-step task flow against POST /1.1/report/flow.json. We answer with our
// own steps (a reason, optional details, a thank-you) and file a report for
// staff. The flow's state lives here between steps, keyed by its flow token.

import type { Viewer } from "./auth";
import { sql } from "./db";
import { isId, newId } from "./ids";

export const REASONS: Record<string, { text: string; subtext: string }> = {
	spam: { text: "Spam", subtext: "Fake engagement, scams, misleading links, repetitive posts" },
	harassment: { text: "Harassment or bullying", subtext: "Insults, threats, targeting someone, unwanted attention" },
	hate: { text: "Hate", subtext: "Attacking people for who they are" },
	violence: { text: "Violence", subtext: "Threats, glorifying or encouraging violence" },
	self_harm: { text: "Self-harm", subtext: "Encouraging suicide or self-harm" },
	sensitive: { text: "Sensitive or graphic media", subtext: "Adult content or gore that isn't marked" },
	impersonation: { text: "Impersonation", subtext: "Pretending to be someone else" },
	private_info: { text: "Private information", subtext: "Sharing someone's address, phone or photos without consent" },
	other: { text: "Something else", subtext: "Tell us in the next step" },
};

// The flow's state rides in its token, so a restart or a second process
// between steps doesn't lose the report. Nothing in it needs to be secret:
// the reporter must match the session, and anyone may report any post.
type Draft = { reporter: string; postId: string | null; userId: string | null; reason?: string; at: number };
const DRAFT_MS = 60 * 60 * 1000;

const tokenOf = (d: Draft) => `report:${Buffer.from(JSON.stringify(d)).toString("base64url")}`;

function draftOf(token: string): Draft | undefined {
	if (!token.startsWith("report:")) return undefined;
	try {
		const d = JSON.parse(Buffer.from(token.slice(7), "base64url").toString());
		const id = (v: unknown) => (v === null || isId(v) ? v : undefined);
		if (!isId(d.reporter) || id(d.postId) === undefined || id(d.userId) === undefined || typeof d.at !== "number") return undefined;
		return { reporter: d.reporter, postId: d.postId, userId: d.userId, reason: REASONS[d.reason] ? d.reason : undefined, at: d.at };
	} catch {
		return undefined;
	}
}

const text = (t: string) => ({ text: t, entities: [] });
const link = (type: string, id: string, label?: string) => ({ link_type: type, link_id: id, ...(label ? { label } : {}) });

const flow = (token: string, subtask: object) => ({ flow_token: token, status: "success", subtasks: [subtask] });

const reasonStep = (what: string) => ({
	subtask_id: "report_reason",
	choice_selection: {
		primary_text: text(`What's wrong with this ${what}?`),
		secondary_text: text("Staff of this instance will look at your report."),
		choices: Object.entries(REASONS).map(([id, r]) => ({ id, text: text(r.text), subtext: text(r.subtext) })),
		selection_type: "single_select",
		next_link: link("task", "next_link", "Next"),
		skip_link: link("abort_flow", "cancel", "Cancel"),
	},
});

const detailsStep = () => ({
	subtask_id: "report_details",
	enter_text: {
		primary_text: text("Anything else staff should know?"),
		secondary_text: text("Optional. Links, context, or what happened."),
		hint_text: "Details",
		multiline: true,
		max_length: 1000,
		next_link: link("task", "next_link", "Send report"),
		skip_link: link("task", "skip_link", "Send without details"),
	},
});

const doneStep = () => ({
	subtask_id: "report_done",
	cta: {
		primary_text: text("Thanks for letting us know"),
		secondary_text: text("Your report went to this instance's staff. You can also block or mute the account from its profile."),
		primary_action_link: link("finish_flow", "done", "Done"),
	},
});

// the reported post or account, from the flow's start request
function target(body: any): { postId: string | null; userId: string | null } {
	let v: any = body?.input_flow_data?.requested_variant;
	if (typeof v === "string") {
		try {
			v = JSON.parse(v);
		} catch {
			v = {};
		}
	}
	const postId = [v?.reported_tweet_id, v?.tweet_id].find(isId) ?? null;
	const userId = [v?.reported_user_id, v?.user_id].find(isId) ?? null;
	return { postId, userId };
}

export async function reportFlow(viewer: Viewer, url: URL, body: any): Promise<Response> {
	const now = Date.now();

	// a new flow
	if (url.searchParams.get("flow_name") || !body?.flow_token) {
		let { postId, userId } = target(body);
		if (postId && !userId) {
			const [p] = await sql`select user_id::text as user_id from posts where id = ${postId}::bigint`;
			userId = p?.user_id ?? null;
		}
		const draft = { reporter: viewer.id, postId, userId, at: now };
		return Response.json(flow(tokenOf(draft), reasonStep(postId ? "post" : "account")));
	}

	const draft = draftOf(String(body.flow_token));
	if (!draft || draft.reporter !== viewer.id || now - draft.at > DRAFT_MS) {
		return Response.json({ errors: [{ code: 366, message: "This report expired. Please start again." }] }, { status: 400 });
	}
	const inputs: any[] = Array.isArray(body.subtask_inputs) ? body.subtask_inputs : [];
	const reason = inputs.find((i) => i.subtask_id === "report_reason")?.choice_selection?.selected_choices?.[0];
	if (reason && REASONS[reason]) {
		return Response.json(flow(tokenOf({ ...draft, reason }), detailsStep()));
	}
	const details = inputs.find((i) => i.subtask_id === "report_details")?.enter_text;
	if (details && draft.reason) {
		const textIn = details.link === "skip_link" ? "" : String(details.text ?? "").slice(0, 1000);
		// a resent last step files once
		const [dupe] = await sql`select 1 from reports where reporter_id = ${viewer.id}::bigint and post_id is not distinct from ${draft.postId}::bigint
			and user_id is not distinct from ${draft.userId}::bigint and reason = ${draft.reason} and created_at > now() - interval '1 minute'`;
		const [recent] = await sql`select count(*)::int as n from reports where reporter_id = ${viewer.id}::bigint and created_at > now() - interval '1 hour'`;
		if (recent.n >= 30) return Response.json({ errors: [{ code: 88, message: "You've sent a lot of reports. Try again later." }] }, { status: 429 });
		if (!dupe) {
			await sql`insert into reports (id, reporter_id, post_id, user_id, reason, details)
				values (${newId()}::bigint, ${viewer.id}::bigint, ${draft.postId}::bigint, ${draft.userId}::bigint, ${draft.reason}, ${textIn})`;
		}
		return Response.json(flow(String(body.flow_token), doneStep()));
	}
	return Response.json(flow(String(body.flow_token), reasonStep(draft.postId ? "post" : "account")));
}
