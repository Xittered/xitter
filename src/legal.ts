import { FEDERATION_ON } from "./federation";
import { gifProviders } from "./gifs";
import { esc, html, layout } from "./login";
import { mailEnabled } from "./mail";
import { scanEnabled } from "./media-scan";
import { settings } from "./settings";

type Section = [string, string[]];

const BUILT_IN_UPDATED = "2026-11-20";

const anthropicKey = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const longDate = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

function operator() {
	const s = settings();
	const who = s.legal.operator.trim() || `the staff of ${s.instance_name}`;
	const contact = s.legal.contact.trim();
	return { who, contact, reach: contact ? `contact us at ${contact}` : "contact the staff of this instance" };
}

function backupDays(): number {
	const s = settings();
	if (s.legal.backup_days > 0) return s.legal.backup_days;
	const { keep, every_hours } = s.backups;
	return Math.max(1, Math.ceil((keep * (every_hours || 24)) / 24));
}

function defaultTerms(): Section[] {
	const s = settings();
	const name = s.instance_name;
	const { who, reach } = operator();
	return [
		["1. Who we are", [
			`${name} is operated by ${who}. It is an independent service and is not affiliated with, endorsed by or connected to X Corp. It runs Xitter, open source software, and serves X's web app pointed at our own server.`,
			`For questions about these terms, ${reach}.`,
		]],
		["2. Eligibility", [
			"You must be at least 13 years old to use this service, or older if the law of your country requires it. By creating an account you confirm that you meet this requirement.",
		]],
		["3. Your account", [
			"You are responsible for keeping your password safe and for everything done through your account.",
			"You may have more than one account, but you may not use additional accounts to evade a suspension, impersonate others or harass anyone.",
		]],
		["4. Your content", [
			"You keep ownership of everything you post. By posting, you give us a non-exclusive, royalty-free permission to store, display and transmit your content as needed to run the service" + (FEDERATION_ON ? ", including sending it to other Xitter instances" : "") + ". This permission ends when the content is deleted, except for copies kept in backups for the period stated in our Privacy Policy.",
			"You may only post content you have the right to share, and nothing that is illegal.",
		]],
		["5. Rules and moderation", [
			"Everyone must follow the rules published at /rules. We may hide or remove content, give strikes, and restrict, limit or suspend accounts that break them. You can appeal a decision from your account's notices page.",
		]],
		...(s.features.money
			? ([["6. Virtual currency", ["Equicoins and anything obtained with them are virtual items with no monetary value. They cannot be sold, exchanged for money or paid out, and we may adjust or reverse them at any time."]]] as Section[])
			: []),
		[`${s.features.money ? 7 : 6}. Disclaimer`, [
			"The service is provided free of charge and \"as is\", without warranties of any kind. It may be unavailable, lose data, change or shut down at any time. To the extent permitted by law, we are not liable for any loss arising from your use of the service.",
		]],
		[`${s.features.money ? 8 : 7}. Changes to these terms`, [
			"We may update these terms at any time. Changes take effect when they are posted on this page, and the date at the top shows the latest version. Continuing to use the service after a change means you accept the updated terms.",
		]],
	];
}

