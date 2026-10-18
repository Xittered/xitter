import { LOOKALIKE, foldGlyphs } from "./fold";

export type HateCategory = "slur" | "hate" | "transphobia" | "abuse";
export type HateHit = { category: HateCategory; term: string };

type Term = { word: string; anywhere?: boolean; suffix?: string; contextual?: boolean; benign?: RegExp };

const TERMS: Term[] = [
	{ word: "nigger", anywhere: true, benign: /snigger/g },
	{ word: "nigga", anywhere: true, benign: /niggard/g },
	{ word: "nignog", anywhere: true },
	{ word: "jigaboo", anywhere: true },
	{ word: "wetback", anywhere: true },
	{ word: "raghead", anywhere: true },
	{ word: "towelhead", anywhere: true },
	{ word: "zipperhead", anywhere: true },
	{ word: "shitskin", anywhere: true },
	{ word: "kike", suffix: "s" },
	{ word: "kyke", suffix: "s" },
	{ word: "spic", suffix: "s|ks|k" },
	{ word: "gook", suffix: "s" },
	{ word: "beaner", suffix: "s" },
	{ word: "troon", suffix: "s|y|ies" },
	{ word: "faggot", anywhere: true, contextual: true },
	{ word: "fag", suffix: "s|gy|gie|gies", contextual: true },
	{ word: "dyke", suffix: "s", contextual: true },
	{ word: "tranny", suffix: "s", contextual: true },
	{ word: "trannie", suffix: "s", contextual: true },
	{ word: "shemale", suffix: "s", contextual: true },
	{ word: "coon", suffix: "s", contextual: true },
	{ word: "chink", suffix: "s|y", contextual: true },
	{ word: "paki", suffix: "s", contextual: true },
];

const ALLOWED_PHRASES = /\b(royal troon|troon (golf|harbour|harbor|scotland|ayrshire|beach|station)|spick and span|chinks? in (the|his|her|their|my|your|its) (armou?r)|maine coons?|coon ?hounds?)\b/g;

const letterClass = (c: string) => {
	const extra = { ...LOOKALIKE, i: "1!|l", g: "96q", a: "4@" }[c];
	return extra ? `[${c}${extra.replace(/[|$+\]\\^-]/g, "\\$&")}]` : c;
};

const core = (word: string) =>
	word.replace(/(\p{L})\1*/gu, (run, c) => {
		const cls = c === "f" ? "(?:f|ph)" : letterClass(c);
		return run.length > 1 ? `${cls}{${run.length},}` : `${cls}+`;
	});

const compiled = TERMS.map((t) => ({
	...t,
	inside: new RegExp(core(t.word), "u"),
	whole: new RegExp(`^${core(t.word)}(?:${t.anywhere ? "s|z|h|hs|az|as|ers|er|a" : t.suffix ?? "s"})?$`, "u"),
	backward: new RegExp(`^${t.word.replace(/(\p{L})\1*/gu, (run, c) => (run.length > 1 ? `${c}{${run.length},}` : `${c}+`))}(?:${t.anywhere ? "s|z|h|hs|az|as|ers|er|a" : t.suffix ?? "s"})?$`, "u"),
}));

const FLIPPED: Record<string, string> = { ɐ: "a", q: "b", ɔ: "c", p: "d", ǝ: "e", ɟ: "f", ƃ: "g", ɥ: "h", ı: "i", ɾ: "j", ʞ: "k", ן: "l", ɯ: "m", u: "n", d: "p", b: "q", ɹ: "r", ʇ: "t", n: "u", ʌ: "v", ʍ: "w", ʎ: "y" };
const FLIP_MARK = /[ɐɔǝɟƃɥıɾʞןɯɹʇʌʍʎ]/u;

const flip = (text: string) => [...text].reverse().map((c) => FLIPPED[c] ?? c).join("");

