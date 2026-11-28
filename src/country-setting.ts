// Settings > Your account > Account information > Country.
//
// The page sends the picked code into an onboarding flow
// (/1.1/onboarding/task.json?flow_name=change_country). We save it as the
// account's country: that is what "Account based in" on the About page shows
// (as the country or its continent, by the owner's choice), unless staff
// typed their own text there.

import type { Viewer } from "./auth";
import { countryName } from "./countries";
import { sql } from "./db";

const text = (t: string) => ({ text: t, entities: [] });

// the code sits somewhere in the flow's input; where depends on the build
function codeIn(body: unknown, depth = 0): string | undefined {
	if (!body || typeof body !== "object" || depth > 6) return undefined;
	for (const [k, v] of Object.entries(body)) {
		if (k === "country_code" && typeof v === "string") return v;
		const found = codeIn(v, depth + 1);
		if (found) return found;
	}
	return undefined;
}

const step = (title: string, detail: string) => ({
	flow_token: `change_country:${crypto.randomUUID()}`,
	status: "success",
	subtasks: [
		{
			subtask_id: "change_country_done",
			cta: { primary_text: text(title), secondary_text: text(detail), primary_action_link: { link_type: "finish_flow", link_id: "done", label: "Done" } },
		},
	],
});

export async function changeCountryFlow(viewer: Viewer, body: unknown): Promise<Response> {
	const code = codeIn(body)?.trim().toUpperCase();
	const name = code && /^[A-Z]{2}$/.test(code) ? countryName(code) : undefined;
	if (!code || !name) return Response.json(step("Country not changed", "That isn't a country we know."));
	await sql`update users set country_changed_at = case when country is distinct from ${code} then now() else country_changed_at end, country = ${code} where id = ${viewer.id}::bigint`;
	return Response.json(step("Country changed", `Your account is now based in ${name}. To show the country instead of the region, go to Settings > About your account.`));
}
