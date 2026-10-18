// Blocked names (admin panel > Settings): words no handle or display name may
// contain. Sign-up with one is refused; an account that renames itself to one
// is suspended on the spot. Matching ignores case, accents, separators,
// look-alike digits and symbols, and extra repeats, so "N_1-gggg3rr" matches
// "nigger". A doubled letter in the word still needs two in the name, or
// "nigger" would block "Nigeria".

import { sql } from "./db";
import { newId } from "./ids";
import { LOOKALIKE, foldGlyphs } from "./fold";
import { hasBlockedPhrase, settings } from "./settings";

export { foldGlyphs };

// lowercase letters plus the look-alike digits and symbols; repeats are kept
export function normalizeName(text: string): string {
	return foldGlyphs(text).replace(/[^\p{L}0-9!|@$+]/gu, "");
}

// "nigger" -> n+[i1!|]+[g96]{2,}[e3]+r+
function wordPattern(word: string): RegExp {
	const letters = word.replace(/[^\p{L}]/gu, "");
	return new RegExp(letters.replace(/(\p{L})\1*/gu, (run, c) => {
		const cls = LOOKALIKE[c] ? `[${c}${LOOKALIKE[c].replace(/[|$+]/g, "\\$&")}]` : c;
		return run.length > 1 ? `${cls}{${run.length},}` : `${cls}+`;
	}), "u");
}

// the first blocked word the text contains, if any
export function blockedNameIn(...texts: string[]): string | undefined {
	const words = settings().operations.blocked_names.filter((w) => /\p{L}/u.test(normalizeName(w)));
	if (!words.length) return undefined;
	const all = texts.map(normalizeName);
	return words.find((w) => {
		const re = wordPattern(normalizeName(w));
		return all.some((t) => re.test(t));
	});
}

// Longer text (bio, location, links, list and community names) is read word
// by word: ignoring spaces as for a name would find "coon" in "taco only".
// Letters spelled out one at a time ("n i g g e r", "n.i.g.g.e.r") are joined
// back into one word first.
function wordsOf(text: string): string[] {
	const parts = foldGlyphs(text)
		.split(/[\s.,/\\?#&=:;()"'<>[\]{}*~^`-]+/u)
		.map((p) => p.replace(/[^\p{L}0-9!|@$+]/gu, ""))
		.filter(Boolean);
	const out: string[] = [];
	let run = "";
	for (const p of parts) {
		// one letter, maybe with a look-alike symbol stuck to it ("x!")
		if ([...p].length <= 2 && [...p.replace(/[^\p{L}0-9]/gu, "")].length <= 1) {
			run += p;
			continue;
		}
		if (run) out.push(run);
		run = "";
		out.push(p);
	}
	if (run) out.push(run);
	return out;
}

// the first blocked name word in longer text, if any
export function blockedWordIn(...texts: string[]): string | undefined {
	const words = settings().operations.blocked_names.filter((w) => /\p{L}/u.test(normalizeName(w)));
	if (!words.length) return undefined;
	const all = texts.flatMap(wordsOf);
	return words.find((w) => {
		const re = wordPattern(normalizeName(w));
		return all.some((t) => re.test(t));
	});
}

// text anyone may write that staff don't want on the instance: a blocked
// phrase, or a blocked name word read word by word
export const forbiddenText = (...texts: string[]) => texts.some((t) => hasBlockedPhrase(t)) || !!blockedWordIn(...texts);

// An account that took a blocked name: suspended and signed out everywhere,
// with a line in the audit log. Staff are left alone (the caller refuses).
export async function suspendForName(userId: string, name: string) {
	await sql`update users set status = 'suspended', status_until = null where id = ${userId}::bigint and role is null`;
	await sql`delete from sessions where user_id = ${userId}::bigint and exists (select 1 from users where id = ${userId}::bigint and role is null)`;
	await sql`insert into audit_log (id, actor_id, action, target, detail) values (${newId()}::bigint, null, 'auto_suspend_name', ${userId}, ${JSON.stringify({ name })}::text::jsonb)`;
}
