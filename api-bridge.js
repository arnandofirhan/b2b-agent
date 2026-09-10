/*************************************************************
 * api-bridge.js  (B2B — diperkuat, meniru pola SO yang sudah lancar)
 * -------------------------------------------------------------
 * Menjadikan "google.script.run" bisa dipakai APA ADANYA di
 * JavaScript.html, padahal halaman ini di-hosting sebagai situs
 * statis (GitHub Pages) — bukan dari domain script.google.com.
 *
 * PENTING — BACA DULU SEBELUM DEBUG LEBIH LANJUT:
 * Error "CORS: No Access-Control-Allow-Origin" yang muncul di
 * Console TAPI request-nya terlihat sebagai GET (bukan POST yang
 * sebenarnya kita kirim) ini adalah TANDA KHAS bahwa GAS
 * me-redirect (302) request kita ke halaman lain (biasanya
 * halaman login Google) SEBELUM sempat sampai ke doPost().
 * Browser mengubah method jadi GET & membuang body saat redirect
 * 302 terjadi pada request non-GET — itulah kenapa terlihat "GET"
 * di Network tab padahal kode ini selalu fetch(..., {method:'POST'}).
 *
 * Penyebabnya BUKAN di file ini, tapi di deployment Web App GAS:
 *   1) Deployment /exec BELUM di-update ke versi kode terbaru
 *      (harus: Deploy > Manage deployments > pencil icon > Version:
 *      New version > Deploy — bukan cuma Ctrl+S di editor).
 *   2) Who has access BUKAN "Anyone" (harus "Anyone", bukan
 *      "Anyone with Google account" — yang terakhir ini memicu
 *      redirect ke accounts.google.com untuk request non-login).
 *   3) Execute as HARUS "Me" (pemilik script), bukan "User accessing
 *      the web app".
 * Cek ketiga hal ini dulu di GAS project B2B kalau error CORS masih
 * muncul walau file ini sudah benar.
 *************************************************************/
(function (global) {
  'use strict';

  var REQUEST_TIMEOUT_MS = 60000;

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

    // RETRY OTOMATIS hanya untuk error jaringan murni (bukan untuk error
    // deployment/akses — itu tidak akan hilang dengan diulang, jadi
    // langsung dilaporkan supaya tidak menunggu sia-sia).
    var MAX_ATTEMPTS = 3;
    var RETRY_DELAY_MS = 700;

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
          if (!res.ok) throw new Error('HTTP ' + res.status + ' dari server.');
          return res.text();
        })
        .then(function (text) {
          var data;
          try {
            data = JSON.parse(text);
          } catch (parseErr) {
            // Respons bukan JSON = hampir pasti bukan doPost() kita yang
            // menjawab, melainkan halaman lain (login Google / error GAS).
            // Ini pertanda deployment/akses Web App salah — lihat catatan
            // di atas file ini.
            throw new Error(
              'Respons server bukan JSON (kemungkinan deployment/akses ' +
              'Web App GAS belum benar — cek "Who has access: Anyone" & ' +
              '"Execute as: Me", lalu deploy versi baru).'
            );
          }
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
            if (onFailure) onFailure(new Error('TIMEOUT: server tidak merespons dalam ' + (REQUEST_TIMEOUT_MS / 1000) + ' detik.'));
            else console.error('[api-bridge] ' + fnName + ' timeout.');
            return;
          }

          var isNetworkLikeError = (err instanceof TypeError) || /Failed to fetch|NetworkError|CORS/i.test(err && err.message || '');
          if (isNetworkLikeError && attemptNo < MAX_ATTEMPTS) {
            console.warn('[api-bridge] ' + fnName + ' percobaan ' + attemptNo + ' gagal (network/CORS), mencoba lagi...', err);
            setTimeout(function () { attempt(attemptNo + 1); }, RETRY_DELAY_MS * attemptNo);
            return;
          }
          if (onFailure) onFailure(err);
          else console.error('[api-bridge] ' + fnName + ' error jaringan:', err);
        });
    }

    attempt(1);
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
