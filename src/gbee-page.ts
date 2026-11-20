import { accountPage, esc } from "./account-page";
import type { Viewer } from "./auth";
import { BEE } from "./bee-icon";
import { grokName } from "./grok";
import { DOUG_SCRIPT } from "./doug";
import { PIRATE_SCRIPT } from "./pirate";


const CSS = `
.gb{display:flex;flex-direction:column;gap:12px;min-height:60vh}
.gb-head{display:flex;align-items:center;gap:10px;justify-content:space-between}
.gb-head h1{display:flex;align-items:center;gap:8px;margin:0}
.gb-head svg{width:30px;height:30px;fill:currentColor}
.gb-log{display:flex;flex-direction:column;gap:10px;flex:1}
.gb-msg{max-width:85%;padding:10px 14px;border-radius:18px;white-space:pre-wrap;word-wrap:break-word;line-height:1.4}
.gb-me{align-self:flex-end;background:var(--accent);color:#fff}
.gb-bot{align-self:flex-start;background:var(--surface);border:1px solid var(--border)}
.gb-form{display:flex;gap:8px;position:sticky;bottom:0;background:var(--bg);padding:8px 0}
.gb-form textarea{flex:1;min-height:44px;max-height:160px;resize:vertical;border-radius:22px;padding:11px 16px}
.gb-form button{border-radius:22px;padding:0 18px}
.gb-chats{display:flex;flex-wrap:wrap;gap:6px}
.gb-chats a{font-size:13px;padding:4px 10px;border:1px solid var(--border);border-radius:14px;color:var(--text);text-decoration:none;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gb-chats a.on{border-color:var(--accent);color:var(--accent)}
.gb-empty{color:var(--muted);text-align:center;margin:auto 0}
`;

const SCRIPT = `(function(){
var log=document.getElementById("gbLog"),form=document.getElementById("gbForm"),box=document.getElementById("gbText"),chats=document.getElementById("gbChats"),empty=document.getElementById("gbEmpty");
var conv=new URL(location.href).searchParams.get("c")||"";
var csrf=(document.cookie.match(/(?:^|; )ct0=([^;]*)/)||[])[1]||"";
function add(cls,text){if(empty)empty.remove();empty=null;var d=document.createElement("div");d.className="gb-msg "+cls;d.textContent=text;log.appendChild(d);d.scrollIntoView({block:"end"});return d}
function gql(op,vars){return fetch("/i/api/graphql/x/"+op+"?variables="+encodeURIComponent(JSON.stringify(vars||{})),{credentials:"include",headers:{"x-csrf-token":csrf}}).then(function(r){return r.json()})}
function loadChats(){gql("GrokHistory",{}).then(function(j){var items=((j.data||{}).grok_conversation_history||{}).items||[];chats.innerHTML="";items.slice(0,12).forEach(function(c){var a=document.createElement("a");a.href="?c="+c.grokConversation.rest_id;a.textContent=c.title||"Chat";if(c.grokConversation.rest_id===conv)a.className="on";chats.appendChild(a)})})}
if(conv)gql("GrokConversationItemsByRestId",{restId:conv}).then(function(j){var items=(((j.data||{}).grok_conversation_items_by_rest_id||{}).items||[]).slice().reverse();items.forEach(function(i){add(i.sender_type==="User"?"gb-me":"gb-bot",i.message)})});
loadChats();
box.addEventListener("keydown",function(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();form.requestSubmit()}});
form.addEventListener("submit",function(e){
e.preventDefault();var text=box.value.trim();if(!text)return;box.value="";add("gb-me",text);var out=add("gb-bot","…"),said="";
var btn=form.querySelector("button");btn.disabled=true;
fetch("/i/api/2/grok/add_response.json",{method:"POST",credentials:"include",headers:{"content-type":"application/json","x-csrf-token":csrf},body:JSON.stringify({responses:[{message:text,sender:1}],conversationId:conv||undefined})}).then(function(r){
if(!r.ok||!r.body){out.textContent="Something went wrong. Try again.";return}
var reader=r.body.getReader(),dec=new TextDecoder(),buf="";
function pump(){return reader.read().then(function(x){if(x.done)return;buf+=dec.decode(x.value,{stream:true});var lines=buf.split("\\n");buf=lines.pop();lines.forEach(function(l){if(!l.trim())return;var j=JSON.parse(l);if(j.conversationId&&!conv){conv=j.conversationId;history.replaceState(null,"","?c="+conv)}var m=j.result&&j.result.message;if(m){said+=m;out.textContent=said;out.scrollIntoView({block:"end"})}});return pump()})}
return pump();
}).catch(function(){out.textContent="Something went wrong. Try again."}).then(function(){btn.disabled=false;box.focus();loadChats()});
});
box.focus();
})();`;

export function gbeePage(req: Request, viewer: Viewer) {
	const name = grokName();
	return accountPage({
		req,
		viewer,
		title: name,
		css: CSS,
		back: { href: "/home", label: "Back to Home" },
		body: `<div class="gb">
<div class="gb-head"><h1><svg viewBox="0 -960 960 960" aria-hidden="true"><path d="${BEE}"/></svg>${esc(name)}</h1><a href="/i/grok">New chat</a></div>
<div class="gb-chats" id="gbChats"></div>
<div class="gb-log" id="gbLog"><p class="gb-empty" id="gbEmpty">Ask ${esc(name)} anything.</p></div>
<form class="gb-form" id="gbForm"><textarea id="gbText" placeholder="Ask anything" rows="1"></textarea><button type="submit">Send</button></form>
</div>
<script>${SCRIPT}</script>
<script>${PIRATE_SCRIPT}</script>
<script>${DOUG_SCRIPT}</script>`,
	});
}
