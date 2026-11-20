import { accountPage, esc } from "./account-page";
import { type Ad, AdError, cancelAd, createAd, currentPrice, estimateViews, extendAd, myAds, pauseAd } from "./ads";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { formatCents } from "./money";
import { settings } from "./settings";

const CSS = `.ads{display:grid;gap:12px}
.ad .text{white-space:pre-wrap;color:var(--text)}
.ad .link{font-size:14px;word-break:break-all}
.ad .acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
.ad details{margin-top:8px}
.ad summary{cursor:pointer;color:var(--accent);font-size:14px;font-weight:700;width:max-content}
.ad details form{margin-top:12px}
.bar-track{height:4px;border-radius:2px;background:var(--surface);overflow:hidden;margin-top:6px}
.bar-fill{height:100%;background:var(--accent);transition:width 300ms ease-out}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%}
.pair>div{display:grid;gap:12px}
.status{font-size:13px;font-weight:700}
.status.running{color:var(--success)}
.status.rejected,.status.cancelled{color:var(--danger)}
.who{display:grid;gap:8px;width:100%}
.who label{display:flex;gap:10px;align-items:flex-start;margin:0;border:1px solid var(--border);border-radius:12px;padding:10px 12px;cursor:pointer;color:var(--text);font-size:15px;line-height:20px}
.who label:has(input:checked){border-color:var(--text)}
.who input{width:18px;min-height:18px;height:18px;margin:2px 0 0;padding:0;flex:none;accent-color:var(--accent)}
.price{font-variant-numeric:tabular-nums}`;

const STATUS: Record<Ad["status"], string> = {
	pending: "Waiting for review",
	running: "Running",
	paused: "Paused",
	ended: "Ended",
	rejected: "Rejected",
	cancelled: "Cancelled",
};

const toCents = (v: FormDataEntryValue | null) => {
	const s = String(v ?? "").trim().replace(/^\$/, "");
	if (!s) return 0;
	if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return Number.NaN;
	return Math.round(Number(s) * 100);
};

const when = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function adCard(ad: Ad, csrf: string, maxDays: number) {
	const live = ad.status === "running" || ad.status === "paused";
	const left = ad.endsAt ? Math.max(0, ad.endsAt.getTime() - Date.now()) : 0;
	const roomDays = Math.floor((maxDays * 86_400_000 - left) / 86_400_000);
	const pct = ad.budgetCents ? Math.min(100, Math.round((ad.spentCents / ad.budgetCents) * 100)) : 0;
	const lines = [
		`${formatCents(ad.spentCents)} of ${formatCents(ad.budgetCents)} spent`,
		`${ad.views.toLocaleString("en-US")} ${ad.views === 1 ? "view" : "views"}`,
		ad.adOnly ? "Only as an ad" : "Also on your profile",
	];
	if (live && ad.endsAt) lines.push(`ends ${when(ad.endsAt)}`);
	if (ad.status === "pending") lines.push(`runs ${ad.days} ${ad.days === 1 ? "day" : "days"} once approved`);
	if (ad.refundedCents) lines.push(`${formatCents(ad.refundedCents)} refunded`);
	const form = (action: string, label: string, cls = "secondary small") =>
		`<form class="inline" method="post" action="/account/ads/${ad.id}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="${action}"><button type="submit" class="${cls}">${label}</button></form>`;
	const acts = [
		ad.postId && ad.status !== "pending" ? `<a class="link" href="/i/status/${ad.postId}" target="_top">View post</a>` : "",
		ad.status === "running" ? form("pause", "Pause") : "",
		ad.status === "paused" ? form("resume", "Resume", "small") : "",
		["pending", "running", "paused"].includes(ad.status) ? form("cancel", ad.status === "pending" ? "Withdraw" : "Stop and refund", "danger small") : "",
	].filter(Boolean);
	const extend = live
		? `<details><summary>Extend</summary><form method="post" action="/account/ads/${ad.id}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="extend">
<div class="pair"><div><label for="b${ad.id}">Add Equicoins</label><input id="b${ad.id}" name="budget" inputmode="decimal" placeholder="0.00"></div>
<div><label for="d${ad.id}">Add days</label><input id="d${ad.id}" name="days" type="number" min="0" max="${Math.max(0, roomDays)}" placeholder="0"${roomDays < 1 ? " disabled" : ""}></div></div>
<button type="submit" class="small">Extend</button></form></details>`
		: "";
	return `<div class="card ad"><div class="split"><span class="status ${ad.status}">${STATUS[ad.status]}</span><span class="meta">${when(ad.createdAt)}</span></div>
<p class="text">${esc(ad.text)}</p>${ad.url ? `<a class="link" href="${esc(ad.url)}" target="_blank" rel="noopener noreferrer">${esc(ad.url)}</a>` : ""}
${ad.status === "rejected" && ad.rejectReason ? `<p class="error">${esc(ad.rejectReason)}</p>` : ""}
<div class="meta">${lines.join(" · ")}</div>${live ? `<div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>` : ""}
${acts.length ? `<div class="acts">${acts.join("")}</div>` : ""}${extend}</div>`;
}

