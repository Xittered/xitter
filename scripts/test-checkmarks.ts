// Who wears a checkmark (model.ts isVerified): an account with a badge of its
// own, and an organisation's affiliate while affiliate_checkmarks is on.
import { afterEach, expect, test } from "bun:test";
import type { User } from "../src/auth";
import { isVerified, userResult, verifiedSince } from "../src/model";
import { settings } from "../src/settings";

const org = { screen_name: "acme", name: "Acme", avatar_url: null, since: "2026-01-02T00:00:00Z" };
const person = (extra: Partial<User> = {}) => ({ id: "1", screen_name: "jo", name: "Jo", verified_type: null, created_at: new Date("2024-01-01T00:00:00Z"), ...extra }) as User;

afterEach(() => {
	settings().features.affiliate_checkmarks = true;
});

test("affiliates get a checkmark by default", () => {
	const u = person({ org } as Partial<User>);
	expect(isVerified(u)).toBe(true);
	expect(verifiedSince(u)?.toISOString()).toBe("2026-01-02T00:00:00.000Z");
	const res = userResult(u) as any;
	expect(res.affiliates_highlighted_label?.label?.url).toEqual({ url: "https://x.com/acme", urlType: "DeepLink" });
	expect(res.verification_info?.reason?.description?.entities?.[0]?.ref?.url).toBe("https://x.com/acme");
});

test("with affiliate checkmarks off, an affiliate has none", () => {
	settings().features.affiliate_checkmarks = false;
	const u = person({ org } as Partial<User>);
	expect(isVerified(u)).toBe(false);
	expect(verifiedSince(u)).toBe(null);
	expect(userResult(u).is_blue_verified).toBe(false);
});

test("with affiliate checkmarks off, an affiliate's own badge still shows", () => {
	settings().features.affiliate_checkmarks = false;
	const u = person({ org, verified_type: "blue", verified_at: "2025-05-05T00:00:00Z" } as Partial<User>);
	expect(isVerified(u)).toBe(true);
	expect(verifiedSince(u)?.toISOString()).toBe("2025-05-05T00:00:00.000Z");
	expect(JSON.stringify(userResult(u).verification_info)).not.toContain("affiliate of");
});
