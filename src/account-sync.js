import {createThiepnAccountSession,createThiepnBrowserSso} from './vendor/account-session/index.js';
import {toState,validState,reconcile,isBlank,MAX_CLOUD_BYTES,equal} from './merge.js';
import {ACCOUNT_ISSUER,ACCOUNT_ORIGIN,ACCOUNT_REDIRECT,ACCOUNT_CLIENT_ID,ACCOUNT_PUBLISHABLE_KEY} from './config.js';

const byId=id=>document.getElementById(id);
const bridge=window.clearpageBridge;
const enabledConfig=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ACCOUNT_CLIENT_ID)
    && ACCOUNT_PUBLISHABLE_KEY.startsWith('sb_publishable_');
const desiredKey='clearpage.account.desired.v1';
const cloudKey=id=>'clearpage.cloud.opted-in:'+id;
const rest=ACCOUNT_ISSUER+'/rest/v1';
const same=equal;
const getFlag=k=>{try{return localStorage.getItem(k)==='1';}catch{return false;}};
const setFlag=(k,v)=>{try{if(v)localStorage.setItem(k,'1');else localStorage.removeItem(k);}catch{}};

let sso=null,accountId=null,active=false,generation=0,pendingTimer=null,busy=false,again=false,accountMessage='';
const controls=['accountConnect','accountEnable','accountSync','accountCopyGuest','accountSignOut'];
const panel=byId('accountBackdrop'),message=byId('accountMessage'),cloudStatus=byId('cloudStatus');
function say(text){accountMessage=text;message.textContent=text;}
function cloud(text,warning=false){
  cloudStatus.hidden=!accountId;
  if(accountId){cloudStatus.textContent=' · '+text;cloudStatus.dataset.error=String(warning);}
}
function render(){
  const connected=Boolean(accountId);
  for(const id of controls)byId(id).hidden=true;
  byId('accountConnect').hidden=connected;
  byId('accountConnect').disabled=!enabledConfig;
  byId('accountEnable').hidden=!connected||active;
  byId('accountSync').hidden=!connected||!active;
  byId('accountCopyGuest').hidden=!connected;
  byId('accountSignOut').hidden=!connected;
  byId('accountMenu').textContent=connected?(active?'THIEPN Account · Sync on':'THIEPN Account · Local only'):'THIEPN Account · Optional';
  if(!connected && !enabledConfig)say('THIEPN Account sync is not activated for this release. Writing and local backups still work.');
  else if(!connected)say(accountMessage||'Guest mode: no account or cloud upload is required.');
  else if(!active)say('Signed in. Notes are stored in this account’s separate local workspace. Enable cloud sync to upload them.');
  else say(accountMessage||'Cloud sync enabled. Pages remain available locally when the network is unavailable.');
}
function open(){render();panel.classList.add('open');panel.setAttribute('aria-hidden','false');byId('accountClose').focus();}
function close(){panel.classList.remove('open');panel.setAttribute('aria-hidden','true');byId('menuButton').focus();}
window.addEventListener('clearpage:account-open',open);
byId('accountClose').addEventListener('click',close);

