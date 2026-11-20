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
    await page.locator('#editor').fill('Writing must remain quiet when storage is blocked.');
    await page.waitForTimeout(600);
    assert.equal(await page.locator('#editor').inputValue(),'Writing must remain quiet when storage is blocked.');
    assert.equal(await page.locator('#saveStatus').count(),0,'No persistence status is displayed');
    assert.equal(await page.locator('.sidebar-foot').count(),0,'No unsolicited backup reminder is displayed');
    assert.equal(await page.locator('#toast.show').count(),0,'No warning toast interrupts typing');
    console.log('Chromium blocked-storage silent writing: PASS');
  }finally{
    await context.close();
    await browser.close();
  }
}
try{
  for(const [name,engine] of [['Chromium',chromium],['Firefox',firefox]]){
    await run(engine,name,1280,800);
    await run(engine,name,390,740);
  }
  await assertSilentStorageFailure();
  console.log('CLEARPAGE_EDITOR_SCROLL_REGRESSION=PASS');
}finally{await new Promise(resolve=>server.close(resolve));}
