import type { Viewer } from "./auth";
import { sql } from "./db";
import { isId, newId } from "./ids";
import { blockedFor, isBlockedEitherWay, outOfView, protectedFor } from "./blocks";
import { getPost, postsByIds, PostError, refuseHate } from "./posts";
import { noteText, tweetEntry, tweetResult } from "./model";
import { feature } from "./settings";

function id(value: unknown): string {
	if (!isId(value)) throw new PostError("Invalid note or post id.", 144);
	return value as string;
}

async function visible(v: Viewer, postId: string, write = false) {
	const post = await getPost(v.id, id(postId));
	if (!post || post.author.status === "suspended" || await isBlockedEitherWay(v.id, post.author.id)) throw new PostError("This post isn't available.", 144);
	if (write && v.status !== "active") throw new PostError("Your account can't contribute right now.", 326);
	return post;
}

async function membership(v: Viewer) {
	const [user] = await sql`select notes_writer from users where id = ${v.id}::bigint`;
	return (!!user?.notes_writer || feature("notes_everyone")) && v.status === "active";
}

async function profile(v: Viewer, alias?: string) {
	const [user] = await sql`select id::text, notes_alias, notes_writer from users where ${alias === undefined ? sql`id = ${v.id}::bigint` : sql`notes_alias = ${alias}`}`;
	if (!user || await isBlockedEitherWay(v.id, user.id)) return null;
	const [counts] = await sql`select count(*) filter(where ratings < 3 or (helpful * 3 < ratings * 2 and not_helpful * 3 < ratings * 2))::int as awaiting_more_ratings,
		count(*) filter(where ratings >= 3 and helpful * 3 >= ratings * 2)::int as currently_rated_helpful,
		count(*) filter(where ratings >= 3 and not_helpful * 3 >= ratings * 2)::int as currently_rated_not_helpful from (
		select n.id, count(voter.id) as ratings, count(voter.id) filter(where r.rating = 'Helpful') as helpful, count(voter.id) filter(where r.rating = 'NotHelpful') as not_helpful
		from community_notes n left join community_note_ratings r on r.note_id = n.id left join users voter on voter.id = r.user_id and voter.status = 'active'
		where n.author_id = ${user.id}::bigint group by n.id) scores`;
	return { alias: user.notes_alias, can_write_notes: (!!user.notes_writer || feature("notes_everyone")) && v.status === "active", user_enrollment: { enrollment_state: user.notes_writer || feature("notes_everyone") ? "EarnedIn" : "NewUser", writing_impact: 0, rating_impact: 0 },
		notes_count: { ...counts, last_updated_at: Date.now() }, ratings_count: { last_updated_at: Date.now(), successful: {}, unsuccessful: {} },
		notification_settings: { needs_your_help_frequency: "Never" }, user_settings: { show_in_app_navigation: true }, is_top_writer: false, is_api_contributor: false,
	};
}

export async function notesFor(v: Viewer, postId: string) {
	await visible(v, postId);
	return (await notesMany(v, [postId])).get(postId) ?? [];
}

async function notesMany(v: Viewer, postIds: string[], noteIds?: string[]) {
	if (!postIds.length) return new Map<string, any[]>();
	const rows = await sql`select n.id::text, n.post_id::text, n.author_id::text, n.text, n.classification, n.created_at, n.data_v1, u.notes_alias as alias,
		count(r.user_id)::int as ratings, count(r.user_id) filter(where r.rating = 'Helpful')::int as helpful,
		count(r.user_id) filter(where r.rating = 'NotHelpful')::int as not_helpful,
		max(r.rating) filter(where r.user_id = ${v.id}::bigint) as viewer_rating,
		(jsonb_agg(r.data_v2) filter(where r.user_id = ${v.id}::bigint))->0 as viewer_data
		from community_notes n left join (select x.* from community_note_ratings x join users voter on voter.id = x.user_id and voter.status = 'active') r on r.note_id = n.id
		join users u on u.id = n.author_id and u.status <> 'suspended'
		where n.post_id = any(${sql.array(postIds, "INT8")}) and ${noteIds ? sql`n.id = any(${sql.array(noteIds, "INT8")})` : sql`true`} and n.author_id not in ${blockedFor(v.id)} group by n.id, u.notes_alias order by n.id desc`;
	const result = new Map<string, any[]>();
	for (const n of rows) {
		const list = result.get(n.post_id) ?? [];
		if (list.length < 100 || n.author_id === v.id) list.push({ ...n, own: n.author_id === v.id, status: n.ratings >= 3 && n.helpful / n.ratings >= 2 / 3 ? "Helpful" : n.ratings >= 3 && n.not_helpful / n.ratings >= 2 / 3 ? "NotHelpful" : "NeedsMoreRatings" });
		result.set(n.post_id, list);
	}
	return result;
}

