// End-to-end check of several accounts signed in at once, against a running
// server: one browser (a cookie jar) signs in to two accounts through X's
// dialog, lists, switches, and logs out.
// usage: bun scripts/test-accounts.ts <user A> <user B> <password of both>

const [nameA, nameB, password] = process.argv.slice(2);
if (!nameA || !nameB || !password) throw new Error("usage: bun scripts/test-accounts.ts <user A> <user B> <password>");
const origin = `http://localhost:${process.env.PORT ?? 3000}`;

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

// the browser's cookies
const jar = new Map<string, string>();
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
async function send(path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("cookie", cookie());
	if (jar.has("ct0")) headers.set("x-csrf-token", jar.get("ct0")!);
	const r = await fetch(`${origin}${path}`, { ...init, headers, redirect: "manual" });
	for (const c of r.headers.getSetCookie()) {
		const [kv, ...attrs] = c.split(";");
		const i = kv.indexOf("=");
		const [k, v] = [kv.slice(0, i), kv.slice(i + 1)];
		if (!v || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(k);
		else jar.set(k, v);
	}
	return r;
}
const signIn = (username: string) =>
	send("/i/jfapi/onboarding/web/actions/login_enter_password", { method: "POST", body: new URLSearchParams({ username, password }) });
const post = (path: string, body: Record<string, string> = {}) => send(`/i/api${path}`, { method: "POST", body: new URLSearchParams(body) });
const me = async () => (await (await send("/i/api/1.1/account/settings.json")).json()).screen_name?.toLowerCase();
const everyone = async () => (await (await send("/i/api/1.1/account/multi/list.json")).json()).users ?? [];
const list = async () => (await everyone()).slice(1);
const badgeOf = async (userId: string) => {
	const r = await send("/i/api/graphql/q4Npr1-FYRWyXsRzPckwEA/ViewerBadgeCounts?variables=%7B%7D", { headers: { "x-web-auth-multi-user-id": userId } });
	return r.status === 200 ? (await r.json()).data.viewer_v2.user_results.result.badge_counts : r.status;
};
const meta = async () => /"hasMultiAccountCookie":(true|false)/.exec(await (await send("/home")).text())?.[1];

await signIn(nameA);
check("signed in as A", (await me()) === nameA.toLowerCase());
check("one account: the menu isn't told of others", (await meta()) === "false");
await signIn(nameB);
check("adding B makes B active", (await me()) === nameB.toLowerCase());
const others = await list();
check("and keeps A signed in, listed in the menu", others.length === 1 && others[0].screen_name.toLowerCase() === nameA.toLowerCase(), others);
check("the page tells the menu to ask", (await meta()) === "true");
check("the menu lists the active account first, as X does", (await everyone())[0]?.screen_name.toLowerCase() === nameB.toLowerCase());
check("each account's badge is asked for as that account", typeof (await badgeOf(others[0]?.user_id))?.ntab_unread_count === "number");
check("not for an account that isn't signed in here", (await badgeOf("1")) === 403);
await signIn(nameA);
check("signing in to A again doesn't list it twice", (await list()).length === 1 && (await me()) === nameA.toLowerCase());

const idB = (await list())[0]?.user_id;
check("an account that isn't signed in can't be switched to", (await post("/1.1/account/multi/switch.json", { user_id: "1" })).status === 400);
await post("/1.1/account/multi/switch.json", { user_id: idB });
check("switching makes B active", (await me()) === nameB.toLowerCase());
check("with A behind it", (await list())[0]?.screen_name.toLowerCase() === nameA.toLowerCase());

await post("/1.1/account/logout.json");
check("logging out of B falls back to A", (await me()) === nameA.toLowerCase());
check("and B is gone from the menu", (await list()).length === 0);

await signIn(nameB);
await post("/1.1/account/multi/logout_all.json");
check("logging out of all ends every session", !jar.has("auth_token") && !jar.has("auth_multi") && (await send("/i/api/1.1/account/settings.json")).status === 401);

console.log(failures ? `${failures} failed` : "all passed");
process.exit(failures ? 1 : 0);
