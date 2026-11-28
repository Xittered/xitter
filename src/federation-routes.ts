import { FEDERATION_ON, INSTANCE_ID, keyFor, loadRegistry, refreshRegistry, verifyIncoming, wellKnown } from "./federation";
import { federationApi, startFederationSync } from "./federation-sync";
import { hit, limitedResponse } from "./ratelimit";
import { emergencyApi, endSuperadminVisits, pollEmergencies } from "./superadmin";
import { SUPERADMINS } from "./superadmins";
import { moneyFederationApi, startMoneyFederation } from "./money-federation";

let ready = false;

export async function federationRoute(req: Request, url: URL): Promise<Response | undefined> {
	const p = url.pathname;
	if (p === "/.well-known/xitter") return wellKnown();
	if (!p.startsWith("/federation/v1/")) return undefined;
	if (!ready) return Response.json({ error: "Starting up, try again in a moment." }, { status: 503, headers: { "retry-after": "5" } });
	const path = `${p}${url.search}`;
	const incoming = await verifyIncoming(req, path, { allowSuperadminHome: p === "/federation/v1/emergency", allowListed: p === "/federation/v1/emergencies" });
	if (incoming instanceof Response) return incoming;
	const h = hit("federation", incoming.from);
	if (!h.ok) return limitedResponse(h);
	return (await emergencyApi(incoming, req.method, p)) ?? (await moneyFederationApi(incoming, req.method, path)) ?? federationApi(incoming, req.method, p, url);
}

export async function startFederation() {
	await loadRegistry();
	ready = true;
	if (!FEDERATION_ON) return;
	void refreshRegistry().catch((e) => console.error("federation registry:", e));
	setInterval(() => void refreshRegistry().catch((e) => console.error("federation registry:", e)), 5 * 60_000).unref();
	startFederationSync();
	startMoneyFederation();
	const meetHomes = () => Promise.all([...new Set(SUPERADMINS.map((s) => s.instance))].filter((i) => i !== INSTANCE_ID).map((i) => keyFor(i).catch(() => undefined)));
	void meetHomes().catch((e) => console.error("federation homes:", e));
	setInterval(() => void meetHomes().catch((e) => console.error("federation homes:", e)), 10 * 60_000).unref();
	setInterval(() => void pollEmergencies().catch(() => {}), 60_000).unref();
	setInterval(() => void endSuperadminVisits().catch(() => {}), 60_000).unref();
}
