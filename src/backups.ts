// Database backups for Admin > Backups: pg_dump's custom format (compressed,
// restored with pg_restore), kept in BACKUP_DIR. Uploaded files live in
// media/ and data/ and are not part of it; copy those directories as well.

import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { recordError } from "./errors";
import { settings } from "./settings";

export const BACKUP_DIR = process.env.BACKUP_DIR ?? "data/backups";
// how often the schedule may run, in hours
export const BACKUP_INTERVALS = [1, 2, 4, 6, 12, 24];
export const MAX_BACKUPS_KEPT = 500;
const PG_DUMP = process.env.PG_DUMP ?? "pg_dump";
const NAME = /^xitter-\d{8}-\d{6}\.dump$/;

export const isBackupName = (name: string) => NAME.test(name);
export const backupPath = (name: string) => (isBackupName(name) ? join(BACKUP_DIR, name) : undefined);

export function listBackups() {
	if (!existsSync(BACKUP_DIR)) return [];
	return readdirSync(BACKUP_DIR)
		.filter(isBackupName)
		.map((name) => {
			const s = statSync(join(BACKUP_DIR, name));
			return { name, bytes: s.size, created_at: s.mtime.toISOString() };
		})
		.sort((a, b) => b.name.localeCompare(a.name));
}

let running: Promise<{ name: string; bytes: number }> | undefined;

// one dump at a time; a second request waits for the first
export function createBackup() {
	running ??= (async () => {
		mkdirSync(BACKUP_DIR, { recursive: true });
		const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
		const name = `xitter-${stamp.slice(0, 8)}-${stamp.slice(8)}.dump`;
		const path = join(BACKUP_DIR, name);
		const dump = Bun.spawn([PG_DUMP, "--format=custom", "--no-owner", "--file", path, process.env.BACKUP_DATABASE_URL ?? process.env.DATABASE_URL ?? "postgres://dev@localhost:5432/xitter"], { stderr: "pipe", stdout: "ignore" });
		const [code, err] = await Promise.all([dump.exited, new Response(dump.stderr).text()]);
		if (code !== 0) {
			if (existsSync(path)) unlinkSync(path);
			throw new Error(`pg_dump failed: ${err.trim().split("\n").pop() || `exit ${code}`}`);
		}
		return { name, bytes: statSync(path).size };
	})().finally(() => {
		running = undefined;
	});
	return running;
}

export function deleteBackup(name: string) {
	const path = backupPath(name);
	if (!path || !existsSync(path)) return false;
	unlinkSync(path);
	return true;
}

function prune(keep: number) {
	for (const b of listBackups().slice(keep)) deleteBackup(b.name);
}

// on a schedule: a dump when the newest is `every_hours` old, then the oldest
// beyond `keep` go. The check runs every few minutes, so a dump that took a
// while doesn't push the next one back by a whole check.
export function startBackups() {
	const tick = async () => {
		const { daily, keep, every_hours } = settings().backups;
		if (!daily) return;
		const hours = BACKUP_INTERVALS.includes(every_hours) ? every_hours : 24;
		const newest = listBackups()[0];
		if (newest && Date.now() - Date.parse(newest.created_at) < hours * 3600e3 - 5 * 60_000) return;
		try {
			await createBackup();
			prune(keep);
		} catch (e) {
			console.error("backup:", e);
			await recordError("job", e, { path: "scheduled backup" });
		}
	};
	setInterval(() => void tick().catch((e) => console.error("backups:", e)), 5 * 60_000).unref();
	void tick().catch((e) => console.error("backups:", e));
}
