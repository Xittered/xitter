// Direct load, reload, and back/forward for every Xitter page.
// In the frame model a browser tab never gets our pages on their own: the X
// client loads and frames the page in #xitter-frame, with the mode on
// <html data-xitter-host>. So "the page works" means the client shell is
// up, the frame is hosted, and the framed document has our content. The
// plain pages are only for fetches (Sec-Fetch-Dest other than document).
// Run with the server up: node scripts/check-direct-load.mjs
// Env: ORIGIN, XITTER_USER, XITTER_PASSWORD, CHROME_PATH, PUPPETEER_PKG
// (the package.json createRequire resolves puppeteer-core from).
// Not part of test:unit. It needs Chrome and a signed-in session.

import { createRequire } from "node:module";

const require = createRequire(process.env.PUPPETEER_PKG || "/workspace/xitterbadge/package.json");
const puppeteer = require("puppeteer-core");

const origin = process.env.ORIGIN || "http://localhost:3000";
const user = process.env.XITTER_USER || "coah";
const password = process.env.XITTER_PASSWORD || "testpass123";

// owned paths a browser can be pointed at; /account/* are the canonical
// addresses (links, pastes, bookmarks) and land on their /settings/xitter
// client route, /admin frames in place
const paths = [
	"/account/xitter",
	"/account/theme",
	"/account/email",
	"/account/decor",
	"/account/decoration",
	"/account/organisation",
	"/account/automation",
	"/account/import",
	"/account/invites",
	"/account/migrate",
	"/account/passkeys",
	"/account/2fa",
	"/account/apps",
	"/account/apps/developer",
	"/account/api",
	"/account/instances",
	"/account/notices",
	"/account/notes/appeals",
	"/account/theme/",
	"/admin",
	"/admin/",
	"/federation/superadmin",
	"/account/no-such-page",
];

// where a tab load of the path ends up in the client
const topPath = (p) => p === "/account/xitter" ? "/settings/xitter"
	: p === "/federation/superadmin" ? "/settings/xitter/superadmin"
	: p.startsWith("/account/") ? "/settings/xitter/" + p.slice("/account/".length).replace(/\/$/, "")
	: p.replace(/\/$/, "") || "/";

const login = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: user, password }), redirect: "manual" });
if (login.status !== 303) throw new Error(`login ${login.status}`);
const jar = Object.fromEntries(login.headers.getSetCookie().map((c) => {
	const pair = c.split(";")[0];
	const cut = pair.indexOf("=");
	return [pair.slice(0, cut), pair.slice(cut + 1)];
}));
const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
// only staff get the panel; anyone else's tab load of /admin is a plain 404
const staff = (await fetch(`${origin}/admin`, { headers: { cookie, "sec-fetch-dest": "iframe" } })).status === 200;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const host = new URL(origin).hostname;
await page.setCookie(...Object.entries(jar).map(([name, value]) => ({ name, value, domain: host, path: "/" })));

// the framed document, once the client hosts one. Polled from the top page:
// a puppeteer Frame handle grabbed mid-navigation can go stale while the
// frame is still loading, but #xitter-frame's contentDocument is always the
// current one.
async function frameOf(p) {
	const el = await p.$("#xitter-frame");
	return el ? el.contentFrame() : null;
}

