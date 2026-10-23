// Parsing, sanitise/import/export, look/prefs, contrast. Theme types live in presets.ts.

import { validateFamily } from "../fonts";
import { isId } from "../ids";
import { readStoredSteam, steamDefId, type SteamDefId, type StoredSteam } from "../steam-items";
import {
	ACCENT_IDS,
	ACCENTS,
	DEFAULT_ACCENT,
	PRESETS,
	accentWire,
	fillOfAccent,
	themeColorOf,
	type Accent,
	type AccentId,
	type BackgroundKnobs,
	type BgFit,
	type BgPosition,
	type BgRepeat,
	type BgScale,
	type BlurPx,
	type Dim,
	type PanelOpacity,
	type Fill,
	type Gradient,
	type MediaId,
	type Theme,
	type ThemeBackground,
	type ThemeFont,
	type ThemeFrame,
} from "./presets";

export type Sanitised = { theme: Theme; warnings: string[] };

export const TEXT_FIELDS = ["text", "secondary", "muted", "link", "inputText", "buttonText", "secondaryButtonText"] as const;

export const THEME_FORMAT = "xitter-theme" as const;
export const THEME_VERSION = 1 as const;
export const THEME_FILE_MAX = 64 * 1024;
export const THEME_DEPTH_MAX = 6;
export const BACKGROUND_OMITTED = "background image not included; upload it again";

export type ThemeError = { readonly path: string; readonly message: string };
export type ThemeMode = "read" | "save" | "import";
export type ParsedTheme =
	| { readonly ok: true; readonly theme: Theme; readonly warnings: readonly string[] }
	| { readonly ok: false; readonly errors: readonly ThemeError[] };

export type SharedBackground = BackgroundKnobs & {
	readonly steam?: { readonly defid: number };
	readonly mediaId?: MediaId;
};

export type BackgroundSource =
	| { readonly tag: "none" }
	| { readonly tag: "upload"; readonly mediaId: MediaId }
	| { readonly tag: "steam"; readonly defid: SteamDefId };

export const STEAM_MISSING = "Steam doesn't have that background.";
export type ImportedTheme = Omit<Theme, "background"> & { background?: SharedBackground };
export type ImportResult =
	| { readonly ok: true; readonly theme: ImportedTheme; readonly warnings: readonly string[] }
	| { readonly ok: false; readonly errors: readonly ThemeError[] };
export type SharedTheme = Omit<Theme, "background"> & { readonly background?: SharedBackground };
export type ThemeFile = { readonly format: typeof THEME_FORMAT; readonly version: typeof THEME_VERSION; readonly theme: SharedTheme };

type FieldKind = "id" | "base" | "hex" | "fill" | "gradient" | "font" | "background";
type FieldSpec<K extends keyof Theme = keyof Theme> = { readonly key: K; readonly kind: FieldKind; readonly required: boolean; readonly share: boolean };

const THEME_FIELDS = [
	{ key: "id", kind: "id", required: true, share: true },
	{ key: "base", kind: "base", required: true, share: true },
	{ key: "bg", kind: "gradient", required: true, share: true },
	{ key: "surface", kind: "fill", required: true, share: true },
	{ key: "text", kind: "hex", required: true, share: true },
	{ key: "accent", kind: "fill", required: true, share: true },
	{ key: "button", kind: "gradient", required: true, share: true },
	{ key: "buttonText", kind: "hex", required: true, share: true },
	{ key: "link", kind: "hex", required: false, share: true },
	{ key: "secondary", kind: "hex", required: false, share: true },
	{ key: "muted", kind: "hex", required: false, share: true },
	{ key: "border", kind: "hex", required: false, share: true },
	{ key: "divider", kind: "hex", required: false, share: true },
	{ key: "hover", kind: "hex", required: false, share: true },
	{ key: "inputBg", kind: "hex", required: false, share: true },
	{ key: "inputText", kind: "hex", required: false, share: true },
	{ key: "inputBorder", kind: "hex", required: false, share: true },
	{ key: "header", kind: "fill", required: false, share: true },
	{ key: "menu", kind: "fill", required: false, share: true },
	{ key: "tooltip", kind: "hex", required: false, share: true },
	{ key: "icon", kind: "hex", required: false, share: true },
	{ key: "iconActive", kind: "hex", required: false, share: true },
	{ key: "reply", kind: "hex", required: false, share: true },
	{ key: "repost", kind: "hex", required: false, share: true },
	{ key: "like", kind: "hex", required: false, share: true },
	{ key: "bookmark", kind: "hex", required: false, share: true },
	{ key: "views", kind: "hex", required: false, share: true },
	{ key: "secondaryButton", kind: "fill", required: false, share: true },
	{ key: "secondaryButtonBorder", kind: "hex", required: false, share: true },
	{ key: "secondaryButtonText", kind: "hex", required: false, share: true },
	{ key: "buttonHover", kind: "hex", required: false, share: true },
	{ key: "badge", kind: "hex", required: false, share: true },
	{ key: "selection", kind: "hex", required: false, share: true },
	{ key: "font", kind: "font", required: false, share: true },
	{ key: "background", kind: "background", required: false, share: true },
] as const satisfies readonly FieldSpec[];

const BACKGROUND_FIELDS = [
	{ key: "fit", share: true, onImport: "take" },
	{ key: "position", share: true, onImport: "take" },
	{ key: "dim", share: true, onImport: "take" },
	{ key: "blur", share: true, onImport: "take" },
	{ key: "scale", share: true, onImport: "take" },
	{ key: "repeat", share: true, onImport: "take" },
	{ key: "panel", share: true, onImport: "take" },
	{ key: "mediaId", share: false, onImport: "forbid" },
	{ key: "steam", share: false, onImport: "take" },
] as const;

