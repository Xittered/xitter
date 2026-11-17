// Sets up an older web client build (2020-2021) from a saved twitter.com page,
// for a server started with CLIENT_DIR pointing at the result. Old builds' files
// are still on abs.twimg.com; the server downloads each one on first use, the
// same as for the pinned build. What only the page has is the webpack chunk map
// (an inline script) and the page's own initial state, which src/shell.ts uses
// as the base for an old build's state (Build.stateBase) and src/adaptive.ts
// answers the API calls of.
//
//   bun scripts/fetch-old-client.ts <saved page: file or https URL> <out dir> [--all]
//
//   --all  download every chunk now instead of on first use
//
// Pages with a full 2020 build: a twitter.com snapshot whose HTML carries
// "client-web-legacy/main.<hash>.js" or "client-web/main.<hash>.js" and an inline
// script with `.src=function(e){return`. Page code is only read as text here.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Build } from "../src/build";

const [source, outArg, flag] = process.argv.slice(2);
if (!source || !outArg) throw new Error("usage: bun scripts/fetch-old-client.ts <saved page file or URL> <out dir> [--all]");
const out = resolve(outArg);
const html = /^https:\/\//.test(source) ? await (await fetch(source)).text() : readFileSync(source, "utf8");

const runtime = html
	.split("<script")
	.map((s) => s.slice(s.indexOf(">") + 1, s.indexOf("</script>")))
	.find((s) => s.includes(".src=function(e){return "));
if (!runtime) throw new Error("no webpack runtime in the page: not a 2020-era client page");

// window.<name> = {...}; read as JSON up to the brace that closes it
function pageJson(name: string): Record<string, any> {
	const at = html.indexOf(`window.${name} = `);
	if (at < 0) throw new Error(`no ${name} in the page`);
	const start = at + `window.${name} = `.length;
	let depth = 0, str = false, esc = false;
	for (let k = start; k < html.length; k++) {
		const c = html[k];
		if (str) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') str = false;
		} else if (c === '"') str = true;
		else if (c === "{" || c === "[") depth++;
		else if ((c === "}" || c === "]") && --depth === 0) return JSON.parse(html.slice(start, k + 1));
	}
	throw new Error(`${name} doesn't end`);
}
const state = pageJson("__INITIAL_STATE__");
const meta = pageJson("__META_DATA__");

const base = /https:\/\/abs\.twimg\.com(\/responsive-web\/client-web[a-z-]*\/)/.exec(html)?.[1];
if (!base) throw new Error("no client-web path in the page");
const entry = [...html.matchAll(/crossorigin="anonymous" src="https:\/\/abs\.twimg\.com([^"]+\.js)"/g)].map((m) => m[1]);

const fs = state.featureSwitch ?? {};
const build: Build = {
	sha: meta.sha,
	scripts: entry,
	featureSwitch: {
		defaultConfig: fs.defaultConfig ?? {},
		config: fs.user?.config ?? fs.config ?? {},
		featureSetToken: fs.featureSetToken ?? "",
		settingsVersion: fs.user?.settingsVersion ?? fs.settingsVersion ?? "",
	},
	// what describes the build, not whoever saved the page
	meta: Object.fromEntries(Object.entries(meta).filter(([k]) => !["isLoggedIn", "hasMultiAccountCookie", "serverDate", "sha", "userId"].includes(k))),
	fetchedAt: new Date(meta.serverDate ?? Date.now()).toISOString(),
	stateBase: { ...state, session: { ...state.session, guestId: "" } },
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "build.json"), JSON.stringify(build, null, "\t"));
writeFileSync(join(out, "runtime.js"), runtime);
console.log(`build ${build.sha}: ${entry.length} entry scripts under ${base}, ${Object.keys(build.featureSwitch.config).length} switches -> ${out}`);

if (flag === "--all") {
	// the runtime's chunk maps: {id:"name"}[e]||e)+"."+{id:"hash"}[e]+"<suffix>.js"
	const maps = [...runtime.matchAll(/\{(\d+:"[^"]*"(?:,\d+:"[^"]*")*)\}/g)].map((m) => Object.fromEntries([...m[1].matchAll(/(\d+):"([^"]*)"/g)].map((x) => [x[1], x[2]])));
	const suffix = /\[e\]\+"([^"]*\.js)"/.exec(runtime)?.[1] ?? ".js";
	const [names, hashes] = maps.length >= 2 ? maps : [{}, maps[0] ?? {}];
	const files = [...new Set([...entry, ...Object.keys(hashes).map((id) => `${base}${names[id] ?? id}.${hashes[id]}${suffix}`)])];
	process.env.CLIENT_DIR = out;
	const { getClientFile } = await import("../src/client-cache");
	let ok = 0;
	const missing: string[] = [];
	for (const f of files) ((await getClientFile(f)) ? ok++ : missing.push(f));
	console.log(`${ok}/${files.length} files${missing.length ? `, missing: ${missing.join(" ")}` : ""}`);
	if (!existsSync(join(out, "abs"))) throw new Error("nothing downloaded");
}
