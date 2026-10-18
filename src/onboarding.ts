// X's own sign-in screen, served by this instance. The client renders whatever
// Jetfuel screens jf.x.com sends (patch.ts points that host here), so the
// screens are X's captured ones (src/jf, made by scripts/jf-templates.ts) with
// our texts, links and accounts filled in.
//
//   GET  /onboarding/web(/landing)                username field
//   POST /onboarding/web/actions/begin_login      username and password
//   POST /onboarding/web/actions/login_enter_password
//        right password: "complete" plus session cookies; wrong: the same
//        screen again with the error under the field
//
// The first screen is the signed-in client's own sign-in dialog.

import { signInCookies } from "./accounts";
import { login, startSession } from "./auth";
import { answerChallenge, startChallenge } from "./two-factor";
import { sql } from "./db";
import { type Message, encode, mapStrings, nameId } from "./jetfuel";
import { fromJson } from "./jetfuel-json";
import { CODE_DIGITS, SignupError, checkSignup, normalizeCode, signUp, usernameProblem, usernameState } from "./invites";
import { requestReset } from "./password-reset";
import { platformSource } from "./platforms";
import { mailEnabled } from "./mail";
import { checkSignupCode, sendSignupCode } from "./email-address";
import { settings } from "./settings";
import { hit, used } from "./ratelimit";
import { requestCountry, requestIp } from "./login-history";

const load = async (name: string): Promise<Message[]> => fromJson(await Bun.file(new URL(`./jf/${name}.json`, import.meta.url)).json());
// Takes out of a screen the parts that hold any of these texts. With `part` (a
// button is 7140) the nearest element of that type goes; otherwise the branch
// that sits beside the username field, i.e. the child of the nearest element
// that also holds the field.
function without(messages: Message[], texts: string[], part?: number): Message[] {
	const [, root] = messages[0];
	const parentOf = new Map<number, number>();
	root.els.forEach((e: any, i: number) => e.children.forEach((c: number) => parentOf.set(c, i)));
	const strings = (e: any) => [...e.props.values()].map((p: number) => root.props[p]).filter((p: any) => p[0] === 0).map((p: any) => p[1]);
	const holdsField = (i: number): boolean => strings(root.els[i]).includes("username_or_email") || root.els[i].children.some(holdsField);
	for (const text of texts) {
		let n = root.els.findIndex((e: any) => strings(e).includes(text));
		if (part !== undefined) while (n >= 0 && parentOf.has(n) && root.els[n].type !== part) n = parentOf.get(n)!;
		else while (n >= 0 && parentOf.has(n) && !holdsField(parentOf.get(n)!)) n = parentOf.get(n)!;
		const parent = parentOf.get(n);
		if (n < 0 || parent === undefined) continue;
		root.els[parent].children = root.els[parent].children.filter((c: number) => c !== n);
	}
	return messages;
}

// The code screen's field (element type -1662) is a row of boxes, one per
// character (digits only); its length is property -3903.
const INVITE_LENGTH = CODE_DIGITS;
function codeLength(messages: Message[], length: number): Message[] {
	const [, root] = messages[0];
	for (const e of root.els) {
		if (e.type !== -1662 || !e.props.has(-3903)) continue;
		root.props.push([1, length]);
		e.props.set(-3903, root.props.length - 1);
	}
	// and the resend countdown under it (type 25739) goes with the resend button
	return without(messages, ["Didn't receive a code? Retry in  "], 25739);
}

