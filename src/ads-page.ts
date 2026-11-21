import { accountPage, esc } from "./account-page";
import {
	type Ad,
	AdError,
	type AdStats,
	adStats,
	cancelAd,
	createAd,
	currentPrice,
	estimateViews,
	extendAd,
	myAds,
	pauseAd,
	promotablePosts,
	renameAd,
	userAdDays,
} from "./ads";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { formatCents } from "./money";
import { settings } from "./settings";

const CSS = `.head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
a.button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:0 16px;border-radius:9999px;background:var(--accent-fill,var(--accent));color:var(--accent-text,#fff);font-weight:700;white-space:nowrap;transition:scale 200ms ease-out}
a.button.secondary{background:transparent;border:1px solid var(--outline);color:var(--text)}
a.button:active{scale:.97}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.tiles>div{background:var(--surface);border-radius:12px;padding:10px 12px;min-width:0}
.tiles b{display:block;font-size:20px;line-height:24px;font-weight:800;font-variant-numeric:tabular-nums;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tiles span{font-size:13px;line-height:16px;color:var(--muted)}
.panel{border:1px solid var(--border);border-radius:16px;padding:16px;display:grid;gap:12px}
.panel h2{margin:0;font-size:17px;line-height:20px}
.chart{display:flex;align-items:flex-end;gap:4px;height:120px}
.chart>div{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:6px;height:100%;min-width:0}
.chart i{display:block;width:100%;min-height:2px;border-radius:4px 4px 0 0;background:var(--accent)}
.chart i.zero{background:var(--border)}
.chart small{font-size:11px;line-height:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--border);overflow:auto hidden;scrollbar-width:none}
.tabs a{padding:12px 14px;color:var(--muted);font-weight:700;white-space:nowrap;border-bottom:4px solid transparent;margin-bottom:-1px}
.tabs a[aria-current]{color:var(--text);border-color:var(--accent)}
.tabs a:hover{text-decoration:none}
.list{display:grid}
.camp{display:grid;grid-template-columns:1fr auto;gap:4px 16px;padding:14px 4px;border-bottom:1px solid var(--border);color:var(--text);border-radius:4px}
.camp:hover{text-decoration:none}
.camp .name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.camp .nums{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.camp .meta{grid-column:1/-1;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.camp .track{grid-column:1/-1}
.state{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;white-space:nowrap}
.state::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--muted)}
.state.running::before{background:var(--success)}
.state.pending::before{background:var(--warning)}
.state.paused::before{background:var(--outline)}
.state.rejected::before,.state.cancelled::before{background:var(--danger)}
.track{height:4px;border-radius:2px;background:var(--surface);overflow:hidden}
.track i{display:block;height:100%;background:var(--accent)}
.preview{border:1px solid var(--border);border-radius:16px;padding:12px 16px;display:grid;grid-template-columns:40px 1fr;gap:12px}
.preview .avatar{width:40px;height:40px;border-radius:50%;background:var(--surface) center/cover;outline:1px solid rgb(0 0 0 / .08);outline-offset:-1px}
.preview .who{display:flex;gap:4px;min-width:0;white-space:nowrap;overflow:hidden}
.preview .who b{overflow:hidden;text-overflow:ellipsis}
.preview .who span{color:var(--muted)}
.preview p{white-space:pre-wrap;color:var(--text)}
.preview .tag{color:var(--muted);font-size:13px;display:flex;align-items:center;gap:4px;margin-top:6px}
.choice{display:grid;grid-template-columns:1fr 1fr;gap:8px;width:100%}
.choice label,.posts label{display:flex;gap:10px;align-items:flex-start;margin:0;border:1px solid var(--border);border-radius:12px;padding:12px;cursor:pointer;color:var(--text);font-size:15px;line-height:20px;transition:border-color 150ms ease-out}
.choice label:has(input:checked),.posts label:has(input:checked){border-color:var(--accent);background:rgb(29 155 240 / .06)}
.choice input,.posts input{width:18px;min-height:18px;height:18px;margin:1px 0 0;padding:0;flex:none;accent-color:var(--accent)}
.choice small,.posts small{display:block;color:var(--muted);font-size:13px;line-height:16px}
.posts{display:grid;gap:8px;width:100%;max-height:380px;overflow-y:auto;padding:2px}
.posts span{min-width:0;flex:1}
.posts q{quotes:none;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
form.make{gap:20px}
form.make section{display:grid;gap:12px;width:100%}
form.make h2{margin:0;font-size:17px;line-height:20px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px;width:100%}
.pair>div{display:grid;gap:8px;align-content:start}
.presets{display:flex;gap:6px;flex-wrap:wrap}
.presets button{min-height:32px;padding:0 12px;font-size:14px}
.estimate{font-variant-numeric:tabular-nums}
.sum{display:grid;gap:6px;width:100%;background:var(--surface);border-radius:12px;padding:12px 16px}
.sum div{display:flex;justify-content:space-between;gap:12px;font-variant-numeric:tabular-nums}
.sum div span:first-child{color:var(--muted)}
.fields{display:grid;gap:12px;width:100%}
.mode-post .only-new,.mode-new .only-post{display:none}
.acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
details summary{cursor:pointer;color:var(--accent);font-weight:700;width:max-content}
details form{margin-top:12px}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0;font-variant-numeric:tabular-nums}
dt{color:var(--muted)}
dd{margin:0}
.empty{text-align:center;padding:32px 16px;display:grid;gap:8px;justify-items:center}
@media (hover:hover){a.button:hover{background:var(--accent-hover);text-decoration:none}a.button.secondary:hover{background:var(--hover)}.camp:hover{background:var(--hover)}.tabs a:hover{color:var(--text)}}
@media (max-width:520px){.tiles{grid-template-columns:repeat(2,1fr)}.choice,.pair{grid-template-columns:1fr}}`;

