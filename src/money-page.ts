// Equicoins pages (money.ts): the balance and activity at /account/money,
// opened from the side bar (tidy.ts); sending, requesting, a payment's and a
// request's own page under it; and merchant mode at /account/merchant, in
// Settings.

import { accountPage, esc, formCsrfOk, scriptNonce, withCsrf } from "./account-page";
import type { Viewer } from "./auth";
import { sql } from "./db";
import { peers } from "./federation";
import { BADGE_TYPES, absolute } from "./media";
import { CARD_CSS } from "./money-ui";
import {
	MoneyError,
	type Party,
	badges,
	acceptDisclaimer,
	balanceOf,
	closeRequest,
	disclaimerAccepted,
	disclaimerText,
	date,
	economy,
	face,
	formatCents,
	merchantOf,
	parseAmount,
	parties,
	paymentCard,
	paymentUrl,
	payments,
	requestCard,
	requestMoney,
	requestUrl,
	requests,
	sendMoney,
	setMerchant,
	shortCents,
	NOTE_MAX,
} from "./money";
import { hit } from "./ratelimit";
import { feature, settings } from "./settings";
import { MONEY_ICON } from "./tidy";
import { buyShopItem, myShopOrders, shopItems, shopView, ShopError } from "./money-shop";

const CSS = `
main{padding:0;gap:0}
.hero{padding:24px 16px 20px;display:grid;justify-items:start;gap:2px;border-bottom:1px solid var(--border)}
.tile{display:grid;place-items:center;width:40px;height:40px;border-radius:10px;background:#000;box-shadow:inset 0 0 0 1px rgb(255 255 255 / .12);margin-bottom:14px}
.tile svg{width:28px;height:28px;fill:#fff}
.hero .label{color:var(--muted)}
.hero .amount{font-size:52px;line-height:60px;font-weight:800;letter-spacing:-1.5px;font-variant-numeric:tabular-nums}
.actions{display:flex;gap:10px;margin-top:16px}
.pill{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:40px;padding:0 24px;border-radius:9999px;font-weight:700;font-size:15px;text-decoration:none;border:1px solid var(--outline);color:var(--text);background:transparent;cursor:pointer}
.pill.primary{background:var(--text);color:var(--bg);border-color:var(--text)}
.pill.small{min-height:32px;padding:0 16px;font-size:14px}
.pill.wide{width:100%;min-height:52px;font-size:17px}
.pill svg{width:18px;height:18px;fill:currentColor}
@media (hover:hover){.pill:hover,button.pill:hover:not(:disabled){background:var(--hover);text-decoration:none}.pill.primary:hover,button.pill.primary:hover:not(:disabled){background:var(--text);opacity:.88}}
.notice{margin:12px 16px 0;padding:12px 16px;border-radius:12px;background:rgb(0 186 124 / .12);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.notice.error{background:rgb(244 33 46 / .12)}
.month{padding:20px 16px 8px;color:var(--muted);font-size:13px;font-weight:700;letter-spacing:.3px;text-transform:uppercase}
.tx{display:grid;grid-template-columns:40px minmax(0,1fr) auto;align-items:center;gap:0 12px;padding:10px 16px;color:var(--text);text-decoration:none}
a.tx:hover{text-decoration:none}
@media (hover:hover){a.tx:hover{background:color-mix(in srgb,var(--text) 4%,transparent)}}
.tx>img,.tx .icon{width:40px;height:40px;border-radius:50%;object-fit:cover;background:var(--border)}
.tx>img.xm-sq{border-radius:8px}
.tx .icon{display:grid;place-items:center;background:rgb(249 24 128 / .12);color:rgb(249 24 128)}
.tx .icon svg{width:20px;height:20px;fill:currentColor}
.tx .who{display:flex;gap:4px;align-items:center;min-width:0;font-weight:700;white-space:nowrap}
.tx .who span{overflow:hidden;text-overflow:ellipsis}
.tx .sub{color:var(--muted);font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx .amt{font-weight:700;font-variant-numeric:tabular-nums}
.tx .amt.in{color:var(--success)}
.tx .end{display:flex;gap:8px;align-items:center}
.tx form{display:contents}
.empty{color:var(--muted);text-align:center;padding:48px 16px}
.send{padding:8px 16px 24px;display:grid;gap:16px;justify-items:stretch}
.picks{display:flex;gap:16px;overflow-x:auto;padding:4px 2px;scrollbar-width:none}
.pick{flex:none;width:60px;display:grid;justify-items:center;gap:6px;border:0;background:none;color:var(--muted);font:inherit;font-size:13px;cursor:pointer;padding:0;min-height:0}
.pick>img{width:48px;height:48px;border-radius:50%;object-fit:cover;background:var(--border);outline:2px solid transparent;outline-offset:2px;transition:outline-color .15s}
.pick>img.xm-sq{border-radius:10px}
/* buttons, not the page's blue pills: no fill on hover or press */
.pick:hover:not(:disabled),.pick:active:not(:disabled){background:none;scale:none}
.pick:focus-visible{outline:0}
@media (hover:hover){.pick:hover>img{outline-color:var(--outline)}.pick:hover{color:var(--text)}}
.pick:focus-visible>img{outline-color:var(--accent)}
.pick[aria-pressed="true"]{color:var(--text)}
.pick[aria-pressed="true"]>img{outline-color:var(--text)}
.pick span{max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.big{display:flex;justify-content:center;align-items:flex-start;padding:28px 0 20px}
.big span{font-size:36px;line-height:48px;font-weight:800;color:var(--muted)}
.big input{all:unset;width:1.2ch;min-width:1.2ch;font-size:72px;line-height:80px;font-weight:800;letter-spacing:-2px;font-variant-numeric:tabular-nums;caret-color:var(--accent)}
.big input::placeholder{color:var(--muted)}
.big input[readonly]{caret-color:transparent}
.balance{text-align:center;color:var(--muted);font-size:14px;margin-top:-12px}
.paying{display:flex;align-items:center;gap:12px;padding:12px 16px;border:1px solid var(--border);border-radius:16px}
.paying>img{width:40px;height:40px;border-radius:50%;object-fit:cover}
.paying>img.xm-sq{border-radius:8px}
.paying .who{display:flex;gap:4px;align-items:center;font-weight:700}
.field{position:relative;display:grid}
.field input{padding-top:22px;padding-bottom:6px;min-height:56px}
.field label{position:absolute;left:13px;top:7px;margin:0;font-size:13px;color:var(--muted);pointer-events:none}
.field:focus-within label{color:var(--accent)}
/* the To and From fields' list of accounts, as X's typeahead */
.people{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:5;max-height:320px;overflow-y:auto;background:var(--bg);border-radius:8px;box-shadow:0 0 15px rgb(255 255 255 / .2),0 0 3px 1px rgb(255 255 255 / .15)}
:root[data-theme="light"] .people,:root:not([data-theme]) .people{box-shadow:0 0 15px rgb(101 119 134 / .2),0 0 3px 1px rgb(101 119 134 / .15)}
.people[hidden]{display:none}
.person{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer}
.person[aria-selected="true"]{background:var(--surface)}
.person>img{width:40px;height:40px;border-radius:50%;object-fit:cover;flex:none;background:var(--border)}
.person>img.xm-sq{border-radius:8px}
.person .name{display:flex;align-items:center;gap:2px;font-weight:700;min-width:0}
.person .name span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.person .handle{color:var(--muted);font-size:15px}
.people .none{padding:16px;color:var(--muted)}
.check{display:flex;align-items:center;justify-content:space-between;gap:10px;color:var(--text);font-size:15px;margin:0}
.check small{display:block;color:var(--muted);font-size:13px}
.check input{appearance:none;width:40px;height:24px;min-height:0;padding:0;border:0;border-radius:9999px;background:var(--field);position:relative;cursor:pointer;transition:background .15s;flex:none}
.check input::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:translate .15s}
.check input:checked{background:var(--accent)}
.check input:checked::after{translate:16px 0}
.fine{color:var(--muted);font-size:13px;text-align:center}
.receipt{padding:16px;display:grid;gap:16px}
dl{margin:0;padding:16px;display:grid;grid-template-columns:auto 1fr;gap:14px 16px;border-top:1px solid var(--border)}
dt{color:var(--muted)}
dd{margin:0;text-align:right;overflow-wrap:anywhere;display:flex;justify-content:flex-end;align-items:center;gap:4px}
.settings{padding:16px;display:grid;gap:16px}
.settings h2{margin:8px 0 0}
.shop-hero .amount{font-size:36px;line-height:44px;letter-spacing:-1px}
.shop-hero .dim{margin:8px 0 0}
.shop-page{display:grid;gap:12px;padding:16px 16px 32px}
.shop-page h2{margin:0;font-size:20px}
.shop-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.shop-item{display:grid;grid-template-rows:1fr auto;gap:12px;min-width:0;padding:12px;border:1px solid var(--border);border-radius:16px}
.shop-item h3{margin:0;font-size:15px;line-height:20px;overflow-wrap:anywhere}
.shop-item-description{margin:2px 0 0;color:var(--muted);font-size:14px;line-height:18px;overflow-wrap:anywhere}
.shop-meta{display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;margin-top:8px}
.shop-price{font-weight:700;font-variant-numeric:tabular-nums}
.shop-kind{color:var(--muted);font-size:13px}
.shop-badge-preview{display:block;width:40px;height:40px;object-fit:contain;margin:0 0 8px}
.shop-remote{color:var(--muted);font-size:13px;line-height:17px}
.shop-form{display:grid;gap:8px;align-content:end}
.shop-form label{margin:0;color:var(--muted);font-size:13px}
.shop-hint{color:var(--muted);font-size:12px;line-height:16px}
.shop-form input:not([type=file]),.shop-form textarea{width:100%;min-width:0}
.shop-form textarea{min-height:88px}
.shop-form .pill{width:100%;padding:0 12px}
.shop-upload input[type=file]{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.shop-upload label{display:flex;align-items:center;gap:8px;min-height:44px;padding:0 12px;border:1px solid var(--field);border-radius:4px;color:var(--text);font-weight:700;cursor:pointer}
.shop-upload input:focus-visible+label{outline:2px solid var(--accent);outline-offset:2px}
.shop-upload label>span:first-child{flex:none}
.shop-upload-name{min-width:0;overflow:hidden;color:var(--muted);font-size:14px;font-weight:400;text-overflow:ellipsis;white-space:nowrap}
.shop-history{display:grid;margin-top:12px}
.order{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:12px 0;border-bottom:1px solid var(--border)}
.order-name{font-weight:700;overflow-wrap:anywhere}
.order-status{color:var(--muted);font-size:13px}
.order-status.approved{color:var(--success)}
.order-price{grid-row:1/3;grid-column:2;font-weight:700;font-variant-numeric:tabular-nums}
@media(max-width:560px){.shop-grid{grid-template-columns:1fr}}
.preview{display:grid;gap:12px}
.xm-badge{width:18px;height:18px;flex:none}
.xm-card{margin:0;--xm-bg:var(--bg);--xm-fg:var(--text)}
${CARD_CSS}`;

