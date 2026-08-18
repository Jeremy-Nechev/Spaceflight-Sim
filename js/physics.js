/* ============================================================
   physics.js — one simulation step for every live vessel
   ------------------------------------------------------------
   Forces: gravity (every world), engine thrust with gimbal,
           atmospheric drag + weathervaning, parachutes,
           buoyancy + water drag, terrain contact, scenery smashing,
           friction and solar heating.
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

  /* ── friction heating ──
     Stagnation heating goes as ρ·v³, balanced against radiative cooling, so a
     part settles at a heat level set by how fast it is ploughing through how
     much air. Measured against real descents and tuned so that: a capsule
     barely warms up (a light, blunt thing slows down high, where the air is
     thin); a whole stack coming back from low orbit glows and gets a warning
     but survives; and a stack returning from the Moon, or diving steeply into
     thick air, starts shedding fins and engines. A shield in front drops
     everything behind it to a couple of percent of that. */
  const HEAT_K = 3.4e-10;
  const HEAT_COOL = 0.08;      // per second, proportional to the heat held
  const HEAT_SHADOW = 0.18;    // share taken by a part tucked behind another
  // Sunlight, through the same accumulator: it falls off as 1/r², and the
  // constant is set so that out at Earth's orbit it settles a hull at a
  // harmless 2%, half that distance is uncomfortable, a tenth of it cooks
  // anything unshielded, and skimming the surface is measured in seconds.
  const SUN_HEAT = 1.64e14;

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

  /** body whose surface we are closest to. Compares against the sphere rather
      than the true terrain — a few km of hills never decides which *world* is
      nearest, and this runs for every craft every step */
  function nearestBody(x, y, t) {
    let best = null, bestAlt = Infinity;
    for (const b of W.bodies) {
      const bp = W.bodyPos(b, t);
      const alt = Math.hypot(x - bp.x, y - bp.y) - b.radius;
      if (alt < bestAlt) { bestAlt = alt; best = b; }
    }
    return best;
  }

  /* ═══════════════════ main step ═══════════════════ */

  PH.step = function (vessels, dt, t) {
    // effects spawned during this step are stamped with its time, so the
    // renderer knows not to integrate them for the whole frame (see FX.clock)
    if (S.fx) S.fx.clock = t;
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
    const near = nearestBody(v.x, v.y, t);      // whose ground we could hit
    const ref = W.soiBody(v.x, v.y, t);         // whose gravity we are orbiting
    const gi = W.groundInfo(near, v.x, v.y, t);      // used by the ground-contact
    // section below too — nothing moves between here and there, so one query does
    // air belongs to whichever world we are over, not to Earth — Mars has its
    // own (very thin) sky, and the Moon and Kore have none at all
    const altASL = W.altitudeASL(near, v.x, v.y, t);
    const rho = W.density(near, altASL);
    const atmoF = near.atmo ? rho / near.atmo.rho0 : 0;

    const nose = v.noseDir();
    // velocity through the air, which travels with the world it belongs to
    const airV = W.bodyVel(near, t);
    const avx = v.vx - airV.x, avy = v.vy - airV.y;
    const airSpd = Math.hypot(avx, avy);

    /* ── attitude command ── */
    let cmd = 0;
    const auth = v.authority();
    if (v.hasControl()) {
      let wantRate;
      if (v.sas === 'off') {
        wantRate = v.steer * MAX_RATE;
      } else {
        let target = v.sasTarget;
        // Prograde/retrograde have to be measured against the world you are
        // actually orbiting, not against the origin. Near Earth the two agree
        // (Earth doesn't move), but the Moon travels at ~470 m/s, so out there
        // the absolute velocity points somewhere quite different from the
        // direction of travel — which is why the nose used to settle well off
        // prograde once you left Earth's neighbourhood. The frame is the
        // *sphere of influence*, not the nearest surface: those two disagree
        // across a wide band around the Moon, and it is the dominant gravity
        // that decides which way an orbit is actually going.
        const bv = W.bodyVel(ref, t);
        const rvx = v.vx - bv.x, rvy = v.vy - bv.y;
        const rSpeed = Math.hypot(rvx, rvy);
        if (v.sas === 'pro' && rSpeed > 0.5) target = Math.atan2(-rvx, rvy);
        else if (v.sas === 'retro' && rSpeed > 0.5) target = Math.atan2(rvx, -rvy);
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

      if (S.fx) S.fx.exhaust(v, p, T, atmoF, dt, gi.alt);
    }
    v.liveThrust = liveThrust;

    /* ── atmosphere ──
       Air belongs to its world and travels with it. That was invisible while
       Earth sat still at the origin; now that it laps the Sun at two
       kilometres a second, using the raw world velocity here would put a
       rocket standing on the pad into a permanent hurricane. */
    if (rho > 1e-7 && airSpd > 0.05) {
      const vAx = avx * nose.x + avy * nose.y;
      const q = 0.5 * rho * airSpd * airSpd;

      // axial drag, straight through the centre of mass
      const cdAx = vAx > 0 ? A.cdFwd : A.cdBack;
      const fAx = 0.5 * rho * vAx * Math.abs(vAx) * cdAx * A.areaAx * DRAG_K;
      Fx -= nose.x * fAx; Fy -= nose.y * fAx;

      // cross-flow drag part by part — this is what makes fins work
      const lvx = avx - nose.x * vAx, lvy = avy - nose.y * vAx;
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
      Tq -= 0.5 * rho * airSpd * v.omega * A.damp * DRAG_K * 0.3;

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
          const f = 0.5 * rho * airSpd * p.def.chute.cd * cA;
          const fx = -avx * f, fy = -avy * f;
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
    v.landed = (contacts > 0 || v.inWater) && relS < 2.0;
    if (v.landed && relS < 0.45 && Math.abs(v.omega) < 0.06 && !liveThrust) {
      v.vx += (bv.x - v.vx) * 0.25;
      v.vy += (bv.y - v.vy) * 0.25;
      v.omega *= 0.75;
    }
    v.nearBody = near;
    v.refBody = ref;
    v.altASL = altASL;
    v.atmoF = atmoF;

    /* ── friction and solar heating (either can burn parts clean off) ── */
    applyHeat(v, rho, avx, avy, dt, t);
  }

  /* ═══════════════════ re-entry heating ═══════════════════ */

  /**
   * Every part carries its own accumulated heat. The parts actually facing the
   * airflow take the brunt of it; anything tucked behind another part takes a
   * fraction, and anything hiding behind a heat shield takes almost none. Run
   * a part past its tolerance and it burns away — and if that was the last
   * command pod, the craft is lost with it.
   */
  function applyHeat(v, rho, avx, avy, dt, t) {
    const ps = v.parts;
    // speed *through the air*, not across the solar system
    const speed = Math.hypot(avx, avy);
    const flux = (rho > 1e-7 && speed > 40) ? rho * speed * speed * speed * HEAT_K : 0;

    // Sunlight, falling off as 1/r², poured into the very same accumulator —
    // so a heat shield held between the craft and the Sun shades what's behind
    // it exactly as it does on the way through an atmosphere.
    const sp = W.bodyPos(W.sun, t == null ? W.t : t);
    const sdx = sp.x - v.x, sdy = sp.y - v.y;
    const sunFlux = SUN_HEAT / Math.max(1e6, sdx * sdx + sdy * sdy);

    // heat arrives from where the air is coming from (that is, from where we
    // are headed) and from wherever the Sun happens to be
    if (flux > 0) heatFrom(ps, v.com, v.angle, flux, avx, avy, dt);
    if (sunFlux > 2e-5) heatFrom(ps, v.com, v.angle, sunFlux, sdx, sdy, dt);
    // remember which of the two is doing the damage, so the obituary is right
    v.cookedBy = sunFlux > flux ? 'sun' : 'air';

    let worst = 0, hottest = 0, cooked = null;
    for (const p of ps) {
      p.temp = Math.max(0, p.temp - HEAT_COOL * p.temp * dt);
      const f = p.temp / p.def.heatTol;
      if (f > worst) worst = f;
      if (p.temp > hottest) hottest = p.temp;
      if (f >= 1) (cooked = cooked || []).push(p);
    }
    v.heatFrac = worst;
    v.heatGlow = hottest;
    if (flux > 0 && hottest > 0.08 && S.fx) S.fx.reentry(v, U.clamp(hottest / 0.6, 0, 1), dt);
    if (cooked) for (const p of cooked) burnOff(v, p);
  }

  /**
   * Pour `flux` into every part, from the world direction (dx, dy). Parts
   * facing the source take it all; anything tucked behind another takes a
   * fraction, and anything behind a heat shield takes almost none.
   */
  function heatFrom(ps, com, angle, flux, dx, dy, dt) {
    const len = Math.hypot(dx, dy) || 1;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    // the source direction, in the craft's own axes
    const ux = (dx * ca + dy * sa) / len;
    const uy = (-dx * sa + dy * ca) / len;
    const px = -uy, py = ux;                       // across it
    for (const p of ps) {
      const ax = p.lx - com.x, ay = p.ly - com.y;
      p._hs = ax * ux + ay * uy;                   // how far toward the source it sits
      p._hq = ax * px + ay * py;                   // offset across
      // exact half-extent of an axis-aligned box measured across the flow
      p._hx = 0.5 * (p.def.w * Math.abs(px) + p.def.h * Math.abs(py));
    }
    for (const p of ps) {
      let shade = 1, prot = 0;
      for (const o of ps) {
        if (o === p || o._hs <= p._hs + 0.05) continue;             // not in front
        if (Math.abs(o._hq - p._hq) > o._hx + p._hx) continue;      // not in the way
        shade = HEAT_SHADOW;
        if (o.def.shield) prot = Math.max(prot, o.def.shield.prot);
      }
      p.temp += flux * shade * (1 - prot) * dt;
    }
  }

  /** a part cooks off: it is gone, and losing the last pod takes the craft */
  function burnOff(v, p) {
    const podsLeft = v.parts.some(q => q !== p && q.def.type === 'pod');
    v.worldOf(p, _wp);
    const i = v.parts.indexOf(p);
    if (i >= 0) v.parts.splice(i, 1);
    if (S.fx) {
      S.fx.puff(_wp.x, _wp.y, Math.max(1.5, p.def.w * 2));
      if (v.mission) S.fx.note(p.def.name + ' burned away!', 'bad');
    }
    if (S.audio) S.audio.boom(0.5);
    if (!v.parts.length || (p.def.type === 'pod' && !podsLeft)) {
      v.crash = v.cookedBy === 'sun'
        ? 'was cooked to pieces by the Sun'
        : 'burned up in the atmosphere';
    }
    v._dirty = true; v._aero = null; v._radius = null;
    v.updateMass();
  }

  /* ═══════════════════ water ═══════════════════ */

  function waterForces(v, b, t, dt) {
    const bp = W.bodyPos(b, t);
    const bv = W.bodyVel(b, t);       // the sea travels with its world, like the air
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
      const wvx = _vp.x - bv.x, wvy = _vp.y - bv.y;      // speed through the water
      const sp = Math.hypot(wvx, wvy);
      const dragK = 0.5 * RHO_W * 0.55 * (p.def.w * p.def.h * 0.5) * sub * sp;

      const pfx = nx * buoy - wvx * dragK;
      const pfy = ny * buoy - wvy * dragK;
      fx += pfx; fy += pfy;
      tq += (_wp.x - v.x) * pfy - (_wp.y - v.y) * pfx;
    }

    if (wet) {
      const relS = Math.hypot(v.vx - bv.x, v.vy - bv.y);
      // clamp so a fast belly-flop can't launch the integrator into orbit
      const mag = Math.hypot(fx, fy);
      const lim = 0.45 * v.mass * Math.max(6, relS) / dt;
      if (mag > lim) { const s = lim / mag; fx *= s; fy *= s; tq *= s; }

      if (!v.inWater) {
        v.inWater = true;
        const sp = relS;
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

  /** one velocity-Verlet gravity step — no aero, no contact */
  function coastStep(v, h, t) {
    W.gravity(v.x, v.y, t, _g);
    const ax = _g.x, ay = _g.y;
    const nx = v.x + v.vx * h + 0.5 * ax * h * h;
    const ny = v.y + v.vy * h + 0.5 * ay * h * h;
    W.gravity(nx, ny, t + h, _g);
    v.vx += 0.5 * (ax + _g.x) * h;
    v.vy += 0.5 * (ay + _g.y) * h;
    v.x = nx; v.y = ny;
  }

  function coastEnd(v, dt, t) {
    v.angle = U.wrap(v.angle + v.omega * dt);
    v.updateMass();
    const near = nearestBody(v.x, v.y, t);
    v.nearBody = near;
    v.refBody = W.soiBody(v.x, v.y, t);
    v.altASL = W.altitudeASL(near, v.x, v.y, t);
    v.atmoF = 0;
    v.liveThrust = 0;
    // the Sun still bakes a craft that is coasting past it on rails
    applyHeat(v, 0, 0, 0, dt, t);
  }

  /**
   * Rails advance for the whole fleet at once.
   *
   * A warp substep can be minutes long, which moves a craft hundreds of
   * kilometres — far too coarse for the hull-level contact test used at 1×, so
   * craft used to sail straight through each other (and through worlds) the
   * moment the clock was wound forward. Collisions here are *swept* instead:
   * two craft touch if the closest approach of their two motion segments falls
   * inside their combined radii, and the same sweep against each world's
   * terrain catches a re-entry that would otherwise have been skipped over.
   */
  PH.rails = function (vessels, dt, t, minSteps) {
    // Substep from the geometry, not from a fixed count. A frame at top warp
    // is a quarter of an hour of flight: chop that into ten and a craft in low
    // orbit is being integrated twenty times per lap, which bleeds enough
    // accuracy to turn a carefully aimed lunar pass into a clean miss. Sizing
    // each step against the local orbital timescale keeps steps fine where the
    // path bends hard and lets them stretch out on the long coast between.
    let tc = Infinity;
    for (const v of vessels) {
      if (v.dead || v.crash || v.landed) continue;
      const b = W.soiBody(v.x, v.y, t), bp = W.bodyPos(b, t);
      const rr = Math.max(1, Math.hypot(v.x - bp.x, v.y - bp.y));
      tc = Math.min(tc, U.TAU * Math.sqrt((rr * rr * rr) / b.mu));
    }
    const n = isFinite(tc)
      ? U.clamp(Math.ceil(dt / Math.max(0.5, tc / 120)), minSteps || 1, 240)
      : (minSteps || 10);
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const t0 = t + h * i, t1 = t0 + h;
      if (S.fx) S.fx.clock = t0;
      for (const v of vessels) {
        if (v.dead || v.crash) continue;
        v._px = v.x; v._py = v.y; v._pvx = v.vx; v._pvy = v.vy;
        // a craft sitting on the ground rides along with its world rather than
        // free-falling through it while the clock is wound forward
        if (v.landed && v.nearBody && v.nearBody.orbit) {
          const p0 = W.bodyPos(v.nearBody, t0), p1 = W.bodyPos(v.nearBody, t1);
          const bv = W.bodyVel(v.nearBody, t1);
          v.x += p1.x - p0.x; v.y += p1.y - p0.y;
          v.vx = bv.x; v.vy = bv.y;
          continue;
        }
        if (v.landed) continue;
        coastStep(v, h, t0);
      }
      railsCollide(vessels, t1, h);
      railsGround(vessels, t1);
    }
    for (const v of vessels) {
      if (v.dead) continue;
      coastEnd(v, dt, t + dt);
    }
  };

  /**
   * Closest approach between two craft over one warp substep.
   *
   * A straight line between the substep's endpoints is nowhere near good
   * enough here: over a minute of orbital motion the chord cuts tens of metres
   * inside the real arc, which dwarfs a craft only a few metres across, so real
   * hits get missed and clean misses get flagged. Interpolating the *relative*
   * motion with a cubic Hermite (both endpoints' positions and velocities)
   * tracks the true arc to within centimetres; a coarse scan then a ternary
   * search pins down where the two are actually closest.
   */
  const _rel = { x: 0, y: 0 };
  function relAt(s, r, h, out) {
    const s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    out.x = h00 * r.x0 + h10 * h * r.vx0 + h01 * r.x1 + h11 * h * r.vx1;
    out.y = h00 * r.y0 + h10 * h * r.vy0 + h01 * r.y1 + h11 * h * r.vy1;
    return out;
  }

  function closestApproach(a, b, h) {
    const r = {
      x0: a._px - b._px, y0: a._py - b._py,
      vx0: a._pvx - b._pvx, vy0: a._pvy - b._pvy,
      x1: a.x - b.x, y1: a.y - b.y,
      vx1: a.vx - b.vx, vy1: a.vy - b.vy
    };
    const at = s => { relAt(s, r, h, _rel); return Math.hypot(_rel.x, _rel.y); };
    const N = 12;
    let bi = 0, bd = Infinity;
    for (let i = 0; i <= N; i++) {
      const d = at(i / N);
      if (d < bd) { bd = d; bi = i; }
    }
    let lo = Math.max(0, (bi - 1) / N), hi = Math.min(1, (bi + 1) / N);
    for (let k = 0; k < 40 && hi - lo > 1e-9; k++) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (at(m1) < at(m2)) hi = m2; else lo = m1;
    }
    return Math.min(bd, at((lo + hi) / 2));
  }

  function railsCollide(vessels, t, h) {
    for (let i = 0; i < vessels.length; i++) {
      const a = vessels[i];
      if (a.dead || a.crash || a._px == null || t < a.noHitUntil) continue;
      const trA = Math.hypot(a.x - a._px, a.y - a._py);
      for (let j = i + 1; j < vessels.length; j++) {
        const b = vessels[j];
        if (b.dead || b.crash || b._px == null || t < b.noHitUntil) continue;
        const rr = a.radius() + b.radius();
        // conservative reject: neither can close by more than the two path
        // lengths put together, so this skips essentially every pair
        const trav = trA + Math.hypot(b.x - b._px, b.y - b._py);
        if (Math.hypot(a._px - b._px, a._py - b._py) > rr + trav) continue;
        if (closestApproach(a, b, h) > rr) continue;
        const rel = Math.hypot(a.vx - b.vx, a.vy - b.vy);
        // a gentle drift-past is survivable at 1×, so it is survivable here too
        if (rel <= Math.min(a.crashSpeed(), b.crashSpeed())) continue;
        const msg = 'was struck by another craft at ' + rel.toFixed(0) + ' m/s';
        a.crash = a.crash || msg;
        b.crash = b.crash || msg;
      }
    }
  }

  function railsGround(vessels, t) {
    for (const v of vessels) {
      if (v.dead || v.crash || v.landed || v._px == null) continue;
      for (const b of W.bodies) {
        const bp = W.bodyPos(b, t);
        const x0 = v._px - bp.x, y0 = v._py - bp.y;
        const x1 = v.x - bp.x, y1 = v.y - bp.y;
        const dx = x1 - x0, dy = y1 - y0;
        const dd = dx * dx + dy * dy;
        let s = dd > 1e-9 ? -(x0 * dx + y0 * dy) / dd : 0;
        s = U.clamp(s, 0, 1);
        const cx = x0 + dx * s, cy = y0 + dy * s;      // deepest point of the sweep
        const r = Math.hypot(cx, cy);
        if (r > b.radius + 4000) continue;             // no terrain reaches that high
        if (r >= W.terrain(b, Math.atan2(cy, cx))) continue;
        const bv = W.bodyVel(b, t);
        const rel = Math.hypot(v.vx - bv.x, v.vy - bv.y);
        if (rel <= v.crashSpeed()) continue;           // a soft arrival, not a crash
        v.crash = 'flew into ' + b.name + ' at ' + rel.toFixed(0) + ' m/s under time warp';
        break;
      }
    }
  }

})(window.SFS);
