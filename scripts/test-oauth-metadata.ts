// Client ID metadata documents: which URLs count, which documents are used,
// and that the server never connects to a private address for one.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizationServerMetadata, clientMetadata, fetcher, metadataClientId, publicLookup, resolver } from "../src/oauth-metadata";

const realGet = fetcher.get;
const realLookup = resolver.lookup;
afterEach(() => {
	fetcher.get = realGet;
	resolver.lookup = realLookup;
});

let n = 0;
// a fresh URL per test, so the document cache never answers for another test
const fresh = () => `https://app.example/oauth-client-${++n}.json`;

// the document as the HTTPS fetch would return it (undefined: not a 200)
function serve(body: unknown) {
	const fetched: string[] = [];
	fetcher.get = async (url: string) => {
		fetched.push(url);
		return body === undefined || typeof body === "string" ? (body as string | undefined) : JSON.stringify(body);
	};
	return fetched;
}

const family = (address: string) => (address.includes(":") ? 6 : 4);
const resolvesTo = (...addresses: string[]) => {
	let calls = 0;
	resolver.lookup = async () => {
		calls++;
		return addresses.map((address) => ({ address, family: family(address) }));
	};
	return () => calls;
};
const lookUp = (host: string, options: { all?: boolean; family?: number } = {}) =>
	new Promise<{ error: NodeJS.ErrnoException | null; address: unknown; family?: number }>((resolve) =>
		publicLookup(host, options as never, ((error: NodeJS.ErrnoException | null, address: unknown, fam?: number) => resolve({ error, address, family: fam })) as never),
	);

test("only plain https document URLs are client IDs", () => {
	expect(metadataClientId("https://app.example/oauth-client.json")).toBeDefined();
	for (const bad of [
		"http://app.example/oauth-client.json",
		"https://app.example/",
		"https://app.example/c.json?x=1",
		"https://app.example/c.json#x",
		"https://user@app.example/c.json",
		"https://app.example:8443/c.json",
		"https://127.0.0.1/c.json",
		"https://[::1]/c.json",
		"https://localhost/c.json",
		"https://printer.local/c.json",
		"https://APP.example/c.json",
		"123456789",
	])
		expect(metadataClientId(bad)).toBeUndefined();
});

test("a valid document is used, with its redirects kept to its own host", async () => {
	const url = fresh();
	serve({ client_id: url, client_name: "xit mob", redirect_uris: ["https://app.example/", "https://evil.example/", "http://app.example/x"], token_endpoint_auth_method: "none" });
	expect(await clientMetadata(url)).toEqual({ url, name: "xit mob", redirects: ["https://app.example/"], logo: null });
});

test("logo_uri becomes the icon when it's https on the document's host", async () => {
	let url = fresh();
	serve({ client_id: url, redirect_uris: ["https://app.example/"], logo_uri: "https://app.example/icon.png" });
	expect((await clientMetadata(url))?.logo).toBe("https://app.example/icon.png");
	for (const logo of ["https://elsewhere.example/icon.png", "http://app.example/icon.png", "javascript:alert(1)", 42]) {
		url = fresh();
		serve({ client_id: url, redirect_uris: ["https://app.example/"], logo_uri: logo });
		expect((await clientMetadata(url))?.logo).toBeNull();
	}
});

test("the document is cached", async () => {
	const url = fresh();
	const fetched = serve({ client_id: url, client_name: "App", redirect_uris: ["https://app.example/"] });
	await clientMetadata(url);
	await clientMetadata(url);
	expect(fetched.length).toBe(1);
});

test("a missing or odd name falls back to the host", async () => {
	const url = fresh();
	serve({ client_id: url, client_name: "x".repeat(81), redirect_uris: ["https://app.example/"] });
	expect((await clientMetadata(url))?.name).toBe("app.example");
});

