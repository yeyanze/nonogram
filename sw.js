/* sw.js — Service Worker：network-first（在线总是最新，离线回退缓存） */
const CACHE = 'nonogram-v16';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/core.js',
  './js/solver.js',
  './js/vendor/qrcode.min.js',
  './js/vendor/jsqr.min.js',
  './js/render.js',
  './js/input.js',
  './js/levels.js',
  './js/storage.js',
  './js/app.js',
  './data/packs.js',
  './data/icons-5.jsonp.js',
  './data/icons-10.jsonp.js',
  './data/icons-15.jsonp.js',
  './data/icons-20.jsonp.js',
  './data/icons-25.jsonp.js',
  './data/stickers-25.jsonp.js',
  './data/stickers-thumbs.js',
  './icon.svg',
  './manifest.webmanifest',
    // sticker-thumbs: 192 张 webp 已打包为 base64 内嵌 data/stickers-thumbs.js
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(ASSETS.map((a) => c.add(a)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // network-first：优先网络（总是最新），失败回退缓存（离线可玩）
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, clone));
      }
      return res;
    }).catch(() =>
      caches.match(e.request).then((hit) => {
        if (hit) return hit;
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      })
    )
  );
});
