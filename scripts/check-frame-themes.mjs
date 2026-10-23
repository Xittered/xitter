import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(process.env.PUPPETEER_PKG || new URL("../package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const origin = process.env.ORIGIN || "http://localhost:3000";
assert(process.env.XITTER_PASSWORD, "Set XITTER_PASSWORD for a disposable staff account");
const login = await fetch(origin + "/login", { method: "POST", body: new URLSearchParams({ username: process.env.XITTER_USER || "ui_admin", password: process.env.XITTER_PASSWORD }), redirect: "manual" });
assert.equal(login.status, 303);
const cookies = login.headers.getSetCookie().map((value) => {
	const pair = value.split(";")[0], at = pair.indexOf("=");
	return { name: pair.slice(0, at), value: pair.slice(at + 1), domain: new URL(origin).hostname, path: "/" };
});
const headers = { cookie: cookies.map((c) => c.name + "=" + c.value).join("; "), "x-csrf-token": cookies.find((c) => c.name === "ct0").value, "content-type": "application/json" };
const before = await fetch(origin + "/i/api/xitter/theme", { headers }).then((r) => r.json());
async function save(body) {
	const response = await fetch(origin + "/i/api/xitter/theme", { method: "POST", headers, body: JSON.stringify(body) });
	assert.equal(response.status, 200, await response.text());
}
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/usr/local/bin/chromium", headless: true, args: ["--no-sandbox"] });
async function ready(page, palette) {
	await page.waitForFunction((palette) => {
		const frame = document.querySelector("#xitter-frame"), root = frame?.contentDocument?.documentElement;
		return frame?.hasAttribute("data-ready") && root?.hasAttribute("data-framed") && root.getAttribute("data-theme") === palette && document.documentElement.getAttribute("data-xitter-theme") === (palette === "dim" ? "dim" : null);
	}, { timeout: 30000, polling: 100 }, palette);
}
try {
	await save({ mode: "dark", accent: null });
	for (const width of [390, 800, 1280, 2560]) {
		const page = await browser.newPage(), other = await browser.newPage();
		await page.setViewport({ width, height: 1000 });
		await page.setCookie(...cookies);
		await other.setCookie(...cookies);
		await save({ mode: "dark", accent: null });
		await page.goto(origin + "/admin", { waitUntil: "domcontentloaded" });
		await ready(page, "dark");
		await other.goto(origin + "/settings/xitter/theme", { waitUntil: "domcontentloaded" });
		await ready(other, "dark");
		const frame = await (await other.$("#xitter-frame")).contentFrame();
		await frame.evaluate(() => document.querySelector('button[name="preset"][value="dim"]').click());
		await ready(other, "dim");
		await page.bringToFront();
		await ready(page, "dim");
		assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#xitter-frame").contentDocument.body).backgroundColor), "rgb(21, 32, 43)");
		console.log(`ok ${width}px: cached admin and theme tab both follow Dim`);
		await save({ mode: "light" });
		await page.evaluate(() => {
			const win = document.querySelector("#xitter-frame").contentWindow;
			win.eval('parent.postMessage({xitter:1,type:"go",path:"/admin#reports"},location.origin)');
		});
		await ready(page, "light");
		assert.equal(new URL(page.url()).hash, "#reports");
		assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#xitter-frame").contentDocument.body).backgroundColor), "rgb(255, 255, 255)");
		console.log(`ok ${width}px: reused admin hash navigation refreshes the saved look`);
		await other.bringToFront();
		await save({ mode: "dark" });
		await page.bringToFront();
		await ready(page, "dark");
		assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#xitter-frame").contentDocument.body).backgroundColor), "rgb(0, 0, 0)");
		let reloads = 0;
		page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) reloads++; });
		await page.evaluate(() => { dispatchEvent(new Event("focus")); dispatchEvent(new PageTransitionEvent("pageshow")); document.dispatchEvent(new Event("visibilitychange")); });
		await new Promise((resolve) => setTimeout(resolve, 500));
		assert.equal(reloads, 0, "An unchanged saved look must not cause a reload loop");
		console.log(`ok ${width}px: Lights out restored; unchanged focus does not reload`);
		await page.close();
		await other.close();
	}
} finally {
	await browser.close();
	await save(before.theme ? { theme: before.theme, accent: before.accent } : { mode: before.mode || "dark", accent: before.accent });
}
