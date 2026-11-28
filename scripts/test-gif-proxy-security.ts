import { afterEach, expect, test } from "bun:test";
import { gifProxy } from "../src/gifs";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("GIF proxy does not follow provider redirects", async () => {
	let options: RequestInit | undefined;
	globalThis.fetch = (async (_input, init) => {
		options = init;
		return Response.redirect("http://127.0.0.1/private", 302);
	}) as typeof fetch;
	const response = await gifProxy(new URL("http://localhost/i/api/xitter/gif?u=https%3A%2F%2Ftenor.googleapis.com%2Fimage.gif"));
	expect(options?.redirect).toBe("manual");
	expect(response.status).toBe(403);
});

test("GIF proxy follows redirects within provider hosts", async () => {
	const seen: string[] = [];
	globalThis.fetch = (async (input) => {
		seen.push(String(input));
		return seen.length === 1
			? Response.redirect("https://media.tenor.com/image.gif", 302)
			: new Response(new Uint8Array([71, 73, 70]), { headers: { "content-type": "image/gif" } });
	}) as typeof fetch;
	const response = await gifProxy(new URL("http://localhost/i/api/xitter/gif?u=https%3A%2F%2Ftenor.googleapis.com%2Fimage.gif"));
	expect(response.status).toBe(200);
	expect(seen).toEqual(["https://tenor.googleapis.com/image.gif", "https://media.tenor.com/image.gif"]);
});

test("GIF proxy rejects oversized image bodies", async () => {
	globalThis.fetch = (async () => new Response(new Uint8Array(20 * 1024 * 1024 + 1), { headers: { "content-type": "image/gif" } })) as typeof fetch;
	const response = await gifProxy(new URL("http://localhost/i/api/xitter/gif?u=https%3A%2F%2Ftenor.googleapis.com%2Fimage.gif"));
	const outcome = response.status === 413 ? "refused" : await response.arrayBuffer().then(() => "served", () => "refused");
	expect(outcome).toBe("refused");
});

test("GIF proxy refuses a declared oversized length up front", async () => {
	globalThis.fetch = (async () => new Response(new Uint8Array(8), { headers: { "content-type": "image/gif", "content-length": String(20 * 1024 * 1024 + 1) } })) as typeof fetch;
	const response = await gifProxy(new URL("http://localhost/i/api/xitter/gif?u=https%3A%2F%2Ftenor.googleapis.com%2Fimage.gif"));
	expect(response.status).toBe(413);
});
