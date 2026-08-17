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
    // Zoom limits are bounded by the size of the system. Letting these run to
    // 1e-7 meant you could zoom out ~800× further than anything worth looking
    // at, and it then took dozens of wheel clicks to get back.
    minZoom: 8e-6, maxZoom: 14,
    mapMin: 1.2e-5, mapMax: 0.02,
    mapDefault: 6.5e-5
  };

  /** which world is under this screen point in map view (null if none) */
  R.pickBody = function (sx, sy, cw, ch, t) {
    if (!cam.map) return null;
    const z = cam.mapZoom;
    const wx = cam.x + (sx - cw / 2) / z;
    const wy = cam.y + (ch / 2 - sy) / z;
    let best = null, bestD = Infinity;
    for (const b of W.bodies) {
      const bp = W.bodyPos(b, t);
      const d = Math.hypot(wx - bp.x, wy - bp.y);
      const reach = Math.max(b.radius * 1.4, 26 / z);
      if (d < reach && d < bestD) { bestD = d; best = b; }
    }
    return best;
  };

  /** which vessel is under this screen point in map view (null if none) —
      checked ahead of R.pickBody by the caller, since craft are the more
      specific, point-like click target */
  R.pickVessel = function (sx, sy, cw, ch, vessels) {
    if (!cam.map || !vessels) return null;
    const z = cam.mapZoom;
    const wx = cam.x + (sx - cw / 2) / z;
    const wy = cam.y + (ch / 2 - sy) / z;
    let best = null, bestD = Infinity;
    for (const ves of vessels) {
      if (ves.dead) continue;
      const d = Math.hypot(wx - ves.x, wy - ves.y);
      const reach = Math.max(ves.radius() * 3, 14 / z);
      if (d < reach && d < bestD) { bestD = d; best = ves; }
    }
    return best;
  };

  /** main.js hands us the canvas size so callers that don't already have it
      on hand (e.g. flight.js's off-screen checks) can still ask for it */
  R.setSize = function (w, h) { R._cw = w; R._ch = h; };

  R.viewR = function (cw, ch) {
    cw = cw || R._cw || 0; ch = ch || R._ch || 0;
    return 0.5 * Math.hypot(cw, ch) / (cam.map ? cam.mapZoom : cam.zoom);
  };

  R.zoomBy = function (f) {
    if (cam.map) {
      // the map spans planet-to-planet distances, so the same wheel/pinch
      // step that feels right up close made the map lurch — soften it here
      // rather than in every caller
      const soft = Math.pow(f, 0.45);
      // recover if it ever got stuck at zero or NaN, otherwise multiplying
      // by the wheel factor can never climb back out
      let z = cam.mapZoomT;
      if (!isFinite(z) || z <= 0) z = cam.mapDefault;
      cam.mapZoomT = U.clamp(z * soft, cam.mapMin, cam.mapMax);
    } else {
      let z = cam.zoomT;
      if (!isFinite(z) || z <= 0) z = 4;
      cam.zoomT = U.clamp(z * f, cam.minZoom, cam.maxZoom);
    }
  };

  R.follow = function (v, t, dt, snap) {
    if (!v) return;
    if (cam.map) {
      // map view is north-up and drag-pannable
      cam.x = v.x + cam.offX;
      cam.y = v.y + cam.offY;
      if (!isFinite(cam.mapZoomT) || cam.mapZoomT <= 0) cam.mapZoomT = cam.mapDefault;
      if (!isFinite(cam.mapZoom) || cam.mapZoom <= 0) cam.mapZoom = cam.mapZoomT;
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
    // The band is widened at low zoom so it stays visible, but it must never
    // grow past the globe itself — that drives the arc radius negative and
    // canvas throws IndexSizeError.
    const band = Math.min(Math.max(Rr * 0.062, 1.5 / zoom), Rr * 0.9);
    const rMid = Math.max(Rr * 0.05, Rr - band / 2);
    const N = Math.round(U.clamp(Rr * zoom * 1.2, 128, 720));
    const dth = U.TAU / N;
    ctx.lineWidth = band;
    ctx.lineCap = 'butt';
    let start = 0, mat = matAt(b, 0, dth);
    for (let i = 1; i <= N; i++) {
      const m = i < N ? matAt(b, (i / N) * U.TAU, dth) : null;
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
  function matAt(b, th, dth) {
    const r = W.terrain(b, th, dth);
    if (!b.sea) return r > b.seaLevel + 900 ? b.col.rock : b.col.land;
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
    const dth = span / n;                 // band-limit detail to what we sample

    const th = new Float64Array(n + 1);
    const rr = new Float64Array(n + 1);
    const px = new Float64Array(n + 1);
    const py = new Float64Array(n + 1);
    let minR = Infinity;
    for (let i = 0; i <= n; i++) {
      const a = th0 + (span * i) / n;
      const r = W.terrain(b, a, dth);
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
    if (v.heatGlow > 0.08) drawPlasma(ctx, v, t, zoom);
  };

  /** shock-heated air piling up on the windward face during a hot re-entry */
  function drawPlasma(ctx, v, t, zoom) {
    const R0 = v.radius();
    if (R0 * zoom < 1.6) return;
    const k = U.clamp(v.heatGlow / 0.6, 0, 1);
    const sp = Math.hypot(v.vx, v.vy) || 1;
    const ux = v.vx / sp, uy = v.vy / sp;         // the air arrives from here
    const cx = v.x - cam.x + ux * R0 * 0.7;
    const cy = v.y - cam.y + uy * R0 * 0.7;
    const rr = R0 * (0.6 + 0.5 * k) * (0.94 + 0.06 * Math.sin(t * 29));
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, rr);
    g.addColorStop(0, 'rgba(255,248,232,' + (0.45 * k).toFixed(3) + ')');
    g.addColorStop(0.34, 'rgba(255,168,78,' + (0.36 * k).toFixed(3) + ')');
    g.addColorStop(1, 'rgba(255,86,28,0)');
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(cx, cy);
    // squashed along the flow and spread across it, the way a bow shock sits
    ctx.rotate(Math.atan2(uy, ux));
    ctx.scale(0.7, 1.3);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, rr, 0, U.TAU);
    ctx.fill();
    ctx.restore();
  }

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
  // Smoke now lingers and keeps billowing for up to a minute (see FX.exhaust),
  // so the budget has to be big enough to hold a full minute of trail instead
  // of just a few seconds of it.
  const MAXP = 6000;
  FX.onNote = null;

  function push(o) {
    if (o.bounce == null) o.bounce = 0;      // how much it rebounds off the ground
    if (o.gdrag == null) o.gdrag = 0.90;     // how fast it slows once it's down
    // At the budget, retire the oldest rather than refusing the newest.
    // Otherwise a heavy smoker starves its own plume at the nozzle and the
    // trail is made entirely of stale puffs.
    if (parts.length >= MAXP) parts.shift();
    parts.push(o);
  }

  /**
   * Puff radius over its life. Smoke billows out fast the moment it leaves the
   * nozzle and then keeps drifting, so growth is front-loaded — linear growth
   * left a thin gap right behind the rocket.
   */
  function radiusOf(p) {
    return U.lerp(p.r0, p.r1, Math.sqrt(p.life / p.max));
  }

  FX.note = function (msg, kind) { if (FX.onNote) FX.onNote(msg, kind); };

  FX.clear = function () { parts.length = 0; };

  FX.exhaust = function (v, p, T, atmoF, dt, groundAlt) {
    if (p.throttle < 0.1) return;
    // solid motors carry their own oxidiser and belch aluminium-oxide smoke,
    // so they keep smoking thickly even where the air is thin
    const sm = (p.def.engine && p.def.engine.smoke) || 1;
    const thick = sm > 1;
    if (!thick && atmoF < 0.06) return;
    const dens = thick ? Math.max(atmoF, 0.55) : atmoF;

    // Emit a *count*, not a coin flip — a single spawn per call silently
    // capped a 6× smoker at 1× no matter what the multiplier said.
    const want = dt * 48 * (thick ? Math.sqrt(sm) * 1.15 : 1) * p.throttle;
    let count = Math.floor(want);
    if (Math.random() < want - count) count++;
    if (!count) return;

    v.worldOf(p, _pw);
    const n = v.noseDir();
    const w = p.def.w;
    const sp = 22 + 40 * p.throttle;
    const spread = w * (thick ? 1.7 : 0.8);
    const scatter = thick ? 32 : 14;

    // On the pad the plume has nowhere to go but sideways. Left alone, every
    // puff follows the same exhaust jet down into the same patch of ground
    // and piles into one clump under the rocket — real ground-hugging exhaust
    // fans out into a broad, low cloud instead. Fade this out by ~150 m so
    // ordinary ascent/in-flight smoke is untouched.
    const ground = groundAlt == null ? 0 : U.clamp(1 - groundAlt / 150, 0, 1);

    for (let i = 0; i < count; i++) {
      const jx = (Math.random() - 0.5) * spread, jy = (Math.random() - 0.5) * spread;
      // stagger along the exhaust so a burst doesn't land as one clump
      const back = p.def.h * 0.6 + Math.random() * w * 1.2;
      // each puff picks its own outward direction to roll away across the
      // pad, rather than all of them riding the jet straight down together
      const fanA = Math.random() * U.TAU;
      const fan = ground * (16 + 46 * Math.random());
      push({
        x: _pw.x - n.x * back + jx, y: _pw.y - n.y * back + jy,
        vx: v.vx - n.x * sp + (Math.random() - 0.5) * scatter + Math.cos(fanA) * fan,
        vy: v.vy - n.y * sp + (Math.random() - 0.5) * scatter + Math.sin(fanA) * fan,
        // billows for about a minute, still slowly swelling the whole time,
        // before it's finally cleared
        life: 0, max: 54 + Math.random() * 12,
        r0: w * (thick ? 1.1 : 0.6), r1: w * (2.8 + 3.4 * dens) * (thick ? 2.6 : 1.15),
        col: thick ? [246, 244, 240] : [235, 235, 240],
        a0: (thick ? 0.34 : 0.30) * dens,
        // near the ground the fan-out needs to survive long enough to actually
        // spread the puffs apart before friction settles them
        drag: U.lerp(0.85, 0.5, ground), grav: 0,
        gdrag: U.lerp(0.94, 0.985, ground), bounce: 0
      });
    }
  };

  /**
   * The burning trail a craft drags behind it while friction heating is
   * cooking the hull. `k` is 0..1 hot; physics.js drives it every step.
   */
  FX.reentry = function (v, k, dt) {
    const want = dt * 46 * k;
    let n = Math.floor(want);
    if (Math.random() < want - n) n++;
    if (!n) return;
    const sp = Math.hypot(v.vx, v.vy) || 1;
    const ux = v.vx / sp, uy = v.vy / sp;
    const R0 = v.radius();
    for (let i = 0; i < n; i++) {
      const j = (Math.random() - 0.5) * R0 * 1.3;
      const back = 30 + Math.random() * 90;
      push({
        x: v.x + ux * R0 * 0.35 - uy * j,
        y: v.y + uy * R0 * 0.35 + ux * j,
        vx: v.vx * 0.6 - ux * back, vy: v.vy * 0.6 - uy * back,
        life: 0, max: 0.45 + Math.random() * 1.1,
        r0: R0 * 0.14, r1: R0 * (0.5 + Math.random() * 0.9),
        col: Math.random() < 0.55 ? [255, 214, 138] : [255, 138, 58],
        a0: 0.55 * k, drag: 1.1, grav: 0, gdrag: 0.9, bounce: 0
      });
    }
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
        life: 0, max: 2.6 + Math.random() * 2.2, r0: 0.4, r1: 5 + Math.random() * 6,
        col: [190, 180, 160], a0: 0.5, drag: 1.1, grav: 0.35,
        gdrag: 0.88, bounce: 0.08
      });
    }
  };

  FX.splash = function (x, y, speed) {
    const n = Math.min(46, 8 + speed * 1.4);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * U.TAU, s = 3 + Math.random() * speed * 0.7;
      push({
        x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: 1.4 + Math.random() * 1.4, r0: 0.3, r1: 1.9,
        col: [210, 240, 255], a0: 0.85, drag: 0.9, grav: 1,
        gdrag: 0.6, bounce: 0.25
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
        life: 0, max: 2.6 + Math.random() * 2.4,
        r0: o.w * 0.09, r1: o.w * 0.16,
        col, a0: 0.95, drag: 0.35, grav: 1,
        gdrag: 0.55, bounce: 0.32
      });
    }
  };

  FX.explode = function (v) {
    const R0 = v.radius();

    // fireball — the fast, bright core of the blast
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * U.TAU, s = 20 + Math.random() * 110;
      push({
        x: v.x + (Math.random() - 0.5) * R0, y: v.y + (Math.random() - 0.5) * R0,
        vx: v.vx * 0.5 + Math.cos(a) * s, vy: v.vy * 0.5 + Math.sin(a) * s,
        life: 0, max: 0.6 + Math.random() * 0.8,
        r0: R0 * 0.12, r1: R0 * 0.65,
        col: [255, 190, 90], a0: 1, drag: 0.8, grav: 0,
        gdrag: 0.9, bounce: 0
      });
    }

    // sparks — a quick shower of embers flung clear of the fireball
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * U.TAU, s = 70 + Math.random() * 190;
      push({
        x: v.x + (Math.random() - 0.5) * R0 * 0.6, y: v.y + (Math.random() - 0.5) * R0 * 0.6,
        vx: v.vx * 0.5 + Math.cos(a) * s, vy: v.vy * 0.5 + Math.sin(a) * s,
        life: 0, max: 0.25 + Math.random() * 0.55,
        r0: R0 * 0.03, r1: R0 * 0.09,
        col: [255, 235, 180], a0: 1, drag: 1.4, grav: 0.4,
        gdrag: 0.9, bounce: 0.2
      });
    }

    // smoke — a big, dark, slow-rising column that lingers long after the
    // fire has died down, so the wreck keeps smouldering on screen
    for (let i = 0; i < 90; i++) {
      const a = Math.random() * U.TAU, s = 4 + Math.random() * 36;
      const dark = Math.random() < 0.55;
      push({
        x: v.x + (Math.random() - 0.5) * R0 * 1.4, y: v.y + (Math.random() - 0.5) * R0 * 1.4,
        vx: v.vx * 0.5 + Math.cos(a) * s, vy: v.vy * 0.5 + Math.sin(a) * s,
        life: 0, max: 6 + Math.random() * 7,
        r0: R0 * 0.2, r1: R0 * (2.4 + Math.random() * 1.4),
        col: dark ? [35, 33, 32] : [95, 92, 88],
        a0: 0.82, drag: 0.55, grav: -0.14,      // negative grav: the plume billows upward, not down
        gdrag: 0.9, bounce: 0
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

  /**
   * Advance particles. `body` is the world whose surface they can land on —
   * smoke, dust and debris pile up on the ground (or the sea) instead of
   * sinking through it.
   */
  FX.update = function (dt, t, body) {
    const g = { x: 0, y: 0 };
    const bp = body ? W.bodyPos(body, t) : null;
    // only bother with terrain for particles actually near the surface
    const nearR = body ? body.radius + 5000 : 0;

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

      if (!bp) continue;
      const dx = p.x - bp.x, dy = p.y - bp.y;
      const r = Math.hypot(dx, dy);
      if (r > nearR || r < 1) continue;
      const th = Math.atan2(dy, dx);
      let gr = W.terrain(body, th);
      if (body.sea && gr < body.seaLevel) gr = body.seaLevel;   // rest on the water
      // sit the puff *on* the surface, not centred in it — and keep doing so as
      // it swells, otherwise a growing cloud sinks back into the ground
      const rest = gr + radiusOf(p) * 0.55;
      if (r >= rest) continue;

      const nx = dx / r, ny = dy / r;
      p.x = bp.x + nx * rest;
      p.y = bp.y + ny * rest;
      const vn = p.vx * nx + p.vy * ny;
      if (vn < 0) {
        // kill the into-ground component, keep a little rebound
        p.vx -= vn * nx * (1 + p.bounce);
        p.vy -= vn * ny * (1 + p.bounce);
      }
      if (!p.hitGround) {
        // first touch: throw it sideways so the plume rolls out across the pad
        // instead of every puff stacking up on the same spot
        p.hitGround = true;
        const side = Math.random() < 0.5 ? 1 : -1;
        const kick = (5 + Math.random() * 20) * side;
        p.vx += -ny * kick; p.vy += nx * kick;
      }
      // scrub off sideways speed so it settles and spreads out
      const k = Math.pow(p.gdrag, dt * 60);
      p.vx *= k; p.vy *= k;
    }
  };

  FX.draw = function (ctx, zoom, viewR) {
    const cull = viewR ? viewR * 1.4 : Infinity;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const k = p.life / p.max;
      const r = radiusOf(p);
      if (r * zoom < 0.35) continue;
      const dx = p.x - cam.x, dy = p.y - cam.y;
      if (Math.abs(dx) - r > cull || Math.abs(dy) - r > cull) continue;
      // hold opacity through most of the life, then fade — a squared falloff
      // made the trail wash out while it was still close behind the rocket
      ctx.globalAlpha = p.a0 * (1 - k * k * k);
      ctx.fillStyle = 'rgb(' + p.col[0] + ',' + p.col[1] + ',' + p.col[2] + ')';
      ctx.beginPath();
      ctx.arc(dx, dy, r, 0, U.TAU);
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

    // planned transfer: the burn node and where it takes us
    const plan = G.plan;
    if (plan && plan.ok && plan.pts && plan.pts.length > 3) {
      ctx.beginPath();
      for (let i = 0; i < plan.pts.length; i += 2) {
        const x = plan.pts[i] - cam.x, y = plan.pts[i + 1] - cam.y;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(255,190,90,.95)';
      ctx.lineWidth = 1.8 / z;
      ctx.setLineDash([9 / z, 6 / z]);
      ctx.stroke();
      ctx.setLineDash([]);
      // burn node
      const bx = plan.burnX - cam.x, by = plan.burnY - cam.y;
      const s = 6 / z;
      ctx.beginPath();
      ctx.arc(bx, by, s, 0, U.TAU);
      ctx.fillStyle = '#ffbe5a';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx, by, s * 2.2, 0, U.TAU);
      ctx.strokeStyle = 'rgba(255,190,90,.8)';
      ctx.lineWidth = 1.4 / z;
      ctx.stroke();
    }

    // whatever we're aiming at — a world, or (for a rendezvous) a live vessel,
    // duck-typed apart by the presence of .parts (only vessels have those)
    if (G.target) {
      const isVes = !!G.target.parts;
      const tp = isVes ? { x: G.target.x, y: G.target.y } : W.bodyPos(G.target, t);
      const rr = isVes ? Math.max(G.target.radius() * 3, 16 / z) : Math.max(G.target.radius * 1.5, 16 / z);
      ctx.beginPath();
      ctx.arc(tp.x - cam.x, tp.y - cam.y, rr, 0, U.TAU);
      ctx.strokeStyle = 'rgba(255,190,90,.9)';
      ctx.lineWidth = 1.6 / z;
      ctx.setLineDash([5 / z, 5 / z]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // every other vessel in the world — other missions and junk alike, each
    // with whatever path F.predictOthers() last cached for it. Missions get a
    // brighter path + a label; junk is dimmer and unlabeled to stay out of the way.
    if (G.vessels) {
      const focus = G.focus;
      for (const ves of G.vessels) {
        if (ves === focus || ves.dead) continue;
        const isMission = !!ves.mission;
        const pr = ves.path;
        if (pr && pr.pts && pr.pts.length > 3) {
          const rp = W.bodyPos(pr.ref, t);
          ctx.beginPath();
          for (let i = 0; i < pr.pts.length; i += 2) {
            const x = pr.pts[i] + rp.x - cam.x, y = pr.pts[i + 1] + rp.y - cam.y;
            if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = isMission ? 'rgba(120,180,255,.5)' : 'rgba(150,150,150,.26)';
          ctx.lineWidth = (isMission ? 1.2 : 0.8) / z;
          ctx.stroke();
        }
        const s = (isMission ? 5.5 : 4.5) / z;
        ctx.save();
        ctx.translate(ves.x - cam.x, ves.y - cam.y);
        ctx.rotate(ves.angle);
        ctx.beginPath();
        ctx.moveTo(0, s * 1.5); ctx.lineTo(-s * 0.8, -s); ctx.lineTo(0, -s * 0.4); ctx.lineTo(s * 0.8, -s);
        ctx.closePath();
        ctx.fillStyle = isMission ? 'rgba(127,196,255,.95)' : 'rgba(138,143,154,.55)';
        ctx.fill();
        ctx.restore();
        if (isMission && ves.mission.name) {
          ctx.save();
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const sx = (ves.x - cam.x) * z + cw / 2, sy = -(ves.y - cam.y) * z + ch / 2;
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillStyle = 'rgba(180,210,255,.85)';
          ctx.textAlign = 'center';
          ctx.fillText(ves.mission.name, sx, sy - 10);
          ctx.restore();
          setWorldTf(ctx, cw, ch, dpr, z, 0);
        }
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

  /**
   * Prograde marker: an arrow parked partway out from the centre pointing the
   * way the craft is actually travelling, with the speed printed above it.
   * Speed is relative to the body below, matching the HUD readout.
   */
  function drawVelocityMarker(ctx, cw, ch, dpr, G) {
    const v = G.focus;
    if (!v) return;
    const b = v.nearBody || W.earth;
    const bv = W.bodyVel(b, G.t);
    const rvx = v.vx - bv.x, rvy = v.vy - bv.y;
    const spd = Math.hypot(rvx, rvy);
    if (spd < 1.5) return;

    // world direction → screen direction through the camera rotation
    const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
    let sx = c * rvx - s * rvy;
    let sy = -(s * rvx + c * rvy);
    const l = Math.hypot(sx, sy) || 1;
    sx /= l; sy /= l;

    const rad = Math.min(cw, ch) * 0.30;      // well inside the screen edge
    const px = cw / 2 + sx * rad, py = ch / 2 + sy * rad;
    const ang = Math.atan2(sy, sx);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // arrow
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(15, 0);
    ctx.lineTo(-7, -9);
    ctx.lineTo(-3, 0);
    ctx.lineTo(-7, 9);
    ctx.closePath();
    ctx.fillStyle = 'rgba(140,225,180,.95)';
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(10,20,16,.75)';
    ctx.stroke();
    // tail, pointing back at the craft
    ctx.beginPath();
    ctx.moveTo(-9, 0);
    ctx.lineTo(-24, 0);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(140,225,180,.45)';
    ctx.stroke();
    ctx.restore();

    // speed label, always upright and above the arrow
    const txt = U.speed(spd);
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(txt).width;
    const ty = py - 22;
    ctx.fillStyle = 'rgba(8,14,22,.82)';
    U.roundRect(ctx, px - tw / 2 - 7, ty - 10, tw + 14, 20, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,225,180,.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#d6f7e4';
    ctx.fillText(txt, px, ty);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
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

    FX.draw(ctx, cam.zoom, viewR);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawVelocityMarker(ctx, cw, ch, dpr, G);
  };

})(window.SFS);
