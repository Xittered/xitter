import { type Viewer, getViewer, parseCookies, csrfCookie } from "./auth";
import { getClientFile, getClientFilePath } from "./client-cache";
import { PORT, PUBLIC_ORIGIN } from "./config";
import { migrate, sql } from "./db";
import { knownOperation, runOperation } from "./graphql";
import { brandingFile } from "./branding";
import { handleLogin, maintenancePage, rulesPage } from "./login";
import { adminApi, audit } from "./admin";
import { loadSettings, settings } from "./settings";
import { flagPickerData } from "./flag-picker";
import { flagSvg } from "./flags";
import { onboarding } from "./onboarding";
import { cachedPatch, patchFile, patchText } from "./patch";
import { clientError, recordError } from "./errors";
import { asRequest, markStaff, setRequestLanguage, staffGate } from "./staff-access";
import { backupPath, startBackups } from "./backups";
import { memberInvitesRoute } from "./member-invites";
import { orgRoute } from "./org-manage";
import { loadMenuFacts } from "./tidy";
import { clientPayload, type MenuFacts } from "./xitter-menu";
import { viewerLook, xitterHome } from "./account-page";
import { FRAME_LOOK_REPORT } from "./settings-shell";
import { isPlayerPage, playerPage } from "./player-card";
import { chatMediaRoute, chatSocket, juiceboxProxy, socketUser } from "./chat";
import { loadBuild } from "./build";
import { MEDIA_DIR, mediaUpload, serveMedia } from "./media";
import { resumeVideos } from "./video";
import { livePipeline, restRoute } from "./rest";
import { bootScript, shell } from "./shell";
import { platformSource } from "./platforms";
import { badgeImage, expireSanctions } from "./moderation";
import { appealRoute, noticesApi, noticesPage } from "./staff-notices";
import { forgotRoute, resetRoute } from "./password-reset";
import { twoFactorRoute } from "./two-factor";
import { passkeySignInRoute, passkeysRoute } from "./passkeys";
import { extraBadges, instanceCard } from "./badges";
import { decorationFile, decorationsFor } from "./decorations";
import { pronounsFor } from "./pronouns";
import { decorationRoute } from "./decoration-settings";
import { startScheduler } from "./scheduled";
import { federationRoute, startFederation } from "./federation-routes";
import { acceptTicket, superadminHomeRoute } from "./superadmin";
import { gifProxy } from "./gifs";
import { cardImage } from "./explore-cards";
import { rememberIp, requestIp } from "./login-history";
import { bucketsFor, hit, isMutation, limitApi, limitedResponse } from "./ratelimit";
import { actingViewer, delegateMay } from "./delegation";
import { automationRoute } from "./automation";
import { instancesRoute } from "./federation-settings";
import { importRoute, resumeImports } from "./archive-import";
import { stickerImage, stickerPacks } from "./stickers";
import { apiTokensRoute, publicApi } from "./public-api";
import { connectedAppsRoute, developerAppsRoute, oauthAppIcon, oauthAuthorize, oauthToken } from "./oauth";
import { authorizationServerMetadata } from "./oauth-metadata";
import { apiDocsPage } from "./api-docs";
import { hashflagAsset } from "./hashflags";
import { startMailDigests } from "./mail-digest";
import { SERVICE_WORKER, startPush } from "./push";
import { manifest } from "./pwa";
import { emailRoute } from "./email-address";
import { embedImage, linkPreview, oembed } from "./embeds";
import { noteAppealsRoute } from "./note-appeals";
import { decorCatalog, decorFor, decorRoute, decorShop, steamFile } from "./decor";
import { nightModeCookies, themeApi, themeExport, themeImport } from "./themes/api";
import { accountVars, resolveBackground } from "./themes/css";
import { themeRoute } from "./themes/page";
import { paletteOf, readPrefs, type Look } from "./themes/validate";
import { serveFont } from "./fonts";
import { migrationApi } from "./migration";
import { failInterrupted } from "./migration-import";
import { migrateRoute } from "./migration-page";
import { acceptedEncoding, compressResponse, compressedFile } from "./compress";
import { forgetRanking } from "./ranking";
import { blocksClientShell, clientRouteFor, FRAMED_HEADERS, opensInTab, trailingSlashTarget, xitterNotFoundPage } from "./owned-paths";

