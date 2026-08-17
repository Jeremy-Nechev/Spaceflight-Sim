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
    scenery: { density: 0.85, chunkM: 240, slots: 5, kinds: 'earth' },
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
    scenery: { density: 0.6, chunkM: 380, slots: 4, kinds: 'moon' },
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

  /**
   * Fine detail, optionally band-limited. `lim` is the highest harmonic the
   * caller can actually resolve; anything near or above it is faded out so a
   * zoomed-out coastline stays smooth instead of aliasing into jitter.
   */
  function detailOf(b, th, lim) {
    const o = th - b.contOrigin;
    let h = 0;
    for (let i = 0; i < b.detail.length; i++) {
      const c = b.detail[i];
      const w = lim ? U.clamp(1 - (c[1] / lim - 0.6) / 0.4, 0, 1) : 1;
      if (w > 0) h += c[0] * w * Math.sin(c[1] * o + c[2]);
    }
    return h;
  }

  /**
   * Distance of the planet's surface from its centre at polar angle th.
   * `dth` is the angular spacing the caller is sampling at — pass it when
   * drawing so detail can be band-limited; omit it (physics, collision) to get
   * the true, full-detail surface.
   */
  const terrain = W.terrain = function (b, th, dth) {
    const lim = dth > 0 ? Math.PI / (dth * 3) : 0;
    let h = b.radius + continents(b, th) + detailOf(b, th, lim);
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
    // optional { posAt(t) } — how close the path we are actually on comes to
    // whatever is targeted, so the transfer panel can report it live
    const watch = opts.watch || null;
    const closest = watch ? { d: Infinity, t: t0 } : null;

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

      if (watch) {
        const wp = watch.posAt(t);
        const wd = Math.hypot(x - wp.x, y - wp.y);
        if (wd < closest.d) { closest.d = wd; closest.t = t; }
      }

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

    return { pts, ref, refNow, hit, closed, escape, span: t - t0, closest };
  };

  /* ═══════════════════ transfer planning ═══════════════════ */

  /** Integrate a point mass forward by `span` seconds. */
  function propagate(x, y, vx, vy, t0, span) {
    let t = t0;
    const g = { x: 0, y: 0 };
    W.gravity(x, y, t, g);
    let ax = g.x, ay = g.y;
    for (let i = 0; i < 24000 && t < t0 + span; i++) {
      const b = W.soiBody(x, y, t), bp = W.bodyPos(b, t);
      const rr = Math.hypot(x - bp.x, y - bp.y);
      let dt = U.clamp(U.TAU * Math.sqrt((rr * rr * rr) / b.mu) / 200, 0.5, 900);
      if (t + dt > t0 + span) dt = t0 + span - t;
      if (dt <= 1e-9) break;
      const nx = x + vx * dt + 0.5 * ax * dt * dt;
      const ny = y + vy * dt + 0.5 * ay * dt * dt;
      t += dt;
      W.gravity(nx, ny, t, g);
      vx += 0.5 * (ax + g.x) * dt; vy += 0.5 * (ay + g.y) * dt;
      x = nx; y = ny; ax = g.x; ay = g.y;
    }
    return { x, y, vx, vy, t };
  }
  W.propagate = propagate;

  /** where `target` sits at time t — a body's closed-form orbit, or a
      vessel's own propagated track once one has been attached (see
      W.vesselTarget / sampleTrack, below) */
  function targetPos(target, t) {
    return (target.isVessel && target.track) ? target.track.at(t) : W.bodyPos(target, t);
  }

  /** Fly forward and record how close we get to `target`. */
  function flyToward(x, y, vx, vy, t0, target, span, collect) {
    let t = t0, best = Infinity, bestT = t0, hit = false;
    const g = { x: 0, y: 0 };
    W.gravity(x, y, t, g);
    let ax = g.x, ay = g.y;
    const pts = collect ? [] : null;
    for (let i = 0; i < 2600 && t < t0 + span; i++) {
      const b = W.soiBody(x, y, t), bp = W.bodyPos(b, t);
      const rr = Math.hypot(x - bp.x, y - bp.y);
      const dt = U.clamp(U.TAU * Math.sqrt((rr * rr * rr) / b.mu) / 190, 0.5, 900);
      const nx = x + vx * dt + 0.5 * ax * dt * dt;
      const ny = y + vy * dt + 0.5 * ay * dt * dt;
      t += dt;
      W.gravity(nx, ny, t, g);
      vx += 0.5 * (ax + g.x) * dt; vy += 0.5 * (ay + g.y) * dt;
      x = nx; y = ny; ax = g.x; ay = g.y;
      if (collect) pts.push(x, y);
      const tp = targetPos(target, t);
      const d = Math.hypot(x - tp.x, y - tp.y);
      if (d < best) { best = d; bestT = t; }
      if (d < target.radius) { hit = true; break; }
      // fell back into the parent
      const pr = Math.hypot(x, y);
      if (pr < W.earth.radius) break;
    }
    return { miss: best, tArrive: bestT, pts, hit };
  }

  /**
   * Wrap a live vessel as a transfer target. A vessel has no closed-form
   * orbit formula the way a body does, so its future position has to come
   * from propagating its own current (coasting) state — see sampleTrack.
   * This assumes the target vessel doesn't burn between now and rendezvous,
   * which is the same assumption any rendezvous planner has to make about
   * a craft it doesn't control.
   */
  W.vesselTarget = function (ves, t0) {
    return {
      isVessel: true,
      name: (ves.mission && ves.mission.name) || 'the other craft',
      radius: Math.max(8, ves.radius()),
      soi: 5000,                       // "close enough to call it a rendezvous" bubble
      x0: ves.x, y0: ves.y, vx0: ves.vx, vy0: ves.vy, t0,
      track: null
    };
  };

  /**
   * Propagate a target's state once, sampling it at even intervals, so the
   * numeric refinement in planTransfer (which asks "where's the target?"
   * dozens of times) doesn't re-integrate from scratch on every query.
   */
  function sampleTrack(x, y, vx, vy, t0, span, nSamples) {
    span = Math.max(span, 1);
    const dt = span / nSamples;
    const xs = new Array(nSamples + 1), ys = new Array(nSamples + 1);
    xs[0] = x; ys[0] = y;
    const g = { x: 0, y: 0 };
    W.gravity(x, y, t0, g);
    let ax = g.x, ay = g.y, t = t0;
    for (let i = 0; i < nSamples; i++) {
      let left = dt;
      while (left > 1e-6) {
        const b = W.soiBody(x, y, t), bp = W.bodyPos(b, t);
        const rr = Math.hypot(x - bp.x, y - bp.y);
        const h = Math.min(left, U.clamp(U.TAU * Math.sqrt((rr * rr * rr) / b.mu) / 200, 0.25, left));
        const nx = x + vx * h + 0.5 * ax * h * h, ny = y + vy * h + 0.5 * ay * h * h;
        t += h;
        W.gravity(nx, ny, t, g);
        vx += 0.5 * (ax + g.x) * h; vy += 0.5 * (ay + g.y) * h;
        x = nx; y = ny; ax = g.x; ay = g.y;
        left -= h;
      }
      xs[i + 1] = x; ys[i + 1] = y;
    }
    return {
      t0, dt, xs, ys,
      at(tq) {
        const u = U.clamp((tq - t0) / dt, 0, nSamples);
        const i = Math.min(nSamples - 1, Math.floor(u));
        const f = u - i;
        return { x: U.lerp(xs[i], xs[i + 1], f), y: U.lerp(ys[i], ys[i + 1], f) };
      }
    };
  }

  /**
   * Work out when and how hard to burn to reach `target` from the craft's
   * current orbit.
   *
   * A Hohmann transfer gives the seed — the burn size that raises apoapsis to
   * the target's orbit, and the phase angle the target must be at so it arrives
   * at the same place we do. Because the real integration includes the target's
   * own gravity (and the orbit is rarely perfectly circular), the seed is then
   * refined numerically against actual closest approach.
   */
  W.planTransfer = function (v, target, t) {
    if (!target) return { ok: false, reason: 'Pick something to target first.' };
    if (!target.isVessel && !target.orbit) return { ok: false, reason: 'That world has no orbit to aim at.' };
    const parent = target.isVessel ? W.soiBody(target.x0, target.y0, t) : W.byId[target.orbit.parent];
    const soi = W.soiBody(v.x, v.y, t);
    if (target.isVessel) {
      const d = Math.hypot(v.x - target.x0, v.y - target.y0);
      if (d < target.soi) return { ok: false, reason: 'You are already at ' + target.name + '.' };
    } else if (soi === target) {
      return { ok: false, reason: 'You are already at ' + target.name + '.' };
    }
    if (soi !== parent) return { ok: false, reason: 'Escape ' + soi.name + ' first.' };

    const el = W.elements(parent, v.x, v.y, v.vx, v.vy, t);
    if (el.e >= 1) return { ok: false, reason: 'You are already on an escape path. Circularise first.' };
    if (el.pe < parent.radius + 20000) return { ok: false, reason: 'Get into a stable orbit first.' };

    const mu = parent.mu;
    // a vessel target has no closed-form orbit, so treat its current osculating
    // ellipse as a stand-in circular orbit for the analytic seed — same
    // approximation this already leans on for the (near-circular) Moon
    const elT = target.isVessel
      ? W.elements(parent, target.x0, target.y0, target.vx0, target.vy0, t)
      : null;
    const r1 = el.a, r2 = target.isVessel ? elT.a : target.orbit.a;
    const at = (r1 + r2) / 2;
    const tTrans = Math.PI * Math.sqrt((at * at * at) / mu);
    // signed mean motions: a craft going round the wrong way has a *negative*
    // rate, and using an unsigned one puts the window half a synodic period out
    const nT = target.isVessel
      ? (elT.h < 0 ? -1 : 1) * Math.sqrt(mu / (r2 * r2 * r2))
      : target.orbit.n;
    const nC = (el.h < 0 ? -1 : 1) * Math.sqrt(mu / (r1 * r1 * r1));
    if (Math.abs(nC - nT) < 1e-12) return { ok: false, reason: 'No transfer window exists.' };

    // Where the target must sit, relative to us, at the moment we burn. The
    // craft arrives half a transfer ellipse later — i.e. at the point opposite
    // the burn — so the target has to be that far ahead, less however far it
    // travels while we're on the way.
    //
    // The gap φ = θtarget − θcraft closes at (nT − nC), so the wait to reach
    // the required φ divides by *that*, not by (nC − nT): with the sign the
    // other way up the seed lands a synodic half-period off, and the numeric
    // refinement then polishes a window that was never the right one — which
    // is why a third of Moon transfers used to arrive hundreds of kilometres
    // wide of the intended pass.
    const pp = W.bodyPos(parent, t);
    const tp = target.isVessel ? { x: target.x0, y: target.y0 } : W.bodyPos(target, t);
    const thC = Math.atan2(v.y - pp.y, v.x - pp.x);
    const thT = Math.atan2(tp.y - pp.y, tp.x - pp.x);
    const phiReq = U.wrap(Math.PI - nT * tTrans);
    const syn = U.TAU / Math.abs(nT - nC);
    let wait = U.wrap(phiReq - U.wrap(thT - thC)) / (nT - nC);
    while (wait < 0) wait += syn;

    // A vessel sitting in a near-identical orbit (nC≈nT — the natural case
    // for two craft launched into similar orbits) makes `syn` enormous, so
    // the natural-drift `wait` above can come out to days or years even
    // though the geometry is otherwise perfectly ordinary. Tracking a target
    // accurately that far out isn't practical with a fixed sample budget —
    // the target completes so many of its own orbits between samples that
    // interpolating its position stops meaning anything — so rather than
    // hand back a plan that's silently wrong at that range, say so plainly:
    // matching orbits this closely needs a deliberate altitude change first,
    // same as it would for a real rendezvous.
    if (target.isVessel && wait > 4 * 24 * 3600) {
      return { ok: false, reason: 'Your orbit is almost identical to ' + target.name + "'s — natural drift would take days. Raise or lower your orbit a little, then recalculate." };
    }

    const vNow = Math.sqrt(mu * (2 / el.r - 1 / el.a));
    const dv0 = Math.sqrt(mu * (2 / el.r - 1 / at)) - vNow;
    const period = el.period;
    const span = tTrans * 2.2;

    // Tuning for the coarse sweep below, decided here (before it runs) so the
    // vessel-target position track can be sized to actually cover it.
    //
    // For a body target the Δv-sweep-width-proportional-to-dv0 approach is
    // fine because r1 and r2 (craft orbit vs. e.g. the Moon's orbit) are
    // wildly different, so dv0 is comfortably large. A vessel target's most
    // common real case is the opposite: rendezvousing with another craft in
    // a near-identical orbit (nC≈nT). There, dv0 collapses toward zero, so a
    // spread *proportional to dv0* collapses right along with it — the coarse
    // pass ends up probing a sliver of burn sizes near zero and can never
    // discover that a deliberately larger phasing burn reaches the target far
    // better than the near-null "Hohmann" the seed suggests. Floor it, for
    // vessel targets only, so body/Moon transfers keep their existing,
    // already-tuned behaviour untouched.
    // An eccentric starting orbit needs a wider net on both axes: the burn size
    // that reaches the target depends on *where* in the orbit it happens (a
    // kick at periapsis buys far more apoapsis than the same kick higher up),
    // so the seed — which treats the orbit as a circle of radius `a` — is only
    // a rough guide, and a spread tuned for a circle misses the good burns.
    const eccK = U.clamp(el.e / 0.1, 0, 1);
    const dvSpread0 = target.isVessel
      ? Math.max(dv0 * 0.18, vNow * 0.02, 2)
      : dv0 * (0.18 + 0.42 * eccK);
    // Near-resonant orbits (nC≈nT — a co-orbital rendezvous, the single most
    // common real vessel-target case) can genuinely need a wait spanning a
    // large slice of the synodic period before the phase lines up, since a
    // craft this close to the target's own period drifts past it only very
    // slowly. `period*0.35` covers well under one orbit in that case — nowhere
    // near enough. Widen toward the synodic period itself when it's
    // meaningfully larger than the craft's own orbit, capped so the coarse
    // grid doesn't get so sparse it stops resolving anything.
    // ...and, for the same reason, an eccentric orbit gets the whole lap in
    // play (half a period either way) instead of a third of it, with extra
    // grid points so widening the window doesn't just coarsen it.
    const tSpread0 = target.isVessel
      ? Math.max(period * 0.35, Math.min(syn * 0.5, period * 8))
      : period * (0.35 + 0.15 * eccK);
    const nT0 = target.isVessel ? 21 : (11 + Math.round(6 * eccK));
    const nD0 = target.isVessel ? 15 : (9 + Math.round(4 * eccK));

    // Give a vessel target a propagated position track covering the whole
    // window search() might probe, so flyToward can just interpolate.
    // search() runs three nested passes (spreads of tSpread0, then 0.07,
    // then 0.015 of `period`, each recentred on the previous best), so the
    // burn time it tries can walk a little past a single-pass estimate of
    // `wait` — and each candidate's flyToward then flies another full `span`
    // past that before giving up. Undershooting the true worst case let
    // queries run past the sampled track's end, where .at() clamps to the
    // last sample and effectively freezes the target in place — which was
    // quietly corrupting the search into optimizing against a stale position
    // instead of the real one. Rather than stack up the exact worst-case
    // fractions across all three passes, just use a generous flat margin
    // on top of the (now much wider, for a near-resonant orbit) tSpread0.
    if (target.isVessel) {
      const trackSpan = wait + tSpread0 + span + period * 0.5 + 900;
      const samples = Math.min(2000, Math.max(400, Math.ceil(trackSpan / 20)));
      target.track = sampleTrack(target.x0, target.y0, target.vx0, target.vy0, t, trackSpan, samples);
    }

    // How close we actually want to pass. Driving the miss distance to zero
    // aims the craft at the centre of the target — i.e. straight into the
    // ground — which is a rotten default: arriving in a low orbit is both what
    // a player normally wants and what the mission log rewards, and you can
    // always burn retrograde from orbit to land afterwards. So aim a little
    // above the surface and let the search hit *that*. A rendezvous with
    // another craft still wants to get as close as it can.
    const wantMiss = target.isVessel ? 0 : target.radius * 1.28;

    // ── refine: propagate once per candidate burn time, then try burn sizes ──
    let best = null;
    const search = (centreT, tSpread, dvCentre, dvSpread, nT_, nD) => {
      for (let i = 0; i < nT_; i++) {
        const tB = centreT + tSpread * (nT_ === 1 ? 0 : (i / (nT_ - 1) - 0.5) * 2);
        if (tB < t) continue;
        const st = propagate(v.x, v.y, v.vx, v.vy, t, tB - t);
        const sp = Math.hypot(st.vx, st.vy) || 1;
        const ux = st.vx / sp, uy = st.vy / sp;
        for (let k = 0; k < nD; k++) {
          const dv = dvCentre + dvSpread * (nD === 1 ? 0 : (k / (nD - 1) - 0.5) * 2);
          if (dv <= 0) continue;
          const r = flyToward(st.x, st.y, st.vx + ux * dv, st.vy + uy * dv, tB, target, span, false);
          const err = Math.abs(r.miss - wantMiss);
          if (!best || err < best.err) {
            best = { err, miss: r.miss, dv, tBurn: tB, tArrive: r.tArrive, hit: r.hit, st, ux, uy };
          }
        }
      }
    };
    search(t + wait, tSpread0, dv0, dvSpread0, nT0, nD0);
    // A coarse grid can settle into a poor corner of one window — a grazing
    // pass, or an arrival that only clips the edge of the sphere of influence.
    // When it clearly has, spend the same effort on the next window round and
    // keep whichever came out better, rather than handing back the bad one.
    // (Vessel targets sit this out: their sampled position track only covers
    // the first window, so probing past it would be measuring a frozen target.)
    if (!target.isVessel && (!best || best.err > wantMiss * 0.4)) {
      const first = best;
      best = null;
      search(t + wait + syn, tSpread0, dv0, dvSpread0, nT0, nD0);
      if (first && (!best || first.err < best.err)) best = first;
    }
    if (best) search(best.tBurn, period * 0.07, best.dv, Math.max(best.dv * 0.05, dvSpread0 * 0.1), 7, 7);
    if (best) search(best.tBurn, period * 0.015, best.dv, Math.max(best.dv * 0.012, dvSpread0 * 0.02), 5, 5);
    if (!best) return { ok: false, reason: 'Could not find a transfer from this orbit.' };

    // final pass, keeping the path for the map
    const shot = flyToward(best.st.x, best.st.y,
      best.st.vx + best.ux * best.dv, best.st.vy + best.uy * best.dv,
      best.tBurn, target, span, true);

    return {
      ok: true, target, parent,
      dv: best.dv,
      tBurn: best.tBurn,
      wait: best.tBurn - t,
      travel: best.tArrive - best.tBurn,
      miss: shot.miss,
      periapsis: shot.miss - target.radius,
      wantAlt: wantMiss - target.radius,
      intercept: shot.miss < target.soi,
      burnX: best.st.x, burnY: best.st.y,
      pts: shot.pts
    };
  };

  /**
   * Mid-course correction.
   *
   * Once the injection burn is done and the craft is on its way, a fresh
   * Hohmann plan is worse than useless — it describes a burn from an orbit the
   * craft is no longer in, at a window days away. What a player actually needs
   * then is the small nudge that moves the arrival to where they wanted it, so
   * this sweeps prograde/retrograde kicks applied *now* and keeps the one whose
   * closest approach lands nearest the intended pass.
   *
   * Returns a plan in the same shape as planTransfer, flagged `correction`.
   */
  W.planCorrection = function (v, target, t) {
    if (!target) return null;
    const wantMiss = target.isVessel ? 0 : target.radius * 1.28;
    const soi = target.isVessel ? (target.soi || 5000) : (target.soi || target.radius * 3);
    // look ahead one full lap of whatever path the craft is on now — the pass
    // we are trying to move has to happen inside that
    const elNow = W.elements(W.soiBody(v.x, v.y, t), v.x, v.y, v.vx, v.vy, t);
    const span = U.clamp(isFinite(elNow.period) ? elNow.period * 1.1 : 12 * 3600,
      3 * 3600, 3 * 24 * 3600);

    if (target.isVessel && !target.track) {
      target.track = sampleTrack(target.x0, target.y0, target.vx0, target.vy0, t, span, 900);
    }

    const sp = Math.hypot(v.vx, v.vy);
    if (sp < 1) return null;
    const ux = v.vx / sp, uy = v.vy / sp;

    let best = null;
    const sweep = (centre, spread, n) => {
      for (let i = 0; i < n; i++) {
        const dv = centre + spread * (n === 1 ? 0 : (i / (n - 1) - 0.5) * 2);
        const r = flyToward(v.x, v.y, v.vx + ux * dv, v.vy + uy * dv, t, target, span, false);
        const err = Math.abs(r.miss - wantMiss);
        if (!best || err < best.err) best = { err, dv, miss: r.miss, tArrive: r.tArrive };
      }
    };
    sweep(0, 70, 29);
    if (best) sweep(best.dv, 6, 9);
    if (best) sweep(best.dv, 0.9, 7);
    if (!best) return null;

    // keep the *current* pass too, so the caller can say whether burning helps
    const now = flyToward(v.x, v.y, v.vx, v.vy, t, target, span, false);

    return {
      ok: true, correction: true, target,
      dv: Math.abs(best.dv), retro: best.dv < 0,
      tBurn: t, wait: 0,
      travel: best.tArrive - t,
      miss: best.miss,
      periapsis: best.miss - target.radius,
      wantAlt: wantMiss - target.radius,
      nowPeriapsis: now.miss - target.radius,
      intercept: best.miss < soi,
      burnX: v.x, burnY: v.y,
      pts: null
    };
  };

  /* ═══════════════════ ground scenery ═══════════════════ */

  const KINDS = {
    earth: [
      { t: 'pine', wgt: 34, w: [4, 7], h: [9, 17] },
      { t: 'tree', wgt: 30, w: [7, 12], h: [8, 13] },
      { t: 'house', wgt: 26, w: [8, 14], h: [6, 10] },
      { t: 'block', wgt: 7, w: [12, 18], h: [15, 27] },
      { t: 'mast', wgt: 3, w: [3, 4], h: [24, 40] },
      { t: 'rock', wgt: 5, w: [3, 6], h: [2, 4] }
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
    const slots = b.scenery.slots || 3;
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
