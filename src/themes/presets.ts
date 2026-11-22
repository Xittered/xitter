// Preset palettes, named accents, CHIRP, and the Theme type they instantiate.

import type { StoredSteam } from "../steam-items";

export type Gradient = { stops: string[]; angle: number };
export type Fill = string | Gradient;
export type ThemeFont = { ui?: string; display?: string };

declare const mediaIdBrand: unique symbol;
declare const dimBrand: unique symbol;
declare const blurBrand: unique symbol;
declare const scaleBrand: unique symbol;
declare const panelBrand: unique symbol;
export type MediaId = string & { readonly [mediaIdBrand]: true };
export type Dim = number & { readonly [dimBrand]: true };
export type BlurPx = number & { readonly [blurBrand]: true };
export type BgScale = number & { readonly [scaleBrand]: true };
export type PanelOpacity = number & { readonly [panelBrand]: true };
export type BgFit = "cover" | "contain" | "tile";
export type BgPosition = "center" | "top" | "bottom";
export type BgRepeat = "repeat" | "space" | "round";

export type BackgroundKnobs = {
	fit: BgFit;
	position: BgPosition;
	dim: Dim;
	blur: BlurPx;
	scale: BgScale;
	repeat: BgRepeat;
	panel: PanelOpacity;
};

export type ThemeBackground =
	| (BackgroundKnobs & { readonly mediaId?: undefined; readonly steam?: undefined })
	| (BackgroundKnobs & { readonly mediaId: MediaId; readonly steam?: undefined })
	| (BackgroundKnobs & { readonly mediaId?: undefined; readonly steam: StoredSteam });

export type ThemeFrame = Omit<Theme, "background"> & { background?: BackgroundKnobs };

export type Theme = {
	id: string;
	base: "dark" | "light";
	bg: Gradient;
	surface: Fill;
	text: string;
	accent: Fill;
	button: Gradient;
	buttonText: string;
	link?: string;
	secondary?: string;
	muted?: string;
	border?: string;
	divider?: string;
	hover?: string;
	inputBg?: string;
	inputText?: string;
	inputBorder?: string;
	header?: Fill;
	menu?: Fill;
	tooltip?: string;
	icon?: string;
	iconActive?: string;
	reply?: string;
	repost?: string;
	like?: string;
	bookmark?: string;
	views?: string;
	secondaryButton?: Fill;
	secondaryButtonBorder?: string;
	secondaryButtonText?: string;
	buttonHover?: string;
	badge?: string;
	selection?: string;
	font?: ThemeFont;
	background?: ThemeBackground;
};

export const CHIRP = `TwitterChirp,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif`;
export const FONT_SUGGESTIONS = [
	"Inter",
	"Roboto",
	"Open Sans",
	"Lato",
	"Montserrat",
	"Poppins",
	"Nunito",
	"Raleway",
	"Source Sans 3",
	"Work Sans",
	"DM Sans",
	"Manrope",
	"IBM Plex Sans",
	"Space Grotesk",
	"JetBrains Mono",
	"Geist",
	"Geist Mono",
	"Geist Serif",
	"Merriweather",
	"Playfair Display",
	"Lora",
	"Fira Sans",
	"Rubik",
	"Outfit",
	"Comic Neue",
	"Press Start 2P",
	"Lexend",
];

export const ACCENT_IDS = ["blue500", "yellow500", "magenta500", "purple500", "orange500", "green500"] as const;
export type AccentId = (typeof ACCENT_IDS)[number];
export const ACCENTS: Record<AccentId, string> = {
	blue500: "#1d9bf0",
	yellow500: "#ffd400",
	magenta500: "#f91880",
	purple500: "#7856ff",
	orange500: "#ff7a00",
	green500: "#00ba7c",
};

export type NamedAccent = { readonly kind: "named"; readonly id: AccentId };
export type CustomAccent = { readonly kind: "custom"; readonly fill: Fill };
export type Accent = NamedAccent | CustomAccent;
export const DEFAULT_ACCENT: NamedAccent = { kind: "named", id: "blue500" };

export function fillOfAccent(a: Accent): Fill {
	return a.kind === "named" ? ACCENTS[a.id] : a.fill;
}

export function themeColorOf(a: Accent): AccentId {
	return a.kind === "named" ? a.id : "blue500";
}

export function accentWire(a: Accent): string | Gradient {
	if (a.kind === "named") return a.id;
	return a.fill;
}

export const PRESET_NAMES: Record<string, string> = {
	dim: "Dim",
	midnight: "Midnight",
	sunset: "Sunset",
	ember: "Ember",
	ocean: "Ocean",
	forest: "Forest",
	rose: "Rosé",
	mono: "Mono",
};

const t = (
	id: string,
	base: "dark" | "light",
	bg: string[],
	angle: number,
	surface: string,
	text: string,
	accent: string,
	button: string[],
	buttonAngle: number,
	buttonText: string,
	extra: Partial<Theme> = {},
): Theme => ({
	id,
	base,
	bg: { stops: bg, angle },
	surface,
	text,
	accent,
	button: { stops: button, angle: buttonAngle },
	buttonText,
	...extra,
});

export const PRESETS: Record<string, Theme> = {
	dim: t("dim", "dark", ["#15202b"], 180, "#1e2732", "#f7f9f9", "#1d9bf0", ["#eff3f4"], 180, "#0f1419", {
		muted: "#8b98a5",
		border: "#38444d",
		inputBg: "#253341",
		inputBorder: "#425364",
	}),
	midnight: t("midnight", "dark", ["#070b1a", "#2a1060"], 135, "#12162c", "#f2f0ff", "#8b7cff", ["#eef0ff"], 135, "#070b1a"),
	sunset: t("sunset", "dark", ["#2a0c08", "#6a1838", "#241040"], 120, "#2a121c", "#fff4ea", "#ff8a4c", ["#fff4ea"], 120, "#2a0c08"),
	ember: t("ember", "dark", ["#1a0b06", "#4a1608"], 140, "#2b120c", "#fff6ee", "#ffb020", ["#fff6ee"], 140, "#1a0b06", {
		link: "#ffb020",
		muted: "#c9a090",
		reply: "#ffb020",
		bookmark: "#ffb020",
	}),
	ocean: t("ocean", "dark", ["#032830", "#0a1c48"], 160, "#0c2430", "#e9f8fa", "#3ecfcf", ["#e9f8fa"], 160, "#032830"),
	forest: t("forest", "dark", ["#0e1c14", "#163024"], 180, "#16261c", "#e7f2ea", "#3dd68c", ["#e7f2ea"], 180, "#0e1c14"),
	rose: t("rose", "light", ["#fceef3", "#f7e0e8"], 160, "#fff7fa", "#3a1524", "#a83262", ["#3a1524"], 160, "#fff7fa"),
	mono: t("mono", "dark", ["#1b1d20"], 180, "#26282c", "#e8e9eb", "#a8adb4", ["#e8e9eb"], 180, "#1b1d20"),
};

export const SWATCH_IDS = ["midnight", "sunset", "ember", "ocean", "forest", "rose", "mono"] as const;

export function swatches(): { id: string; name: string; bg: Gradient; base: "dark" | "light" }[] {
	return SWATCH_IDS.map((id) => {
		const p = PRESETS[id]!;
		return { id, name: PRESET_NAMES[id]!, bg: p.bg, base: p.base };
	});
}
