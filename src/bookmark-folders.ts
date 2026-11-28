// Bookmark folders: named groups of the viewer's bookmarks. Adding a post to a
// folder bookmarks it too; removing the bookmark leaves it in the folder's
// list only while it stays bookmarked.
import type { Viewer } from "./auth";
import { holdLock, sql } from "./db";
import { isId, newId } from "./ids";
import { cursorEntry, tweetEntry } from "./model";
import { PUBLIC_ORIGIN } from "./config";
import { mediaUrl, posterUrl } from "./media";
import { PostError, folderPosts, originalPostId, setMark } from "./posts";

type Vars = Record<string, any>;
export const MAX_FOLDERS = 25;

function readCursor(value: unknown): { at: string; id: string; sort: string } | undefined {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > 300) throw new PostError("Invalid folder cursor.", 214);
	try {
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		// Preserve Postgres microseconds: converting to Date would skip entries
		// when several bookmarks were added within the same millisecond.
		if (typeof cursor.at !== "string" || !/^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?[+-](?:0\d|1[0-5])(?::[0-5]\d)?$/.test(cursor.at)
			|| !Number.isFinite(Date.parse(cursor.at)) || !isId(cursor.id) || !isId(cursor.sort) || BigInt(cursor.sort) < 102n) throw new Error("cursor");
		const [year, month, day] = cursor.at.slice(0, 10).split("-").map(Number);
		if (new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) !== cursor.at.slice(0, 10)) throw new Error("cursor");
		return cursor;
	} catch {
		throw new PostError("Invalid folder cursor.", 214);
	}
}

const folderId = (vars: Vars) => {
	const id = String(vars.bookmark_collection_id ?? "");
	if (!isId(id)) throw new PostError("That folder doesn't exist.", 144);
	return id;
};

// the client lists a folder only when it has a cover picture: the newest photo
// in it, else the instance logo
const cover = (url?: string) => ({
	media_info: { __typename: "ApiImage", original_img_url: url ?? `${PUBLIC_ORIGIN}/icon-dark.png`, original_img_width: 400, original_img_height: 400 },
});
const item = (r: { id: string; name: string; cover?: string }) => ({ __typename: "BookmarkCollection", id: r.id, name: r.name, media: cover(r.cover) });

async function mine(viewerId: string, id: string) {
	const [r] = await sql`select id::text, name from bookmark_folders where id = ${id}::bigint and user_id = ${viewerId}::bigint`;
	if (!r) throw new PostError("That folder doesn't exist.", 144);
	return r as { id: string; name: string };
}

const cleanName = (v: unknown) => {
	const name = typeof v === "string" ? v.trim().slice(0, 25) : "";
	if (!name) throw new PostError("A folder needs a name.", 187);
	return name;
};

const coverUrl = (packed: string | null) => {
	if (!packed) return undefined;
	const [id, kind, mime] = packed.split(":");
	return kind === "video" ? posterUrl(id) : mediaUrl(id, mime);
};

export const bookmarkFolderHandlers = {
	BookmarkFoldersSlice: async (v: Viewer) => {
		const rows = await sql`select f.id::text, f.name,
				(select m.id::text || ':' || m.kind || ':' || m.mime from bookmark_folder_posts fp join media m on m.post_id = fp.post_id
					where fp.folder_id = f.id order by fp.created_at desc, m.position limit 1) as cover
			from bookmark_folders f where f.user_id = ${v.id}::bigint order by f.created_at`;
		return { data: { viewer: { user_results: { result: { __typename: "User", bookmark_collections_slice: { items: rows.map((r: any) => item({ ...r, cover: coverUrl(r.cover) })), slice_info: { has_next_page: false } } } } } } };
	},
	createBookmarkFolder: async (v: Viewer, vars: Vars) => {
		const name = cleanName(vars.name);
		const id = newId();
		await sql.begin(async (tx) => {
			await holdLock(tx, `bookmark-folders:${v.id}`);
			const [n] = await tx`select count(*)::int as n from bookmark_folders where user_id = ${v.id}::bigint`;
			if (n.n >= MAX_FOLDERS) throw new PostError("You have too many folders.", 214);
			await tx`insert into bookmark_folders (id, user_id, name) values (${id}::bigint, ${v.id}::bigint, ${name})`;
		});
		return { data: { bookmark_collection_create: item({ id, name }) } };
	},
	EditBookmarkFolder: async (v: Viewer, vars: Vars) => {
		const f = await mine(v.id, folderId(vars));
		const name = cleanName(vars.name);
		await sql`update bookmark_folders set name = ${name} where id = ${f.id}::bigint`;
		return { data: { bookmark_collection_update: item({ id: f.id, name }) } };
	},
	DeleteBookmarkFolder: async (v: Viewer, vars: Vars) => {
		const f = await mine(v.id, folderId(vars));
		await sql`delete from bookmark_folders where id = ${f.id}::bigint`;
		return { data: { bookmark_collection_delete: "Done" } };
	},
	bookmarkTweetToFolder: async (v: Viewer, vars: Vars) => {
		const f = await mine(v.id, folderId(vars));
		const raw = String(vars.tweet_id ?? "");
		if (!isId(raw)) throw new PostError("Invalid post id.", 144);
		const post = await originalPostId(raw);
		await setMark("bookmarks", v.id, post, true);
		await sql`insert into bookmark_folder_posts (folder_id, post_id) values (${f.id}::bigint, ${post}::bigint) on conflict do nothing`;
		return { data: { bookmark_collection_tweet_put: "Done" } };
	},
	RemoveTweetFromBookmarkFolder: async (v: Viewer, vars: Vars) => {
		const f = await mine(v.id, folderId(vars));
		const raw = String(vars.tweet_id ?? "");
		if (!isId(raw)) throw new PostError("Invalid post id.", 144);
		const post = await originalPostId(raw);
		await sql`delete from bookmark_folder_posts where folder_id = ${f.id}::bigint and post_id = ${post}::bigint`;
		return { data: { bookmark_collection_tweet_delete: "Done" } };
	},
	BookmarkFolderTimeline: async (v: Viewer, vars: Vars) => {
		const f = await mine(v.id, folderId(vars));
		const before = readCursor(vars.cursor);
		const { posts, next } = await folderPosts(v.id, f.id, 100, before);
		const base = BigInt(before?.sort ?? newId());
		const entries: unknown[] = posts.map((p, i) => tweetEntry(p, (base - BigInt(i) - 1n).toString()));
		if (next) {
			const sort = (base - BigInt(posts.length) - 2n).toString();
			entries.push(cursorEntry("Bottom", Buffer.from(JSON.stringify({ ...next, sort })).toString("base64url"), sort));
		}
		return { data: { bookmark_collection_timeline: { timeline: { instructions: [{ type: "TimelineAddEntries", entries }], responseObjects: {} } } } };
	},
};
