import { expect, test } from "bun:test";
import { ERROR_SCRIPT } from "../src/errors";
import { newerReason, restrictedBody, restrictedReason, restrictedRefuses } from "../src/restricted-page";

test("restriction reason prefers the active staff notice", () => {
	expect(restrictedReason("Your posts broke the rules.", "older audit reason")).toBe("Your posts broke the rules.");
	expect(restrictedReason("", "audit reason")).toBe("audit reason");
});

test("restriction reason falls back to the sanction audit and default", () => {
	expect(restrictedReason(null, "Repeated rule violations.")).toBe("Repeated rule violations.");
	expect(restrictedReason(null, null)).toBe("The instance team has restricted this account.");
});

test("the newer of the staff message and the sanction reason wins", () => {
	const old = { body: "Your profile picture was reset", created_at: "2026-11-22T05:24:50Z" };
	const ban = { reason: "Changing profile picture back. 24 hour ban", created_at: "2026-11-22T19:05:34Z" };
	expect(newerReason(old, ban)).toBe(ban.reason);
	expect(newerReason({ ...old, created_at: "2026-11-22T19:06:00Z" }, ban)).toBe(old.body);
	expect(newerReason(undefined, ban)).toBe(ban.reason);
	expect(newerReason(old, undefined)).toBe(old.body);
	expect(newerReason(undefined, undefined)).toBeUndefined();
});

test("restricted page content includes the reason and appeal link safely", () => {
	const body = restrictedBody('Reason <script>alert("x")</script>');
	expect(body).toContain("Your account is restricted");
	expect(body).toContain("Reason &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
	expect(body).toContain('href="/appeal"');
	expect(body).toContain("can't interact with posts");
	expect(body).toContain("message people who don't follow you");
});

test("restricted API errors navigate the client to account access", () => {
	expect(ERROR_SCRIPT).toContain('e.code===326');
	// only right after the user did something
	expect(ERROR_SCRIPT).toContain("Date.now()-acted>5000");
	expect(() => new Function(ERROR_SCRIPT)).not.toThrow();
	expect(ERROR_SCRIPT).toContain('location.assign("/account/access")');
	expect(ERROR_SCRIPT).toContain("XMLHttpRequest.prototype.open");
});

const refuses = (method: string, path: string, operation?: string) => restrictedRefuses(method, path, operation, new URL(`http://localhost${path}`));

test("restricted accounts can't post, engage or change their account", () => {
	expect(refuses("POST", "/graphql/x/CreateTweet", "CreateTweet")).toBe(true);
	expect(refuses("POST", "/graphql/x/FavoriteTweet", "FavoriteTweet")).toBe(true);
	expect(refuses("POST", "/1.1/friendships/create.json")).toBe(true);
	expect(refuses("POST", "/1.1/account/update_profile.json")).toBe(true);
});

test("restricted accounts still read, block, mute, message and run the client's background calls", () => {
	expect(refuses("GET", "/1.1/statuses/show.json")).toBe(false);
	expect(refuses("POST", "/1.1/jot/client_event.json")).toBe(false);
	expect(refuses("POST", "/2/notifications/all/last_seen_cursor.json")).toBe(false);
	expect(refuses("POST", "/xitter/client_error")).toBe(false);
	expect(refuses("POST", "/1.1/blocks/create.json")).toBe(false);
	expect(refuses("POST", "/1.1/mutes/users/destroy.json")).toBe(false);
	expect(refuses("POST", "/1.1/mutes/keywords/create.json")).toBe(false);
	expect(refuses("POST", "/xitter/money/payme")).toBe(false);
	expect(refuses("POST", "/graphql/x/SendMessageCreateMutation", "SendMessageCreateMutation")).toBe(false);
	expect(refuses("POST", "/i/media/upload.json")).toBe(false);
});
