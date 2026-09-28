/* Torque Index service worker: makes the site installable and quick to reopen.
   Pages always try the network first (so updates show up), photos are kept once downloaded. */
const CORE = "ti-core-v1", IMG = "ti-img-v1";
self.addEventListener("install", e => { e.waitUntil(caches.open(CORE).then(c => c.addAll(["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "favicon.svg"]).catch(() => {}))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CORE && k !== IMG).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname === "/version.txt") return;
  if (/^\/(sprites|hero)\//.test(u.pathname)) {
    e.respondWith(caches.open(IMG).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }))));
    return;
  }
  e.respondWith(fetch(e.request).then(r => { if (r.ok) caches.open(CORE).then(c => c.put(e.request, r.clone())); return r; }).catch(() => caches.match(e.request).then(m => m || caches.match("index.html"))));
});
