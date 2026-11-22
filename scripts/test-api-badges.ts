// The public API's account shape agrees with what the web client shows: the
// checkmark and its "Verified since", organisations and their affiliates,
// the badges after a name, and profile labels. Against a migrated, disposable
// local database.
import { strict as assert } from "node:assert";
import { sql } from "../src/db";
import { newId } from "../src/ids";
import { createToken, publicApi } from "../src/public-api";
import { applyUser } from "../src/federation-sync";
import { PUBLIC_ORIGIN } from "../src/config";
import { isOrganizationSql } from "../src/users";
import { menuLinks } from "../src/tidy";

const database = new URL(process.env.DATABASE_URL ?? "postgres://localhost/xitter");
assert(["localhost", "127.0.0.1"].includes(database.hostname) && /test|codex/.test(database.pathname), "Use a disposable local test database.");

const ids = { org: newId(), lonelyOrg: newId(), unverifiedOrg: newId(), person: newId(), labelled: newId(), member: newId(), plain: newId() };
const badge = newId(), label = newId();
const tag = ids.org.slice(-8);
const name = (k: keyof typeof ids) => `${k.slice(0, 6)}_${tag}`;
const peer = `peer-${tag}.example`;
const remoteId = String(BigInt(ids.org) + 7n);
const get = async (token: string, path: string) => {
	const url = new URL(`${PUBLIC_ORIGIN}/api/v1${path}`);
	const res = await publicApi(new Request(url, { headers: { authorization: `Bearer ${token}` } }), url);
	assert.equal(res.status, 200, path);
	return (await res.json()).data;
};

