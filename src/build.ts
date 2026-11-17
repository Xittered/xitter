// The pinned client build: what scripts/fetch-client.ts took from a signed-in
// page. Kept next to the archived bundle, outside the repository.

import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CLIENT_DIR, clientDir } from "./client-cache";

export type Build = {
	sha: string;
	// CDN paths of the entry scripts, in page order (vendor, i18n, main)
	scripts: string[];
	featureSwitch: { defaultConfig: Record<string, unknown>; config: Record<string, unknown>; featureSetToken: string; settingsVersion: string };
	// page metadata minus anything about the account it was taken from
	meta: Record<string, unknown>;
	fetchedAt: string;
	// Older builds (client/old/) read a differently shaped __INITIAL_STATE__: the
	// captured one, signed-out parts and all, under ours (shell.ts)
	stateBase?: Record<string, any>;
};

// the default build's files (client-update.ts re-pins only this one)
export const BUILD_FILE = join(CLIENT_DIR, "build.json");
// webpack runtime with the chunk map; the page inlines it, there is no file for it
export const RUNTIME_FILE = join(CLIENT_DIR, "runtime.js");

type Loaded = { build: Build; runtime: string };
const cached = new Map<string, Loaded>();

// after build.json changed under the running server (client-update.ts)
export function reloadBuild() {
	cached.clear();
	registry = undefined;
}

// the build of the request being answered (server.ts picks it), else the default
export function loadBuild(dir = clientDir()): Loaded | undefined {
	const hit = cached.get(dir);
	if (hit) return hit;
	const file = join(dir, "build.json");
	const runtime = join(dir, "runtime.js");
	if (!existsSync(file) || !existsSync(runtime)) return undefined;
	const loaded = { build: JSON.parse(readFileSync(file, "utf8")), runtime: readFileSync(runtime, "utf8") };
	cached.set(dir, loaded);
	return loaded;
}

// An instance serves its CLIENT_DIR build and, next to it, the builds named in
// EXTRA_CLIENT_DIRS (comma separated, each `dir` or `id=dir`). People pick one
// of them (client-choice.ts). An old build's id is its year unless named.
export type ClientEntry = { id: string; dir: string; label: string; old: boolean };
let registry: ClientEntry[] | undefined;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function entry(dir: string, named?: string): ClientEntry | undefined {
	const build = loadBuild(dir)?.build;
	if (!build) return undefined;
	const old = !!build.stateBase;
	const dated = /^(\d{4})-(\d{2})/.exec(basename(dir)) ?? /^(\d{4})-(\d{2})/.exec(build.fetchedAt ?? "");
	const id = named ?? (old ? (dated?.[1] ?? basename(dir)) : "current");
	const label = old ? `Twitter, ${dated ? `${MONTHS[Number(dated[2]) - 1]} ${dated[1]}` : id}` : "X, current";
	return { id, dir, label, old };
}

export function clientBuilds(): ClientEntry[] {
	if (registry) return registry;
	const list: ClientEntry[] = [];
	const add = (e: ClientEntry | undefined) => {
		if (e && !list.some((x) => x.id === e.id || x.dir === e.dir)) list.push(e);
	};
	add(entry(CLIENT_DIR));
	for (const part of (process.env.EXTRA_CLIENT_DIRS ?? "").split(",")) {
		const item = part.trim();
		if (!item) continue;
		const eq = /^([\w-]+)=(.+)$/.exec(item);
		const e = eq ? entry(eq[2]!.trim(), eq[1]) : entry(item);
		if (!e) console.warn(`EXTRA_CLIENT_DIRS: no build in ${eq ? eq[2] : item}`);
		add(e);
	}
	registry = list;
	return list;
}

export const clientBuild = (id: string | undefined | null) => (id ? clientBuilds().find((b) => b.id === id) : undefined);
