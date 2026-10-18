// Sign-ins, for Settings > Your account > Account access history (the
// client reads them from p13n_data's login_history) and for the admin
// panel's sessions list.
//
// The address is the socket's, or Cloudflare's CF-Connecting-IP when the site
// sits behind it (the same trust countries.ts gives CF-IPCountry). Bun only
// knows the socket address through the server, so server.ts notes it per request.

import { BlockList, isIP } from "node:net";
import { countryFromHeader, countryName } from "./countries";
import { sql } from "./db";
import { newId } from "./ids";
import { platformSource, webSource } from "./platforms";

const socketIps = new WeakMap<Request, string>();
export const rememberIp = (req: Request, ip: string | undefined) => {
	if (ip) socketIps.set(req, ip);
};
const CLOUDFLARE = [
	"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
	"197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
	"2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
];
const LOCAL = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "::1/128", "fc00::/7", "fe80::/10"];
const trusted = new BlockList();
for (const range of [...CLOUDFLARE, ...LOCAL, ...(process.env.TRUSTED_PROXIES ?? "").split(",").map((r) => r.trim()).filter(Boolean)]) {
	const [address, bits] = range.split("/");
	const family = isIP(address);
	if (family) trusted.addSubnet(address, Number(bits ?? (family === 4 ? 32 : 128)), family === 4 ? "ipv4" : "ipv6");
}
const unmapped = (ip: string) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
const fromProxy = (peer: string | undefined) => {
	if (!peer) return true;
	const ip = unmapped(peer);
	const family = isIP(ip);
	return !!family && trusted.check(ip, family === 4 ? "ipv4" : "ipv6");
};
export const fromTrustedProxy = (req: Request) => fromProxy(socketIps.get(req));

export const requestIp = (req: Request): string | null => {
	const peer = socketIps.get(req);
	const forwarded = req.headers.get("cf-connecting-ip")?.trim();
	return (forwarded && isIP(forwarded) && fromProxy(peer) ? forwarded : peer) || null;
};

export const requestCountry = (req: Request) => (fromProxy(socketIps.get(req)) ? countryFromHeader(req.headers.get("cf-ipcountry")) : undefined);

export async function recordSignIn(req: Request, session: { token: string; userId: string }) {
	const ip = requestIp(req);
	const country = requestCountry(req) ?? null;
	const app = (await platformSource(req)) ?? webSource();
	await sql`insert into login_events (id, user_id, ip, country, app, user_agent)
		values (${newId()}::bigint, ${session.userId}::bigint, ${ip}, ${country}, ${app}, ${(req.headers.get("user-agent") ?? "").slice(0, 500)})`;
	await sql`update sessions set ip = ${ip} where token = ${session.token}`;
}

// newest first, as the settings page lists them
export async function loginHistory(userId: string, limit = 50) {
	const rows = await sql`select ip, country, app, created_at from login_events where user_id = ${userId}::bigint order by created_at desc limit ${limit}`;
	return rows.map((r: any) => ({ app_name: r.app, time: r.created_at.toISOString(), ip: r.ip ?? "", country: r.country ? (countryName(r.country) ?? r.country) : null }));
}
