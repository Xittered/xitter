const chars = (...codes: number[]) => String.fromCodePoint(...codes);
const INVISIBLE = new RegExp(
	`[${chars(0xad, 0x115f, 0x1160, 0x200b, 0x3164, 0xfeff, 0xffa0)}${chars(0x2060)}-${chars(0x2064)}]`,
	"g",
);
const TRAILING_BLANK = new RegExp(
	`[\\s${chars(0x2800, 0x3000, 0xa0, 0x202f, 0x205f)}${chars(0x2000)}-${chars(0x200a)}]+$`,
	"u",
);
const PILED_MARKS = /(\p{M}{3})\p{M}+/gu;

export function cleanText(
	text: string,
	opts: { blankLines?: number; lines?: number } = {},
): string {
	const { blankLines = 1, lines = Number.POSITIVE_INFINITY } = opts;
	const kept: string[] = [];
	let blanks = 0;
	for (const raw of text
		.replace(/\r\n?/g, "\n")
		.replace(INVISIBLE, "")
		.replace(PILED_MARKS, "$1")
		.split("\n")) {
		const line = raw.replace(TRAILING_BLANK, "");
		blanks = line ? 0 : blanks + 1;
		if (blanks <= blankLines) kept.push(line);
	}
	while (kept.length && !kept[0]) kept.shift();
	while (kept.length && !kept.at(-1)) kept.pop();
	return kept.length > lines
		? [
				...kept.slice(0, lines - 1),
				kept
					.slice(lines - 1)
					.filter(Boolean)
					.join(" "),
			].join("\n")
		: kept.join("\n");
}

export const oneLine = (text: string) =>
	cleanText(text)
		.replace(/\s*\n\s*/g, " ")
		.replace(/\s{2,}/g, " ");

// Hangul fillers, the braille blank and other characters that draw nothing:
// a name made only of them looks empty
export const looksBlank = (text: string) => !text.replace(/[\s\p{C}\p{Default_Ignorable_Code_Point}⠀]/gu, "");
