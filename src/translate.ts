import type { Viewer } from "./auth";
import { sql } from "./db";
import { isId } from "./ids";
import { readJson } from "./federation";
import { bioEntities, urlEntities } from "./links";
import { MENTION_HANDLE } from "./mentions";
import { bioMentions, hashtags, userMentions } from "./model";
import { getPost } from "./posts";
import { userById } from "./users";

const ENDPOINT = "https://translate-pa.googleapis.com/v1/translateHtml";
const API_KEY = "AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520";
const TIMEOUT_MS = 8000;
const MAX_CHARS = 30_000;

const LANG_RE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
export const isValidLang = (code: unknown): code is string => typeof code === "string" && LANG_RE.test(code);

const escapeHtml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\n", "<br>");

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

const unescapeHtml = (s: string) =>
	s
		.replace(/<br\s*\/?>\s?/gi, "\n")
		.replace(/<\/span>\s+(?=[,.!?;:])/g, "")
		.replace(/<[^>]*>/g, "")
		.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (m, ref: string) => {
			if (ref[0] !== "#") return NAMED[ref.toLowerCase()] ?? m;
			const cp = ref[1] === "x" || ref[1] === "X" ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
			return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
		});

const KEEP = new RegExp(`https?:\\/\\/\\S+|#[\\p{L}\\p{N}_]+|${MENTION_HANDLE.source}`, "giu");

const protectedHtml = (text: string) => {
	let out = "";
	let at = 0;
	for (const m of text.matchAll(KEEP)) {
		out += `${escapeHtml(text.slice(at, m.index))}<span translate="no">${escapeHtml(m[0])}</span>`;
		at = m.index + m[0].length;
	}
	return out + escapeHtml(text.slice(at));
};

export async function googleTranslate(text: string, target: string, source = "auto"): Promise<{ text: string; source: string } | undefined> {
	try {
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json+protobuf", "x-goog-api-key": API_KEY },
			body: JSON.stringify([[[protectedHtml(text)], source, target], "te_lib"]),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
		if (!res.ok) return undefined;
		const data = await readJson(res, 1024 * 1024);
		if (!Array.isArray(data) || !Array.isArray(data[0]) || typeof data[0][0] !== "string") return undefined;
		const detected = Array.isArray(data[1]) && typeof data[1][0] === "string" ? data[1][0] : source;
		return { text: unescapeHtml(data[0][0]), source: detected };
	} catch {
		return undefined;
	}
}

const languageName = (code: string, inLang: string) => {
	try {
		return new Intl.DisplayNames([inLang], { type: "language" }).of(code) ?? code;
	} catch {
		return code;
	}
};

const hashOf = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const TRANSLATE_TWEET = /strato\/column\/None\/tweetId=(\d{1,19}),destinationLanguage=(None|Some\(([A-Za-z-]{2,10})\)),[^/]*\/translation\/service\/translateTweet$/;
const TRANSLATE_PROFILE = /strato\/column\/None\/profileUserId=(\d{1,19}),destinationLanguage=(None|Some\(([A-Za-z-]{2,10})\)),[^/]*\/translation\/service\/translateProfile$/;
export const isTranslateRequest = (path: string) => /\/translation\/service\/translate(Tweet|Profile)$/.test(path);

const failure = (status: number, code: number, message: string) => Response.json({ errors: [{ code, message }] }, { status });

