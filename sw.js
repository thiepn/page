// Cache only the public, static writing shell. Never cache account callbacks,
// tokens, user documents, API responses, or cross-origin requests.
const CACHE='clearpage-shell-v1.3';
const SHELL=['/','/manifest.webmanifest','/icon.svg'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));
});
self.addEventListener('activate',event=>{
  event.waitUntil(caches.keys().then(keys=>Promise.all(
    keys.filter(key=>key.startsWith('clearpage-shell-')&&key!==CACHE).map(key=>caches.delete(key))
  )));
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET'||new URL(req.url).origin!==self.location.origin)return;
  const path=new URL(req.url).pathname;
  if(req.mode==='navigate'&&(path==='/'||path==='/index.html')){
    event.respondWith(fetch(req).then(async response=>{
      if(response.ok){
        const cache=await caches.open(CACHE);
        await cache.put('/',response.clone());
      }
      return response;
    }).catch(async()=>await caches.match('/')||Response.error()));
    return;
  }
  if(path==='/manifest.webmanifest'||path==='/icon.svg'){
    event.respondWith(fetch(req).then(async response=>{
      if(response.ok){
        const cache=await caches.open(CACHE);
        await cache.put(path,response.clone());
      }
      return response;
    }).catch(async()=>await caches.match(path)||Response.error()));
  }
});
