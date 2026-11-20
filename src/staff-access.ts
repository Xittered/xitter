// Who reaches the admin panel beyond having a staff role: Admin > Security can
// require two-factor of staff and limit the panel to some addresses.
// ADMIN_ANY_IP=1 lifts the address limit, for an admin who locked themselves out.

import { AsyncLocalStorage } from "node:async_hooks";
import { BlockList, isIP } from "node:net";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { requestIp } from "./login-history";
import { settings } from "./settings";
import { allows } from "./staff-permissions";

// "::ffff:10.0.0.1" is how an IPv4 client shows on a dual-stack socket
export const clientIp = (req: Request) => requestIp(req)?.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "") ?? null;

// "10.0.0.0/8", "2001:db8::/32" or a single address; undefined when it is neither
export function parseRange(entry: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } | undefined {
	const [address, bits, extra] = entry.trim().split("/");
	const v = isIP(address ?? "");
	if (!v || extra !== undefined) return undefined;
	const max = v === 4 ? 32 : 128;
	const prefix = bits === undefined ? max : /^\d{1,3}$/.test(bits) ? Number(bits) : Number.NaN;
	if (!(prefix >= 0 && prefix <= max)) return undefined;
	return { address, prefix, family: v === 4 ? "ipv4" : "ipv6" };
}

export function ipAllowed(ip: string | null, ranges: string[]): boolean {
	if (!ranges.length) return true;
	const v = ip ? isIP(ip) : 0;
	if (!ip || !v) return false;
	const list = new BlockList();
	for (const r of ranges.map(parseRange)) if (r) list.addSubnet(r.address, r.prefix, r.family);
	return list.check(ip, v === 4 ? "ipv4" : "ipv6");
}

// why this staff member can't use the panel from here, or null when they can
export async function staffGate(req: Request, viewer: Viewer): Promise<string | null> {
	if (viewer.superadmin && viewer.role === "admin") return null;
	const { staff_2fa, admin_ips } = settings().security;
	if (!process.env.ADMIN_ANY_IP && !ipAllowed(clientIp(req), admin_ips)) return `The admin panel isn't open to your address (${clientIp(req) ?? "unknown"}).`;
	if (staff_2fa) {
		const [u] = await sql`select totp_enabled from users where id = ${viewer.id}::bigint`;
		if (!u?.totp_enabled) return "Staff need two-factor authentication. Turn it on at /account/2fa, then come back.";
	}
	return null;
}

const staffRequest = new AsyncLocalStorage<{ staff: boolean; language?: string; suspended?: string; hideParody?: boolean; hideChecks?: boolean }>();

export const asRequest = <T>(run: () => T) => staffRequest.run({ staff: false }, run);

export const setRequestLanguage = (language: string | undefined) => {
	const request = staffRequest.getStore();
	if (request) request.language = language;
};

// Settings > Labels and checkmarks (parody-labels.ts): this viewer doesn't
// want to see parody, commentary or fan labels, or checkmarks, on anyone
export const setHidden = (hide: { parody: boolean; checks: boolean }) => {
	const request = staffRequest.getStore();
	if (!request) return;
	request.hideParody = hide.parody;
	request.hideChecks = hide.checks;
};
export const hidesParody = () => !!staffRequest.getStore()?.hideParody;
export const hidesChecks = () => !!staffRequest.getStore()?.hideChecks;

export const requestLanguage = () => staffRequest.getStore()?.language;

export const markStaff = () => {
	const request = staffRequest.getStore();
	if (request) request.staff = true;
};

// whether this request passed staffGate (the admin panel's address and 2FA rules)
export const isStaffRequest = () => !!staffRequest.getStore()?.staff;

// Staff with the suspended_profiles permission open a suspended account's
// profile in the app. For the rest of that request, that one account's posts
// aren't left out (blocks.ts); everywhere else it stays gone.
export const seesSuspended = (viewer: { role?: string | null }) => !!staffRequest.getStore()?.staff && allows(viewer.role, "suspended_profiles");
export const revealSuspended = (viewer: { role?: string | null }, userId: string) => {
	const request = staffRequest.getStore();
	if (request && seesSuspended(viewer)) request.suspended = userId;
};
export const revealedSuspended = () => staffRequest.getStore()?.suspended;

export const staffViewer = (viewerId: string) =>
	staffRequest.getStore()?.staff ? sql`exists (select 1 from users staff where staff.id = ${viewerId}::bigint and staff.role is not null)` : sql`false`;
