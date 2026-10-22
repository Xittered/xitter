import { expect, test } from "bun:test";
import { declaredLength, readJson, readLimited, CappedRead } from "../src/federation";

test("a remote body stops at the cap and the error carries none of it", async () => {
	let pulled = false;
	const declared = {
		headers: new Headers({ "content-length": "8000000" }),
		body: { getReader() { pulled = true; throw new Error("should not read"); } },
	} as unknown as Response;
	await expect(readLimited(declared, 64)).rejects.toMatchObject({ name: "CappedRead", message: "the answer is too large" });
	expect(pulled).toBe(false);

	const streamed = new Response(new Uint8Array(200).fill(65));
	const error = await readLimited(streamed, 32).catch((e) => e);
	expect(error).toBeInstanceOf(CappedRead);
	expect(error.message).toBe("the answer is too large");
	expect(String(error.stack)).not.toContain("A".repeat(20));

	const ok = new Response(JSON.stringify({ title: "Cats" }));
	expect(await readJson(ok, 64 * 1024)).toEqual({ title: "Cats" });
	await expect(readJson(new Response(`{"title":"${"x".repeat(80)}"}`), 64)).rejects.toBeInstanceOf(CappedRead);
});

test("a pass-through file needs a real content length under the cap", () => {
	const max = 40 * 1024 * 1024;
	expect(declaredLength(null, max)).toBeUndefined();
	expect(declaredLength("", max)).toBeUndefined();
	expect(declaredLength("nope", max)).toBeUndefined();
	expect(declaredLength("0", max)).toBeUndefined();
	expect(declaredLength(String(max + 1), max)).toBeUndefined();
	expect(declaredLength("4096", max)).toBe(4096);
});
