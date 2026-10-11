const V = 'lwm-v4';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'apple-touch-icon.png', 'favicon-48.png'];
const FB = 'https://www.gstatic.com/firebasejs/10.14.1/';
const LIBS = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js', 'firebase-analytics.js'].map(f => FB + f);
const CDN = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(async c => {
    await c.addAll(SHELL);
    await Promise.all(LIBS.map(u => c.add(u).catch(() => {})));   // عشان الموقع يفتح من غير نت
  }).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;

  /* مكتبات فايربيز والخطوط: من الكاش الأول (مرقّمة بالنسخة) */
  if (CDN.includes(u.hostname)) {
    e.respondWith(caches.match(r).then(hit => hit || fetch(r).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(V).then(c => c.put(r, copy)); }
      return res;
    })));
    return;
  }

  /* ملفات الموقع: الشبكة الأول (عشان التحديثات تظهر)، والكاش لو مفيش نت */
  if (u.origin !== location.origin) return;
  e.respondWith(
    fetch(r).then(res => {
      const copy = res.clone();
      caches.open(V).then(c => c.put(r, copy));
      return res;
    }).catch(() => caches.match(r).then(m => m || caches.match('index.html')))
  );
});
