// Checks GIF search and the media proxy against a running server that was
// started with KLIPY_API_KEY=test KLIPY_API_URL=http://localhost:39999/v2, or
// with TENOR_API_KEY and TENOR_API_URL and GIF_PROVIDER=tenor here
// (this script serves the fake provider there).
// usage: bun scripts/test-gifs.ts <user> <password>

export {};

const origin = `http://localhost:${process.env.PORT ?? 3000}`;
const [name, password] = process.argv.slice(2);
if (!name || !password) throw new Error("usage: bun scripts/test-gifs.ts <user> <password>");

const provider = process.env.GIF_PROVIDER ?? "klipy";
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]);
const seen: string[] = [];
const klipy = Bun.serve({
	port: 39999,
	fetch(req) {
		const url = new URL(req.url);
		seen.push(url.pathname + "?" + url.searchParams.toString());
		if (url.pathname.endsWith(".gif")) return new Response(gif, { headers: { "content-type": "image/gif" } });
		if (url.pathname === "/v2/search" || url.pathname === "/v2/featured") {
			const base = `http://localhost:39999/media`;
			return Response.json({
				next: "page2",
				results: [
					{
						id: "abc",
						content_description: "a cat",
						media_formats: {
							gif: { url: `${base}/abc.gif`, dims: [320, 240] },
							tinygif: { url: `${base}/abc-tiny.gif`, dims: [160, 120] },
							gifpreview: { url: `${base}/abc.gif` },
						},
					},
					{ id: "broken", media_formats: {} },
				],
			});
		}
		return new Response("not found", { status: 404 });
	},
});

const r = await fetch(`${origin}/login`, { method: "POST", body: new URLSearchParams({ username: name, password }), redirect: "manual" });
const cookies = r.headers.getSetCookie().map((c) => c.split(";")[0]);
const csrf = cookies.find((c) => c.startsWith("ct0="))?.slice(4);
if (!csrf) throw new Error("login failed");
const headers = { cookie: cookies.join("; "), "x-csrf-token": csrf };
const get = async (op: string, variables: object) =>
	(await fetch(`${origin}/i/api/graphql/q/${op}?variables=${encodeURIComponent(JSON.stringify(variables))}`, { headers })).json();

let failures = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
	if (!ok) failures++;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : `: ${JSON.stringify(detail)}`}`);
}

const raw = await get("GifSearch", { rawQuery: "cat", count: 10 });
const found = raw.data?.gif_search_slice;
check("search returns usable items only", found?.items?.length === 1 && found.items[0].id === `${provider}_abc`, found?.items?.length);
check("items have the shape the client maps", found?.items?.[0]?.full_image?.still_image_url && found.items[0].thumbnail_images.length === 1 && found.items[0].provider.id === provider);
check("cursor passes through", found?.slice_info?.next_cursor === "page2");
check("the provider got the query and the key", seen.some((s) => s.includes("q=cat") && s.includes("key=test")));

const trending = (await get("GifEnumerateCategory", { category: "trending", count: 5 })).data?.gif_enumerate_category_slice;
check("trending uses the featured feed", trending?.items?.length === 1 && seen.some((s) => s.startsWith("/v2/featured")));

const proxied = await fetch(`${origin}${found.items[0].full_image.url}`, { headers });
check("a result's image comes through the proxy", proxied.status === 200 && proxied.headers.get("content-type") === "image/gif" && (await proxied.arrayBuffer()).byteLength === gif.length);
const evil = await fetch(`${origin}/i/api/xitter/gif?u=${encodeURIComponent("http://example.com/x.gif")}`, { headers });
check("other hosts are refused", evil.status === 403);
const signedOut = await fetch(`${origin}/i/api/xitter/gif?u=${encodeURIComponent("http://localhost:39999/media/abc.gif")}`);
check("signed-out requests are refused", signedOut.status === 401);

klipy.stop();
console.log(failures ? `${failures} FAILED` : "all passed");
process.exit(failures ? 1 : 0);
