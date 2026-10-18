// /api: the public API's documentation (public-api.ts), open to everyone.

import { accountPage, esc } from "./account-page";
import { PUBLIC_ORIGIN } from "./config";
import { RULES } from "./ratelimit";
import { settings } from "./settings";

type Endpoint = [method: string, path: string, scope: "read" | "write", what: string];

const ENDPOINTS: Endpoint[] = [
	["GET", "/me", "read", "Your account."],
	["GET", "/users/{screen_name}", "read", "An account."],
	["GET", "/users/{screen_name}/posts", "read", "Its posts and reposts, newest first. <code>replies=true</code> includes replies."],
	["GET", "/users/{screen_name}/followers", "read", "Who follows it (up to <code>limit</code>, 200 at most)."],
	["GET", "/users/{screen_name}/following", "read", "Who it follows."],
	["GET", "/timeline", "read", "Posts and reposts from you and the accounts you follow, newest first."],
	["GET", "/posts/{id}", "read", "One post."],
	["GET", "/posts/{id}/replies", "read", "Its replies."],
	["GET", "/search/posts?q=", "read", "Posts matching a search, with the same operators as the app (<code>from:</code>, <code>filter:media</code>, ...). <code>sort=top</code> for top posts."],
	["GET", "/search/users?q=", "read", "Accounts matching a name or handle."],
	["POST", "/posts", "write", "Post. Body: <code>text</code>, and optionally <code>reply_to</code> (a post id), <code>quote</code> (a post id), <code>media_ids</code> (up to 4 from <code>/media</code>), <code>sensitive</code>."],
	["DELETE", "/posts/{id}", "write", "Delete one of your posts."],
	["POST", "/posts/{id}/like", "write", "Like. <code>DELETE</code> to undo."],
	["POST", "/posts/{id}/repost", "write", "Repost. <code>DELETE</code> to undo."],
	["POST", "/posts/{id}/bookmark", "write", "Bookmark. <code>DELETE</code> to undo."],
	["POST", "/users/{screen_name}/follow", "write", "Follow (asks, for a protected account). <code>DELETE</code> to unfollow."],
	["POST", "/media", "write", "Upload an image, GIF or video: the file is the whole body, with its <code>Content-Type</code>. Returns a <code>media_id</code> for <code>/posts</code>; a video may still be <code>processing</code>."],
];

const DOCS_CSS = `table{width:100%;border-collapse:collapse}
td{padding:10px 8px;border-top:1px solid var(--border);vertical-align:top}
td:first-child,td:nth-child(2){font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;white-space:nowrap}
td:first-child{font-weight:700}
.w{color:#f91880}.r{color:var(--success)}
@media (max-width:560px){tr{display:grid;grid-template-columns:auto 1fr;border-top:1px solid var(--border);padding:8px 0}td{border:0;padding:2px 8px 2px 0}td:nth-child(2){white-space:normal;word-break:break-all}td:nth-child(3){grid-column:1/-1}}`;

export function apiDocsPage(req: Request): Promise<Response> {
	const name = esc(settings().instance_name);
	const base = `${PUBLIC_ORIGIN}/api/v1`;
	const window = (b: keyof typeof RULES) => `${RULES[b].limit} per ${RULES[b].window / 60_000} minutes`;
	const body = `<h1>${name} API</h1>
<p class="dim">Read and post on ${name} from scripts and bots, as your own account.</p>

<h2>Signing in</h2>
<p>Make a token at <a href="/account/api">/account/api</a>. A <span class="r">read</span> token can only look; a <span class="w">write</span> token can also post, like and follow. Send it with every request:</p>
<pre>Authorization: Bearer xit_...</pre>
<p>Requests go to <code>${esc(base)}</code>. Bodies are JSON (or a form); answers are JSON with the result in <code>data</code>, or <code>{"error": "..."}</code> with a 4xx or 5xx status.</p>

<h2>Endpoints</h2>
<table>${ENDPOINTS.map(([m, p, s, w]) => `<tr><td>${m}</td><td>${esc(p)}</td><td><span class="${s === "write" ? "w" : "r"}">${s}</span> · ${w}</td></tr>`).join("")}</table>

<h2>Paging</h2>
<p>Lists take <code>limit</code> (20 by default, 100 at most). Those that page give <code>next_cursor</code>: pass it back as <code>cursor</code> for the next page; it is <code>null</code> at the end.</p>

<h2>Limits</h2>
<p>The same as in the app: ${window("read")} requests in all, ${window("post")} posts, ${window("engage")} likes, reposts, bookmarks and follows together, and ${window("upload")} uploads. Every answer carries <code>x-rate-limit-limit</code>, <code>-remaining</code> and <code>-reset</code> (a Unix time); over a limit you get <code>429</code> with <code>retry-after</code>.</p>

<h2>Example</h2>
<pre>curl -X POST ${esc(base)}/posts \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"text": "hello from the API"}'</pre>
<pre>curl -X POST ${esc(base)}/media \\
  -H "Authorization: Bearer $TOKEN" \\
  -H "Content-Type: image/png" \\
  --data-binary @picture.png</pre>

<h2>Shapes</h2>
<p>A post: <code>id</code>, <code>text</code>, <code>created_at</code>, <code>edited_at</code>, <code>url</code>, <code>author</code> (an account), <code>reply_to</code>, <code>quote_of</code>, <code>sensitive</code>, <code>counts</code> (likes, reposts, replies, quotes, bookmarks, views), <code>viewer</code> (whether you liked, reposted, bookmarked it), <code>media</code>; in timelines a repost adds <code>reposted_by</code> and <code>reposted_at</code>.</p>
<p>An account: <code>id</code>, <code>screen_name</code>, <code>name</code>, <code>bio</code>, <code>location</code>, <code>website</code>, <code>avatar_url</code>, <code>banner_url</code>, <code>verified_type</code>, <code>protected</code>, <code>created_at</code>, <code>url</code>, <code>counts</code> (posts, followers, following, likes) and <code>viewer</code> (following, followed_by).</p>

<p class="dim">Posts made through the API show "Xitter API" as their app. What a token sees is what its account sees: blocks, protected accounts and suspensions apply.</p>
`;
	return accountPage({ req, title: "API", body, cache: "no-cache", referrer: null, back: { href: "/home", label: `Back to ${settings().instance_name}` }, css: DOCS_CSS });
}
