import { FEDERATION_ON } from "./federation";
import { gifProviders } from "./gifs";
import { esc, html, layout } from "./login";
import { mailEnabled } from "./mail";
import { scanEnabled } from "./media-scan";
import { settings } from "./settings";

type Section = [string, string[]];

const anthropicKey = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

function defaultTerms(): Section[] {
	const s = settings();
	const name = s.instance_name;
	return [
		["Who runs this", [
			`${name} is run by its own staff. It isn't X or Twitter and has nothing to do with X Corp. It runs Xitter, open source software, and shows X's web app pointed at this server.`,
		]],
		["Your account", [
			"You need to be at least 13, or older if the law where you live says so.",
			"Keep your password to yourself. You're responsible for what's posted from your account.",
			"One person can have several accounts, but using them to get around a suspension, fake support or harass someone isn't allowed.",
		]],
		["What you post", [
			"What you post stays yours. By posting it you let this instance store it, show it to the people it's meant for and send it where it needs to go to work" + (FEDERATION_ON ? ", other Xitter instances included" : "") + ".",
			"Don't post what you have no right to post, and nothing illegal.",
		]],
		["Rules and moderation", [
			"The rules at /rules apply to everyone. Staff can hide or remove posts and media, give strikes, limit accounts and suspend them when the rules are broken. You can appeal from your account's notices page.",
		]],
		...(s.features.money
			? ([["Play money", ["Equicoins and everything bought with them are play money. They have no cash value, can't be sold or paid out, and staff can adjust or reverse them."]]] as Section[])
			: []),
		["No guarantees", [
			"The service is given as it is, for free. It can be down, lose data, change or close. Nobody running it is liable for that as far as the law allows.",
		]],
		["Changes", [
			"These terms can change. The current version is always on this page, and using the service after a change means you accept it.",
		]],
	];
}

function defaultPrivacy(): Section[] {
	const s = settings();
	const services: string[] = [];
	if (mailEnabled()) services.push("A mail service delivers the emails this instance sends you (sign-up codes, password resets, digests).");
	if (anthropicKey() && s.claude_mod.enabled)
		services.push("Anthropic's Claude reads new posts, profile changes, reports and messages from the old 2020 app to flag rule breaking for staff. Chat messages are end-to-end encrypted and never sent.");
	if (s.features.grok)
		services.push(s.grok.brain === "claude" && anthropicKey() ? "When you talk to Grok, your messages go to Anthropic's Claude to get an answer." : "When you talk to Grok, your messages go to a language model run for this instance.");
	const gifs = gifProviders().map((p) => p.display_name);
	if (s.features.gifs && gifs.length) services.push(`GIF searches go to ${gifs.length > 1 ? `the GIF service you pick (${gifs.slice(0, -1).join(", ")} or ${gifs.at(-1)})` : gifs[0]}.`);
	services.push("When you press Translate, that post's text goes to Google Translate.");
	if (scanEnabled()) services.push("Uploaded photos pass through Cloudflare once so its tool can check them for child sexual abuse material.");
	if (FEDERATION_ON) services.push("Public posts and profiles are shared with other Xitter instances this one federates with, and those instances follow their own rules.");
	return [
		["What we keep", [
			"Your account: username, display name, profile, the email you gave and your password, stored only as a hash nobody can read back.",
			"What you do here: posts, replies, likes, reposts, bookmarks, follows, lists, uploads and settings.",
			"Messages: chats are end-to-end encrypted, so the server only stores them sealed and can't read them. Messages sent from the old 2020 app aren't encrypted.",
			"Sign-ins: the IP address, the country it's in, the app and the browser of each sign-in, and of every device that's still signed in. You see these under Settings, Your account, Account access history.",
		]],
		["Why", [
			"To run the service and show you your stuff.",
			"To keep accounts safe and the rules working: staff with permission can see sign-in addresses to find stolen accounts, spam and people getting around a suspension.",
			"Your country sets the \"based in\" line of your profile unless you change it.",
		]],
		["Who else sees it", [
			"Your posts and profile are public unless you protect your account or post to a circle.",
			"Staff see what they need to moderate. Only some staff can see email and IP addresses.",
			...services,
			"Nothing is sold, there are no ads, and the app only talks to this server: no trackers or analytics from anyone else.",
		]],
		["Cookies", [
			"Only the ones that keep you signed in and remember your settings, like dark mode.",
		]],
		["How long", [
			"Everything is kept while your account exists. Database backups are kept for a while after that.",
			"Deactivating hides your account; signing in within 30 days brings it back. To have it deleted for good, ask staff.",
			"When a suspended account is deleted, its username, email and recent sign-in addresses are kept so it can't just come back.",
		]],
		["Your data", [
			"You can download an archive of your data under Settings, Your account. You can change or delete your posts and profile any time, and ask staff to delete your account.",
		]],
	];
}

function custom(text: string): string {
	return text
		.trim()
		.split(/\n\s*\n/)
		.map((p) => (p.startsWith("## ") ? `<h2>${esc(p.slice(3).trim())}</h2>` : `<p class="rules">${esc(p)}</p>`))
		.join("");
}

const builtIn = (sections: Section[]) =>
	sections.map(([title, paragraphs]) => `<h2>${esc(title)}</h2>${paragraphs.map((p) => `<p class="rules">${esc(p)}</p>`).join("")}`).join("");

function legalPage(title: string, written: string, sections: () => Section[]): Response {
	return html(
		layout(
			title,
			`<style>.legal h2 { margin: 16px 0 0; font-size: 18px; } body:has(.legal) { display: block; } .legal { margin: 0 auto; } .source { position: static; margin: 0 0 24px; }</style>
<form class="legal">
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>${esc(title)}</h1>
	${written.trim() ? custom(written) : builtIn(sections())}
	<p class="alt"><a href="/tos">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/rules">Rules</a> · <a href="/">Sign in</a></p>
</form>`,
		),
	);
}

export const termsPage = () => legalPage("Terms of Service", settings().terms, defaultTerms);
export const privacyPage = () => legalPage("Privacy Policy", settings().privacy, defaultPrivacy);