// The setup screen has name, username and password. Email goes under the name:
// a copy of the name block (label, input, error slot) with its texts changed.
function withEmailField(messages: Message[]): Message[] {
	const [, root] = messages[0];
	const text = (p: number): string | undefined => (root.props[p]?.[0] === 0 ? root.props[p][1] : undefined);
	const parentOf = new Map<number, number>();
	root.els.forEach((e: any, i: number) => e.children.forEach((c: number) => parentOf.set(c, i)));
	const input = root.els.findIndex((e: any) => e.props.has(17392) && text(e.props.get(17392)) === "name");
	const block = parentOf.get(input);
	const holder = block === undefined ? undefined : parentOf.get(block);
	if (input < 0 || block === undefined || holder === undefined) throw new Error("setup screen: no name field to copy");
	const swap: Record<string, string> = { "Name *": "Email *", name: "email", "Full name": "Email" };
	const copies = new Map<number, number>();
	const copy = (i: number): number => {
		if (copies.has(i)) return copies.get(i)!;
		const old = root.els[i];
		const props = new Map<number, number>(old.props);
		for (const [k, p] of props) {
			const t = text(p);
			if (t !== undefined && t in swap) {
				root.props.push([0, swap[t]]);
				props.set(k, root.props.length - 1);
			}
		}
		const fresh = { ...old, props, children: [] as number[] };
		root.els.push(fresh);
		const at = root.els.length - 1;
		copies.set(i, at);
		fresh.children = old.children.map(copy);
		return at;
	};
	const at = copy(block);
	const siblings = root.els[holder].children;
	siblings.splice(siblings.indexOf(block) + 1, 0, at);
	return messages;
}

// The setup screen checks the username as it's typed: its
// Input2.RemoteAsYouType posts the form to suggest_username and draws the
// reply. "Username is available" shows, and Continue enables, while the
// state AVAILABLE is true; "Username already taken" while TAKEN is. A reply
// sets them with state props that aren't defaults (the client then
// overwrites the page's value, states being shared by id); it draws nothing.
const AVAILABLE = 5843147273490502584n;
const TAKEN = 1165880133285406392n;
function usernameReply(state: "available" | "taken" | "invalid"): Message[] {
	const set = (id: bigint, on: boolean) => [18, { ref: [0, { id }], prop_ref: on ? 0 : 1, is_default: false }];
	const el = { type: nameId("View"), props: new Map([[nameId("available"), 2], [nameId("taken"), 3]]), children: [], id: null, extend: null };
	return [
		[0, { els: [el], props: [[6, true], [6, false], set(AVAILABLE, state === "available"), set(TAKEN, state === "taken")], ts: Math.floor(Date.now() / 1000) }],
		[1, { ref: 0, t: null }],
	] as Message[];
}

const templates = {
	// the forgot-password button mails a reset link (forgot_password action)
	password: await load("password"),
	// no phone numbers, Google or Apple accounts here
	landing: without(await load("landing"), ["Continue with phone", "Continue with Google", "Continue with Apple", "or"]),
	// the same, inline on the signed-out home page
	page: without(await load("page"), ["Continue with phone", "Continue with Google", "Continue with Apple", "or"]),
	// sign-up: X's emailed-code screen asks for the invite code instead
	code: codeLength(without(await load("code"), ["Send again"], 7140), INVITE_LENGTH),
	// the authenticator code at sign-in: six digits
	twoFactor: codeLength(without(await load("code"), ["Send again"], 7140), 6),
	setup: withEmailField(await load("setup")),
	success: await load("success"),
	passkey: await load("passkey"),
};

// x.com's legal links become the instance's rules page
const LINKS: Record<string, string> = {
	"https://x.com/tos": "/rules",
	"https://x.com/privacy": "/rules",
	"https://help.x.com/rules-and-policies/twitter-cookies": "/rules",
};
const TEXTS: Record<string, () => string> = {
	"Terms of Service": () => "Rules",
	"Privacy Policy": () => "privacy",
	"Cookie Use": () => "cookies",
	Login: () => `Sign in to ${settings().instance_name}`,
	"See what's happening": () => `Sign in to ${settings().instance_name}`,
	"Select an option below:": () => "Enter your username to continue.",
	"Email or username": () => "Username",
	"We sent you a security code": () => "Enter your invite code",
	"The code was sent to your device": () => `No account goes by that name yet. To create it, enter an invite to ${settings().instance_name}.`,
	"Didn't receive a code? ": () => "",
	"Choose a name, username, and password.": () => `Welcome to ${settings().instance_name}. Choose a name, username, and password.`,
};

