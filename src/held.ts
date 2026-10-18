import { sql } from "./db";
import { foldGlyphs } from "./fold";

const DIGITS: Record<string, string> = {
	"0": "o",
	"1": "l",
	"3": "e",
	"4": "a",
	"5": "s",
	"6": "g",
	"7": "t",
	"8": "b",
	"9": "g",
};

export const skeleton = (name: string) =>
	foldGlyphs(name)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.replace(/[0-9]/g, (d) => DIGITS[d] ?? d)
		.replace(/i/g, "l")
		.replace(/rn/g, "m")
		.replace(/vv/g, "w");

type Held = { skeleton: string; userId: string | null };
let cache: { at: number; held: Held[] } | undefined;

export const forgetHeld = () => {
	cache = undefined;
};

async function heldNames(): Promise<Held[]> {
	if (cache && Date.now() - cache.at < 60_000) return cache.held;
	const rows = await sql`
		select u.screen_name as name, u.id::text as user_id from users u where u.status = 'suspended' and u.deactivated_at is null and u.role is null
		union all
		select c.old_name, u.id::text from username_changes c join users u on u.id = c.user_id where u.status = 'suspended' and u.deactivated_at is null and u.role is null
		union all
		select value, user_id::text from retired_identities where kind = 'handle'`;
	const held = rows.map((r: any) => ({
		skeleton: skeleton(r.name),
		userId: r.user_id,
	}));
	cache = { at: Date.now(), held };
	return held;
}

export async function handleHeld(
	wanted: string,
	forUserId?: string,
): Promise<boolean> {
	const s = skeleton(wanted);
	if (!s) return false;
	return (await heldNames()).some(
		(h) => h.skeleton === s && h.userId !== forUserId,
	);
}

export async function retireAccount(userId: string, reason: string) {
	const [u] =
		await sql`select screen_name, email from users where id = ${userId}::bigint`;
	if (!u) return;
	const handles = [
		u.screen_name,
		...(
			await sql`select old_name from username_changes where user_id = ${userId}::bigint`
		).map((r: any) => r.old_name),
	];
	const ips = (
		await sql`select distinct ip from login_events where user_id = ${userId}::bigint and ip is not null and created_at > now() - interval '30 days'`
	).map((r: any) => r.ip);
	const rows = [
		...handles.map((h) => ({ kind: "handle", value: h.toLowerCase() })),
		...(u.email
			? [{ kind: "email", value: String(u.email).toLowerCase() }]
			: []),
		...ips.map((ip: string) => ({ kind: "ip", value: ip })),
	];
	for (const r of rows)
		await sql`insert into retired_identities (kind, value, user_id, reason) values (${r.kind}, ${r.value}, ${userId}::bigint, ${reason})
			on conflict (kind, value) do update set created_at = now(), user_id = excluded.user_id, reason = excluded.reason`;
	forgetHeld();
}
