/*************************************************************
 * service-worker.js
 * -------------------------------------------------------------
 * Cache "app shell" (file statis) supaya PWA bisa terbuka cepat &
 * tetap bisa tampil walau koneksi hilang. Data dari backend (Code.gs)
 * TIDAK di-cache di sini — selalu diambil live lewat api-bridge.js,
 * supaya data yang ditampilkan selalu yang terbaru.
 *
 * Kalau kamu mengubah isi index.html/JavaScript.html/Stylesheet.html
 * dan perubahannya tidak muncul di HP, naikkan CACHE_VERSION di bawah
 * ini supaya service worker lama dibuang & cache diisi ulang.
 *************************************************************/
var CACHE_VERSION = 'agrinesia-b2b-v35';
var APP_SHELL = [
  './',
  './index.html',
  './JavaScript.html',
  './Stylesheet.html',
  './api-bridge.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-192.png',
  './icon-maskable-512.png'
];

self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      return cache.addAll(APP_SHELL).catch(function (err) {
        // Jangan gagalkan instalasi SW kalau satu-dua file gagal di-cache saat install
        // (mis. koneksi lambat) — app tetap bisa jalan online seperti biasa.
        console.warn('[service-worker] Sebagian app shell gagal di-cache saat install:', err);
      });
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_VERSION; })
          .map(function (key) { return caches.delete(key); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var req = event.request;

  // Jangan pernah cache pemanggilan ke backend GAS (RPC lewat api-bridge.js) —
  // data harus selalu live, bukan dari cache.
  if (req.method !== 'GET' || req.url.indexOf('script.google.com') !== -1) {
    return; // biarkan request ini lewat network seperti biasa
  }

  event.respondWith(
    caches.match(req).then(function (cached) {
      var networkFetch = fetch(req)
        .then(function (res) {
          if (res && res.status === 200) {
            var resClone = res.clone();
            caches.open(CACHE_VERSION).then(function (cache) { cache.put(req, resClone); });
          }
          return res;
        })
        .catch(function () { return cached; }); // offline: fallback ke cache kalau ada
      // Cache-first untuk app-shell supaya buka cepat; kalau tidak ada di cache, tunggu network.
      return cached || networkFetch;
    })
  );
});
