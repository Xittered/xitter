import { expect, test } from "bun:test";
import { linkCard, linksIn, parsePreview, previewable, proxied, urlEntities } from "../src/links";

test("finds links and trims punctuation", () => {
	expect(linksIn("see https://example.com/a. and (https://en.wikipedia.org/wiki/Foo_(bar)) ok").map((l) => l.url)).toEqual(["https://example.com/a", "https://en.wikipedia.org/wiki/Foo_(bar)"]);
	expect(linksIn("no links here")).toEqual([]);
});

test("entities count code points and shorten the display", () => {
	const [e] = urlEntities("🏳️‍⚧️ https://www.example.com/a/very/long/path/that/goes/on");
	expect(e.indices[0]).toBe([..."🏳️‍⚧️ "].length);
	expect(e.display_url).toBe("example.com/a/very/long/p…");
	expect(e.expanded_url).toBe("https://www.example.com/a/very/long/path/that/goes/on");
});

test("private and local hosts aren't previewed", () => {
	for (const u of ["http://localhost:3000/x", "http://127.0.0.1/", "http://10.0.0.5/", "http://192.168.1.1/", "http://[::1]/", "http://user:pw@example.com/", "ftp://example.com/"]) expect(previewable(u)).toBe(false);
	expect(previewable("https://example.com/")).toBe(true);
});

test("parses OpenGraph tags and proxies the image", () => {
	const html = `<html><head><title>Fallback</title><meta property="og:title" content="Bun &amp; friends"><meta content="A runtime" property="og:description">
		<meta property="og:image" content="/img.png"><meta property="og:image:width" content="1200"><meta property="og:site_name" content="GitHub"></head></html>`;
	const p = parsePreview("https://github.com/oven-sh/bun", html);
	expect(p?.title).toBe("Bun & friends");
	expect(p?.description).toBe("A runtime");
	expect(p?.image).toBe("https://github.com/img.png");
	const card: any = linkCard(p!);
	expect(card.legacy.name).toBe("summary_large_image");
	const image = card.legacy.binding_values.find((b: any) => b.key === "thumbnail_image_large").value.image_value.url;
	expect(image).toBe(proxied("https://github.com/img.png"));
	expect(image.startsWith("https://cors.estrogen.delivery/?url=")).toBe(true);
});

test("a page without a title gives no card", () => {
	expect(parsePreview("https://example.com", "<html><body>hi</body></html>")).toBeUndefined();
	expect(parsePreview("https://example.com", "<title>Just a title</title>")?.image).toBeNull();
});
