// Previews of this instance's links in other apps (Discord, Slack, iMessage,
// Telegram, Mastodon…). Their link fetchers are signed out, so a signed-out
// request for a post or a profile gets a small page with its OpenGraph and
// Twitter card tags and an oEmbed link; people who open it go on to the
// sign-in page as before. Only what a public X account shows anyone is used:
// active, unprotected accounts and their visible posts, with no picture from a
// post marked sensitive. Admin > Settings > Features turns previews off.

import { existsSync } from "node:fs";
import { PUBLIC_ORIGIN } from "./config";
import { sql } from "./db";
import { remoteMediaFile } from "./federation-sync";
import { MEDIA_CSP, MEDIA_DIR, servedType } from "./media";
import { isId } from "./ids";
import { feature, settings } from "./settings";
import { posterFile } from "./video";

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const clip = (s: string, n: number) => ([...s].length > n ? `${[...s].slice(0, n - 1).join("")}…` : s);

type Author = { id: string; screen_name: string; name: string; bio: string; avatar_url: string | null };

// an account anyone may see: not protected, suspended, limited or deactivated
async function publicAuthor(where: ReturnType<typeof sql>): Promise<Author | undefined> {
	const [u] = await sql`select id::text, screen_name, name, bio, avatar_url from users
		where ${where} and not protected and not instance_blocked and status in ('active', 'restricted') and deactivated_at is null`;
	return u as Author | undefined;
}

type Media = { id: string; kind: string; mime: string; width: number; height: number; remote: boolean };
type Counts = { replies: number; reposts: number; likes: number; views: number };
type Post = {
	id: string;
	text: string;
	created_at: Date;
	author: Author;
	media: Media[];
	image?: Media;
	replyTo?: string;
	quote?: { id: string; author: Author; text: string; media: Media[] };
	counts: Counts;
};

const SUSPENDED = sql`(select id from users where status = 'suspended' or instance_blocked)`;

async function publicPost(id: string, withQuote = true): Promise<Post | undefined> {
	if (!isId(id)) return undefined;
	const [p] = await sql`select p.id::text, p.user_id::text, p.text, p.created_at, p.sensitive and not u.never_sensitive as sensitive, u.never_sensitive,
		p.quote_id::text, (select r.screen_name from users r where r.id = p.reply_to_user_id) as reply_screen_name,
		coalesce((p.count_overrides->>'replies')::int, greatest((p.remote_counts->>'replies')::int, (select count(*)::int from posts x where x.reply_to_id = p.id and x.user_id not in ${SUSPENDED}))) as replies,
		coalesce((p.count_overrides->>'reposts')::int, greatest((p.remote_counts->>'reposts')::int, (select count(*)::int from reposts x where x.post_id = p.id and x.user_id not in ${SUSPENDED}))) as reposts,
		coalesce((p.count_overrides->>'likes')::int, greatest((p.remote_counts->>'likes')::int, (select count(*)::int from likes x where x.post_id = p.id and x.user_id not in ${SUSPENDED}))) as likes,
		coalesce((p.count_overrides->>'views')::int, greatest((p.remote_counts->>'views')::int, (select count(*)::int from post_views x where x.post_id = p.id))) as views
		from posts p join users u on u.id = p.user_id where p.id = ${id}::bigint and not p.hidden and p.circle_owner_id is null`;
	if (!p) return undefined;
	const author = await publicAuthor(sql`id = ${p.user_id}::bigint`);
	if (!author) return undefined;
	const media = (
		p.sensitive
			? []
			: await sql`select id::text, kind, mime, width, height, remote_instance is not null as remote from media
			where post_id = ${id}::bigint and state = 'ready' and (coalesce(cardinality(sensitive_warning), 0) = 0 or ${p.never_sensitive}) order by position nulls last limit 4`
	) as Media[];
	const quoted = withQuote && p.quote_id ? await publicPost(p.quote_id, false) : undefined;
	return {
		id: p.id,
		text: p.text,
		created_at: p.created_at,
		author,
		media,
		image: media[0],
		replyTo: p.reply_screen_name ?? undefined,
		quote: quoted ? { id: quoted.id, author: quoted.author, text: quoted.text, media: quoted.media } : undefined,
		counts: { replies: p.replies ?? 0, reposts: p.reposts ?? 0, likes: p.likes ?? 0, views: p.views ?? 0 },
	};
}

const avatarId = (a: Author) => /^\/media\/(\d{1,19})$/.exec(a.avatar_url ?? "")?.[1];

type Tag = [string, string, string];
type Picture = { url: string; width?: number; height?: number };
type Video = { url: string; type: string; width: number; height: number };