const FONT_KEYS = ["ui", "display"] as const;
const BANNED_KEYS = ["__proto__", "constructor", "prototype"] as const;
const IMPORT_FORBIDDEN = ["mediaId", "url", "src", "href"] as const;
const FITS = ["cover", "contain", "tile"] as const;
const POSITIONS = ["center", "top", "bottom"] as const;
const REPEATS = ["repeat", "space", "round"] as const;
const KEY_CAP = THEME_FIELDS.length + 8;
const ARRAY_CAP = 5;

type Listed = (typeof THEME_FIELDS)[number]["key"];
type FieldsCoverTheme = Exclude<keyof Theme, Listed> extends never ? (Exclude<Listed, keyof Theme> extends never ? true : never) : never;
const fieldsCoverTheme: FieldsCoverTheme = true;
void fieldsCoverTheme;

type ListedBg = (typeof BACKGROUND_FIELDS)[number]["key"];
type BgCovered = Exclude<keyof ThemeBackground, ListedBg> extends never ? (Exclude<ListedBg, keyof ThemeBackground> extends never ? true : never) : never;
const bgCovered: BgCovered = true;
void bgCovered;

export const OPTIONAL_HEX = THEME_FIELDS.filter((f) => f.kind === "hex" && !f.required).map((f) => f.key);
export const OPTIONAL_FILL = THEME_FIELDS.filter((f) => f.kind === "fill" && !f.required).map((f) => f.key);
export const GRADIENT_FIELDS = THEME_FIELDS.filter((f) => f.kind === "gradient" || f.kind === "fill").map((f) => f.key);

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{6})$/i;

export function parseHex(v: unknown): string | undefined {
	if (typeof v !== "string") return;
	const s = v.trim().toLowerCase();
	const m6 = HEX6.exec(s);
	if (m6) return `#${m6[1]}`;
	const m3 = HEX3.exec(s);
	if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
}

