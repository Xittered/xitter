import { expect, test } from "bun:test";
import { decode, encode, fromBase64, i32, list, str, struct } from "../src/thrift";

// GHSA-gqv5-jxv5-g37c: a string with length -7 moved the cursor back to the
// start, and the struct loop read the same bytes forever
test("a negative string length is refused, not looped on", () => {
	expect(() => decode(fromBase64("CwAA////+Q=="))).toThrow();
});

test("negative and oversized counts are refused", () => {
	// list of i32, count -1 / count 2^31-1 with no elements after it
	expect(() => decode(Uint8Array.from([15, 0, 1, 8, 255, 255, 255, 255, 0]))).toThrow();
	expect(() => decode(Uint8Array.from([15, 0, 1, 8, 127, 255, 255, 255, 0]))).toThrow();
	// map of i32 to i32, count -1
	expect(() => decode(Uint8Array.from([13, 0, 1, 8, 8, 255, 255, 255, 255, 0]))).toThrow();
});

test("deep nesting is refused instead of overflowing the stack", () => {
	const depth = 100_000;
	const deep = new Uint8Array(depth * 3 + depth + 1);
	for (let i = 0; i < depth; i++) deep.set([12, 0, 1], i * 3);
	deep.fill(0, depth * 3);
	expect(() => decode(deep)).toThrow(/nested too deep/);
	const lists = new Uint8Array(depth * 8);
	for (let i = 0; i < depth; i++) lists.set([15, 0, 1, 15, 0, 0, 0, 1], i * 8);
	expect(() => decode(lists)).toThrow();
});

test("real messages still round-trip", () => {
	const s = { 1: str("hello"), 2: i32(-5), 3: list(11, [str("a"), str("")]), 4: struct({ 1: struct({ 2: str("x") }) }) };
	expect(decode(encode(s))).toEqual(s);
});
