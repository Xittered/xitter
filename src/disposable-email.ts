import { readFileSync } from "node:fs";
import { join } from "node:path";
import { settings } from "./settings";

let domains: Set<string> | undefined;
const list = () => (domains ??= new Set(readFileSync(join(import.meta.dir, "disposable-domains.txt"), "utf8").split("\n").map((d) => d.trim().toLowerCase()).filter((d) => d && !d.startsWith("#"))));

export function isDisposableDomain(domain: string) {
	const parts = domain.trim().toLowerCase().replace(/\.$/, "").split(".");
	for (let i = 0; i < parts.length - 1; i++) if (list().has(parts.slice(i).join("."))) return true;
	return false;
}

export const disposableEmailRefused = (email: string) => settings().block_disposable_email && isDisposableDomain(email.split("@").pop() ?? "");

export const DISPOSABLE_EMAIL_ERROR = "Throwaway email addresses can't be used here. Use your usual email.";
