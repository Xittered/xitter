// The instance's logo and icons, uploaded from the admin panel. Each slot
// replaces one of the shipped files in public/ under the same name.

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { StorageFailure, putFile } from "./disk";
import { STORAGE_SENTENCE } from "./notices";

const dir = () => process.env.BRANDING_DIR ?? "data/branding";

export const SLOTS = {
	"logo-dark": "Word mark on dark themes (wide sidebar, sign-in page)",
	"logo-light": "Word mark on the light theme",
	"icon-dark": "Icon on dark themes (narrow sidebar)",
	"icon-light": "Icon on the light theme",
	favicon: "Browser tab icon",
	"app-icon": "PWA app icon (home screen, notifications): square, 512×512, no transparency",
} as const;
export type Slot = keyof typeof SLOTS;

const TYPES: [string, number[]][] = [
	["image/png", [0x89, 0x50, 0x4e, 0x47]],
	["image/jpeg", [0xff, 0xd8, 0xff]],
	["image/webp", [0x52, 0x49, 0x46, 0x46]],
];
const sniff = (b: Uint8Array) => TYPES.find(([, magic]) => magic.every((m, i) => b[i] === m))?.[0];

const path = (slot: string) => `${dir()}/${slot}`;

// the uploaded file for a public/ name like "logo-dark.png"
export function brandingFile(name: string) {
	const slot = name.replace(/\.png$/, "");
	if (!(slot in SLOTS) || !existsSync(path(slot))) return undefined;
	const file = Bun.file(path(slot));
	const head = new Uint8Array(readFileSync(path(slot)).subarray(0, 4));
	return { file, type: sniff(head) ?? "application/octet-stream" };
}

export async function saveBranding(slot: string, data: Uint8Array): Promise<string | undefined> {
	if (!(slot in SLOTS)) return "Unknown slot.";
	if (data.length > 2 * 1024 * 1024) return "Images are up to 2 MB.";
	// raster only: an SVG could carry script
	if (!sniff(data)) return "Use a PNG, JPEG or WebP image.";
	try {
		await putFile(path(slot), data);
	} catch (e) {
		if (e instanceof StorageFailure) return STORAGE_SENTENCE;
		throw e;
	}
}

export function resetBranding(slot: string) {
	if (slot in SLOTS && existsSync(path(slot))) unlinkSync(path(slot));
}

export const brandingState = () => Object.fromEntries(Object.keys(SLOTS).map((s) => [s, existsSync(path(s))]));