const entity = (n: any, post?: any) => ({
	__typename: "BirdwatchNote", rest_id: n.id, tweet_id: n.post_id, alias: n.alias,
	created_at: new Date(n.created_at).getTime(), status: n.status,
	rating_status: n.status === "Helpful" ? "CurrentlyRatedHelpful" : n.status === "NotHelpful" ? "CurrentlyRatedNotHelpful" : "NeedsMoreRatings",
	data_v1: { ...n.data_v1, summary: noteText(n.text), classification: n.classification === "Misleading" ? "MisinformedOrPotentiallyMisleading" : "NotMisleading" },
	rating: n.viewer_rating ? { __typename: "BirdwatchNoteRating", data_v2: { ...n.viewer_data, helpfulness_level: n.viewer_rating } } : null,
	birdwatch_profile: { alias: n.alias, notes_count: { awaiting_more_ratings: 0, currently_rated_helpful: 0, currently_rated_not_helpful: 0, last_updated_at: Date.now() }, ratings_count: { last_updated_at: Date.now(), successful: {}, unsuccessful: {} } },
	above_pcrh_threshold: false, appeal_status: "NotAppealed", can_appeal: false, decided_by: "XitterLocalRatings", fully_visible_model: true,
	is_api_author: false, is_community_note_translatable: false, is_media_note: false, language: "en", helpful_tags: [],
	grok_translated_community_note_with_availability: { is_available: false },
	...(post ? { tweet_results: { result: tweetResult(post) } } : {}),
});

async function target(v: Viewer, noteId: string, write = false) {
	const [note] = await sql`select n.id::text, n.post_id::text, n.author_id::text from community_notes n join users u on u.id = n.author_id and u.status <> 'suspended' where n.id = ${id(noteId)}::bigint`;
	if (!note) throw new PostError("No such note.", 144);
	if (await isBlockedEitherWay(v.id, note.author_id)) throw new PostError("This note isn't available.", 144);
	await visible(v, note.post_id, write);
	return note;
}

