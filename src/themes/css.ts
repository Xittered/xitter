// Server-side CSS: deriveTokens, account/boot/page-chrome CSS, font links, background paint.

import { fontSlug } from "../fonts";
import { STEAM_STILL_PATH, STEAM_VIDEO_PATH, steamStillPath, steamVideoPath } from "../steam-items";
import { CHIRP, fillOfAccent, type Accent, type BgFit, type BgPosition, type BgRepeat, type BgScale, type BlurPx, type Dim, type PanelOpacity, type Theme } from "./presets";
import { INK, WHITE, accentTextOn, derived, fillCss, mixHex, rgba, solidOf } from "./validate";

export type BackgroundPaint = {
	readonly image: string;
	readonly still: string | null;
	readonly fit: BgFit;
	readonly position: BgPosition;
	readonly dim: Dim;
	readonly blur: BlurPx;
	readonly scale: number;
	readonly repeat: BgRepeat;
	readonly panel: number;
	readonly movie: string | null;
	readonly mp4: string | null;
	readonly defid: number | null;
};

export type SteamMotion = { readonly defid: number; readonly movie: string | null; readonly mp4: string | null };

export type ChromeSlots = {
	root: string;
	image: string;
	imagePos: "fixed" | "absolute";
	column: string;
	nav: string;
	header: string;
	sidebar: string;
	search: string;
};

export type AccountTokens = {
	bg: string;
	bar: string;
	text: string;
	muted: string;
	border: string;
	field: string;
	outline: string;
	surface: string;
	hover: string;
	logo: string;
	scheme: string;
	accent: string;
	accentHover: string;
	font?: string;
};

export function deriveTokens(theme: Theme): AccountTokens {
	const d = derived(theme);
	const accentHover = mixHex(d.accent, INK, 0.12);
	return {
		bg: d.bg,
		bar: d.header,
		text: d.text,
		muted: d.muted,
		border: d.border,
		field: d.inputBorder,
		outline: d.secondaryButtonBorder,
		surface: solidOf(theme.surface),
		hover: d.hover,
		logo: theme.base === "light" ? "url(/public/logo-light.png)" : "url(/public/logo-dark.png)",
		scheme: theme.base,
		accent: d.accent,
		accentHover,
		font: theme.font?.ui ? `"${theme.font.ui}",${CHIRP}` : undefined,
	};
}

export function xtVars(theme: Theme): Record<string, string> {
	const d = derived(theme);
	return {
		"--xt-bg": d.bg,
		"--xt-surface": d.surface,
		"--xt-text": d.text,
		"--xt-secondary": d.secondary,
		"--xt-muted": d.muted,
		"--xt-link": d.link,
		"--xt-border": d.border,
		"--xt-divider": d.divider,
		"--xt-accent": d.accent,
		"--xt-accent-fill": d.accentFill,
		"--xt-button": d.button,
		"--xt-button-text": d.buttonText,
		"--xt-button-hover": d.buttonHover,
		"--xt-header": d.header,
		"--xt-hover": d.hover,
		"--xt-input": d.inputBg,
		"--xt-input-text": d.inputText,
		"--xt-input-border": d.inputBorder,
		"--xt-menu": d.menu,
		"--xt-tooltip": d.tooltip,
		"--xt-icon": d.icon,
		"--xt-icon-active": d.iconActive,
		"--xt-reply": d.reply,
		"--xt-repost": d.repost,
		"--xt-like": d.like,
		"--xt-bookmark": d.bookmark,
		"--xt-views": d.views,
		"--xt-secondary-button": d.secondaryButton,
		"--xt-secondary-button-border": d.secondaryButtonBorder,
		"--xt-secondary-button-text": d.secondaryButtonText,
		"--xt-badge": d.badge,
		"--xt-selection": d.selection,
		"--xt-accent-soft": d.accentSoft,
		"--xt-reply-soft": d.replySoft,
		"--xt-repost-soft": d.repostSoft,
		"--xt-like-soft": d.likeSoft,
		"--xt-bookmark-soft": d.bookmarkSoft,
	};
}

export function accentVars(accent: Accent): string {
	const fill = fillOfAccent(accent);
	const solid = solidOf(fill);
	const hover = mixHex(solid, INK, 0.12);
	return `--xt-accent:${solid};--xt-accent-fill:${fillCss(fill)};--xt-accent-soft:${rgba(solid, 0.1)};--xt-accent-hover:${hover};--accent:${solid};--accent-fill:${fillCss(fill)};--accent-hover:${hover};--accent-text:${accentTextOn(solid)}`;
}

