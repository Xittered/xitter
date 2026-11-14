// Passkeys: signing in with a fingerprint, face or screen lock instead of a
// password (and instead of the two-factor code: a passkey checks both).
//
//   /account/passkeys            list, add and remove them (signed in)
//   /account/passkey             a page with a "Sign in with a passkey" button
//   POST /account/passkey/options   a challenge for signing in
//   POST /account/passkey/signin    the browser's answer: session cookies
//
// The sign-in dialog (PASSKEY_SCRIPT) offers saved passkeys in the username
// field's autofill, as its autocomplete="username webauthn" asks, and adds a
// button above the field.
import { signInCookies } from "./accounts";
import { accountPage, esc } from "./account-page";
import { startSession, type Viewer } from "./auth";
import { PASSKEY_ORIGINS, PUBLIC_HOSTNAME } from "./config";
import { sql } from "./db";
import { requestIp } from "./login-history";
import { hit, passwordTry } from "./ratelimit";
import { settings } from "./settings";
import { ALGORITHMS, b64url, challengeOf, unb64url, verifyAssertion, verifyRegistration } from "./webauthn";

const MAX_PASSKEYS = 10;
const TIMEOUT = 5 * 60 * 1000;
const expected = (challenge: string) => ({ challenge, origin: PASSKEY_ORIGINS, rpId: PUBLIC_HOSTNAME });
const fail = (error: string, status = 400) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

// one challenge per ceremony, used once; for adding a passkey it belongs to the account
async function newChallenge(userId: string | null): Promise<string> {
	const challenge = b64url(crypto.getRandomValues(new Uint8Array(32)));
	await sql`delete from passkey_challenges where created_at < now() - interval '5 minutes'`;
	await sql`insert into passkey_challenges (challenge, user_id) values (${challenge}, ${userId}::bigint)`;
	return challenge;
}

async function spend(challenge: string | undefined, userId: string | null): Promise<boolean> {
	if (!challenge || challenge.length > 100) return false;
	const spent = await sql`delete from passkey_challenges where challenge = ${challenge}
		and user_id is not distinct from ${userId}::bigint and created_at > now() - interval '5 minutes' returning challenge`;
	return spent.length > 0;
}

// a same-site page's own request; SameSite=Lax cookies already keep other
// sites out, this is the belt to those braces
const sameOrigin = (req: Request) => PASSKEY_ORIGINS.includes(req.headers.get("origin") ?? "");

