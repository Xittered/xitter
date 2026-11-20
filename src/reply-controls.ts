import { allCountries, countryCode, countryName, regionName } from "./countries";
import { sql } from "./db";
import { feature } from "./settings";

export class ReplyControlError extends Error {
	code = 214;
}

export type ReplyControl = { policy: string | null; selections: string[]; values: string[] };

const COUNTRIES = allCountries();
const REGIONS = new Map([...new Set(COUNTRIES.map((country) => regionName(country.code)).filter((region): region is string => !!region))].sort().map((region) => [region, [region.toLowerCase(), ...COUNTRIES.filter((country) => regionName(country.code) === region).flatMap((country) => [country.code.toLowerCase(), country.name.toLowerCase()])]]));

const MODES: Record<string, string> = { all: "All", community: "Community", by_invitation: "ByInvitation", verified: "Verified", premium: "Premium", my_network: "MyNetwork", followers: "Followers", co: "CountryOfOrigin", country: "Country", Co: "CountryOfOrigin" };
const POLICIES = new Set(["All", "Community", "ByInvitation", "Verified", "Premium", "MyNetwork", "Followers", "CountryOfOrigin", "Country"]);

export function replyCountrySelections(value: unknown = []): string[] {
	if (!Array.isArray(value) || value.length > 1000 || value.some((selection) => typeof selection !== "string" || !selection.trim() || selection.length > 100)) throw new ReplyControlError("Choose valid countries or regions.");
	return [...new Set(value.map((selection: string) => selection.trim()))];
}

export function replyControl(mode: unknown, selected: unknown = []): ReplyControl {
	const policy = typeof mode === "string" ? (Object.hasOwn(MODES, mode) ? MODES[mode] : mode) : "All";
	let selections: string[] = [], values: string[] = [], selection: string, code: string | undefined;
	if (mode !== undefined && (typeof mode !== "string" || !POLICIES.has(policy))) {
		console.warn("Unknown reply audience; using Everyone:", typeof mode === "string" ? JSON.stringify(mode.slice(0, 120)) : typeof mode);
		return { policy: null, selections, values };
	}
	if (policy === "All") return { policy: null, selections, values };
	if (policy === "CountryOfOrigin" || policy === "Country") {
		selections = replyCountrySelections(selected);
		if (!selections.length) throw new ReplyControlError("Choose at least one valid country or region.");
		for (selection of selections) {
			if (policy === "CountryOfOrigin" && REGIONS.has(selection)) {
				values.push(...REGIONS.get(selection)!);
			} else {
				code = countryCode(selection);
				if (policy === "CountryOfOrigin" && !code) throw new ReplyControlError("Unknown region.");
				values.push(...(code ? [code.toLowerCase(), countryName(code)!.toLowerCase()] : [selection, selection.toLowerCase()]));
			}
		}
	}
	return { policy, selections, values: [...new Set(values)] };
}

export async function conversationSettings() {
	const known = new Map(COUNTRIES.map((country) => [country.name.toLowerCase(), { label: country.name, value: country.code }]));
	const custom = await sql`select value from reply_country_catalog where account_count > 0 order by value`;
	const regions = [...REGIONS.keys()];
	let row: any, value: string;
	for (row of custom) {
		value = row.value.trim();
		if (!countryCode(value) && !known.has(value.toLowerCase())) known.set(value.toLowerCase(), { label: value, value });
	}
	return { data: { get_conversation_control_settings: { settings: [
		{ policy: "MyNetwork", available: true },
		{ policy: "Co", available: true, preferences: { __typename: "GeoPreferences", available_preferences: regions.map((region) => ({ label: region, value: region })) } },
		{ policy: "Country", available: true, preferences: { __typename: "GeoPreferences", available_preferences: [...known.values()].sort((a, b) => a.label.localeCompare(b.label)) } },
	] } } };
}

export const lockedAbove = (postId: ReturnType<typeof sql>, conversationId: ReturnType<typeof sql>, userId: string) => sql`exists (
	with recursive up (id, reply_to_id, depth) as (
		select q.id, q.reply_to_id, 0 from posts q where q.id = ${postId}
		union all
		select q.id, q.reply_to_id, up.depth + 1 from posts q join up on q.id = up.reply_to_id where up.depth < 200
	)
	select 1 from (select id from up union select ${conversationId}) ids join posts r on r.id = ids.id where ${replyDenied(userId)})`;

export const replyRestricted = (userId: string) => lockedAbove(sql`p.id`, sql`p.conversation_id`, userId);

export const replyDenied = (userId: string) => sql`r.reply_policy is not null and r.user_id <> ${userId}::bigint and not (
	(r.reply_policy in ('Community', 'MyNetwork') and exists (select 1 from follows f where f.follower_id = r.user_id and f.followee_id = ${userId}::bigint))
	or (r.reply_policy = 'MyNetwork' and exists (select 1 from follows f join follows ff on ff.follower_id = f.followee_id where f.follower_id = r.user_id and ff.followee_id = ${userId}::bigint))
	or (r.reply_policy = 'Followers' and exists (select 1 from follows f where f.follower_id = ${userId}::bigint and f.followee_id = r.user_id))
	or exists (select 1 from post_mentions m where m.post_id = r.id and m.user_id = ${userId}::bigint)
	or (r.reply_policy in ('Verified', 'Premium') and exists (select 1 from users x where x.id = ${userId}::bigint and (x.verified_type is not null or (${feature("affiliate_checkmarks")} and exists (select 1 from affiliations af where af.user_id = x.id)))))
	or (r.reply_policy in ('Country', 'CountryOfOrigin') and exists (select 1 from users x where x.id = ${userId}::bigint and (coalesce(nullif(trim(x.based_in_override), ''), trim(x.country)) = any(r.reply_allowed_values) or lower(coalesce(nullif(trim(x.based_in_override), ''), trim(x.country))) = any(r.reply_allowed_values))))
)`;
