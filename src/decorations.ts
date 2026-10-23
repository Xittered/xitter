import { sql } from "./db";
import { readLimited } from "./federation";
import { DISCORD_DECORATIONS } from "./decoration-presets";
import { STAFF_HANDLE } from "./invites";

export type Decoration =
	| {
			type: "ears";
			style: EarStyle;
			color: string;
			inner: string;
			bow: string | null;
	  }
	| { type: "discord"; asset: string };

export const EAR_STYLES = ["pointy", "round", "tilted", "fluffy"] as const;
type EarStyle = (typeof EAR_STYLES)[number];

const HEX = /^#[0-9a-f]{6}$/;
const PRESETS = new Set(DISCORD_DECORATIONS.map((d) => d.asset));

export function parseDecoration(value: unknown): Decoration | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (v.type === "discord")
		return typeof v.asset === "string" && PRESETS.has(v.asset)
			? { type: "discord", asset: v.asset }
			: null;
	if (v.type !== "ears") return null;
	const hex = (x: unknown) =>
		typeof x === "string" && HEX.test(x.toLowerCase())
			? x.toLowerCase()
			: undefined;
	const style = EAR_STYLES.includes(v.style as EarStyle)
		? (v.style as EarStyle)
		: "pointy";
	const color = hex(v.color);
	const inner = hex(v.inner);
	if (!color || !inner) return null;
	return { type: "ears", style, color, inner, bow: hex(v.bow) ?? null };
}

export function decorationUrl(
	d: Decoration | null,
	animated = false,
): string | null {
	if (!d) return null;
	if (d.type === "discord")
		return `/i/xitter/decoration/${d.asset}.png${animated ? "?animated=1" : ""}`;
	const q = new URLSearchParams({
		s: d.style,
		c: d.color.slice(1),
		i: d.inner.slice(1),
	});
	if (d.bow) q.set("b", d.bow.slice(1));
	return `/i/xitter/decoration/ears.svg?${q}`;
}

const EARS: Record<EarStyle, { path: string; center: [number, number] }> = {
	pointy: { path: "M19 38 L13 4 L48 14 Q31 19 19 38 Z", center: [26, 20] },
	round: {
		path: "M19 38 C7 22 9 5 22 4 C33 3 43 9 48 14 Q31 19 19 38 Z",
		center: [26, 19],
	},
	tilted: { path: "M19 38 L2 14 L45 13 Q30 20 19 38 Z", center: [22, 22] },
	fluffy: {
		path: "M19 38 L16 25 L11 22 L15 17 L12 4 L25 9 L30 6 L33 11 L48 14 Q31 19 19 38 Z",
		center: [26, 19],
	},
};

export function earsSvg(
	style: EarStyle,
	color: string,
	inner: string,
	bow: string | null,
): string {
	const ear = EARS[style];
	const [cx, cy] = ear.center;
	const one = `<path d="${ear.path}" fill="${color}" stroke="${color}" stroke-width="3" stroke-linejoin="round"/>
<path d="${ear.path}" fill="${inner}" transform="translate(${cx} ${cy + 3}) scale(0.5) translate(${-cx} ${-cy})"/>`;
	const ribbon = bow
		? `<g transform="translate(83 21) rotate(28)" fill="${bow}" stroke="${bow}" stroke-width="1.5" stroke-linejoin="round"><path d="M0 0 L-10 -6 L-10 6 Z"/><path d="M0 0 L10 -6 L10 6 Z"/><circle r="3.2"/></g>`
		: "";
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">${one}<g transform="translate(120 0) scale(-1 1)">${one}</g>${ribbon}</svg>`;
}

const memory = new Map<string, Uint8Array>();
let memoryBytes = 0;
const MEMORY_CAP = 64 * 1024 * 1024;

async function discordArt(
	asset: string,
	animated: boolean,
): Promise<Uint8Array | undefined> {
	const key = `${asset}${animated ? ":a" : ""}`;
	const hit = memory.get(key);
	if (hit) {
		memory.delete(key);
		memory.set(key, hit);
		return hit;
	}
	const r = await fetch(
		`https://cdn.discordapp.com/avatar-decoration-presets/${asset}.png?size=240&passthrough=${animated}`,
		{ redirect: "error", signal: AbortSignal.timeout(15_000) },
	).catch(() => undefined);
	if (!r?.ok || !r.headers.get("content-type")?.startsWith("image/"))
		return undefined;
	const bytes = await readLimited(r, 4 * 1024 * 1024).catch(() => undefined);
	if (!bytes) return undefined;
	memory.set(key, bytes);
	memoryBytes += bytes.length;
	for (const [k, v] of memory) {
		if (memoryBytes <= MEMORY_CAP) break;
		memory.delete(k);
		memoryBytes -= v.length;
	}
	return bytes;
}

