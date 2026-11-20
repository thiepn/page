import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {chromium,firefox} from 'playwright';

const root=resolve('.');
const server=createServer((req,res)=>{
  try{
    const name=new URL(req.url,'http://localhost').pathname.replace(/^\/+/,'')||'index.html';
    if(!['index.html','manifest.webmanifest','sw.js','icon.svg'].includes(name)){res.writeHead(404).end();return;}
    const path=resolve(root,name);
    if(!path.startsWith(root+sep)){res.writeHead(403).end();return;}
    const mime=extname(path)==='.js'?'text/javascript':extname(path)==='.svg'?'image/svg+xml':extname(path)==='.webmanifest'?'application/manifest+json':'text/html';
    res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-store'});
    res.end(readFileSync(path));
  }catch{res.writeHead(404).end();}
});
await new Promise(done=>server.listen(0,'127.0.0.1',done));
const url='http://127.0.0.1:'+server.address().port+'/';
const pause=ms=>new Promise(done=>setTimeout(done,ms));
// Assert the actual persisted note, not the intentionally removed save-status UI.
const waitSaved=page=>page.waitForFunction(async()=>{
  if(document.documentElement.dataset.clearpageReady!=='true')return false;
  const title=document.querySelector('#pageTitle')?.value;
  const text=document.querySelector('#editor')?.value;
  try {
    const db=await new Promise((resolve,reject)=>{
      const req=indexedDB.open('clearpage.data.v2',1);
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    const row=await new Promise((resolve,reject)=>{
      const req=db.transaction('snapshots','readonly').objectStore('snapshots').get('current');
      req.onsuccess=()=>resolve(req.result);
      req.onerror=()=>reject(req.error);
    });
    db.close();
    const data=JSON.parse(row?.record?.json||'null');
    const note=data?.notes?.find(n=>n.id===data.activeId);
    return note?.title===title && note?.text===text;
  }catch{return false;}
},undefined,{timeout:10000});
const saveText=async(page,value)=>{
  await page.locator('#editor').fill(value);
  await page.waitForTimeout(540);
  await waitSaved(page);
};
async function scenario(engine,name,viewport,mobile=false){
  const browser=await engine.launch({headless:true});
  const context=await browser.newContext({viewport,acceptDownloads:true,hasTouch:mobile,isMobile:mobile&&name==='chromium'});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  try{
    await page.goto(url);
    await waitSaved(page);
    await page.locator('#pageTitle').fill('Find and replace note');
    await saveText(page,'one two one a.b');
    await page.locator('#findButton').click();
    await page.locator('#findQuery').fill('one');
    assert.match(await page.locator('#findCount').innerText(),/2 matches/);
    await page.locator('#findNext').click();
    assert.deepEqual(await page.locator('#editor').evaluate(el=>el.value.slice(el.selectionStart,el.selectionEnd)),'one');
    await page.locator('#replaceQuery').fill('three');
    await page.locator('#replaceOne').click();
    assert.equal(await page.locator('#editor').inputValue(),'three two one a.b');
    await page.locator('#toastUndo').click();
    assert.equal(await page.locator('#editor').inputValue(),'one two one a.b','single replacement undo');
    await page.locator('#replaceOne').click();
    assert.equal(await page.locator('#editor').inputValue(),'three two one a.b');
    await page.locator('#replaceAll').click();
    assert.equal(await page.locator('#editor').inputValue(),'three two three a.b');
    await page.locator('#toastUndo').click();
    assert.equal(await page.locator('#editor').inputValue(),'three two one a.b','replace-all is undoable');
    await page.locator('#findQuery').fill('a.b');
    assert.match(await page.locator('#findCount').innerText(),/1 matches/,'find matches literal punctuation');
    await page.locator('#findClose').click();
    assert.equal(await page.locator('#findBar').isVisible(),false);

    // Pinning is metadata only: it must persist across a reload while the
    // existing v2 backup still contains only the original notes/trash fields.
    await page.locator('#openPages').click();
    const first=page.locator('.page-item').filter({hasText:'Find and replace note'}).first();
    await first.locator('.page-pin').click();
    await page.locator('#pinnedTab').click();
    assert.equal(await page.locator('.page-item-main').count(),1);
    assert.match(await page.locator('#sidebarTitle').innerText(),/Pinned pages/);
    await page.locator('#recentTab').click();
    assert.ok((await page.locator('.page-item-main').count())>=1);
    await page.locator('#sidebarNew').click();
    await page.locator('#pageTitle').fill('History target');
    await saveText(page,'Before revision\nThe unchanged sentence');
    await saveText(page,'After revision\nThe unchanged sentence');
    await page.locator('#historyButton').click();
    await page.locator('#recoveryBackdrop').waitFor({state:'visible'});
    const versions=await page.locator('#recoverySnapshot option').count();
    assert.ok(versions>=1,name+': version history must have snapshots');
    let found=false;
    for(let version=0;version<versions;version++){
      await page.locator('#recoverySnapshot').selectOption(String(version));
      const choices=await page.locator('#recoveryPage option').count();
      for(let choice=0;choice<choices;choice++){
        await page.locator('#recoveryPage').selectOption(String(choice));
        if((await page.locator('#historyOlder').innerText()).includes('Before revision')){
          found=true;break;
        }
      }
      if(found)break;
    }
    assert.ok(found,name+': older page version is previewable');
    assert.match(await page.locator('#historyCurrent').innerText(),/After revision/);
    await page.locator('#recoveryConfirm').click();
    assert.equal(await page.locator('#editor').inputValue(),'Before revision\nThe unchanged sentence');
    await page.locator('#openPages').click();
    await page.locator('#pagesTab').click();
    assert.ok((await page.locator('.page-item-main').count())>=3,name+': recovery creates a copy, not an overwrite');
    await page.locator('#closePages').click();

    // Earlier backup v2 continues to round-trip without new metadata fields.
    const downloadPromise=page.waitForEvent('download');
    await page.locator('#menuButton').click();
    await page.locator('[data-action="backup"]').click();
    const download=await downloadPromise;
    const stream=await download.createReadStream(),chunks=[];
    for await (const chunk of stream)chunks.push(chunk);
    const backup=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.equal(backup.version,2);
    assert.ok(Array.isArray(backup.notes));
    assert.ok(!('pinned' in backup)&&!('recent' in backup)&&!('cursors' in backup));
    await page.reload();
    await waitSaved(page);
    await page.locator('#openPages').click();
    await page.locator('#pinnedTab').click();
    assert.equal(await page.locator('.page-item-main').count(),1,'pins survive reload');
    await page.locator('#closePages').click();

    // Long writing: manual scroll shows a return affordance, and switching
    // away/back preserves a resumable caret without hijacking initial viewport.
    await page.locator('#openPages').click();
    await page.locator('#sidebarNew').click();
    await page.locator('#pageTitle').fill('Long writing resume target');
    const longText=Array.from({length:65},(_,i)=>'Line '+i+': Continuing the same long document should stay practical.').join('\n');
    await saveText(page,longText);
    await page.waitForTimeout(100);
    const writingY=await page.evaluate(()=>window.scrollY);
    assert.ok(writingY>500,name+': typing long note follows cursor');
    await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));
    await page.waitForTimeout(120);
    assert.equal(await page.locator('#resumeWriting').isVisible(),true,name+': manual reading offers return to writing');
    await page.locator('#resumeWriting').click();
    await page.waitForTimeout(100);
    assert.ok((await page.evaluate(()=>window.scrollY))>500,name+': resume scrolls to the saved cursor');
    await page.locator('#openPages').click();
    await page.locator('#sidebarNew').click();
    await page.locator('#openPages').click();
    assert.equal(await page.locator('#pagesTab').getAttribute('aria-pressed'),'true','new pages reset an incompatible sidebar filter');
    await page.locator('.page-item').filter({hasText:'Long writing resume target'}).first().locator('.page-item-main').click();
    assert.ok((await page.evaluate(()=>window.scrollY))<5,name+': returning page initially opens at top');
    assert.equal(await page.locator('#resumeWriting').isVisible(),true,name+': last cursor remains resumable');
    await page.locator('#resumeWriting').click();
    await page.waitForTimeout(100);
    assert.ok((await page.evaluate(()=>window.scrollY))>500,name+': resumed cursor returns to writing position');

    // Mobile navigation must not overflow the width or obscure controls.
    if(mobile){
      const dims=await page.evaluate(()=>({inner:innerWidth,scroll:document.documentElement.scrollWidth}));
      assert.ok(dims.scroll<=dims.inner+2,name+' mobile overflow '+JSON.stringify(dims));
      assert.equal(await page.locator('#findButton').isVisible(),true);
    }
    assert.deepEqual(errors,[],name+': runtime errors: '+errors.join(' | '));
    console.log(name+' '+viewport.width+'x'+viewport.height+': PASS find/replace, undo, search, history comparison and copy restore, pinned/recent, v2 backup, reload');
    if(name==='chromium' && !mobile){
      await page.waitForFunction(()=>navigator.serviceWorker?.ready,{timeout:10000});
      const manifest=await page.evaluate(async()=>await (await fetch('/manifest.webmanifest')).json());
      assert.equal(manifest.display,'standalone');
      await page.reload();
      await page.waitForFunction(()=>Boolean(navigator.serviceWorker?.controller),{timeout:10000});
      await context.setOffline(true);
      await page.reload();
      assert.equal(await page.locator('#editor').count(),1,'offline cached app shell');
      await waitSaved(page);
      await page.locator('#openPages').click();
      await page.locator('#pageSearch').fill('Long writing resume target');
      await page.locator('.page-item-main').first().click();
      assert.ok((await page.locator('#editor').inputValue()).includes('Continuing the same long document'),'offline saved notes remain accessible');
      await context.setOffline(false);
      console.log('PWA_OFFLINE_SHELL=PASS');
    }
  }finally{
    await context.close();
    await browser.close();
  }
}
try{
  await scenario(chromium,'chromium',{width:1280,height:800},false);
  await scenario(chromium,'chromium',{width:390,height:740},true);
  await scenario(firefox,'firefox',{width:1280,height:800},false);
  await scenario(firefox,'firefox',{width:390,height:740},true);
  console.log('CLEARPAGE_USABILITY_V13=PASS');
}finally{await new Promise(done=>server.close(done));}
