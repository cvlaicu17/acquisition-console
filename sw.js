// Offline shell: after one online visit the page opens with no cell coverage (the usual field case).
// Bump VERSION on every release so phones pick up the new files.
const VERSION = 'lee-console-6bb70d8';
const FILES = ['./', 'index.html', 'app.js', 'client.js', 'protocol.js', 'webble.js', 'sim.js', 'style.css', 'icon.svg', 'manifest.webmanifest'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
// Network first (fresh code when online), cache when the network is gone.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then((r) => { const c = r.clone(); caches.open(VERSION).then((x) => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request)));
});