async function page(req: Request, viewer: Viewer, opts: { error?: string; notice?: string; draft?: Record<string, string> } = {}) {
	const rules = settings().ads;
	if (!rules.enabled) return accountPage({ req, viewer, title: "Ads Manager", body: `<h1>Ads Manager</h1><p class="dim">Ads aren't open on this instance.</p>` });
	const [ads, cpm, [wallet]] = await Promise.all([myAds(viewer.id), currentPrice(), sql`select balance_cents::bigint as cents from money_wallets where user_id = ${viewer.id}::bigint`]);
	const balance = Number(wallet?.cents ?? 0);
	const d = opts.draft ?? {};
	const adOnly = d.who !== "everyone";
	const perDollar = estimateViews(100, cpm);
	const body = `<h1>Ads Manager</h1>
<p class="dim">Pay in Equicoins to show a post in people's timelines. A bigger budget reaches more people. Staff review every ad first, and a rejected ad gets ${rules.reject_refund_pct}% of its budget back.</p>
${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ""}${opts.notice ? `<p class="card success" role="status">${esc(opts.notice)}</p>` : ""}
<h2>New ad</h2>
<form method="post" action="/account/ads">
<input type="hidden" name="csrf" value="${esc(viewer.csrf)}">
<label for="text">What it says</label><textarea id="text" name="text" maxlength="280" required>${esc(d.text ?? "")}</textarea>
<label for="url">Link</label><input id="url" name="url" type="url" placeholder="https://" value="${esc(d.url ?? "")}">
<div class="pair"><div><label for="budget">Budget in Equicoins</label><input id="budget" name="budget" inputmode="decimal" required placeholder="${(rules.min_spend_cents / 100).toFixed(2)}" value="${esc(d.budget ?? "")}"></div>
<div><label for="days">Days</label><input id="days" name="days" type="number" min="1" max="${rules.max_days}" required value="${esc(d.days ?? String(rules.max_days))}"></div></div>
<div class="who">
<label><input type="radio" name="who" value="ad"${adOnly ? " checked" : ""}><span><b>Only as an ad</b><br><span class="dim">The post shows up only in timelines as an ad, never on your profile.</span></span></label>
<label><input type="radio" name="who" value="everyone"${adOnly ? "" : " checked"}><span><b>Also on your profile</b><br><span class="dim">The post is a normal post anyone can see, and it also runs as an ad.</span></span></label>
</div>
<p class="dim price">The minimum is ${formatCents(rules.min_spend_cents)}. Right now each Equicoin buys about ${perDollar.toLocaleString("en-US")} views, and the price rises as more Equicoins go into ads. You have ${formatCents(balance)}.</p>
<button type="submit">Send for review</button>
</form>
<h2>Your ads</h2>
${ads.length ? `<div class="ads">${ads.map((a) => adCard(a, viewer.csrf, rules.max_days)).join("")}</div>` : `<p class="dim">You haven't made any ads yet.</p>`}
<p class="dim">Don't want to see ads? <a href="/account/labels">Hide them for free</a>.</p>`;
	return accountPage({ req, viewer, title: "Ads Manager", css: CSS, body, status: opts.error ? 400 : 200 });
}

const back = (notice: string) => new Response(null, { status: 303, headers: { location: `/account/ads?done=${encodeURIComponent(notice)}` } });

const NOTICES: Record<string, string> = {
	sent: "Your ad is waiting for review.",
	paused: "Your ad is paused.",
	resumed: "Your ad is running again.",
	cancelled: "Your ad is stopped and what it didn't spend is back in your wallet.",
	extended: "Your ad is extended.",
};

export async function adsRoute(req: Request, viewer: Viewer, path: string): Promise<Response> {
	const url = new URL(req.url);
	if (req.method !== "POST") return page(req, viewer, { notice: NOTICES[url.searchParams.get("done") ?? ""] });
	const form = await req.formData().catch(() => undefined);
	if (String(form?.get("csrf") ?? "") !== viewer.csrf) return page(req, viewer, { error: "That form is out of date. Try again." });
	const id = /^\/account\/ads\/(\d{1,19})$/.exec(path)?.[1];
	const draft = Object.fromEntries(["text", "url", "budget", "days", "who"].map((k) => [k, String(form?.get(k) ?? "")]));
	try {
		if (!id) {
			const budgetCents = toCents(form?.get("budget") ?? null);
			if (Number.isNaN(budgetCents)) throw new AdError("Write the budget as an amount, like 5 or 5.50.");
			await createAd(viewer.id, { text: draft.text, url: draft.url, budgetCents, days: Number(draft.days), adOnly: draft.who !== "everyone" });
			return back("sent");
		}
		const action = String(form?.get("action") ?? "");
		if (action === "pause" || action === "resume") {
			await pauseAd(viewer.id, id, action === "pause");
			return back(action === "pause" ? "paused" : "resumed");
		}
		if (action === "cancel") {
			await cancelAd(viewer.id, id);
			return back("cancelled");
		}
		if (action === "extend") {
			const budgetCents = toCents(form?.get("budget") ?? null);
			if (Number.isNaN(budgetCents)) throw new AdError("Write the amount like 5 or 5.50.");
			await extendAd(viewer.id, id, { budgetCents, days: Number(form?.get("days") || 0) });
			return back("extended");
		}
		throw new AdError("That isn't something you can do to an ad.");
	} catch (e) {
		if (e instanceof AdError) return page(req, viewer, { error: e.message, draft: id ? undefined : draft });
		throw e;
	}
}