// links on the page that open the client's composer with a payment or request
// in it (money-ui.ts takes it from there); cards go to their page; picking a
// person fills the To field; the amount field grows as it's typed in
const SCRIPT = `document.addEventListener("click",function(e){
	var b=e.target.closest("[data-compose]");
	if(b){e.preventDefault();var t=b.getAttribute("data-compose");try{parent.__xitterCompose(t)}catch(x){sessionStorage.setItem("xitter-compose",t);top.location.href="/compose/post"}return}
	var g=e.target.closest("[data-xm-go]");
	if(g){e.preventDefault();var to=g.getAttribute("data-xm-go");if(to.indexOf("/account/")===0)location.href=to;else try{parent.__xitterGo(to)}catch(x){top.location.href=to}}
});
document.querySelectorAll(".shop-file-input").forEach(function(input){input.addEventListener("change",function(){var name=input.nextElementSibling&&input.nextElementSibling.querySelector("[data-file-name]");var n=input.files?input.files.length:0;if(name)name.textContent=n>1?n+" images":n?input.files[0].name:"No image chosen"})});
document.querySelectorAll(".pick").forEach(function(p){p.addEventListener("click",function(){var to=document.getElementById("to");to.value="@"+p.dataset.handle;document.querySelectorAll(".pick").forEach(function(q){q.setAttribute("aria-pressed",q===p?"true":"false")});document.getElementById("amount").focus()})});
var amt=document.getElementById("amount");if(amt){var fit=function(){amt.style.width=Math.max(1,amt.value.length)*0.62+0.4+"em"};amt.addEventListener("input",fit);fit();if(!amt.value)amt.focus()}
var auto=document.querySelector("[data-compose][data-auto]");if(auto)auto.click();
document.querySelectorAll("input[data-people]").forEach(function(input){
	var box=document.createElement("div");
	box.className="people";box.id="people";box.setAttribute("role","listbox");box.hidden=true;
	input.parentNode.appendChild(box);
	var items=[],at=-1,timer=null,asked="";
	function show(open){box.hidden=!open;input.setAttribute("aria-expanded",open?"true":"false")}
	function mark(i){at=i;[].forEach.call(box.children,function(c,j){c.setAttribute("aria-selected",j===i?"true":"false");if(j===i)c.scrollIntoView({block:"nearest"})})}
	function pick(p){
		input.value="@"+p.screen_name;show(false);
		document.querySelectorAll(".pick").forEach(function(q){q.setAttribute("aria-pressed",q.dataset.handle.toLowerCase()===p.screen_name.toLowerCase()?"true":"false")});
		var next=document.getElementById("amount");
		if(!next||next.value)next=document.getElementById("note");
		if(next)next.focus();
	}
	function draw(list){
		items=list;box.innerHTML="";at=-1;
		if(!list.length){var n=document.createElement("div");n.className="none";n.textContent="No accounts match";box.appendChild(n);show(true);return}
		list.forEach(function(p,i){
			var row=document.createElement("div");
			row.className="person";row.setAttribute("role","option");row.setAttribute("aria-selected","false");
			var img=document.createElement("img");img.src=p.avatar;img.alt="";if(p.square)img.className="xm-sq";row.appendChild(img);
			var text=document.createElement("div");text.style.minWidth="0";
			var name=document.createElement("div");name.className="name";
			var nm=document.createElement("span");nm.textContent=p.name;name.appendChild(nm);
			name.insertAdjacentHTML("beforeend",p.badges);
			var handle=document.createElement("div");handle.className="handle";handle.textContent="@"+p.screen_name;
			text.appendChild(name);text.appendChild(handle);row.appendChild(text);
			row.addEventListener("mousedown",function(e){e.preventDefault();pick(p)});
			row.addEventListener("mousemove",function(){if(at!==i)mark(i)});
			box.appendChild(row);
		});
		show(true);mark(0);
	}
	function look(){
		var q=input.value.trim().replace(/^@/,"");
		if(!q){show(false);return}
		if(q===asked&&items.length){show(true);return}
		asked=q;
		fetch("/account/money/people?q="+encodeURIComponent(q)+(input.hasAttribute("data-local")?"&local=1":""),{credentials:"same-origin"}).then(function(r){return r.ok?r.json():[]}).then(function(list){
			if(asked===q&&document.activeElement===input)draw(list);
		},function(){});
	}
	input.addEventListener("input",function(){clearTimeout(timer);timer=setTimeout(look,120)});
	input.addEventListener("focus",function(){if(input.value.trim())look()});
	input.addEventListener("blur",function(){setTimeout(function(){show(false)},100)});
	input.addEventListener("keydown",function(e){
		if(box.hidden||!items.length)return;
		if(e.key==="ArrowDown"){e.preventDefault();mark((at+1)%items.length)}
		else if(e.key==="ArrowUp"){e.preventDefault();mark((at-1+items.length)%items.length)}
		else if(e.key==="Enter"&&at>=0){e.preventDefault();pick(items[at])}
		else if(e.key==="Tab"&&at>=0){pick(items[at])}
		else if(e.key==="Escape"){show(false)}
	});
});`;
const POST_ICON = "M23 3c-6.62-.1-10.38 2.421-13.05 6.03C7.29 12.61 6 17.331 6 22h2c0-1.007.07-2.012.19-3H12c4.1 0 7.48-3.082 7.94-7.054C22.79 10.147 23.17 6.359 23 3zm-7 8h-1.5v2H16c.63-.016 1.2-.08 1.72-.188C16.95 15.24 14.68 17 12 17H8.55c.57-2.512 1.57-4.851 3-6.78 2.16-2.912 5.29-4.911 9.45-5.187C20.95 8.079 19.9 11 16 11zM4 9V6H1V4h3V1h2v3h3v2H6v3H4z";
const HEART = "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.908-1.91z";
const tile = `<span class="tile" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${MONEY_ICON}"/></svg></span>`;
const HOME = { href: "/account/money", label: "Back to Equicoins" };
const page = (req: Request, viewer: Viewer, title: string, body: string, status = 200, back = HOME) =>
	accountPage({ req, viewer, status, title, back, css: CSS, head: `<script nonce="${scriptNonce(req)}">addEventListener("DOMContentLoaded",function(){${SCRIPT}})</script>`, body: withCsrf(body, viewer) });
