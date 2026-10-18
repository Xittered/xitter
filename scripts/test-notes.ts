import { createUser } from "../src/auth";
import { sql } from "../src/db";

const origin = "http://localhost:3000";
let count = 0;
function check(ok: unknown, label: string) { if (!ok) throw new Error(label); count++; }
async function session(username: string, password = "testpass123") {
	const r = await fetch(origin + "/login", { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map(c => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find(c => c.startsWith("ct0="))!.slice(4), "content-type": "application/json" };
	return {
		headers,
		gql: async (op: string, variables: any, token?: string) => (await fetch(origin + "/i/api/graphql/q/" + op, { method: "POST", headers: { ...headers, ...(token ? { authorization: "Bearer " + token } : {}) }, body: JSON.stringify({ variables }) })).json() as Promise<any>,
		admin: async (action: string, body: any = {}) => { const r = await fetch(origin + "/admin/api/" + action, { method: "POST", headers, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() as any }; },
	};
}
const ids: string[] = [];
const a = await session("pozo"), b = await session("goldcorp");
let platform: any, postId: string | undefined;
const [author] = await sql`select id::text, notes_writer from users where screen_name = 'pozo'`;
try {
	platform = (await a.admin("createPlatform", { label: "Xitter for UFO" })).body;
	check(platform.token?.startsWith("xitter_"), "token issued");
	check(!(JSON.stringify((await a.admin("platforms")).body).includes(platform.token)), "token not listed");
	check((await b.admin("createPlatform", { label: "Xitter for Evil" })).status === 403, "admin only");
	const created = await a.gql("CreateTweet", { tweet_text: "Community Notes integration check", source: "spoofed" }, platform.token);
	postId = created.data.create_tweet.tweet_results.result.rest_id;
	check(created.data.create_tweet.tweet_results.result.legacy.source === "Xitter for UFO", "registered token labels post");
	const context = () => b.gql("XitterPostContext", { ids: [postId] });
	check((await context()).data.xitter_post_context[0].source === "Xitter for UFO", "source stored across viewers");
	await b.gql("BirdwatchCreateBatSignal", { tweet_id: postId, source_link: "https://example.org", suggestion: "Please add context" });
	const [request] = await sql`select source_link, suggestion from community_note_requests where post_id = ${postId}::bigint`;
	check(request.source_link === "https://example.org" && request.suggestion === "Please add context", "request details saved");
	await b.gql("BirdwatchCreateBatSignal", { tweet_id: postId });
	check((await context()).data.xitter_post_context[0].requests === 1, "requests deduplicated");
	await b.gql("BirdwatchDeleteBatSignal", { tweet_id: postId });
	check((await context()).data.xitter_post_context[0].requests === 0, "withdraw request");
	// with "Anyone can write Community Notes" off, writing needs the admin's grant
	const features = (await a.admin("settings")).body.settings.features;
	await a.admin("saveSettings", { features: { ...features, notes_everyone: false } });
	check((await b.gql("BirdwatchFetchAuthenticatedUserProfile", {})).data.authenticated_user_birdwatch_profile.can_write_notes === false, "closed: profile says no writing");
	check(!!(await b.gql("BirdwatchCreateNote", { tweet_id: postId, data_v1: { summary: "unauthorized" } })).errors, "nonmember cannot write notes");
	await a.admin("saveSettings", { features: { ...features, notes_everyone: true } });
	check((await b.gql("BirdwatchFetchAuthenticatedUserProfile", {})).data.authenticated_user_birdwatch_profile.can_write_notes === true, "open: anyone may write");
	await a.admin("saveSettings", { features });
	check((await b.admin("setNotesAccess", { id: author.id, enabled: true })).status === 403, "only admin grants membership");
	check((await a.admin("setNotesAccess", { id: author.id, enabled: true })).status === 200, "grant writing membership");
	check(!!(await a.gql("BirdwatchCreateNote", { tweet_id: postId, data_v1: { summary: "" } })).errors, "empty note rejected");
	const result = await a.gql("BirdwatchCreateNote", { tweet_id: postId, data_v1: { summary: "Context from https://example.org <script>never executes</script>", classification: "Misleading" } });
	const noteId = result.data.birdwatchnote_create_v2.rest_id;
	check(!!noteId, "note created");
	check(!result.data.birdwatchnote_create_v2.note.alias.includes(author.id), "alias independent of account id");
	check(typeof result.data.birdwatchnote_create_v2.note.created_at === "number", "native timestamp type");
	check(!!(await a.gql("BirdwatchCreateNote", { tweet_id: postId, data_v1: { summary: "duplicate" } })).errors, "one note per contributor per post");
	check(!!(await a.gql("BirdwatchCreateRating", { note_id: noteId, data_v2: { helpfulness_level: "Helpful" } })).errors, "self rating rejected");
	check(!!(await b.gql("BirdwatchDeleteNote", { note_id: noteId })).errors, "another user cannot delete");
	check(!!(await b.gql("BirdwatchCreateRating", { note_id: noteId, data_v2: { helpfulness_level: "Bogus" } })).errors, "invalid rating rejected");
	const voters = [b];
	for(let i = 0; i < 2; i++) { const name = "nt" + Date.now().toString().slice(-9) + i; ids.push(await createUser(name, name, "testpass123")); voters.push(await session(name)); }
	for(const voter of voters) await voter.gql("BirdwatchCreateRating", { note_id: noteId, data_v2: { helpfulness_level: "Helpful" } });
	let note = (await context()).data.xitter_post_context[0].notes[0];
	check(note.status === "Helpful" && note.ratings === 3, "threshold publishes helpful note");
	const nativeNote = (await b.gql("BirdwatchFetchOneNote", { note_id: noteId })).data.birdwatch_note_by_rest_id;
	check(nativeNote.rating_status === "CurrentlyRatedHelpful", "native status enum");
	check(nativeNote.rating.data_v2.helpfulness_level === "Helpful", "native rating shape");
	check(nativeNote.tweet_results.result.rest_id === postId, "native parent post included");
	check(nativeNote.tweet_results.result.birdwatch_pivot.note.rest_id === noteId, "native context pivot");
	check(nativeNote.data_v1.summary.entities[0].ref.urlType === "ExternalUrl", "native source link entity");
	await sql`update users set status = 'suspended' where id = ${ids[0]}::bigint`;
	check((await context()).data.xitter_post_context[0].notes[0].status === "NeedsMoreRatings", "suspended votes excluded");
	await sql`update users set status = 'active' where id = ${ids[0]}::bigint`;
	await b.gql("BirdwatchCreateRating", { note_id: noteId, data_v2: { helpfulness_level: "NotHelpful" } });
	note = (await context()).data.xitter_post_context[0].notes[0];
	check(note.status === "Helpful" && note.ratings === 3, "changing rating does not add vote");
	await voters[1].gql("BirdwatchCreateRating", { note_id: noteId, data_v2: { helpfulness_level: "NotHelpful" } });
	check((await context()).data.xitter_post_context[0].notes[0].status === "NotHelpful", "status recalculated");
	await b.gql("BirdwatchDeleteRating", { note_id: noteId });
	check((await context()).data.xitter_post_context[0].notes[0].status === "NeedsMoreRatings", "removing rating hides context");
	check((await b.gql("BirdwatchFetchOneNote", { note_id: noteId })).data.birdwatch_note_by_rest_id.rest_id === noteId, "emusks note lookup");
	await b.gql("BirdwatchCreateRating", { note_id: noteId, data_v2: { helpfulness_level: "Helpful" } });
	await b.gql("BirdwatchCreateBatSignal", { tweet_id: postId });
	const authorId = (await a.gql("UserByScreenName", { screen_name: "pozo" })).data.user.result.rest_id;
	await sql`insert into blocks(blocker_id, blocked_id) values(${ids[0]}::bigint, ${authorId}::bigint)`;
	try {
		check((await voters[1].gql("XitterPostContext", { ids: [postId] })).data.xitter_post_context.length === 0, "blocked post context hidden");
		check(!!(await voters[1].gql("BirdwatchCreateRating", { note_id: noteId, data_v2: { helpfulness_level: "Helpful" } })).errors, "blocked users cannot rate");
	} finally { await sql`delete from blocks where blocker_id = ${ids[0]}::bigint and blocked_id = ${authorId}::bigint`; }
	const get = await fetch(origin + "/i/api/graphql/q/BirdwatchCreateBatSignal?variables=" + encodeURIComponent(JSON.stringify({ tweet_id: postId })), { headers: b.headers });
	check(get.status === 405, "GET cannot mutate notes");
	await a.admin("revokePlatform", { id: platform.id });
	check(!!(await a.gql("CreateTweet", { tweet_text: "revoked" }, platform.token)).errors, "revoked token rejected");
	check((await context()).data.xitter_post_context[0].source === "Xitter for UFO", "revocation preserves historic source");
	await a.gql("BirdwatchDeleteNote", { note_id: noteId });
	check((await context()).data.xitter_post_context[0].notes.length === 0, "author delete");
	await a.admin("setNotesAccess", { id: ids[0], enabled: true });
	const other = (await voters[1].gql("BirdwatchCreateNote", { tweet_id: postId, data_v1: { summary: "For staff review" } })).data.birdwatchnote_create_v2.rest_id;
	await a.gql("BirdwatchDeleteNote", { note_id: other });
	const [audit] = await sql`select 1 from audit_log where target = ${other} and action = 'delete_community_note'`;
	check(!!audit, "staff removal audited");
	console.log(`all ${count} notes/platform checks passed`);
} finally {
	await sql`update users set notes_writer = ${author.notes_writer} where id = ${author.id}::bigint`;
	if (postId) await a.gql("DeleteTweet", { tweet_id: postId });
	if (platform?.id) await sql`delete from client_platforms where id = ${platform.id}::bigint`;
	for(const id of ids) await sql`delete from users where id = ${id}::bigint`;
	await sql.close();
}
