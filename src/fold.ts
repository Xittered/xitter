// what else can stand for a letter; "1" is both i and l
export const LOOKALIKE: Record<string, string> = { a: "4@", b: "8", e: "3", g: "96", i: "1!|", l: "1|", o: "0", s: "5$", t: "7+", z: "2" };

// Letters from other scripts that pass for Latin ones; NFKD already folds
// full-width, bold/italic math and circled letters. Pairs: look-alike, Latin.
const GLYPHS = Object.fromEntries(
	[
		// Cyrillic, including faux-Cyrillic (И for N, Я for R)
		"аaвbеeёeкkмmнhоoрpсcтtуyхxіiїiјjѕsԁdьbъbпnиnйnяrгrшwщwцuчyзeэeдdлnғfқkңhүyұyһhӏl",
		// Greek
		"αaβbγyδdεeζzηnθoιiκkλnμuνvοoπnρpσoςcτtυuφoχxψwωw",
		// small caps and other Latin look-alikes NFKD leaves alone
		"ᴀaʙbᴄcᴅdᴇeɢgʜhɪiᴊjᴋkʟlᴍmɴnᴏoᴘpʀrꜱsᴛtᴜuᴠvᴡwʏyᴢzıiȷjłløođdħhŋnſsɑaɡgɩiʋvƒfßb",
		// symbols that aren't letters but read as one
		"∂d©c®r℗p∑e∆a∏n€e£l¢c¥y∅o⊂c∩n∪u∈e∃e∀a",
		"ԛqԝwҽeӑaӧoꙅsօoսuոnհhցgզqǝeɘeəeɛeɨiɵoꞃrʀrꭇrꮒhꮓzꭵiꭺaꭼeᏸbꮃwꮪsꭲtꮯcꮮlꮇmꮢrꭱrꮩvꮶkꭻjꮋhᏻgꮐg",
	]
		.join("")
		.match(/../gsu)!
		.map((pair) => [...pair] as [string, string]),
);
// capitals that look unlike their small letter (Σ is an E, σ an o)
const CAPITALS: Record<string, string> = { Σ: "e", Δ: "a", Λ: "a", Ξ: "e", Η: "h", Υ: "y", Ν: "n", Μ: "m", Γ: "r" };
// regional indicators (flag letters) 🇦..🇿
const FLAG_A = 0x1f1e6;
export const INVISIBLE = /\p{Cf}|\p{Variation_Selector}|\u034f|\u115f|\u1160|\u17b4|\u17b5|\u2800|\u3164|\uffa0/gu;

// NFKD, no accents, lowercase, every look-alike letter as its Latin one
export function foldGlyphs(text: string): string {
	return text
		.normalize("NFKD")
		.replace(INVISIBLE, "")
		.replace(/\p{M}/gu, "")
		.replace(/[ΣΔΛΞΗΥΝΜΓ]/gu, (c) => CAPITALS[c])
		.toLowerCase()
		.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, (c) => String.fromCharCode(97 + c.codePointAt(0)! - FLAG_A))
		.replace(/[^\x00-\x7f]/gu, (c) => GLYPHS[c] ?? c);
}