const who = (p: Party) => `<span class="who"><span>${esc(p.merchant?.name ?? p.name)}</span>${badges(p)}</span>`;
const postButton = (url: string, label = "Post", auto = false) =>
	`<button type="button" class="pill primary" data-compose="${esc(url)}"${auto ? " data-auto" : ""}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="${POST_ICON}"/></svg>${label}</button>`;

// what came and went, newest first: payments, and each day's earnings from likes
async function activity(userId: string) {
	const [rows, likes] = await Promise.all([
		sql`select id::text from money_transfers where sender_id = ${userId}::bigint or recipient_id = ${userId}::bigint order by id desc limit 60`,
		sql`select date_trunc('day', created_at) as day, max(created_at) as at, count(*)::int as likes, sum(cents)::bigint as cents
			from money_like_rewards where author_id = ${userId}::bigint group by 1 order by 1 desc limit 30`,
	]);
	const found = await payments(rows.map((r: any) => r.id));
	const items: { at: Date; html: string }[] = [];
	for (const r of rows) {
		const t = found.get(r.id);
		if (!t) continue;
		const sent = t.sender.id === userId;
		const other = sent ? t.recipient : t.sender;
		const what = t.reversed ? "Reversed" : t.status === "pending" ? "Sending…" : t.status === "failed" ? "Transfer failed · refunded" : sent ? (other.merchant ? "Purchase" : "Sent") : "Received";
		items.push({
			at: t.at,
			html: `<a class="tx" href="/account/money/p/${t.id}">${face(other)}<div>${who(other)}<div class="sub">${t.reversed ? "Reversed" : t.note ? esc(t.note) : what} · ${date(t.at)}</div></div>
<div class="amt${sent || t.reversed ? "" : " in"}"${t.reversed ? ' style="text-decoration:line-through;color:var(--muted)"' : ""}>${sent ? "−" : "+"}${shortCents(t.amount)}</div></a>`,
		});
	}
	for (const l of likes)
		items.push({
			at: new Date(l.at),
			html: `<div class="tx"><span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="${HEART}"/></svg></span><div><div class="who"><span>Likes on your posts</span></div>
<div class="sub">${l.likes} like${l.likes === 1 ? "" : "s"} · ${date(l.day)}</div></div><div class="amt in">+${shortCents(Number(l.cents))}</div></div>`,
		});
	return items.sort((a, b) => b.at.getTime() - a.at.getTime());
}

