import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { THEME_SCRIPT } from "../src/themes/client";
import { accountVars } from "../src/themes/css";
import { PRESETS, type Theme } from "../src/themes/presets";

const account = readFileSync(new URL("../src/account-page.ts", import.meta.url), "utf8");

function customTheme(button: string, buttonText: string, buttonHover: string): Theme {
	return {
		id: "custom",
		base: "dark",
		bg: { stops: ["#000000"], angle: 180 },
		surface: "#111111",
		text: "#ffffff",
		accent: "#ff3d7f",
		button: { stops: [button], angle: 180 },
		buttonText,
		buttonHover,
	};
}

test("a painted preset paints primary actions with its accent and legible text", () => {
	const dim = accountVars(PRESETS.dim!);
	expect(dim).toContain("--primary:#1d9bf0");
	expect(dim).toContain("--primary-text:#ffffff");
	expect(dim).toContain("--primary-hover:");

	const midnight = accountVars(PRESETS.midnight!);
	expect(midnight).toContain("--primary:#8b7cff");
	expect(midnight).toContain("--primary-text:#ffffff");
});

test("a custom painted theme keeps its own primary button fill and text", () => {
	const vars = accountVars(customTheme("#123456", "#ffffff", "#345678"));
	expect(vars).toContain("--primary:#123456");
	expect(vars).toContain("--primary-text:#ffffff");
	expect(vars).toContain("--primary-hover:#345678");
});

test("the client script paints native primary actions inverted and painted ones by look", () => {
	expect(THEME_SCRIPT).toContain("lightNative?\"#0f1419\":\"#eff3f4\"");
	expect(THEME_SCRIPT).toContain("lightNative?\"#ffffff\":\"#0f1419\"");
	expect(THEME_SCRIPT).toContain('"html[data-xitter-theme] "+s');
	expect(THEME_SCRIPT).toContain("var(--xt-accent-fill,var(--xt-accent))");
	expect(THEME_SCRIPT).toContain("var(--xt-button,var(--xt-accent-fill,var(--xt-accent)))");
	expect(THEME_SCRIPT).toContain("var(--xt-button-text,var(--xt-accent-text,#fff))");
	expect(THEME_SCRIPT).toContain('["accentBg","accentHover"]');
	expect(THEME_SCRIPT).toContain("wrapAccent(sel+POST_NOT)");
});

test("the account page keeps native inverted and custom primary tokens", () => {
	expect(account).toContain('primary: "#0f1419"');
	expect(account).toContain('primary: "#eff3f4"');
	expect(account).toContain('primary: "#1d9bf0"');
	expect(account).toContain('"primary-text": "#0f1419"');
	expect(account).toContain(".save button:not(.secondary):not(.danger),.savebar button:not(.secondary):not(.danger){background:var(--primary,var(--accent-fill,var(--accent)));color:var(--primary-text,var(--accent-text,#fff))}");
	expect(account).toContain(".save button:not(.secondary):not(.danger):hover,.savebar button:not(.secondary):not(.danger):hover{background:var(--primary-hover,var(--accent-hover))}");
});
