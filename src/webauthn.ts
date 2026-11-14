// WebAuthn (passkey) checks, without a library: just enough CBOR to read an
// authenticator's data and its COSE public key, and node's crypto for the
// signatures. Attestation is "none": a passkey is trusted because the signed-in
// account added it, not because of who made the authenticator.
import { createHash, createPublicKey, verify } from "node:crypto";

export const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
export const unb64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

// ES256, EdDSA (Ed25519), RS256: what every platform and security key offers
export const ALGORITHMS = [-7, -8, -257];

// CBOR, as authenticators use it: no tags, floats or indefinite lengths
function cbor(data: Uint8Array, at = 0): [any, number] {
	const head = data[at];
	if (head === undefined) throw new Error("cbor: ran out of data");
	const major = head >> 5;
	const info = head & 31;
	let n: number;
	at++;
	if (info < 24) n = info;
	else if (info === 24) n = data[at++]!;
	else if (info === 25) (n = (data[at]! << 8) | data[at + 1]!), (at += 2);
	else if (info === 26) (n = new DataView(data.buffer, data.byteOffset + at, 4).getUint32(0)), (at += 4);
	else throw new Error("cbor: unsupported length");
	switch (major) {
		case 0:
			return [n, at];
		case 1:
			return [-1 - n, at];
		case 2:
			if (at + n > data.length) throw new Error("cbor: ran out of data");
			return [data.slice(at, at + n), at + n];
		case 3:
			if (at + n > data.length) throw new Error("cbor: ran out of data");
			return [new TextDecoder().decode(data.subarray(at, at + n)), at + n];
		case 4: {
			const out: any[] = [];
			for (let i = 0; i < n; i++) [out[i], at] = cbor(data, at);
			return [out, at];
		}
		case 5: {
			const out = new Map<any, any>();
			for (let i = 0; i < n; i++) {
				let k: any, v: any;
				[k, at] = cbor(data, at);
				[v, at] = cbor(data, at);
				out.set(k, v);
			}
			return [out, at];
		}
		case 7:
			if (info === 20) return [false, at];
			if (info === 21) return [true, at];
			if (info === 22) return [null, at];
	}
	throw new Error("cbor: unsupported item");
}

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

type AuthData = { rpIdHash: Uint8Array; flags: number; signCount: number; credentialId?: Uint8Array; cose?: Map<number, any> };

function authData(data: Uint8Array): AuthData {
	if (data.length < 37) throw new Error("authenticator data too short");
	const flags = data[32]!;
	const out: AuthData = { rpIdHash: data.subarray(0, 32), flags, signCount: new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0) };
	if (flags & AT) {
		if (data.length < 55) throw new Error("authenticator data too short");
		const length = (data[53]! << 8) | data[54]!;
		out.credentialId = data.slice(55, 55 + length);
		if (out.credentialId.length !== length) throw new Error("authenticator data too short");
		[out.cose] = cbor(data, 55 + length);
	}
	return out;
}

// A COSE key as SPKI (DER), the form node's crypto takes back later
function spki(cose: Map<number, any>): { key: Uint8Array; alg: number } {
	const alg = cose.get(3);
	const kty = cose.get(1);
	const part = (k: number) => {
		const v = cose.get(k);
		if (!(v instanceof Uint8Array)) throw new Error("public key: missing part");
		return b64url(v);
	};
	let jwk: JsonWebKey;
	if (alg === -7 && kty === 2 && cose.get(-1) === 1) jwk = { kty: "EC", crv: "P-256", x: part(-2), y: part(-3) };
	else if (alg === -8 && kty === 1 && cose.get(-1) === 6) jwk = { kty: "OKP", crv: "Ed25519", x: part(-2) };
	else if (alg === -257 && kty === 3) jwk = { kty: "RSA", n: part(-1), e: part(-2) };
	else throw new Error("That kind of passkey isn't supported.");
	return { key: new Uint8Array(createPublicKey({ key: jwk, format: "jwk" }).export({ type: "spki", format: "der" })), alg };
}

// origin: the site the ceremony may come from, or any of several
export type Expected = { challenge: string; origin: string | string[]; rpId: string };

function clientData(json: Uint8Array, type: string, expected: Expected) {
	let c: any;
	try {
		c = JSON.parse(new TextDecoder().decode(json));
	} catch {
		throw new Error("unreadable client data");
	}
	if (c?.type !== type) throw new Error("wrong ceremony");
	if (c.challenge !== expected.challenge) throw new Error("wrong challenge");
	if (![expected.origin].flat().includes(c.origin)) throw new Error("wrong origin");
	if (c.crossOrigin === true) throw new Error("made inside another site's frame");
}

function checkAuthData(a: AuthData, rpId: string) {
	if (!Buffer.from(a.rpIdHash).equals(createHash("sha256").update(rpId).digest())) throw new Error("passkey for another site");
	// present and verified (fingerprint, face, PIN): a passkey stands in for
	// both the password and the second factor
	if (!(a.flags & UP) || !(a.flags & UV)) throw new Error("The passkey didn't verify you. Try again with your fingerprint, face or PIN.");
}

export const challengeOf = (clientDataJSON: Uint8Array): string | undefined => {
	try {
		const c = JSON.parse(new TextDecoder().decode(clientDataJSON));
		return typeof c?.challenge === "string" ? c.challenge : undefined;
	} catch {
		return undefined;
	}
};

export type Registration = { id: string; clientDataJSON: Uint8Array; attestationObject: Uint8Array };

// a new passkey: its id, public key (SPKI) and algorithm, and counter
export function verifyRegistration(r: Registration, expected: Expected) {
	clientData(r.clientDataJSON, "webauthn.create", expected);
	const [att] = cbor(r.attestationObject);
	const raw = att instanceof Map ? att.get("authData") : undefined;
	if (!(raw instanceof Uint8Array)) throw new Error("no authenticator data");
	const a = authData(raw);
	checkAuthData(a, expected.rpId);
	if (!a.credentialId || !a.cose) throw new Error("no credential in the response");
	if (b64url(a.credentialId) !== r.id) throw new Error("credential id doesn't match");
	const { key, alg } = spki(a.cose);
	return { id: r.id, publicKey: key, alg, signCount: a.signCount, backedUp: !!(a.flags & 0x10) };
}

export type Assertion = { clientDataJSON: Uint8Array; authenticatorData: Uint8Array; signature: Uint8Array };

// a sign-in: the counter it reports when the signature is right; throws otherwise
export function verifyAssertion(r: Assertion, stored: { publicKey: Uint8Array; alg: number }, expected: Expected): number {
	clientData(r.clientDataJSON, "webauthn.get", expected);
	const a = authData(r.authenticatorData);
	checkAuthData(a, expected.rpId);
	const signed = Buffer.concat([r.authenticatorData, createHash("sha256").update(r.clientDataJSON).digest()]);
	const key = createPublicKey({ key: Buffer.from(stored.publicKey), format: "der", type: "spki" });
	const ok = verify(stored.alg === -8 ? null : "sha256", signed, stored.alg === -7 ? { key, dsaEncoding: "der" } : key, r.signature);
	if (!ok) throw new Error("bad signature");
	return a.signCount;
}