function rgb(h: string): [number, number, number] {
	return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function toHex(r: number, g: number, b: number): string {
	return `#${[r, g, b]
		.map((n) => Math.round(Math.max(0, Math.min(255, n)))
			.toString(16)
			.padStart(2, "0"))
		.join("")}`;
}

export function mixHex(a: string, b: string, t: number): string {
	const A = rgb(a),
		B = rgb(b);
	return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}

export function averageHex(stops: string[]): string {
	const rs = stops.map(rgb);
	const n = rs.length || 1;
	return toHex(
		rs.reduce((s, c) => s + c[0], 0) / n,
		rs.reduce((s, c) => s + c[1], 0) / n,
		rs.reduce((s, c) => s + c[2], 0) / n,
	);
}

function lin(c: number): number {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function lum(h: string): number {
	const [r, g, b] = rgb(h);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrast(a: string, b: string): number {
	const L1 = lum(a),
		L2 = lum(b);
	const [hi, lo] = L1 > L2 ? [L1, L2] : [L2, L1];
	return (hi + 0.05) / (lo + 0.05);
}

export const WHITE = "#ffffff";
export const INK = "#0f1419";
const REPOST = "#00ba7c";
const LIKE = "#f91880";

// Text on an accent-filled button. X keeps white on its own accents (blue
// included, which a pure contrast pick would flip to ink), and only the
// light ones (yellow) take ink; the client uses the same cut.
export function accentTextOn(hex: string): string {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) return WHITE;
	const [r, g, b] = [m[1]!, m[2]!, m[3]!].map((v) => parseInt(v, 16)) as [number, number, number];
	return (r * 299 + g * 587 + b * 114) / 1000 > 160 ? INK : WHITE;
}

export function readableOn(bgs: string[]): string {
	const score = (t: string) => Math.min(...bgs.map((bg) => contrast(t, bg)));
	return score(WHITE) >= score(INK) ? WHITE : INK;
}

function intAngle(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : typeof v === "string" && /^-?\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
	if (!Number.isInteger(n) || n < 0 || n > 360) return;
	return n;
}

function parseGradient(v: unknown): Gradient | undefined {
	if (!v || typeof v !== "object") return;
	const g = v as Record<string, unknown>;
	if (!Array.isArray(g.stops) || g.stops.length < 1 || g.stops.length > 5) return;
	const stops = g.stops.map(parseHex);
	if (stops.some((s) => !s)) return;
	const angle = intAngle(g.angle);
	if (angle === undefined) return;
	return { stops: stops as string[], angle };
}

function parseGradientOrHex(v: unknown): Gradient | undefined {
	const h = parseHex(v);
	if (h) return { stops: [h], angle: 180 };
	return parseGradient(v);
}

function parseFill(v: unknown): Fill | undefined {
	const h = parseHex(v);
	if (h) return h;
	return parseGradient(v);
}

export function solidOf(f: Fill): string {
	return typeof f === "string" ? f : averageHex(f.stops);
}

export function stopsOf(f: Fill): string[] {
	return typeof f === "string" ? [f] : f.stops;
}

const ACCENT_ID_SET = new Set<string>(ACCENT_IDS);
const HEX_TO_ACCENT = Object.fromEntries(ACCENT_IDS.map((id) => [ACCENTS[id], id])) as Record<string, AccentId>;

export type Prefs = {
	readonly look: Look | null;
	readonly accent: Accent;
};

export function parseAccent(v: unknown): Accent | null {
	if (typeof v === "string" && ACCENT_ID_SET.has(v)) return { kind: "named", id: v as AccentId };
	const fill = parseFill(v);
	if (!fill) return null;
	if (typeof fill === "string") {
		const id = HEX_TO_ACCENT[fill];
		return id ? { kind: "named", id } : { kind: "custom", fill };
	}
	if (fill.stops.length === 1) {
		const id = HEX_TO_ACCENT[fill.stops[0]!];
		if (id) return { kind: "named", id };
		return { kind: "custom", fill: fill.stops[0]! };
	}
	return { kind: "custom", fill };
}

export function overlayAccent(look: Look | null, accent: Accent): Look | null {
	if (!look || look.kind !== "painted") return look;
	return { kind: "painted", theme: { ...look.theme, accent: fillOfAccent(accent) } };
}

export function fillCss(g: Fill): string {
	if (typeof g === "string") return g;
	return g.stops.length === 1 ? g.stops[0]! : `linear-gradient(${g.angle}deg,${g.stops.join(",")})`;
}

export function rgba(h: string, a: number): string {
	const [r, g, b] = rgb(h);
	return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function alphaBg(h: string, a: number): string {
	const [r, g, b] = rgb(h);
	return `rgb(${r} ${g} ${b} / ${a})`;
}

export type Resolved = {
	bg: string;
	surface: string;
	text: string;
	accent: string;
	accentFill: string;
	button: string;
	buttonText: string;
	link: string;
	secondary: string;
	muted: string;
	border: string;
	divider: string;
	hover: string;
	inputBg: string;
	inputText: string;
	inputBorder: string;
	header: string;
	menu: string;
	tooltip: string;
	icon: string;
	iconActive: string;
	reply: string;
	repost: string;
	like: string;
	bookmark: string;
	views: string;
	secondaryButton: string;
	secondaryButtonBorder: string;
	secondaryButtonText: string;
	buttonHover: string;
	badge: string;
	selection: string;
	accentSoft: string;
	replySoft: string;
	repostSoft: string;
	likeSoft: string;
	bookmarkSoft: string;
};

export function derived(theme: Theme): Resolved {
	const avg = averageHex(theme.bg.stops);
	const surface = solidOf(theme.surface);
	const text = theme.text;
	const muted = theme.muted ?? mixHex(text, avg, 0.45);
	const border = theme.border ?? mixHex(text, avg, 0.82);
	const accentSolid = solidOf(theme.accent);
	const reply = theme.reply ?? accentSolid;
	const bookmark = theme.bookmark ?? accentSolid;
	const like = theme.like ?? LIKE;
	const repost = theme.repost ?? REPOST;
	const tr = rgb(text);
	return {
		bg: fillCss(theme.bg),
		surface: fillCss(theme.surface),
		text,
		accent: accentSolid,
		accentFill: fillCss(theme.accent),
		button: fillCss(theme.button),
		buttonText: theme.buttonText,
		link: theme.link ?? accentSolid,
		secondary: theme.secondary ?? mixHex(text, avg, 0.28),
		muted,
		border,
		divider: theme.divider ?? border,
		hover: theme.hover ?? `rgb(${tr[0]} ${tr[1]} ${tr[2]} / .1)`,
		inputBg: theme.inputBg ?? mixHex(surface, text, 0.08),
		inputText: theme.inputText ?? text,
		inputBorder: theme.inputBorder ?? border,
		header: theme.header ? fillCss(theme.header) : alphaBg(avg, 0.85),
		menu: theme.menu ? fillCss(theme.menu) : fillCss(theme.surface),
		tooltip: theme.tooltip ?? mixHex(surface, text, 0.16),
		icon: theme.icon ?? muted,
		iconActive: theme.iconActive ?? text,
		reply,
		repost,
		like,
		bookmark,
		views: theme.views ?? muted,
		secondaryButton: theme.secondaryButton ? fillCss(theme.secondaryButton) : "transparent",
		secondaryButtonBorder: theme.secondaryButtonBorder ?? border,
		secondaryButtonText: theme.secondaryButtonText ?? text,
		buttonHover: theme.buttonHover ?? mixHex(solidOf(theme.button), text, 0.12),
		badge: theme.badge ?? accentSolid,
		selection: theme.selection ?? rgba(accentSolid, 0.28),
		accentSoft: rgba(accentSolid, 0.1),
		replySoft: rgba(reply, 0.1),
		repostSoft: rgba(repost, 0.1),
		likeSoft: rgba(like, 0.1),
		bookmarkSoft: rgba(bookmark, 0.1),
	};
}

function warnPairs(label: string, fg: string, bgs: string[], min = 4.5): string[] {
	const out: string[] = [];
	for (const bg of bgs) {
		const c = contrast(fg, bg);
		if (c < min) out.push(`${label} on ${bg} is ${c.toFixed(2)}:1`);
	}
	return out;
}

function clampFg(fg: string, bgs: string[]): string {
	if (!bgs.length || Math.min(...bgs.map((bg) => contrast(fg, bg))) >= 3) return fg;
	return readableOn(bgs);
}

const asMediaId = (v: string): MediaId => v as MediaId;
const asDim = (n: number): Dim => n as Dim;
const asBlur = (n: number): BlurPx => n as BlurPx;
const asScale = (n: number): BgScale => n as BgScale;
const asPanel = (n: number): PanelOpacity => n as PanelOpacity;

function boundedInt(v: unknown, min: number, max: number): number | undefined {
	if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return;
	return v;
}

function parseRepeat(v: unknown): BgRepeat | undefined {
	if (typeof v !== "string" || !(REPEATS as readonly string[]).includes(v)) return;
	return v as BgRepeat;
}

export function backgroundKnobs(bg: BackgroundKnobs): BackgroundKnobs {
	return { fit: bg.fit, position: bg.position, dim: bg.dim, blur: bg.blur, scale: bg.scale, repeat: bg.repeat, panel: bg.panel };
}

export function sharedBackground(bg: ThemeBackground | BackgroundKnobs): SharedBackground {
	const knobs = backgroundKnobs(bg);
	return "steam" in bg && bg.steam ? { ...knobs, steam: { defid: bg.steam.defid } } : knobs;
}

function pushError(errors: ThemeError[], path: string, message: string) {
	errors.push({ path, message });
}

function isBanned(key: string): boolean {
	return (BANNED_KEYS as readonly string[]).includes(key);
}

function isForbiddenImport(key: string): boolean {
	return (IMPORT_FORBIDDEN as readonly string[]).includes(key);
}

function checkShape(value: unknown, depth: number, path: string, mode: ThemeMode, errors: ThemeError[]) {
	if (Array.isArray(value)) {
		if (value.length > ARRAY_CAP) pushError(errors, path, "too many items");
		const n = Math.min(value.length, ARRAY_CAP + 1);
		for (let i = 0; i < n; i++) {
			const child = `${path}[${i}]`;
			if (depth + 1 > THEME_DEPTH_MAX) {
				pushError(errors, child, "too deeply nested");
				continue;
			}
			checkShape(value[i], depth + 1, child, mode, errors);
		}
		return;
	}
	if (!value || typeof value !== "object") return;
	if (depth > THEME_DEPTH_MAX) {
		pushError(errors, path, "too deeply nested");
		return;
	}
	const keys = Object.keys(value);
	if (keys.length > KEY_CAP) pushError(errors, path, "too many keys");
	for (const key of keys) {
		const childPath = path ? `${path}.${key}` : key;
		if (isBanned(key)) {
			if (mode !== "read") pushError(errors, childPath, "banned key");
			if (mode === "read") continue;
		} else if (mode === "import" && isForbiddenImport(key)) pushError(errors, childPath, "forbidden key");
		const child = (value as Record<string, unknown>)[key];
		if (depth + 1 > THEME_DEPTH_MAX && child && typeof child === "object") {
			pushError(errors, childPath, "too deeply nested");
			continue;
		}
		checkShape(child, depth + 1, childPath, mode, errors);
	}
}

function hexOfMode(v: unknown, mode: ThemeMode): string | undefined {
	if (typeof v !== "string") return;
	const s = v.trim().toLowerCase();
	const m6 = HEX6.exec(s);
	if (m6) return `#${m6[1]}`;
	if (mode === "import") return;
	const m3 = HEX3.exec(s);
	if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
}

function angleOfMode(v: unknown, mode: ThemeMode): number | undefined {
	if (mode === "import") {
		if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 360) return;
		return v;
	}
	return intAngle(v);
}

function ownUnknown(value: object, allowed: readonly string[], path: string, mode: ThemeMode, errors: ThemeError[]) {
	if (mode === "read") return;
	for (const key of Object.keys(value)) {
		if (allowed.includes(key) || isBanned(key) || (mode === "import" && isForbiddenImport(key))) continue;
		pushError(errors, path ? `${path}.${key}` : key, "unknown key");
	}
}

function gradientOf(v: unknown, mode: ThemeMode, path: string, errors: ThemeError[], bareHex: boolean): Gradient | undefined {
	if (bareHex && mode !== "import") {
		const h = hexOfMode(v, mode);
		if (h) return { stops: [h], angle: 180 };
	}
	if (!v || typeof v !== "object" || Array.isArray(v)) return;
	const g = v as Record<string, unknown>;
	ownUnknown(g, ["stops", "angle"], path, mode, errors);
	const min = mode === "import" ? 2 : 1;
	if (!Array.isArray(g.stops) || g.stops.length < min || g.stops.length > 5) return;
	const stops = g.stops.map((stop) => hexOfMode(stop, mode));
	if (stops.some((s) => !s)) return;
	const angle = angleOfMode(g.angle, mode);
	if (angle === undefined) return;
	return { stops: stops as string[], angle };
}

function fillOfMode(v: unknown, mode: ThemeMode, path: string, errors: ThemeError[]): Fill | undefined {
	const h = hexOfMode(v, mode);
	if (h) return h;
	return gradientOf(v, mode, path, errors, false);
}

export function copyTheme(theme: Theme): Theme {
	const out = {} as Theme;
	for (const field of THEME_FIELDS) {
		const value = theme[field.key];
		if (value !== undefined) (out as Record<string, unknown>)[field.key] = value;
	}
	return out;
}

function frameOf(theme: Theme): ThemeFrame {
	const { background, ...rest } = theme;
	if (!background) return rest;
	return { ...rest, background: backgroundKnobs(background) };
}

export function parseTheme(input: unknown, mode: "read"): { ok: true; theme: Theme; warnings: readonly string[] } | { ok: false; errors: readonly ThemeError[] };
export function parseTheme(input: unknown, mode: "save" | "import"):
	| { ok: true; theme: ThemeFrame; source: BackgroundSource; warnings: readonly string[] }
	| { ok: false; errors: readonly ThemeError[] };
export function parseTheme(
	input: unknown,
	mode: ThemeMode,
):
	| { ok: true; theme: Theme | ThemeFrame; source?: BackgroundSource; warnings: readonly string[] }
	| { ok: false; errors: readonly ThemeError[] } {
	const errors: ThemeError[] = [];
	let source: BackgroundSource = { tag: "none" };
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return { ok: false, errors: [{ path: "", message: "theme must be an object" }] };
	}
	checkShape(input, 1, "", mode, errors);
	const o = input as Record<string, unknown>;
	const known = new Set<string>(THEME_FIELDS.map((f) => f.key));
	for (const key of Object.keys(o)) {
		if (isBanned(key)) continue;
		if (mode === "import" && isForbiddenImport(key)) continue;
		if (!known.has(key) && mode !== "read") pushError(errors, key, "unknown key");
	}
	const preset = typeof o.id === "string" ? PRESETS[o.id] : undefined;
	const idKnown = typeof o.id === "string" && (o.id === "custom" || !!PRESETS[o.id]);
	let id: string | undefined;
	if (idKnown) id = o.id as string;
	else if (mode === "import") pushError(errors, "id", "unknown theme");
	else id = "custom";
	const basePresent = "base" in o;
	let base: "light" | "dark" | undefined;
	if (o.base === "light" || o.base === "dark") base = o.base;
	else if (mode === "import" && basePresent) pushError(errors, "base", "invalid base");
	else base = preset?.base;
	if (base !== "light" && base !== "dark" && !(mode === "import" && basePresent)) pushError(errors, "base", "invalid base");

	const takeRequired = <T>(key: string, present: boolean, parsed: T | undefined, fallback: T | undefined, message: string): T | undefined => {
		if (parsed) return parsed;
		if (present && mode === "import") {
			pushError(errors, key, message);
			return;
		}
		if (fallback !== undefined && mode !== "import") return fallback;
		if (fallback !== undefined && !present) return fallback;
		pushError(errors, key, present ? message : "missing");
		return;
	};

	const bg = takeRequired("bg", "bg" in o, gradientOf(o.bg, mode, "bg", errors, true), preset?.bg, "invalid colour");
	const button = takeRequired("button", "button" in o, gradientOf(o.button, mode, "button", errors, true), preset?.button, "invalid colour");
	const surface = takeRequired("surface", "surface" in o, "surface" in o ? fillOfMode(o.surface, mode, "surface", errors) : undefined, preset?.surface, "invalid colour");
	let text = takeRequired("text", "text" in o, hexOfMode(o.text, mode), preset?.text, "invalid colour");
	const accent = takeRequired("accent", "accent" in o, "accent" in o ? fillOfMode(o.accent, mode, "accent", errors) : undefined, preset?.accent, "invalid colour");
	let buttonText = takeRequired("buttonText", "buttonText" in o, hexOfMode(o.buttonText, mode), preset?.buttonText, "invalid colour");

	const theme = {} as Theme;
	if (id) theme.id = id;
	if (base === "light" || base === "dark") theme.base = base;
	if (bg) theme.bg = bg;
	if (surface) theme.surface = surface;
	if (text) theme.text = text;
	if (accent) theme.accent = accent;
	if (button) theme.button = button;
	if (buttonText) theme.buttonText = buttonText;

	for (const field of THEME_FIELDS) {
		if (field.required || (field.kind !== "hex" && field.kind !== "fill")) continue;
		const key = field.key;
		if (!(key in o)) {
			const fallback = preset?.[key];
			if (fallback !== undefined) (theme as Record<string, unknown>)[key] = fallback;
			continue;
		}
		const parsed = field.kind === "hex" ? hexOfMode(o[key], mode) : fillOfMode(o[key], mode, key, errors);
		if (parsed) (theme as Record<string, unknown>)[key] = parsed;
		else if (mode === "import") pushError(errors, key, "invalid colour");
	}

	if ("font" in o) {
		const fontValue = o.font;
		if (!fontValue || typeof fontValue !== "object" || Array.isArray(fontValue)) {
			if (mode !== "read") pushError(errors, "font", "invalid font");
		} else {
			const fontObj = fontValue as Record<string, unknown>;
			ownUnknown(fontObj, FONT_KEYS, "font", mode, errors);
			const font: ThemeFont = {};
			for (const key of FONT_KEYS) {
				if (!(key in fontObj)) continue;
				const name = validateFamily(fontObj[key]);
				if (name) font[key] = name;
				else if (mode === "import") pushError(errors, `font.${key}`, "invalid font");
			}
			if (font.ui || font.display) theme.font = font;
		}
	} else if (preset?.font) theme.font = preset.font;

	if ("background" in o) {
		const raw = o.background;
		if (raw === null && mode === "save") {
			/* clear is applied by the save peel */
		} else if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			if (mode !== "read") pushError(errors, "background", "invalid background");
		} else {
			const bgObj = raw as Record<string, unknown>;
			ownUnknown(bgObj, BACKGROUND_FIELDS.map((f) => f.key), "background", mode, errors);
			const background = {} as ThemeBackground;
			const fit = "fit" in bgObj ? bgObj.fit : "cover";
			const position = "position" in bgObj ? bgObj.position : "center";
			const dim = "dim" in bgObj ? bgObj.dim : 0;
			const blur = "blur" in bgObj ? bgObj.blur : 0;
			const scale = "scale" in bgObj ? bgObj.scale : 100;
			const repeat = "repeat" in bgObj ? bgObj.repeat : "repeat";
			const panel = "panel" in bgObj ? bgObj.panel : 72;
			if ((FITS as readonly string[]).includes(fit as string)) background.fit = fit as BgFit;
			else if (mode === "read") background.fit = "cover";
			else pushError(errors, "background.fit", "invalid fit");
			if ((POSITIONS as readonly string[]).includes(position as string)) background.position = position as BgPosition;
			else if (mode === "read") background.position = "center";
			else pushError(errors, "background.position", "invalid position");
			const dimN = typeof dim === "number" && Number.isInteger(dim) && dim >= 0 && dim <= 80 ? dim : undefined;
			const blurN = typeof blur === "number" && Number.isInteger(blur) && blur >= 0 && blur <= 20 ? blur : undefined;
			const scaleN = boundedInt(scale, 10, 400);
			const panelN = boundedInt(panel, 20, 90);
			const repeatN = parseRepeat(repeat);
			if (dimN !== undefined) background.dim = asDim(dimN);
			else if (mode === "read") background.dim = asDim(0);
			else pushError(errors, "background.dim", "invalid dim");
			if (blurN !== undefined) background.blur = asBlur(blurN);
			else if (mode === "read") background.blur = asBlur(0);
			else pushError(errors, "background.blur", "invalid blur");
			if (scaleN !== undefined) background.scale = asScale(scaleN);
			else if (mode === "read") background.scale = asScale(100);
			else pushError(errors, "background.scale", "invalid scale");
			if (repeatN) background.repeat = repeatN;
			else if (mode === "read") background.repeat = "repeat";
			else pushError(errors, "background.repeat", "invalid repeat");
			if (panelN !== undefined) background.panel = asPanel(panelN);
			else if (mode === "read") background.panel = asPanel(72);
			else pushError(errors, "background.panel", "invalid panel");
			const hasMedia = "mediaId" in bgObj;
			const hasSteam = "steam" in bgObj;
			let readMedia: MediaId | undefined;
			let readSteam: StoredSteam | undefined;
			if (mode === "read") {
				if (hasMedia && isId(bgObj.mediaId)) readMedia = asMediaId(bgObj.mediaId);
				if (hasSteam) readSteam = readStoredSteam(bgObj.steam);
				if (readMedia && readSteam) {
					readMedia = undefined;
					readSteam = undefined;
				}
			} else if (hasMedia && hasSteam) {
				pushError(errors, "background", "background has two sources");
			} else if (hasSteam) {
				const steam = bgObj.steam;
				if (!steam || typeof steam !== "object" || Array.isArray(steam)) pushError(errors, "background.steam", "invalid steam background");
				else {
					const steamObj = steam as Record<string, unknown>;
					ownUnknown(steamObj, ["defid"], "background.steam", mode, errors);
					const id = steamDefId(steamObj.defid);
					if (!id) pushError(errors, "background.steam", "invalid steam background");
					else source = { tag: "steam", defid: id };
				}
			} else if (hasMedia) {
				if (mode === "import") pushError(errors, "background.mediaId", "forbidden key");
				else if (isId(bgObj.mediaId)) source = { tag: "upload", mediaId: asMediaId(bgObj.mediaId) };
				else if (mode === "save") pushError(errors, "background.mediaId", "invalid media id");
			}
			if (
				background.fit &&
				background.position &&
				background.dim !== undefined &&
				background.blur !== undefined &&
				background.scale !== undefined &&
				background.repeat &&
				background.panel !== undefined &&
				!errors.some((e) => e.path.startsWith("background"))
			) {
				const knobs = backgroundKnobs(background);
				if (readMedia) theme.background = { ...knobs, mediaId: readMedia };
				else if (readSteam) theme.background = { ...knobs, steam: readSteam };
				else theme.background = knobs;
			}
		}
	}

	if (!theme.id || !theme.base || !theme.bg || !theme.surface || !theme.text || !theme.accent || !theme.button || !theme.buttonText) {
		if (!errors.length) pushError(errors, "", "theme must be an object");
		return { ok: false, errors };
	}
	if (errors.length) return { ok: false, errors };

	const d = derived(theme);
	const pageBgs = [...theme.bg.stops, ...stopsOf(theme.surface)];
	const warnings = [...warnPairs("text", text!, pageBgs), ...warnPairs("button text", buttonText!, theme.button.stops)];
	text = clampFg(text!, pageBgs);
	buttonText = clampFg(buttonText!, theme.button.stops);
	theme.text = text;
	theme.buttonText = buttonText;
	const clampOpt = (key: keyof Theme, fg: string | undefined, bgs: string[], label: string, warnAt: number) => {
		if (!fg) return;
		warnings.push(...warnPairs(label, fg, bgs, warnAt));
		(theme as Record<string, unknown>)[key] = clampFg(fg, bgs);
	};
	clampOpt("secondary", theme.secondary, pageBgs, "secondary text", 4.5);
	clampOpt("muted", theme.muted, pageBgs, "muted text", 3);
	clampOpt("link", theme.link, pageBgs, "link", 4.5);
	clampOpt("inputText", theme.inputText, [theme.inputBg ?? d.inputBg], "input text", 4.5);
	clampOpt("secondaryButtonText", theme.secondaryButtonText, theme.secondaryButton ? stopsOf(theme.secondaryButton) : pageBgs, "secondary button text", 4.5);
	if (mode === "read") return { ok: true, theme, warnings };
	return { ok: true, theme: frameOf(theme), source, warnings };
}

