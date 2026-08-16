/* ============================================================
   physics.js — one simulation step for every live vessel
   ------------------------------------------------------------
   Forces: gravity (Earth + Moon), engine thrust with gimbal,
           atmospheric drag + weathervaning, parachutes,
           buoyancy + water drag, terrain contact, scenery smashing.
   ============================================================ */
(function (S) {
  'use strict';

  const U = S.util;
  const W = S.world;
  const PH = S.physics = {};

  const DRAG_K = 0.5;        // global aero fudge — keeps ascents forgiving
  const RHO_W = 1000;        // water density
  const CONTACT_K = 420;     // contact spring, per kg
  const CONTACT_C = 42;      // contact damper, per kg
  const FRICTION = 0.72;
  const MAX_RATE = 1.9;      // rad/s the attitude controller aims for
  const RATE_GAIN = 5.0;     // how hard it chases that rate
  const CHUTE_RIP_Q = 45000; // dynamic pressure that shreds a canopy (Pa)
  // How much of the cross-flow restoring torque is applied. At full strength it
  // reaches ~500 kN·m at max q, which buries the ~150 kN·m the wheels and
  // gimbal can muster and leaves the craft unable to turn during the gravity
  // turn. The drag *force* is unscaled, so ascent losses stay honest — only the
  // weathervaning moment is softened, and fins still point the nose forward.
  const AERO_TQ = 0.30;

  const _g = { x: 0, y: 0 };
  const _wp = { x: 0, y: 0 };
  const _vp = { x: 0, y: 0 };
  let _pts = [];
  let _scen = [];

  /** cached, geometry-only aerodynamic summary */
  function aeroOf(v) {
    if (v._aero) return v._aero;
    let maxW = 0, top = null, bot = null, damp = 0;
    const lat = [], chutes = [];
    for (const p of v.parts) {
      maxW = Math.max(maxW, p.def.w);
      if (!top || p.ly > top.ly) top = p;
      if (!bot || p.ly < bot.ly) bot = p;
      const area = p.def.w * p.def.h;
      lat.push({ p, cdA: p.def.cd * area });
      const d = Math.hypot(p.lx - v.com.x, p.ly - v.com.y);
      damp += p.def.cd * area * d * d;
      if (p.def.chute) chutes.push(p);
    }
    v._aero = {
      areaAx: Math.PI / 4 * maxW * maxW,
      cdFwd: top ? top.def.cd : 0.9,
      cdBack: bot ? bot.def.cd : 1.0,
      lat, chutes, damp
    };
    return v._aero;
  }

  const SCEN_DENSITY = { pine: 22, tree: 22, house: 120, block: 210, mast: 70, rock: 300, boulder: 280, flag: 8 };
  function scenMass(o) { return o.w * o.h * (SCEN_DENSITY[o.type] || 60); }

  /** body whose surface we are closest to */
  function nearestBody(x, y, t) {
    let best = null, bestAlt = Infinity;
    for (const b of W.bodies) {
      const gi = W.groundInfo(b, x, y, t);
      if (gi.alt < bestAlt) { bestAlt = gi.alt; best = b; }
    }
    return best;
  }

  /* ═══════════════════ main step ═══════════════════ */

  PH.step = function (vessels, dt, t) {
    for (let i = 0; i < vessels.length; i++) {
      const v = vessels[i];
      if (!v.dead) stepVessel(v, dt, t);
    }
    collideVessels(vessels, t);
  };

  /* ═══════════════════ hull-to-hull collision ═══════════════════ */

  const _cpA = [], _cpB = [], _hitList = [];
  const _hit = { nx: 0, ny: 0, depth: 0 };
  const RESTITUTION = 0.18;

  /** Is this world point inside any part of v? If so, report the shallowest way out. */
  function pointInside(v, wx, wy, out) {
    const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
    const dx = wx - v.x, dy = wy - v.y;
    // world → vessel local (inverse rotation), then back into part coordinates
    const lx = dx * ca + dy * sa + v.com.x;
    const ly = -dx * sa + dy * ca + v.com.y;
    for (let i = 0; i < v.parts.length; i++) {
      const p = v.parts[i];
      const hw = p.def.w / 2, hh = p.def.h / 2;
      const ex = lx - p.lx, ey = ly - p.ly;
      if (Math.abs(ex) >= hw || Math.abs(ey) >= hh) continue;
      const outX = hw - Math.abs(ex), outY = hh - Math.abs(ey);
      let nlx = 0, nly = 0;
      if (outX < outY) { nlx = ex < 0 ? -1 : 1; out.depth = outX; }
      else { nly = ey < 0 ? -1 : 1; out.depth = outY; }
      out.nx = nlx * ca - nly * sa;          // local normal back into world space
      out.ny = nlx * sa + nly * ca;
      return true;
    }
    return false;
  }

  function collideVessels(vessels, t) {
    for (let i = 0; i < vessels.length; i++) {
      const a = vessels[i];
      if (a.dead || a.crash || t < a.noHitUntil) continue;
      for (let j = i + 1; j < vessels.length; j++) {
        const b = vessels[j];
        if (b.dead || b.crash || t < b.noHitUntil) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const rr = a.radius() + b.radius();
        if (dx * dx + dy * dy > rr * rr) continue;      // broad phase
        resolvePair(a, b);
      }
    }
  }

  function resolvePair(a, b) {
    _hitList.length = 0;
    a.contactPoints(_cpA);
    for (let i = 0; i < _cpA.length && _hitList.length < 40; i += 2) {
      if (pointInside(b, _cpA[i], _cpA[i + 1], _hit)) {
        _hitList.push(_cpA[i], _cpA[i + 1], _hit.nx, _hit.ny, _hit.depth);
      }
    }
    b.contactPoints(_cpB);
    for (let i = 0; i < _cpB.length && _hitList.length < 40; i += 2) {
      if (pointInside(a, _cpB[i], _cpB[i + 1], _hit)) {
        // normal points out of A, so flip it to push A away from B
        _hitList.push(_cpB[i], _cpB[i + 1], -_hit.nx, -_hit.ny, _hit.depth);
      }
    }
    const n = _hitList.length / 5;
    if (!n) return;

    const invMa = 1 / a.mass, invMb = 1 / b.mass;
    let worst = 0, deepest = 0;

    for (let k = 0; k < n; k++) {
      const px = _hitList[k * 5], py = _hitList[k * 5 + 1];
      const nx = _hitList[k * 5 + 2], ny = _hitList[k * 5 + 3];
      const depth = _hitList[k * 5 + 4];
      deepest = Math.max(deepest, depth);

      const rax = px - a.x, ray = py - a.y;
      const rbx = px - b.x, rby = py - b.y;
      const vax = a.vx - a.omega * ray, vay = a.vy + a.omega * rax;
      const vbx = b.vx - b.omega * rby, vby = b.vy + b.omega * rbx;
      const rvx = vax - vbx, rvy = vay - vby;
      const vn = rvx * nx + rvy * ny;
      if (vn > 0) continue;                       // already separating
      worst = Math.max(worst, -vn);

      const raXn = rax * ny - ray * nx;
      const rbXn = rbx * ny - rby * nx;
      const denom = invMa + invMb + (raXn * raXn) / a.inertia + (rbXn * rbXn) / b.inertia;
      if (denom <= 0) continue;
      const jImp = (-(1 + RESTITUTION) * vn) / (denom * n);

      a.vx += jImp * nx * invMa; a.vy += jImp * ny * invMa;
      a.omega += (raXn * jImp) / a.inertia;
      b.vx -= jImp * nx * invMb; b.vy -= jImp * ny * invMb;
      b.omega -= (rbXn * jImp) / b.inertia;
    }

    // ease the overlap apart so hulls don't sink into each other
    if (deepest > 0.03) {
      const nx = _hitList[2], ny = _hitList[3];
      const corr = (deepest - 0.02) * 0.35 / (invMa + invMb);
      a.x += nx * corr * invMa; a.y += ny * corr * invMa;
      b.x -= nx * corr * invMb; b.y -= ny * corr * invMb;
    }

    // a hard enough knock writes off both craft
    const tol = Math.min(a.crashSpeed(), b.crashSpeed());
    if (worst > tol) {
      const msg = 'was struck by another stage at ' + worst.toFixed(0) + ' m/s';
      a.crash = a.crash || msg;
      b.crash = b.crash || msg;
    }
  }

  function stepVessel(v, dt, t) {
    if (v._dirty) v.rebuildGraph();
    v.updateMass();
    const A = aeroOf(v);

    let Fx = 0, Fy = 0, Tq = 0;
    const m = v.mass;

    /* ── gravity ── */
    W.gravity(v.x, v.y, t, _g);
    Fx += _g.x * m; Fy += _g.y * m;

    /* ── where are we ── */
    const near = nearestBody(v.x, v.y, t);
    const altASL = W.altitudeASL(W.earth, v.x, v.y, t);
    const rho = W.density(W.earth, altASL);
    const atmoF = rho / W.earth.atmo.rho0;

    const nose = v.noseDir();
    const speed = Math.hypot(v.vx, v.vy);

    /* ── attitude command ── */
    let cmd = 0;
    const auth = v.authority();
    if (v.hasControl()) {
      let wantRate;
      if (v.sas === 'off') {
        wantRate = v.steer * MAX_RATE;
      } else {
        let target = v.sasTarget;
        if (v.sas === 'pro' && speed > 0.5) target = Math.atan2(-v.vx, v.vy);
        else if (v.sas === 'retro' && speed > 0.5) target = Math.atan2(v.vx, -v.vy);
        else if (v.sas === 'up') {
          // nose along the outward radial: rot(a)·(0,1) = r̂  ⇒  a = atan2(−r̂x, r̂y)
          const bp = W.bodyPos(near, t);
          const dx = v.x - bp.x, dy = v.y - bp.y;
          target = Math.atan2(-dx, dy);
        }
        const err = U.wrap(target - v.angle);
        wantRate = U.clamp(err * 1.7, -MAX_RATE, MAX_RATE) + v.steer * MAX_RATE;
      }
      cmd = U.clamp((wantRate - v.omega) * RATE_GAIN, -1, 1);
      Tq += cmd * auth * v.inertia;
    }

    /* ── engines ── */
    let liveThrust = 0;
    for (const p of v.parts) {
      p.throttle = 0;
      if (p.def.type !== 'engine' || !p.active) continue;
      const e = p.def.engine;
      const thr = e.solid ? 1 : v.throttle;
      if (thr <= 0.001) continue;

      const isp = e.ispVac + (e.ispSl - e.ispVac) * atmoF;
      const flow = (e.thrust / (e.ispVac * U.G0)) * thr;      // kg/s, throttle-scaled
      const need = flow * dt;

      let got;
      if (e.solid) {
        const have = p.def.fuel * p.fuel;
        got = Math.min(need, have);
        p.fuel = Math.max(0, p.fuel - got / p.def.fuel);
        if (p.fuel <= 0) p.active = false;
      } else {
        got = v.drawFuel(p.comp, need);
      }
      if (got <= 1e-9) continue;

      const frac = need > 0 ? got / need : 0;
      p.throttle = thr * frac;
      const T = e.thrust * (isp / e.ispVac) * thr * frac;
      liveThrust += T;

      // gimbal deflects opposite the commanded torque so it *helps* the wheels
      const gim = -cmd * (e.gimbal || 0);
      const a = v.angle + gim;
      const fx = -Math.sin(a) * T, fy = Math.cos(a) * T;
      v.worldOf(p, _wp);
      const rx = _wp.x - v.x, ry = _wp.y - v.y;
      Fx += fx; Fy += fy;
      Tq += rx * fy - ry * fx;

      if (S.fx) S.fx.exhaust(v, p, T, atmoF, dt);
    }
    v.liveThrust = liveThrust;

    /* ── atmosphere ── */
    if (rho > 1e-7 && speed > 0.05) {
      const vAx = v.vx * nose.x + v.vy * nose.y;
      const q = 0.5 * rho * speed * speed;

      // axial drag, straight through the centre of mass
      const cdAx = vAx > 0 ? A.cdFwd : A.cdBack;
      const fAx = 0.5 * rho * vAx * Math.abs(vAx) * cdAx * A.areaAx * DRAG_K;
      Fx -= nose.x * fAx; Fy -= nose.y * fAx;

      // cross-flow drag part by part — this is what makes fins work
      const lvx = v.vx - nose.x * vAx, lvy = v.vy - nose.y * vAx;
      const lSpd = Math.hypot(lvx, lvy);
      if (lSpd > 0.05) {
        const k = 0.5 * rho * lSpd * DRAG_K;
        for (const it of A.lat) {
          const f = k * it.cdA;
          const fx = -lvx * f, fy = -lvy * f;
          v.worldOf(it.p, _wp);
          Fx += fx; Fy += fy;
          Tq += ((_wp.x - v.x) * fy - (_wp.y - v.y) * fx) * AERO_TQ;
        }
      }
      // rotational damping from cross-flow — kept light so the craft stays
      // steerable at max q; the per-part cross-flow above still weathervanes it
      Tq -= 0.5 * rho * speed * v.omega * A.damp * DRAG_K * 0.3;

      // parachutes
      for (const p of A.chutes) {
        if (p.chuteOut && p.chute < 1) {
          if (rho > 0.002) {
            if (q > CHUTE_RIP_Q && p.chute > 0.05) {
              p.chuteOut = false; p.chute = 0;
              if (S.fx) S.fx.note('Parachute ripped off!', 'bad');
              continue;
            }
            p.chute = Math.min(1, p.chute + dt / 1.6);
          } else p.chute = Math.min(p.chute, 0.12);
        }
        if (p.chute > 0.001) {
          const cA = p.def.chute.area * p.chute * p.chute;
          const f = 0.5 * rho * speed * p.def.chute.cd * cA;
          const fx = -v.vx * f, fy = -v.vy * f;
          v.worldOf(p, _wp);
          // riser sits above the canister, so pull from there
          _wp.x += nose.x * p.def.chute.riser * p.chute;
          _wp.y += nose.y * p.def.chute.riser * p.chute;
          Fx += fx; Fy += fy;
          Tq += (_wp.x - v.x) * fy - (_wp.y - v.y) * fx;
        }
      }
    } else {
      for (const p of A.chutes) if (!p.chuteOut) p.chute = 0;
    }

    /* ── water ── */
    if (near.sea) {
      const res = waterForces(v, near, t, dt);
      Fx += res.fx; Fy += res.fy; Tq += res.tq;
    } else v.inWater = false;

    /* ── ground + scenery ── */
    const gi = W.groundInfo(near, v.x, v.y, t);
    let contacts = 0;
    if (gi.alt < v.radius() + 60) {
      const res = groundForces(v, near, t, dt, m);
      Fx += res.fx; Fy += res.fy; Tq += res.tq; contacts = res.n;
      if (gi.alt < 90) smashScenery(v, near, t);
    }
    // groundForces reads last frame's value to spot the moment of touchdown
    v.touching = contacts > 0;

    /* ── integrate ── */
    v.vx += (Fx / m) * dt;
    v.vy += (Fy / m) * dt;
    v.x += v.vx * dt;
    v.y += v.vy * dt;

    v.omega += (Tq / v.inertia) * dt;
    if (Math.abs(v.omega) > 4.2) v.omega = 4.2 * U.sign(v.omega);
    v.angle = U.wrap(v.angle + v.omega * dt);

    /* ── resting ── */
    const bv = W.bodyVel(near, t);
    const relS = Math.hypot(v.vx - bv.x, v.vy - bv.y);
    v.landed = contacts > 0 && relS < 2.0;
    if (v.landed && relS < 0.45 && Math.abs(v.omega) < 0.06 && !liveThrust) {
      v.vx += (bv.x - v.vx) * 0.25;
      v.vy += (bv.y - v.vy) * 0.25;
      v.omega *= 0.75;
    }
    v.nearBody = near;
    v.altASL = altASL;
    v.atmoF = atmoF;
  }

  /* ═══════════════════ water ═══════════════════ */

  function waterForces(v, b, t, dt) {
    const bp = W.bodyPos(b, t);
    let fx = 0, fy = 0, tq = 0, wet = 0, deepest = 0;
    for (const p of v.parts) {
      v.worldOf(p, _wp);
      const dx = _wp.x - bp.x, dy = _wp.y - bp.y;
      const r = Math.hypot(dx, dy);
      const depth = b.seaLevel - r;
      if (depth < -p.def.h) continue;
      const th = Math.atan2(dy, dx);
      if (W.terrain(b, th) >= b.seaLevel) continue;         // dry land here
      const sub = U.clamp(depth / p.def.h + 0.5, 0, 1);
      if (sub <= 0) continue;
      wet++; deepest = Math.max(deepest, depth);

      const nx = dx / r, ny = dy / r;
      const vol = Math.PI / 4 * p.def.w * p.def.w * p.def.h;
      const gLoc = b.mu / (r * r);
      const buoy = RHO_W * vol * gLoc * sub;

      v.velAt(_wp.x, _wp.y, _vp);
      const sp = Math.hypot(_vp.x, _vp.y);
      const dragK = 0.5 * RHO_W * 0.55 * (p.def.w * p.def.h * 0.5) * sub * sp;

      const pfx = nx * buoy - _vp.x * dragK;
      const pfy = ny * buoy - _vp.y * dragK;
      fx += pfx; fy += pfy;
      tq += (_wp.x - v.x) * pfy - (_wp.y - v.y) * pfx;
    }

    if (wet) {
      // clamp so a fast belly-flop can't launch the integrator into orbit
      const mag = Math.hypot(fx, fy);
      const lim = 0.45 * v.mass * Math.max(6, Math.hypot(v.vx, v.vy)) / dt;
      if (mag > lim) { const s = lim / mag; fx *= s; fy *= s; tq *= s; }

      if (!v.inWater) {
        v.inWater = true;
        const sp = Math.hypot(v.vx, v.vy);
        if (S.fx) S.fx.splash(v.x, v.y, sp);
        if (sp > v.crashSpeed() + 12) v.crash = 'broke apart on impact with the water';
        else if (S.audio) S.audio.splash();
      }
    } else v.inWater = false;

    return { fx, fy, tq };
  }

  /* ═══════════════════ terrain contact ═══════════════════ */

  function groundForces(v, b, t, dt, m) {
    const bp = W.bodyPos(b, t);
    _pts = v.contactPoints(_pts);
    const n = _pts.length / 2;

    // pass 1: which points are actually buried
    const hitI = [], hitD = [];
    for (let i = 0; i < n; i++) {
      const px = _pts[i * 2], py = _pts[i * 2 + 1];
      const dx = px - bp.x, dy = py - bp.y;
      const r = Math.hypot(dx, dy);
      const th = Math.atan2(dy, dx);
      const g = W.terrain(b, th);
      if (r < g) { hitI.push(i); hitD.push(g - r, th); }
    }
    if (!hitI.length) return { fx: 0, fy: 0, tq: 0, n: 0 };

    const cnt = hitI.length;
    const k = (m * CONTACT_K) / cnt;
    const c = (m * CONTACT_C) / cnt;
    let fx = 0, fy = 0, tq = 0, worst = 0;

    for (let j = 0; j < cnt; j++) {
      const i = hitI[j], depth = hitD[j * 2], th = hitD[j * 2 + 1];
      const px = _pts[i * 2], py = _pts[i * 2 + 1];
      const nrm = W.terrainNormal(b, th);
      v.velAt(px, py, _vp);
      const bvv = W.bodyVel(b, t);
      const rvx = _vp.x - bvv.x, rvy = _vp.y - bvv.y;
      const vn = rvx * nrm.x + rvy * nrm.y;
      worst = Math.max(worst, Math.hypot(rvx, rvy));

      let Fn = k * Math.min(depth, 3) - c * vn;
      if (Fn < 0) Fn = 0;

      // friction along the surface
      const tvx = rvx - vn * nrm.x, tvy = rvy - vn * nrm.y;
      const ts = Math.hypot(tvx, tvy);
      let Ft = 0;
      if (ts > 1e-4) Ft = Math.min(FRICTION * Fn, ts * c * 0.6);

      const pfx = nrm.x * Fn - (ts > 1e-4 ? (tvx / ts) * Ft : 0);
      const pfy = nrm.y * Fn - (ts > 1e-4 ? (tvy / ts) * Ft : 0);
      fx += pfx; fy += pfy;
      tq += (px - v.x) * pfy - (py - v.y) * pfx;
    }

    if (!v.touching) {                       // first frame of this touchdown
      const inSea = W.isOcean(b, gi_th(v, b, t));
      const tol = v.crashSpeed() + (inSea ? 12 : 0);
      if (worst > tol) {
        v.crash = worst > tol * 2
          ? 'hit the ground at ' + worst.toFixed(0) + ' m/s'
          : 'came down too hard (' + worst.toFixed(0) + ' m/s)';
      } else if (worst > 2 && S.fx) S.fx.dust(v, b, t, worst);
    }
    return { fx, fy, tq, n: cnt };
  }

  function gi_th(v, b, t) {
    const bp = W.bodyPos(b, t);
    return Math.atan2(v.y - bp.y, v.x - bp.x);
  }

  /* ═══════════════════ scenery ═══════════════════ */

  function smashScenery(v, b, t) {
    if (!b.scenery) return;
    const bp = W.bodyPos(b, t);
    const gi = W.groundInfo(b, v.x, v.y, t);
    const span = (v.radius() + 40) / Math.max(1, gi.r);
    _scen = W.sceneryIn(b, gi.th - span, gi.th + span, _scen);
    if (!_scen.length) return;

    _pts = v.contactPoints(_pts);
    const np = _pts.length / 2;

    for (let s = 0; s < _scen.length; s++) {
      const o = _scen[s];
      // object frame: sitting on the ground, standing along the local normal
      const nrm = W.terrainNormal(b, o.th);
      const ox = bp.x + Math.cos(o.th) * o.gr + nrm.x * o.h / 2;
      const oy = bp.y + Math.sin(o.th) * o.gr + nrm.y * o.h / 2;
      const ux = nrm.x, uy = nrm.y;          // object "up"
      const hw = o.w / 2, hh = o.h / 2;

      let hitX = 0, hitY = 0, hit = false;
      for (let i = 0; i < np; i++) {
        const dx = _pts[i * 2] - ox, dy = _pts[i * 2 + 1] - oy;
        const along = dx * ux + dy * uy;             // vertical in object space
        const across = dx * uy - dy * ux;            // horizontal
        if (Math.abs(along) < hh && Math.abs(across) < hw) {
          hit = true; hitX = _pts[i * 2]; hitY = _pts[i * 2 + 1];
          break;
        }
      }
      if (!hit) continue;

      W.wrecked.add(o.key);
      v.velAt(hitX, hitY, _vp);
      const bvv = W.bodyVel(b, t);
      const rvx = _vp.x - bvv.x, rvy = _vp.y - bvv.y;
      const rel = Math.hypot(rvx, rvy);

      if (S.fx) S.fx.smash(ox, oy, o, rel);
      if (S.audio && rel > 3) S.audio.boom(Math.min(1, rel / 40));

      // inelastic exchange: the object soaks up momentum
      const om = scenMass(o);
      const j = Math.min(0.55, om / v.mass) * rel;
      if (rel > 0.01) {
        const jx = -(rvx / rel) * j, jy = -(rvy / rel) * j;
        v.vx += jx; v.vy += jy;
        v.omega += ((hitX - v.x) * jy - (hitY - v.y) * jx) * v.mass / v.inertia * 0.25;
      }

      // heavy things at speed end the mission
      if (rel > v.crashSpeed() * 1.35 || (om > 8000 && rel > v.crashSpeed())) {
        v.crash = 'flew into a ' + friendlyName(o.type) + ' at ' + rel.toFixed(0) + ' m/s';
      }
    }
  }

  function friendlyName(t) {
    return t === 'block' ? 'tower block' : t === 'mast' ? 'radio mast'
      : t === 'pine' || t === 'tree' ? 'tree' : t === 'boulder' ? 'boulder' : t;
  }

  /* ═══════════════════ on-rails advance (high time warp) ═══════════════════ */

  /** Keplerian-ish coast: gravity only, no aero, no contact. */
  PH.coast = function (v, dt, t, substeps) {
    const n = substeps || 8;
    const h = dt / n;
    let ax, ay;
    W.gravity(v.x, v.y, t, _g); ax = _g.x; ay = _g.y;
    for (let i = 0; i < n; i++) {
      const nx = v.x + v.vx * h + 0.5 * ax * h * h;
      const ny = v.y + v.vy * h + 0.5 * ay * h * h;
      W.gravity(nx, ny, t + h * (i + 1), _g);
      v.vx += 0.5 * (ax + _g.x) * h;
      v.vy += 0.5 * (ay + _g.y) * h;
      v.x = nx; v.y = ny;
      ax = _g.x; ay = _g.y;
    }
    v.angle = U.wrap(v.angle + v.omega * dt);
    v.updateMass();
    v.nearBody = nearestBody(v.x, v.y, t);
    v.altASL = W.altitudeASL(W.earth, v.x, v.y, t);
    v.atmoF = 0;
    v.liveThrust = 0;
  };

})(window.SFS);
