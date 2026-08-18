/* ============================================================
   parts.js — rocket part catalogue + part artwork
   ------------------------------------------------------------
   Part local space: origin at the part centre,
                     +y points toward the nose, +x to the right.
   All sizes in metres, masses in kg, thrust in newtons.
   ============================================================ */
(function (S) {
  'use strict';

  const U = S.util;
  const PARTS = S.PARTS = {};
  const ORDER = S.PART_ORDER = [];
  const CATS = S.PART_CATS = ['Command', 'Tanks', 'Engines', 'Aero', 'Struct'];

  /**
   * How much friction heating a part shrugs off before it burns away, in the
   * same units as the accumulated `temp` physics.js tracks. Roughly: 1.0 ≈
   * survives a normal return from low orbit facing the airflow head-on. A pod
   * has a bit of built-in shielding (it's drawn with one); an ablative heat
   * shield takes many times as much and protects whatever hides behind it.
   */
  const HEAT_TOL = {
    pod: 1.3, shield: 9, nose: 1.15, tank: 1.0, engine: 1.15, adapter: 1.0,
    fin: 0.85, chute: 0.8, leg: 0.85, sep: 0.9, coupler: 0.95, rcs: 0.8
  };

  function add(d) {
    d.radial = !!d.radial;
    d.mass = d.mass || 0;
    d.fuel = d.fuel || 0;
    d.cd = d.cd == null ? 1.1 : d.cd;
    d.heatTol = d.heatTol == null ? (HEAT_TOL[d.type] || 1) : d.heatTol;
    PARTS[d.id] = d;
    ORDER.push(d.id);
  }

  /* ─────────────────── artwork helpers ─────────────────── */

  const SHELL_L = '#f4f7fb', SHELL_M = '#ccd5e1', SHELL_D = '#7b8595';
  /* Paint for fuel tanks. Three finishes, because these are the three every
     real launcher has worn: bare white insulation, unpainted metal, and sprayed
     foam. Chosen in the hangar per tank (see B.setColor) and carried through
     blueprints and save games on the part itself. */
  const TANK_COLS = S.TANK_COLS = {
    white: { name: 'White', l: '#f4f7fb', m: '#ccd5e1', d: '#7b8595', chip: '#e8eef7' },
    gray: { name: 'Gray', l: '#ccd1d8', m: '#9ba2ad', d: '#5b626d', chip: '#a9b0ba' },
    orange: { name: 'Orange', l: '#e9a862', m: '#c8752e', d: '#7c4319', chip: '#d4832f' }
  };
  S.TANK_COL_KEYS = ['white', 'gray', 'orange'];
  function tankPaint(st) { return TANK_COLS[(st && st.col) || 'white'] || TANK_COLS.white; }
  const METAL_L = '#a8b0bb', METAL_M = '#767e8a', METAL_D = '#41474f';
  const DARK = '#2b3038';
  const ACCENT = '#e2673a';

  /** cylindrical shading across the part width */
  function cyl(ctx, w, l, m, d) {
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0.00, d);
    g.addColorStop(0.16, m);
    g.addColorStop(0.38, l);
    g.addColorStop(0.62, m);
    g.addColorStop(1.00, d);
    return g;
  }

  function ink(ctx, w) {
    ctx.lineWidth = Math.max(0.035, w * 0.022);
    ctx.strokeStyle = 'rgba(20,26,34,.85)';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  /** thin vertical fuel gauge drawn on a tank face */
  function gauge(ctx, w, h, frac, colA, colB) {
    const gw = Math.min(w * 0.2, 0.5), gh = h - 0.55;
    if (gh <= 0.2) return;
    const x = -gw / 2, y = -gh / 2;
    ctx.fillStyle = 'rgba(18,22,30,.72)';
    U.roundRect(ctx, x, y, gw, gh, gw * 0.35); ctx.fill();
    const f = U.clamp(frac, 0, 1);
    if (f > 0.004) {
      const g = ctx.createLinearGradient(0, y, 0, y + gh);
      g.addColorStop(0, colB); g.addColorStop(1, colA);
      ctx.fillStyle = g;
      U.roundRect(ctx, x + gw * 0.16, y + gw * 0.16, gw * 0.68, (gh - gw * 0.32) * f, gw * 0.2);
      ctx.fill();
    }
  }

  /** horizontal reinforcement band */
  function band(ctx, w, y, t) {
    ctx.fillStyle = 'rgba(52,60,72,.9)';
    ctx.fillRect(-w / 2, y - t / 2, w, t);
    ctx.fillStyle = 'rgba(255,255,255,.14)';
    ctx.fillRect(-w / 2, y + t / 2 - t * 0.28, w, t * 0.28);
  }

  /* ─────────────────── shared draw routines ─────────────────── */

  function drawTank(ctx, st, d) {
    const w = d.w, h = d.h, c = tankPaint(st);
    ctx.fillStyle = cyl(ctx, w, c.l, c.m, c.d);
    ctx.fillRect(-w / 2, -h / 2, w, h);
    // subtle weld seams every ~2 m
    ctx.fillStyle = 'rgba(90,100,116,.28)';
    for (let y = -h / 2 + 2; y < h / 2 - 0.2; y += 2) ctx.fillRect(-w / 2, y - 0.03, w, 0.06);
    gauge(ctx, w, h, st ? st.fuel : 1, '#c9541f', '#ffb457');
    band(ctx, w, h / 2 - 0.11, 0.22);
    band(ctx, w, -h / 2 + 0.11, 0.22);
    ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ink(ctx, w);
  }

  /** tank that narrows toward the top so a smaller stack sits flush on it */
  function drawTaperTank(ctx, st, d) {
    const w = d.w, h = d.h, tw = d.topW, c = tankPaint(st);
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(-tw / 2, h / 2);
    ctx.lineTo(tw / 2, h / 2);
    ctx.lineTo(w / 2, -h / 2);
    ctx.closePath();
    ctx.fillStyle = cyl(ctx, w, c.l, c.m, c.d);
    ctx.fill();
    ink(ctx, w);
    // seams follow the taper
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(-tw / 2, h / 2);
    ctx.lineTo(tw / 2, h / 2); ctx.lineTo(w / 2, -h / 2);
    ctx.closePath(); ctx.clip();
    ctx.fillStyle = 'rgba(90,100,116,.28)';
    for (let y = -h / 2 + 1.6; y < h / 2 - 0.2; y += 1.6) ctx.fillRect(-w / 2, y - 0.03, w, 0.06);
    ctx.restore();
    gauge(ctx, tw, h, st ? st.fuel : 1, '#c9541f', '#ffb457');
    band(ctx, w, -h / 2 + 0.11, 0.22);
    band(ctx, tw, h / 2 - 0.11, 0.22);
  }

  function drawEngine(ctx, st, d) {
    const w = d.w, h = d.h;
    const topW = w * 0.62, botW = w * 0.99, throatY = h / 2 - h * 0.34;
    // mounting plate
    ctx.fillStyle = cyl(ctx, w, METAL_L, METAL_M, METAL_D);
    ctx.fillRect(-w / 2 * 0.86, h / 2 - h * 0.16, w * 0.86, h * 0.16);
    // turbo block
    ctx.fillStyle = cyl(ctx, topW, METAL_L, METAL_M, METAL_D);
    ctx.fillRect(-topW / 2, throatY, topW, h / 2 - h * 0.16 - throatY);
    // bell
    ctx.beginPath();
    ctx.moveTo(-topW * 0.42, throatY);
    ctx.bezierCurveTo(-topW * 0.5, throatY - h * 0.18, -botW / 2, -h / 2 + h * 0.16, -botW / 2, -h / 2);
    ctx.lineTo(botW / 2, -h / 2);
    ctx.bezierCurveTo(botW / 2, -h / 2 + h * 0.16, topW * 0.5, throatY - h * 0.18, topW * 0.42, throatY);
    ctx.closePath();
    ctx.fillStyle = cyl(ctx, botW, '#9aa2ad', '#666e79', '#31363e');
    ctx.fill(); ink(ctx, w);
    // nozzle mouth
    ctx.beginPath();
    ctx.ellipse(0, -h / 2, botW / 2, Math.min(0.28, h * 0.09), 0, 0, U.TAU);
    ctx.fillStyle = DARK; ctx.fill();
    // hot glow when running
    if (st && st.throttle > 0.02) {
      ctx.fillStyle = 'rgba(255,150,60,' + (0.28 * st.throttle).toFixed(3) + ')';
      ctx.fill();
    }
    // plumbing
    ctx.strokeStyle = 'rgba(40,46,56,.7)'; ctx.lineWidth = w * 0.05;
    ctx.beginPath();
    ctx.moveTo(-topW * 0.34, h / 2 - h * 0.16); ctx.lineTo(-topW * 0.34, throatY);
    ctx.moveTo(topW * 0.34, h / 2 - h * 0.16); ctx.lineTo(topW * 0.34, throatY);
    ctx.stroke();
  }

  function drawCone(ctx, st, d) {
    const w = d.w, h = d.h;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.quadraticCurveTo(-w / 2, h * 0.24, 0, h / 2);
    ctx.quadraticCurveTo(w / 2, h * 0.24, w / 2, -h / 2);
    ctx.closePath();
    ctx.fillStyle = cyl(ctx, w, SHELL_L, SHELL_M, SHELL_D);
    ctx.fill(); ink(ctx, w);
    // painted tip
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.quadraticCurveTo(-w / 2, h * 0.24, 0, h / 2);
    ctx.quadraticCurveTo(w / 2, h * 0.24, w / 2, -h / 2);
    ctx.closePath(); ctx.clip();
    ctx.fillStyle = ACCENT;
    ctx.fillRect(-w / 2, h / 2 - h * 0.34, w, h * 0.34);
    ctx.restore();
    band(ctx, w, -h / 2 + 0.1, 0.2);
  }

  function drawPod(ctx, st, d) {
    const w = d.w, h = d.h, tw = w * 0.52;
    // The capsule tapers up to a flat deck rather than a dome: that deck is
    // what a parachute clamps onto, and it is the top face parts snap to.
    const neck = h * 0.12;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(-tw / 2, h / 2 - neck);
    ctx.lineTo(-tw / 2, h / 2);
    ctx.lineTo(tw / 2, h / 2);
    ctx.lineTo(tw / 2, h / 2 - neck);
    ctx.lineTo(w / 2, -h / 2);
    ctx.closePath();
    ctx.fillStyle = cyl(ctx, w, SHELL_L, SHELL_M, SHELL_D);
    ctx.fill(); ink(ctx, w);
    // the deck plate itself, a little proud of the neck, with clamp lugs
    const dw = tw * 1.22;
    ctx.fillStyle = 'rgba(96,106,122,.95)';
    ctx.fillRect(-dw / 2, h / 2 - h * 0.045, dw, h * 0.045);
    ctx.fillStyle = 'rgba(255,255,255,.16)';
    ctx.fillRect(-dw / 2, h / 2 - h * 0.012, dw, h * 0.012);
    ctx.fillStyle = 'rgba(60,68,80,.9)';
    ctx.fillRect(-dw / 2, h / 2 - h * 0.085, dw * 0.1, h * 0.04);
    ctx.fillRect(dw / 2 - dw * 0.1, h / 2 - h * 0.085, dw * 0.1, h * 0.04);
    // heat shield
    ctx.fillStyle = '#3b4048';
    ctx.fillRect(-w / 2, -h / 2, w, h * 0.11);
    // window
    ctx.beginPath();
    ctx.ellipse(0, h * 0.04, w * 0.19, h * 0.13, 0, 0, U.TAU);
    ctx.fillStyle = '#1a2f4a'; ctx.fill();
    ctx.strokeStyle = 'rgba(230,238,248,.75)'; ctx.lineWidth = w * 0.035; ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(-w * 0.06, h * 0.08, w * 0.06, h * 0.05, 0, 0, U.TAU);
    ctx.fillStyle = 'rgba(160,205,255,.55)'; ctx.fill();
  }

  function drawProbe(ctx, st, d) {
    const w = d.w, h = d.h;
    ctx.fillStyle = cyl(ctx, w, METAL_L, METAL_M, METAL_D);
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ink(ctx, w);
    ctx.fillStyle = '#2a6fb0';
    ctx.fillRect(-w * 0.3, -h * 0.16, w * 0.6, h * 0.32);
    ctx.strokeStyle = 'rgba(220,235,255,.8)'; ctx.lineWidth = w * 0.05;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(0, h / 2 + h * 0.7); ctx.stroke();
  }

  function drawSep(ctx, st, d) {
    const w = d.w, h = d.h;
    ctx.fillStyle = cyl(ctx, w, '#8b8f96', '#5d626a', '#33373d');
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = 'rgba(226,103,58,.85)';
    const n = Math.max(3, Math.round(w * 3));
    for (let i = 0; i < n; i++) {
      const x = -w / 2 + (i + 0.5) * (w / n);
      ctx.fillRect(x - w / n * 0.24, -h * 0.18, w / n * 0.48, h * 0.36);
    }
    ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ink(ctx, w);
  }

  /**
   * An interstage shroud, drawn in the craft's own coordinates about the
   * shroud's centre (see V.shroudsFor). Straight-sided where it butts up
   * against the stage above; closed over with a cone where there is nothing
   * above it to butt against.
   */
  S.drawShroud = function (ctx, sh) {
    const w = sh.w, h = sh.h;
    const tw = sh.nose ? w : Math.min(sh.topW == null ? w : sh.topW, w);
    // short straight collars top and bottom, so the taper starts and ends on a
    // real joint rather than at a knife edge
    const lip = Math.min(0.2, h * 0.25);
    const cone = sh.nose ? Math.min(w * 0.62, h * 0.55) : 0;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(-w / 2, -h / 2 + lip);
    if (cone > 0) {
      ctx.lineTo(-w * 0.34, h / 2 - cone);
      ctx.quadraticCurveTo(-w * 0.3, h / 2 - cone * 0.18, 0, h / 2);
      ctx.quadraticCurveTo(w * 0.3, h / 2 - cone * 0.18, w * 0.34, h / 2 - cone);
    } else {
      ctx.lineTo(-tw / 2, h / 2 - lip);
      ctx.lineTo(-tw / 2, h / 2);
      ctx.lineTo(tw / 2, h / 2);
      ctx.lineTo(tw / 2, h / 2 - lip);
    }
    ctx.lineTo(w / 2, -h / 2 + lip);
    ctx.lineTo(w / 2, -h / 2);
    ctx.closePath();
    ctx.fillStyle = cyl(ctx, w, SHELL_L, SHELL_M, SHELL_D);
    ctx.fill();
    ink(ctx, w);
    // the split line the two halves come apart along, and a band at each joint
    ctx.strokeStyle = 'rgba(70,80,96,.5)';
    ctx.lineWidth = Math.max(0.03, w * 0.016);
    ctx.beginPath();
    ctx.moveTo(0, -h / 2 + 0.05); ctx.lineTo(0, h / 2 - 0.05);
    ctx.stroke();
    band(ctx, w, -h / 2 + lip / 2, Math.min(0.2, lip));
    if (!sh.nose) band(ctx, tw, h / 2 - lip / 2, Math.min(0.2, lip));
  };

  function drawAdapter(ctx, st, d) {
    const w = d.w, h = d.h, tw = d.topW;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2); ctx.lineTo(-tw / 2, h / 2);
    ctx.lineTo(tw / 2, h / 2); ctx.lineTo(w / 2, -h / 2);
    ctx.closePath();
    ctx.fillStyle = cyl(ctx, w, SHELL_L, SHELL_M, SHELL_D);
    ctx.fill(); ink(ctx, w);
    band(ctx, w, -h / 2 + 0.1, 0.2);
  }

  function drawFin(ctx, st, d) {
    const w = d.w, h = d.h;   // root edge sits at x = -w/2
    ctx.beginPath();
    ctx.moveTo(-w / 2, h / 2);
    ctx.lineTo(w / 2, -h / 2 + h * 0.06);
    ctx.lineTo(w / 2, -h / 2 + h * 0.30);
    ctx.lineTo(-w / 2, -h / 2);
    ctx.closePath();
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, 0);
    g.addColorStop(0, SHELL_M); g.addColorStop(0.55, SHELL_L); g.addColorStop(1, '#96a0ae');
    ctx.fillStyle = g; ctx.fill(); ink(ctx, w);
    ctx.strokeStyle = 'rgba(226,103,58,.8)'; ctx.lineWidth = w * 0.06;
    ctx.beginPath(); ctx.moveTo(-w / 2 + w * 0.12, h / 2 - h * 0.14); ctx.lineTo(w / 2 - w * 0.1, -h / 2 + h * 0.24); ctx.stroke();
  }

  function drawLeg(ctx, st, d) {
    const w = d.w, h = d.h;
    const dep = st && st.deployed ? 1 : 0.18;
    ctx.strokeStyle = '#8d95a1'; ctx.lineWidth = w * 0.16; ctx.lineCap = 'round';
    // hip
    ctx.beginPath();
    ctx.moveTo(-w / 2, h / 2);
    const kx = -w / 2 + w * (0.35 + 0.6 * dep), ky = -h / 2 + h * 0.22;
    ctx.lineTo(kx, ky);
    ctx.stroke();
    // shock strut
    ctx.strokeStyle = '#5f6772'; ctx.lineWidth = w * 0.11;
    ctx.beginPath(); ctx.moveTo(-w / 2, h * 0.1); ctx.lineTo(kx * 0.85, ky + h * 0.16); ctx.stroke();
    // foot
    ctx.fillStyle = '#3d434c';
    U.roundRect(ctx, kx - w * 0.24, -h / 2, w * 0.5, h * 0.16, w * 0.06); ctx.fill();
    ctx.lineCap = 'butt';
  }

  function drawRcs(ctx, st, d) {
    const w = d.w, h = d.h;
    ctx.fillStyle = cyl(ctx, w, METAL_L, METAL_M, METAL_D);
    U.roundRect(ctx, -w / 2, -h / 2, w, h, w * 0.2); ctx.fill(); ink(ctx, w);
    ctx.fillStyle = DARK;
    ctx.beginPath(); ctx.moveTo(w * 0.1, h * 0.36); ctx.lineTo(w * 0.75, h * 0.5); ctx.lineTo(w * 0.75, h * 0.16); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(w * 0.1, -h * 0.36); ctx.lineTo(w * 0.75, -h * 0.5); ctx.lineTo(w * 0.75, -h * 0.16); ctx.closePath(); ctx.fill();
  }

  function drawChute(ctx, st, d) {
    const w = d.w, h = d.h;
    // A small can that clamps down onto the deck below it: a pair of jaws at
    // the bottom, the packed canopy above them, and a lid. Nothing about it
    // needs to match the width of what it is bolted to.
    const pw = w * 0.78;
    ctx.fillStyle = 'rgba(74,82,95,.95)';
    ctx.fillRect(-w / 2, -h / 2, w, h * 0.26);                  // the clamp
    ctx.fillStyle = 'rgba(40,46,56,.9)';
    ctx.fillRect(-w / 2, -h / 2 + h * 0.09, w, h * 0.06);
    ctx.fillStyle = cyl(ctx, pw, METAL_L, METAL_M, METAL_D);
    U.roundRect(ctx, -pw / 2, -h / 2 + h * 0.24, pw, h * 0.76, pw * 0.26);
    ctx.fill(); ink(ctx, pw);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(-pw / 2, h / 2 - h * 0.2, pw, h * 0.13);       // the lid
    if (st && st.chute > 0.001) {
      const t = st.chute;                       // 0..1 inflation
      const cw = d.chute.width * (0.25 + 0.75 * t);
      const cy = h / 2 + d.chute.riser * t;
      const ch = cw * 0.46;
      ctx.strokeStyle = 'rgba(230,238,248,.65)';
      ctx.lineWidth = Math.max(0.03, cw * 0.012);
      ctx.beginPath();
      for (let i = -2; i <= 2; i++) {
        ctx.moveTo(0, h / 2);
        ctx.lineTo(cw * 0.5 * i / 2.4, cy);
      }
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(-cw / 2, cy);
      ctx.bezierCurveTo(-cw / 2, cy + ch * 1.5, cw / 2, cy + ch * 1.5, cw / 2, cy);
      ctx.quadraticCurveTo(cw * 0.25, cy - ch * 0.18, 0, cy - ch * 0.1);
      ctx.quadraticCurveTo(-cw * 0.25, cy - ch * 0.18, -cw / 2, cy);
      ctx.closePath();
      const g = ctx.createLinearGradient(-cw / 2, 0, cw / 2, 0);
      g.addColorStop(0, '#d8552a'); g.addColorStop(0.3, '#ff9b52');
      g.addColorStop(0.55, '#f4f7fb'); g.addColorStop(0.8, '#ff9b52'); g.addColorStop(1, '#d8552a');
      ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = Math.max(0.03, cw * 0.008);
      ctx.strokeStyle = 'rgba(30,36,46,.6)'; ctx.stroke();
    }
  }

  /**
   * Ablative heat shield — a shallow dish that takes the friction heating on
   * its own face so the stack behind it doesn't. The exposed side chars and
   * then glows as it soaks up heat (see `st.temp`, kept by physics.js).
   */
  function drawShield(ctx, st, d) {
    const w = d.w, h = d.h;
    const hot = U.clamp(((st && st.temp) || 0) / 0.5, 0, 1);
    ctx.beginPath();
    ctx.moveTo(-w / 2, h / 2);
    ctx.lineTo(w / 2, h / 2);
    ctx.lineTo(w / 2, -h * 0.15);
    ctx.quadraticCurveTo(0, -h * 1.25, -w / 2, -h * 0.15);
    ctx.closePath();
    ctx.fillStyle = cyl(ctx, w, '#7a6250', '#544234', '#2e241d');
    ctx.fill();
    ink(ctx, w);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(-w / 2, h * 0.08);
    ctx.lineTo(w / 2, h * 0.08);
    ctx.lineTo(w / 2, -h * 0.15);
    ctx.quadraticCurveTo(0, -h * 1.25, -w / 2, -h * 0.15);
    ctx.closePath();
    ctx.clip();
    ctx.fillStyle = U.mix('#3a2d24', '#ff7326', hot);
    ctx.fillRect(-w / 2, -h * 1.3, w, h * 1.5);
    if (hot > 0.18) {
      ctx.fillStyle = 'rgba(255,226,160,' + (0.55 * hot).toFixed(3) + ')';
      ctx.fillRect(-w / 2, -h * 1.3, w, h * 0.62);
    }
    ctx.restore();
    band(ctx, w, h / 2 - 0.07, 0.14);
  }

  /** vertical coupler — in-line truss that rigidly joins two stacks */
  function drawVCoup(ctx, st, d) {
    const w = d.w, h = d.h, pt = h * 0.24;
    ctx.fillStyle = cyl(ctx, w, METAL_L, METAL_M, METAL_D);
    ctx.fillRect(-w / 2, h / 2 - pt, w, pt);
    ctx.fillRect(-w / 2, -h / 2, w, pt);
    ctx.strokeStyle = '#6d757f';
    ctx.lineWidth = Math.max(0.06, w * 0.07);
    ctx.beginPath();
    const n = Math.max(2, Math.round(w));
    for (let i = 0; i <= n; i++) {
      const x = -w / 2 + (w * i) / n;
      ctx.moveTo(x, -h / 2 + pt); ctx.lineTo(x, h / 2 - pt);
    }
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + (w * i) / n, x1 = x0 + w / n;
      ctx.moveTo(x0, -h / 2 + pt); ctx.lineTo(x1, h / 2 - pt);
      ctx.moveTo(x1, -h / 2 + pt); ctx.lineTo(x0, h / 2 - pt);
    }
    ctx.stroke();
    ctx.beginPath(); ctx.rect(-w / 2, h / 2 - pt, w, pt); ink(ctx, w);
    ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, pt); ink(ctx, w);
  }

  /** linear coupler — sideways truss beam bridging two parallel stacks */
  function drawLCoup(ctx, st, d) {
    const w = d.w, h = d.h, pt = w * 0.13;
    ctx.fillStyle = '#7d848e';
    ctx.fillRect(-w / 2, -h / 2, pt, h);
    ctx.fillRect(w / 2 - pt, -h / 2, pt, h);
    ctx.strokeStyle = '#69707a';
    ctx.lineWidth = Math.max(0.06, h * 0.16);
    ctx.beginPath();
    ctx.moveTo(-w / 2 + pt, h * 0.3); ctx.lineTo(w / 2 - pt, h * 0.3);
    ctx.moveTo(-w / 2 + pt, -h * 0.3); ctx.lineTo(w / 2 - pt, -h * 0.3);
    const n = Math.max(2, Math.round(w));
    for (let i = 0; i < n; i++) {
      const x0 = -w / 2 + pt + ((w - 2 * pt) * i) / n, x1 = x0 + (w - 2 * pt) / n;
      ctx.moveTo(x0, -h * 0.3); ctx.lineTo(x1, h * 0.3);
    }
    ctx.stroke();
    ctx.beginPath(); ctx.rect(-w / 2, -h / 2, pt, h); ink(ctx, h);
    ctx.beginPath(); ctx.rect(w / 2 - pt, -h / 2, pt, h); ink(ctx, h);
  }

  /** bi-coupler — one stack below splits into two side-by-side stacks above */
  function drawBiCoup(ctx, st, d) {
    const w = d.w, h = d.h, tw = w / 2, dx = w / 4;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2);
    ctx.lineTo(w / 2, -h / 2);
    ctx.lineTo(w / 2, -h / 2 + h * 0.22);
    ctx.lineTo(dx + tw / 2, h / 2);
    ctx.lineTo(dx - tw / 2, h / 2);
    ctx.lineTo(0, -h / 2 + h * 0.30);
    ctx.lineTo(-dx + tw / 2, h / 2);
    ctx.lineTo(-dx - tw / 2, h / 2);
    ctx.lineTo(-w / 2, -h / 2 + h * 0.22);
    ctx.closePath();
    ctx.fillStyle = cyl(ctx, w, SHELL_L, SHELL_M, SHELL_D);
    ctx.fill(); ink(ctx, w);
    band(ctx, w, -h / 2 + 0.1, 0.2);
  }

  function drawSrb(ctx, st, d) {
    const w = d.w, h = d.h;
    ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2 + h * 0.06);
    ctx.lineTo(-w / 2, h / 2 - w * 0.9);
    ctx.quadraticCurveTo(-w / 2, h / 2, 0, h / 2);
    ctx.quadraticCurveTo(w / 2, h / 2, w / 2, h / 2 - w * 0.9);
    ctx.lineTo(w / 2, -h / 2 + h * 0.06);
    ctx.closePath();
    ctx.fillStyle = cyl(ctx, w, '#f6f0e4', '#ddd2bc', '#8d8574');
    ctx.fill(); ink(ctx, w);
    ctx.save();
    ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip();
    ctx.fillStyle = 'rgba(200,90,40,.75)';
    ctx.fillRect(-w / 2, h / 2 - w * 1.5, w, w * 0.35);
    ctx.fillRect(-w / 2, -h / 2 + h * 0.24, w, w * 0.22);
    ctx.restore();
    gauge(ctx, w, h * 0.8, st ? st.fuel : 1, '#7a3410', '#e08a3c');
    // fixed nozzle
    ctx.beginPath();
    ctx.moveTo(-w * 0.22, -h / 2 + h * 0.06);
    ctx.lineTo(-w * 0.44, -h / 2);
    ctx.lineTo(w * 0.44, -h / 2);
    ctx.lineTo(w * 0.22, -h / 2 + h * 0.06);
    ctx.closePath();
    ctx.fillStyle = '#4a5058'; ctx.fill(); ink(ctx, w);
  }

  /* ═══════════════════ COMMAND ═══════════════════ */

  add({
    id: 'pod_s', name: 'Pod Mk1', cat: 'Command', type: 'pod',
    w: 1.0, h: 1.3, mass: 190, cd: 0.9, authority: 2.40,
    desc: 'One-seat capsule. Steering wheels + heat shield.',
    draw: drawPod
  });
  add({
    id: 'pod_m', name: 'Pod Mk2', cat: 'Command', type: 'pod',
    w: 2.0, h: 2.0, mass: 640, cd: 0.9, authority: 2.60,
    desc: 'Roomy capsule with stronger attitude control.',
    draw: drawPod
  });
  add({
    id: 'probe', name: 'Probe Core', cat: 'Command', type: 'pod',
    w: 1.0, h: 0.6, mass: 55, cd: 0.9, authority: 1.60,
    desc: 'Unmanned brain. Light, but weaker control.',
    draw: drawProbe
  });

  /* ═══════════════════ TANKS ═══════════════════ */

  add({ id: 'tank_s1', name: 'Tank S', cat: 'Tanks', type: 'tank', w: 1, h: 2, mass: 90, fuel: 700, draw: drawTank, desc: 'Small fuel tank.' });
  add({ id: 'tank_s2', name: 'Tank S Long', cat: 'Tanks', type: 'tank', w: 1, h: 4, mass: 170, fuel: 1500, draw: drawTank, desc: 'Small tank, double length.' });
  add({ id: 'tank_m1', name: 'Tank M', cat: 'Tanks', type: 'tank', w: 2, h: 3, mass: 380, fuel: 3600, draw: drawTank, desc: 'Medium fuel tank.' });
  add({ id: 'tank_m2', name: 'Tank M Long', cat: 'Tanks', type: 'tank', w: 2, h: 6, mass: 700, fuel: 7600, draw: drawTank, desc: 'Medium tank, double length.' });
  add({ id: 'tank_l1', name: 'Tank L', cat: 'Tanks', type: 'tank', w: 4, h: 6, mass: 1500, fuel: 22000, draw: drawTank, desc: 'Large core tank.' });
  add({ id: 'tank_l2', name: 'Tank L Long', cat: 'Tanks', type: 'tank', w: 4, h: 10, mass: 2500, fuel: 38000, draw: drawTank, desc: 'Large tank, double length.' });

  /* Tapered tanks — narrow at the top so the next size down (or a pod) sits
     flush without spending a part on a separate adapter. They hold less than
     a straight tank of the same height because the cone has less volume. */
  add({
    id: 'tank_ms', name: 'Tank M→S', cat: 'Tanks', type: 'tank',
    w: 2, topW: 1, h: 3, mass: 270, fuel: 2100, draw: drawTaperTank,
    desc: 'Medium tank tapering to small. A Mk1 pod sits flush on top.'
  });
  add({
    id: 'tank_ms2', name: 'Tank M→S Long', cat: 'Tanks', type: 'tank',
    w: 2, topW: 1, h: 5, mass: 420, fuel: 3600, draw: drawTaperTank,
    desc: 'Longer medium-to-small taper.'
  });
  add({
    id: 'tank_lm', name: 'Tank L→M', cat: 'Tanks', type: 'tank',
    w: 4, topW: 2, h: 4, mass: 620, fuel: 8500, draw: drawTaperTank,
    desc: 'Large tank tapering to medium. Saves an adapter on a big stack.'
  });
  add({
    id: 'tank_lm2', name: 'Tank L→M Long', cat: 'Tanks', type: 'tank',
    w: 4, topW: 2, h: 7, mass: 1080, fuel: 15000, draw: drawTaperTank,
    desc: 'Longer large-to-medium taper.'
  });

  /* ═══════════════════ ENGINES ═══════════════════ */

  add({
    id: 'eng_s', name: 'Sparrow', cat: 'Engines', type: 'engine',
    w: 1, h: 1.3, mass: 120, cd: 0.9,
    engine: { thrust: 30e3, ispVac: 300, ispSl: 250, gimbal: 0.15 },
    desc: 'Small engine. Great for upper stages and landers.',
    draw: drawEngine
  });
  add({
    id: 'eng_m', name: 'Hawk', cat: 'Engines', type: 'engine',
    w: 2, h: 2.2, mass: 560, cd: 0.9,
    engine: { thrust: 200e3, ispVac: 315, ispSl: 270, gimbal: 0.14 },
    desc: 'Reliable medium workhorse.',
    draw: drawEngine
  });
  add({
    id: 'eng_l', name: 'Titan', cat: 'Engines', type: 'engine',
    w: 4, h: 3.2, mass: 2000, cd: 0.9,
    engine: { thrust: 950e3, ispVac: 320, ispSl: 285, gimbal: 0.12 },
    desc: 'Heavy lifter for the big stuff.',
    draw: drawEngine
  });
  add({
    id: 'eng_vac', name: 'Bell', cat: 'Engines', type: 'engine',
    w: 2, h: 3.0, mass: 700, cd: 0.9,
    engine: { thrust: 120e3, ispVac: 375, ispSl: 130, gimbal: 0.14 },
    desc: 'Vacuum-optimised. Terrible at sea level, superb in space.',
    draw: drawEngine
  });
  add({
    id: 'eng_ion', name: 'Ion Drive', cat: 'Engines', type: 'engine',
    w: 1, h: 1.2, mass: 90, cd: 0.9,
    engine: { thrust: 3e3, ispVac: 2800, ispSl: 90, gimbal: 0.08 },
    desc: 'Feeble thrust, absurd efficiency. Deep-space only.',
    draw: drawEngine
  });
  add({
    id: 'srb', name: 'Solid Booster', cat: 'Engines', type: 'engine',
    w: 2, h: 9, mass: 900, fuel: 11000, radial: true, cd: 1.0,
    engine: { thrust: 380e3, ispVac: 240, ispSl: 210, gimbal: 0, solid: true, smoke: 6 },
    desc: 'Burns its own fuel flat-out until empty. Cannot be shut down, and throws out a colossal cloud of smoke.',
    draw: drawSrb
  });

  /* ═══════════════════ AERO ═══════════════════ */

  add({ id: 'nose_s', name: 'Nose S', cat: 'Aero', type: 'nose', w: 1, h: 1.5, mass: 40, cd: 0.55, draw: drawCone, desc: 'Slippery tip. Cuts drag a lot.' });
  add({ id: 'nose_m', name: 'Nose M', cat: 'Aero', type: 'nose', w: 2, h: 2.4, mass: 150, cd: 0.55, draw: drawCone, desc: 'Medium nose cone.' });
  add({ id: 'nose_l', name: 'Nose L', cat: 'Aero', type: 'nose', w: 4, h: 4.0, mass: 420, cd: 0.55, draw: drawCone, desc: 'Large fairing nose.' });
  add({ id: 'fin_s', name: 'Fin', cat: 'Aero', type: 'fin', w: 1.5, h: 2.0, mass: 50, radial: true, cd: 2.1, draw: drawFin, desc: 'Keeps the nose pointing forward in air.' });
  add({ id: 'fin_l', name: 'Big Fin', cat: 'Aero', type: 'fin', w: 2.5, h: 3.0, mass: 140, radial: true, cd: 2.3, draw: drawFin, desc: 'Twice the bite. Heavy.' });
  add({
    id: 'chute', name: 'Parachute', cat: 'Aero', type: 'chute', w: 0.55, h: 0.34, mass: 85, cd: 0.9,
    chute: { area: 240, cd: 1.3, width: 9, riser: 5.5 },
    desc: 'Tiny can. Clamps onto any capsule deck; brings a light one down at about 9 m/s.', draw: drawChute
  });
  add({
    id: 'chute_l', name: 'Big Chute', cat: 'Aero', type: 'chute', w: 0.95, h: 0.46, mass: 210, cd: 0.9,
    chute: { area: 700, cd: 1.3, width: 17, riser: 9 },
    desc: 'Clamps on like the small one. For heavy capsules coming home hot.', draw: drawChute
  });
  add({
    id: 'shield_s', name: 'Heat Shield S', cat: 'Aero', type: 'shield',
    w: 1.3, h: 0.45, mass: 110, cd: 1.3, shield: { prot: 0.88 },
    desc: 'Ablative dish. Bolt it under a Mk1 pod and come back down blunt-end first.',
    draw: drawShield
  });
  add({
    id: 'shield_m', name: 'Heat Shield M', cat: 'Aero', type: 'shield',
    w: 2.4, h: 0.6, mass: 300, cd: 1.3, shield: { prot: 0.90 },
    desc: 'Shields a medium stack. Re-enter retrograde so it faces the airflow.',
    draw: drawShield
  });
  add({
    id: 'shield_l', name: 'Heat Shield L', cat: 'Aero', type: 'shield',
    w: 4.4, h: 0.8, mass: 720, cd: 1.3, shield: { prot: 0.92 },
    desc: 'Big ablative shield for a heavy craft returning from the Moon.',
    draw: drawShield
  });

  /* ═══════════════════ STRUCTURE ═══════════════════ */

  add({ id: 'sep_s', name: 'Separator S', cat: 'Struct', type: 'sep', w: 1, h: 0.4, mass: 30, cd: 1.0, draw: drawSep, desc: 'Splits the rocket here when staged.' });
  add({ id: 'sep_m', name: 'Separator M', cat: 'Struct', type: 'sep', w: 2, h: 0.5, mass: 80, cd: 1.0, draw: drawSep, desc: 'Splits the rocket here when staged.' });
  add({ id: 'sep_l', name: 'Separator L', cat: 'Struct', type: 'sep', w: 4, h: 0.6, mass: 200, cd: 1.0, draw: drawSep, desc: 'Splits the rocket here when staged.' });
  add({ id: 'sep_side', name: 'Side Sep.', cat: 'Struct', type: 'sep', w: 0.6, h: 1.4, mass: 25, radial: true, cd: 1.0, draw: drawSep, desc: 'Holds a booster on the side, then throws it clear.' });
  add({ id: 'adapt_sm', name: 'Adapter S→M', cat: 'Struct', type: 'adapter', w: 2, h: 1.2, topW: 1, mass: 110, cd: 0.8, draw: drawAdapter, desc: 'Medium below, small above.' });
  add({ id: 'adapt_ml', name: 'Adapter M→L', cat: 'Struct', type: 'adapter', w: 4, h: 1.6, topW: 2, mass: 300, cd: 0.8, draw: drawAdapter, desc: 'Large below, medium above.' });
  add({ id: 'leg', name: 'Landing Leg', cat: 'Struct', type: 'leg', w: 1.2, h: 2.0, mass: 70, radial: true, cd: 1.0, draw: drawLeg, desc: 'Triples your survivable touchdown speed.' });
  add({ id: 'rcs', name: 'RCS Block', cat: 'Struct', type: 'rcs', w: 0.6, h: 0.8, mass: 40, radial: true, cd: 1.0, authority: 0.60, draw: drawRcs, desc: 'Extra turning authority, anywhere.' });

  /* ── couplers ───────────────────────────────────────────────
     Vertical  : in-line truss, rigidly joins the stack above to the stack below.
     Linear    : sideways beam, ties a parallel stack to the core.
     Bi        : one stack below feeds two side-by-side stacks above.        */

  add({
    id: 'coup_v_s', name: 'V-Coupler S', cat: 'Struct', type: 'coupler', w: 1, h: 0.7, mass: 30, cd: 0.9,
    desc: 'Vertical coupler. Rigidly joins two small stacks in line.', draw: drawVCoup
  });
  add({
    id: 'coup_v_m', name: 'V-Coupler M', cat: 'Struct', type: 'coupler', w: 2, h: 0.9, mass: 75, cd: 0.9,
    desc: 'Vertical coupler. Rigidly joins two medium stacks in line.', draw: drawVCoup
  });
  add({
    id: 'coup_v_l', name: 'V-Coupler L', cat: 'Struct', type: 'coupler', w: 4, h: 1.1, mass: 180, cd: 0.9,
    desc: 'Vertical coupler for large stacks.', draw: drawVCoup
  });
  add({
    id: 'coup_l_s', name: 'L-Coupler S', cat: 'Struct', type: 'coupler', w: 1.6, h: 0.8, mass: 35, radial: true, cd: 1.0,
    desc: 'Linear coupler. Bridges sideways to hold a parallel stack.', draw: drawLCoup
  });
  add({
    id: 'coup_l_m', name: 'L-Coupler M', cat: 'Struct', type: 'coupler', w: 3.0, h: 1.0, mass: 80, radial: true, cd: 1.0,
    desc: 'Long linear coupler for wide parallel stacks.', draw: drawLCoup
  });
  add({
    id: 'coup_bi_s', name: 'Bi-Coupler S', cat: 'Struct', type: 'coupler', w: 2, h: 1.6, mass: 120, cd: 0.85,
    desc: 'Splits a medium stack into two small stacks.', draw: drawBiCoup
  });
  add({
    id: 'coup_bi_m', name: 'Bi-Coupler M', cat: 'Struct', type: 'coupler', w: 4, h: 2.4, mass: 330, cd: 0.85,
    desc: 'Splits a large stack into two medium stacks.', draw: drawBiCoup
  });

  /* ─────────────────── helpers used elsewhere ─────────────────── */

  /** default runtime state for a placed part */
  S.partState = function (def) {
    return { fuel: def.fuel > 0 ? 1 : 0, throttle: 0, deployed: false, chute: 0, active: false };
  };

  /** render a part into a small canvas for the palette */
  S.partIcon = function (def, box) {
    const c = document.createElement('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = box * dpr; c.height = box * dpr;
    c.style.width = box + 'px'; c.style.height = box + 'px';
    const ctx = c.getContext('2d');
    const pad = 4;
    const sc = Math.min((box - pad * 2) / def.w, (box - pad * 2) / def.h);
    ctx.setTransform(sc * dpr, 0, 0, -sc * dpr, (box / 2) * dpr, (box / 2) * dpr);
    try { def.draw(ctx, { fuel: 1, throttle: 0, deployed: true, chute: 0 }, def); } catch (e) { }
    return c;
  };

})(window.SFS);