const checkContext=(epoch,id)=>{
  if(epoch!==generation||id!==accountId||bridge.scope()!==':account:'+id)throw Error('Account changed while syncing');
};
function withCredentials(token){return {'apikey':ACCOUNT_PUBLISHABLE_KEY,'Authorization':'Bearer '+token};}
async function request(path,token,body){
  const res=await fetch(rest+path,{
    method:body===undefined?'GET':'POST',
    headers:{...withCredentials(token),...(body===undefined?{}:{'Content-Type':'application/json','Prefer':'return=representation'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    signal:AbortSignal.timeout(15000),
    cache:'no-store'
  });
  if(!res.ok){
    if(res.status===401||res.status===403)throw Error('Account authorization expired or denied');
    if(res.status===404)throw Error('Cloud sync backend is not activated');
    throw Error('Cloud request failed ('+res.status+')');
  }
  return res.json();
}
async function getCloud(token){
  const result=await request('/clearpage_sync_state?select=revision,payload,last_mutation_id&limit=1',token);
  if(!Array.isArray(result)||result.length>1)throw Error('Invalid cloud response');
  if(!result.length)return null;
  const row=result[0];
  if(!Number.isSafeInteger(row.revision)||row.revision<1||!validState(row.payload))throw Error('Invalid cloud data; local writing preserved');
  return row;
}
async function putCloud(token,revision,payload,mutationId){
  const rows=await request('/rpc/clearpage_sync_cas',token,{
    p_expected_revision:revision,p_payload:payload,p_mutation_id:mutationId
  });
  if(!Array.isArray(rows)||rows.length>1)throw Error('Invalid cloud write response');
  return rows[0]||null;
}
function ensureSize(state){
  if(new TextEncoder().encode(JSON.stringify(state)).length>MAX_CLOUD_BYTES)
    throw Error('Cloud size limit exceeded. Download a JSON backup.');
}
function usableBaseline(base){
  return base&&Number.isSafeInteger(base.revision)&&base.revision>0&&validState(base.state);
}
async function runOnce(epoch,id){
  checkContext(epoch,id);
  const identity=await sso.verify();
  checkContext(epoch,id);
  if(identity.status!=='signed-in'||identity.id!==id)throw Error('Account session unavailable; cloud sync paused');
  const token=await sso.getAccessToken();
  if(!token)throw Error('Account token unavailable');
  await bridge.flush();
  checkContext(epoch,id);
  let retryBase=null; // Last observed cloud snapshot, for retry without duplicating conflict copies.
  for(let attempt=0;attempt<4;attempt++){
    checkContext(epoch,id);
    const local=toState(bridge.snapshot());
    const oldBase=await bridge.readBaseline();
    const baseline=usableBaseline(oldBase)?oldBase:null;
    const remote=await getCloud(token);
    checkContext(epoch,id);
    if(!same(toState(bridge.snapshot()),local)){again=true;return;}
    if(!remote && baseline)throw Error('Cloud data disappeared. Automatic re-creation is blocked; export a local backup.');
    let desired,conflicts=0;
    if(!remote){
      desired=local;
    }else if(!baseline && isBlank(local)){
      // Fresh account workspace: use the existing server state without uploading a blank placeholder.
      desired=remote.payload;
    }else{
      const merge=reconcile(retryBase||baseline?.state||null,local,remote.payload);
      desired=merge.state;conflicts=merge.conflicts;
    }
    if(!validState(desired))throw Error('Invalid merged cloud data');
    ensureSize(desired);
    if(!same(desired,local)){
      checkContext(epoch,id);
      if(!same(toState(bridge.snapshot()),local)){again=true;return;}
      const snapshot=bridge.snapshot();
      await bridge.applySnapshot({notes:desired.notes,trash:desired.trash,activeId:snapshot.activeId});
      checkContext(epoch,id);
    }
    if(remote && same(desired,remote.payload)){
      await bridge.writeBaseline({revision:remote.revision,state:remote.payload});
      checkContext(epoch,id);
      if(conflicts)bridge.notify(conflicts+' concurrent edit(s) preserved as conflict copies');
      return;
    }
    const mutationId=crypto.randomUUID();
    const saved=await putCloud(token,remote?.revision||0,desired,mutationId);
    checkContext(epoch,id);
    if(saved){
      if(!Number.isSafeInteger(saved.revision)||!validState(saved.payload)||!same(saved.payload,desired))
        throw Error('Invalid write acknowledgement');
      await bridge.writeBaseline({revision:saved.revision,state:desired});
      checkContext(epoch,id);
      if(conflicts)bridge.notify(conflicts+' concurrent edit(s) preserved as conflict copies');
      return;
    }
    // CAS lost to another device. The previous remote state is now the merge
    // base for this *attempt only*: the local candidate already incorporated
    // its contents. Reusing an older persistent base would duplicate copies.
    retryBase=remote?.payload||{schema:1,notes:[],trash:[]};
    // Concurrent server revision: retry from the new remote state. Never overwrite blind.
  }
  throw Error('Cloud changed repeatedly. Local copy is safe; try syncing again.');
}
async function sync(){
  if(!active||!accountId||!sso)return;
  if(busy){again=true;return;}
  busy=true;const epoch=generation,id=accountId;
  cloud('Cloud: syncing…');
  try{
    await runOnce(epoch,id);
    if(epoch===generation&&id===accountId)cloud('Cloud: synced');
  }catch(e){
    if(epoch===generation&&id===accountId){
      cloud(navigator.onLine?'Cloud: not synced':'Cloud: offline',true);
      say((e instanceof Error?e.message:'Cloud sync failed')+' Your local writing is retained.');
      render();
    }
  }finally{
    busy=false;
    if(again&&active&&epoch===generation){again=false;queueSync(1500);}
  }
}
function queueSync(delay=1700){
  if(!active)return;
  clearTimeout(pendingTimer);
  pendingTimer=setTimeout(()=>{void sync();},delay);
}
window.addEventListener('clearpage:saved',()=>{if(active)queueSync();});
window.addEventListener('online',()=>queueSync(500));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)queueSync(700);});
setInterval(()=>{if(active&&navigator.onLine&&!document.hidden)queueSync(500);},60000);