function defaultPrivacy(): Section[] {
	const s = settings();
	const name = s.instance_name;
	const { who, reach } = operator();
	const days = backupDays();
	const providers: string[] = [];
	if (mailEnabled()) providers.push("Email delivery: an email service sends the messages we send you, such as sign-up codes, password resets and digests.");
	if (anthropicKey() && s.claude_mod.enabled)
		providers.push("Anthropic (Claude), United States: automated moderation. New posts, profile changes, reports and messages sent from the old 2020 app are checked for rule violations. End-to-end encrypted chats are never sent.");
	if (s.features.grok)
		providers.push(s.grok.brain === "claude" && anthropicKey() ? "Anthropic (Claude), United States: when you talk to Grok, your messages are sent to generate a reply." : "A language model run for this instance: when you talk to Grok, your messages are sent to it to generate a reply.");
	const gifs = gifProviders().map((p) => p.display_name);
	if (s.features.gifs && gifs.length) providers.push(`GIF search (${gifs.join(", ")}): your search terms go to the GIF service you use.`);
	providers.push("Google Translate, United States: when you press Translate, the text of that post is sent to be translated.");
	if (scanEnabled()) providers.push("Cloudflare, United States: uploaded photos pass through Cloudflare once so they can be checked against known child sexual abuse material.");
	return [
		["1. Who we are", [
			`${name} is operated by ${who}, who is the controller of your personal data. To ask anything about this policy or your data, ${reach}.`,
			"This policy explains what personal data we collect, why, who it is shared with, how long we keep it and what rights you have.",
		]],
		["2. Information we collect", [
			"Account details: your username, display name, profile information, the email address you give us, and your password, which is stored only as a one-way hash that no one can read.",
			"Content and activity: your posts, replies, likes, reposts, bookmarks, follows, lists, uploaded media and settings.",
			"Messages: chats are end-to-end encrypted. Our server only stores them in encrypted form and cannot read them. Messages sent from the old 2020 app are not end-to-end encrypted.",
			"Technical data: for every sign-in, and for every device that is signed in, we record the IP address, the country it belongs to, the app and the browser used, and the time. You can see this under Settings, Your account, Account access history.",
		]],
		["3. Why we use it and our legal basis", [
			"To provide the service you signed up for: creating your account, showing your content and delivering it to the people it's meant for (performance of a contract).",
			"To keep the platform safe: IP addresses and sign-in records are used to protect accounts from being taken over, to fight spam and abuse, and to stop people from getting around suspensions. Content is moderated, partly with automated tools, to enforce our rules (legitimate interests).",
			"To show the \"based in\" country on your profile, which you can change at any time (legitimate interests).",
			"To comply with the law, for example when removing illegal content (legal obligation).",
		]],
		["4. Who we share it with", [
			"Your posts and profile are public unless you protect your account or post to a circle.",
			"Staff can see what they need to moderate the service. Only staff with specific permission can see email addresses and IP addresses.",
			...(FEDERATION_ON ? ["Other Xitter instances: public posts and profiles are shared with the instances we federate with. They are run by other people, may be located anywhere in the world, and handle data under their own policies."] : []),
			"Service providers, who process data on our behalf only for the purposes below:",
			...providers.map((p) => `• ${p}`),
			"We do not sell your data and do not show ads. The app only connects to our server and loads no third-party trackers or analytics.",
		]],
		["5. International transfers", [
			"Our server and some of our providers may be located outside your country, including in the United States. Where data leaves the UK or the EU, our providers rely on standard legal safeguards, such as Standard Contractual Clauses, to protect it.",
		]],
		["6. Cookies and tracking", [
			"We only use cookies that are needed to keep you signed in and to remember your settings, such as dark mode. We do not use advertising or tracking cookies.",
			"We do not track you across other websites over time, and we do not allow third parties to collect information about your online activity through our service. Because we do no such tracking, the service works the same whether or not your browser sends a \"Do Not Track\" signal.",
		]],
		["7. Data retention", [
			"We keep your data for as long as your account exists.",
			`Database backups are kept for up to ${days} days, after which they are automatically overwritten and permanently deleted.`,
			"If you deactivate your account, it is hidden and can be restored by signing in within 30 days. To have your account deleted permanently, contact us.",
			"If a suspended account is deleted, we keep its username, email address and the IP addresses it used in its last 30 days, only to prevent it from returning.",
		]],
		["8. Data security", [
			"Passwords are hashed, connections are encrypted with HTTPS, chats are end-to-end encrypted, and access to personal data is limited by staff permissions.",
		]],
		["9. Your rights", [
			"You have the right to access, correct and delete your personal data, to object to or restrict how we use it, and to receive a copy of it. You can download an archive of your data under Settings, Your account, and edit or delete your posts and profile at any time.",
			`For anything else, ${reach}. We will verify that the request comes from the account owner before acting on it. You also have the right to complain to your local data protection authority.`,
			"California residents: this policy is written to meet the California Online Privacy Protection Act (CalOPPA). We do not sell your personal information or share it for advertising.",
		]],
		["10. Children", [
			"The service is not intended for children under 13, and we do not knowingly collect personal data from them. If you believe a child under 13 has given us personal data, contact us and we will delete it.",
		]],
		["11. Changes to this policy", [
			"We may update this policy at any time. Changes take effect when they are posted on this page, and the date at the top shows the latest version.",
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

function legalPage(title: string, written: string, updated: string, sections: () => Section[]): Response {
	const own = written.trim();
	return html(
		layout(
			title,
			`<style>.legal h2 { margin: 16px 0 0; font-size: 18px; } body:has(.legal) { display: block; } .legal { margin: 0 auto; } .source { position: static; margin: 0 0 24px; }</style>
<form class="legal">
	<img class="logo" src="/public/logo-dark.png" alt="${esc(settings().instance_name)}">
	<h1>${esc(title)}</h1>
	<p class="alt">Last updated: ${esc(longDate(own && updated ? updated : BUILT_IN_UPDATED))}</p>
	${own ? custom(written) : builtIn(sections())}
	<p class="alt"><a href="/tos">Terms</a> · <a href="/privacy">Privacy</a> · <a href="/rules">Rules</a> · <a href="/">Sign in</a></p>
</form>`,
		),
	);
}

export const termsPage = () => legalPage("Terms of Service", settings().terms, settings().legal.terms_updated, defaultTerms);
export const privacyPage = () => legalPage("Privacy Policy", settings().privacy, settings().legal.privacy_updated, defaultPrivacy);
