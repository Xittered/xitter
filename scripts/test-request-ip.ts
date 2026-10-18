import { expect, test } from "bun:test";
import { rememberIp, requestCountry, requestIp } from "../src/login-history";

const from = (peer: string | undefined, header?: string) => {
	const req = new Request("http://x/", { headers: header ? { "cf-connecting-ip": header } : {} });
	rememberIp(req, peer);
	return requestIp(req);
};

test("Cloudflare and local proxies pass the visitor's address on", () => {
	expect(from("172.70.1.2", "203.0.113.5")).toBe("203.0.113.5");
	expect(from("2606:4700::1", "203.0.113.5")).toBe("203.0.113.5");
	expect(from("127.0.0.1", "203.0.113.5")).toBe("203.0.113.5");
	expect(from("::ffff:172.18.0.1", "203.0.113.5")).toBe("203.0.113.5");
});

test("anyone else reaching the origin can't pick an address", () => {
	expect(from("198.51.100.20", "203.0.113.5")).toBe("198.51.100.20");
	expect(from("198.51.100.20")).toBe("198.51.100.20");
	expect(from("172.70.1.2", "not an ip")).toBe("172.70.1.2");
});

test("the country header counts only through a trusted proxy", () => {
	const country = (peer: string) => {
		const req = new Request("http://x/", { headers: { "cf-ipcountry": "PT" } });
		rememberIp(req, peer);
		return requestCountry(req);
	};
	expect(country("172.70.1.2")).toBe("PT");
	expect(country("198.51.100.20")).toBeUndefined();
});