export const noteHandlers = {
	BirdwatchFetchGlobalTimeline: async (v: Viewer) => {
		const rows = await sql`select p.id::text from posts p where (exists(select 1 from community_notes n where n.post_id = p.id) or exists(select 1 from community_note_requests r where r.post_id = p.id))
			and p.user_id not in ${blockedFor(v.id)} and p.user_id not in ${outOfView(v.id)} order by p.id desc limit 50`;
		const posts = await postsByIds(v.id, rows.map((r: any) => r.id));
		const entries = rows.flatMap((r: any) => posts.get(r.id) ? [tweetEntry(posts.get(r.id)!, r.id)] : []);
		return { data: { viewer: { birdwatch_home_page: { id: "xitter-community-notes", title: "Community Notes", body: { __typename: "Timeline", timeline: { instructions: [{ type: "TimelineAddEntries", entries }] } } } } } };
	},
	BirdwatchFetchCanTweetBeMediaNote: async (v: Viewer, vars: any) => {
		const post = await visible(v, vars.tweetId);
		return { data: { tweet_result_by_rest_id: { result: { rest_id: post.id, can_be_media_note: false, can_be_url_note: false, media_note_category: "Unsupported", note_match_url: null } } } };
	},
	BirdwatchFetchBatSignal: async (v: Viewer, vars: any) => {
		await visible(v, vars.tweet_id);
		const [r] = await sql`select min(created_at) as created_at from community_note_requests where post_id = ${vars.tweet_id}::bigint`;
		return { data: { birdwatch_bat_signal_by_rest_id: { created_at: r.created_at ? new Date(r.created_at).getTime() : null, has_live_note: false } } };
	},
	XitterPostContext: async (v: Viewer, vars: any) => {
		const ids = [...new Set((Array.isArray(vars.ids) ? vars.ids : []).filter(isId))].slice(0, 20) as string[];
		if (!ids.length) return { data: { xitter_post_context: [] } };
		const posts = await sql`select id::text, source from posts where id = any(${sql.array(ids, "INT8")}) and (not hidden or exists (select 1 from users staff where staff.id = ${v.id}::bigint and staff.role is not null)) and user_id not in ${blockedFor(v.id)} and user_id not in ${outOfView(v.id)} and user_id not in ${protectedFor(v.id)}`;
		const visibleIds = posts.map((p: any) => p.id);
		const notes = await notesMany(v, visibleIds);
		const requests = visibleIds.length ? await sql`select post_id::text, count(*)::int as count, bool_or(user_id = ${v.id}::bigint) as own from community_note_requests where post_id = any(${sql.array(visibleIds, "INT8")}) group by post_id` : [];
		const byPost = new Map(requests.map((r: any) => [r.post_id, r]));
		const canWrite = await membership(v);
		return { data: { xitter_post_context: posts.map((p: any) => ({ ...p, can_write_notes: canWrite, notes: (notes.get(p.id) ?? []).map(({ author_id, ...n }: any) => n), requests: byPost.get(p.id)?.count ?? 0, requested: !!byPost.get(p.id)?.own })) } };
	},
	BirdwatchCreateNote: async (v: Viewer, vars: any) => {
		await visible(v, vars.tweet_id, true);
		if (!await membership(v)) throw new PostError("Community Notes writing access is required.", 403);
		const data = vars.data_v1 ?? {};
		const text = typeof data.summary === "string" ? data.summary.trim() : typeof data.summary?.text === "string" ? data.summary.text.trim() : "";
		if (!text || [...text].length > 500) throw new PostError("Notes must contain 1–500 characters.", 186);
		await refuseHate(v.id, text, "note");
		const classification = data.classification === "MisinformedOrPotentiallyMisleading" ? "Misleading" : data.classification ?? "Misleading";
		if (!["Misleading", "NotMisleading"].includes(classification)) throw new PostError("Invalid classification.", 144);
		const tags = (key: string) => Array.isArray(data[key]) ? data[key].filter((x: unknown) => typeof x === "string" && x.length < 60).slice(0, 20) : [];
		const details = { trustworthy_sources: data.trustworthy_sources === true, misleading_tags: tags("misleading_tags"), not_misleading_tags: tags("not_misleading_tags") };
		const rows = await sql`insert into community_notes(id, post_id, author_id, text, classification, data_v1)
			values(${newId()}::bigint, ${vars.tweet_id}::bigint, ${v.id}::bigint, ${text}, ${classification}, ${JSON.stringify(details)}::text::jsonb)
			on conflict(post_id, author_id) do nothing returning id::text`;
		if (!rows.length) throw new PostError("You already wrote a note on this post.", 187);
		const note = (await notesFor(v, vars.tweet_id)).find((n: any) => n.id === rows[0].id);
		return { data: { birdwatchnote_create_v2: { type: "BirdwatchNote", note: entity(note), rest_id: rows[0].id } } };
	},
	BirdwatchCreateRating: async (v: Viewer, vars: any) => {
		const note = await target(v, vars.note_id, true);
		if (note.author_id === v.id) throw new PostError("You can't rate your own note.", 144);
		const rating = vars.data_v2?.helpfulness_level;
		if (!["Helpful", "SomewhatHelpful", "NotHelpful"].includes(rating)) throw new PostError("Invalid rating.", 144);
		const tags = (key: string) => Array.isArray(vars.data_v2[key]) ? vars.data_v2[key].filter((x: unknown) => typeof x === "string" && x.length < 60).slice(0, 20) : [];
		const data = { helpfulness_level: rating, helpful_tags: tags("helpful_tags"), not_helpful_tags: tags("not_helpful_tags") };
		await sql`insert into community_note_ratings(note_id, user_id, rating, data_v2) values(${note.id}::bigint, ${v.id}::bigint, ${rating}, ${JSON.stringify(data)}::text::jsonb)
			on conflict(note_id, user_id) do update set rating = excluded.rating, data_v2 = excluded.data_v2`;
		return { data: { birdwatchnote_rate_v3: { __typename: "BirdwatchNoteRating", data_v2: data } } };
	},
	BirdwatchDeleteRating: async (v: Viewer, vars: any) => {
		const note = await target(v, vars.note_id, true);
		await sql`delete from community_note_ratings where note_id = ${note.id}::bigint and user_id = ${v.id}::bigint`;
		return { data: { birdwatchnote_rating_delete: "Done" } };
	},
	BirdwatchDeleteNote: async (v: Viewer, vars: any) => {
		const note = await target(v, vars.note_id, true);
		if (note.author_id !== v.id && !["admin", "moderator"].includes(v.role ?? "")) throw new PostError("You can't delete this note.", 144);
		if (note.author_id !== v.id) await sql`insert into audit_log(id, actor_id, action, target, detail) values(${newId()}::bigint, ${v.id}::bigint, 'delete_community_note', ${note.id}, ${JSON.stringify({ post_id: note.post_id })}::text::jsonb)`;
		await sql`delete from community_notes where id = ${note.id}::bigint`;
		return { data: { birdwatchnote_delete: true } };
	},
	BirdwatchCreateBatSignal: async (v: Viewer, vars: any) => {
		await visible(v, vars.tweet_id, true);
		const suggestion = typeof vars.suggestion === "string" ? vars.suggestion.trim() : "";
		const source = typeof vars.source_link === "string" ? vars.source_link.trim() : "";
		if ([...suggestion].length > 500 || source.length > 2048 || (source && !/^https?:\/\/[^\s<>]+$/.test(source))) throw new PostError("Invalid request source or explanation.", 144);
		await refuseHate(v.id, suggestion, "note");
		const [r] = await sql`insert into community_note_requests(post_id, user_id, source_link, suggestion) values(${vars.tweet_id}::bigint, ${v.id}::bigint, ${source || null}, ${suggestion || null})
			on conflict(post_id,user_id) do update set source_link = excluded.source_link, suggestion = excluded.suggestion returning created_at`;
		return { data: { birdwatchbatsignal_create: { type: "BirdwatchBatSignal", created_at: String(new Date(r.created_at).getTime()) } } };
	},
	BirdwatchDeleteBatSignal: async (v: Viewer, vars: any) => {
		await visible(v, vars.tweet_id, true);
		await sql`delete from community_note_requests where post_id = ${vars.tweet_id}::bigint and user_id = ${v.id}::bigint`;
		return { data: { birdwatchbatsignal_delete: true } };
	},
	BirdwatchFetchNotes: async (v: Viewer, vars: any) => {
		const post = await visible(v, vars.tweet_id);
		const notes = await notesFor(v, vars.tweet_id);
		return { data: { tweet_result_by_rest_id: { result: { ...tweetResult(post), tweet_id: post.id, can_user_write_notes_on_post_author: true,
			misleading_birdwatch_notes: { notes: notes.filter((n: any) => n.classification === "Misleading").map((n: any) => entity(n, post)) },
			not_misleading_birdwatch_notes: { notes: notes.filter((n: any) => n.classification !== "Misleading").map((n: any) => entity(n, post)) },
			self_birdwatch_note: notes.find((n: any) => n.own) ? entity(notes.find((n: any) => n.own)) : null } } } };
	},
	BirdwatchFetchOneNote: async (v: Viewer, vars: any) => {
		const note = await target(v, vars.note_id);
		const value = (await notesMany(v, [note.post_id], [note.id])).get(note.post_id)?.[0];
		if (!value) throw new PostError("No such note.", 144);
		return { data: { birdwatch_note_by_rest_id: entity(value, await getPost(v.id, note.post_id)) } };
	},
	BirdwatchFetchContributorNotesSlice: async (v: Viewer, vars: any) => {
		const alias = typeof vars.alias === "string" ? vars.alias.slice(0, 80) : "";
		const before = isId(vars.cursor) ? vars.cursor : "9223372036854775807";
		const rows = await sql`select n.id::text, n.post_id::text from community_notes n join users u on u.id = n.author_id join posts p on p.id = n.post_id
			where u.notes_alias = ${alias} and n.id < ${before}::bigint and n.author_id not in ${blockedFor(v.id)} and p.user_id not in ${blockedFor(v.id)} and p.user_id not in ${outOfView(v.id)} order by n.id desc limit 11`;
		const page = rows.slice(0, 10), ids = page.map((r: any) => r.post_id);
		const values = await notesMany(v, ids, page.map((r: any) => r.id)), posts = await postsByIds(v.id, ids);
		const notes = page.flatMap((r: any) => { const note = values.get(r.post_id)?.find((n: any) => n.id === r.id), post = posts.get(r.post_id); return note && post ? [entity(note, post)] : []; });
		return { data: { birdwatch_profile_by_alias: { alias, notes_slice: { notes, slice_info: rows.length > 10 ? { next_cursor: page.at(-1)!.id } : {} } } } };
	},
	BirdwatchFetchAuthenticatedUserProfile: async (v: Viewer) => ({ data: { authenticated_user_birdwatch_profile: await profile(v) } }),
	BirdwatchFetchAliasSelfSelectStatus: () => ({ data: { authenticated_user_birdwatch_alias_self_select_status: { can_select: false, has_selected: true } } }),
	BirdwatchFetchBirdwatchProfile: async (v: Viewer, vars: any) => ({ data: { birdwatch_profile_by_alias: typeof vars.alias === "string" ? await profile(v, vars.alias.slice(0, 80)) : null } }),
	BirdwatchFetchSignUpEligiblity: async (v: Viewer) => ({ data: { birdwatch_sign_up_eligibility: { eligible: false, has_already_signed_up: await membership(v), has_eligible_phone: false, has_no_recent_twitter_rules_violations: true, has_unique_phone: true, has_verified_email_address: false, has_verified_phone: false, meets_account_age_minimum: true } } }),
};