const MIME: Record<string, string> = {
	js: "text/javascript; charset=utf-8",
	css: "text/css; charset=utf-8",
	json: "application/json",
	svg: "image/svg+xml",
	png: "image/png",
	jpg: "image/jpeg",
	ico: "image/x-icon",
	woff: "font/woff",
	woff2: "font/woff2",
};

// On its own domain the client prefixes API paths with /i/api; in its localhost
// dev mode it calls the bare paths.
// The client also calls outside services on its own (grok.com checkout, ads
// measurement). Requests from the page may only reach this instance.
const PAGE_CSP = "connect-src 'self' blob: data:; font-src 'self'";

// the instance's own files (logo, icons), open to everyone since the sign-in page uses them
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? "public";
async function servePublic(p: string): Promise<Response> {
	const name = p.slice("/public/".length);
	const badge = /^badge-(\d{1,19})\.png$/.exec(name);
	if (badge) return badgeImage(badge[1]);
	const sticker = /^sticker-(\d{1,19})\.(png|gif|webp)$/.exec(name);
	if (sticker) return stickerImage(sticker[1]);
	const hashflag = /^hashflag-(\d{1,19})\.(json|png|gif|webp)$/.exec(name);
	if (hashflag) return hashflagAsset(hashflag[1], hashflag[2]);
	const card = /^card-(\d{1,19})\.img$/.exec(name);
	if (card) return cardImage(card[1]);
	const flag = /^flag-([a-z]+)\.svg$/.exec(name);
	if (flag) {
		const svg = flagSvg(flag[1]);
		return svg ? new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } }) : new Response("not found", { status: 404 });
	}
	if (!/^[\w.-]+\.(png|svg|ico|webp)$/.test(name)) return new Response("not found", { status: 404 });
	// a logo uploaded in the admin panel replaces the shipped one
	const uploaded = brandingFile(name);
	if (uploaded && (await uploaded.file.exists())) return new Response(uploaded.file, { headers: { "content-type": uploaded.type, "cache-control": "no-cache" } });
	const file = Bun.file(`${PUBLIC_DIR}/${name}`);
	if (!(await file.exists())) return new Response("not found", { status: 404 });
	return new Response(file, { headers: { "cache-control": "no-cache" } });
}

const API_PREFIX = /^\/(i\/api\/|i\/jfapi\/|i\/media\/|1\.1\/|2\/|v2\/|graphql\/|fleets\/|live_pipeline\/)/;
// calls no handler exists for yet, most frequent first
const unknown = new Map<string, number>();
const MAX_UNKNOWN_PATHS = 1000;

const apiError = (status: number, code: number, message: string) => Response.json({ errors: [{ code, message }] }, { status });

// a hash of each patched file, for its tags
const etags = new WeakMap<Buffer, string>();

// The panel names the instance in its markup and in its scripts' single-quoted
// strings; as entities the name is safe in both.
const ADMIN_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "\\": "&#92;" };
// framed beside the client, the panel takes the viewer's theme the way the
// Xitter settings pages do (light, dim or dark)
const adminTokens = (look: Look | null, theme: string): string => {
	if (look?.kind !== "painted") return "";
	const css = `${accountVars(look.theme)};--panel:var(--surface);--line:var(--border);--dim:var(--muted);--blue:var(--accent);--bar-thin:var(--bar);--on:var(--hover)`;
	return `<style>:root[data-theme="${theme}"]{${css}}</style>`;
};

