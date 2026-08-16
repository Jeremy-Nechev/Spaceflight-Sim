/* ============================================================
   builder.js — the vehicle assembly hangar
   ------------------------------------------------------------
   Blueprint space: +y up, origin at the pad surface (y = 0).
   ============================================================ */
(function (S) {
  'use strict';

  const U = S.util;
  const P = S.PARTS;
  const B = S.builder = {};

  const GRID = 0.25;

  B.parts = [];
  B.stages = [];
  B.mirror = true;
  B.held = null;          // { def, flip, uid? }  — following the pointer
  B.sel = null;           // selected placed part
  B.chip = null;          // uid picked up inside the staging editor
  B.cat = 'Command';
  B.name = 'New Rocket';

  const cam = B.cam = { x: 0, y: 8, zoom: 13 };
  let undoStack = [];
  let pointer = { x: 0, y: 0, sx: 0, sy: 0, down: false, drag: false, panX: 0, panY: 0 };
  let cw = 0, ch = 0;

  /* ═══════════════════ blueprint helpers ═══════════════════ */

  function snapshot() {
    return JSON.stringify({ p: B.parts.map(p => ({ uid: p.uid, id: p.id, x: p.lx, y: p.ly, f: p.flip })), s: B.stages });
  }

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 50) undoStack.shift();
  }

  B.undo = function () {
    const s = undoStack.pop();
    if (!s) return;
    restore(JSON.parse(s));
    B.changed();
  };

  function restore(o) {
    B.parts = o.p.map(q => ({ uid: q.uid, id: q.id, def: P[q.id], lx: q.x, ly: q.y, flip: q.f })).filter(p => p.def);
    B.stages = (o.s || []).map(g => g.slice());
    B.parts.forEach(p => S.vessel.seedUid(p.uid));
    B.sel = null; B.chip = null;
  }

  B.blueprint = function () {
    return {
      name: B.name,
      parts: B.parts.map(p => ({ uid: p.uid, id: p.id, x: p.lx, y: p.ly, flip: p.flip })),
      stages: B.stages.map(g => g.slice())
    };
  };

  B.load = function (bp) {
    undoStack = [];
    B.name = bp.name || 'Rocket';
    restore({
      p: (bp.parts || []).map(q => ({ uid: q.uid || S.vessel.nextUid(), id: q.id, x: q.x, y: q.y, f: q.flip || 1 })),
      s: bp.stages || []
    });
    if (!B.stages.length) B.autoStage();
    B.changed();
    B.fit();
  };

  /* ═══════════════════ stage groups ═══════════════════ */

  function stageable(p) { return S.vessel.isStageable(p.def); }

  B.autoStage = function () {
    B.stages = S.vessel.autoStages(B.parts);
  };

  /** every stageable part that isn't in a group yet */
  B.unassigned = function () {
    const used = new Set();
    B.stages.forEach(g => g.forEach(u => used.add(u)));
    return B.parts.filter(p => stageable(p) && !used.has(p.uid)).map(p => p.uid);
  };

  B.moveToStage = function (uid, idx) {
    pushUndo();
    B.stages.forEach(g => {
      const i = g.indexOf(uid);
      if (i >= 0) g.splice(i, 1);
    });
    if (idx >= 0 && idx < B.stages.length) B.stages[idx].push(uid);
    B.stages = B.stages.filter(g => g.length);
    B.changed();
  };

  B.addStage = function () { pushUndo(); B.stages.push([]); B.changed(); };

  B.moveStage = function (i, dir) {
    const j = i + dir;
    if (j < 0 || j >= B.stages.length) return;
    pushUndo();
    const t = B.stages[i]; B.stages[i] = B.stages[j]; B.stages[j] = t;
    B.changed();
  };

  B.delStage = function (i) {
    pushUndo();
    B.stages.splice(i, 1);
    B.changed();
  };

  /** keep the groups honest after parts are added or removed */
  function syncStages() {
    const live = new Set(B.parts.filter(stageable).map(p => p.uid));
    B.stages = B.stages.map(g => g.filter(u => live.has(u))).filter(g => g.length);
  }

  /* ═══════════════════ editing ═══════════════════ */

  function snapFor(def, mx, my, exclude) {
    let bx = Math.round(mx / GRID) * GRID;
    let by = Math.round(my / GRID) * GRID;
    let bflip = 1, best = Infinity;
    const thr = Math.max(1.3, Math.max(def.w, def.h) * 0.55);
    for (const p of B.parts) {
      if (p === exclude) continue;
      const cands = [
        { x: p.lx, y: p.ly + p.def.h / 2 + def.h / 2, f: 1 },
        { x: p.lx, y: p.ly - p.def.h / 2 - def.h / 2, f: 1 }
      ];
      if (def.radial) {
        const yy = Math.round(my / GRID) * GRID;
        cands.push({ x: p.lx + p.def.w / 2 + def.w / 2, y: yy, f: 1 });
        cands.push({ x: p.lx - p.def.w / 2 - def.w / 2, y: yy, f: -1 });
      }
      for (const c of cands) {
        const d = Math.hypot(c.x - mx, c.y - my);
        if (d < thr && d < best) { best = d; bx = c.x; by = c.y; bflip = c.f; }
      }
    }
    return { x: bx, y: by, flip: bflip };
  }

  function partAt(x, y) {
    for (let i = B.parts.length - 1; i >= 0; i--) {
      const p = B.parts[i];
      if (Math.abs(x - p.lx) <= p.def.w / 2 && Math.abs(y - p.ly) <= p.def.h / 2) return p;
    }
    return null;
  }

  function place(def, x, y, flip, uid) {
    const p = { uid: uid || S.vessel.nextUid(), id: def.id, def, lx: x, ly: y, flip: flip || 1 };
    B.parts.push(p);
    return p;
  }

  B.placeHeld = function (x, y) {
    const h = B.held;
    if (!h) return;
    pushUndo();
    const sn = snapFor(h.def, x, y, null);
    const main = place(h.def, sn.x, sn.y, sn.flip, h.uid);
    if (B.mirror && h.def.radial && Math.abs(sn.x) > 0.15) {
      place(h.def, -sn.x, sn.y, -sn.flip);
    }
    // new stageable parts join a sensible group automatically
    if (stageable(main)) autoAssign(main);
    B.held = null;
    B.changed();
  };

  /** slot a freshly placed part into the group nearest its height */
  function autoAssign(p) {
    syncStages();
    if (!B.stages.length) { B.autoStage(); return; }
    const y = p.ly - p.def.h / 2;
    let best = -1, bestD = Infinity;
    B.stages.forEach((g, i) => {
      for (const u of g) {
        const q = B.parts.find(z => z.uid === u);
        if (!q) continue;
        const d = Math.abs((q.ly - q.def.h / 2) - y);
        if (d < bestD) { bestD = d; best = i; }
      }
    });
    if (best >= 0 && bestD < S.vessel.STAGE_TOL) B.stages[best].push(p.uid);
    else B.autoStage();
  }

  B.remove = function (p) {
    pushUndo();
    const i = B.parts.indexOf(p);
    if (i >= 0) B.parts.splice(i, 1);
    if (B.sel === p) B.sel = null;
    B.changed();
  };

  B.clear = function () {
    pushUndo();
    B.parts = []; B.stages = []; B.sel = null; B.held = null;
    B.changed();
  };

  /* ═══════════════════ stats ═══════════════════ */

  function estimateDv(bp) {
    let v = S.vessel.fromBlueprint(bp);
    if (!v) return { dv: 0, twr: 0 };
    let dv = 0, guard = 0, twr = 0;
    const m0 = v.mass;

    while (v && v.stageIdx < v.stages.length && guard++ < 60) {
      const sep = v.fireStage();
      const live = v.parts.filter(p => p.def.type === 'engine' && p.active);
      if (live.length) {
        if (!twr) {
          let T = 0;
          for (const p of live) {
            const e = p.def.engine;
            T += e.thrust * (e.ispSl / e.ispVac);
          }
          twr = T / (m0 * 9.8);
        }
        const groups = {};
        for (const p of live) {
          const k = p.def.engine.solid ? 's' + p.uid : 'c' + p.comp;
          (groups[k] = groups[k] || []).push(p);
        }
        for (const k in groups) {
          const g = groups[k];
          let isp = 0;
          for (const p of g) isp += p.def.engine.ispVac;
          isp /= g.length;
          const solid = g[0].def.engine.solid;
          const fuel = solid
            ? g.reduce((s, p) => s + p.def.fuel * p.fuel, 0)
            : v.fuelIn(g[0].comp).cur;
          if (fuel > 1) {
            dv += isp * U.G0 * Math.log(v.mass / Math.max(1, v.mass - fuel));
            if (solid) g.forEach(p => { p.fuel = 0; });
            else v.drawFuel(g[0].comp, fuel);
            v.updateMass();
          }
          g.forEach(p => { p.active = false; });
        }
      }
      if (sep) {
        const r = S.vessel.split(v);
        v = r.primary || r.vessels[0];
      }
    }
    return { dv, twr };
  }

  B.stats = function () {
    let mass = 0, fuel = 0, lo = 0, hi = 0, pods = 0, engines = 0;
    for (const p of B.parts) {
      mass += p.def.mass + p.def.fuel;
      fuel += p.def.fuel;
      lo = Math.min(lo, p.ly - p.def.h / 2);
      hi = Math.max(hi, p.ly + p.def.h / 2);
      if (p.def.type === 'pod') pods++;
      if (p.def.type === 'engine') engines++;
    }
    const est = B.parts.length ? estimateDv(B.blueprint()) : { dv: 0, twr: 0 };
    return {
      mass, fuel, height: B.parts.length ? hi - lo : 0,
      count: B.parts.length, pods, engines,
      dv: est.dv, twr: est.twr,
      stages: B.stages.length
    };
  };

  /* ═══════════════════ camera / view ═══════════════════ */

  /** main.js hands us the canvas size so fit() works before the first draw */
  B.setSize = function (w, h) { cw = w; ch = h; };

  B.fit = function () {
    if (!B.parts.length) { cam.x = 0; cam.y = 8; cam.zoom = 13; return; }
    let lo = Infinity, hi = -Infinity, l = Infinity, r = -Infinity;
    for (const p of B.parts) {
      lo = Math.min(lo, p.ly - p.def.h / 2); hi = Math.max(hi, p.ly + p.def.h / 2);
      l = Math.min(l, p.lx - p.def.w / 2); r = Math.max(r, p.lx + p.def.w / 2);
    }
    cam.x = (l + r) / 2;
    cam.y = (lo + hi) / 2;
    const availW = Math.max(200, cw - 440), availH = Math.max(200, ch - 130);
    cam.zoom = U.clamp(Math.min(availW / (r - l + 8), availH / (hi - lo + 8)), 1.2, 26);
  };

  function toWorld(sx, sy) {
    return { x: (sx - cw / 2) / cam.zoom + cam.x, y: cam.y - (sy - ch / 2) / cam.zoom };
  }

  /* ═══════════════════ pointer ═══════════════════ */

  B.pointerDown = function (sx, sy, button) {
    const w = toWorld(sx, sy);
    pointer.down = true; pointer.drag = false;
    pointer.sx = sx; pointer.sy = sy;
    pointer.panX = cam.x; pointer.panY = cam.y;

    if (button === 2) {
      const p = partAt(w.x, w.y);
      if (p) B.remove(p);
      return;
    }
    if (B.held) { B.placeHeld(w.x, w.y); return; }

    const p = partAt(w.x, w.y);
    if (p) {
      B.sel = p;
      pointer.grab = p;
      pointer.grabDX = w.x - p.lx;
      pointer.grabDY = w.y - p.ly;
    } else {
      B.sel = null;
      pointer.grab = null;
    }
  };

  B.pointerMove = function (sx, sy) {
    const w = toWorld(sx, sy);
    pointer.x = w.x; pointer.y = w.y;
    if (!pointer.down) return;
    const dx = sx - pointer.sx, dy = sy - pointer.sy;
    if (!pointer.drag && Math.hypot(dx, dy) > 4) pointer.drag = true;
    if (!pointer.drag) return;

    if (pointer.grab) {
      if (!pointer.moved) { pushUndo(); pointer.moved = true; }
      const sn = snapFor(pointer.grab.def, w.x - pointer.grabDX, w.y - pointer.grabDY, pointer.grab);
      pointer.grab.lx = sn.x;
      pointer.grab.ly = sn.y;
      if (pointer.grab.def.radial) pointer.grab.flip = sn.flip;
    } else {
      cam.x = pointer.panX - dx / cam.zoom;
      cam.y = pointer.panY + dy / cam.zoom;
    }
  };

  B.pointerUp = function () {
    if (pointer.moved) B.changed();
    pointer.down = false; pointer.grab = null; pointer.moved = false;
  };

  B.wheel = function (d) {
    cam.zoom = U.clamp(cam.zoom * (d < 0 ? 1.12 : 1 / 1.12), 1.2, 40);
  };

  /* ═══════════════════ drawing ═══════════════════ */

  B.draw = function (ctx, W_, H_, dpr) {
    cw = W_; ch = H_;
    const z = cam.zoom;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, '#0a1020');
    g.addColorStop(1, '#141c2e');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);

    ctx.setTransform(z * dpr, 0, 0, -z * dpr,
      (cw / 2 - cam.x * z) * dpr, (ch / 2 + cam.y * z) * dpr);

    drawGrid(ctx);

    // ground line
    ctx.strokeStyle = 'rgba(150,180,220,.4)';
    ctx.lineWidth = 0.1;
    const half = cw / (2 * z) + Math.abs(cam.x) + 10;
    ctx.beginPath();
    ctx.moveTo(cam.x - half, 0); ctx.lineTo(cam.x + half, 0);
    ctx.stroke();
    ctx.fillStyle = 'rgba(80,110,150,.16)';
    ctx.fillRect(cam.x - half, -ch / z, half * 2, ch / z);

    // symmetry axis
    if (B.mirror) {
      ctx.strokeStyle = 'rgba(120,190,255,.22)';
      ctx.lineWidth = 0.05;
      ctx.setLineDash([0.5, 0.5]);
      ctx.beginPath();
      ctx.moveTo(0, -2); ctx.lineTo(0, cam.y + ch / (2 * z));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // placed parts
    for (const p of B.parts) {
      ctx.save();
      ctx.translate(p.lx, p.ly);
      if (p.flip < 0) ctx.scale(-1, 1);
      p.def.draw(ctx, { fuel: 1, throttle: 0, deployed: true, chute: 0 }, p.def);
      ctx.restore();
    }

    // stage badges
    if (z > 4) drawBadges(ctx, z);

    // selection
    if (B.sel) {
      ctx.strokeStyle = '#4da3ff';
      ctx.lineWidth = 0.08;
      ctx.setLineDash([0.35, 0.25]);
      ctx.strokeRect(B.sel.lx - B.sel.def.w / 2 - 0.12, B.sel.ly - B.sel.def.h / 2 - 0.12,
        B.sel.def.w + 0.24, B.sel.def.h + 0.24);
      ctx.setLineDash([]);
    }

    // ghost of whatever we're holding
    if (B.held) {
      const sn = snapFor(B.held.def, pointer.x, pointer.y, null);
      ctx.globalAlpha = 0.62;
      ctx.save();
      ctx.translate(sn.x, sn.y);
      if (sn.flip < 0) ctx.scale(-1, 1);
      B.held.def.draw(ctx, { fuel: 1, throttle: 0, deployed: true, chute: 0 }, B.held.def);
      ctx.restore();
      if (B.mirror && B.held.def.radial && Math.abs(sn.x) > 0.15) {
        ctx.save();
        ctx.translate(-sn.x, sn.y);
        if (-sn.flip < 0) ctx.scale(-1, 1);
        B.held.def.draw(ctx, { fuel: 1, throttle: 0, deployed: true, chute: 0 }, B.held.def);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = '#7cc0ff';
      ctx.lineWidth = 0.06;
      ctx.strokeRect(sn.x - B.held.def.w / 2, sn.y - B.held.def.h / 2, B.held.def.w, B.held.def.h);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  function drawGrid(ctx) {
    const z = cam.zoom;
    const hw = cw / (2 * z), hh = ch / (2 * z);
    const x0 = Math.floor((cam.x - hw)), x1 = Math.ceil((cam.x + hw));
    const y0 = Math.floor((cam.y - hh)), y1 = Math.ceil((cam.y + hh));
    if (x1 - x0 > 400) return;
    ctx.lineWidth = 0.02;
    ctx.strokeStyle = 'rgba(120,160,220,.08)';
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = y0; y <= y1; y++) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
    ctx.lineWidth = 0.035;
    ctx.strokeStyle = 'rgba(120,160,220,.16)';
    ctx.beginPath();
    for (let x = Math.ceil(x0 / 5) * 5; x <= x1; x += 5) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
    for (let y = Math.ceil(y0 / 5) * 5; y <= y1; y += 5) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke();
  }

  function drawBadges(ctx, z) {
    const idx = new Map();
    B.stages.forEach((g, i) => g.forEach(u => idx.set(u, i + 1)));
    ctx.save();
    ctx.scale(1, -1);                       // text must not be mirrored
    for (const p of B.parts) {
      if (!stageable(p)) continue;
      const n = idx.get(p.uid);
      const x = p.lx + p.def.w / 2 - 0.28;
      const y = -(p.ly + p.def.h / 2 - 0.28);
      ctx.beginPath();
      ctx.arc(x, y, 0.34, 0, U.TAU);
      ctx.fillStyle = n ? 'rgba(30,80,150,.92)' : 'rgba(140,50,50,.92)';
      ctx.fill();
      ctx.lineWidth = 0.045;
      ctx.strokeStyle = n ? '#7cc0ff' : '#ff8a8a';
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '600 0.44px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n ? String(n) : '!', x, y + 0.02);
    }
    ctx.restore();
    void z;
  }

  /* ═══════════════════ change hook ═══════════════════ */

  B.onChange = null;
  B.changed = function () {
    syncStages();
    if (B.onChange) B.onChange();
  };

  /* ═══════════════════ stock rockets ═══════════════════ */

  function stack(list, x) {
    let y = 0;
    const out = [];
    for (const id of list) {
      const d = P[id];
      out.push({ id, x: x || 0, y: y + d.h / 2 });
      y += d.h;
    }
    return out;
  }

  B.presets = function () {
    const A = stack(['eng_m', 'tank_m2', 'pod_s', 'chute']);
    A.push({ id: 'fin_s', x: 1.75, y: 3.2, flip: 1 }, { id: 'fin_s', x: -1.75, y: 3.2, flip: -1 });

    const Bp = stack(['eng_l', 'tank_l2', 'sep_l', 'eng_m', 'tank_m2', 'pod_m', 'chute_l']);
    Bp.push(
      { id: 'srb', x: 3.3, y: 4.5, flip: 1 }, { id: 'srb', x: -3.3, y: 4.5, flip: -1 },
      { id: 'sep_side', x: 2.15, y: 6.0, flip: 1 }, { id: 'sep_side', x: -2.15, y: 6.0, flip: -1 },
      { id: 'fin_l', x: 5.55, y: 1.5, flip: 1 }, { id: 'fin_l', x: -5.55, y: 1.5, flip: -1 }
    );

    const C = stack(['eng_l', 'tank_l2', 'sep_l', 'eng_vac', 'tank_m2', 'sep_m',
      'eng_s', 'tank_s2', 'pod_s', 'chute']);
    // legs hug the lander's own tank (24.6 → 28.6 m), not the capsule above it
    C.push(
      { id: 'fin_l', x: 3.25, y: 2.0, flip: 1 }, { id: 'fin_l', x: -3.25, y: 2.0, flip: -1 },
      { id: 'leg', x: 1.1, y: 25.6, flip: 1 }, { id: 'leg', x: -1.1, y: 25.6, flip: -1 }
    );

    return [
      { name: 'Kestrel', parts: A, stages: null, tip: 'Single stage. Easily reaches orbit.' },
      { name: 'Atlas II', parts: Bp, stages: null, tip: 'Solid boosters + two liquid stages.' },
      { name: 'Luna I', parts: C, stages: null, tip: 'Three stages and landing legs. Moon capable.' }
    ];
  };

  /* ═══════════════════ blueprint storage ═══════════════════ */

  B.saved = function () { return U.store.get('blueprints', []); };

  B.saveAs = function (name) {
    const list = B.saved();
    const bp = B.blueprint();
    bp.name = name;
    const i = list.findIndex(b => b.name === name);
    if (i >= 0) list[i] = bp; else list.push(bp);
    U.store.set('blueprints', list);
    B.name = name;
  };

  B.deleteSaved = function (name) {
    U.store.set('blueprints', B.saved().filter(b => b.name !== name));
  };

})(window.SFS);
