/* ============================================================
   render.js — camera, planets, oceans, scenery, clouds,
               vessels, exhaust, particles and the map view
   ------------------------------------------------------------
   Everything is drawn in CAMERA-RELATIVE metres so that path
   coordinates stay small and precise however far from the origin
   the craft happens to be.
   ============================================================ */
(function (S) {
  'use strict';

  const U = S.util;
  const W = S.world;
  const R = S.render = {};

  const SUN = 0.9;                       // world angle the sunlight comes from

  /** rotation that maps local +y onto the given unit "up" vector */
  const upAngle = S.upAngle = n => Math.atan2(-n.x, n.y);

  /* ═══════════════════ camera ═══════════════════ */

  const cam = R.cam = {
    x: 0, y: 0, zoom: 6, zoomT: 6, rot: 0,
    map: false, mapZoom: 8e-5, mapZoomT: 8e-5,
    offX: 0, offY: 0,                    // map-view pan, relative to the craft
    minZoom: 2.2e-7, maxZoom: 14
  };

  R.viewR = function (cw, ch) {
    return 0.5 * Math.hypot(cw, ch) / (cam.map ? cam.mapZoom : cam.zoom);
  };

  R.zoomBy = function (f) {
    if (cam.map) cam.mapZoomT = U.clamp(cam.mapZoomT * f, cam.minZoom, 0.02);
    else cam.zoomT = U.clamp(cam.zoomT * f, cam.minZoom, cam.maxZoom);
  };

  R.follow = function (v, t, dt, snap) {
    if (!v) return;
    if (cam.map) {
      // map view is north-up and drag-pannable
      cam.x = v.x + cam.offX;
      cam.y = v.y + cam.offY;
      cam.mapZoom = U.smooth(cam.mapZoom, cam.mapZoomT, 9, dt);
      return;
    }
    const b = v.nearBody || W.soiBody(v.x, v.y, t);
    const bp = W.bodyPos(b, t);
    const want = Math.PI / 2 - Math.atan2(v.y - bp.y, v.x - bp.x);
    // Position tracks exactly. Easing it leaves a steady-state lag of
    // speed/rate metres, which at orbital speed is hundreds of metres — enough
    // to push the craft clean off a zoomed-in screen. The craft's own motion is
    // already smooth, so there is nothing here worth filtering.
    cam.x = v.x;
    cam.y = v.y;
    if (snap) { cam.rot = want; cam.zoom = cam.zoomT; }
    else {
      cam.rot += U.wrap(want - cam.rot) * (1 - Math.exp(-6 * dt));
      cam.zoom = U.smooth(cam.zoom, cam.zoomT, 9, dt);
    }
  };

  function setWorldTf(ctx, cw, ch, dpr, zoom, rot) {
    const z = zoom * dpr, c = Math.cos(rot), s = Math.sin(rot);
    ctx.setTransform(z * c, -z * s, -z * s, -z * c, (cw / 2) * dpr, (ch / 2) * dpr);
  }

  /* ═══════════════════ stars ═══════════════════ */

  let stars = null;
  function initStars() {
    const rnd = U.rng(7717);
    stars = [];
    for (let i = 0; i < 520; i++) {
      stars.push({
        a: rnd() * U.TAU,
        r: Math.sqrt(rnd()) * 1.05,
        s: 0.5 + rnd() * 1.4,
        b: 0.25 + rnd() * 0.75,
        tw: rnd() * 10
      });
    }
  }

  function drawStars(ctx, cw, ch, dpr, alpha, t, rot) {
    if (!stars) initStars();
    if (alpha <= 0.01) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = cw / 2, cy = ch / 2;
    const rad = 0.5 * Math.hypot(cw, ch);
    for (let i = 0; i < stars.length; i++) {
      const st = stars[i];
      const a = st.a + rot;
      const x = cx + Math.cos(a) * st.r * rad;
      const y = cy - Math.sin(a) * st.r * rad;
      if (x < -4 || y < -4 || x > cw + 4 || y > ch + 4) continue;
      const tw = 0.78 + 0.22 * Math.sin(t * 1.6 + st.tw);
      ctx.globalAlpha = alpha * st.b * tw;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x, y, st.s, st.s);
    }
    ctx.globalAlpha = 1;
  }

  /* ═══════════════════ sky ═══════════════════ */

  function drawSky(ctx, cw, ch, dpr, atmoF) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (atmoF <= 0.001) {
      ctx.fillStyle = '#05070f';
      ctx.fillRect(0, 0, cw, ch);
      return;
    }
    const c = W.earth.col;
    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, U.mix('#05070f', c.skyHi, Math.pow(atmoF, 0.55)));
    g.addColorStop(0.62, U.mix('#05070f', c.sky, Math.pow(atmoF, 0.42)));
    g.addColorStop(1, U.mix('#05070f', c.glow, Math.pow(atmoF, 0.3)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
  }

  /* ═══════════════════ planets ═══════════════════ */

  const _sc = [];
  const _cl = [];

  function smoothstep(a, b, x) {
    const t = U.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function drawBody(ctx, b, t, cw, ch, viewR) {
    const bp = W.bodyPos(b, t);
    const rx = bp.x - cam.x, ry = bp.y - cam.y;
    const dc = Math.hypot(rx, ry);
    const zoom = cam.map ? cam.mapZoom : cam.zoom;

    // entirely off-screen — skip it (also keeps path coords sane when zoomed in)
    const outer = b.radius + (b.atmo ? b.atmo.height : 0) + 4000;
    if (dc - outer > viewR * 1.7) return;

    // on-screen but sub-pixel: render as a lit dot instead
    if (b.radius * zoom < 2.2) { drawFarBody(ctx, b, rx, ry, zoom); return; }

    const halfAng = Math.min(Math.PI, (viewR / b.radius) * 1.7 + 0.02);
    const thC = Math.atan2(-ry, -rx);        // direction from body centre to camera
    const orbK = smoothstep(0.30, 0.46, halfAng);

    if (b.atmo) drawAtmosphere(ctx, b, rx, ry, zoom, viewR);
    if (orbK > 0.01) drawOrbital(ctx, b, rx, ry, zoom, orbK);
    if (orbK < 0.99) drawSurface(ctx, b, t, rx, ry, thC, halfAng, zoom, viewR, 1 - orbK);
  }

  /** a distant world reduced to a lit dot */
  function drawFarBody(ctx, b, rx, ry, zoom) {
    ctx.beginPath();
    ctx.arc(rx, ry, 2.4 / zoom, 0, U.TAU);
    ctx.fillStyle = b.col.land;
    ctx.fill();
  }

  /**
   * The view from orbit. In a 2-D world the only real surface is the rim, so
   * the disc is the planet's bulk and land/ocean show as a coloured band round
   * the edge — drawing continents as pie sectors would read as a pie chart.
   */
  function drawOrbital(ctx, b, rx, ry, zoom, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const Rr = b.radius;

    // bulk
    const core = ctx.createRadialGradient(
      rx - Math.cos(SUN) * Rr * 0.3, ry - Math.sin(SUN) * Rr * 0.3, Rr * 0.05, rx, ry, Rr);
    core.addColorStop(0, b.col.core);
    core.addColorStop(1, b.col.coreLo);
    ctx.beginPath(); ctx.arc(rx, ry, Rr, 0, U.TAU);
    ctx.fillStyle = core;
    ctx.fill();

    if (b.id === 'moon') drawCraters(ctx, b, rx, ry, Rr);

    // surface band: green where land pokes above sea level, blue where it doesn't
    const band = Math.max(Rr * 0.062, 1.5 / zoom);
    const rMid = Rr - band / 2;
    const N = Math.round(U.clamp(Rr * zoom * 1.2, 128, 720));
    ctx.lineWidth = band;
    ctx.lineCap = 'butt';
    let start = 0, mat = matAt(b, 0);
    for (let i = 1; i <= N; i++) {
      const m = i < N ? matAt(b, (i / N) * U.TAU) : null;
      if (m !== mat || i === N) {
        ctx.beginPath();
        ctx.arc(rx, ry, rMid, (start / N) * U.TAU, (i / N) * U.TAU);
        ctx.strokeStyle = mat;
        ctx.stroke();
        start = i - 1; mat = m;
      }
    }

    // shallow water glow at the coasts
    if (b.sea) {
      ctx.save();
      ctx.beginPath(); ctx.arc(rx, ry, Rr, 0, U.TAU); ctx.clip();
      const g = ctx.createRadialGradient(rx, ry, Rr * 0.965, rx, ry, Rr);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(130,205,240,.25)');
      ctx.fillStyle = g;
      ctx.fillRect(rx - Rr, ry - Rr, Rr * 2, Rr * 2);
      ctx.restore();
    }

    // night side
    ctx.save();
    ctx.beginPath(); ctx.arc(rx, ry, Rr, 0, U.TAU); ctx.clip();
    const sx = Math.cos(SUN), sy = Math.sin(SUN);
    const ng = ctx.createLinearGradient(rx + sx * Rr, ry + sy * Rr, rx - sx * Rr, ry - sy * Rr);
    ng.addColorStop(0, 'rgba(0,0,0,0)');
    ng.addColorStop(0.42, 'rgba(0,0,0,.12)');
    ng.addColorStop(0.66, 'rgba(2,4,10,.62)');
    ng.addColorStop(1, 'rgba(2,4,10,.86)');
    ctx.fillStyle = ng;
    ctx.fillRect(rx - Rr, ry - Rr, Rr * 2, Rr * 2);
    ctx.restore();

    ctx.restore();
  }

  /** surface-band colour at a given angle, seen from orbit */
  function matAt(b, th) {
    if (!b.sea) return W.terrain(b, th) > b.seaLevel + 900 ? b.col.rock : b.col.land;
    const r = W.terrain(b, th);
    if (r < b.seaLevel) return r < b.seaLevel - 1400 ? b.col.waterDeep : b.col.water;
    return r > b.seaLevel + 1500 ? b.col.rock : b.col.land;
  }

  function drawCraters(ctx, b, rx, ry, Rr) {
    const rnd = U.rng(4242);
    ctx.fillStyle = 'rgba(70,68,64,.35)';
    for (let i = 0; i < 26; i++) {
      const a = rnd() * U.TAU, d = Math.sqrt(rnd()) * Rr * 0.93;
      const cr = Rr * (0.025 + rnd() * 0.07);
      ctx.beginPath();
      ctx.arc(rx + Math.cos(a) * d, ry + Math.sin(a) * d, cr, 0, U.TAU);
      ctx.fill();
    }
  }

  function drawAtmosphere(ctx, b, rx, ry, zoom, viewR) {
    const h = b.atmo.height;
    const R0 = b.radius, R1 = b.radius + h;
    if ((R1 - R0) * zoom < 1.5) return;
    const g = ctx.createRadialGradient(rx, ry, R0 * 0.995, rx, ry, R1);
    g.addColorStop(0, 'rgba(120,190,245,.42)');
    g.addColorStop(0.28, 'rgba(90,165,235,.24)');
    g.addColorStop(1, 'rgba(60,130,215,0)');
    ctx.beginPath();
    ctx.arc(rx, ry, R1, 0, U.TAU);
    ctx.fillStyle = g;
    ctx.fill();
  }

  /** close-up terrain: the visible arc, its crust, oceans, scenery and clouds */
  function drawSurface(ctx, b, t, rx, ry, thC, halfAng, zoom, viewR, alpha) {
    const full = halfAng >= Math.PI - 1e-6;
    const n = Math.round(U.clamp(halfAng * 2 * b.radius * zoom / 3.2, 90, 1000));
    const th0 = thC - halfAng, span = halfAng * 2;

    const th = new Float64Array(n + 1);
    const rr = new Float64Array(n + 1);
    const px = new Float64Array(n + 1);
    const py = new Float64Array(n + 1);
    let minR = Infinity;
    for (let i = 0; i <= n; i++) {
      const a = th0 + (span * i) / n;
      const r = W.terrain(b, a);
      th[i] = a; rr[i] = r;
      px[i] = rx + Math.cos(a) * r;
      py[i] = ry + Math.sin(a) * r;
      if (r < minR) minR = r;
    }

    ctx.save();
    ctx.globalAlpha = alpha;

    /* ── bedrock ── */
    const depth = viewR * 3.2;
    ctx.beginPath();
    ctx.moveTo(px[0], py[0]);
    for (let i = 1; i <= n; i++) ctx.lineTo(px[i], py[i]);
    if (full) ctx.closePath();
    else {
      const rin = Math.max(b.radius * 0.35, minR - depth);
      for (let i = n; i >= 0; i--) ctx.lineTo(rx + Math.cos(th[i]) * rin, ry + Math.sin(th[i]) * rin);
      ctx.closePath();
    }
    // soil near the surface fading into rock further down
    const mc = Math.cos(thC), ms = Math.sin(thC);
    const bg = ctx.createLinearGradient(
      rx + mc * b.radius, ry + ms * b.radius,
      rx + mc * (b.radius - depth * 0.7), ry + ms * (b.radius - depth * 0.7));
    bg.addColorStop(0, b.col.landLo);
    bg.addColorStop(1, b.col.deep);
    ctx.fillStyle = bg;
    ctx.fill();

    /* ── surface crust, coloured by material ── */
    const crust = Math.max(1.5, viewR * 0.035);
    ctx.lineWidth = crust; ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    const matOf = i => {
      if (b.sea && rr[i] < b.seaLevel + 45) return b.col.sand;
      if (rr[i] > b.seaLevel + 2100) return b.col.rock;
      return b.col.land;
    };
    let runStart = 0, runMat = matOf(0);
    for (let i = 1; i <= n + 1; i++) {
      const m = i <= n ? matOf(i) : null;
      if (m !== runMat || i > n) {
        ctx.beginPath();
        ctx.moveTo(px[runStart] + Math.cos(th[runStart]) * -crust / 2, py[runStart] + Math.sin(th[runStart]) * -crust / 2);
        for (let k = runStart + 1; k <= Math.min(i, n); k++) {
          ctx.lineTo(px[k] + Math.cos(th[k]) * -crust / 2, py[k] + Math.sin(th[k]) * -crust / 2);
        }
        ctx.strokeStyle = runMat;
        ctx.stroke();
        runStart = Math.max(0, i - 1); runMat = m;
      }
    }

    /* ── oceans ── */
    if (b.sea) drawWater(ctx, b, t, rx, ry, th, rr, n, viewR, zoom);

    /* ── clouds behind nothing, scenery on the ground ── */
    if (b.scenery) drawScenery(ctx, b, t, rx, ry, th0, th0 + span, zoom);
    if (b.pad) drawPad(ctx, b, rx, ry, th0, th0 + span, zoom);
    if (b.clouds) drawClouds(ctx, b, t, rx, ry, th0, th0 + span, zoom, viewR);

    ctx.restore();
  }

  function drawWater(ctx, b, t, rx, ry, th, rr, n, viewR, zoom) {
    const waves = viewR < 6000;
    const amp = waves ? Math.min(2.2, Math.max(0.25, viewR * 0.0035)) : 0;
    const sea = i => b.seaLevel + (waves
      ? amp * (Math.sin(th[i] * 52000 + t * 1.3) + 0.55 * Math.sin(th[i] * 131000 - t * 2.1))
      : 0);

    let i = 0;
    while (i <= n) {
      if (rr[i] >= b.seaLevel) { i++; continue; }
      let j = i;
      while (j + 1 <= n && rr[j + 1] < b.seaLevel) j++;

      ctx.beginPath();
      for (let k = i; k <= j; k++) {
        const s = sea(k);
        const x = rx + Math.cos(th[k]) * s, y = ry + Math.sin(th[k]) * s;
        if (k === i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let k = j; k >= i; k--) {
        ctx.lineTo(rx + Math.cos(th[k]) * rr[k], ry + Math.sin(th[k]) * rr[k]);
      }
      ctx.closePath();

      const mid = (i + j) >> 1;
      const cx = Math.cos(th[mid]), cy = Math.sin(th[mid]);
      let deep = b.seaLevel;
      for (let k = i; k <= j; k++) deep = Math.min(deep, rr[k]);
      const g = ctx.createLinearGradient(
        rx + cx * b.seaLevel, ry + cy * b.seaLevel,
        rx + cx * deep, ry + cy * deep);
      g.addColorStop(0, b.col.water);
      g.addColorStop(1, b.col.waterDeep);
      ctx.fillStyle = g;
      ctx.fill();

      // surf line
      ctx.beginPath();
      for (let k = i; k <= j; k++) {
        const s = sea(k);
        const x = rx + Math.cos(th[k]) * s, y = ry + Math.sin(th[k]) * s;
        if (k === i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineWidth = Math.max(0.6, viewR * 0.004);
      ctx.strokeStyle = 'rgba(190,235,255,.55)';
      ctx.stroke();

      i = j + 1;
    }
  }

  /* ═══════════════════ scenery artwork ═══════════════════ */

  function drawScenery(ctx, b, t, rx, ry, th0, th1, zoom) {
    if (12 * zoom < 0.9) return;                    // too small to matter
    W.sceneryIn(b, th0, th1, _sc);
    for (let i = 0; i < _sc.length; i++) {
      const o = _sc[i];
      const nrm = W.terrainNormal(b, o.th);
      ctx.save();
      ctx.translate(rx + Math.cos(o.th) * o.gr, ry + Math.sin(o.th) * o.gr);
      ctx.rotate(upAngle(nrm));
      SCEN[o.type](ctx, o, t);
      ctx.restore();
    }
  }

  const SCEN = {
    pine(ctx, o) {
      const w = o.w, h = o.h;
      ctx.fillStyle = '#5b4028';
      ctx.fillRect(-w * 0.07, 0, w * 0.14, h * 0.32);
      const lay = 3;
      for (let i = 0; i < lay; i++) {
        const y0 = h * (0.18 + i * 0.26), hw = w * 0.5 * (1 - i * 0.24);
        ctx.beginPath();
        ctx.moveTo(-hw, y0); ctx.lineTo(hw, y0); ctx.lineTo(0, y0 + h * 0.38);
        ctx.closePath();
        ctx.fillStyle = i === lay - 1 ? '#2f6b34' : '#285c2d';
        ctx.fill();
      }
    },
    tree(ctx, o) {
      const w = o.w, h = o.h;
      ctx.strokeStyle = '#5b4028'; ctx.lineWidth = w * 0.11; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(0, h * 0.45);
      ctx.moveTo(0, h * 0.34); ctx.lineTo(-w * 0.16, h * 0.5);
      ctx.moveTo(0, h * 0.36); ctx.lineTo(w * 0.17, h * 0.52);
      ctx.stroke();
      ctx.fillStyle = '#3a7a3c';
      const puf = [[0, 0.66, 0.34], [-0.24, 0.56, 0.26], [0.25, 0.58, 0.27], [0.05, 0.8, 0.24]];
      for (const p of puf) {
        ctx.beginPath();
        ctx.arc(w * p[0], h * p[1], w * p[2], 0, U.TAU);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(120,190,110,.5)';
      ctx.beginPath(); ctx.arc(-w * 0.12, h * 0.72, w * 0.16, 0, U.TAU); ctx.fill();
    },
    house(ctx, o) {
      const w = o.w, h = o.h;
      const bh = h * 0.62;
      ctx.fillStyle = '#d9cdb8';
      ctx.fillRect(-w / 2, 0, w, bh);
      ctx.strokeStyle = 'rgba(40,36,30,.5)'; ctx.lineWidth = Math.max(0.06, w * 0.015);
      ctx.strokeRect(-w / 2, 0, w, bh);
      ctx.beginPath();
      ctx.moveTo(-w * 0.56, bh); ctx.lineTo(0, h); ctx.lineTo(w * 0.56, bh);
      ctx.closePath();
      ctx.fillStyle = '#9c4a35'; ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#6c5a44';
      ctx.fillRect(-w * 0.09, 0, w * 0.18, bh * 0.52);
      ctx.fillStyle = '#8fc4e8';
      ctx.fillRect(-w * 0.36, bh * 0.35, w * 0.16, bh * 0.3);
      ctx.fillRect(w * 0.2, bh * 0.35, w * 0.16, bh * 0.3);
    },
    block(ctx, o) {
      const w = o.w, h = o.h;
      ctx.fillStyle = '#8e9099';
      ctx.fillRect(-w / 2, 0, w, h);
      ctx.strokeStyle = 'rgba(30,34,42,.55)'; ctx.lineWidth = Math.max(0.06, w * 0.012);
      ctx.strokeRect(-w / 2, 0, w, h);
      const cols = Math.max(2, Math.round(w / 3)), rows = Math.max(3, Math.round(h / 3.4));
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const lit = U.hash(o.seed, r, c) > 0.55;
        ctx.fillStyle = lit ? 'rgba(255,225,150,.85)' : 'rgba(45,58,75,.85)';
        ctx.fillRect(-w / 2 + w * (c + 0.28) / cols, h * (r + 0.3) / rows, w * 0.44 / cols, h * 0.4 / rows);
      }
    },
    mast(ctx, o) {
      const w = o.w, h = o.h;
      ctx.strokeStyle = '#b0b6bf'; ctx.lineWidth = Math.max(0.08, w * 0.1);
      ctx.beginPath();
      ctx.moveTo(-w / 2, 0); ctx.lineTo(-w * 0.12, h);
      ctx.moveTo(w / 2, 0); ctx.lineTo(w * 0.12, h);
      const seg = 7;
      for (let i = 0; i < seg; i++) {
        const y0 = h * i / seg, y1 = h * (i + 1) / seg;
        const s0 = U.lerp(w / 2, w * 0.12, i / seg), s1 = U.lerp(w / 2, w * 0.12, (i + 1) / seg);
        ctx.moveTo(-s0, y0); ctx.lineTo(s1, y1);
        ctx.moveTo(s0, y0); ctx.lineTo(-s1, y1);
        ctx.moveTo(-s1, y1); ctx.lineTo(s1, y1);
      }
      ctx.stroke();
      ctx.fillStyle = '#ff4444';
      ctx.beginPath(); ctx.arc(0, h * 1.02, w * 0.16, 0, U.TAU); ctx.fill();
    },
    rock(ctx, o) { blob(ctx, o, '#7d7a73', '#5d5a54'); },
    boulder(ctx, o) { blob(ctx, o, '#8b877f', '#63605a'); },
    flag(ctx, o) {
      const w = o.w, h = o.h;
      ctx.strokeStyle = '#d8d8d8'; ctx.lineWidth = Math.max(0.05, w * 0.09);
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, h); ctx.stroke();
      ctx.fillStyle = '#d33a3a';
      ctx.fillRect(0, h * 0.6, w * 0.9, h * 0.3);
    }
  };

  function blob(ctx, o, c1, c2) {
    const w = o.w, h = o.h, n = 7;
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const a = Math.PI * i / n;
      const k = 0.72 + 0.34 * U.hash(o.seed, i, 3);
      const x = -Math.cos(a) * w / 2 * k, y = Math.sin(a) * h * k;
      if (!i) ctx.moveTo(-w / 2, 0); else ctx.lineTo(x, y);
    }
    ctx.lineTo(w / 2, 0);
    ctx.closePath();
    const g = ctx.createLinearGradient(-w / 2, 0, w / 2, h);
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    ctx.fillStyle = g; ctx.fill();
  }

  /** the launch complex sitting on the flattened plateau */
  function drawPad(ctx, b, rx, ry, th0, th1, zoom) {
    const pt = b.pad.theta;
    if (pt < th0 - 0.002 || pt > th1 + 0.002) return;
    if (60 * zoom < 1) return;
    const gr = W.terrain(b, pt);
    const nrm = W.terrainNormal(b, pt);
    ctx.save();
    ctx.translate(rx + Math.cos(pt) * gr, ry + Math.sin(pt) * gr);
    ctx.rotate(upAngle(nrm));
    // apron
    ctx.fillStyle = '#5b5f66';
    ctx.fillRect(-46, -1.5, 92, 3.2);
    ctx.fillStyle = '#71767e';
    ctx.fillRect(-16, -0.6, 32, 2.2);
    ctx.fillStyle = '#3c4046';
    for (let i = -4; i <= 4; i++) ctx.fillRect(i * 9 - 0.5, -1.4, 1, 3);
    // flame trench
    ctx.fillStyle = '#23262b';
    ctx.fillRect(-5, -1.4, 10, 2.4);
    // service tower
    ctx.strokeStyle = '#9aa1ab'; ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(14, 0); ctx.lineTo(14, 46);
    ctx.moveTo(21, 0); ctx.lineTo(21, 46);
    for (let y = 0; y < 46; y += 4.6) {
      ctx.moveTo(14, y); ctx.lineTo(21, y + 4.6);
      ctx.moveTo(14, y + 4.6); ctx.lineTo(21, y);
      ctx.moveTo(14, y); ctx.lineTo(21, y);
    }
    ctx.moveTo(14, 46); ctx.lineTo(21, 46);
    ctx.stroke();
    ctx.fillStyle = '#c94f2f';
    ctx.fillRect(13.4, 46, 8.2, 1.4);
    ctx.restore();
  }

  function drawClouds(ctx, b, t, rx, ry, th0, th1, zoom, viewR) {
    if (600 * zoom < 1.2) return;
    W.cloudsIn(b, th0, th1, t, _cl);
    for (let i = 0; i < _cl.length; i++) {
      const c = _cl[i];
      const r = b.seaLevel + c.alt;
      const nx = Math.cos(c.th), ny = Math.sin(c.th);
      ctx.save();
      ctx.translate(rx + nx * r, ry + ny * r);
      ctx.rotate(Math.atan2(-nx, ny));
      // flat-bottomed: clip away everything below the cloud base
      ctx.beginPath();
      ctx.rect(-c.w, 0, c.w * 2, c.h * 2.2);
      ctx.clip();
      ctx.globalAlpha = c.op * 0.9;
      const g = ctx.createLinearGradient(0, c.h * 0.95, 0, -c.h * 0.1);
      g.addColorStop(0, '#ffffff');
      g.addColorStop(0.55, '#eef3fa');
      g.addColorStop(1, '#b9c6d8');           // shaded underside
      ctx.fillStyle = g;
      ctx.beginPath();
      for (const p of c.puffs) {
        ctx.moveTo(p.dx + p.r, p.dy);
        ctx.arc(p.dx, p.dy, p.r, 0, U.TAU);
      }
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /* ═══════════════════ vessels ═══════════════════ */

  const _pw = { x: 0, y: 0 };

  R.drawVessel = function (ctx, v, t, zoom) {
    // flames first so the hardware sits on top of them
    for (const p of v.parts) {
      if (p.def.type === 'engine' && p.throttle > 0.02) drawFlame(ctx, v, p, t, zoom);
    }
    for (const p of v.parts) {
      v.worldOf(p, _pw);
      ctx.save();
      ctx.translate(_pw.x - cam.x, _pw.y - cam.y);
      ctx.rotate(v.angle);
      if (p.flip < 0) ctx.scale(-1, 1);
      p.def.draw(ctx, p, p.def);
      ctx.restore();
    }
  };

  function drawFlame(ctx, v, p, t, zoom) {
    const w = p.def.w, thr = p.throttle;
    const vac = 1 - (v.atmoF || 0);
    const flick = 0.86 + 0.14 * Math.sin(t * 47 + p.uid * 2.7) + 0.06 * Math.sin(t * 91 + p.uid);
    const len = w * (2.4 + 5.4 * thr) * (1 + vac * 0.55) * flick;
    const wid = w * (0.52 + 0.34 * thr) * (1 + vac * 0.5);
    if (len * zoom < 0.7) return;

    v.worldOf(p, _pw);
    ctx.save();
    ctx.translate(_pw.x - cam.x, _pw.y - cam.y);
    ctx.rotate(v.angle);
    if (p.flip < 0) ctx.scale(-1, 1);
    ctx.translate(0, -p.def.h / 2);

    const g = ctx.createLinearGradient(0, 0, 0, -len);
    g.addColorStop(0, 'rgba(255,255,255,.95)');
    g.addColorStop(0.12, 'rgba(190,225,255,.9)');
    g.addColorStop(0.42, 'rgba(255,170,70,.75)');
    g.addColorStop(1, 'rgba(255,90,30,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-wid * 0.5, 0);
    ctx.quadraticCurveTo(-wid * 0.85, -len * 0.4, 0, -len);
    ctx.quadraticCurveTo(wid * 0.85, -len * 0.4, wid * 0.5, 0);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath();
    ctx.moveTo(-wid * 0.2, 0);
    ctx.quadraticCurveTo(-wid * 0.26, -len * 0.24, 0, -len * 0.42);
    ctx.quadraticCurveTo(wid * 0.26, -len * 0.24, wid * 0.2, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ═══════════════════ particle effects ═══════════════════ */

  const FX = S.fx = {};
  const parts = [];
  const MAXP = 700;
  FX.onNote = null;

  function push(o) { if (parts.length < MAXP) parts.push(o); }

  FX.note = function (msg, kind) { if (FX.onNote) FX.onNote(msg, kind); };

  FX.clear = function () { parts.length = 0; };

  FX.exhaust = function (v, p, T, atmoF, dt) {
    if (atmoF < 0.06 || p.throttle < 0.1) return;
    if (Math.random() > dt * 40 * p.throttle) return;
    v.worldOf(p, _pw);
    const n = v.noseDir();
    const w = p.def.w;
    const sp = 22 + 40 * p.throttle;
    const jx = (Math.random() - 0.5) * w * 0.8, jy = (Math.random() - 0.5) * w * 0.8;
    push({
      x: _pw.x - n.x * p.def.h * 0.6 + jx, y: _pw.y - n.y * p.def.h * 0.6 + jy,
      vx: v.vx - n.x * sp + (Math.random() - 0.5) * 14,
      vy: v.vy - n.y * sp + (Math.random() - 0.5) * 14,
      life: 0, max: 1.1 + Math.random() * 1.4,
      r0: w * 0.45, r1: w * (2.4 + 3 * atmoF),
      col: [235, 235, 240], a0: 0.42 * atmoF, drag: 1.7, grav: 0
    });
  };

  FX.dust = function (v, b, t, speed) {
    const n = Math.min(22, 4 + speed * 1.2);
    const bp = W.bodyPos(b, t);
    const nx = (v.x - bp.x), ny = (v.y - bp.y);
    const l = Math.hypot(nx, ny) || 1;
    for (let i = 0; i < n; i++) {
      const a = (Math.random() - 0.5) * 2.4;
      const s = 4 + Math.random() * speed * 0.9;
      const dx = -ny / l, dy = nx / l;
      push({
        x: v.x, y: v.y,
        vx: v.vx * 0.2 + dx * s * Math.cos(a) + (nx / l) * s * 0.5,
        vy: v.vy * 0.2 + dy * s * Math.cos(a) + (ny / l) * s * 0.5,
        life: 0, max: 0.9 + Math.random(), r0: 0.4, r1: 4 + Math.random() * 5,
        col: [190, 180, 160], a0: 0.5, drag: 1.4, grav: 0.35
      });
    }
  };

  FX.splash = function (x, y, speed) {
    const n = Math.min(46, 8 + speed * 1.4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * U.TAU, s = 3 + Math.random() * speed * 0.7;
      push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: 0.7 + Math.random() * 0.9, r0: 0.3, r1: 1.6,
        col: [210, 240, 255], a0: 0.85, drag: 0.9, grav: 1
      });
    }
  };

  FX.smash = function (x, y, o, speed) {
    const col = o.type === 'house' || o.type === 'block' ? [200, 190, 172]
      : o.type === 'mast' ? [175, 182, 191]
        : o.type === 'rock' || o.type === 'boulder' ? [130, 126, 118] : [70, 120, 60];
    const n = Math.min(40, 10 + o.w * 1.6);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * U.TAU, s = 2 + Math.random() * Math.min(40, speed * 0.6);
      push({
        x: x + (Math.random() - 0.5) * o.w, y: y + (Math.random() - 0.5) * o.h,
        vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: 1.2 + Math.random() * 1.6,
        r0: o.w * 0.09, r1: o.w * 0.16,
        col, a0: 0.95, drag: 0.35, grav: 1
      });
    }
  };

  FX.explode = function (v) {
    const R0 = v.radius();
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * U.TAU, s = 6 + Math.random() * 70;
      const hot = i < 40;
      push({
        x: v.x + (Math.random() - 0.5) * R0, y: v.y + (Math.random() - 0.5) * R0,
        vx: v.vx * 0.5 + Math.cos(a) * s, vy: v.vy * 0.5 + Math.sin(a) * s,
        life: 0, max: hot ? 0.5 + Math.random() * 0.7 : 1.6 + Math.random() * 1.8,
        r0: R0 * 0.12, r1: R0 * (hot ? 0.6 : 1.3),
        col: hot ? [255, 190, 90] : [70, 70, 74],
        a0: hot ? 1 : 0.7, drag: 0.8, grav: hot ? 0 : 0.6
      });
    }
    if (S.audio) S.audio.boom(1.2);
  };

  FX.puff = function (x, y, r) {
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * U.TAU, s = 2 + Math.random() * 8;
      push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: 0.6 + Math.random() * 0.6, r0: r * 0.2, r1: r * 1.1,
        col: [220, 220, 226], a0: 0.6, drag: 1.2, grav: 0
      });
    }
  };

  FX.update = function (dt, t) {
    const g = { x: 0, y: 0 };
    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      p.life += dt;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      if (p.grav) {
        W.gravity(p.x, p.y, t, g);
        p.vx += g.x * p.grav * dt;
        p.vy += g.y * p.grav * dt;
      }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d; p.vy *= d;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
  };

  FX.draw = function (ctx, zoom) {
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const k = p.life / p.max;
      const r = U.lerp(p.r0, p.r1, k);
      if (r * zoom < 0.35) continue;
      ctx.globalAlpha = p.a0 * (1 - k * k);
      ctx.fillStyle = 'rgb(' + p.col[0] + ',' + p.col[1] + ',' + p.col[2] + ')';
      ctx.beginPath();
      ctx.arc(p.x - cam.x, p.y - cam.y, r, 0, U.TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  };

  FX.count = () => parts.length;

  /* ═══════════════════ map view ═══════════════════ */

  function drawMap(ctx, G, cw, ch, dpr) {
    const t = G.t, viewR = R.viewR(cw, ch);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#04060d';
    ctx.fillRect(0, 0, cw, ch);
    drawStars(ctx, cw, ch, dpr, 0.55, t, 0);

    setWorldTf(ctx, cw, ch, dpr, cam.mapZoom, 0);
    const z = cam.mapZoom;

    // Moon's orbit
    ctx.beginPath();
    ctx.arc(-cam.x, -cam.y, W.moon.orbit.a, 0, U.TAU);
    ctx.strokeStyle = 'rgba(120,150,200,.22)';
    ctx.lineWidth = 1 / z;
    ctx.stroke();

    for (const b of W.bodies) {
      const bp = W.bodyPos(b, t);
      const rx = bp.x - cam.x, ry = bp.y - cam.y;
      if (b.atmo) {
        ctx.beginPath();
        ctx.arc(rx, ry, b.radius + b.atmo.height, 0, U.TAU);
        ctx.fillStyle = 'rgba(80,150,225,.16)';
        ctx.fill();
      }
      drawOrbital(ctx, b, rx, ry, z, 1);
      if (b.soi) {
        ctx.beginPath();
        ctx.arc(rx, ry, b.soi, 0, U.TAU);
        ctx.strokeStyle = 'rgba(150,190,255,.2)';
        ctx.lineWidth = 1 / z;
        ctx.setLineDash([6 / z, 6 / z]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // predicted path
    const pr = G.path;
    if (pr && pr.pts.length > 3) {
      const rp = W.bodyPos(pr.ref, t);
      ctx.beginPath();
      for (let i = 0; i < pr.pts.length; i += 2) {
        const x = pr.pts[i] + rp.x - cam.x, y = pr.pts[i + 1] + rp.y - cam.y;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = pr.hit ? 'rgba(255,120,110,.9)' : 'rgba(120,220,160,.9)';
      ctx.lineWidth = 1.6 / z;
      ctx.stroke();
      if (pr.hit) {
        const hp = W.bodyPos(pr.hit.body, t);
        markX(ctx, pr.hit.x + hp.x - cam.x, pr.hit.y + hp.y - cam.y, 7 / z, '#ff6b60');
      }
    }

    // apoapsis / periapsis markers
    const el = G.el;
    if (el && el.e < 1 && el.e > 1e-4) {
      const bp = W.bodyPos(el.body, t);
      const el0 = Math.hypot(el.ex, el.ey) || 1;
      const ux = el.ex / el0, uy = el.ey / el0;
      apsis(ctx, bp.x + ux * el.pe - cam.x, bp.y + uy * el.pe - cam.y, z, '#8fe3b0', 'Pe');
      if (isFinite(el.ap)) apsis(ctx, bp.x - ux * el.ap - cam.x, bp.y - uy * el.ap - cam.y, z, '#7fc4ff', 'Ap');
    }

    // craft
    const v = G.focus;
    if (v) {
      const s = 6 / z;
      ctx.save();
      ctx.translate(v.x - cam.x, v.y - cam.y);
      ctx.rotate(v.angle);
      ctx.beginPath();
      ctx.moveTo(0, s * 1.5); ctx.lineTo(-s * 0.8, -s); ctx.lineTo(0, -s * 0.4); ctx.lineTo(s * 0.8, -s);
      ctx.closePath();
      ctx.fillStyle = '#ffd166';
      ctx.fill();
      ctx.restore();
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // bottom-centre: the corners belong to the throttle and the stage buttons
    ctx.font = '12px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(160,185,215,.8)';
    ctx.fillText('scale: ' + U.dist(100 / cam.mapZoom) + ' per 100 px', cw / 2, ch - 18);
    ctx.textAlign = 'left';
    void viewR;
  }

  function apsis(ctx, x, y, z, col, label) {
    const s = 4.5 / z;
    ctx.beginPath();
    ctx.arc(x, y, s, 0, U.TAU);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, s * 2.1, 0, U.TAU);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1 / z;
    ctx.stroke();
    void label;
  }

  function markX(ctx, x, y, s, col) {
    ctx.strokeStyle = col;
    ctx.lineWidth = s * 0.22;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
    ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
    ctx.stroke();
  }

  /* ═══════════════════ frame ═══════════════════ */

  R.frame = function (ctx, cw, ch, dpr, G) {
    if (cam.map) { drawMap(ctx, G, cw, ch, dpr); return; }

    const t = G.t;
    const v = G.focus;
    const atmoF = v ? W.atmoFrac(W.earth, v.altASL == null ? 1e9 : v.altASL) : 0;

    drawSky(ctx, cw, ch, dpr, atmoF);
    drawStars(ctx, cw, ch, dpr, U.clamp(1 - atmoF * 1.35, 0, 1), t, cam.rot);

    setWorldTf(ctx, cw, ch, dpr, cam.zoom, cam.rot);
    const viewR = R.viewR(cw, ch);

    for (const b of W.bodies) drawBody(ctx, b, t, cw, ch, viewR);

    for (const ves of G.vessels) if (!ves.dead) R.drawVessel(ctx, ves, t, cam.zoom);

    FX.draw(ctx, cam.zoom);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

})(window.SFS);
