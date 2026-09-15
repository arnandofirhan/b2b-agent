/*************************************************************
 * api-bridge.js  (B2B — dengan antrian concurrency-limit)
 * -------------------------------------------------------------
 * Menjadikan "google.script.run" bisa dipakai APA ADANYA di
 * JavaScript.html, padahal halaman ini di-hosting sebagai situs
 * statis (GitHub Pages) — bukan dari domain script.google.com.
 *
 * -------------------------------------------------------------
 * RIWAYAT DEBUG (baca kalau nanti error serupa muncul lagi):
 * -------------------------------------------------------------
 * GEJALA #1 (SUDAH FIX): CORS error yang request-nya kelihatan
 * sebagai GET padahal kode selalu fetch(...,{method:'POST'}), dan
 * hanya terjadi SEKALI/konsisten di awal — itu tanda deployment
 * /exec belum di-update ke versi kode terbaru, atau setelan
 * "Who has access"/"Execute as" salah. FIX: redeploy versi baru,
 * pastikan Execute as: Me, Who has access: Anyone.
 *
 * GEJALA #2 (DIPERBAIKI DI FILE INI): CORS error / 302 yang
 * muncul ACAK — hanya sebagian request gagal, sisanya sukses,
 * dan di Network tab kelihatan PULUHAN request ke /exec menembak
 * BERSAMAAN (mis. saat preloadAllPages_() di JavaScript.html
 * merender >10 halaman sekaligus setelah login). Ini BUKAN
 * masalah CORS/izin, melainkan Web App GAS overload karena
 * dikirimi request simultan melebihi kuota eksekusi paralel-nya
 * — sebagian request ditolak/di-throttle GAS di tengah jalan
 * sehingga responsnya tidak sempat membawa header CORS, dan
 * browser salah melaporkannya sebagai "CORS error".
 * FIX: file ini membatasi jumlah request yang boleh berjalan
 * BERSAMAAN lewat antrian (lihat MAX_CONCURRENT). Semua
 * pemanggilan google.script.run.namaFungsi(...) yang sudah ada
 * di JavaScript.html TIDAK PERLU diubah — antrian ini transparan.
 *************************************************************/