const STATUS: Record<Ad["status"], string> = {
	pending: "In review",
	running: "Running",
	paused: "Paused",
	ended: "Ended",
	rejected: "Rejected",
	cancelled: "Stopped",
};

const FILTERS: Record<string, { label: string; has: Ad["status"][] }> = {
	active: { label: "Active", has: ["running", "paused", "pending"] },
	done: { label: "Finished", has: ["ended", "cancelled", "rejected"] },
	all: { label: "All", has: ["pending", "running", "paused", "ended", "rejected", "cancelled"] },
};

const toCents = (v: FormDataEntryValue | null | undefined) => {
	const s = String(v ?? "").trim().replace(/^\$/, "");
	if (!s) return 0;
	if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return Number.NaN;
	return Math.round(Number(s) * 100);
};

const when = (d: Date) => d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const num = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const title = (ad: Ad) => ad.name || ad.text.split("\n")[0].slice(0, 80) || "Untitled campaign";
const perThousand = (ad: Pick<Ad, "views" | "spentCents">) => (ad.views ? formatCents(Math.round((ad.spentCents * 1000) / ad.views)) : "None yet");
const hidden = (csrf: string, action?: string) =>
	`<input type="hidden" name="csrf" value="${esc(csrf)}">${action ? `<input type="hidden" name="action" value="${action}">` : ""}`;

function bars(days: { day: string; views: number }[]) {
	const max = Math.max(1, ...days.map((d) => d.views));
	const label = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", days.length > 10 ? { day: "numeric" } : { weekday: "short" });
	return `<div class="chart" role="img" aria-label="Views per day">${days
		.map((d) => `<div title="${d.day}: ${plural(d.views, "view")}"><i class="${d.views ? "" : "zero"}" style="height:${Math.round((d.views / max) * 100)}%"></i><small>${label(d.day)}</small></div>`)
		.join("")}</div>`;
}

