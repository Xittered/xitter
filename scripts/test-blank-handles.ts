import { expect, test } from "bun:test";
import { staffHandleProblem } from "../src/invites";
import { looksBlank } from "../src/text-clean";

test("blank-looking characters aren't handles", () => {
	for (const h of ["ㅤ", "ᅟ", "ᅠ", "ﾠ", "⠀", "a​b", "aㅤ"]) expect(staffHandleProblem(h)).not.toBeNull();
});

test("real handles still pass", () => {
	for (const h of ["tiago", "café", "日本語", "x.y"]) expect(staffHandleProblem(h)).toBeNull();
});

test("names of blank characters look blank", () => {
	for (const n of ["ㅤ", "ㅤㅤ", " ⠀ ", "​"]) expect(looksBlank(n)).toBe(true);
	for (const n of ["tiago", "aㅤ", "🦊"]) expect(looksBlank(n)).toBe(false);
});
