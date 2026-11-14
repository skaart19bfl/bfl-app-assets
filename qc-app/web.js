/* BFL QC App (เว็บ) — ฟังก์ชันที่ต่างจาก Apps Script (โหลดหลัง server.js จึงทับของเดิม) */
/* ---------------- ส่วนที่ต่างจาก Apps Script ---------------- */
function rpc_(fn, args) {
  var r = xhr_(SB_URL + '/rest/v1/rpc/' + fn, { method: 'post', contentType: 'application/json',
    headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY }, payload: JSON.stringify(args || {}) });
  var body = r.getContentText(), j = null; try { j = body ? JSON.parse(body) : null; } catch (e) {}
  if (r.getResponseCode() >= 300) throw new Error((j && j.message) || 'เชื่อมต่อฐานข้อมูลไม่สำเร็จ');
  return j;
}
/* Apps Script endpoint (ออกเอกสาร / ส่งลง Sheet) — POST แบบ text/plain ไม่ต้อง preflight */
function gas_(api, args) {
  var r = xhr_(GAS_URL, { method: 'post', contentType: 'text/plain;charset=utf-8', payload: JSON.stringify({ api: api, token: CUR.token, args: args || {} }) });
  var j = null; try { j = JSON.parse(r.getContentText()); } catch (e) {}
  if (!j) throw new Error('เรียก Apps Script ไม่สำเร็จ (' + r.getResponseCode() + ')');
  if (!j.ok) throw new Error(j.error || 'Apps Script ผิดพลาด');
  return j.result;
}
// ไม่มี Sheet ให้อ่าน: ข้อมูลใหม่จาก AppSheet/แอปอื่นเข้า Supabase จากงานทุก 5 นาทีของ Apps Script แทน
function sheetTail_(name, max) { return { lr: max, head: [], rows: [] }; }
function now_() { return new Date(Date.now() + (CUR.offset || 0)); }
function sampleTime_(dateStr, hour, minute, free) {   // free = เลือกนาทีได้เอง (Extruder)
  var m = Number(minute);
  if (free ? !(m >= 0 && m <= 59 && Math.floor(m) === m) : (m !== 0 && m !== 30)) throw new Error(free ? 'นาทีไม่ถูกต้อง' : 'เวลาเก็บต้องเป็น :00 หรือ :30');
  var h = Number(hour); if (!(h >= 0 && h <= 23)) throw new Error('ชั่วโมงไม่ถูกต้อง');
  var p = String(dateStr).split('-');
  return new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2]), h - 7, m, 0));
}
function qcKey_() { if (!CUR.token) throw new Error('SESSION: กรุณาเข้าสู่ระบบใหม่'); return CUR.token; }
function session_(token, needRoles) {
  if (!CUR.user || !token || token !== CUR.token) throw new Error('SESSION: กรุณาเข้าสู่ระบบใหม่');
  if (needRoles && needRoles.indexOf(CUR.user.role) < 0) throw new Error('สิทธิ์ไม่พอ (' + CUR.user.role + ')');
  return { id: CUR.user.id, name: CUR.user.name, role: CUR.user.role };
}
function loginResult_(r) {
  if (!r || !r.ok) throw new Error((r && r.error) || 'เข้าสู่ระบบไม่สำเร็จ');
  CUR.token = r.token; CUR.user = r.user; CUR.offset = (r.now || Date.now()) - Date.now();
  return { token: r.token, exp: r.exp, user: r.user, offset: CUR.offset, mustChange: !!r.mustChange };
}
function api_bootstrap() {
  var u = rpc_('qc_users_public');
  return { needSetup: !!u.needSetup, users: u.users || [], forms: FORM_INFO, specItems: SPEC_ITEMS, qcSpecItems: QC_SPEC_ITEMS, masterTypes: MASTER_TYPES };
}
function api_login(userId, pin, remember) { return loginResult_(rpc_('qc_login', { p_user: String(userId || ''), p_pin: String(pin || ''), p_remember: !!remember })); }
function api_setupAdmin(name, pin) { return loginResult_(rpc_('qc_setup_admin', { p_name: String(name || ''), p_pin: String(pin || '') })); }
function api_hubLogin(ticket) { var r = loginResult_(rpc_('qc_hub_login', { p_ticket: String(ticket || '') })); r.hubUser = ''; return r; }
function api_logout(token) { try { rpc_('qc_logout', { p_token: token || CUR.token }); } catch (e) {} CUR.token = ''; CUR.user = null; return true; }
function api_users(token) { session_(token, ['Admin']); return rpc_('qc_users', { p_token: token }); }
function api_changePin(token, oldPin, newPin) { session_(token); return rpc_('qc_change_pin', { p_token: token, p_old: String(oldPin || ''), p_new: String(newPin || '') }); }
function api_saveUser(token, u) { session_(token, ['Admin']); return rpc_('qc_user_save', { p_token: token, p_u: u }); }
function api_exportXlsx(token, form, productionId) { session_(token); return gas_('xlsx', { form: form, productionId: productionId }); }
function api_checkTemplate(token, form) { session_(token); return gas_('check', { form: form }); }
function api_flushNow(token) { session_(token, ROLE_WRITE); return gas_('flush', {}); }
function api_outboxCount(token) { session_(token); try { return rpc_('qc_out_pending', { p_key: token, p_limit: 500 }).length; } catch (e) { return -1; } }
var _kibm = null;
function kibMaster_() {
  if (_kibm) return _kibm;
  var out = { shapes: [], colors: [] };
  try {
    var r = sbCall_('qc_read', { p_key: qcKey_(), p_reqs: [{ tab: 'Shape_Detail', cols: ['ShapeID', 'ShapeName', 'Cancelled'] }] }).Shape_Detail;
    var h = r.cols.map(function (c) { return c.h; }), iI = h.indexOf('ShapeID'), iN = h.indexOf('ShapeName'), iC = h.indexOf('Cancelled');
    r.rows.forEach(function (x) { var v = x.slice(1); if (v[iI] && !(iC >= 0 && v[iC] === true)) out.shapes.push({ id: String(v[iI]).trim(), name: String(v[iN] || '').trim() }); });
  } catch (e) { Logger.log('Shape_Detail ' + e.message); }
  return (_kibm = out);
}