// sign-up's emailed code, on the same six-box screen
const emailCodeTexts = (email: string): Record<string, string> => ({
	"We sent you a security code": "We sent you a code",
	"The code was sent to your device": `Enter it below to confirm ${email}.`,
	"Didn't receive a code? ": "",
});

const TWO_FACTOR_TEXTS: Record<string, string> = {
	"We sent you a security code": "Enter your authentication code",
	"The code was sent to your device": "Open your authenticator app and enter the 6-digit code, or one of your backup codes.",
	"Didn't receive a code? ": "",
};

function fill(messages: Message[], values: Record<string, string>, texts: Record<string, string> = {}): Message[] {
	return mapStrings(messages, (s) => {
		if (s in LINKS) return LINKS[s];
		if (s in texts) return texts[s];
		if (s in TEXTS) return TEXTS[s]();
		return s.replace(/\{\{(\w+)\}\}/g, (_, k) => values[k] ?? "");
	});
}

const respond = (messages: Message[], page = false, headers: Headers = new Headers()) => {
	headers.set("content-type", "text/plain");
	headers.set("x-jf-tag", "AgE");
	if (page) headers.set("x-jf-presentation", "page");
	headers.set("cache-control", "no-store");
	return new Response(encode(messages), { headers });
};

async function form(req: Request): Promise<Record<string, string>> {
	const f = await req.formData().catch(() => undefined);
	const out: Record<string, string> = {};
	if (f) for (const [k, v] of f) if (typeof v === "string") out[k] = v;
	return out;
}

// Sign-ups in progress, between their screens. In the database, so a restart
// in between doesn't lose them; they last half an hour.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function pending(token: string): Promise<{ username: string; code: string } | undefined> {
	if (!UUID.test(token)) return undefined;
	await sql`delete from signup_sessions where created_at < now() - interval '30 minutes'`;
	const [s] = await sql`select username, code from signup_sessions where token = ${token}::uuid`;
	return s;
}
const STALE = "That took too long. Go back and start again.";

// "Set up your account" with the username they typed already in place
function setupScreen(token: string, username: string): Message[] {
	const messages = fill(templates.setup, { session_token: token });
	for (const [tag, m] of messages) {
		if (tag !== 0) continue;
		for (const p of m.props) if (p[0] === 30 && p[1][1] instanceof Map && p[1][1].has("username")) p[1][1].set("username", username);
	}
	return messages;
}

// Errors without a new screen: an ActionResponder root whose "errors" (field
// name to text) the client puts under those fields of the screen it shows.
// (Sending the screen again with the error in its form works for steps, but
// not for the first screen, which came as a page.)
function fieldError(field: string, text: string): Message[] {
	const el = { type: nameId("ActionResponder"), props: new Map([[nameId("errors"), 0], [nameId("expected"), 1]]), children: [], id: null, extend: null };
	return [
		[0, { els: [el], props: [[17, new Map([[field, text]])], [6, true]], ts: Math.floor(Date.now() / 1000) }],
		[1, { ref: 0, t: null }],
	];
}

// the code, normalised, if it can still be used
async function validCode(raw: string): Promise<string | undefined> {
	const code = normalizeCode(raw);
	const [ok] = await sql`select 1 from invites where code = ${code} and not revoked and uses < max_uses and (expires_at is null or expires_at > now())
		and not exists (select 1 from users c where c.id = invites.created_by and c.status = 'suspended' and c.deactivated_at is null)`;
	return ok ? code : undefined;
}

const signInScreen = (username = "") => fill(templates.password, { username, session_token: crypto.randomUUID() });

