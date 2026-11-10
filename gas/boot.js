/* BFL apps on GitHub Pages (user 10 Nov 2026)
 * The app page (Index.html) still lives in its Apps Script project. This loader asks the script for it (doPost __page), keeps a
 * copy in this browser so the next open is instant, and writes it into this page with a small stand-in for google.script.run:
 * every server call becomes a POST to the same script (doPost → the same function as before). The /exec link still works.
 * Usage: <script src="../gas/boot.js" data-key="coat" data-exec="https://script.google.com/macros/s/…/exec" data-title="…"></script> */
(function () {
  var me = document.currentScript, cfg = me.dataset;
  var EXEC = cfg.exec, LSK = 'gasp-page-' + cfg.key, TITLE = cfg.title || document.title;

  function lsGet() { try { return JSON.parse(localStorage.getItem(LSK) || 'null'); } catch (e) { return null; } }
  function lsSet(v) { try { localStorage.setItem(LSK, JSON.stringify(v)); } catch (e) { try { localStorage.removeItem(LSK); } catch (e2) {} } }
  function post(body) {
    return fetch(EXEC, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('เซิร์ฟเวอร์ตอบ ' + r.status); return r.text(); })
      .then(function (t) {
        var j; try { j = JSON.parse(t); } catch (e) { throw new Error('เซิร์ฟเวอร์ตอบไม่ถูกต้อง'); }
        if (!j.ok) throw new Error(j.e || 'ผิดพลาด'); return j.v;
      });
  }

  /* Runs inside the app page, before its own scripts. Kept free of globals except google + __GASP. */
  function shim(C) {
    function post(body) {
      return fetch(C.exec, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('เซิร์ฟเวอร์ตอบ ' + r.status); return r.text(); })
        .then(function (t) {
          var j; try { j = JSON.parse(t); } catch (e) { throw new Error('เซิร์ฟเวอร์ตอบไม่ถูกต้อง (ลองใหม่อีกครั้ง)'); }
          if (!j.ok) throw new Error(j.e || 'ผิดพลาด'); return j.v;
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

  function boot(page, check) {
    var C = { exec: EXEC, key: cfg.key, title: TITLE, lsk: LSK, hash: page.hash, check: check };
    var head = '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
      + '<script>(' + shim.toString() + ')(' + JSON.stringify(C).replace(/</g, '\\u003c') + ');<\/script>';
    var h = page.html, m;
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
  if (c && c.html && c.hash) later(function () { boot(c, true); });
  else post({ fn: '__page' }).then(function (v) { lsSet({ hash: v.hash, html: v.html, at: Date.now() }); boot(v, false); }, fail);
})();
