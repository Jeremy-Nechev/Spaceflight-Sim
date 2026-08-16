/* ============================================================
   vessel.js — rigid-body craft assembled from parts,
               fuel compartments, stage groups and separation
   ------------------------------------------------------------
   Vessel local space: +y toward the nose, +x right.
   `pos` is always the world position of the centre of mass.
   angle 0 ⇒ nose points along world +y.
   ============================================================ */
(function (S) {
  'use strict';

  const U = S.util;
  const P = S.PARTS;
  const V = S.vessel = {};

  const TOUCH_TOL = 0.14;      // metres of slop when deciding "these parts touch"
  const SEP_SPEED = 3.0;       // m/s push-apart when a separator fires

  let UID = 1;
  V.nextUid = () => UID++;
  V.seedUid = function (n) { UID = Math.max(UID, (n | 0) + 1); };

  /* ═══════════════════ construction ═══════════════════ */

  function mkPart(spec) {
    const def = P[spec.id];
    if (!def) return null;
    return {
      uid: spec.uid || V.nextUid(),
      id: spec.id, def,
      lx: spec.x, ly: spec.y,
      flip: spec.flip || 1,
      fuel: def.fuel > 0 ? (spec.fuel == null ? 1 : spec.fuel) : 0,
      active: false, fired: false, chute: 0, chuteOut: false,
      deployed: def.type === 'leg',
      comp: 0, throttle: 0
    };
  }

  function Vessel(parts, stages) {
    this.parts = parts;
    this.stages = stages || [];
    this.stageIdx = 0;
    this.x = 0; this.y = 0; this.vx = 0; this.vy = 0;
    this.angle = 0; this.omega = 0;
    this.throttle = 0;
    this.com = { x: 0, y: 0 };
    this.mass = 1; this.inertia = 1;
    this.landed = false; this.dead = false;
    this.debris = false;
    this.noHitUntil = 0;      // grace period so freshly split pieces don't self-collide
    this.sas = 'off'; this.sasTarget = 0;
    this.steer = 0;
    this._dirty = true;
    this.updateMass(true);
    this.rebuildGraph();
  }
  V.Vessel = Vessel;

  V.fromBlueprint = function (bp) {
    const parts = [];
    for (const s of bp.parts) {
      const p = mkPart(s);
      if (p) { parts.push(p); V.seedUid(p.uid); }
    }
    if (!parts.length) return null;
    const live = new Set(parts.map(p => p.uid));
    let stages = (bp.stages || []).map(g => g.filter(u => live.has(u))).filter(g => g.length);
    if (!stages.length) stages = V.autoStages(parts);
    return new Vessel(parts, stages);
  };

  V.toBlueprint = function (parts, stages, name) {
    return {
      name: name || 'Rocket',
      parts: parts.map(p => ({ uid: p.uid, id: p.id, x: p.lx, y: p.ly, flip: p.flip })),
      stages: (stages || []).map(g => g.slice())
    };
  };

  /* ═══════════════════ stage groups ═══════════════════ */

  V.isStageable = function (def) {
    return def.type === 'engine' || def.type === 'sep' || def.type === 'chute';
  };

  /**
   * Default grouping: everything that can be activated, ordered bottom-up,
   * with parts at the same height sharing a stage. Bottom engines light first,
   * then the separator under them drops the spent stage, and so on.
   * The tolerance is tight enough that a separator and the engine sitting
   * directly on top of it land in different groups.
   */
  V.STAGE_TOL = 0.35;

  V.autoStages = function (parts) {
    const act = parts.filter(p => V.isStageable(p.def))
      .map(p => ({ uid: p.uid, y: p.ly - p.def.h / 2 }))
      .sort((a, b) => a.y - b.y);
    const out = [];
    let cur = null, curY = -1e9;
    for (const a of act) {
      if (!cur || a.y - curY > V.STAGE_TOL) { cur = []; out.push(cur); curY = a.y; }
      cur.push(a.uid);
    }
    return out;
  };

  Vessel.prototype.stageOf = function (uid) {
    for (let i = 0; i < this.stages.length; i++) if (this.stages[i].indexOf(uid) >= 0) return i;
    return -1;
  };

  Vessel.prototype.byUid = function (uid) {
    for (const p of this.parts) if (p.uid === uid) return p;
    return null;
  };

  /** Fire the next stage. Returns true if a separator went off (caller must split). */
  Vessel.prototype.fireStage = function () {
    if (this.stageIdx >= this.stages.length) return false;
    const group = this.stages[this.stageIdx++];
    let sep = false;
    for (const uid of group) {
      const p = this.byUid(uid);
      if (!p) continue;
      const t = p.def.type;
      if (t === 'engine') {
        p.active = true;
        if (p.def.engine.solid) p.throttle = 1;
      } else if (t === 'sep') {
        p.fired = true; sep = true;
      } else if (t === 'chute') {
        p.chuteOut = true;
      }
    }
    this._dirty = true;
    return sep;
  };

  /* ═══════════════════ mass properties ═══════════════════ */

  Vessel.prototype.updateMass = function (initial) {
    let m = 0, cx = 0, cy = 0;
    for (const p of this.parts) {
      const pm = p.def.mass + p.def.fuel * p.fuel;
      m += pm; cx += p.lx * pm; cy += p.ly * pm;
    }
    if (m <= 0) m = 1;
    cx /= m; cy /= m;

    if (!initial) {
      // keep the craft geometrically still as the centre of mass migrates
      const dx = cx - this.com.x, dy = cy - this.com.y;
      if (dx || dy) {
        this.x += U.rotX(dx, dy, this.angle);
        this.y += U.rotY(dx, dy, this.angle);
      }
    }
    this.com.x = cx; this.com.y = cy;
    this.mass = m;

    let I = 0;
    for (const p of this.parts) {
      const pm = p.def.mass + p.def.fuel * p.fuel;
      const w = p.def.w, h = p.def.h;
      const dx = p.lx - cx, dy = p.ly - cy;
      I += pm * (w * w + h * h) / 12 + pm * (dx * dx + dy * dy);
    }
    this.inertia = Math.max(1, I);
  };

  /** world position of a part's centre */
  Vessel.prototype.worldOf = function (p, out) {
    const dx = p.lx - this.com.x, dy = p.ly - this.com.y;
    out = out || {};
    out.x = this.x + U.rotX(dx, dy, this.angle);
    out.y = this.y + U.rotY(dx, dy, this.angle);
    return out;
  };

  Vessel.prototype.worldOfLocal = function (lx, ly, out) {
    const dx = lx - this.com.x, dy = ly - this.com.y;
    out = out || {};
    out.x = this.x + U.rotX(dx, dy, this.angle);
    out.y = this.y + U.rotY(dx, dy, this.angle);
    return out;
  };

  /** unit vector along the nose, in world space */
  Vessel.prototype.noseDir = function () {
    return { x: -Math.sin(this.angle), y: Math.cos(this.angle) };
  };

  /** velocity of a world point rigidly attached to the craft */
  Vessel.prototype.velAt = function (wx, wy, out) {
    const rx = wx - this.x, ry = wy - this.y;
    out = out || {};
    out.x = this.vx - this.omega * ry;
    out.y = this.vy + this.omega * rx;
    return out;
  };

  /* ═══════════════════ structure graph ═══════════════════ */

  function touches(a, b) {
    return Math.abs(a.lx - b.lx) < (a.def.w + b.def.w) / 2 + TOUCH_TOL &&
      Math.abs(a.ly - b.ly) < (a.def.h + b.def.h) / 2 + TOUCH_TOL;
  }
  V.touches = touches;

  /**
   * Fuel compartments: connected groups of parts, with separators acting as
   * walls. An engine can only drink from tanks inside its own compartment,
   * which is what stops an upper stage from being emptied by the boosters.
   */
  Vessel.prototype.rebuildGraph = function () {
    const ps = this.parts, n = ps.length;
    for (let i = 0; i < n; i++) ps[i].comp = -1;
    let c = 0;
    const stack = [];
    for (let i = 0; i < n; i++) {
      if (ps[i].comp >= 0 || ps[i].def.type === 'sep') continue;
      stack.length = 0; stack.push(i); ps[i].comp = c;
      while (stack.length) {
        const k = stack.pop();
        for (let j = 0; j < n; j++) {
          if (ps[j].comp >= 0 || ps[j].def.type === 'sep') continue;
          if (touches(ps[k], ps[j])) { ps[j].comp = c; stack.push(j); }
        }
      }
      c++;
    }
    for (const p of ps) if (p.def.type === 'sep') p.comp = -1;
    this.ncomp = c;
    this._dirty = false;
  };

  /** total / capacity fuel, optionally restricted to one compartment */
  Vessel.prototype.fuelIn = function (comp) {
    let cur = 0, cap = 0;
    for (const p of this.parts) {
      if (p.def.fuel <= 0) continue;
      if (comp != null && p.comp !== comp) continue;
      if (p.def.engine && p.def.engine.solid) continue;    // solids keep their own
      cur += p.def.fuel * p.fuel; cap += p.def.fuel;
    }
    return { cur, cap };
  };

  /** draw `kg` of fuel from a compartment, proportionally. Returns kg taken. */
  Vessel.prototype.drawFuel = function (comp, kg) {
    if (kg <= 0) return 0;
    const tanks = [];
    let avail = 0;
    for (const p of this.parts) {
      if (p.def.fuel <= 0 || p.fuel <= 0) continue;
      if (p.comp !== comp) continue;
      if (p.def.engine && p.def.engine.solid) continue;
      tanks.push(p); avail += p.def.fuel * p.fuel;
    }
    if (avail <= 0) return 0;
    const take = Math.min(kg, avail);
    const frac = take / avail;
    for (const p of tanks) p.fuel = Math.max(0, p.fuel - p.fuel * frac);
    return take;
  };

  /* ═══════════════════ capability queries ═══════════════════ */

  Vessel.prototype.authority = function () {
    let a = 0, best = 0;
    for (const p of this.parts) {
      if (p.def.authority) {
        if (p.def.type === 'pod') best = Math.max(best, p.def.authority);
        else a += p.def.authority;
      }
    }
    return best + a;
  };

  Vessel.prototype.hasControl = function () {
    for (const p of this.parts) if (p.def.type === 'pod') return true;
    return false;
  };

  Vessel.prototype.legCount = function () {
    let n = 0;
    for (const p of this.parts) if (p.def.type === 'leg') n++;
    return n;
  };

  /** touchdown speed the craft walks away from — a capsule under a canopy
      arrives at roughly 9 m/s, so bare hulls must survive a little more */
  Vessel.prototype.crashSpeed = function () {
    const l = this.legCount();
    return l >= 2 ? 20 : l === 1 ? 14 : 10;
  };

  /** engines that are lit right now */
  Vessel.prototype.liveEngines = function (out) {
    out = out || [];
    out.length = 0;
    for (const p of this.parts) {
      if (p.def.type !== 'engine' || !p.active) continue;
      const solid = p.def.engine.solid;
      const fuel = solid ? p.fuel > 0 : this.fuelIn(p.comp).cur > 0;
      if (fuel) out.push(p);
    }
    return out;
  };

  /** vacuum thrust available at the current throttle */
  Vessel.prototype.thrustNow = function (atmoFrac) {
    let T = 0;
    const live = this.liveEngines();
    for (const p of live) {
      const e = p.def.engine;
      const isp = e.ispVac + (e.ispSl - e.ispVac) * (atmoFrac || 0);
      const th = e.thrust * (isp / e.ispVac);
      T += th * (e.solid ? 1 : this.throttle);
    }
    return T;
  };

  /** Δv left in the stage that is burning (or about to burn) */
  Vessel.prototype.stageDv = function () {
    let comp = -1, isp = 0, n = 0;
    const scan = p => {
      if (p.def.type !== 'engine' || p.def.engine.solid) return;
      comp = p.comp; isp += p.def.engine.ispVac; n++;
    };
    for (const p of this.parts) if (p.active) scan(p);
    if (!n && this.stageIdx < this.stages.length) {
      for (const uid of this.stages[this.stageIdx]) {
        const p = this.byUid(uid);
        if (p) scan(p);
      }
    }
    if (!n) return 0;
    isp /= n;
    const f = this.fuelIn(comp).cur;
    if (f <= 0) return 0;
    return isp * U.G0 * Math.log(this.mass / Math.max(1, this.mass - f));
  };

  /** world-space corners of every part — used for terrain and scenery contact */
  Vessel.prototype.contactPoints = function (out) {
    out = out || [];
    out.length = 0;
    const ca = Math.cos(this.angle), sa = Math.sin(this.angle);
    for (const p of this.parts) {
      const w = p.def.w / 2, h = p.def.h / 2;
      const bx = p.lx - this.com.x, by = p.ly - this.com.y;
      for (let i = 0; i < 4; i++) {
        const ox = (i & 1) ? w : -w, oy = (i & 2) ? h : -h;
        const lx = bx + ox, ly = by + oy;
        out.push(this.x + lx * ca - ly * sa, this.y + lx * sa + ly * ca);
      }
    }
    return out;
  };

  /** rough bounding radius from the centre of mass */
  Vessel.prototype.radius = function () {
    if (this._radius != null && !this._dirty) return this._radius;
    let r = 1;
    for (const p of this.parts) {
      const dx = p.lx - this.com.x, dy = p.ly - this.com.y;
      r = Math.max(r, Math.hypot(dx, dy) + Math.hypot(p.def.w, p.def.h) / 2);
    }
    this._radius = r;
    return r;
  };

  /* ═══════════════════ separation ═══════════════════ */

  /**
   * Drop fired separators and break the craft into one vessel per
   * remaining connected group. Returns { vessels, junk } where `junk` are the
   * world positions of the separator rings that blew.
   */
  V.split = function (v) {
    const junk = [];
    const keep = [];
    const wp = {};
    for (const p of v.parts) {
      if (p.def.type === 'sep' && p.fired) {
        v.worldOf(p, wp);
        junk.push({ x: wp.x, y: wp.y });
      } else keep.push(p);
    }
    if (keep.length === v.parts.length) return { vessels: [v], junk };
    if (!keep.length) { v.dead = true; return { vessels: [], junk }; }

    // connected groups over what's left (separators are gone, so nothing blocks)
    const n = keep.length, grp = new Array(n).fill(-1);
    let g = 0;
    const stack = [];
    for (let i = 0; i < n; i++) {
      if (grp[i] >= 0) continue;
      stack.length = 0; stack.push(i); grp[i] = g;
      while (stack.length) {
        const k = stack.pop();
        for (let j = 0; j < n; j++) {
          if (grp[j] >= 0) continue;
          if (touches(keep[k], keep[j])) { grp[j] = g; stack.push(j); }
        }
      }
      g++;
    }

    const oldX = v.x, oldY = v.y, oldA = v.angle, om = v.omega;
    const out = [];
    for (let gi = 0; gi < g; gi++) {
      const ps = keep.filter((_, i) => grp[i] === gi);
      const live = new Set(ps.map(p => p.uid));
      const stages = v.stages.map(s => s.filter(u => live.has(u)));
      const nv = new Vessel(ps, stages.filter(s => s.length));

      // rebuild the stage cursor so the surviving craft resumes where it was
      let idx = 0;
      for (let i = 0; i < v.stages.length && i < v.stageIdx; i++) {
        if (v.stages[i].some(u => live.has(u))) idx++;
      }
      nv.stageIdx = idx;

      // place the new centre of mass exactly where those parts already were
      nv.angle = oldA;
      nv.x = oldX + U.rotX(nv.com.x - v.com.x, nv.com.y - v.com.y, oldA);
      nv.y = oldY + U.rotY(nv.com.x - v.com.x, nv.com.y - v.com.y, oldA);
      // rigid-body velocity at that offset: v + ω × r
      const rx = nv.x - oldX, ry = nv.y - oldY;
      nv.vx = v.vx - om * ry;
      nv.vy = v.vy + om * rx;
      nv.omega = om;
      nv.throttle = v.throttle;
      nv.sas = v.sas; nv.sasTarget = v.sasTarget;
      out.push(nv);
    }

    // shove the pieces apart, conserving momentum
    const total = out.reduce((s, nv) => s + nv.mass, 0);
    for (const nv of out) {
      let dx = nv.x - oldX, dy = nv.y - oldY;
      const l = Math.hypot(dx, dy);
      if (l < 1e-6) continue;
      const k = SEP_SPEED * (total - nv.mass) / total;
      nv.vx += (dx / l) * k;
      nv.vy += (dy / l) * k;
    }

    // the piece holding the best command pod stays under the player's thumb
    let bestI = 0, bestScore = -1;
    out.forEach((nv, i) => {
      let sc = 0;
      for (const p of nv.parts) if (p.def.type === 'pod') sc = Math.max(sc, p.def.authority * 100);
      sc += nv.mass * 1e-6;
      if (sc > bestScore) { bestScore = sc; bestI = i; }
    });
    out.forEach((nv, i) => { nv.debris = i !== bestI; });

    return { vessels: out, primary: out[bestI], junk };
  };

})(window.SFS);
