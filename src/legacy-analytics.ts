// The 2020 client's "Tweet activity" (View Tweet activity on one's own post)
// frames /i/tfb/v1/quick_promote/lite/<id>, a page twitter.com served on its
// own. Left to the client shell, the page framed itself, header in header,
// spinning forever. This is that page: the post's own counts.

import type { Viewer } from "./auth";
import { getPost } from "./posts";

const vars = (t: (typeof THEMES)[number]) => `--bg:${t.bg};--text:${t.text};--muted:${t.muted};--line:${t.line}`;
// the 2020 client keeps its theme in its own storage, so the frame asks the page
const THEME_PICK = `try{var b=getComputedStyle(parent.document.body).backgroundColor;document.documentElement.className=b==="rgb(0, 0, 0)"?"dark":b.indexOf("rgb(21, 32, 43")===0?"dim":""}catch(e){}`;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const num = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");

// light, dim, lights out; the frame takes the one its page shows (THEME_PICK)
const THEMES = [
	{ bg: "#fff", text: "#0f1419", muted: "#536471", line: "#eff3f4" },
	{ bg: "#15202b", text: "#fff", muted: "#8b98a5", line: "#38444d" },
	{ bg: "#000", text: "#d9d9d9", muted: "#6e767d", line: "#2f3336" },
];

export async function legacyAnalyticsPage(req: Request, id: string, viewer: Viewer | undefined): Promise<Response> {
	const post = viewer ? await getPost(viewer.id, id) : undefined;
	const own = !!post && post.author.id === viewer!.id;
	const engagements = post ? post.like_count + post.repost_count + post.reply_count + post.quote_count + post.bookmark_count : 0;
	const rows: [string, number | undefined][] = post
		? [["Likes", post.like_count], ["Retweets", post.repost_count], ["Quote Tweets", post.quote_count], ["Replies", post.reply_count], ["Bookmarks", post.bookmark_count]]
		: [];
	const body = !own
		? `<p class="muted">Tweet activity is only available for your own Tweets.</p>`
		: `<div class="top"><div><span class="muted">Impressions</span><b>${post!.view_count ? num(post!.view_count) : "–"}</b><small class="muted">times people saw this Tweet</small></div>
<div><span class="muted">Total engagements</span><b>${num(engagements)}</b><small class="muted">times people interacted with this Tweet</small></div></div>
<ul>${rows.map(([k, v]) => `<li><span>${esc(k)}</span><b>${num(v)}</b></li>`).join("")}</ul>`;
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tweet activity</title><style>
html{${vars(THEMES[0]!)}}html.dim{${vars(THEMES[1]!)}}html.dark{${vars(THEMES[2]!)}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/20px -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{padding:16px}.muted{color:var(--muted)}p{margin:0}
.top{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding-bottom:16px;border-bottom:1px solid var(--line)}
.top div{display:grid;gap:2px}.top b{font-size:23px;line-height:28px;font-weight:800}.top small{font-size:13px}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--line)}
</style><script>${THEME_PICK}</script></head><body><main>${body}</main></body></html>`;
	return new Response(html, { status: own ? 200 : 404, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'" } });
}
