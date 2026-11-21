// usage: bun scripts/test-federation.ts

import { SQL } from "bun";
import { newId } from "../src/ids";
import { codeAt, newSecret } from "../src/totp";

const A = { origin: process.env.FED_A ?? "http://localhost:3041", db: new SQL(process.env.FED_A_DB ?? "postgres://tiago@127.0.0.1:5432/fed_a") };
const B = { origin: process.env.FED_B ?? "http://localhost:3042", db: new SQL(process.env.FED_B_DB ?? "postgres://tiago@127.0.0.1:5432/fed_b") };
const idOf = (origin: string) => new URL(origin).host;
const stamp = Date.now().toString(36).slice(-6);
let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}
async function until<T>(get: () => Promise<T>, seconds = 40): Promise<T | undefined> {
	for (let i = 0; i < seconds * 2; i++) {
		const v = await get().catch(() => undefined);
		if (v) return v;
		await Bun.sleep(500);
	}
	return undefined;
}

async function account(side: typeof A, name: string) {
	const id = newId();
	await side.db`insert into users (id, screen_name, name, password_hash) values (${id}::bigint, ${name}, ${name}, ${await Bun.password.hash("testpass123")})`;
	const r = await fetch(`${side.origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password: "testpass123" }), redirect: "manual" });
	const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
	const headers = { cookie: cookies.join("; "), "x-csrf-token": cookies.find((c) => c.startsWith("ct0="))?.slice(4) ?? "" };
	return {
		id,
		name,
		cookies: headers.cookie,
		gql: async (op: string, variables: object) =>
			(await fetch(`${side.origin}/i/api/graphql/q/${op}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ variables }) })).json(),
		get: async (op: string, variables: object) =>
			(await fetch(`${side.origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json(),
		form: (path: string, body: Record<string, string>) => fetch(`${side.origin}/i/api${path}`, { method: "POST", headers, body: new URLSearchParams(body) }),
		raw: (path: string) => fetch(`${side.origin}${path}`, { headers }),
		// a page form, like Settings > Other instances
		page: (path: string, body: Record<string, string>) =>
			fetch(`${side.origin}${path}`, { method: "POST", headers: { cookie: headers.cookie }, body: new URLSearchParams({ csrf: headers["x-csrf-token"], ...body }), redirect: "manual" }),
	};
}

const made: { side: typeof A; id: string }[] = [];
try {
	const alice = await account(A, `fa${stamp}`);
	const bob = await account(B, `fb${stamp}`);
	made.push({ side: A, id: alice.id }, { side: B, id: bob.id });

	const posted = await alice.gql("CreateTweet", { tweet_text: `hello from a ${stamp}` });
	const postId = posted.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	check("alice posts on A", !!postId);

	const aliceOnB = await until(async () => (await B.db`select id::text from users where instance = ${idOf(A.origin)} and remote_id = ${alice.id}::bigint`)[0]?.id as string);
	check("B keeps a copy of alice", !!aliceOnB);
	const [handle] = aliceOnB ? await B.db`select screen_name from users where id = ${aliceOnB}::bigint` : [];
	check("named with her instance", handle?.screen_name === `${alice.name}@${idOf(A.origin)}`, handle?.screen_name);
	const preview = await fetch(`${B.origin}/${alice.name}@${idOf(A.origin)}`, { redirect: "manual" });
	check("B previews her for link fetchers by her full handle", preview.status === 200 && (await preview.text()).includes("og:title"), preview.status);
	const mirror = await until(async () => (await B.db`select local_id::text from federated_objects where instance = ${idOf(A.origin)} and kind = 'post' and remote_id = ${postId}::bigint`)[0]?.local_id as string);
	check("and her post", !!mirror);
	const syncStatus = await until(async () => {
		const doc = (await (await fetch(`${B.origin}/.well-known/xitter`)).json()) as any;
		return doc.federation?.peers?.find((p: any) => p.id === idOf(A.origin) && p.federating && p.last_sync_at);
	}, 60);
	check("B's public status shows when it last synced with A", !!syncStatus, syncStatus);

	const found = await bob.get("UserByScreenName", { screen_name: `${alice.name}@${idOf(A.origin)}`, withSafetyModeUserFields: true });
	check("bob finds alice by her handle", found.data?.user?.result?.rest_id === aliceOnB, found.data?.user?.result?.rest_id);

	await bob.form("/1.1/friendships/create.json", { user_id: aliceOnB ?? "" });
	const bobOnA = await until(async () => (await A.db`select id::text from users where instance = ${idOf(B.origin)} and remote_id = ${bob.id}::bigint`)[0]?.id as string);
	check("A learns about bob", !!bobOnA);
	check(
		"A sees bob follow alice",
		!!(await until(async () => (await A.db`select 1 from follows where follower_id = ${bobOnA ?? "0"}::bigint and followee_id = ${alice.id}::bigint`).length > 0)),
	);

	await bob.gql("FavoriteTweet", { tweet_id: mirror });
	check("A sees bob's like", !!(await until(async () => (await A.db`select 1 from likes where user_id = ${bobOnA ?? "0"}::bigint and post_id = ${postId}::bigint`).length > 0)));

	await A.db`update posts set count_overrides = '{"likes": 4242}'::jsonb where id = ${postId}::bigint`;
	const shown = await until(async () => (await B.db`select remote_counts from posts where id = ${mirror ?? "0"}::bigint and (remote_counts->>'likes')::int = 4242`)[0]);
	check("counts set at home show on the copy", !!shown);
	await A.db`update users set count_overrides = '{"followers": 777}'::jsonb where id = ${alice.id}::bigint`;
	check("and so do an account's", !!(await until(async () => (await B.db`select 1 from users where id = ${aliceOnB ?? "0"}::bigint and (remote_counts->>'followers')::int = 777`).length > 0)));

	const reply = await bob.gql("CreateTweet", { tweet_text: `hi alice ${stamp}`, reply: { in_reply_to_tweet_id: mirror } });
	const replyId = reply.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	check("bob replies on B", !!replyId, reply.errors);
	const replyOnA = await until(async () => (await A.db`select local_id::text from federated_objects where instance = ${idOf(B.origin)} and kind = 'post' and remote_id = ${replyId}::bigint`)[0]?.local_id as string);
	const [threaded] = replyOnA ? await A.db`select reply_to_id::text, reply_to_user_id::text from posts where id = ${replyOnA}::bigint` : [];
	check("A threads bob's reply under alice's post", threaded?.reply_to_id === postId && threaded?.reply_to_user_id === alice.id, threaded);

	const linking = await bob.gql("CreateTweet", { tweet_text: `look ${A.origin}/${alice.name}/status/${postId} and ${A.origin}/${alice.name}` });
	const linkingId = linking.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	const shownLink = (await bob.get("TweetResultByRestId", { tweetId: linkingId ?? "0" })).data?.tweetResult?.result;
	check("a link to a post on another instance shows its copy here as a quote", shownLink?.quoted_status_result?.result?.rest_id === mirror, shownLink?.quoted_status_result?.result?.rest_id);
	const linkTargets = (shownLink?.legacy?.entities?.urls ?? []).map((u: any) => u.expanded_url);
	check("and its links open the copies here", linkTargets.includes(`${B.origin}/${alice.name}@${idOf(A.origin)}/status/${mirror}`) && linkTargets.includes(`${B.origin}/${alice.name}@${idOf(A.origin)}`), linkTargets);

	const mentionA = await alice.gql("CreateTweet", { tweet_text: `hey @${bob.name}@${idOf(B.origin)}, I'm @${alice.name} ${stamp}` });
	const mentionId = mentionA.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	const mentionsHere = await A.db`select user_id::text from post_mentions where post_id = ${mentionId ?? "0"}::bigint order by user_id`;
	check("a mention by full handle points at the copy, not a local namesake", mentionsHere.some((m: any) => m.user_id === bobOnA), mentionsHere);
	const entities = mentionA.data?.create_tweet?.tweet_results?.result?.legacy?.entities?.user_mentions ?? [];
	const fullEntity = entities.find((m: any) => m.id_str === bobOnA);
	check("and its entity covers the whole handle", fullEntity?.screen_name === `${bob.name}@${idOf(B.origin)}` && fullEntity.indices[1] - fullEntity.indices[0] === `@${bob.name}@${idOf(B.origin)}`.length, entities);
	const mentionOnB = await until(async () => (await B.db`select local_id::text from federated_objects where instance = ${idOf(A.origin)} and kind = 'post' and remote_id = ${mentionId ?? "0"}::bigint`)[0]?.local_id as string);
	const mentionsOf = async () => (mentionOnB ? (await B.db`select user_id::text from post_mentions where post_id = ${mentionOnB}::bigint`).map((m: any) => m.user_id as string) : []);
	const mentionsThere = (await until(async () => {
		const m = await mentionsOf();
		return m.includes(bob.id) && m.includes(aliceOnB) ? m : undefined;
	}, 10)) ?? (await mentionsOf());
	check("on B it mentions bob himself and alice's copy", mentionsThere.includes(bob.id) && mentionsThere.includes(aliceOnB), mentionsThere);
	const copyShown = (await bob.get("TweetResultByRestId", { tweetId: mentionOnB ?? "0" })).data?.tweetResult?.result;
	const copyText = copyShown?.legacy?.full_text ?? "";
	const spans = (copyShown?.legacy?.entities?.user_mentions ?? []).map((m: any) => ({ id: m.id_str, text: [...copyText].slice(m.indices[0], m.indices[1]).join("") }));
	check("on B the whole @bob@host in the copy links to bob", spans.some((m: any) => m.id === bob.id && m.text === `@${bob.name}@${idOf(B.origin)}`), spans);
	check("and a bare @alice links to alice's copy, not a namesake on B", spans.some((m: any) => m.id === aliceOnB && m.text === `@${alice.name}`), spans);
	const quoter = await bob.gql("CreateTweet", { tweet_text: `quoting the mention ${stamp}`, attachment_url: `${B.origin}/${alice.name}@${idOf(A.origin)}/status/${mentionOnB}` });
	const inQuote = quoter.data?.create_tweet?.tweet_results?.result?.quoted_status_result?.result;
	const quoteText = inQuote?.legacy?.full_text ?? "";
	const quoteSpans = (inQuote?.legacy?.entities?.user_mentions ?? []).map((m: any) => ({ id: m.id_str, text: [...quoteText].slice(m.indices[0], m.indices[1]).join("") }));
	check("and so do the mentions inside a quote of it", quoteSpans.some((m: any) => m.id === bob.id && m.text === `@${bob.name}@${idOf(B.origin)}`) && quoteSpans.some((m: any) => m.id === aliceOnB), quoteSpans);
	const bobNotified = await until(async () => {
		const n = await bob.get("NotificationsTimeline", { timeline_type: "Mentions", count: 20 });
		return JSON.stringify(n).includes(mentionOnB ?? "none");
	}, 10);
	check("and bob gets the mention", !!bobNotified);

	await A.db`update users set bio = ${`me: @${alice.name}, pal: @${bob.name}@${idOf(B.origin)}, see https://example.org/@${bob.name}`}, website = 'https://example.org' where id = ${alice.id}::bigint`;
	const bioOnB = await until(async () => {
		const r = await bob.get("UserByScreenName", { screen_name: `${alice.name}@${idOf(A.origin)}`, withSafetyModeUserFields: true });
		const result = r.data?.user?.result;
		return result?.profile_bio?.description?.startsWith("me:") ? result.profile_bio : undefined;
	});
	const bioMentions = bioOnB?.entities?.description?.user_mentions?.map((m: any) => m.screen_name) ?? [];
	check("a bare @name in a copied bio points at its home account", bioMentions.includes(`${alice.name}@${idOf(A.origin)}`), bioMentions);
	check("and @name@<this instance> points at the local account", bioMentions.includes(bob.name), bioMentions);
	check("and @names inside links are left alone", bioMentions.length === 2, bioMentions);
	const badgeId = newId();
	await A.db`insert into custom_badges (id, name, image, mime) values (${badgeId}::bigint, ${`fed badge ${stamp}`}, ${Buffer.from("png")}, 'image/png')`;
	await A.db`insert into user_badges (user_id, badge_id, position) values (${alice.id}::bigint, ${badgeId}::bigint, 0)`;
	await A.db`update users set verified_type = 'blue' where id = ${alice.id}::bigint`;
	const looks = await until(async () => (await B.db`select verified_type, remote_badges from users where id = ${aliceOnB ?? "0"}::bigint and verified_type is not null and remote_badges <> '[]'::jsonb`)[0]);
	check("her checkmark and custom badges travel", looks?.verified_type === "blue" && looks.remote_badges?.[0]?.url === `${A.origin}/public/badge-${badgeId}.png`, looks);
	await A.db`delete from custom_badges where id = ${badgeId}::bigint`;
	check("the website travels too", (await B.db`select website from users where id = ${aliceOnB ?? "0"}::bigint`)[0]?.website === "https://example.org");
	const ownHost = await bob.get("UserByScreenName", { screen_name: `${bob.name}@${idOf(B.origin)}`, withSafetyModeUserFields: true });
	check("a handle naming this instance finds the local account", ownHost.data?.user?.result?.rest_id === bob.id, ownHost.data?.user?.result?.rest_id);

	await A.db`update posts set text = text || ' (edited)', edited_at = now() where id = ${mentionId ?? "0"}::bigint`;
	const versions = await until(async () => (await B.db`select count(*)::int as n from post_versions where post_id = ${mentionOnB ?? "0"}::bigint`)[0]?.n);
	const [edited] = await B.db`select edit_count, text from posts where id = ${mentionOnB ?? "0"}::bigint`;
	check("an edit at home keeps the old text in the copy's history", versions === 1 && edited?.edit_count === 1 && edited.text.endsWith("(edited)"), { versions, edited });

	const limited = await alice.gql("CreateTweet", { tweet_text: `only people I mention ${stamp}` });
	const limitedId = limited.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	await A.db`update posts set reply_policy = 'ByInvitation' where id = ${limitedId ?? "0"}::bigint`;
	const limitedOnB = await until(async () => (await B.db`select local_id::text from federated_objects where instance = ${idOf(A.origin)} and kind = 'post' and remote_id = ${limitedId ?? "0"}::bigint`)[0]?.local_id as string);
	await bob.gql("CreateTweet", { tweet_text: `sneaking in ${stamp}`, reply: { in_reply_to_tweet_id: limitedOnB } });
	const marker = await bob.gql("CreateTweet", { tweet_text: `marker ${stamp}` });
	const markerId = marker.data?.create_tweet?.tweet_results?.result?.rest_id as string;
	await until(async () => (await A.db`select 1 from federated_objects where instance = ${idOf(B.origin)} and kind = 'post' and remote_id = ${markerId ?? "0"}::bigint`).length > 0);
	check("a reply the home's reply limit forbids is dropped there", !(await A.db`select 1 from posts where reply_to_id = ${limitedId ?? "0"}::bigint`).length);

	const mediaId = newId();
	const picture = Buffer.from(`GIF89a-${stamp}`);
	const picturePost = newId();
	await Bun.write(`${process.env.FED_A_MEDIA}/${mediaId}`, picture);
	await A.db.begin(async (tx) => {
		await tx`insert into posts (id, user_id, text, conversation_id) values (${picturePost}::bigint, ${alice.id}::bigint, 'a picture', ${picturePost}::bigint)`;
		await tx`insert into media (id, user_id, kind, mime, size, width, height, post_id, position) values (${mediaId}::bigint, ${alice.id}::bigint, 'photo', 'image/gif', ${picture.length}, 1, 1, ${picturePost}::bigint, 0)`;
		await tx`update posts set text = 'a picture!' where id = ${picturePost}::bigint`;
	});
	const pictureOnB = await until(async () => (await B.db`select m.id::text from media m join federated_objects f on f.kind = 'post' and f.local_id = m.post_id where f.remote_id = ${picturePost}::bigint`)[0]?.id as string);
	check("B lists the picture", !!pictureOnB);
	const served = pictureOnB ? await bob.raw(`/media/${pictureOnB}.gif`) : undefined;
	check("and serves it from its own address", served?.status === 200 && Buffer.from(await served.arrayBuffer()).equals(picture), served?.status);

	await alice.gql("DeleteTweet", { tweet_id: postId });
	check("a deleted post goes from B", !!(await until(async () => !(await B.db`select 1 from posts where id = ${mirror ?? "0"}::bigint`).length)));

	const parent = (await alice.gql("CreateTweet", { tweet_text: `parent ${stamp}` })).data?.create_tweet?.tweet_results?.result?.rest_id as string;
	const orphan = (await alice.gql("CreateTweet", { tweet_text: `orphan ${stamp}`, reply: { in_reply_to_tweet_id: parent } })).data?.create_tweet?.tweet_results?.result?.rest_id as string;
	await alice.gql("DeleteTweet", { tweet_id: parent });
	const orphanOnB = await until(async () => (await B.db`select p.reply_to_id::text from posts p join federated_objects f on f.kind = 'post' and f.local_id = p.id where f.instance = ${idOf(A.origin)} and f.remote_id = ${orphan ?? "0"}::bigint`)[0]);
	check("a reply whose parent was deleted stays a reply on B", !!orphanOnB?.reply_to_id, orphanOnB);

	const hidden = (await alice.gql("CreateTweet", { tweet_text: `not for peers ${stamp}` })).data?.create_tweet?.tweet_results?.result?.rest_id as string;
	await A.db`update posts set hidden = true where id = ${hidden ?? "0"}::bigint`;
	const quoting = (await alice.gql("CreateTweet", { tweet_text: `quoting ${stamp}`, attachment_url: `${A.origin}/${alice.name}/status/${hidden}` })).data?.create_tweet?.tweet_results?.result?.rest_id as string;
	const quoteOnB = await until(async () => (await B.db`select p.text, p.quote_id::text from posts p join federated_objects f on f.kind = 'post' and f.local_id = p.id where f.instance = ${idOf(A.origin)} and f.remote_id = ${quoting ?? "0"}::bigint`)[0]);
	check("a quote of a post that can't federate links to it on B", !quoteOnB?.quote_id && quoteOnB?.text?.includes(`${A.origin}/${alice.name}/status/${hidden}`), quoteOnB);

	const closedPost = (await alice.gql("CreateTweet", { tweet_text: `soon protected ${stamp}` })).data?.create_tweet?.tweet_results?.result?.rest_id as string;
	const closedOnB = await until(async () => (await B.db`select local_id::text from federated_objects where instance = ${idOf(A.origin)} and kind = 'post' and remote_id = ${closedPost ?? "0"}::bigint`)[0]?.local_id as string);
	const quiet = (on: boolean) => A.db.begin(async (tx) => {
		await tx`set local session_replication_role = replica`;
		await tx`update users set protected = ${on} where id = ${alice.id}::bigint`;
	});
	await quiet(true);
	const erin = await account(A, `fe${stamp}`);
	const dave = await account(B, `fd${stamp}`);
	made.push({ side: A, id: erin.id }, { side: B, id: dave.id });
	const refused = await erin.gql("CreateTweet", { tweet_text: `let me in ${stamp}`, reply: { in_reply_to_tweet_id: closedPost } });
	check("someone who doesn't follow a protected account can't reply to it", !refused.data?.create_tweet?.tweet_results?.result?.rest_id && !!refused.errors, refused.errors);
	if (closedOnB) await B.db`insert into posts (id, user_id, text, reply_to_id, conversation_id) values (${newId()}::bigint, ${dave.id}::bigint, ${`sneaky ${stamp}`}, ${closedOnB}::bigint, ${closedOnB}::bigint)`;
	const daveOnA = await until(async () => (await A.db`select id::text from users where instance = ${idOf(B.origin)} and remote_id = ${dave.id}::bigint`)[0]?.id as string);
	await Bun.sleep(3000);
	check("nor can someone from another instance", !!closedOnB && !!daveOnA && !(await A.db`select 1 from posts where reply_to_id = ${closedPost ?? "0"}::bigint and user_id = ${daveOnA}::bigint`).length, { closedOnB, daveOnA });
	await quiet(false);

	await A.db`update users set protected = true where id = ${alice.id}::bigint`;
	check("a protected account's posts go from B", !!(await until(async () => !(await B.db`select 1 from posts where user_id = ${aliceOnB ?? "0"}::bigint`).length)));

	const carol = await account(A, `fc${stamp}`);
	made.push({ side: A, id: carol.id });
	const carolOnB = await until(async () => (await B.db`select id::text from users where screen_name = ${`${carol.name}@${idOf(A.origin)}`}`)[0]?.id as string | undefined);
	await A.db`update users set status = 'suspended' where id = ${carol.id}::bigint`;
	check("a suspended account goes from B", !!carolOnB && !!(await until(async () => !(await B.db`select 1 from users where id = ${carolOnB ?? "0"}::bigint`).length)));
	await A.db`update users set status = 'active' where id = ${carol.id}::bigint`;
	const carolBack = await until(async () => (await B.db`select id::text from users where screen_name = ${`${carol.name}@${idOf(A.origin)}`}`)[0]?.id as string | undefined);
	check("and comes back when it's lifted", !!carolBack, carolBack);
	await A.db`delete from users where id = ${carol.id}::bigint`;
	check("a deleted account goes from B", !!(await until(async () => !(await B.db`select 1 from users where screen_name = ${`${carol.name}@${idOf(A.origin)}`}`).length)));

	const forged = await fetch(`${A.origin}/federation/v1/events?after=0`, {
		headers: { "x-xitter-from": idOf(B.origin), "x-xitter-to": idOf(A.origin), "x-xitter-timestamp": String(Date.now()), "x-xitter-nonce": "AAAAAAAAAAAAAAAAAAAAAA", "x-xitter-signature": "x".repeat(86) },
	});
	check("an unsigned request is refused", forged.status === 401, forged.status);
	const stranger = await fetch(`${A.origin}/federation/v1/events?after=0`, {
		headers: { "x-xitter-from": "evil.example", "x-xitter-to": idOf(A.origin), "x-xitter-timestamp": String(Date.now()), "x-xitter-nonce": "AAAAAAAAAAAAAAAAAAAAAA", "x-xitter-signature": "x".repeat(86) },
	});
	check("an instance off the list is refused", stranger.status === 403, stranger.status);
	const login = await fetch(`${A.origin}/login`, { method: "POST", body: new URLSearchParams({ username: `${bob.name}@${idOf(B.origin)}`, password: "!" }), redirect: "manual" });
	check("nobody signs in as a copied account", !login.headers.getSetCookie().some((c) => c.startsWith("auth_token=")));

	const admin = await account(A, `fadm${stamp}`);
	made.push({ side: A, id: admin.id });
	await A.db`update users set role = 'admin' where id = ${admin.id}::bigint`;
	const adminApi = async (side: typeof A, cookies: string, action: string, body: object) => {
		const csrf = /ct0=([^;]+)/.exec(cookies)?.[1] ?? "";
		const r = await fetch(`${side.origin}/admin/api/${action}`, { method: "POST", headers: { cookie: cookies, "x-csrf-token": csrf, "content-type": "application/json" }, body: JSON.stringify(body) });
		return { status: r.status, body: await r.json().catch(() => ({})) };
	};
	const adminCookies = admin.cookies;
	const status = await adminApi(A, adminCookies, "federation", {});
	check("the admin panel shows federation", status.status === 200 && status.body.id === idOf(A.origin) && status.body.instances.some((i: any) => i.id === idOf(B.origin) && i.federating), status.body.error);
	const blocked = await adminApi(A, adminCookies, "federationBlock", { instance: idOf(B.origin), reason: "test" });
	check("an admin defederates B", blocked.status === 200, blocked.body);
	check("B's accounts drop out of view on A", (await A.db`select instance_blocked from users where id = ${bobOnA ?? "0"}::bigint`)[0]?.instance_blocked === true);
	const hiddenPreview = await fetch(`${A.origin}/${bob.name}@${idOf(B.origin)}`, { redirect: "manual" });
	check("and out of A's link previews", hiddenPreview.status === 302, hiddenPreview.status);
	const hiddenProfile = await alice.get("UserByScreenName", { screen_name: `${bob.name}@${idOf(B.origin)}`, withSafetyModeUserFields: true });
	check("and alice can't open his profile", !hiddenProfile.data?.user, hiddenProfile.data);
	await bob.gql("CreateTweet", { tweet_text: `after the block ${stamp}` });
	await Bun.sleep(20_000);
	check("nothing new arrives from B", !(await A.db`select 1 from posts where user_id = ${bobOnA ?? "0"}::bigint and text like 'after the block%'`).length);
	await adminApi(A, adminCookies, "federationUnblock", { instance: idOf(B.origin) });
	check("lifting it catches up", !!(await until(async () => (await A.db`select 1 from posts where user_id = ${bobOnA ?? "0"}::bigint and text like 'after the block%'`).length > 0)));

	const editCopy = await adminApi(A, adminCookies, "updateUser", { id: bobOnA, name: "renamed here" });
	check("admins can't edit a copy of another instance's account", editCopy.status === 403 && /lives on/.test(editCopy.body.error ?? ""), editCopy.body);
	const roleCopy = await adminApi(A, adminCookies, "setRole", { id: bobOnA, role: "admin" });
	check("or make it staff", roleCopy.status === 403, roleCopy.body);
	const suspendCopy = await adminApi(A, adminCookies, "setStatus", { id: bobOnA, status: "suspended" });
	check("but they can suspend it here", suspendCopy.status === 200, suspendCopy.body);
	await adminApi(A, adminCookies, "setStatus", { id: bobOnA, status: "active" });

	const meowId = newId();
	const secret = newSecret();
	const existing = await A.db`select id::text from users where lower(screen_name) = 'meow'`;
	if (existing.length) await A.db`delete from users where lower(screen_name) = 'meow'`;
	await A.db`insert into users (id, screen_name, name, password_hash, role, totp_enabled, totp_secret) values (${meowId}::bigint, 'meow', 'meow', ${await Bun.password.hash("testpass123")}, 'admin', true, ${secret})`;
	made.push({ side: A, id: meowId });
	const meowToken = newId();
	await A.db`insert into sessions (token, user_id, csrf) values (${new Bun.CryptoHasher("sha256").update(meowToken).digest("hex")}, ${meowId}::bigint, 'meowcsrf')`;
	const meowCookies = `auth_token=${meowToken}; ct0=meowcsrf`;
	const ask = (path: string, form: Record<string, string>) => fetch(`${A.origin}${path}`, { method: "POST", headers: { cookie: meowCookies }, body: new URLSearchParams(form), redirect: "manual" });
	const firstCode = codeAt(secret, Math.floor(Date.now() / 30000));
	const page = await (await ask("/federation/superadmin/enter", { instance: idOf(B.origin), password: "testpass123", code: firstCode })).text();
	const ticket = /name="ticket" value="([^"]+)"/.exec(page)?.[1]?.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
	check("meow gets a ticket after password and code", !!ticket, page.slice(0, 200));
	const replay = await (await ask("/federation/superadmin/enter", { instance: idOf(B.origin), password: "testpass123", code: firstCode })).text();
	check("the same code can't be used twice", !replay.includes('name="ticket"'));
	const wrong = await (await ask("/federation/superadmin/enter", { instance: idOf(B.origin), password: "wrong", code: "000000" })).text();
	check("a wrong password gets no ticket", !wrong.includes('name="ticket"'));
	const notMeow = await fetch(`${A.origin}/federation/superadmin`, { headers: { cookie: adminCookies } });
	check("other admins don't see the superadmin page", notMeow.status === 404);
	const entered = await fetch(`${B.origin}/federation/superadmin/accept`, { method: "POST", body: new URLSearchParams({ ticket: ticket ?? "" }), redirect: "manual" });
	const superCookies = entered.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
	check("B lets meow in with it", entered.status === 303 && superCookies.includes("auth_token="), entered.status);
	const asSuper = await adminApi(B, superCookies, "federation", {});
	check("with an admin session there", asSuper.status === 200, asSuper.body);
	const again = await fetch(`${B.origin}/federation/superadmin/accept`, { method: "POST", body: new URLSearchParams({ ticket: ticket ?? "" }), redirect: "manual" });
	check("the ticket works once", again.status === 403, again.status);
	const tampered = ticket ? JSON.stringify({ ...JSON.parse(ticket), key_id: idOf(B.origin) }) : "";
	const forgedTicket = await fetch(`${B.origin}/federation/superadmin/accept`, { method: "POST", body: new URLSearchParams({ ticket: tampered }), redirect: "manual" });
	check("a ticket from anywhere else is refused", forgedTicket.status === 403, forgedTicket.status);
	const [superOnB] = await B.db`select u.id::text from users u where u.instance = ${idOf(A.origin)} and u.screen_name = ${`meow@${idOf(A.origin)}`}`;
	const bAdmin = await account(B, `fbadm${stamp}`);
	made.push({ side: B, id: bAdmin.id });
	await B.db`update users set role = 'admin' where id = ${bAdmin.id}::bigint`;
	const demote = await adminApi(B, bAdmin.cookies, "setStatus", { id: superOnB?.id, status: "suspended" });
	check("B's own admins can't act on the superadmin", demote.status === 403, demote.body);

	if (process.env.FED_D_DB) {
		const D = new SQL(process.env.FED_D_DB);
		const paused = await until(async () => {
			const e = (await D`select last_error from federation_peers where instance = ${idOf(A.origin)}`)[0]?.last_error ?? "";
			return /paused/.test(e) ? e : undefined;
		}, 60);
		check("an instance over its hourly budget is paused", /paused/.test(paused ?? ""), paused);
		const [{ cursor }] = await D`select cursor::text from federation_peers where instance = ${idOf(A.origin)}`;
		const [{ head }] = await A.db`select max(seq)::text as head from federation_outbox`;
		check("and it stops reading before the end, after the events it applied", BigInt(cursor) > 0n && BigInt(cursor) < BigInt(head), { cursor, head });
	}

	const bAdminCookies = bAdmin.cookies;
	const ownBlock = await adminApi(B, bAdminCookies, "federationBlock", { instance: "localhost:3043", reason: "our own reasons" });
	check("B's admin defederates D on their own", ownBlock.status === 200, ownBlock.body);
	const sent = await (await ask("/federation/superadmin/emergency", { instance: "localhost:3043", action: "block", reason: "test emergency", password: "testpass123", code: codeAt(secret, Math.floor(Date.now() / 30000) + 1) })).text();
	check("meow sends an emergency defederation", sent.includes("Sent."), sent.slice(0, 300));
	check("B applies it", !!(await until(async () => (await B.db`select source from federation_blocks where instance = 'localhost:3043'`)[0]?.source === "emergency", 30)));
	const lifted = await adminApi(B, superCookies, "federationUnblock", { instance: "localhost:3043" });
	check("a superadmin session can lift it locally", lifted.status === 200, lifted.body);
	const [afterLift] = await B.db`select source, reason from federation_blocks where instance = 'localhost:3043'`;
	check("lifting the emergency keeps B's own block", afterLift?.source === "local" && afterLift.reason === "our own reasons", afterLift);
	await adminApi(B, bAdminCookies, "federationUnblock", { instance: "localhost:3043" });
	await B.db`update sessions set expires_at = now() - interval '1 second' where user_id = ${superOnB?.id ?? "0"}::bigint and superadmin`;
	check("meow's copy stops being an admin once the visit ends", !!(await until(async () => (await B.db`select role from users where id = ${superOnB?.id ?? "0"}::bigint`)[0]?.role === null, 75)));

	const rename = await fetch(`${A.origin}/1.1/account/settings.json`, { method: "POST", headers: { cookie: meowCookies, "x-csrf-token": "meowcsrf" }, body: new URLSearchParams({ screen_name: `meow${stamp}` }) });
	check("meow can't rename away from the superadmin handle", rename.status === 400, await rename.text());
	const org = await adminApi(A, adminCookies, "createOrg", { screen_name: "MEOW", name: "meow" });
	check("nobody makes an org with that handle", org.status !== 200 && /reserved/.test(org.body.error ?? ""), org.body);

	const blockAdmin = await alice.form("/1.1/blocks/create.json", { user_id: admin.id });
	check("alice can't block an admin of her own instance", blockAdmin.status === 403, blockAdmin.status);
	await A.db`insert into blocks (blocker_id, blocked_id) values (${alice.id}::bigint, ${admin.id}::bigint) on conflict do nothing`;
	check("not even by writing the row", !(await A.db`select 1 from blocks where blocker_id = ${alice.id}::bigint and blocked_id = ${admin.id}::bigint`).length);
	const later = await account(A, `fl${stamp}`);
	made.push({ side: A, id: later.id });
	const blockLater = await alice.form("/1.1/blocks/create.json", { user_id: later.id });
	check("alice blocks someone who isn't staff", blockLater.status === 200, blockLater.status);
	await A.db`update users set role = 'admin' where id = ${later.id}::bigint`;
	check("and the block goes when they become an admin", !(await A.db`select 1 from blocks where blocker_id = ${alice.id}::bigint and blocked_id = ${later.id}::bigint`).length);
	const blockSuper = await bob.form("/1.1/blocks/create.json", { user_id: superOnB?.id ?? "0" });
	check("bob can block meow's account, which only hides it from him", blockSuper.status === 200, blockSuper.status);
	const adminOnB = await until(async () => (await B.db`select id::text from users where instance = ${idOf(A.origin)} and remote_id = ${admin.id}::bigint`)[0]?.id);
	const blockRemoteAdmin = await bob.form("/1.1/blocks/create.json", { user_id: adminOnB ?? "0" });
	check("bob can block A's admin, whose instance isn't his", blockRemoteAdmin.status === 200, { status: blockRemoteAdmin.status, adminOnB });

	const bCookies = `auth_token=${bSession.token}; ct0=${bSession.csrf}`;
	const acceptHome = await adminApi(B, bCookies, "federationAcceptKey", { instance: idOf(A.origin) });
	check("B's admins can't accept a new key for the superadmin's home", acceptHome.status === 403, acceptHome.body);
	const [pinnedOnB] = await B.db`select key from federation_peers where instance = ${idOf(A.origin)}`;
	if (process.env.FED_REGISTRY && process.env.FED_B_KEY_FILE) {
		const forgedList = `${process.env.FED_REGISTRY}.forged.json`;
		const list = JSON.parse(await Bun.file(process.env.FED_REGISTRY).text());
		list.sequence += 1;
		for (const i of list.instances) if (i.id === idOf(A.origin)) i.public_key = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		await Bun.write(forgedList, JSON.stringify(list));
		const probe = (clear = false) => {
			const run = Bun.spawnSync(["bun", "-e", `import { sql } from "./src/db"; import { refreshRegistry, keyFor, pendingKeyChange } from "./src/federation"; await refreshRegistry(); ${clear ? `await sql\`update federation_peers set key = null where instance = \${${JSON.stringify(idOf(A.origin))}}\`;` : ""} console.log(JSON.stringify({ key: await keyFor(${JSON.stringify(idOf(A.origin))}), pending: await pendingKeyChange(${JSON.stringify(idOf(A.origin))}) })); process.exit(0);`], {
				env: { ...process.env, DATABASE_URL: process.env.FED_B_DB ?? "postgres://tiago@127.0.0.1:5432/fed_b", PUBLIC_ORIGIN: B.origin, FEDERATION_REGISTRY_URL: forgedList, FEDERATION_KEY_FILE: process.env.FED_B_KEY_FILE, FEDERATION_ALLOW_HTTP: "1", XITTER_TEST_SUPERADMINS: `meow@${idOf(A.origin)}` },
			});
			return { stdout: run.stdout, stderr: run.stderr };
		};
		const firstProbe = probe();
		const fresh = JSON.parse(probe(true).stdout.toString().trim().split("\n").pop() || "{}");
		const [afterFresh] = await B.db`select key from federation_peers where instance = ${idOf(A.origin)}`;
		await B.db`update federation_peers set key = ${pinnedOnB?.key ?? null} where instance = ${idOf(A.origin)}`;
		await B.db`delete from federation_state where key = 'registry'`;
		check("on first contact, a home key the list and the home disagree on is refused", !fresh.key && afterFresh?.key !== "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", { fresh, stored: afterFresh?.key });
		const seen = JSON.parse(firstProbe.stdout.toString().trim().split("\n").pop() || "{}");
		check("a list that swaps the home's key doesn't replace the pinned one", !!pinnedOnB?.key && seen.key === pinnedOnB.key, { seen, pinned: pinnedOnB?.key, err: firstProbe.stderr.toString().slice(0, 300) });
		check("and shows up as a key change", seen.pending === "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", seen);
	}

	// what people see of other instances, and hiding them (in a block: its names are its own)
	{
		const tweet = await bob.get("TweetResultByRestId", { tweetId: mirror });
		const source = tweet.data?.tweetResult?.result?.legacy?.source as string | undefined;
		check("a copy's source line names its instance", !!source?.endsWith(` - ${idOf(A.origin)}`), source);
		const globe = `/public/globe.svg?from=${encodeURIComponent(idOf(A.origin))}`;
		check("accounts from other instances wear the globe", JSON.stringify(found).includes(globe));
		const card = (await (await bob.raw(`/i/api/xitter/instance?id=${encodeURIComponent(idOf(A.origin))}`)).json()) as any;
		check("the globe's card describes the instance", card.id === idOf(A.origin) && card.accounts >= 1 && card.rules?.endsWith("/rules") && card.hidden === false, card);
		const unknownCard = await bob.raw("/i/api/xitter/instance?id=nowhere.invalid");
		check("but only instances this one knows", unknownCard.status === 404, unknownCard.status);

		const quiet = await account(A, `fq${stamp}`);
		made.push({ side: A, id: quiet.id });
		const word = `quietword${stamp}`;
		const quietPost = (await quiet.gql("CreateTweet", { tweet_text: `${word} from a` })).data?.create_tweet?.tweet_results?.result?.rest_id as string;
		const quietMirror = await until(async () => (await B.db`select local_id::text from federated_objects where instance = ${idOf(A.origin)} and kind = 'post' and remote_id = ${quietPost}::bigint`)[0]?.local_id as string);
		const quietOnB = await until(async () => (await B.db`select id::text from users where instance = ${idOf(A.origin)} and remote_id = ${quiet.id}::bigint`)[0]?.id as string);
		check("B keeps a copy of someone bob doesn't follow", !!quietMirror && !!quietOnB);
		const searchFor = async (q: string) => JSON.stringify(await bob.get("SearchTimeline", { rawQuery: q, product: "Latest", count: 20 })).includes(quietMirror ?? "-");
		check("bob finds their post in search", await searchFor(word));
		const hide = (body: Record<string, string>) => bob.page("/account/instances", body);
		await hide({ instance: idOf(A.origin), hide: "1" });
		check("hiding A takes it out of bob's search", !(await searchFor(word)));
		check("but a search naming the full handle still finds it", await searchFor(`from:${quiet.name}@${idOf(A.origin)} ${word}`));
		check("accounts bob follows on A stay", JSON.stringify(await bob.get("SearchTimeline", { rawQuery: `hello from a ${stamp}`, product: "Latest", count: 20 })).includes(mirror ?? "-"));
		const hiddenCard = (await (await bob.raw(`/i/api/xitter/instance?id=${encodeURIComponent(idOf(A.origin))}`)).json()) as any;
		check("and the card says A is hidden", hiddenCard.hidden === true, hiddenCard.hidden);

		const bobPost = (await bob.gql("CreateTweet", { tweet_text: `hello from b ${stamp}` })).data?.create_tweet?.tweet_results?.result?.rest_id as string;
		const bobPostOnA = await until(async () => (await A.db`select local_id::text from federated_objects where instance = ${idOf(B.origin)} and kind = 'post' and remote_id = ${bobPost}::bigint`)[0]?.local_id as string, 60);
		await quiet.gql("FavoriteTweet", { tweet_id: bobPostOnA });
		const liked = await until(async () => (await B.db`select 1 from likes where user_id = ${quietOnB ?? "0"}::bigint and post_id = ${bobPost}::bigint`).length > 0, 60);
		const notified = async () => JSON.stringify(await bob.get("NotificationsTimeline", { timeline_type: "All", count: 40 })).includes(quietOnB ?? "-");
		check("bob is notified of a like from a hidden instance", !!liked && (await notified()));
		await hide({ notifications: "1" });
		check("until he mutes notifications from what he hid", !(await notified()));
		await hide({ notifications: "0" });
		await hide({ instance: idOf(A.origin), hide: "0" });
		check("showing A again brings the post back", await searchFor(word));

		const remoteList = await adminApi(B, bCookies, "users", { q: quiet.name, home: "remote" });
		const localList = await adminApi(B, bCookies, "users", { q: quiet.name, home: "local" });
		check("the admin list of other instances' accounts has them", remoteList.body.users?.some((u: any) => u.id === quietOnB), remoteList.body.error);
		check("and the list of this instance's doesn't", localList.status === 200 && !localList.body.users?.some((u: any) => u.id === quietOnB), localList.body.error);
	}

} finally {
	for (const m of made) await m.side.db`delete from users where id = ${m.id}::bigint`;
}
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
