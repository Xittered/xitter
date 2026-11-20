// Instance-wide settings, changed from the admin panel. They are read on
// nearly every page, so they are kept in memory: loaded once at start and
// replaced whenever the panel saves one.

import { sql } from "./db";
import { gifAvailable } from "./gifs";
import { foldGlyphs } from "./fold";

export type SignupMode = "invite" | "open" | "closed";

// parts of the client this instance can switch off; true shows the feature
export const NAME_MAX = 100;

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
	notes_everyone: "Anyone can write Community Notes (off: only accounts given access on their admin page)",
	link_previews: "Previews of public posts and profiles when their links are shared in other apps",
	archive_import: "Import from X: accounts upload their X archive and its posts come over (Settings > Your account)",
	money: "Equicoins: accounts send each other money from the side bar (the instance's own play money, not real currency)",
	circles: "Circles: posts only the people an account picks can see (Circle instead of Everyone in the composer)",
	migration: "Move account: accounts move to and from other instances with a migration code (off: no new codes or imports here, and other instances can't read accounts from here; imports already running finish)",
	affiliate_checkmarks: "Checkmarks for affiliates of an organisation (off: they keep the organisation's badge, and only a checkmark of their own shows)",
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
		notes_everyone: true,
		link_previews: true,
		archive_import: false,
		money: false,
		circles: true,
		affiliate_checkmarks: true,
		migration: true,
	} as Record<Feature, boolean>,
	limits: { image_mb: 5, video_mb: Number(process.env.MAX_VIDEO_MB ?? 200), video_seconds: Number(process.env.MAX_VIDEO_SECONDS ?? 600) },
	// media-compress.ts and video.ts: uploads made smaller as they're stored, for
	// instances short on disk; off keeps photos as they came
	media: { compress: false, photo_max_side: 2048, photo_quality: 80, video_max_side: 1280, video_crf: 26 },
	// per account per 15 minutes (ratelimit.ts); sign-in and mail limits are fixed
	rate_limits: { read: 6000, endpoint: 1000, write: 1500, post: 150, engage: 1000, dm: 1500, upload: 150 },
	// longest post per badge, in X's weighted characters (textlen.ts); grey covers
	// government organisations and officials
	post_limits: { none: 4000, blue: 25000, business: 128000, government: 256000 },
	// posts and replies each account may make in any 24 hours; staff have none
	daily_caps: { enabled: true, posts: 1000, replies: 3000 },
	// shown above every timeline until the viewer closes it; a new id shows it again
	announcement: { id: "", text: "", link: "", buttons: [] as { label: string; url: string }[] },
	// handles every new account follows
	default_follows: [] as string[],
	// the instance's rules, shown at /rules and linked from sign-up
	rules: "",
	terms: "",
	privacy: "",
	legal: { operator: "", contact: "", backup_days: 0, terms_updated: "", privacy_updated: "" },
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
		trend_min_people: 3,
		trend_min_account_days: 3,
		global_pin: null as string | null,
	},
	automod: { enabled: true, strike_days: 365, ladder: [0, 24, 168, 720, -1] as number[], second_chances: 5 },
	// claude-mod.ts: Claude reads new posts, profile changes, reports and 2020
	// DMs (needs ANTHROPIC_API_KEY in the server's environment). It hides clear
	// violations and files the rest for staff; it never strikes or suspends.
	claude_mod: {
		enabled: true,
		model: "claude-haiku-5-5",
		// a verdict below this confidence is only filed for staff, never acted on
		hide_confidence: 0.85,
		// a ceiling on model calls per day, so a flood can't run up the bill
		daily_limit: 5000,
		posts: true,
		profiles: true,
		reports: true,
		dms: true,
		// learn from staff confirming or dismissing its reports (claude-mod-feedback.ts)
		learn: true,
		borderline: false,
		// replaces claude-mod.ts DEFAULT_GUIDE when set
		prompt: "",
	},
	grok: { brain: "claude" as "claude" | "bee", model: "claude-haiku-5-5", bee_url: "", daily_per_account: 100, prompt: "" },
	// the admin panel itself (admin.ts staffGate): staff must have two-factor on;
	// only these addresses (IPs or CIDR ranges) reach it, none meaning any
	security: { staff_2fa: false, admin_ips: [] as string[] },
	// Admin > Federation: show the checkmarks other instances gave their accounts
	// (model.ts shownVerifiedType); off, they look unverified here
	remote_checkmarks: true,
	// backups.ts: while `daily` is on, a database dump every `every_hours` (one
	// of BACKUP_INTERVALS), the newest `keep` kept
	backups: { daily: false, keep: 7, every_hours: 24 },
	// self-update.ts: the repository and branch an admin last updated from, which
	// the update check (update-check.ts) then follows; blank for its defaults
	update_source: { repo: "", branch: "" },
	// member-invites.ts: invites members make themselves, while sign-up is by invite
	invite_quota: { enabled: false, per_month: 3, uses: 1, min_age_days: 7 },
	// archive-import.ts: who may import from X, while the feature is on; staff skip both
	archive_import: { min_age_days: 7, approval: true },
	// money.ts: what a new wallet holds and the most one transfer moves, in cents
	// like_cents: what a post's author earns for each like (once per post and account)
	// feed: the handle of a local account that posts every payment ("" for none)
	// follow_network: take the starting balance, like reward and largest payment from xitter.space
	// peer_daily_cents: most taken in from one peer a day, its transfers and likes (0: no limit).
	// A peer's word is all there is for what it sends, so the default is one largest payment a day.
	// move_balance: an account moving away takes its balance along
	// network_totals: share this instance's totals with peers and show the network's
	money: { starting_cents: 500, max_transfer_cents: 100_000, like_cents: 50, feed: "", follow_network: false, peer_daily_cents: 100_000, move_balance: true, network_totals: false },
	// money shop: listings are in money_shop_items; only approved announcements are shown
	ads: { enabled: false, min_spend_cents: 500, base_cpm_cents: 20, price_scale_cents: 10_000, economy_cpm_ppm: 20, demand_share_pct: 1, max_days: 7, max_pending: 3, reject_refund_pct: 70, min_viewer_age_days: 3 },
	money_shop: { enabled: false, announcement: null as null | { id: string; text: string; buttons: { label: string; url: string }[] } },
	// client-choice.ts: which web client people get when the instance serves more
	// than one ("" for the CLIENT_DIR build), and whether each person may pick
	clients: { default: process.env.DEFAULT_CLIENT ?? "", user_choice: process.env.CLIENT_CHOICE !== "off" },
	// the client's own feature switches, set by an admin (Admin > Feature
	// switches); they win over the build's values and Xitter's own (shell.ts)
	switch_overrides: {} as Record<string, unknown>,
	// staff-permissions.ts: what moderators and support may do, where an admin
	// changed it from the defaults (Admin > Staff permissions)
	staff_permissions: { moderator: {} as Record<string, boolean>, support: {} as Record<string, boolean> },
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
export const feature = (f: Feature) => (f === "gifs" && !gifAvailable() ? false : current.features[f] !== false);
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
