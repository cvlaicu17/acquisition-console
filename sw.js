// Offline shell: after one online visit the page opens with no cell coverage (the usual field case).
// Bump VERSION on every release so phones pick up the new files.
const VERSION = 'lee-console-babdbdc';
const FILES = ['./', 'index.html', 'app.js', 'client.js', 'protocol.js', 'webble.js', 'sim.js', 'style.css', 'icon.svg', 'manifest.webmanifest'];
// cache: 'reload' / 'no-cache': GitHub Pages lets browsers reuse files for 10 min (max-age=600), so a plain
// fetch here could return the previous release right after publishing (2026-11-14: the Disconnect fix
// was live but the phone still ran the old webble.js).
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
// Network first (fresh code when online), cache when the network is gone.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const req = e.request.mode === 'navigate' ? e.request.url : e.request;   // a navigate Request cannot take options
  e.respondWith(fetch(req, { cache: 'no-cache' }).then((r) => { const c = r.clone(); caches.open(VERSION).then((x) => x.put(e.request, c)); return r; })
    .catch(() => caches.match(e.request)));
});
