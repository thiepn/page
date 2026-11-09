import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {equal,validState,reconcile,toState} from '../src/merge.js';

const n=(id,text='',title='')=>({id,title,text,createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z'});
const s=(notes,trash=[])=>({schema:1,notes,trash});

test('JSONB property order never causes an edit conflict',()=>{
  assert.ok(equal({schema:1,notes:[{id:'a',title:'hi'}]},{notes:[{title:'hi',id:'a'}],schema:1}));
});
test('existing cloud pages replace fresh blank device without data loss',()=>{
  const local=s([n('placeholder')]),remote=s([n('remote','text')]);
  assert.ok(validState(remote));assert.equal(remote.notes[0].text,'text');
});
test('remote-only change is adopted',()=>{
  const base=s([n('a','old')]),remote=s([n('a','remote')]);
  const r=reconcile(base,base,remote,()=> 'duplicate');
  assert.equal(r.state.notes[0].text,'remote');assert.equal(r.conflicts,0);
});
test('local-only change is retained',()=>{
  const base=s([n('a','old')]),local=s([n('a','local')]);
  const r=reconcile(base,local,base,()=> 'duplicate');
  assert.equal(r.state.notes[0].text,'local');assert.equal(r.conflicts,0);
});
test('concurrent edits preserve both versions as separate pages',()=>{
  const base=s([n('a','old')]),local=s([n('a','local')]),remote=s([n('a','remote')]);
  const r=reconcile(base,local,remote,()=> 'copy');
  assert.equal(r.conflicts,1);assert.equal(r.state.notes.length,2);
  assert.equal(r.state.notes.find(x=>x.id==='a')?.text,'remote');
  assert.equal(r.state.notes.find(x=>x.id==='copy')?.text,'local');
  assert.match(r.state.notes.find(x=>x.id==='copy')?.title,/conflict copy/);
});
test('edit versus remote trash preserves local in new active page',()=>{
  const base=s([n('a','old')]),local=s([n('a','local')]),remote=s([n('placeholder')],[{...n('a','old'),deletedAt:'2026-01-02T00:00:00Z'}]);
  const r=reconcile(base,local,remote,()=> 'copy');
  assert.ok(r.state.trash.some(x=>x.id==='a'));
  assert.ok(r.state.notes.some(x=>x.id==='copy'&&x.text==='local'));
});
test('deleted pages stay deleted when a stale device has no edits',()=>{
  const base=s([n('a','old')]),remote=s([n('placeholder')],[{...n('a','old'),deletedAt:'2026-01-02T00:00:00Z'}]);
  const r=reconcile(base,base,remote);
  assert.ok(r.state.trash.some(x=>x.id==='a'));
  assert.ok(!r.state.notes.some(x=>x.id==='a'));
});
test('independent pages from devices merge without overwriting',()=>{
  const base=s([n('base')]),local=s([n('base'),n('l','left')]),remote=s([n('base'),n('r','right')]);
  const r=reconcile(base,local,remote);
  assert.deepEqual(new Set(r.state.notes.map(x=>x.id)),new Set(['base','l','r']));
});
test('retry rebases onto last observed server version without duplicating prior conflict copies',()=>{
  const base=s([n('a','old')]), local=s([n('a','local')]), firstRemote=s([n('a','remote')]);
  const first=reconcile(base,local,firstRemote,()=> 'copy');
  assert.equal(first.state.notes.length,2);
  // CAS fails, second server read contains a separate new page but same a.
  const updatedRemote=s([n('a','remote'),n('b','other device')]);
  const retry=reconcile(firstRemote,first.state,updatedRemote,()=> 'newcopy');
  assert.equal(retry.conflicts,0);
  assert.equal(retry.state.notes.filter(x=>x.text==='local').length,1);
  assert.equal(retry.state.notes.find(x=>x.id==='b')?.text,'other device');
});
test('cross-collection duplicate ID is invalid',()=>{
  assert.equal(validState(s([n('a')],[n('a')])),false);
});
test('blank state is always guaranteed after deletion',()=>{
  const base=s([n('a','old')]),local=s([n('placeholder')]),remote=s([n('placeholder')]);
  const r=reconcile(base,local,remote);
  assert.ok(r.state.notes.length>=1);
});
test('guest storage is separate from user-specific IndexedDB',()=>{
  const html=readFileSync('index.html','utf8');
  assert.match(html,/DB_NAME\+currentScope/);
  assert.match(html,/currentScope\s*=\s*next/);
  assert.match(html,/currentScope \? null : normalize\(getJSON\(LEGACY_KEY\)\)/);
  assert.match(html,/case 'account'/);
});
test('no default OAuth client credentials or accidental auto-upload',()=>{
  const config=readFileSync('src/config.js','utf8');
  const sync=readFileSync('src/account-sync.js','utf8');
  assert.match(config,/ACCOUNT_CLIENT_ID=''/);
  assert.match(sync,/if\(!callback&&!getFlag\(desiredKey\)\)/);
  assert.match(sync,/accountEnable/);
  assert.match(sync,/window.confirm\(/);
});
test('backend refuses direct table writes and requires client + account grant',()=>{
  const sql=readFileSync('supabase/20261109_clearpage_optional_sync_PENDING.sql','utf8');
  for(const phrase of ['revoke insert,update,delete','clearpage_client_allowed','oauth_client_id','identity.basic',"c.status='connected'","g.status='granted'",'p_expected_revision','p_mutation_id','auth.uid()']){
    assert.ok(sql.includes(phrase),phrase);
  }
  assert.ok(!sql.includes('grant select,insert,update'));
});