export function sanitiseTheme(input: unknown): Sanitised | null {
	const got = parseTheme(input, "read");
	if (!got.ok) return null;
	return { theme: got.theme, warnings: [...got.warnings] };
}

function freshCopy(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => freshCopy(item));
	if (!value || typeof value !== "object") return value;
	const out = Object.create(null) as Record<string, unknown>;
	for (const key of Object.keys(value)) {
		Object.defineProperty(out, key, { value: freshCopy((value as Record<string, unknown>)[key]), enumerable: true, writable: true, configurable: true });
	}
	return out;
}

export function importTheme(text: string): ImportResult {
	if (Buffer.byteLength(text) > THEME_FILE_MAX) return { ok: false, errors: [{ path: "", message: "file is too large" }] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text, (key, value) => {
			if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("banned");
			return value;
		});
	} catch (err) {
		if (err instanceof Error && err.message === "banned") return { ok: false, errors: [{ path: "", message: "banned key" }] };
		return { ok: false, errors: [{ path: "", message: "invalid json" }] };
	}
	const errors: ThemeError[] = [];
	const root = freshCopy(parsed);
	checkShape(root, 1, "", "import", errors);
	if (!root || typeof root !== "object" || Array.isArray(root)) return { ok: false, errors: [{ path: "", message: "invalid file" }] };
	const envelope = root as Record<string, unknown>;
	for (const key of Object.keys(envelope)) {
		if (isBanned(key)) continue;
		if (key !== "format" && key !== "version" && key !== "theme") pushError(errors, key, "unknown key");
	}
	if (envelope.format !== THEME_FORMAT) pushError(errors, "format", "unknown format");
	if (envelope.version !== THEME_VERSION) pushError(errors, "version", "unknown version");
	if (errors.length) return { ok: false, errors };
	const got = parseTheme(envelope.theme, "import");
	if (!got.ok) return { ok: false, errors: got.errors.map((e) => ({ path: e.path ? `theme.${e.path}` : "theme", message: e.message })) };
	const warnings = [...got.warnings];
	const theme = copyTheme(got.theme) as ImportedTheme;
	if (got.source.tag === "steam" && got.theme.background) {
		theme.background = { ...backgroundKnobs(got.theme.background), steam: { defid: got.source.defid } };
	} else if (got.theme.background) {
		warnings.push(BACKGROUND_OMITTED);
		theme.background = sharedBackground(got.theme.background);
	}
	return { ok: true, theme, warnings };
}

