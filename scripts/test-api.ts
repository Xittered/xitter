// End-to-end check of the public API (/api/v1) against a running server. Makes
// tokens through /account/api like a person would, and removes what it
// creates.
// usage: bun scripts/test-api.ts <user A> <user B> <password of both> <image>

import { readFileSync } from "node:fs";

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [nameA, nameB, password, image] = process.argv.slice(2);
if (!nameA || !nameB || !password || !image) throw new Error("usage: bun scripts/test-api.ts <user A> <user B> <password> <image>");

let failed = 0;
const check = (ok: boolean, what: string, detail?: unknown) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : `: ${JSON.stringify(detail).slice(0, 300)}`}`);
	if (!ok) failed++;
};

async function cookies(username: string) {
	const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
	return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}

// a token from the account page, as its HTML shows it once
async function makeToken(cookie: string, name: string, scope: "read" | "write") {
	const html = await (await fetch(`${origin}/account/api`, { method: "POST", headers: { cookie, origin }, body: new URLSearchParams({ csrf: /ct0=([^;]+)/.exec(cookie)?.[1] ?? "", do: "create", name, scope }) })).text();
	return /xit_[0-9a-f]{48}/.exec(html)?.[0];
}

const api = (token: string | undefined) => async (method: string, path: string, body?: unknown, type = "application/json") => {
	const res = await fetch(`${origin}/api/v1${path}`, {
		method,
		headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": type } : {}) },
		body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : (body as BodyInit),
	});
	return { status: res.status, headers: res.headers, json: (await res.json().catch(() => ({}))) as any };
};

const cookieA = await cookies(nameA);
const cookieB = await cookies(nameB);
const writeA = await makeToken(cookieA, "api test write", "write");
const readA = await makeToken(cookieA, "api test read", "read");
const writeB = await makeToken(cookieB, "api test write", "write");
check(!!writeA && !!readA && !!writeB, "tokens are made on /account/api");
const forged = await (await fetch(`${origin}/account/api`, { method: "POST", headers: { cookie: cookieA, origin: "https://evil.example" }, body: new URLSearchParams({ do: "create", name: "forged", scope: "write" }) })).text();
check(!/xit_[0-9a-f]{48}/.test(forged), "a form posted from another site makes no token");
const a = api(writeA), ar = api(readA), b = api(writeB), anon = api(undefined);

check((await anon("GET", "/me")).status === 401, "no token: 401");
check((await api("xit_" + "0".repeat(48))("GET", "/me")).status === 401, "a made-up token: 401");
const me = await a("GET", "/me");
check(me.status === 200 && me.json.data?.screen_name?.toLowerCase() === nameA.toLowerCase(), "GET /me", me.json.data?.screen_name);
check(me.headers.get("x-rate-limit-remaining") !== null, "answers carry the rate limit headers");
check((await anon("OPTIONS", "/me")).headers.get("access-control-allow-origin") === "*", "CORS preflight is answered");

const other = await a("GET", `/users/${nameB}`);
check(other.status === 200 && typeof other.json.data?.counts?.followers === "number", "GET /users/{name} with counts");
const before = (await a("GET", "/me")).json.data ?? {};
const edited = await a("PATCH", "/me", { bio: "edited over the api", location: "Kyiv" });
check(edited.status === 200 && edited.json.data?.bio === "edited over the api" && edited.json.data?.location === "Kyiv", "PATCH /me edits bio and location", edited.json);
check((await a("PATCH", "/me", { website: "not a url" })).status === 400, "PATCH /me refuses a bad website");
check((await a("PATCH", "/me", { name: "" })).status === 400, "PATCH /me refuses a blank name");
check((await ar("PATCH", "/me", { bio: "x" })).status === 403, "a read token can't edit the profile");
await a("PATCH", "/me", { bio: before.bio ?? "", location: before.location ?? "" });
check((await a("GET", "/users/nobody_here_at_all")).status === 404, "an unknown account is 404");

// write with the read token is refused
check((await ar("POST", "/posts", { text: "should not post" })).status === 403, "a read token can't post");

// media and posts
const up = await a("POST", "/media", readFileSync(image), image.endsWith(".png") ? "image/png" : "image/jpeg");
check(up.status === 201 && !!up.json.data?.media_id, "POST /media uploads the body", up.json);
const post = await a("POST", "/posts", { text: `api test ${Date.now()}`, media_ids: [up.json.data?.media_id] });
const pid = post.json.data?.id;
check(post.status === 201 && post.json.data?.media?.length === 1, "POST /posts with an image", post.json);
const avatarUp = await a("POST", "/media", readFileSync(image), image.endsWith(".png") ? "image/png" : "image/jpeg");
const withAvatar = await a("PATCH", "/me", { avatar_media_id: avatarUp.json.data?.media_id });
check(withAvatar.status === 200 && String(withAvatar.json.data?.avatar_url).includes(`/media/${avatarUp.json.data?.media_id}`), "PATCH /me sets the avatar from an upload", withAvatar.json);
check((await a("PATCH", "/me", { avatar_media_id: "1" })).status === 400, "PATCH /me refuses an upload that isn't yours");
check((await a("POST", "/posts", { text: "" })).status === 400, "an empty post is refused with the app's message");
const reply = await b("POST", "/posts", { text: "a reply over the api", reply_to: pid });
check(reply.status === 201 && reply.json.data?.reply_to === pid, "B replies");
const quote = await b("POST", "/posts", { text: "quoting over the api", quote: pid });
check(quote.status === 201 && quote.json.data?.quote_of === pid, "B quotes");

// engagement
const liked = await b("POST", `/posts/${pid}/like`);
check(liked.json.data?.viewer?.liked === true && liked.json.data?.counts?.likes === 1, "like");
const likers = await a("GET", `/posts/${pid}/likes`);
check(likers.status === 200 && likers.json.data?.length === 1 && likers.json.data[0]?.screen_name?.toLowerCase() === nameB.toLowerCase(), "GET /posts/{id}/likes lists B", likers.json);
check((await b("POST", `/posts/${pid}/repost`)).json.data?.viewer?.reposted === true, "repost");
check((await b("POST", `/posts/${pid}/bookmark`)).json.data?.viewer?.bookmarked === true, "bookmark");
check((await b("DELETE", `/posts/${pid}/like`)).json.data?.viewer?.liked === false, "unlike");
check((await b("DELETE", `/posts/${pid}/repost`)).json.data?.viewer?.reposted === false, "undo repost");
check((await b("DELETE", `/posts/${pid}/bookmark`)).json.data?.viewer?.bookmarked === false, "remove bookmark");

// reads
const one = await b("GET", `/posts/${pid}`);
check(one.status === 200 && one.json.data?.author?.screen_name?.toLowerCase() === nameA.toLowerCase(), "GET /posts/{id}");
const replies = await a("GET", `/posts/${pid}/replies`);
check(replies.json.data?.some((p: any) => p.id === reply.json.data?.id), "GET /posts/{id}/replies");
const onlyReplies = await a("GET", `/users/${nameB}/posts?replies=only&limit=20`);
check(onlyReplies.json.data?.some((p: any) => p.id === reply.json.data?.id) && !onlyReplies.json.data?.some((p: any) => p.id === quote.json.data?.id), "GET /users/{name}/posts?replies=only has the reply, not the quote");
const posts = await b("GET", `/users/${nameA}/posts?limit=5`);
check(posts.json.data?.[0]?.id === pid, "GET /users/{name}/posts, newest first");
const paged = await b("GET", `/users/${nameA}/posts?limit=1`);
const next = paged.json.next_cursor ? await b("GET", `/users/${nameA}/posts?limit=1&cursor=${paged.json.next_cursor}`) : undefined;
check(!!next && next.json.data?.[0]?.id !== paged.json.data?.[0]?.id, "paging with next_cursor moves on");
const found = await b("GET", `/search/posts?q=${encodeURIComponent("api test")}`);
check(found.json.data?.some((p: any) => p.id === pid), "GET /search/posts");
const extra = await b("POST", "/posts", { text: `api test paging ${Date.now()}` });
check(extra.status === 201, "B posts a second match for top-search paging", extra.json);
const top = `/search/posts?q=${encodeURIComponent("api test")}&sort=top&limit=1`;
const top1 = await b("GET", top);
const top2 = top1.json.next_cursor ? await b("GET", `${top}&cursor=${top1.json.next_cursor}`) : undefined;
check(!!top2 && top2.json.data?.[0]?.id !== top1.json.data?.[0]?.id, "top search paging with next_cursor moves on", { first: top1.json, second: top2?.json });
const people = await b("GET", `/search/users?q=${encodeURIComponent(nameA)}`);
check(people.json.data?.some((u: any) => u.screen_name.toLowerCase() === nameA.toLowerCase()), "GET /search/users");

// follows
const wasFollowing = (await b("GET", `/users/${nameA}`)).json.data?.viewer?.following;
const unf = await b("DELETE", `/users/${nameA}/follow`);
check(unf.json.data?.viewer?.following === false, "unfollow");
const fol = await b("POST", `/users/${nameA}/follow`);
check(fol.json.data?.viewer?.following === true, "follow");
const timeline = await b("GET", "/timeline");
check(timeline.json.data?.some((p: any) => p.id === pid), "the followed account's post is in GET /timeline");
if (!wasFollowing) await b("DELETE", `/users/${nameA}/follow`);
check((await a("POST", `/users/${nameA}/follow`)).status === 400, "following yourself is refused");

// someone else's post can't be deleted
check((await b("DELETE", `/posts/${pid}`)).status === 403, "B can't delete A's post");

// clean up
await b("DELETE", `/posts/${extra.json.data?.id}`);
await b("DELETE", `/posts/${reply.json.data?.id}`);
await b("DELETE", `/posts/${quote.json.data?.id}`);
const del = await a("DELETE", `/posts/${pid}`);
check(del.status === 200 && (await a("GET", `/posts/${pid}`)).status === 404, "DELETE /posts/{id}");

// deleting a token on the page turns it off
for (const [cookie, tok] of [[cookieA, writeA], [cookieA, readA], [cookieB, writeB]] as const) {
	const html = await (await fetch(`${origin}/account/api`, { headers: { cookie } })).text();
	for (const m of html.matchAll(/<b>api test (?:write|read)<\/b>[\s\S]*?name="id" value="(\d+)"/g)) {
		await fetch(`${origin}/account/api`, { method: "POST", headers: { cookie, origin }, body: new URLSearchParams({ csrf: /ct0=([^;]+)/.exec(cookie)?.[1] ?? "", do: "delete", id: m[1] }) });
	}
	void tok;
}
check((await a("GET", "/me")).status === 401, "a deleted token stops working");

console.log(failed ? `${failed} failed` : "all passed");
process.exit(failed ? 1 : 0);
