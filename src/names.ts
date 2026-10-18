// Blocked names (admin panel > Settings): words no handle or display name may
// contain. Sign-up with one is refused; an account that renames itself to one
// is suspended on the spot. Matching ignores case, accents, separators,
// look-alike digits and symbols, and extra repeats, so "N_1-gggg3rr" matches
// "nigger". A doubled letter in the word still needs two in the name, or
// "nigger" would block "Nigeria".

import { sql } from "./db";
import { newId } from "./ids";
import { LOOKALIKE, foldGlyphs } from "./fold";
import { hateIn } from "./hate";
import { shutOut } from "./moderation";
import { hasBlockedPhrase, settings } from "./settings";

export { foldGlyphs };

// lowercase letters plus the look-alike digits and symbols; repeats are kept
export function normalizeName(text: string): string {
	return foldGlyphs(text).replace(/[^\p{L}0-9!|@$+]/gu, "");
}

// "nigger" -> n+ [i1!|]+ [g96]{2,} [e3]+ r+, matched anywhere in a text.
// Not a RegExp: neighbouring letters share look-alikes (i and l both take 1
// and |), and a backtracking engine tries every split of a run of them, so a
// long run took minutes and froze the server. This walks the text once,
// keeping every place in the word a match could be at.
type Segment = { chars: Set<string>; min: number };
type WordPattern = { test(text: string): boolean };

function wordPattern(word: string): WordPattern {
	const letters = word.replace(/[^\p{L}]/gu, "");
	const segments: Segment[] = [...letters.matchAll(/(\p{L})\1*/gu)].map(([run, c]) => ({ chars: new Set([c, ...(LOOKALIKE[c] ?? "")]), min: [...run].length }));
	return {
		test(text: string) {
			if (!segments.length) return false;
			const last = segments.length - 1;
			// state: segment index * 1000 + how many it has taken so far (capped at its min)
			let states = new Set<number>();
			for (const ch of text) {
				const next = new Set<number>();
				const step = (k: number, n: number) => {
					if (!segments[k].chars.has(ch)) return false;
					const taken = Math.min(n + 1, segments[k].min);
					if (k === last && taken === segments[k].min) return true;
					next.add(k * 1000 + taken);
					return false;
				};
				// a match may start at any character
				if (step(0, 0)) return true;
				for (const s of states) {
					const k = Math.floor(s / 1000), n = s % 1000;
					if (step(k, n)) return true;
					if (n === segments[k].min && k < last && step(k + 1, 0)) return true;
				}
				states = next;
			}
			return false;
		},
	};
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
export const forbiddenText = (...texts: string[]) => texts.some((t) => hasBlockedPhrase(t)) || !!blockedWordIn(...texts) || !!hateIn(...texts);

// An account that took a blocked name: suspended and signed out everywhere,
// with a line in the audit log. Staff are left alone (the caller refuses).
export async function suspendForName(userId: string, name: string) {
	await sql`update users set status = 'suspended', status_until = null, status_restore = null, deactivated_at = null where id = ${userId}::bigint and role is null`;
	const [member] = await sql`select 1 from users where id = ${userId}::bigint and role is null`;
	if (member) await shutOut(userId);
	await sql`insert into audit_log (id, actor_id, action, target, detail) values (${newId()}::bigint, null, 'auto_suspend_name', ${userId}, ${JSON.stringify({ name })}::text::jsonb)`;
}
