import { expect, test } from "bun:test";
import { isVerified, labelTakesSlot } from "../src/model";
import { asRequest, setHidden } from "../src/staff-access";

const user = { parody_label: "Parody" } as Parameters<typeof labelTakesSlot>[0];

test("a parody label takes the slot by default", () => {
	expect(asRequest(() => labelTakesSlot(user))).toBe(true);
});

test("a viewer who hides parody labels doesn't get one", () => {
	expect(
		asRequest(() => {
			setHidden({ parody: true, checks: false });
			return labelTakesSlot(user);
		}),
	).toBe(false);
});

const checked = { verified_type: "blue", instance: null } as unknown as Parameters<typeof isVerified>[0];

test("a viewer who hides checkmarks sees none", () => {
	expect(asRequest(() => isVerified(checked))).toBe(true);
	expect(
		asRequest(() => {
			setHidden({ parody: false, checks: true });
			return isVerified(checked);
		}),
	).toBe(false);
});
