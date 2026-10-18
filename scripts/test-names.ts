// Blocked names: sign-up refused, renames suspend members, staff only refused,
// the admin check lists existing accounts. Run against the live server.
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { SignupError, checkSignup } from "../src/invites";
import { blockedNameIn, blockedWordIn, normalizeName } from "../src/names";
import { loadSettings } from "../src/settings";

const origin="http://localhost:3000",password="testpass123",WORD="zorbleflax";
let checks=0;
const check=(ok:unknown,label:string)=>{if(!ok)throw new Error(label);checks++;console.log("ok  ",label);};
async function session(username:string){
	const r=await fetch(origin+"/login",{method:"POST",body:new URLSearchParams({username,password}),redirect:"manual"});
	const cookies=r.headers.getSetCookie().map(c=>c.split(';')[0]);
	const headers={cookie:cookies.join('; '),'x-csrf-token':cookies.find(c=>c.startsWith('ct0='))!.slice(4)};
	return {headers,
		admin:async(action:string,body:any={})=>{const r=await fetch(origin+'/admin/api/'+action,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json() as any};},
		post:async(path:string,f:Record<string,string>)=>{const r=await fetch(origin+'/i/api'+path,{method:'POST',headers,body:new URLSearchParams(f)});return {status:r.status,text:await r.text()};},
	};
}
const status=async(id:string)=>(await sql`select status from users where id=${id}::bigint`)[0].status;
const created:string[]=[];
const admin=await session('pozo');
const {operations}=(await admin.admin('operations')).data;
try{
	check((await admin.admin('saveOperations',{...operations,blocked_names:[...(operations.blocked_names??[]),WORD]})).status===200,'list saved');
	await loadSettings();
	check(normalizeName('Z0rb_l3-ffLAX')==='z0rbl3fflax','normalised: case and separators');
	check(blockedNameIn('xx_z0rbl3fl4x_xx')===WORD,'matched inside a longer name');
	check(blockedNameIn('ZZZORB1EEEFLAX')===WORD,'repeats and 1 for l');
	check(!blockedNameIn('harmless name'),'clean name passes');
	await admin.admin('saveOperations',{...operations,blocked_names:[WORD,'nigger','kkk']});
	await loadSettings();
	check(blockedNameIn('N_1-GGG3rr')==='nigger','digits, separators and repeats');
	check(!blockedNameIn('Nigeria')&&!blockedNameIn('Niger Delta'),'a doubled letter needs two: Nigeria passes');
	check(blockedNameIn('kkkk')==='kkk'&&!blockedNameIn('kick'),'kkk needs three ks, a single k passes');
	// letters from other scripts and Unicode styles that pass for Latin ones
	for(const s of['nіggеr','ИIGGER','nιggεr','ɴɪɢɢᴇʀ','🇳🇮🇬🇬🇪🇷','ｎｉｇｇｅｒ','𝐧𝐢𝐠𝐠𝐞𝐫','ⓝⓘⓖⓖⓔⓡ','n​igger','NÏGGËR'])
		check(blockedNameIn(s)==='nigger','look-alike caught: '+JSON.stringify(s));
	// a real one: math symbols and capital Greek as Latin letters
	check(normalizeName('faΣ ∂ń©ś^¨ńķąć^∂śļą^∂ΔĻ∂∂')==='faedncsnkacdsladaldd','symbols read as letters: ∂ d, © c, Σ e, Δ a');
	for(const s of['Иван Петров','Νίκος Παπαδόπουλος','Нигерия','Łukasz','Ølstrup'])
		check(!blockedNameIn(s),'ordinary name passes: '+s);
	await admin.admin('saveOperations',{...operations,blocked_names:[...(operations.blocked_names??[]),WORD]});
	await loadSettings();
	const signup=async(screenName:string,name:string)=>{try{await checkSignup({screenName,name,password:'longenough1',email:'n@example.com'} as any);return 'ok';}catch(e){return e instanceof SignupError?e.message:String(e);}};
	check((await signup('z0rbleflax','fine')).includes("isn't allowed"),'sign-up refused for a blocked handle');
	check((await signup('cleanhandle','Mr Zorbleflax')).includes("isn't allowed"),'sign-up refused for a blocked display name');
	check(!(await signup('cleanhandle','fine')).includes("isn't allowed"),'clean sign-up not refused for the name');
	const names:string[]=[];
	for(let i=0;i<3;i++){const n='nm'+Date.now().toString().slice(-9)+i;names.push(n);created.push(await createUser(n,n,password));}
	await sql`update users set role='moderator' where id=${created[2]}::bigint`;
	const a=await session(names[0]),b=await session(names[1]),staff=await session(names[2]);
	const r1=await a.post('/1.1/account/update_profile.json',{name:'The Zorbleflax'});
	check(r1.status>=400&&await status(created[0])==='suspended','display-name change suspends');
	check((await fetch(origin+'/i/api/1.1/account/settings.json',{headers:a.headers})).status===401,'and signs them out');
	const r2=await b.post('/1.1/account/settings.json',{screen_name:'zorbleflax_'+names[1].slice(-3)});
	check(r2.status===400&&await status(created[1])==='suspended','handle change suspends');
	check((await sql`select 1 from audit_log where action='auto_suspend_name' and target=${created[1]}`).length===1,'audit line written');
	// reserved handles are refused at rename too, not only at sign-up
	const reserved=await staff.post('/1.1/account/settings.json',{screen_name:'Admin'});
	check(reserved.status===400&&reserved.text.includes('reserved')&&(await sql`select screen_name from users where id=${created[2]}::bigint`)[0].screen_name===names[2],'reserved handle refused at rename');
	const r3=await staff.post('/1.1/account/update_profile.json',{name:'Zorbleflax staff'});
	check(r3.status>=400&&await status(created[2])!=='suspended','staff only refused');
	await sql`update users set status='active', name='Zorbleflax old' where id=${created[0]}::bigint or id=${created[2]}::bigint`;
	const hits=(await admin.admin('blockedNameAccounts',{})).data.accounts;
	check(hits.some((u:any)=>u.id===created[0])&&hits.some((u:any)=>u.id===created[2]&&u.staff),'check lists existing matches, staff marked');
	check(await status(created[0])!=='suspended','listing alone suspends nobody');
	await admin.admin('blockedNameAccounts',{suspend:true});
	check(await status(created[0])==='suspended'&&await status(created[2])!=='suspended','suspend button: members only');
	check((await (await fetch(origin+'/admin',{headers:admin.headers})).text()).includes('blockedNames'),'admin page carries the box');

	// longer fields are read word by word
	check(!blockedWordIn('a taco only a day'),'words aren\'t joined across spaces in a bio');
	check(blockedWordIn('fan of z o r b l e f l a x')===WORD&&blockedWordIn('z.0.r.b.l.e.f.l.a.x!')===WORD,'spelled-out letters are joined');
	check(blockedWordIn('https://zorbleflax.example/x')===WORD,'a link is read too');
	// profiles: bio, location, website suspend; a blocked phrase is only refused; nothing half-saved
	const more:string[]=[];
	for(let i=0;i<3;i++){const n='nq'+Date.now().toString().slice(-9)+i;more.push(n);created.push(await createUser(n,n,password));}
	const [bioId,siteId,phraseId]=created.slice(-3);
	const bio=await session(more[0]),site=await session(more[1]),phrase=await session(more[2]);
	const r4=await bio.post('/1.1/account/update_profile.json',{name:'Fresh name',description:'I am a big Zоrblеflax fan'});
	check(r4.status>=400&&await status(bioId)==='suspended','a blocked word in the bio suspends');
	check((await sql`select name from users where id=${bioId}::bigint`)[0].name!=='Fresh name','and nothing of that request was saved');
	await site.post('/1.1/account/update_profile.json',{url:'https://zorbleflax.example'});
	check(await status(siteId)==='suspended','a blocked word in the website suspends');
	await admin.admin('saveOperations',{...operations,blocked_names:[...(operations.blocked_names??[]),WORD],blocked_phrases:[...operations.blocked_phrases,'zorble flax']});
	const r5=await phrase.post('/1.1/account/update_profile.json',{location:'Zorble Flax town'});
	check(r5.status>=400&&await status(phraseId)!=='suspended','a blocked phrase in the location is refused, not suspended');
	check((await phrase.post('/1.1/account/update_profile.json',{location:'Taco town',description:'taco only'})).status===200,'ordinary bio and location save');
	// everything else people can name or write
	const gql=async(s:any,op:string,variables:any)=>(await(await fetch(origin+'/i/api/graphql/q/'+op,{method:'POST',headers:{...s.headers,'content-type':'application/json'},body:JSON.stringify({variables})})).json()) as any;
	check(!!(await gql(phrase,'CreateList',{name:'zorbleflax club',description:'',isPrivate:false})).errors?.length,'a list name with a blocked word is refused');
	check(!!(await gql(phrase,'CreateCommunity',{name:'Z0rbleflax crew '+Date.now(),description:'',joinPolicy:'Open',invitesPolicy:'MemberInvitesAllowed',question:''})).errors?.length,'a community name with a blocked word is refused');
	const poll=await phrase.post('/v2/cards/create.json',{card_data:JSON.stringify({'twitter:card':'poll2choice_text_only','twitter:api:api:endpoint':'1','twitter:long:duration_minutes':60,'twitter:string:choice1_label':'yes','twitter:string:choice2_label':'zorbleflax'})});
	check(poll.status>=400||JSON.parse(poll.text).errors,'a poll choice with a blocked word is refused');
	const alt=await fetch(origin+'/i/api/1.1/media/metadata/create.json',{method:'POST',headers:{...phrase.headers,'content-type':'application/json'},body:JSON.stringify({media_id:'1',alt_text:{text:'a zorble flax picture'}})});
	check(alt.status===400,'an image description with a blocked phrase is refused');
	await sql`update users set status='active', bio='zorbleflax forever' where id=${created[0]}::bigint`;
	check((await admin.admin('blockedNameAccounts',{})).data.accounts.some((u:any)=>u.id===created[0]),'the admin check finds a blocked word in a bio');
	await sql`update users set status='suspended' where id=${created[0]}::bigint`;
	// blocked phrases in posts go through the same look-alike folding
	await admin.admin('saveOperations',{...operations,blocked_names:[...(operations.blocked_names??[]),WORD],blocked_phrases:[...operations.blocked_phrases,'zorble flax']});
	const tweet=async(text:string)=>(await(await fetch(origin+'/i/api/graphql/q/CreateTweet',{method:'POST',headers:{...admin.headers,'content-type':'application/json'},body:JSON.stringify({variables:{tweet_text:text}})})).json()) as any;
	const refused=await tweet('look: zоrblе​ flаx here');
	check(refused.errors?.[0]?.code===186,'blocked phrase with Cyrillic and a zero-width space refused');
	const fine=await tweet('zorbles flax is two words apart');
	const fineId=fine.data?.create_tweet?.tweet_results?.result?.rest_id;
	check(!!fineId,'other spacing still posts (phrases keep word breaks)');
	if(fineId)await fetch(origin+'/i/api/graphql/q/DeleteTweet',{method:'POST',headers:{...admin.headers,'content-type':'application/json'},body:JSON.stringify({variables:{tweet_id:fineId}})});
	console.log(`all passed (${checks})`);
}finally{
	await admin.admin('saveOperations',operations);
	for(const id of created){await sql`delete from audit_log where target=${id}`;await sql`delete from users where id=${id}::bigint`;}
	await sql.end();
}
