// Passkey checks (webauthn.ts) against a software authenticator: registration
// and sign-in for each algorithm, and the answers that must be refused.
import { describe, expect, test } from "bun:test";
import { verifyAssertion, verifyRegistration } from "../src/webauthn";
import { KINDS, authenticator as make, type Kind } from "./fake-authenticator";

const expected = { challenge: "c2FtcGxlLWNoYWxsZW5nZQ", origin: "https://xit.example", rpId: "xit.example" };

const authenticator = (kind: Kind, rpId = expected.rpId) => make(kind, { ...expected, rpId });

describe("passkeys", () => {
	for (const [name, kind] of Object.entries(KINDS)) {
		test(`${name}: made, then signs in`, () => {
			const a = authenticator(kind);
			const made = verifyRegistration(a.create(), expected);
			expect(made.id).toBe(a.id);
			expect(made.alg).toBe(kind.alg);
			expect(verifyAssertion(a.get(7), made, expected)).toBe(7);
		});
	}

	test("refuses another passkey's signature", () => {
		const a = authenticator(KINDS.ES256!);
		const b = authenticator(KINDS.ES256!);
		const stored = verifyRegistration(a.create(), expected);
		expect(() => verifyAssertion(b.get(1), stored, expected)).toThrow();
	});

	test("refuses a changed answer", () => {
		const a = authenticator(KINDS.EdDSA!);
		const stored = verifyRegistration(a.create(), expected);
		const r = a.get(1);
		r.authenticatorData[36]! ^= 1;
		expect(() => verifyAssertion(r, stored, expected)).toThrow("bad signature");
	});

	test("refuses the wrong challenge, origin, ceremony or site", () => {
		const a = authenticator(KINDS.ES256!);
		const stored = verifyRegistration(a.create(), expected);
		expect(() => verifyAssertion(a.get(1, 0x05, { challenge: "b3RoZXI" }), stored, expected)).toThrow("wrong challenge");
		expect(() => verifyAssertion(a.get(1, 0x05, { origin: "https://evil.example" }), stored, expected)).toThrow("wrong origin");
		expect(() => verifyAssertion(a.get(1, 0x05, { crossOrigin: true }), stored, expected)).toThrow();
		expect(() => verifyAssertion(a.get(1, 0x05, { type: "webauthn.create" }), stored, expected)).toThrow("wrong ceremony");
		const elsewhere = authenticator(KINDS.ES256!, "evil.example");
		expect(() => verifyRegistration(elsewhere.create(), expected)).toThrow("another site");
	});

	test("takes any of the instance's listed origins, and only those", () => {
		const a = authenticator(KINDS.ES256!);
		const listed = { ...expected, origin: ["https://xit.example", "https://m.xit.example"] };
		const stored = verifyRegistration(a.create(), listed);
		expect(verifyAssertion(a.get(1, 0x05, { origin: "https://m.xit.example" }), stored, listed)).toBe(1);
		expect(() => verifyAssertion(a.get(2, 0x05, { origin: "https://evil.example" }), stored, listed)).toThrow("wrong origin");
	});

	test("needs the person verified", () => {
		const a = authenticator(KINDS.ES256!);
		expect(() => verifyRegistration(a.create(0x41), expected)).toThrow("didn't verify");
		const stored = verifyRegistration(a.create(), expected);
		expect(() => verifyAssertion(a.get(1, 0x01), stored, expected)).toThrow("didn't verify");
	});

	test("refuses a registration claiming another credential id", () => {
		const a = authenticator(KINDS.ES256!);
		expect(() => verifyRegistration({ ...a.create(), id: "AAAA" }, expected)).toThrow("doesn't match");
	});

	test("refuses truncated data", () => {
		const a = authenticator(KINDS.ES256!);
		const r = a.create();
		expect(() => verifyRegistration({ ...r, attestationObject: r.attestationObject.slice(0, 60) }, expected)).toThrow();
	});
});
