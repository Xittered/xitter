import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(process.env.PUPPETEER_PKG || new URL("../package.json", import.meta.url));
const puppeteer = require("puppeteer-core");
const origin = process.env.ORIGIN || "http://localhost:3000";
const username = process.env.XITTER_USER || "ui_admin";
const password = process.env.XITTER_PASSWORD;
assert(password, "Set XITTER_PASSWORD for a disposable test account");
const login = await fetch(origin + "/login", { method: "POST", body: new URLSearchParams({ username, password }), redirect: "manual" });
assert.equal(login.status, 303);
const cookies = login.headers.getSetCookie().map((value) => {
	const pair = value.split(";")[0];
	const at = pair.indexOf("=");
	return { name: pair.slice(0, at), value: pair.slice(at + 1), domain: new URL(origin).hostname, path: "/" };
});
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/usr/local/bin/chromium", headless: true, args: ["--no-sandbox"] });
try {
	for (const width of [390, 800, 1280, 2560]) {
		const page = await browser.newPage();
		await page.setViewport({ width, height: 1000 });
		await page.setCookie(...cookies);
		await page.evaluateOnNewDocument(() => {
			window.framePaints = [];
			const end = performance.now() + 15000;
			function sample() {
				const frame = document.querySelector("#xitter-frame");
				if (frame) {
					const css = getComputedStyle(frame);
					if (css.display !== "none" && css.visibility === "visible") {
						const rect = frame.getBoundingClientRect();
						window.framePaints.push({ x: rect.x, width: rect.width });
					}
				}
				if (performance.now() < end) requestAnimationFrame(sample);
			}
			requestAnimationFrame(sample);
		});
		for (const path of ["/settings/xitter", "/admin"]) {
			await page.goto(origin + path, { waitUntil: "domcontentloaded" });
			await page.waitForFunction(() => {
				const frame = document.querySelector("#xitter-frame");
				return frame?.contentDocument?.documentElement?.hasAttribute("data-framed") && frame.hasAttribute("data-ready");
			});
			await new Promise((resolve) => setTimeout(resolve, 250));
			const state = await page.evaluate(() => {
				const frame = document.querySelector("#xitter-frame");
				const rect = frame.getBoundingClientRect();
				return { paints: window.framePaints, x: rect.x, width: rect.width, overflow: document.documentElement.scrollWidth - innerWidth };
			});
			assert(state.paints.length, `${width} ${path}: frame never painted`);
			assert.equal(state.overflow, 0, `${width} ${path}: parent overflow`);
			for (const paint of state.paints) {
				assert(Math.abs(paint.x - state.x) <= 1 && Math.abs(paint.width - state.width) <= 1, `${width} ${path}: transient stretched frame ${JSON.stringify(paint)}, final ${JSON.stringify(state)}`);
			}
			console.log(`ok ${width}px ${path}: first paint matches final column`);
		}
		await page.close();
	}
} finally {
	await browser.close();
}
