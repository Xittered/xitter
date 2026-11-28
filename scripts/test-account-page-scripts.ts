import { expect, test } from "bun:test";
import { accountPage } from "../src/account-page";

// the page scripts sit in template literals, where a regex's backslashes vanish
// unless doubled; one that fails to parse leaves a framed page without its
// link handling, and its links load the whole client inside Settings
test("account page scripts parse", async () => {
	const res = await accountPage({ req: new Request("http://localhost/account/"), title: "Test", body: "<p>test</p>" });
	const nonce = /'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
	const tags = [...(await res.text()).matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
	const scripts = tags.map((m) => m[2]!);
	expect(scripts.length).toBeGreaterThan(0);
	for (const tag of tags) expect(tag[1]).toBe(` nonce="${nonce}"`);
	for (const script of scripts) expect(() => new Function(script)).not.toThrow();
});
