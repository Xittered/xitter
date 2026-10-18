// Trends by location: Explore settings pick a place, and Explore and the side
// bar count only posts by accounts based there. Restores what it changes.
// usage: bun scripts/test-trends-location.ts <viewer> <author A> <author B> <password>

import { sql } from "../src/db";
import { loosenTrends } from "./loose-trends";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [viewerName, aName, bName, password] = process.argv.slice(2);
if (!password) throw new Error("usage: bun scripts/test-trends-location.ts <viewer> <author A> <author B> <password>");

async function session(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
	if (!csrf) throw new Error(`login ${username} failed`);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
	const gql = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json();
	const get = async (op: string, variables: object) =>
		(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();
	const rest = async (path: string, json?: object) =>
		(await fetch(`${origin}/i/api${path}`, json ? { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(json) } : { headers })).json();
	return { gql, get, rest };
}
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const viewer = await session(viewerName);
const a = await session(aName);
const b = await session(bName);
const before = (await sql`select screen_name, country, preferences->'explore' as explore from users where screen_name in (${viewerName}, ${aName}, ${bName})`) as any[];
const was = Object.fromEntries(before.map((r) => [r.screen_name, r]));
const stamp = Date.now().toString(36);
const de = `zqde${stamp}`;
const fr = `zqfr${stamp}`;
const made: [typeof a, string][] = [];

const trends = async () => {
	const entries = (await viewer.get("ExplorePage", {})).data.explore_page.body.timeline.instructions[0].entries;
	return entries.map((e: any) => e.content.itemContent) as { name: string; trend_metadata: { domain_context: string } }[];
};
const names = async () => (await trends()).map((t) => t.name);

const restoreTrends = await loosenTrends(origin);
try {
	await sql`update users set country = 'DE' where screen_name = ${aName}`;
	await sql`update users set country = 'FR' where screen_name = ${bName}`;
	await sql`update users set country = 'FR' where screen_name = ${viewerName}`;
	made.push([a, (await a.gql("CreateTweet", { tweet_text: `#${de} news` })).data.create_tweet.tweet_results.result.rest_id]);
	made.push([b, (await b.gql("CreateTweet", { tweet_text: `#${fr} news` })).data.create_tweet.tweet_results.result.rest_id]);

	const start = await viewer.rest("/2/guide/get_explore_settings.json");
	check("settings start personalized, worldwide", start.use_personalized_trends === true && start.places[0]?.name === "Worldwide", start);
	const found = await viewer.rest("/2/guide/explore_locations_with_auto_complete.json?prefix=germ");
	check("locations can be searched", found.some((p: any) => p.place_id === "DE" && p.name === "Germany"), found);

	let list = await names();
	check("personalized: trends from the viewer's own country", list.includes(`#${fr}`) && !list.includes(`#${de}`), list);
	check("labelled with it", (await trends()).every((t) => t.trend_metadata.domain_context === "Trending in France"));

	const saved = await viewer.rest("/2/guide/set_explore_settings.json", { use_personalized_trends: false, use_current_location: false, places: ["DE"] });
	check("picking Germany", saved.places[0]?.place_id === "DE" && saved.use_personalized_trends === false, saved);
	list = await names();
	check("then Germany's trends", list.includes(`#${de}`) && !list.includes(`#${fr}`), list);
	const side = (await viewer.get("ExploreSidebar", {})).data.explore_sidebar.timeline.instructions[1].entries[0]?.content.items.map((i: any) => i.item.itemContent.name);
	check("in the side bar too", side?.includes(`#${de}`) && !side.includes(`#${fr}`), side);

	await viewer.rest("/2/guide/set_explore_settings.json", { use_current_location: true });
	check("using the current location goes back to the viewer's country", (await names()).includes(`#${fr}`));
	await viewer.rest("/2/guide/set_explore_settings.json", { use_current_location: false, places: ["1"] });
	list = await names();
	check("worldwide has both", list.includes(`#${de}`) && list.includes(`#${fr}`), list);
	check("an unknown place is ignored", (await viewer.rest("/2/guide/set_explore_settings.json", { places: ["ZZ"] })).places[0].place_id === "1");
} finally {
	await restoreTrends();
	for (const [s, id] of made) await s.gql("DeleteTweet", { tweet_id: id });
	for (const name of [viewerName, aName, bName]) {
		const r = was[name];
		await sql`update users set country = ${r.country}, preferences = case when ${r.explore === null} then preferences - 'explore' else jsonb_set(preferences, '{explore}', ${JSON.stringify(r.explore)}::text::jsonb) end where screen_name = ${name}`;
	}
}

console.log(failures ? `${failures} failed` : "all checks passed");
await sql.close();
process.exit(failures ? 1 : 0);
