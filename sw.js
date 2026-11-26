// NFL LIVE 6.4 — no cached HTML or analytics interception
self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('nfl-live-')).map(k => caches.delete(k)))).then(() => self.clients.claim())));
// No fetch handler: browser and Vercel handle all network requests directly.