test("documents that don't describe themselves are refused", async () => {
	for (const doc of [
		(url: string) => ({ client_id: `${url}x`, redirect_uris: ["https://app.example/"] }),
		(url: string) => ({ client_id: url, redirect_uris: [] }),
		(url: string) => ({ client_id: url, redirect_uris: ["https://elsewhere.example/"] }),
		(url: string) => ({ client_id: url, redirect_uris: ["https://app.example/"], token_endpoint_auth_method: "client_secret_basic" }),
	]) {
		const url = fresh();
		serve(doc(url));
		expect(await clientMetadata(url)).toBeUndefined();
	}
	let url = fresh();
	serve("not json");
	expect(await clientMetadata(url)).toBeUndefined();
	url = fresh();
	serve(undefined);
	expect(await clientMetadata(url)).toBeUndefined();
});

test("the connection's lookup refuses private, reserved and documentation addresses", async () => {
	for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.10", "198.51.100.7", "203.0.113.9", "240.0.0.1",
		"::1", "::", "fd00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2001:db8::1", "2002:7f00:1::1", "2001:0:4136:e378::1"]) {
		resolvesTo(address);
		expect((await lookUp("app.example")).error?.code).toBe("ENOTFOUND");
	}
	// one private address among public ones is enough to refuse
	resolvesTo("93.184.216.34", "10.0.0.1");
	expect((await lookUp("app.example")).error).toBeTruthy();
});

test("the connection's lookup hands over the address it checked", async () => {
	resolvesTo("93.184.216.34", "2606:4700::1111");
	expect(await lookUp("app.example")).toEqual({ error: null, address: "93.184.216.34", family: 4 });
	expect((await lookUp("app.example", { family: 6 })).address).toBe("2606:4700::1111");
	expect((await lookUp("app.example", { all: true })).address).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:4700::1111", family: 6 }]);
});

test("a host that answers with a private address is never connected to", async () => {
	const calls = resolvesTo("127.0.0.1");
	expect(await realGet("https://app.example/oauth-client.json")).toBeUndefined();
	// the only lookup is the connection's own: there's no second, unchecked one
	expect(calls()).toBe(1);
});

// the real HTTPS fetch against a local server with a throwaway certificate
const dir = mkdtempSync(join(tmpdir(), "oauth-metadata-"));
const made = !Bun.which("openssl") ? { exitCode: 1 } : Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=app.example", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stderr: "ignore", stdout: "ignore" });
const haveCert = made.exitCode === 0;
let server: ReturnType<typeof Bun.serve> | undefined;
beforeAll(() => {
	if (!haveCert) return;
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		tls: { cert: readFileSync(join(dir, "cert.pem"), "utf8"), key: readFileSync(join(dir, "key.pem"), "utf8") },
		fetch(req) {
			const p = new URL(req.url).pathname;
			if (p === "/ok.json") return Response.json({ hello: "there" });
			if (p === "/moved.json") return new Response(null, { status: 302, headers: { location: "/ok.json" } });
			if (p === "/big.json") return new Response("x".repeat(20_000));
			if (p === "/stream.json") return new Response(new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode("y".repeat(1024))); c.close(); } }));
			return new Response("no", { status: 404 });
		},
	});
});
afterAll(() => {
	server?.stop(true);
	rmSync(dir, { recursive: true, force: true });
});
const local = (path: string) => realGet(`https://app.example${path}`, { port: server!.port, rejectUnauthorized: false, lookup: ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4))) as never });

test.skipIf(!haveCert)("the fetch reads a 200 and refuses redirects, errors and anything over 16 KB", async () => {
	expect(JSON.parse((await local("/ok.json"))!)).toEqual({ hello: "there" });
	expect(await local("/moved.json")).toBeUndefined();
	expect(await local("/missing.json")).toBeUndefined();
	expect(await local("/big.json")).toBeUndefined();
	expect(await local("/stream.json")).toBeUndefined();
});

test("the server metadata says documents work as client IDs", async () => {
	const res = authorizationServerMetadata();
	expect(res.headers.get("access-control-allow-origin")).toBe("*");
	const body = await res.json();
	expect(body.client_id_metadata_document_supported).toBe(true);
	expect(body.code_challenge_methods_supported).toEqual(["S256"]);
	expect(body.authorization_endpoint).toEndWith("/oauth/authorize");
});
