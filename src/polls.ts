// Polls are cards: the composer creates the card first (caps /v2/cards/create),
// then posts with card_uri. Voting goes through the card passthrough endpoint.

import { sql } from "./db";
import { isId, newId } from "./ids";
import { mediaUrl } from "./media";
import { forbiddenText } from "./names";

const MAX_LABEL = 25;
const MIN_DURATION = 5;
const MAX_DURATION = 10080;
// the composer's card name for a poll with a photo on its choices (any count)
export const IMAGE_POLL = "1906814671912599552:poll_choice_images";

export class PollError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

type PollRow = {
	id: string;
	choices: string[];
	duration_minutes: number;
	ends_at: Date | null;
	counts: number[];
	voted: number | null;
	// image polls: each choice's photo, in choice order
	images?: ({ id: string; mime: string; width: number; height: number } | null)[] | null;
};

const text = (v: string) => ({ type: "STRING", string_value: v });

// binding values as the graphql card (array of { key, value }) and the
// passthrough response (object by key) both need them
function bindings(p: PollRow): Record<string, unknown> {
	const ended = !!p.ends_at && p.ends_at.getTime() <= Date.now();
	const out: Record<string, unknown> = {};
	p.choices.forEach((label, i) => {
		out[`choice${i + 1}_label`] = text(label);
		out[`choice${i + 1}_count`] = text(String(p.counts[i] ?? 0));
		const img = p.images?.[i];
		if (img) out[`choice${i + 1}_image`] = { type: "IMAGE", image_value: { url: mediaUrl(img.id, img.mime), width: img.width, height: img.height } };
	});
	if (p.images) out.choice_count = text(String(p.choices.length));
	out.counts_are_final = { type: "BOOLEAN", boolean_value: ended };
	out.duration_minutes = text(String(p.duration_minutes));
	if (p.ends_at) out.end_datetime_utc = text(p.ends_at.toISOString());
	out.last_updated_datetime_utc = text(new Date().toISOString());
	out.api = text("capi://passthrough/1");
	out.card_url = text("https://twitter.com");
	if (p.voted) out.selected_choice = text(String(p.voted));
	return out;
}

const cardName = (p: PollRow) => (p.images ? IMAGE_POLL : `poll${p.choices.length}choice_text_only`);

export function pollCard(p: PollRow) {
	return {
		rest_id: `card://${p.id}`,
		legacy: {
			binding_values: Object.entries(bindings(p)).map(([key, value]) => ({ key, value })),
			card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
			name: cardName(p),
			url: `card://${p.id}`,
			user_refs_results: [],
		},
	};
}

export async function pollsByIds(viewerId: string, ids: string[]): Promise<Map<string, PollRow>> {
	if (!ids.length) return new Map();
	const rows = await sql`select p.id::text, p.choices, p.duration_minutes, p.ends_at,
			case when p.choice_media is null then null else (select json_agg(case when m.id is null then null else json_build_object('id', m.id::text, 'mime', m.mime, 'width', m.width, 'height', m.height) end order by c.n)
				from unnest(p.choice_media) with ordinality as c(media_id, n) left join media m on m.id = c.media_id) end as images,
			coalesce((select array_agg(c.n order by c.choice) from (
				select g.choice, count(v.user_id)::int as n from generate_series(1, array_length(p.choices, 1)) as g(choice)
				left join poll_votes v on v.poll_id = p.id and v.choice = g.choice group by g.choice) c), '{}') as counts,
			(select v.choice from poll_votes v where v.poll_id = p.id and v.user_id = ${viewerId}::bigint) as voted
		from polls p where p.id = any(${sql.array(ids, "INT8")})`;
	return new Map(rows.map((r: any) => [r.id as string, r as PollRow]));
}

