const C='nfl-live-v58';
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(['/manifest.webmanifest','/icon-192.png','/icon-512.png'])).catch(()=>{}).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('nfl-live-')&&k!==C).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
// Always use the current deployment for navigation; never serve an obsolete HTML shell.
self.addEventListener('fetch',e=>{if(e.request.mode==='navigate')e.respondWith(fetch(e.request,{cache:'no-store'}));});