// requests still waiting: of the viewer (pay or decline), and the viewer's own
async function waiting(userId: string) {
	const rows = await sql`select id::text from money_requests where status = 'open'
		and (payer_id = ${userId}::bigint or (requester_id = ${userId}::bigint and payer_id is not null)) order by id desc limit 40`;
	const found = await requests(rows.map((r: any) => r.id));
	return rows
		.map((r: any) => found.get(r.id))
		.filter((q: any) => !!q)
		.map((q: any) => {
			const mine = q.requester.id === userId;
			const other: Party = mine ? q.payer : q.requester;
			const actions = mine
				? `<form method="post" action="/account/money/r/${q.id}"><input type="hidden" name="action" value="cancel"><button type="submit" class="pill small">Cancel</button></form>`
				: `<form method="post" action="/account/money/r/${q.id}"><input type="hidden" name="action" value="decline"><button type="submit" class="pill small">Decline</button></form><a class="pill small primary" href="/account/money/send?request=${q.id}">Pay</a>`;
			return `<div class="tx">${face(other)}<a href="/account/money/r/${q.id}" style="color:inherit;min-width:0">${who(other)}<div class="sub">${mine ? "You asked for" : "Asks for"} ${shortCents(q.amount)}${q.note ? ` · ${esc(q.note)}` : ""}</div></a><div class="end">${actions}</div></div>`;
		});
}

async function home(req: Request, viewer: Viewer, status = 200, notice = "", error = "") {
	const [balance, items, asks] = await Promise.all([balanceOf(viewer.id), activity(viewer.id), waiting(viewer.id)]);
	let month = "";
	const list = items.length
		? items
				.map((i) => {
					const m = i.at.toLocaleDateString("en-US", { month: "long", year: "numeric" });
					const head = m !== month ? `<div class="month">${m}</div>` : "";
					month = m;
					return head + i.html;
				})
				.join("\n")
		: `<p class="empty">No activity yet.<br>Equicoins you send, receive and earn shows up here.</p>`;
	const likes = economy().like_cents;
	return page(
		req,
		viewer,
		"Equicoins",
		`<section class="hero" aria-label="Balance">${tile}<div class="label">Balance</div><div class="amount">${formatCents(balance)}</div>
${viewer.actor ? `<p class="dim">Only @${esc(viewer.screen_name)} can send money from this account.</p>` : `<div class="actions"><a class="pill primary" href="/account/money/send">Send</a><a class="pill" href="/account/money/request">Request</a>${settings().money_shop.enabled ? `<a class="pill" href="/account/money/shop">Shop</a>` : ""}</div>`}
${likes > 0 ? `<p class="dim" style="margin-top:12px">You earn ${likes < 100 ? `${likes}¢` : formatCents(likes)} for each like on your posts.</p>` : ""}</section>
${notice ? `<div class="notice" role="status">${notice}</div>` : ""}${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}
${asks.length ? `<section aria-label="Requests"><div class="month">Requests</div>${asks.join("\n")}</section>` : ""}
<section aria-label="Activity">${list}</section>
`,
		status,
		{ href: "/home", label: "Back to home" },
	);
}

// people to pay in one tap: the latest the viewer paid or was paid by, then accounts they follow
async function quickPicks(userId: string) {
	const rows = await sql`select p.o::text as id from (
			select o, max(at) as at from (
				select case when sender_id = ${userId}::bigint then recipient_id else sender_id end as o, created_at as at from money_transfers
				where sender_id = ${userId}::bigint or recipient_id = ${userId}::bigint
				union all select followee_id, created_at - interval '100 years' from follows where follower_id = ${userId}::bigint
			) x group by o order by at desc limit 8
		) p join users u on u.id = p.o
		where u.instance is null and u.status <> 'suspended' and u.deactivated_at is null
			and not exists (select 1 from blocks b where (b.blocker_id = u.id and b.blocked_id = ${userId}::bigint) or (b.blocker_id = ${userId}::bigint and b.blocked_id = u.id))
		order by p.at desc`;
	const found = await parties(rows.map((r: any) => r.id));
	return rows.map((r: any) => found.get(r.id)).filter((p: Party | undefined): p is Party => !!p);
}