function shareFill(value: Fill): Fill {
	if (typeof value === "string") return value;
	const stops = value.stops.length === 1 ? [value.stops[0]!, value.stops[0]!] : [...value.stops];
	return { stops, angle: value.angle };
}

export function exportTheme(theme: Theme): ThemeFile {
	const shared = Object.create(null) as SharedTheme;
	for (const field of THEME_FIELDS) {
		if (!field.share) continue;
		const value = theme[field.key];
		if (value === undefined) continue;
		if (field.kind === "gradient") {
			shared[field.key] = shareFill(value as Gradient) as never;
			continue;
		}
		if (field.kind === "fill") {
			shared[field.key] = shareFill(value as Fill) as never;
			continue;
		}
		if (field.kind === "background") {
			shared.background = sharedBackground(value as ThemeBackground);
			continue;
		}
		(shared as Record<string, unknown>)[field.key] = value;
	}
	return { format: THEME_FORMAT, version: THEME_VERSION, theme: shared };
}

export function themeFileName(theme: Theme): `${string}.xitter-theme.json` {
	const id = theme.id === "custom" || PRESETS[theme.id] ? theme.id : "custom";
	return `${id}.xitter-theme.json`;
}

export function finishBackground(
	previous: Theme | undefined,
	frame: ThemeFrame,
	peel: "keep" | "clear" | "frame",
	source: BackgroundSource,
	resolved: StoredSteam | undefined,
): { ok: true; theme: Theme } | { ok: false; error: typeof STEAM_MISSING } {
	if (PRESETS[frame.id]) {
		const theme = copyTheme(frame);
		delete theme.background;
		return { ok: true, theme };
	}
	if (peel === "keep") {
		const theme = copyTheme(frame);
		if (previous?.background) theme.background = previous.background;
		return { ok: true, theme };
	}
	if (peel === "clear") {
		const theme = copyTheme(frame);
		delete theme.background;
		return { ok: true, theme };
	}
	const knobs = frame.background ? backgroundKnobs(frame.background) : undefined;
	if (!knobs) return { ok: true, theme: copyTheme(frame) };
	if (source.tag === "steam") {
		if (!resolved) return { ok: false, error: STEAM_MISSING };
		const theme = copyTheme(frame);
		theme.background = { ...knobs, steam: resolved };
		return { ok: true, theme };
	}
	const theme = copyTheme(frame);
	if (source.tag === "upload") theme.background = { ...knobs, mediaId: source.mediaId };
	else if (previous?.background?.mediaId) theme.background = { ...knobs, mediaId: previous.background.mediaId };
	else if (previous?.background?.steam) theme.background = { ...knobs, steam: previous.background.steam };
	else theme.background = knobs;
	return { ok: true, theme };
}