export async function createCard(userId: string, raw: unknown): Promise<{ status: string; card_uri: string }> {
	if (String(raw ?? "").length > 20_000) throw new PollError("card_data is too large.");
	const [recent] = await sql`select count(*)::int as n from polls where user_id = ${userId}::bigint and created_at > now() - interval '1 hour'`;
	if (recent.n >= 60) throw new PollError("You've made too many polls. Try again later.", 429);
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(String(raw));
	} catch {
		throw new PollError("card_data must be JSON.");
	}
	const kind = String(data["twitter:card"] ?? "");
	// an image poll names no count: as many choices as have labels
	const image = kind === IMAGE_POLL;
	const n = image ? [1, 2, 3, 4].filter((i) => String(data[`twitter:string:choice${i}_label`] ?? "").trim()).length : Number(/^poll([234])choice_text_only$/.exec(kind)?.[1]);
	if (!n || n < 2 || n > 4) throw new PollError(image ? "A poll has 2 to 4 choices." : "Only text and image polls are supported.");
	const choices: string[] = [];
	for (let i = 1; i <= n; i++) {
		const label = String(data[`twitter:string:choice${i}_label`] ?? "").trim();
		if (!label) throw new PollError("Every choice needs a label.");
		if ([...label].length > MAX_LABEL) throw new PollError(`Choices can be up to ${MAX_LABEL} characters.`);
		if (forbiddenText(label)) throw new PollError("A choice contains a word this instance doesn't allow.");
		choices.push(label);
	}
	const duration = Number(data["twitter:long:duration_minutes"] ?? 1440);
	if (!Number.isInteger(duration) || duration < MIN_DURATION || duration > MAX_DURATION) throw new PollError("A poll runs from 5 minutes to 7 days.");
	// "mis://<media id>": a photo the viewer uploaded, not yet in any post
	let media: (string | null)[] | null = null;
	if (image) {
		media = choices.map((_, i) => /^mis:\/\/(\d{1,19})$/.exec(String(data[`twitter:image:choice${i + 1}_image:src:id`] ?? ""))?.[1] ?? null);
		const given = media.filter((m): m is string => !!m);
		if (!given.length) throw new PollError("An image poll needs at least one image.");
		const ok = await sql`select id::text from media where id = any(${sql.array(given, "INT8")}) and user_id = ${userId}::bigint and kind = 'photo' and post_id is null and state = 'ready'`;
		if (ok.length !== new Set(given).size) throw new PollError("Choice images must be photos you just uploaded.");
	}
	const id = newId();
	await sql`insert into polls (id, user_id, choices, duration_minutes) values (${id}::bigint, ${userId}::bigint, ${sql.array(choices, "TEXT")}, ${duration})`;
	// a choice without a photo keeps 0, which matches no upload
	if (media) await sql`update polls set choice_media = ${sql.array(media.map((m) => m ?? "0"), "INT8")} where id = ${id}::bigint`;
	return { status: "OK", card_uri: `card://${id}` };
}

// the post being created takes the card; its clock starts now
export async function attachPoll(userId: string, postId: string, cardUri: string): Promise<void> {
	const id = /^card:\/\/(\d{1,19})$/.exec(cardUri)?.[1];
	if (!id) throw new PollError("Unknown card.");
	const rows = await sql`update polls set ends_at = now() + make_interval(mins => duration_minutes)
		where id = ${id}::bigint and user_id = ${userId}::bigint and ends_at is null returning id`;
	if (!rows.length) throw new PollError("That poll can't be used.");
	await sql`update posts set poll_id = ${id}::bigint where id = ${postId}::bigint`;
}

export async function vote(viewerId: string, form: FormData): Promise<Record<string, unknown>> {
	const uri = String(form.get("twitter:string:card_uri") ?? "");
	const id = /^card:\/\/(\d{1,19})$/.exec(uri)?.[1];
	const choice = Number(form.get("twitter:string:selected_choice"));
	if (!id || !isId(id)) throw new PollError("Unknown card.", 404);
	const poll = (await pollsByIds(viewerId, [id])).get(id);
	if (!poll || !poll.ends_at) throw new PollError("Unknown card.", 404);
	if (!Number.isInteger(choice) || choice < 1 || choice > poll.choices.length) throw new PollError("Pick one of the choices.");
	if (poll.ends_at.getTime() <= Date.now()) throw new PollError("This poll has ended.");
	await sql`insert into poll_votes (poll_id, user_id, choice) values (${id}::bigint, ${viewerId}::bigint, ${choice}) on conflict do nothing`;
	const fresh = (await pollsByIds(viewerId, [id])).get(id)!;
	return {
		card: {
			name: cardName(fresh),
			url: `card://${id}`,
			card_type_url: "http://card-dev.twitter.com/v2/card.json",
			binding_values: bindings(fresh),
			card_platform: { platform: { audience: { name: "production" }, device: { name: "Swift", version: "12" } } },
		},
	};
}
