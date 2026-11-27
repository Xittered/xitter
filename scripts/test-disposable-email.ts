import { strict as assert } from "node:assert";
import { sql } from "../src/db";
import { isDisposableDomain } from "../src/disposable-email";
import { checkSignup, SignupError } from "../src/invites";
import { loadSettings, setSetting, settings } from "../src/settings";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

let checks = 0;
const check = (ok: unknown, label: string) => {
	assert(ok, label);
	checks++;
	console.log("ok", label);
};
const form = (email: string) => ({ code: "", screenName: `de${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`, name: "", password: "disposable-test-only", email });
const refusal = (email: string) => checkSignup(form(email)).then(() => "", (e) => (e instanceof SignupError ? e.message : `other: ${e}`));

await loadSettings();
const before = settings().block_disposable_email;
const mode = settings().signup_mode;
try {
	check(isDisposableDomain("mailinator.com") && isDisposableDomain("YOPMAIL.COM"), "listed domains match in any case");
	check(isDisposableDomain("inbox.mailinator.com"), "a subdomain of a listed domain matches");
	check(!isDisposableDomain("gmail.com") && !isDisposableDomain("proton.me") && !isDisposableDomain("com"), "normal providers and bare tlds don't match");
	await setSetting("signup_mode", "open");
	await setSetting("block_disposable_email", true);
	check((await refusal("raider@yopmail.com")).includes("Throwaway"), "sign-up refuses a throwaway address");
	check((await refusal("someone@gmail.com")) === "", "sign-up takes a normal address");
	await setSetting("block_disposable_email", false);
	check((await refusal("raider@yopmail.com")) === "", "with the switch off a throwaway address goes through");
	console.log(`${checks} checks passed`);
} finally {
	await setSetting("block_disposable_email", before);
	await setSetting("signup_mode", mode);
	await sql.close();
}
