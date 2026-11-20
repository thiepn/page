// Real-browser regression of the public, local-only Clearpage editor.
// No account requests, user credentials, remote data or deployments.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {chromium, firefox} from 'playwright';

const html=readFileSync(new URL('../index.html',import.meta.url));
const script=html.toString('utf8').match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script,'Inline app script must exist');
new Function(script); // Syntax verification on the exact proposed editor source.
const server=createServer((req,res)=>{
  if(req.url!=='/'){res.writeHead(404).end();return;}
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  res.end(html);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url='http://127.0.0.1:'+server.address().port+'/';
const text=Array.from({length:95},(_,i)=>'Paragraph '+(i+1)+': Long-form writing must keep the cursor visible without jumping to the top.').join('\n');
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function metrics(page){
  return page.evaluate(()=>{
    const e=document.querySelector('#editor');
    const css=getComputedStyle(e), r=e.getBoundingClientRect();
    const visual=window.visualViewport;
    const bottom=(visual?visual.offsetTop+visual.height:window.innerHeight);
    return {
      scrollY:window.scrollY, scrollHeight:document.documentElement.scrollHeight,
      caretBottom:r.bottom-(parseFloat(css.paddingBottom)||0),
      safeBottom:bottom-(document.body.classList.contains('focus')?34:82),
      selectionStart:e.selectionStart, valueLength:e.value.length,
      editorScroll:e.scrollTop, editorHeight:r.height
    };
  });
}
async function run(engine,name,width,height){
  const browser=await engine.launch({headless:true});
  const context=await browser.newContext({viewport:{width,height}});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  try{
    await page.goto(url);
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    const editor=page.locator('#editor');
    await page.locator('#pageTitle').fill('Scroll regression note');
    await editor.fill(text);
    await settle(page);
    let m=await metrics(page);
    assert.ok(m.scrollY>700,name+': long note should automatically follow writing: '+JSON.stringify(m));
    assert.ok(m.caretBottom<=m.safeBottom+9,name+': last typed line must clear the fixed footer: '+JSON.stringify(m));
    assert.equal(m.selectionStart,m.valueLength,name+': cursor remains at end');

    // Manual reading must not be overridden by a pending editor resize.
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.waitForTimeout(420); // Includes the autosave debounce.
    assert.ok((await metrics(page)).scrollY<3,name+': manually scrolling to the top must stick');
    // Height-only viewport changes (e.g. mobile browser chrome) must not
    // drag a reader back to a focused caret in the long document.
    await page.setViewportSize({width,height:height-55});
    await settle(page);
    assert.ok((await metrics(page)).scrollY<3,name+': viewport chrome resize must not steal manual scroll');
    await page.setViewportSize({width,height});
    await settle(page);

    // Continuing to write must bring the caret back and follow later lines.
    await editor.press('ControlOrMeta+End');
    await editor.press('Enter');
    await editor.type('New line after the initial full document.');
    await settle(page);
    m=await metrics(page);
    assert.ok(m.scrollY>700,name+': writing again should auto-follow: '+JSON.stringify(m));
    assert.ok(m.caretBottom<=m.safeBottom+9,name+': typing must stay visible: '+JSON.stringify(m));

    // Navigation to a new page resets document position, preserving the old text.
    await editor.press('ControlOrMeta+Alt+N');
    await settle(page);
    assert.ok((await metrics(page)).scrollY<3,name+': new page must open at top');
    assert.equal(await editor.inputValue(),'');
    await page.locator('#openPages').click();
    await page.locator('#pageSearch').fill('Scroll regression note');
    await page.locator('.page-item-main').first().click();
    assert.ok((await editor.inputValue()).includes('New line after the initial full document.'));
    assert.ok((await metrics(page)).scrollY<3,name+': switched page must open at top');

    // Focus mode and typography changes must retain usable caret following.
    await page.locator('#focusButton').click();
    await editor.press('ControlOrMeta+End');
    await editor.press('Enter');
    await editor.type('Still visible in focus mode.');
    await settle(page);
    m=await metrics(page);
    assert.ok(m.caretBottom<=m.safeBottom+9,name+': focus mode caret should remain visible: '+JSON.stringify(m));
    await page.locator('#exitFocus').click();
    await page.locator('#menuButton').click();
    await page.locator('[data-action="size"]').click();
    await settle(page);
    assert.ok((await metrics(page)).editorHeight>height,name+': resizable typography preserves auto-growth');

    // Actual browser storage persistence; do not introduce any data format changes.
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    assert.ok((await editor.inputValue()).includes('Still visible in focus mode.'),name+': IndexedDB persistence survives reload');
    assert.deepEqual(errors,[],name+': no browser errors');
    console.log(name+' '+width+'x'+height+': PASS (long writing, manual scroll, follow caret, switch, focus, typography, reload)');
  }finally{
    await context.close();
    await browser.close();
  }
}
async function assertSilentStorageFailure(){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1280,height:800}});
  await context.addInitScript(()=>{
    Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true});
    Storage.prototype.setItem=function(){throw new DOMException('Storage blocked','QuotaExceededError');};
  });
  try{
    const page=await context.newPage();
    await page.goto(url);
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    assert.equal(await page.evaluate(()=>typeof indexedDB),'undefined','IndexedDB is unavailable in this test');
    await page.locator('#editor').pressSequentially('Writing must remain quiet when storage is blocked.',{delay:3});
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#editor').inputValue(),'Writing must remain quiet when storage is blocked.');
    assert.equal(await page.locator('#saveStatus').count(),0,'No persistence status is displayed');
    assert.equal(await page.locator('.sidebar-foot').count(),0,'No unsolicited backup reminder is displayed');
    assert.equal(await page.locator('#toast.show').count(),0,'No warning toast interrupts typing');
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#menuButton').click();
    await page.locator('[data-action="backup"]').click();
    const downloaded=await downloadPromise;
    const backup=JSON.parse(readFileSync(await downloaded.path(),'utf8'));
    assert.ok(backup.notes.some(note=>note.text==='Writing must remain quiet when storage is blocked.'),'Manual backup preserves session text with no storage');
    assert.equal(await page.locator('#toast.show').count(),0,'Manual backup does not show a warning');
    console.log('Chromium blocked-storage silent writing: PASS');
  }finally{
    await context.close();
    await browser.close();
  }
}

