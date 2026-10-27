const C = 'hs-v12';
const SHELL = ['./', 'index.html', 'style.css', 'js/app.js', 'js/store.js', 'js/parse.js', 'js/category.js', 'js/optimize.js', 'js/gmail.js', 'js/ocr.js', 'js/ocr-paddle.js', 'js/ocr-post.js', 'js/ocr-vocab.js', 'js/ocr-dict.js', 'js/barcode.js', 'js/config.js', 'icon.svg', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== C).map((x) => caches.delete(x))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => { const cp = r.clone(); caches.open(C).then((c) => c.put(e.request, cp)); return r; }).catch(() => caches.match(e.request)));
});