try {
	const verifiedAt = "2025-03-01T10:00:00.000Z", joinedAt = "2025-06-15T12:00:00.000Z";
	await sql`insert into users(id, screen_name, name, password_hash, verified_type, verified_at, avatar_url) values
		(${ids.org}::bigint, ${name("org")}, 'Example Org', 'unused', 'business', ${verifiedAt}, '/media/org.png'),
		(${ids.lonelyOrg}::bigint, ${name("lonelyOrg")}, 'Lonely Org', 'unused', 'business', ${verifiedAt}, null),
		(${ids.unverifiedOrg}::bigint, ${name("unverifiedOrg")}, 'Club', 'unused', null, null, null),
		(${ids.person}::bigint, ${name("person")}, 'Affiliate', 'unused', null, null, null),
		(${ids.labelled}::bigint, ${name("labelled")}, 'Labelled', 'unused', null, null, null),
		(${ids.member}::bigint, ${name("member")}, 'Member', 'unused', null, null, null),
		(${ids.plain}::bigint, ${name("plain")}, 'Plain', 'unused', null, null, null)`;
	await sql`update users set flag = 'pride,trans', parody_label = 'Fan', automated_by = ${ids.org}::bigint where id = ${ids.person}::bigint`;
	await sql`insert into affiliations(org_id, user_id, created_at) values
		(${ids.org}::bigint, ${ids.person}::bigint, ${joinedAt}),
		(${ids.unverifiedOrg}::bigint, ${ids.member}::bigint, now())`;
	await sql`insert into custom_badges(id, name, image, mime) values(${badge}::bigint, 'Early supporter', '\\x00'::bytea, 'image/png')`;
	await sql`insert into user_badges(user_id, badge_id) values(${ids.person}::bigint, ${badge}::bigint)`;
	await sql`insert into account_labels(id, text, badge_id, url) values(${label}::bigint, 'State-affiliated media', ${badge}::bigint, 'https://example.org/about')`;
	await sql`update users set label_id = ${label}::bigint, parody_label = 'None' where id = ${ids.labelled}::bigint`;
	const viewer = newId();
	await sql`insert into users(id, screen_name, name, password_hash) values(${viewer}::bigint, ${`viewer_${tag}`}, 'Viewer', 'unused')`;
	const token = await createToken(viewer, "badges test", "read");

	// an organisation: verified since its badge, with its affiliate count
	const o = await get(token, `/users/${name("org")}`);
	assert.deepEqual([o.verified_type, o.verified, o.verified_since, o.organization, o.affiliates_count], ["business", true, verifiedAt, true, 1]);

	// an organisation with no affiliates still says so
	const lonely = await get(token, `/users/${name("lonelyOrg")}`);
	assert.equal(lonely.affiliates_count, 0, "affiliates_count is 0, not missing");

	// an account with affiliates is a business account even without a badge
	const club = await get(token, `/users/${name("unverifiedOrg")}`);
	assert.deepEqual([club.organization, club.affiliates_count, club.verified], [true, 1, false]);

	// the same rule in SQL (the admin panel's organisation list, the Organisation menu)
	const orgs = await sql`select u.id::text from users u where ${isOrganizationSql(sql`u`)} and u.id = any(${sql.array(Object.values(ids), "INT8")})`;
	assert.deepEqual(orgs.map((r: { id: string }) => r.id).sort(), [ids.org, ids.lonelyOrg, ids.unverifiedOrg].sort(), "SQL and TypeScript agree on organisations");
	const hasMenu = async (id: string) => (await menuLinks(id)).some((l) => l.href === "/account/organisation");
	assert.deepEqual([await hasMenu(ids.unverifiedOrg), await hasMenu(ids.member), await hasMenu(ids.plain)], [true, true, false], "Organisation menu for organisations and their people");

	// a gold organisation with self-service affiliate adding turned off keeps its badge and org flag,
	// without showing the Organisation menu until it has affiliates
	await sql`update users set allow_affiliates = false where id = ${ids.lonelyOrg}::bigint`;
	const solo = await get(token, `/users/${name("lonelyOrg")}`);
	assert.deepEqual([solo.verified_type, solo.verified, solo.organization, solo.affiliates_count], ["business", true, true, 0]);
	assert.equal(await hasMenu(ids.lonelyOrg), false, "no Organisation menu while allow_affiliates is off and it has no affiliates");

	// an affiliate: the checkmark the app shows, dated from joining the organisation
	const a = await get(token, `/users/${name("person")}`);
	assert.deepEqual([a.verified_type, a.verified, a.verified_since, a.organization], [null, true, joinedAt, false]);
	assert.deepEqual(a.affiliations, [{ screen_name: name("org"), name: "Example Org", badge_url: `${PUBLIC_ORIGIN}/media/org.png` }]);
	assert.deepEqual(a.badges, [
		{ name: "Early supporter", url: `${PUBLIC_ORIGIN}/public/badge-${badge}.png` },
		{ name: "Pride flag", url: `${PUBLIC_ORIGIN}/public/flag-pride.svg` },
		{ name: "Transgender flag", url: `${PUBLIC_ORIGIN}/public/flag-trans.svg` },
	], "custom badges, then flags");
	assert.deepEqual([a.parody_label, a.label, a.automated_by], ["Fan", null, name("org")]);
	assert(!("affiliates_count" in a), "only organisations have affiliates_count");

	// an organisation without a picture: its badge falls back to the default picture, as in the app
	await sql`insert into affiliations(org_id, user_id) values(${ids.lonelyOrg}::bigint, ${ids.labelled}::bigint)`;
	assert.equal(await hasMenu(ids.lonelyOrg), true, "Organisation menu returns when it has existing affiliates");
	const l = await get(token, `/users/${name("labelled")}`);
	assert.match(l.affiliations[0].badge_url, /^https?:\/\/.+\/default_profile_images\//, "no broken badge image");
	// a label staff gave: shown, while parody_label stays empty
	assert.deepEqual(l.label, { text: "State-affiliated media", url: "https://example.org/about", badge_url: `${PUBLIC_ORIGIN}/public/badge-${badge}.png` });
	assert.equal(l.parody_label, null);

	// nothing to show: empty, not missing
	const p = await get(token, `/users/${name("plain")}`);
	assert.deepEqual(
		[p.affiliations, p.badges, p.parody_label, p.label, p.automated_by, p.verified, p.verified_since, p.organization],
		[[], [], null, null, null, false, null, false],
	);

	// the same shape on post authors
	const post = newId();
	await sql`insert into posts(id, user_id, text, conversation_id) values(${post}::bigint, ${ids.person}::bigint, 'hello', ${post}::bigint)`;
	assert.equal((await get(token, `/posts/${post}`)).author.affiliations[0]?.screen_name, name("org"), "post authors carry affiliations");

	// an account from another instance: its verified date arrives with it, and it wears the globe
	const remoteVerified = "2024-11-05T08:30:00.000Z";
	const local = await applyUser(peer, { id: remoteId, screen_name: `rem_${tag}`, name: "Remote", verified_type: "blue", verified_at: remoteVerified, created_at: "2024-01-01T00:00:00.000Z" });
	assert(local, "remote account stored");
	const r = await get(token, `/users/${encodeURIComponent(`rem_${tag}@${peer}`)}`);
	assert.deepEqual([r.verified, r.verified_since], [true, remoteVerified], "verified_since federates");
	assert(r.badges.some((b: { url: string }) => b.url.includes("/public/globe.svg")), "another instance's account wears the globe");
	// from an instance that doesn't send the date yet: unknown, and a later badge loss clears it
	await applyUser(peer, { id: remoteId, screen_name: `rem_${tag}`, name: "Remote", verified_type: null, verified_at: remoteVerified });
	assert.deepEqual((await sql`select verified_type, verified_at from users where id = ${local}::bigint`)[0], { verified_type: null, verified_at: null });

	console.log("API badge, label, organisation and verified-since checks passed");
} finally {
	await sql`delete from users where id = any(${sql.array(Object.values(ids), "INT8")}) or screen_name = ${`viewer_${tag}`} or instance = ${peer}`;
	await sql`delete from account_labels where id = ${label}::bigint`;
	await sql`delete from custom_badges where id = ${badge}::bigint`;
	await sql.close();
}
