import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { lookKeyOf } from "../src/account-page";
import { FRAME_BRIDGE, FRAME_LOOK_REPORT } from "../src/settings-shell";
import { paletteOf, readPrefs } from "../src/themes/validate";
import type { Look } from "../src/themes/validate";

const paintedDim = { kind: "painted", theme: { id: "dim", base: "dark" } } as unknown as Look;
const paintedCustom = { kind: "painted", theme: { id: "neon", base: "dark" } } as unknown as Look;

test("the look key is deterministic and safe inside an attribute", () => {
	const dark = readPrefs({ mode: "dark" });
	const key = lookKeyOf(dark.look, dark.accent, null);
	expect(key).toMatch(/^[0-9a-z]+$/);
	expect(lookKeyOf(dark.look, dark.accent, null)).toBe(key);
	expect(lookKeyOf(dark.look, dark.accent, undefined)).toBe(key);
});

test("the look key covers theme, accent and decoration only", () => {
	const dark = readPrefs({ mode: "dark" });
	const darkExtra = readPrefs({ mode: "dark", hide_replies: true, other_pref: 1 });
	expect(dark.look).toEqual(darkExtra.look);
	expect(dark.accent).toEqual(darkExtra.accent);
	expect(lookKeyOf(dark.look, dark.accent, null)).toBe(lookKeyOf(darkExtra.look, darkExtra.accent, null));

	const light = readPrefs({ mode: "light" });
	expect(lookKeyOf(light.look, light.accent, null)).not.toBe(lookKeyOf(dark.look, dark.accent, null));

	const yellow = readPrefs({ mode: "dark", accent: "yellow500" });
	expect(lookKeyOf(yellow.look, yellow.accent, null)).not.toBe(lookKeyOf(dark.look, dark.accent, null));

	expect(lookKeyOf(dark.look, dark.accent, { id: "1" })).not.toBe(lookKeyOf(dark.look, dark.accent, null));
});

test("the saved look maps to the palette the framed pages bake", () => {
	expect(paletteOf(readPrefs({ mode: "dark" }).look)).toBe("dark");
	expect(paletteOf(readPrefs({ mode: "light" }).look)).toBe("light");
	expect(paletteOf(paintedDim)).toBe("dim");
});

test("custom painted themes fall back to their base palette and need token overrides", () => {
	expect(paletteOf(paintedCustom)).toBe("dark");
});

test("every framed page reports the canonical look, same origin only", () => {
	expect(FRAME_LOOK_REPORT).toContain('parent.location.origin===location.origin');
	expect(FRAME_LOOK_REPORT).toContain('type:"look"');
	expect(FRAME_LOOK_REPORT).toContain('meta[name="xitter-look"]');
	expect(FRAME_LOOK_REPORT).toContain("location.origin");
	expect(FRAME_BRIDGE).toContain('type:"page"');
	expect(FRAME_BRIDGE).toContain("look:look?look.content:");
	expect(FRAME_BRIDGE).toContain('type:"look"');
});

test("admin.html keeps the anchors the server injection replaces", () => {
	const html = readFileSync(new URL("../src/admin.html", import.meta.url), "utf8");
	expect(html.match(/<html lang="en">/g)).toHaveLength(1);
	expect(html.match(/<\/head>/g)).toHaveLength(1);
	expect(html.match(/<\/body>/g)).toHaveLength(1);
	expect(html.match(/src="\/public\/icon-dark\.png"/g)).toHaveLength(1);
});