// GET /account/money/people?q=: accounts for the To and From fields' list,
// matched by handle or name; people the viewer follows and has paid first.
// Money goes to accounts here and on peers; requests (`local`) stay here.
async function peopleApi(viewer: Viewer, query: string, local: boolean): Promise<Response> {
	const q = query.trim().replace(/^@/, "").toLowerCase().slice(0, 300);
	if (!q) return Response.json([]);
	const like = `${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const reachable = local ? [] : peers().map((p) => p.id);
	const rows = await sql`select u.id::text from users u
		where u.status <> 'suspended' and u.deactivated_at is null and u.id <> ${viewer.id}::bigint
			and (u.instance is null or u.instance = any(${sql.array(reachable, "TEXT")}))
			and (lower(u.screen_name) like ${like} or lower(u.name) like ${like} or lower(u.name) like ${`% ${like}`})
			and not exists (select 1 from blocks b where (b.blocker_id = u.id and b.blocked_id = ${viewer.id}::bigint) or (b.blocker_id = ${viewer.id}::bigint and b.blocked_id = u.id))
		order by lower(u.screen_name) = ${q} desc,
			exists (select 1 from money_transfers t where t.sender_id = ${viewer.id}::bigint and t.recipient_id = u.id) desc,
			exists (select 1 from follows f where f.follower_id = ${viewer.id}::bigint and f.followee_id = u.id) desc,
			lower(u.screen_name) like ${like} desc, length(u.screen_name), u.id
		limit 8`;
	const found = await parties(rows.map((r: any) => r.id));
	return Response.json(
		rows
			.map((r: any) => found.get(r.id))
			.filter((x: Party | undefined): x is Party => !!x)
			.map((x: Party) => ({ screen_name: x.screen_name, name: x.merchant?.name ?? x.name, avatar: x.avatar, square: x.square, badges: badges(x) })),
		{ headers: { "cache-control": "private, no-store" } },
	);
}

// sending, on a screen of its own: who, how much, a note; or paying a request
async function sendView(req: Request, viewer: Viewer, status = 200, form: { to?: string; amount?: string; note?: string; request?: string } = {}, error = "") {
	const url = new URL(req.url);
	const requestId = form.request ?? url.searchParams.get("request") ?? "";
	const q = /^\d{1,19}$/.test(requestId) ? (await requests([requestId], viewer.id)).get(requestId) : undefined;
	if (q && (q.status !== "open" || q.requester.id === viewer.id || (q.payer && q.payer.id !== viewer.id)))
		return page(req, viewer, "Pay", `<p class="empty">This request isn't open to you any more.</p>`, 410);
	const [balance, picks] = await Promise.all([balanceOf(viewer.id), q ? Promise.resolve([]) : quickPicks(viewer.id)]);
	const to = q ? `@${q.requester.screen_name}` : (form.to ?? url.searchParams.get("to") ?? "");
	const amount = q?.amount ? (q.amount / 100).toFixed(2).replace(/\.00$/, "") : (form.amount ?? url.searchParams.get("amount") ?? "");
	const note = form.note ?? q?.note ?? "";
	const chosen = to.replace(/^@/, "").toLowerCase();
	return page(
		req,
		viewer,
		q ? "Pay" : "Send",
		`${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/account/money/send" class="send" autocomplete="off">
<input type="hidden" name="idem" value="${crypto.randomUUID()}">${q ? `<input type="hidden" name="request" value="${q.id}">` : ""}
<div class="big"><span>$</span><input id="amount" name="amount" required inputmode="decimal" placeholder="0" aria-label="Amount" value="${esc(amount)}"${q?.amount ? " readonly" : ""}></div>
<div class="balance">${formatCents(balance)} available</div>
${
	q
		? `<input type="hidden" name="to" value="${esc(to)}"><div class="paying">${face(q.requester)}<div>${who(q.requester)}<div class="dim">@${esc(q.requester.screen_name)}${q.note ? ` · ${esc(q.note)}` : ""}</div></div></div>`
		: `${
				picks.length
					? `<div class="picks" role="group" aria-label="People">${picks
							.map((p: Party) => `<button type="button" class="pick" data-handle="${esc(p.screen_name)}" aria-pressed="${chosen === p.screen_name.toLowerCase()}">${face(p)}<span>${esc(p.merchant?.name ?? p.name)}</span></button>`)
							.join("")}</div>`
					: ""
			}
<div class="field"><input id="to" name="to" required placeholder=" " value="${esc(to)}" autocapitalize="off" autocomplete="off" spellcheck="false" data-people role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="people"><label for="to">To</label></div>`
}
<div class="field"><input id="note" name="note" maxlength="${NOTE_MAX}" placeholder=" " value="${esc(note)}"><label for="note">What's it for?</label></div>
<label class="check">Share it in a post<input type="checkbox" name="share" value="1"></label>
<button type="submit" class="pill primary wide">${q ? "Pay" : "Send"}</button>
<p class="fine">Instant and free. ${esc(settings().instance_name)} Equicoins has no cash value.${
	settings().money.feed ? ` Payments are posted publicly by <a href="/${esc(settings().money.feed)}">@${esc(settings().money.feed)}</a>, without your note.` : ""
}</p>
</form>`,
		status,
	);
}

