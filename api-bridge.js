/*************************************************************
 * api-bridge.js  (v2 — Supabase backend, bukan lagi fetch ke GAS /exec)
 * -------------------------------------------------------------
 * TUJUAN: JavaScript.html TIDAK PERLU DIUBAH SAMA SEKALI. Semua
 * pemanggilan google.script.run.namaFungsi(...) yang sudah ada
 * tetap jalan apa adanya — bridge ini yang menerjemahkan tiap
 * panggilan ke query Supabase (PostgREST) atau ke Supabase Edge
 * Function untuk logic kompleks (approve PO, hitung komisi, dsb).
 *
 * KENAPA INI LEBIH CEPAT DARI VERSI LAMA:
 * Versi lama (v1) menembak SEMUA panggilan ke SATU endpoint GAS
 * /exec yang cold-start tiap request & tidak sanggup banyak
 * request paralel — makanya perlu antrian rumit (MAX_CONCURRENT_HI/LO,
 * retry, dedup) hanya untuk menahan beban itu.
 * Supabase (PostgREST + Postgres) didesain untuk request paralel
 * sungguhan dan TIDAK PUNYA cold-start, jadi seluruh mesin antrian
 * itu sudah tidak diperlukan — bridge ini jauh lebih sederhana &
 * responsnya konsisten cepat, bahkan saat banyak request bersamaan
 * (mis. preloadAllPages_ saat login).
 *
 * SETUP:
 * 1. Include <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *    SEBELUM file ini, di index.html.
 * 2. Isi SUPABASE_URL & SUPABASE_ANON_KEY di bawah.
 * 3. Fungsi backend yang TIDAK tercakup di TABLE_MAP / EDGE_FUNCTIONS
 *    di bawah akan otomatis coba dipanggil sebagai Edge Function
 *    dengan nama yang sama (fallback aman, tidak perlu didaftar semua
 *    dulu sebelum go-live — tinggal tambah 1 baris tiap kali nemu
 *    fungsi yang belum ke-cover).
 *************************************************************/