(function (global) {
  'use strict';

  var REQUEST_TIMEOUT_MS = 60000;

  // Maksimal request ke GAS yang boleh berjalan BERSAMAAN. Sisanya otomatis
  // diantre dan baru dijalankan begitu ada slot kosong. Diturunkan dari 4 ke 2 setelah
  // ditemukan bahwa preloadAllPages_() di JavaScript.html masih bisa membebani GAS saat
  // >10 halaman di-preload sekaligus usai login, menyebabkan sebagian eksekusi GAS
  // gagal/timeout dan direspons 404 lewat redirect echo?user_content_key=... . Sekarang
  // preloadAllPages_() JUGA sudah di-stagger (tidak lagi menembak semua sekaligus), jadi
  // kombinasi keduanya membuat beban ke backend jauh lebih halus.
  // PENTING (fix bug nyata): sebelumnya activeCount_ ini SATU angka global dipakai
  // bersama oleh hi & lo — job hi-priority cuma didahulukan DI URUTAN ANTRIAN, tapi
  // kalau ke-2 slot activeCount_ kebetulan sedang dipakai job LO-priority yang lagi
  // gagal-retry (bisa berjalan lama krn RETRY_DELAY_MS*attemptNo + MAX_ATTEMPTS 4x),
  // job hi-priority (klik user, mis. buka modal Detail PO) tetap harus NUNGGU slot
  // itu kosong dulu — gejalanya: modal keburu keliatan freeze/lama padahal request-nya
  // sendiri belum tentu lambat, cuma masih antre nunggu proses background yang lagi
  // sibuk retry. FIX: pisahkan jatah slot hi & lo jadi 2 counter independen supaya job
  // hi-priority PASTI selalu dapat slot sendiri, tidak pernah terblokir oleh proses
  // background yang sedang retry.
  // NAIK LAGI dari 1 -> 3 (HI) / 1 -> 2 (LO): 1/1 sengaja dicoba dulu untuk menghilangkan
  // burst 2x-simultan yang sempat bikin login+listPO gagal bareng, TAPI efek sampingnya
  // ternyata jauh lebih parah — SELURUH aplikasi jadi strictly-sequential satu request
  // per waktu, jadi 1 request lambat/di-retry menahan SEMUA request lain (termasuk klik
  // user) walau tidak saling terkait sama sekali. Root cause asli (2 request BERSAMAAN
  // persis di detik yang sama saat boot pertama) sudah ditangani dengan cara lain yang
  // lebih presisi: (1) dedup in-flight di callServer() mencegah panggilan identik dobel,
  // (2) preloadAllPages_() di JavaScript.html sudah di-stagger (tidak lagi menembak semua
  // sekaligus), (3) delay 2.5 detik sebelum preload mulai supaya tidak tabrakan dengan
  // request Dashboard sendiri. Dengan 3 mitigasi itu sudah aktif, HI=1/LO=1 tidak lagi
  // diperlukan dan hanya menambah lambat secara nyata di setiap klik menu — dinaikkan ke
  // HI=3 (jatah aksi user, cukup untuk beberapa klik cepat berurutan tanpa membanjiri GAS)
  // dan LO=2 (preload/polling background, tetap dibatasi rendah supaya tidak dominan).
  var MAX_CONCURRENT_HI = 3; // klik user / submit form — jatah sendiri, tidak pernah nunggu background
  var MAX_CONCURRENT_LO = 2; // preload/polling background — tetap dibatasi supaya tidak dominan
  var activeHi_ = 0;
  var activeLo_ = 0;

  // ANTRIAN 2 TINGKAT: request yang dipicu LANGSUNG oleh user (klik menu, submit form,
  // dsb) harus SELALU didahulukan dari request preload diam-diam di background
  // (preloadAllPages_ / polling notifikasi). Tanpa ini, begitu user klik menu lain
  // sesaat setelah login, request klik itu ikut antre di BELAKANG belasan request
  // preload yang sudah lebih dulu masuk antrian — makanya menu yang diklik terasa lama
  // padahal cuma nunggu giliran, bukan benar-benar lambat.
  //
  // DUA CARA MENANDAI SEBUAH PANGGILAN SEBAGAI BACKGROUND/LOW-PRIORITY:
  //  1) window.__BG_LOW_PRIORITY__ = true; ...panggil google.script.run...; = false;
  //     — cara lama, cocok utk panggilan SINKRON TUNGGAL (mis. loadNotifications_).
  //  2) google.script.run.asBackground().withSuccessHandler(fn)...namaFungsi(...)
  //     — cara BARU (lihat FIX BUG di bawah), WAJIB dipakai kalau renderer yang dipreload
  //     melakukan google.script.run BERANTAI (callback sukses yang di dalamnya memanggil
  //     google.script.run LAGI) — .asBackground() menempel tag "background" ke RUNNER itu
  //     sendiri, jadi ikut terbawa oleh clone runner (.withSuccessHandler/.withFailureHandler
  //     mengembalikan runner baru) TANPA peduli kapan call sesungguhnya baru benar2 terjadi.
  //
  // FIX BUG NYATA (device kadang lemot pas ada preload jalan di background, walau
  // MAX_CONCURRENT_HI/LO sudah dipisah): cara #1 (boolean via window) HANYA aman kalau
  // renderer yang dipreload melakukan PERSIS SATU google.script.run.xxx(...) yang terdaftar
  // sinkron. Kenyataannya beberapa renderer (mis. renderPO untuk role AGENT) memanggil
  // google.script.run PERTAMA secara sinkron (aman, masih ke-tag LO oleh preloadAllPages_),
  // tapi lalu di DALAM withSuccessHandler-nya memanggil google.script.run KEDUA (getAgentDetail
  // sukses -> baru lanjut listPO) — panggilan kedua ini baru terdaftar SETELAH request pertama
  // pulang dari network, yaitu SETELAH window.__BG_LOW_PRIORITY__ sudah lama di-set balik ke
  // false oleh pemanggil awal. Akibatnya request kedua ini salah ke-tag sebagai HI-priority,
  // ikut menyita slot MAX_CONCURRENT_HI yang seharusnya khusus buat aksi user — user klik menu
  // lain / submit form jadi ikut ketahan antre di belakang preload background tsb.
  // preloadAllPages_() di JavaScript.html sekarang dipanggil lewat pola #2 di atas untuk
  // renderer yang diketahui berantai, jadi tag LO-nya ikut terbawa sampai ke request paling
  // dalam sekalipun, seberapa pun dalam rantai callback-nya.
  var queueHi_ = [];
  var queueLo_ = [];

  // -----------------------------------------------------------------------
  // DEDUPLIKASI REQUEST IN-FLIGHT
  // -----------------------------------------------------------------------
  // BUG NYATA (dilaporkan user): saat login pertama di jaringan lambat, dashboard
  // (getAgentDashboardConfig/getDashboardData) kadang "macet" spinner lama sekali
  // (bisa >1 menit, karena antrian retry MAX_ATTEMPTS x RETRY_DELAY_MS x
  // REQUEST_TIMEOUT_MS). Begitu user pindah menu lalu balik lagi ke Dashboard,
  // request LAMA masih jalan diam-diam di background (tidak pernah dibatalkan),
  // dan showPage('dashboard') menembak request BARU yang identik — dua request
  // untuk fungsi & argumen yang sama, menghabiskan slot antrian dua kali dan
  // membuat load-nya terasa dobel/lebih lama.
  // FIX: kalau ada request dengan fnName+args yang SAMA PERSIS sedang berjalan
  // (belum jobDone), request baru yang identik CUKUP "menumpang" hasil yang lama
  // itu (dapat onSuccess/onFailure yang sama) alih-alih menembak request baru ke
  // server. Ini aman untuk fungsi read-only (get*/list*) yang dipakai di alur
  // render halaman — untuk fungsi yang mengubah data (create/update/delete) dedup
  // ini nyaris tidak pernah kena karena argumennya jarang identik dua kali
  // berturut-turut dalam window waktu yang sama, tapi supaya 100% aman kita
  // hanya men-dedup panggilan yang namanya berawalan get/list/fetch.
  var inFlight_ = Object.create(null); // key -> array of {onSuccess, onFailure}

  function isDedupableFn_(fnName) {
    return /^(get|list|fetch)/.test(fnName);
  }

  function inFlightKey_(fnName, args) {
    try {
      return fnName + '::' + JSON.stringify(args);
    } catch (e) {
      return null; // args tidak bisa di-serialize (mis. ada fungsi) — skip dedup, aman
    }
  }

  // FIX BUG NYATA (laporan: logout lalu login lagi cepat-cepat masih terasa lambat):
  // queueHi_/queueLo_/inFlight_ di atas SEBELUMNYA tidak pernah dikosongkan saat logout.
  // Kalau ada request lama (preload/dashboard) yang masih tertunda di antrian atau sedang
  // menunggu jawaban server saat user klik Logout, entri itu tetap nyangkut: begitu server
  // akhirnya menjawab, ia tetap ikut menempati slot MAX_CONCURRENT_HI/LO yang seharusnya
  // sudah bebas untuk sesi BARU, dan callback-nya (yang menunjuk ke fungsi render sesi lama)
  // masih terpanggil sia-sia. Fungsi ini dipanggil oleh handleLogout() di JavaScript.html
  // untuk membuang semua job yang belum sempat jalan (job yang SUDAH terkirim ke server
  // tidak bisa dibatalkan beneran, tapi dibiarkan selesai di background tanpa mengganggu
  // apa pun karena queueHi_/queueLo_ sudah dikosongkan duluan sebelum job itu genap giliran).
  function resetQueue_() {
    queueHi_.length = 0;
    queueLo_.length = 0;
    inFlight_ = Object.create(null);
  }

  function runNext_() {
    if (activeHi_ < MAX_CONCURRENT_HI && queueHi_.length) {
      var jobHi = queueHi_.shift();
      activeHi_++;
      jobHi(function done() { activeHi_--; runNext_(); });
    }
    if (activeLo_ < MAX_CONCURRENT_LO && queueLo_.length) {
      var jobLo = queueLo_.shift();
      activeLo_++;
      jobLo(function done() { activeLo_--; runNext_(); });
    }
  }

  function enqueue_(job, isBackground) {
    if (isBackground || global.__BG_LOW_PRIORITY__) queueLo_.push(job); else queueHi_.push(job);
    runNext_();
  }

  function resolveExecUrl() {
    var url = global.GAS_EXEC_URL || global.SO_APP_URL || global.SO_WEBAPP_URL;
    if (!url) {
      console.error('[api-bridge] GAS_EXEC_URL belum didefinisikan sebelum api-bridge.js dimuat.');
    }
    return url;
  }

  function callServer(fnName, args, onSuccess, onFailure, isBackground) {
    var url = resolveExecUrl();
    if (!url) {
      if (onFailure) onFailure(new Error('URL backend (GAS_EXEC_URL) belum diset.'));
      return;
    }

    // FIX BUG NYATA #1 (ditemukan saat audit — dedup TERNYATA cuma didefinisikan tapi TIDAK
    // PERNAH dipakai sebelumnya di sini, walau komentar & fungsi helper-nya sudah lengkap
    // sejak awal). Akibatnya: kalau user pindah halaman lalu balik lagi ke Dashboard SAAT
    // request lama untuk fungsi+argumen yang SAMA PERSIS masih jalan di background (umum
    // terjadi di koneksi lambat, request lama bisa >30 detik belum selesai), 2 request
    // identik menembak backend SEKALIGUS — pas persis dengan gejala di laporan: 2 toast
    // "TIMEOUT" muncul bersamaan begitu Dashboard dibuka. FIX: request baru untuk
    // fnName+args yang sama PERSIS dengan yang sedang berjalan cukup "menumpang" hasil yang
    // lama (dapat callback yang sama), tidak menembak request baru ke server sama sekali.
    var dedupKey = isDedupableFn_(fnName) ? inFlightKey_(fnName, args) : null;
    if (dedupKey && inFlight_[dedupKey]) {
      inFlight_[dedupKey].push({ onSuccess: onSuccess, onFailure: onFailure });
      return; // numpang — tidak menambah beban request baru ke backend
    }
    if (dedupKey) inFlight_[dedupKey] = [{ onSuccess: onSuccess, onFailure: onFailure }];

    // Semua waiter (pemanggil asli + yang numpang lewat dedup di atas) diberi tahu bareng
    // lewat sini, sekali jadi hasilnya keluar (sukses ATAU gagal) — dan entri dedup langsung
    // dibersihkan supaya panggilan identik BERIKUTNYA (setelah request ini selesai) menembak
    // request baru seperti biasa, bukan ikut numpang ke hasil yang sudah basi.
    // FIX BUG NYATA (crash nyata dari laporan user: "TypeError: Cannot read properties of
    // undefined (reading 'forEach') at notifyAll_", muncul di percobaan retry ke-2/ke-3):
    // notifyAll_ SEBELUMNYA berasumsi ia hanya akan dipanggil TEPAT SEKALI per dedupKey —
    // begitu dipanggil, ia langsung delete inFlight_[dedupKey]. Asumsi itu TIDAK SELALU benar:
    // kalau attempt() punya lebih dari satu jalur yang bisa berakhir memanggil notifyAll_
    // untuk closure yang SAMA (mis. sebuah promise fetch() lama yang telat resolve SETELAH
    // attempt lain di closure yang sama sudah lebih dulu notifyAll_+jobDone karena
    // timeout/retry), panggilan KEDUA akan membaca inFlight_[dedupKey] yang sudah dihapus
    // panggilan pertama -> undefined -> .forEach meledak. FIX: (1) simpan referensi waiters
    // SEBELUM delete, (2) kalau ternyata sudah kosong/undefined (sudah pernah dinotifikasi
    // sebelumnya), diam-diam berhenti alih-alih crash — hasil yang "telat" ini memang sudah
    // tidak relevan lagi buat siapapun, semua pemanggil asli sudah dapat jawaban.
    var notifyAllDone_ = false;
    function notifyAll_(isSuccess, payload) {
      if (notifyAllDone_) return; // panggilan kedua utk closure yg sama — sudah pernah selesai, abaikan
      notifyAllDone_ = true;
      var waiters = dedupKey ? inFlight_[dedupKey] : [{ onSuccess: onSuccess, onFailure: onFailure }];
      if (dedupKey) delete inFlight_[dedupKey];
      if (!waiters) return; // sudah dibersihkan lebih dulu oleh jalur lain — tidak ada yg perlu dinotifikasi
      waiters.forEach(function (w) {
        if (isSuccess) { if (w.onSuccess) w.onSuccess(payload); }
        else { if (w.onFailure) w.onFailure(payload); else console.error('[api-bridge] ' + fnName + ' gagal:', payload); }
      });
    }

    // RETRY OTOMATIS hanya untuk error jaringan murni (bukan error
    // deployment/akses — itu tidak akan hilang dengan diulang).
    var MAX_ATTEMPTS = 4; // dinaikkan dari 3 — glitch redirect/echo GAS kadang butuh >2x percobaan utk pulih
    // DITURUNKAN dari 700ms -> 400ms: dengan MAX_CONCURRENT_HI sekarang > 1, slot yang
    // dipakai sebuah request yang sedang retry TIDAK LAGI memblokir SEMUA request lain
    // (ada slot lain yang bebas), jadi delay besar di sini tidak lagi wajib untuk melindungi
    // klik user lain — tapi tetap diberi jeda kecil (bukan 0) supaya tidak langsung menembak
    // ulang GAS yang mungkin masih dalam kondisi ter-throttle.
    var RETRY_DELAY_MS = 400;
    // FIX BUG NYATA #2 (ditemukan saat audit): TIMEOUT (AbortError, request tidak dijawab
    // sama sekali dalam REQUEST_TIMEOUT_MS) sebelumnya LANGSUNG dianggap gagal permanen,
    // TIDAK PERNAH masuk jalur retry di atas — padahal timeout di koneksi lambat sering
    // cuma glitch sesaat (paket lambat/hilang), justru salah satu kasus yang PALING
    // diuntungkan kalau dicoba ulang. FIX: timeout sekarang boleh di-retry, TAPI dibatasi
    // cuma 1x percobaan ulang saja (bukan sampai MAX_ATTEMPTS penuh) — kalau timeout tetap
    // dipaksa retry 4x penuh, user di koneksi lemah bisa menunggu sampai ~4 menit
    // (4 x REQUEST_TIMEOUT_MS) untuk satu tombol yang akhirnya tetap gagal, yang jauh lebih
    // menyiksa daripada gagal cepat dengan pesan jelas.
    var MAX_TIMEOUT_RETRIES = 1;

    enqueue_(function (jobDone) {
      function attempt(attemptNo) {
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;

        var fetchOpts = {
          method: 'POST',
          // text/plain sengaja dipakai (bukan application/json) supaya request
          // dianggap "simple request" oleh browser dan TIDAK memicu CORS
          // preflight (OPTIONS) yang tidak didukung endpoint Apps Script.
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ fn: fnName, args: args }),
          redirect: 'follow'
        };
        if (controller) fetchOpts.signal = controller.signal;

        fetch(url, fetchOpts)
          .then(function (res) {
            if (timer) clearTimeout(timer);
            if (!res.ok) {
              // PENTING: status non-2xx dari endpoint GAS ini (baik langsung dari /exec
              // maupun dari redirect internalnya ke script.googleusercontent.com/macros/echo)
              // di RPC bridge ini HAMPIR SELALU transient — bukan "resource tidak ada"
              // sungguhan (tidak ada konsep URL/resource di sini, cuma 1 endpoint /exec).
              // Biasanya muncul kalau GAS lagi under load & sempat men-redirect ke echo
              // URL yang belum siap/telat, sehingga responsnya sempat 404. Ditandai
              // isTransientHttp=true supaya blok retry di bawah ikut mencoba ulang —
              // sebelumnya error jenis ini (bukan TypeError/CORS) LANGSUNG gagal permanen
              // tanpa retry sama sekali walau sebenarnya besar kemungkinan sukses kalau
              // dicoba lagi sesaat kemudian.
              var httpErr = new Error('HTTP ' + res.status + ' dari server.');
              httpErr.isTransientHttp = true;
              throw httpErr;
            }
            return res.text();
          })
          .then(function (text) {
            var data;
            try {
              data = JSON.parse(text);
            } catch (parseErr) {
              // Respons bukan JSON = hampir pasti bukan doPost() kita yang
              // menjawab, melainkan halaman lain (login Google / error GAS).
              // Pertanda deployment/akses Web App salah — lihat catatan file.
              throw new Error(
                'Respons server bukan JSON (kemungkinan deployment/akses ' +
                'Web App GAS belum benar — cek "Who has access: Anyone" & ' +
                '"Execute as: Me", lalu deploy versi baru).'
              );
            }
            jobDone();
            if (data && data.ok) {
              notifyAll_(true, data.result);
            } else {
              var msg = (data && data.error) ? data.error : 'Terjadi kesalahan pada server.';
              notifyAll_(false, new Error(msg));
            }
          })
          .catch(function (err) {
            if (timer) clearTimeout(timer);
            if (err && err.name === 'AbortError') {
              if (attemptNo <= MAX_TIMEOUT_RETRIES) {
                console.warn('[api-bridge] ' + fnName + ' percobaan ' + attemptNo + ' TIMEOUT, coba sekali lagi...', err);
                attempt(attemptNo + 1); // langsung coba lagi, tanpa delay tambahan (sudah nunggu REQUEST_TIMEOUT_MS penuh)
                return;
              }
              jobDone();
              notifyAll_(false, new Error('TIMEOUT: server tidak merespons dalam ' + (REQUEST_TIMEOUT_MS / 1000) + ' detik.'));
              return;
            }

            var isNetworkLikeError = (err instanceof TypeError) || /Failed to fetch|NetworkError|CORS/i.test(err && err.message || '') || (err && err.isTransientHttp);
            if (isNetworkLikeError && attemptNo < MAX_ATTEMPTS) {
              console.warn('[api-bridge] ' + fnName + ' percobaan ' + attemptNo + ' gagal (network/CORS), mencoba lagi...', err);
              setTimeout(function () { attempt(attemptNo + 1); }, RETRY_DELAY_MS * attemptNo);
              return;
            }
            jobDone();
            notifyAll_(false, err);
          });
      }

      attempt(1);
    }, isBackground);
  }

  // Proxy chainable yang meniru API asli google.script.run:
  //   google.script.run.withSuccessHandler(fn).withFailureHandler(fn).namaFungsi(a, b)
  //   google.script.run.namaFungsi(a, b)   <- juga didukung, tanpa handler
  function makeRunner(successHandler, failureHandler) {
    return new Proxy(function () {}, {
      get: function (target, prop) {
        if (prop === 'withSuccessHandler') {
          return function (fn) { return makeRunner(fn, failureHandler); };
        }
        if (prop === 'withFailureHandler') {
          return function (fn) { return makeRunner(successHandler, fn); };
        }
        if (prop === 'withUserObject') {
          return function () { return makeRunner(successHandler, failureHandler); };
        }
        if (typeof prop !== 'string') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          // Prioritas request DITENTUKAN DI SINI, saat request BENAR-BENAR dikirim (bukan
          // saat google.script.run.xxx di-reference) — lihat window.__BG_LOW_PRIORITY__
          // reentrant counter di JavaScript.html (preloadAllPages_) untuk kenapa ini penting
          // buat renderer yang google.script.run-nya berantai/nested lewat callback async.
          callServer(prop, args, successHandler, failureHandler, !!global.__BG_LOW_PRIORITY__);
        };
      }
    });
  }

  global.google = global.google || {};
  global.google.script = global.google.script || {};
  global.google.script.run = makeRunner(null, null);

  global.google.script.host = {
    close: function () {},
    setHeight: function () {},
    setWidth: function () {},
    origin: (global.location && global.location.origin) || ''
  };

  // ===========================================================================
  // BATCHING — window.callBackendBatch(calls)
  // ---------------------------------------------------------------------------
  // FIX PERFORMA BESAR ("PWA di HP lemot padahal data dikit, GAS langsung cepat"):
  // setiap google.script.run.xxx(...) = 1 request HTTP terpisah, dan SETIAP request itu
  // (berapapun kecil datanya) kena overhead TETAP dari redirect internal GAS + dispatch,
  // yang di sinyal seluler HP terasa jauh lebih berat daripada di wifi/desktop. Kalau 1
  // halaman butuh beberapa RPC buat tampil penuh (mis. Dashboard: config + products +
  // cart + notifications), overhead itu KALI jumlah RPC-nya, bukan berbagi 1x overhead.
  //
  // callBackendBatch() mengirim BEBERAPA panggilan fungsi dalam SATU request HTTP (lihat
  // handleBatchRpc_ di Code.gs) — backend menjalankan semuanya lalu membalas semua
  // hasilnya sekaligus. Hasilnya: cuma 1x kena overhead redirect+network walau yang
  // diminta 4 fungsi sekaligus.
  //
  // INI API TERPISAH dari google.script.run yang sudah ada — TIDAK mengubah/menggantikan
  // satu pun pemanggilan google.script.run.xxx(...) yang sudah ada di JavaScript.html.
  // Dipakai HANYA di titik-titik load halaman yang memang butuh beberapa RPC sekaligus
  // (mis. boot Dashboard), sebagai TAMBAHAN opsional — bukan rombak total jalur RPC yang
  // sudah ada.
  //
  // Pemakaian:
  //   window.callBackendBatch([
  //     { fn: 'getAgentDashboardConfig', args: [token] },
  //     { fn: 'listProducts', args: [token] },
  //     { fn: 'getCart', args: [token] }
  //   ]).then(function(results){
  //     // results[0] = { ok:true, result:... } atau { ok:false, error:'...' }, dst,
  //     // urutan PERSIS sama dengan urutan calls yang dikirim.
  //   });
  //
  // Request batch SELALU ditandai HI-priority (aksi user langsung menunggu halamannya),
  // dan TIDAK ikut sistem dedup in-flight (dedup dirancang untuk single-call get*/list*,
  // bukan untuk kombinasi call yang berubah-ubah per halaman).
  function callServerBatch_(calls) {
    return new Promise(function (resolve, reject) {
      var url = resolveExecUrl();
      if (!url) {
        reject(new Error('URL backend (GAS_EXEC_URL) belum diset.'));
        return;
      }

      var MAX_ATTEMPTS = 4;
      var RETRY_DELAY_MS = 400;
      var MAX_TIMEOUT_RETRIES = 1;

      enqueue_(function (jobDone) {
        function attempt(attemptNo) {
          var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
          var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;

          var fetchOpts = {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ calls: calls }),
            redirect: 'follow'
          };
          if (controller) fetchOpts.signal = controller.signal;

          fetch(url, fetchOpts)
            .then(function (res) {
              if (timer) clearTimeout(timer);
              if (!res.ok) {
                var httpErr = new Error('HTTP ' + res.status + ' dari server.');
                httpErr.isTransientHttp = true;
                throw httpErr;
              }
              return res.text();
            })
            .then(function (text) {
              var data;
              try {
                data = JSON.parse(text);
              } catch (parseErr) {
                throw new Error(
                  'Respons server bukan JSON (kemungkinan deployment/akses ' +
                  'Web App GAS belum benar — cek "Who has access: Anyone" & ' +
                  '"Execute as: Me", lalu deploy versi baru).'
                );
              }
              jobDone();
              if (data && data.ok && Array.isArray(data.results)) {
                resolve(data.results);
              } else {
                reject(new Error((data && data.error) ? data.error : 'Terjadi kesalahan pada server (batch).'));
              }
            })
            .catch(function (err) {
              if (timer) clearTimeout(timer);
              if (err && err.name === 'AbortError') {
                if (attemptNo <= MAX_TIMEOUT_RETRIES) {
                  console.warn('[api-bridge] batch percobaan ' + attemptNo + ' TIMEOUT, coba sekali lagi...', err);
                  attempt(attemptNo + 1);
                  return;
                }
                jobDone();
                reject(new Error('TIMEOUT: server tidak merespons dalam ' + (REQUEST_TIMEOUT_MS / 1000) + ' detik.'));
                return;
              }
              var isNetworkLikeError = (err instanceof TypeError) || /Failed to fetch|NetworkError|CORS/i.test(err && err.message || '') || (err && err.isTransientHttp);
              if (isNetworkLikeError && attemptNo < MAX_ATTEMPTS) {
                console.warn('[api-bridge] batch percobaan ' + attemptNo + ' gagal (network/CORS), mencoba lagi...', err);
                setTimeout(function () { attempt(attemptNo + 1); }, RETRY_DELAY_MS * attemptNo);
                return;
              }
              jobDone();
              reject(err);
            });
        }
        attempt(1);
      }, false); // false = HI-priority, batch selalu untuk halaman yang sedang ditunggu user
    });
  }

  global.callBackendBatch = callServerBatch_;

  // Dipanggil dari handleLogout() di JavaScript.html supaya antrian request lama
  // (preload/dashboard sesi sebelumnya yang belum sempat jalan) tidak nyangkut dan
  // membebani sesi berikutnya begitu user login lagi.
  global.__apiBridgeResetQueue__ = resetQueue_;
})(window);
