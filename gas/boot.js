/* BFL apps on GitHub Pages (user 10 Nov 2026)
 * The app page (Index.html) still lives in its Apps Script project. This loader asks the script for it (doPost __page), keeps a
 * copy in this browser so the next open is instant, and writes it into this page with a small stand-in for google.script.run:
 * every server call becomes a POST to the same script (doPost → the same function as before). The /exec link still works.
 * Usage: <script src="../gas/boot.js" data-key="coat" data-exec="https://script.google.com/macros/s/…/exec" data-title="…"></script> */
(function () {
  var me = document.currentScript, cfg = me.dataset;
  var EXEC = cfg.exec, LSK = 'gasp-page-' + cfg.key, TITLE = cfg.title || document.title, BUILD = 2026112401;

  function lsGet() { try { return JSON.parse(localStorage.getItem(LSK) || 'null'); } catch (e) { return null; } }
  function lsSet(v) { try { localStorage.setItem(LSK, JSON.stringify(v)); } catch (e) { try { localStorage.removeItem(LSK); } catch (e2) {} } }
  // 24 Nov 2026: some Apps Script answers never arrive (the request runs, the reply hangs) → ask again after 10 s (the page only)
  function post(body, n) {
    n = n || 0;
    var ac = typeof AbortController === 'function' ? new AbortController() : null, tm = ac && setTimeout(function () { ac.abort(); }, 10000 + 2000 * n);
    return fetch(EXEC, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), cache: 'no-store', signal: ac ? ac.signal : undefined })
      .then(function (r) { if (!r.ok) throw new Error('เซิร์ฟเวอร์ตอบ ' + r.status); return r.text(); })
      .then(function (t) {
        clearTimeout(tm);
        var j; try { j = JSON.parse(t); } catch (e) { throw new Error('เซิร์ฟเวอร์ตอบไม่ถูกต้อง'); }
        if (!j.ok) throw new Error(j.e || 'ผิดพลาด'); return j.v;
      }, function (e) { clearTimeout(tm); if (n < 3 && ac && ac.signal.aborted) return post(body, n + 1); throw e; });
  }

  /* Runs inside the app page, before its own scripts. Kept free of globals except google + __GASP. */
  function shim(C) {
    // 24 Nov 2026 (Extruder Log stuck while loading): some Apps Script answers never arrive — the function runs, the reply hangs forever.
    // Reads (get… / list… / ex… / login …) are asked again after 8 s, 10 s, 12 s, 14 s (normal answer ~2 s); anything else gives up after 90 s with a
    // message to check before saving again (it may have been saved).
    var READ = /^(get|list|load|read|find|search|ex[A-Z]|hubLogin$|login$|ncp[A-Za-z]*Questions$|__)/;
    function post(body, n) {
      n = n || 0;
      var rd = READ.test(String(body.fn || '')), ac = typeof AbortController === 'function' ? new AbortController() : null;
      var tm = ac && setTimeout(function () { ac.abort(); }, rd ? 8000 + 2000 * n : 90000);
      return fetch(C.exec, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), cache: 'no-store', signal: ac ? ac.signal : undefined })
        .then(function (r) { if (!r.ok) throw new Error('เซิร์ฟเวอร์ตอบ ' + r.status); return r.text(); })
        .then(function (t) {
          clearTimeout(tm);
          var j; try { j = JSON.parse(t); } catch (e) { throw new Error('เซิร์ฟเวอร์ตอบไม่ถูกต้อง (ลองใหม่อีกครั้ง)'); }
          if (!j.ok) throw new Error(j.e || 'ผิดพลาด'); return j.v;
        }, function (e) {
          clearTimeout(tm);
          if (ac && ac.signal.aborted) {
            if (rd && n < 4) return post(body, n + 1);
            throw new Error(rd ? 'เซิร์ฟเวอร์ไม่ตอบ — ลองใหม่อีกครั้ง' : 'เซิร์ฟเวอร์ไม่ตอบ — ตรวจดูก่อนว่าบันทึกแล้วหรือยัง แล้วค่อยบันทึกซ้ำ');
          }
          throw e;
        });
    }
    function runner(ok, bad, uo) {
      return new Proxy({}, { get: function (_, name) {
        if (name === 'withSuccessHandler') return function (h) { return runner(h, bad, uo); };
        if (name === 'withFailureHandler') return function (h) { return runner(ok, h, uo); };
        if (name === 'withUserObject') return function (o) { return runner(ok, bad, o); };
        if (typeof name !== 'string' || name === 'then' || name === 'toJSON') return undefined;
        return function () {
          var args = Array.prototype.slice.call(arguments);
          post({ fn: name, args: args }).then(function (v) { if (ok) ok(v, uo); },
            function (e) { var err = e instanceof Error ? e : new Error(String(e)); if (bad) bad(err, uo); else console.error(name, err); });
        };
      } });
    }
    function loc() {
      var p = {}, ps = {};
      new URLSearchParams(location.search).forEach(function (v, k) { (ps[k] = ps[k] || []).push(v); if (!(k in p)) p[k] = v; });
      return { hash: location.hash.replace(/^#/, ''), parameter: p, parameters: ps };
    }
    window.google = { script: {
      run: runner(),
      url: { getLocation: function (cb) { var l = loc(); setTimeout(function () { cb(l); }, 0); } },
      host: { origin: location.origin, close: function () {}, setHeight: function () {}, setWidth: function () {}, editor: { focus: function () {} } },
      history: { push: function () {}, replace: function () {}, setChangeHandler: function () {} }
    } };
    window.__GASP = { exec: C.exec, key: C.key };
    document.addEventListener('DOMContentLoaded', function () { if (!document.title) document.title = C.title; });
    // a newer page in Apps Script → keep it for next time and offer a reload (never interrupts work in progress)
    if (C.check) setTimeout(function () {
      post({ fn: '__page', hash: C.hash }).then(function (v) {
        if (!v || v.same || !v.html) return;
        try { localStorage.setItem(C.lsk, JSON.stringify({ hash: v.hash, html: v.html, at: Date.now() })); } catch (e) {}
        var b = document.createElement('button');
        b.textContent = 'มีแอปเวอร์ชันใหม่ · แตะเพื่อโหลดใหม่';
        b.setAttribute('style', 'position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));z-index:2147483647;'
          + 'border:0;border-radius:999px;padding:12px 20px;font:600 15px/1.2 system-ui,sans-serif;background:#1F3A5F;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.25)');
        b.onclick = function () { location.reload(); };
        document.body.appendChild(b);
      }, function () {});
    }, 3000);
  }

  function bflGuard(APP, BUILD, OPT) { /* BFL version guard — 23 พ.ย. 2026 (ผู้ใช้ "A, B และให้บังคับ อัพเวอร์ชั่น ไม่งั้นเข้าไม่ได้")
 * ทุกคำขอไป Supabase ติด x-client-info: bfl/<app>/<build> · ทุกคำขอไป Apps Script ติด av · ทุก 10 นาที (และเมื่อกลับมาที่แท็บ) ถาม app_ver_min
 * เวอร์ชันนี้ต่ำกว่าที่กำหนด / Supabase หรือ Apps Script ตอบ APP_UPDATE / (แอปที่โหลดผ่าน boot.js) หน้าใน Apps Script เปลี่ยน
 * → ขึ้นหน้าบังคับโหลดใหม่ และหยุดส่งคำขอทั้งหมด */
  var W = window; if (W.__bflAv) return;
  var SB = 'https://kdytxuufvigwjccebrki.supabase.co', KEY = 'sb_publishable_IYCMIaN7tJleWINprA42CQ_dX10sXFF', TAG = 'bfl/' + APP + '/' + BUILD, f0 = W.fetch;
  var G = W.__bflAv = { app: APP, build: BUILD, tag: TAG, blocked: false, last: 0, block: block, check: check, act: Date.now(), runs: {}, slow: slow };
  // E14 (24 Nov 2026): nobody touching the screen → the app's "anything new?" loops ask less often (G.slow(key, base) = true → skip this tick)
  //   idle > 5 min: loops every ≤ 30 s → 30 s, longer loops → 5 min · idle > 30 min: → 60 s / 15 min · a touch or key → back to normal at once
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (e) { W.addEventListener(e, function () { G.act = Date.now(); }, { passive: true, capture: true }); });
  function slow(key, base) {
    var now = Date.now(), idle = now - G.act, every = base;
    if (idle > 30 * 60e3) every = base < 30e3 ? 60e3 : 15 * 60e3;
    else if (idle > 5 * 60e3) every = base < 30e3 ? 30e3 : 5 * 60e3;
    if (now - (G.runs[key] || 0) < every - 400) return true;
    G.runs[key] = now; return false;
  }
  // only the REST API (the Edge Function prod-calc does not allow extra headers in its CORS)
  function kind(u) { return u.indexOf('.supabase.co/rest/v1/') >= 0 ? 'sb' : (u.indexOf('script.google.com/macros/') >= 0 ? 'gas' : ''); }
  W.fetch = function (u, o) {
    var url = typeof u === 'string' ? u : (u && u.url) || '', k = kind(url);
    if (!k) return f0.apply(W, arguments);
    if (G.blocked) { show(); return Promise.reject(new Error('APP_UPDATE: แอปเวอร์ชันเก่า — กด "โหลดแอปใหม่"')); }
    o = o ? Object.assign({}, o) : {};
    if (k === 'sb') { var h = new Headers(o.headers || (typeof u !== 'string' && u.headers) || {}); h.set('x-client-info', TAG); o.headers = h; }
    else if (typeof o.body === 'string' && o.body.charAt(0) === '{') {
      try { var b = JSON.parse(o.body); if (b && typeof b === 'object' && !Array.isArray(b)) { b.av = TAG; o.body = JSON.stringify(b); } } catch (e) { /* not JSON */ }
    }
    var p = f0.call(W, u, o);
    p.then(function (r) {
      if (k === 'gas' || r.status >= 400) r.clone().text().then(function (t) { if (t.indexOf('APP_UPDATE') >= 0 && (k === 'sb' || t.indexOf('"ok":false') >= 0)) block(); }, function () {});
    }, function () {});
    return p;
  };
  function check() {
    if (G.blocked) return; G.last = Date.now();
    f0.call(W, SB + '/rest/v1/rpc/app_ver_min', { method: 'POST', cache: 'no-store', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', 'x-client-info': TAG }, body: JSON.stringify({ p_app: APP }) })
      .then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) { if (Number(t) > BUILD) block(); }, function () {});
    if (OPT && OPT.exec && OPT.hash) {   // page kept by gas/boot.js: a newer page in Apps Script → keep it for the reload, then reload
      f0.call(W, OPT.exec, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ fn: '__page', hash: OPT.hash, av: TAG }), cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; }).then(function (j) {
          var v = j && j.ok && j.v; if (!v || v.same || !v.html || !v.hash) return;
          try { localStorage.setItem(OPT.lsk, JSON.stringify({ hash: v.hash, html: v.html, at: Date.now() })); } catch (e) { /* full */ }
          block();
        }, function () {});
    }
  }
  function block() { G.blocked = true; show(); }
  function show() {
    if (document.getElementById('bfl-av')) return;
    if (!document.body) { setTimeout(show, 100); return; }
    var d = document.createElement('div'); d.id = 'bfl-av'; d.setAttribute('role', 'alertdialog');
    d.setAttribute('style', 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483647;background:rgba(15,27,45,.92);display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;font-family:system-ui,sans-serif');
    d.innerHTML = '<div style="background:#fff;color:#1B2A3D;border-radius:16px;max-width:420px;width:100%;padding:24px;box-sizing:border-box;text-align:center;box-shadow:0 10px 40px rgba(0,0,0,.4)">'
      + '<div style="font-size:21px;font-weight:700;margin-bottom:8px">มีแอปเวอร์ชันใหม่</div>'
      + '<div style="font-size:16px;line-height:1.55;margin-bottom:18px">ต้องโหลดแอปใหม่ก่อน จึงจะใช้งานต่อได้<br>ข้อมูลที่ยังไม่ได้กดบันทึก ต้องกรอกใหม่หลังโหลด</div>'
      + '<button type="button" style="border:0;border-radius:12px;padding:14px 24px;font:600 17px system-ui,sans-serif;background:#1F3A5F;color:#fff;width:100%">โหลดแอปใหม่</button></div>';
    d.querySelector('button').onclick = function () {
      this.disabled = true; this.textContent = 'กำลังโหลด…';
      if (!(OPT && OPT.exec)) try { Object.keys(localStorage).forEach(function (k) { if (/^gasp-page-/.test(k)) localStorage.removeItem(k); }); } catch (e) { /* none */ }
      location.reload();
    };
    document.body.appendChild(d);
  }
  setTimeout(check, 4000);
  setInterval(function () { if (!document.hidden) check(); }, 10 * 60e3);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - G.last > 60e3) check(); });
}

  function stampGuard() { /* 22 พ.ย. 2026 (ผู้ใช้ "ทำ 1 และ 2"): Supabase แผนฟรี (disk IO) — คำถาม "มีอะไรใหม่" (*_stamp) ไปถึง Supabase ไม่เกินทุก 30 วิ · ไม่มีคนแตะ/กดปุ่ม 10 นาที = ทุก 5 นาที · แตะหรือกลับมาที่แท็บ = ถามใหม่ทันที */
  var W = window, g = W.__stampGuard;
  if (!g) {
    g = W.__stampGuard = { every: 30e3, idle: 10 * 60e3, slow: 5 * 60e3, touch: Date.now(), last: {}, memo: {}, f0: W.fetch };
    W.fetch = function (u, o) {
      var url = typeof u === 'string' ? u : (u && u.url) || '', m = /\/rest\/v1\/rpc\/([a-z0-9_]+_stamp)(\?|$)/.exec(url), b = o && typeof o.body === 'string' ? o.body : null;
      if (!m || b === null || String((o && o.method) || 'GET').toUpperCase() !== 'POST') return g.f0.apply(W, arguments);
      var k = m[1] + '|' + b, n = Date.now(), c = g.memo[k], gap = n - g.touch > g.idle ? g.slow : g.every;
      if (c !== undefined && n - (g.last[k] || 0) < gap) return Promise.resolve(new Response(c, { status: 200, headers: { 'Content-Type': 'application/json' } }));
      g.last[k] = n;
      return g.f0.apply(W, arguments).then(function (r) { if (r.ok) r.clone().text().then(function (t) { g.memo[k] = t; }, function () {}); return r; });
    };
  }
  var wake = function () { var was = Date.now() - g.touch > g.idle; g.touch = Date.now(); if (was) g.last = {}; };
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach(function (e) { document.addEventListener(e, wake, { capture: true, passive: true }); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) g.last = {}; });
}

  function boot(page, check) {
    var C = { exec: EXEC, key: cfg.key, title: TITLE, lsk: LSK, hash: page.hash, check: check };
    var head = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
      + '<script>(' + bflGuard.toString() + ')(' + JSON.stringify(cfg.key) + ', ' + BUILD + ', ' + JSON.stringify({ exec: EXEC, hash: page.hash, lsk: LSK }).replace(/</g, '\\u003c') + ');<\/script>'
      + '<script>(' + shim.toString() + ')(' + JSON.stringify(C).replace(/</g, '\\u003c') + ');<\/script>'
      + '<script>(' + stampGuard.toString() + ')();<\/script>';
    // libraries from a CDN (e.g. xlsx for Excel export) load without blocking: Chrome may refuse a blocking cross-site script
    // written by document.write on a slow connection, and these are only used when someone presses a button
    var h = page.html.replace(/<script(\s+src=["']https?:\/\/[^"']+["'])\s*>/gi, '<script$1 async>'), m;
    if ((m = /<head[^>]*>/i.exec(h))) h = h.slice(0, m.index + m[0].length) + head + h.slice(m.index + m[0].length);
    else if ((m = /^\s*<!doctype[^>]*>/i.exec(h))) h = m[0] + head + h.slice(m[0].length);
    else h = '<!DOCTYPE html>' + head + h;
    document.open(); document.write(h); document.close();
  }

  function fail(e) {
    var s = document.getElementById('gasp-msg'); if (!s) return;
    s.innerHTML = '';
    var t = document.createElement('div'); t.textContent = 'เปิดแอปไม่ได้: ' + (e && e.message || e); s.appendChild(t);
    var r = document.createElement('button'); r.textContent = 'ลองใหม่'; r.onclick = function () { location.reload(); }; s.appendChild(r);
    var a = document.createElement('a'); a.textContent = 'เปิดแบบเดิม (Apps Script)'; a.href = EXEC + location.search; a.target = '_top'; s.appendChild(a);
  }

  var c = lsGet();
  // document.open() is ignored while this page is still being parsed → write the app only once parsing is done
  function later(f) { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(f, 0); }); else setTimeout(f, 0); }
  // V1 (23 Nov 2026): ask Apps Script first (up to 8 s) whether the kept page is still the newest — reopening always gives the newest page
  if (c && c.html && c.hash) {
    var done = false, wait = setTimeout(function () { if (!done) { done = true; later(function () { boot(c, false); }); } }, 8000);
    post({ fn: '__page', hash: c.hash }).then(function (v) {
      var fresh = v && !v.same && v.html && v.hash;
      if (fresh) lsSet({ hash: v.hash, html: v.html, at: Date.now() });
      if (done) return; done = true; clearTimeout(wait);
      later(function () { boot(fresh ? v : c, false); });
    }, function () { if (!done) { done = true; clearTimeout(wait); later(function () { boot(c, false); }); } });
  }
  else post({ fn: '__page' }).then(function (v) { lsSet({ hash: v.hash, html: v.html, at: Date.now() }); boot(v, false); }, fail);
})();
