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
var CACHE_VERSION = 'agrinesia-b2b-v65';
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

  // FIX BUG NYATA (console error: "Failed to execute 'put' on 'Cache': Request scheme
  // 'chrome-extension' is unsupported"): request GET yang lewat sini TERNYATA tidak selalu
  // murni datang dari halaman kita sendiri — ekstensi browser (ad-blocker, password manager,
  // React/Vue DevTools, dll) kadang ikut memicu fetch dengan skema URL seperti
  // 'chrome-extension://...' (atau 'moz-extension://', 'safari-extension://' di browser lain)
  // yang tetap ikut tertangkap oleh listener 'fetch' global ini karena scope-nya memang
  // seluruh halaman. Cache API browser CUMA menerima skema 'http:'/'https:' — begitu
  // caches.open(...).then(cache => cache.put(req, ...)) dipanggil untuk request berskema lain,
  // browser melempar TypeError di console (tidak fatal untuk user, tapi tetap bug/noise nyata
  // dan bikin promise fetch-nya reject tanpa penanganan/di-log sebagai uncaught).
  // FIX: cek skema URL request LEBIH DULU — kalau bukan http/https, jangan disentuh sama
  // sekali oleh Service Worker ini (biarkan lewat network seperti biasa, sama seperti
  // permintaan ke script.google.com di atas).
  if (req.url.indexOf('http://') !== 0 && req.url.indexOf('https://') !== 0) {
    return;
  }

  // FIX BUG NYATA (root cause "PWA di HP tetap lemot walau sinyal lancar & sudah update
  // kode"): ignoreSearch:true di atas membuat "JavaScript.html?v=XXXX" (versi BARU, beda
  // query string tiap kali ASSET_CACHE_BUSTER_ di index.html dinaikkan) dianggap SAMA
  // dengan entri precache lama "./JavaScript.html" — jadi versi LAMA yang selalu dikirim
  // duluan (cache-first), update-nya cuma menyusul diam-diam di background untuk load
  // BERIKUTNYA. Di browser desktop biasanya tidak kerasa (sering ke-hard-refresh/banyak
  // tab/DevTools kebuka), tapi PWA yang sudah di-install di HP nyaris tidak pernah
  // "fresh start" — jadi bisa STUCK bertahun-tahun jalan di kode lama walau sudah berkali-
  // kali di-update & di-deploy ulang, PADAHAL sinyalnya lancar (bukan soal jaringan sama
  // sekali, ini soal cache yang salah strategi).
  // FIX: index.html (dokumen utama/navigasi) & file yang memang sengaja dikasih cache-buster
  // query string (?v=..., yaitu JavaScript.html/Stylesheet.html) sekarang pakai NETWORK-FIRST
  // — coba network dulu (supaya versi TERBARU yang dipakai), cache cuma jadi fallback kalau
  // offline/network gagal. Asset statis lain (ikon, manifest, dll, yang memang jarang/tidak
  // pernah berubah) TETAP cache-first seperti sebelumnya supaya buka app tetap terasa instan.
  var isVersionedShellFile = req.url.indexOf('v=') !== -1 &&
    (req.url.indexOf('JavaScript.html') !== -1 || req.url.indexOf('Stylesheet.html') !== -1);
  var isNavigationOrIndex = req.mode === 'navigate' || /\/index\.html($|\?)/.test(req.url) || /\/$/.test(req.url.split('?')[0]);

  if (isVersionedShellFile || isNavigationOrIndex) {
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var resClone = res.clone();
          caches.open(CACHE_VERSION).then(function (cache) {
            cache.put(req, resClone).catch(function () {});
          });
        }
        return res;
      }).catch(function () {
        // Offline / network gagal total — baru jatuh ke cache (kalau ada) sebagai fallback,
        // lebih baik dari layar putih kosong.
        return caches.match(req, { ignoreSearch: true });
      })
    );
    return;
  }

  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(function (cached) {
      var networkFetch = fetch(req)
        .then(function (res) {
          // FIX TAMBAHAN: hanya cache response yang "basic" (same-origin, benar-benar bisa
          // dibaca) atau "cors" yang valid — response "opaque" (mis. dari CDN pihak ketiga
          // tanpa header CORS) tidak boleh diasumsikan status 200 dengan aman untuk logika
          // lain di masa depan, tapi yang PALING PENTING di sini: cache.put tetap dibungkus
          // try/catch supaya kasus tak terduga lain (skema aneh yang lolos dari pengecekan di
          // atas, kuota storage penuh, dll) tidak pernah jadi unhandled promise rejection lagi
          // di console — worst case gagal diam-diam, app tetap jalan normal dari network.
          if (res && res.status === 200) {
            var resClone = res.clone();
            caches.open(CACHE_VERSION).then(function (cache) {
              cache.put(req, resClone).catch(function (err) {
                console.warn('[service-worker] Gagal menyimpan ke cache (diabaikan, tidak mengganggu app):', err);
              });
            });
          }
          return res;
        })
        .catch(function () { return cached; }); // offline: fallback ke cache kalau ada
      // Cache-first untuk app-shell supaya buka cepat; kalau tidak ada di cache, tunggu network.
      return cached || networkFetch;
    })
  );
});
