import { expect, test } from "bun:test";
import { patchText } from "../src/patch";

const PREDICATE = "function i({isCondensed:e,mediaCount:t,withMediaCarousel:r}){return t>1&&!e&&!!r?.()}";
const INDICATOR = '""===r.slice(i[0],i[1]).trim()&&!a.A.isPromoted(e)&&!d.A.isArticlePost(t)&&(t.extended_entities?.media?.length??0)>1&&n()}';

test("media carousel only takes over posts with more than four items", () => {
	expect(patchText(PREDICATE)).toBe("function i({isCondensed:e,mediaCount:t,withMediaCarousel:r}){return t>4&&!e&&!!r?.()}");
	expect(patchText(INDICATOR)).toContain("(t.extended_entities?.media?.length??0)>4&&n()}");
});