async function body(req: Request): Promise<Record<string, unknown>> {
	if ((Number(req.headers.get("content-length")) || 0) > 64 * 1024) return {};
	const b = await req.json().catch(() => ({}));
	return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

const bytes = (v: unknown): Uint8Array | undefined => (typeof v === "string" && v.length < 16 * 1024 && /^[\w-]*$/.test(v) ? unb64url(v) : undefined);

// the name a new passkey gets when none is typed: the browser and system it was made on
function deviceName(req: Request): string {
	const ua = req.headers.get("user-agent") ?? "";
	const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
	const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
	return [browser, os].filter(Boolean).join(" on ") || "Passkey";
}

// Signing in. Discoverable passkeys only: the browser offers whichever it
// holds for this site, so no username is asked for first.
export async function passkeySignInRoute(req: Request, path: string): Promise<Response | undefined> {
	if (path === "/account/passkey" && req.method === "GET") return signInPage(req);
	if (req.method !== "POST" || !sameOrigin(req)) return undefined;
	// The dialog asks for a challenge each time it opens (for the autofill), so
	// that has its own bucket; only answers spend sign-in tries
	const ip = requestIp(req) ?? "unknown";
	if (!hit(path === "/account/passkey/options" ? "passkey" : "auth", ip).ok) return fail("Too many tries from here. Wait 15 minutes.", 429);
	if (path === "/account/passkey/options") {
		return Response.json({ challenge: await newChallenge(null), rpId: PUBLIC_HOSTNAME, userVerification: "required", timeout: TIMEOUT }, { headers: { "cache-control": "no-store" } });
	}
	if (path !== "/account/passkey/signin") return undefined;
	const b = await body(req);
	const id = typeof b.id === "string" && b.id.length <= 1400 ? b.id : "";
	const clientDataJSON = bytes(b.clientDataJSON);
	const authenticatorData = bytes(b.authenticatorData);
	const signature = bytes(b.signature);
	if (!id || !clientDataJSON || !authenticatorData || !signature) return fail("That passkey answer was incomplete. Try again.");
	if (!(await spend(challengeOf(clientDataJSON), null))) return fail("That took too long. Try again.");
	const [key] = await sql`select p.user_id::text, p.public_key, p.alg, p.sign_count from passkeys p join users u on u.id = p.user_id
		where p.id = ${id} and u.instance is null`;
	if (!key) return fail("This passkey isn't on any account here. It may have been removed.");
	// the account the passkey was made for, if the browser says
	const handle = bytes(b.userHandle);
	if (handle?.length && new TextDecoder().decode(handle) !== key.user_id) return fail("This passkey isn't on any account here.");
	let count: number;
	try {
		count = verifyAssertion({ clientDataJSON, authenticatorData, signature }, { publicKey: unb64url(key.public_key), alg: key.alg }, expected(challengeOf(clientDataJSON)!));
	} catch {
		return fail("That passkey couldn't be checked. Try again.");
	}
	const result = await sql.begin(async (tx) => {
		// the account lock first, as password changes and two-factor sign-ins take it
		const [u] = await tx`select status, deactivated_at, deactivated_at > now() - interval '30 days' as returning
			from users where id = ${key.user_id}::bigint for update`;
		// a password change or reset may have removed it while this was checked
		const [still] = await tx`select sign_count from passkeys where id = ${id} and user_id = ${key.user_id}::bigint`;
		if (!u || !still) return { error: "This passkey isn't on any account here. It may have been removed.", status: 400 };
		// A counter that didn't move forward means a copied authenticator
		// (passkeys that sync always report 0, and are let through)
		const [p] = await tx`update passkeys set sign_count = ${count}, last_used_at = now()
			where id = ${id} and (${count} = 0 or sign_count < ${count}) returning id`;
		if (!p) return { error: "This passkey looks like a copy, so it was refused. Sign in with your password." };
		if (u.returning) await tx`update users set status = 'active', deactivated_at = null where id = ${key.user_id}::bigint`;
		else if (u.status === "suspended" || u.deactivated_at) return { error: "This account is suspended." };
		return { session: await startSession(key.user_id, tx) };
	});
	if (!result.session) return fail(result.error!, result.status ?? 403);
	const headers = new Headers({ "cache-control": "no-store" });
	for (const c of await signInCookies(req, result.session)) headers.append("set-cookie", c);
	return Response.json({ ok: true }, { headers });
}

// the browser side, shared by the dialog and the sign-in page: window.xitterPasskey
const CLIENT = `(function(){
	if(window.xitterPasskey||!window.PublicKeyCredential)return;
	var dec=function(s){s=s.replace(/-/g,"+").replace(/_/g,"/");var b=atob(s),a=new Uint8Array(b.length);for(var i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a.buffer};
	var enc=function(b){var s="",a=new Uint8Array(b);for(var i=0;i<a.length;i++)s+=String.fromCharCode(a[i]);return btoa(s).replace(/\\+/g,"-").replace(/\\//g,"_").replace(/=+$/,"")};
	var post=function(path,data){return fetch(path,{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json"},body:JSON.stringify(data||{})}).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||"Something went wrong.");return j})})};
	var waiting;
	// mediation "conditional": the passkeys show in the username field's
	// autofill and nothing happens until one is picked
	function signIn(mediation){
		if(waiting)waiting.abort();
		var ctl=waiting=new AbortController();
		return post("/account/passkey/options").then(function(o){
			return navigator.credentials.get({mediation:mediation,signal:ctl.signal,publicKey:{challenge:dec(o.challenge),rpId:o.rpId,userVerification:o.userVerification,timeout:o.timeout,allowCredentials:[]}});
		}).then(function(c){
			// some browsers resolve with nothing instead of rejecting when the prompt is closed
			if(!c)throw new DOMException("closed","NotAllowedError");
			var r=c.response;
			return post("/account/passkey/signin",{id:c.id,clientDataJSON:enc(r.clientDataJSON),authenticatorData:enc(r.authenticatorData),signature:enc(r.signature),userHandle:r.userHandle?enc(r.userHandle):""});
		}).then(function(){location.assign("/home")},function(e){
			if(ctl.signal.aborted)return;
			if(waiting===ctl)waiting=null;
			// closed or timed out, which browsers don't tell apart: nothing to say
			if(e&&e.name==="NotAllowedError"){if(mediation==="conditional")autofill();return}
			alert(e&&e.message||"Signing in with a passkey didn't work.");
			if(mediation==="conditional")autofill();
		});
	}
	var started=false;
	function autofill(){
		if(!PublicKeyCredential.isConditionalMediationAvailable)return;
		PublicKeyCredential.isConditionalMediationAvailable().then(function(ok){if(ok){started=true;signIn("conditional")}});
	}
	window.xitterPasskey={
		signIn:function(){return signIn("required")},
		autofill:function(){if(!started)autofill()},
		post:post,dec:dec,enc:enc
	};
})();`;

// On the signed-out page: the dialog's username field (autocomplete "username
// webauthn") gets saved passkeys in its autofill, and above it a button in the
// style of X's "Continue with Google", then X's "or" line.
const KEY_ICON = "M12.65 10A6 6 0 0 0 7 6a6 6 0 1 0 5.65 8H17v4h4v-4h2v-4H12.65zM7 14a2 2 0 1 1 0-4 2 2 0 0 1 0 4z";
export const PASSKEY_SCRIPT = `${CLIENT}
(function(){
	if(!window.xitterPasskey)return;
	function look(){
		var field=document.querySelector('input[autocomplete~="webauthn"]');
		if(!field)return;
		xitterPasskey.autofill();
		var label=field.closest("label");
		var block=label&&label.parentElement;
		if(!block||block.parentElement.querySelector("[data-xitter-passkey]"))return;
		var light=getComputedStyle(document.body).backgroundColor==="rgb(255, 255, 255)";
		var box=document.createElement("div");
		box.setAttribute("data-xitter-passkey","");
		box.style.cssText="display:flex;flex-direction:column;box-sizing:border-box;width:100%;margin:0 0 4px;align-self:flex-start";
		var b=document.createElement("button");
		b.type="button";
		b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" style="width:20px;height:20px;margin-right:8px;fill:currentColor;flex:none"><path d="${KEY_ICON}"/></svg><span>Sign in with a passkey</span>';
		b.style.cssText="display:flex;align-items:center;justify-content:center;width:100%;min-height:40px;padding:0 16px;border-radius:9999px;border:1px solid rgb(207, 217, 222);background:#fff;color:rgb(15, 20, 25);font:inherit;font-size:15px;font-weight:700;line-height:20px;cursor:pointer;transition:background-color .2s";
		b.addEventListener("mouseenter",function(){b.style.backgroundColor="rgb(230, 230, 230)"});
		b.addEventListener("mouseleave",function(){b.style.backgroundColor="#fff"});
		b.addEventListener("click",function(e){e.preventDefault();e.stopPropagation();xitterPasskey.signIn()});
		var line=light?"rgb(207, 217, 222)":"rgb(47, 51, 54)";
		var or=document.createElement("div");
		or.style.cssText="display:flex;align-items:center;gap:8px;margin:12px 0 8px;color:"+(light?"rgb(15, 20, 25)":"rgb(231, 233, 234)")+";font-size:15px;line-height:20px";
		or.innerHTML='<div style="flex:1;height:1px;background:'+line+'"></div><span>or</span><div style="flex:1;height:1px;background:'+line+'"></div>';
		box.appendChild(b);box.appendChild(or);
		block.parentElement.insertBefore(box,block);
		// as wide as the textbox and lined up with it, which is narrower than the column
		function fit(){
			var f=label.getBoundingClientRect(),p=box.parentElement&&box.parentElement.getBoundingClientRect();
			if(!p||!f.width)return;
			box.style.width=f.width+"px";
			box.style.marginLeft=(f.left-p.left-parseFloat(getComputedStyle(box.parentElement).paddingLeft||"0"))+"px";
		}
		fit();
		if(window.ResizeObserver)new ResizeObserver(fit).observe(label);
	}
	new MutationObserver(look).observe(document.documentElement,{childList:true,subtree:true});
	look();
})();`;

function signInPage(req: Request): Promise<Response> {
	return accountPage({
		req,
		title: "Sign in with a passkey",
		body: `<h1>Sign in with a passkey</h1>
<p>Use the fingerprint, face or screen lock of a device that has a passkey for ${esc(settings().instance_name)}. Add one in Settings, under Passkeys, after signing in with your password.</p>
<p class="error" id="unsupported" hidden>This browser can't use passkeys.</p>
<form><button type="button" id="go">Sign in with a passkey</button></form>
<p class="dim"><a href="/">Sign in with your password instead</a></p>
<script>${CLIENT}
if(window.xitterPasskey){document.getElementById("go").onclick=function(){xitterPasskey.signIn()}}
else{document.getElementById("unsupported").hidden=false;document.getElementById("go").disabled=true}</script>`,
	});
}

// Settings: the account's passkeys
const MANAGE_SCRIPT = `${CLIENT}
(function(){
	var form=document.getElementById("add"),err=document.getElementById("add-error");
	if(!window.xitterPasskey){err.textContent="This browser can't make passkeys.";err.hidden=false;form.querySelector("button").disabled=true;return}
	form.addEventListener("submit",function(e){
		e.preventDefault();err.hidden=true;
		var button=form.querySelector("button");button.disabled=true;
		var name=form.elements.name.value;
		xitterPasskey.post("/account/passkeys/options",{password:form.elements.password.value}).then(function(o){
			o.challenge=xitterPasskey.dec(o.challenge);
			o.user.id=xitterPasskey.dec(o.user.id);
			o.excludeCredentials=o.excludeCredentials.map(function(c){return {type:c.type,id:xitterPasskey.dec(c.id)}});
			return navigator.credentials.create({publicKey:o});
		}).then(function(c){
			// some browsers resolve with nothing instead of rejecting when the prompt is closed
			if(!c)throw new DOMException("closed","NotAllowedError");
			var r=c.response;
			return xitterPasskey.post("/account/passkeys/add",{id:c.id,name:name,clientDataJSON:xitterPasskey.enc(r.clientDataJSON),attestationObject:xitterPasskey.enc(r.attestationObject),transports:r.getTransports?r.getTransports():[]});
		}).then(function(){location.reload()},function(e){
			button.disabled=false;
			err.textContent=e&&e.name==="InvalidStateError"?"This device already has a passkey for your account.":e&&e.name==="NotAllowedError"?"The passkey wasn't made. Try again.":(e&&e.message)||"Something went wrong.";
			err.hidden=false;
		});
	});
})();`;

const when = (d: Date | null) => (d ? d.toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }) : "never");

