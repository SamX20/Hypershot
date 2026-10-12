// Hyper Shot service worker: makes repeat visits load fast.
// - the page itself: network first (so updates show up right away), cached copy if offline
// - everything else (models, textures, sounds, three.js from the CDN): served from cache instantly and refreshed in the background
const CACHE='hs-v1';
self.addEventListener('install',e=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil((async()=>{
  for(const k of await caches.keys()) if(k!==CACHE) await caches.delete(k);
  await self.clients.claim(); })()));
self.addEventListener('fetch',e=>{
  const req=e.request; if(req.method!=='GET') return;
  const url=new URL(req.url);
  if(url.protocol!=='http:'&&url.protocol!=='https:') return;
  if(url.hostname.includes('railway.app')||url.hostname.includes('peerjs')) return; // live game traffic: never cache
  if(req.mode==='navigate'){
    e.respondWith((async()=>{ try{ const r=await fetch(req); const c=await caches.open(CACHE); c.put(req,r.clone()); return r; }
      catch(err){ return (await caches.match(req))||Response.error(); } })());
    return; }
  e.respondWith((async()=>{ const c=await caches.open(CACHE), hit=await c.match(req);
    const net=fetch(req).then(r=>{ if(r&&(r.ok||r.type==='opaque')) c.put(req,r.clone()); return r; }).catch(()=>null);
    if(hit){ e.waitUntil(net); return hit; }
    return (await net)||Response.error(); })());
});