export function themeForClient(theme: Theme): SharedTheme {
	const shared = exportTheme(theme).theme;
	const mediaId = theme.background?.mediaId;
	if (!mediaId || !shared.background) return shared;
	return { ...shared, background: { ...shared.background, mediaId } };
}

export type Mode = "light" | "dark";

export type NativeLook = {
	readonly kind: "native";
	readonly mode: Mode;
};

export type PaintedLook = {
	readonly kind: "painted";
	readonly theme: Theme;
};

export type Look = NativeLook | PaintedLook;

export type LookView = {
	readonly mode: Mode | null;
	readonly theme: Theme | null;
	readonly accent: string | Gradient;
};

export type ClientLook = {
	readonly night: "0" | "2";
	readonly theme: SharedTheme | null;
	readonly accent: string | Gradient;
	readonly themeColor: AccentId;
};

export type LookWrite =
	| { readonly type: "plain"; readonly mode: Mode }
	| { readonly type: "clear" }
	| { readonly type: "paint"; readonly theme: ThemeFrame; readonly peel: "keep" | "clear" | "frame"; readonly source: BackgroundSource }
	| { readonly type: "keep" };

export type ParsedWrite =
	| { readonly ok: true; readonly write: LookWrite; readonly accent?: Accent; readonly warnings: readonly string[] }
	| { readonly ok: false; readonly error: string; readonly errors?: readonly ThemeError[] };

