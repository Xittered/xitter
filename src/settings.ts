// Instance-wide settings, changed from the admin panel. They are read on
// nearly every page, so they are kept in memory: loaded once at start and
// replaced whenever the panel saves one.

import { sql } from "./db";
import { foldGlyphs } from "./names";

export type SignupMode = "invite" | "open" | "closed";

// parts of the client this instance can switch off; true shows the feature
export const FEATURES = {
	communities: "Communities",
	lists: "Lists",
	gifs: "GIF search in the composer",
	polls: "Polls in the composer",
	location: "Location in the composer",
	scheduling: "Scheduling in the composer",
	grok: "Grok",
	image_gen: "Grok image generation",
	premium: "Premium and verification upsells",
	calls: "Calls",
	history: "History",
	creator_studio: "Creator Studio and monetization",
	spaces: "Spaces",
	business: "Business sign-up",
} as const;
export type Feature = keyof typeof FEATURES;

const DEFAULTS = {
	signup_mode: "invite" as SignupMode,
	instance_name: "Xitter",
	features: {
		communities: true,
		lists: true,
		gifs: true,
		polls: true,
		location: true,
		scheduling: true,
		grok: false,
		image_gen: false,
		premium: false,
		calls: false,
		history: false,
		creator_studio: false,
		spaces: false,
		business: false,
	} as Record<Feature, boolean>,
	limits: { image_mb: 5, video_mb: Number(process.env.MAX_VIDEO_MB ?? 200), video_seconds: Number(process.env.MAX_VIDEO_SECONDS ?? 600) },
	// per account per 15 minutes (ratelimit.ts); sign-in and mail limits are fixed
	rate_limits: { read: 6000, endpoint: 1000, write: 1500, post: 150, engage: 1000, dm: 1500, upload: 150 },
	// longest post per badge, in X's weighted characters (textlen.ts); grey covers
	// government organisations and officials
	post_limits: { none: 4000, blue: 25000, business: 128000, government: 256000 },
	// shown above every timeline until the viewer closes it; a new id shows it again
	announcement: { id: "", text: "", link: "" },
	// handles every new account follows
	default_follows: [] as string[],
	// the instance's rules, shown at /rules and linked from sign-up
	rules: "",
	// AGPL-3.0: people using an instance can get its source here
	source_url: process.env.SOURCE_URL ?? "https://github.com/Xittered/xitter",
	// admin panel, Settings: maintenance mode, blocked phrases, trend controls, pinned post
	operations: {
		maintenance: false,
		message: "The instance is undergoing maintenance.",
		blocked_phrases: [] as string[],
		// words no handle or display name may contain (names.ts)
		blocked_names: [] as string[],
		hidden_trends: [] as string[],
		promoted_trends: [] as string[],
		global_pin: null as string | null,
	},
	// the admin panel itself (admin.ts staffGate): staff must have two-factor on;
	// only these addresses (IPs or CIDR ranges) reach it, none meaning any
	security: { staff_2fa: false, admin_ips: [] as string[] },
	// backups.ts: a database dump every day, the newest `keep` kept
	backups: { daily: false, keep: 7 },
	// member-invites.ts: invites members make themselves, while sign-up is by invite
	invite_quota: { enabled: false, per_month: 3, uses: 1, min_age_days: 7 },
	// the client's own feature switches, set by an admin (Admin > Feature
	// switches); they win over the build's values and Xitter's own (shell.ts)
	switch_overrides: {} as Record<string, unknown>,
};
export type Settings = typeof DEFAULTS;
type Key = keyof Settings;

let current: Settings = structuredClone(DEFAULTS);

export async function loadSettings() {
	const next = structuredClone(DEFAULTS) as any;
	for (const r of await sql`select key, value from settings`) {
		if (!(r.key in DEFAULTS)) continue;
		const d = (DEFAULTS as any)[r.key];
		// objects merge over their defaults, so new fields get a value
		next[r.key] = d && typeof d === "object" && !Array.isArray(d) ? { ...d, ...r.value } : r.value;
	}
	current = next;
}

export const settings = (): Settings => current;
// GIF search needs a Klipy key; without one the button stays hidden
export const feature = (f: Feature) => (f === "gifs" && !process.env.KLIPY_API_KEY ? false : current.features[f] !== false);
// the admin's blocked phrases, in any case and through look-alike letters and
// invisible characters (names.ts); spacing still counts, unlike names
const phraseForm = (text: string) => foldGlyphs(text).replace(/\p{Cf}/gu, "");
export const hasBlockedPhrase = (text: string) => {
	const folded = phraseForm(text);
	return current.operations.blocked_phrases.some((phrase) => {
		const p = phraseForm(phrase);
		return !!p && folded.includes(p);
	});
};

export async function setSetting<K extends Key>(key: K, value: Settings[K]) {
	await sql`insert into settings (key, value) values (${key}, ${JSON.stringify(value)}::text::jsonb)
		on conflict (key) do update set value = excluded.value`;
	current = { ...current, [key]: value };
}

// kept for callers that read one value
export async function getSetting<K extends Key>(key: K): Promise<Settings[K]> {
	return current[key];
}

export const allSettings = async () => current;
