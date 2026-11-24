// Whether this instance runs the latest Xitter, for the banner atop the admin
// panel. Every six hours it asks GitHub about the repository's main branch
// (UPDATE_REPO, else the one last updated from in the panel (self-update.ts),
// else the GitHub repository source_url names, else Xittered/xitter;
// UPDATE_BRANCH, else the panel's; UPDATE_CHECK=off turns it off).
//
// With a known commit (a git checkout, or XITTER_COMMIT) GitHub says how many
// commits the branch is ahead of it. The Docker image has no .git, so without
// one the code's files are compared with the branch's by their git blob
// hashes: any that differ, or that the branch added or removed, mean an update.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { settings } from "./settings";
import { selfUpdateEnabled, startSelfUpdate } from "./self-update";
import { COMMIT } from "./version";

const root = join(import.meta.dir, "..");
const branch = () => process.env.UPDATE_BRANCH || settings().update_source.branch || "main";
const EVERY = Math.max(1, Number(process.env.UPDATE_CHECK_MINUTES) || 360) * 60_000;
// what the Docker image is built from (Dockerfile COPY), minus the instance list, which is data
const TRACKED = (path: string) => /^(src|public)\//.test(path) || path === "package.json" || path === "bun.lock";

export type UpdateStatus = {
	repo: string;
	branch: string;
	checked_at: string;
	// the branch's newest commit
	latest: { sha: string; date: string | null; message: string } | null;
	// commits the branch has that this instance hasn't, when its commit is known
	behind: number | null;
	// files that differ from the branch's, when it isn't
	changed_files: number | null;
	outdated: boolean;
	error: string | null;
};

let status: UpdateStatus | null = null;
export const updateStatus = () => status;

export function updateRepo(): string {
	if (process.env.UPDATE_REPO) return process.env.UPDATE_REPO;
	if (settings().update_source.repo) return settings().update_source.repo;
	const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(settings().source_url.trim());
	return m?.[1] ?? "Xittered/xitter";
}

// GitHub allows 60 requests an hour per address without a token, shared with
// whatever else runs there. An answer of "not modified" to a request that
// names the last answer's ETag doesn't count, so the answers are kept.
const answers = new Map<string, { etag: string; body: unknown }>();

