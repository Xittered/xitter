// Thrift's binary protocol, as XChat uses it for message events and socket
// frames. A struct is read into its fields with their wire types kept, so what
// is read can be written back byte for byte, and built by hand:
//
//   { 1: str("123"), 7: struct({ 1: struct({ 100: bin(bytes) }) }) }

export const T = { bool: 2, byte: 3, double: 4, i16: 6, i32: 8, i64: 10, string: 11, struct: 12, map: 13, set: 14, list: 15 } as const;

export type Value =
	| { t: 2; v: boolean }
	| { t: 3 | 6 | 8; v: number }
	| { t: 4; v: number }
	| { t: 10; v: bigint }
	| { t: 11; v: Uint8Array }
	| { t: 12; v: Struct }
	| { t: 13; k: number; e: number; v: [Value, Value][] }
	| { t: 14 | 15; e: number; v: Value[] };
export type Struct = Record<number, Value>;

// builders
export const str = (s: string): Value => ({ t: 11, v: new TextEncoder().encode(s) });
export const bin = (b: Uint8Array): Value => ({ t: 11, v: b });
export const i64 = (n: bigint | number | string): Value => ({ t: 10, v: BigInt(n) });
export const i32 = (n: number): Value => ({ t: 8, v: n });
export const bool = (b: boolean): Value => ({ t: 2, v: b });
export const struct = (s: Struct): Value => ({ t: 12, v: s });
export const list = (e: number, v: Value[]): Value => ({ t: 15, e, v });

// readers of a field that may be missing
export const text = (v: Value | undefined) => (v?.t === 11 ? new TextDecoder().decode(v.v) : undefined);
export const bytes = (v: Value | undefined) => (v?.t === 11 ? v.v : undefined);
export const fields = (v: Value | undefined) => (v?.t === 12 ? v.v : undefined);
export const int = (v: Value | undefined) => (v?.t === 10 ? v.v : v?.t === 8 || v?.t === 6 || v?.t === 3 ? BigInt(v.v) : undefined);

// Everything here comes from clients. A negative length once moved the cursor
// backwards, so one 7-byte message looped forever and hung the server: lengths
// and counts must be non-negative and fit in what is left (every element takes
// at least a byte), and nesting stops at MAX_DEPTH.
const MAX_DEPTH = 64;

class Reader {
	pos = 0;
	depth = 0;
	view: DataView;
	constructor(public buf: Uint8Array) {
		this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	}
	need(n: number) {
		if (!Number.isInteger(n) || n < 0 || this.pos + n > this.buf.length) throw new Error("thrift: truncated");
	}
	count(n: number) {
		if (n < 0 || n > this.buf.length - this.pos) throw new Error("thrift: bad count");
		return n;
	}
	value(t: number): Value {
		if (++this.depth > MAX_DEPTH) throw new Error("thrift: nested too deep");
		try {
			return this.read(t);
		} finally {
			this.depth--;
		}
	}
	read(t: number): Value {
		const v = this.view;
		switch (t) {
			case 2:
				this.need(1);
				return { t, v: this.buf[this.pos++] !== 0 };
			case 3:
				this.need(1);
				return { t, v: v.getInt8(this.pos++) };
			case 4:
				this.need(8);
				return { t, v: v.getFloat64((this.pos += 8) - 8) };
			case 6:
				this.need(2);
				return { t, v: v.getInt16((this.pos += 2) - 2) };
			case 8:
				this.need(4);
				return { t, v: v.getInt32((this.pos += 4) - 4) };
			case 10:
				this.need(8);
				return { t, v: v.getBigInt64((this.pos += 8) - 8) };
			case 11: {
				this.need(4);
				const n = v.getInt32((this.pos += 4) - 4);
				this.need(n);
				return { t, v: this.buf.slice(this.pos, (this.pos += n)) };
			}
			case 12:
				return { t, v: this.struct() };
			case 13: {
				this.need(6);
				const k = this.buf[this.pos], e = this.buf[this.pos + 1];
				const n = v.getInt32(this.pos + 2);
				this.pos += 6;
				this.count(n);
				const out: [Value, Value][] = [];
				for (let i = 0; i < n; i++) out.push([this.value(k), this.value(e)]);
				return { t, k, e, v: out };
			}
			case 14:
			case 15: {
				this.need(5);
				const e = this.buf[this.pos];
				const n = v.getInt32(this.pos + 1);
				this.pos += 5;
				this.count(n);
				const out: Value[] = [];
				for (let i = 0; i < n; i++) out.push(this.value(e));
				return { t, e, v: out };
			}
		}
		throw new Error(`thrift: unknown type ${t} at ${this.pos}`);
	}
	struct(): Struct {
		const out: Struct = {};
		for (;;) {
			this.need(1);
			const t = this.buf[this.pos++];
			if (t === 0) return out;
			this.need(2);
			const id = this.view.getInt16(this.pos);
			this.pos += 2;
			out[id] = this.value(t);
		}
	}
}

export function decode(buf: Uint8Array): Struct {
	const r = new Reader(buf);
	const s = r.struct();
	if (r.pos !== buf.length) throw new Error("thrift: trailing bytes");
	return s;
}

export function encode(s: Struct): Uint8Array {
	const out: number[] = [];
	const u8 = (n: number) => out.push(n & 255);
	const i16 = (n: number) => out.push((n >> 8) & 255, n & 255);
	const i32 = (n: number) => out.push((n >>> 24) & 255, (n >> 16) & 255, (n >> 8) & 255, n & 255);
	const value = (x: Value) => {
		switch (x.t) {
			case 2:
				return u8(x.v ? 1 : 0);
			case 3:
				return u8(x.v);
			case 4: {
				const b = new Uint8Array(8);
				new DataView(b.buffer).setFloat64(0, x.v);
				return out.push(...b);
			}
			case 6:
				return i16(x.v);
			case 8:
				return i32(x.v);
			case 10: {
				const b = new Uint8Array(8);
				new DataView(b.buffer).setBigInt64(0, x.v);
				return out.push(...b);
			}
			case 11:
				i32(x.v.length);
				for (const b of x.v) out.push(b);
				return;
			case 12:
				return fieldsOf(x.v);
			case 13:
				u8(x.k);
				u8(x.e);
				i32(x.v.length);
				for (const [k, v] of x.v) {
					value(k);
					value(v);
				}
				return;
			case 14:
			case 15:
				u8(x.e);
				i32(x.v.length);
				for (const v of x.v) value(v);
				return;
		}
	};
	const fieldsOf = (s: Struct) => {
		for (const [id, x] of Object.entries(s).sort(([a], [b]) => Number(a) - Number(b))) {
			u8(x.t);
			i16(Number(id));
			value(x);
		}
		u8(0);
	};
	fieldsOf(s);
	return Uint8Array.from(out);
}

export const fromBase64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
export const toBase64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
