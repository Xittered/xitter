// claude-mod-feedback.ts: staff decisions in, prompt block and muted categories out
import { expect, test } from "bun:test";
import { feedbackBlock, mutedCategories } from "../src/claude-mod-feedback";

test("a category staff keep dismissing is muted, a confirmed one isn't", () => {
	const muted = mutedCategories([
		{ category: "impersonation", confirmed: 1, dismissed: 19 },
		{ category: "hate", confirmed: 12, dismissed: 3 },
		{ category: "spam", confirmed: 0, dismissed: 4 },
	]);
	expect([...muted]).toEqual(["impersonation"]);
});

test("the block names rates, advice and examples with staff notes", () => {
	const block = feedbackBlock(
		[
			{ category: "impersonation", confirmed: 1, dismissed: 19 },
			{ category: "hate", confirmed: 8, dismissed: 1 },
			{ category: "spam", confirmed: 1, dismissed: 1 },
		],
		[
			{ category: "impersonation", confirmed: false, item: "@wendys, name: Wendy's, bio: fresh never frozen", note: "brand accounts are fine here" },
			{ category: "hate", confirmed: true, item: "@someone: slur here", note: "" },
		],
	);
	expect(block).toContain("impersonation: staff confirmed 1 of 20 (they don't want these");
	expect(block).toContain("hate: staff confirmed 8 of 9 (they want these");
	expect(block).not.toContain("spam:");
	expect(block).toContain("@wendys");
	expect(block).toContain("staff note: brand accounts are fine here");
	expect(block.indexOf("Dismissed")).toBeLessThan(block.indexOf("Confirmed"));
});

test("nothing decided yet gives no block", () => {
	expect(feedbackBlock([{ category: "hate", confirmed: 1, dismissed: 0 }], [])).toBe("");
});
