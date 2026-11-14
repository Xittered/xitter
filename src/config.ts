export const PORT = Number(process.env.PORT ?? 3000);
// where browsers reach this instance, e.g. https://xit.example.org
export const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN ?? `http://localhost:${PORT}`).replace(/\/$/, "");
export const PUBLIC_HOSTNAME = new URL(PUBLIC_ORIGIN).hostname;
// other sites of this instance that may make and use its passkeys, e.g.
// https://m.xit.example.org; browsers only allow subdomains of PUBLIC_HOSTNAME
export const PASSKEY_ORIGINS = [
	PUBLIC_ORIGIN,
	...(process.env.PASSKEY_ORIGINS ?? "")
		.split(",")
		.map((s) => s.trim().replace(/\/$/, ""))
		.filter((s) => /^https:\/\/[^/]+$/.test(s) && new URL(s).hostname.endsWith("." + PUBLIC_HOSTNAME)),
];
