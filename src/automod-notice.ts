export const NOTICE_SCRIPT = `(function(){
	var showing=false,timer=null;
	function csrf(){return(document.cookie.match(/(?:^|;\\s*)ct0=([^;]+)/)||[])[1]||""}
	function theme(){var m=(document.cookie.match(/(?:^|;\\s*)night_mode=(\\d)/)||[])[1];if(m==="0")return"light";if(m==="1")return"dim";if(m==="2")return"dark";return matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"}
	var COLORS={light:["#fff","#0f1419","#536471","#eff3f4"],dim:["#15202b","#f7f9f9","#8b98a5","#38444d"],dark:["#000","#e7e9ea","#71767b","#2f3336"]};
	var TITLE={strike:"You got a strike",warning:"Your post wasn't published",message:"A message from staff"};
	function show(m){
		showing=true;
		var c=COLORS[theme()],back=document.createElement("div"),card=document.createElement("div"),h=document.createElement("h2"),p=document.createElement("p"),row=document.createElement("div"),more=document.createElement("a"),ok=document.createElement("button");
		back.setAttribute("role","alertdialog");back.setAttribute("aria-modal","true");
		back.style.cssText="position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(91,112,131,.4);font-family:TwitterChirp,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
		card.style.cssText="box-sizing:border-box;width:min(440px,100%);max-height:90vh;overflow:auto;border-radius:16px;padding:32px;background:"+c[0]+";color:"+c[1]+";box-shadow:0 0 15px rgba(101,119,134,.2),0 0 3px 1px rgba(101,119,134,.15)";
		h.style.cssText="margin:0 0 12px;font-size:24px;font-weight:800;line-height:28px";
		h.textContent=TITLE[m.kind]||TITLE.message;
		p.style.cssText="margin:0 0 24px;font-size:15px;line-height:20px;color:"+c[2]+";white-space:pre-wrap";
		p.textContent=m.body;
		row.style.cssText="display:flex;flex-direction:column;gap:12px";
		ok.type="button";ok.textContent="Okay";
		ok.style.cssText="height:52px;border-radius:9999px;border:0;font:inherit;font-size:17px;font-weight:700;cursor:pointer;background:"+c[1]+";color:"+c[0];
		more.href="/account/notices";more.textContent="See everything from staff";
		more.style.cssText="text-align:center;font-size:15px;color:rgb(29,155,240);text-decoration:none";
		ok.onclick=function(){
			ok.disabled=true;
			fetch("/i/api/xitter/moderation",{method:"POST",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":csrf()},body:JSON.stringify({action:"read",id:m.id})})
				.finally(function(){back.remove();showing=false;check()});
		};
		row.appendChild(ok);row.appendChild(more);
		card.appendChild(h);card.appendChild(p);card.appendChild(row);back.appendChild(card);
		document.body.appendChild(back);
		ok.focus();
	}
	function check(){
		if(showing||!csrf()||document.visibilityState==="hidden")return;
		fetch("/i/api/xitter/moderation",{credentials:"same-origin",headers:{"x-csrf-token":csrf()}}).then(function(r){return r.ok?r.json():null}).then(function(d){
			if(!d||showing)return;
			var m=(d.messages||[]).filter(function(x){return!x.read_at&&!x.revoked_at}).pop();
			if(m)show(m);
		},function(){});
	}
	function soon(){clearTimeout(timer);timer=setTimeout(check,600)}
	function posting(url,method){return String(method||"GET").toUpperCase()==="POST"&&/\\/graphql\\/[^/]+\\/(Create|Edit|Update|Upsert|Birdwatch|Article|List|Community|Poll)/i.test(String(url))||/\\/1\\.1\\/account\\/update_profile/.test(String(url))}
	var f=window.fetch;
	window.fetch=function(input,init){
		var p=f.apply(this,arguments);
		try{if(posting(typeof input==="string"?input:input.url,(init&&init.method)||(input&&input.method)))p.then(soon,function(){})}catch(e){}
		return p;
	};
	var open=XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open=function(method,url){
		try{if(posting(url,method))this.addEventListener("loadend",soon)}catch(e){}
		return open.apply(this,arguments);
	};
	document.addEventListener("visibilitychange",check);
	setInterval(check,60000);
	setTimeout(check,2500);
})();`;
