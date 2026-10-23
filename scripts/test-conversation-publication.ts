import { expect, mock, test } from "bun:test";
import { join } from "node:path";

async function fixture() {
	const posts = new Map<string, any>();
	const media = new Map<string, any>([["100", { id: "100", user_id: "1", kind: "photo", mime: "image/jpeg", width: 1200, height: 628, size: 1024, state: "ready", post_id: null }]]);
	const author = { a_id: "1", a_screen_name: "alice", a_name: "Alice", a_bio: "", a_location: "", a_website: null, a_avatar_url: null, a_banner_url: null, a_verified_type: null, a_flag: null, a_status: "active", a_created_at: new Date(), a_followers: 0, a_following: 0, a_posts: 0, a_media_posts: 0, a_likes: 0, a_articles: 0, a_highlights: 0 };
	let graphql: typeof import("../src/graphql"), postModule: typeof import("../src/posts"), response: Response, body: any, saved: any;
	function textOf(query: any): string {
		return query.strings.reduce((text: string, part: string, index: number) => text + part + (index < query.values.length ? query.values[index]?.strings ? textOf(query.values[index]) : "?" : ""), "").replace(/\s+/g, " ").trim();
	}
	function evaluate(query: any): any[] {
		const text = textOf(query), values = query.values;
		let post: any, upload: any, ids: string[];
		if (text.startsWith("select status, deactivated_at, role from users")) return [{ status: "active", deactivated_at: null, role: null }];
		if (text.startsWith("select count(*)::int as n from posts")) return [{ n: 0 }];
		if (text.startsWith("select verified_type from users")) return [{ verified_type: null }];
		if (text.startsWith("select id from media where")) return [...media.values()].filter((row) => row.id === values[0] && row.user_id === values[1] && row.state === "ready" && !row.post_id);
		if (text.startsWith("insert into posts")) {
			post = { ...author, id: values[0], text: values[2], conversation_id: values[0], created_at: new Date(), source: "Xitter for Web", sensitive: false, like_count: 0, repost_count: 0, bookmark_count: 0, reply_count: 0, quote_count: 0, view_count: 0 };
			posts.set(post.id, post);return [];
		}
		if (text.startsWith("select id from posts where")) return posts.has(values[0]) ? [{ id: values[0] }] : [];
		if (text.startsWith("select id, kind from media")) return [...media.values()].filter((row) => values[0].array.includes(row.id) && !row.post_id && row.user_id === values[1]);
		if (text.startsWith("update media set post_id")) {
			upload = media.get(values[2]);if (!upload || upload.post_id) return [];
			upload.post_id = values[0];upload.position = values[1];return [{ id: upload.id }];
		}
		if (text.startsWith("update posts set conversation_card =")) { posts.get(values[1]).conversation_card = JSON.parse(values[0]);return []; }
		if (text.startsWith("update posts set sensitive")) return [];
		if (text.startsWith("select p.id, p.text,")) { ids = values[1].array;return [...posts.values()].filter((row) => ids.includes(row.id)); }
		if (text.startsWith("select id, post_id, kind, mime")) return [...media.values()].filter((row) => values[0].array.includes(row.post_id));
		if (/^(delete from post_mentions|select n.id::text, n.post_id|select m.post_id, u.id)/.test(text)) return [];
		throw new Error(`Unexpected fixture query: ${text.slice(0, 140)}`);
	}
	function sql(strings: any, ...values: any[]): any {
		const query = { strings, values, then: (resolve: any, reject: any) => Promise.resolve().then(() => evaluate(query)).then(resolve, reject) };
		return typeof strings === "string" ? strings : query;
	}
	Object.assign(sql, { array: (array: any[]) => ({ array }), begin: (action: any) => action(sql) });
	mock.module("../src/db", () => ({ sql, DATABASE_SENTENCE: "The database is unavailable right now. Try again later.", DatabaseOutage: class DatabaseOutage extends Error { kind = "outage"; }, databaseOutage: () => undefined }));
	graphql = await import("../src/graphql");postModule = await import("../src/posts");
	response = await graphql.runOperation("CreateTweet", { id: "1", postSource: "Xitter for Web" } as any, { tweet_text: "", media: { media_entities: [{ media_id: "100" }] }, xitter_conversation_card: { choices: [{ hashtag: "Cats" }] } });
	body = await response.json();
	if (body.errors) throw new Error(JSON.stringify(body.errors));
	saved = body.data.create_tweet.tweet_results.result;
	if (saved.legacy.full_text !== "" || saved.card.legacy.name !== "promo_image_convo") throw new Error("Media-only conversation card did not reach the published response.");
	if (saved.card.legacy.binding_values.find((binding: any) => binding.key === "cta_one_tweet").value.string_value !== "#Cats") throw new Error("Blank CTA text did not use its hashtag.");
	saved = await postModule.getPost("1", saved.rest_id);
	if (saved?.conversationCard?.choices[0].hashtag !== "#Cats" || saved.media?.[0]?.id !== "100") throw new Error("Stored card and media did not survive a fresh post read.");
	console.log("publication and fresh-read checks passed");
}

if (process.argv.includes("--fixture")) await fixture();
else test("CreateTweet persists a media-only conversation card and returns it on a fresh read", async () => {
	const subprocess = Bun.spawn([Bun.which("bun")!, join(import.meta.dir, "test-conversation-publication.ts"), "--fixture"], { stdout: "pipe", stderr: "pipe" });
	const output = await new Response(subprocess.stdout).text();
	const error = await new Response(subprocess.stderr).text();
	const status = await subprocess.exited;
	expect({ status, error }).toEqual({ status: 0, error: "" });
	expect(output).toContain("publication and fresh-read checks passed");
});