export type AccountPalette = "light" | "dim" | "dark";

export const NIGHT_MODE_ATTR = "Path=/; Max-Age=31536000; SameSite=Lax";

export function modeOf(look: Look): Mode {
	return look.kind === "native" ? look.mode : look.theme.base;
}

export function readAccent(preferences: unknown, look: Look | null): Accent {
	const row = preferences && typeof preferences === "object" && !Array.isArray(preferences) ? (preferences as Record<string, unknown>) : null;
	const fromPref = row && "accent" in row ? parseAccent(row.accent) : null;
	if (fromPref) return fromPref;
	if (look?.kind === "painted") return parseAccent(look.theme.accent) ?? DEFAULT_ACCENT;
	return DEFAULT_ACCENT;
}

export function readPrefs(preferences: unknown): Prefs {
	const look = readLookRaw(preferences);
	const accent = readAccent(preferences, look);
	return { look: overlayAccent(look, accent), accent };
}

function readLookRaw(preferences: unknown): Look | null {
	if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) return null;
	const row = preferences as Record<string, unknown>;
	const theme = sanitiseTheme(row.theme)?.theme;
	if (theme) return { kind: "painted", theme };
	if (row.mode === "light" || row.mode === "dark") return { kind: "native", mode: row.mode };
	return null;
}

