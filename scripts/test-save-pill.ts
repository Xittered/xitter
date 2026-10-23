import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const account = readFileSync(new URL("../src/account-page.ts", import.meta.url), "utf8");
const decoration = readFileSync(new URL("../src/decoration-settings.ts", import.meta.url), "utf8");
const theme = readFileSync(new URL("../src/themes/page.ts", import.meta.url), "utf8");

test("decoration and theme share one floating save pill", () => {
	expect(account).toContain(".save,.savebar{position:sticky;bottom:16px;");
	expect(account).toContain("background:transparent");
	expect(account).toContain("box-shadow:0 2px 12px rgb(0 0 0 / .28)");
	expect(account).toContain("padding:16px 16px 96px");
	expect(decoration).not.toContain(".save{");
	expect(decoration).toContain('class="save"');
	expect(theme).toContain('class="savebar"');
	expect(theme).not.toContain(".savebar{");
	expect(theme).not.toContain(".savebar button[type=submit]{flex:1}");
});