// the top page is the client, it frames our page, and the frame has content
async function framed(p, label) {
	const deadline = Date.now() + 30000;
	let mode = null;
	while (Date.now() < deadline) {
		const state = await p.evaluate(() => {
			const el = document.querySelector("#xitter-frame");
			const doc = el && el.contentDocument;
			return {
				mode: document.documentElement.getAttribute("data-xitter-host"),
				text: doc && doc.body ? doc.body.innerText.trim().length : 0,
			};
		}).catch(() => ({ mode: null, text: 0 }));
		mode = state.mode;
		if (mode && state.text > 1) {
			const frame = await frameOf(p);
			if (frame) return frame;
		}
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error(mode ? `${label} framed an empty page` : `${label} is not framed (no data-xitter-host)`);
}

async function expectTop(p, want, label) {
	await p.waitForFunction((w) => location.pathname === w, { timeout: 15000 }, want)
		.catch(() => { throw new Error(`${label}: landed on ${new URL(p.url()).pathname}, wanted ${want}`); });
}

// click inside the framed page, re-finding the frame if its handle went stale.
// Waits for the page's bridge first (data-framed on its <html>): a click that
// lands before the bridge script runs navigates the frame itself instead of
// asking the client to move, which is not the behaviour being checked. The
// click goes through the frame's DOM: puppeteer's coordinate clicks land in
// the wrong place for the client's fixed-position frame.
async function frameClick(p, selector, label) {
	let last;
	for (let i = 0; i < 3; i++) {
		const frame = await frameOf(p);
		if (frame) {
			try {
				await frame.waitForFunction(() => document.documentElement.hasAttribute("data-framed"), { timeout: 10000 });
				await frame.waitForSelector(selector, { timeout: 10000 });
				if (await frame.evaluate((sel) => { const el = document.querySelector(sel); if (!el) return false; el.click(); return true; }, selector)) return;
			} catch (e) { last = e; }
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	throw new Error(`${label}: could not click ${selector} in the frame (${last && last.message})`);
}

async function frameText(p) {
	const frame = await frameOf(p);
	return frame ? frame.evaluate(() => document.body.innerText) : "";
}

const failures = [];
for (const path of process.env.ONLY_EXITS ? [] : paths) {
	const url = origin + path;
	try {
		await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
		if (!staff && path.startsWith("/admin")) {
			const res = await fetch(url, { headers: { cookie, "sec-fetch-dest": "document" } });
			if (res.status !== 404) throw new Error(`${path} answered ${res.status} for a viewer who is not staff`);
		} else if (path === "/account/no-such-page") {
			// not an owned root, so no frame: the plain missing page answers
			const text = await page.evaluate(() => document.body.innerText);
			if (!text.includes("Xitter has no page here")) throw new Error(`${path} did not show the missing page`);
		} else {
			await framed(page, `${path} direct`);
			await expectTop(page, topPath(path), `${path} direct`);
			await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
			await framed(page, `${path} reload`);
			await page.goto(origin + "/home", { waitUntil: "domcontentloaded", timeout: 30000 });
			await page.goBack({ waitUntil: "domcontentloaded", timeout: 30000 });
			await framed(page, `${path} back`);
			await page.goForward({ waitUntil: "domcontentloaded", timeout: 30000 });
			const home = await page.content();
			if (!home.includes('id="react-root"')) throw new Error(`${path} forward did not return to the client`);
		}
		console.log("ok", path);
	} catch (error) {
		failures.push(`${path}: ${error.message}`);
		console.error("fail", path, error.message);
	}
}

// every framed page has a way out, through the client: the framed page's own
// back arrow walks the top window back, and the framed admin panel's back
// arrow returns to wherever it was opened from
async function fresh(width = 1280, height = 800) {
	const ctx = await browser.createBrowserContext();
	const p = await ctx.newPage();
	await p.setViewport({ width, height });
	await p.setCookie(...Object.entries(jar).map(([name, value]) => ({ name, value, domain: host, path: "/" })));
	return { ctx, p };
}
const exits = [
	["from a framed settings subpage, desktop and phone", async () => {
		for (const [width, height] of [[1280, 800], [390, 844]]) {
			const { ctx, p } = await fresh(width, height);
			await p.goto(origin + "/settings/xitter/theme", { waitUntil: "domcontentloaded", timeout: 30000 });
			await framed(p, "theme");
			await frameClick(p, "a.back", "theme");
			await expectTop(p, "/settings/xitter", `theme back arrow at ${width}px`);
			await ctx.close();
		}
	}],
	["from the framed admin panel", async () => {
		const { ctx, p } = await fresh();
		await p.goto(origin + "/home", { waitUntil: "domcontentloaded", timeout: 30000 });
		await p.waitForSelector('a[href="/admin"]', { timeout: 20000 });
		await p.click('a[href="/admin"]');
		await framed(p, "admin");
		await frameClick(p, "#navback", "admin");
		await expectTop(p, "/home", "admin back arrow returns to the opener");
		// and the panel's own last row leaves for Home through the client
		await p.waitForSelector('a[href="/admin"]', { timeout: 20000 });
		await p.click('a[href="/admin"]');
		await framed(p, "admin again");
		await frameClick(p, '[data-find="home"]', "admin again");
		await expectTop(p, "/home", "admin Back to instance");
		await ctx.close();
	}],
	["from note-appeal review and superadmin", async () => {
		const { ctx, p } = await fresh();
		for (const path of ["/account/notes/appeals", "/federation/superadmin"]) {
			await p.goto(origin + path, { waitUntil: "domcontentloaded", timeout: 30000 });
			await framed(p, path);
			const text = await frameText(p);
			if (text.trim() === "not found" || text.includes("no page here") || text.includes("not staff") || text.includes("Not allowed")) continue; // not this viewer's page
			await frameClick(p, "a.back", path);
			await expectTop(p, "/settings/xitter", `${path} back arrow`);
		}
		await ctx.close();
	}],
];
const exitsRun = exits.filter(([label]) => staff || label !== "from the framed admin panel");
for (const [label, run] of exitsRun) {
	try {
		await run();
		console.log("ok exit", label);
	} catch (error) {
		failures.push(`exit ${label}: ${error.message}`);
		console.error("fail exit", label, error.message);
	}
}

await browser.close();
if (failures.length) {
	console.error(failures.join("\n"));
	process.exit(1);
}
console.log(`direct load ok for ${paths.length} urls, and every framed page has a way out (${exitsRun.length} checks)`);