const adminPage = async (req: Request, viewer: Viewer) => {
	const name = settings().instance_name.replace(/[&<>"'\\]/g, (c) => ADMIN_ENTITIES[c]);
	const got = await viewerLook(viewer);
	const theme = paletteOf(got.look, parseCookies(req).night_mode) ?? "dark";
	const page = (await Bun.file(new URL("./admin.html", import.meta.url)).text()).replaceAll("{{instance}}", () => name);
	return page
		.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`)
		.replace("/public/icon-dark.png", theme === "light" ? "/public/icon-light.png" : "/public/icon-dark.png")
		.replace("</head>", `${adminTokens(got.look, theme)}<meta name="xitter-look" content="${got.lookKey}">\n</head>`)
		.replace("</body>", `${FRAME_LOOK_REPORT}\n</body>`);
};

function staffBlockedPage(reason: string) {
	const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
	const text = esc(reason).replace("/account/2fa", '<a href="/account/2fa">/account/2fa</a>');
	return new Response(
		`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin · ${esc(settings().instance_name)}</title>
<body style="margin:0;background:#000;color:#e7e9ea;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh"><main style="width:min(460px,92vw)"><h1 style="font-size:24px">Admin panel</h1><p>${text}</p><p><a style="color:#1d9bf0" href="/home">Back</a></p></main></body>`,
		{ status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
	);
}

async function serveClient(req: Request, pathname: string): Promise<Response> {
	const cdnPath = pathname.slice("/abs".length);
	const ext = cdnPath.split(".").pop() ?? "";
	const type = MIME[ext] ?? "application/octet-stream";
	if (ext !== "js" && ext !== "css") {
		const file = await getClientFilePath(cdnPath);
		if (!file) return new Response("not found", { status: 404 });
		return new Response(Bun.file(file), { headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" } });
	}

	// The file name stays the same when our patches change, so patched files are
	// revalidated against a hash of what we actually serve.
	let body = cachedPatch(cdnPath);
	if (!body) {
		const raw = await getClientFile(cdnPath);
		if (!raw) return new Response("not found", { status: 404 });
		body = patchFile(cdnPath, raw);
	}
	let hash = etags.get(body);
	if (!hash) {
		hash = Bun.hash(body).toString(36);
		etags.set(body, hash);
	}
	// each encoding is its own representation, with its own tag
	const encoding = acceptedEncoding(req);
	const etag = `"${hash}${encoding ? `-${encoding}` : ""}"`;
	const headers: Record<string, string> = { "content-type": type, "cache-control": "no-cache", etag, vary: "accept-encoding" };
	if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
	if (!encoding) return new Response(new Uint8Array(body), { headers });
	return new Response(await compressedFile(body, encoding), { headers: { ...headers, "content-encoding": encoding } });
}

const MAX_API_BODY = 2 * 1024 * 1024;

function shapeFits(value: unknown): boolean {
	let nodes = 0;
	const walk = (v: unknown, depth: number): boolean => {
		if (++nodes > 20_000 || depth > 32) return false;
		if (typeof v === "string") return v.length <= 1_000_000;
		if (Array.isArray(v)) return v.length <= 5_000 && v.every((x) => walk(x, depth + 1));
		if (v && typeof v === "object") return Object.entries(v).every(([k, x]) => k.length <= 200 && walk(x, depth + 1));
		return true;
	};
	return walk(value, 0);
}

function parseJson(text: string | null): any {
	if (!text) return {};
	try {
		return JSON.parse(text) ?? {};
	} catch {
		return {};
	}
}

async function serveApi(req: Request, url: URL, viewer: Viewer | undefined): Promise<Response> {
	// the signed-out home page asks for a guest token first; it gets one, but
	// nothing is readable without signing in. Signed in, a guest token would make
	// the client act as a guest and stop sending its csrf header.
	if (!viewer && url.pathname.endsWith("/1.1/guest/activate.json")) return Response.json({ guest_token: "1" });
	if (!viewer) return apiError(401, 32, "Could not authenticate you.");
	const source = await platformSource(req);
	if (source === null) return apiError(401, 32, "Invalid or revoked client token.");
	viewer = { ...viewer, postSource: source };
	const path = url.pathname.replace(/^\/i\/(jf)?api/, "");
	const parts = path.split("/").filter(Boolean);
	const gql = parts.indexOf("graphql");
	const operation = gql >= 0 ? parts[parts.length - 1] : undefined;
	if (req.method === "POST" && path === "/1.1/graphql/app_context.json") return new Response(null, { status: 204 });
	if ((req.method !== "GET" || operation) && req.headers.get("x-csrf-token") !== viewer.csrf)
		return apiError(403, 353, "This request requires a matching csrf cookie and header.");
	if (req.method === "GET" && operation && isMutation(operation)) return apiError(405, 144, "Use POST for this operation.");
	// a delegate switched into another account (delegation.ts); the client sends
	// this on every call while switched
	const actAs = req.headers.get("x-act-as-user-id");
	if (actAs && actAs !== viewer.id) {
		const acting = await actingViewer(viewer, actAs);
		if (!acting) return apiError(403, 200, "You can't act as this account.");
		if (!delegateMay(acting.actor!.role, req.method, path, operation)) return apiError(403, 200, "Delegates can't do this for the account.");
		viewer = acting;
	}
	// a follow, block, mute or like changes what "For you" would rank
	if (req.method !== "GET") forgetRanking(viewer.id);
	const limited = limitApi(viewer, req.method, path, operation, url);
	if (limited) return limited;
	if (path === "/xitter/moderation") return noticesApi(req, viewer);
	if (path === "/xitter/badges") return extraBadges(viewer.id, url);
	if (path === "/xitter/decorations") return decorationsFor(url);
	if (path === "/xitter/pronouns") return pronounsFor(url);
	if (path === "/xitter/instance") return instanceCard(viewer.id, url);
	if (path === "/xitter/decor") return decorFor(url);
	if (path === "/xitter/decor/shop") return decorShop(url);
	if (path === "/xitter/decor/catalog") return decorCatalog();
	if (path === "/xitter/theme/import") return themeImport(req, viewer);
	if (path === "/xitter/theme/export") return themeExport(req, viewer);
	if (path === "/xitter/theme") return themeApi(req, viewer);
	if (path === "/xitter/gif") return gifProxy(url);
	if (path === "/xitter/stickers") return Response.json(await stickerPacks());
	if (path === "/xitter/client_error" && req.method === "POST") return clientError(req, viewer);
	if (viewer.status === "restricted" && bucketsFor(req.method, path, operation, url).some((b) => b === "post" || b === "dm"))
		return apiError(403, 326, "Your account can't post or send messages right now.");
	if (req.method !== "GET" && !/^\/(i|1\.1)\/media\/upload2?\.json$/.test(path) && Number(req.headers.get("content-length") ?? 0) > MAX_API_BODY)
		return apiError(413, 324, "That request is too large.");
	if (process.env.LOG_REQUESTS) console.log(`api ${req.method} ${gql >= 0 ? `graphql:${parts[parts.length - 1]}` : path}`);
	// the client reports its own render errors through telemetry
	// (not uploads: a binary body isn't URI-encoded text)
	if (process.env.LOG_REQUESTS === "errors" && req.method === "POST" && !path.includes("/media/upload")) {
		const raw = await req.clone().text();
		let body = raw;
		try {
			body = decodeURIComponent(raw.replace(/\+/g, " "));
		} catch {}
		for (const m of body.matchAll(/.{0,160}(?:[Ee]rror|exception|stack).{0,400}/g)) console.log(`client-report ${path}: ${m[0]}`);
	}
	if (/^\/(i|1\.1)\/media\/upload2?\.json$/.test(path)) return mediaUpload(req, url, viewer);
	if (gql >= 0) {
		const name = parts[parts.length - 1];
		if (knownOperation(name)) {
			if (/^Birdwatch(Create|Delete)/.test(name) && req.method !== "POST") return apiError(405, 144, "Use POST for note changes.");
			let vars = req.method === "GET" ? parseJson(url.searchParams.get("variables")) : parseJson(await req.text()).variables;
			// the chat app sends its variables as a JSON string
			if (typeof vars === "string") vars = parseJson(vars);
			if (!shapeFits(vars)) return apiError(413, 324, "That request is too large.");
			return runOperation(name, viewer, vars ?? {});
		}
	} else if (path === "/live_pipeline/events") {
		return livePipeline();
	}
	const rest = await restRoute(req.method, path, viewer, req);
	if (rest) return rest;

	const key = `${req.method} ${gql >= 0 ? `graphql:${parts[parts.length - 1]}` : path}`;
	if (unknown.has(key)) unknown.set(key, unknown.get(key)! + 1);
	else if (unknown.size < MAX_UNKNOWN_PATHS) unknown.set(key, 1);
	else unknown.set("(other paths)", (unknown.get("(other paths)") ?? 0) + 1);
	console.log(`unhandled ${key}`);
	return Response.json(gql >= 0 ? { data: {} } : {});
}

await migrate();
await expireSanctions();
// temporary sanctions end on their own
setInterval(
	() =>
		expireSanctions().catch((e) => {
			console.error("sanction expiry failed", e.message);
			recordError("job", e, { path: "sanction expiry" });
		}),
	30_000,
).unref();
await loadSettings();
await resumeVideos(MEDIA_DIR);
await resumeImports();
await failInterrupted();

// a request that throws is answered by Bun's error() below, which doesn't know
// the request; caught here it is logged with its path and account
async function handle(req: Request): Promise<Response | undefined> {
	try {
		const res = await asRequest(() => route(req));
		return res && (await compressResponse(req, res, new URL(req.url).pathname));
	} catch (e) {
		const viewer = await getViewer(req).catch(() => undefined);
		await recordError("server", e, { path: `${req.method} ${new URL(req.url).pathname}`, userId: viewer?.id });
		throw e;
	}
}

async function route(req: Request): Promise<Response | undefined> {
	rememberIp(req, server.requestIP(req)?.address);
	const url = new URL(req.url);
	const p = url.pathname;
	if (req.method === "GET" || req.method === "HEAD") {
		const slash = trailingSlashTarget(p);
		if (slash) return Response.redirect(slash + url.search, 302);
	}
	// for Docker's health check (Dockerfile): the server answers and reaches its database
	if (p === "/healthz") {
		const db = await Promise.race([sql`select 1`.then(() => true, () => false), Bun.sleep(3000).then(() => false)]);
		return new Response(db ? "ok" : "database unreachable", { status: db ? 200 : 503, headers: { "cache-control": "no-store" } });
	}
	if (p === "/federation/superadmin/accept") return acceptTicket(req, requestIp(req) ?? "unknown");
	// /i/xitter/* holds Xitter's own static files, served before sign-in and
	// rate limits: avatar decoration images, the locally cached Google Fonts and
	// the page's own scripts (shell.ts bootScript).
	// Everything else under this prefix 404s on purpose. Without that line an
	// unknown or missing file here (a font that failed to download, a stale
	// decoration link) would fall through to the client shell and come back as
	// a 200 HTML page, which the browser then tries to use as a font or image.
	// A new route under /i/xitter/ must go ABOVE the catch-all, or it is never
	// reached. JSON endpoints belong under /i/api/xitter/ instead (serveApi).
	if (p.startsWith("/i/xitter/decoration/")) return (await decorationFile(url)) ?? new Response("not found", { status: 404 });
	if (p.startsWith("/i/xitter/fonts/")) return serveFont(url, url.searchParams.has("family") && !!(await getViewer(req)));
	if (p.startsWith("/i/xitter/boot-")) {
		const body = bootScript(p);
		if (!body) return new Response("not found", { status: 404 });
		const headers = { "content-type": MIME.js, "cache-control": "public, max-age=31536000, immutable", vary: "accept-encoding" };
		const encoding = acceptedEncoding(req);
		return encoding ? new Response(await compressedFile(body, encoding), { headers: { ...headers, "content-encoding": encoding } }) : new Response(new Uint8Array(body), { headers });
	}
	if (p.startsWith("/i/xitter/")) return new Response("not found", { status: 404 });
	if (req.method !== "GET" && req.method !== "HEAD" && req.headers.has("cookie")) {
		const site = req.headers.get("sec-fetch-site");
		const origin = req.headers.get("origin");
		if (site ? site !== "same-origin" && site !== "none" : origin && origin !== PUBLIC_ORIGIN && origin !== url.origin)
			return new Response("This request came from another site.", { status: 403 });
	}
	if (p.startsWith("/abs/")) return serveClient(req, p);
	if (p === "/.well-known/xitter" || p.startsWith("/federation/v1/")) {
		const answer = await federationRoute(req, url);
		if (answer) return answer;
	}
	// chat: the live socket (its token from GenerateXChatTokenMutation) and
	// the way to the key backup realm
	if (p === "/xchat/ws") {
		const userId = socketUser(url.searchParams.get("token") ?? "");
		if (!userId) return new Response("bad token", { status: 401 });
		const [account] = await sql`select 1 from users where id = ${userId}::bigint and status <> 'suspended'`;
		if (!account) return new Response("suspended", { status: 403 });
		return server.upgrade(req, { data: { userId } }) ? undefined : new Response("expected a websocket", { status: 400 });
	}
	if (p.startsWith("/juicebox/")) return juiceboxProxy(req, p.slice("/juicebox/".length));
	// Chat's manifest: the pinned chat build's own, its addresses ours
	if (p === "/xchat/embed-v1.json") {
		const base = loadBuild()?.build.meta.xchatEmbedBuild as string | undefined;
		const raw = base && (await getClientFile(`${new URL(base).pathname}mf-manifest.json`));
		if (!raw) return new Response("no pinned chat build", { status: 404 });
		return new Response(patchText(raw.toString("utf8")), { headers: { "content-type": "application/json", "cache-control": "no-cache" } });
	}
	// account migration: another instance reads an account here with the code
	// the account made (migration.ts); never cookies
	if (p.startsWith("/migration/v1/")) return migrationApi(req, url);
	// the public API signs in with its own tokens, never cookies
	if (p.startsWith("/api/v1/") || p === "/api/v1") return publicApi(req, url);
	if (p === "/oauth/token") return oauthToken(req);
	const appIcon = /^\/oauth\/apps\/(\d{1,19})\/icon$/.exec(p);
	if (appIcon && req.method === "GET") return oauthAppIcon(appIcon[1]!);
	if (p === "/.well-known/oauth-authorization-server") return authorizationServerMetadata();
	if (p === "/api" || p === "/api/") return apiDocsPage(req);
	if (req.method === "OPTIONS") return new Response(null, { status: 204 });
	if (p === "/login" && req.method === "POST") {
		const h = hit("auth", requestIp(req) ?? "unknown");
		if (!h.ok) return limitedResponse(h);
		return handleLogin(req);
	}
	if (p === "/rules" || p === "/tos" || p === "/privacy") return rulesPage();
	// X's sign-in screens (jf.x.com), answered here
	// inside the signed-in client the same screens come through /i/jfapi
	if (p.startsWith("/onboarding/web") || p.startsWith("/i/jfapi/onboarding/web")) {
		// only the steps that try something count as tries; the screens also post
		// on every keystroke (is this name free?), which would use them up while
		// one person types
		if (req.method === "POST") {
			const ip = requestIp(req) ?? "unknown";
			const step = p.replace(/^\/i\/jfapi/, "");
			const h = step.startsWith("/onboarding/web/actions/") ? hit("auth", ip) : hit("endpoint", `${ip}:${step.replace(/\d+/g, "#")}`);
			if (!h.ok) return limitedResponse(h);
		}
		const screen = await onboarding(req, p.replace(/^\/i\/jfapi/, ""));
		if (screen) return screen;
	}
	// people sign in and up on the signed-out home page; an invite link's code
	// is kept for the dialog, which then skips asking for it
	// X's own add-email flow: ours is a page
	if (p === "/i/flow/add_email") return Response.redirect("/settings/xitter/email", 302);
	// and X's automated-account flow (automation.ts)
	if (p === "/i/flow/enable_automated_account") return Response.redirect("/settings/xitter/automation", 302);
	// and X's passkey settings and flows: ours is a page (passkeys.ts)
	if (/^\/(settings|i\/flow)\/.*passkey/i.test(p) && !p.startsWith("/settings/xitter/")) return Response.redirect("/settings/xitter/passkeys", 302);
	// the built-in "All" list (lists.ts)
	if (p === "/all") return Response.redirect("/i/lists/1", 302);
	if (p === "/login" || p === "/signup" || p.startsWith("/i/flow/")) {
		const headers = new Headers({ location: "/" });
		const code = url.searchParams.get("code");
		if (code) headers.append("set-cookie", `xitter_invite=${encodeURIComponent(code)}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly`);
		return new Response(null, { status: 302, headers });
	}
	if (p.startsWith("/public/") && !p.startsWith("/public/steam/")) return servePublic(p);
	if (p === "/favicon.ico") return servePublic("/public/favicon.png");
	if (p === "/sw.js") return new Response(SERVICE_WORKER, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" } });
	if (p === "/manifest.json") return manifest();

	const viewer = await getViewer(req);
	setRequestLanguage(viewer?.language ?? undefined);
	const steam = /^\/public\/steam\/(\d+)\/([^/]+)$/.exec(p);
	if (steam) return steamFile(req, steam[1]!, steam[2]!, url.searchParams.has("thumb"), !!viewer);
	if (viewer?.role && !(await staffGate(req, viewer))) markStaff();
	// a suspended account can't sign in, so it appeals here with its password
	if (p === "/appeal") return appealRoute(req, server.requestIP(req)?.address ?? "");
	// maintenance: staff carry on, everyone else signed in waits
	if (viewer && !viewer.role && settings().operations.maintenance) {
		if (API_PREFIX.test(p) || req.method !== "GET") return apiError(503, 130, settings().operations.message);
		return maintenancePage();
	}
	if (p === "/oauth/authorize") return oauthAuthorize(req, url, viewer);
	// a tab opening a Xitter settings page goes to its place in the client's
	// Settings, which frames the page (tidy.ts)
	if (viewer && req.method === "GET" && opensInTab(req)) {
		const to = clientRouteFor(p);
		if (to) return Response.redirect(to + url.search, 302);
	}
	if (p === "/account/xitter" && viewer) return xitterHome(req, viewer);
	if (p === "/account/apps" && viewer) return connectedAppsRoute(req, viewer);
	if (p === "/account/apps/developer" && viewer) return developerAppsRoute(req, viewer);
	if (p === "/federation/superadmin" || p.startsWith("/federation/superadmin/")) return superadminHomeRoute(req, url, viewer);
	if (p === "/account/reset") return resetRoute(req, url);
	if (p === "/account/forgot") {
		if (req.method === "POST") {
			const h = hit("mail", requestIp(req) ?? "unknown");
			if (!h.ok) return limitedResponse(h);
		}
		return forgotRoute(req, url);
	}
	if (p === "/account/email" || p === "/account/email/confirm") return emailRoute(req, url, viewer);
	if (p.startsWith("/account/2fa") && viewer) return twoFactorRoute(req, url, viewer);
	if ((p === "/account/passkeys" || p.startsWith("/account/passkeys/")) && viewer && !viewer.instance) return passkeysRoute(req, url, viewer);
	if (p === "/account/passkey" || p.startsWith("/account/passkey/")) {
		const done = await passkeySignInRoute(req, p);
		if (done) return done;
	}
	if (p === "/account/notices" && viewer) return noticesPage(req, viewer);
	if (p === "/account/invites" && viewer) return memberInvitesRoute(req, viewer);
	if (p === "/account/api" && viewer) return apiTokensRoute(req, viewer);
	if (p === "/account/notes/appeals" && viewer) return noteAppealsRoute(req, viewer);
	if (p === "/account/automation" && viewer) return automationRoute(req, viewer);
	if (p === "/account/instances" && viewer) return instancesRoute(req, viewer);
	if ((p === "/account/import" || p === "/account/import/upload") && viewer) return importRoute(req, url, viewer);
	if (p === "/account/decoration" && viewer) return decorationRoute(req, viewer);
	if (p === "/account/organisation" && viewer) return orgRoute(req, viewer);
	if (p === "/account/decor" && viewer) return decorRoute(req, viewer);
	if (p === "/account/theme" && viewer) return themeRoute(req, viewer);
	if (p === "/account/migrate" && viewer) return migrateRoute(req, viewer);
	if (p.startsWith("/i/ton/data/xchat_media/")) return chatMediaRoute(req, viewer, url);
	// pictures and oEmbed for previews of public posts in other apps (embeds.ts)
	if (p.startsWith("/embed/")) return embedImage(p);
	if (p === "/oembed") return oembed(url);
	// the frame X's client opens for a player card (YouTube links)
	if (isPlayerPage(p)) return viewer ? playerPage(p, viewer.id) : new Response("not found", { status: 404 });
	// uploads stay inside the instance: only signed-in users get them
	if (p.startsWith("/media/")) return viewer ? serveMedia(req, p, viewer) : new Response("not found", { status: 404 });
	// the admin panel: staff only. anyone else signed in gets our 404, not the client shell
	if (p.startsWith("/admin/api/")) return adminApi(req, p.slice("/admin/api/".length), viewer);
	if (p === "/admin/flags.json" && viewer?.role) return Response.json(flagPickerData(null).flags);
	// a backup, for an admin's browser to save
	if (p.startsWith("/admin/backups/") && viewer?.role === "admin" && !(await staffGate(req, viewer))) {
		const name = p.slice("/admin/backups/".length);
		const file = backupPath(name);
		if (!file || !(await Bun.file(file).exists())) return new Response("not found", { status: 404 });
		await audit(viewer, "download_backup", null, { name });
		return new Response(Bun.file(file), { headers: { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" } });
	}
	// the panel: a tab gets the client, which draws its own nav and frames the
	// panel beside it (tidy.ts); the frame, or a script, gets the panel itself
	let hostAdmin = false;
	if ((p === "/admin" || p === "/admin/") && viewer?.role) {
		const blocked = await staffGate(req, viewer);
		if (blocked) return staffBlockedPage(blocked);
		if (!opensInTab(req)) return new Response(await adminPage(req, viewer), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...FRAMED_HEADERS } });
		hostAdmin = true;
	}
	if (p === "/_debug/unknown" && viewer?.role === "admin") return Response.json(Object.fromEntries([...unknown].sort((a, b) => b[1] - a[1])));
	if (API_PREFIX.test(p) || req.method !== "GET") {
		// the event stream must outlive the default idle timeout
		if (p.endsWith("/live_pipeline/events")) server.timeout(req, 0);
		return serveApi(req, url, viewer);
	}

	// signed out: a public post or profile gives other apps' link fetchers its preview
	if (!viewer && req.method === "GET") {
		const preview = await linkPreview(p);
		if (preview) return preview;
	}
	// signed out: X's own home page with its sign-in form, and the dialog
	if (!viewer && p !== "/" && !p.startsWith("/i/jf/onboarding")) return Response.redirect("/", 302);
	// maintenance: guests see the notice; ?staff=1 is the sign-in page, for staff
	if (!viewer && p === "/" && settings().operations.maintenance && !url.searchParams.has("staff")) return maintenancePage(true);
	if (viewer && blocksClientShell(p) && !hostAdmin) return xitterNotFoundPage();
	const [communityRows, flagRows, facts] = viewer
		? await Promise.all([
			sql`select 1 from community_members where user_id = ${viewer.id}::bigint limit 1`,
			sql`select education_flags, preferences from users where id = ${viewer.id}::bigint`,
			loadMenuFacts(req, viewer),
		])
		: [[], [], null];
	const menu = facts ? clientPayload(facts as MenuFacts) : { links: [], staff: undefined };
	const prefs = readPrefs(flagRows[0]?.preferences);
	const look = prefs.look;
	const painted = look?.kind === "painted" ? look.theme : null;
	const paint = viewer && painted ? await resolveBackground(viewer.id, painted) : undefined;
	const page = shell(viewer ?? null, !!parseCookies(req).auth_multi, communityRows.length > 0, flagRows[0]?.education_flags ?? {}, menu.links, look, prefs.accent, paint, viewer?.csrf, menu.staff);
	const headers = new Headers({ "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": PAGE_CSP });
	// a guest token left from the signed-out page makes the signed-in client act
	// as a guest (no csrf header, every write refused)
	if (viewer && /(?:^|;\s*)gt=/.test(req.headers.get("cookie") ?? "")) headers.append("set-cookie", "gt=; Path=/; Max-Age=0");
	if (viewer && parseCookies(req).ct0 !== viewer.csrf) headers.append("set-cookie", csrfCookie(viewer.csrf));
	for (const c of nightModeCookies(look)) headers.append("set-cookie", c);
	if (!page) return new Response("no pinned client build: run scripts/fetch-client.ts --token or --har", { status: 500, headers });
	return new Response(page, { headers });
}

const server = Bun.serve({
	port: PORT,
	fetch: handle,
	maxRequestBodySize: 16 * 1024 * 1024,
	websocket: chatSocket,
	error(e) {
		console.error(e);
		return apiError(500, 131, "Internal error.");
	},
});

startScheduler();
await startFederation();
startMailDigests();
startBackups();
startPush();
console.log(`xitter listening on ${PUBLIC_ORIGIN}`);
