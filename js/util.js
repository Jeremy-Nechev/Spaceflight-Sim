/* ============================================================
   util.js: math, formatting and misc helpers
   ============================================================ */
window.SFS = window.SFS || {};
(function (S) {
  'use strict';

  const U = S.util = {};

  U.TAU = Math.PI * 2;
  U.G0 = 9.80665;                      // standard gravity, for Isp

  U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  U.lerp = (a, b, t) => a + (b - a) * t;
  U.smooth = (cur, tgt, rate, dt) => cur + (tgt - cur) * (1 - Math.exp(-rate * dt));
  U.sign = v => (v < 0 ? -1 : 1);

  /** wrap an angle into (-PI, PI] */
  U.wrap = function (a) {
    a = (a + Math.PI) % U.TAU;
    if (a < 0) a += U.TAU;
    return a - Math.PI;
  };
  /** wrap into [0, TAU) */
  U.wrap2 = function (a) {
    a %= U.TAU;
    return a < 0 ? a + U.TAU : a;
  };

  /** rotate vector (x,y) by angle a (CCW, y-up world) */
  U.rot = function (x, y, a) {
    const c = Math.cos(a), s = Math.sin(a);
    return { x: x * c - y * s, y: x * s + y * c };
  };
  U.rotX = (x, y, a) => x * Math.cos(a) - y * Math.sin(a);
  U.rotY = (x, y, a) => x * Math.sin(a) + y * Math.cos(a);

  U.len = Math.hypot;

  /** deterministic 32-bit hash -> float in [0,1) */
  U.hash = function (a, b, c) {
    let h = (a | 0) * 374761393 + (b | 0) * 668265263 + ((c | 0) + 1) * 2246822519;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 1274126177) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };

  /** small deterministic RNG seeded from an integer */
  U.rng = function (seed) {
    let s = (seed | 0) >>> 0 || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /* ─────────── formatting ─────────── */

  U.dist = function (m) {
    const a = Math.abs(m);
    if (a < 1000) return m.toFixed(0) + ' m';
    if (a < 1e6) return (m / 1e3).toFixed(a < 1e4 ? 2 : 1) + ' km';
    return (m / 1e6).toFixed(2) + ' Mm';
  };

  U.speed = function (v) {
    const a = Math.abs(v);
    if (a < 100) return v.toFixed(1) + ' m/s';
    if (a < 10000) return v.toFixed(0) + ' m/s';
    return (v / 1000).toFixed(2) + ' km/s';
  };

  U.mass = function (kg) {
    if (kg < 1000) return kg.toFixed(0) + ' kg';
    return (kg / 1000).toFixed(kg < 1e4 ? 2 : 1) + ' t';
  };

  U.force = function (n) {
    if (Math.abs(n) < 1000) return n.toFixed(0) + ' N';
    if (Math.abs(n) < 1e6) return (n / 1e3).toFixed(0) + ' kN';
    return (n / 1e6).toFixed(2) + ' MN';
  };

  U.time = function (s) {
    if (!isFinite(s) || s < 0) return 'N/A';
    s = Math.floor(s);
    const d = Math.floor(s / 86400), h = Math.floor(s / 3600) % 24;
    const m = Math.floor(s / 60) % 60, ss = s % 60;
    const p = n => String(n).padStart(2, '0');
    if (d > 0) return d + 'd ' + p(h) + ':' + p(m) + ':' + p(ss);
    if (h > 0) return h + ':' + p(m) + ':' + p(ss);
    return m + ':' + p(ss);
  };

  /* ─────────── canvas helpers ─────────── */

  U.roundRect = function (ctx, x, y, w, h, r) {
    r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + Math.sign(h) * r);
    ctx.lineTo(x + w, y + h - Math.sign(h) * r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - Math.sign(h) * r);
    ctx.lineTo(x, y + Math.sign(h) * r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  };

  U.poly = function (ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  };

  /** mix two '#rrggbb' colours */
  U.mix = function (c1, c2, t) {
    const p = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const a = p(c1), b = p(c2);
    return 'rgb(' + Math.round(U.lerp(a[0], b[0], t)) + ',' +
      Math.round(U.lerp(a[1], b[1], t)) + ',' + Math.round(U.lerp(a[2], b[2], t)) + ')';
  };

  /* ─────────── storage ─────────── */

  U.store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('sfs_' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, val) {
      try { localStorage.setItem('sfs_' + key, JSON.stringify(val)); } catch (e) { /* private mode */ }
    },
    del(key) {
      try { localStorage.removeItem('sfs_' + key); } catch (e) { }
    }
  };

  U.$ = sel => document.querySelector(sel);
  U.$$ = sel => Array.prototype.slice.call(document.querySelectorAll(sel));

})(window.SFS);
