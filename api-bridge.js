/*************************************************************
 * api-bridge.js
 * -------------------------------------------------------------
 * Menjadikan "google.script.run" bisa dipakai APA ADANYA di
 * JavaScript.html (tanpa mengubah ratusan pemanggilan yang sudah
 * ada), padahal halaman ini di-hosting sebagai situs statis (mis.
 * GitHub Pages) — bukan lagi dari domain script.google.com.
 *
 * Cara kerja: setiap .withSuccessHandler(fn).withFailureHandler(fn)
 * .namaFungsi(arg1, arg2, ...) di-encode menjadi POST JSON
 * { fn: "namaFungsi", args: [arg1, arg2, ...] } ke Web App GAS
 * (var GAS_EXEC_URL / SO_APP_URL, WAJIB didefinisikan SEBELUM
 * file ini dimuat — lihat index.html).
 *
 * Backend (Code.gs) merespons lewat doPost()/handleRpc_() dengan
 * { ok:true, result:... } atau { ok:false, error:"..." }.
 *
 * CATATAN: Google Apps Script Web App (/exec) yang di-deploy
 * dengan akses "Anyone" otomatis mengizinkan fetch() lintas-origin
 * untuk permintaan POST bertipe text/plain (tanpa header custom),
 * sehingga tidak perlu proxy CORS tambahan.
 *************************************************************/
(function (global) {
  'use strict';

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

    fetch(url, {
      method: 'POST',
      // text/plain sengaja dipakai (bukan application/json) supaya request tetap
      // dianggap "simple request" oleh browser dan TIDAK memicu CORS preflight
      // (OPTIONS) yang tidak didukung oleh endpoint Apps Script.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ fn: fnName, args: args })
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status + ' dari server.');
        return res.json();
      })
      .then(function (data) {
        if (data && data.ok) {
          if (onSuccess) onSuccess(data.result);
        } else {
          var msg = (data && data.error) ? data.error : 'Terjadi kesalahan pada server.';
          if (onFailure) onFailure(new Error(msg));
          else console.error('[api-bridge] ' + fnName + ' gagal:', msg);
        }
      })
      .catch(function (err) {
        if (onFailure) onFailure(err);
        else console.error('[api-bridge] ' + fnName + ' error jaringan:', err);
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
          // Tidak relevan di luar Apps Script HtmlService; diterima saja supaya chain tidak error.
          return function () { return makeRunner(successHandler, failureHandler); };
        }
        if (typeof prop !== 'string') return undefined;
        // Setiap property lain dianggap nama fungsi server yang mau dipanggil.
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

  // google.script.host dipakai di beberapa tempat untuk hal-hal yang hanya berlaku
  // di dalam iframe sandbox Apps Script (mis. menutup dialog) — di web biasa ini
  // no-op supaya tidak error kalau ada pemanggilan sisa.
  global.google.script.host = {
    close: function () {},
    setHeight: function () {},
    setWidth: function () {},
    origin: (global.location && global.location.origin) || ''
  };
})(window);