export function readLook(preferences: unknown): Look | null {
	return readPrefs(preferences).look;
}

function accentFromBody(o: Record<string, unknown>): { accent?: Accent; error?: string } {
	if (!("accent" in o)) return {};
	if (o.accent === null) return { accent: DEFAULT_ACCENT };
	const accent = parseAccent(o.accent);
	if (!accent) return { error: "that isn't an accent" };
	return { accent };
}

export function parseLookWrite(body: unknown): ParsedWrite {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "that isn't a theme" };
	const o = body as Record<string, unknown>;
	const mode = o.mode === "light" || o.mode === "dark" ? o.mode : undefined;
	const hasMode = "mode" in o;
	const gotAccent = accentFromBody(o);
	if (gotAccent.error) return { ok: false, error: gotAccent.error };
	const extra = gotAccent.accent ? { accent: gotAccent.accent } : {};
	if (o.clear === true) {
		if (hasMode) return { ok: false, error: "invalid mode" };
		return { ok: true, write: { type: "clear" }, warnings: [], ...extra };
	}
	if (o.theme && typeof o.theme === "object" && !Array.isArray(o.theme)) {
		const themeBody = o.theme as Record<string, unknown>;
		const got = parseTheme(themeBody, "save");
		if (!got.ok) return { ok: false, error: "that isn't a theme", errors: got.errors };
		if (hasMode && mode !== got.theme.base) return { ok: false, error: "invalid mode" };
		const fromTheme = "accent" in themeBody ? parseAccent(themeBody.accent) ?? parseAccent(got.theme.accent) : undefined;
		const peel = !("background" in themeBody) ? "keep" : themeBody.background === null ? "clear" : "frame";
		const source = peel === "frame" ? got.source : { tag: "none" as const };
		return { ok: true, write: { type: "paint", theme: got.theme, peel, source }, warnings: got.warnings, accent: extra.accent ?? fromTheme };
	}
	if (hasMode) {
		if (!mode) return { ok: false, error: "invalid mode" };
		if ("theme" in o && o.theme !== null) return { ok: false, error: "that isn't a theme" };
		return { ok: true, write: { type: "plain", mode }, warnings: [], ...extra };
	}
	if (o.theme === null) return { ok: true, write: { type: "clear" }, warnings: [], ...extra };
	if (extra.accent) return { ok: true, write: { type: "keep" }, warnings: [], ...extra };
	return { ok: false, error: "that isn't a theme" };
}

export function applyWrite(current: Look | null, write: LookWrite): Look | null {
	if (write.type === "keep") return current;
	if (write.type === "plain") return { kind: "native", mode: write.mode };
	if (write.type === "paint") return { kind: "painted", theme: write.theme };
	if (!current || current.kind === "native") return current;
	return { kind: "native", mode: current.theme.base };
}

export function lookView(look: Look | null, accent: Accent = DEFAULT_ACCENT): LookView {
	if (!look) return { mode: null, theme: null, accent: accentWire(accent) };
	return { mode: modeOf(look), theme: look.kind === "painted" ? look.theme : null, accent: accentWire(accent) };
}

export function clientLook(look: Look | null, accent: Accent = DEFAULT_ACCENT): ClientLook {
	return {
		night: look ? (modeOf(look) === "light" ? "0" : "2") : "2",
		theme: look?.kind === "painted" ? themeForClient(look.theme) : null,
		accent: accentWire(accent),
		themeColor: themeColorOf(accent),
	};
}

export function paletteOf(look: Look | null, nightCookie?: string): AccountPalette | undefined {
	if (look?.kind === "painted" && look.theme.id === "dim") return "dim";
	if (look) return modeOf(look);
	if (nightCookie === "0") return "light";
	if (nightCookie === "1" || nightCookie === "2") return "dark";
	return undefined;
}