(function (global) {
  'use strict';

  var SUPABASE_URL = 'https://ozitvsmvofoteupjekad.supabase.co'; // GANTI
  var SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im96aXR2c212b2ZvdGV1cGpla2FkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk0NTQyODQsImV4cCI6MjEwNTAzMDI4NH0.RBk-8KgyjTSBgPUrW2jNKCZ35g-dhF7E-Li9NUHA1Hc';                 // GANTI — anon key AMAN ditaruh di frontend (RLS yang melindungi)

  if (!global.supabase) {
    console.error('[api-bridge] Library @supabase/supabase-js belum di-load. Tambahkan <script> CDN-nya SEBELUM api-bridge.js.');
  }
  var sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, storage: window.localStorage }
  });
  global.__supabaseClient__ = sb; // biar bisa dipakai langsung kalau perlu di JavaScript.html

  // =========================================================================
  // PEMETAAN sederhana: getXxx()/listXxx() generik -> baca tabel langsung
  // lewat PostgREST. Ini menggantikan fungsi get*/list* paling umum di
  // Code.gs lama. Tambahkan baris baru di sini kalau nemu fungsi get/list
  // lain yang belum tercakup — jauh lebih ringan daripada bikin Edge Function.
  // =========================================================================
  // =========================================================================
  // FIX UTAMA: mapping snake_case (Postgres) -> PascalCase (dipakai
  // JavaScript.html, warisan header Google Sheets: POID, AgentID, SJFileID,
  // MOUStatus, dst). SCHEMA di bawah ini disalin PERSIS dari SCHEMA di
  // Code.gs (satu-satunya sumber kebenaran nama kolom asli).
  // Setiap key dipetakan ke versi snake_case-nya secara otomatis (mis.
  // 'POID' -> 'po_id', 'SJFileURL' -> 'sj_file_url', 'NPWPFileID' ->
  // 'npwp_file_id'), lalu dipakai untuk translasi 2 arah:
  //   - hasil dari Postgres/Edge Function (snake_case) -> ke frontend (PascalCase)
  // =========================================================================
  var SCHEMA = {
    USERS: ['UserID', 'Name', 'Email', 'Role', 'AgentID', 'PasswordHash', 'Status', 'CreatedAt', 'UpdatedAt', 'SignatureFileID', 'SignatureFileURL'],
    AGENTS: [
      'AgentID', 'FullName', 'Email', 'Phone', 'KTPNumber', 'AddressKTP',
      'KTPFileID', 'KTPFileURL', 'NPWPFileID', 'NPWPFileURL', 'BankFileID', 'BankFileURL',
      'RegistrationStatus', 'RejectionNote', 'MOUStatus', 'MOUFileID', 'MOUFileURL', 'MOUDocID',
      'SignatureFileID', 'SignatureFileURL', 'AgentStatus', 'CreatedAt', 'UpdatedAt'
    ],
    PRODUCTS: ['ProductID', 'ProductName', 'Category', 'ImageURL', 'Packaging', 'ShelfLife', 'RegularPrice', 'Status', 'CreatedAt', 'UpdatedAt'],
    PRODUCT_IMAGES: ['ImageID', 'ProductID', 'FileID', 'FileURL', 'IsPrimary', 'CreatedAt'],
    PACKAGING: ['PackagingID', 'ProductID', 'PackagingName', 'QtyPerPack', 'CreatedAt'],
    SHELF_LIFE: ['ShelfLifeID', 'ProductID', 'ShelfLifeDays', 'CreatedAt'],
    PROMOS: ['PromoID', 'PromoCode', 'PromoName', 'Description', 'StartDate', 'EndDate', 'Status', 'CreatedAt', 'UpdatedAt'],
    STORES: ['StoreID', 'StoreName', 'Address', 'Phone', 'PIC', 'Status', 'CreatedAt'],
    PO: [
      'POID', 'AgentID', 'PromoID', 'RequestedDiscount', 'ApprovedDiscount', 'Status',
      'RejectionNote', 'StoreID', 'SupervisorID', 'SuratPenawaranFileID', 'SuratPenawaranFileURL',
      'GrandTotal', 'CreatedAt', 'UpdatedAt', 'Description', 'PickupDate',
      'SuratPenawaranEmailSentAt', 'PaymentConfirmedAt', 'PaymentConfirmedBy',
      'PaymentProofFileID', 'PaymentProofFileURL'
    ],
    PO_ITEMS: ['POItemID', 'POID', 'ProductID', 'Qty', 'UnitPrice', 'LineTotal', 'CreatedAt'],
    ORDERS: ['OrderID', 'POID', 'StoreID', 'SJFileID', 'SJFileURL', 'DeliveryStatus', 'CustomerPaymentStatus', 'TransactionStatus', 'CreatedAt', 'UpdatedAt', 'OrderDocFileID', 'OrderDocFileURL'],
    SUPPORTING_DOCUMENTS: ['DocID', 'OrderID', 'FileID', 'FileURL', 'DocType', 'VerifiedBy', 'VerificationStatus', 'CreatedAt'],
    COMMISSION_SCHEME: ['SchemeID', 'MinDiscountPct', 'MaxDiscountPct', 'CommissionPct', 'Label', 'Status'],
    COMMISSIONS: ['CommissionID', 'AgentID', 'OrderID', 'POID', 'ApprovedDiscount', 'CommissionPct', 'NetInvoiceValue', 'CommissionAmount', 'Status', 'VerifiedBy', 'RejectionNote', 'PaidAt', 'PaymentProofFileID', 'PaymentProofFileURL', 'PaymentRefNote', 'CreatedAt', 'UpdatedAt'],
    SETTINGS: ['Key', 'Value', 'UpdatedAt'],
    AUDIT_LOG: ['LogID', 'UserID', 'Role', 'Action', 'Entity', 'EntityID', 'Detail', 'Timestamp'],
    DOCUMENT_SEQUENCE: ['Prefix', 'YearMonth', 'LastNumber'],
    NOTIF_SEEN: ['UserID', 'NotifID', 'SeenAt'],
    DASHBOARD_CONFIG: [
      'ConfigID', 'ItemType', 'Title', 'Subtitle', 'ImageURL', 'ImageFileID',
      'ProductID', 'LinkAction', 'SortOrder', 'IsActive', 'CreatedAt', 'UpdatedAt'
    ],
    CHAT_ROOMS: [
      'RoomID', 'AgentID', 'AgentName', 'LastMessage', 'LastMessageAt', 'LastSenderRole',
      'UnreadForStaff', 'UnreadForAgent', 'Status', 'ClosedBy', 'ClosedAt', 'CreatedAt', 'UpdatedAt'
    ],
    CHAT_MESSAGES: [
      'MessageID', 'RoomID', 'SenderUserID', 'SenderName', 'SenderRole',
      'MessageText', 'MessageType', 'CreatedAt',
      'AttachmentFileID', 'AttachmentURL', 'AttachmentType', 'AttachmentName'
    ],
    CART: ['AgentID', 'CartJSON', 'UpdatedAt']
  };

  // snake_case -> PascalCase, dibangun otomatis dari SCHEMA di atas supaya
  // TIDAK PERNAH ketinggalan/typo dibanding Code.gs. Akronim (ID, SJ, MOU,
  // KTP, NPWP, PIC, dst) otomatis kebaca benar karena kita derive
  // snake_case-nya DARI PascalCase asli, bukan menebak arah sebaliknya.
  var SNAKE_TO_PASCAL_ = {};
  function toSnakeCase_(pascalKey) {
    var s = pascalKey;
    // 1) batas antar blok akronim & kata Kapital berikutnya: "POItem" -> "PO_Item", "SJFile" -> "SJ_File"
    s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
    // 2) batas antara huruf kecil/angka & huruf besar: "grandTotal","FullName" -> "Full_Name"
    s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    // 3) kasus khusus: akronim murni + ID/URL di ujung string yg TIDAK kena aturan di atas
    //    krn tidak ada huruf kecil sama sekali, mis. "POID" (bukan "POId") -> "PO_ID"
    s = s.replace(/^([A-Z]{2,})(ID|URL)$/, '$1_$2');
    return s.toLowerCase();
  }
  Object.keys(SCHEMA).forEach(function (sheetName) {
    SCHEMA[sheetName].forEach(function (pascalKey) {
      var snake = toSnakeCase_(pascalKey);
      SNAKE_TO_PASCAL_[snake] = pascalKey;
    });
  });
  // Beberapa nama umum tambahan yang dipakai payload gabungan (agentId,
  // agentName di respons custom Edge Function, dsb) — jaga-jaga di luar SCHEMA.
  var EXTRA_SNAKE_TO_PASCAL_ = {
    id: 'id', created_at: 'CreatedAt', updated_at: 'UpdatedAt'
  };
  Object.keys(EXTRA_SNAKE_TO_PASCAL_).forEach(function (k) {
    if (!SNAKE_TO_PASCAL_[k]) SNAKE_TO_PASCAL_[k] = EXTRA_SNAKE_TO_PASCAL_[k];
  });

  // Ubah SATU object flat dari snake_case -> PascalCase. Key yang tidak
  // dikenal (tidak ada di SCHEMA manapun) dibiarkan apa adanya (fallback
  // aman) supaya field baru yang belum didaftar tidak hilang diam-diam.
  function mapRowKeys_(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    var out = {};
    Object.keys(row).forEach(function (k) {
      var mapped = SNAKE_TO_PASCAL_[k] || k;
      out[mapped] = row[k];
    });
    return out;
  }

  // Terapkan mapRowKeys_ SECARA REKURSIF ke: array of rows, single row, atau
  // object bersarang seperti { pos: [...], agents: [...] } yang dikembalikan
  // getPOsPageData/getOrdersPageData/getDashboardData. String/number/boolean/
  // null dibiarkan lewat apa adanya.
  function deepMapKeys_(value) {
    if (Array.isArray(value)) {
      return value.map(deepMapKeys_);
    }
    if (value && typeof value === 'object') {
      var mapped = mapRowKeys_(value);
      var out = {};
      Object.keys(mapped).forEach(function (k) {
        out[k] = deepMapKeys_(mapped[k]);
      });
      return out;
    }
    return value;
  }

  var READ_MAP = {
    // fnName lama (GAS)     : { table: 'nama_tabel_postgres', order: 'kolom', ascending: bool }
    listProducts:            { table: 'products', order: 'product_name', ascending: true },
    listActiveProducts:      { table: 'products', order: 'product_name', ascending: true, filter: { status: 'ACTIVE' } },
    listPromos:              { table: 'promos', order: 'created_at', ascending: false },
    listActivePromos:        { table: 'promos', order: 'created_at', ascending: false, filter: { status: 'ACTIVE' } },
    listStores:              { table: 'stores', order: 'store_name', ascending: true },
    listAgents:              { table: 'agents', order: 'created_at', ascending: false },
    listUsers:                { table: 'users', order: 'created_at', ascending: false },
    getCommissionScheme:     { table: 'commission_scheme', order: 'min_discount_pct', ascending: true },
    listDashboardConfig:     { table: 'dashboard_config', order: 'sort_order', ascending: true, filter: { is_active: true } }
    // ^ Tambah baris baru sesuai kebutuhan saat migrasi tiap halaman.
  };

  // Fungsi backend yang LOGIC-nya kompleks (bukan sekadar baca 1 tabel) —
  // ini dipanggil sebagai Supabase Edge Function dengan nama yang sama
  // (lihat folder edge-functions/). SUDAH DIBUAT: changePassword, createPO,
  // resubmitPO, approvePO (juga menangani decision REJECTED, sama seperti
  // Code.gs lama — 1 fungsi utk approve & reject), getDashboardData.
  // Fungsi lain yang tidak ada di READ_MAP maupun daftar ini otomatis
  // DIANGGAP Edge Function juga (lihat fallback di callServer()) — akan
  // gagal dgn 404 jelas kalau belum dibuat, bukan diam-diam salah baca tabel.
  var KNOWN_EDGE_FUNCTIONS = [
    'changePassword', 'getDashboardData',
    'createPO', 'resubmitPO', 'approvePO', // rejectPO TIDAK ada — approvePO(decision='REJECTED') dipakai
    'completeTransactionAndCalculateCommission',
    'approveCommission', 'rejectCommission', 'markCommissionPaid',
    'uploadMySignature', 'saveDashboardConfigItem',
    'getReportsData', 'getPOsPageData', 'getOrdersPageData'
  ];

  // login/logout DITANGANI LANGSUNG oleh Supabase Auth SDK di client (bukan
  // Edge Function) — supaya session auto-refresh & tersimpan otomatis oleh
  // library-nya sendiri (persisten walau app ditutup, tidak hilang tiap 6 jam
  // seperti CacheService di Code.gs lama).
  function callLogin_(args) {
    var email = String(args[0] || '').trim().toLowerCase();
    var password = String(args[1] || '');
    if (!email || !password) {
      return Promise.resolve({ success: false, message: 'Email dan password wajib diisi.' });
    }
    return sb.auth.signInWithPassword({ email: email, password: password }).then(function (res) {
      if (res.error || !res.data.session) {
        return { success: false, message: 'Email atau password salah.' };
      }
      var user = res.data.user;
      var meta = user.app_metadata || {};
      return {
        success: true,
        token: res.data.session.access_token,
        user: {
          userId: meta.user_id || user.id,
          name: (user.user_metadata && user.user_metadata.name) || '',
          email: user.email,
          role: meta.role || '',
          agentId: meta.agent_id || null
        }
      };
    });
  }

  function callLogout_() {
    return sb.auth.signOut().then(function () { return { success: true }; });
  }

  // -----------------------------------------------------------------------
  // Auth token cache — dipakai utk kirim Authorization header ke Edge Function
  // -----------------------------------------------------------------------
  function getAccessToken_() {
    return sb.auth.getSession().then(function (r) {
      return r.data && r.data.session ? r.data.session.access_token : null;
    });
  }

  // -----------------------------------------------------------------------
  // Jalur 1: baca tabel langsung lewat PostgREST (READ_MAP)
  // -----------------------------------------------------------------------
  function callRead_(fnName, args) {
    var cfg = READ_MAP[fnName];
    var q = sb.from(cfg.table).select('*');
    if (cfg.filter) {
      Object.keys(cfg.filter).forEach(function (k) { q = q.eq(k, cfg.filter[k]); });
    }
    // Konvensi sederhana: 1 argumen string pertama dianggap filter tambahan
    // by agent_id kalau tabelnya punya kolom itu (dipakai listPO milik agent, dst).
    if (args && args.length && typeof args[0] === 'string' && cfg.table !== 'products' && cfg.table !== 'promos' && cfg.table !== 'stores') {
      // no-op placeholder: perluas sesuai kebutuhan per fungsi spesifik
    }
    if (cfg.order) q = q.order(cfg.order, { ascending: !!cfg.ascending });
    return q.then(function (res) {
      if (res.error) throw new Error(res.error.message);
      return deepMapKeys_(res.data); // snake_case (Postgres) -> PascalCase (frontend)
    });
  }

  // -----------------------------------------------------------------------
  // Jalur 2: panggil Supabase Edge Function (untuk logic kompleks)
  // -----------------------------------------------------------------------
  function callEdgeFunction_(fnName, args) {
    return getAccessToken_().then(function (token) {
      return sb.functions.invoke(fnName, {
        body: { args: args },
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      });
    }).then(function (res) {
      if (res.error) throw new Error(res.error.message || 'Edge function error');
      // Edge Function diharapkan mengembalikan { success, message, ...data }
      // supaya kompatibel dgn pola return lama di Code.gs.
      // deepMapKeys_ menerjemahkan SEMUA field bersarang (pos, agents, items,
      // dst) dari snake_case Postgres ke PascalCase yang dipakai JavaScript.html
      // — TAPI kita jaga 'success' dan 'message' tetap seperti aslinya karena
      // itu bukan nama kolom tabel, itu kontrak sukses/pesan generik.
      var mapped = deepMapKeys_(res.data);
      if (mapped && typeof mapped === 'object' && !Array.isArray(mapped)) {
        if ('success' in res.data) mapped.success = res.data.success;
        if ('message' in res.data) mapped.message = res.data.message;
      }
      return mapped;
    });
  }

  function callServer(fnName, args, successHandler, failureHandler) {
    var promise;
    if (fnName === 'login') {
      promise = callLogin_(args);
    } else if (fnName === 'logout') {
      promise = callLogout_();
    } else if (READ_MAP[fnName]) {
      promise = callRead_(fnName, args);
    } else {
      // Baik yang eksplisit di KNOWN_EDGE_FUNCTIONS maupun fungsi lain yang
      // tidak dikenal SAMA-SAMA dicoba sebagai Edge Function — ini aman
      // karena Edge Function yang belum ada akan gagal dengan pesan jelas
      // (404), bukan diam-diam salah baca tabel.
      promise = callEdgeFunction_(fnName, args);
    }

    promise.then(function (result) {
      if (successHandler) successHandler(result);
    }).catch(function (err) {
      console.error('[api-bridge] ' + fnName + ' gagal:', err);
      if (failureHandler) failureHandler(err);
      else console.warn('[api-bridge] Tidak ada failureHandler terpasang untuk ' + fnName + ', error di atas hanya di-log.');
    });
  }

  // Proxy chainable — interface IDENTIK dengan google.script.run asli,
  // supaya JavaScript.html tidak perlu diubah sama sekali.
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

  // Versi lama (v1) punya __apiBridgeResetQueue__ dipanggil saat logout untuk
  // membersihkan antrian request lama. Supabase tidak punya antrian seperti
  // itu (tidak diperlukan lagi), tapi kita tetap sediakan fungsi no-op supaya
  // pemanggilnya di JavaScript.html tidak error kalau belum sempat dihapus.
  global.__apiBridgeResetQueue__ = function () { /* no-op: tidak ada antrian lagi di v2 */ };

  // Realtime helper (BARU, tidak ada di v1) — opsional dipakai JavaScript.html
  // utk update live tanpa polling manual, mis. chat & notifikasi.
  // Contoh pakai: window.__supabaseSubscribe__('chat_messages', 'room_id=eq.' + roomId, function(payload){...})
  global.__supabaseSubscribe__ = function (table, filter, onChange) {
    var channel = sb.channel(table + '_' + Math.random().toString(36).slice(2))
      .on('postgres_changes', { event: '*', schema: 'public', table: table, filter: filter }, onChange)
      .subscribe();
    return function unsubscribe() { sb.removeChannel(channel); };
  };
})(window);