function page(o: { path: string; title: string; description: string; images?: Picture[]; video?: Video; large: boolean; author?: Author; time?: Date }): Response {
	const name = settings().instance_name;
	const url = PUBLIC_ORIGIN + o.path;
	const images = o.images?.length ? o.images : [{ url: `${PUBLIC_ORIGIN}/public/icon-dark.png` }];
	const text = (key: string, value: string): Tag[] => (value ? [["property", key, value]] : []);
	const pictureTags = images.flatMap((image): Tag[] => [
		["property", "og:image", image.url],
		...(image.width && image.height ? ([["property", "og:image:width", String(image.width)], ["property", "og:image:height", String(image.height)]] as Tag[]) : []),
	]);
	const videoTags: Tag[] = o.video
		? [
				["property", "og:video", o.video.url],
				["property", "og:video:secure_url", o.video.url],
				["property", "og:video:type", o.video.type],
				["property", "og:video:width", String(o.video.width)],
				["property", "og:video:height", String(o.video.height)],
				["name", "twitter:card", "player"],
				["name", "twitter:player", o.video.url],
				["name", "twitter:player:stream", o.video.url],
				["name", "twitter:player:stream:content_type", o.video.type],
				["name", "twitter:player:width", String(o.video.width)],
				["name", "twitter:player:height", String(o.video.height)],
			]
		: [["name", "twitter:card", o.large ? "summary_large_image" : "summary"]];
	const tags: Tag[] = [
		["property", "og:site_name", name],
		["property", "og:type", o.video ? "video.other" : o.time ? "article" : "profile"],
		["property", "og:url", url],
		["property", "og:title", o.title],
		...text("og:description", o.description),
		...pictureTags,
		...videoTags,
		...(o.time ? ([["property", "article:published_time", o.time.toISOString()]] as Tag[]) : []),
		["name", "twitter:title", o.title],
		...(o.description ? ([["name", "twitter:description", o.description]] as Tag[]) : []),
		["name", "twitter:image", images[0].url],
		...(o.description ? ([["name", "description", o.description]] as Tag[]) : []),
		["name", "theme-color", "#1d9bf0"],
	];
	const oembed = `${PUBLIC_ORIGIN}/oembed?url=${encodeURIComponent(url)}`;
	const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${esc(o.title)}</title>
${tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`).join("\n")}
<link rel="canonical" href="${esc(url)}">
<link rel="alternate" type="application/json+oembed" href="${esc(oembed)}" title="${esc(o.title)}">
<meta http-equiv="refresh" content="0;url=/">
</head><body style="background:#000;color:#e7e9ea;font-family:sans-serif"><p><a href="/" style="color:var(--xt-accent,#1d9bf0)">Sign in to ${esc(name)}</a> to see this.</p></body></html>`;
	return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}

const postTitle = (a: Author) => `${a.name} (@${a.screen_name})`;

const shown = (m: Media) => m.kind === "photo" || m.remote || existsSync(posterFile(MEDIA_DIR, m.id));

const playable = (m: Media) => m.kind !== "photo" && /^video\/(mp4|webm)$/.test(m.mime);

function postText(p: Post): string {
	const parts: string[] = [];
	const text = (p.replyTo ? p.text.replace(/^(?:@[\w]+(?:@[\w.:-]+)?\s+)+/, "") : p.text).trim();
	if (p.replyTo) parts.push(`↪ Replying to @${p.replyTo}`);
	if (text) parts.push(text);
	if (p.quote) parts.push(`↘ Quoting ${postTitle(p.quote.author)}${p.quote.text.trim() ? `\n${p.quote.text.trim()}` : ""}`);
	return clip(parts.join("\n\n"), 400);
}

function postPreview(p: Post): Response {
	const source = p.media.length || !p.quote ? { id: p.id, media: p.media } : { id: p.quote.id, media: p.quote.media };
	const pictures = source.media.filter(shown).map((m, i) => ({ url: `${PUBLIC_ORIGIN}/embed/post/${source.id}${i ? `/${i}` : ""}`, width: m.width, height: m.height }));
	const video = source.media.find(playable);
	const avatar = avatarId(p.author);
	return page({
		path: `/${p.author.screen_name}/status/${p.id}`,
		title: postTitle(p.author),
		description: postText(p),
		images: pictures.length ? pictures : avatar ? [{ url: `${PUBLIC_ORIGIN}/embed/avatar/${p.author.id}` }] : undefined,
		video: video ? { url: `${PUBLIC_ORIGIN}/embed/video/${video.id}.${video.mime === "video/webm" ? "webm" : "mp4"}`, type: video.mime, width: video.width, height: video.height } : undefined,
		large: pictures.length > 0,
		author: p.author,
		time: p.created_at,
	});
}

function profilePreview(a: Author): Response {
	return page({
		path: `/${a.screen_name}`,
		title: postTitle(a),
		description: clip(a.bio, 300) || `@${a.screen_name}`,
		images: avatarId(a) ? [{ url: `${PUBLIC_ORIGIN}/embed/avatar/${a.id}` }] : undefined,
		large: false,
		author: a,
	});
}

const handleIn = (pathname: string) => {
	const raw = /^\/([^/]{1,320})\/?$/.exec(pathname)?.[1];
	try {
		const name = raw && decodeURIComponent(raw);
		return name && /^[^\s\p{C}/\\?#@%,:]{1,50}(?:@[a-z0-9.:-]{1,260})?$/iu.test(name) ? name : undefined;
	} catch {
		return undefined;
	}
};

// a signed-out page request: the preview page, or undefined to carry on as before
export async function linkPreview(pathname: string): Promise<Response | undefined> {
	if (!feature("link_previews")) return undefined;
	const status = /^\/([^/]{1,320})\/status\/(\d{1,19})(?:\/(?:photo|video)\/\d)?\/?$/i.exec(pathname);
	if (status) {
		const post = await publicPost(status[2]);
		return post ? postPreview(post) : undefined;
	}
	const profile = handleIn(pathname);
	if (profile) {
		const author = await publicAuthor(sql`lower(screen_name) = lower(${profile})`);
		return author ? profilePreview(author) : undefined;
	}
	return undefined;
}

async function fileResponse(body: Blob | undefined, type: string): Promise<Response> {
	if (!body) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
	return new Response(body, { headers: { "content-type": servedType(type), "cache-control": "no-store", "x-content-type-options": "nosniff", "content-security-policy": MEDIA_CSP } });
}

// the pictures the preview pages name: a public post's photos or video
// frames, a public account's avatar, and a public post's video to play.
// Other uploads stay for signed-in users.
export async function embedImage(pathname: string): Promise<Response> {
	const none = new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
	if (!feature("link_previews")) return none;
	const post = /^\/embed\/post\/(\d{1,19})(?:\/([1-3]))?$/.exec(pathname);
	if (post) {
		const p = await publicPost(post[1], false);
		const m = p?.media.filter(shown)[Number(post[2] ?? 0)];
		if (!m) return none;
		return m.kind === "photo" ? fileResponse(await remoteMediaFile(m.id), m.mime) : fileResponse(await remoteMediaFile(m.id, true), "image/jpeg");
	}
	const video = /^\/embed\/video\/(\d{1,19})\.(?:mp4|webm)$/.exec(pathname);
	if (video && isId(video[1])) {
		const [owner] = await sql`select post_id::text from media where id = ${video[1]}::bigint and post_id is not null`;
		const p = owner && (await publicPost(owner.post_id, false));
		const m = p && p.media.find((x) => x.id === video[1] && playable(x));
		return m ? fileResponse(await remoteMediaFile(m.id), m.mime) : none;
	}
	const avatar = /^\/embed\/avatar\/(\d{1,19})$/.exec(pathname);
	if (avatar && isId(avatar[1])) {
		const a = await publicAuthor(sql`id = ${avatar[1]}::bigint`);
		const id = a && avatarId(a);
		if (!id || !isId(id)) return none;
		const [m] = await sql`select mime from media where id = ${id}::bigint`;
		return m ? fileResponse(await remoteMediaFile(id), m.mime) : none;
	}
	return none;
}

const count = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0).replace(/\.0$/, "")}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0).replace(/\.0$/, "")}K` : String(n));

const stats = (c: Counts) => [`💬 ${count(c.replies)}`, `🔁 ${count(c.reposts)}`, `❤️ ${count(c.likes)}`, ...(c.views ? [`👁️ ${count(c.views)}`] : [])].join("   ");

// oEmbed (oembed.com): apps such as Discord show the author line from it
export async function oembed(url: URL): Promise<Response> {
	const none = new Response("not found", { status: 404, headers: { "cache-control": "no-store" } });
	if (!feature("link_previews")) return none;
	let target: URL;
	try {
		target = new URL(url.searchParams.get("url") ?? "");
	} catch {
		return none;
	}
	if (target.origin !== PUBLIC_ORIGIN) return none;
	const status = /^\/[^/]{1,320}\/status\/(\d{1,19})/i.exec(target.pathname);
	const post = status ? await publicPost(status[1], false) : undefined;
	const author = status ? post?.author : await publicAuthor(sql`lower(screen_name) = lower(${handleIn(target.pathname) ?? ""})`);
	if (!author) return none;
	const [follows] = post
		? [undefined]
		: await sql`select (select count(*)::int from follows f where f.followee_id = ${author.id}::bigint and f.follower_id not in ${SUSPENDED}) as followers,
			(select count(*)::int from follows f where f.follower_id = ${author.id}::bigint) as following`;
	return Response.json(
		{
			version: "1.0",
			type: "link",
			title: postTitle(author),
			author_name: post ? stats(post.counts) : `👥 ${count(follows.followers)} followers   ${count(follows.following)} following`,
			author_url: post ? `${PUBLIC_ORIGIN}/${author.screen_name}/status/${post.id}` : `${PUBLIC_ORIGIN}/${author.screen_name}`,
			provider_name: settings().instance_name,
			provider_url: PUBLIC_ORIGIN,
		},
		{ headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } },
	);
}
