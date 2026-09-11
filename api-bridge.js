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
  var MAX_CONCURRENT = 2;
  var activeCount_ = 0;

  // ANTRIAN 2 TINGKAT: request yang dipicu LANGSUNG oleh user (klik menu, submit form,
  // dsb) harus SELALU didahulukan dari request preload diam-diam di background
  // (preloadAllPages_ / polling notifikasi). Tanpa ini, begitu user klik menu lain
  // sesaat setelah login, request klik itu ikut antre di BELAKANG belasan request
  // preload yang sudah lebih dulu masuk antrian — makanya menu yang diklik terasa lama
  // padahal cuma nunggu giliran, bukan benar-benar lambat. JavaScript.html menandai
  // panggilan sebagai "background" dengan set window.__BG_LOW_PRIORITY__ = true tepat
  // sebelum memanggil google.script.run, lalu balikin ke false lagi setelahnya.
  var queueHi_ = [];
  var queueLo_ = [];

  function runNext_() {
    if (activeCount_ >= MAX_CONCURRENT) return;
    var job = queueHi_.length ? queueHi_.shift() : queueLo_.shift();
    if (!job) return;
    activeCount_++;
    job(function done() {
      activeCount_--;
      runNext_();
    });
  }

  function enqueue_(job) {
    if (global.__BG_LOW_PRIORITY__) queueLo_.push(job); else queueHi_.push(job);
    runNext_();
  }

  function resolveExecUrl() {
    var url = global.GAS_EXEC_URL || global.SO_APP_URL || global.SO_WEBAPP_URL;
    if (!url) {
      console.error('[api-bridge] GAS_EXEC_URL belum didefinisikan sebelum api-bridge.js dimuat.');
    }
    return url;
  }

  function callServer(fnName, args, onSuccess, onFailure) {
    var url = resolveExecUrl();
    if (!url) {
      if (onFailure) onFailure(new Error('URL backend (GAS_EXEC_URL) belum diset.'));
      return;
    }

    // RETRY OTOMATIS hanya untuk error jaringan murni (bukan error
    // deployment/akses — itu tidak akan hilang dengan diulang).
    var MAX_ATTEMPTS = 4; // dinaikkan dari 3 — glitch redirect/echo GAS kadang butuh >2x percobaan utk pulih
    var RETRY_DELAY_MS = 700;

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
              if (onSuccess) onSuccess(data.result);
            } else {
              var msg = (data && data.error) ? data.error : 'Terjadi kesalahan pada server.';
              if (onFailure) onFailure(new Error(msg));
              else console.error('[api-bridge] ' + fnName + ' gagal:', msg);
            }
          })
          .catch(function (err) {
            if (timer) clearTimeout(timer);
            if (err && err.name === 'AbortError') {
              jobDone();
              if (onFailure) onFailure(new Error('TIMEOUT: server tidak merespons dalam ' + (REQUEST_TIMEOUT_MS / 1000) + ' detik.'));
              else console.error('[api-bridge] ' + fnName + ' timeout.');
              return;
            }

            var isNetworkLikeError = (err instanceof TypeError) || /Failed to fetch|NetworkError|CORS/i.test(err && err.message || '') || (err && err.isTransientHttp);
            if (isNetworkLikeError && attemptNo < MAX_ATTEMPTS) {
              console.warn('[api-bridge] ' + fnName + ' percobaan ' + attemptNo + ' gagal (network/CORS), mencoba lagi...', err);
              setTimeout(function () { attempt(attemptNo + 1); }, RETRY_DELAY_MS * attemptNo);
              return;
            }
            jobDone();
            if (onFailure) onFailure(err);
            else console.error('[api-bridge] ' + fnName + ' error jaringan:', err);
          });
      }

      attempt(1);
    });
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
          callServer(prop, args, successHandler, failureHandler);
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
})(window);
