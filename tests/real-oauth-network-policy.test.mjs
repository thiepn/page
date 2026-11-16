import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProposedRequest as classify, LIVE_EGRESS_ENABLED,
  CLEARPAGE_ORIGIN as PAGE, ACCOUNT_ORIGIN as ACCOUNT,
  ISSUER_ORIGIN as ISSUER, CALLBACK, CLEARPAGE_CLIENT_ID as ID
} from './real-oauth-network-policy.mjs';
const cls=(u,m='GET')=>classify(u,m).classification;
test('future real OAuth egress is not enabled by adding this classifier',()=>{
  assert.equal(LIVE_EGRESS_ENABLED,false);
  assert.equal(cls(PAGE+'/'),'local');
  assert.equal(cls(PAGE+'/auth/callback/?code=synthetic&state=synthetic'),'local');
  assert.equal(cls(PAGE+'/auth/callback/?error=access_denied&state=synthetic'),'local');
  assert.equal(cls(PAGE+'/js/vendor/account-session/index.js'),'local');
  assert.equal(cls(PAGE+'/unknown-production-route/'),'deny');
  assert.equal(cls(PAGE+'/js/config.js?cache=1'),'deny');
  assert.equal(cls(PAGE+'/auth/callback/?code=example'),'deny');
  assert.equal(cls(PAGE+'/auth/callback/?code=one&code=two&state=s'),'deny');
});
test('known issuer paths remain only candidates, never real authorization',()=>{
  const params=new URLSearchParams({
    response_type:'code',client_id:ID,redirect_uri:CALLBACK,
    scope:'openid email profile offline_access',state:'synthetic-state-012345678901',
    code_challenge:'A'.repeat(43),code_challenge_method:'S256'
  });
  assert.deepEqual(classify(ISSUER+'/auth/v1/oauth/authorize?'+params),
    {classification:'candidate-only',rule:'issuer-pkce-authorization'});
  assert.equal(cls(ISSUER+'/auth/v1/oauth/token','POST'),'candidate-only');
  assert.equal(cls(ISSUER+'/auth/v1/user'),'candidate-only');
  assert.equal(cls(ISSUER+'/rest/v1/clearpage_sync_state?select=revision%2Cpayload%2Clast_mutation_id&limit=1'),'candidate-only');
  assert.equal(cls(ISSUER+'/rest/v1/rpc/clearpage_sync_cas','POST'),'candidate-only');
  params.set('code_challenge_method','plain');
  assert.equal(cls(ISSUER+'/auth/v1/oauth/authorize?'+params),'deny');
  params.set('code_challenge_method','S256');
  params.set('redirect_uri','https://somewhere-else.example/callback');
  assert.equal(cls(ISSUER+'/auth/v1/oauth/authorize?'+params),'deny');
  assert.equal(cls(ISSUER+'/auth/v1/oauth/token?redirect=https://elsewhere.example','POST'),'deny');
  assert.equal(cls(ISSUER+'/rest/v1/auth.users?select=*'),'deny');
  assert.equal(cls(ISSUER+'/rest/v1/rpc/clearpage_sync_cas','GET'),'deny');
  assert.equal(cls(ISSUER+'/rest/v1/clearpage_sync_state?select=*'),'deny');
});
test('Account paths default to denial until individually reviewed',()=>{
  assert.equal(cls(ACCOUNT+'/sso/probe?client_id='+ID),'candidate-only');
  assert.equal(cls(ACCOUNT+'/oauth/consent?authorization_id=synthetic-opaque'),'candidate-only');
  assert.equal(cls(ACCOUNT+'/sso/probe?client_id=00000000-0000-4000-8000-000000000000'),'deny');
  assert.equal(cls(ACCOUNT+'/sso/probe?client_id='+ID+'&next=https://evil.example'),'deny');
  for(const path of ['/','/login','/assets/index-abcd.js','/oauth/consent?authorization_id=x&extra=1']){
    assert.equal(cls(ACCOUNT+path),'deny',path);
  }
});
test('no alternate hosts, credentials, fragments, downgrade or unreviewed verbs',()=>{
  for(const u of [
    'http://page.thiepn.dev/','https://page.thiepn.dev.evil.example/',
    'https://account.thiepn.dev.evil.example/sso/probe',
    'https://user:pass@page.thiepn.dev/', 'https://page.thiepn.dev:444/',
    'https://page.thiepn.dev/#token', 'javascript:alert(1)',
    'https://accounts.google.com/', 'https://origin-isolation-test.invalid/'
  ])assert.equal(cls(u),'deny',u);
  assert.equal(cls(PAGE+'/','PUT'),'deny');
  assert.equal(classify(null).classification,'deny');
  assert.deepEqual(Object.keys(classify(ISSUER+'/auth/v1/oauth/token','POST')).sort(),
    ['classification','rule'],'result must not expose a sensitive URL');
});