export async function decorationFile(url: URL): Promise<Response | undefined> {
	const m =
		/^\/i\/xitter\/decoration\/(ears\.svg|(?:a_)?[0-9a-f]{32}\.png)$/.exec(
			url.pathname,
		);
	if (!m) return undefined;
	const immutable = {
		"cache-control": "public, max-age=604800, immutable",
		"x-content-type-options": "nosniff",
	};
	if (m[1] === "ears.svg") {
		const p = url.searchParams;
		const d = parseDecoration({
			type: "ears",
			style: p.get("s"),
			color: `#${p.get("c")}`,
			inner: `#${p.get("i")}`,
			bow: p.get("b") ? `#${p.get("b")}` : null,
		});
		if (d?.type !== "ears") return new Response("bad colours", { status: 400 });
		return new Response(earsSvg(d.style, d.color, d.inner, d.bow), {
			headers: {
				...immutable,
				"content-type": "image/svg+xml",
				"content-security-policy":
					"default-src 'none'; style-src 'unsafe-inline'",
			},
		});
	}
	const asset = m[1].slice(0, -4);
	if (!PRESETS.has(asset)) return new Response("not found", { status: 404 });
	const bytes = await discordArt(
		asset,
		url.searchParams.get("animated") === "1",
	);
	if (!bytes) return new Response("unavailable", { status: 502 });
	return new Response(bytes as Uint8Array<ArrayBuffer>, {
		headers: { ...immutable, "content-type": "image/png" },
	});
}

export async function decorationsFor(url: URL): Promise<Response> {
	const names = [
		...new Set(
			(url.searchParams.get("names") ?? "")
				.split(",")
				.map((n) => n.trim().toLowerCase())
				.filter((n) => {
					const at = n.indexOf("@");
					return at < 0
						? STAFF_HANDLE.test(n)
						: STAFF_HANDLE.test(n.slice(0, at)) &&
								/^[a-z0-9.-]{1,253}(?::\d{1,5})?$/.test(n.slice(at + 1));
				}),
		),
	].slice(0, 100);
	const out: Record<string, { still: string; animated: string }> = {};
	if (names.length) {
		const rows =
			await sql`select lower(screen_name) as name, decoration from users where lower(screen_name) = any(${sql.array(names, "TEXT")}) and decoration is not null
			and status <> 'suspended' and not instance_blocked`;
		for (const r of rows) {
			const d = parseDecoration(r.decoration);
			const still = decorationUrl(d);
			if (still)
				out[r.name] = { still, animated: decorationUrl(d, true) ?? still };
		}
	}
	return Response.json(out, {
		headers: { "cache-control": "private, max-age=60" },
	});
}

export const DECORATIONS_SCRIPT = `(function(){
	var known={},waiting={},timer;
	var PREFIX="UserAvatar-Container-";
	function nameOf(el){var t=el.getAttribute("data-testid")||"";return t.indexOf(PREFIX)===0?t.slice(PREFIX.length).toLowerCase():""}
	function paint(el){
		var name=nameOf(el);if(!name)return;
		var d=known[name];
		var img=el.querySelector(":scope > img.xitter-deco");
		if(!d){if(img)img.remove();return}
		var big=el.offsetWidth>=100;
		var src=big?d.animated:d.still;
		if(img&&img.getAttribute("src")===src)return;
		if(!img){img=document.createElement("img");img.className="xitter-deco";img.alt="";img.setAttribute("aria-hidden","true");img.draggable=false;el.appendChild(img)}
		img.src=src;
		if(getComputedStyle(el).position==="static")el.style.position="relative";
	}
	function ask(){
		timer=null;
		var names=Object.keys(waiting).slice(0,100);
		if(!names.length)return;
		names.forEach(function(n){delete waiting[n];known[n]=known[n]||null});
		fetch("/i/api/xitter/decorations?names="+encodeURIComponent(names.join(",")),{credentials:"include"}).then(function(r){return r.ok?r.json():{}}).then(function(found){
			names.forEach(function(n){known[n]=found[n]||null});
			scan(document);
		}).catch(function(){});
		if(Object.keys(waiting).length)timer=setTimeout(ask,50);
	}
	function scan(root){
		var els=root.querySelectorAll?root.querySelectorAll('[data-testid^="'+PREFIX+'"]'):[];
		for(var i=0;i<els.length;i++){
			var n=nameOf(els[i]);if(!n)continue;
			if(!(n in known)){waiting[n]=1;if(!timer)timer=setTimeout(ask,80)}
			else paint(els[i]);
		}
	}
	var css=document.createElement("style");
	css.textContent='img.xitter-deco{position:absolute;left:-10%;top:-10%;width:120%;height:120%;max-width:none;pointer-events:none;z-index:2;user-select:none}[data-testid^="'+PREFIX+'"]{overflow:visible!important}';
	document.head.appendChild(css);
	new MutationObserver(function(ms){for(var i=0;i<ms.length;i++)for(var j=0;j<ms[i].addedNodes.length;j++){var a=ms[i].addedNodes[j];if(a.nodeType===1){if(a.matches&&a.matches('[data-testid^="'+PREFIX+'"]'))scan(a.parentNode||document);else scan(a)}}}).observe(document.documentElement,{childList:true,subtree:true});
	window.addEventListener("xitter-decoration-changed",function(e){var n=e.detail&&e.detail.name;if(n){delete known[n];waiting[n]=1;if(!timer)timer=setTimeout(ask,10)}});
	scan(document);
})();`;