const SPLIT = /[\s.,/\\?#&=:;()"<>[\]{}*~^_\-–—…·•]+/u;

const tokensOf = (text: string) =>
	foldGlyphs(text)
		.replace(/['`]/g, "")
		.replace(ALLOWED_PHRASES, " ")
		.split(SPLIT)
		.map((p) => p.replace(/[^\p{L}0-9!@$+|]/gu, ""))
		.filter(Boolean);

const LEET: Record<string, string> = { "|": "i", "4": "a", "@": "a", "8": "b", "3": "e", "6": "g", "9": "g", "1": "i", "!": "i", "0": "o", "5": "s", $: "s", "7": "t", "+": "t", "2": "z" };
const plain = (token: string) => token.replace(/[0-9!@$+|]/g, (c) => LEET[c] ?? c);

const SECOND_PERSON = new Set(["you", "u", "ur", "youre", "your", "ya", "yall", "yu", "yo", "thou"]);
const IN_GROUP = new Set(["i", "im", "we", "were", "us", "our", "my", "me", "as", "fellow", "proud", "ourselves", "myself", "ive"]);
const VIOLENT = /^(kill|kills|killing|killed|killer|gas|gassed|gassing|lynch|lynched|lynching|hang|hanged|exterminate|exterminated|eradicate|genocide|stab|rape|raped|kys)$/;
const DEMEANING = /^(subhuman|subhumans|vermin|degenerate|degenerates|groomer|groomers|pedo|pedos|pedophile|pedophiles|paedo|paedophile|abomination|abominations|disgusting|filthy|dirty|worthless|mentally|freak|freaks)$/;
const DIE_LEAD = new Set(["should", "must", "to", "all", "gonna", "will", "can", "go", "pls", "please"]);

function attacked(words: string[], i: number) {
	const before = words.slice(Math.max(0, i - 3), i);
	const near = words.slice(Math.max(0, i - 5), i + 6);
	if (near.some((w, j) => VIOLENT.test(w) || (w === "die" && DIE_LEAD.has(near[j - 1] ?? "")))) return true;
	if (before.some((w) => IN_GROUP.has(w))) return false;
	return near.some((w) => SECOND_PERSON.has(w) || DEMEANING.test(w));
}

function termIn(candidate: string, wholeOnly: boolean) {
	const forms = [...new Set([candidate, candidate.replace(/^@+|!+$/g, "")])];
	return compiled.find((t) =>
		forms.some((form) => {
			const c = t.benign ? form.replace(t.benign, " ") : form;
			return t.whole.test(c) || (!wholeOnly && !!t.anywhere && t.inside.test(c));
		}),
	);
}

const reverse = (s: string) => [...s].reverse().join("");

const backwardIn = (candidate: string) => {
	const form = plain(reverse(candidate).replace(/^@+|!+$/g, ""));
	return compiled.find((t) => t.backward.test(t.benign ? form.replace(t.benign, " ") : form));
};

function slurIn(tokens: string[]): HateHit | undefined {
	const words = tokens.map(plain);
	const found = (t: Term, at: number): HateHit | undefined => (!t.contextual || attacked(words, at) ? { category: "slur", term: t.word } : undefined);
	for (const [i, token] of tokens.entries()) {
		const t = termIn(token, false) ?? backwardIn(token);
		const hit = t && found(t, i);
		if (hit) return hit;
	}
	for (let i = 0; i < tokens.length; i++) {
		let joined = "";
		for (let j = i; j < Math.min(tokens.length, i + 8); j++) {
			if ([...tokens[j]].length > 5) break;
			joined += tokens[j];
			if (j === i) continue;
			const t = termIn(joined, true) ?? backwardIn(joined);
			const hit = t && found(t, i);
			if (hit) return hit;
		}
	}
	return undefined;
}

const GROUPS =
	"jews|jew|kikes|blacks|black people|niggers|gays|gay people|queers|fags|faggots|trannies|trannys|troons|trans people|trans folks|trans women|trans men|trans kids|transgenders|transgender people|muslims|immigrants|mexicans|asians|arabs|lgbt|lgbtq|lesbians|homos|homosexuals";

const PHRASES: [HateCategory, RegExp][] = [
	["hate", new RegExp(`\\b(gas|kill|lynch|hang|exterminate|eradicate|shoot) (all |every |the |these |those )*(${GROUPS})\\b`)],
	["hate", new RegExp(`\\b(${GROUPS}) (should|must|need to|deserve to|ought to|have to) (all )?(die|be killed|be gassed|be exterminated|hang|be hanged|burn|be shot|be lynched|not exist)\\b`)],
	["hate", new RegExp(`\\b(${GROUPS}) (are|r) (subhuman|vermin|animals|parasites|a disease|cockroaches|rats|an infestation)\\b`)],
	["hate", /\b(heil hitler|sieg heil|seig heil|white power|1488|14 88|hitler was right|hitler did nothing wrong|holohoax|gas chambers? (were|was) (fake|a lie|a hoax)|jews will not replace us|you will not replace us|six million wasnt enough|6 million wasnt enough|6 gorillion|the holocaust (never happened|didnt happen|was (a lie|fake|a hoax|a myth))|day of the rope|race war now|rahowa)\b/],
	["transphobia", /\btrans ?(women|woman|girls?|females?) (are|is|r) (just |really |still |all |only )?(men|males?|a man|biological (men|males?)|not (real )?women|not (a )?(real )?woman|mentally ill|groomers|perverts|predators|delusional|freaks|fake women|men in dresses)\b/],
	["transphobia", /\btrans ?(women|woman|girls?|females?) (arent|isnt|aint|are not|is not) (real |actual |really )?(women|woman|girls?|females?)\b/],
	["transphobia", /\btrans ?(men|man|boys?|males?) (arent|isnt|aint|are not|is not) (real |actual |really )?(men|man|boys?|males?)\b/],
	["transphobia", /\btrans ?(men|man|boys?|males?) (are|is|r) (just |really |still |all |only )?(women|females?|a woman|biological (women|females?)|not (real )?men|not (a )?(real )?man|mentally ill|delusional|freaks|fake men)\b/],
	["transphobia", /\b(transgenderism|being trans|being transgender|trans people|transgender people|transgenders|trans folks|trans identities) (is|are|r) (a )?(mental illness|mentally ill|a disease|a mental disorder|degenerate|groomers|pedophiles|perverts|a cult|a fetish|demonic)\b/],
	["transphobia", /\b(you|u|he|she|they|trans women|trans men|trannies|troons) (will|wil|ll) never (be|pass as) a (real )?(woman|man|girl|boy)\b/],
	["transphobia", /\b(ywnbaw|ywnbam|ywnbar|join the 41|do the 41|41 percent yourself|41 yourself)\b/],
	["abuse", /\b(kill yourself|kill urself|kill yourselves|kill your self|kys|go die|neck yourself|hang yourself|rope yourself|unalive yourself)\b/],
];

const REPORTED = /\b(say|says|said|saying|claim|claims|claiming|claimed|think|thinks|believe|believes|pretend|pretending|argue|argues|argued|insist|insists|tweet|tweeted|posted|calling|called|yelled|shouted|telling|told|means|meaning|like when|not that|isnt that|myth that|lie that|false that|wrong that|whenever)\b/;
const REBUTTED = /^ ?(is|are|was|isnt|r) (false|wrong|a lie|transphobic|bigoted|bigotry|hateful|hate speech|bullshit|nonsense|disgusting|evil|not okay|not ok|unacceptable)\b/;
const NEGATED = /\b(dont|do not|never|please dont|pls dont|not|wont|shouldnt|would never|didnt)$/;

function phraseIn(tokens: string[]): HateHit | undefined {
	const text = tokens.map(plain).join(" ");
	const raw = tokens.join(" ");
	for (const [category, re] of PHRASES) {
		for (const form of [text, raw]) {
			const m = re.exec(form);
			if (!m) continue;
			const before = form.slice(0, m.index).split(" ").slice(-7).join(" ");
			const after = form.slice(m.index + m[0].length);
			if (REPORTED.test(before) || REBUTTED.test(after)) continue;
			if (category === "abuse" && NEGATED.test(before.trim())) continue;
			return { category, term: m[0] };
		}
	}
	return undefined;
}

const MAX_SCAN = 20_000;

function scan(text: string): HateHit | undefined {
	const tokens = tokensOf(text);
	if (!tokens.length) return undefined;
	return slurIn(tokens) ?? phraseIn(tokens);
}

export function hateIn(...texts: (string | null | undefined)[]): HateHit | undefined {
	for (const raw of texts) {
		if (!raw) continue;
		for (let at = 0; at < raw.length; at += MAX_SCAN - 200) {
			const text = raw.slice(at, at + MAX_SCAN);
			const hit = scan(text) ?? (FLIP_MARK.test(text) ? scan(flip(text)) : undefined);
			if (hit) return hit;
		}
	}
	return undefined;
}

const splitName = (name: string) => name.replace(/([a-z])([A-Z])/g, "$1 $2");

export function hateInName(...names: (string | null | undefined)[]): HateHit | undefined {
	for (const name of names) {
		if (!name) continue;
		const hit = hateIn(name, splitName(name));
		if (hit) return hit;
		const joined = tokensOf(name).join("");
		const t = compiled.find((c) => !c.contextual && c.anywhere && c.inside.test(c.benign ? joined.replace(c.benign, " ") : joined));
		if (t) return { category: "slur", term: t.word };
	}
	return undefined;
}
