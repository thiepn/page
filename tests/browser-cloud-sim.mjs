import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,sep,extname} from 'node:path';
import {chromium} from 'playwright';

// Real browser + original Account SDK and actual Clearpage HTTP client.
// OAuth token verification and PostgREST are simulated; never contact
// production services or claim authenticated production certification.
const ROOT=resolve('dist');
const TEST_CLIENT='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const TEST_KEY='sb_publishable_clearpage_disposable_browser_test_key';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ACC='https://hycegznamzjhwinegaai.supabase.co/';
const stored=new Map();
let offlineCloud=false;
const clone=x=>structuredClone(x);
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const CORS={
  'access-control-allow-origin':'*',
  'access-control-allow-methods':'GET, POST, OPTIONS',
  'access-control-allow-headers':'apikey, Authorization, Content-Type, Prefer',
  'content-type':'application/json'
};
const server=createServer((req,res)=>{
  try{
    const path=new URL(req.url||'/', 'http://localhost').pathname;
    const rel=(path==='/'||path.startsWith('/auth/callback'))?'index.html':path.replace(/^\//,'');
    const full=resolve(ROOT,rel);
    if(full!==ROOT&&!full.startsWith(ROOT+sep)){res.writeHead(403).end();return;}
    let source=readFileSync(full,'utf8');
    if(rel==='js/config.js'){
      source=source.replace(/export const ACCOUNT_CLIENT_ID='[^']*';/, "export const ACCOUNT_CLIENT_ID='"+TEST_CLIENT+"';")
                   .replace(/export const ACCOUNT_PUBLISHABLE_KEY='[^']*';/, "export const ACCOUNT_PUBLISHABLE_KEY='"+TEST_KEY+"';");
    }
    res.writeHead(200,{'content-type':extname(full)==='.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store'});
    res.end(source);
  }catch(e){res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/';
const browser=await chromium.launch({headless:true});
const sessions=[];
const problem=[];
async function fakeAuth(ctx){
  await ctx.route('https://hycegznamzjhwinegaai.supabase.co/**',async route=>{
    const req=route.request();
    const parsed=new URL(req.url());
    const bearer=(await req.allHeaders()).authorization?.replace(/^Bearer /i,'')||'';
    const user=bearer==='synthetic-a'?A:bearer==='synthetic-b'?B:null;
    const reply=(status,body)=>route.fulfill({status,headers:CORS,body:JSON.stringify(body)});
    if(req.method()==='OPTIONS')return route.fulfill({status:204,headers:CORS,body:''});
    if(parsed.pathname==='/auth/v1/user'){
      if(!user)return reply(401,{message:'Unknown synthetic identity'});
      return reply(200,{id:user,email:'test@example.invalid',aud:'authenticated'});
    }
    if(!parsed.pathname.startsWith('/rest/v1/'))return reply(404,{message:'Unknown synthetic API'});
    if(offlineCloud)return reply(503,{message:'Simulated network outage'});
    if(!user)return reply(401,{message:'Missing verified owner'});
    if(parsed.pathname==='/rest/v1/clearpage_sync_state'){
      const current=stored.get(user);
      return reply(200,current?[clone(current)]:[]);
    }
    if(parsed.pathname==='/rest/v1/rpc/clearpage_sync_cas'){
      const body=JSON.parse(req.postData()||'{}');
      const rev=body.p_expected_revision,mutation=body.p_mutation_id,payload=body.p_payload;
      assert.equal(payload?.schema,1);
      const current=stored.get(user);
      if(!current){
        if(rev!==0)return reply(200,[]);
        const row={revision:1,payload:clone(payload),last_mutation_id:mutation};
        stored.set(user,row);return reply(200,[clone(row)]);
      }
      if(current.last_mutation_id===mutation && equal(current.payload,payload))
        return reply(200,[clone(current)]);
      if(current.revision!==rev)return reply(200,[]);
      const row={revision:rev+1,payload:clone(payload),last_mutation_id:mutation};
      stored.set(user,row);return reply(200,[clone(row)]);
    }
    return reply(404,{message:'Unknown synthetic API'});
  });
}
async function createDevice(token){
  const ctx=await browser.newContext({viewport:{width:1250,height:900}});
  sessions.push(ctx);
  await fakeAuth(ctx);
  await ctx.addInitScript(({token})=>{
    localStorage.setItem('clearpage.account.desired.v1','1');
    localStorage.setItem('thiepn:clearpage:account-session:v1:tokens',JSON.stringify({
      accessToken:token,refreshToken:'synthetic-refresh',expiresAt:Date.now()+3600000,scope:'openid email profile'
    }));
  },{token});
  const page=await ctx.newPage();
  page.on('pageerror',e=>problem.push(String(e)));
  await page.goto(url);
  await page.evaluate(()=>window.clearpageReady);
  await page.waitForFunction(()=>document.getElementById('accountMenu').textContent.includes('Local only'));
  return page;
}
async function enable(page){
  await page.locator('#menuButton').click();
  await page.locator('#accountMenu').click();
  await page.locator('#accountEnable').click();
  await page.locator('#accountClose').click();
}
async function push(page){
  await page.locator('#menuButton').click();
  await page.locator('#accountMenu').click();
  await page.locator('#accountSync').click();
  await page.locator('#accountClose').click();
}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async (fn,message)=>{
  for(let i=0;i<90;i++){
    if(await fn())return;
    await delay(100);
  }
  throw Error('Timeout: '+message);
};
try{
  const a=await createDevice('synthetic-a');
  await a.locator('#pageTitle').fill('Shared original');
  await a.locator('#editor').fill('Original writing');
  await a.evaluate(()=>window.clearpageBridge.flush());
  await enable(a);
  await until(()=>stored.get(A)?.revision===1,'first device cloud bootstrap');

  const b=await createDevice('synthetic-a');
  await enable(b);
  await until(async()=> (await b.locator('#editor').inputValue())==='Original writing','second device initial download');
  assert.equal(stored.get(A).payload.notes.length,1);

  // Force both devices to edit the same original revision while offline.
  offlineCloud=true;
  await a.locator('#editor').fill('Edit from device A');
  await b.locator('#editor').fill('Edit from device B');
  await Promise.all([a.evaluate(()=>window.clearpageBridge.flush()),b.evaluate(()=>window.clearpageBridge.flush())]);
  await delay(2100);
  assert.equal(stored.get(A)?.revision,1,'offline edits never reach cloud');
  assert.equal(await b.locator('#editor').inputValue(),'Edit from device B','outage does not replace local draft');

  offlineCloud=false;
  await push(a);
  await until(()=>stored.get(A)?.payload.notes.some(n=>n.text==='Edit from device A'),'device A recovery upload');
  await push(b);
  await until(()=>stored.get(A)?.payload.notes.some(n=>n.text==='Edit from device B'),'device B conflict copy upload');
  const remote=stored.get(A).payload.notes;
  assert.ok(remote.some(n=>n.text==='Edit from device A'));
  assert.ok(remote.some(n=>n.text==='Edit from device B'&&n.title.includes('conflict copy')));
  assert.equal(remote.length,2,'concurrent edits yield exactly two pages, not lost writes');

  // An independently initialized third device downloads both versions.
  const c=await createDevice('synthetic-a');
  await enable(c);
  await until(async()=> (await c.evaluate(()=>window.clearpageBridge.snapshot())).notes.length===2,'third device bootstrap');
  assert.deepEqual(new Set((await c.evaluate(()=>window.clearpageBridge.snapshot())).notes.map(n=>n.text)),new Set(['Edit from device A','Edit from device B']));

  // Account B must not receive Account A cloud state.
  const d=await createDevice('synthetic-b');
  await enable(d);
  await until(()=>Boolean(stored.get(B)),'Account B isolated bootstrap');
  const accountBState=await d.evaluate(()=>window.clearpageBridge.snapshot());
  assert.ok(accountBState.notes.every(n=>!n.text.includes('device A')&&!n.text.includes('device B')));
  assert.equal(stored.get(B).payload.notes.some(n=>n.text.includes('device A')),false);

  // Verify a real Account A -> B identity change while A has an app session.
  // The SDK publishes B's verified identity, and Clearpage MUST immediately
  // hide/switch A's local workspace before displaying any B data.
  await d.locator('#pageTitle').fill('Private B');
  await d.locator('#editor').fill('Account B private data');
  await d.evaluate(()=>window.clearpageBridge.flush());
  await push(d);
  await until(()=>stored.get(B)?.payload.notes.some(n=>n.text==='Account B private data'),'B separate server write');

  await a.evaluate(()=>{
    localStorage.setItem('clearpage.cloud.opted-in:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','1');
    localStorage.setItem('thiepn:clearpage:account-session:v1:tokens',JSON.stringify({
      accessToken:'synthetic-b',refreshToken:'synthetic-refresh-b',
      expiresAt:Date.now()+3600000,scope:'openid email profile'
    }));
  });
  await push(a);
  await until(async()=>await a.evaluate(()=>window.clearpageBridge.scope())===':account:'+B,'A->B account switch');
  await until(async()=>await a.locator('#editor').inputValue()==='Account B private data','B workspace cloud download after switch');
  assert.ok(!(await a.locator('#editor').inputValue()).includes('device A'));

  // User permanently deletes a B workspace note while offline.
  // Another B device edits its older version. Neither side may silently
  // restore a permanently deleted page or overwrite a simultaneous edit.
  offlineCloud=true;
  await a.locator('#openPages').click();
  await a.locator('#pageList .delete-page').first().click();
  await a.locator('#confirmDialog').click();
  await a.locator('#trashTab').click();
  await a.locator('#pageList .delete-page').first().click();
  await a.locator('#confirmDialog').click();
  await a.locator('#closePages').click();
  await a.evaluate(()=>window.clearpageBridge.flush());
  const afterDelete=await a.evaluate(()=>window.clearpageBridge.snapshot());
  assert.ok(afterDelete.notes.every(n=>n.text!=='Account B private data'));
  assert.ok(afterDelete.trash.every(n=>n.text!=='Account B private data'));

  offlineCloud=false;
  await d.locator('#editor').fill('Account B concurrent edit after other device deleted permanently');
  await d.evaluate(()=>window.clearpageBridge.flush());
  await push(d);
  await until(()=>stored.get(B)?.payload.notes.some(n=>n.text==='Account B concurrent edit after other device deleted permanently'),'remote concurrent edit upload');
  await push(a);
  await until(async()=>/Permanent deletion conflicts/.test(await a.locator('#accountMessage').textContent()),'deletion/edit conflict is surfaced');
  const afterConflict=await a.evaluate(()=>window.clearpageBridge.snapshot());
  assert.ok(afterConflict.notes.every(n=>n.text!=='Account B private data'&&!n.text.includes('concurrent edit after')));
  assert.ok(stored.get(B).payload.notes.some(n=>n.text.includes('concurrent edit after')),'remote writer is not overwritten');
  assert.match(await a.locator('#cloudStatus').textContent(),/not synced/i);
  assert.equal(problem.length,0,problem.join('; '));
  console.log('CLEARPAGE_TWO_DEVICE_SIMULATED_HTTP=PASS');
  console.log('COVERED: offline pending local edits, first upload, second-device bootstrap, concurrent conflict copy, third-device convergence, cross-owner cloud isolation, same-browser Account A→B privacy, delete/edit conflict fail-closed');
}finally{
  for(const ctx of sessions)await ctx.close().catch(()=>{});
  await browser.close();
  await new Promise(done=>server.close(done));
}