async function requestView(req: Request, viewer: Viewer, status = 200, form: { from?: string; amount?: string; note?: string } = {}, error = "") {
	const url = new URL(req.url);
	const from = form.from ?? url.searchParams.get("from") ?? "";
	return page(
		req,
		viewer,
		"Request",
		`${error ? `<div class="notice error" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/account/money/request" class="send" autocomplete="off">
<div class="big"><span>$</span><input id="amount" name="amount" inputmode="decimal" placeholder="0" aria-label="Amount" value="${esc(form.amount ?? "")}"></div>
<div class="balance">Leave it at 0 to let people choose</div>
<div class="field"><input id="from" name="from" placeholder=" " value="${esc(from)}" autocapitalize="off" autocomplete="off" spellcheck="false" data-people data-local role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="people"><label for="from">From (@username, or empty for anyone)</label></div>
<div class="field"><input id="note" name="note" maxlength="${NOTE_MAX}" placeholder=" " value="${esc(form.note ?? "")}"><label for="note">What's it for?</label></div>
<label class="check"><span>Share it in a post<small>A Pay button anyone who sees the post can use</small></span><input type="checkbox" name="share" value="1" checked></label>
<button type="submit" class="pill primary wide">Request</button>
<p class="fine">Asking one account sends them a notification to pay or decline.</p>
</form>`,
		status,
	);
}

// one payment, for either side, or anyone once a side put it in a post
async function paymentPage(req: Request, viewer: Viewer, id: string) {
	const t = (await payments([id], viewer.id)).get(id);
	if (!t) return page(req, viewer, "Payment", `<p class="empty">This payment doesn't exist, or isn't yours to see.</p>`, 404);
	const mine = viewer.id === t.sender.id || viewer.id === t.recipient.id;
	const other = viewer.id === t.sender.id ? t.recipient : t.sender;
	const post = new URL(req.url).searchParams.has("post");
	const link = (p: Party) => `<a href="/${esc(p.screen_name)}">${esc(p.name)}</a>${badges(p)}`;
	return page(
		req,
		viewer,
		"Payment",
		`<section class="receipt">${paymentCard(t, (mine ? viewer.screen_name : t.sender.screen_name).toLowerCase(), !t.shared)}
${mine ? `<div class="row">${postButton(paymentUrl(t.id), "Post", post)}<a class="pill" href="/account/money/send?to=${encodeURIComponent(other.screen_name)}">${viewer.id === t.sender.id ? "Pay again" : "Pay back"}</a></div>` : ""}</section>
<dl>
<dt>From</dt><dd>${link(t.sender)}</dd>
<dt>To</dt><dd>${link(t.recipient)}</dd>
<dt>Amount</dt><dd>${formatCents(t.amount)}</dd>
<dt>Date</dt><dd>${t.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</dd>
<dt>Status</dt><dd${t.reversed || t.status !== "complete" ? "" : ' style="color:var(--success)"'}>${t.reversed ? "Reversed: the money went back to the sender" : t.status === "pending" ? "Waiting for the recipient’s instance to confirm" : t.status === "failed" ? "Could not deliver; the money was refunded" : "Completed"}</dd>
</dl>`,
	);
}

// one request: pay or decline it, or as its requester share or cancel it
async function requestPage(req: Request, viewer: Viewer, id: string, status = 200, notice = "") {
	const q = (await requests([id], viewer.id)).get(id);
	if (!q) return page(req, viewer, "Request", `<p class="empty">This request doesn't exist, or isn't yours to see.</p>`, 404);
	const mine = q.requester.id === viewer.id;
	const post = new URL(req.url).searchParams.has("post");
	const open = q.status === "open";
	const link = (p: Party) => `<a href="/${esc(p.screen_name)}">${esc(p.name)}</a>${badges(p)}`;
	const actions = mine
		? `${open ? postButton(requestUrl(q.id), "Post", post) : ""}${open ? `<form method="post"><input type="hidden" name="action" value="cancel"><button type="submit" class="pill">Cancel request</button></form>` : ""}`
		: q.payer?.id === viewer.id && open
			? `<a class="pill primary" href="/account/money/send?request=${q.id}">Pay</a><form method="post"><input type="hidden" name="action" value="decline"><button type="submit" class="pill">Decline</button></form>`
			: "";
	return page(
		req,
		viewer,
		"Request",
		`${notice ? `<div class="notice" role="status">${notice}</div>` : ""}<section class="receipt">${requestCard(q, viewer.id)}${actions ? `<div class="row">${actions}</div>` : ""}</section>
<dl>
<dt>Requested by</dt><dd>${link(q.requester)}</dd>
<dt>From</dt><dd>${q.payer ? link(q.payer) : "Anyone"}</dd>
<dt>Amount</dt><dd>${q.amount ? formatCents(q.amount) : "Payer chooses"}</dd>
${q.note ? `<dt>For</dt><dd>${esc(q.note)}</dd>` : ""}
<dt>Asked</dt><dd>${q.at.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}</dd>
<dt>Status</dt><dd>${open ? (q.payer ? "Waiting" : "Open") : q.status === "paid" ? `<span style="color:var(--success)">Paid</span>` : q.status === "declined" ? "Declined" : "Cancelled"}</dd>
${!q.payer && mine ? `<dt>Paid</dt><dd>${q.paidCount} time${q.paidCount === 1 ? "" : "s"} · ${formatCents(q.paidCents)}</dd>` : ""}
</dl>`,
		status,
	);
}

// Settings > Equicoins: merchant mode, for gold organisations
export async function merchantRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (!feature("money") || viewer.instance) return accountPage({ req, viewer, status: 404, title: "Equicoins", body: `<p>Equicoins isn't available on ${esc(settings().instance_name)}.</p>` });
	let notice = "";
	let error = "";
	if (req.method === "POST") {
		const m = await merchantOf(viewer.id);
		const fresh = await formCsrfOk(req, viewer);
		const form = await req.formData();
		if (!fresh) error = "That form is out of date. Try again.";
		else if (!m.gold) error = "Merchant mode is for organisations with a gold checkmark.";
		else if (viewer.actor && viewer.actor.role !== "Admin") error = "Only the account or its admins can change this.";
		else
			try {
				await setMerchant(viewer.id, form.get("on") === "1", String(form.get("name") ?? ""), form.get("banner") === "1");
				notice = "Saved.";
			} catch (e) {
				if (!(e instanceof MoneyError)) throw e;
				error = e.message;
			}
	}
	const m = await merchantOf(viewer.id);
	const me = (await parties([viewer.id])).get(viewer.id)!;
	const [{ banner_url }] = await sql`select banner_url from users where id = ${viewer.id}::bigint`;
	const sample = { id: "0", amount: 352, note: "", at: new Date(), sender: me, recipient: me };
	const banner = m.showBanner && banner_url ? absolute(banner_url) : null;
	const asMerchant = { ...me, merchant: { name: m.name || me.name, banner: banner && /^(https?:\/\/|\/)[^\s"'()\\<>]+$/.test(banner) ? banner : null } };
	return accountPage({
		req,
		viewer,
		title: "Equicoins",
		back: { href: "/account/", label: "Back to Xitter settings" },
		css: CSS,
		body: withCsrf(`<section class="settings">${tile}
${notice ? `<div class="notice" role="status" style="margin:0">${esc(notice)}</div>` : ""}${error ? `<div class="notice error" role="alert" style="margin:0">${esc(error)}</div>` : ""}
<h2>Merchant mode</h2>
<p class="dim">Payments to your organisation read as purchases, like “${shortCents(352)} at ${esc(m.name || me.name)}”, and your Pay button carries your logo.${m.gold ? "" : " It's for organisations with a gold checkmark."}</p>
${
	m.gold
		? `<form method="post" class="send" style="padding:0">
<label class="check">Merchant mode<input type="checkbox" name="on" value="1"${m.on ? " checked" : ""}></label>
<div class="field"><input id="name" name="name" maxlength="50" placeholder=" " value="${esc(m.name)}"><label for="name">Name on purchases (empty: ${esc(me.name)})</label></div>
<label class="check"><span>Show your banner<small>Purchase cards show your header picture above your logo</small></span><input type="checkbox" name="banner" value="1"${m.showBanner ? " checked" : ""}></label>
<button type="submit" class="pill primary wide">Save</button></form>
<h2>Preview</h2><div class="preview">${paymentCard({ ...sample, recipient: asMerchant }, "")}${requestCard({ id: "0", amount: null, note: "", status: "open", at: new Date(), requester: asMerchant, payer: null, paidCount: 0, paidCents: 0 }, "")}</div>`
		: ""
}</section>`, viewer),
	});
}

// The first time Equicoins opens, before anything else: what its money is. The
// page asked for comes back once it's accepted.
function disclaimer(req: Request, viewer: Viewer, back: string) {
	const name = esc(`${settings().instance_name} Equicoins`);
	return page(
		req,
		viewer,
		"Equicoins",
		`<section class="settings" style="padding:32px 16px">${tile}
<h1>Welcome to ${name}</h1>
<p><b>Disclaimer:</b> ${esc(disclaimerText())}</p>
<form method="post" action="/account/money" class="send" style="padding:8px 0 0"><input type="hidden" name="action" value="accept"><input type="hidden" name="back" value="${esc(back)}">
<button type="submit" class="pill primary wide">I understand</button></form></section>`,
		200,
		{ href: "/home", label: "Back to home" },
	);
}

export async function moneyRoute(req: Request, viewer: Viewer): Promise<Response> {
	if (!feature("money") || viewer.instance)
		return accountPage({ req, viewer, status: 404, title: "Equicoins", body: `<h1>Equicoins</h1><p>Equicoins isn't available on ${esc(settings().instance_name)}.</p>` });
	const url = new URL(req.url);
	const p = url.pathname;
	const remoteBadge = /^\/account\/money\/shop\/badge\/([^/]{1,300})\/(\d{1,19})$/.exec(p);
	if (req.method === "GET" && remoteBadge) {
		let origin = "";
		try { origin = decodeURIComponent(remoteBadge[1]).toLowerCase(); } catch {}
		if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::\d{1,5})?$/.test(origin)) return new Response("Not found", { status: 404 });
		const [image] = await sql`select badge_image, badge_mime from money_remote_shop_items
			where origin = ${origin} and remote_id = ${remoteBadge[2]}::bigint and source_active and active and status = 'approved'`;
		if (!image?.badge_image || !BADGE_TYPES.includes(image.badge_mime)) return new Response("Not found", { status: 404 });
		return new Response(image.badge_image, { headers: { "content-type": image.badge_mime, "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" } });
	}
	// a picture sent with a shop request, for the staff who review it (Admin > Equicoins)
	const orderFile = /^\/account\/money\/shop\/file\/(\d{1,19})\/(\d{1,2})$/.exec(p);
	if (req.method === "GET" && orderFile) {
		if (viewer.role !== "admin" && viewer.role !== "moderator") return new Response("Not found", { status: 404 });
		const [f] = await sql`select image, mime from money_shop_order_files where order_id = ${orderFile[1]}::bigint and position = ${Number(orderFile[2])}`;
		if (!f) return new Response("Not found", { status: 404 });
		return new Response(f.image, { headers: { "content-type": f.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
	}
	if (req.method === "POST" && !(await formCsrfOk(req, viewer))) return new Response("That form is out of date. Go back and try again.", { status: 403 });
	if (!(await disclaimerAccepted(viewer.id))) {
		if (req.method !== "POST") return disclaimer(req, viewer, p + url.search);
		const form = await req.formData();
		if (form.get("action") !== "accept" || (viewer.actor && viewer.actor.role !== "Admin")) return disclaimer(req, viewer, "/account/money");
		await acceptDisclaimer(viewer.id);
		// only back to one of Money's own pages
		const back = String(form.get("back") ?? "");
		return new Response(null, { status: 303, headers: { location: /^\/account\/money(\/[\w/]*)?(\?[\w=&%.-]*)?$/.test(back) ? back : "/account/money" } });
	}
	const payment = /^\/account\/money\/p\/(\d{1,19})$/.exec(p);
	if (payment) return paymentPage(req, viewer, payment[1]);
	const asked = /^\/account\/money\/r\/(\d{1,19})$/.exec(p);
	if (asked) {
		if (req.method !== "POST") return requestPage(req, viewer, asked[1]);
		const action = String((await req.formData()).get("action") ?? "");
		if ((action !== "decline" && action !== "cancel") || viewer.actor) return requestPage(req, viewer, asked[1], 400);
		const done = await closeRequest(viewer.id, asked[1], action);
		// from the Money page's list, back to it
		if (done && (req.headers.get("referer") ?? "").replace(/\?.*$/, "").endsWith("/account/money"))
			return new Response(null, { status: 303, headers: { location: `/account/money?${action === "decline" ? "declined" : "cancelled"}=1` } });
		return requestPage(req, viewer, asked[1], done ? 200 : 409, done ? (action === "decline" ? "Declined." : "Cancelled.") : "");
	}
	if (p === "/account/money/request") {
		if (viewer.actor) return home(req, viewer, 403, "", `Only @${viewer.screen_name} can ask for money for this account.`);
		if (req.method !== "POST") return requestView(req, viewer);
		const form = await req.formData();
		const values = { from: String(form.get("from") ?? ""), amount: String(form.get("amount") ?? ""), note: String(form.get("note") ?? "") };
		if (!hit("write", viewer.id).ok) return requestView(req, viewer, 429, values, "You're asking too fast. Wait a few minutes and try again.");
		try {
			const id = await requestMoney(viewer.id, values.from, values.amount.trim() === "0" ? "" : values.amount, values.note);
			return new Response(null, { status: 303, headers: { location: `/account/money/r/${id}${form.get("share") ? "?post=1" : ""}` } });
		} catch (e) {
			if (e instanceof MoneyError) return requestView(req, viewer, 400, values, e.message);
			throw e;
		}
	}
	if (p === "/account/money/shop") {
		if (!settings().money_shop.enabled) return page(req, viewer, "Equicoins shop", `<p class="empty">The shop is closed.</p>`, 404);
		let error = "";
		if (req.method === "POST") {
			if (viewer.actor) error = `Only @${esc(viewer.screen_name)} can buy from this account.`;
			else if (!hit("write", viewer.id).ok) error = "You're sending requests too fast. Wait a few minutes and try again.";
			else {
				const form = await req.formData();
				const text = (k: string) => String(form.get(k) ?? "");
				const image = async (f: FormDataEntryValue | null) => (f instanceof File && f.size ? Buffer.from(await f.arrayBuffer()) : undefined);
				try {
					const stickers: Buffer[] = [];
					for (const f of form.getAll("stickers").slice(0, 7)) {
						const b = await image(f);
						if (b) stickers.push(b);
					}
					const bought = await buyShopItem(viewer.id, text("item"), {
						text: text("text"),
						link: text("link"),
						badgeName: text("badgeName"),
						badgeImage: await image(form.get("badgeImage")),
						gift: text("gift"),
						hashtag: text("hashtag"),
						emoji: await image(form.get("emoji")),
						packName: text("packName"),
						stickers,
						title: text("title"),
						summary: text("summary"),
						query: text("query"),
						picture: await image(form.get("picture")),
						post: text("post"),
					});
					return new Response(null, { status: 303, headers: { location: `/account/money/shop?${bought.auto ? "ready" : "requested"}=1` } });
				} catch (e) {
					if (e instanceof ShopError) error = e.message;
					else throw e;
				}
			}
		}
		const [items, orders, balance] = await Promise.all([shopItems(true), myShopOrders(viewer.id), balanceOf(viewer.id)]);
		const notice = url.searchParams.has("ready") ? "It's ready: find it under Your requests." : url.searchParams.has("requested") ? "Your request is waiting for staff approval." : "";
		return page(req, viewer, "Equicoins shop", await shopView(items, orders, balance, error, notice));
	}
	if (p === "/account/money/people") return peopleApi(viewer, url.searchParams.get("q") ?? "", url.searchParams.has("local"));
	const sending = p === "/account/money/send";
	if (!sending && p !== "/account/money") return new Response("not found", { status: 404 });
	if (req.method !== "POST") {
		if (sending) return viewer.actor ? home(req, viewer, 403, "", `Only @${viewer.screen_name} can send money from this account.`) : sendView(req, viewer);
		const sent = url.searchParams.get("sent");
		const [t] = sent && /^\d{1,19}$/.test(sent) ? await sql`select t.id::text, t.amount_cents, u.screen_name from money_transfers t join users u on u.id = t.recipient_id where t.id = ${sent}::bigint and t.sender_id = ${viewer.id}::bigint` : [];
		const notice = t
			? `<span>Sent ${formatCents(Number(t.amount_cents))} to @${esc(t.screen_name)}.</span><button type="button" class="pill small" data-compose="${esc(paymentUrl(t.id))}">Post it</button>`
			: url.searchParams.has("declined")
				? "Request declined."
				: url.searchParams.has("cancelled")
					? "Request cancelled."
					: "";
		return home(req, viewer, 200, notice);
	}
	const form = await req.formData();
	const field = (k: string) => String(form.get(k) ?? "");
	const values = { to: field("to"), amount: field("amount"), note: field("note"), request: field("request") || undefined };
	if (viewer.actor) return home(req, viewer, 403, "", `Only @${viewer.screen_name} can send money from this account.`);
	if (!hit("write", viewer.id).ok) return sendView(req, viewer, 429, values, "You're sending too fast. Wait a few minutes and try again.");
	const cents = parseAmount(values.amount);
	if (cents === null) return sendView(req, viewer, 400, values, "Enter an amount, like 5 or 12.50.");
	try {
		const r = await sendMoney(viewer.id, values.to, cents, values.note, field("idem"), values.request);
		// after a send the page reloads by GET, so going back or refreshing can't send it twice
		const to = field("share") ? `/account/money/p/${r.id}?post=1` : `/account/money?sent=${r.id}`;
		return new Response(null, { status: 303, headers: { location: to } });
	} catch (e) {
		if (e instanceof MoneyError) return sendView(req, viewer, 400, values, e.message);
		throw e;
	}
}

