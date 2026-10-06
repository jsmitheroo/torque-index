/* Torque Index service worker: installable, opens instantly, works offline.
   The page itself is served from the cache straight away and refreshed in the background
   (the site shows "A new version is ready" when an update has arrived). Photos are kept once downloaded. */
const CORE = "ti-core-v2", IMG = "ti-img-v1";
const CORE_FILES = ["./", "manifest.webmanifest", "icon-192.png", "icon-512.png", "favicon.svg", "favicon.ico", "apple-touch-icon.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CORE).then(c => Promise.all(CORE_FILES.map(f => fetch(new Request(f, { cache: "reload" })).then(r => r.ok ? clean(r).then(cr => c.put(f, cr)) : null).catch(() => {}))))); self.skipWaiting(); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CORE && k !== IMG).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
/* a redirected response can't be used to answer a page load, so store a clean copy */
const clean = r => r.redirected ? r.clone().blob().then(b => new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers })) : Promise.resolve(r.clone());
function fresh(req, key) {
  return fetch(req, { cache: "no-cache" }).then(r => { if (r.ok && r.type === "basic") clean(r).then(cr => caches.open(CORE).then(c => c.put(key || req, cr))); return r; });
}
self.addEventListener("fetch", e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== "GET" || u.origin !== location.origin || u.pathname.startsWith("/api/") || u.pathname === "/version.txt" || u.pathname === "/sw.js") return;
  if (/^\/(sprites|hero)\//.test(u.pathname)) {
    e.respondWith(caches.open(IMG).then(c => c.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }))));
    return;
  }
  const isPage = req.mode === "navigate" || u.pathname === "/" || u.pathname.endsWith("/index.html");
  if (isPage) {
    const key = new Request(self.registration.scope);
    const net = fresh(req, key);
    e.waitUntil(net.catch(() => {}));
    e.respondWith(caches.match(key).then(hit => hit || net).catch(() => net).then(r => r || caches.match(key)));
    return;
  }
  e.respondWith(caches.match(req).then(hit => {
    const net = fresh(req).catch(() => hit);
    return hit || net;
  }));
});
/* push notifications: show them, and open the right page when tapped */
self.addEventListener("push", e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Torque Index", { body: d.body || "", icon: "icon-192.png", badge: "icon-192.png", data: { link: d.link || "#home" }, tag: d.tag || undefined }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close(); const url = new URL(self.registration.scope + (e.notification.data && e.notification.data.link || "#home")).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => { for (const c of list) { if ("focus" in c) { c.navigate ? c.navigate(url).catch(() => {}) : 0; return c.focus(); } } return self.clients.openWindow(url); }));
});
