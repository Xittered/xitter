import { expect, test } from "bun:test";
import { labelTakesSlot } from "../src/model";
import { asRequest, setHideParody } from "../src/staff-access";

const user = { parody_label: "Parody" } as Parameters<typeof labelTakesSlot>[0];

test("a parody label takes the slot by default", () => {
	expect(asRequest(() => labelTakesSlot(user))).toBe(true);
});

test("a viewer who hides parody labels doesn't get one", () => {
	expect(
		asRequest(() => {
			setHideParody(true);
			return labelTakesSlot(user);
		}),
	).toBe(false);
});