async function github(path: string): Promise<any> {
	const url = `https://api.github.com/repos/${updateRepo()}${path}`;
	const kept = answers.get(url);
	const token = process.env.UPDATE_GITHUB_TOKEN;
	const r = await fetch(url, {
		headers: {
			accept: "application/vnd.github+json",
			"user-agent": "xitter-update-check",
			...(token ? { authorization: `Bearer ${token}` } : {}),
			...(kept ? { "if-none-match": kept.etag } : {}),
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (r.status === 304 && kept) return kept.body;
	if (r.status === 404) return undefined;
	if ((r.status === 403 || r.status === 429) && r.headers.get("x-ratelimit-remaining") === "0") {
		const reset = new Date(Number(r.headers.get("x-ratelimit-reset")) * 1000);
		throw new Error(`GitHub's hourly limit for this server's address is used up until ${reset.toISOString().slice(11, 16)} UTC${token ? "" : "; UPDATE_GITHUB_TOKEN raises it"}`);
	}
	if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
	const body = await r.json();
	const etag = r.headers.get("etag");
	if (etag) answers.set(url, { etag, body });
	return body;
}

// git's name for a file's contents. Text checked out on Windows may have CRLF
// line ends that the repository stores as LF.
export function blobSha(bytes: Buffer): string {
	const body = bytes.includes(0) ? bytes : Buffer.from(bytes.toString("latin1").replace(/\r\n/g, "\n"), "latin1");
	return createHash("sha1").update(`blob ${body.length}\0`).update(body).digest("hex");
}

function localFiles(): Map<string, string> {
	const out = new Map<string, string>();
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else out.set(relative(root, path).split(sep).join("/"), path);
		}
	};
	walk(join(root, "src"));
	walk(join(root, "public"));
	for (const f of ["package.json", "bun.lock"]) if (existsSync(join(root, f))) out.set(f, join(root, f));
	return out;
}

// how many tracked files differ from the branch's tree
export function differingFiles(tree: { path: string; type: string; sha: string }[], local = localFiles()): number {
	let changed = 0;
	const upstream = new Set<string>();
	for (const t of tree) {
		if (t.type !== "blob" || !TRACKED(t.path)) continue;
		upstream.add(t.path);
		const path = local.get(t.path);
		if (!path || blobSha(readFileSync(path)) !== t.sha) changed++;
	}
	for (const path of local.keys()) if (TRACKED(path) && !upstream.has(path)) changed++;
	return changed;
}

export async function checkForUpdate(): Promise<UpdateStatus> {
	// an admin pressing "Check again" over and over shouldn't use up GitHub's hourly allowance
	const base = { repo: updateRepo(), branch: branch(), checked_at: new Date().toISOString() };
	if (status && !status.error && status.repo === base.repo && status.branch === base.branch && Date.now() - Date.parse(status.checked_at) < 60_000) return status;
	try {
		const head = await github(`/commits/${encodeURIComponent(base.branch)}`);
		if (!head?.sha) throw new Error(`No branch ${base.branch} in ${base.repo}`);
		const latest = { sha: String(head.sha), date: head.commit?.committer?.date ?? null, message: String(head.commit?.message ?? "").split("\n")[0].slice(0, 200) };
		let behind: number | null = null;
		let changed: number | null = null;
		if (COMMIT && latest.sha.startsWith(COMMIT)) behind = 0;
		else if (COMMIT) {
			// a commit GitHub doesn't know (one made here and not pushed) says nothing either way
			const compare = await github(`/compare/${COMMIT}...${latest.sha}`);
			behind = typeof compare?.ahead_by === "number" ? compare.ahead_by : null;
		} else {
			const tree = await github(`/git/trees/${head.commit.tree.sha}?recursive=1`);
			if (!Array.isArray(tree?.tree) || tree.truncated) throw new Error("GitHub sent no file list");
			changed = differingFiles(tree.tree);
		}
		status = { ...base, latest, behind, changed_files: changed, outdated: (behind ?? 0) > 0 || (changed ?? 0) > 0, error: null };
		autoUpdate(status);
	} catch (e) {
		// keep what the last good check found
		status = { ...(status ?? { latest: null, behind: null, changed_files: null, outdated: false }), ...base, error: e instanceof Error ? e.message : String(e) };
	}
	return status;
}

// Admin > Server update > "Update automatically". A git checkout with
// SELF_UPDATE=on updates itself; anything else (the Docker image) leaves a
// request in data/ for the updater container (compose profile "updater",
// docker/updater.sh) to pull and rebuild. Each new commit is tried once.
const REQUEST_FILE = process.env.UPDATE_REQUEST_FILE ?? "data/update-request.json";
let tried = "";

function autoUpdate(s: UpdateStatus) {
	if (!s.outdated || !s.latest || !settings().auto_update || tried === s.latest.sha) return;
	tried = s.latest.sha;
	if (selfUpdateEnabled() && existsSync(join(root, ".git"))) {
		try {
			startSelfUpdate("auto-update", s.repo, s.branch);
		} catch (e) {
			console.error("auto-update:", e instanceof Error ? e.message : e);
		}
		return;
	}
	mkdirSync(join(REQUEST_FILE, ".."), { recursive: true });
	writeFileSync(REQUEST_FILE, JSON.stringify({ sha: s.latest.sha, repo: s.repo, branch: s.branch, at: new Date().toISOString() }));
}

export function startUpdateChecks() {
	if (process.env.UPDATE_CHECK === "off") return;
	setInterval(() => void checkForUpdate(), EVERY).unref();
	void checkForUpdate();
}
