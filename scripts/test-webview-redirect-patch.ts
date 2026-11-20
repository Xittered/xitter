import { expect, test } from "bun:test";
import { patchText } from "../src/patch";

const REDIRECT = 'function ec(e,t,r){var i,n;let o;t.log({page:"app",section:"external_webview_redirect",component:e?"logged_in":"logged_out",element:r?.key??"unknown",action:"show"});let s=(i=window.location.pathname+window.location.search,n=r?.appStoreAttribution??"rw-null",(o=new URL(`x-safari-https://redirect.x.com${i}`)).searchParams.set("ct",n),o.toString());window.location.href=s}var ed=r(973192)';

test("iphone safari taken for an in-app browser is not sent to x.com", () => {
	const patched = patchText(REDIRECT);
	expect(patched).not.toContain("window.location.href=s");
	expect(patched).toContain('o.toString());}var ed=r(973192)');
});