export async function translateRoute(path: string, viewer: Viewer): Promise<Response | undefined> {
	if (!isTranslateRequest(path)) return undefined;
	let decoded = path;
	try {
		decoded = decodeURIComponent(path);
	} catch {}
	const profile = TRANSLATE_PROFILE.exec(decoded);
	if (profile) return translateProfile(profile, viewer);
	const m = TRANSLATE_TWEET.exec(decoded);
	if (!m || !isId(m[1])) return failure(400, 214, "That translation request isn't valid.");
	const target = isValidLang(m[3]) ? m[3] : isValidLang(viewer.language) ? viewer.language : "en";
	const post = await getPost(viewer.id, m[1]);
	if (!post) return failure(404, 144, "No status found with that ID.");
	if (!post.text.trim() || post.text.length > MAX_CHARS) return failure(400, 214, "This post can't be translated.");
	const baseId = post.staleEditOf ?? post.id;
	const [old] = post.staleEditOf ? await sql`select seq from post_versions where version_id = ${post.id}::bigint` : [];
	const version = old ? Number(old.seq) : (post.edit_count ?? 0);
	const hash = hashOf(post.text);
	const [hit] = await sql`select source_lang, text from post_translations
		where post_id = ${baseId}::bigint and version = ${version} and target_lang = ${target} and source_hash = ${hash}`;
	let translated: { text: string; source: string } | undefined = hit ? { text: hit.text, source: hit.source_lang } : undefined;
	if (!translated) {
		translated = await googleTranslate(post.text, target);
		if (!translated) return failure(503, 131, "Translation isn't available right now. Try again later.");
		await sql`insert into post_translations (post_id, version, target_lang, source_hash, source_lang, text)
			values (${baseId}::bigint, ${version}, ${target}, ${hash}, ${translated.source}, ${translated.text})
			on conflict (post_id, version, target_lang) do update set source_hash = excluded.source_hash, source_lang = excluded.source_lang, text = excluded.text, created_at = now()`.catch(() => {});
	}
	const text = translated.text;
	return Response.json({
		id: post.id,
		id_str: post.id,
		translation: text,
		entities: {
			hashtags: hashtags(text),
			user_mentions: userMentions({ ...post, text }),
			urls: urlEntities(text, undefined, post.localLinks),
			symbols: [],
		},
		translationState: "Success",
		sourceLanguage: translated.source,
		localizedSourceLanguage: languageName(translated.source, target),
		destinationLanguage: target,
		translationSource: "Google",
	});
}

async function translateProfile(m: RegExpExecArray, viewer: Viewer): Promise<Response> {
	if (!isId(m[1])) return failure(400, 214, "That translation request isn't valid.");
	const target = isValidLang(m[3]) ? m[3] : isValidLang(viewer.language) ? viewer.language : "en";
	const user = await userById(viewer.id, m[1]);
	if (!user || user.status === "suspended" || user.stats?.blockedBy) return failure(404, 50, "User not found.");
	const bio = user.bio?.trim() ?? "";
	if (!bio || bio.length > MAX_CHARS) return failure(400, 214, "This bio can't be translated.");
	const hash = hashOf(bio);
	const [hit] = await sql`select source_lang, text from bio_translations
		where user_id = ${user.id}::bigint and target_lang = ${target} and source_hash = ${hash}`;
	let translated: { text: string; source: string } | undefined = hit ? { text: hit.text, source: hit.source_lang } : undefined;
	if (!translated) {
		translated = await googleTranslate(bio, target);
		if (!translated) return failure(503, 131, "Translation isn't available right now. Try again later.");
		await sql`insert into bio_translations (user_id, target_lang, source_hash, source_lang, text)
			values (${user.id}::bigint, ${target}, ${hash}, ${translated.source}, ${translated.text})
			on conflict (user_id, target_lang) do update set source_hash = excluded.source_hash, source_lang = excluded.source_lang, text = excluded.text, created_at = now()`.catch(() => {});
	}
	const text = translated.text;
	return Response.json({
		profileUserId: user.id,
		profileTranslation: {
			translation: text,
			entities: { urls: bioEntities(text), user_mentions: bioMentions({ ...user, bio: text }), hashtags: hashtags(text), symbols: [] },
			translationState: "Success",
			sourceLanguage: translated.source,
			localizedSourceLanguage: languageName(translated.source, target),
			destinationLanguage: target,
			translationSource: "Google",
		},
	});
}
