// End-to-end check of search against a running server: the query operators,
// the tabs, typeahead, hashtag links and Explore trends. Removes its posts.
// usage: bun scripts/test-search.ts <user A> <user B> <password of both> <image>

import { readFileSync } from "node:fs";
import { loosenTrends } from "./loose-trends";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password, imagePath] = process.argv.slice(2);
if (!nameA || !nameB || !password || !imagePath) throw new Error("usage: bun scripts/test-search.ts <user A> <user B> <password> <image>");

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
	const rest = async (path: string) => (await fetch(`${origin}/i/api/${path}`, { headers })).json();
	async function upload(path: string) {
		const data = readFileSync(path);
		const init = await (await fetch(`${origin}/i/media/upload.json?command=INIT&total_bytes=${data.length}&media_type=image/png&media_category=tweet_image`, { method: "POST", headers })).json();
		const form = new FormData();
		form.set("media", new Blob([data]));
		await fetch(`${origin}/i/media/upload.json?command=APPEND&media_id=${init.media_id_string}&segment_index=0`, { method: "POST", headers, body: form });
		await fetch(`${origin}/i/media/upload.json?command=FINALIZE&media_id=${init.media_id_string}`, { method: "POST", headers });
		return init.media_id_string as string;
	}
	return { gql, get, rest, upload };
}

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const a = await session(nameA);
const b = await session(nameB);
const userB = (await a.get("UserByScreenName", { screen_name: nameB })).data.user.result;
// a word no other post contains, so results are only this run's posts
const w = `zq${Date.now().toString(36)}`;
const created: [typeof a, string][] = [];
const post = async (s: typeof a, text: string, extra: object = {}) => {
	const r = (await s.gql("CreateTweet", { tweet_text: text, ...extra })).data.create_tweet.tweet_results.result;
	created.push([s, r.rest_id]);
	return r;
};

const p1 = await post(a, `${w} first post about the quick brown fox #${w}tag`);
const p2 = await post(b, `${w} second one, quick but not brown, hi @${nameA}`);
const p3 = await post(b, `${w} третий пост Кириллица #${w}tagx`, { media: { media_entities: [{ media_id: await b.upload(imagePath), tagged_users: [] }] } });
await b.gql("FavoriteTweet", { tweet_id: p1.rest_id });

const results = async (q: string, product = "Latest") =>
	(await a.get("SearchTimeline", { rawQuery: q, product, count: 20, querySource: "typed_query" })).data.search_by_raw_query.search_timeline.timeline.instructions
		.flatMap((i: any) => i.entries ?? i.moduleItems ?? [])
		.flatMap((e: any) => (e.content?.items ? e.content.items : [e]))
		.map((e: any) => e.content?.itemContent ?? e.item?.itemContent ?? e.itemContent)
		.filter(Boolean);
const ids = async (q: string, product = "Latest") => (await results(q, product)).map((c: any) => c.tweet_results?.result?.rest_id).filter(Boolean);
const same = (got: string[], want: any[]) => got.length === want.length && want.every((p) => got.includes(p.rest_id));

check("a word finds every post with it, newest first", JSON.stringify(await ids(w)) === JSON.stringify([p3.rest_id, p2.rest_id, p1.rest_id]), await ids(w));
check("two words must both appear", same(await ids(`${w} brown`), [p1, p2]));
check('"exact phrase"', same(await ids(`${w} "quick brown"`), [p1]));
check("-word excludes", same(await ids(`${w} -brown`), [p3]));
check("OR", same(await ids(`${w} fox OR третий`), [p1, p3]));
check("from:", same(await ids(`${w} from:${nameB}`), [p2, p3]));
check("@mention", same(await ids(`${w} @${nameA}`), [p2]));
check("#tag matches the whole tag only", same(await ids(`#${w}tag`), [p1]));
check("filter:media", same(await ids(`${w} filter:media`), [p3]));
check("Cyrillic is case-insensitive", same(await ids(`${w} кириллица`), [p3]));
check("min_faves:", same(await ids(`${w} min_faves:1`), [p1]));
check("until: in the past finds nothing", (await ids(`${w} until:2020-01-01`)).length === 0);
check("unknown operators are ignored, not searched for", same(await ids(`${w} near:me lang:en fox`), [p1]));
// A's own posts never count as "people you follow"; B's do only if A follows B
const followsB = userB.relationship_perspectives?.following === true;
check("filter:follows (People you follow) keeps only followed accounts", same(await ids(`${w} filter:follows`), followsB ? [p2, p3] : []), { followsB });
check("Top puts the liked post first", (await ids(w, "Top"))[0] === p1.rest_id, await ids(w, "Top"));
check("Media tab shows a grid of media posts", same(await ids(w, "Media"), [p3]));
const people = (await results(userB.core.name, "People")).map((c: any) => c.user_results?.result?.rest_id);
check("People finds accounts by name", people.includes(userB.rest_id), people);
const top = await results(nameB, "Top");
check("Top starts with matching accounts", top.some((c: any) => c.user_results?.result?.rest_id === userB.rest_id));

const ta = await a.rest(`1.1/search/typeahead.json?q=${encodeURIComponent(nameB.slice(0, 3))}&src=search_box&result_type=events,users,topics,lists`);
check("typeahead suggests the account", ta.users?.some((u: any) => u.id_str === userB.rest_id), ta.users?.map((u: any) => u.screen_name));
const tags = await a.rest(`1.1/search/typeahead.json?q=${encodeURIComponent(`#${w}`)}&src=search_box`);
check("typeahead suggests hashtags", tags.topics?.map((t: any) => t.topic).sort().join(" ") === `#${w}tag #${w}tagx`, tags.topics);

check("the hashtag is an entity in the post", p1.legacy.entities.hashtags?.[0]?.text === `${w}tag`, p1.legacy.entities.hashtags);
const ru = await post(a, "тест #привет");
check("Cyrillic hashtags too", ru.legacy.entities.hashtags?.[0]?.text === "привет" && ru.legacy.entities.hashtags[0].indices.join() === "5,12", ru.legacy.entities.hashtags);
const restoreTrends = await loosenTrends(origin);
const explore = (await a.get("ExplorePage", {})).data.explore_page.body.timeline.instructions[0].entries.map((e: any) => e.content.itemContent.name);
await restoreTrends();
check("Explore lists the hashtags in use", explore.includes(`#${w}tag`) && explore.includes("#привет"), explore.slice(0, 8));

await b.gql("UnfavoriteTweet", { tweet_id: p1.rest_id });
for (const [s, id] of created.reverse()) await s.gql("DeleteTweet", { tweet_id: id });

console.log(failures ? `${failures} check(s) failed` : "all checks passed");
process.exit(failures ? 1 : 0);
