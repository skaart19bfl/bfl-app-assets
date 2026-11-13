/* BFL QC App (เว็บ) — ตัวประมวลผลในเบราว์เซอร์
 * ใช้ตรรกะเดิมของ QC App (server.js = Code.gs ฉบับ Apps Script) รันใน Web Worker แล้วคุยกับ Supabase ตรง (เหมือนระบบวัตถุดิบ)
 * · บริการของ Apps Script ที่ตรรกะเรียกใช้ ถูกแทนด้วยตัวจำลองด้านล่าง (UrlFetch = XHR แบบรอผล ซึ่งใช้ได้ใน Worker)
 * · สิ่งที่ต้องใช้ Google (ออกเอกสาร .xlsx จากแบบฟอร์มใน Drive / ส่งข้อมูลลง Sheet) เรียก Apps Script endpoint (GAS_URL)
 */
var SB_URL = 'https://kdytxuufvigwjccebrki.supabase.co';
var SB_KEY = 'sb_publishable_IYCMIaN7tJleWINprA42CQ_dX10sXFF';
var GAS_URL = 'https://script.google.com/macros/s/AKfycbzTFCZ2HvBtOWIf6hHpz-CsMdcdbz-o8ABNn-XJBwQQhXuNobMFlSOecoYo8cHHDsenyg/exec';
var CUR = { token: '', user: null, offset: 0 };

/* ---------------- ตัวจำลองบริการ Apps Script ---------------- */
function xhr_(url, o) {
  var x = new XMLHttpRequest();
  x.open((o && o.method || 'GET').toUpperCase(), url, false);
  var h = (o && o.headers) || {};
  Object.keys(h).forEach(function (k) { x.setRequestHeader(k, h[k]); });
  if (o && o.contentType) x.setRequestHeader('Content-Type', o.contentType);
  try { x.send(o && o.payload !== undefined ? o.payload : null); }
  catch (e) { throw new Error('เชื่อมต่อไม่ได้ — ตรวจสอบอินเทอร์เน็ต'); }
  return { getResponseCode: function () { return x.status; }, getContentText: function () { return x.responseText; } };
}
var UrlFetchApp = {
  fetch: function (url, o) { return xhr_(url, o); },
  fetchAll: function (reqs) { return reqs.map(function (r) { return xhr_(r.url, r); }); }
};
var _mem = {};
var CacheService = { getScriptCache: function () { return {
  get: function (k) { var e = _mem[k]; return e && e.exp > Date.now() ? e.v : null; },
  put: function (k, v, ttl) { _mem[k] = { v: v, exp: Date.now() + (ttl || 600) * 1000 }; },
  remove: function (k) { delete _mem[k]; }
}; } };
var PropertiesService = { getScriptProperties: function () { return {
  getProperty: function (k) { return k === 'QC_SB_KEY' ? CUR.token : (k === 'COLOR_TAB' ? '-' : null); },
  setProperty: function () {}, deleteProperty: function () {}, getProperties: function () { return {}; }
}; } };
var LockService = { getScriptLock: function () { return { waitLock: function () {}, tryLock: function () { return true; }, releaseLock: function () {} }; } };
var Logger = { log: function (m) { try { console.log(m); } catch (e) {} } };
function noGoogle_() { throw new Error('ส่วนนี้ต้องใช้ Google (ไม่มีในเวอร์ชันเว็บ)'); }
var SpreadsheetApp = { openById: noGoogle_ }, DriveApp = { getFileById: noGoogle_, getFolderById: noGoogle_ };
var HtmlService = {}, ContentService = {}, ScriptApp = {};
/* วันเวลาแบบ Asia/Bangkok (UTC+7 ไม่มีเวลาออมแสง) */
function bkk_(d) { var x = new Date(d.getTime() + 7 * 3600000); return { y: x.getUTCFullYear(), M: x.getUTCMonth() + 1, d: x.getUTCDate(), H: x.getUTCHours(), m: x.getUTCMinutes(), s: x.getUTCSeconds() }; }
function pad_(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
var Utilities = {
  getUuid: function () { return (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }); },
  sleep: function () {},
  formatDate: function (d, tz, f) {
    var t = bkk_(d);
    return String(f).replace(/yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g, function (k) {
      switch (k) {
        case 'yyyy': return String(t.y); case 'yy': return pad_(t.y % 100, 2);
        case 'MM': return pad_(t.M, 2); case 'M': return String(t.M);
        case 'dd': return pad_(t.d, 2); case 'd': return String(t.d);
        case 'HH': return pad_(t.H, 2); case 'H': return String(t.H);
        case 'mm': return pad_(t.m, 2); case 'm': return String(t.m);
        case 'ss': return pad_(t.s, 2); default: return String(t.s);
      }
    });
  },
  computeDigest: noGoogle_, newBlob: noGoogle_, zip: noGoogle_, unzip: noGoogle_, base64Encode: noGoogle_, base64Decode: noGoogle_,
  DigestAlgorithm: {}, Charset: {}
};

importScripts('server.js?v=202611130948', 'web.js?v=202611130948');   // web.js ทับฟังก์ชันของ server.js ที่ต่างกัน

/* ---------------- รับคำสั่งจากหน้าเว็บ ---------------- */
self.onmessage = function (e) {
  var m = e.data || {};
  if (m.session) { CUR.token = m.session.token || ''; CUR.user = m.session.user || null; CUR.offset = m.session.offset || 0; }
  var out;
  try {
    if (!/^api_[A-Za-z]+$/.test(m.fn) || typeof self[m.fn] !== 'function') throw new Error('ไม่รู้จักคำสั่ง ' + m.fn);
    var t0 = Date.now(), r = self[m.fn].apply(null, m.args || []);
    out = { id: m.id, ok: true, r: r === undefined ? null : JSON.parse(JSON.stringify(r)), ms: Date.now() - t0 };
  } catch (err) {
    var msg = String(err && err.message || err);
    if (/AUTH:/.test(msg)) msg = 'SESSION: ' + msg.replace(/^.*AUTH:\s*/, '');
    out = { id: m.id, ok: false, e: msg.replace(/^Supabase \w+: (FORBIDDEN: )?/, '') };
  } finally { _tcache = {}; }
  self.postMessage(out);
};
