/* Learn With Me — Service Worker (تثبيت التطبيق + فتح سريع + آخر نسخة محفوظة لو النت قطع) */
const C = 'lwm-v1';
const PRE = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(C).then(c => Promise.allSettled(PRE.map(u => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  if (u.origin !== location.origin) return;          /* Firebase والخطوط والفيديوهات مش بتتخزن هنا */
  if (r.mode === 'navigate') {                        /* الصفحة: النسخة الجديدة الأول، ولو النت قطع آخر نسخة */
    e.respondWith(fetch(r).then(res => { const c = res.clone(); caches.open(C).then(x => x.put('./', c)); return res; }).catch(() => caches.match('./')));
    return;
  }
  e.respondWith(caches.match(r).then(hit => {
    const net = fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(C).then(x => x.put(r, c)); } return res; }).catch(() => hit);
    return hit || net;
  }));
});
