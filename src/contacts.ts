// Uploaded address books (Settings > Privacy > Discoverability and contacts >
// Manage contacts). The client uploads from the browser's Contacts Picker in
// sign-up's contacts step (Chrome on Android); the dashboard lists them as
// vCards and removes them all at once. Who-to-follow puts uploaded contacts
// first, but only accounts that let themselves be found by email.

import { holdLock, sql } from "./db";
import { isId, newId } from "./ids";

const MAX_CONTACTS = 5000;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}$/;

// vCard text must not carry line breaks or the separators of its own syntax
const field = (v: unknown) => String(v ?? "").replace(/[\r\n]+/g, " ").replace(/[\\;,]/g, (c) => `\\${c}`).slice(0, 200);

export async function uploadContacts(userId: string, contacts: unknown): Promise<number> {
	if (!Array.isArray(contacts)) return 0;
	const rows: { id: string; vcard: string; emails: string[] }[] = [];
	for (const c of contacts.slice(0, MAX_CONTACTS)) {
		if (!c || typeof c !== "object") continue;
		const name = field((c as any).name);
		const emails = (Array.isArray((c as any).email_addresses) ? (c as any).email_addresses : []).map((e: unknown) => String(e).trim().toLowerCase()).filter((e: string) => EMAIL.test(e)).slice(0, 10);
		const phones = (Array.isArray((c as any).phone_numbers) ? (c as any).phone_numbers : []).map((p: unknown) => String(p).replace(/[^\d+]/g, "")).filter((p: string) => p.length >= 3).slice(0, 10);
		if (!name && !emails.length && !phones.length) continue;
		const vcard = ["BEGIN:VCARD", "VERSION:3.0", `FN:${name}`, ...emails.map((e: string) => `EMAIL:${field(e)}`), ...phones.map((p: string) => `TEL:${p}`), "END:VCARD"].join("\r\n");
		rows.push({ id: newId(), vcard, emails });
	}
	return sql.begin(async (tx) => {
		await holdLock(tx, `contacts:${userId}`);
		const [{ have }] = await tx`select count(*)::int as have from contacts where user_id = ${userId}::bigint`;
		const kept = rows.slice(0, Math.max(MAX_CONTACTS - have, 0));
		if (!kept.length) return 0;
		await tx`insert into contacts (id, user_id, vcard, emails)
			select (c->>'id')::bigint, ${userId}::bigint, c->>'vcard', array(select jsonb_array_elements_text(c->'emails'))
			from jsonb_array_elements(${JSON.stringify(kept)}::text::jsonb) c`;
		return kept.length;
	});
}

// pages are oldest first; the cursor is the last id shown
export async function addressBook(userId: string, cursor: string | null, count: number) {
	const after = isId(cursor ?? "") ? cursor! : "0";
	const rows = await sql`select id::text as id_str, vcard from contacts where user_id = ${userId}::bigint and id > ${after}::bigint
		order by id limit ${Math.min(Math.max(count, 1), 100) + 1}`;
	const more = rows.length > Math.min(Math.max(count, 1), 100);
	const page = (more ? rows.slice(0, -1) : rows) as { id_str: string; vcard: string }[];
	return { contacts: page, next_cursor: more ? page[page.length - 1].id_str : null };
}

export async function deleteContacts(userId: string) {
	await sql`delete from contacts where user_id = ${userId}::bigint`;
}
