// OFFLINE-ONLY, test-only exact-origin harness for Clearpage v1.2.
// ALL requests are either fulfilled from the reviewed local dist/ build or
// aborted. No route.continue(), route.fetch(), external API mock, credentials,
// OAuth activation, Supabase writes, production deployment, or real sign-in.
// A future credentialed acceptance run must use a separately reviewed route
// policy: never mock the Account issuer, OAuth endpoints or production RLS/CAS.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const origin='https://page.thiepn.dev';
const root=resolve('dist');
const routes=new Map([
  ['/','index.html'],
  ['/index.html','index.html'],
  ['/auth/callback/','index.html'],
  ['/auth/callback','index.html'],
  ['/js/account-sync.js','js/account-sync.js'],
  ['/js/config.js','js/config.js'],
  ['/js/merge.js','js/merge.js'],
  ['/js/vendor/account-session/index.js','js/vendor/account-session/index.js'],
  ['/js/vendor/account-session/browser-sso.js','js/vendor/account-session/browser-sso.js'],
]);
const mime=path=>path.endsWith('.js')?'text/javascript; charset=utf-8':'text/html; charset=utf-8';
const served=[];
const denied=[];
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({
  viewport:{width:1280,height:850},
  serviceWorkers:'block',
  ignoreHTTPSErrors:false
});
const errors=[];
try{
  // Intercept before ANY page exists, including popup/callback navigation.
  await context.route('**/*',async route=>{
    const req=route.request();
    let url;
    try{url=new URL(req.url());}
    catch{denied.push('invalid-url');await route.abort('blockedbyclient');return;}
    // Do not log query strings, OAuth parameters, payloads or tokens.
    if(url.origin!==origin){
      denied.push('external-origin');
      await route.abort('blockedbyclient');
      return;
    }
    const file=routes.get(url.pathname);
    if(req.method()!=='GET'||!file||
       (url.search && url.pathname!=='/auth/callback/' && url.pathname!=='/auth/callback')){
      denied.push('unapproved-clearpage-path-or-method');
      await route.abort('blockedbyclient');
      return;
    }
    // File names come only from the fixed allowlist, not from user URLs.
    let body;
    try{body=readFileSync(resolve(root,file));}
    catch{
      denied.push('missing-local-build-asset');
      await route.abort('blockedbyclient');
      return;
    }
    served.push(url.pathname);
    await route.fulfill({
      status:200,body,
      headers:{'content-type':mime(file),'cache-control':'no-store'}
    });
  });

  const page=await context.newPage();
  page.on('pageerror',error=>errors.push(error.name));
  await page.goto(origin+'/',{waitUntil:'load'});
  await page.evaluate(async()=>window.clearpageReady);
  assert.equal(new URL(page.url()).origin,origin,'browser must have exact registered HTTPS origin');
  assert.equal(context.serviceWorkers().length,0,'service workers must be blocked');
  assert.ok(served.includes('/js/account-sync.js'),'Account module served from local build');
  assert.ok(served.includes('/js/config.js'),'pinned config served from local build');

  const editor=page.locator('#editor'),title=page.locator('#pageTitle');
  assert.equal(await page.locator('#accountConnect').count(),1);
  await page.locator('#menuButton').click();
  await page.locator('[data-action="account"]').click();
  assert.equal(await page.locator('#accountConnect').isDisabled(),false,
    'registered public client is configured in the draft');
  assert.match(await page.locator('#accountMessage').innerText(),/Guest mode: no account or cloud upload is required/i);
  await page.locator('#accountClose').click();
  assert.equal(await page.evaluate(()=>window.clearpageBridge.scope()),'','guest workspace must be default');
  assert.equal(await page.evaluate(()=>localStorage.getItem('clearpage.account.desired.v1')),null,
    'guest visit must not opt into Account');
  assert.equal(await page.evaluate(()=>localStorage.getItem('thiepn:clearpage:account-session:v1:tokens')),null,
    'guest visit must not create an Account token store');

  await title.fill('Offline-only guest draft');
  await editor.fill('Private guest writing stays in this browser.');
  await page.evaluate(async()=>window.clearpageBridge.flush());
  assert.ok((await page.evaluate(()=>window.clearpageBridge.snapshot())).notes
    .some(note=>note.text==='Private guest writing stays in this browser.'));

  await context.setOffline(true);
  await editor.fill('Private guest writing survives an offline change.');
  await page.evaluate(async()=>window.clearpageBridge.flush());
  assert.match(await editor.inputValue(),/survives an offline change/);
  assert.equal(await page.evaluate(()=>window.clearpageBridge.scope()),'');
  await context.setOffline(false);
  await page.reload({waitUntil:'load'});
  await page.evaluate(async()=>window.clearpageReady);
  assert.match(await page.locator('#editor').inputValue(),/survives an offline change/,
    'offline guest draft must persist in IndexedDB after reconnect and reload');
  assert.deepEqual(denied,[],'guest startup, edit and reload must make zero external or missing-asset requests');
  assert.deepEqual(errors,[],'guest run must not throw browser errors');

  // The callback must be provided from the local dist shell, not production v1.1.
  // Do not supply an OAuth code/state or contact Account during this smoke test.
  const callback=await context.newPage();
  callback.on('pageerror',error=>errors.push(error.name));
  await callback.goto(origin+'/auth/callback/',{waitUntil:'load'});
  assert.equal(await callback.locator('#editor').count(),1,'exact callback loads local v1.2 shell');
  await callback.close();
  assert.deepEqual(denied,[],'bare callback must not fetch unapproved production resources');
  assert.deepEqual(errors,[],'bare callback must fail closed without runtime error');

  // Negative controls: invalid paths and unrelated origins are never served,
  // redirected, or allowed to escape to the public internet.
  const bad=await context.newPage();
  await assert.rejects(bad.goto(origin+'/unknown-production-fallback/',{timeout:5000}),
    'unexpected same-origin route must be blocked, never served from live v1.1');
  assert.equal(denied.at(-1),'unapproved-clearpage-path-or-method');
  await bad.close();
  const before=denied.length;
  const blocked=await page.evaluate(async()=>{
    try{await fetch('https://origin-isolation-test.invalid/should-not-leave-browser');return false;}
    catch{return true;}
  });
  assert.equal(blocked,true,'unrelated origin must be rejected');
  assert.equal(denied.length,before+1,'non-Clearpage request must hit the deny-all route');
  assert.equal(denied.at(-1),'external-origin');
  assert.equal(context.serviceWorkers().length,0);
  console.log('CLEARPAGE_EXACT_ORIGIN_LOCAL_INTERCEPT=PASS');
  console.log('CLEARPAGE_GUEST_OFFLINE_ZERO_EXTERNAL_NETWORK=PASS');
  console.log('CLEARPAGE_CALLBACK_SHELL_AND_FALLBACK_BLOCK=PASS');
}finally{
  await context.close();
  await browser.close();
}