export function accountVars(theme: Theme): string {
	const tkn = deriveTokens(theme);
	const d = derived(theme);
	const rows: Record<string, string> = {
		bg: tkn.bg,
		bar: tkn.bar,
		text: tkn.text,
		muted: tkn.muted,
		border: tkn.border,
		field: tkn.field,
		outline: tkn.outline,
		surface: tkn.surface,
		hover: tkn.hover,
		logo: tkn.logo,
		accent: tkn.accent,
		"accent-fill": d.accentFill,
		"accent-hover": tkn.accentHover,
		"accent-text": accentTextOn(tkn.accent),
		primary: theme.id === "custom" ? d.button : d.accentFill,
		"primary-text": theme.id === "custom" ? d.buttonText : accentTextOn(tkn.accent),
		"primary-hover": theme.id === "custom" ? d.buttonHover : tkn.accentHover,
	};
	if (tkn.font) rows.font = tkn.font;
	return Object.entries(rows)
		.map(([k, v]) => `--${k}:${v}`)
		.join(";") + `;color-scheme:${tkn.scheme}`;
}

function fontFamilyCss(theme: Theme): string {
	let css = "";
	if (theme.font?.ui) css += `html[data-xitter-theme] body,html[data-xitter-theme] .css-146c3p1,html[data-xitter-theme] .css-1jxf684{font-family:"${theme.font.ui}",${CHIRP}!important}`;
	if (theme.font?.display)
		css += `html[data-xitter-theme] [data-testid="User-Name"] span:first-of-type,html[data-xitter-theme] [data-testid="UserName"],html[data-xitter-theme] h1,html[data-xitter-theme] h2{font-family:"${theme.font.display}",${CHIRP}!important}`;
	return css;
}

const PAGE_GATE = "html[data-xitter-theme]:not([data-xitter-decor])";

export const PAGE_CHROME_SLOTS: ChromeSlots = {
	root: "html[data-xitter-theme]",
	image: `${PAGE_GATE} body`,
	imagePos: "fixed",
	// Settings has no primary column: its list and its details are two regions
	// of the main landmark (the timeline's own region sits inside the column)
	column: `${PAGE_GATE} [data-testid="primaryColumn"],${PAGE_GATE} main[role="main"] section[role="region"]:not([data-testid="primaryColumn"] *)`,
	nav: `${PAGE_GATE} header[role="banner"]>div>div`,
	header: `${PAGE_GATE} [data-testid="primaryColumn"] [role="tablist"]:not([data-testid="toolBar"] *),${PAGE_GATE} [data-testid="primaryColumn"] [style*="position: sticky"]`,
	// The sidebar's cards and search pill are X's own rounded boxes, found by
	// their classes in the page script (client.ts paint()), so the glass follows
	// their corners. Nothing square in the sidebar is frosted here.
	sidebar: "",
	search: "",
};

export const PREVIEW_CHROME_SLOTS: ChromeSlots = {
	root: "#preview.live",
	image: "#preview.live",
	imagePos: "absolute",
	column: "#preview.live .feed",
	nav: "#preview.live .nav",
	header: "#preview.live .tabs",
	sidebar: "#preview.live .glass",
	search: "#preview.live .search",
};

export function cssUrl(path: string): string {
	if (typeof path !== "string") return "none";
	if (/^\/media\/(?:poster\/)?\d{1,19}\.(?:png|gif|webp|jpg)$/.test(path) || STEAM_STILL_PATH.test(path)) return `url("${path}")`;
	return "none";
}

export function steamMotion(paint: BackgroundPaint | undefined): SteamMotion | null {
	if (!paint?.defid) return null;
	if (!paint.movie && !paint.mp4) return null;
	return { defid: paint.defid, movie: paint.movie, mp4: paint.mp4 };
}

function finiteOr(v: number | null | undefined, fallback: number): number {
	return typeof v === "number" && v === v ? v : fallback;
}

function bgSize(fit: string | undefined, scale: number): string {
	if (fit === "tile") return scale === 100 ? "auto" : `${scale}%`;
	if (fit === "cover" || fit === "contain") return scale === 100 ? fit : `${scale}%`;
	return "auto";
}

function tileRepeat(fit: string | undefined, repeat: string | undefined): string {
	if (fit !== "tile") return "no-repeat";
	if (repeat === "repeat" || repeat === "space" || repeat === "round") return repeat;
	return "repeat";
}

function bgPosition(position: string | undefined): string {
	if (position === "top" || position === "bottom" || position === "center") return position;
	return "center";
}

export function pageChromeVars(paint: BackgroundPaint): Record<string, string> {
	const scale = finiteOr(paint.scale, 100);
	const panel = finiteOr(paint.panel, 72);
	const dim = finiteOr(paint.dim, 0);
	const blur = finiteOr(paint.blur, 0);
	const still = paint.still ? cssUrl(paint.still) : cssUrl(paint.image);
	return {
		"--xt-bg-image": cssUrl(paint.image),
		"--xt-bg-still": still,
		"--xt-bg-size": bgSize(paint.fit, scale),
		"--xt-bg-position": bgPosition(paint.position),
		"--xt-bg-repeat": tileRepeat(paint.fit, paint.repeat),
		"--xt-bg-dim": String(dim / 100),
		"--xt-bg-blur": `${blur}px`,
		"--xt-bg-panel": `${panel}%`,
	};
}

