// Post length the way X's composer counts it (twitter-text's weighted length):
// most scripts count 1 per character, wide ones (CJK, emoji) 2, and a link 23
// however long it is. The server counts the same, so it never refuses a post
// the composer allowed.

import { settings } from "./settings";

const LINK = /https?:\/\/\S+/g;

export function weightedLength(text: string): number {
	let n = 0;
	const rest = text.normalize("NFC").replace(LINK, () => {
		n += 23;
		return "";
	});
	for (const c of rest) {
		const cp = c.codePointAt(0)!;
		n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
	}
	return n;
}

// longer than this, the composer sends a long post (CreateNoteTweet) and
// timelines show a preview with "Show more"
export const SHORT_POST = 280;

// how long a post this account may write, by its badge (Admin > Settings)
export function postLimitFor(verifiedType: string | null | undefined): number {
	const l = settings().post_limits;
	if (verifiedType === "government" || verifiedType === "government_individual") return l.government;
	if (verifiedType === "business") return l.business;
	if (verifiedType === "blue") return l.blue;
	return l.none;
}

// the start of a long post that timelines show, cut at a word when one is near
export function previewOf(text: string): string {
	const chars = [...text];
	if (weightedLength(text) <= SHORT_POST) return text;
	let cut = "";
	for (const c of chars) {
		if (weightedLength(cut + c) > SHORT_POST - 5) break;
		cut += c;
	}
	const space = cut.search(/\s\S*$/);
	return (space > cut.length * 0.7 ? cut.slice(0, space) : cut).trimEnd();
}