async function activate(id){
  if(accountId===id)return;
  const next=++generation;
  clearTimeout(pendingTimer);
  active=false;
  accountId=null;
  cloudStatus.hidden=true;
  await bridge.switchWorkspace(id);
  if(next!==generation)return;
  accountId=id;
  active=getFlag(cloudKey(id));
  cloud(active?'Cloud: pending':'Cloud off');
  render();
  if(active)queueSync(100);
}
async function guest(){
  const next=++generation;
  clearTimeout(pendingTimer);
  active=false;
  accountId=null;
  cloudStatus.hidden=true;
  await bridge.switchWorkspace(null);
  if(next!==generation)return;
  say('Guest writing stays on this device. Nothing is uploaded.');
  render();
}
byId('accountConnect').addEventListener('click',()=>{
  if(!enabledConfig||!sso)return;
  setFlag(desiredKey,true);
  say('Redirecting securely to THIEPN Account…');
  void sso.connect().catch(e=>{say('THIEPN Account could not open. Guest writing is unchanged.');render();});
});
byId('accountEnable').addEventListener('click',async()=>{
  if(!accountId)return;
  if(!(await bridge.storageReady())){say('IndexedDB storage is required for cloud sync. Export a backup.');return;}
  setFlag(cloudKey(accountId),true);
  active=true;say('Cloud sync enabled for this Account on this device.');
  render();queueSync(100);
});
byId('accountSync').addEventListener('click',()=>queueSync(0));
byId('accountCopyGuest').addEventListener('click',async()=>{
  if(!accountId)return;
  if(!window.confirm('Copy guest pages into this Account workspace? They will stay in guest storage too. Copied pages will sync only if cloud sync is enabled.'))return;
  try{const n=await bridge.copyGuestPages();bridge.notify(n?n+' guest page(s) copied without overwriting existing pages':'No non-empty guest pages to copy');if(active)queueSync(50);}catch(e){say(e.message||'Could not copy guest pages');}
});
byId('accountSignOut').addEventListener('click',async()=>{
  if(!sso)return;
  try{
    await guest();
    sso.signOutLocal();setFlag(desiredKey,false);
    bridge.notify('Switched to guest pages. Account notes remain separate on this device.');
    render();
  }catch(e){say('Could not safely switch away from account notes. Export a local backup.');}
});
(async()=>{
  try{
    // Guest-first: do not silently probe Account, redirect, or expose any account data
    // unless the user has explicitly opted into this app's Account experience.
    await window.clearpageReady;
    if(!enabledConfig){render();return;}
    sso=createThiepnBrowserSso(createThiepnAccountSession({
      issuer:ACCOUNT_ISSUER,publishableKey:ACCOUNT_PUBLISHABLE_KEY,clientId:ACCOUNT_CLIENT_ID,
      redirectUri:ACCOUNT_REDIRECT,storageKey:'thiepn:clearpage:account-session:v1',authPolicy:'guest-first'
    }),{accountOrigin:ACCOUNT_ORIGIN});
    sso.subscribe(identity=>{
      if(!accountId)return;
      if(identity.status==='signed-in'&&identity.id===accountId)return;
      // A temporary offline verification failure must not discard access to
      // the already-open local account workspace; only cloud writes pause.
      if(identity.status==='unavailable'){cloud('Cloud: offline or unavailable',true);return;}
      // Never continue showing user A's private workspace after a user B
      // verification, logout or revocation. Mask immediately, then switch.
      document.getElementById('app').style.visibility='hidden';
      const promise=identity.status==='signed-in'?activate(identity.id):guest();
      void promise.catch(()=>{say('Account identity changed; local data is locked until safely reloaded.');})
        .finally(()=>{if(bridge.scope() === (accountId?':account:'+accountId:''))document.getElementById('app').style.visibility='';});
    });
    const callback=new URL(ACCOUNT_REDIRECT).pathname===location.pathname;
    if(!callback&&!getFlag(desiredKey)){render();return;}
    if(callback){
      const identity=await sso.completeCallback(location);
      history.replaceState({},'',location.origin+'/');
      if(identity.status==='signed-in')await activate(identity.id);
      else{say('Sign-in was not completed. Guest pages are unchanged.');setFlag(desiredKey,false);}
      render();return;
    }
    const state=await sso.initialize();
    if(state.status==='redirecting')return;
    if(state.identity.status==='signed-in')await activate(state.identity.id);
    else if(state.identity.status==='unavailable')say('Account is temporarily unavailable. Guest writing remains available.');
    render();
  }catch(e){
    say('Could not initialize Account. Guest writing remains available.');
    render();
  }
})();
