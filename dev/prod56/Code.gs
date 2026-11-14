/* BFL Production App — Grinding + Tool life (phase 1)
 * Same sheet as AppSheet (BFL Production-Dep): writes Grinding_* rows with the existing columns only,
 * then asks the main script (Bluefalo Production_Lot) to recalc through its webhook.
 * Own tabs: ProdApp_Users, Grinding_Part_Life (PUL-1 blade / liner). */
const CFG = {
  SHEET_ID: '1jDn7AWFrLgwDXzPr5Lju8BU_PYgtMs_Z7BamDldSr3Q',
  USERS: 'ProdApp_Users', USER_HEADERS: ['User_ID', 'Name', 'Role', 'PIN_Hash', 'Active', 'Updated_At', 'Updated_By'],
  ROLES: ['control', 'admin', 'viewer'],
  SEED_USERS: [['Admin', 'admin', '9999'], ['Control-1', 'control', '1111'], ['Control-2', 'control', '2222']], // temp PINs, must change at first login
  TOKEN_HOURS: 14, REMEMBER_DAYS: 30, // "จำเครื่องนี้" (user 25 Oct) · changing / resetting the PIN ends every session of that user
  SOURCE: 'ProdApp',
  HOOK_URL: 'https://script.google.com/macros/s/AKfycbwVXGDr7xCs5fSCrot8Dm1Ictg5glYOEdurMgnxbLBkT3BsGaFhh98bVOJNt1OteMhQEA/exec',
  T: { LOT: 'Production_Lot', PRODUCT: 'Product_Detail', RTYPE: 'RuntimeType', SETUP: 'Grinding_Setup', RUN: 'Grinding_Runtime',
       REC: 'Grinding_Records', TOOL: 'Grinding_Tool_Life', PART: 'Grinding_Part_Life', COAT: 'Coater_Records', MOIST: 'Moisture', NCP: 'NCP' },
  STATES: ['Batching', 'Extruder', 'Packing', 'Finished', 'Revise'],
  EXTRUDERS: ['EXT-1', 'EXT-2', 'EXT-1+2'],
  KIBBLES: ['Small', 'Medium', 'Large', 'Dog', 'KOI', 'Bird', 'Cat', 'MIX'],
  // same initial text AppSheet puts in a new Production_Lot row
  EXT_DETAIL: 'ดาย :           แถว          รู \nใช้งาน:          แถว          รู\nใช้งานแล้ว :       ตัน\n-------------------------------\nมีด:              ใบ \nใช้งานแล้ว :       ตัน\n-------------------------------\nVentury: ',
  SIEVE_DETAIL: 'ร่อนใหญ่ \nOS:      ตา/นิ้ว  US:     ตา/นิ้ว  \nร่อนเล็ก \nOS:      ตา/นิ้ว  US:     ตา/นิ้ว',
  BATCH_GRIND_WARN_KG: 1500,
  PART_HEADERS: ['PartLifeID', 'Machine', 'Part', 'Set_No', 'StartDateTime', 'EndDateTime', 'Status', 'Reason', 'Memo', 'Cancelled', 'CreatedBy', 'CreateTimestamp', 'UpdatedTimestamp', 'Opening_kg'],
  PART_SEED: [['PUL-1', 'Blade', 1, '2025-10-01T00:00:00+07:00'], ['PUL-1', 'Liner', 1, '2025-10-01T00:00:00+07:00']],
  MACHINES: ['ATOM-3', 'ATOM-1', 'ATOM-2', 'PUL-1'],
  BLADE_MACHINES: ['ATOM-1', 'ATOM-2', 'ATOM-3'],
  FLOWS: { 'ATOM-1+ATOM-2': ['ATOM-1', 'ATOM-2'], 'ATOM-1+ATOM-2+PUL-1': ['ATOM-1', 'ATOM-2', 'PUL-1'], 'PUL-1': ['PUL-1'], 'ATOM-1+PUL-1': ['ATOM-1', 'PUL-1'], 'ATOM-2+PUL-1': ['ATOM-2', 'PUL-1'] },
  // fixed split of a weighing record for routes that include PUL-1 (user rule 26 Oct 2026): ATOM + PUL-1 = 60 : 40, ATOM-1 + ATOM-2 + PUL-1 = 35 : 35 : 30
  SPLIT: { 'ATOM-1+PUL-1': { 'ATOM-1': 0.6, 'PUL-1': 0.4 }, 'ATOM-2+PUL-1': { 'ATOM-2': 0.6, 'PUL-1': 0.4 }, 'ATOM-1+ATOM-2+PUL-1': { 'ATOM-1': 0.35, 'ATOM-2': 0.35, 'PUL-1': 0.3 } },
  SCREENS: ['0.8mm', '1.0mm', '1.2mm', '1.6mm'],
  RUN: 'GD-เดินเครื่อง',
  FUTURE_MIN: 30, MAX_KG_HR: 15000, OPEN_RUN_MIN: 120, SPREAD_MAX_H: 8, STEP_MIN: 5,
  LOT_STATES: ['Batching', 'Extruder', 'Packing'],
  BLADE_SET_BAHT: 4600
};
const HOUR = 3600e3, MIN = 60e3;
let SS_ = null, SALT_ = null, TABLES_ = {};
// ---------- read cache (user 31 Oct "App โหลดนาน"): a sheet read costs ~0.5–3 s, so read-only calls take tabs from CacheService
// (gzip + base64 in ≤ 90 KB pieces). Calls that write never use it (fresh reads, so row numbers are always current) and every
// app write drops the tab's copy.
// อุ่นไว้ + ตรวจ stamp (user 10 Nov 2026, แทนแผน C — วัดแล้ว: Sheet 5–7 วิ · สำเนา Supabase 3.4 วิ · cache นี้ 1.5 วิ):
// แท็บใน LIVE.TABS เก็บได้ LIVE_TTL และใช้ได้เฉพาะเมื่อ stamp ที่เก็บไว้ = stamp ของ Sheet ตอนนี้ (จำนวนแถว + UpdatedTimestamp ล่าสุด
// ในแถวท้าย + เครื่องหมายว่าแอปนี้เพิ่งเขียน) · หน้าเว็บที่เปิดอยู่ (liveStamp ทุก 5 วิ) และการเปิด Hub (__warm) อ่านแท็บที่เปลี่ยน
// หรือเก่ากว่า REFRESH_AGE มาใส่ cache ให้ก่อน คนเปิดหน้าจึงไม่ต้องรออ่าน Sheet · แท็บอื่นใช้อายุอย่างเดียว (TTL)
const TC = { TTL: 300, LIVE_TTL: 900, REFRESH_AGE: 150e3, FRESH_LS: 20e3, POLL_MS: 2500, WARM_MS: 25000, CH: 90000, P: 'tc4_' };
let TCACHE_ = false, WROTE_ = false, TC_ST_ = null, TC_DIRTY_ = {};
function cacheOn_() { if (!WROTE_) TCACHE_ = true; }
function tcDel_(n) { try { CacheService.getScriptCache().remove(TC.P + n); } catch (e) { } }
function tcGet_(n) {
  try {
    const st = LIVE.TABS.indexOf(n) >= 0 ? tcStamps_(false)[n] : null;   // taken before any read, so a copy made now is safe
    const c = CacheService.getScriptCache(), head = c.get(TC.P + n); if (!head) return null;
    const hp = head.split('|');   // pieces | id | stamp | saved at
    if (st != null && hp[2] !== st) return null;   // the Sheet changed since → read it
    const k = Number(hp[0]), keys = []; for (let i = 0; i < k; i++) keys.push(TC.P + n + '_' + hp[1] + '_' + i);
    const got = c.getAll(keys); let b = '';
    for (let i = 0; i < k; i++) { if (got[keys[i]] == null) return null; b += got[keys[i]]; }
    const txt = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b), 'application/x-gzip')).getDataAsString('UTF-8');
    return JSON.parse(txt, function (key, v) { return v && typeof v === 'object' && v.$d != null && Object.keys(v).length === 1 ? new Date(v.$d) : v; });
  } catch (e) { console.warn('cache read ' + n + ': ' + e); return null; }
}
function tcPut_(n, v, stamp) {
  try {
    const live = LIVE.TABS.indexOf(n) >= 0;
    if (live && stamp == null) { if (!TC_ST_) return; stamp = TC_ST_[n]; }   // stamp taken before this read, or no copy
    const txt = JSON.stringify(v, function (key, x) { return this[key] instanceof Date ? { $d: this[key].getTime() } : x; });
    const b = Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(txt, 'application/json')).getBytes());
    if (b.length > TC.CH * 40) return; // > 3.6 MB: not worth it
    const id = Date.now().toString(36), o = {}; let k = 0;
    for (let i = 0; i < b.length; i += TC.CH) o[TC.P + n + '_' + id + '_' + (k++)] = b.slice(i, i + TC.CH);
    const c = CacheService.getScriptCache(), ttl = live ? TC.LIVE_TTL : TC.TTL;
    c.putAll(o, ttl + 30); c.put(TC.P + n, k + '|' + id + '|' + (live ? stamp : '') + '|' + Date.now(), ttl);
  } catch (e) { console.warn('cache write ' + n + ': ' + e); }
}
function wrote_(n) {
  PDREF_DIRTY_[n] = 1;   // v56
  WROTE_ = true; TCACHE_ = false; tcDel_(n); TC_DIRTY_[n] = 1;
  try { const c = CacheService.getScriptCache(), v = Date.now().toString(36); c.put('live_v', v, 21600); if (n === CFG.T.COAT) c.put('coat_v', v, 21600); } catch (e) { }
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('BFL Production · Grinding')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL); // BFL Hub shows this app inside its page (user 9 Nov 2026)
}
// ---------- BFL Hub single login (user 9 Nov 2026) ----------
// The Hub opens this app with ?hub=<one-time ticket>. Supabase (bfl-production · hub_redeem) accepts the ticket once and names the
// ProdApp_Users account this Hub user is mapped to; we then issue our normal token. PIN login here works exactly as before.
const HUB = { URL: 'https://kdytxuufvigwjccebrki.supabase.co/rest/v1/rpc/hub_redeem', KEY: 'sb_publishable_IYCMIaN7tJleWINprA42CQ_dX10sXFF', APP: 'prod' };
function hubRedeem_(ticket) {
  const t = String(ticket || ''); if (!/^[0-9a-f]{48}$/.test(t)) throw new Error('ลิงก์จาก Hub ไม่ถูกต้อง — เปิดจาก Hub ใหม่');
  const res = UrlFetchApp.fetch(HUB.URL, { method: 'post', contentType: 'application/json', headers: { apikey: HUB.KEY, Authorization: 'Bearer ' + HUB.KEY },
    payload: JSON.stringify({ p_ticket: t, p_app: HUB.APP }), muteHttpExceptions: true });
  const r = res.getResponseCode() === 200 ? JSON.parse(res.getContentText()) : null;
  if (!r || !r.ok) throw new Error('Hub ยืนยันตัวตนไม่ได้ — กลับไปที่ Hub แล้วเปิดใหม่');
  return r;
}
function hubLogin(ticket) {
  const r = hubRedeem_(ticket);
  const u = users_().find(function (x) { return x.id === String(r.account) && x.active; });
  if (!u) throw new Error('บัญชีที่ Hub ผูกไว้ไม่มีหรือปิดใช้งานในแอปนี้ — แจ้ง Admin');
  const exp = Math.min(Number(r.exp) || 0, Date.now() + CFG.REMEMBER_DAYS * 24 * HOUR);
  if (!(exp > Date.now())) throw new Error('เซสชัน Hub หมดอายุ — login ที่ Hub ใหม่');
  return { token: token_(u, exp), exp: exp, me: { id: u.id, name: u.Name, role: u.Role }, mustChange: mustChange_(u), hubUser: r.hub_user };
}

/* ---------- NCP → Supabase (user 9 Nov 2026) ----------
 * Every NCP row this app writes in the Sheet goes to Supabase (bfl-production · table ncp, same sheet row number) at the same moment,
 * so NCP System and the Raw material system see it at once. Supabase is what the apps read; the Sheet stays the copy AppSheet and the
 * reports use. A failed send never stops the user: the hourly Sheet → Supabase sync brings the row anyway.
 * The key is made here on the first send, kept in Script Properties (NCP_PUSH_KEY) and registered once in Supabase (stored hashed). */
const NCP_SB = { URL: 'https://kdytxuufvigwjccebrki.supabase.co/rest/v1/rpc/', KEY: HUB.KEY, SOURCE: 'prodapp' };
let NCP_TOUCHED_ = [];
let PDREF_DIRTY_ = {};   // v56: sheet tabs written in this call (→ Supabase copy for phones)
function sbRpc_(fn, body) {
  const res = UrlFetchApp.fetch(NCP_SB.URL + fn, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: NCP_SB.KEY, Authorization: 'Bearer ' + NCP_SB.KEY }, payload: JSON.stringify(body) });
  const txt = res.getContentText();
  if (res.getResponseCode() !== 200) throw new Error(txt.slice(0, 300));
  return JSON.parse(txt);
}
function ncpKey_() {
  const p = PropertiesService.getScriptProperties(); let k = p.getProperty('NCP_PUSH_KEY');
  if (k || p.getProperty('NCP_PUSH_OFF')) return k || '';
  k = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  try { sbRpc_('ncp_push_register', { p_source: NCP_SB.SOURCE, p_key: k }); p.setProperty('NCP_PUSH_KEY', k); return k; }
  catch (e) { if (/NCP_KEY_EXISTS/.test(e.message)) p.setProperty('NCP_PUSH_OFF', 'key already registered — ask the Supabase admin to reset ' + NCP_SB.SOURCE); console.warn('NCP key: ' + e.message); return ''; }
}
function ncpFlush_() {
  const rows = NCP_TOUCHED_.filter(function (r, i, a) { return r > 1 && a.indexOf(r) === i; }); NCP_TOUCHED_ = [];
  if (!rows.length) return 0;
  try {
    const key = ncpKey_(); if (!key) return 0;
    SpreadsheetApp.flush();
    const sh = ss_().getSheetByName(CFG.T.NCP), w = sh.getLastColumn(), h = sh.getRange(1, 1, 1, w).getValues()[0].map(String);
    const out = rows.map(function (r) {
      const v = sh.getRange(r, 1, 1, w).getValues()[0], o = { _row: r };
      h.forEach(function (k, i) { if (k) o[k] = v[i] instanceof Date ? v[i].toISOString() : v[i]; });
      return o;
    });
    return sbRpc_('ncp_push', { p_source: NCP_SB.SOURCE, p_key: key, p_rows: out }).rows;
  } catch (e) { console.warn('NCP → Supabase (prodapp): ' + e.message); return 0; }
}
// ---------- sheet helpers ----------
function ss_() { return SS_ || (SS_ = dbOn_() ? dbSs_(rawSs_()) : rawSs_()); }
function sheet_(n) { const sh = ss_().getSheetByName(n); if (!sh) throw new Error('ไม่พบแท็บ ' + n); return sh; }
function truthy_(v) { return v === true || /^(true|y|yes|1)$/i.test(String(v == null ? '' : v).trim()); }
function str_(v) { return v == null ? '' : String(v).trim(); }
function num_(v) { const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, '')); return isFinite(n) ? n : null; }
function date_(v) { if (v instanceof Date) return isNaN(v) ? null : v; const s = str_(v); if (!s) return null; const d = new Date(s); return isNaN(d) ? null : d; }
function toObjs_(h, values) { return values.map(function (v) { const o = {}; h.forEach(function (k, i) { o[k] = v[i]; }); return o; }); }
function table_(n) {
  if (TABLES_[n]) return TABLES_[n];
  let sh = null, v = TCACHE_ ? tcGet_(n) : null;
  if (!v) { sh = sheet_(n); v = sh.getDataRange().getValues(); tcPut_(n, v); }
  const h = v.shift().map(String), rows = toObjs_(h, v);
  rows.forEach(function (r, i) { r._row = i + 2; });
  return (TABLES_[n] = { get sh() { return sh || (sh = sheet_(n)); }, h: h, rows: rows });
}
function live_(n) { return table_(n).rows.filter(function (r) { return !truthy_(r.Cancelled) && str_(r[table_(n).h[0]]); }); }
function appendRows_(n, objs) {
  const t = table_(n), sh = t.sh, h = t.h;
  const out = objs.map(function (o) { return h.map(function (c) { return c in o ? o[c] : ''; }); }), at = sh.getLastRow() + 1;
  sh.getRange(at, 1, out.length, h.length).setValues(out);
  if (n === CFG.T.NCP) for (let i = 0; i < out.length; i++) NCP_TOUCHED_.push(at + i);   // → Supabase when the lock ends
  delete TABLES_[n]; wrote_(n);
}
function setCells_(n, row, obj) {
  const t = table_(n);
  Object.keys(obj).forEach(function (k) { const c = t.h.indexOf(k); if (c >= 0) t.sh.getRange(row, c + 1).setValue(obj[k]); });
  if (n === CFG.T.NCP) NCP_TOUCHED_.push(row);
  delete TABLES_[n]; wrote_(n);
}
function withLock_(fn) { TCACHE_ = false; WROTE_ = true; const l = dbLock_(); l.waitLock(20000); let dirty = null; try { const out = fn(); ncpFlush_(); pdRefDirty_(); return out; } finally { NCP_TOUCHED_ = []; PDREF_DIRTY_ = {}; dirty = Object.assign({}, TC_DIRTY_); tcMark_(); l.releaseLock(); if (dbOn_()) { TC_DIRTY_ = dirty; tcMark_(); } } }
function prop_(k, make) {
  const p = PropertiesService.getScriptProperties(); let v = p.getProperty(k);
  if (!v && make) { v = Utilities.getUuid() + Utilities.getUuid(); p.setProperty(k, v); }
  return v;
}
function id8_() { return 'abcdf'.charAt(Math.floor(Math.random() * 5)) + Utilities.getUuid().replace(/-/g, '').slice(1, 8); }
function fmt_(d, f) { return d ? Utilities.formatDate(d, 'Asia/Bangkok', f || 'dd/MM HH:mm') : ''; }
// ---------- auth ----------
function hash_(id, pin) {
  SALT_ = SALT_ || prop_('SALT', true);
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, SALT_ + '|' + id + '|' + pin, Utilities.Charset.UTF_8));
}
function tempPins_() { return CFG.SEED_USERS.map(function (s) { return s[2]; }).concat(['0000']); }
function pinOk_(u, pin) { return String(u.PIN_Hash).replace(/^!/, '') === hash_(u.id, String(pin)); }
function mustChange_(u) { return String(u.PIN_Hash).charAt(0) === '!' || tempPins_().some(function (p) { return pinOk_(u, p); }); }
function sign_(s) { return Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(s, prop_('SECRET', true))); }
function usersSheet_() {
  let sh = ss_().getSheetByName(CFG.USERS);
  if (!sh) { sh = ss_().insertSheet(CFG.USERS, ss_().getNumSheets()); sh.appendRow(CFG.USER_HEADERS); }
  return sh;
}
function users_() {
  let v = TCACHE_ ? tcGet_(CFG.USERS) : null;
  if (!v) { v = usersSheet_().getDataRange().getValues(); tcPut_(CFG.USERS, v); }
  const h = v.shift().map(String);
  return toObjs_(h, v).map(function (u, i) { u.row = i + 2; u.id = String(u.User_ID); u.active = truthy_(u.Active); return u; });
}
// view = everyone · work = control/admin · users = control/admin (control may add admin/viewer, user 25 Oct) · admin = admin
function roleOk_(have, need) {
  if (!need || need === 'view') return CFG.ROLES.indexOf(have) >= 0;
  if (need === 'work' || need === 'users') return have === 'control' || have === 'admin';
  return have === need;
}
// token = id|expiry|ver|sig · ver follows the PIN hash, so a PIN change / reset logs that user out everywhere
function ver_(u) { return sign_('v|' + String(u.PIN_Hash)).slice(0, 12); }
function token_(u, exp) { const s = u.id + '|' + exp + '|' + ver_(u); return s + '|' + sign_(s); }
function session_(token, need, pinChange) {
  const p = String(token || '').split('|');
  if (p.length !== 4 || p[3] !== sign_(p[0] + '|' + p[1] + '|' + p[2]) || Date.now() > Number(p[1])) throw new Error('AUTH');
  const u = users_().find(function (x) { return x.id === p[0] && x.active; });
  if (!u || p[2] !== ver_(u)) throw new Error('AUTH');
  u.exp = Number(p[1]);
  if (!roleOk_(u.Role, need)) throw new Error('สิทธิ์ไม่พอสำหรับรายการนี้');
  if (!pinChange && mustChange_(u)) throw new Error('PIN_CHANGE');
  return u;
}
function listLogin() { cacheOn_(); return users_().filter(function (u) { return u.active; }).map(function (u) { return { id: u.id, name: u.Name, role: u.Role }; }); }
function login(id, pin, remember) {
  const cache = CacheService.getScriptCache(), k = 'fail_' + id, fails = Number(cache.get(k) || 0);
  if (fails >= 5) throw new Error('ใส่ PIN ผิดหลายครั้ง รอ 5 นาทีแล้วลองใหม่');
  const u = users_().find(function (x) { return x.id === String(id) && x.active; });
  if (!u || !pinOk_(u, pin)) { cache.put(k, String(fails + 1), 300); throw new Error('PIN ไม่ถูกต้อง'); }
  cache.remove(k);
  const exp = Date.now() + (remember ? CFG.REMEMBER_DAYS * 24 * HOUR : CFG.TOKEN_HOURS * HOUR);
  return { token: token_(u, exp), exp: exp, me: { id: u.id, name: u.Name, role: u.Role }, mustChange: mustChange_(u) };
}
// returns a fresh token (same expiry): the old one stops working because the PIN hash changed
function changePin(token, pin) {
  const me = session_(token, null, true), p = String(pin || '');
  if (!/^\d{4}$/.test(p)) throw new Error('PIN ต้องเป็นตัวเลข 4 หลัก');
  if (tempPins_().indexOf(p) >= 0 || pinOk_(me, p)) throw new Error('ตั้งรหัสอื่น');
  return withLock_(function () {
    const h = hash_(me.id, p);
    usersSheet_().getRange(me.row, 4, 1, 4).setValues([[h, true, new Date(), me.Name]]); wrote_(CFG.USERS);
    me.PIN_Hash = h;
    return { token: token_(me, me.exp), exp: me.exp };
  });
}
// ---------- users (control / admin) ----------
function listUsers(token) {
  session_(token, 'users');
  return users_().map(function (u) { return { id: u.id, name: u.Name, role: u.Role, active: u.active }; });
}
// add: {name, role} → temp PIN 0000 · edit: {id, role?, active?, resetPin?}
function saveUser(token, x) {
  const me = session_(token, 'users');
  return withLock_(function () {
    const sh = usersSheet_(), all = users_();
    if (!x.id) {
      const name = str_(x.name); if (!name) throw new Error('ใส่ชื่อ');
      if (CFG.ROLES.indexOf(x.role) < 0) throw new Error('เลือกสิทธิ์');
      if (all.some(function (u) { return u.Name === name; })) throw new Error('มีชื่อนี้แล้ว');
      const id = 'U' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
      sh.appendRow([id, name, x.role, '!' + hash_(id, '0000'), true, new Date(), me.Name]); wrote_(CFG.USERS);
      return { id: id, tempPin: '0000' };
    }
    const u = all.find(function (v) { return v.id === x.id; }); if (!u) throw new Error('ไม่พบผู้ใช้');
    if (u.id === me.id && (x.active === false || (x.role && x.role !== u.Role))) throw new Error('แก้สิทธิ์ของตัวเองไม่ได้');
    if (x.role) { if (CFG.ROLES.indexOf(x.role) < 0) throw new Error('สิทธิ์ไม่ถูกต้อง'); sh.getRange(u.row, 3).setValue(x.role); }
    if (x.active != null) sh.getRange(u.row, 5).setValue(!!x.active);
    if (x.resetPin) sh.getRange(u.row, 4).setValue('!' + hash_(u.id, '0000'));
    sh.getRange(u.row, 6, 1, 2).setValues([[new Date(), me.Name]]); wrote_(CFG.USERS);
    return { id: u.id, tempPin: x.resetPin ? '0000' : '' };
  });
}

// ---------- reading the grinding world ----------
function products_() { const m = {}; live_(CFG.T.PRODUCT).forEach(function (r) { m[str_(r.ProductID)] = str_(r.ProductName); }); return m; }
function lots_() {
  const names = products_(), out = {};
  table_(CFG.T.LOT).rows.forEach(function (r) {
    const id = str_(r.ProductionID); if (!id || truthy_(r.Cancelled) || /TEST/i.test(str_(r.ProductID))) return;
    out[id] = { pid: id, lot: str_(r.Lot_Number), productID: str_(r.ProductID), name: names[str_(r.ProductID)] || str_(r.ProductID),
      state: str_(r.State), ext: str_(r.Extruder_Number), plan: num_(r.Qty_Plan), batch: num_(r.Total_Batch_kg) };
  });
  return out;
}
function processes_() {
  return live_(CFG.T.RTYPE).map(function (r) { return { p: str_(r.Process), type: str_(r.Type) }; }).filter(function (x) { return /^GD-/.test(x.p); });
}
// runtime events per machine, sorted, each with end = next event (or now)
function runtime_(now) {
  const by = {};
  CFG.MACHINES.forEach(function (m) { by[m] = []; });
  live_(CFG.T.RUN).forEach(function (r) {
    const m = str_(r.Grinding_Machine), t = date_(r.DateTime); if (!by[m] || !t) return;
    by[m].push({ id: str_(r.ID), t: t.getTime(), p: str_(r.Process), lot: str_(r.Lot_Number), pid: str_(r.ProductionID), setup: str_(r.SetupID), reason: str_(r.Reason) });
  });
  Object.keys(by).forEach(function (m) {
    const L = by[m].sort(function (a, b) { return a.t - b.t; });
    L.forEach(function (e, i) { e.end = i + 1 < L.length ? L[i + 1].t : now; e.run = e.p === CFG.RUN || e.p === CUT_; });
  });
  return by;
}
function setups_() {
  return live_(CFG.T.SETUP).map(function (r) {
    return { id: str_(r.SetupID), pid: str_(r.ProductionID), lot: str_(r.Lot_Number), productID: str_(r.ProductID), flow: str_(r.Grinding_Flow),
      machine: str_(r.Machine), s1: str_(r.Screen_Size_1), s2: str_(r.Screen_Size_2), blade: str_(r.Blade_No), angle: str_(r.Blade_Angle),
      rot: str_(r.Rotation_Direction), tool: str_(r.ToolLifeID), row: r._row };
  });
}
// cumulative scale readings → kg per reading (Δ; first of lot = reading; drop = reset if reading < |Δ| else 0)
function records_() {
  const by = {};
  live_(CFG.T.REC).forEach(function (r) {
    const t = date_(r.DateTimeRecords), w = num_(r.Output_Weight); if (!t || w == null) return;
    const pid = str_(r.ProductionID);
    (by[pid] = by[pid] || []).push({ id: str_(r.RecordID), pid: pid, lot: str_(r.Lot_Number), t: t.getTime(), w: w, point: str_(r.Grinding_Machine), memo: str_(r.Memo) });
  });
  const all = [];
  Object.keys(by).forEach(function (pid) {
    let prev = null;
    by[pid].sort(function (a, b) { return a.t - b.t; }).forEach(function (x) {
      if (!prev) x.kg = x.w; else { const d = x.w - prev.w; x.kg = d >= 0 ? d : (x.w < Math.abs(d) ? x.w : 0); }
      x.prevT = prev ? prev.t : null; x.prevW = prev ? prev.w : null;
      prev = x; all.push(x);
    });
  });
  return { by: by, all: all };
}
function lives_() {
  const tools = live_(CFG.T.TOOL).map(function (r) {
    const s = date_(r.StartDateTime), e = date_(r.EndDateTime);
    return { id: str_(r.ToolLifeID), machine: str_(r.Grinding_Machine) === 'PUL-01' ? 'PUL-1' : str_(r.Grinding_Machine), no: str_(r.Blade_No), angle: str_(r.Blade_Angle).toUpperCase(),
      rot: str_(r.Rotation_Direction), s: s ? s.getTime() : null, e: e ? e.getTime() : null, status: str_(r.Tool_Status), why: str_(r.Retire_Reason), row: r._row };
  }).filter(function (x) { return x.s && CFG.BLADE_MACHINES.indexOf(x.machine) >= 0; });
  /* Follow edits made in AppSheet (user 27 Oct): an angle ends where the next live angle of the machine starts (re-entered with an
   * earlier time, or the old one left open); when the next angle was cancelled and nothing replaced it, the old angle is open again. */
  const canc = table_(CFG.T.TOOL).rows.filter(function (r) { return truthy_(r.Cancelled); }).map(function (r) {
    const s = date_(r.StartDateTime); return { m: str_(r.Grinding_Machine), s: s ? s.getTime() : null }; });
  CFG.BLADE_MACHINES.forEach(function (m) {
    const L = tools.filter(function (t) { return t.machine === m; }).sort(function (a, b) { return a.s - b.s; });
    L.forEach(function (t, i) {
      const nx = L[i + 1];
      if (nx) { if (t.e == null || t.e > nx.s) { t.endSheet = t.e; t.e = nx.s; } }
      else if (t.e != null && canc.some(function (c) { return c.m === m && c.s != null && Math.abs(c.s - t.e) <= 10 * MIN; })) {
        t.endSheet = t.e; t.e = null; t.reopened = true; t.why = '';
      }
    });
  });
  const sh = ss_().getSheetByName(CFG.T.PART);
  const parts = !sh ? [] : live_(CFG.T.PART).map(function (r) {
    const s = date_(r.StartDateTime), e = date_(r.EndDateTime);
    return { id: str_(r.PartLifeID), machine: str_(r.Machine), part: str_(r.Part), no: str_(r.Set_No), s: s ? s.getTime() : null, e: e ? e.getTime() : null, status: str_(r.Status), why: str_(r.Reason), open: num_(r.Opening_kg) || 0, row: r._row };
  }).filter(function (x) { return x.s; });
  return { tools: tools, parts: parts };
}
function stateAt_(seg, t) { // binary search the event covering t
  let lo = 0, hi = seg.length - 1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (seg[m].t <= t) { if (t < seg[m].end) return seg[m]; lo = m + 1; } else hi = m - 1; }
  return null;
}
/* Who ground what: each reading's kg spread every STEP_MIN back to the previous reading (≤ SPREAD_MAX_H, else 60 min).
 * ATOM-3 gets everything (exact). Downstream: ATOM-1/2 that are "เดินเครื่อง" at that minute (none running → the ATOM the
 * weighing point names) split equally. Routes with PUL-1 use the fixed CFG.SPLIT (ATOM+PUL-1 60:40, ATOM-1+ATOM-2+PUL-1 35:35:30); PUL-1 alone gets 100 %. (≈) */
function allocate_(rec, run) {
  const alloc = { 'ATOM-3': [], 'ATOM-1': [], 'ATOM-2': [], 'PUL-1': [] }, STEP = CFG.STEP_MIN * MIN;
  rec.all.forEach(function (x) {
    if (!(x.kg > 0)) return;
    const start = x.prevT && x.t - x.prevT <= CFG.SPREAD_MAX_H * HOUR ? x.prevT : x.t - 60 * MIN;
    const n = Math.max(1, Math.round((x.t - start) / STEP)), per = x.kg / n, named = CFG.FLOWS[x.point] || [];
    for (let i = 0; i < n; i++) {
      const tm = start + STEP * i + STEP / 2;
      alloc['ATOM-3'].push([tm, x.lot, per]);
      const sp = CFG.SPLIT[x.point];
      if (sp) { Object.keys(sp).forEach(function (m) { alloc[m].push([tm, x.lot, per * sp[m]]); }); continue; }
      if (named.indexOf('PUL-1') >= 0) { alloc['PUL-1'].push([tm, x.lot, per]); continue; } // PUL-1 alone
      let atoms = ['ATOM-1', 'ATOM-2'].filter(function (m) { const e = stateAt_(run[m], tm); return e && e.run; });
      if (!atoms.length) atoms = named;
      atoms.forEach(function (m) { alloc[m].push([tm, x.lot, per / atoms.length]); });
    }
  });
  return alloc;
}
function sumWindow_(list, s, e) {
  let kg = 0; const lots = {};
  list.forEach(function (a) { if (a[0] >= s && a[0] < e) { kg += a[2]; lots[a[1]] = (lots[a[1]] || 0) + a[2]; } });
  return { kg: kg, lots: Object.keys(lots).map(function (k) { return [k, Math.round(lots[k])]; }).filter(function (x) { return x[1] >= 50; }).sort(function (a, b) { return b[1] - a[1]; }) };
}
function runMin_(seg, s, e) {
  let m = 0; (seg || []).forEach(function (x) { if (x.run) { const o = Math.min(x.end, e) - Math.max(x.t, s); if (o > 0) m += o; } });
  return m / MIN;
}
function world_() {
  const now = Date.now();
  const run = runtime_(now), rec = records_(), L = lives_();
  return { now: now, run: run, rec: rec, tools: L.tools, parts: L.parts, alloc: allocate_(rec, run) };
}

// ---------- screens ----------
function getState(token, fresh) {
  if (!fresh) cacheOn_();
  const me = session_(token);
  // หน้าแรกเหมือนกันทุกคน (ต่างแค่ชื่อผู้ใช้) → เก็บผลไว้ GS_TTL วิ ใช้ร่วมกันตราบที่ข้อมูลทุกแท็บยังเหมือนเดิม (user 10 Nov 2026)
  const gk = fresh ? null : gsKey_();
  if (gk) try { const hit = CacheService.getScriptCache().get(gk); if (hit) { const o = JSON.parse(hit); o.me = { id: me.id, name: me.Name, role: me.Role }; o.serverNow = Date.now(); return o; } } catch (e) { }
  const W = world_(), lots = lots_(), setups = setups_(), now = W.now, fine = fineRows_();
  const machines = CFG.MACHINES.map(function (m) {
    const ev = W.run[m], last = ev.length ? ev[ev.length - 1] : null;
    const o = { m: m, state: last ? last.p : '', since: last ? last.t : null, lot: last ? last.lot : '', pid: last ? last.pid : '' };
    if (CFG.BLADE_MACHINES.indexOf(m) >= 0) {
      const act = W.tools.filter(function (t) { return t.machine === m && !t.e; }).sort(function (a, b) { return b.s - a.s; })[0];
      if (act) {
        const setRows = W.tools.filter(function (t) { return t.machine === m && t.no === act.no; });
        const setKg = setRows.reduce(function (a, t) { return a + sumWindow_(W.alloc[m], t.s, t.e || now).kg; }, 0);
        o.blade = { id: act.id, no: act.no, angle: act.angle, since: act.s, angleKg: Math.round(sumWindow_(W.alloc[m], act.s, now).kg), setKg: Math.round(setKg), median: median_(setTons_(W, m)) };
      }
    } else {
      o.parts = W.parts.filter(function (p) { return p.machine === m && !p.e; }).map(function (p) {
        return { id: p.id, part: p.part, no: p.no, since: p.s, open: Math.round(p.open), kg: Math.round(sumWindow_(W.alloc[m], p.s, now).kg + p.open) };
      });
    }
    const fl = fine.filter(function (f) { return f.m === m; });
    if (fl.length) { const lastT = fl[fl.length - 1].t, same = fl.filter(function (f) { return f.t >= lastT - 30 * MIN; });
      o.fine = { t: lastT, lot: fl[fl.length - 1].lot, result: same[same.length - 1].result, moist: (same.filter(function (f) { return f.moist != null; }).pop() || {}).moist,
        pcts: FINE.SIEVES.map(function (sv) { const v = same.filter(function (f) { return f.sieve === sv && f.pct != null; }).pop(); return v ? [sv, v.pct] : null; }).filter(Boolean) }; }
    // open run: เดินเครื่อง > OPEN_RUN_MIN with no scale reading of that lot in the last OPEN_RUN_MIN
    if (last && last.run && now - last.t > CFG.OPEN_RUN_MIN * MIN) {
      const rs = (W.rec.by[last.pid] || []).filter(function (x) { return x.t >= now - CFG.OPEN_RUN_MIN * MIN; });
      if (!rs.length) o.warn = 'เดินเครื่องค้าง ' + Math.round((now - last.t) / HOUR) + ' ชม. ไม่มียอดชั่งของ lot ใน ' + CFG.OPEN_RUN_MIN / 60 + ' ชม.';
    }
    return o;
  });
  const recent = now - 72 * HOUR;
  const lotList = Object.keys(lots).map(function (k) { return lots[k]; }).filter(function (l) {
    if (['Batching', 'Extruder'].indexOf(l.state) >= 0) return true;
    return (W.rec.by[l.pid] || []).some(function (x) { return x.t >= recent; });
  }).map(function (l) {
    const rs = W.rec.by[l.pid] || [], lastR = rs[rs.length - 1];
    const su = setups.filter(function (s) { return s.pid === l.pid; });
    const a3 = su.filter(function (s) { return s.machine === 'ATOM-3'; }).pop();
    const fs = fineOnce_(fine.filter(function (f) { return f.pid === l.pid; }));
    return Object.assign({}, l, { fineN: fs.length, fineLast: fs.length ? fs[fs.length - 1].t : null, ground: lastR ? lastR.w : 0, lastT: lastR ? lastR.t : null, records: rs.length,
      flow: a3 ? a3.flow : (su.length ? su[su.length - 1].flow : ''), setupMachines: unique_(su.map(function (s) { return s.machine; })) });
  }).sort(function (a, b) { return b.lot.localeCompare(a.lot); }).slice(0, 40);
  const out = { me: { id: me.id, name: me.Name, role: me.Role }, serverNow: now, machines: machines, lots: lotList,
    processes: processes_().map(function (x) { return x.p; }), screens: CFG.SCREENS, flows: Object.keys(CFG.FLOWS), bin: gbNow_(null, W.rec), bins: GB.BINS };
  if (gk) try { const s = JSON.stringify(out); if (s.length < 95000) CacheService.getScriptCache().put(gk, s, GS_TTL); } catch (e) { }
  return out;
}
// key of the shared home-screen result: every LIVE tab's stamp + the small tabs' cached copies + the app-write mark
const GS_TTL = 20;
function gsKey_() {
  try {
    const st = tcStamps_(false), c = CacheService.getScriptCache(), h = c.getAll(TC_WARM.map(function (t) { return TC.P + t; }));
    const s = LIVE.TABS.map(function (t) { return st[t]; }).join('.') + '|' + TC_WARM.map(function (t) { return (h[TC.P + t] || '').split('|')[1] || ''; }).join('.') + '|' + (c.get('live_v') || '');
    return 'gs1_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s, Utilities.Charset.UTF_8)).slice(0, 22);
  } catch (e) { return null; }
}

// ---------- destination bin after grinding (user 2 Nov 11:23: B64–B67, B115–B118, can change, show which bin is being filled) ----------
// one grinding line → one bin at a time. App-owned tab Grinding_Bin_Log: each row = "from Start_Time the line fills Bin".
// A scale reading belongs to the bin whose start is before the reading time, so changing bin together with a reading
// counts that reading to the old bin and starts the new bin from it. Nothing is added to Grinding_Records (AppSheet table).
const GB = { TAB: 'Grinding_Bin_Log', BINS: ['B64', 'B65', 'B66', 'B67', 'B115', 'B116', 'B117', 'B118', 'B138', 'B139', 'B140', 'B141'],
  HEAD: ['BinLogID', 'Start_Time', 'Bin', 'ProductionID', 'Lot_Number', 'RecordID', 'Memo', 'Cancelled', 'CreatedBy', 'CreateTimestamp'] };
function gbEvents_() {
  if (!ss_().getSheetByName(GB.TAB)) return [];
  return table_(GB.TAB).rows.filter(function (r) { return str_(r.BinLogID) && !truthy_(r.Cancelled); }).map(function (r) {
    const t = date_(r.Start_Time); return { id: str_(r.BinLogID), t: t ? t.getTime() : 0, bin: str_(r.Bin), pid: str_(r.ProductionID), lot: str_(r.Lot_Number).replace(/^'/, ''), memo: str_(r.Memo), by: str_(r.CreatedBy), row: r._row };
  }).filter(function (e) { return e.t; }).sort(function (a, b) { return a.t - b.t; });
}
function gbAt_(ev, t) { let b = null; for (let i = 0; i < ev.length && ev[i].t < t; i++) b = ev[i]; return b; }
// bin being filled now + kg put in it since it started (deltas of every lot's readings after the start)
function gbNow_(ev, recs) {
  ev = ev || gbEvents_(); const cur = ev.length ? ev[ev.length - 1] : null; if (!cur) return null;
  const all = (recs || records_()).all.filter(function (r) { return r.t > cur.t && r.t <= Date.now() + CFG.FUTURE_MIN * MIN; });
  const lots = {}; let kg = 0; all.forEach(function (r) { kg += r.kg; lots[r.lot] = (lots[r.lot] || 0) + r.kg; });
  return { id: cur.id, bin: cur.bin, since: cur.t, lot: cur.lot, kg: Math.round(kg), lots: Object.keys(lots).map(function (l) { return [l, Math.round(lots[l])]; }), memo: cur.memo };
}
// kg per bin of one lot (readings → bin at their time); '' = before any bin was set
function gbLot_(pid, ev, recs) {
  ev = ev || gbEvents_(); const rs = (recs || records_()).by[pid] || [], out = {};
  rs.forEach(function (r) { const b = gbAt_(ev, r.t), k = b ? b.bin : ''; out[k] = (out[k] || 0) + r.kg; });
  return Object.keys(out).map(function (k) { return { bin: k, kg: Math.round(out[k]) }; });
}
function gbAdd_(me, bin, t, lot, recId, memo) {
  ensureTab_(GB.TAB, GB.HEAD);
  appendRows_(GB.TAB, [{ BinLogID: id8_(), Start_Time: new Date(t), Bin: bin, ProductionID: lot ? lot.pid : '', Lot_Number: lot ? "'" + lot.lot : '', RecordID: recId || '', Memo: str_(memo).slice(0, 200), Cancelled: false, CreatedBy: by_(me), CreateTimestamp: new Date() }]);
}
// x = {bin, t, pid?, memo} — change the bin without a reading (from the board)
function binChange(token, x) {
  const me = session_(token, 'work'), bin = str_(x && x.bin).toUpperCase();
  if (GB.BINS.indexOf(bin) < 0) throw new Error('เลือกถังปลายทาง');
  const t = checkTime_(new Date(Number(x.t))).getTime(), lot = x.pid ? lots_()[str_(x.pid)] : null;
  return withLock_(function () {
    const ev = gbEvents_(), last = ev[ev.length - 1];
    if (last && t <= last.t) throw new Error('เวลาต้องหลังการเปลี่ยนถังครั้งก่อน (' + fmt_(new Date(last.t)) + ')');
    if (last && last.bin === bin) throw new Error('ตอนนี้ลงถัง ' + bin + ' อยู่แล้ว');
    gbAdd_(me, bin, t, lot, '', x.memo);
    return { ok: true, bin: bin };
  });
}
// undo the latest change (wrong bin) — Cancelled TRUE, the bin before it is current again
function binCancel(token, id) {
  const me = session_(token, 'work');
  return withLock_(function () {
    const ev = gbEvents_(), last = ev[ev.length - 1];
    if (!last || last.id !== str_(id)) throw new Error('ยกเลิกได้เฉพาะการเปลี่ยนถังล่าสุด');
    setCells_(GB.TAB, last.row, { Cancelled: true, Memo: (last.memo ? last.memo + ' · ' : '') + 'ยกเลิกโดย ' + me.Name });
    return { ok: true };
  });
}
function binLog(token) {
  cacheOn_(); session_(token);
  const ev = gbEvents_(), recs = records_();
  return { now: gbNow_(ev, recs), bins: GB.BINS, log: ev.slice(-30).reverse().map(function (e, i, a) {
    const next = i ? a[i - 1].t : Date.now() + 1, kg = recs.all.filter(function (r) { return r.t > e.t && r.t <= next; }).reduce(function (s, r) { return s + r.kg; }, 0);
    return { id: e.id, t: e.t, bin: e.bin, lot: e.lot, memo: e.memo, by: e.by.replace(/^ProdApp:/, ''), kg: Math.round(kg) }; }) };
}
function unique_(a) { return a.filter(function (x, i) { return x && a.indexOf(x) === i; }); }
function median_(a) { if (!a.length) return null; const s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
// t per complete set (has a Broken angle), last 12
function setTons_(W, m) {
  const sets = {};
  W.tools.filter(function (t) { return t.machine === m; }).forEach(function (t) { (sets[t.no] = sets[t.no] || []).push(t); });
  return Object.keys(sets).filter(function (k) { return sets[k].some(function (t) { return /broken/i.test(t.why); }) && sets[k].length >= 4; })
    .sort(function (a, b) { return Number(a) - Number(b); }).slice(-12)
    .map(function (k) { return sets[k].reduce(function (a, t) { return a + sumWindow_(W.alloc[m], t.s, t.e || W.now).kg; }, 0) / 1000; });
}

// lot detail for the setup / record panels
function lotGrinding(token, pid) {
  cacheOn_();
  session_(token);
  const lot = lots_()[pid]; if (!lot) throw new Error('ไม่พบ Lot');
  const su = setups_().filter(function (s) { return s.pid === pid; });
  const recsAll = records_(), rs = recsAll.by[pid] || [], gbEv = gbEvents_();
  const latest = {}; su.forEach(function (s) { latest[s.machine] = s; });
  const flow = flowAt_(pid, Date.now()) || (latest['ATOM-3'] ? latest['ATOM-3'].flow : (su.length ? su[su.length - 1].flow : ''));
  return { lot: lot, flow: flow, point: pointOf_(flow), setups: latest, flows: Object.keys(CFG.FLOWS), screens: CFG.SCREENS,
    started: runtime_(Date.now())['ATOM-3'].some(function (e) { return e.pid === pid; }),
    bin: gbNow_(gbEv, recsAll), bins: GB.BINS, binKg: gbLot_(pid, gbEv, recsAll),
    records: rs.slice(-12).map(function (x) { const b = gbAt_(gbEv, x.t); return { id: x.id, t: x.t, w: x.w, kg: Math.round(x.kg), point: x.point, bin: b ? b.bin : '' }; }) };
}
function pointOf_(flow) { const p = str_(flow).split('>>')[1]; return p ? p.trim() : ''; }

// tool life page
function toolLife(token, m) {
  cacheOn_();
  session_(token);
  const W = world_(), now = W.now;
  if (m === 'PUL-1') {
    const parts = W.parts.filter(function (p) { return p.machine === m; }).sort(function (a, b) { return a.s - b.s; }).map(function (p) {
      const s = sumWindow_(W.alloc[m], p.s, p.e || now);
      return { id: p.id, part: p.part, no: p.no, s: p.s, e: p.e, status: p.status, why: p.why, open: Math.round(p.open), kg: Math.round(s.kg + p.open), lots: s.lots.slice(0, 8) };
    });
    const months = {};
    W.alloc[m].forEach(function (a) { const k = fmt_(new Date(a[0]), 'yyyy-MM'); months[k] = (months[k] || 0) + a[2]; });
    const dataFrom = W.rec.all.length ? Math.min.apply(null, W.rec.all.map(function (x) { return x.t; })) : null;
    return { m: m, parts: parts, months: Object.keys(months).sort().map(function (k) { return [k, Math.round(months[k] / 1000)]; }), dataFrom: dataFrom };
  }
  if (CFG.BLADE_MACHINES.indexOf(m) < 0) throw new Error('ไม่รู้จักเครื่อง');
  const sets = {}, fine = m === 'ATOM-3' ? fineOnce_(fineRows_()) : fineRows_().filter(function (f) { return f.m === m; });
  W.tools.filter(function (t) { return t.machine === m; }).forEach(function (t) { (sets[t.no] = sets[t.no] || []).push(t); });
  const keys = Object.keys(sets).sort(function (a, b) { return Number(a) - Number(b); }).slice(-8);
  const out = keys.map(function (k) {
    return { no: k, angles: sets[k].sort(function (a, b) { return a.s - b.s; }).map(function (t) {
      const e = t.e || now, s = sumWindow_(W.alloc[m], t.s, e);
      return { id: t.id, a: t.angle, s: t.s, e: t.e, h: Math.round((e - t.s) / HOUR * 10) / 10, r: Math.round(runMin_(W.run[m], t.s, e) / 6) / 10,
        kg: Math.round(s.kg), why: t.why, lots: s.lots.slice(0, 6), fine: fineStat_(fine.filter(function (f) { return f.t >= t.s && f.t < e; })) };
    }) };
  });
  const allSets = {};
  W.tools.filter(function (t) { return t.machine === m; }).forEach(function (t) { (allSets[t.no] = allSets[t.no] || []).push(t); });
  const tps = Object.keys(allSets).filter(function (k) { return allSets[k].some(function (t) { return /broken/i.test(t.why); }) && allSets[k].length >= 4; })
    .sort(function (a, b) { return Number(a) - Number(b); }).slice(-12)
    .map(function (k) { return [k, Math.round(allSets[k].reduce(function (a, t) { return a + sumWindow_(W.alloc[m], t.s, t.e || now).kg; }, 0) / 100) / 10]; });
  return { m: m, sets: out, tps: tps, median: median_(tps.map(function (x) { return x[1]; })), approx: m !== 'ATOM-3', baht: CFG.BLADE_SET_BAHT };
}

// 24 h timeline from 08:00 of the production day (yyyy-MM-dd)
function runtimeDay(token, day) {
  cacheOn_();
  session_(token);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? day : prodDay_(Date.now());
  const S = new Date(d + 'T08:00:00+07:00').getTime(), E = S + 24 * HOUR, W = world_(), LT = lots_();
  const rows = CFG.MACHINES.map(function (m) {
    const segs = W.run[m].filter(function (x) { return x.end > S && x.t < E; }).map(function (x) {
      const a = Math.max(x.t, S), b = Math.min(x.end, E); return { a: (a - S) / MIN, w: (b - a) / MIN, p: x.p, lot: x.lot, nm: (LT[x.pid] || {}).name || '', run: !!x.run };
    });
    // notes = the Reason typed with a status (user 28 Oct: show them at their time, like the shift sheet)
    const notes = W.run[m].filter(function (x) { return x.reason && x.t >= S && x.t < E; }).map(function (x) { return { a: (x.t - S) / MIN, p: x.p, k: x.reason, lot: x.lot }; });
    const marks = (m === 'PUL-1' ? W.parts.filter(function (p) { return p.machine === m; }).map(function (p) { return { t: p.s, k: p.part + ' #' + p.no }; })
      : W.tools.filter(function (t) { return t.machine === m; }).map(function (t) { return { t: t.s, k: '#' + t.no + ' ' + t.angle }; }))
      .filter(function (k) { return k.t >= S && k.t < E; }).map(function (k) { return { a: (k.t - S) / MIN, k: k.k }; });
    return { m: m, segs: segs, marks: marks, notes: notes, runMin: Math.round(runMin_(W.run[m], S, E)) };
  });
  const hours = function (m) { const h = []; for (let i = 0; i < 24; i++) h.push(0); W.alloc[m].forEach(function (a) { if (a[0] >= S && a[0] < E) h[Math.floor((a[0] - S) / HOUR)] += a[2]; }); return h.map(Math.round); };
  const kgh = hours('ATOM-3'), byM = {}; ['ATOM-1', 'ATOM-2', 'PUL-1'].forEach(function (m) { byM[m] = hours(m); });
  // scale readings (Grinding_Records) of the day, with the change since the lot's previous reading
  // a reading closes the hour it ends: 16:00 → row 15:00–16:00, 16:05 → row 16:00–17:00 (so 08:00 belongs to the previous day)
  const recs = W.rec.all.filter(function (x) { return x.t > S && x.t <= E; }).sort(function (a, b) { return a.t - b.t; }).map(function (x) {
    const min = x.prevT ? Math.round((x.t - x.prevT) / MIN) : null;
    return { h: Math.max(0, Math.ceil((x.t - S) / HOUR) - 1), t: x.t, lot: x.lot, w: x.w, kg: Math.round(x.kg), min: min, first: !x.prevT, point: x.point,
      rate: min && min > 0 && min <= 180 ? Math.round(x.kg / min * 60) : null };
  });
  // Mix หลังบด per hour (by Datetime_Stamp; 16:00:00 closes the hour 15:00–16:00 like the scale readings)
  const mixh = []; for (let i = 0; i < 24; i++) mixh.push(0);
  const mixr = mxRecs_().filter(function (x) { return x.t > S && x.t <= E; });
  mixr.forEach(function (x) { mixh[Math.max(0, Math.ceil((x.t - S) / HOUR) - 1)] += x.kg; });
  return { day: d, rows: rows, kgh: kgh, byM: byM, recs: recs, mixh: mixh.map(function (v) { return Math.round(v * 10) / 10; }), mixN: mixr.length };
}
function prodDay_(t) { return fmt_(new Date(t - 8 * HOUR), 'yyyy-MM-dd'); }

// ---------- writes ----------
function checkTime_(t) {
  if (!(t instanceof Date) || isNaN(t)) throw new Error('เวลาไม่ถูกต้อง');
  if (t.getTime() > Date.now() + CFG.FUTURE_MIN * MIN) throw new Error('เวลาเกินตอนนี้ ' + CFG.FUTURE_MIN + ' นาที');
  if (t.getTime() < Date.now() - 7 * 24 * HOUR) throw new Error('ย้อนหลังเกิน 7 วัน — แก้ใน AppSheet');
  return t;
}
function by_(me) { return CFG.SOURCE + ':' + me.Name; }
function activeTool_(m) { return lives_().tools.filter(function (t) { return t.machine === m && !t.e; }).sort(function (a, b) { return b.s - a.s; })[0] || null; }

// x = {pid, flow (e.g. 'ATOM-1+ATOM-2'), machines: {m: {s1, s2, rot}}}
function setupRows_(lot, flowKey, machines, me, reason) {
  const down = CFG.FLOWS[flowKey]; if (!down) throw new Error('เลือกเส้นทางโม่');
  const flow = 'ATOM-3 >> ' + flowKey, ms = ['ATOM-3'].concat(down);
  const x = { machines: machines, reason: reason };
  return ms.map(function (m) {
      const c = (x.machines || {})[m] || {}, tool = CFG.BLADE_MACHINES.indexOf(m) >= 0 ? activeTool_(m) : null;
      const pul = m === 'PUL-1'; // PUL-1 has no screen / rotation setting
      if (!pul && CFG.SCREENS.indexOf(c.s1) < 0) throw new Error(m + ': เลือกตะแกรง');
      return { SetupID: id8_(), ProductionID: lot.pid, Lot_Number: lot.lot, ProductID: lot.productID, Grinding_Flow: flow, Machine: m,
        Screen_Size_1: pul ? '' : c.s1, Screen_Size_2: pul ? '' : (CFG.SCREENS.indexOf(c.s2) >= 0 ? c.s2 : c.s1),
        Blade_No: tool ? tool.no : '', Blade_Angle: tool ? tool.angle : '', Rotation_Direction: pul ? '' : (c.rot === 'Reverse' ? 'Reverse' : 'Forward'),
        Cancelled: false, Memo: str_(x.reason) ? 'เปลี่ยน route: ' + str_(x.reason) : str_(c.memo), CreatedBy: by_(me), Visible: true, Plan_Extruder: lot.ext, Actual_Extruder: lot.ext,
        Setup_Status: 'Planned', ToolLifeID: tool ? tool.id : '' }; // Change_Reason belongs to the extruder change (AppSheet shows it when Actual ≠ Plan extruder)
  });
}
function saveSetup(token, x) {
  const me = session_(token, 'work');
  const lot = lots_()[str_(x.pid)]; if (!lot) throw new Error('ไม่พบ Lot');
  const cur = flowAt_(lot.pid, Date.now()), started = runtime_(Date.now())['ATOM-3'].some(function (e) { return e.pid === lot.pid; });
  if (started && cur && pointOf_(cur) !== str_(x.flow)) throw new Error('Lot นี้ใช้ route ' + pointOf_(cur) + ' อยู่ — ใช้ "เปลี่ยน route" เพื่อบันทึกเวลาที่เปลี่ยน');
  return withLock_(function () {
    const rows = setupRows_(lot, x.flow, x.machines || {}, me, x.reason);
    appendRows_(CFG.T.SETUP, rows);
    return { ok: true, setups: rows.map(function (r) { return r.SetupID; }), at: Date.now() };
  });
}
// route of a lot at time t = setup linked to the latest ATOM-3 status of that lot at or before t (as AppSheet's Check_Machine);
// no such status yet → the lot's latest ATOM-3 setup
function flowAt_(pid, t) {
  const su = setups_().filter(function (s) { return s.pid === pid; }), byId = {};
  su.forEach(function (s) { byId[s.id] = s; });
  const ev = runtime_(Date.now())['ATOM-3'].filter(function (e) { return e.pid === pid && e.t <= t && byId[e.setup]; }).pop();
  if (ev) return byId[ev.setup].flow;
  const a3 = su.filter(function (s) { return s.machine === 'ATOM-3'; }).pop();
  return a3 ? a3.flow : (su.length ? su[su.length - 1].flow : '');
}
const CUT_ = 'GD-ตัดรอบเบอร์ ใช้มีดมุมเดิม'; // cut a grinding round without changing blade / angle (counts as running)
const ROUTE_ = { CHANGE: 'GD-เคลียร์สูตร+เปลี่ยน route โม่', STOP: 'GD-หยุดโม่' };
// x = { pid, flow: 'PUL-1', t, reason, machines: {m: {s1, s2, rot}}, stopOld, startNew }
// writes the new setup rows + status events at t (ATOM-3 = route change, machines leaving = หยุดโม่, machines joining = เดินเครื่อง)
function changeRoute(token, x) {
  const me = session_(token, 'work');
  const lot = lots_()[str_(x.pid)]; if (!lot) throw new Error('ไม่พบ Lot');
  const down = CFG.FLOWS[x.flow]; if (!down) throw new Error('เลือก route ใหม่');
  const t = checkTime_(new Date(Number(x.t)));
  const reason = str_(x.reason); if (reason.length < 2) throw new Error('ใส่เหตุผลที่เปลี่ยน route');
  const cur = flowAt_(lot.pid, t.getTime()); if (!cur) throw new Error('Lot นี้ยังไม่ได้ตั้งค่าโม่ — ใช้ "ตั้งค่าโม่"');
  if (pointOf_(cur) === x.flow) throw new Error('route เดิมอยู่แล้ว (' + x.flow + ')');
  const procs = processes_().map(function (p) { return p.p; });
  [ROUTE_.CHANGE, ROUTE_.STOP, CFG.RUN].forEach(function (p) { if (procs.indexOf(p) < 0) throw new Error('ไม่พบสถานะ ' + p + ' ใน RuntimeType'); });
  const oldDown = CFG.FLOWS[pointOf_(cur)] || [];
  const events = [['ATOM-3', ROUTE_.CHANGE]]
    .concat(x.stopOld === false ? [] : oldDown.filter(function (m) { return down.indexOf(m) < 0; }).map(function (m) { return [m, ROUTE_.STOP]; }))
    .concat(x.startNew === false ? [] : down.filter(function (m) { return oldDown.indexOf(m) < 0; }).map(function (m) { return [m, CFG.RUN]; }));
  const res = withLock_(function () {
    events.forEach(function (e) { runtimeCheck_(e[0], t); }); // all checks before any write
    const oldSu = {}; events.forEach(function (e) { const s = setups_().filter(function (v) { return v.pid === lot.pid && v.machine === e[0]; }).pop(); if (s) oldSu[e[0]] = s; });
    const rows = setupRows_(lot, x.flow, x.machines || {}, me, reason), newSu = {};
    rows.forEach(function (r) { newSu[r.Machine] = r; });
    appendRows_(CFG.T.SETUP, rows);
    const now = new Date(), flow = 'ATOM-3 >> ' + x.flow;
    const run = events.map(function (e) {
      const su = newSu[e[0]] ? { id: newSu[e[0]].SetupID } : oldSu[e[0]] || { id: '' };
      return { ID: id8_(), Grinding_Machine: e[0], Grinding_Flow: flow, Lot_Number: lot.lot, ProductionID: lot.pid, ProductID: lot.productID,
        DateTime: t, Process: e[1], Reason: 'เปลี่ยน route ' + pointOf_(cur) + ' → ' + x.flow + ': ' + reason, CreateTimestamp: now, UpdatedTimestamp: now,
        Cancelled: false, CreatedBy: by_(me), Visible: true, SetupID: su.id };
    });
    appendRows_(CFG.T.RUN, run);
    return { setups: rows.map(function (r) { return r.SetupID; }), run: run.map(function (r) { return { id: r.ID, m: r.Grinding_Machine, p: r.Process, setup: r.SetupID }; }) };
  });
  res.run.forEach(function (r) { hook_({ action: 'GRINDING_RUNTIME', rowID: r.id, productionID: lot.pid, setupID: r.setup, requestedBy: by_(me) }); });
  return { ok: true, from: pointOf_(cur), to: x.flow, events: res.run.map(function (r) { return [r.m, r.p]; }) };
}

function runtimeCheck_(m, t) {
  const ev = runtime_(Date.now())[m], last = ev[ev.length - 1];
  if (last && t.getTime() <= last.t) throw new Error(m + ': เวลาต้องหลังสถานะล่าสุด (' + fmt_(new Date(last.t)) + ')');
}
function runtimeSetup_(m, lot) {
  const su = setups_().filter(function (s) { return s.pid === lot.pid && s.machine === m; }).pop();
  if (!su) throw new Error(m + ' ยังไม่มีการตั้งค่าโม่ของ Lot ' + lot.lot + ' — ตั้งค่าก่อน');
  return su;
}
// x = {m, pid, process, reason, t (ms)}
function saveRuntime(token, x) {
  const me = session_(token, 'work');
  const m = str_(x.m); if (CFG.MACHINES.indexOf(m) < 0) throw new Error('เลือกเครื่อง');
  if (processes_().map(function (p) { return p.p; }).indexOf(x.process) < 0) throw new Error('เลือกสถานะ');
  const t = checkTime_(new Date(Number(x.t)));
  const lot = lots_()[str_(x.pid)]; if (!lot) throw new Error('เลือก Lot');
  let su = runtimeSetup_(m, lot);
  const res = withLock_(function () {
    runtimeCheck_(m, t);
    // re-saving a cancelled angle / blade status: the blade setup row (cancelled with it) is written again on this lot
    if (str_(x.tool) && CFG.BLADE_MACHINES.indexOf(m) >= 0) {
      const tool = lives_().tools.filter(function (v) { return v.id === str_(x.tool) && v.machine === m; })[0];
      if (tool && bladeSetup_(m, lot.pid, tool.id, 'ชุด #' + tool.no + ' มุม ' + tool.angle, t.getTime(), me)) su = runtimeSetup_(m, lot);
    }
    const id = id8_(), now = new Date();
    appendRows_(CFG.T.RUN, [{ ID: id, Grinding_Machine: m, Grinding_Flow: su.flow, Lot_Number: lot.lot, ProductionID: lot.pid, ProductID: lot.productID,
      DateTime: t, Process: x.process, Reason: str_(x.reason), CreateTimestamp: now, UpdatedTimestamp: now, Cancelled: false, CreatedBy: by_(me), Visible: true, SetupID: su.id }]);
    return { id: id, setup: su.id };
  });
  hook_({ action: 'GRINDING_RUNTIME', rowID: res.id, productionID: lot.pid, setupID: res.setup, requestedBy: by_(me) });
  return { ok: true, id: res.id };
}

// last statuses of a machine, newest first (status drawer)
function runLog(token, m) {
  cacheOn_();
  session_(token);
  m = str_(m); if (CFG.MACHINES.indexOf(m) < 0) throw new Error('เลือกเครื่อง');
  return runtime_(Date.now())[m].slice(-8).reverse().map(function (e) { return { id: e.id, t: e.t, p: e.p, lot: e.lot, pid: e.pid, reason: e.reason }; });
}
/* Cancel the machine's latest live status (wrong lot / wrong status) — same idea as cancelCoater. Rows are never deleted.
 * A blade setup row written with it ("เปลี่ยนมุม/ใบ: …", ProdApp, no other live status) is cancelled too and its ToolLifeID returned,
 * so saving the status again on the right lot re-creates that setup row there. Route-change statuses (several rows) → AppSheet. */
function cancelRuntime(token, id) {
  const me = session_(token, 'work');
  const r = withLock_(function () {
    delete TABLES_[CFG.T.RUN]; delete TABLES_[CFG.T.SETUP];
    const row = live_(CFG.T.RUN).filter(function (v) { return str_(v.ID) === str_(id); })[0];
    if (!row) throw new Error('ไม่พบสถานะ (อาจถูกยกเลิกไปแล้ว)');
    const m = str_(row.Grinding_Machine), ev = runtime_(Date.now())[m] || [], last = ev[ev.length - 1];
    if (!last || last.id !== str_(row.ID)) throw new Error('ยกเลิกได้เฉพาะสถานะล่าสุดของ ' + m);
    if (/^เปลี่ยน route /.test(str_(row.Reason))) throw new Error('สถานะนี้มาจาก “เปลี่ยน route” (บันทึกหลายแถวพร้อมกัน) — ยกเลิกใน AppSheet');
    setCells_(CFG.T.RUN, row._row, { Cancelled: true, UpdatedTimestamp: new Date(), UpdatedBy: by_(me) });
    const sid = str_(row.SetupID);
    const su = sid ? live_(CFG.T.SETUP).filter(function (v) { return str_(v.SetupID) === sid; })[0] : null;
    let tool = '', setupCancelled = '';
    if (su && /^เปลี่ยนมุม\/ใบ: /.test(str_(su.Memo)) && /^ProdApp:/.test(str_(su.CreatedBy))
        && !live_(CFG.T.RUN).some(function (v) { return str_(v.SetupID) === sid; })) {
      setCells_(CFG.T.SETUP, su._row, { Cancelled: true });
      tool = str_(su.ToolLifeID); setupCancelled = sid;
    }
    const t = date_(row.DateTime);
    /* The status came with an angle / blade change made in this app at the same time (user 27 Oct: "ได้"): undo that change too —
     * cancel the new Grinding_Tool_Life row and open the previous angle again, so it can be entered again with the right time. */
    let undo = null;
    if (tool) {
      delete TABLES_[CFG.T.TOOL];
      const TR = table_(CFG.T.TOOL).rows, live = function (v) { return !truthy_(v.Cancelled); };
      const tr = TR.filter(function (v) { return str_(v.ToolLifeID) === tool && live(v); })[0], st = tr && date_(tr.StartDateTime);
      const later = tr && st && TR.some(function (v) { const s2 = date_(v.StartDateTime); return live(v) && v !== tr && str_(v.Grinding_Machine) === m && s2 && s2.getTime() > st.getTime(); });
      if (tr && st && t && /^ProdApp:/.test(str_(tr.CreatedBy)) && Math.abs(st.getTime() - t.getTime()) <= 2 * MIN && !later) {
        const prev = TR.filter(function (v) { return str_(v.ToolLifeID) === str_(tr.Previous_ToolLifeID) && live(v); })[0], now = new Date();
        setCells_(CFG.T.TOOL, tr._row, { Cancelled: true, UpdatedTimestamp: now, UpdatedBy: by_(me) });
        if (prev) setCells_(CFG.T.TOOL, prev._row, { EndDateTime: '', Tool_Status: 'Active', Retire_Reason: '', UpdatedTimestamp: now, UpdatedBy: by_(me) });
        undo = { cancelled: tool, label: 'ชุด #' + str_(tr.Blade_No) + ' มุม ' + str_(tr.Blade_Angle), reopened: prev ? str_(prev.ToolLifeID) : '',
          back: prev ? 'ชุด #' + str_(prev.Blade_No) + ' มุม ' + str_(prev.Blade_Angle) : '' };
        tool = '';
      }
    }
    return { ok: true, id: str_(row.ID), m: m, pid: str_(row.ProductionID), lot: str_(row.Lot_Number), t: t ? t.getTime() : null, p: str_(row.Process),
      reason: str_(row.Reason), setup: sid, tool: tool, setupCancelled: setupCancelled, undo: undo };
  });
  hook_({ action: 'GRINDING_RUNTIME', rowID: r.id, productionID: r.pid, setupID: r.setup, requestedBy: by_(me) });
  if (r.undo) [r.undo.reopened, r.undo.cancelled].filter(Boolean).forEach(function (id) { hook_({ action: 'GRINDING_TOOL_LIFE_RECALC', toolLifeID: id, rowID: id, requestedBy: by_(me) }); });
  return r;
}

// x = {pid, w (scale reading), t (ms), memo}
function saveRecord(token, x) {
  const me = session_(token, 'work');
  const lot = lots_()[str_(x.pid)]; if (!lot) throw new Error('เลือก Lot');
  const w = num_(x.w); if (w == null || w <= 0) throw new Error('ใส่ตัวเลขตาชั่ง');
  const t = checkTime_(new Date(Number(x.t)));
  const point = pointOf_(flowAt_(lot.pid, t.getTime())); if (!point) throw new Error('Lot นี้ยังไม่มีการตั้งค่าโม่ ATOM-3');
  const g = { point: point };
  const res = withLock_(function () {
    const rs = records_().by[lot.pid] || [], prev = rs.filter(function (r) { return r.t <= t.getTime(); }).pop();
    const maxW = rs.reduce(function (a, r) { return Math.max(a, r.t <= t.getTime() ? r.w : 0); }, 0);
    if (w < maxW) throw new Error('น้อยกว่ายอดครั้งก่อน (' + maxW.toLocaleString() + ' kg)');
    if (prev) {
      const hrs = (t.getTime() - prev.t) / HOUR;
      if (hrs <= 0) throw new Error('เวลาต้องหลังครั้งก่อน (' + fmt_(new Date(prev.t)) + ')');
      if ((w - prev.w) / Math.max(hrs, 1 / 60) > CFG.MAX_KG_HR) throw new Error('เพิ่มเกิน ' + CFG.MAX_KG_HR.toLocaleString() + ' kg/ชม. — ตรวจตัวเลข');
    }
    const id = id8_(), now = new Date();
    // destination bin: none yet → this reading starts it; another bin → this reading closes the old one, the new one starts here
    const bin = str_(x.bin).toUpperCase(); let binNote = '';
    if (bin) {
      if (GB.BINS.indexOf(bin) < 0) throw new Error('ถังปลายทางไม่ถูกต้อง');
      const ev = gbEvents_(), cur = gbAt_(ev, t.getTime() + 1), last = ev[ev.length - 1];
      if (!cur || cur.bin !== bin) {
        if (last && last.t >= t.getTime()) throw new Error('มีการเปลี่ยนถังหลังเวลานี้แล้ว (' + fmt_(new Date(last.t)) + ') — ลงยอดตามลำดับเวลา');
        if (records_().all.some(function (r) { return r.t > t.getTime(); })) throw new Error('มียอดชั่งหลังเวลานี้แล้ว — เปลี่ยนถังย้อนหลังใช้ปุ่ม "เปลี่ยนถัง" แล้วใส่เวลา');
        binNote = cur ? bin : 'first';
      }
    }
    appendRows_(CFG.T.REC, [{ RecordID: id, ProductionID: lot.pid, Lot_Number: lot.lot, ProductID: lot.productID, Grinding_Machine: g.point,
      DateTimeRecords: t, Output_Weight: w, CreateTimestamp: now, UpdatedTimestamp: now, Cancelled: false, Memo: str_(x.memo), CreatedBy: by_(me), Visible: true, RecordType: 'Normal' }]);
    if (binNote) gbAdd_(me, bin, binNote === 'first' ? t.getTime() - 1000 : t.getTime(), lot, id, binNote === 'first' ? 'เริ่มบันทึกถัง' : 'เปลี่ยนถังพร้อมลงยอด');
    return { id: id };
  });
  hook_({ action: 'GRINDING_RECORDS', rowID: res.id, productionID: lot.pid, requestedBy: by_(me) });
  return { ok: true, id: res.id };
}

/* Blade / part change in one tap.
 * ATOM: x = {m, kind: 'angle' | 'turn' | 'new', t, pid?, process?} — closes the active angle (Change Angle / Turn Blade / Broken),
 *       opens the next (A→B angle, B→C turn, C→D angle, D→new set A), writes the runtime event if a lot is given.
 * PUL-1: x = {m: 'PUL-1', part: 'Blade' | 'Liner' | 'Both', t, pid?, process?} — closes the active part set, opens Set_No + 1. */
/* New setup row after an angle / blade change on m (ATOM-1/2/3): same lot, route, screens and rotation as the setup in use,
 * ToolLifeID = the new angle. Lot = pid if given, else the open lot on m at time t. Skipped when the setup in use already has that ToolLifeID. */
function bladeSetup_(m, pid, toolId, label, t, me) {
  const tool = lives_().tools.filter(function (x) { return x.id === toolId; })[0]; if (!tool) return '';
  const lots = lots_();
  if (!pid) { const e = stateAt_(runtime_(Date.now())[m], t); pid = e ? e.pid : ''; }
  const lot = lots[pid]; if (!lot || CFG.LOT_STATES.indexOf(lot.state) < 0) return '';
  const su = setups_().filter(function (s) { return s.pid === pid && s.machine === m; }); if (!su.length) return '';
  const byId = {}; su.forEach(function (s) { byId[s.id] = s; });
  const ev = runtime_(Date.now())[m].filter(function (e) { return e.pid === pid && e.t <= t && byId[e.setup]; }).pop();
  const base = ev ? byId[ev.setup] : su[su.length - 1];
  if (base.tool === tool.id) return '';
  const id = id8_();
  appendRows_(CFG.T.SETUP, [{ SetupID: id, ProductionID: lot.pid, Lot_Number: lot.lot, ProductID: lot.productID, Grinding_Flow: base.flow, Machine: m,
    Screen_Size_1: base.s1, Screen_Size_2: base.s2, Blade_No: tool.no, Blade_Angle: tool.angle, Rotation_Direction: base.rot || 'Forward',
    Cancelled: false, Memo: 'เปลี่ยนมุม/ใบ: ' + label, CreatedBy: by_(me), Visible: true, Plan_Extruder: lot.ext, Actual_Extruder: lot.ext,
    Setup_Status: 'Planned', ToolLifeID: tool.id }]);
  return id;
}
const NEXT_ = { A: 'B', B: 'C', C: 'D' };
const WHY_ = { angle: 'Change Angle', turn: 'Turn Blade', 'new': 'Broken' };
function bladeChange(token, x) {
  const me = session_(token, 'work');
  const m = str_(x.m), t = checkTime_(new Date(Number(x.t))), now = new Date();
  let closed = '', opened = '', label = '';
  if (x.pid && x.process) { // check the runtime event first so a failed event never leaves a half-done change
    if (processes_().map(function (p) { return p.p; }).indexOf(x.process) < 0) throw new Error('เลือกสถานะ');
    const lot = lots_()[str_(x.pid)]; if (!lot) throw new Error('เลือก Lot');
    runtimeSetup_(m, lot); runtimeCheck_(m, t);
  }
  withLock_(function () {
    if (m === 'PUL-1') {
      // part = 'Blade' | 'Liner' | 'Both' (user 7 Nov 2026: PUL-1 เปลี่ยนใบมีดกับ Liner พร้อมกัน → 2 แถวใน Grinding_Part_Life, Runtime 1 ครั้ง)
      const parts = x.part === 'Both' ? ['Blade', 'Liner'] : [x.part];
      if (!parts.every(function (p) { return ['Blade', 'Liner'].indexOf(p) >= 0; })) throw new Error('เลือกใบมีด / Liner / ทั้งคู่');
      setupParts_();
      const P = lives_().parts, nm = function (p) { return p === 'Blade' ? 'ใบมีด' : 'Liner'; };
      const actOf = function (part) { return P.filter(function (p) { return p.machine === m && p.part === part && !p.e; }).sort(function (a, b) { return b.s - a.s; })[0]; };
      parts.forEach(function (part) { const act = actOf(part); if (act && t.getTime() <= act.s) throw new Error(nm(part) + ': เวลาต้องหลังวันที่ใส่ชุดเดิม (' + fmt_(new Date(act.s)) + ')'); });
      const ids = [], cl = [], labels = [];
      parts.forEach(function (part) {
        const act = actOf(part), id = id8_(), no = act ? (Number(act.no) || 0) + 1 : 1;
        if (act) { setCells_(CFG.T.PART, act.row, { EndDateTime: t, Status: 'Closed', Reason: str_(x.reason) || 'Replaced', UpdatedTimestamp: now }); cl.push(act.id); }
        appendRows_(CFG.T.PART, [{ PartLifeID: id, Machine: m, Part: part, Set_No: no, StartDateTime: t, Status: 'Active', Cancelled: false, CreatedBy: by_(me), CreateTimestamp: now, UpdatedTimestamp: now }]);
        ids.push(id); labels.push(nm(part) + ' ชุด #' + no);
      });
      opened = ids.join(','); closed = cl.join(','); label = labels.join(' + ');
      return;
    }
    if (CFG.BLADE_MACHINES.indexOf(m) < 0) throw new Error('เลือกเครื่อง');
    const kind = x.kind; if (!WHY_[kind]) throw new Error('เลือกการเปลี่ยน');
    const act = activeTool_(m); if (!act) throw new Error(m + ' ไม่มีใบที่ใช้อยู่ — ตรวจใน AppSheet');
    if (t.getTime() <= act.s) throw new Error('เวลาต้องหลังเวลาเริ่มมุมเดิม (' + fmt_(new Date(act.s)) + ')');
    let no = act.no, angle;
    if (kind === 'new') { no = String((Number(act.no) || 0) + 1); angle = 'A'; }
    else { angle = NEXT_[act.angle]; if (!angle) throw new Error('มุม ' + act.angle + ' เป็นมุมสุดท้าย — เปลี่ยนชุดใหม่'); }
    setCells_(CFG.T.TOOL, act.row, { EndDateTime: t, Tool_Status: 'Closed', Retire_Reason: WHY_[kind], UpdatedTimestamp: now, UpdatedBy: by_(me) });
    opened = id8_(); closed = act.id;
    appendRows_(CFG.T.TOOL, [{ ToolLifeID: opened, Grinding_Machine: m, Blade_No: no, Blade_Angle: angle, Rotation_Direction: act.rot || 'FORWARD', StartDateTime: t,
      Tool_Status: 'Active', Previous_ToolLifeID: act.id, Cancelled: false, CreateTimestamp: now, UpdatedTimestamp: now, CreatedBy: by_(me), Visible: true, Manual_Recalc_Request: false }]);
    label = 'ชุด #' + no + ' มุม ' + angle;
  });
  // AppSheet shows a lot's blade / angle from its setup row's ToolLifeID, so the lot on this machine gets a setup row for the new angle
  let setupID = '';
  if (m !== 'PUL-1' && opened) setupID = withLock_(function () { return bladeSetup_(m, str_(x.pid), opened, label, t.getTime(), me); });
  let runtimeID = '';
  if (x.pid && x.process) runtimeID = saveRuntime(token, { m: m, pid: x.pid, process: x.process, reason: label, t: t.getTime() }).id;
  if (m !== 'PUL-1' && closed) hook_({ action: 'GRINDING_TOOL_LIFE_RECALC', toolLifeID: closed, rowID: closed, requestedBy: by_(me) });
  return { ok: true, closed: closed, opened: opened, label: label, runtimeID: runtimeID, setupID: setupID };
}


// ---------- grinding rounds (26 Oct: เปลี่ยนเบอร์ / ยอดแยกตามรอบ) ----------
/* A round = one stretch of ATOM-3 grinding of a lot. It starts at the lot's first ATOM-3 status / scale reading and is cut by
 * (a) a new blade-life row on ATOM-3 (angle or blade change) or (b) a "GD-ตัดรอบเบอร์ ใช้มีดมุมเดิม" status of that lot.
 * kg of a round = scale readings (cumulative kg) that fall in (start, end]; the rounds always add up to the lot's total. */
function lotCockpit(token, pid) {
  cacheOn_();
  session_(token);
  const lot = lots_()[pid]; if (!lot) throw new Error('ไม่พบ Lot');
  const W = world_(), now = W.now, a3 = W.run['ATOM-3'];
  const ev = a3.filter(function (e) { return e.pid === pid; });
  const recs = (W.rec.by[pid] || []).slice().sort(function (a, b) { return a.t - b.t; });
  const fine = fineOnce_(fineRows_().filter(function (f) { return f.pid === pid; }));
  const su = setups_().filter(function (s) { return s.pid === pid; });
  const flow = flowAt_(pid, now), last = a3.length ? a3[a3.length - 1] : null;
  const times = ev.map(function (e) { return e.t; }).concat(recs.map(function (r) { return r.t; }));
  const t0 = times.length ? Math.min.apply(null, times) : null;
  const out = { lot: lot, flow: flow, point: pointOf_(flow), hasSetup: su.length > 0, started: ev.length > 0, canCut: !!t0, rounds: [], total: 0, now: now, cutProcess: CUT_,
    cutReady: processes_().some(function (p) { return p.p === CUT_; }), status: last && last.pid === pid ? { p: last.p, t: last.t } : null,
    active: (function () { const a = W.tools.filter(function (t) { return t.machine === 'ATOM-3' && !t.e; }).sort(function (x, y) { return y.s - x.s; })[0]; return a ? { no: a.no, angle: a.angle, since: a.s } : null; })() };
  if (!t0) return out;
  const cuts = ev.filter(function (e) { return e.p === CUT_; }).map(function (e) { return { t: e.t, k: 'cut', why: e.reason }; });
  const tools = W.tools.filter(function (t) { return t.machine === 'ATOM-3' && t.s > t0 && t.s <= now; }).map(function (t) { return { t: t.s, k: 'tool', why: '' }; });
  const bounds = cuts.concat(tools).sort(function (a, b) { return a.t - b.t; }), starts = [{ t: t0, k: 'start' }];
  bounds.forEach(function (b) { if (b.t > starts[starts.length - 1].t) starts.push(b); });
  const cum = function (t) { return recs.reduce(function (a, r) { return r.t <= t ? a + r.kg : a; }, 0); };
  starts.forEach(function (b, i) {
    const s = b.t, e = i + 1 < starts.length ? starts[i + 1].t : now;
    const tool = W.tools.filter(function (t) { return t.machine === 'ATOM-3' && t.s <= s && (!t.e || t.e > s); }).sort(function (x, y) { return y.s - x.s; })[0] || null;
    const kg = Math.round(cum(e) - (i === 0 ? 0 : cum(s))), hrs = runMin_(a3, s, e) / 60;
    const fs = fine.filter(function (f) { return f.t > (i === 0 ? 0 : s) && f.t <= e && f.pct != null; });
    const samples = {}; fs.forEach(function (f) { samples[f.m + '|' + Math.floor(f.t / (30 * MIN))] = f.result; });
    const res = Object.keys(samples).map(function (k) { return samples[k]; });
    const prev = out.rounds[i - 1];
    out.rounds.push({ n: i + 1, s: s, e: i + 1 < starts.length ? e : null, kg: kg, hrs: Math.round(hrs * 10) / 10, kgh: hrs > 0.1 ? Math.round(kg / hrs) : null,
      blade: tool ? tool.no : '', angle: tool ? tool.angle : '', how: i === 0 ? 'start' : b.k, why: b.why || '',
      same: !!prev && prev.blade === (tool ? tool.no : '') && prev.angle === (tool ? tool.angle : ''),
      readings: recs.filter(function (r) { return r.t > (i === 0 ? 0 : s) && r.t <= e; }).length,
      fine: { n: res.length, pass: res.filter(function (x) { return /pass/i.test(x); }).length, re: res.filter(function (x) { return /re-?grind/i.test(x); }).length } });
  });
  out.total = out.rounds.reduce(function (a, r) { return a + r.kg; }, 0);
  const cur = out.rounds[out.rounds.length - 1], lr = recs[recs.length - 1];
  out.lastRecord = lr ? { t: lr.t, w: lr.w } : null;
  out.next = !lr ? 'rec' : (now - lr.t > 30 * MIN ? 'rec' : (cur.fine.n === 0 ? 'fine' : ''));
  return out;
}
// x = {pid, kind: 'same' | 'angle' | 'blade', t, reason}
function cutRound(token, x) {
  session_(token, 'work');
  const lot = lots_()[str_(x.pid)]; if (!lot) throw new Error('ไม่พบ Lot');
  const kind = str_(x.kind);
  if (kind === 'same') {
    if (!processes_().some(function (p) { return p.p === CUT_; })) throw new Error('ยังไม่มีสถานะ "' + CUT_ + '" ใน RuntimeType — เพิ่มก่อน');
    const r = saveRuntime(token, { m: 'ATOM-3', pid: lot.pid, process: CUT_, reason: str_(x.reason) || 'ประเมินหน้างาน', t: x.t });
    return { ok: true, kind: kind, label: 'ใช้ใบ/มุมเดิม', id: r.id };
  }
  if (['angle', 'blade'].indexOf(kind) < 0) throw new Error('เลือกการเปลี่ยน');
  const act = activeTool_('ATOM-3'); if (!act) throw new Error('ATOM-3 ไม่มีใบที่ใช้อยู่ — ตรวจใน AppSheet');
  const k = kind === 'blade' ? 'new' : (act.angle === 'B' ? 'turn' : act.angle === 'D' ? 'new' : 'angle');
  const r = bladeChange(token, { m: 'ATOM-3', kind: k, t: x.t, pid: lot.pid });
  return { ok: true, kind: kind, label: r.label, opened: r.opened, setupID: r.setupID };
}

// Main script webhook (same deployment Coating Control uses). The webhook skips identical bodies within 45 s → requestID makes each unique.
function hook_(p) {
  try {
    p.requestID = (p.rowID || p.toolLifeID || '') + '-' + Date.now();
    const r = UrlFetchApp.fetch(prop_('RECALC_URL') || CFG.HOOK_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(p) });
    dbCalcBack_(p);
    return r.getResponseCode();
  } catch (e) { console.warn('hook ' + p.action + ': ' + e); return 0; }
}

// ---------- setup (run once from the editor; the user runs it) ----------
function setupParts_() {
  let sh = ss_().getSheetByName(CFG.T.PART);
  if (!sh) {
    sh = ss_().insertSheet(CFG.T.PART, ss_().getNumSheets());
    sh.appendRow(CFG.PART_HEADERS);
    const now = new Date();
    CFG.PART_SEED.forEach(function (s) {
      sh.appendRow([id8_(), s[0], s[1], s[2], new Date(s[3]), '', 'Active', '', 'ชุดที่ใช้อยู่ก่อนเริ่มบันทึก (ผู้ใช้แจ้ง 25 ต.ค. 2026)', false, 'setup', now, now]);
    });
    delete TABLES_[CFG.T.PART];
  }
  return sh;
}
/* PUL-1 opening balance: the sheet's weighing data starts 14 Jul 2026, so the user gives the real total to date
 * of the active blade / liner set; Opening_kg = real total - what the app counts from its own data (≥ 0). */
function setPartTotal(token, x) {
  const me = session_(token, 'work');
  if (['Blade', 'Liner'].indexOf(x.part) < 0) throw new Error('เลือกใบมีด หรือ Liner');
  const tot = num_(x.total); if (tot == null || tot <= 0 || tot > 100000) throw new Error('ใส่ยอดรวมเป็นตัน (เช่น 1717.22)');
  return withLock_(function () {
    setupParts_(); const pt = table_(CFG.T.PART);
    if (pt.h.indexOf('Opening_kg') < 0) { pt.sh.getRange(1, pt.h.length + 1).setValue('Opening_kg'); delete TABLES_[CFG.T.PART]; wrote_(CFG.T.PART); }
    const act = lives_().parts.filter(function (p) { return p.machine === 'PUL-1' && p.part === x.part && !p.e; }).sort(function (a, b) { return b.s - a.s; })[0];
    if (!act) throw new Error('ไม่มีชุดที่ใช้อยู่');
    const W = world_();
    // the user's total may end at a lot ("จบ Lot …"): then only what the app counted up to that lot's last reading is replaced, later grinding is added on top
    let upTo = W.now, upLot = '';
    if (x.until) {
      const rs = W.rec.all.filter(function (r) { return r.pid === str_(x.until); });
      if (!rs.length) throw new Error('Lot ที่เลือกยังไม่มียอดตาชั่ง');
      upTo = Math.max.apply(null, rs.map(function (r) { return r.t; })) + 1; upLot = rs[0].lot;
    }
    const calc = sumWindow_(W.alloc['PUL-1'], act.s, upTo).kg, open = Math.round(tot * 1000 - calc);
    if (open < 0) throw new Error('ยอดที่ใส่ (' + tot + ' t) น้อยกว่าที่แอพนับได้แล้ว (' + (calc / 1000).toFixed(1) + ' t)');
    const note = 'ยอดรวมจริง ' + tot + ' t ' + (upLot ? 'จบที่ Lot ' + upLot + ' (' + fmt_(new Date(upTo), 'dd/MM/yyyy HH:mm') + ')' : 'ณ ' + fmt_(new Date(W.now), 'dd/MM/yyyy HH:mm')) + ' (ผู้ใช้แจ้ง · ' + me.Name + ')';
    setCells_(CFG.T.PART, act.row, { Opening_kg: open, Memo: note, UpdatedTimestamp: new Date() });
    return { part: x.part, no: act.no, total: tot, open: open, calc: Math.round(calc), upLot: upLot, after: Math.round(sumWindow_(W.alloc['PUL-1'], act.s, W.now).kg + open) };
  });
}

function setup() {
  const sh = usersSheet_(), have = users_().map(function (u) { return u.Name; });
  CFG.SEED_USERS.forEach(function (s) {
    wrote_(CFG.USERS); if (have.indexOf(s[0]) < 0) { const id = 'U' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); sh.appendRow([id, s[0], s[1], '!' + hash_(id, s[2]), true, new Date(), 'setup']); }
  });
  setupParts_();
  prop_('SECRET', true);
  return 'ok';
}

// =====================================================================
// Phase 2 — Product + Production Lot (user 25 Oct: "เริ่มทำส่วน lot และ product ก่อน")
// Production_Lot / Product_Detail are AppSheet tables: same columns, no new columns.
// =====================================================================
function productsAll_() {
  return table_(CFG.T.PRODUCT).rows.filter(function (r) { return str_(r.ProductID); }).map(function (r) {
    return { id: str_(r.ProductID), name: str_(r.ProductName), size: str_(r.Kibble_Size), cap: num_(r['Std Cap/hr']),
      lcl: num_(r.Moisture_LCL), cl: num_(r.Moisture_CL), ucl: num_(r.Moisture_UCL), cancelled: truthy_(r.Cancelled), row: r._row };
  });
}
function listProducts(token) {
  cacheOn_();
  session_(token);
  const used = {};
  table_(CFG.T.LOT).rows.forEach(function (r) { if (!truthy_(r.Cancelled)) { const k = str_(r.ProductID); used[k] = (used[k] || 0) + 1; } });
  const caps = {};
  productsAll_().forEach(function (p) { if (p.cap && !p.cancelled) { (caps[p.size] = caps[p.size] || {})[p.cap] = ((caps[p.size] || {})[p.cap] || 0) + 1; } });
  const capBySize = {};
  Object.keys(caps).forEach(function (k) { capBySize[k] = Number(Object.keys(caps[k]).sort(function (a, b) { return caps[k][b] - caps[k][a]; })[0]); });
  const maps = ncpMaps_(), codes = ncpCodes_(), cn = {};
  codes.forEach(function (c) { cn[c.id] = c.name; });
  return { products: productsAll_().map(function (p) {
    delete p.row; p.lots = used[p.id] || 0;
    p.maps = maps.filter(function (m) { return m.pid === p.id; }).map(function (m) { return { mapId: m.mapId, ncp: m.ncp, name: cn[m.ncp] || '', priority: m.priority, def: m.def, active: m.active, remark: m.remark }; })
      .sort(function (a, b) { return (b.active - a.active) || (a.priority - b.priority); });
    const on = p.maps.filter(function (m) { return m.active && m.ncp; }); p.ncp = on.length ? on[0].ncp : ''; p.ncpName = on.length ? on[0].name : '';
    return p; }), kibbles: CFG.KIBBLES, capBySize: capBySize, ncpCodes: codes };
}
// ---------- NCP mapping (user 29 Oct 16:16 "หน้า product ให้สามารถเพิ่ม NCP mapping ได้แบบ appsheet") ----------
// Production_NCP_Map: MapID · ProductID · NCP_ID (→ NCP_Detail) · Priority · Default_Flag · Active · Remark. Shared with AppSheet,
// the Coating app and the daily NCP export: rows are only added / edited, never deleted; a change of code = new row + old row Active FALSE (as in the sheet)
const NM = { TAB: 'Production_NCP_Map', DET: 'NCP_Detail' };
function ncpCodes_() {
  if (!ss_().getSheetByName(NM.DET)) return [];
  return table_(NM.DET).rows.filter(function (r) { return str_(r.NCP_ID); }).map(function (r) {
    return { id: str_(r.NCP_ID), name: str_(r.NCP_Name), cat: str_(r.Category), color: str_(r.Color), active: str_(r.Active) === '' || truthy_(r.Active),
      pmin: num_(r['Protein Min %']), pmax: num_(r['Protein Max %']), storage: str_(r.Storage), row: r._row };
  });
}
function ncpMaps_() {
  if (!ss_().getSheetByName(NM.TAB)) return [];
  return table_(NM.TAB).rows.filter(function (r) { return str_(r.MapID) || str_(r.ProductID); }).map(function (r) {
    return { mapId: str_(r.MapID), pid: str_(r.ProductID), ncp: str_(r.NCP_ID), priority: num_(r.Priority) || 1, def: truthy_(r.Default_Flag), active: truthy_(r.Active), remark: str_(r.Remark), row: r._row };
  });
}
// x = {mapId (edit) | –, pid, ncp, priority, def, active, remark, closeOthers}
function saveNcpMap(token, x) {
  const me = session_(token, 'work'), pid = str_(x.pid), ncp = str_(x.ncp).toUpperCase(), pr = num_(x.priority) == null ? 1 : num_(x.priority);
  if (!productsAll_().some(function (p) { return p.id === pid; })) throw new Error('ไม่พบ ProductID ' + pid);
  const code = ncpCodes_().filter(function (c) { return c.id.toUpperCase() === ncp; })[0];
  if (!code) throw new Error('เลือกรหัส NCP จาก NCP_Detail');
  if (!(pr >= 1 && pr <= 99 && Math.round(pr) === pr)) throw new Error('Priority = 1–99');
  if (!ss_().getSheetByName(NM.TAB)) throw new Error('ไม่พบชีต ' + NM.TAB);
  withLock_(function () {
    delete TABLES_[NM.TAB];
    const all = ncpMaps_(), row = { ProductID: pid, NCP_ID: code.id, Priority: pr, Default_Flag: x.def !== false, Active: x.active !== false, Remark: str_(x.remark) };
    let keep = str_(x.mapId);
    if (keep) {
      const m = all.filter(function (r) { return r.mapId === keep; })[0]; if (!m || m.pid !== pid) throw new Error('ไม่พบ mapping ' + keep);
      setCells_(NM.TAB, m.row, row);
    } else {
      if (!code.active) throw new Error(code.id + ' ปิดใช้งานใน NCP_Detail');
      if (all.some(function (r) { return r.pid === pid && r.ncp === code.id && r.active; }) && row.Active) throw new Error(pid + ' มี mapping ' + code.id + ' ที่ Active อยู่แล้ว');
      do { keep = Utilities.getUuid().replace(/-/g, '').slice(0, 8); } while (all.some(function (r) { return r.mapId === keep; })); // 8 hex like AppSheet UNIQUEID()
      row.MapID = keep; appendRows_(NM.TAB, [row]);
    }
    if (x.closeOthers && row.Active) all.forEach(function (r) { if (r.pid === pid && r.active && r.mapId !== keep) setCells_(NM.TAB, r.row, { Active: false }); });
    console.log('saveNcpMap ' + pid + ' ' + code.id + ' ' + keep + ' by ' + me.Name);
  });
  return listProducts(token);
}
// ---------- NCP codes (user 13 Nov 2026: "รหัส NCP … มีส่วนเพิ่ม/แก้ไข ใน BFL Production หรือยัง ถ้าไม่มีให้เพิ่ม") ----------
// NCP_Detail: NCP_ID · NCP_Name · Category · Color · Protein Min % · Protein Max % · Storage · Active. Shared master (Coating, Packing,
// Bluefalo NCP reports read it; nothing else writes it) — stays in the sheet. A code is never deleted or renamed (NCP rows and
// Production_NCP_Map point at the ID): Active FALSE = no longer offered for new mappings.
// x = {isNew, id, name, cat, color, pmin, pmax, storage, active}
function saveNcpCode(token, x) {
  const me = session_(token, 'work');
  const id = str_(x.id).toUpperCase(), name = str_(x.name), cat = str_(x.cat).toUpperCase(), color = str_(x.color).toUpperCase(), storage = str_(x.storage).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._\-]{2,30}$/.test(id)) throw new Error('NCP_ID ใช้ตัวอังกฤษ ตัวเลข - . _ ไม่มีเว้นวรรค (3–31 ตัว)');
  if (!name || name.length > 120) throw new Error('ใส่ชื่อรหัส NCP (ไม่เกิน 120 ตัว)');
  if (!cat || cat.length > 30) throw new Error('ใส่กลุ่ม (Category) เช่น DOG / CAT / BIRD');
  if (color.length > 40 || storage.length > 20) throw new Error('สี / ที่เก็บ ยาวเกินไป');
  const pmin = str_(x.pmin) === '' ? null : num_(x.pmin), pmax = str_(x.pmax) === '' ? null : num_(x.pmax);
  [[x.pmin, pmin], [x.pmax, pmax]].forEach(function (p) { if (str_(p[0]) !== '' && (p[1] == null || p[1] < 0 || p[1] > 100)) throw new Error('Protein % ต้องเป็นตัวเลข 0–100'); });
  if (pmin != null && pmax != null && pmin > pmax) throw new Error('Protein Min % ต้องไม่มากกว่า Max %');
  if (!ss_().getSheetByName(NM.DET)) throw new Error('ไม่พบชีต ' + NM.DET);
  withLock_(function () {
    delete TABLES_[NM.DET];
    const same = ncpCodes_().filter(function (c) { return c.id.toUpperCase() === id; })[0];
    const row = { NCP_Name: name, Category: cat, Color: color, 'Protein Min %': pmin == null ? '' : pmin, 'Protein Max %': pmax == null ? '' : pmax,
      Storage: storage, Active: x.active !== false };
    if (x.isNew) {
      if (same) throw new Error('มีรหัส ' + same.id + ' อยู่แล้ว');
      appendRows_(NM.DET, [Object.assign({ NCP_ID: id }, row)]);
    } else {
      if (!same) throw new Error('ไม่พบรหัส ' + id);
      setCells_(NM.DET, same.row, row);
    }
    console.log('saveNcpCode ' + id + (x.isNew ? ' new' : ' edit') + ' by ' + me.Name);
  });
  return listProducts(token);
}
// x = {isNew, id, name, size, cap, lcl, cl, ucl, cancelled}
function saveProduct(token, x) {
  const me = session_(token, 'work');
  const id = str_(x.id), name = str_(x.name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-]{2,40}$/.test(id)) throw new Error('ProductID ใช้ตัวอังกฤษ ตัวเลข - . _ ไม่มีเว้นวรรค');
  if (!name) throw new Error('ใส่ชื่อสินค้า');
  if (CFG.KIBBLES.indexOf(x.size) < 0) throw new Error('เลือกขนาดเม็ด');
  const cap = num_(x.cap), lcl = num_(x.lcl), cl = num_(x.cl), ucl = num_(x.ucl);
  if (cap != null && (cap < 100 || cap > 20000)) throw new Error('Std Cap/hr ไม่สมเหตุผล');
  if ([lcl, cl, ucl].some(function (v) { return v == null || v < 0 || v > 30; })) throw new Error('ใส่ช่วงความชื้น LCL / CL / UCL');
  if (!(lcl < cl && cl < ucl)) throw new Error('ความชื้นต้องเรียง LCL < CL < UCL');
  return withLock_(function () {
    delete TABLES_[CFG.T.PRODUCT];
    const all = productsAll_(), same = all.find(function (p) { return p.id.toLowerCase() === id.toLowerCase(); });
    const row = { ProductID: id, ProductName: name, Kibble_Size: x.size, 'Std Cap/hr': cap == null ? '' : cap, Moisture_LCL: lcl, Moisture_CL: cl, Moisture_UCL: ucl, Cancelled: !!x.cancelled };
    if (x.isNew) {
      if (same) throw new Error('มี ProductID นี้แล้ว' + (same.id !== id ? ' (' + same.id + ')' : ''));
      appendRows_(CFG.T.PRODUCT, [row]);
    } else {
      if (!same || same.id !== id) throw new Error('ไม่พบ ProductID');
      delete row.ProductID;
      setCells_(CFG.T.PRODUCT, same.row, row);
    }
    console.log('saveProduct ' + id + ' by ' + me.Name);
    return { ok: true, id: id };
  });
}

function lotRows_() {
  return table_(CFG.T.LOT).rows.filter(function (r) { return str_(r.ProductionID); });
}
function lotOut_(r, names) {
  const ct = date_(r.CreateTimestamp);
  return { pid: str_(r.ProductionID), lot: str_(r.Lot_Number), productID: str_(r.ProductID), name: names[str_(r.ProductID)] || str_(r.ProductID),
    state: str_(r.State), ext: str_(r.Extruder_Number), plan: num_(r.Qty_Plan), batch: num_(r.Total_Batch_kg), input: num_(r.Total_Input),
    fg: num_(r.Total_FG), ncp: num_(r.Total_NCP), out: num_(r.Total_Output), yieldPct: num_(r.Yield), loss: num_(r.Loss), prod: num_(r.Productivity),
    formula: str_(r.Formula_change), created: ct ? ct.getTime() : null, cancelled: truthy_(r.Cancelled),
    fat: num_(r.Total_Fat_kg), flavour: num_(r.Total_Flavour_kg), precon: num_(r['Total_Pre-con_kg']), color: num_(r.Total_Color_kg), oldSemi: num_(r.Old_Semi), reuse: num_(r.NCP_Reuse_kg), ncpUse: num_(r.NCP_Usage_kg), pcb: num_(r.PC_Before), pca: num_(r.PC_After) };
}
function listLots(token) {
  cacheOn_();
  session_(token);
  const names = products_();
  const rows = lotRows_().filter(function (r) { return !truthy_(r.Cancelled); }).map(function (r) { return lotOut_(r, names); })
    .sort(function (a, b) { return (b.created || 0) - (a.created || 0) || b.lot.localeCompare(a.lot); });
  return { lots: rows.slice(0, 300), total: rows.length, states: CFG.STATES, extruders: CFG.EXTRUDERS, counts: CFG.STATES.reduce(function (o, s) { o[s] = rows.filter(function (l) { return l.state === s; }).length; return o; }, {}) };
}
// Lot number = YYMMDD (production date) + 3-digit running number of that month (+ "-PC" for PC lots)
function nextLotNo(token, day) {
  session_(token);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? day : fmt_(new Date(), 'yyyy-MM-dd');
  return nextLotNo_(d);
}
function nextLotNo_(d) {
  const yymm = d.slice(2, 4) + d.slice(5, 7), yymmdd = yymm + d.slice(8, 10);
  let max = 0;
  lotRows_().forEach(function (r) { const m = /^(\d{4})\d{2}(\d{3})/.exec(str_(r.Lot_Number)); if (m && m[1] === yymm && !truthy_(r.Cancelled)) max = Math.max(max, Number(m[2])); });
  return { lot: yymmdd + String(max + 1).padStart(3, '0'), seq: max + 1 };
}
// x = {productID, lot, qty, ext, formula}
function createLot(token, x) {
  const me = session_(token, 'work');
  const prod = productsAll_().find(function (p) { return p.id === str_(x.productID) && !p.cancelled; });
  if (!prod) throw new Error('เลือก Product');
  const lot = str_(x.lot).toUpperCase();
  if (!/^\d{9}(-PC)?$/.test(lot)) throw new Error('เลข Lot ต้องเป็น YYMMDD + 3 หลัก (เช่น 261026049) หรือต่อท้าย -PC');
  const qty = num_(x.qty); if (!(qty > 0 && qty <= 500)) throw new Error('แผนผลิต (ตัน) ต้องมากกว่า 0');
  if (CFG.EXTRUDERS.indexOf(x.ext) < 0) throw new Error('เลือก Extruder');
  return withLock_(function () {
    delete TABLES_[CFG.T.LOT];
    const same = lotRows_().filter(function (r) { return str_(r.Lot_Number).toUpperCase() === lot && !truthy_(r.Cancelled); });
    if (same.some(function (r) { return str_(r.Extruder_Number) === x.ext; })) throw new Error('มี Lot ' + lot + ' ของ ' + x.ext + ' แล้ว');
    if (same.some(function (r) { return str_(r.ProductID) !== prod.id; })) throw new Error('Lot ' + lot + ' ใช้กับ Product อื่นแล้ว');
    const pid = id8_(), now = new Date();
    appendRows_(CFG.T.LOT, [{ ProductionID: pid, ProductID: prod.id, Lot_Number: lot, Qty_Plan: qty, State: 'Batching', CreateTimestamp: now, UpdatedTimestamp: now,
      Cancelled: false, Extruder_Detail: CFG.EXT_DETAIL, Sieve_Detail: CFG.SIEVE_DETAIL, LotProductKey: lot + '|' + prod.id + '|' + x.ext, Extruder_Number: x.ext,
      'Total_Pre-con_kg': 0, 'Total_Color_kg': 0, Old_Semi: 0, NCP_Reuse_kg: 0, KPI_Recalc_RequestBy: 'USER', Formula_change: str_(x.formula) }]);
    console.log('createLot ' + lot + ' ' + pid + ' by ' + me.Name);
    return { ok: true, pid: pid, lot: lot, also: same.length ? 'Lot นี้มีอีก ' + same.length + ' แถว (เครื่องอื่น)' : '' };
  });
}
// x = {state?, qty?, formula?, cancel?}
// rows in the production tabs that still point at a lot — cancelled together with the lot (user 9 Nov 2026) and listed in Lot_Cancel_Log
const LC = { LOG: 'Lot_Cancel_Log', HEAD: ['LogID', 'Time', 'By', 'ProductionID', 'Lot_Number', 'ProductID', 'State_Before', 'Reason', 'Rows_Cancelled'],
  TABS: ['Grinding_Setup', 'Grinding_Runtime', 'Grinding_Records', 'Grinding_Fineness', 'Coater_Records', 'NCP', 'Moisture', 'Kibble', 'Extruder_Runtime', 'Die_Usage', 'Batching_Formula'] };
function lotUse_(pid) {
  const out = {};
  LC.TABS.forEach(function (n) {
    if (!ss_().getSheetByName(n)) return;
    let rows = []; try { delete TABLES_[n]; rows = live_(n).filter(function (v) { return str_(v.ProductionID) === str_(pid); }); } catch (e) { console.warn('lotUse_ ' + n + ': ' + e); }
    if (rows.length) out[n] = rows;
  });
  return out;
}
// Cancelled TRUE (+ UpdatedTimestamp / UpdatedBy / NCP State-Status where the tab has them) on the given rows — one sheet read, no row deleted
function lotCancelRows_(n, rows, why, me) {
  const t = table_(n), sh = t.sh, h = t.h, now = new Date();
  const put = function (row, k, v) { const c = h.indexOf(k); if (c >= 0) sh.getRange(row, c + 1).setValue(v); };
  rows.forEach(function (v) {
    put(v._row, 'Cancelled', true); put(v._row, 'UpdatedTimestamp', now); put(v._row, 'UpdatedBy', by_(me));
    if (n === CFG.T.NCP) { put(v._row, 'State', 'Cancel'); if (str_(v.Status)) put(v._row, 'Status', 'Cancelled'); }
  });
  delete TABLES_[n]; wrote_(n);
  if (n === CFG.T.NCP) { rows.forEach(function (v) { NCP_TOUCHED_.push(v._row); }); ncpFlush_(); }
  if (n === CFG.T.NCP) rows.forEach(function (v) { ncpLog_(me, v, 'cancel-lot', [['Cancelled', 'FALSE', 'TRUE'], ['Reason', '', why]]); });
}
function lotCancelCheck(token, pid) {
  session_(token, 'work');
  const r = lotRows_().find(function (v) { return str_(v.ProductionID) === str_(pid); }); if (!r) throw new Error('ไม่พบ Lot');
  const u = lotUse_(pid), used = {}; Object.keys(u).forEach(function (k) { used[k] = u[k].length; });
  return { lot: str_(r.Lot_Number), state: str_(r.State), used: used, fg: live_('FG_Lot').filter(function (v) { return str_(v.ProductionID) === str_(pid); }).length };
}
function updateLot(token, pid, x) {
  const me = session_(token, 'work');
  const res = withLock_(function () {
    delete TABLES_[CFG.T.LOT];
    const r = lotRows_().find(function (v) { return str_(v.ProductionID) === str_(pid); }); if (!r) throw new Error('ไม่พบ Lot');
    const set = { UpdatedTimestamp: new Date() };
    if (x.state != null) { if (CFG.STATES.indexOf(x.state) < 0) throw new Error('State ไม่ถูกต้อง'); set.State = x.state; }
    if (x.qty != null) { const q = num_(x.qty); if (!(q > 0 && q <= 500)) throw new Error('แผนผลิต (ตัน) ไม่ถูกต้อง'); set.Qty_Plan = q; }
    if (x.formula != null) set.Formula_change = str_(x.formula);
    if (x.batch != null) { const b = num_(x.batch); if (!(b > 0 && b <= 1000000)) throw new Error('ยอด Batch (kg) ไม่ถูกต้อง'); set.Total_Batch_kg = Math.round(b * 10) / 10; }
    // Fat / Flavour / Pre-con / Color: one total per lot (user 31 Oct 07:43); same columns AppSheet and the KPI script read
    if (x.inputs) {
      const log = { LogID: id8_(), Time: new Date(), By: by_(me), ProductionID: str_(pid), Lot_Number: str_(r.Lot_Number), Source: str_(x.inputs.source) || 'manual', Note: str_(x.inputs.note).slice(0, 300) };
      LI.COLS.forEach(function (c) {
        const v = x.inputs[c[0]]; if (v == null || String(v).trim() === '') return;
        const n = num_(String(v).replace(/,/g, '')); if (n == null || n < 0 || n > 1000000) throw new Error(c[2] + ' (kg) ไม่ถูกต้อง');
        set[c[1]] = c[4] === 'int' ? Math.round(n) : Math.round(n * 10) / 10; log[c[3]] = set[c[1]]; log[c[3] + '_Before'] = num_(r[c[1]]) == null ? '' : num_(r[c[1]]);
      });
      // Pre-con อัตโนมัติ (user 7 Nov 2026): when PC_Before / PC_After change and both are known → Total_Pre-con_kg = Before − After
      if ('PC_Before' in set || 'PC_After' in set) {
        const pb = 'PC_Before' in set ? set.PC_Before : num_(r.PC_Before), pa = 'PC_After' in set ? set.PC_After : num_(r.PC_After);
        if (pb != null && pa != null) {
          const use = Math.round((pb - pa) * 10) / 10, typed = x.inputs.precon != null && String(x.inputs.precon).trim() !== '';
          if (use < 0 && !typed) throw new Error('PC After มากกว่า PC Before — ตรวจตัวเลข (ถ้าเติมถังระหว่าง Lot ให้กรอก Pre-con เอง)');
          if (use >= 0) { set['Total_Pre-con_kg'] = use; log.PreCon_kg = use; log.PreCon_kg_Before = num_(r['Total_Pre-con_kg']) == null ? '' : num_(r['Total_Pre-con_kg']); log.Note = (log.Note ? log.Note + ' · ' : '') + 'Pre-con = PC ' + pb + ' − ' + pa; }
        }
      }
      if (Object.keys(set).length === 1) throw new Error('ยังไม่ได้ใส่ตัวเลข');
      ensureTab_(LI.LOG, LI.HEAD); appendRows_(LI.LOG, [log]);
    }
    if (x.cancel) {
      // user 9 Nov 2026: Control or Admin cancels here (no more AppSheet). A lot with production data needs a reason; its rows in the
      // production tabs are cancelled with it (Cancelled TRUE, never deleted) and everything is written to Lot_Cancel_Log.
      const used = lotUse_(pid), n = Object.keys(used).reduce(function (a, k) { return a + used[k].length; }, 0);
      const fg = live_('FG_Lot').filter(function (v) { return str_(v.ProductionID) === str_(pid); }).length;
      if (fg) throw new Error('Lot นี้มี FG Lot ในแอป Packing ' + fg + ' รายการ — ยกเลิก FG Lot ในแอป Packing ก่อน');
      if (n) {
        const why = str_(x.reason).slice(0, 300); if (why.length < 5) throw new Error('ใส่เหตุผลที่ยกเลิก (อย่างน้อย 5 ตัวอักษร)');
        const done = Object.keys(used).map(function (tab) { lotCancelRows_(tab, used[tab], why, me); return tab + ' ' + used[tab].length; }).join(' · ');
        ensureTab_(LC.LOG, LC.HEAD);
        appendRows_(LC.LOG, [{ LogID: id8_(), Time: new Date(), By: by_(me), ProductionID: str_(pid), Lot_Number: str_(r.Lot_Number), ProductID: str_(r.ProductID),
          State_Before: str_(r.State), Reason: why, Rows_Cancelled: done }]);
      }
      set.Cancelled = true;
    }
    setCells_(CFG.T.LOT, r._row, set);
    return { before: str_(r.State) };
  });
  // the main script's PRODUCTION_LOT_FINISHED + PRODUCTION_LOT_KPI only recalculates that lot's KPI (checked 25 Oct), so it is also used after a Batch change
  if (x.state === 'Finished' || x.batch != null || x.inputs) hook_({ action: 'PRODUCTION_LOT_FINISHED', module: 'PRODUCTION_LOT_KPI', productionID: String(pid), rowID: String(pid), requestedBy: by_(me) });
  return { ok: true, before: res.before };
}

// Lot_Input_Log: every Fat / Flavour / Pre-con / Color save (before → after); Source 'manual' now, room for 'scada' later (user: SCADA values
// can be lost on a power cut or a wrong save, so they are typed for now)
const LI = { LOG: 'Lot_Input_Log', COLS: [['fat', 'Total_Fat_kg', 'Fat', 'Fat_kg'], ['flavour', 'Total_Flavour_kg', 'Flavour', 'Flavour_kg'], ['precon', 'Total_Pre-con_kg', 'Pre-con', 'PreCon_kg'], ['color', 'Total_Color_kg', 'Color', 'Color_kg'], ['reuse', 'NCP_Reuse_kg', 'NCP Reuse', 'NCP_Reuse_kg'], ['ncpUse', 'NCP_Usage_kg', 'NCP Usage', 'NCP_Usage_kg'], ['oldSemi', 'Old_Semi', 'Old Semi', 'Old_Semi_kg'], ['pcb', 'PC_Before', 'PC Before', 'PC_Before', 'int'], ['pca', 'PC_After', 'PC After', 'PC_After', 'int']] };
LI.HEAD = ['LogID', 'Time', 'By', 'ProductionID', 'Lot_Number', 'Source', 'Fat_kg', 'Flavour_kg', 'PreCon_kg', 'Color_kg', 'Fat_kg_Before', 'Flavour_kg_Before', 'PreCon_kg_Before', 'Color_kg_Before', 'Note', 'NCP_Reuse_kg', 'NCP_Reuse_kg_Before', 'NCP_Usage_kg', 'NCP_Usage_kg_Before', 'Old_Semi_kg', 'Old_Semi_kg_Before', 'PC_Before', 'PC_Before_Before', 'PC_After', 'PC_After_Before'];
function lotInputLog(token, pid) {
  cacheOn_();
  session_(token);
  if (!ss_().getSheetByName(LI.LOG)) return [];
  return table_(LI.LOG).rows.filter(function (r) { return str_(r.ProductionID) === str_(pid); }).map(function (r) {
    const t = date_(r.Time); return { t: t ? t.getTime() : null, by: str_(r.By), src: str_(r.Source), fat: num_(r.Fat_kg), flavour: num_(r.Flavour_kg), precon: num_(r.PreCon_kg), color: num_(r.Color_kg), reuse: num_(r.NCP_Reuse_kg), ncpUse: num_(r.NCP_Usage_kg), oldSemi: num_(r.Old_Semi_kg), pcb: num_(r.PC_Before), pca: num_(r.PC_After), note: str_(r.Note) };
  }).reverse();
}

// ---------- ProductID / Lot_Number / Extruder_Number the same in every table (user 31 Oct 07:43) ----------
// child rows are found by ProductionID; Production_Lot is the truth. Every cell changed is written to Lot_Key_Log (old → new) so it can be undone.
const LK = { TABS: ['Grinding_Setup', 'Grinding_Runtime', 'Grinding_Records', 'Grinding_Fineness', 'Coater_Records', 'Moisture', 'NCP', 'Extruder_Runtime', 'Batching_Formula', 'Mix_Weigh'],
  LOG: 'Lot_Key_Log', HEAD: ['LogID', 'Time', 'By', 'ProductionID', 'Action', 'Tab', 'Row', 'Column', 'Old', 'New', 'Reason'] };
// a child on one line of an EXT-1+2 lot is right
function lkExtOk_(child, master) {
  if (!child || child === master) return true;
  if (master.indexOf('+') < 0) return false;
  const nums = master.replace(/^EXT-/, '').split('+'); return nums.indexOf(child.replace(/^EXT-/, '')) >= 0;
}
// changes that make the child rows of the lots in want = {pid: {lot, prod, ext}} match; pids = null → every lot given
function lkPlan_(want) {
  const out = [];
  LK.TABS.forEach(function (tab) {
    if (!ss_().getSheetByName(tab)) return;
    const T = table_(tab); if (T.h.indexOf('ProductionID') < 0) return;
    const lc = T.h.indexOf('Lot_Number') >= 0 ? 'Lot_Number' : T.h.indexOf('Lot_No') >= 0 ? 'Lot_No' : null;
    T.rows.forEach(function (r) {
      const w = want[str_(r.ProductionID)]; if (!w) return;
      const ch = {};
      // a blank value in Production_Lot (old lots have no Extruder_Number) says nothing → that column is left alone
      if (lc && w.lot && str_(r[lc]) && str_(r[lc]).replace(/^'/, '') !== w.lot) ch[lc] = tab === MX.TAB ? "'" + w.lot : w.lot;
      if ('ProductID' in r && w.prod && str_(r.ProductID) && str_(r.ProductID) !== w.prod) ch.ProductID = w.prod;
      let ext = str_(r.Extruder_Number);
      if ('Extruder_Number' in r && w.ext && ext && !lkExtOk_(ext, w.ext)) { ch.Extruder_Number = w.ext; ext = w.ext; }
      if ('LotProductKey' in r && str_(r.LotProductKey)) {
        const k = str_(r.LotProductKey).split('|'); if (w.lot) k[0] = w.lot; if (k.length > 1 && w.prod) k[1] = w.prod; if (k.length > 2 && k[2] && (ext || w.ext)) k[2] = ext || w.ext;
        if (k.join('|') !== str_(r.LotProductKey)) ch.LotProductKey = k.join('|');
      }
      Object.keys(ch).forEach(function (c) { out.push({ pid: str_(r.ProductionID), tab: tab, row: r._row, col: c, old: r[c] instanceof Date ? r[c].toISOString() : str_(r[c]), val: ch[c] }); });
    });
  });
  return out;
}
function lkCount_(plan) {
  const by = {}; plan.forEach(function (c) { const b = by[c.tab] = by[c.tab] || { rows: {}, cells: 0, cols: {} }; b.rows[c.row] = 1; b.cells++; b.cols[c.col] = 1; });
  return Object.keys(by).map(function (t) { return { tab: t, rows: Object.keys(by[t].rows).length, cells: by[t].cells, cols: Object.keys(by[t].cols) }; });
}
function lkApply_(plan, me, action, reason) {
  if (!plan.length) return;
  // one read of each tab, then plain cell writes (setCells_ would re-read the whole tab for every row)
  const tabs = {}; plan.forEach(function (c) { (tabs[c.tab] = tabs[c.tab] || []).push(c); });
  Object.keys(tabs).forEach(function (tab) {
    const T = table_(tab);
    tabs[tab].forEach(function (c) { const i = T.h.indexOf(c.col); if (i >= 0) T.sh.getRange(c.row, i + 1).setValue(c.val); });
    delete TABLES_[tab]; wrote_(tab);
  });
  ensureTab_(LK.LOG, LK.HEAD);
  const now = new Date();
  appendRows_(LK.LOG, plan.map(function (c) { return { LogID: id8_(), Time: now, By: by_(me), ProductionID: c.pid, Action: action, Tab: c.tab, Row: c.row, Column: c.col, Old: "'" + c.old, New: "'" + String(c.val).replace(/^'/, ''), Reason: str_(reason).slice(0, 300) }; }));
}
// x = {productID?, lot?, ext?, reason, dry}; dry → what would change, nothing written
function editLotKey(token, pid, x) {
  const me = session_(token, 'work');
  x = x || {};
  const run = function () {
    delete TABLES_[CFG.T.LOT];
    const r = lotRows_().find(function (v) { return str_(v.ProductionID) === str_(pid); }); if (!r) throw new Error('ไม่พบ Lot');
    const old = { lot: str_(r.Lot_Number), prod: str_(r.ProductID), ext: str_(r.Extruder_Number) };
    const w = { lot: x.lot != null ? str_(x.lot).toUpperCase().trim() : old.lot, prod: x.productID != null ? str_(x.productID).trim() : old.prod, ext: x.ext != null ? str_(x.ext).trim() : old.ext };
    if (w.lot === old.lot && w.prod === old.prod && w.ext === old.ext) throw new Error('ยังไม่ได้เปลี่ยน Product / Lot / Ext');
    if (!/^\d{9}(-PC)?$/.test(w.lot)) throw new Error('เลข Lot ต้องเป็น YYMMDD + 3 หลัก (เช่น 261026049) หรือต่อท้าย -PC');
    if (!productsAll_().some(function (p) { return p.id === w.prod && !p.cancelled; })) throw new Error('ไม่พบ Product ' + w.prod);
    if (CFG.EXTRUDERS.indexOf(w.ext) < 0) throw new Error('เลือก Extruder');
    const same = lotRows_().filter(function (v) { return str_(v.ProductionID) !== str_(pid) && str_(v.Lot_Number).toUpperCase() === w.lot && !truthy_(v.Cancelled); });
    if (same.some(function (v) { return str_(v.Extruder_Number) === w.ext; })) throw new Error('มี Lot ' + w.lot + ' ของ ' + w.ext + ' อยู่แล้ว');
    if (same.some(function (v) { return str_(v.ProductID) !== w.prod; })) throw new Error('Lot ' + w.lot + ' ใช้กับ Product อื่นแล้ว');
    const wantMap = {}; wantMap[str_(pid)] = w;
    const kids = lkPlan_(wantMap);
    const master = [];
    if (w.lot !== old.lot) master.push({ col: 'Lot_Number', old: old.lot, val: w.lot });
    if (w.prod !== old.prod) master.push({ col: 'ProductID', old: old.prod, val: w.prod });
    if (w.ext !== old.ext) master.push({ col: 'Extruder_Number', old: old.ext, val: w.ext });
    const key = w.lot + '|' + w.prod + '|' + w.ext; if (str_(r.LotProductKey) !== key) master.push({ col: 'LotProductKey', old: str_(r.LotProductKey), val: key });
    const res = { old: old, now: w, master: master.map(function (m) { return m.col; }), tabs: lkCount_(kids), cells: kids.length };
    if (x.dry) return res;
    if (!str_(x.reason)) throw new Error('ใส่เหตุผลที่แก้');
    const plan = master.map(function (m) { return { pid: str_(pid), tab: CFG.T.LOT, row: r._row, col: m.col, old: m.old, val: m.val }; }).concat(kids);
    lkApply_(plan, me, 'edit', x.reason);
    setCells_(CFG.T.LOT, r._row, { UpdatedTimestamp: new Date() });
    console.log('editLotKey ' + old.lot + ' → ' + w.lot + ' / ' + w.prod + ' / ' + w.ext + ': ' + kids.length + ' cells by ' + me.Name);
    res.saved = true; return res;
  };
  const res = x.dry ? run() : withLock_(run);
  if (res.saved) hook_({ action: 'PRODUCTION_LOT_FINISHED', module: 'PRODUCTION_LOT_KPI', productionID: String(pid), rowID: String(pid), requestedBy: by_(me) });
  return res;
}
// lots whose child rows do not match Production_Lot
function lkScan_() {
  const want = {}, info = {};
  lotRows_().forEach(function (r) { if (truthy_(r.Cancelled) || !str_(r.ProductionID)) return; const pid = str_(r.ProductionID);
    want[pid] = { lot: str_(r.Lot_Number), prod: str_(r.ProductID), ext: str_(r.Extruder_Number) }; info[pid] = { state: str_(r.State) }; });
  const plan = lkPlan_(want), by = {};
  plan.forEach(function (c) { (by[c.pid] = by[c.pid] || []).push(c); });
  return { want: want, info: info, by: by };
}
function lotKeyCheck(token) {
  session_(token, 'work');
  const S = lkScan_();
  return Object.keys(S.by).map(function (pid) {
    const P = S.by[pid], olds = {};
    P.forEach(function (c) { if (c.col !== 'LotProductKey') { const k = c.col + ': ' + c.old.replace(/^'/, ''); olds[k] = (olds[k] || 0) + 1; } });
    return { pid: pid, lot: S.want[pid].lot, prod: S.want[pid].prod, ext: S.want[pid].ext, state: S.info[pid].state, cells: P.length, keyOnly: !Object.keys(olds).length, olds: olds, tabs: lkCount_(P) };
  }).sort(function (a, b) { return a.lot < b.lot ? -1 : 1; });
}
// pids = [...] or 'all'; LotProductKey alone (format only) is left as it is unless keys = true
function lotKeyFix(token, pids, keys) {
  const me = session_(token, 'work');
  return withLock_(function () { return lkFix_(me, pids, keys, 'sync'); });
}
function lkFix_(me, pids, keys, action) {
  const S = lkScan_(), list = pids === 'all' ? Object.keys(S.by) : (pids || []).map(String);
  let plan = []; list.forEach(function (pid) { plan = plan.concat(S.by[pid] || []); });
  if (!keys) { const real = {}; plan.forEach(function (c) { if (c.col !== 'LotProductKey') real[c.tab + '#' + c.row] = 1; }); plan = plan.filter(function (c) { return c.col !== 'LotProductKey' || real[c.tab + '#' + c.row]; }); }
  lkApply_(plan, me, action, 'ทำให้ตรงกับ Production_Lot');
  console.log('lotKeyFix ' + list.length + ' lots ' + plan.length + ' cells by ' + me.Name);
  return { lots: Object.keys(plan.reduce(function (a, c) { a[c.pid] = 1; return a; }, {})).length, cells: plan.length, tabs: lkCount_(plan) };
}
// run once from the editor (31 Oct, user: "แก้เลย"): every lot whose child rows do not match Production_Lot
function fixLotKeysNow() { const r = lkFix_({ Name: 'editor (Claude)' }, 'all', false, 'sync'); console.log(JSON.stringify(r)); return r; }

// Everything the lot page shows, read in one call
function lotSummary(token, pid) {
  cacheOn_();
  session_(token);
  const names = products_(), r = lotRows_().find(function (v) { return str_(v.ProductionID) === str_(pid); });
  if (!r) throw new Error('ไม่พบ Lot');
  const lot = lotOut_(r, names), prod = productsAll_().find(function (p) { return p.id === lot.productID; }) || {};
  const kpi = {}; ['Total_Batch_kg', 'NCP_Usage_kg', 'Total_Fat_kg', 'Total_Flavour_kg', 'Total_Pre-con_kg', 'Total_Color_kg', 'Total_Input', 'Total_Coat', 'Total_NCP', 'Total_FG',
    'Total_Output', 'Total_SEMI', 'Total_Packed', 'Hold_Balance_kg', 'Old_Semi', 'NCP_Reuse_kg', 'Yield', 'Loss', 'Productivity'].forEach(function (k) { kpi[k] = num_(r[k]); });
  const startExt = date_(r.Start_Extruder_Date);
  const of = function (t) { return live_(t).filter(function (v) { return str_(v.ProductionID) === lot.pid; }); };
  // grinding
  const W = world_(), recs = W.rec.by[lot.pid] || [];
  const setups = of(CFG.T.SETUP).map(function (s) { return { m: str_(s.Machine), flow: str_(s.Grinding_Flow), s1: str_(s.Screen_Size_1), s2: str_(s.Screen_Size_2), blade: str_(s.Blade_No), angle: str_(s.Blade_Angle) }; });
  const used = [];
  ['ATOM-3', 'ATOM-1', 'ATOM-2', 'PUL-1'].forEach(function (m) {
    const kgBy = {};
    W.alloc[m].forEach(function (a) {
      if (a[1] !== lot.lot) return;
      let k = '';
      if (m === 'PUL-1') { const p = W.parts.find(function (q) { return q.machine === m && q.part === 'Blade' && q.s <= a[0] && (!q.e || a[0] < q.e); }); k = p ? 'ใบ #' + p.no : '—'; }
      else { const t = W.tools.find(function (q) { return q.machine === m && q.s <= a[0] && (!q.e || a[0] < q.e); }); k = t ? '#' + t.no + '|' + t.angle : '—'; }
      kgBy[k] = (kgBy[k] || 0) + a[2];
    });
    Object.keys(kgBy).forEach(function (k) { if (kgBy[k] >= 50) { const p = k.split('|'); used.push({ m: m, set: p[0], angle: p[1] || '', kg: Math.round(kgBy[k]), approx: m !== 'ATOM-3' }); } });
  });
  const ground = recs.length ? recs[recs.length - 1].w : 0;
  // coater: kg per record = Total_Weight − previous of the lot
  const coat = of(CFG.T.COAT).map(function (c) { const t = date_(c.DateTimeRecords); return { t: t ? t.getTime() : 0, w: num_(c.Total_Weight) || 0, last: truthy_(c.Last_Coat) }; })
    .filter(function (c) { return c.t; }).sort(function (a, b) { return a.t - b.t; });
  let prevW = 0, prevT = null; const coatRows = coat.map(function (c) { const kg = c.w - prevW, mins = prevT ? (c.t - prevT) / MIN : null; prevW = c.w; prevT = c.t; return { t: c.t, w: c.w, kg: kg, rate: mins && mins <= 180 ? kg / mins * 60 : null, last: c.last }; });
  // moisture
  const moist = of(CFG.T.MOIST).map(function (m) { const t = date_(m.DateTime); return { t: t ? t.getTime() : 0, p: str_(m.Process), v: num_(m.Moisture) }; }).filter(function (m) { return m.v != null; });
  const mstat = {}; ['Dyer', 'Cooler'].forEach(function (p) { const v = moist.filter(function (m) { return m.p === p; }).map(function (m) { return m.v; });
    mstat[p] = v.length ? { n: v.length, avg: v.reduce(function (a, b) { return a + b; }, 0) / v.length, min: Math.min.apply(null, v), max: Math.max.apply(null, v),
      below: v.filter(function (x) { return prod.lcl != null && x < prod.lcl; }).length, above: v.filter(function (x) { return prod.ucl != null && x > prod.ucl; }).length } : null; });
  // ncp by process
  const ncp = {}; of(CFG.T.NCP).forEach(function (n) { const p = str_(n.Process) || '—'; ncp[p] = (ncp[p] || 0) + (num_(n.Weight_Kg) != null ? num_(n.Weight_Kg) : (num_(n.Weight) || 0)); });
  const runs = {}; CFG.MACHINES.forEach(function (m) { runs[m] = Math.round(W.run[m].filter(function (e) { return e.lot === lot.lot && e.run; }).reduce(function (a, e) { return a + (e.end - e.t); }, 0) / MIN); });
  const checks = [];
  if (!kpi.Total_Batch_kg) checks.push(['warn', 'ยังไม่มี Total_Batch']); else checks.push(['ok', 'Batch ' + Math.round(kpi.Total_Batch_kg).toLocaleString() + ' kg']);
  if (kpi.Total_Batch_kg && ground) { const diff = ground - kpi.Total_Batch_kg; checks.push([Math.abs(diff) > CFG.BATCH_GRIND_WARN_KG ? 'warn' : 'ok', 'ยอดบดเทียบ Batch ' + (diff >= 0 ? '+' : '') + Math.round(diff).toLocaleString() + ' kg']); }
  if (!setups.length) checks.push(['warn', 'ยังไม่ตั้งค่าโม่']);
  if (recs.length) { const fr = fineOnce_(fineRows_().filter(function (f) { return f.pid === lot.pid; })), rg = fr.filter(function (f) { return /re-?grind/i.test(f.result); }).length;
    checks.push([fr.length && !rg ? 'ok' : 'warn', fr.length ? 'ความละเอียด ' + fr.length + ' ค่า' + (rg ? ' · Re-Grinding ' + rg : '') : 'ยังไม่มีค่าความละเอียด']); }
  if (coatRows.length) checks.push([coatRows.some(function (c) { return c.last; }) ? 'ok' : 'warn', coatRows.some(function (c) { return c.last; }) ? 'Coat ครบ (Last coat)' : 'Coat ยังไม่จบ']);
  if (mstat.Cooler && prod.cl != null) checks.push([mstat.Cooler.avg < prod.cl - 0.3 ? 'warn' : 'ok', 'ความชื้น Cooler เฉลี่ย ' + mstat.Cooler.avg.toFixed(2) + '% (CL ' + prod.cl + ')']);
  return { lot: lot, product: { id: prod.id, size: prod.size, cap: prod.cap, lcl: prod.lcl, cl: prod.cl, ucl: prod.ucl }, kpi: kpi, startExt: startExt ? startExt.getTime() : null,
    fineness: (function () { const fr = fineRows_().filter(function (f) { return f.pid === lot.pid; }); const st = fineStat_(fineOnce_(fr));
      st.byMachine = {}; FINE.MACHINES.forEach(function (mm) { const x = fr.filter(function (f) { return f.m === mm; }); if (x.length) st.byMachine[mm] = fineStat_(x); }); return st; })(),
    grinding: { records: recs.length, first: recs.length ? recs[0].t : null, last: recs.length ? recs[recs.length - 1].t : null, ground: ground, setups: setups, used: used, runMin: runs, bins: gbLot_(lot.pid, null, W.rec) },
    coater: { rows: coatRows, total: coat.length ? coat[coat.length - 1].w : 0 }, moisture: mstat, ncp: ncp, checks: checks, states: CFG.STATES,
    mix: (function () { const mx = mixLot_(lot.pid, lot.lot, kpi.Total_Batch_kg, ground, mxRecs_());
      if (mx.n) checks.push(['ok', 'Mix หลังบด ' + mx.n + ' ครั้ง ' + Math.round(mx.kg).toLocaleString() + ' kg' + (mx.loss != null ? ' · loss ' + Math.round(mx.loss).toLocaleString() + ' kg (' + mx.lossPct + '%)' : '')]);
      return mx; })() };
}

// =====================================================================
// Phase 3 — Coater record (user 25 Oct 11:33: "ทำ coater ได้เลย")
// Coater_Records: Total_Weight = running total of the lot on that line. Main script fills PrevDT / PrevWeight /
// DeltaMinutes / Capacity / RecalcAt / RecalcStatus via webhook COATER_REALTIME (rowID, productionID).
// =====================================================================
const COAT = { LINES: ['EXT-1', 'EXT-2'], GAP_MIN: 180, MAX_KG_HR: 10000 };
function coatRows_() {
  return live_(CFG.T.COAT).map(function (c) {
    const t = date_(c.DateTimeRecords);
    return { id: str_(c.ID), pid: str_(c.ProductionID), lot: str_(c.Lot_Number), productID: str_(c.ProductID), ext: str_(c.Extruder_Number),
      t: t ? t.getTime() : 0, w: num_(c.Total_Weight) || 0, last: truthy_(c.Last_Coat), memo: str_(c.Memo), row: c._row, visible: str_(c.Visible) === '' || truthy_(c.Visible) };
  }).filter(function (c) { return c.t && c.visible; });
}
// per lot+line: sort, kg = Δ total (first = its own total), rate over the gap (≤ GAP_MIN)
function coatSeries_(rows) {
  const by = {};
  rows.forEach(function (c) { const k = c.pid + '|' + c.ext; (by[k] = by[k] || []).push(c); });
  Object.keys(by).forEach(function (k) {
    let p = null;
    by[k].sort(function (a, b) { return a.t - b.t; }).forEach(function (c) {
      c.kg = p ? c.w - p.w : c.w; c.mins = p ? (c.t - p.t) / MIN : null;
      c.rate = c.mins && c.mins <= COAT.GAP_MIN && c.mins > 0 ? c.kg / c.mins * 60 : null; c.prevT = p ? p.t : null; p = c;
    });
  });
  return by;
}
function lineOf_(ext) { return ext === 'EXT-1+2' ? COAT.LINES : [ext]; }
// Coater page realtime (user 9 Nov 2026): the page asks every 5 s. Reads only the sheet size + an edit mark (no rows), so it is cheap;
// a new row from this app or AppSheet, or an edit here, changes it → the page reloads the board with fresh = true.
function coaterStamp(token) {
  session_(token);
  const sh = rawSs_().getSheetByName(CFG.T.COAT);
  return (sh ? sh.getLastRow() : 0) + '|' + (CacheService.getScriptCache().get('coat_v') || '');
}
// Every page realtime (user 9 Nov 2026): the page asks every 5 s. Reads only the sheet sizes + a web-edit mark (no rows).
// A tab whose size changed (new row from AppSheet or another app) has its 2-min copy dropped here, so the reload that follows is fresh.
const LIVE = { TABS: ['Production_Lot', 'Grinding_Setup', 'Grinding_Runtime', 'Grinding_Records', 'Grinding_Fineness', 'Grinding_Tool_Life', 'Coater_Records', 'NCP', 'Moisture', 'Extruder_Runtime'] };
// AppSheet แก้แถวเดิม (user 10 Nov 2026): จำนวนแถวไม่เปลี่ยน แต่ UpdatedTimestamp เปลี่ยน → ค่าใหม่สุดของ UpdatedTimestamp ใน TAIL แถวท้าย
// ของแต่ละแท็บเป็นส่วนหนึ่งของ stamp · คำนวณครั้งเดียวต่อ EVERY วิ ใช้ร่วมทุกเครื่อง (CacheService) ไม่อ่านซ้ำทุกคน
const EDMARK = { TAIL: 400, EVERY: 5, COLS: ['UpdatedTimestamp', 'Updated_At', 'UpdatedAt'] };
function edMarks_(tabs, ssFn) {
  const c = CacheService.getScriptCache(), key = 'edm_' + tabs.join(',').length + '_' + tabs.length, hit = c.get(key);
  if (hit) return hit.split('.');
  const out = tabs.map(function (t) {
    try {
      const sh = ssFn().getSheetByName(t); if (!sh) return '0';
      const last = sh.getLastRow(); if (last < 2) return '0';
      let col = Number(c.get('edc_' + t) || 0);
      if (!col) {
        const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (x) { return String(x).trim(); });
        col = -1; EDMARK.COLS.some(function (k) { const i = h.indexOf(k); if (i >= 0) { col = i + 1; return true; } return false; });
        c.put('edc_' + t, String(col), 21600);
      }
      if (col < 1) return '0';
      const n = Math.min(EDMARK.TAIL, last - 1); let m = 0;
      sh.getRange(last - n + 1, col, n, 1).getValues().forEach(function (r) { const d = r[0] instanceof Date ? r[0].getTime() : 0; if (d > m) m = d; });
      return m.toString(36);
    } catch (e) { return '0'; }
  });
  c.put(key, out.join('.'), EDMARK.EVERY);
  return out;
}
function liveStamp(token) {
  session_(token);
  const c = CacheService.getScriptCache(), keys = LIVE.TABS.map(function (t) { return 'ls_' + t; }), put = {}, ed = edMarks_(LIVE.TABS, rawSs_);
  const n = LIVE.TABS.map(function (t, i) {
    const sh = rawSs_().getSheetByName(t), v = String(sh ? sh.getLastRow() : 0) + ':' + (ed[i] || '0');   // แถวเพิ่ม หรือแถวเดิมถูกแก้ → stamp เปลี่ยน
    put[keys[i]] = v; return v;
  });
  put.ls_at = String(Date.now());
  c.putAll(put, 21600);
  tcSetStamps_(n);
  try { tcRefresh_(TC.POLL_MS); } catch (e) { console.warn('cache refresh: ' + e.message); }   // แท็บที่เปลี่ยน → อ่านมาใส่ cache ให้คนถัดไป
  return n.join('.') + '|' + (c.get('live_v') || '');
}
// stamp of each LIVE tab = <last row>:<edit mark>#<app write mark>; one per execution. From the last liveStamp (any device) when it ran
// within FRESH_LS, else read now (row counts + edit marks, ~1–3 s — still far less than reading the tabs)
function tcStamps_(fresh) {
  if (TC_ST_ && (!fresh || TC_ST_.fresh)) return TC_ST_;
  const c = CacheService.getScriptCache();
  if (!fresh && Date.now() - Number(c.get('ls_at') || 0) < TC.FRESH_LS) {
    const g = c.getAll(LIVE.TABS.map(function (t) { return 'ls_' + t; }));
    if (LIVE.TABS.every(function (t) { return g['ls_' + t] != null; })) return tcSetStamps_(LIVE.TABS.map(function (t) { return g['ls_' + t]; }), false);
  }
  const ed = edMarks_(LIVE.TABS, rawSs_), put = {};
  const v = LIVE.TABS.map(function (t, i) { const sh = rawSs_().getSheetByName(t); return (put['ls_' + t] = String(sh ? sh.getLastRow() : 0) + ':' + (ed[i] || '0')); });
  put.ls_at = String(Date.now()); c.putAll(put, 21600);
  return tcSetStamps_(v);
}
function tcSetStamps_(v, fresh) {
  const wv = CacheService.getScriptCache().getAll(LIVE.TABS.map(function (t) { return 'wv_' + t; })), o = { fresh: fresh !== false };
  LIVE.TABS.forEach(function (t, i) { o[t] = v[i] + '#' + (wv['wv_' + t] || '0'); });
  return (TC_ST_ = o);
}
// end of a write: the Sheet is committed first, then the tab's cached copy stops matching (an edit that keeps the row count and
// UpdatedTimestamp still counts)
function tcMark_() {
  const tabs = Object.keys(TC_DIRTY_).filter(function (t) { return LIVE.TABS.indexOf(t) >= 0; }); TC_DIRTY_ = {};
  if (!tabs.length) return;
  try { SpreadsheetApp.flush(); const o = {}, v = Date.now().toString(36); tabs.forEach(function (t) { o['wv_' + t] = v; }); CacheService.getScriptCache().putAll(o, 21600); TC_ST_ = null; }
  catch (e) { console.warn('cache mark: ' + e.message); }
}
// put changed / old tabs into the cache (one job at a time across devices; stops after `budget` ms, the rest next time)
const TC_WARM = ['Product_Detail', 'RuntimeType', 'Grinding_Part_Life'];
function tcRefresh_(budget) {
  const t0 = Date.now(), c = CacheService.getScriptCache(), me = Utilities.getUuid(), out = [];
  if (c.get('tc_busy')) return 'busy';
  c.put('tc_busy', me, 90); if (c.get('tc_busy') !== me) return 'busy';
  try {
    const st = tcStamps_(true), tabs = LIVE.TABS.concat(TC_WARM, [CFG.USERS]), heads = c.getAll(tabs.map(function (t) { return TC.P + t; })), now = Date.now();
    const need = tabs.map(function (t) {
      const h = heads[TC.P + t], p = (h || '').split('|'), live = LIVE.TABS.indexOf(t) >= 0;
      return { t: t, live: live, pri: !h || (live && p[2] !== st[t]) ? 2 : now - Number(p[3] || 0) > TC.REFRESH_AGE ? 1 : 0 };
    }).filter(function (x) { return x.pri; }).sort(function (a, b) { return b.pri - a.pri; });
    for (let i = 0; i < need.length; i++) {
      if (Date.now() - t0 > budget) { out.push('+' + (need.length - i)); break; }
      const t = need[i].t, sh = t === CFG.USERS ? usersSheet_() : rawSs_().getSheetByName(t); if (!sh) continue;
      tcPut_(t, sh.getDataRange().getValues(), need[i].live ? st[t] : '');
      out.push(t);
    }
  } finally { if (c.get('tc_busy') === me) c.remove('tc_busy'); }
  return out.join(',');
}
function coaterBoard(token, day, fresh) {
  if (fresh) tcDel_(CFG.T.COAT); // re-read Coater_Records only; other tabs may come from the 2-min copy
  cacheOn_();
  session_(token);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? day : prodDay_(Date.now());
  const S = new Date(d + 'T08:00:00+07:00').getTime(), E = S + 24 * HOUR;
  const lots = lots_(), prods = {}; productsAll_().forEach(function (p) { prods[p.id] = p; });
  const by = coatSeries_(coatRows_());
  const lines = COAT.LINES.map(function (ext) {
    const series = Object.keys(by).filter(function (k) { return lineOf_(k.split('|')[1]).indexOf(ext) >= 0; }).map(function (k) { return by[k]; });
    const all = [].concat.apply([], series).sort(function (a, b) { return a.t - b.t; });
    const last = all[all.length - 1] || null;
    const hours = []; for (let i = 0; i < 24; i++) hours.push(0);
    const inDay = all.filter(function (c) { return c.t > S && c.t <= E; });
    inDay.forEach(function (c) { hours[Math.min(23, Math.floor((c.t - 1 - S) / HOUR))] += c.kg; });
    const perLot = series.map(function (L) {
      const x = L.filter(function (c) { return c.t > S && c.t <= E; }); if (!x.length) return null;
      const kg = x.reduce(function (a, c) { return a + c.kg; }, 0), mins = x.reduce(function (a, c) { return a + (c.rate != null ? c.mins : 0); }, 0), kgR = x.reduce(function (a, c) { return a + (c.rate != null ? c.kg : 0); }, 0);
      const p = prods[x[0].productID] || {};
      return { pid: x[0].pid, lot: x[0].lot, name: p.name || x[0].productID, from: x[0].prevT || x[0].t, to: x[x.length - 1].t, kg: Math.round(kg),
        rate: mins ? Math.round(kgR / mins * 60) : null, std: p.cap || null, last: L.some(function (c) { return c.last; }) && x.some(function (c) { return c.last; }) };
    }).filter(Boolean).sort(function (a, b) { return a.from - b.from; });
    // lots that can be coated on this line now: State Batching/Extruder/Packing, extruder matches, no Last_Coat yet on this line
    const open = Object.keys(lots).map(function (k) { return lots[k]; }).filter(function (l) {
      if (['Batching', 'Extruder', 'Packing'].indexOf(l.state) < 0 || lineOf_(l.ext).indexOf(ext) < 0) return false;
      const L = by[l.pid + '|' + l.ext] || []; return !L.some(function (c) { return c.last; });
    }).map(function (l) { const L = by[l.pid + '|' + l.ext] || [], z = L[L.length - 1];
      return { pid: l.pid, lot: l.lot, name: l.name, state: l.state, total: z ? z.w : 0, lastT: z ? z.t : null, n: L.length, std: (prods[l.productID] || {}).cap || null };
    }).sort(function (a, b) { return (b.lastT || 0) - (a.lastT || 0) || b.lot.localeCompare(a.lot); });
    const kgDay = inDay.reduce(function (a, c) { return a + c.kg; }, 0), runMin = inDay.reduce(function (a, c) { return a + (c.rate != null ? c.mins : 0); }, 0);
    return { ext: ext, hours: hours.map(Math.round), kg: Math.round(kgDay), runH: Math.round(runMin / 6) / 10, perLot: perLot, open: open,
      last: last ? { lot: last.lot, t: last.t, w: last.w, lastCoat: last.last, rate: last.rate } : null };
  });
  return { day: d, start: S, lines: lines };
}
function coaterLot(token, pid) {
  cacheOn_();
  session_(token);
  const lot = lots_()[str_(pid)]; if (!lot) throw new Error('ไม่พบ Lot');
  const ext = lot.ext;
  const p = productsAll_().find(function (x) { return x.id === lot.productID; }) || {};
  const L = coatSeries_(coatRows_().filter(function (c) { return c.pid === lot.pid && c.ext === ext; }))[lot.pid + '|' + ext] || [];
  return { lot: lot, ext: ext, std: p.cap || null, rows: L.map(function (c) { return { id: c.id, t: c.t, w: c.w, kg: Math.round(c.kg), rate: c.rate == null ? null : Math.round(c.rate), last: c.last, memo: c.memo }; }) };
}
// x = {pid, w, t, last, memo} — Extruder_Number / LotProductKey come from the lot (same as the AppSheet formulas)
function saveCoater(token, x) {
  const me = session_(token, 'work');
  const lot = lots_()[str_(x.pid)]; if (!lot) throw new Error('เลือก Lot');
  const ext = lot.ext; if (!ext) throw new Error('Lot ' + lot.lot + ' ยังไม่มี Extruder_Number');
  const w = num_(x.w); if (w == null || w <= 0) throw new Error('ใส่ยอดสะสมบนตาชั่ง Coater');
  const t = checkTime_(new Date(Number(x.t)));
  const res = withLock_(function () {
    delete TABLES_[CFG.T.COAT];
    const L = coatSeries_(coatRows_().filter(function (c) { return c.pid === lot.pid && c.ext === ext; }))[lot.pid + '|' + ext] || [];
    const prev = L[L.length - 1];
    if (L.some(function (c) { return c.last; })) throw new Error('Lot นี้จบ Coat (Last coat) บน ' + ext + ' แล้ว — ยกเลิกแถวสุดท้ายก่อนถ้าจะบันทึกต่อ');
    if (prev) {
      if (t.getTime() <= prev.t) throw new Error('เวลาต้องหลังครั้งก่อน (' + fmt_(new Date(prev.t)) + ')');
      if (w < prev.w) throw new Error('น้อยกว่ายอดครั้งก่อน (' + prev.w.toLocaleString() + ' kg)');
      const mins = (t.getTime() - prev.t) / MIN;
      if (mins <= COAT.GAP_MIN && (w - prev.w) / mins * 60 > COAT.MAX_KG_HR) throw new Error('เพิ่มเกิน ' + COAT.MAX_KG_HR.toLocaleString() + ' kg/ชม. — ตรวจตัวเลข');
    }
    const id = id8_(), now = new Date();
    appendRows_(CFG.T.COAT, [{ ID: id, Extruder_Number: ext, Lot_Number: lot.lot, ProductID: lot.productID, DateTimeRecords: t, Total_Weight: w,
      CreateTimestamp: now, UpdatedTimestamp: now, Last_Coat: !!x.last, Memo: str_(x.memo), LotProductKey: lot.lot + '|' + lot.productID + '|' + lot.ext,
      ProductionID: lot.pid, Cancelled: false, NeedRecalc: true, Visible: true }]);
    return { id: id };
  });
  hook_({ action: 'COATER_REALTIME', rowID: res.id, productionID: lot.pid, requestedBy: by_(me) });
  if (x.last) hook_({ action: 'PRODUCTION_LOT_FINISHED', module: 'PRODUCTION_LOT_KPI', productionID: lot.pid, rowID: lot.pid, requestedBy: by_(me) });
  return { ok: true, id: res.id };
}
// cancel only the latest live record of its lot + line (typo fix)
function cancelCoater(token, id) {
  const me = session_(token, 'work');
  const r = withLock_(function () {
    delete TABLES_[CFG.T.COAT];
    const rows = coatRows_(), c = rows.find(function (v) { return v.id === str_(id); }); if (!c) throw new Error('ไม่พบแถว');
    const later = rows.some(function (v) { return v.pid === c.pid && v.ext === c.ext && v.t > c.t; });
    if (later) throw new Error('ยกเลิกได้เฉพาะแถวล่าสุดของ Lot');
    setCells_(CFG.T.COAT, c.row, { Cancelled: true, UpdatedTimestamp: new Date(), NeedRecalc: true });
    return c;
  });
  hook_({ action: 'COATER_REALTIME', rowID: r.id, productionID: r.pid, requestedBy: by_(me) });
  if (r.last) hook_({ action: 'PRODUCTION_LOT_FINISHED', module: 'PRODUCTION_LOT_KPI', productionID: r.pid, rowID: r.pid, requestedBy: by_(me) });
  return { ok: true };
}

// =====================================================================
// แก้ข้อมูลทั้ง Lot จากหน้า Lot (user 10 Nov 2026): Control / Admin แก้ Extruder runtime และ Coater record ของ Lot ไหนก็ได้
// (ย้อนหลังไม่จำกัด · เวลาเกินตอนนี้ไม่ได้) · NCP ใช้หน้าต่าง "NCP ของ Lot" เดิม · Lot ที่ Finished แล้ว → ส่งคำนวณ KPI ใหม่ทุกครั้งที่แก้
// Extruder_Runtime: แถวรูปแบบเดียวกับ AppSheet / Extruder Log (ID 8 หลัก · LotProductKey = Lot|ProductID|EXT · ไม่ลบแถว ยกเลิก = Cancelled TRUE)
// แล้วยิง webhook EXTRUDER_RUNTIME / REALTIME ตัวเดียวกับ AppSheet (หน้าเว็บเรียก lotRecalc แยก ผู้ใช้ไม่ต้องรอ)
// =====================================================================
const LE = { RT: 'Extruder_Runtime', GROUP: 'ext-runtime', TAIL: 3000, MAX_KG_HR: 10000 };
function leTime_(ms) {
  const t = new Date(Number(ms));
  if (!ms || isNaN(t)) throw new Error('เวลาไม่ถูกต้อง');
  if (t.getTime() > Date.now() + CFG.FUTURE_MIN * MIN) throw new Error('เวลาเกินตอนนี้ ' + CFG.FUTURE_MIN + ' นาที');
  t.setSeconds(0, 0);   // หน่วยนาที เหมือน AppSheet
  return t;
}
function leLot_(pid) { const lot = lots_()[str_(pid)]; if (!lot) throw new Error('ไม่พบ Lot (หรือ Lot ถูกยกเลิกแล้ว)'); return lot; }
function leExts_(lot) { return lot.ext === 'EXT-1+2' ? ['EXT-1', 'EXT-2'] : lot.ext ? [lot.ext] : ['EXT-1', 'EXT-2']; }
function leKpi_(pid, me) {
  const lot = lots_()[str_(pid)];
  if (lot && lot.state === 'Finished') { hook_({ action: 'PRODUCTION_LOT_FINISHED', module: 'PRODUCTION_LOT_KPI', productionID: lot.pid, rowID: lot.pid, requestedBy: by_(me) }); return true; }
  return false;
}
function leRtTypes_() {
  return live_(CFG.T.RTYPE).filter(function (r) { return str_(r.Group).toLowerCase() === LE.GROUP && str_(r.Process); })
    .map(function (r) { return { p: str_(r.Process), type: str_(r.Type) }; });
}
function leRtSheet_() {
  const sh = sheet_(LE.RT), h = {};
  sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].forEach(function (k, i) { if (str_(k)) h[str_(k)] = i; });
  return { sh: sh, h: h, w: sh.getLastColumn() };
}
// แถวที่ค่าในคอลัมน์ col ตรงกับ v ทั้งช่อง → [{row, v:[...]}] (อ่านเฉพาะช่วงแถวที่เจอ ไม่อ่านทั้งแท็บ)
function leFind_(T, col, v) {
  const last = T.sh.getLastRow(); if (last < 2 || T.h[col] === undefined) return [];
  const hits = T.sh.getRange(2, T.h[col] + 1, last - 1, 1).createTextFinder(String(v)).matchEntireCell(true).findAll().map(function (r) { return r.getRow(); });
  if (!hits.length) return [];
  const top = Math.min.apply(null, hits), n = Math.max.apply(null, hits) - top + 1, vals = T.sh.getRange(top, 1, n, T.w).getValues();
  return hits.map(function (r) { return { row: r, v: vals[r - top] }; });
}
function leRtOut_(T, x) {
  const v = x.v, h = T.h, t = date_(v[h.DateTime]);
  return { id: str_(v[h.ID]), row: x.row, t: t ? t.getTime() : 0, ext: str_(v[h.Extruder_Number]), p: str_(v[h.Process]), reason: str_(v[h.Reason]),
    pid: str_(v[h.ProductionID]), cancelled: truthy_(v[h.Cancelled]), dur: h.Duration_Min !== undefined ? num_(v[h.Duration_Min]) : null };
}
function lotRuntime(token, pid) {
  cacheOn_();
  const me = session_(token), lot = leLot_(pid), T = leRtSheet_();
  const rows = leFind_(T, 'ProductionID', lot.pid).map(function (x) { return leRtOut_(T, x); })
    .filter(function (r) { return r.pid === lot.pid && !r.cancelled && r.t; }).sort(function (a, b) { return a.t - b.t; });
  // นาที = Duration_Min ที่ระบบคำนวณ (ถ้ามี) ไม่งั้นนับถึงรายการถัดไปของเครื่องเดียวกันใน Lot นี้
  rows.forEach(function (r, i) { const n = rows.slice(i + 1).find(function (q) { return q.ext === r.ext; }); r.min = r.dur != null ? Math.round(r.dur) : n ? Math.round((n.t - r.t) / MIN) : null; delete r.row; delete r.pid; delete r.cancelled; delete r.dur; });
  return { lot: lot, exts: leExts_(lot), types: leRtTypes_(), rows: rows, canEdit: roleOk_(me.Role, 'work') };
}
// x = {pid, id, ext, t, p, reason} หรือ {pid, id, cancel:true} · id = 8 ตัว hex จากหน้าเว็บ (ส่งซ้ำ = ไม่เพิ่มซ้ำ)
function saveLotRuntime(token, x) {
  const me = session_(token, 'work');
  x = x || {};
  const id = str_(x.id).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error('รหัสรายการไม่ถูกต้อง — โหลดหน้าใหม่แล้วลองอีกครั้ง');
  const lot = leLot_(x.pid), exts = leExts_(lot);
  return withLock_(function () {
    const T = leRtSheet_(), h = T.h, hit = leFind_(T, 'ID', id)[0], now = new Date();
    if (x.cancel) {
      if (!hit) throw new Error('ไม่พบรายการนี้');
      const r = leRtOut_(T, hit); if (r.pid !== lot.pid) throw new Error('รายการนี้ไม่ใช่ของ Lot นี้');
      T.sh.getRange(hit.row, h.Cancelled + 1).setValue(true); T.sh.getRange(hit.row, h.UpdatedTimestamp + 1).setValue(now);
      wrote_(LE.RT);
      return { id: id, pid: lot.pid, ext: r.ext, boundaryId: leBoundary_(T, r.ext, r.t, id) };
    }
    const ext = str_(x.ext); if (exts.indexOf(ext) < 0) throw new Error('เลือกเครื่อง ' + exts.join(' / '));
    const p = str_(x.p); if (!leRtTypes_().some(function (q) { return q.p === p; })) throw new Error('เลือกสาเหตุ (ไม่พบ "' + p + '" ใน RuntimeType กลุ่ม Ext-Runtime)');
    const t = leTime_(x.t), reason = str_(x.reason).slice(0, 300);
    if (!hit) {   // เพิ่มใหม่
      const row = new Array(T.w).fill(''), put = function (k, v) { if (h[k] !== undefined) row[h[k]] = v; };
      put('ID', id); put('Extruder_Number', ext); put('Lot_Number', lot.lot); put('ProductID', lot.productID); put('DateTime', t); put('Process', p);
      put('Reason', reason); put('CreateTimestamp', now); put('UpdatedTimestamp', now); put('LotProductKey', [lot.lot, lot.productID, ext].join('|'));
      put('ProductionID', lot.pid); put('Cancelled', false); put('Visible', true);
      T.sh.appendRow(row); wrote_(LE.RT);
      return { id: id, pid: lot.pid, ext: ext, added: true };
    }
    const r = leRtOut_(T, hit); if (r.pid !== lot.pid) throw new Error('รายการนี้ไม่ใช่ของ Lot นี้');
    if (r.cancelled) throw new Error('รายการนี้ถูกยกเลิกแล้ว');
    const v = hit.v.slice();
    v[h.Extruder_Number] = ext; v[h.DateTime] = t; v[h.Process] = p; v[h.Reason] = reason; v[h.UpdatedTimestamp] = now;
    if (h.LotProductKey !== undefined) v[h.LotProductKey] = [lot.lot, lot.productID, ext].join('|');
    // เขียนเฉพาะช่วงคอลัมน์ที่แก้ ไม่แตะคอลัมน์ที่ระบบคำนวณเขียน (Duration ฯลฯ)
    const cols = ['Extruder_Number', 'DateTime', 'Process', 'Reason', 'UpdatedTimestamp', 'LotProductKey'].filter(function (k) { return h[k] !== undefined; }).map(function (k) { return h[k]; });
    const c0 = Math.min.apply(null, cols), c1 = Math.max.apply(null, cols);
    T.sh.getRange(hit.row, c0 + 1, 1, c1 - c0 + 1).setValues([v.slice(c0, c1 + 1)]);
    wrote_(LE.RT);
    const moved = r.ext !== ext || r.t !== t.getTime();
    return { id: id, pid: lot.pid, ext: ext, oldExt: r.ext, boundaryId: moved ? leBoundary_(T, r.ext, r.t, id) : '' };
  });
}
// แถวก่อนหน้าบนเครื่องเดิม (ก่อนเวลาเดิม) → สั่งคำนวณช่วงเดิมใหม่หลังย้าย / ยกเลิก (ระบบคำนวณหา Lot / เครื่องจากแถวที่ส่งไป)
function leBoundary_(T, ext, t0, id) {
  const h = T.h, last = T.sh.getLastRow(), n = Math.min(LE.TAIL, last - 1); if (n < 1) return '';
  let best = null;
  T.sh.getRange(last - n + 1, 1, n, T.w).getValues().forEach(function (v) {
    const t = date_(v[h.DateTime]); if (!t || str_(v[h.ID]) === id || truthy_(v[h.Cancelled]) || str_(v[h.Extruder_Number]) !== ext || t.getTime() > t0) return;
    if (!best || t.getTime() >= best.t) best = { id: str_(v[h.ID]), pid: str_(v[h.ProductionID]), t: t.getTime() };
  });
  return best ? best.id + '|' + best.pid : '';
}
// หลังบันทึก (หน้าเว็บเรียกแยก): runtime → คำนวณช่วงเวลา แล้ว KPI ถ้า Lot จบแล้ว · coater → COATER_REALTIME ของแถวที่ได้รับผล แล้ว KPI
function lotRecalc(token, r) {
  const me = session_(token, 'work'), out = [];
  r = r || {};
  if (r.kind === 'coat') (r.ids || []).forEach(function (id) { out.push(hook_({ action: 'COATER_REALTIME', rowID: String(id), productionID: str_(r.pid), requestedBy: by_(me) })); });
  else {
    const jobs = [[r.id, r.pid, r.ext]];
    if (r.boundaryId) { const b = String(r.boundaryId).split('|'); jobs.push([b[0], b[1], r.oldExt || r.ext]); }
    jobs.forEach(function (j) {
      for (let k = 0; k < 3; k++) {
        const res = UrlFetchApp.fetch(prop_('RECALC_URL') || CFG.HOOK_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          payload: JSON.stringify({ module: 'EXTRUDER_RUNTIME', action: 'REALTIME', rowID: String(j[0]), productionID: String(j[1]), extruderNumber: String(j[2]), eventType: 'ADD_UPDATE', requestedBy: by_(me) }) });
        if (res.getContentText().indexOf('SKIP_LOCK') < 0) { out.push(res.getResponseCode()); dbCalcBack_({ action: 'EXT_RUNTIME', rowID: String(j[0]) }); return; }
        Utilities.sleep(2000);
      }
      out.push('SKIP_LOCK');
    });
  }
  const kpi = r.kpi !== false && leKpi_(r.pid, me);
  return { jobs: out, kpi: kpi };
}

// ---------- Coater ของ Lot: ทุกแถวทุกไลน์ แก้ / ยกเลิกได้ทุกแถว ----------
function lotCoater(token, pid) {
  cacheOn_();
  const me = session_(token), lot = leLot_(pid), by = coatSeries_(coatRows_().filter(function (c) { return c.pid === lot.pid; }));
  const rows = [];
  Object.keys(by).forEach(function (k) { by[k].forEach(function (c) { rows.push({ id: c.id, ext: c.ext, t: c.t, w: c.w, kg: Math.round(c.kg), rate: c.rate == null ? null : Math.round(c.rate), last: c.last, memo: c.memo }); }); });
  rows.sort(function (a, b) { return a.t - b.t; });
  return { lot: lot, rows: rows, canEdit: roleOk_(me.Role, 'work') };
}
// x = {pid, id, t, w, last, memo} หรือ {pid, id, cancel:true} — Total_Weight เป็นยอดสะสม: ต้องไม่น้อยกว่าแถวก่อนหน้า และไม่มากกว่าแถวถัดไปของไลน์เดียวกัน
function saveLotCoater(token, x) {
  const me = session_(token, 'work');
  x = x || {};
  const lot = leLot_(x.pid);
  return withLock_(function () {
    delete TABLES_[CFG.T.COAT];
    const all = coatRows_().filter(function (c) { return c.pid === lot.pid; }), c = all.find(function (v) { return v.id === str_(x.id); });
    if (!c) throw new Error('ไม่พบแถว Coater (อาจถูกยกเลิกแล้ว)');
    const line = all.filter(function (v) { return v.ext === c.ext && v.id !== c.id; }).sort(function (a, b) { return a.t - b.t; });
    const nextOf = function (t) { return line.find(function (v) { return v.t > t; }); };
    const ids = [c.id], oldNext = nextOf(c.t); if (oldNext) ids.push(oldNext.id);
    if (x.cancel) {
      setCells_(CFG.T.COAT, c.row, { Cancelled: true, UpdatedTimestamp: new Date(), NeedRecalc: true });
      return { kind: 'coat', pid: lot.pid, ids: ids };
    }
    const w = num_(String(x.w == null ? '' : x.w).replace(/,/g, '')); if (w == null || w <= 0) throw new Error('ใส่ยอดสะสมบนตาชั่ง Coater');
    const t = leTime_(x.t), tm = t.getTime();
    if (line.some(function (v) { return v.t === tm; })) throw new Error('มีแถวเวลาเดียวกันบน ' + c.ext + ' แล้ว');
    const prev = line.filter(function (v) { return v.t < tm; }).pop(), next = nextOf(tm);
    if (prev && w < prev.w) throw new Error('น้อยกว่ายอดแถวก่อนหน้า (' + fmt_(new Date(prev.t)) + ' · ' + prev.w.toLocaleString() + ' kg)');
    if (next && w > next.w) throw new Error('มากกว่ายอดแถวถัดไป (' + fmt_(new Date(next.t)) + ' · ' + next.w.toLocaleString() + ' kg)');
    if (prev) { const mins = (tm - prev.t) / MIN; if (mins <= COAT.GAP_MIN && (w - prev.w) / mins * 60 > LE.MAX_KG_HR) throw new Error('เพิ่มเกิน ' + LE.MAX_KG_HR.toLocaleString() + ' kg/ชม. จากแถวก่อนหน้า — ตรวจตัวเลข'); }
    if (x.last && next) throw new Error('Last coat ต้องเป็นแถวสุดท้ายของไลน์ ' + c.ext);
    if (x.last && line.some(function (v) { return v.last; })) throw new Error('ไลน์ ' + c.ext + ' มีแถว Last coat อยู่แล้ว');
    setCells_(CFG.T.COAT, c.row, { DateTimeRecords: t, Total_Weight: w, Last_Coat: !!x.last, Memo: str_(x.memo).slice(0, 300), UpdatedTimestamp: new Date(), NeedRecalc: true });
    if (next && ids.indexOf(next.id) < 0) ids.push(next.id);
    return { kind: 'coat', pid: lot.pid, ids: ids };
  });
}

// ---------- NCP ที่เกิด (user 7 Nov 2026): monitor + edit the tab NCP (rows come mostly from the Coater web app; AppSheet still adds some) ----------
// Tab NCP is also read by the NCP web app and the RawMat web app — edit only, same columns. AppSheet fills: ID · Extruder_Number · Lot_Number ·
// ProductID · DateTime · Process · Weight · State (Active / Cancel) · Comment · LotProductKey · ProductionID · Cancelled · Visible; the Coater app also
// Weight_Kg · Status · NCP_No · SourceModule CoatingApp. Main script: Total_NCP = Σ Weight_Kg (blank → Weight) of rows not Cancelled (PRODUCTION_LOT_FINISHED).
// Weight is an AppSheet Number (whole kg). Packing_Record rows belong to the packing script → not edited here. Every edit → NCP_Edit_Log (before → after).
const NC = { PROCS: ['Dyer', 'Sieve', 'Scrap', 'Extruder', 'Clearing'], MAX_KG: 5000, EDIT: ['', 'ProdApp', 'CoatingApp'], LOG: 'NCP_Edit_Log',
  LHEAD: ['LogID', 'Time', 'By', 'NCP_ID', 'ProductionID', 'Lot_Number', 'Action', 'Field', 'Before', 'After'] };
function ncpOut_(r) {
  const t = date_(r.DateTime), src = str_(r.SourceModule);
  return { id: str_(r.ID), t: t ? t.getTime() : 0, pid: str_(r.ProductionID), lot: str_(r.Lot_Number), productID: str_(r.ProductID), ext: str_(r.Extruder_Number), proc: str_(r.Process),
    kg: num_(r.Weight_Kg) != null ? num_(r.Weight_Kg) : (num_(r.Weight) || 0), code: str_(r.NCP_Detail_ID), comment: str_(r.Comment), no: str_(r.NCP_No), status: str_(r.Status),
    src: src || 'AppSheet', by: str_(r.CreateMethod).replace(/^\w+:/, ''), edit: NC.EDIT.indexOf(src) >= 0, row: r._row };
}
function ncpClean_(rows) { return rows.map(function (r) { const o = Object.assign({}, r); delete o.row; return o; }); }
function ncpRowsOf_(pid) { return live_(CFG.T.NCP).filter(function (r) { return str_(r.ProductionID) === str_(pid); }).map(ncpOut_).sort(function (a, b) { return a.t - b.t; }); }
function ncpActiveCodes_() { return ncpCodes_().filter(function (c) { return c.active; }).map(function (c) { return { id: c.id, name: c.name }; }); }
function ncpDefault_(productID) {
  const m = ncpMaps_().filter(function (x) { return x.pid === productID && x.active; }).sort(function (a, b) { return (b.def - a.def) || (a.priority - b.priority); })[0];
  return m ? m.ncp : '';
}
function ncpSum_(rows, k) { const o = {}; rows.forEach(function (r) { o[r[k]] = (o[r[k]] || 0) + r.kg; }); return o; }
// production day 08:00 → 08:00 (as Coater); every source
function ncpDay(token, day) {
  cacheOn_();
  session_(token);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? day : prodDay_(Date.now());
  const S = new Date(d + 'T08:00:00+07:00').getTime(), E = S + 24 * HOUR, names = products_();
  const rows = live_(CFG.T.NCP).map(ncpOut_).filter(function (r) { return r.t >= S && r.t < E; }).sort(function (a, b) { return a.t - b.t; });
  rows.forEach(function (r) { r.name = names[r.productID] || r.productID; });
  const by = {};
  rows.forEach(function (r) { const L = by[r.pid] = by[r.pid] || { pid: r.pid, lot: r.lot, name: r.name, ext: r.ext, kg: 0, n: 0, byProc: {} }; L.kg += r.kg; L.n++; L.byProc[r.proc] = (L.byProc[r.proc] || 0) + r.kg; });
  return { day: d, start: S, procs: NC.PROCS, codes: ncpActiveCodes_(), rows: ncpClean_(rows), lots: Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.kg - a.kg; }),
    total: rows.reduce(function (a, r) { return a + r.kg; }, 0), byProc: ncpSum_(rows, 'proc'), bySrc: ncpSum_(rows, 'src') };
}
function ncpLot(token, pid) {
  cacheOn_();
  session_(token);
  const lot = lots_()[str_(pid)]; if (!lot) throw new Error('ไม่พบ Lot');
  const rows = ncpRowsOf_(lot.pid);
  rows.forEach(function (r) { r.name = lot.name; });
  return { lot: lot, procs: NC.PROCS, exts: lot.ext === 'EXT-1+2' ? ['EXT-1', 'EXT-2', 'EXT-1+2'] : [lot.ext], def: ncpDefault_(lot.productID), codes: ncpActiveCodes_(),
    rows: ncpClean_(rows), total: rows.reduce(function (a, r) { return a + r.kg; }, 0), byProc: ncpSum_(rows, 'proc') };
}
function ncpLog_(me, row, action, changes) {
  ensureTab_(NC.LOG, NC.LHEAD);
  const now = new Date();
  appendRows_(NC.LOG, changes.map(function (c) { return { LogID: id8_(), Time: now, By: by_(me), NCP_ID: str_(row.ID), ProductionID: str_(row.ProductionID), Lot_Number: str_(row.Lot_Number),
    Action: action, Field: c[0], Before: c[1] == null ? '' : String(c[1]), After: c[2] == null ? '' : String(c[2]) }; }));
}
function ncpRowById_(id) {
  delete TABLES_[CFG.T.NCP];
  const row = live_(CFG.T.NCP).filter(function (v) { return str_(v.ID) === str_(id); })[0]; if (!row) throw new Error('ไม่พบแถว NCP (อาจถูกยกเลิกแล้ว)');
  if (NC.EDIT.indexOf(str_(row.SourceModule)) < 0) throw new Error('แถวนี้มาจาก ' + str_(row.SourceModule) + ' — แก้ / ยกเลิกในแอปนั้น');
  return row;
}
// x = {proc, kg, t, code, comment} — only the fields that changed are written
function updateNcp(token, id, x) {
  const me = session_(token, 'work');
  const r = withLock_(function () {
    const row = ncpRowById_(id), was = ncpOut_(row), set = {}, log = [];
    if (x.proc != null) { const p = str_(x.proc); if (NC.PROCS.indexOf(p) < 0 && p !== was.proc) throw new Error('เลือกจุดที่เกิด NCP'); if (p !== was.proc) { set.Process = p; log.push(['Process', was.proc, p]); } }
    if (x.kg != null && String(x.kg).trim() !== '') {
      const kg = num_(String(x.kg).replace(/,/g, ''));
      if (kg == null || !(kg > 0) || Math.round(kg) !== kg) throw new Error('น้ำหนัก NCP เป็นจำนวนเต็ม kg มากกว่า 0');
      if (kg > NC.MAX_KG) throw new Error('เกิน ' + NC.MAX_KG.toLocaleString() + ' kg — ตรวจตัวเลข');
      if (kg !== was.kg) { set.Weight = kg; if (num_(row.Weight_Kg) != null) set.Weight_Kg = kg; log.push(['Weight', was.kg, kg]); }
    }
    if (x.t != null && String(x.t) !== '') {
      const t = new Date(Number(x.t)); if (isNaN(t) || t.getTime() > Date.now() + CFG.FUTURE_MIN * MIN) throw new Error('เวลาไม่ถูกต้อง');
      if (Math.abs(t.getTime() - was.t) >= MIN) { set.DateTime = t; log.push(['DateTime', was.t ? fmt_(new Date(was.t), 'dd/MM/yy HH:mm') : '', fmt_(t, 'dd/MM/yy HH:mm')]); }
    }
    if (x.code != null) {
      const c = str_(x.code).toUpperCase();
      if (c && !ncpCodes_().some(function (q) { return q.id.toUpperCase() === c; })) throw new Error('ไม่พบรหัส NCP ' + c + ' ใน NCP_Detail');
      if (c !== was.code.toUpperCase()) { set.NCP_Detail_ID = c; log.push(['NCP_Detail_ID', was.code, c]); }
    }
    if (x.comment != null) { const cm = str_(x.comment).slice(0, 300); if (cm !== was.comment) { set.Comment = cm; log.push(['Comment', was.comment, cm]); } }
    if (!log.length) throw new Error('ไม่มีอะไรเปลี่ยน');
    set.UpdatedTimestamp = new Date();
    setCells_(CFG.T.NCP, row._row, set);
    ncpLog_(me, row, 'edit', log);
    return { pid: str_(row.ProductionID) };
  });
  if (r.pid) hook_({ action: 'PRODUCTION_LOT_FINISHED', module: 'PRODUCTION_LOT_KPI', productionID: r.pid, rowID: r.pid, requestedBy: by_(me) });
  return { ok: true };
}
// NCP Scrap / Clearing from the lot page (user 9 Nov 2026): Control records them for lots made in this app — replaces the AppSheet form.
// Same columns AppSheet fills (ID · Extruder_Number · Lot_Number · ProductID · DateTime · Process · Weight · State Active · LotProductKey · ProductionID)
// + SourceModule 'ProdApp' / CreateMethod 'ProdApp:<name>' so the row can be told apart and edited here. Re-send safe: the phone sends the ID.
NC.ADD = ['Scrap', 'Clearing'];
function addNcp(token, pid, x) {
  const me = session_(token, 'work');
  x = x || {};
  const id = str_(x.id).toLowerCase();
  if (!/^[abcdf][0-9a-f]{7}$/.test(id)) throw new Error('รหัสรายการไม่ถูกต้อง — โหลดหน้าใหม่แล้วลองอีกครั้ง');
  const proc = str_(x.proc); if (NC.ADD.indexOf(proc) < 0) throw new Error('เลือก Scrap หรือ Clearing');
  const kg = num_(String(x.kg == null ? '' : x.kg).replace(/,/g, ''));
  if (kg == null || !(kg > 0) || Math.round(kg) !== kg) throw new Error('น้ำหนัก NCP เป็นจำนวนเต็ม kg มากกว่า 0');
  if (kg > NC.MAX_KG) throw new Error('เกิน ' + NC.MAX_KG.toLocaleString() + ' kg — ตรวจตัวเลข');
  const t = new Date(Number(x.t)); if (!x.t || isNaN(t) || t.getTime() > Date.now() + CFG.FUTURE_MIN * MIN) throw new Error('เวลาไม่ถูกต้อง');
  t.setSeconds(0, 0); // minute, like AppSheet
  const code = str_(x.code).toUpperCase();
  if (code && !ncpCodes_().some(function (q) { return q.id.toUpperCase() === code; })) throw new Error('ไม่พบรหัส NCP ' + code + ' ใน NCP_Detail');
  const r = withLock_(function () {
    delete TABLES_[CFG.T.LOT]; delete TABLES_[CFG.T.NCP];
    const lot = lots_()[str_(pid)]; if (!lot) throw new Error('ไม่พบ Lot (หรือ Lot ถูกยกเลิกแล้ว)');
    const exts = lot.ext === 'EXT-1+2' ? ['EXT-1', 'EXT-2', 'EXT-1+2'] : [lot.ext];
    const ext = str_(x.ext) || lot.ext; if (exts.indexOf(ext) < 0) throw new Error('เลือก Extruder');
    if (table_(CFG.T.NCP).rows.some(function (v) { return str_(v.ID) === id; })) return { dup: true, pid: lot.pid };
    const now = new Date(), row = { ID: id, Extruder_Number: ext, Lot_Number: lot.lot, ProductID: lot.productID, DateTime: t, Process: proc, Weight: kg,
      CreateTimestamp: now, UpdatedTimestamp: now, State: 'Active', Comment: str_(x.comment).slice(0, 300), LotProductKey: lot.lot + '|' + lot.productID + '|' + lot.ext,
      ProductionID: lot.pid, Cancelled: false, SourceModule: CFG.SOURCE, NCP_Detail_ID: code, CreateMethod: by_(me), Visible: true };
    appendRows_(CFG.T.NCP, [row]);
    ncpLog_(me, row, 'add', [['Process', '', proc], ['Weight', '', kg]]);
    return { pid: lot.pid };
  });
  if (!r.dup) hook_({ action: 'PRODUCTION_LOT_FINISHED', module: 'PRODUCTION_LOT_KPI', productionID: r.pid, rowID: r.pid, requestedBy: by_(me) });
  return { ok: true, id: id, dup: !!r.dup };
}
function cancelNcp(token, id) {
  const me = session_(token, 'work');
  const r = withLock_(function () {
    const row = ncpRowById_(id), set = { State: 'Cancel', Cancelled: true, UpdatedTimestamp: new Date() };
    if (str_(row.Status)) set.Status = 'Cancelled';
    setCells_(CFG.T.NCP, row._row, set);
    ncpLog_(me, row, 'cancel', [['Cancelled', 'FALSE', 'TRUE']]);
    return { pid: str_(row.ProductionID) };
  });
  if (r.pid) hook_({ action: 'PRODUCTION_LOT_FINISHED', module: 'PRODUCTION_LOT_KPI', productionID: r.pid, rowID: r.pid, requestedBy: by_(me) });
  return { ok: true };
}


// =====================================================================
// Phase 6 — Grinding fineness + powder moisture (user 25 Oct 17:27: "ไม่เห็นส่วนใส่ fineness และ moisture")
// Grinding_Fineness (same columns as AppSheet): one row per machine × sieve. Fineness_Pct stored as a fraction (0.94),
// Result_Status PASS / Re-Grinding is the operator's call (no threshold in the data: Re-Grinding seen at 0.78–0.98).
// Moisture (powder, %) started ~19 Oct; when two sieves are saved together it goes on the last row only.
// The main script has no fineness recalc wired up, so no webhook call.
// =====================================================================
const FINE = { MACHINES: ['ATOM-1', 'ATOM-2', 'PUL-1'], SIEVES: ['425 mc', '250 mc'], RESULTS: ['PASS', 'Re-Grinding'], BACK_DAYS: 7 };
function fineRows_() {
  return live_('Grinding_Fineness').map(function (r) {
    const t = date_(r.DateTimeRecords); let p = num_(r.Fineness_Pct); if (p != null && p > 1.5) p = p / 100;
    return { id: str_(r.ID), m: str_(r.Grinding_Machine), pid: str_(r.ProductionID), lot: str_(r.Lot_Number), t: t ? t.getTime() : 0,
      pct: p, sieve: str_(r.Sieve_Size), sample: str_(r.Sample_No), result: str_(r.Result_Status), moist: num_(r.Moisture), comment: str_(r.Comment), row: r._row,
      grp: (str_(r.Comment).match(/^\[ร่วม ([^\]]+)\]/) || [])[1] || '' };
  }).filter(function (x) { return x.t; }).sort(function (a, b) { return a.t - b.t; });
}
/* A sample taken after Mixer-2 for ATOM + PUL-1 is saved once per machine (Comment starts "[ร่วม ATOM-1+PUL-1]").
 * Lot-level counts / averages keep one copy; per-machine views use every row. */
function fineKey_(x) { return x.grp ? [x.grp, x.pid, x.t, x.sieve, x.sample].join('|') : 'id:' + x.id; }
function fineOnce_(rows) { const seen = {}; return rows.filter(function (x) { const k = fineKey_(x); if (seen[k]) return false; seen[k] = 1; return true; }); }
function fineStat_(rows) {
  const out = { n: rows.length, regrind: rows.filter(function (x) { return /re-?grind/i.test(x.result); }).length, sieves: {}, moist: null, last: rows.length ? rows[rows.length - 1].t : null };
  FINE.SIEVES.forEach(function (s) {
    const v = rows.filter(function (x) { return x.sieve === s && x.pct != null; }).map(function (x) { return x.pct; });
    if (v.length) out.sieves[s] = { n: v.length, avg: v.reduce(function (a, b) { return a + b; }, 0) / v.length, min: Math.min.apply(null, v), max: Math.max.apply(null, v) };
  });
  const m = rows.filter(function (x) { return x.moist != null; }).map(function (x) { return x.moist; });
  if (m.length) out.moist = { n: m.length, avg: m.reduce(function (a, b) { return a + b; }, 0) / m.length, min: Math.min.apply(null, m), max: Math.max.apply(null, m) };
  return out;
}
function fineOut_(x) { return { id: x.id, m: x.m, grp: x.grp, t: x.t, pct: x.pct, sieve: x.sieve, sample: x.sample, result: x.result, moist: x.moist, comment: x.comment, lot: x.lot }; }
// drawer data: lot, machines in its flow, last rows, next sample no. guess
function lotFineness(token, pid) {
  cacheOn_();
  session_(token);
  const lot = lots_()[pid]; if (!lot) throw new Error('ไม่พบ Lot');
  const su = setups_().filter(function (s) { return s.pid === pid; }), a3 = su.filter(function (s) { return s.machine === 'ATOM-3'; }).pop();
  const flow = a3 ? a3.flow : (su.length ? su[su.length - 1].flow : '');
  const down = (CFG.FLOWS[pointOf_(flow)] || []).filter(function (m) { return FINE.MACHINES.indexOf(m) >= 0; });
  const rows = fineRows_().filter(function (x) { return x.pid === pid; });
  const nums = rows.map(function (x) { return Number(x.sample); }).filter(function (n) { return isFinite(n) && n > 0; });
  return { lot: lot, flow: flow, machines: down.length ? down : FINE.MACHINES.slice(), all: FINE.MACHINES, sieves: FINE.SIEVES, results: FINE.RESULTS,
    rows: rows.slice(-20).reverse().map(fineOut_), stat: fineStat_(fineOnce_(rows)), lastSample: nums.length ? Math.max.apply(null, nums) : null };
}
// x = { pid, m, t, sample, pcts: { '425 mc': 94, '250 mc': 92 } (percent), moist, result, comment }
function saveFineness(token, x) {
  const me = session_(token, 'work');
  const lot = lots_()[str_(x.pid)]; if (!lot) throw new Error('ไม่พบ Lot หรือ Lot ถูกยกเลิก');
  // x.m = one machine, or "ATOM-1+PUL-1" / "ATOM-2+PUL-1": one sample after Mixer-2 for an ATOM running with PUL-1 (ATOM-1 and ATOM-2 are sampled apart)
  const ms = unique_(str_(x.m).split('+').map(function (v) { return v.trim(); }).filter(Boolean)), m = ms.join('+');
  if (!ms.length || ms.some(function (v) { return FINE.MACHINES.indexOf(v) < 0; })) throw new Error('เลือกเครื่อง ATOM-1 / ATOM-2 / PUL-1');
  if (ms.length > 1 && (ms.length > 2 || ms.indexOf('PUL-1') < 0)) throw new Error('เลือกร่วมได้เฉพาะ ATOM หนึ่งเครื่องกับ PUL-1 (ATOM-1 กับ ATOM-2 แยกกันเก็บ)');
  const t = Number(x.t); if (!isFinite(t)) throw new Error('ใส่เวลา');
  if (t > Date.now() + CFG.FUTURE_MIN * MIN) throw new Error('เวลาเกินตอนนี้ +' + CFG.FUTURE_MIN + ' นาที');
  if (t < Date.now() - FINE.BACK_DAYS * 24 * HOUR) throw new Error('ย้อนหลังได้ไม่เกิน ' + FINE.BACK_DAYS + ' วัน — เก่ากว่านั้นใช้ AppSheet');
  const result = FINE.RESULTS.indexOf(str_(x.result)) >= 0 ? str_(x.result) : 'PASS';
  const sample = result === 'PASS' ? str_(x.sample) : ''; // Re-Grinding has no Sample No. (user 27 Oct)
  if (sample && !/^\d{1,4}$/.test(sample)) throw new Error('Sample No. เป็นตัวเลข');
  const moist = str_(x.moist) === '' ? null : num_(x.moist);
  if (str_(x.moist) !== '' && (moist == null || moist < 2 || moist > 25)) throw new Error('ความชื้นต้องอยู่ระหว่าง 2–25 %');
  const pcts = [];
  FINE.SIEVES.forEach(function (s) {
    const raw = x.pcts && str_(x.pcts[s]); if (!raw) return;
    const v = num_(raw); if (v == null || v <= 0 || v > 100) throw new Error('ความละเอียด ' + s + ' ต้องเป็น % ระหว่าง 1–100');
    pcts.push([s, Math.round(v * 10) / 1000]);
  });
  if (!pcts.length && moist == null) throw new Error('ใส่ % ความละเอียดอย่างน้อย 1 ตะแกรง หรือความชื้น');
  const sus = setups_(), tag = ms.length > 1 ? '[ร่วม ' + m + '] ' : '', now = new Date(), rows = [];
  ms.forEach(function (mm) { const setup = sus.filter(function (s) { return s.pid === lot.pid && s.machine === mm; }).pop();
  (pcts.length ? pcts : [['', null]]).forEach(function (p, i, arr) {
    rows.push({ ID: id8_(), Grinding_Machine: mm, Lot_Number: lot.lot, ProductionID: lot.pid, ProductID: lot.productID, DateTimeRecords: new Date(t),
      Fineness_Pct: p[1] == null ? '' : p[1], Sieve_Size: p[0], Sample_No: sample ? Number(sample) : '', Result_Status: result,
      CreateTimestamp: now, UpdatedTimestamp: now, Cancelled: false, Comment: (tag + str_(x.comment)).slice(0, 200), CreatedBy: by_(me), Visible: true,
      SetupID: setup ? setup.id : '', Moisture: i === arr.length - 1 && moist != null ? moist : '' });
  }); });
  return withLock_(function () {
    appendRows_('Grinding_Fineness', rows);
    return { ids: rows.map(function (r) { return r.ID; }), n: rows.length, m: m, lot: lot.lot };
  });
}
function cancelFineness(token, id) {
  const me = session_(token, 'work');
  return withLock_(function () {
    const all = fineRows_(), r = all.find(function (x) { return x.id === str_(id); }); if (!r) throw new Error('ไม่พบรายการ (หรือยกเลิกไปแล้ว)');
    const k = fineKey_(r), rows = r.grp ? all.filter(function (x) { return fineKey_(x) === k; }) : [r]; // a joint sample: cancel every machine's copy
    rows.forEach(function (x) { setCells_('Grinding_Fineness', x.row, { Cancelled: true, UpdatedTimestamp: new Date(), UpdatedBy: by_(me) }); });
    return { id: r.id, n: rows.length };
  });
}

// =====================================================================
// Batching formula (user 27 Oct 10:56): the team attaches a photo / screenshot of the TAT01 "AUTO START BATCH" screen,
// the app reads it (Google Drive OCR), the team checks / edits the lines, and it is saved against the Lot.
// Several records per lot (each change of formula). Compare with the previous record of the same Formula Code (user choice).
// App-owned tabs: Batching_Formula (one row per record) + Batching_Formula_Line (one row per ingredient). Images: a Drive folder.
// =====================================================================
const BF = {
  TAB: 'Batching_Formula', LINE: 'Batching_Formula_Line', FOLDER: 'BFL ProdApp - สูตร Batching',
  HEAD: ['FormulaRecID', 'ProductionID', 'Lot_Number', 'ProductID', 'Recorded_At', 'Mixer', 'Formula_Code', 'Formula_Name', 'Formula_Date', 'Batch_Size_kg',
    'Multi_Batch', 'Job_No', 'Plan_Number', 'Lot_On_Screen', 'Total_kg', 'Items', 'Image_FileID', 'OCR_Text', 'Memo', 'Cancelled', 'CreatedBy', 'CreateTimestamp',
    'UpdatedTimestamp', 'UpdatedBy'],
  LHEAD: ['LineID', 'FormulaRecID', 'Line_No', 'Ingredient_Code', 'Ingredient_Name', 'Type', 'Target_kg', 'Plc', 'Bin', 'Cancelled'],
  TYPES: ['H1', 'S1', 'S2'],
  LOG: 'Batching_OCR_Log', LOGHEAD: ['Time', 'By', 'Read_As', 'Lines', 'Sum_kg', 'Total_kg', 'Items', 'Lot', 'OCR_Text']
};
function ensureTab_(name, head) {
  if (isDb_(name)) return dbEnsureTab_(name, head);
  let sh = ss_().getSheetByName(name);
  if (!sh) { sh = ss_().insertSheet(name, ss_().getNumSheets()); sh.appendRow(head); delete TABLES_[name]; wrote_(name); return sh; }
  const have = table_(name).h, miss = head.filter(function (c) { return have.indexOf(c) < 0; });
  if (miss.length) { sh.getRange(1, have.length + 1, 1, miss.length).setValues([miss]); delete TABLES_[name]; wrote_(name); }
  return sh;
}
function bfTabs_() { ensureTab_(BF.TAB, BF.HEAD); ensureTab_(BF.LINE, BF.LHEAD); }

// ---------- reading the screen text ----------
const BF_DIG_ = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', i: '1', '|': '1', S: '5', s: '5', B: '8', Z: '2', z: '2', G: '6' };
function bfDigits_(s) { return String(s).split('').map(function (c) { return /\d/.test(c) ? c : (BF_DIG_[c] || c); }).join(''); }
// ingredient code like 01FI018-1000000 (OCR may add junk in front or read 0 as O, 1 as I / l)
// a code cut off on screen ("04RW004-16NA...", "97-FH16PU8806...") comes back with "…" at the end
function bfCode_(tok) {
  const raw = String(tok), cut = /(\.{2,}|…)$/.test(raw), t = raw.replace(/[^A-Za-z0-9\-]/g, '');
  const lt = function (x) { return x.toUpperCase().replace(/1/g, 'I').replace(/0/g, 'O').replace(/5/g, 'S').replace(/8/g, 'B'); };
  let m = /^([0-9OoIlQD]{1,4})([A-Za-z][A-Za-z015]|[015][A-Za-z])([0-9OoIlSBZ]{3})-([0-9OoIlSBZ]{7})$/.exec(t);
  if (m) { const p = bfDigits_(m[1]); return p.slice(-2) + lt(m[2]) + bfDigits_(m[3]) + '-' + bfDigits_(m[4]); }
  m = /^([0-9OoIlQD]{1,4})([A-Za-z][A-Za-z015])([0-9OoIlSBZ]{3})-([A-Za-z0-9]{7,10})$/.exec(t); // suffix with letters: 04RW004-25NA000 · 04RW003-18FT10000
  if (m && /[A-Za-z]/.test(m[4]) && /\d/.test(m[4])) return bfDigits_(m[1]).slice(-2) + lt(m[2]) + bfDigits_(m[3]) + '-' + m[4].toUpperCase();
  m = /^([0-9OoIl]{2,3})-([A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{1,6})*)-([0-9OoIl]{2})$/.exec(t); // premix / formula code like 97-FH32PL801-41 · 97-DG18RTRB-NA-41
  if (m && m[2].replace(/-/g, '').length >= 6) return bfDigits_(m[1]).slice(-2) + '-' + m[2].toUpperCase() + '-' + bfDigits_(m[3]);
  if (!cut) return '';
  m = /^([0-9OoIlQD]{1,4})([A-Za-z]{2})([0-9OoIlSBZ]{3,4})(-[A-Za-z0-9]{0,7})?$/.exec(t);
  if (m) return bfDigits_(m[1]).slice(-2) + m[2].toUpperCase() + bfDigits_(m[3]).slice(-3) + (m[4] || '').toUpperCase() + '…';
  m = /^([0-9OoIl]{2,3})-([A-Za-z0-9]{3,})(-[0-9OoIl]?)?$/.exec(t);
  if (m) return bfDigits_(m[1]).slice(-2) + '-' + m[2].toUpperCase() + (m[3] || '') + '…';
  return '';
}
function bfCut_(c) { return /…$/.test(c); }
function bfType_(tok) { const t = String(tok).toUpperCase().replace('$', 'S').replace(/^5/, 'S').replace(/L$/, '1').replace(/I$/, '1'); return BF.TYPES.indexOf(t) >= 0 ? t : ''; }
function bfBin_(tok) {
  const t = String(tok).replace(/[^A-Za-z0-9]/g, ''); if (!t) return '';
  if (/^x{2,}$/i.test(t)) return 'XXX';
  let m = /^[Bb8]((?:IA|I)?)([0-9OoQDli]{1,4})$/.exec(t); // B002 · BIA1 · BI26 (O read for 0, l / i for 1)
  if (m) return 'B' + m[1] + bfDigits_(m[2]);
  m = /^([A-Za-z]{1,3})([0-9OoIli]{1,3})$/.exec(t); if (m) return m[1].toUpperCase() + bfDigits_(m[2]);
  return t.toUpperCase();
}
function bfIsBin_(tok) { return /^[Bb](?:IA|I)?[0-9OoQDliS?]{3}$/.test(String(tok).replace(/[^A-Za-z0-9?]/g, '')); }
function bfNum_(s) { const n = parseFloat(String(s).replace(/,/g, '')); return isFinite(n) ? n : null; }
const BF_W_ = /^\d{1,3}(?:,\d{3})*\.\d{3}$|^\d+\.\d{3}$/;
const bfR3_ = function (n) { return Math.round(n * 1000) / 1000; };
// codes in reading order; a cut code is replaced by the full code that starts with it (the name column often repeats it in full)
function bfCodeList_(toks, skip) {
  const out = [];
  toks.forEach(function (t) {
    const c = bfCode_(t); if (!c || c === skip) return;
    if (bfCut_(c)) { const pre = c.slice(0, -1); if (!out.some(function (x) { return x === c || (!bfCut_(x) && x.indexOf(pre) === 0); })) out.push(c); return; }
    if (out.indexOf(c) >= 0) return;
    const k = out.findIndex(function (x) { return bfCut_(x) && c.indexOf(x.slice(0, -1)) === 0; });
    if (k >= 0) out[k] = c; else out.push(c);
  });
  return out;
}
// n weights in a row (reading order) that add up to the screen total; else n weights in order that do (side table / header values skipped)
function bfPickKg_(ws, n, total) {
  if (!n || ws.length < n) return null;
  if (total) {
    for (let i = 0; i + n <= ws.length; i++) if (Math.abs(bfR3_(ws.slice(i, i + n).reduce(function (a, x) { return a + x; }, 0)) - total) < 0.01) return { kg: ws.slice(i, i + n), at: i, run: true };
    const memo = {}, go = function (i, k, left) { // pick k of ws[i..] in order with sum = left
      if (k === 0) return Math.abs(left) < 0.01 ? [] : null;
      if (ws.length - i < k || left < -0.01) return null;
      const key = i + '|' + k + '|' + Math.round(left * 1000); if (key in memo) return memo[key];
      let r = go(i + 1, k - 1, bfR3_(left - ws[i])); r = r ? [i].concat(r) : go(i + 1, k, left);
      return (memo[key] = r);
    };
    const idx = ws.length <= 60 ? go(0, n, total) : null;
    if (idx) return { kg: idx.map(function (i) { return ws[i]; }), at: idx[0], run: false };
  }
  return null;
}
// n types in a row; prefer the run whose per-type sums show up elsewhere on screen (the Type / Weight box on the right)
function bfPickType_(ts, n, kgs, ws) {
  if (ts.length < n) return null;
  let best = null;
  for (let i = 0; i + n <= ts.length; i++) {
    const w = ts.slice(i, i + n), sums = {};
    if (kgs) w.forEach(function (t, j) { sums[t] = bfR3_((sums[t] || 0) + (kgs[j] || 0)); });
    const score = Object.keys(sums).filter(function (t) { return ws.some(function (x) { return Math.abs(x - sums[t]) < 0.01; }); }).length;
    if (!best || score > best.score) best = { t: w, score: score };
  }
  return best.t;
}
// a code Drive split at spaces is joined back when only the joined form is a code:
// "04RW003-18FT 10000" · "97-DG 18FT 10-NA-41" · "97-DG18FT 10-NA-41" (a premix code split in 2–3 pieces was lost → rows shifted, 11 Nov)
function bfJoin_(s) {
  const t = s.split(' '), out = [], full = function (x) { const c = bfCode_(x); return !!c && !bfCut_(c); };
  for (let i = 0; i < t.length; i++) {
    let k = 0;
    if (!full(t[i]) && !/^\d{1,2}$/.test(t[i])) {
      for (let n = 3; n >= 2 && !k; n--) {
        if (i + n > t.length) continue;
        const parts = t.slice(i, i + n), j = parts.join('');
        if (parts.some(full) || !/-/.test(j)) continue;
        if (full(j)) k = n;
      }
    }
    if (k) { out.push(t.slice(i, i + k).join('')); i += k - 1; } else out.push(t[i]);
  }
  return out.join(' ');
}
// type, plc and bin belong together on TAT01: H1 = plc 30 (bin H1, premix 97-…), S1 = plc 1 (silo B0xx / BIA1), S2 = plc 2 (BI25 / BI26 / B135 / B136).
// Drive sometimes hands the type (or a whole detail group) to the next row of the same weight → put them back (seen 11 Nov, Dog18% FT10)
function bfFix_(lines) {
  const PT = { 30: 'H1', 1: 'S1', 2: 'S2' }, pre = function (x) { return /^\d{2}-/.test(x.code || ''); }, isH = function (x) { return x.type === 'H1' || x.plc === 30 || x.bin === 'H1'; };
  const silo = function (b) { return /^B(?:IA\d|I\d{2}|\d{3})$/.test(b || ''); }, changed = {};
  const keyOf = function (x) { return x.type + '|' + x.plc + '|' + x.bin; };
  lines.forEach(function (x) { // a premix row holding a silo row's details ↔ the row of the same weight holding the H1 details
    if (!pre(x) || (x.type === 'H1' && !silo(x.bin))) return;
    const y = lines.filter(function (o) { return o !== x && !pre(o) && Math.abs((o.kg || 0) - (x.kg || 0)) < 0.0005 && isH(o); })[0];
    if (y) { ['type', 'plc', 'bin'].forEach(function (f) { const t = x[f]; x[f] = y[f]; y[f] = t; }); changed[x.no] = changed[y.no] = 1; }
  });
  lines.forEach(function (x) {
    const k0 = keyOf(x);
    if (pre(x)) { x.type = 'H1'; if (x.plc == null || PT[x.plc]) x.plc = 30; if (!x.bin || silo(x.bin)) x.bin = 'H1'; }
    else if (x.type === 'H1' && (x.plc === 1 || x.plc === 2) && silo(x.bin)) x.type = PT[x.plc]; // a silo row cannot be H1
    else if ((x.type === 'S1' || x.type === 'S2') && (x.plc === 30 || x.bin === 'H1') && !silo(x.bin)) { x.type = 'H1'; if (x.plc == null) x.plc = 30; }
    else if ((x.type === 'S1' || x.type === 'S2') && (x.plc === 1 || x.plc === 2) && PT[x.plc] !== x.type && (!x.bin || silo(x.bin))) x.type = PT[x.plc];
    if (!pre(x) && silo(x.bin) && x.plc === 30 && (x.type === 'S1' || x.type === 'S2')) x.plc = x.type === 'S1' ? 1 : 2; // a silo row has plc 1 / 2
    if (x.type !== k0.split('|')[0]) changed[x.no] = 1;
  });
  return Object.keys(changed).map(Number).sort(function (a, b) { return a - b; });
}
function bfParse_(text) {
  const L = String(text || '').split(/\r?\n/).map(function (s) { return bfJoin_(s.replace(/[\[\]|{}]/g, ' ').replace(/\s+/g, ' ').trim()); }).filter(Boolean), all = L.join('\n');
  const pick = function (re) { const m = re.exec(all); return m ? m[1] : ''; };
  const head = {};
  head.code = bfCode_(pick(/Formula\s*Code\s*:?\s*([0-9OoIl]{2,3}-[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{1,6})*-[0-9OoIl]{2})/i)) || bfCode_(pick(/Formula\s*:?\s*([0-9OoIl]{2,3}-[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{1,6})*-[0-9OoIl]{2})/i));
  head.name = (pick(/Formula\s*Code\s*:?\s*[0-9OoIl]{2,3}-[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{1,6})*-[0-9OoIl]{2}\s+(.+?)(?:\s+Formula\s*Date|$)/im) || '').trim();
  if (!head.name || /Formula|^Q\b|^\d{2}-[A-Z0-9]{6,}/i.test(head.name)) { // name line moved (crop / OCR order): take the product-looking line, e.g. "Fish26% Pola 8802 8803 -NA.ROUND -"
    const nl = L.filter(function (s) { return /[A-Za-z]{3,}\s*\d+(?:\.\d+)?%/.test(s) && !/REWORK|TOTAL/i.test(s) && !bfCode_(s.split(' ')[0]); })[0];
    head.name = nl ? nl.replace(/\s*Formula\s*Date.*$/i, '').replace(/^.*?-\d{2}\s+(?=[A-Za-z])/, '').trim() : '';
  }
  head.date = pick(/Formula\s*Date\s*:?\s*\n?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i) || pick(/Formula\s*:?\s*[0-9OoIl]{2,3}-[A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{1,6})*-[0-9OoIl]{2}\s+(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  head.size = bfNum_(pick(/New\s*Batch\s*Size\s*:?\s*([\d,]+\.\d+)/i));
  head.multi = bfNum_(pick(/Multi\s*Batch\s*Size\s*:?\s*([\d.]+)/i));
  head.job = pick(/Job\s*No\s*:?\s*\n?\s*(\d{4,8})\b/i);
  if (!head.job) head.job = pick(/Job\s*No\s*:?[^\n]*\n\s*(\d{5,8})\s*$/im);
  const plan = pick(/\b([WVwv][O0o]\d{8})\b/); head.plan = plan ? 'WO' + plan.slice(2) : '';
  head.lot = pick(/Lot\s*Number\s*:?\s*\n?\s*(2\d{8}(?:-PC)?)\b/i) || pick(/\b(26\d{7}(?:-PC)?)\b/);
  const mx = pick(/\bMIXER\s*_?\s*([12])\b/i) || pick(/Destination\s*Mixer\s*:?\s*(?:MIX|mx)\s*([12])/i); head.mixer = mx ? 'MIXER ' + mx : '';
  head.total = bfNum_(pick(/TOTAL\s*WEIGHT\s*:?\s*([\d,]+\.\d{3})/i));
  head.items = bfNum_(pick(/TOTAL\s*INGREDIENTS?\s*:?\s*(\d{1,3})\b/i));
  const destBin = (pick(/Destination\s*Bin\s*:?\s*(\S+)/i) || '').replace(/[^A-Za-z0-9]/g, '');
  const total = head.total || head.size || null;

  // A) row by row: a line with an ingredient code and a weight (x.xxx); name / type / plc / bin read around them
  const rows = [];
  L.forEach(function (s) {
    if (/TOTAL|Batch\s*Size|Formula/i.test(s)) return;
    const tok = s.split(' '), found = [];
    tok.forEach(function (t, i) { const c = bfCode_(t); if (c) found.push({ i: i, c: c, clean: !bfCut_(c) && c === t.replace(/[^A-Za-z0-9\-]/g, '') }); });
    if (!found.length) return;
    const ci = found[0].i, full = found.filter(function (f) { return !bfCut_(f.c); }), best = full.filter(function (f) { return f.clean; })[0] || full[0] || found[0];
    let wi = -1; for (let i = ci + 1; i < tok.length; i++) if (BF_W_.test(tok[i].replace(/[^\d.,]/g, '')) && /\d\.\d{3}/.test(tok[i])) { wi = i; break; }
    if (wi < 0) return;
    let type = '', ti = -1; for (let i = wi - 1; i > ci; i--) { type = bfType_(tok[i]); if (type) { ti = i; break; } }
    const plc = tok[wi + 1] && /^\d{1,3}$/.test(bfDigits_(tok[wi + 1])) ? Number(bfDigits_(tok[wi + 1])) : null;
    const bin = plc != null && tok[wi + 2] ? bfBin_(tok[wi + 2]) : '';
    const no = /^\d{1,2}$/.test(tok[0]) && ci > 0 ? Number(tok[0]) : null;
    const nameToks = tok.slice(ci + 1, ti > ci ? ti : wi).filter(function (t) { return !bfCode_(t); });
    const name = found.length > 1 ? (full[full.length - 1] || found[1]).c : nameToks.join(' ');
    rows.push({ no: no, code: best.c, name: name || best.c, type: type || (/^\d{2}-/.test(best.c) ? 'H1' : ''), kg: bfNum_(tok[wi].replace(/[^\d.,]/g, '')), plc: plc, bin: bin });
  });

  // B) column by column (Drive often reads a table one column at a time): codes, weights, types and bins each in reading order
  const toks = L.filter(function (s) { return !/Formula|Batch\s*Size|Production|Plan\s*Number|Job\s*No/i.test(s); }).join(' ').split(' ');
  const codes = bfCodeList_(toks, head.code), ws = [], ts = [], bins = [];
  let seenCode = false;
  toks.forEach(function (t, i) {
    const c = bfCode_(t); if (c) { if (c !== head.code) seenCode = true; return; }
    if (BF_W_.test(t.replace(/[^\d.,]/g, '')) && /\d\.\d{3}/.test(t)) { const v = bfNum_(t.replace(/[^\d.,]/g, '')); if (!/TOTAL/i.test(toks[i - 1] || '') && !/WEIGHT/i.test(toks[i - 1] || '')) ws.push(v); return; }
    if (!seenCode) return;
    const ty = bfType_(t); if (ty) { ts.push(ty); return; }
    if (bfIsBin_(t) && t.replace(/[^A-Za-z0-9]/g, '') !== destBin) bins.push(bfBin_(t.replace(/\?/g, '')));
  });
  const n = head.items || codes.length, kgPick = bfPickKg_(ws.filter(function (x) { return x !== total || ws.length <= n; }), n, total) || bfPickKg_(ws, n, total);
  // D) Drive's usual layout (seen on the real screens 27 Oct): codes in order, and each row's details in order as
  //    type, weight, plc, bin (bin = B### / BIA1 / XXX, or H1 for a premix). The Type / Weight box on the right gives
  //    type, weight with no plc + bin after it, so it is skipped.
  const st = [];
  L.filter(function (s) { return !/TOTAL|Formula|Batch\s*Size|Production|Plan\s*Number|Job\s*No|Destination/i.test(s); }).join(' ').split(' ').forEach(function (t, i, a) {
    if (/^[Bb][IiAa]{0,2}$/.test(t) && /^\d{1,3}$/.test(a[i + 1] || '')) { a[i + 1] = t + a[i + 1]; return; } // "BIA 1" → BIA1
    st.push(t);
  });
  const isW = function (t) { const w = String(t || '').replace(/[^\d.,]/g, ''); return BF_W_.test(w) && /\d\.\d{3}/.test(t); };
  // a bin may be cut off when the TAT01 window is narrow (B00 / BIA / BI2) → still a bin; the plc + bin pair is what tells a row from the Type / Weight box
  const isBinTok = function (t) { return bfIsBin_(t) || /^x{2,}$/i.test(t) || bfType_(t) === 'H1' || /^[Bb][IiAa]{0,2}[0-9OoQDli]{0,3}$/.test(t) || /^8\d{3}$/.test(t); };
  const sdet = [], part = []; // full "type weight plc bin" groups · lone "type weight" pairs (the Type / Weight box, or a row whose plc / bin was not read)
  const realBin = function (t) { return (bfIsBin_(t) || /^8\d{3}$/.test(t) || /^[Bb][IiAa]{1,2}\d{1,3}$/.test(t)) && !bfType_(t); };
  const toBin = function (b) { return bfType_(b) === 'H1' ? 'H1' : /^x{2,}$/i.test(b) ? 'XXX' : /^8\d{3}$/.test(b) ? 'B' + b.slice(1) : bfBin_(b.replace(/\?/g, '')); };
  for (let i = 0; i + 1 < st.length; i++) {
    const ty = bfType_(st[i]); if (!ty || !isW(st[i + 1])) continue;
    const kg = bfNum_(st[i + 1].replace(/[^\d.,]/g, ''));
    if (i + 3 < st.length && /^\d{1,2}$/.test(bfDigits_(st[i + 2])) && isBinTok(st[i + 3])) {
      let bi = i + 3;
      // "H1" right after a non-premix row is the previous premix row's bin pushed down (seen 27 Oct 15:16): take the real bin a few tokens on
      if (ty !== 'H1' && bfType_(st[bi]) === 'H1') { for (let k = bi + 1; k <= bi + 3 && k < st.length; k++) if (realBin(st[k])) { bi = k; break; } }
      const bin = toBin(st[bi]);
      sdet.push({ pos: i, type: ty, kg: kg, plc: Number(bfDigits_(st[i + 2])), bin: ty !== 'H1' && bin === 'H1' ? '' : bin, cut: bin !== 'H1' && bin !== 'XXX' && !/^B(?:IA\d|I\d{2}|\d{3})$/.test(bin) });
      i = bi;
    } else {
      // plc may still follow (bin lost): keep it for the row if this pair is used
      const plc = i + 2 < st.length && /^\d{1,2}$/.test(st[i + 2]) ? Number(st[i + 2]) : null;
      part.push({ pos: i, type: ty, kg: kg, plc: plc, bin: '', part: true }); i += 1;
    }
  }
  // some rows lost their plc / bin (Drive put them in a separate block): add lone pairs in reading order so the total matches
  // TOTAL WEIGHT; a pair equal to its type's total while that type has several rows is the side box → avoided
  const nT = head.items || 0, fullSum = sdet.reduce(function (a, d) { return a + d.kg; }, 0);
  if (nT && total && sdet.length < nT && nT - sdet.length <= 14 && part.length && part.length <= 28) {
    const need = nT - sdet.length, target = bfR3_(total - fullSum);
    let best = null, tries = 0;
    const walk = function (from, pick, sum) {
      if (++tries > 40000 || (best && best.bad === 0)) return;
      if (pick.length === need) {
        if (Math.abs(sum - target) >= 0.01) return;
        const all = sdet.concat(pick), sums = {}, cnt = {};
        all.forEach(function (d) { sums[d.type] = bfR3_((sums[d.type] || 0) + d.kg); cnt[d.type] = (cnt[d.type] || 0) + 1; });
        // side-box pairs first, then pairs with no plc after them (the box has none; a real row has its plc)
        const bad = pick.filter(function (d) { return Math.abs(sums[d.type] - d.kg) < 0.0005 && cnt[d.type] > 1; }).length * 100 + pick.filter(function (d) { return d.plc == null; }).length;
        if (!best || bad < best.bad) best = { cb: pick.slice(), bad: bad };
        return;
      }
      for (let a = from; a <= part.length - (need - pick.length); a++) { pick.push(part[a]); walk(a + 1, pick, bfR3_(sum + part[a].kg)); pick.pop(); }
    };
    walk(0, [], 0);
    if (best) {
      best.cb.forEach(function (d) { sdet.push(d); }); sdet.sort(function (a, b) { return a.pos - b.pos; });
      // bins left over (not part of a full group) belong to those rows, in order (a premix row's bin is H1)
      const used = {}; sdet.forEach(function (d) { if (!d.part) used[d.pos + 3] = 1; });
      const orphan = st.map(function (t, i) { return { t: t, i: i }; }).filter(function (x) { return !used[x.i] && (bfIsBin_(x.t) || /^8\d{3}$/.test(x.t)) && x.t.replace(/[^A-Za-z0-9]/g, '') !== destBin; });
      const fill = best.cb.filter(function (d) { return d.type !== 'H1'; });
      if (orphan.length === fill.length) fill.forEach(function (d, k) { const t = orphan[k].t; d.bin = /^8\d{3}$/.test(t) ? 'B' + t.slice(1) : bfBin_(t); });
      best.cb.forEach(function (d) { if (d.type === 'H1' && !d.bin) d.bin = 'H1'; });
    }
  }
  let stream = [];
  if (codes.length >= 2 && sdet.length >= 2) {
    const cut = sdet.slice(0, head.items || sdet.length);
    // a lone pair's "plc" equal to the next row number is that row number, not a plc
    if (codes.length >= cut.length) stream = cut.map(function (d, i) { return { no: i + 1, code: codes[i], name: codes[i], type: d.type, kg: d.kg, plc: d.part && d.plc === i + 2 ? null : d.plc, bin: d.bin }; });
  }
  // C) number rows without a code (Drive split the table into a left block of codes and a right block of "type weight plc bin")
  const det = [];
  L.forEach(function (s) {
    if (/TOTAL/i.test(s)) return;
    const tk = s.split(' '), ty = bfType_(tk[0] || ''), w = (tk[1] || '').replace(/[^\d.,]/g, '');
    if (!ty || !BF_W_.test(w) || bfCode_(s.split(' ')[0])) return;
    const plc = tk[2] && /^\d{1,3}$/.test(bfDigits_(tk[2])) ? Number(bfDigits_(tk[2])) : null;
    det.push({ type: ty, kg: bfNum_(w), plc: plc, bin: plc != null && tk[3] ? (bfType_(tk[3]) || bfBin_(tk[3].replace(/\?/g, ''))) : '' });
  });
  let cols = [];
  const detRun = det.length >= n && n >= 2 ? bfPickKg_(det.map(function (x) { return x.kg; }), n, total) : null;
  if (codes.length >= 2 && detRun && detRun.run) {
    for (let i = 0; i < n; i++) { const d = det[detRun.at + i], c = codes[i] || ''; cols.push({ no: i + 1, code: c, name: c, type: d.type, kg: d.kg, plc: d.plc, bin: d.bin }); }
  } else if (codes.length >= 2 && kgPick) {
    const types = bfPickType_(ts, n, kgPick.kg, ws) || [], pre = function (c) { return /^\d{2}-/.test(c); };
    const nPre = codes.slice(0, n).filter(pre).length, useBins = bins.length >= n - nPre; // a premix row shows "H1" in the Bin column
    let bi = 0;
    for (let i = 0; i < n; i++) {
      const c = codes[i] || '';
      cols.push({ no: i + 1, code: c, name: c, type: types[i] || (pre(c) ? 'H1' : ''), kg: kgPick.kg[i], plc: null, bin: pre(c) ? 'H1' : useBins ? bins[bi++] || '' : '' });
    }
    // details read as full "type weight plc bin" groups win over the guessed type window (matched by weight, in order)
    let dj = 0;
    cols.forEach(function (c) {
      for (let k = dj; k < Math.min(sdet.length, dj + 4); k++) if (!sdet[k].part && Math.abs(sdet[k].kg - c.kg) < 0.0005) { c.type = sdet[k].type; c.plc = sdet[k].plc; c.bin = sdet[k].bin; dj = k + 1; break; }
    });
  }

  // choose: the reading whose weights add up to the screen total with the right count
  const sumOf = function (a) { return bfR3_(a.reduce(function (x, r) { return x + (r.kg || 0); }, 0)); };
  const ok = function (a) { return a.length >= 2 && (!total || Math.abs(sumOf(a) - total) < 0.01) && (!head.items || a.length === head.items); };
  let lines = rows, how = 'row';
  if (!ok(rows) && ok(stream)) {
    stream.forEach(function (c) { const r = rows.filter(function (x) { return x.code === c.code; })[0]; if (r && r.name && r.name !== r.code) c.name = r.name; });
    lines = stream; how = 'stream';
  } else if (!ok(rows) && cols.length && (ok(cols) || rows.length < 2)) {
    // keep plc / bin / name read row by row where the code matches
    cols.forEach(function (c) { const r = rows.filter(function (x) { return x.code === c.code; })[0]; if (r) { if (r.plc != null) c.plc = r.plc; if (r.bin) c.bin = r.bin; if (r.name && r.name !== r.code) c.name = r.name; } });
    lines = cols; how = 'col';
  }
  lines.forEach(function (x, i) { if (x.no == null) x.no = i + 1; });
  const fixed = bfFix_(lines);
  const sum = sumOf(lines), warn = [];
  if (fixed.length) warn.push('ปรับชนิด/Plc ตามรหัสและ Plc (แถว ' + fixed.join(', ') + ') — ตรวจกับรูป');
  // the Type / Weight box on the right: each type's total should be one of the weights read
  const tsum = {}; lines.forEach(function (x) { if (x.type) tsum[x.type] = bfR3_((tsum[x.type] || 0) + (x.kg || 0)); });
  const tmiss = Object.keys(tsum).filter(function (t) { return !ws.some(function (w) { return Math.abs(w - tsum[t]) < 0.01; }); });
  if (lines.length > 1 && ws.length > lines.length && tmiss.length) warn.push('ยอดรวมชนิด ' + tmiss.map(function (t) { return t + ' ' + tsum[t]; }).join(', ') + ' ไม่ตรงกล่อง Type/Weight บนจอ — ตรวจชนิดแต่ละแถว');
  if (how === 'stream') { const pp = lines.filter(function (x) { return x.plc == null; }).map(function (x) { return x.no; }), pb = lines.filter(function (x) { return !x.bin; }).map(function (x) { return x.no; }); if (pp.length) warn.push('แถว ' + pp.join(', ') + ' อ่าน Plc ไม่ได้ — ใส่เองตามรูป'); if (pb.length && pb.length === lines.filter(function (x) { return x.type !== 'H1'; }).length && !lines.some(function (x) { return x.bin && x.bin !== 'H1'; })) warn.push('ในรูปไม่เห็นคอลัมน์ Bin — เลื่อนตาราง TAT01 ไปทางขวาให้เห็น Bin แล้วจับภาพใหม่ หรือพิมพ์ Bin เอง'); else if (pb.length) warn.push('แถว ' + pb.join(', ') + ' อ่าน Bin ไม่ได้ — ใส่เองตามรูป'); const cb = lines.filter(function (x, i) { return sdet[i] && sdet[i].cut; }).map(function (x) { return x.no; }); if (cb.length) warn.push('Bin ในรูปถูกตัด (แถว ' + cb.join(', ') + ') — ขยายหน้าต่าง TAT01 ให้เห็นคอลัมน์ Bin เต็ม หรือพิมพ์ Bin เอง'); }
  if (how === 'stream' && codes.length !== lines.length) warn.push('รหัสที่อ่านได้ ' + codes.length + ' รายการ ไม่เท่าจำนวนแถว ' + lines.length + ' — ตรวจรหัสทุกแถวกับรูป');
  if (how === 'col') warn.push('อ่านแบบแยกคอลัมน์ — ตรวจรหัส ชนิด น้ำหนัก Plc และ Bin ทุกแถวกับรูป');
  if (!lines.length) warn.push('อ่านรายการวัตถุดิบไม่ได้ — พิมพ์เองตามรูป');
  lines.forEach(function (x) { if (bfCut_(x.code)) warn.push('แถว ' + x.no + ' รหัสบนหน้าจอถูกตัด (' + x.code + ') — พิมพ์รหัสเต็ม'); });
  if (head.items && lines.length && head.items !== lines.length) warn.push('อ่านได้ ' + lines.length + ' รายการ จากทั้งหมด ' + head.items + ' — เพิ่มรายการที่ขาด');
  if (head.total && lines.length && Math.abs(head.total - sum) > 0.01) warn.push('ผลรวมที่อ่านได้ ' + sum + ' ไม่เท่า TOTAL ' + head.total);
  return { head: head, lines: lines, sum: sum, warn: warn, how: how };
}

// ---------- Drive: OCR + images (needs the Drive permission once) ----------
function bfBlob_(dataUrl, name) {
  const m = /^data:([\w\/+.-]+);base64,(.+)$/.exec(String(dataUrl || '')); if (!m) throw new Error('ไม่พบรูป');
  return Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name || 'image');
}
function ocrText_(blob) { // Drive v3: upload the image as a Google Doc (OCR), export the text, delete the temp doc
  const tk = ScriptApp.getOAuthToken(), bd = 'bfl' + Date.now(), H = { Authorization: 'Bearer ' + tk };
  const meta = { name: 'ProdApp-OCR-' + Date.now(), mimeType: 'application/vnd.google-apps.document' };
  const body = Utilities.newBlob('--' + bd + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + bd + '\r\nContent-Type: ' + blob.getContentType() + '\r\n\r\n').getBytes()
    .concat(blob.getBytes()).concat(Utilities.newBlob('\r\n--' + bd + '--').getBytes());
  const up = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&ocrLanguage=en&fields=id', {
    method: 'post', contentType: 'multipart/related; boundary=' + bd, payload: body, headers: H, muteHttpExceptions: true });
  if (up.getResponseCode() >= 300) throw new Error('อ่านรูปไม่สำเร็จ (Drive OCR ' + up.getResponseCode() + ') ' + up.getContentText().slice(0, 160));
  const id = JSON.parse(up.getContentText()).id;
  try {
    const ex = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id + '/export?mimeType=text/plain', { headers: H, muteHttpExceptions: true });
    if (ex.getResponseCode() >= 300) throw new Error('อ่านรูปไม่สำเร็จ (export ' + ex.getResponseCode() + ')');
    return ex.getContentText();
  } finally { UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + id, { method: 'delete', headers: H, muteHttpExceptions: true }); }
}
function bfFolder_() {
  const id = prop_('BFORM_FOLDER'); if (id) { try { return DriveApp.getFolderById(id); } catch (e) { } }
  const f = DriveApp.createFolder(BF.FOLDER); PropertiesService.getScriptProperties().setProperty('BFORM_FOLDER', f.getId()); return f;
}
function bfStore_(blob) { return bfFolder_().createFile(blob).getId(); }
// รายงาน NCP: รูปแยกโฟลเดอร์ของตัวเอง ไม่ปนกับรูปสูตร Batching (user 5 Nov 2026)
function nuFolder_() {
  const id = prop_('NCP_FOLDER'); if (id) { try { return DriveApp.getFolderById(id); } catch (e) { } }
  const f = DriveApp.createFolder('BFL ProdApp - รายงาน NCP'); PropertiesService.getScriptProperties().setProperty('NCP_FOLDER', f.getId()); return f;
}
function nuStore_(blob) { return nuFolder_().createFile(blob).getId(); }
function bfImage_(fileId) { const b = DriveApp.getFileById(fileId).getBlob(); return 'data:' + b.getContentType() + ';base64,' + Utilities.base64Encode(b.getBytes()); }

// ---------- read / compare ----------
// ---------- ข้อมูลเพิ่มของ Lot (user 7 Nov 2026): NCP_Usage_kg · Old_Semi · PC_Before / PC_After · Extruder log ----------
// NCP_Usage_kg: suggested from the pasted SCADA NCP reports (NCP_Usage) — a report column belongs to the lot whose latest สูตร Batching record
// of the same Formula_Code (OCR may cut the code short → prefix match) was recorded before the run ended. Lots that share one
// formula on the same day can be mis-assigned → Control checks the rows and can always type the number (manual).
// Old_Semi: Σ Kg of Old_Semi_Use (written by the BFLPacking record app: semi of an earlier lot used in this lot). PC_Before / PC_After: manual
// (Extruder log keeps only the pre-con Hz). Extruder_Detail: shown from Extruder log (Extruder_Lot_Info) — not typed here.
const LX = { SH: { A: '07:30', B: '16:00', C: '00:00' }, OSU: 'Old_Semi_Use', ELI: 'Extruder_Lot_Info' };
function ncpUseFor_(pid) {
  if (!ss_().getSheetByName(NU.TAB)) return [];
  const recs = bfRecs_(), norm = function (c) { return str_(c).toUpperCase().replace(/-+$/, ''); };
  // time = end of the run (Run_To; blank → end of the shift): the formula photo is often taken after the run started
  const tOf = function (r) {
    if (/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2}/.test(r.toT)) { const p = r.toT.split(' '), hm = p[1].split(':'); return new Date(p[0] + 'T' + ('0' + hm[0]).slice(-2) + ':' + hm[1].slice(0, 2) + ':00+07:00').getTime(); }
    const d = new Date(r.day + 'T' + (LX.SH[r.shift] || '07:30') + ':00+07:00').getTime() + (r.shift === 'A' ? 8.5 : r.shift === 'B' ? 8 : 7.5) * HOUR; return r.shift === 'C' ? d + 24 * HOUR : d;
  };
  return nuRecs_().filter(function (r) {
    const c = norm(r.code); if (c.length < 6) return false;
    const t = tOf(r), best = recs.filter(function (x) { return x.pid && norm(x.code).indexOf(c) === 0 && x.t <= t; }).sort(function (a, b) { return b.t - a.t; })[0];
    return !!best && best.pid === str_(pid);
  }).map(function (r) { return { day: r.day, shift: r.shift, code: r.code, from: r.fromT, to: r.toT, batches: r.batches, ncp: r.ncpA, act: r.actual }; })
    .sort(function (a, b) { return (a.day + a.shift).localeCompare(b.day + b.shift); });
}
function lotExtras(token, pid) {
  cacheOn_();
  session_(token);
  const lot = lots_()[str_(pid)]; if (!lot) throw new Error('ไม่พบ Lot');
  const nu = ncpUseFor_(lot.pid);
  const osu = ss_().getSheetByName(LX.OSU) ? table_(LX.OSU).rows.filter(function (r) { return str_(r.ProductionID) === lot.pid && !truthy_(r.Cancelled); }).map(function (r) {
    return { src: str_(r.Src_Lot_Number) || str_(r.Src_Name), type: str_(r.Src_Type), bags: num_(r.Bags), kg: num_(r.Kg) || 0, comment: str_(r.Comment) }; }) : [];
  const eli = ss_().getSheetByName(LX.ELI) ? table_(LX.ELI).rows.filter(function (r) { return str_(r.Lot_Number) === lot.lot; }).map(function (r) {
    const o = {}; Object.keys(r).forEach(function (k) { if (k !== '_row' && !/^(Updated|Checker)/i.test(k) && str_(r[k]) !== '') o[k] = r[k] instanceof Date ? fmt_(r[k], 'dd/MM/yy HH:mm') : str_(r[k]); }); return o; }) : [];
  const plr = table_(CFG.T.LOT).rows.filter(function (q) { return str_(q.ProductionID) === lot.pid; })[0] || {};
  return { sieve: str_(plr.Sieve_Detail).replace(/^"|"$/g, ''), ncpUse: { rows: nu, ncp: Math.round(nu.reduce(function (a, r) { return a + (r.ncp || 0); }, 0) * 10) / 10, act: Math.round(nu.reduce(function (a, r) { return a + (r.act || 0); }, 0) * 10) / 10 },
    oldSemi: { rows: osu, kg: Math.round(osu.reduce(function (a, r) { return a + r.kg; }, 0) * 10) / 10, sheet: !!ss_().getSheetByName(LX.OSU) }, ext: eli };
}
function bfRecs_() {
  if (!ss_().getSheetByName(BF.TAB)) return [];
  return table_(BF.TAB).rows.filter(function (r) { return str_(r.FormulaRecID) && !truthy_(r.Cancelled); }).map(function (r) {
    const t = date_(r.Recorded_At);
    return { id: str_(r.FormulaRecID), pid: str_(r.ProductionID), lot: str_(r.Lot_Number), productID: str_(r.ProductID), t: t ? t.getTime() : 0, mixer: str_(r.Mixer),
      code: str_(r.Formula_Code), name: str_(r.Formula_Name), date: r.Formula_Date instanceof Date ? fmt_(r.Formula_Date, 'dd/MM/yy') : str_(r.Formula_Date).replace(/^'/, ''),
      size: num_(r.Batch_Size_kg), multi: num_(r.Multi_Batch), job: str_(r.Job_No), plan: str_(r.Plan_Number), lotScreen: str_(r.Lot_On_Screen), total: num_(r.Total_kg),
      items: num_(r.Items), img: str_(r.Image_FileID), memo: str_(r.Memo), by: str_(r.CreatedBy), row: r._row };
  }).sort(function (a, b) { return a.t - b.t; });
}
function bfLines_() {
  const by = {}; if (!ss_().getSheetByName(BF.LINE)) return by;
  table_(BF.LINE).rows.forEach(function (r) {
    const id = str_(r.FormulaRecID); if (!id || truthy_(r.Cancelled)) return;
    (by[id] = by[id] || []).push({ no: num_(r.Line_No), code: str_(r.Ingredient_Code), name: str_(r.Ingredient_Name), type: str_(r.Type), kg: num_(r.Target_kg), plc: num_(r.Plc), bin: str_(r.Bin) });
  });
  Object.keys(by).forEach(function (k) { by[k].sort(function (a, b) { return (a.no || 0) - (b.no || 0); }); });
  return by;
}
function bfBase_(rec, recs) { // previous record of the same Formula Code; none → previous of the same product
  const before = recs.filter(function (x) { return x.id !== rec.id && x.t <= rec.t; });
  return before.filter(function (x) { return x.code && x.code === rec.code; }).pop() || before.filter(function (x) { return x.productID === rec.productID; }).pop() || null;
}
function bfDiff_(A, B) {
  const key = function (x) { return x.code || ('#' + x.no); }, ma = {}, mb = {}, order = [];
  A.forEach(function (x) { const k = key(x); if (!ma[k]) { ma[k] = Object.assign({}, x, { kg: 0 }); order.push(k); } ma[k].kg += x.kg || 0; });
  B.forEach(function (x) { const k = key(x); if (!mb[k]) { mb[k] = Object.assign({}, x, { kg: 0 }); if (!ma[k]) order.push(k); } mb[k].kg += x.kg || 0; });
  const rows = order.map(function (k) {
    const a = ma[k], b = mb[k], r = { code: k, name: (a || b).name, type: (a || b).type, a: a || null, b: b || null };
    if (a && !b) r.st = 'added'; else if (!a && b) r.st = 'removed';
    else { r.d = Math.round((a.kg - b.kg) * 1000) / 1000; r.pct = b.kg ? Math.round(r.d / b.kg * 1000) / 10 : null; r.binChg = a.bin !== b.bin; r.st = Math.abs(r.d) > 0.0005 ? 'changed' : (r.binChg || a.type !== b.type ? 'other' : 'same'); }
    return r;
  });
  const n = function (st) { return rows.filter(function (r) { return r.st === st; }).length; };
  return { rows: rows, changed: n('changed'), added: n('added'), removed: n('removed'), other: n('other'), same: n('same') };
}
function bfOut_(r, lines) { return Object.assign({}, r, { row: undefined, lines: lines || undefined, n: lines ? lines.length : r.items }); }
function bfSummary_(r, recs, L) { const b = bfBase_(r, recs); if (!b) return null; const d = bfDiff_(L[r.id] || [], L[b.id] || []); return { id: b.id, lot: b.lot, sameCode: b.code === r.code, changed: d.changed, added: d.added, removed: d.removed, other: d.other }; }

// list: {pid} → that lot · {q} → search lot / formula / product · default the latest 60
function bformList(token, x) {
  cacheOn_();
  session_(token); x = x || {};
  const recs = bfRecs_(), L = bfLines_(), q = str_(x.q).toLowerCase(), names = products_();
  let list = recs.slice();
  if (x.pid) list = list.filter(function (r) { return r.pid === str_(x.pid); });
  if (q) list = list.filter(function (r) { return (r.lot + ' ' + r.code + ' ' + r.name + ' ' + r.productID + ' ' + (names[r.productID] || '')).toLowerCase().indexOf(q) >= 0; });
  list = list.reverse().slice(0, x.pid ? 50 : 60);
  return list.map(function (r) { return Object.assign(bfOut_(r), { n: (L[r.id] || []).length, product: names[r.productID] || r.productID, base: bfSummary_(r, recs, L) }); });
}
// one record with its lines, compared with vs (record id) or the previous one of the same Formula Code
function bformGet(token, id, vs) {
  cacheOn_();
  session_(token);
  const recs = bfRecs_(), L = bfLines_(), r = recs.filter(function (x) { return x.id === str_(id); })[0]; if (!r) throw new Error('ไม่พบรายการสูตร');
  const b = vs ? recs.filter(function (x) { return x.id === str_(vs); })[0] : bfBase_(r, recs), names = products_();
  const cands = recs.filter(function (x) { return x.id !== r.id && (x.code === r.code || x.productID === r.productID); }).reverse().slice(0, 40)
    .map(function (x) { return { id: x.id, lot: x.lot, t: x.t, code: x.code, date: x.date, same: x.code === r.code }; });
  const head = ['code', 'name', 'date', 'size', 'multi', 'mixer', 'total'].map(function (k) { return { k: k, a: r[k], b: b ? b[k] : null, chg: !!b && String(r[k] == null ? '' : r[k]) !== String(b[k] == null ? '' : b[k]) }; });
  return { rec: Object.assign(bfOut_(r, L[r.id] || []), { product: names[r.productID] || r.productID }), base: b ? Object.assign(bfOut_(b, L[b.id] || []), { product: names[b.productID] || b.productID }) : null,
    diff: b ? bfDiff_(L[r.id] || [], L[b.id] || []) : null, head: head, cands: cands };
}
function bformImage(token, id) {
  session_(token);
  const r = bfRecs_().filter(function (x) { return x.id === str_(id); })[0]; if (!r || !r.img) throw new Error('ไม่มีรูป');
  return bfImage_(r.img);
}
// x = { img: dataURL (screen photo, enlarged for reading) } → text + parsed fields + matching lot
function bformOcr(token, x) {
  const me = session_(token, 'work'), text = ocrText_(bfBlob_(x && x.img, 'ocr.jpg')), p = bfParse_(text), lots = lots_();
  try { // every reading is kept (also when not saved) so the reader can be tuned from real screens
    (wrote_(BF.LOG), ensureTab_(BF.LOG, BF.LOGHEAD)).appendRow([new Date(), by_(me), p.how, p.lines.length, p.sum, p.head.total, p.head.items, p.head.lot, String(text).slice(0, 45000)]);
  } catch (e) { }
  const lot = p.head.lot ? Object.keys(lots).map(function (k) { return lots[k]; }).filter(function (l) { return l.lot === p.head.lot; })[0] : null;
  return { text: text, head: p.head, lines: p.lines, sum: p.sum, warn: p.warn, pid: lot ? lot.pid : '' };
}
// x = { pid, t, head: {code,name,date,size,multi,job,plan,lot,mixer,total}, lines: [{no,code,name,type,kg,plc,bin}], img (dataURL), text, memo }
function bformSave(token, x) {
  const me = session_(token, 'work');
  const lot = lots_()[str_(x.pid)]; if (!lot) throw new Error('เลือก Lot');
  const h = x.head || {}, code = str_(h.code).toUpperCase(); if (!code) throw new Error('ใส่ Formula Code');
  const t = new Date(x.t ? Number(x.t) : Date.now()); if (isNaN(t) || t.getTime() > Date.now() + CFG.FUTURE_MIN * MIN) throw new Error('เวลาไม่ถูกต้อง');
  const lines = (x.lines || []).map(function (l, i) {
    return { no: num_(l.no) || i + 1, code: str_(l.code).toUpperCase(), name: str_(l.name) || str_(l.code).toUpperCase(), type: str_(l.type).toUpperCase(), kg: num_(l.kg), plc: num_(l.plc), bin: str_(l.bin).toUpperCase() };
  }).filter(function (l) { return l.code || l.kg != null; });
  if (!lines.length) throw new Error('ไม่มีรายการวัตถุดิบ');
  lines.forEach(function (l) { if (!l.code) throw new Error('แถว ' + l.no + ': ใส่ Ingredient Code'); if (!(l.kg > 0)) throw new Error(l.code + ': ใส่น้ำหนัก (kg)'); });
  if (!x.img) throw new Error('แนบรูปหน้าจอ Batching');
  bfTabs_();
  const id = id8_(), now = new Date();
  const fileId = bfStore_(bfBlob_(x.img, lot.lot + '_' + code + '_' + fmt_(t, 'yyyyMMdd-HHmm') + '_' + id + '.jpg'));
  const total = Math.round(lines.reduce(function (a, l) { return a + l.kg; }, 0) * 1000) / 1000;
  withLock_(function () {
    appendRows_(BF.TAB, [{ FormulaRecID: id, ProductionID: lot.pid, Lot_Number: lot.lot, ProductID: lot.productID, Recorded_At: t, Mixer: str_(h.mixer), Formula_Code: code,
      Formula_Name: str_(h.name), Formula_Date: "'" + str_(h.date), Batch_Size_kg: num_(h.size) == null ? '' : num_(h.size), Multi_Batch: num_(h.multi) == null ? '' : num_(h.multi),
      Job_No: str_(h.job), Plan_Number: str_(h.plan), Lot_On_Screen: str_(h.lot), Total_kg: total, Items: lines.length, Image_FileID: fileId, OCR_Text: str_(x.text).slice(0, 45000),
      Memo: str_(x.memo), Cancelled: false, CreatedBy: by_(me), CreateTimestamp: now, UpdatedTimestamp: now }]);
    appendRows_(BF.LINE, lines.map(function (l) {
      return { LineID: id8_(), FormulaRecID: id, Line_No: l.no, Ingredient_Code: l.code, Ingredient_Name: l.name, Type: l.type, Target_kg: l.kg, Plc: l.plc == null ? '' : l.plc, Bin: l.bin, Cancelled: false };
    }));
  });
  return bformGet(token, id);
}
function bformCancel(token, id) {
  const me = session_(token, 'work');
  return withLock_(function () {
    const r = bfRecs_().filter(function (x) { return x.id === str_(id); })[0]; if (!r) throw new Error('ไม่พบรายการสูตร');
    setCells_(BF.TAB, r.row, { Cancelled: true, UpdatedTimestamp: new Date(), UpdatedBy: by_(me) });
    return { ok: true };
  });
}
// ---------- NCP usage by formula (user 29 Oct): SCADA "SUM INGREDIENT USAGE BY FORMULA" picture → one record per shift + formula →
// daily table like the team's Excel (Total Batch, Total weight, NCP Usage by Formula, Actual NCP Usage, Ratio, Diff, สาเหตุ).
// NCP rows = every ingredient code 04RW… (user: FT rework counts too). Shifts of a production day: A 07:30–16:00, B 16:00–24:00, C 00:00–07:30 (next day).
const NU = {
  TAB: 'NCP_Usage', LINE: 'NCP_Usage_Line',
  HEAD: ['NCPUsageID', 'Prod_Date', 'Shift', 'Formula_Code', 'Formula_Name', 'Prod_No_From', 'Prod_No_To', 'Run_From', 'Run_To', 'Batches', 'Target_kg', 'Actual_kg', 'NCP_Target_kg',
    'NCP_Actual_kg', 'Cause', 'Image_FileID', 'OCR_Text', 'Cancelled', 'CreatedBy', 'CreateTimestamp', 'UpdatedTimestamp', 'UpdatedBy', 'Mill_Target_kg', 'Mill_Actual_kg'],
  LHEAD: ['LineID', 'NCPUsageID', 'Line_No', 'Ingredient_Code', 'Ingredient_Name', 'Bin', 'Target_kg', 'Actual_kg', 'Deviation_kg', 'Is_NCP', 'Cancelled', 'Is_Mill'],
  SHIFTS: [['A', '07:30-16.00'], ['B', '16.00-00.00'], ['C', '00.00-07.30']]
};
function nuTabs_() { ensureTab_(NU.TAB, NU.HEAD); ensureTab_(NU.LINE, NU.LHEAD); }
function nuIsNcp_(code) { return /^04RW/i.test(str_(code)); }
// ingredient code as SCADA prints it (often cut: 01AM004-10, 97-DG18RTR); OCR may read 0 as O, 1 as I / l
function nuCode_(tok) {
  const t = String(tok || '').replace(/[^A-Za-z0-9\-]/g, '');
  let m = /^([0-9OoIlQD]{2})([A-Za-z]{2}|[A-Za-z][015]|[015][A-Za-z])([0-9OoIlSBZ]{3})(-[A-Za-z0-9]{1,12})?$/.exec(t);
  if (m) return bfDigits_(m[1]) + m[2].toUpperCase().replace(/1/g, 'I').replace(/0/g, 'O').replace(/5/g, 'S') + bfDigits_(m[3]) + (m[4] || '').toUpperCase();
  m = /^([0-9OoIl]{2})-([A-Za-z0-9][A-Za-z0-9\-]{2,})$/.exec(t);
  if (m && /[A-Za-z]/.test(m[2])) return bfDigits_(m[1]) + '-' + m[2].toUpperCase();
  return '';
}
// x,xxx.xxx or x.xxx.xxx (SCADA prints 3 decimals; OCR may read the thousands comma as a dot)
function nuNum_(tok) {
  if (/^-?0$/.test(String(tok || '').trim())) return 0; // new layout prints a zero deviation as 0
  const t = String(tok || '').replace(/[^\d.,\-]/g, ''), m = /^(-?)(\d{1,3}(?:[.,]\d{3})*|\d+)[.,](\d{2,3})$/.exec(t); // the Total line prints 2 decimals (43,239.00)
  return m ? (m[1] ? -1 : 1) * Number(m[2].replace(/[.,]/g, '') + '.' + m[3]) : null;
}
function nuBin_(tok) { // B002 · BI26 · BIA1 · H1 (OCR: Boos = B005, BO10 = B010)
  if (/[.,]/.test(String(tok || ''))) return '';
  const t = String(tok || '').replace(/[^A-Za-z0-9]/g, '');
  if (/^(H\d|DL)$/i.test(t)) return t.toUpperCase(); // H1 hand-add · DL
  const bi = /^[Bb8][Il1|][Aa4]([0-9OoIlZSQD])$/.exec(t); if (bi) return 'BIA' + bfDigits_(bi[1]); // BIA1–BIA3 (OCR: B1A1 · BlA2 · BIAI)
  const m = /^[Bb8]([IiAa]{0,2})([0-9OoQDSsIlZ]{1,4})$/.exec(t);
  return m && /\d/.test(t.slice(1)) || m && /^[Bb]/.test(t) && m[2].length >= 2 ? 'B' + m[1].toUpperCase() + bfDigits_(m[2]) : '';
}
function nuParse_(text) {
  const L = String(text || '').split(/\r?\n/).map(function (s) { return s.replace(/[\[\]|{}]/g, ' ').replace(/\s+/g, ' ').trim(); }).filter(Boolean), all = L.join('\n');
  const head = {}, warn = [];
  let m = /Formula\s*Code\s*:?\s*([0-9OoIl]{2}\s?-\s?[A-Za-z0-9\-]{3,})/i.exec(all); head.code = m ? nuCode_(m[1].replace(/\s/g, '')) : '';
  // real reading 29 Oct 11:50: labels in one block ("Formula Code:" / "From Date:"), values later — "97-DG18RTRB-N Dog18% Raptor dog | Formula Version :"
  const vt = function (s) { return s.replace(/^Formula\s*Code\s*:?\s*/i, ''); };
  const vl = L.filter(function (s) { return /Formula\s*Version/i.test(s) && nuCode_(vt(s).split(' ')[0]); })[0];
  if (!head.code && vl) head.code = nuCode_(vt(vl).split(' ')[0]);
  m = /Formula[ \t]*Name[ \t]*:?[ \t]*([^\n]+)/i.exec(all); head.name = m ? m[1].replace(/\s*Production.*$/i, '').trim() : '';
  if (!head.name && vl) head.name = vt(vl).replace(/^\S+\s*/, '').replace(/\s*Formula\s*Version.*$/i, '').trim();
  if (!head.name) { // layout of 29 Oct 11:34: no "Formula Name" label, the name follows the code (often cut)
    m = /Formula[ \t]*Code[ \t]*:?[ \t]*\S+[ \t]+([^\n]+?)[ \t]*(?:Formula\s*Version|$)/im.exec(all);
    const nl = m && /[A-Za-z]{3}/.test(m[1]) ? m[1] : L.filter(function (s) { return /[A-Za-z]{3,}\s*\d+(?:\.\d+)?%/.test(s) && !/REWORK|Formula\s*Code/i.test(s) && !nuCode_(s.split(' ')[0]); })[0];
    head.name = nl ? nl.replace(/\s*Formula\s*Version.*$/i, '').trim() : '';
  }
  m = /Total\s*Batch\s*:?\s*(\d{1,4})\b/i.exec(all); if (m) head.batches = Number(m[1]);
  const dt = function (re) { const x = re.exec(all); return x ? { d: x[3] + '-' + ('0' + x[2]).slice(-2) + '-' + ('0' + x[1]).slice(-2), t: ('0' + x[4]).slice(-2) + ':' + x[5] } : null; };
  // date-times in reading order: the title "INGREDIENT USAGE BY FORMULA <from> To <to>" is the report window, the others are the run From / To
  const DT = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/g, win = /USAGE\s*BY\s*FORMULA[^\n]*/i.exec(all), dts = [], wds = [];
  let x0; while ((x0 = DT.exec(all))) (win && x0.index >= win.index && x0.index < win.index + win[0].length ? wds : dts).push(x0);
  const cv = function (x) { return x ? { d: x[3] + '-' + ('0' + x[2]).slice(-2) + '-' + ('0' + x[1]).slice(-2), t: ('0' + x[4]).slice(-2) + ':' + x[5] } : null; };
  let f0 = cv(dts[0]), t0 = cv(dts[1]);
  if (!(f0 && t0) && wds.length === 2) { f0 = cv(wds[0]); t0 = cv(wds[1]); }
  if (f0) head.fromT = f0.d + ' ' + f0.t; if (t0) head.toT = t0.d + ' ' + t0.t;
  if (f0 && t0) { // the shift that holds the middle of the run (A 07:30–16:00 · B 16:00–24:00 · C 00:00–07:30 of the day before)
    const ms = function (x) { return new Date(x.d + 'T' + x.t + ':00Z').getTime(); }, mid = new Date((ms(f0) + ms(t0)) / 2), mm = mid.getUTCHours() * 60 + mid.getUTCMinutes();
    const day = mm < 450 ? new Date(mid.getTime() - 864e5) : mid; head.day = day.toISOString().slice(0, 10); head.shift = mm < 450 ? 'C' : mm < 960 ? 'A' : 'B';
  }
  m = /(\d{8,12}\s?-\s?\S{1,4})\s*T[o0]\s*(\d{8,12}\s?-\s?\d{1,4})/i.exec(all);
  if (m) { head.from = m[1].replace(/\s/g, '').replace(/[^\d\-]+$/, ''); head.to = m[2].replace(/\s/g, ''); }
  // Total line: target, actual, deviation (the last numbers after the word Total)
  const ti = all.search(/\bTotal\b(?!\s*Batch)|Ton\s*\/\s*Hr/i), tot = ti >= 0 ? all.slice(ti).split(/\s+/).slice(1).map(nuNum_).filter(function (v) { return v != null; }) : [];
  m = /([\d.]+)\s*Ton\s*\/\s*Hr/i.exec(all); if (m) head.tph = Number(m[1]);
  if (tot.length >= 2) { head.totalTarget = tot[0]; head.totalActual = tot[1]; }
  let tl = L.findIndex(function (s) { return /^Tota?l\b(?!\s*Batch)|Ton\s*\/\s*Hr/i.test(s); }); // nothing from the Total / Ton/Hr line on belongs to the rows
  if (tl > 0 && /^\d+(?:[.,]\d+)?$/.test(L[tl - 1]) && /^Ton/i.test(L[tl])) tl--; // "4.44" on its own line before "Ton/Hr."
  const body = (tl > 0 ? L.slice(0, tl) : L).filter(function (s) { return !/Formula|Production|SUM\s*INGREDIENT|Ingredient\s*(Code|Name)|\bTotal\b|From\s*Date|Bin\s*Code|Target\s*Weight|Actual\s*Weight|บริษัท/i.test(s); });
  // A) row by row: a line with code … bin target actual deviation (actual − target = deviation)
  const rows = [];
  body.forEach(function (s) {
    const tk = s.split(' '), nums = [];
    tk.forEach(function (t, i) { const v = nuNum_(t); if (v != null) nums.push({ i: i, v: v }); });
    if (nums.length < 3) return;
    const k = nums.length - 3, T = nums[k].v, A = nums[k + 1].v, D = nums[k + 2].v;
    if (Math.abs(A - T - D) > 0.011 && Math.abs(Math.abs(A - T) - Math.abs(D)) > 0.011) return; // the minus sign of the deviation is often lost
    let rest = tk.slice(0, nums[k].i), code = nuCode_(rest[0]);
    if (!code && rest.length > 1) { code = nuCode_(rest[0] + rest[1]); if (code) rest = [rest[0] + rest[1]].concat(rest.slice(2)); }
    const bin = rest.length > 1 ? nuBin_(rest[rest.length - 1]) : '';
    const mid = rest.slice(1, bin ? rest.length - 1 : rest.length), full = mid.map(nuCode_).filter(function (c) { return c && code && c.indexOf(code) === 0 && c.length > code.length; })[0];
    rows.push({ code: full || code, name: full ? full : mid.join(' '), bin: bin, target: T, actual: A, dev: bfR3_(A - T) });
  });
  // B) column by column (Drive often reads a table one column at a time): codes, bins and numbers each in reading order
  const tks = body.join(' ').split(' '), nums = tks.map(nuNum_).filter(function (v) { return v != null; });
  const codes = [], bins = [];
  // the formula code itself (header) is not an ingredient — real reading 29 Oct put it on its own line above the table
  tks.forEach(function (t) { const c = nuCode_(t); if (c) { if (c !== head.code) codes.push(c); } else { const b = nuBin_(t); if (b) bins.push(b); } });
  let cols = [];
  const dOk = function (t, a, d) { return Math.abs(Math.abs(a - t) - Math.abs(d)) < 0.011; };
  const fit = function (T, A, D) { return T.every(function (t, i) { return dOk(t, A[i], D[i]); }); };
  for (let n = Math.min(40, Math.floor(nums.length / 3)); n >= 2 && !cols.length; n--) {
    for (let s0 = 0; s0 + 3 * n <= nums.length && !cols.length; s0++) {
      const T = nums.slice(s0, s0 + n), A = nums.slice(s0 + n, s0 + 2 * n), D = nums.slice(s0 + 2 * n, s0 + 3 * n);
      if (fit(T, A, D)) cols = T.map(function (t, i) { return { target: t, actual: A[i], dev: bfR3_(A[i] - t) }; });
    }
    if (!cols.length) for (let s0 = 0; s0 + 3 * n <= nums.length && !cols.length; s0++) { // interleaved triples somewhere in the stream
      const tr = []; for (let i = 0; i < n; i++) tr.push(nums.slice(s0 + 3 * i, s0 + 3 * i + 3));
      if (tr.every(function (x) { return dOk(x[0], x[1], x[2]); })) cols = tr.map(function (x) { return { target: x[0], actual: x[1], dev: bfR3_(x[1] - x[0]) }; });
    }
  }
  // the Total line read as one more triple (its numbers came before the word Total): drop it, keep it as the totals
  if (cols.length >= 3) {
    const last = cols[cols.length - 1], rest = cols.slice(0, -1), sT = bfR3_(rest.reduce(function (a, r) { return a + r.target; }, 0)), sA = bfR3_(rest.reduce(function (a, r) { return a + r.actual; }, 0));
    if (Math.abs(last.target - sT) < 0.02 && Math.abs(last.actual - sA) < 0.02) { cols.pop(); if (head.totalTarget == null) head.totalTarget = last.target; if (head.totalActual == null) head.totalActual = last.actual; }
  }
  if (cols.length) {
    // the code column comes first (cut codes); full codes from the name column fill in the rest of a cut code
    const n = cols.length, base = [];
    codes.forEach(function (c) { if (base.length < n && !base.some(function (b) { return c.indexOf(b) === 0 && c.length > b.length; })) base.push(c); });
    const full = base.slice();
    codes.forEach(function (c) { const k = full.findIndex(function (b, i) { return b === base[i] && c.indexOf(b) === 0 && c.length > b.length; }); if (k >= 0) full[k] = c; });
    cols.forEach(function (r, i) { r.code = full[i] || ''; r.name = full[i] || ''; r.bin = bins.length === n ? bins[i] : ''; });
  }
  // C) record by record (new layout read by Google, 29 Oct 11:50): "code [name]" / [name] / bin / target / actual / deviation, one cell per line
  const blk = []; let cur = null;
  const close = function () {
    if (cur && cur.nums.length >= 2 && (cur.nums.length < 3 || dOk(cur.nums[0], cur.nums[1], cur.nums[2]))) {
      const fc = nuCode_(cur.name.split(' ')[0]), full = fc && fc.indexOf(cur.code) === 0 && fc.length > cur.code.length ? fc : '';
      blk.push({ code: full || cur.code, name: cur.name || cur.code, bin: cur.bin, target: cur.nums[0], actual: cur.nums[1], dev: bfR3_(cur.nums[1] - cur.nums[0]) });
    }
    cur = null;
  };
  body.forEach(function (s) {
    const tk = s.split(' '), c = nuCode_(tk[0]);
    if (c && c !== head.code && (!cur || cur.nums.length >= 2 || cur.bin || cur.name)) { close(); cur = { code: c, name: tk.slice(1).join(' '), bin: '', nums: [] }; return; }
    if (!cur) return;
    if (cur.nums.length >= 2 && /^-?[oOоО0]$/.test(s)) { cur.nums.push(0); return; } // zero deviation read as the letter o
    const nv = tk.map(nuNum_);
    if (nv.every(function (v) { return v != null; })) { cur.nums = cur.nums.concat(nv); return; }
    const b = !cur.bin && !cur.nums.length ? nuBin_(tk[0]) : '';
    if (b) { cur.bin = b; cur.nums = cur.nums.concat(tk.slice(1).map(nuNum_).filter(function (v) { return v != null; })); return; }
    if (!cur.nums.length && !cur.bin && !cur.name) cur.name = s; // name on its own line
  });
  close();
  // D) sequence (29 Oct 12:55, KF33): Google groups several codes on one line and their bins / numbers below, even two targets on one line
  //    (215.700 2,372.700 / 217.200 / 1.500 / 2,372.200 / -0.500). Rows are rebuilt from the numbers alone: a number is the actual of an
  //    open row when actual − target shows up as the deviation within the next numbers (or actual = target); otherwise it starts a new row.
  const hi = body.findIndex(function (s) { return /^D[ie]v[il]?ation$/i.test(s); }), sb = hi >= 0 ? body.slice(hi + 1) : body;
  const sn = [], sc = [], sbin = [];
  sb.forEach(function (s) {
    if (/^-?[oOоОcC]$/.test(s)) { sn.push(0); return; } // zero deviation read as a letter
    const tk = s.split(' '); let row = null, txt = [];
    tk.forEach(function (t) {
      const v = nuNum_(t); if (v != null) { sn.push(v); return; }
      const c = nuCode_(t); if (c) { row = { code: c, line: true }; sc.push(row); return; }
      const b = nuBin_(t); if (b && tk.length <= 3) { sbin.push(b); return; }
      if (row) { row.name = (row.name ? row.name + ' ' : '') + t; }
      else txt.push(t);
    });
    if (txt.length && !row && /[A-Za-z]{3}/.test(txt.join(' '))) sc.push({ text: txt.join(' ') }); // a name on its own line
  });
  const zz = function (x) { return String(x).replace(/O/g, '0'); }, srow = [];
  sc.forEach(function (x) {
    if (x.text) { const r = srow.filter(function (r) { return !r.name; }).pop(); if (r) r.name = x.text; return; }
    const r = srow.filter(function (r) { return !r.full && zz(x.code).indexOf(zz(r.code)) === 0 && x.code.length > r.code.length; })[0];
    if (r) { r.full = x.code; if (x.name && !r.name) r.name = x.name; } else srow.push({ code: x.code, name: x.name || '' });
  });
  const seq = [];
  for (let i = 0; i < sn.length; i++) {
    const v = sn[i], wd = seq.filter(function (r) { return r.a != null && r.d == null; })[0];
    if (wd) {
      if (dOk(wd.t, wd.a, v)) { wd.d = v; continue; }
      wd.d = bfR3_(wd.a - wd.t); // deviation lost
    }
    const near = sn.slice(i + 1, i + 4), op = seq.filter(function (r) { return r.a == null; });
    const r = op.filter(function (r) { return Math.abs(v - r.t) < 0.0005 || near.some(function (d) { return dOk(r.t, v, d); }); })[0];
    if (r) r.a = v; else seq.push({ t: v });
  }
  const sq = seq.every(function (r) { return r.a != null; }) ? seq.map(function (r, i) {
    const w = srow.length === seq.length ? srow[i] : null;
    return { code: w ? w.full || w.code : '', name: w ? (w.name || w.full || w.code) : '', bin: sbin.length === seq.length ? sbin[i] : '', target: r.t, actual: r.a, dev: bfR3_(r.a - r.t) };
  }) : [];
  const sum = function (a, k) { return bfR3_(a.reduce(function (x, r) { return x + (r[k] || 0); }, 0)); };
  const ok = function (a) { return a.length >= 2 && (head.totalTarget == null || Math.abs(sum(a, 'target') - head.totalTarget) < 0.01) && (head.totalActual == null || Math.abs(sum(a, 'actual') - head.totalActual) < 0.01); };
  let lines = rows, how = 'row';
  if (ok(blk) && blk.length >= rows.length && (!ok(rows) || blk.some(function (r) { return r.bin; }) && !rows.some(function (r) { return r.bin; }))) { lines = blk; how = 'blk'; }
  else if (!ok(rows) && (ok(cols) || cols.length > rows.length)) {
    cols.forEach(function (c) { const r = rows.filter(function (x) { return Math.abs(x.target - c.target) < 0.001 && Math.abs(x.actual - c.actual) < 0.001; })[0]; if (r) { if (r.code) c.code = r.code; if (r.name) c.name = r.name; if (r.bin) c.bin = r.bin; } });
    lines = cols; how = 'col';
  }
  if (!ok(lines) && ok(sq)) { lines = sq; how = 'seq'; }
  lines.forEach(function (r, i) { r.no = i + 1; r.ncp = nuIsNcp_(r.code); if (!r.name) r.name = r.code; });
  const tT = sum(lines, 'target'), tA = sum(lines, 'actual');
  if (!lines.length) warn.push('อ่านรายการไม่ได้ — พิมพ์เองตามรูป');
  if (head.totalTarget != null && lines.length && Math.abs(tT - head.totalTarget) > 0.01) warn.push('Target รวม ' + tT + ' ไม่เท่า Total ' + head.totalTarget);
  if (head.totalActual != null && lines.length && Math.abs(tA - head.totalActual) > 0.01) warn.push('Actual รวม ' + tA + ' ไม่เท่า Total ' + head.totalActual);
  lines.forEach(function (r) { if (!r.code) warn.push('แถว ' + r.no + ' อ่านรหัสไม่ได้ — ใส่เองตามรูป'); });
  if (lines.length && !lines.some(function (r) { return r.ncp; })) warn.push('ไม่พบแถว 04RW — NCP ของสูตรนี้ = 0 (ถ้าในรูปมีแถว 04RW ให้ตรวจรหัส)');
  return { head: head, lines: lines, warn: warn, how: how };
}
// batch size of the formula from the last สูตร Batching record whose code starts with the SCADA code (97-DG18RTRB-NA → 97-DG18RTRB-NA-31)
// several lots of one formula can have different batch sizes (1,544.25 / 1,424.25): take the latest record whose size gives a whole number of batches
function nuBatchSize_(code, target) {
  if (!code || !ss_().getSheetByName(BF.TAB)) return null;
  const rs = bfRecs_().filter(function (x) { return x.code && x.code.indexOf(code) === 0 && x.size > 0; }).reverse(); // SCADA may cut the code: 97-DG18RTRB-N…
  const off = function (r) { const v = target / r.size; return Math.round(v) >= 1 ? Math.abs(v - Math.round(v)) : 1; };
  let r = rs[0]; if (target > 0) rs.forEach(function (x) { if (off(x) < off(r) - 1e-9) r = x; }); // closest to a whole number; ties → newest
  return r ? { size: r.size, code: r.code, lot: r.lot, name: r.name } : null;
}
function nuBatches_(target, bs) { if (!bs || !(target > 0)) return null; const v = target / bs.size; return Math.abs(v - Math.round(v)) < 0.05 ? Math.round(v) : Math.round(v * 100) / 100; }
function nuOcr(token, x) {
  const me = session_(token, 'work'), text = ocrText_(bfBlob_(x && x.img, 'scada.jpg')), p = nuParse_(text);
  const tT = bfR3_(p.lines.reduce(function (a, r) { return a + r.target; }, 0)), tA = bfR3_(p.lines.reduce(function (a, r) { return a + r.actual; }, 0));
  try { (wrote_(BF.LOG), ensureTab_(BF.LOG, BF.LOGHEAD)).appendRow([new Date(), by_(me), 'scada-' + p.how, p.lines.length, tA, p.head.totalActual == null ? '' : p.head.totalActual, '', p.head.code, String(text).slice(0, 45000)]); } catch (e) { }
  const bs = nuBatchSize_(p.head.code, p.head.totalTarget || tT);
  if (p.head.batches == null) p.head.batches = nuBatches_(p.head.totalTarget || tT, bs); else p.head.batchesRead = true; // new layout prints Total Batch
  if (bs && bs.name && (!p.head.name || (bs.name.indexOf(p.head.name.replace(/[^A-Za-z0-9% ]+$/, '').trim()) === 0 && bs.name.length > p.head.name.length))) p.head.name = bs.name; // the report cuts the name
  return { text: text, head: p.head, lines: p.lines, warn: p.warn, batch: bs };
}
function nuRecs_() {
  if (!ss_().getSheetByName(NU.TAB)) return [];
  return table_(NU.TAB).rows.filter(function (r) { return str_(r.NCPUsageID) && !truthy_(r.Cancelled); }).map(function (r) {
    return { id: str_(r.NCPUsageID), day: r.Prod_Date instanceof Date ? fmt_(r.Prod_Date, 'yyyy-MM-dd') : str_(r.Prod_Date).replace(/^'/, ''), shift: str_(r.Shift), code: str_(r.Formula_Code),
      name: str_(r.Formula_Name), from: str_(r.Prod_No_From).replace(/^'/, ''), to: str_(r.Prod_No_To).replace(/^'/, ''), fromT: str_(r.Run_From).replace(/^'/, ''), toT: str_(r.Run_To).replace(/^'/, ''), batches: num_(r.Batches), target: num_(r.Target_kg) || 0,
      actual: num_(r.Actual_kg) || 0, ncpT: num_(r.NCP_Target_kg) || 0, ncpA: num_(r.NCP_Actual_kg) || 0, millT: num_(r.Mill_Target_kg) || 0, millA: num_(r.Mill_Actual_kg) || 0, cause: str_(r.Cause), img: str_(r.Image_FileID), by: str_(r.CreatedBy),
      t: (date_(r.CreateTimestamp) || new Date(0)).getTime(), row: r._row };
  });
}
// x = { day: yyyy-MM-dd, shift: A|B|C, head: {code, name, from, to, batches}, lines: [{code, name, bin, target, actual, dev}], img, text, cause }
function nuSave(token, x) {
  const me = session_(token, 'work'), day = str_(x.day), sh = str_(x.shift).toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('เลือกวันผลิต');
  if (!NU.SHIFTS.some(function (s) { return s[0] === sh; })) throw new Error('เลือกกะ');
  const h = x.head || {}, code = str_(h.code).toUpperCase(); if (!code) throw new Error('ใส่ Formula Code');
  const lines = (x.lines || []).map(function (l, i) {
    const c = str_(l.code).toUpperCase(), t = num_(l.target), a = num_(l.actual);
    return { no: i + 1, code: c, name: str_(l.name) || c, bin: str_(l.bin).toUpperCase(), target: t, actual: a, dev: num_(l.dev) == null && t != null && a != null ? bfR3_(a - t) : num_(l.dev), mill: nuIsNcp_(c) && !!l.mill, ncp: nuIsNcp_(c) && !l.mill };
  }).filter(function (l) { return l.code || l.target != null || l.actual != null; });
  if (!lines.length) throw new Error('ไม่มีรายการวัตถุดิบ');
  lines.forEach(function (l) { if (!l.code) throw new Error('แถว ' + l.no + ': ใส่ Ingredient Code'); if (l.target == null || l.actual == null) throw new Error(l.code + ': ใส่ Target และ Actual'); });
  if (!x.img) throw new Error('แนบรูปรายงาน SCADA');
  const sumK = function (k, ncp) { return bfR3_(lines.reduce(function (a, l) { return a + (ncp === true && !l.ncp || ncp === 'mill' && !l.mill ? 0 : l[k]); }, 0)); };
  nuTabs_();
  const id = id8_(), now = new Date();
  const fileId = nuStore_(bfBlob_(x.img, 'NCP_' + day + '_' + sh + '_' + code + '_' + id + '.jpg'));
  withLock_(function () {
    appendRows_(NU.TAB, [{ NCPUsageID: id, Prod_Date: "'" + day, Shift: sh, Formula_Code: code, Formula_Name: str_(h.name), Prod_No_From: "'" + str_(h.from), Prod_No_To: "'" + str_(h.to), Run_From: "'" + str_(h.fromT), Run_To: "'" + str_(h.toT),
      Batches: num_(h.batches) == null ? '' : num_(h.batches), Target_kg: sumK('target'), Actual_kg: sumK('actual'), NCP_Target_kg: sumK('target', true), NCP_Actual_kg: sumK('actual', true), Mill_Target_kg: sumK('target', 'mill'), Mill_Actual_kg: sumK('actual', 'mill'),
      Cause: str_(x.cause), Image_FileID: fileId, OCR_Text: str_(x.text).slice(0, 45000), Cancelled: false, CreatedBy: by_(me), CreateTimestamp: now, UpdatedTimestamp: now }]);
    appendRows_(NU.LINE, lines.map(function (l) {
      return { LineID: id8_(), NCPUsageID: id, Line_No: l.no, Ingredient_Code: l.code, Ingredient_Name: l.name, Bin: l.bin, Target_kg: l.target, Actual_kg: l.actual, Deviation_kg: l.dev == null ? '' : l.dev, Is_NCP: l.ncp, Is_Mill: l.mill, Cancelled: false };
    }));
  });
  return nuDay(token, day);
}
// the day's table: per shift, one column per formula (several reports of one formula in a shift are added up) + Summarize; day totals in tons
function nuDay(token, day) {
  cacheOn_();
  session_(token);
  const d = /^\d{4}-\d{2}-\d{2}$/.test(str_(day)) ? str_(day) : fmt_(new Date(Date.now() - 7.5 * HOUR), 'yyyy-MM-dd');
  const recs = nuRecs_().filter(function (r) { return r.day === d; });
  const shifts = NU.SHIFTS.map(function (S) {
    const cols = [];
    recs.filter(function (r) { return r.shift === S[0]; }).sort(function (a, b) { return a.t - b.t; }).forEach(function (r) {
      let c = cols.filter(function (x) { return x.code === r.code; })[0];
      if (!c) { c = { code: r.code, name: r.name, ids: [], batches: 0, weight: 0, mill: 0, ncpT: 0, ncpA: 0, causes: [] }; cols.push(c); }
      // milling taken out and ground again (user 29 Oct 13:44): not NCP, and not production again (counted when first made)
      c.ids.push(r.id); c.batches = bfR3_(c.batches + (r.batches || 0)); c.weight = bfR3_(c.weight + r.actual - r.millA); c.mill = bfR3_(c.mill + r.millA); c.ncpT = bfR3_(c.ncpT + r.ncpT); c.ncpA = bfR3_(c.ncpA + r.ncpA);
      if (r.cause && c.causes.indexOf(r.cause) < 0) c.causes.push(r.cause);
    });
    const tot = { batches: 0, weight: 0, mill: 0, ncpT: 0, ncpA: 0 };
    cols.forEach(function (c) { c.cause = c.causes.join(' · '); delete c.causes; Object.keys(tot).forEach(function (k) { tot[k] = bfR3_(tot[k] + c[k]); }); });
    const W = nuShiftWin_(d, S[0]), now = Date.now();
    return { s: S[0], label: S[1], cols: cols, tot: tot, live: now >= W[0] && now < W[1] }; // shift still running (batching not finished)
  });
  const w = shifts.reduce(function (a, s) { return a + s.tot.weight; }, 0), n = shifts.reduce(function (a, s) { return a + s.tot.ncpA; }, 0);
  const mill = shifts.reduce(function (a, s) { return a + s.tot.mill; }, 0);
  return Object.assign({ day: d, shifts: shifts, weightT: Math.round(w / 100) / 10, ncpT: Math.round(n / 10) / 100, millKg: bfR3_(mill), n: recs.length }, nuMix_(d, shifts));
}
// Batching (Total weight of the shift, net of Milling) → Mix หลังบด weighed in the same shift window (user 30 Oct 13:58)
// a Mix row goes to the formula column whose code starts the same (SCADA may cut the code); the bins between batching and mix
// carry stock over the shift change, so one shift can be + or −; the day total is steadier
function nuShiftWin_(d, s) {
  const t0 = new Date(d + 'T00:00:00+07:00').getTime();
  return s === 'A' ? [t0 + 7.5 * HOUR, t0 + 16 * HOUR] : s === 'B' ? [t0 + 16 * HOUR, t0 + 24 * HOUR] : [t0 + 24 * HOUR, t0 + 31.5 * HOUR];
}
function nuCodeKey_(c) { return str_(c).toUpperCase().replace(/\s+/g, ''); }
function nuMix_(d, shifts) {
  const all = mxRecs_(); if (!all.length) return { mix: null };
  const last = Math.max.apply(null, all.map(function (r) { return r.t; }));
  let mixKg = 0, batch = 0, any = false;
  shifts.forEach(function (sh) {
    const W = nuShiftWin_(d, sh.s), R = all.filter(function (r) { return r.t >= W[0] && r.t < W[1]; }), other = {};
    sh.cols.forEach(function (c) { c.mix = 0; c.mixN = 0; });
    R.forEach(function (r) {
      const f = nuCodeKey_(r.formula); let best = null;
      sh.cols.forEach(function (c) { const k = nuCodeKey_(c.code); if (k && f && (f.indexOf(k) === 0 || k.indexOf(f) === 0) && (!best || k.length > nuCodeKey_(best.code).length)) best = c; });
      if (best) { best.mix = bfR3_(best.mix + r.kg); best.mixN++; } else other[r.formula || '?'] = bfR3_((other[r.formula || '?'] || 0) + r.kg);
    });
    const T = sh.tot; T.mix = 0; T.loss = 0; T.lossBase = 0;
    sh.cols.forEach(function (c) {
      c.loss = c.mixN ? bfR3_(c.weight - c.mix) : null; c.lossPct = c.mixN && c.weight ? Math.round(c.loss / c.weight * 10000) / 100 : null;
      if (c.mixN) { T.mix = bfR3_(T.mix + c.mix); T.loss = bfR3_(T.loss + c.loss); T.lossBase = bfR3_(T.lossBase + c.weight); }
    });
    T.lossPct = T.lossBase ? Math.round(T.loss / T.lossBase * 10000) / 100 : null; if (!T.lossBase) T.loss = null;
    sh.mixOther = Object.keys(other).map(function (k) { return { formula: k, kg: other[k] }; });
    sh.mixPart = last < W[1]; // Mix file imported only up to part of this shift
    if (T.lossBase) { any = true; mixKg += T.mix; batch += T.lossBase; }
  });
  return { mix: any ? { kg: bfR3_(mixKg), batch: bfR3_(batch), loss: bfR3_(batch - mixKg), lossPct: Math.round((batch - mixKg) / batch * 10000) / 100 } : null, mixLast: last };
}
function nuGet(token, id) {
  cacheOn_();
  session_(token);
  const r = nuRecs_().filter(function (x) { return x.id === str_(id); })[0]; if (!r) throw new Error('ไม่พบรายงาน');
  const lines = !ss_().getSheetByName(NU.LINE) ? [] : table_(NU.LINE).rows.filter(function (l) { return str_(l.NCPUsageID) === r.id && !truthy_(l.Cancelled); })
    .map(function (l) { return { no: num_(l.Line_No), code: str_(l.Ingredient_Code), name: str_(l.Ingredient_Name), bin: str_(l.Bin), target: num_(l.Target_kg), actual: num_(l.Actual_kg), dev: num_(l.Deviation_kg), ncp: truthy_(l.Is_NCP), mill: truthy_(l.Is_Mill) }; })
    .sort(function (a, b) { return (a.no || 0) - (b.no || 0); });
  return Object.assign({}, r, { row: undefined, lines: lines });
}
function nuImage(token, id) {
  session_(token);
  const r = nuRecs_().filter(function (x) { return x.id === str_(id); })[0]; if (!r || !r.img) throw new Error('ไม่มีรูป');
  return bfImage_(r.img);
}
// สาเหตุ of one column (all reports of that formula in the shift get the same text)
function nuCause(token, ids, cause) {
  const me = session_(token, 'work'), set = (ids || []).map(str_);
  return withLock_(function () {
    const rs = nuRecs_().filter(function (x) { return set.indexOf(x.id) >= 0; }); if (!rs.length) throw new Error('ไม่พบรายงาน');
    rs.forEach(function (r) { setCells_(NU.TAB, r.row, { Cause: str_(cause), UpdatedTimestamp: new Date(), UpdatedBy: by_(me) }); });
    return { ok: true };
  });
}
// move a saved report to another production day / shift (user 29 Oct 13:21: choose the day and shift yourself, saved ones can be changed)
function nuMove(token, id, day, shift) {
  const me = session_(token, 'work'), d = str_(day), sh = str_(shift).toUpperCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new Error('เลือกวันผลิต');
  if (!NU.SHIFTS.some(function (s) { return s[0] === sh; })) throw new Error('เลือกกะ');
  return withLock_(function () {
    const r = nuRecs_().filter(function (x) { return x.id === str_(id); })[0]; if (!r) throw new Error('ไม่พบรายงาน');
    setCells_(NU.TAB, r.row, { Prod_Date: "'" + d, Shift: sh, UpdatedTimestamp: new Date(), UpdatedBy: by_(me) });
    return { ok: true, day: d, from: r.day };
  });
}
// mark which 04RW rows (bins) were milling taken out and ground again (user 29 Oct 13:44: same 04RW code, separate bin — choose the bin)
function nuMill(token, id, nos) {
  const me = session_(token, 'work'), set = (nos || []).map(Number);
  nuTabs_();
  withLock_(function () {
    const r = nuRecs_().filter(function (x) { return x.id === str_(id); })[0]; if (!r) throw new Error('ไม่พบรายงาน');
    const ls = table_(NU.LINE).rows.filter(function (l) { return str_(l.NCPUsageID) === r.id && !truthy_(l.Cancelled); });
    const sum = { ncpT: 0, ncpA: 0, millT: 0, millA: 0 };
    ls.forEach(function (l) {
      const is = nuIsNcp_(l.Ingredient_Code), mill = is && set.indexOf(num_(l.Line_No)) >= 0, t = num_(l.Target_kg) || 0, a = num_(l.Actual_kg) || 0;
      if (mill) { sum.millT += t; sum.millA += a; } else if (is) { sum.ncpT += t; sum.ncpA += a; }
      if (truthy_(l.Is_Mill) !== mill || truthy_(l.Is_NCP) !== (is && !mill)) setCells_(NU.LINE, l._row, { Is_Mill: mill, Is_NCP: is && !mill });
    });
    setCells_(NU.TAB, r.row, { NCP_Target_kg: bfR3_(sum.ncpT), NCP_Actual_kg: bfR3_(sum.ncpA), Mill_Target_kg: bfR3_(sum.millT), Mill_Actual_kg: bfR3_(sum.millA), UpdatedTimestamp: new Date(), UpdatedBy: by_(me) });
  });
  return nuGet(token, id);
}
function nuCancel(token, id) {
  const me = session_(token, 'work');
  return withLock_(function () {
    const r = nuRecs_().filter(function (x) { return x.id === str_(id); })[0]; if (!r) throw new Error('ไม่พบรายงาน');
    setCells_(NU.TAB, r.row, { Cancelled: true, UpdatedTimestamp: new Date(), UpdatedBy: by_(me) });
    return { ok: true, day: r.day };
  });
}
// Run once from the editor (Run ▶ authorizeDrive) so the owner grants the Drive permission used by สูตร Batching (OCR + image folder).
function authorizeDrive() {
  const f = bfFolder_(), tk = ScriptApp.getOAuthToken();
  const r = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { Authorization: 'Bearer ' + tk }, muteHttpExceptions: true });
  bfTabs_();
  Logger.log('Drive OK · folder "' + f.getName() + '" ' + f.getUrl() + ' · Drive API ' + r.getResponseCode());
}
// Run once from the editor (Run ▶ moveNcpImages) — moves old NCP report images (NCP_*) out of the Batching folder into 'BFL ProdApp - รายงาน NCP'. File ids stay the same, so Image_FileID keeps working.
function moveNcpImages() {
  const src = bfFolder_(), dst = nuFolder_(), it = src.getFiles(); let n = 0;
  while (it.hasNext()) { const f = it.next(); if (/^NCP_/.test(f.getName())) { f.moveTo(dst); n++; } }
  Logger.log('ย้ายรูป NCP ' + n + ' ไฟล์ → "' + dst.getName() + '" ' + dst.getUrl());
}

// ---------- Mix หลังบด (user 30 Oct 13:32): report of the scale after grinding (Mix-2) → import Excel / CSV ----------
// columns of the report: Datetime_Stamp · FormulaID · Lot_No · Weight_No · quantity (kg) · Destination_Bin · Operator · Opening_Time · Closing_Time · Duration_seconds
// main purpose (user): the loss between Batching (Total_Batch_kg) and Mix after grinding
const MX = { TAB: 'Mix_Weigh', HEAD: ['MixID', 'Datetime_Stamp', 'FormulaID', 'Lot_No', 'ProductionID', 'Weight_No', 'Qty_kg', 'Destination_Bin', 'Operator', 'Opening_Time', 'Closing_Time',
  'Duration_s', 'Source_File', 'ImportedBy', 'ImportTimestamp', 'Cancelled'] };
// "2026-10-30 12:05:01.000" (local time) → ms; also accepts dd/MM/yyyy HH:mm[:ss]
function mxTime_(v) {
  if (v instanceof Date) return v.getTime();
  const s = str_(v).replace(/^'/, '').trim(); let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/.exec(s);
  if (m) return new Date(m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2) + 'T' + ('0' + m[4]).slice(-2) + ':' + m[5] + ':' + (m[6] || '00') + '.' + ((m[7] || '0') + '00').slice(0, 3) + '+07:00').getTime();
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return new Date(m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) + 'T' + ('0' + m[4]).slice(-2) + ':' + m[5] + ':' + (m[6] || '00') + '+07:00').getTime();
  return null;
}
function mxTxt_(t) { return t == null ? '' : fmt_(new Date(t), 'yyyy-MM-dd HH:mm') + ':' + ('0' + new Date(t).getUTCSeconds()).slice(-2); }
function mxRecs_() {
  if (!ss_().getSheetByName(MX.TAB)) return [];
  return table_(MX.TAB).rows.filter(function (r) { return str_(r.MixID) && !truthy_(r.Cancelled); }).map(function (r) {
    return { id: str_(r.MixID), t: mxTime_(r.Datetime_Stamp), formula: str_(r.FormulaID), lot: str_(r.Lot_No).replace(/^'/, ''), pid: str_(r.ProductionID), no: num_(r.Weight_No),
      kg: num_(r.Qty_kg) || 0, bin: str_(r.Destination_Bin), op: str_(r.Operator), open: mxTime_(r.Opening_Time), close: mxTime_(r.Closing_Time), dur: num_(r.Duration_s), file: str_(r.Source_File), row: r._row };
  }).filter(function (r) { return r.t; });
}
const mxKey_ = function (lot, no, t) { return lot + '|' + no + '|' + Math.floor(t / 1000); };
// x = {file, rows: [{dt, formula, lot, no, kg, bin, op, open, close, dur}], dry}; dry = count only (preview before saving)
function mixImport(token, x) {
  const me = session_(token, 'work'), rows = (x && x.rows) || [];
  if (!rows.length) throw new Error('ไฟล์ไม่มีแถวข้อมูล');
  if (rows.length > 5000) throw new Error('นำเข้าได้ครั้งละไม่เกิน 5,000 แถว');
  const lotPid = {}; lotRows_().forEach(function (r) { if (!truthy_(r.Cancelled)) lotPid[str_(r.Lot_Number)] = str_(r.ProductionID); });
  const have = {}; mxRecs_().forEach(function (r) { have[mxKey_(r.lot, r.no, r.t)] = 1; });
  const out = [], bad = [], noLot = {}; let dup = 0, kg = 0, t0 = null, t1 = null;
  rows.forEach(function (r, i) {
    const t = mxTime_(r.dt), lot = str_(r.lot).replace(/\.0+$/, '').trim(), no = num_(r.no), q = num_(String(r.kg == null ? '' : r.kg).replace(/,/g, ''));
    if (!t || !lot || q == null) { bad.push((i + 2) + (t ? '' : ' เวลา') + (lot ? '' : ' Lot') + (q == null ? ' quantity' : '')); return; }
    const k = mxKey_(lot, no, t); if (have[k]) { dup++; return; } have[k] = 1;
    if (!lotPid[lot]) noLot[lot] = (noLot[lot] || 0) + 1;
    kg += q; t0 = t0 == null || t < t0 ? t : t0; t1 = t1 == null || t > t1 ? t : t1;
    out.push({ MixID: id8_(), Datetime_Stamp: "'" + mxTxt_(t), FormulaID: str_(r.formula), Lot_No: "'" + lot, ProductionID: lotPid[lot] || '', Weight_No: no == null ? '' : no, Qty_kg: q,
      Destination_Bin: str_(r.bin).toUpperCase(), Operator: str_(r.op), Opening_Time: mxTime_(r.open) ? "'" + mxTxt_(mxTime_(r.open)) : '', Closing_Time: mxTime_(r.close) ? "'" + mxTxt_(mxTime_(r.close)) : '',
      Duration_s: num_(r.dur) == null ? '' : num_(r.dur), Source_File: str_(x.file).slice(0, 120), ImportedBy: by_(me), ImportTimestamp: new Date(), Cancelled: false });
  });
  const res = { add: out.length, dup: dup, bad: bad.slice(0, 20), badN: bad.length, noLot: Object.keys(noLot), kg: bfR3_(kg), from: t0, to: t1,
    lots: Object.keys(out.reduce(function (a, o) { a[o.Lot_No.slice(1)] = 1; return a; }, {})) };
  if (x.dry || !out.length) return res;
  ensureTab_(MX.TAB, MX.HEAD);
  withLock_(function () { appendRows_(MX.TAB, out); });
  console.log('mixImport ' + out.length + ' rows by ' + me.Name);
  res.saved = true; return res;
}
// per lot: Batch (Total_Batch_kg) → after-mill scale → Mix หลังบด; loss = Batch − Mix
function mixLot_(pid, lot, batch, ground, recs) {
  const R = recs.filter(function (r) { return pid ? r.pid === pid : r.lot === lot; }).sort(function (a, b) { return a.t - b.t; });
  const kg = bfR3_(R.reduce(function (a, r) { return a + r.kg; }, 0)), bins = {};
  R.forEach(function (r) { if (r.bin) bins[r.bin] = bfR3_((bins[r.bin] || 0) + r.kg); });
  return { n: R.length, kg: kg, first: R.length ? R[0].t : null, last: R.length ? R[R.length - 1].t : null, bins: bins,
    loss: batch && kg ? bfR3_(batch - kg) : null, lossPct: batch && kg ? Math.round((batch - kg) / batch * 10000) / 100 : null,
    fromGround: ground && kg ? bfR3_(ground - kg) : null };
}
// list for a range of production days (08:00 → 08:00) + one line per lot weighed in the range
function mixList(token, from, to) {
  cacheOn_();
  session_(token);
  const d0 = /^\d{4}-\d{2}-\d{2}$/.test(str_(from)) ? str_(from) : prodDay_(Date.now()), d1 = /^\d{4}-\d{2}-\d{2}$/.test(str_(to)) ? str_(to) : d0;
  const S = new Date(d0 + 'T08:00:00+07:00').getTime(), E = new Date(d1 + 'T08:00:00+07:00').getTime() + 24 * HOUR;
  const all = mxRecs_(), rows = all.filter(function (r) { return r.t >= S && r.t < E; }).sort(function (a, b) { return a.t - b.t; });
  const LT = lots_(), W = world_(), lotBy = {}; lotRows_().forEach(function (r) { lotBy[str_(r.ProductionID)] = r; });
  const keys = []; rows.forEach(function (r) { const k = r.pid || ('?' + r.lot); if (keys.indexOf(k) < 0) keys.push(k); });
  const lots = keys.map(function (k) {
    const pid = k.charAt(0) === '?' ? '' : k, lr = lotBy[pid], recs = pid ? (W.rec.by[pid] || []) : [], batch = lr ? num_(lr.Total_Batch_kg) : null, ground = recs.length ? recs[recs.length - 1].w : null;
    const lot = pid ? str_(lr.Lot_Number) : k.slice(1);
    return Object.assign({ pid: pid, lot: lot, name: (LT[pid] || {}).name || '', state: lr ? str_(lr.State) : '', batch: batch, ground: ground,
      inRange: rows.filter(function (r) { return (r.pid || ('?' + r.lot)) === k; }).length }, mixLot_(pid, lot, batch, ground, all));
  });
  return { from: d0, to: d1, rows: rows.map(function (r) { const o = Object.assign({}, r); delete o.row; o.name = (LT[r.pid] || {}).name || ''; return o; }), lots: lots,
    total: { n: rows.length, kg: bfR3_(rows.reduce(function (a, r) { return a + r.kg; }, 0)) }, last: all.length ? Math.max.apply(null, all.map(function (r) { return r.t; })) : null };
}
function mixCancel(token, id) {
  const me = session_(token, 'work');
  return withLock_(function () {
    const r = mxRecs_().filter(function (x) { return x.id === str_(id); })[0]; if (!r) throw new Error('ไม่พบรายการ');
    setCells_(MX.TAB, r.row, { Cancelled: true, ImportedBy: by_(me) + ' (ยกเลิก)' }); return { ok: true };
  });
}
// timing check from the editor (31 Oct): each tab read from the sheet, then from the cache; nothing is written to the sheet
function perfCheck() {
  const tabs = [CFG.T.LOT, CFG.T.PRODUCT, CFG.T.RUN, CFG.T.REC, CFG.T.SETUP, CFG.T.TOOL, CFG.T.COAT, CFG.T.MOIST, CFG.T.NCP, 'Grinding_Fineness'], out = [];
  tabs.forEach(function (n) {
    TABLES_ = {}; TCACHE_ = false; let t = Date.now(); const a = table_(n); const sheetMs = Date.now() - t;
    TABLES_ = {}; TCACHE_ = true; t = Date.now(); const b = table_(n); const cacheMs = Date.now() - t;
    const same = a.rows.length === b.rows.length && JSON.stringify(a.rows[a.rows.length - 1]) === JSON.stringify(b.rows[b.rows.length - 1]);
    out.push(n + ' rows ' + a.rows.length + ' · sheet ' + sheetMs + ' ms · cache ' + cacheMs + ' ms · same ' + same);
  });
  console.log(out.join('\n')); return out;
}





/* ---------- ที่เก็บข้อมูล Supabase (user 12 Nov 2026) ----------
 * 14 แท็บที่แอปนี้เขียนคนเดียว (Grinding_Runtime, Grinding_Records, Grinding_Tool_Life, Grinding_Part_Life, Grinding_Bin_Log, Batching_Formula,
 * Batching_Formula_Line, NCP_Usage, NCP_Usage_Line, Mix_Weigh, Lot_Input_Log, Lot_Cancel_Log, Lot_Key_Log, NCP_Edit_Log) เก็บใน Supabase
 * bfl-production (ตาราง pkp_row: 1 แถว = 1 แถวของชีต ค่าเหมือนที่สคริปต์อ่านจากชีต) — ชีต BFL Production-Dep ได้สำเนาทันทีหลังบันทึก
 * (ปล่อย lock แล้ว ก่อนเรียก webhook สคริปต์คำนวณเดิม) + storeFlushJob ทุก 5 นาทีเก็บตก · ค่าที่ชีตแปลงเอง (ข้อความวันที่ / ตัวเลข / ') อ่านกลับเข้า Supabase
 * ตรรกะของแอปไม่เปลี่ยน: โค้ดเดิมใช้คำสั่งชีตตามเดิม แต่ ss_().getSheetByName ของ 14 แท็บนี้ได้ "ชีตเสมือน" (dbVSheet_) ที่อ่าน/เขียน Supabase
 * คอลัมน์ที่สคริปต์คำนวณเดิม (Bluefalo Production_Lot) เขียนในชีต (DB.CALC) คัดกลับเข้า Supabase หลัง webhook GRINDING_* · ไม่สำเนาทับ
 * stamp ของ liveStamp / cache ยังอ่านจากชีต (สำเนาลงชีตเสร็จก่อนจบการบันทึก) — ไม่เรียก Supabase ทุก 5 วิ
 * สวิตช์ = Script Property DB_PRIMARY ('1' = Supabase) — ตั้งโดย storeCutover() เท่านั้น · ย้อนกลับ: storeRollback() (สำเนาลงชีตให้ครบแล้วปิดสวิตช์)
 * แท็บอื่น (Production_Lot, NCP, Grinding_Setup, Grinding_Fineness, Coater_Records, Extruder_Runtime, Product_Detail, Production_NCP_Map,
 * ProdApp_Users, Batching_OCR_Log …) ยังอยู่ในชีตเหมือนเดิม · ห้ามแก้ 14 แท็บนี้ในชีตด้วยมือ (ค่าไม่เข้า Supabase และถูกทับ)
 * Coater_Records (user 13 Nov 2026): แท็บที่เพิ่มทีหลัง (DB.LATER) — ใช้ Supabase เมื่ออยู่ใน Script Property DB_LATER_ON เท่านั้น
 * (storeCutoverCoater / storeRollbackCoater รันจาก editor) · Bluefalo คำนวณ PrevDT…RecalcStatus หลัง webhook COATER_REALTIME
 * Extruder_Runtime + Die_Usage (user 13 Nov 2026): แท็บร่วมกับ Extruder Log (source extruder) — LATER เหมือน Coater (storeCutoverShared /
 * storeRollbackShared) · สำเนาลงชีตได้ทั้งสองแอป (pkp_flush_take กันแถวซ้ำด้วย claim) · Bluefalo คำนวณ Duration_* หลัง webhook EXTRUDER_RUNTIME
 * → lotRecalc คัดกลับ (เครื่องเดียวกัน 600 แถวท้าย) · ถ้าชีตกับ Supabase ต่างกัน ถือ Supabase เป็นค่าจริง (ผู้ใช้ตัดสิน 13 พ.ย.)
 * Grinding_Setup (user 13 Nov 2026): แอปนี้เขียนคนเดียว (QC อ่านหน้า Fineness · Bluefalo อ่านจากชีตตอนคำนวณ Tool Life) — LATER
 * (storeCutoverSetup / storeRollbackSetup) · ไม่มีคอลัมน์คำนวณ · เขียนใน withLock_ → สำเนาลงชีตก่อน webhook GRINDING_TOOL_LIFE_RECALC */
const DB = {
  URL: 'https://kdytxuufvigwjccebrki.supabase.co/rest/v1/rpc/', KEY: 'sb_publishable_IYCMIaN7tJleWINprA42CQ_dX10sXFF', SOURCE: 'prodapp',
  // tab → key column(s) (more than one = joined with '|')
  TABS: { Grinding_Runtime: ['ID'], Grinding_Records: ['RecordID'], Grinding_Tool_Life: ['ToolLifeID'], Grinding_Part_Life: ['PartLifeID'],
    Grinding_Bin_Log: ['BinLogID'], Batching_Formula: ['FormulaRecID'], Batching_Formula_Line: ['LineID'], NCP_Usage: ['NCPUsageID'],
    NCP_Usage_Line: ['LineID'], Mix_Weigh: ['MixID'], Lot_Input_Log: ['LogID'], Lot_Cancel_Log: ['LogID'], Lot_Key_Log: ['LogID'], NCP_Edit_Log: ['LogID'],
    Coater_Records: ['ID'], Extruder_Runtime: ['ID'], Die_Usage: ['UsageID'], Grinding_Setup: ['SetupID'] },
  // tabs added after the first cutover: in Supabase only once listed in Script Property DB_LATER_ON (comma list)
  LATER: ['Coater_Records', 'Extruder_Runtime', 'Die_Usage', 'Grinding_Setup'],
  // cells the main script computes in the sheet (webhook GRINDING_*) — never copied over, read back after the webhook
  CALC: {
    Grinding_Records: ['PrevDT', 'Prev_Output_Weight', 'DeltaMinutes', 'Delta_Output_Weight', 'Capacity_kg_hr', 'RecalcAt'],
    Grinding_Runtime: ['PrevDT', 'NextDT_Check', 'Duration_Min', 'Duration_Text', 'Duration_Over_Lot', 'Duration_Over_Lot_Text', 'RecalcAt'],
    Grinding_Tool_Life: ['Total_Output_Weight', 'Total_Runtime_Min', 'Total_Regrinding', 'Last_RecordDT', 'Blade_Angle_Count', 'Blade_Has_Active', 'Blade_Completed', 'RecalcAt'],
    Coater_Records: ['PrevDT', 'PrevWeight', 'DeltaMinutes', 'Capacity', 'RecalcAt', 'RecalcStatus', 'NeedRecalc'],
    Extruder_Runtime: ['Duration_Min', 'Duration_Over_Lot', 'RecalcAt', 'RecalcStatus', 'RecalcError']
  },
  // webhook action → [tab, column that scopes the rows the main script recalculates]
  HOOK: { GRINDING_RUNTIME: ['Grinding_Runtime', 'Grinding_Machine'], GRINDING_RECORDS: ['Grinding_Records', 'ProductionID'],
    GRINDING_TOOL_LIFE_RECALC: ['Grinding_Tool_Life', 'Grinding_Machine'], COATER_REALTIME: ['Coater_Records', 'ProductionID'],
    EXT_RUNTIME: ['Extruder_Runtime', 'Extruder_Number'] },
  CALC_TAIL: 600, BATCH: 800, FLUSH_MAX: 400
};
let DB_ON_ = null, DB_DIRTY_ = false, DB_DEPTH_ = 0, DB_PEND_ = [], DB_VS_ = {}, RAW_SS_ = null, DB_LATER_ON_ = null;
function dbOn_() { if (DB_ON_ == null) DB_ON_ = PropertiesService.getScriptProperties().getProperty('DB_PRIMARY') === '1'; return DB_ON_; }
function dbLaterOn_() {
  if (DB_LATER_ON_ == null) DB_LATER_ON_ = String(PropertiesService.getScriptProperties().getProperty('DB_LATER_ON') || '').split(',').filter(String);
  return DB_LATER_ON_;
}
// the tabs this app keeps in Supabase (a LATER tab only once switched on)
function dbTabs_() { return Object.keys(DB.TABS).filter(function (t) { return DB.LATER.indexOf(t) < 0 || dbLaterOn_().indexOf(t) >= 0; }); }
function isDb_(name) { return dbOn_() && Object.prototype.hasOwnProperty.call(DB.TABS, name) && (DB.LATER.indexOf(name) < 0 || dbLaterOn_().indexOf(name) >= 0); }
// the real spreadsheet (stamps, the sheet copy, tabs that stay in the sheet)
function rawSs_() { return RAW_SS_ || (RAW_SS_ = SpreadsheetApp.openById(CFG.SHEET_ID)); }
// the spreadsheet as the app sees it: the 14 tabs → virtual sheets (rows read from Supabase on first use)
function dbSs_(raw) {
  return {
    getSheetByName: function (n) { return isDb_(n) ? new dbLazy_(n) : raw.getSheetByName(n); },
    getNumSheets: function () { return raw.getNumSheets(); },
    insertSheet: function (n, i) { if (isDb_(n)) throw new Error('ฐานข้อมูล: แท็บ ' + n + ' อยู่ใน Supabase'); return raw.insertSheet(n, i); }
  };
}
// headers of the tabs this app makes on first use (the store always has them)
function dbHeads_(tab) {
  return { Grinding_Bin_Log: GB.HEAD, Lot_Input_Log: LI.HEAD, Lot_Cancel_Log: LC.HEAD, Lot_Key_Log: LK.HEAD, NCP_Edit_Log: NC.LHEAD, Batching_Formula: BF.HEAD,
    Batching_Formula_Line: BF.LHEAD, NCP_Usage: NU.HEAD, NCP_Usage_Line: NU.LHEAD, Mix_Weigh: MX.HEAD, Grinding_Part_Life: CFG.PART_HEADERS }[tab] || null;
}
function dbCall_(fn, body, key) {
  key = key || PropertiesService.getScriptProperties().getProperty('DB_KEY');
  if (!key) throw new Error('ฐานข้อมูล: ยังไม่ได้ตั้ง DB_KEY (รัน storeSetup)');
  const r = UrlFetchApp.fetch(DB.URL + fn, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { apikey: DB.KEY, Authorization: 'Bearer ' + DB.KEY }, payload: JSON.stringify(Object.assign({ p_source: DB.SOURCE, p_key: key }, body)) });
  const code = r.getResponseCode(), txt = r.getContentText();
  if (code >= 300) { let m = txt; try { m = JSON.parse(txt).message || txt; } catch (e) { /* text */ } throw new Error('ฐานข้อมูล: ' + String(m).slice(0, 300)); }
  return txt ? JSON.parse(txt) : null;
}
// cell ↔ store: Date = {$d: ms} (time-only cells too), '' = not kept
function dbEnc_(v) {
  if (v === '' || v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : { $d: v.getTime() };
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  return String(v); // kept as written (a leading ' too) — the sheet copy reads the sheet's own value back
}
function dbDec_(v) { return v == null ? '' : typeof v === 'object' && v.$d != null ? new Date(v.$d) : v; }
function dbKeyOf_(tab, h, vals) {
  const parts = DB.TABS[tab].map(function (c) { const i = h.indexOf(c); const v = i < 0 ? '' : vals[i]; return v == null ? '' : String(v instanceof Date ? v.getTime() : v); });
  return parts.every(function (p) { return p !== ''; }) ? parts.join('|') : '';
}

/* ---------- ชีตเสมือน: คำสั่งชีตชุดที่โค้ดของแอปใช้ บนแถวจาก Supabase ---------- */
// rows = [{k, v:[cells in header order]}] in sheet order · writes wait in DB_PEND_ and go to Supabase in one call when the lock is released
function dbVSheet_(tab, h, rows) { this.tab = tab; this.h = h; this.rows = rows; }
dbVSheet_.prototype.db = true;
dbVSheet_.prototype.getName = function () { return this.tab; };
dbVSheet_.prototype.getLastRow = function () { return this.rows.length + 1; };
dbVSheet_.prototype.getLastColumn = function () { return this.h.length; };
dbVSheet_.prototype.getMaxRows = function () { return this.rows.length + 1; };
dbVSheet_.prototype.getMaxColumns = function () { return this.h.length; };
dbVSheet_.prototype.getRange = function (r, c, nr, nc) {
  if (typeof r !== 'number') throw new Error('ฐานข้อมูล: getRange แบบ A1 ใช้ไม่ได้กับแท็บ ' + this.tab);
  return new dbVRange_(this, r, c, nr || 1, nc || 1);
};
dbVSheet_.prototype.getDataRange = function () { return this.getRange(1, 1, this.getLastRow(), Math.max(1, this.h.length)); };
dbVSheet_.prototype.appendRow = function (a) { this.put_(this.getLastRow() + 1, 1, a); return this; };
dbVSheet_.prototype.deleteRow = function () { throw new Error('ฐานข้อมูล: ลบแถวในแท็บ ' + this.tab + ' ไม่ได้ (ใช้ Supabase)'); };
dbVSheet_.prototype.deleteRows = dbVSheet_.prototype.deleteRow;
dbVSheet_.prototype.setFrozenRows = function () { return this; };
dbVSheet_.prototype.cell_ = function (r, c) {
  if (r === 1) return this.h[c - 1] !== undefined ? this.h[c - 1] : '';
  const x = this.rows[r - 2];
  return x && x.v[c - 1] !== undefined ? x.v[c - 1] : '';
};
// write cells a (row of values) at row r from column c: an existing row → changed cells · the row after the last → a new row
dbVSheet_.prototype.put_ = function (r, c, a) {
  if (r < 2) throw new Error('ฐานข้อมูล: เขียนหัวคอลัมน์แท็บ ' + this.tab + ' ไม่ได้');
  const self = this, n = this.rows.length;
  if (r > n + 2) throw new Error('ฐานข้อมูล: เขียนข้ามแถวในแท็บ ' + this.tab + ' ไม่ได้');
  if (r === n + 2) { // new row
    const v = this.h.map(function () { return ''; });
    a.forEach(function (x, j) { if (c - 1 + j < v.length) v[c - 1 + j] = dbNorm_(x); });
    const k = dbKeyOf_(this.tab, this.h, v);
    if (!k) throw new Error('ฐานข้อมูล: แถวใหม่ในแท็บ ' + this.tab + ' ไม่มีรหัส (' + DB.TABS[this.tab].join(', ') + ')');
    if (this.rows.some(function (x) { return x.k === k; })) throw new Error('ฐานข้อมูล: รหัสซ้ำในแท็บ ' + this.tab + ': ' + k);
    const row = { k: k, v: v, add: true };
    this.rows.push(row);
    dbQueue_(this, row, null);
    return;
  }
  const row = this.rows[r - 2], set = {};
  a.forEach(function (x, j) {
    const i = c - 1 + j;
    if (i >= self.h.length || !self.h[i]) return; // outside the headers: skipped (no column in the store)
    row.v[i] = dbNorm_(x);
    set[self.h[i]] = row.v[i];
  });
  if (dbKeyOf_(this.tab, this.h, row.v) !== row.k) throw new Error('ฐานข้อมูล: เปลี่ยนรหัสของแถวในแท็บ ' + this.tab + ' ไม่ได้');
  dbQueue_(this, row, set);
};
function dbNorm_(x) { const e = dbEnc_(x); return e === null ? '' : dbDec_(e); } // what a read gives back (bad dates / NaN → '')
function dbVRange_(sh, r, c, nr, nc) { this.sh = sh; this.r = r; this.c = c; this.nr = nr; this.nc = nc; }
dbVRange_.prototype.getValues = function () {
  const o = [];
  for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.cell_(this.r + i, this.c + j)); o.push(row); }
  return o;
};
dbVRange_.prototype.getValue = function () { return this.sh.cell_(this.r, this.c); };
dbVRange_.prototype.setValues = function (a) { const self = this; a.forEach(function (row, i) { self.sh.put_(self.r + i, self.c, row); }); return this; };
dbVRange_.prototype.setValue = function (x) {
  for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(x); this.sh.put_(this.r + i, this.c, row); }
  return this;
};
dbVRange_.prototype.getRow = function () { return this.r; };
dbVRange_.prototype.getColumn = function () { return this.c; };
dbVRange_.prototype.getNumRows = function () { return this.nr; };
['setNumberFormat', 'setFontWeight', 'setFontSize', 'setHorizontalAlignment', 'setBackground'].forEach(function (f) { dbVRange_.prototype[f] = function () { return this; }; });
dbVRange_.prototype.createTextFinder = function (txt) {
  const rg = this, want = String(txt).toLowerCase();
  let whole = false;
  const hits = function () {
    const out = [];
    rg.getValues().forEach(function (row, i) {
      row.forEach(function (x, j) {
        if (x instanceof Date) return;
        const s = String(x).toLowerCase();
        if (whole ? s === want : s.indexOf(want) >= 0) out.push(new dbVRange_(rg.sh, rg.r + i, rg.c + j, 1, 1));
      });
    });
    return out;
  };
  return { matchEntireCell: function (b) { whole = b !== false; return this; }, matchCase: function () { return this; },
    findAll: function () { return hits(); }, findNext: function () { return hits()[0] || null; } };
};
// what ss_().getSheetByName gives for a tab in Supabase: nothing is read until the code uses it (existence checks stay free), then the
// tab's rows of this run (dbFull_) — the same rows for every caller, so a write is seen by the next read
function dbLazy_(tab) { this.tab = tab; }
dbLazy_.prototype.db = true;
dbLazy_.prototype.getName = function () { return this.tab; };
['getLastRow', 'getLastColumn', 'getMaxRows', 'getMaxColumns', 'getRange', 'getDataRange', 'appendRow', 'deleteRow', 'deleteRows', 'setFrozenRows'].forEach(function (f) {
  dbLazy_.prototype[f] = function () { const vs = dbFull_(this.tab); return vs[f].apply(vs, arguments); };
});

// the app's writes → DB_PEND_ (one Supabase call per lock) · a write outside a lock goes now
function dbQueue_(vs, row, set) {
  const p = DB_PEND_.find(function (x) { return x.tab === vs.tab && x.k === row.k; });
  if (p) { if (!p.add) Object.assign(p.set, set || {}); }
  else DB_PEND_.push({ tab: vs.tab, k: row.k, add: !set, row: row, h: vs.h, set: set ? Object.assign({}, set) : null });
  if (!DB_DEPTH_) { dbCommit_(); dbAfter_(); }
}
function dbCommit_() {
  if (!DB_PEND_.length) return;
  const pend = DB_PEND_; DB_PEND_ = [];
  const ops = [];
  pend.forEach(function (p) {
    if (p.add) {
      const d = {};
      p.h.forEach(function (c, i) { if (!c) return; const e = dbEnc_(p.row.v[i]); if (e !== null) d[c] = e; });
      ops.push({ tab: p.tab, op: 'ins', rows: [{ k: p.k, d: d }] });
    } else {
      const set = {};
      Object.keys(p.set).forEach(function (c) { set[c] = dbEnc_(p.set[c]); });
      ops.push({ tab: p.tab, op: 'upd', rows: [{ k: p.k, set: set }] });
    }
  });
  try { dbCall_('pkp_put', { p_ops: ops }); }
  catch (e) { DB_VS_ = {}; throw e; } // nothing was kept: later reads come from Supabase again
  DB_DIRTY_ = true;
}
// after the lock is released: the sheet copy now (the 5-min job catches anything missed)
function dbAfter_() {
  if (!DB_DIRTY_) return;
  DB_DIRTY_ = false;
  try { dbFlush_(); } catch (e) { console.warn('sheet copy: ' + e.message); }
}
// script lock as the app uses it + the store: writes go to Supabase before the lock is let go, the sheet copy right after.
// Taking the lock starts from fresh Supabase rows (another user may have saved meanwhile), as the sheet would be.
function dbLock_() {
  const l = LockService.getScriptLock();
  let held = false;
  return {
    waitLock: function (ms) { l.waitLock(ms); held = true; if (!DB_DEPTH_) DB_VS_ = {}; DB_DEPTH_++; },
    tryLock: function (ms) { const ok = l.tryLock(ms); if (ok) { held = true; if (!DB_DEPTH_) DB_VS_ = {}; DB_DEPTH_++; } return ok; },
    releaseLock: function () {
      if (!held) return l.releaseLock();
      held = false;
      DB_DEPTH_ = Math.max(0, DB_DEPTH_ - 1);
      try { if (!DB_DEPTH_) dbCommit_(); } finally { l.releaseLock(); }
      if (!DB_DEPTH_) dbAfter_();
    }
  };
}

/* ---------- อ่านจาก Supabase ---------- */
function dbRead_(tab, col, vals, tail) {
  const res = dbCall_('pkp_get', { p_tab: tab, p_col: col || null, p_vals: vals || null, p_tail: tail || null }), h = res.h.slice();
  const rows = res.rows.map(function (d) { return { k: d._k, v: h.map(function (c) { return c ? dbDec_(d[c]) : ''; }) }; });
  return new dbVSheet_(tab, h, rows);
}
function dbFull_(tab) { return DB_VS_[tab] || (DB_VS_[tab] = dbRead_(tab)); } // whole tab, once per run (fresh again when a lock is taken)
// a column the sheet got (ensureTab_) → the store's headers too
function dbHeadSync_(tab, sh) {
  const h = dbHeadOf_(sh), c = CacheService.getScriptCache(), sig = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, tab + '|' + h.join('\u0001')));
  if (c.get('db_h_' + tab) === sig) return;
  const cur = dbCall_('pkp_get', { p_tab: tab, p_col: '_none_', p_vals: [] }).h;
  if (JSON.stringify(cur) !== JSON.stringify(h)) {
    if (h.slice(0, cur.length).join('\u0001') !== cur.join('\u0001')) throw new Error('ฐานข้อมูล: หัวคอลัมน์แท็บ ' + tab + ' ในชีตไม่ตรงกับ Supabase — แจ้ง Admin');
    dbCall_('pkp_load', { p_tab: tab, p_keycol: DB.TABS[tab].join('|'), p_headers: h, p_rows: [], p_truncate: false });
    delete DB_VS_[tab];
  }
  c.put('db_h_' + tab, sig, 21600);
}
// ensureTab_ for a tab in Supabase: missing columns go into the sheet's header row, then into the store's headers
function dbEnsureTab_(name, head) {
  const have = table_(name).h, miss = head.filter(function (c) { return have.indexOf(c) < 0; });
  if (miss.length) {
    const raw = dbSheet_(name, true), rh = dbHeadOf_(raw), add = miss.filter(function (c) { return rh.indexOf(c) < 0; });
    if (add.length) raw.getRange(1, rh.length + 1, 1, add.length).setValues([add]);
    dbHeadSync_(name, raw);
    delete TABLES_[name]; wrote_(name);
  }
  return ss_().getSheetByName(name);
}

/* ---------- สำเนาลงชีต ---------- */
// Waiting rows → the sheet: a new row is appended, an edited row gets only the cells that changed; then the sheet's own reading of each
// written cell (text → date / number) goes back into Supabase (and into this run's rows) so both hold the same value.
// One copy at a time (script lock; held = caller has it).
function dbFlush_(held) {
  if (!dbOn_()) return null;
  const lock = held ? null : LockService.getScriptLock();
  if (lock && !lock.tryLock(30000)) return { busy: true };
  try {
    let n = 0;
    for (let round = 0; round < 6; round++) {
      const r = dbCall_('pkp_flush_take', { p_max: DB.FLUSH_MAX });
      if (!r.items.length) break;
      const by = {};
      r.items.forEach(function (it) { (by[it.tab] = by[it.tab] || []).push(it); });
      const back = {};
      Object.keys(by).forEach(function (tab) { back[tab] = dbFlushTab_(tab, by[tab]); });
      SpreadsheetApp.flush();
      Object.keys(back).forEach(function (tab) { dbReadBack_(tab, back[tab]); });
      dbCall_('pkp_flush_done', { p_upto: r.upto });
      n += r.items.length;
      if (r.items.length < DB.FLUSH_MAX) break;
    }
    return { n: n };
  } finally { if (lock) lock.releaseLock(); }
}
function dbSheet_(tab, create) {
  let sh = rawSs_().getSheetByName(tab);
  if (sh || !create) return sh;
  const heads = dbHeads_(tab);
  if (!heads) throw new Error('ไม่พบแท็บ ' + tab);
  sh = rawSs_().insertSheet(tab, rawSs_().getNumSheets());
  sh.appendRow(heads);
  return sh;
}
function dbHeadOf_(sh) { return sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0].map(String); }
function dbFlushTab_(tab, items) {
  const sh = dbSheet_(tab, true), h = dbHeadOf_(sh), last = sh.getLastRow(), at = {}, add = [], addK = [], cells = {}, edit = {}, kc = DB.TABS[tab];
  kc.forEach(function (c) { if (h.indexOf(c) < 0) throw new Error('แท็บ ' + tab + ' ไม่มีคอลัมน์ ' + c); });
  if (last > 1) { // key column(s) only
    const cols = kc.map(function (c) { return sh.getRange(2, h.indexOf(c) + 1, last - 1, 1).getValues(); });
    for (let i = 0; i < last - 1; i++) {
      const v = h.map(function () { return ''; });
      kc.forEach(function (c, j) { v[h.indexOf(c)] = cols[j][i][0]; });
      const k = dbKeyOf_(tab, h, v);
      if (k && !(k in at)) at[k] = i + 2;
    }
  }
  items.forEach(function (it) {
    if (!it.d) return; // removed meanwhile
    const row = at[it.k];
    if (!row) { // new row: every cell
      add.push(h.map(function (c) { return c && c in it.d ? dbDec_(it.d[c]) : ''; }));
      addK.push(it);
      at[it.k] = -1;
      return;
    }
    if (row < 0 || !it.cols) return; // a new row already in the sheet (copy stopped before it was marked done)
    it.cols.forEach(function (c) {
      const j = h.indexOf(c);
      if (j < 0 || !c) return;
      const v = c in it.d ? dbDec_(it.d[c]) : '', g = j + '|' + JSON.stringify(v instanceof Date ? { t: v.getTime() } : v);
      (cells[g] = cells[g] || { c: j + 1, v: v, rows: [] }).rows.push(row);
      (edit[row] = edit[row] || { it: it, cols: [] }).cols.push(c);
    });
  });
  Object.keys(cells).forEach(function (g) { // same value into many rows → one RangeList call
    const x = cells[g];
    if (x.rows.length === 1) sh.getRange(x.rows[0], x.c).setValue(x.v);
    else sh.getRangeList(x.rows.map(function (r) { return sh.getRange(r, x.c).getA1Notation(); })).setValue(x.v);
  });
  let start = 0;
  if (add.length) { start = sh.getLastRow() + 1; sh.getRange(start, 1, add.length, h.length).setValues(add); }
  return { sh: sh, h: h, start: start, add: addK, edit: edit };
}
// cells as the sheet now holds them ≠ what Supabase has → Supabase takes the sheet's value (quiet: no new copy), and so do the rows of this run
function dbReadBack_(tab, b) {
  const set = [], h = b.h;
  const cmp = function (it, vals, cols) {
    const s = {};
    cols.forEach(function (c) {
      const j = h.indexOf(c); if (j < 0 || !c) return;
      const a = dbEnc_(vals[j]), want = it.d[c] === undefined ? null : it.d[c];
      if (JSON.stringify(a) !== JSON.stringify(want)) s[c] = a;
    });
    if (Object.keys(s).length) set.push({ k: it.k, set: s });
  };
  if (b.add.length) b.sh.getRange(b.start, 1, b.add.length, h.length).getValues().forEach(function (v, i) { cmp(b.add[i], v, h); });
  Object.keys(b.edit).forEach(function (row) { cmp(b.edit[row].it, b.sh.getRange(Number(row), 1, 1, h.length).getValues()[0], b.edit[row].cols); });
  if (!set.length) return;
  dbCall_('pkp_computed', { p_tab: tab, p_rows: set });
  dbPatchRows_(tab, set);
}
// values Supabase just took → the rows this run already holds
function dbPatchRows_(tab, set) {
  const vs = DB_VS_[tab]; if (!vs) return;
  const by = {}; vs.rows.forEach(function (r) { by[r.k] = r; });
  set.forEach(function (x) {
    const r = by[x.k]; if (!r) return;
    Object.keys(x.set).forEach(function (c) { const i = vs.h.indexOf(c); if (i >= 0) r.v[i] = dbDec_(x.set[c]); });
  });
}
// after a webhook GRINDING_*: the cells the main script computed (DB.CALC) in the rows it recalculated → Supabase. The rows: the tab's last
// CALC_TAIL rows in the same scope (machine / ProductionID) as the row sent. Never stops the user.
function dbCalcBack_(p) {
  const m = DB.HOOK[p && p.action]; if (!m || !isDb_(m[0])) return 0;
  try {
    const tab = m[0], sh = rawSs_().getSheetByName(tab), h = dbHeadOf_(sh), last = sh.getLastRow(), n = Math.min(DB.CALC_TAIL, last - 1);
    if (n < 1) return 0;
    const v = sh.getRange(last - n + 1, 1, n, h.length).getValues(), ki = h.indexOf(DB.TABS[tab][0]), si = h.indexOf(m[1]), id = String(p.toolLifeID || p.rowID || '');
    if (ki < 0 || si < 0) return 0;
    let scope = m[1] === 'ProductionID' && p.productionID ? String(p.productionID) : null;
    if (scope == null) v.forEach(function (r) { if (String(r[ki]) === id) scope = String(r[si]); });
    if (scope == null) return 0;
    const calc = DB.CALC[tab].filter(function (c) { return h.indexOf(c) >= 0; }), set = [];
    v.forEach(function (r) {
      if (String(r[si]) !== scope || r[ki] === '' || r[ki] == null) return;
      const s = {}; calc.forEach(function (c) { s[c] = dbEnc_(r[h.indexOf(c)]); });
      set.push({ k: String(r[ki] instanceof Date ? r[ki].getTime() : r[ki]), set: s });
    });
    if (set.length) { dbCall_('pkp_computed', { p_tab: tab, p_rows: set }); dbPatchRows_(tab, set); }
    return set.length;
  } catch (e) { console.warn('calc back ' + p.action + ': ' + e.message); return 0; }
}
// time trigger every 5 min: whatever is still waiting reaches the sheet
function storeFlushJob() {
  if (!dbOn_()) return 'off';
  const r = dbFlush_();
  try { r.q = pdHookQ_(); } catch (e) { console.warn('hook queue: ' + e.message); }   // v55
  try { r.ref = pdRefSync_(PDREF.OWN); } catch (e) { console.warn('ref copy: ' + e.message); }   // v56
  console.log(JSON.stringify(r));
  return r;
}
// v56: sheet-only tabs → Supabase (pkp_row, quiet) so phones read them without Apps Script (pdr_sheets).
// Own copies are keyed by sheet row (R<row>, whole tab); Production_Lot / NCP / Product_Detail use packing's keys (packing copies them every 5 min too).
const PDREF = { OWN: ['ProdApp_Users', 'Moisture', 'Kibble', 'Grinding_Fineness'], KEYED: { Production_Lot: 'ProductionID', NCP: 'ID', Product_Detail: 'ProductID' } };
function pdRefRows_(tab) {
  const own = PDREF.OWN.indexOf(tab) >= 0, kc = own ? '' : PDREF.KEYED[tab];
  if (!own && !kc) throw new Error('not a ref tab: ' + tab);
  const sh = rawSs_().getSheetByName(tab); if (!sh) return null;
  const v = sh.getDataRange().getValues(), h = v.shift().map(String), ki = kc ? h.indexOf(kc) : -1, pin = tab === CFG.USERS ? h.indexOf('PIN_Hash') : -1, rows = [], seen = {};
  v.forEach(function (r, i) {
    if (r.every(function (x) { return x === '' || x == null; })) return;
    let k;
    if (own) k = 'R' + (i + 2);
    else { k = String(r[ki] == null ? '' : r[ki]); if (!k || seen[k]) k = '#row' + (i + 2); seen[k] = 1; }
    const d = {}; h.forEach(function (col, j) { if (j === pin) return; const e = dbEnc_(r[j]); if (e !== null) d[col] = e; });
    rows.push({ k: k, d: d });
  });
  return { kc: kc, h: h, rows: rows };
}
function pdRefSync_(tabs, force) {
  if (!dbOn_()) return 'off';
  const P = PropertiesService.getScriptProperties(), out = {};
  tabs.forEach(function (tab) {
    try {
      const t = pdRefRows_(tab); if (!t) { out[tab] = 'no tab'; return; }
      const hx = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify([t.h, t.rows]), Utilities.Charset.UTF_8));
      if (!force && P.getProperty('PDREF_' + tab) === hx) { out[tab] = 'same'; return; }
      out[tab] = dbCall_('pd_ref_put', { p_tab: tab, p_keycol: t.kc, p_headers: t.h, p_rows: t.rows });
      P.setProperty('PDREF_' + tab, hx);
    } catch (e) { out[tab] = 'error: ' + e.message; }
  });
  return out;
}
function pdRefDirty_() {
  const t = Object.keys(PDREF_DIRTY_).filter(function (n) { return PDREF.OWN.indexOf(n) >= 0 || !!PDREF.KEYED[n]; }); PDREF_DIRTY_ = {};
  if (!t.length || !dbOn_()) return null;
  try { SpreadsheetApp.flush(); return pdRefSync_(t); } catch (e) { console.warn('ref copy: ' + e.message); return null; }
}
// editor: send all copies now (first time, or after a manual sheet edit)
function storeRefInit() {
  const r = pdRefSync_(PDREF.OWN.concat(Object.keys(PDREF.KEYED)), true);
  console.log(JSON.stringify(r)); return r;
}
// editor: the 13 tabs the phone takes from Supabase vs the sheet now (rdCtx's values) — counts and the first differing row only, no cell values
function storeRefCheck() {
  const tabs = ['ProdApp_Users', 'Moisture', 'Kibble', 'Grinding_Fineness', 'Production_Lot', 'NCP', 'Product_Detail', 'NCP_Detail', 'Production_NCP_Map',
                'RuntimeType', 'Old_Semi_Use', 'Extruder_Lot_Info', 'FG_Lot'], out = {};
  const enc = function (x) { return x instanceof Date ? (isNaN(x.getTime()) ? '' : { $d: x.getTime() }) : (typeof x === 'number' && !isFinite(x) ? '' : x); };
  tabs.forEach(function (tab) {
    try {
      const sh = rawSs_().getSheetByName(tab); if (!sh) { out[tab] = 'no tab'; return; }
      let v = sh.getDataRange().getValues();
      const pin = tab === CFG.USERS ? v[0].map(String).indexOf('PIN_Hash') : -1;
      v = v.map(function (r, j) { return r.map(function (x, i) { return j && i === pin ? '' : enc(x); }); });
      const head = JSON.stringify(v[0].map(String)), body = v.slice(1).filter(function (r) { return !r.every(function (x) { return x === '' || x == null; }); });
      const sb = dbCall_('pd_ref_get', { p_tab: tab });
      if (!sb) { out[tab] = 'not in Supabase'; return; }
      const sbody = sb.slice(1);
      let diff = 0, first = -1;
      for (let i = 0; i < Math.max(body.length, sbody.length); i++) {
        if (JSON.stringify(body[i] || null) !== JSON.stringify(sbody[i] || null)) { diff++; if (first < 0) first = i + 1; }
      }
      out[tab] = { sheet: body.length, supabase: sbody.length, head: head === JSON.stringify(sb[0].map(String)), diffRows: diff, firstDiff: first };
    } catch (e) { out[tab] = 'error: ' + e.message; }
  });
  console.log(JSON.stringify(out)); return out;
}
// v55: main-script calls queued by phone saves (pd_hook_q) — after the sheet copy above, so the main script reads the saved rows
function pdHookQ_() {
  if (!dbOn_()) return null;
  const items = dbCall_('pdq_take', { p_max: 20 }) || [];
  if (!items.length) return { n: 0 };
  const done = [], bad = [];
  items.forEach(function (it) {
    const p = Object.assign({}, it.body);
    const code = String(p.module || '').toUpperCase() === 'EXTRUDER_RUNTIME' ? extHook_(p) : hook_(p);
    (code === 200 ? done : bad).push(it.id);
  });
  if (done.length) dbCall_('pdq_done', { p_ids: done });
  if (bad.length) dbCall_('pdq_done', { p_ids: bad, p_err: 'main script did not answer 200' });
  return { n: items.length, ok: done.length, bad: bad.length };
}
function extHook_(p) {
  try {
    const res = UrlFetchApp.fetch(prop_('RECALC_URL') || CFG.HOOK_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify(p) });
    dbCalcBack_({ action: 'EXT_RUNTIME', rowID: String(p.rowID || '') });
    return res.getResponseCode();
  } catch (e) { console.warn('hook ext: ' + e); return 0; }
}

/* ---------- ตั้งค่า / สลับ (รันจาก editor เท่านั้น) ---------- */
// once: a random key for this script, its sha256 registered in Supabase (pk_key, source 'prodapp'), the key kept in Script Properties
function storeSetup() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('DB_KEY')) return 'DB_KEY already set';
  const key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  dbCall_('pk_register', {}, key);
  p.setProperty('DB_KEY', key);
  return 'ok';
}
// Copy the 14 tabs into Supabase under the script lock (nobody can save meanwhile), then switch DB_PRIMARY on.
function storeCutover() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('DB_KEY')) throw new Error('รัน storeSetup ก่อน');
  if (p.getProperty('DB_PRIMARY') === '1') throw new Error('ใช้ Supabase อยู่แล้ว');
  const l = LockService.getScriptLock();
  l.waitLock(30000);
  try {
    const out = {};
    dbTabs_().forEach(function (tab) { out[tab] = dbLoadTab_(tab); });
    out.done = dbCall_('pkp_load_done', { p_primary: true });
    p.setProperty('DB_PRIMARY', '1');
    DB_ON_ = true; SS_ = null; TABLES_ = {};
    console.log(JSON.stringify(out));
    return out;
  } finally { l.releaseLock(); }
}
function dbLoadTab_(tab) {
  const sh = rawSs_().getSheetByName(tab), heads = dbHeads_(tab);
  if (!sh && !heads) throw new Error('ไม่พบแท็บ ' + tab);
  const h = sh ? dbHeadOf_(sh) : heads.slice(), last = sh ? sh.getLastRow() : 0;
  DB.TABS[tab].forEach(function (c) { if (h.indexOf(c) < 0) throw new Error('แท็บ ' + tab + ' ไม่มีคอลัมน์ ' + c); });
  const v = last > 1 ? sh.getRange(2, 1, last - 1, h.length).getValues() : [], rows = [], seen = {};
  v.forEach(function (r, i) {
    if (r.every(function (x) { return x === '' || x == null; })) return; // blank row
    let k = dbKeyOf_(tab, h, r);
    if (!k || seen[k]) k = '#row' + (i + 2); // no key / key twice: kept under its row number (never matches a real id)
    seen[k] = 1;
    const d = {};
    h.forEach(function (c, j) { if (!c) return; const e = dbEnc_(r[j]); if (e !== null) d[c] = e; });
    rows.push({ k: k, s: i + 2, d: d });
  });
  for (let i = 0; i === 0 || i < rows.length; i += DB.BATCH) {
    dbCall_('pkp_load', { p_tab: tab, p_keycol: DB.TABS[tab].join('|'), p_headers: h, p_rows: rows.slice(i, i + DB.BATCH), p_truncate: i === 0 });
  }
  return rows.length;
}
// Back to the sheet: copy what is still waiting, then the switch off (the sheet is then the store again).
function storeRollback() {
  const l = LockService.getScriptLock();
  l.waitLock(30000);
  try {
    const r = dbFlush_(true);
    dbCall_('pkp_load_done', { p_primary: false });
    PropertiesService.getScriptProperties().setProperty('DB_PRIMARY', '0');
    DB_ON_ = false; SS_ = null; TABLES_ = {};
    return { flushed: r, primary: false };
  } finally { l.releaseLock(); }
}
// A LATER tab on its own (the other tabs keep working): copy the sheet into Supabase under the script lock, then list it in DB_LATER_ON.
function dbCutoverLater_(tab) {
  const p = PropertiesService.getScriptProperties();
  if (DB.LATER.indexOf(tab) < 0) throw new Error(tab + ' ไม่ใช่แท็บที่เพิ่มทีหลัง');
  if (p.getProperty('DB_PRIMARY') !== '1') throw new Error('ยังไม่ได้สลับแท็บหลัก (storeCutover)');
  if (dbLaterOn_().indexOf(tab) >= 0) throw new Error(tab + ' ใช้ Supabase อยู่แล้ว');
  const l = LockService.getScriptLock();
  l.waitLock(30000);
  try {
    const n = dbLoadTab_(tab), done = dbCall_('pkp_load_done', { p_primary: true });
    const on = dbLaterOn_().concat([tab]);
    p.setProperty('DB_LATER_ON', on.join(','));
    DB_LATER_ON_ = on; SS_ = null; TABLES_ = {};
    const out = { tab: tab, rows: n, done: done };
    console.log(JSON.stringify(out));
    return out;
  } finally { l.releaseLock(); }
}
// back to the sheet for that tab only: copy what is still waiting, then take it off DB_LATER_ON
function dbRollbackLater_(tab) {
  const p = PropertiesService.getScriptProperties();
  const l = LockService.getScriptLock();
  l.waitLock(30000);
  try {
    const r = dbFlush_(true), on = dbLaterOn_().filter(function (t) { return t !== tab; });
    p.setProperty('DB_LATER_ON', on.join(','));
    DB_LATER_ON_ = on; SS_ = null; TABLES_ = {};
    return { flushed: r, tab: tab, store: 'sheet' };
  } finally { l.releaseLock(); }
}
function storeCutoverCoater() { return dbCutoverLater_('Coater_Records'); }
function storeRollbackCoater() { return dbRollbackLater_('Coater_Records'); }
// Extruder_Runtime + Die_Usage (shared with Extruder Log): this app first, then Extruder Log's dbCutoverShared reloads both from the sheet
function storeCutoverShared() { return [dbCutoverLater_('Extruder_Runtime'), dbCutoverLater_('Die_Usage')]; }
function storeRollbackShared() { return [dbRollbackLater_('Extruder_Runtime'), dbRollbackLater_('Die_Usage')]; }
function storeCutoverSetup() { return dbCutoverLater_('Grinding_Setup'); }
function storeRollbackSetup() { return dbRollbackLater_('Grinding_Setup'); }
// Check: every cell of the 14 tabs in Supabase = the sheet (run after the copy has caught up). Differences per tab (max 20 shown);
// cells the main script computes are counted apart (calc) — they reach Supabase only after a webhook.
function storeCompare() {
  if (!dbOn_()) return 'off';
  dbFlush_();
  const out = {};
  dbTabs_().forEach(function (tab) {
    const sh = rawSs_().getSheetByName(tab), db = dbRead_(tab), calc = DB.CALC[tab] || [];
    if (!sh) { out[tab] = { sheet: 0, db: db.rows.length }; return; }
    const h = dbHeadOf_(sh), last = sh.getLastRow(), v = last > 1 ? sh.getRange(2, 1, last - 1, h.length).getValues() : [];
    const sheetRows = v.filter(function (r) { return !r.every(function (x) { return x === '' || x == null; }); }), by = {}, diff = [];
    let nc = 0;
    sheetRows.forEach(function (r) { const k = dbKeyOf_(tab, h, r); if (k && !(k in by)) by[k] = r; });
    if (JSON.stringify(h) !== JSON.stringify(db.h)) diff.push('หัวคอลัมน์ไม่ตรง');
    db.rows.forEach(function (o) {
      const r = by[o.k];
      if (!r) { if (o.k.charAt(0) !== '#') diff.push(o.k + ' ไม่มีในชีต'); return; }
      h.forEach(function (c, j) {
        const i = db.h.indexOf(c); if (!c || i < 0) return;
        const a = JSON.stringify(dbEnc_(r[j])), b = JSON.stringify(dbEnc_(o.v[i]));
        if (a === b) return;
        if (calc.indexOf(c) >= 0) nc++; else diff.push(o.k + '.' + c + ': ชีต ' + a + ' / Supabase ' + b);
      });
    });
    out[tab] = { sheet: sheetRows.length, db: db.rows.length, diff: diff.length, calc: nc, first: diff.slice(0, 20) };
  });
  console.log(JSON.stringify(out));
  return out;
}

/* ---------- GitHub Pages (user 10 Nov 2026) ----------
 * หน้าแอปบน GitHub Pages (skaart19bfl.github.io/bfl-app-assets/<app>/) เรียกฟังก์ชันเดิมของสคริปต์นี้ผ่าน POST แทน google.script.run
 * __page = ส่ง Index.html ไปให้หน้า GitHub Pages (ส่ง hash มาตรงกัน = ไม่ส่งซ้ำ) · ลิงก์ /exec เดิมยังเปิดได้เหมือนเดิม
 * เรียกได้เฉพาะชื่อที่ google.script.run เรียกได้อยู่แล้ว และกันชื่องานหลังบ้าน (setup / store / sync / migrate / trigger …) ออกเพิ่ม */
var GLOBAL__ = this;
/* ---------- v54: the phone reads Supabase itself (user 14 Nov 2026 "ทำเลย") ----------
 * The page runs this file's read functions on the phone (lr.js) on rows from Supabase (pdr_get + ticket) — no UrlFetch here.
 * rdCtx gives only what is not in Supabase: sheet-only tabs (PIN hashes blanked; a tab the phone already has with the same hash is
 * not sent again), the Script Properties the reads use and the ticket. No ticket unless DB_PRIMARY = '1' and PD_LOCAL_R = '1'. */
const RD = { SHEETS: ['ProdApp_Users', 'Production_Lot', 'Product_Detail', 'RuntimeType', 'NCP', 'Moisture', 'Kibble', 'Grinding_Fineness', 'NCP_Detail',
  'Production_NCP_Map', 'Old_Semi_Use', 'Extruder_Lot_Info', 'FG_Lot', 'Batching_OCR_Log'], HOURS: 2 };
function rdCtx(token, want, have) {
  cacheOn_();
  const me = session_(token), all = PropertiesService.getScriptProperties().getProperties();
  const props = { DB_PRIMARY: all.DB_PRIMARY || '', DB_LATER_ON: all.DB_LATER_ON || '', PD_LOCAL_R: all.PD_LOCAL_R || '', PD_LOCAL_W: all.PD_LOCAL_W || '' };
  const sheets = {}, same = {}, hash = {};
  (want || []).forEach(function (n) {
    n = String(n);
    if (RD.SHEETS.indexOf(n) < 0 || isDb_(n) || hash[n]) return;
    let v = TCACHE_ ? tcGet_(n) : null;
    if (!v) { const sh = rawSs_().getSheetByName(n); if (!sh) return; v = sh.getDataRange().getValues(); tcPut_(n, v); }
    if (n === CFG.USERS) { const i = v[0].map(String).indexOf('PIN_Hash'); if (i >= 0) v = v.map(function (r, j) { if (!j) return r; r = r.slice(); r[i] = ''; return r; }); }
    const enc = v.map(function (r) { return r.map(function (x) { return x instanceof Date ? { $d: x.getTime() } : x; }); });
    const hx = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, JSON.stringify(enc), Utilities.Charset.UTF_8));
    hash[n] = hx;
    if (have && have[n] === hx) same[n] = 1; else sheets[n] = enc;
  });
  const on = props.DB_PRIMARY === '1' && props.PD_LOCAL_R === '1' && !!all.DB_KEY;
  return { me: { id: me.id, name: me.Name, role: me.Role }, ticket: on ? rdTicket_(me, all.DB_KEY) : null, props: props, sheets: sheets, same: same, hash: hash, serverNow: Date.now() };
}
function rdTicket_(me, key) {
  const exp = Date.now() + RD.HOURS * HOUR, body = [me.id, me.Role, exp].join('|');
  const hx = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key, Utilities.Charset.UTF_8).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
  return [me.id, me.Role, exp, Utilities.base64EncodeWebSafe(Utilities.computeHmacSha256Signature(body, 'pdr|' + hx)).replace(/=+$/, '')].join('.');
}
// editor switches (names start with "store" → doPost refuses them)
function storeLocalReadsOn() { PropertiesService.getScriptProperties().setProperty('PD_LOCAL_R', '1'); console.log('PD_LOCAL_R=1 at ' + new Date()); return 'PD_LOCAL_R=1'; }
function storeLocalWritesOn() { PropertiesService.getScriptProperties().setProperty('PD_LOCAL_W', '1'); console.log('PD_LOCAL_W=1 at ' + new Date()); return 'PD_LOCAL_W=1'; }
function storeLocalWritesOff() { PropertiesService.getScriptProperties().setProperty('PD_LOCAL_W', '0'); console.log('PD_LOCAL_W=0 at ' + new Date()); return 'PD_LOCAL_W=0'; }
function storeLocalReadsOff() { PropertiesService.getScriptProperties().setProperty('PD_LOCAL_R', '0'); console.log('PD_LOCAL_R=0 at ' + new Date()); return 'PD_LOCAL_R=0'; }
function doPost(e) {
  var out;
  try {
    var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var fn = String(b.fn || '');
    if (fn === '__warm') {   // the Hub opened: fill the read cache now, while nobody waits (user 10 Nov 2026)
      out = { ok: true, v: tcRefresh_(TC.WARM_MS) };
    } else if (fn === '__page') {
      var html = HtmlService.createHtmlOutputFromFile('Index').getContent();
      var hsh = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, html, Utilities.Charset.UTF_8));
      out = { ok: true, v: b.hash === hsh ? { same: true, hash: hsh } : { html: html, hash: hsh } };
    } else {
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(fn) || /^(do|on)[A-Z]/.test(fn) ||
          /^(setup|store|sync|install|migrate|debug|test|cron|seed|reset|purge|wipe|backfill)/i.test(fn) || /(Trigger|Now)$/.test(fn) ||
          typeof GLOBAL__[fn] !== 'function' || !Object.prototype.propertyIsEnumerable.call(GLOBAL__, fn)) throw new Error('API: ไม่มีฟังก์ชัน ' + fn);
      out = { ok: true, v: GLOBAL__[fn].apply(null, b.args || []) };
    }
  } catch (err) {
    out = { ok: false, e: String((err && err.message) || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}


// Emergency (14 Nov 2026, UrlFetch quota used up — user approved switching Production App + Extruder Log to the sheet): like storeRollback but
// WITHOUT Supabase calls. Run only after checking pkp_out has no open rows. DB_LATER_ON is kept, so storeCutover later reloads every tab.
function storeSheetModeNow() {
  const l = LockService.getScriptLock(); l.waitLock(30000);
  try {
    PropertiesService.getScriptProperties().setProperty('DB_PRIMARY', '0');
    DB_ON_ = false; SS_ = null; TABLES_ = {};
    console.log('sheet mode at ' + new Date());
    return 'sheet mode';
  } finally { l.releaseLock(); }
}