function glassSel(slots: ChromeSlots, sel: string): string {
	if (slots.imagePos !== "absolute") return sel;
	return sel.replaceAll("#preview.live", "#preview.live[data-bg]");
}

export function pageChromeRules(slots: ChromeSlots): string {
	const img = slots.image;
	const pos = slots.imagePos;
	const soft = `${glassSel(slots, slots.column)},${glassSel(slots, slots.header)}`;
	const hard = [slots.nav, slots.sidebar, slots.search]
		.filter((sel) => sel)
		.map((sel) => glassSel(slots, sel))
		.join(",");
	const tint = "background:color-mix(in srgb,var(--xt-surface) var(--xt-bg-panel),transparent)!important;";
	return (
		`${img}{position:relative;z-index:0}` +
		`${img}::before{content:"";position:${pos};inset:0;z-index:-1;background-image:var(--xt-bg-image);background-size:var(--xt-bg-size);background-position:var(--xt-bg-position);background-repeat:var(--xt-bg-repeat);filter:blur(var(--xt-bg-blur));pointer-events:none}` +
		`${img}::after{content:"";position:${pos};inset:0;z-index:-1;background:rgb(0 0 0 / var(--xt-bg-dim));pointer-events:none}` +
		`@media (prefers-reduced-motion:reduce){${img}::before{animation:none;background-image:var(--xt-bg-still)}}` +
		`${soft}{${tint}-webkit-backdrop-filter:blur(2px)!important;backdrop-filter:blur(2px)!important}` +
		`${hard}{${tint}-webkit-backdrop-filter:blur(14px)!important;backdrop-filter:blur(14px)!important}` +
		`@supports not ((-webkit-backdrop-filter:blur(1px)) or (backdrop-filter:blur(1px))){${soft},${hard}{background:color-mix(in srgb,var(--xt-surface) 92%,transparent)!important}}`
	);
}

export function pageChromeCss(paint?: BackgroundPaint, slots: ChromeSlots = PAGE_CHROME_SLOTS): string {
	if (!paint) return "";
	const vars = pageChromeVars(paint);
	const block = Object.keys(vars)
		.map((k) => `${k}:${vars[k]}`)
		.join(";");
	return `${slots.root}{${block}}` + pageChromeRules(slots);
}

export function bootCss(theme: Theme, paint?: BackgroundPaint): string {
	const vars = Object.entries(xtVars(theme))
		.map(([k, v]) => `${k}:${v}`)
		.join(";");
	return (
		`html[data-xitter-theme]{${vars}}` +
		`html[data-xitter-theme] ::selection{background:var(--xt-selection)}` +
		`${PAGE_GATE},${PAGE_GATE} body{background:var(--xt-bg)!important;background-attachment:fixed!important}` +
		`${PAGE_GATE} #react-root>div>div,${PAGE_GATE} #react-root>div>div>div:not([data-testid]){background-color:transparent!important}` +
		pageChromeCss(paint) +
		fontFamilyCss(theme)
	);
}

export async function resolveBackground(userId: string, theme: Theme): Promise<BackgroundPaint | undefined> {
	const bg = theme.background;
	if (!bg) return;
	const knobs = {
		fit: bg.fit,
		position: bg.position,
		dim: bg.dim,
		blur: bg.blur,
		scale: bg.scale ?? (100 as BgScale),
		repeat: bg.repeat ?? "repeat",
		panel: bg.panel ?? (72 as PanelOpacity),
	};
	if (bg.steam && !bg.mediaId) {
		const image = steamStillPath(bg.steam);
		if (!STEAM_STILL_PATH.test(image)) return;
		const movie = steamVideoPath(bg.steam, "movie");
		const mp4 = steamVideoPath(bg.steam, "mp4");
		return {
			image,
			still: image,
			...knobs,
			movie: movie && STEAM_VIDEO_PATH.test(movie) ? movie : null,
			mp4: mp4 && STEAM_VIDEO_PATH.test(mp4) ? mp4 : null,
			defid: bg.steam.defid,
		};
	}
	if (!bg.mediaId) return;
	const { ownedThemePhoto, themeMediaPath, themePosterPath } = await import("../media");
	const photo = await ownedThemePhoto(userId, bg.mediaId);
	if (!photo) return;
	return {
		image: themeMediaPath(bg.mediaId, photo.ext),
		still: photo.poster ? themePosterPath(bg.mediaId) : null,
		...knobs,
		movie: null,
		mp4: null,
		defid: null,
	};
}

// Hung off the accent attribute, like every accent rule, so that a decorated
// profile, which takes the attribute away, takes these values with it.
export function bootAccentCss(accent: Accent): string {
	return `html[data-xitter-accent]{${accentVars(accent)}}`;
}

export function fontLinks(theme: Theme | null): string {
	if (!theme?.font) return "";
	const names = [theme.font.ui, theme.font.display].filter((n, i, a): n is string => !!n && a.indexOf(n) === i);
	return names.map((n) => `<link rel="stylesheet" href="/i/xitter/fonts/${fontSlug(n)}/fonts.css">`).join("");
}
