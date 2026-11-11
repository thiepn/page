// REVIEW-ONLY request classifier; NOT a live Playwright network handler.
// "candidate-only" never authorizes egress. Redirects may bypass Playwright
// routing, so approved future live tests require independent egress containment.
// No fetch, credentials, real tokens, activation, or route.continue() here.
export const LIVE_EGRESS_ENABLED=false;
export const CLEARPAGE_ORIGIN='https://page.thiepn.dev';
export const ACCOUNT_ORIGIN='https://account.thiepn.dev';
export const ISSUER_ORIGIN='https://hycegznamzjhwinegaai.supabase.co';
export const CLEARPAGE_CLIENT_ID='088b34ff-84ad-4746-a030-cc517159a17a';
export const CALLBACK=CLEARPAGE_ORIGIN+'/auth/callback/';

const localAssets=new Set([
  '/', '/index.html', '/auth/callback/', '/auth/callback',
  '/js/account-sync.js', '/js/config.js', '/js/merge.js',
  '/js/vendor/account-session/index.js',
  '/js/vendor/account-session/browser-sso.js'
]);
const result=(classification,rule)=>Object.freeze({classification,rule});
const deny=rule=>result('deny',rule);
const candidate=rule=>result('candidate-only',rule);
function exactKeys(query,allowed,required=[]){
  const keys=[...query.keys()];
  if(keys.some(k=>!allowed.includes(k)||query.getAll(k).length!==1))return false;
  return required.every(k=>query.has(k)&&Boolean(query.get(k)));
}
const noQuery=url=>!url.search;
function callbackParams(url){
  if(noQuery(url))return true; // Bare callback: negative smoke test only.
  const q=url.searchParams;
  if(q.has('code'))return exactKeys(q,['code','state'],['code','state']);
  if(q.has('error'))return exactKeys(q,['error','error_description','state'],['error','state']);
  return false;
}
function authorizeParams(url){
  const q=url.searchParams;
  const keys=['response_type','client_id','redirect_uri','scope','state','code_challenge','code_challenge_method'];
  return exactKeys(q,keys,keys)
    && q.get('response_type')==='code'
    && q.get('client_id')===CLEARPAGE_CLIENT_ID
    && q.get('redirect_uri')===CALLBACK
    && q.get('code_challenge_method')==='S256'
    && /^[A-Za-z0-9_-]{43,128}$/.test(q.get('code_challenge')??'')
    && /^[A-Za-z0-9._~-]{16,2048}$/.test(q.get('state')??'');
}

/** Pure offline classification. Do not convert candidate-only to route.continue().
 * Do not log raw URLs, query strings, headers, cookies, bodies or tokens.
 * Query values are checked and discarded; only coarse rule IDs are returned.
 */
export function classifyProposedRequest(rawUrl,method='GET'){
  if(typeof rawUrl!=='string'||typeof method!=='string')return deny('invalid-input');
  const verb=method.toUpperCase();
  if(!['GET','POST'].includes(verb))return deny('method');
  let url;
  try{url=new URL(rawUrl);}
  catch{return deny('invalid-url');}
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!url.hostname)
    return deny('unsafe-url');
  if(url.origin===CLEARPAGE_ORIGIN){
    if(verb!=='GET'||!localAssets.has(url.pathname))return deny('clearpage-fallback');
    if(url.pathname==='/auth/callback/'||url.pathname==='/auth/callback'){
      return callbackParams(url)?result('local','callback-shell'):deny('callback-query');
    }
    return noQuery(url)?result('local','reviewed-dist-asset'):deny('asset-query');
  }
  if(url.origin===ISSUER_ORIGIN){
    if(verb==='GET'&&url.pathname==='/auth/v1/oauth/authorize'
       &&authorizeParams(url))return candidate('issuer-pkce-authorization');
    if(verb==='POST'&&url.pathname==='/auth/v1/oauth/token'
       &&noQuery(url))return candidate('issuer-token-exchange-or-refresh');
    if(verb==='GET'&&url.pathname==='/auth/v1/user'
       &&noQuery(url))return candidate('issuer-identity-verification');
    if(verb==='GET'&&url.pathname==='/rest/v1/clearpage_sync_state'
       &&exactKeys(url.searchParams,['select','limit'],['select','limit'])
       &&url.searchParams.get('select')==='revision,payload,last_mutation_id'
       &&url.searchParams.get('limit')==='1')return candidate('owner-scoped-cloud-read');
    if(verb==='POST'&&url.pathname==='/rest/v1/rpc/clearpage_sync_cas'
       &&noQuery(url))return candidate('owner-derived-cas');
    return deny('issuer-unreviewed-endpoint');
  }
  if(url.origin===ACCOUNT_ORIGIN){
    if(verb==='GET'&&url.pathname==='/sso/probe'
       &&exactKeys(url.searchParams,['client_id'],['client_id'])
       &&url.searchParams.get('client_id')===CLEARPAGE_CLIENT_ID)
      return candidate('account-boolean-probe');
    if(verb==='GET'&&url.pathname==='/oauth/consent'
       &&exactKeys(url.searchParams,['authorization_id'],['authorization_id']))
      return candidate('account-consent-ui');
    // Login, CSS/JS bundles and provider redirects must be separately
    // inventoried and reviewed. Never blanket-allow Account /assets/**.
    return deny('account-unreviewed-endpoint');
  }
  return deny('external-origin');
}
