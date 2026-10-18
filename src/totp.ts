// RFC 6238 time-based codes (SHA-1, 6 digits, 30 s), as every authenticator app expects.
import { createHmac, randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newSecret(): string {
	const bytes = randomBytes(20);
	let bits = "";
	for (const b of bytes) bits += b.toString(2).padStart(8, "0");
	let out = "";
	for (let i = 0; i + 5 <= bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
	return out;
}

function decode(secret: string): Buffer {
	let bits = "";
	for (const ch of secret.replace(/=+$/, "").toUpperCase()) {
		const v = ALPHABET.indexOf(ch);
		if (v >= 0) bits += v.toString(2).padStart(5, "0");
	}
	const out: number[] = [];
	for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
	return Buffer.from(out);
}

export function codeAt(secret: string, step: number): string {
	const counter = Buffer.alloc(8);
	counter.writeBigUInt64BE(BigInt(step));
	const h = createHmac("sha1", decode(secret)).update(counter).digest();
	const o = h[h.length - 1] & 15;
	const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
	return String(n % 1_000_000).padStart(6, "0");
}

// the current step and one either side, for clocks that drift
export function verifyCode(secret: string, code: string, now = Date.now()): boolean {
	const clean = code.replace(/[\s-]/g, "");
	if (!/^\d{6}$/.test(clean)) return false;
	const step = Math.floor(now / 30000);
	return [-1, 0, 1].some((d) => codeAt(secret, step + d) === clean);
}

export const otpauthUrl = (secret: string, account: string, issuer: string) =>
	`otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
