import { expect, test } from "bun:test";
import { knownChatOperation } from "../src/chat";
import { delegateMay } from "../src/delegation";
import { knownOperation } from "../src/graphql";

test("a delegate can't read or change the account's money or look", () => {
	for (const role of ["Admin", "Contributor"] as const) {
		expect(delegateMay(role, "GET", "/xitter/money/recent", undefined)).toBe(false);
		expect(delegateMay(role, "GET", "/xitter/money/cards", undefined)).toBe(false);
		expect(delegateMay(role, "POST", "/xitter/money/payme", undefined)).toBe(false);
		expect(delegateMay(role, "POST", "/xitter/theme", undefined)).toBe(false);
		expect(delegateMay(role, "POST", "/xitter/theme/import", undefined)).toBe(false);
		expect(delegateMay(role, "GET", "/xitter/theme", undefined)).toBe(true);
		expect(delegateMay(role, "GET", "/xitter/badges", undefined)).toBe(true);
	}
});

test("a refused mutation stays refused when it arrives as a GET", () => {
	for (const name of ["UserAccountLabel", "DisableUserAccountLabel", "WriteEmailNotificationSettings", "useDelegateMutation_settings_Mutation"]) {
		expect(delegateMay("Admin", "GET", `/graphql/x/${name}`, name)).toBe(false);
		expect(delegateMay("Admin", "POST", `/graphql/x/${name}`, name)).toBe(false);
	}
});

test("a delegate still reads what the refused names would catch", () => {
	for (const name of ["UserByScreenName", "DelegatedAccountListQuery", "GroupsDelegateQuery", "UserPreferencesQuery", "HomeTimeline", "TweetDetail"])
		expect(delegateMay("Contributor", "GET", `/graphql/x/${name}`, name)).toBe(true);
	expect(delegateMay("Contributor", "POST", "/graphql/x/CreateTweet", "CreateTweet")).toBe(true);
	expect(delegateMay("Contributor", "GET", "/graphql/x/UserSessionsList", "UserSessionsList")).toBe(false);
});

test("operations are looked up by their own names only", () => {
	for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
		expect(knownOperation(name)).toBe(false);
		expect(knownChatOperation(name)).toBe(false);
	}
	expect(knownOperation("CreateTweet")).toBe(true);
});