async function assertWorkingFallback(){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  await context.addInitScript(()=>Object.defineProperty(window,'indexedDB',{value:undefined,configurable:true}));
  try{
    const page=await context.newPage();
    await page.goto(url);
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    await page.locator('#editor').fill('Local fallback must persist when IndexedDB is missing.');
    await page.waitForTimeout(550);
    await page.reload();
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    assert.equal(await page.locator('#editor').inputValue(),'Local fallback must persist when IndexedDB is missing.');
    assert.equal(await page.locator('#toast.show').count(),0,'Fallback save does not notify');
    console.log('Chromium localStorage fallback persistence: PASS');
  }finally{await context.close();await browser.close();}
}
async function assertIdbWithBlockedLocalStorage(){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  await context.addInitScript(()=>{
    Storage.prototype.setItem=function(){throw new DOMException('LocalStorage blocked','QuotaExceededError');};
  });
  try{
    const page=await context.newPage();
    await page.goto(url);
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    await page.locator('#editor').fill('IndexedDB remains usable when localStorage writes fail.');
    await page.waitForTimeout(550);
    await page.reload();
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    assert.equal(await page.locator('#editor').inputValue(),'IndexedDB remains usable when localStorage writes fail.');
    assert.equal(await page.locator('#toast.show').count(),0,'No localStorage failure notification');
    console.log('Chromium IDB save despite blocked localStorage: PASS');
  }finally{await context.close();await browser.close();}
}
async function assertTransientIdbWriteFailure(){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  try{
    const page=await context.newPage();
    const errors=[];
    page.on('pageerror',e=>errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    await page.evaluate(()=>{
      window.__originalClearpageTransaction=IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction=function(store,mode,options){
        if(mode==='readwrite')throw new DOMException('Write disabled','QuotaExceededError');
        return window.__originalClearpageTransaction.call(this,store,mode,options);
      };
    });
    const editor=page.locator('#editor');
    await editor.pressSequentially('Writes fail, typing continues.',{delay:4});
    await page.waitForTimeout(450);
    assert.equal(await editor.inputValue(),'Writes fail, typing continues.');
    assert.equal(await page.locator('#toast.show').count(),0,'No warning on failed IDB write');
    assert.equal(await page.locator('#saveStatus').count(),0,'No status UI on failed write');
    await page.evaluate(()=>{IDBDatabase.prototype.transaction=window.__originalClearpageTransaction;});
    await editor.pressSequentially(' Writes recover.',{delay:4});
    await page.waitForTimeout(550);
    await page.reload();
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    assert.equal(await editor.inputValue(),'Writes fail, typing continues. Writes recover.','Autosave resumes after IDB recovers');
    assert.deepEqual(errors,[],'No unhandled browser exceptions');
    console.log('Chromium transient IDB write failure and recovery: PASS');
  }finally{await context.close();await browser.close();}
}

async function assertConflictingTabsStaySilent(){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  try{
    const first=await context.newPage();
    await first.goto(url);
    await first.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    await first.locator('#editor').fill('Shared baseline');
    await first.waitForTimeout(500);
    const second=await context.newPage();
    await second.goto(url);
    await second.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    assert.equal(await second.locator('#editor').inputValue(),'Shared baseline');
    await first.locator('#editor').fill('New text from first tab');
    await first.waitForTimeout(500);
    await second.locator('#editor').fill('Unsaved text in conflicting tab');
    await second.waitForTimeout(550);
    assert.equal(await second.locator('#editor').inputValue(),'Unsaved text in conflicting tab','Conflicting editor remains usable');
    assert.equal(await second.locator('#toast.show').count(),0,'Conflict never causes warning');
    assert.equal(await second.locator('#saveStatus').count(),0,'Conflict never exposes save status');
    await first.reload();
    await first.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    assert.equal(await first.locator('#editor').inputValue(),'New text from first tab','Conflict never overwrites first tab');
    console.log('Chromium two-tab conflicting writes: PASS');
  }finally{await context.close();await browser.close();}
}

async function injectEmergencyDraft(page,draft){
  // Simulate a draft left by another tab/crashed old version while this tab reloads.
  await page.evaluate(d=>{
    const originalSet=Storage.prototype.setItem;
    originalSet.call(localStorage,'clearpage.emergency.v2',JSON.stringify(d));
    Storage.prototype.setItem=function(key,value){
      if(this===localStorage && key==='clearpage.emergency.v2')return;
      return originalSet.call(this,key,value);
    };
  },draft);
}
async function activeStoredId(page){
  return page.evaluate(()=>new Promise((resolve,reject)=>{
    const opening=indexedDB.open('clearpage.data.v2',1);
    opening.onerror=()=>reject(opening.error);
    opening.onsuccess=()=>{
      const db=opening.result;
      const req=db.transaction('snapshots','readonly').objectStore('snapshots').get('current');
      req.onerror=()=>{db.close();reject(req.error);};
      req.onsuccess=()=>{const id=JSON.parse(req.result.record.json).activeId;db.close();resolve(id);};
    };
  }));
}
async function assertCrossTabDraftIsolation(){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  try{
    const page=await context.newPage();
    await page.goto(url);
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    await page.locator('#editor').fill('Committed text must not be replaced by another tab.');
    await page.waitForTimeout(550);
    const id=await activeStoredId(page);
    await injectEmergencyDraft(page,{id,title:'',text:'Foreign draft',at:Date.now()+2000,ownerId:'some-other-tab',baseRevision:0});
    await page.reload();
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    assert.equal(await page.locator('#editor').inputValue(),'Committed text must not be replaced by another tab.');
    assert.equal(await page.locator('#toast.show').count(),0,'No foreign-draft warning');
    console.log('Chromium cross-tab emergency draft isolation: PASS');
  }finally{await context.close();await browser.close();}
}
async function assertLegacyDraftPreservedSeparately(){
  const browser=await chromium.launch({headless:true});
  const context=await browser.newContext();
  try{
    const page=await context.newPage();
    await page.goto(url);
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    await page.locator('#editor').fill('Original saved version');
    await page.waitForTimeout(550);
    const id=await activeStoredId(page);
    await injectEmergencyDraft(page,{id,title:'',text:'Legacy unsaved draft',at:Date.now()+2000});
    await page.reload();
    await page.waitForFunction(()=>document.documentElement.dataset.clearpageReady==='true');
    assert.equal(await page.locator('#editor').inputValue(),'Legacy unsaved draft','Legacy draft is recovered');
    assert.equal(await page.evaluate(()=>localStorage.getItem('clearpage.emergency.v2')),null,'Recovered legacy draft is cleared only after persistence');
    await page.locator('#openPages').click();
    assert.equal(await page.locator('.page-item').count(),2,'Legacy recovery should not overwrite or duplicate saved note');
    await page.locator('#pageSearch').fill('Original saved version');
    await page.locator('.page-item-main').first().click();
    assert.equal(await page.locator('#editor').inputValue(),'Original saved version','Original committed note remains unchanged');
    console.log('Chromium legacy draft recovers alongside saved note: PASS');
  }finally{await context.close();await browser.close();}
}
try{
  for(const [name,engine] of [['Chromium',chromium],['Firefox',firefox]]){
    await run(engine,name,1280,800);
    await run(engine,name,390,740);
  }
  await assertSilentStorageFailure();
  await assertWorkingFallback();
  await assertIdbWithBlockedLocalStorage();
  await assertTransientIdbWriteFailure();
  await assertConflictingTabsStaySilent();
  await assertCrossTabDraftIsolation();
  await assertLegacyDraftPreservedSeparately();
  console.log('CLEARPAGE_EDITOR_SCROLL_REGRESSION=PASS');
}finally{await new Promise(resolve=>server.close(resolve));}