export async function passkeysRoute(req: Request, url: URL, viewer: Viewer): Promise<Response> {
	const sub = url.pathname.slice("/account/passkeys".length);
	if (req.method === "POST" && (sub === "/options" || sub === "/add") && !sameOrigin(req)) return fail("Wrong origin.", 403);

	// adding one asks for the password again: a session left signed in on a
	// shared computer shouldn't be enough to add a way in
	if (req.method === "POST" && sub === "/options") {
		const b = await body(req);
		const password = typeof b.password === "string" ? b.password : "";
		const account = viewer.screen_name.toLowerCase();
		const refund = passwordTry(account);
		if (!refund) return fail("Too many tries for this account. Wait 15 minutes.", 429);
		const [u] = await sql`select password_hash from users where id = ${viewer.id}::bigint`;
		if (password.length > 1024 || !(await Bun.password.verify(password, u?.password_hash ?? "").catch(() => false))) return fail("That password isn't right.");
		refund();
		const keys = await sql`select id, transports from passkeys where user_id = ${viewer.id}::bigint`;
		if (keys.length >= MAX_PASSKEYS) return fail(`You can have up to ${MAX_PASSKEYS} passkeys. Remove one first.`);
		return Response.json(
			{
				challenge: await newChallenge(viewer.id),
				rp: { id: PUBLIC_HOSTNAME, name: settings().instance_name },
				// the account id as the passkey's user handle, so signing in finds it
				user: { id: b64url(new TextEncoder().encode(viewer.id)), name: viewer.screen_name, displayName: viewer.name || viewer.screen_name },
				pubKeyCredParams: ALGORITHMS.map((alg) => ({ type: "public-key", alg })),
				excludeCredentials: keys.map((k: { id: string }) => ({ type: "public-key", id: k.id })),
				authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
				attestation: "none",
				timeout: TIMEOUT,
			},
			{ headers: { "cache-control": "no-store" } },
		);
	}
	if (req.method === "POST" && sub === "/add") {
		const b = await body(req);
		const id = typeof b.id === "string" && b.id.length <= 1400 && /^[\w-]+$/.test(b.id) ? b.id : "";
		const clientDataJSON = bytes(b.clientDataJSON);
		const attestationObject = bytes(b.attestationObject);
		if (!id || !clientDataJSON || !attestationObject) return fail("That passkey answer was incomplete. Try again.");
		const challenge = challengeOf(clientDataJSON);
		if (!(await spend(challenge, viewer.id))) return fail("That took too long. Start again.");
		let made: ReturnType<typeof verifyRegistration>;
		try {
			made = verifyRegistration({ id, clientDataJSON, attestationObject }, expected(challenge!));
		} catch (e: any) {
			return fail(/^[A-Z]/.test(e?.message ?? "") ? e.message : "That passkey couldn't be checked. Try again.");
		}
		const transports = Array.isArray(b.transports) ? b.transports.filter((t): t is string => typeof t === "string" && /^[a-z-]{1,20}$/.test(t)).slice(0, 8) : [];
		const name = (typeof b.name === "string" ? b.name.trim().slice(0, 50) : "") || deviceName(req);
		const added = await sql.begin(async (tx) => {
			await tx`select id from users where id = ${viewer.id}::bigint for update`;
			// a password change or reset in the meantime signed this session out
			if (!(await tx`select 1 from sessions where token = ${viewer.token}`).length) return false;
			const [{ n }] = await tx`select count(*)::int as n from passkeys where user_id = ${viewer.id}::bigint`;
			if (n >= MAX_PASSKEYS) return false;
			const rows = await tx`insert into passkeys (id, user_id, public_key, alg, sign_count, name, transports, backed_up)
				values (${made.id}, ${viewer.id}::bigint, ${b64url(made.publicKey)}, ${made.alg}, ${made.signCount}, ${name}, ${sql.array(transports)}::text[], ${made.backedUp})
				on conflict (id) do nothing returning id`;
			return rows.length > 0;
		});
		if (!added) return fail("That passkey couldn't be added.");
		return Response.json({ ok: true });
	}
	if (req.method === "POST" && sub === "/remove") {
		const form = await req.formData().catch(() => undefined);
		if (String(form?.get("csrf") ?? "") !== viewer.csrf) return new Response("That form is out of date. Go back and try again.", { status: 403 });
		await sql`delete from passkeys where id = ${String(form?.get("id") ?? "")} and user_id = ${viewer.id}::bigint`;
		return new Response(null, { status: 303, headers: { location: "/account/passkeys" } });
	}

	const keys = await sql`select id, name, created_at, last_used_at, backed_up from passkeys where user_id = ${viewer.id}::bigint order by created_at`;
	const list = keys.length
		? keys
				.map(
					(k: any) => `<div class="card split"><div><p><strong>${esc(k.name)}</strong></p>
<p class="meta">Added ${when(k.created_at)} · last used ${when(k.last_used_at)}${k.backed_up ? " · synced" : ""}</p></div>
<form method="post" action="/account/passkeys/remove" class="inline" onsubmit="return confirm('Remove this passkey? You won\\'t be able to sign in with it any more.')"><input type="hidden" name="csrf" value="${esc(viewer.csrf)}"><input type="hidden" name="id" value="${esc(k.id)}"><button class="secondary small" type="submit">Remove</button></form></div>`,
				)
				.join("\n")
		: `<p class="dim">You haven't added any passkeys yet.</p>`;
	return accountPage({
		req,
		viewer,
		title: "Passkeys",
		body: `<h1>Passkeys</h1>
<p>A passkey signs you in with your fingerprint, face or screen lock instead of your password and two-factor code. It's kept by your device or password manager and only works on ${esc(PUBLIC_HOSTNAME)}, so it can't be phished.</p>
<p class="dim">Changing or resetting your password removes all your passkeys, so nobody else who added one keeps a way in.</p>
${list}
<h2>Add a passkey</h2>
<form id="add"><label for="pk-name">Name (optional)</label><input id="pk-name" name="name" maxlength="50" placeholder="${esc(deviceName(req))}" autocomplete="off">
<label for="pk-password">Your password</label><input id="pk-password" type="password" name="password" autocomplete="current-password" required>
<p class="error" id="add-error" hidden></p><button type="submit">Add a passkey</button></form>
<script>${MANAGE_SCRIPT}</script>`,
	});
}
