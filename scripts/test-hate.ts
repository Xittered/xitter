import { expect, test } from "bun:test";
import { hateIn, hateInName } from "../src/hate";

const zw = "​";
const evasions = [
	"nigger",
	"NIGGER",
	"niggers",
	"nigga",
	"niggaz",
	"n1gg3r",
	"n!gg@",
	"ni66er",
	"niqqer",
	"nlgger",
	"n|gger",
	"niiiiigggggeeerrrr",
	"n i g g e r",
	"n.i.g.g.e.r",
	"n-i-g-g-e-r",
	"n_i_g_g_e_r",
	"n*i*g*g*e*r",
	"nig ger",
	"ni gg er",
	"n i gga",
	`n${zw}i${zw}g${zw}g${zw}e${zw}r`,
	"n­i­gger",
	"n⁠igger",
	"n️igger",
	"n\u{e0020}igger",
	"nㅤigger",
	"n̷i̷g̷g̷e̷r̷",
	"ńìğğéř",
	"nіggеr",
	"ИIGGER",
	"nιggεr",
	"ɴɪɢɢᴇʀ",
	"ｎｉｇｇｅｒ",
	"𝐧𝐢𝐠𝐠𝐞𝐫",
	"𝔫𝔦𝔤𝔤𝔢𝔯",
	"𝓷𝓲𝓰𝓰𝓮𝓻",
	"ⓝⓘⓖⓖⓔⓡ",
	"⒩⒤⒢⒢⒠⒭",
	"🇳🇮🇬🇬🇪🇷",
	"NᎥᏀᏀᎬᎡ",
	"reggin",
	"aggin",
	"ɹǝƃƃıu",
	"sandnigger",
	"go back home you n🍆i🍆g🍆g🍆e🍆r",
	"you dumb n1gg3r!",
	"kike",
	"k1kes",
	"spic",
	"wetback",
	"towelhead",
	"troon",
	"troons are mentally ill",
	"you're a faggot",
	"kill all fags",
	"shut up you dyke",
	"dirty tranny",
	"you fucking c00n",
	"gas the jews",
	"g4s the j3ws",
	"kill all trans people",
	"jews should die",
	"heil hitler",
	"sieg heil brothers",
	"1488",
	"the holocaust never happened",
	"hitler did nothing wrong",
	"trans women are men",
	"transwomen are just men",
	"trans women aren't women",
	"trans women are not real women",
	"trans men are women",
	"being trans is a mental illness",
	"transgenderism is a mental illness",
	"you will never be a real woman",
	"ywnbaw",
	"join the 41%",
	"kill yourself",
	"kys loser",
];

for (const s of evasions) test(`caught: ${JSON.stringify(s)}`, () => expect(hateIn(s)).toBeDefined());

const benign = [
	"Niger",
	"Nigeria",
	"Nigerian food is amazing",
	"the Niger river delta",
	"night",
	"knight",
	"midnight snack",
	"trigger warning",
	"digger",
	"bigger",
	"jigger of rum",
	"niggle",
	"niggling doubt",
	"niggardly",
	"don't be so niggardly with the sauce",
	"snigger",
	"he sniggered at the joke",
	"sniggering in the back row",
	"Scunthorpe United",
	"spice",
	"spicy",
	"spick and span",
	"raccoon",
	"my maine coon is fat",
	"tycoon",
	"cocoon",
	"a chink in the armor",
	"Pakistan",
	"Royal Troon golf club",
	"I'm a dyke and proud",
	"we're all dykes here",
	"dyke march this weekend 🏳️‍🌈",
	"as a fag myself this is hilarious",
	"proud tranny lol",
	"queer as fuck",
	"trans women are women",
	"trans men are men",
	"trans rights are human rights",
	"protect trans kids",
	"anyone who says trans women are men is a bigot",
	"saying trans women are men is transphobic",
	"trans women are men is a lie",
	"she sat on my face and I came so hard",
	"the yuri girls kissed and scissored all night",
	"cock and balls",
	"don't kill yourself, please reach out",
	"kill the lights",
	"gas station",
	"the holocaust happened and we must remember",
	"bragging",
	"nagging",
	"lagging behind",
	"sagging",
	"flagging",
	"tagging",
	"gaggle",
	"faggots are a british meatball dish",
	"transmission",
	"skinny",
	"",
	"   ",
];

for (const s of benign) test(`passes: ${JSON.stringify(s)}`, () => expect(hateIn(s)).toBeUndefined());

test("names: spaceless and camel case", () => {
	expect(hateInName("BigNiggerLover")).toBeDefined();
	expect(hateInName("xX_n1gg3r_Xx")).toBeDefined();
	expect(hateInName("reggin_lol")).toBeDefined();
	expect(hateInName("kike_hunter")).toBeDefined();
	expect(hateInName("nіgga")).toBeDefined();
});

test("names: ordinary ones pass", () => {
	for (const s of ["NigeriaFan", "nightknight", "Иван Петров", "Νίκος Παπαδόπουλος", "Нигерия", "Łukasz", "trigger_happy", "sniggerpants", "MaineCoonMom", "yuri", "transgirl_jess", "DykeQueen"])
		expect(hateInName(s)).toBeUndefined();
});

test("categories", () => {
	expect(hateIn("nigger")?.category).toBe("slur");
	expect(hateIn("gas the jews")?.category).toBe("hate");
	expect(hateIn("trans women are men")?.category).toBe("transphobia");
	expect(hateIn("kill yourself")?.category).toBe("abuse");
});

test("long text is scanned past the first chunk", () => {
	expect(hateIn(`${"hello world ".repeat(5000)} nigger`)).toBeDefined();
	expect(hateIn("hello world ".repeat(20000))).toBeUndefined();
});