const lastDays = (n: number, byDay: Map<string, number>) =>
	Array.from({ length: n }, (_, i) => {
		const day = new Date(Date.now() - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
		return { day, views: byDay.get(day) ?? 0 };
	});

const tiles = (list: [string, string][]) => `<div class="tiles">${list.map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("")}</div>`;

const notices = (opts: { error?: string; notice?: string }) =>
	`${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ""}${opts.notice ? `<p class="card success" role="status">${esc(opts.notice)}</p>` : ""}`;

const closed = (req: Request, viewer: Viewer) =>
	accountPage({ req, viewer, title: "Ads Manager", body: `<h1>Ads Manager</h1><p class="dim">Ads aren't open on this instance.</p>` });

async function balanceOf(userId: string) {
	const [wallet] = await sql`select balance_cents::bigint as cents from money_wallets where user_id = ${userId}::bigint`;
	return Number(wallet?.cents ?? 0);
}

function row(ad: Ad) {
	const pct = ad.budgetCents ? Math.min(100, Math.round((ad.spentCents / ad.budgetCents) * 100)) : 0;
	const live = ad.status === "running" || ad.status === "paused";
	const end = ad.status === "pending" ? `${plural(ad.days, "day")} once approved` : live && ad.endsAt && ad.status === "running" ? `ends ${when(ad.endsAt)}` : when(ad.createdAt);
	return `<a class="camp" href="/account/ads/${ad.id}"><span class="name" title="${esc(title(ad))}">${esc(title(ad))}</span>
<span class="nums">${plural(ad.views, "view")}</span>
<span class="meta"><span class="state ${ad.status}">${STATUS[ad.status]}</span><span class="dim">· ${ad.existingPost ? "Promoted post" : "New ad"} · ${formatCents(ad.spentCents)} of ${formatCents(ad.budgetCents)} · ${end}</span></span>
${live ? `<span class="track" aria-hidden="true"><i style="width:${pct}%"></i></span>` : ""}</a>`;
}

async function dashboard(req: Request, viewer: Viewer, opts: { error?: string; notice?: string } = {}) {
	const url = new URL(req.url);
	const show = FILTERS[url.searchParams.get("show") ?? ""] ? (url.searchParams.get("show") as string) : "active";
	const [ads, balance, recent] = await Promise.all([myAds(viewer.id), balanceOf(viewer.id), userAdDays(viewer.id, 14)]);
	const views = ads.reduce((s, a) => s + a.views, 0);
	const spent = ads.reduce((s, a) => s + a.spentCents, 0);
	const running = ads.filter((a) => a.status === "running").length;
	const listed = ads.filter((a) => FILTERS[show].has.includes(a.status));
	const counts = Object.fromEntries(Object.entries(FILTERS).map(([k, f]) => [k, ads.filter((a) => f.has.includes(a.status)).length]));
	const days = lastDays(14, recent.byDay);
	const recentViews = days.reduce((s, d) => s + d.views, 0);
	const body = `<div class="head"><h1>Ads Manager</h1>${ads.length ? `<a class="button" href="/account/ads/new">Create campaign</a>` : ""}</div>
${notices(opts)}
${ads.length ? `${tiles([
	[num(views), "Views"],
	[num(recent.reach), "People reached"],
	[formatCents(spent), "Spent"],
	[perThousand({ views, spentCents: spent }), "Per 1000 views"],
])}
<div class="panel"><div class="head"><h2>Last 14 days</h2><span class="dim">${plural(recentViews, "view")} · ${plural(running, "campaign")} running</span></div>${bars(days)}</div>
<nav class="tabs" aria-label="Campaigns">${Object.entries(FILTERS)
	.map(([k, f]) => `<a href="/account/ads?show=${k}"${k === show ? ' aria-current="page"' : ""}>${f.label} ${counts[k] ? `<span class="dim">${counts[k]}</span>` : ""}</a>`)
	.join("")}</nav>
${listed.length ? `<div class="list">${listed.map(row).join("")}</div>` : `<p class="dim empty">No ${FILTERS[show].label.toLowerCase()} campaigns.</p>`}`
	: `<div class="panel empty"><h2>Run your first campaign</h2><p class="dim">Promote one of your posts, or write an ad that shows only in timelines. You pay in Equicoins, and staff review every campaign before it runs.</p><a class="button" href="/account/ads/new">Create campaign</a></div>`}
<p class="dim">You have ${formatCents(balance)} Equicoins. Don't want to see ads? <a href="/account/labels">Hide them for free</a>.</p>`;
	return accountPage({ req, viewer, title: "Ads Manager", css: CSS, body, status: opts.error ? 400 : 200 });
}

const MAKE = String.raw`var f=document.querySelector("form.make");if(!f)return;
var out=document.getElementById("estimate"),b=f.budget,d=f.days,cpm=+out.dataset.cpm,min=+out.dataset.min,bal=+out.dataset.balance;
var pv=document.getElementById("pvtext"),pay=document.getElementById("pay"),left=document.getElementById("left");
function money(c){return "$"+(c/100).toFixed(2)}
function mode(){var m=f.querySelector('input[name=mode]:checked');f.classList.toggle("mode-post",!!m&&m.value==="post");f.classList.toggle("mode-new",!m||m.value==="new");text()}
function text(){var m=f.querySelector('input[name=mode]:checked'),t="";
	if(m&&m.value==="post"){var p=f.querySelector('input[name=post]:checked');t=p?p.dataset.text:"Pick a post above."}
	else{t=f.text.value.trim()||"What your ad says shows here.";if(f.url.value.trim())t+="\n\n"+f.url.value.trim()}
	pv.textContent=t}
function est(){var s=b.value.trim().replace(/^\$/,""),c=Math.round(parseFloat(s)*100),n=Math.max(1,parseInt(d.value,10)||1);
	if(!/^\d+(\.\d{1,2})?$/.test(s)||!(c>0)){out.textContent="Set a budget to see how many views it buys.";pay.textContent="$0.00";left.textContent=money(bal);return}
	pay.textContent=money(c);left.textContent=money(bal-c);
	if(c<min){out.textContent="The minimum budget is "+money(min)+".";return}
	if(c>bal){out.textContent="That's more than your "+money(bal)+".";return}
	var v=Math.floor(c*1000/cpm);out.textContent="About "+v.toLocaleString("en-US")+" views, or "+Math.floor(v/n).toLocaleString("en-US")+" a day over "+n+(n===1?" day":" days")+", at today's price."}
f.addEventListener("input",function(e){if(e.target.name==="mode")mode();else{text();est()}});
f.addEventListener("change",function(e){if(e.target.name==="mode")mode();else text()});
f.querySelectorAll("[data-set]").forEach(function(x){x.addEventListener("click",function(){var i=f[x.dataset.set];i.value=x.dataset.v;est()})});
var find=document.getElementById("find");
if(find)find.addEventListener("input",function(e){e.stopPropagation();var q=find.value.trim().toLowerCase(),n=0;
	f.querySelectorAll(".posts label").forEach(function(l){var hit=!q||l.textContent.toLowerCase().indexOf(q)>=0;l.hidden=!hit;if(hit)n++});
	document.getElementById("nomatch").hidden=n>0});
find&&find.addEventListener("keydown",function(e){if(e.key==="Enter")e.preventDefault()});
mode();est();`;

async function create(req: Request, viewer: Viewer, opts: { error?: string; draft?: Record<string, string> } = {}) {
	const rules = settings().ads;
	const url = new URL(req.url);
	const [posts, cpm, balance] = await Promise.all([promotablePosts(viewer.id), currentPrice(), balanceOf(viewer.id)]);
	const d = opts.draft ?? {};
	const picked = d.post || url.searchParams.get("post") || "";
	const mode = d.mode || (picked || posts.length ? "post" : "new");
	const adOnly = d.who !== "everyone";
	const min = rules.min_spend_cents;
	const budgets = [min, min * 2, min * 5, min * 10].filter((c, i, a) => a.indexOf(c) === i);
	const dayChoices = [1, 3, 7, 14, rules.max_days].filter((n, i, a) => n <= rules.max_days && a.indexOf(n) === i);
	const postList = posts.length
		? `<div class="posts" role="radiogroup" aria-label="Your posts">${posts
				.map(
					(p) =>
						`<label><input type="radio" name="post" value="${p.id}" data-text="${esc(p.text || "Post with media")}"${p.id === picked ? " checked" : ""}><span><q>${esc(p.text || "Post with media")}</q><small>${when(p.createdAt)}${p.reply ? " · Reply" : ""}${p.media ? " · Has media" : ""}</small></span></label>`,
				)
				.join("")}</div>`
		: `<p class="dim">You don't have any posts that can be promoted. Posts in a Circle or a Community, and posts already in a campaign, can't be.</p>`;
	const busy = !d.post && picked && !posts.some((p) => p.id === picked) ? (await sql`select id::text from ads where post_id = ${picked}::bigint and user_id = ${viewer.id}::bigint and status in ('pending', 'running', 'paused')`)[0] : undefined;
	const body = `<h1>Create campaign</h1>
${notices(opts)}${busy ? `<p class="card warning">That post is already in a campaign. <a href="/account/ads/${busy.id}">Open the campaign</a> to add budget or days.</p>` : ""}
<form method="post" action="/account/ads" class="make">${hidden(viewer.csrf)}
<section><h2>What to promote</h2>
<div class="choice">
<label><input type="radio" name="mode" value="post"${mode === "post" ? " checked" : ""}><span><b>One of your posts</b><small>It keeps its likes and replies, and shows up in more timelines.</small></span></label>
<label><input type="radio" name="mode" value="new"${mode === "new" ? " checked" : ""}><span><b>A new ad</b><small>Write a post just for this campaign.</small></span></label>
</div>
<div class="only-post fields">${posts.length > 3 ? `<input type="search" id="find" aria-label="Search your posts" placeholder="Search your posts" autocomplete="off"><p class="dim" id="nomatch" hidden>No posts match.</p>` : ""}${postList}</div>
<div class="only-new fields">
<label for="text">What it says</label><textarea id="text" name="text" maxlength="280">${esc(d.text ?? "")}</textarea>
<label for="url">Link</label><input id="url" name="url" type="url" inputmode="url" placeholder="https://" value="${esc(d.url ?? "")}">
<div class="choice">
<label><input type="radio" name="who" value="ad"${adOnly ? " checked" : ""}><span><b>Only as an ad</b><small>It never shows on your profile.</small></span></label>
<label><input type="radio" name="who" value="everyone"${adOnly ? "" : " checked"}><span><b>Also on your profile</b><small>A normal post that also runs as an ad.</small></span></label>
</div></div>
</section>
<section><h2>Preview</h2>
<div class="preview"><div class="avatar"${viewer.avatar_url ? ` style="background-image:url(&quot;${esc(viewer.avatar_url)}&quot;)"` : ""}></div><div><div class="who"><b>${esc(viewer.name)}</b><span>@${esc(viewer.screen_name)}</span></div><p id="pvtext"></p><div class="tag">Ad</div></div></div>
</section>
<section><h2>Budget and schedule</h2>
<div class="pair"><div><label for="budget">Budget in Equicoins</label><input id="budget" name="budget" inputmode="decimal" placeholder="${(min / 100).toFixed(2)}" value="${esc(d.budget ?? "")}">
<div class="presets">${budgets.map((c) => `<button type="button" class="secondary" data-set="budget" data-v="${(c / 100).toFixed(2)}">${formatCents(c)}</button>`).join("")}</div></div>
<div><label for="days">Days</label><input id="days" name="days" type="number" min="1" max="${rules.max_days}" value="${esc(d.days ?? String(Math.min(7, rules.max_days)))}">
<div class="presets">${dayChoices.map((n) => `<button type="button" class="secondary" data-set="days" data-v="${n}">${plural(n, "day")}</button>`).join("")}</div></div></div>
<p class="estimate" id="estimate" aria-live="polite" data-cpm="${cpm}" data-min="${min}" data-balance="${balance}"></p>
<label for="name">Campaign name, only you see it</label><input id="name" name="name" maxlength="60" placeholder="Optional" value="${esc(d.name ?? "")}">
</section>
<div class="sum"><div><span>You pay now</span><b id="pay">$0.00</b></div><div><span>Left in your wallet</span><span id="left">${formatCents(balance)}</span></div>
<p class="dim">What the campaign doesn't spend comes back when it ends or you stop it. ${rules.reject_refund_pct >= 100 ? "If staff reject it, all of it comes back." : `If staff reject it, ${rules.reject_refund_pct}% comes back.`}</p></div>
<div class="acts"><button type="submit">Send for review</button><a class="button secondary" href="/account/ads">Cancel</a></div>
</form>`;
	return accountPage({
		req,
		viewer,
		title: "Create campaign",
		css: CSS,
		head: `<script>addEventListener("DOMContentLoaded",function(){${MAKE}})</script>`,
		back: { href: "/account/ads", label: "Ads Manager" },
		body,
		status: opts.error ? 400 : 200,
	});
}

function campaignDays(ad: Ad, stats: AdStats | undefined) {
	if (!ad.startsAt) return [];
	const byDay = new Map((stats?.days ?? []).map((d) => [d.day, d.views]));
	const last = new Date(Math.min(Date.now(), ad.endsAt?.getTime() ?? Date.now())).toISOString().slice(0, 10);
	const out: { day: string; views: number }[] = [];
	for (let t = ad.startsAt.getTime(); out.length < 31; t += 86_400_000) {
		const day = new Date(t).toISOString().slice(0, 10);
		if (day > last) break;
		out.push({ day, views: byDay.get(day) ?? 0 });
	}
	return out.slice(-14);
}

async function detail(req: Request, viewer: Viewer, id: string, opts: { error?: string; notice?: string } = {}) {
	const rules = settings().ads;
	const ad = (await myAds(viewer.id)).find((a) => a.id === id);
	if (!ad) return accountPage({ req, viewer, title: "Campaign", back: { href: "/account/ads", label: "Ads Manager" }, body: `<h1>Campaign not found</h1><p class="dim"><a href="/account/ads">Back to your campaigns</a></p>`, status: 404 });
	const [stats, cpm] = await Promise.all([adStats([ad.id]).then((m) => m.get(ad.id)), currentPrice()]);
	const live = ad.status === "running" || ad.status === "paused";
	const left = ad.pausedLeftMs ?? (ad.endsAt ? Math.max(0, ad.endsAt.getTime() - Date.now()) : 0);
	const roomDays = Math.max(0, Math.floor((rules.max_days * 86_400_000 - left) / 86_400_000));
	const pct = ad.budgetCents ? Math.min(100, Math.round((ad.spentCents / ad.budgetCents) * 100)) : 0;
	const days = campaignDays(ad, stats);
	const act = (action: string, label: string, cls = "secondary") =>
		`<form class="inline" method="post" action="/account/ads/${ad.id}">${hidden(viewer.csrf, action)}<button type="submit" class="${cls}">${label}</button></form>`;
	const facts: [string, string][] = [
		["Type", ad.existingPost ? "Promoted post" : ad.adOnly ? "New ad, only in timelines" : "New ad, also on your profile"],
		["Budget", `${formatCents(ad.spentCents)} of ${formatCents(ad.budgetCents)} spent`],
		["Created", when(ad.createdAt)],
	];
	if (ad.startsAt) facts.push(["Started", when(ad.startsAt)]);
	if (ad.status === "pending") facts.push(["Runs for", `${plural(ad.days, "day")} once approved`]);
	else if (ad.status === "paused" && ad.pausedLeftMs != null) facts.push(["Time left", `${plural(Math.max(1, Math.round(ad.pausedLeftMs / 3_600_000)), "hour")} once resumed`]);
	else if (ad.endsAt) facts.push([live ? "Ends" : "Ended", when(ad.endsAt)]);
	if (ad.refundedCents) facts.push(["Refunded", formatCents(ad.refundedCents)]);
	const body = `<div class="head"><div><h1>${esc(title(ad))}</h1><span class="state ${ad.status}">${STATUS[ad.status]}</span></div>
<div class="acts">${ad.status === "running" ? act("pause", "Pause") : ""}${ad.status === "paused" ? act("resume", "Resume", "") : ""}${
		["pending", "running", "paused"].includes(ad.status) ? act("cancel", ad.status === "pending" ? "Withdraw" : "Stop and refund") : ""
	}</div></div>
${notices(opts)}
${ad.rejectReason && (ad.status === "rejected" || ad.status === "cancelled") ? `<div class="card strike"><b>${ad.status === "rejected" ? "Why it was rejected" : "Staff stopped this campaign"}</b><p>${esc(ad.rejectReason)}</p></div>` : ""}
${ad.startsAt ? tiles([
	[num(ad.views), "Views"],
	[num(stats?.reach ?? 0), "People reached"],
	[perThousand(ad), "Per 1000 views"],
	[live ? `~${num(estimateViews(ad.budgetCents - ad.spentCents, cpm))}` : "0", "Views left"],
]) : ""}
${live ? `<div class="track" aria-label="${pct}% of the budget spent"><i style="width:${pct}%"></i></div>` : ""}
${days.length > 1 ? `<div class="panel"><h2>Views per day</h2>${bars(days)}</div>` : ""}
<div class="panel"><h2>Ad</h2><div class="preview"><div class="avatar"${viewer.avatar_url ? ` style="background-image:url(&quot;${esc(viewer.avatar_url)}&quot;)"` : ""}></div><div><div class="who"><b>${esc(viewer.name)}</b><span>@${esc(viewer.screen_name)}</span></div><p>${esc(ad.text)}${ad.url && !ad.existingPost ? `\n\n${esc(ad.url)}` : ""}</p><div class="tag">Ad</div></div></div>
${ad.postId && ad.status !== "pending" ? `<a href="/i/status/${ad.postId}">Open the post</a>` : ad.existingPost && !ad.postId ? `<p class="dim">The post was deleted.</p>` : ""}</div>
<div class="panel"><h2>Details</h2><dl>${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
<details><summary>Rename</summary><form method="post" action="/account/ads/${ad.id}">${hidden(viewer.csrf, "rename")}<label for="name">Campaign name</label><input id="name" name="name" maxlength="60" value="${esc(ad.name ?? "")}" placeholder="${esc(title(ad))}"><button type="submit" class="secondary">Save name</button></form></details>
${live ? `<details><summary>Add budget or days</summary><form method="post" action="/account/ads/${ad.id}">${hidden(viewer.csrf, "extend")}
<div class="pair"><div><label for="ab">Add Equicoins</label><input id="ab" name="budget" inputmode="decimal" placeholder="0.00"></div>
<div><label for="ad">Add days</label><input id="ad" name="days" type="number" min="0" max="${roomDays}" placeholder="0"${roomDays < 1 ? " disabled" : ""}></div></div>
<button type="submit">Extend campaign</button></form></details>` : ""}
</div>`;
	return accountPage({ req, viewer, title: title(ad), css: CSS, back: { href: "/account/ads", label: "Ads Manager" }, body, status: opts.error ? 400 : 200 });
}

const NOTICES: Record<string, string> = {
	sent: "Your campaign is waiting for review.",
	paused: "Your campaign is paused.",
	resumed: "Your campaign is running again.",
	cancelled: "Your campaign is stopped and what it didn't spend is back in your wallet.",
	extended: "Your campaign is extended.",
	renamed: "Saved.",
};

const back = (to: string, notice: string) => new Response(null, { status: 303, headers: { location: `${to}${to.includes("?") ? "&" : "?"}done=${notice}` } });

export async function adsRoute(req: Request, viewer: Viewer, path: string): Promise<Response> {
	if (!settings().ads.enabled) return closed(req, viewer);
	const url = new URL(req.url);
	const id = /^\/account\/ads\/(\d{1,19})$/.exec(path)?.[1];
	const notice = NOTICES[url.searchParams.get("done") ?? ""];
	if (req.method !== "POST") {
		if (path === "/account/ads/new") return create(req, viewer);
		return id ? detail(req, viewer, id, { notice }) : dashboard(req, viewer, { notice });
	}
	const form = await req.formData().catch(() => undefined);
	const field = (k: string) => String(form?.get(k) ?? "");
	if (field("csrf") !== viewer.csrf) return dashboard(req, viewer, { error: "That form is out of date. Try again." });
	if (!id) {
		const draft = Object.fromEntries(["mode", "post", "text", "url", "budget", "days", "who", "name"].map((k) => [k, field(k)]));
		try {
			const budgetCents = toCents(draft.budget);
			if (Number.isNaN(budgetCents)) throw new AdError("Write the budget as an amount, like 5 or 5.50.");
			const fromPost = draft.mode === "post";
			if (fromPost && !draft.post) throw new AdError("Pick the post to promote.");
			const ad = await createAd(viewer.id, {
				text: draft.text,
				url: draft.url,
				budgetCents,
				days: Number(draft.days),
				adOnly: draft.who !== "everyone",
				postId: fromPost ? draft.post : undefined,
				name: draft.name,
			});
			return back(`/account/ads/${ad.id}`, "sent");
		} catch (e) {
			if (e instanceof AdError) return create(req, viewer, { error: e.message, draft });
			throw e;
		}
	}
	try {
		const action = field("action");
		if (action === "pause" || action === "resume") {
			await pauseAd(viewer.id, id, action === "pause");
			return back(`/account/ads/${id}`, action === "pause" ? "paused" : "resumed");
		}
		if (action === "cancel") {
			await cancelAd(viewer.id, id);
			return back(`/account/ads/${id}`, "cancelled");
		}
		if (action === "rename") {
			await renameAd(viewer.id, id, field("name"));
			return back(`/account/ads/${id}`, "renamed");
		}
		if (action === "extend") {
			const budgetCents = toCents(form?.get("budget"));
			if (Number.isNaN(budgetCents)) throw new AdError("Write the amount like 5 or 5.50.");
			await extendAd(viewer.id, id, { budgetCents, days: Number(form?.get("days") || 0) });
			return back(`/account/ads/${id}`, "extended");
		}
		throw new AdError("That isn't something you can do to a campaign.");
	} catch (e) {
		if (e instanceof AdError) return detail(req, viewer, id, { error: e.message });
		throw e;
	}
}
