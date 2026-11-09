// Browser tests use the actual compiled static app with a localhost server.
// No production Account, OAuth tokens, credentials or customer data are used.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,statSync} from 'node:fs';
import {resolve,join,extname,sep} from 'node:path';
import {chromium} from 'playwright';

const root=resolve('dist');
const server=createServer((req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url||'/', 'http://localhost').pathname);
    const name=pathname==='/' || pathname.startsWith('/auth/callback')?'index.html':pathname.replace(/^\//,'');
    const path=resolve(root,name);
    if(path!==root && !path.startsWith(root+sep)){res.writeHead(403).end();return;}
    const buf=readFileSync(path);
    res.writeHead(200,{'content-type':extname(path)==='.js'?'text/javascript; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store'});
    res.end(buf);
  }catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const url='http://127.0.0.1:'+server.address().port+'/';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1280,height:850}});
const page=await context.newPage();
const errors=[];
page.on('pageerror',e=>errors.push(String(e)));
const flush=()=>page.evaluate(async()=>window.clearpageBridge.flush());
const switchTo=id=>page.evaluate(async id=>window.clearpageBridge.switchWorkspace(id),id);
try{
  await page.goto(url);
  await page.evaluate(async()=>window.clearpageReady);
  const editor=page.locator('#editor'),title=page.locator('#pageTitle');
  assert.equal(await page.locator('#accountConnect').count(),1,'Account UI available');
  await page.locator('#menuButton').click();
  await page.locator('[data-action="account"]').click();
  assert.equal(await page.locator('#accountConnect').isDisabled(),true,'unregistered OAuth cannot authorize');
  assert.match(await page.locator('#accountMessage').innerText(),/not activated/i);
  await page.locator('#accountClose').click();

  await title.fill('Guest journal');
  await editor.fill('Guest-only writing must not cross to another account.');
  await flush();
  const guestBefore=await page.evaluate(()=>window.clearpageBridge.snapshot());
  assert.equal(guestBefore.notes[0].text.includes('Guest-only'),true);

  const accountA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const accountB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await switchTo(accountA);
  assert.equal(await editor.inputValue(),'','Account A must not show guest note');
  await title.fill('Account A draft');
  await editor.fill('Private A: offline to online test.');
  await flush();
  const aData=await page.evaluate(()=>window.clearpageBridge.snapshot());
  assert.ok(aData.notes.some(n=>n.text.startsWith('Private A:')));

  await context.setOffline(true);
  await editor.fill('Private A: edited offline in real IndexedDB.');
  await flush();
  assert.match(await editor.inputValue(),/edited offline/);
  await context.setOffline(false);
  await page.reload();
  await page.evaluate(async()=>window.clearpageReady);
  await switchTo(accountA);
  assert.match(await editor.inputValue(),/edited offline/,'offline edit must survive reload');

  await switchTo(accountB);
  assert.equal(await editor.inputValue(),'','Account B must not see Account A notes');
  await title.fill('Account B only');
  await editor.fill('Private B entry.');
  await flush();

  await switchTo(accountA);
  assert.match(await editor.inputValue(),/edited offline/,'Account A must be restored separately');
  assert.doesNotMatch(await editor.inputValue(),/Private B/);
  const imported=await page.evaluate(async()=>window.clearpageBridge.copyGuestPages());
  assert.equal(imported,1,'guest import should create one copy only on explicit action');
  const afterImport=await page.evaluate(()=>window.clearpageBridge.snapshot());
  assert.equal(afterImport.notes.some(n=>n.text.includes('Guest-only writing')),true);

  await switchTo(null);
  const guestAfter=await page.evaluate(()=>window.clearpageBridge.snapshot());
  assert.deepEqual(guestAfter,guestBefore,'guest original must be unchanged by Account workspace import');
  assert.match(await editor.inputValue(),/Guest-only/);
  await page.locator('#newButton').click();
  await title.fill('Search this new note');
  await editor.fill('Unique keyword for instant search: cinnamonbird');
  await flush();
  await page.locator('#openPages').click();
  await page.locator('#pageSearch').fill('cinnamonbird');
  await page.waitForFunction(()=>document.getElementById('pageList').textContent.includes('Search this new note'));
  const count=await page.locator('#pageList').locator('button').count();
  assert.ok(count>=1,'search must return the matching page');

  await page.reload();
  await page.evaluate(async()=>window.clearpageReady);
  assert.ok((await page.evaluate(()=>window.clearpageBridge.snapshot())).notes.some(n=>n.text.includes('cinnamonbird')));
  assert.equal(errors.length,0,'no runtime browser exceptions: '+errors.join('; '));
  console.log('CLEARPAGE_BROWSER_CHROMIUM=PASS');
  console.log('COVERED: guest persistence, explicit Account A/B local workspace isolation, offline IndexedDB edits, guest copy, search, reload, fail-closed OAuth gate');
}finally{
  await context.close();
  await browser.close();
  await new Promise(done=>server.close(done));
}