export async function onboarding(req: Request, path: string): Promise<Response | undefined> {
	if (path === "/onboarding/web") return respond(fill(templates.landing, {}), true);
	if (path === "/onboarding/web/landing") return respond(fill(templates.page, {}), true);
	if (path === "/onboarding/web/remotes/passkey_one_fa") return respond(templates.passkey, true);
	// "Username is available": the setup screen asks while typing
	if (path.startsWith("/onboarding/web/remotes/suggest_username")) return respond(usernameReply(await usernameState(String((await form(req)).username ?? ""))));
	if (req.method !== "POST") return undefined;

	// One field for both: a known username goes on to its password; an unknown
	// one starts sign-up (X does the same with an email it doesn't know).
	if (path === "/onboarding/web/actions/begin_login") {
		const f = await form(req);
		const name = String(f.username_or_email ?? "").trim().replace(/^@/, "");
		const [user] = name ? await sql`select screen_name from users where lower(screen_name) = lower(${name}) and status <> 'suspended'` : [];
		if (user) return respond(signInScreen(user.screen_name));
		const mode = settings().signup_mode;
		if (mode === "closed") return respond(fieldError("username_or_email", "No account goes by that name."));
		const problem = usernameProblem(name);
		if (problem) return respond(fieldError("username_or_email", problem));
		const token = crypto.randomUUID();
		// came by an invite link (server.ts keeps its code in a cookie)
		const linked = /(?:^|;\s*)xitter_invite=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
		const code = linked && (await validCode(decodeURIComponent(linked)));
		await sql`insert into signup_sessions (token, username, code) values (${token}::uuid, ${name}, ${code || ""})`;
		return respond(mode === "open" || code ? setupScreen(token, name) : fill(templates.code, { session_token: token }));
	}
	// the invite code, checked here and spent when the account is made
	if (path === "/onboarding/web/actions/finish_verification") {
		const f = await form(req);
		const token = String(f.session_token ?? "");
		// a second-factor challenge answers here too
		const answered = await answerChallenge(token, String(f.code ?? ""));
		if (!answered.unknown) {
			if (!answered.userId) return respond(fieldError("code", answered.error ?? "That code isn't right."));
			const session = await startSession(answered.userId);
			const [user] = await sql`select screen_name from users where id = ${session.userId}::bigint`;
			const headers = new Headers();
			for (const c of await signInCookies(req, session)) headers.append("set-cookie", c);
			return respond(fill(templates.success, { user_id: session.userId, username: user.screen_name }), false, headers);
		}
		const s = await pending(token);
		if (!s) return respond(fieldError("code", STALE));
		// the code mailed at sign-up: the account is made once it's right
		const [held] = await sql`select pending from signup_sessions where token = ${token}::uuid and pending is not null`;
		if (held) {
			const result = await checkSignupCode(token, String(f.code ?? ""));
			if (result !== "ok") return respond(fieldError("code", result === "wrong" ? "That code isn't right." : "That code has expired. Go back and start again."));
			const p = held.pending;
			let userId: string;
			try {
				userId = await signUp({ code: s.code, screenName: p.screenName, name: p.name, email: p.email, passwordHash: p.passwordHash, emailVerified: true, source: p.source, country: p.country, ip: requestIp(req) ?? p.ip });
			} catch (e) {
				if (e instanceof SignupError) return respond(fieldError("code", e.message));
				throw e;
			}
			await sql`delete from signup_sessions where token = ${token}::uuid`;
			const session = await startSession(userId);
			const headers = new Headers();
			for (const c of await signInCookies(req, session)) headers.append("set-cookie", c);
			headers.append("set-cookie", "xitter_invite=; Path=/; Max-Age=0");
			return respond(fill(templates.success, { user_id: userId, username: p.screenName }), false, headers);
		}
		const code = await validCode(String(f.code ?? ""));
		if (!code) return respond(fieldError("code", "That invite code is not valid or has been used up."));
		await sql`update signup_sessions set code = ${code} where token = ${token}::uuid`;
		return respond(setupScreen(token, s.username));
	}
	if (path === "/onboarding/web/actions/verify_signup" || path === "/onboarding/web/actions/signup") {
		const f = await form(req);
		const token = String(f.session_token ?? "");
		const s = await pending(token);
		if (!s) return respond(fieldError("username", STALE));
		const fieldOf = (e: Error) => (/email/i.test(e.message) ? "email" : /password/i.test(e.message) ? "password" : /name/i.test(e.message) && !/user/i.test(e.message) ? "name" : "username");
		// with mail set up, the address is proven first: the checked form waits for the code
		if (mailEnabled()) {
			const given = { code: s.code, screenName: String(f.username ?? s.username), name: String(f.name ?? ""), password: String(f.password ?? ""), email: String(f.email ?? ""), ip: requestIp(req) };
			let checked: Awaited<ReturnType<typeof checkSignup>>;
			try {
				checked = await checkSignup(given);
			} catch (e) {
				if (!(e instanceof SignupError)) throw e;
				return respond(fieldError(fieldOf(e), e.message));
			}
			const held = { ...checked, ip: given.ip, passwordHash: await Bun.password.hash(given.password), source: await platformSource(req), country: requestCountry(req) ?? null };
			await sql`update signup_sessions set pending = ${JSON.stringify(held)}::text::jsonb where token = ${token}::uuid`;
			if (!hit("mail", requestIp(req) ?? "unknown").ok) return respond(fieldError("email", "Too many codes sent from here. Wait an hour."));
			try {
				await sendSignupCode(token, checked.email);
			} catch (e: any) {
				return respond(fieldError("email", `We couldn't send a code to that address: ${e.message}`));
			}
			return respond(fill(templates.twoFactor, { session_token: token }, emailCodeTexts(checked.email)));
		}
		try {
			await signUp({
				code: s.code,
				screenName: String(f.username ?? s.username),
				name: String(f.name ?? ""),
				password: String(f.password ?? ""),
				email: String(f.email ?? ""),
				ip: requestIp(req),
				source: await platformSource(req),
				country: requestCountry(req) ?? null,
			});
		} catch (e) {
			if (!(e instanceof SignupError)) throw e;
			const field = /email/i.test(e.message) ? "email" : /password/i.test(e.message) ? "password" : /name/i.test(e.message) && !/user/i.test(e.message) ? "name" : "username";
			return respond(fieldError(field, e.message));
		}
		await sql`delete from signup_sessions where token = ${token}::uuid`;
		const session = await login(String(f.username ?? s.username), String(f.password ?? ""));
		const headers = new Headers();
		for (const c of await signInCookies(req, session!)) headers.append("set-cookie", c);
		headers.append("set-cookie", "xitter_invite=; Path=/; Max-Age=0");
		return respond(fill(templates.success, { user_id: session!.userId, username: String(f.username ?? s.username) }), false, headers);
	}
	if (path === "/onboarding/web/actions/begin_password_recovery") {
		const f = await form(req);
		if (!hit("mail", requestIp(req) ?? "unknown").ok) return respond(fieldError("username_or_email", "Too many emails from here. Wait an hour."));
		await requestReset(String(f.username_or_email ?? f.username ?? ""));
		return respond(fieldError("username_or_email", "If that account has an email, we've sent a reset link to it."));
	}
	if (path === "/onboarding/web/actions/login_enter_password") {
		const f = await form(req);
		const username = String(f.username ?? "").trim().replace(/^@/, "");
		// guessing one account's password from many addresses still runs out;
		// only wrong passwords count, so signing in on several devices doesn't
		const account = username.toLowerCase();
		if (username && used("password", account)) return respond(fieldError("password", "Too many tries for this account. Wait 15 minutes."));
		const challenge = username && f.password ? await startChallenge(username, f.password) : undefined;
		if (challenge) return respond(fill(templates.twoFactor, { session_token: challenge }, TWO_FACTOR_TEXTS));
		const session = username && f.password ? await login(username, f.password) : undefined;
		if (!session) {
			if (username) hit("password", account);
			return respond(fieldError("password", "Wrong username or password."));
		}
		const [user] = await sql`select screen_name from users where id = ${session.userId}::bigint`;
		const headers = new Headers();
		for (const c of await signInCookies(req, session)) headers.append("set-cookie", c);
		return respond(fill(templates.success, { user_id: session.userId, username: user.screen_name }), false, headers);
	}
	return undefined;
}
