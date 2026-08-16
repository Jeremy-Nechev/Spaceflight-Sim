/* ============================================================
   world.js — planets, terrain, oceans, scenery, clouds,
              atmosphere, orbital maths and trajectory prediction
   ------------------------------------------------------------
   World space: metres, +x right, +y up, Earth centred on (0,0).
   ============================================================ */
(function (S) {
  'use strict';

  const U = S.util;
  const W = S.world = {};

  /* ═══════════════════ bodies ═══════════════════ */

  const EARTH = {
    id: 'earth', name: 'Earth', seed: 1337,
    radius: 300000,
    mu: 8.82e11,                       // g0 ≈ 9.8 m/s² at the surface
    sea: true,
    atmo: { height: 60000, rho0: 1.225, scaleH: 8000 },
    // terrain = radius + continents + detail   (integer harmonics ⇒ seamless wrap)
    cont: [[1500, 2, 1.1], [950, 3, 2.6], [520, 5, -1.0], [260, 7, 0.4]],
    detail: [[300, 17, 1.0], [150, 41, 2.0], [80, 97, 0.5]],
    contOrigin: Math.PI / 2,
    // a wide, gentle blend — a narrow one leaves a ring of cliffs round the pad
    pad: { theta: Math.PI / 2, width: 0.011 },
    padClear: 0.0024,
    col: {
      land: '#4f7a3a', landLo: '#6b5137', deep: '#3a2c20',
      core: '#2a6b81', coreLo: '#0c2436',        // the bulk of the globe, seen from space
      rock: '#8a8175', sand: '#d3bd8c',
      water: '#1f6fa8', waterDeep: '#0d3559', surf: '#a8dcf0',
      sky: '#5aa6e8', skyHi: '#1a4f8f', glow: '#79b8f0'
    },
    scenery: { density: 0.72, chunkM: 380, kinds: 'earth' },
    clouds: { chunkM: 3000, density: 0.55, loAlt: 700, hiAlt: 9000 },
    orbit: null
  };

  const MOON = {
    id: 'moon', name: 'Moon', seed: 90210,
    radius: 100000,
    mu: 1.6e10,                        // ≈1.6 m/s² at the surface
    sea: false,
    atmo: null,
    cont: [[900, 2, 0.5], [600, 3, 3.1], [350, 5, 1.7]],
    detail: [[220, 13, 2.0], [120, 29, 0.3]],
    contOrigin: 0,
    pad: null, padClear: 0,
    col: {
      land: '#9a978f', landLo: '#63615c', deep: '#3b3a37',
      core: '#86837c', coreLo: '#3f3d3a',
      rock: '#7d7a73', sand: '#b3b0a7',
      water: '#000', waterDeep: '#000', surf: '#000',
      sky: '#000', skyHi: '#000', glow: '#8899aa'
    },
    scenery: { density: 0.5, chunkM: 520, kinds: 'moon' },
    clouds: null,
    orbit: { parent: 'earth', a: 4.0e6, phase0: -0.6 }
  };

  MOON.orbit.n = Math.sqrt(EARTH.mu / Math.pow(MOON.orbit.a, 3));   // rad/s
  MOON.orbit.period = U.TAU / MOON.orbit.n;
  MOON.soi = MOON.orbit.a * Math.pow(MOON.mu / EARTH.mu, 0.4);      // ≈ 805 km

  W.bodies = [EARTH, MOON];
  W.earth = EARTH;
  W.moon = MOON;
  W.byId = { earth: EARTH, moon: MOON };
  W.t = 0;

  W.bodies.forEach(b => {
    b.seaLevel = b.radius;
    b.chunkAng = b.scenery.chunkM / b.radius;
    if (b.clouds) b.cloudAng = b.clouds.chunkM / b.radius;
    b._sc = new Map();
    b._cl = new Map();
  });

  /** scenery the player has already flattened */
  W.wrecked = new Set();
  W.resetScenery = function () { W.wrecked.clear(); };

  /* ═══════════════════ body motion ═══════════════════ */

  W.bodyPos = function (b, t) {
    if (!b.orbit) return { x: 0, y: 0 };
    const a = b.orbit.phase0 + b.orbit.n * t;
    return { x: b.orbit.a * Math.cos(a), y: b.orbit.a * Math.sin(a) };
  };

  W.bodyVel = function (b, t) {
    if (!b.orbit) return { x: 0, y: 0 };
    const a = b.orbit.phase0 + b.orbit.n * t, s = b.orbit.a * b.orbit.n;
    return { x: -s * Math.sin(a), y: s * Math.cos(a) };
  };

  /* ═══════════════════ terrain ═══════════════════ */

  /** smooth continent shape (no fine detail) */
  function continents(b, th) {
    const o = th - b.contOrigin;
    let h = 0;
    for (let i = 0; i < b.cont.length; i++) {
      const c = b.cont[i];
      h += c[0] * Math.sin(c[1] * o + c[2]);
    }
    return h;
  }

  function detailOf(b, th) {
    const o = th - b.contOrigin;
    let h = 0;
    for (let i = 0; i < b.detail.length; i++) {
      const c = b.detail[i];
      h += c[0] * Math.sin(c[1] * o + c[2]);
    }
    return h;
  }

  /** distance of the planet's surface from its centre, at polar angle th */
  const terrain = W.terrain = function (b, th) {
    let h = b.radius + continents(b, th) + detailOf(b, th);
    if (b.pad) {
      // blend to a dead-flat plateau at the launch site
      const d = U.wrap(th - b.pad.theta) / b.pad.width;
      const wgt = Math.exp(-d * d);
      if (wgt > 1e-4) {
        const flat = b.radius + continents(b, b.pad.theta);
        h = h + (flat - h) * wgt;
      }
    }
    return h;
  };

  /** outward unit normal of the terrain surface at angle th */
  W.terrainNormal = function (b, th) {
    const e = 2e-5;
    const dr = (terrain(b, th + e) - terrain(b, th - e)) / (2 * e);
    const r = terrain(b, th);
    const c = Math.cos(th), s = Math.sin(th);
    // tangent = (dr·c − r·s, dr·s + r·c) ⇒ outward normal is its right-hand perpendicular
    let nx = dr * s + r * c, ny = r * s - dr * c;
    const l = Math.hypot(nx, ny) || 1;
    return { x: nx / l, y: ny / l };
  };

  W.isOcean = function (b, th) { return b.sea && terrain(b, th) < b.seaLevel; };

  /** height of ground under a world point, and the point's altitude above it */
  W.groundInfo = function (b, x, y, t) {
    const bp = W.bodyPos(b, t == null ? W.t : t);
    const dx = x - bp.x, dy = y - bp.y;
    const r = Math.hypot(dx, dy);
    const th = Math.atan2(dy, dx);
    const g = terrain(b, th);
    return { r, th, ground: g, alt: r - g, dx, dy };
  };

  /** altitude above sea level (what the HUD shows) */
  W.altitudeASL = function (b, x, y, t) {
    const bp = W.bodyPos(b, t == null ? W.t : t);
    return Math.hypot(x - bp.x, y - bp.y) - b.seaLevel;
  };

  /* ═══════════════════ atmosphere ═══════════════════ */

  W.density = function (b, altASL) {
    if (!b.atmo || altASL >= b.atmo.height || altASL < -2000) return 0;
    return b.atmo.rho0 * Math.exp(-Math.max(0, altASL) / b.atmo.scaleH);
  };

  /** 0..1 — how deep in the atmosphere we are, for sky colour + audio */
  W.atmoFrac = function (b, altASL) {
    if (!b.atmo) return 0;
    return U.clamp(1 - altASL / b.atmo.height, 0, 1);
  };

  /* ═══════════════════ gravity ═══════════════════ */

  const GACC = { x: 0, y: 0 };
  W.gravity = function (x, y, t, out) {
    out = out || GACC;
    out.x = 0; out.y = 0;
    for (let i = 0; i < W.bodies.length; i++) {
      const b = W.bodies[i];
      const bp = W.bodyPos(b, t);
      const dx = bp.x - x, dy = bp.y - y;
      let r2 = dx * dx + dy * dy;
      const rmin = b.radius * 0.35;
      if (r2 < rmin * rmin) r2 = rmin * rmin;      // no singularity inside the core
      const r = Math.sqrt(r2);
      const a = b.mu / r2;
      out.x += a * dx / r;
      out.y += a * dy / r;
    }
    return out;
  };

  /** which body's sphere of influence a point sits in */
  W.soiBody = function (x, y, t) {
    const mp = W.bodyPos(MOON, t);
    const d = Math.hypot(x - mp.x, y - mp.y);
    return d < MOON.soi ? MOON : EARTH;
  };

  /* ═══════════════════ orbital elements ═══════════════════ */

  /** classic 2-body elements relative to body b */
  W.elements = function (b, x, y, vx, vy, t) {
    const bp = W.bodyPos(b, t), bv = W.bodyVel(b, t);
    const rx = x - bp.x, ry = y - bp.y;
    const ux = vx - bv.x, uy = vy - bv.y;
    const r = Math.hypot(rx, ry), v2 = ux * ux + uy * uy;
    const mu = b.mu;
    const en = v2 / 2 - mu / r;
    const h = rx * uy - ry * ux;
    const a = -mu / (2 * en);
    const e2 = 1 + (2 * en * h * h) / (mu * mu);
    const e = Math.sqrt(Math.max(0, e2));
    // eccentricity vector — points at periapsis
    const rv = rx * ux + ry * uy;
    const k = v2 - mu / r;
    const res = {
      body: b, r, speed: Math.sqrt(v2), a, e, h, energy: en,
      ex: (k * rx - rv * ux) / mu,
      ey: (k * ry - rv * uy) / mu,
      ap: en < 0 ? a * (1 + e) : Infinity,
      pe: a * (1 - e),
      period: en < 0 ? U.TAU * Math.sqrt(a * a * a / mu) : Infinity,
      vr: (rx * ux + ry * uy) / r
    };
    if (en >= 0) res.ap = Infinity;
    return res;
  };

  /* ═══════════════════ trajectory prediction ═══════════════════ */

  /**
   * Integrate a point mass forward under Earth + Moon gravity.
   * Returns points relative to the reference body's *current* position so the
   * path can be drawn straight onto the map.
   */
  W.predict = function (x, y, vx, vy, t0, opts) {
    opts = opts || {};
    const maxSteps = opts.maxSteps || 2400;
    const ref = W.soiBody(x, y, t0);
    const refNow = W.bodyPos(ref, t0);
    const pts = [];
    const g = { x: 0, y: 0 };
    let t = t0, hit = null, escape = false;

    const sx = x, sy = y;
    let closed = false, travelled = 0, lastStep = 0;

    // On a bound orbit one lap is all the player needs to see. Perturbation from
    // the other body means the path rarely closes on itself exactly, so cap the
    // span by the orbital period rather than relying on the proximity test alone.
    const el0 = W.elements(ref, x, y, vx, vy, t0);
    const maxSpan = (el0.e < 1 && isFinite(el0.period)) ? el0.period * 1.04 : Infinity;

    W.gravity(x, y, t, g);
    let ax = g.x, ay = g.y;

    for (let i = 0; i < maxSteps; i++) {
      const b = W.soiBody(x, y, t);
      const bp = W.bodyPos(b, t);
      const rr = Math.hypot(x - bp.x, y - bp.y);
      const Tc = U.TAU * Math.sqrt((rr * rr * rr) / b.mu);
      const dt = U.clamp(Tc / 240, 0.4, 1200);

      // velocity Verlet
      const nx = x + vx * dt + 0.5 * ax * dt * dt;
      const ny = y + vy * dt + 0.5 * ay * dt * dt;
      t += dt;
      W.gravity(nx, ny, t, g);
      vx += 0.5 * (ax + g.x) * dt;
      vy += 0.5 * (ay + g.y) * dt;
      lastStep = Math.hypot(nx - x, ny - y);
      travelled += lastStep;
      x = nx; y = ny; ax = g.x; ay = g.y;

      const rp = W.bodyPos(ref, t);
      pts.push(x - rp.x, y - rp.y);

      // impact?
      for (let k = 0; k < W.bodies.length; k++) {
        const cb = W.bodies[k], cp = W.bodyPos(cb, t);
        const cdx = x - cp.x, cdy = y - cp.y;
        const cr = Math.hypot(cdx, cdy);
        if (cr < cb.radius + 4000 && cr < terrain(cb, Math.atan2(cdy, cdx))) {
          hit = { body: cb, t: t - t0, x: cdx, y: cdy };
          break;
        }
      }
      if (hit) break;

      // one lap is enough
      if (t - t0 > maxSpan) { closed = true; break; }
      if (i > 40 && travelled > lastStep * 8 &&
        Math.hypot(x - sx, y - sy) < lastStep * 1.4) { closed = true; break; }

      if (Math.hypot(x, y) > MOON.orbit.a * 14) { escape = true; break; }
    }

    return { pts, ref, refNow, hit, closed, escape, span: t - t0 };
  };

  /* ═══════════════════ ground scenery ═══════════════════ */

  const KINDS = {
    earth: [
      { t: 'pine', wgt: 30, w: [4, 7], h: [9, 17] },
      { t: 'tree', wgt: 26, w: [7, 12], h: [8, 13] },
      { t: 'house', wgt: 22, w: [8, 14], h: [6, 10] },
      { t: 'block', wgt: 9, w: [12, 18], h: [15, 27] },
      { t: 'mast', wgt: 5, w: [3, 4], h: [24, 40] },
      { t: 'rock', wgt: 8, w: [3, 6], h: [2, 4] }
    ],
    moon: [
      { t: 'rock', wgt: 62, w: [3, 9], h: [2, 6] },
      { t: 'boulder', wgt: 33, w: [10, 18], h: [7, 13] },
      { t: 'flag', wgt: 5, w: [2, 3], h: [5, 7] }
    ]
  };

  function pickKind(list, r) {
    let tot = 0;
    for (const k of list) tot += k.wgt;
    let v = r * tot;
    for (const k of list) { v -= k.wgt; if (v <= 0) return k; }
    return list[list.length - 1];
  }

  /** deterministic scenery for one angular chunk */
  W.sceneryChunk = function (b, ci) {
    let arr = b._sc.get(ci);
    if (arr) return arr;
    arr = [];
    const ca = b.chunkAng, list = KINDS[b.scenery.kinds];
    const slots = 3;
    for (let k = 0; k < slots; k++) {
      if (U.hash(b.seed, ci, k * 11 + 1) > b.scenery.density) continue;
      const jitter = (U.hash(b.seed, ci, k * 11 + 2) - 0.5) * 0.7;
      const th = (ci + (k + 0.5 + jitter) / slots) * ca;
      const gr = terrain(b, th);
      if (b.sea && gr <= b.seaLevel + 8) continue;              // nothing in the water
      if (b.pad && Math.abs(U.wrap(th - b.pad.theta)) < b.padClear) continue;
      const kind = pickKind(list, U.hash(b.seed, ci, k * 11 + 3));
      const rw = U.hash(b.seed, ci, k * 11 + 4), rh = U.hash(b.seed, ci, k * 11 + 5);
      arr.push({
        key: b.id + ':' + ci + ':' + k,
        th, gr, type: kind.t,
        w: U.lerp(kind.w[0], kind.w[1], rw),
        h: U.lerp(kind.h[0], kind.h[1], rh),
        seed: Math.floor(U.hash(b.seed, ci, k * 11 + 6) * 65535)
      });
    }
    b._sc.set(ci, arr);
    if (b._sc.size > 900) b._sc.clear();
    return arr;
  };

  /**
   * Every scenery item whose angle falls inside [th0, th1].
   * Chunk indices come straight from the angle — atan2 keeps θ in (−π, π],
   * so indices stay bounded and each cached item keeps the exact ground
   * height it was generated against. Returns the cached objects themselves
   * (no allocation) because this runs every physics step.
   */
  W.sceneryIn = function (b, th0, th1, out) {
    out = out || [];
    out.length = 0;
    if (!b.scenery) return out;
    const ca = b.chunkAng;
    const c0 = Math.floor(th0 / ca) - 1, c1 = Math.ceil(th1 / ca) + 1;
    if (c1 - c0 > 700) return out;                              // way too zoomed out
    for (let ci = c0; ci <= c1; ci++) {
      const arr = W.sceneryChunk(b, ci);
      for (let i = 0; i < arr.length; i++) {
        const o = arr[i];
        if (!W.wrecked.has(o.key)) out.push(o);
      }
    }
    return out;
  };

  /* ═══════════════════ clouds ═══════════════════ */

  W.cloudChunk = function (b, ci) {
    let arr = b._cl.get(ci);
    if (arr) return arr;
    arr = [];
    const ca = b.cloudAng, cf = b.clouds;
    for (let k = 0; k < 2; k++) {
      if (U.hash(b.seed + 7, ci, k * 13 + 1) > cf.density) continue;
      const th = (ci + (k + 0.5 + (U.hash(b.seed + 7, ci, k * 13 + 2) - 0.5) * 0.8) / 2) * ca;
      const ra = U.hash(b.seed + 7, ci, k * 13 + 3);
      const alt = U.lerp(cf.loAlt, cf.hiAlt, ra * ra);
      const w = U.lerp(340, 1250, U.hash(b.seed + 7, ci, k * 13 + 4));
      const h = w * U.lerp(0.26, 0.44, U.hash(b.seed + 7, ci, k * 13 + 5));
      // lumps sitting on a flat base, tallest in the middle — a cumulus profile
      const puffs = [];
      const n = 6 + Math.floor(U.hash(b.seed + 7, ci, k * 13 + 6) * 5);
      for (let p = 0; p < n; p++) {
        const u = n === 1 ? 0.5 : p / (n - 1);
        const hump = Math.sin(Math.PI * u);
        const r1 = U.hash(b.seed + 7, ci, k * 97 + p * 3 + 20);
        const r2 = U.hash(b.seed + 7, ci, k * 97 + p * 3 + 21);
        const r3 = U.hash(b.seed + 7, ci, k * 97 + p * 3 + 22);
        puffs.push({
          dx: (u - 0.5 + (r1 - 0.5) * 0.7 / n) * w,
          dy: hump * h * 0.34 * (0.55 + 0.45 * r2),
          r: h * (0.30 + 0.24 * r3) * (0.68 + 0.5 * hump)
        });
      }
      arr.push({
        th, alt, w, h, puffs,
        drift: (U.hash(b.seed + 7, ci, k * 13 + 7) - 0.35) * 4e-6,
        op: U.lerp(0.5, 0.9, U.hash(b.seed + 7, ci, k * 13 + 8))
      });
    }
    b._cl.set(ci, arr);
    if (b._cl.size > 500) b._cl.clear();
    return arr;
  };

  W.cloudsIn = function (b, th0, th1, t, out) {
    out = out || [];
    out.length = 0;
    if (!b.clouds) return out;
    const ca = b.cloudAng;
    const c0 = Math.floor(th0 / ca) - 2, c1 = Math.ceil(th1 / ca) + 2;
    if (c1 - c0 > 400) return out;
    for (let ci = c0; ci <= c1; ci++) {
      const arr = W.cloudChunk(b, ci);
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        out.push({ th: c.th + c.drift * t, alt: c.alt, w: c.w, h: c.h, puffs: c.puffs, op: c.op });
      }
    }
    return out;
  };

  /* ═══════════════════ launch site ═══════════════════ */

  W.padTheta = EARTH.pad.theta;
  W.padGround = terrain(EARTH, EARTH.pad.theta);
  W.padPoint = function () {
    return {
      x: W.padGround * Math.cos(W.padTheta),
      y: W.padGround * Math.sin(W.padTheta)
    };
  };

})(window.SFS);
