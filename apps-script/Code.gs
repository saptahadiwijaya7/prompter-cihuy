/**
 * PROMPTER CIHUY — Apps Script Bridge v0.5.0
 * ------------------------------------------------
 * 1. Membaca isi Google Docs untuk prompter (polling ~2,5 detik).
 * 2. Relay remote control: HP (remote) <-> tablet (prompter)
 *    lewat CacheService, tanpa server tambahan.
 * 3. Relay naskah tablet -> remote (POST text_push / GET text_pull)
 *    agar remote menampilkan naskah yang sama persis.
 * 4. Relay naskah manual remote -> tablet (POST mtext_push / GET mtext_pull)
 *    untuk fitur kelola sumber naskah dari remote.
 *
 * Token TIDAK ditulis di file ini — tersimpan di Script Properties
 * (PROMPTER_TOKEN), aman saat Code.gs di-paste ulang.
 *
 * UPDATE DARI VERSI SEBELUMNYA: paste file ini →
 * Deploy → Manage deployments → Edit → New version.
 * Token & URL tidak berubah.
 */

var CACHE_TTL_SEC = 180; // perintah/status kedaluwarsa 3 menit
var TEXT_TTL_SEC = 21600; // naskah relay bertahan 6 jam (maks CacheService)

function setupToken() {
  var props = PropertiesService.getScriptProperties();
  var existing = props.getProperty('PROMPTER_TOKEN');
  if (existing) {
    Logger.log('Token sudah ada: ' + existing);
    return existing;
  }
  var token = Utilities.getUuid().replace(/-/g, '');
  props.setProperty('PROMPTER_TOKEN', token);
  Logger.log('Token baru dibuat: ' + token);
  return token;
}

function getToken_() {
  return PropertiesService.getScriptProperties().getProperty('PROMPTER_TOKEN') || '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function roomKey_(room, kind) {
  return 'room:' + room + ':' + kind;
}

function isValidRoom_(room) {
  return /^[0-9]{4}$/.test(room || '');
}

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};

    // ── Auth ──
    var token = getToken_();
    if (!token) {
      return json_({
        ok: false,
        error: 'Token belum di-setup. Jalankan setupToken() sekali di editor.',
      });
    }
    if (params.token !== token) {
      return json_({ ok: false, error: 'unauthorized' });
    }

    // ── Health check ──
    if (params.ping === '1') {
      return json_({ ok: true, pong: true, version: '0.5.0' });
    }

    var action = params.action || 'doc';
    var cache = CacheService.getScriptCache();

    // ── Remote relay ──
    if (action === 'text_pull' || action === 'mtext_pull') {
      var roomT = params.room;
      if (!isValidRoom_(roomT)) {
        return json_({ ok: false, error: 'Kode ruang tidak valid (4 digit).' });
      }
      var kind = action === 'text_pull' ? 'text' : 'mtext';
      var stored = cache.get(roomKey_(roomT, kind));
      return json_({ ok: true, text: stored || '' });
    }

    if (action === 'tsync' || action === 'rsync') {
      var room = params.room;
      if (!isValidRoom_(room)) {
        return json_({ ok: false, error: 'Kode ruang tidak valid (4 digit).' });
      }

      if (action === 'tsync') {
        // Tablet: simpan status, ambil perintah terbaru dari remote.
        if (params.status) {
          cache.put(roomKey_(room, 'status'), params.status, CACHE_TTL_SEC);
        }
        var cmd = cache.get(roomKey_(room, 'cmd'));
        return json_({ ok: true, cmd: cmd ? JSON.parse(cmd) : null });
      }

      // rsync — Remote: simpan perintah (jika ada), ambil status tablet.
      if (params.cmd) {
        cache.put(roomKey_(room, 'cmd'), params.cmd, CACHE_TTL_SEC);
      }
      var status = cache.get(roomKey_(room, 'status'));
      return json_({ ok: true, status: status ? JSON.parse(status) : null });
    }

    // ── Baca dokumen (default) ──
    var docId = (params.docId || '').trim();
    if (!docId) {
      return json_({ ok: false, error: 'Parameter docId kosong.' });
    }

    var doc;
    try {
      doc = DocumentApp.openById(docId);
    } catch (err) {
      return json_({
        ok: false,
        error:
          'Dokumen tidak bisa dibuka. Pastikan dokumen di-share ke akun pemilik script. (' +
          String(err) +
          ')',
      });
    }

    return json_({
      ok: true,
      text: doc.getBody().getText(),
      title: doc.getName(),
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}

/**
 * Menerima naskah dari tablet (body POST = teks mentah) dan menyimpannya
 * di cache per kode ruang, untuk ditampilkan di remote.
 * POST dipakai karena naskah bisa panjang (URL GET terbatas).
 */
function doPost(e) {
  try {
    var params = (e && e.parameter) || {};
    var token = getToken_();
    if (!token || params.token !== token) {
      return json_({ ok: false, error: 'unauthorized' });
    }
    if (params.action === 'text_push' || params.action === 'mtext_push') {
      var room = params.room;
      if (!isValidRoom_(room)) {
        return json_({ ok: false, error: 'Kode ruang tidak valid (4 digit).' });
      }
      var kind = params.action === 'text_push' ? 'text' : 'mtext';
      var text = (e.postData && e.postData.contents) || '';
      CacheService.getScriptCache().put(roomKey_(room, kind), text, TEXT_TTL_SEC);
      return json_({ ok: true });
    }
    return json_({ ok: false, error: 'action tidak dikenal' });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  }
}
