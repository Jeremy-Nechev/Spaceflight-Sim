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

  /* ── colour mixing ──
     U.mix only speaks '#rrggbb' and hands back 'rgb()', which is no use when a
     colour has to be blended three or four times over (sky → dusk → cloud →
     smog). These work in [r,g,b] and only stringify at the end. */
  const _rgbCache = new Map();
  function rgb(c) {
    let v = _rgbCache.get(c);
    if (v) return v;
    v = c.charAt(0) === '#'
      ? [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]
      : c.slice(c.indexOf('(') + 1, c.indexOf(')')).split(',').map(Number);
    _rgbCache.set(c, v);
    return v;
  }
  function mixRGB(a, b, t) {
    if (typeof a === 'string') a = rgb(a);
    if (typeof b === 'string') b = rgb(b);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  function css(c) {
    return 'rgb(' + Math.round(c[0]) + ',' + Math.round(c[1]) + ',' + Math.round(c[2]) + ')';
  }
  function shade(c, k) {
    if (typeof c === 'string') c = rgb(c);
    return [c[0] * k, c[1] * k, c[2] * k];
  }

  const NIGHT_SKY = '#05070f';
  const NIGHT_GROUND = [7, 11, 26];      // what the land fades towards after dark

  // How lit the scene being drawn is, and what is falling out of its sky.
  // drawSurface sets these before it draws the ground so the scenery artwork
  // (city windows, in particular) can light up after dark without every
  // routine having to be handed the clock.
  const scene = { day: 1, dusk: 0, wx: W.CALM };

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
    // the map has to be able to hold the whole system in view now, so it zooms
    // out roughly an order of magnitude further than the Earth–Moon days needed
    mapMin: 5e-7, mapMax: 0.02,
    mapDefault: 6.5e-5,
    // set once the player has zoomed or panned the map themselves: from then
    // on the map reopens exactly where they left it, rather than being
    // re-framed for them every time
    mapSet: false
  };

  // The point the map is being zoomed about, in world coordinates, held while
  // the zoom eases toward its target so the spot under the cursor stays put
  // for the whole animation rather than just the first frame of it.
  let zAnchor = null;

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

  /** screen point → world point, through whichever camera is live */
  R.screenToWorld = function (sx, sy, cw, ch) {
    const z = cam.map ? cam.mapZoom : cam.zoom;
    const u = (sx - cw / 2) / z, w = (sy - ch / 2) / z;
    if (cam.map) return { x: cam.x + u, y: cam.y - w };
    // the close-up transform is its own inverse (see setWorldTf): a rotation
    // composed with a y-flip
    const c = Math.cos(cam.rot), s = Math.sin(cam.rot);
    return { x: cam.x + c * u - s * w, y: cam.y - s * u - c * w };
  };

  /** which part of which craft sits under this screen point, close up */
  R.pickPart = function (sx, sy, cw, ch, vessels) {
    if (cam.map || !vessels) return null;
    const w = R.screenToWorld(sx, sy, cw, ch);
    const pad = Math.min(1.2, 8 / cam.zoom);          // a little slack for fat fingers
    for (const ves of vessels) {
      if (ves.dead) continue;
      if (Math.hypot(w.x - ves.x, w.y - ves.y) > ves.radius() + pad) continue;
      const ca = Math.cos(ves.angle), sa = Math.sin(ves.angle);
      const dx = w.x - ves.x, dy = w.y - ves.y;
      const lx = dx * ca + dy * sa + ves.com.x;       // world → the craft's own axes
      const ly = -dx * sa + dy * ca + ves.com.y;
      // take the part the point sits deepest inside, not merely the first one
      // it grazes — with any slack at all a tall neighbour swallows the click
      let best = null, bestScore = Infinity;
      for (const p of ves.parts) {
        const ex = Math.abs(lx - p.lx) - p.def.w / 2;
        const ey = Math.abs(ly - p.ly) - p.def.h / 2;
        if (ex > pad || ey > pad) continue;
        const score = Math.max(ex, ey);              // negative ⇒ genuinely inside
        if (score < bestScore) { bestScore = score; best = p; }
      }
      if (best) return { ves, part: best };
    }
    return null;
  };

  /** main.js hands us the canvas size so callers that don't already have it
      on hand (e.g. flight.js's off-screen checks) can still ask for it */
  R.setSize = function (w, h) { R._cw = w; R._ch = h; };

  R.viewR = function (cw, ch) {
    cw = cw || R._cw || 0; ch = ch || R._ch || 0;
    return 0.5 * Math.hypot(cw, ch) / (cam.map ? cam.mapZoom : cam.zoom);
  };

  // every wheel notch / pinch step is taken to this power, so a quarter of the
  // zoom happens per input — fine control beats racing to the limits
  const ZOOM_STEP = 0.5;

  /**
   * Zoom about a screen point — the map is pannable, so a wheel over the far
   * side of a planet should pull *that* toward you, not the craft.
   * `sx`/`sy` optional; without them this is R.zoomBy.
   */
  R.zoomAt = function (f, sx, sy, cw, ch) {
    if (cam.map && sx != null) {
      const w = R.screenToWorld(sx, sy, cw, ch);
      zAnchor = { sx: sx, sy: sy, cw: cw, ch: ch, x: w.x, y: w.y };
    }
    R.zoomBy(f);
  };

  /** drop the zoom anchor — panning takes over from here */
  R.dropAnchor = function () { zAnchor = null; };

  /**
   * Frame the map on whatever world the craft is at: its own planet or moon
   * and the orbit around it, not the whole solar system. (The distance from
   * the *origin* used to stand in for this, which was the same thing back when
   * Earth sat at the origin and is now the width of Earth's orbit.)
   */
  R.frameOn = function (v, t, cw, ch) {
    const b = (v && (v.nearBody || W.soiBody(v.x, v.y, t))) || W.earth;
    const bp = W.bodyPos(b, t);
    const d = v ? Math.hypot(v.x - bp.x, v.y - bp.y) : b.radius * 3;
    const r = Math.max(b.radius * 2.4, d * 1.8);
    const scr = Math.max(320, Math.min(cw || R._cw || 800, ch || R._ch || 450));
    cam.mapZoomT = cam.mapZoom = U.clamp((0.42 * scr) / r, cam.mapMin, cam.mapMax);
    zAnchor = null;
  };

  R.zoomBy = function (f) {
    if (cam.map) {
      cam.mapSet = true;
      // the map spans planet-to-planet distances, so the same wheel/pinch
      // step that feels right up close made the map lurch — soften it here
      // rather than in every caller
      const soft = Math.pow(f, 0.45 * ZOOM_STEP);
      // recover if it ever got stuck at zero or NaN, otherwise multiplying
      // by the wheel factor can never climb back out
      let z = cam.mapZoomT;
      if (!isFinite(z) || z <= 0) z = cam.mapDefault;
      cam.mapZoomT = U.clamp(z * soft, cam.mapMin, cam.mapMax);
    } else {
      let z = cam.zoomT;
      if (!isFinite(z) || z <= 0) z = 4;
      cam.zoomT = U.clamp(z * Math.pow(f, ZOOM_STEP), cam.minZoom, cam.maxZoom);
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
      // hold the zoomed-about point under the cursor as the zoom eases in
      if (zAnchor) {
        const now = R.screenToWorld(zAnchor.sx, zAnchor.sy, zAnchor.cw, zAnchor.ch);
        const ddx = zAnchor.x - now.x, ddy = zAnchor.y - now.y;
        cam.offX += ddx; cam.offY += ddy;
        cam.x += ddx; cam.y += ddy;
        if (Math.abs(cam.mapZoom - cam.mapZoomT) < cam.mapZoomT * 0.002) zAnchor = null;
      }
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

  function drawSky(ctx, cw, ch, dpr, atmoF, body, th, t) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (atmoF <= 0.001) {
      ctx.fillStyle = NIGHT_SKY;
      ctx.fillRect(0, 0, cw, ch);
      return;
    }
    // atmoF falls off linearly with altitude and still reaches zero exactly at
    // the top of the atmosphere, so "space starts here" hasn't moved. What the
    // exponents do is bend the *colour* down faster than the altitude: raising
    // them (they used to be well under 1, which held the sky bright almost all
    // the way up) darkens the whole upper half of the climb into a long,
    // gradual fade instead of a bright sky that snaps to black near the top.
    // The horizon glow fades slowest, which is how a real high-altitude sky
    // looks — dark overhead, a bright band still hugging the limb.
    const c = (body || W.earth).col;
    const day = scene.day, dusk = scene.dusk, wx = scene.wx;

    // Daylight scales the whole sky, so the same gradient carries a blue noon,
    // a deep blue-grey night, and everything between. Dusk lays a warm band
    // over the bottom of it — brightest right as the sun crosses the horizon,
    // and strongest low down, which is where a sunset actually lives.
    let hi = mixRGB(NIGHT_SKY, c.skyHi, Math.pow(atmoF, 2.6) * (0.07 + 0.93 * day));
    let mid = mixRGB(NIGHT_SKY, c.sky, Math.pow(atmoF, 2.0) * (0.05 + 0.95 * day));
    let lo = mixRGB(NIGHT_SKY, c.glow, Math.pow(atmoF, 1.3) * (0.04 + 0.96 * day));
    if (dusk > 0.01) {
      hi = mixRGB(hi, '#3b2c5e', dusk * 0.45 * atmoF);
      mid = mixRGB(mid, '#d05f33', dusk * 0.62 * atmoF);
      lo = mixRGB(lo, '#ff8a3c', dusk * 0.92 * atmoF);
    }
    // cloud greys the sky out, a storm makes it properly gloomy, and city
    // smog puts a brown cast over the lot
    const grey = U.clamp(wx.cover * 0.34 + wx.storm * 0.62, 0, 0.9) * atmoF;
    if (grey > 0.01) {
      // an overcast day is bright and flat; a thunderstorm is dark even at noon
      const gc = mixRGB('#20242c', '#9aa3ad', day * (1 - wx.storm * 0.8));
      hi = mixRGB(hi, gc, grey); mid = mixRGB(mid, gc, grey * 0.9); lo = mixRGB(lo, gc, grey * 0.7);
    }
    if (wx.smog > 0.02) {
      const sc = mixRGB('#241d16', '#c2a173', day);
      const k = wx.smog * 0.55 * atmoF;
      mid = mixRGB(mid, sc, k * 0.8); lo = mixRGB(lo, sc, k);
    }

    const g = ctx.createLinearGradient(0, 0, 0, ch);
    g.addColorStop(0, css(hi));
    g.addColorStop(0.62, css(mid));
    g.addColorStop(1, css(lo));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, cw, ch);
  }

  /**
   * The sun itself, hanging in the sky at the right place for the time of day.
   * Screen-space: the close-up camera keeps the local vertical pointing up, so
   * the sun's hour angle maps straight onto a track across the screen.
   */
  function drawSunInSky(ctx, cw, ch, dpr, body, th, t, atmoF) {
    if (atmoF < 0.02) return;
    const d = U.wrap(W.sunAngle(body, t) - th);          // 0 overhead, ±π/2 horizon
    const el = Math.cos(d);
    if (el < -0.16) return;                              // well down: nothing to draw
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // el = 0 puts the disc down on the horizon line, el = 1 overhead
    const x = cw / 2 - Math.sin(d) * cw * 0.42;
    const y = ch * (0.82 - el * 0.76);
    const r = Math.max(9, Math.min(cw, ch) * 0.026);
    // low sun reddens and the disc swells, the way it does through thick air
    const warm = U.clamp(1 - el * 2.2, 0, 1);
    const core = css(mixRGB('#fff6d8', '#ff9040', warm));
    // thick cloud hides the sun completely — you should not be able to pick it
    // out of a thunderstorm
    const seen = U.clamp((el + 0.16) / 0.18, 0, 1) * atmoF *
      U.clamp(1 - scene.wx.cover * 1.05 - scene.wx.storm * 0.6, 0, 1);
    if (seen <= 0.01) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = seen * 0.5;
    const g = ctx.createRadialGradient(x, y, r * 0.3, x, y, r * (4 + warm * 4));
    g.addColorStop(0, core);
    g.addColorStop(0.14, css(mixRGB('#ffe9a8', '#ff7a2a', warm)));
    g.addColorStop(1, 'rgba(255,150,60,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r * (4 + warm * 4), 0, U.TAU);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = seen;
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, U.TAU);
    ctx.fill();
    ctx.restore();
  }

  /* ═══════════════════ weather on screen ═══════════════════ */

  // rain and snow are drawn in screen space: at any sensible zoom a raindrop is
  // far too small to place in the world, and what the player wants is the sense
  // of flying through it
  const drops = [];
  let lightning = 0, lightningIn = 6;

  function drawPrecip(ctx, cw, ch, dpr, t, dt, alt, wind) {
    const wx = scene.wx;
    const fall = wx.rain + wx.snow;
    // only inside the weather layer, and not once you are above the cloud tops
    const near = U.clamp(1 - (alt - 6000) / 5000, 0, 1);
    const k = fall * near;
    if (k <= 0.02) { drops.length = 0; return; }
    const snowy = wx.snow > wx.rain;
    const want = Math.round(U.clamp(k * (snowy ? 220 : 420), 0, 460));
    while (drops.length < want) {
      drops.push({ x: Math.random() * cw, y: Math.random() * ch, s: 0.6 + Math.random() * 0.8,
        w: Math.random() });
    }
    if (drops.length > want) drops.length = want;

    // the wind blows the fall sideways — the same wind the craft is fighting
    const slant = U.clamp(wind / (snowy ? 6 : 28), -2.2, 2.2);
    const vy = snowy ? 90 : 620;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = snowy ? 'rgba(240,248,255,.9)' : 'rgba(205,226,250,.75)';
    ctx.fillStyle = 'rgba(245,250,255,.9)';
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i];
      d.y += vy * d.s * dt;
      d.x += slant * vy * d.s * dt * 0.5 + (snowy ? Math.sin(t * 1.7 + d.w * 9) * 14 * dt * 60 * 0.02 : 0);
      if (d.y > ch) { d.y = -8; d.x = Math.random() * cw; }
      if (d.x < -20) d.x += cw + 40; else if (d.x > cw + 20) d.x -= cw + 40;
      if (snowy) {
        ctx.moveTo(d.x + 1.4 * d.s, d.y);
        ctx.arc(d.x, d.y, 1.4 * d.s, 0, U.TAU);
      } else {
        const L = 13 * d.s;
        ctx.moveTo(d.x, d.y);
        ctx.lineTo(d.x + slant * L * 0.5, d.y + L);
      }
    }
    if (snowy) ctx.fill(); else ctx.stroke();
  }

  /** the odd flash of lightning inside a thunderstorm */
  function drawLightning(ctx, cw, ch, dpr, dt, alt) {
    const st = scene.wx.storm * U.clamp(1 - (alt - 9000) / 6000, 0, 1);
    if (st < 0.25) { lightning = 0; return; }
    lightningIn -= dt * st;
    if (lightningIn <= 0) { lightning = 0.16; lightningIn = 3 + Math.random() * 9; }
    if (lightning <= 0) return;
    lightning -= dt;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(226,238,255,' + (0.42 * U.clamp(lightning / 0.16, 0, 1)).toFixed(3) + ')';
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
    if (dc - outer > viewR * (b.star ? 6 : 1.7)) return;   // a star's glare reaches further

    if (b.star) { drawStar(ctx, b, rx, ry, zoom, t); return; }

    // on-screen but sub-pixel: render as a lit dot instead
    if (b.radius * zoom < 2.2) { drawFarBody(ctx, b, rx, ry, zoom); return; }

    const halfAng = Math.min(Math.PI, (viewR / b.radius) * 1.7 + 0.02);
    const thC = Math.atan2(-ry, -rx);        // direction from body centre to camera
    const orbK = smoothstep(0.30, 0.46, halfAng);

    if (b.atmo) drawAtmosphere(ctx, b, rx, ry, zoom, viewR);
    if (orbK > 0.01) drawOrbital(ctx, b, rx, ry, zoom, orbK, t);
    if (orbK < 0.99) drawSurface(ctx, b, t, rx, ry, thC, halfAng, zoom, viewR, 1 - orbK);
  }

  /**
   * The Sun: a white-hot disc with a corona that keeps bleeding outward well
   * past the surface, so it still reads as a star when it is only a few pixels
   * across and blinding when you are close enough to be in trouble.
   */
  function drawStar(ctx, b, rx, ry, zoom, t) {
    const R0 = Math.max(b.radius, 2.5 / zoom);       // never smaller than a dot
    const flare = R0 * (3.2 + 0.06 * Math.sin(t * 0.7));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createRadialGradient(rx, ry, R0 * 0.2, rx, ry, flare);
    g.addColorStop(0, 'rgba(255,252,235,1)');
    g.addColorStop(R0 / flare, 'rgba(255,214,120,.92)');
    g.addColorStop(0.55, 'rgba(255,150,40,.20)');
    g.addColorStop(1, 'rgba(255,110,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(rx, ry, flare, 0, U.TAU);
    ctx.fill();
    ctx.restore();
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
  function drawOrbital(ctx, b, rx, ry, zoom, alpha, t) {
    ctx.save();
    ctx.globalAlpha = alpha;
    const Rr = b.radius;
    // the lit side is wherever the sunlight is falling from *now* — which is
    // what makes the terminator crawl round the globe as the day passes
    const sunA = W.sunAngle(b, t == null ? W.t : t);

    // bulk
    const core = ctx.createRadialGradient(
      rx + Math.cos(sunA) * Rr * 0.3, ry + Math.sin(sunA) * Rr * 0.3, Rr * 0.05, rx, ry, Rr);
    core.addColorStop(0, b.col.core);
    core.addColorStop(1, b.col.coreLo);
    ctx.beginPath(); ctx.arc(rx, ry, Rr, 0, U.TAU);
    ctx.fillStyle = core;
    ctx.fill();

    if (b.craters) drawCraters(ctx, b, rx, ry, Rr);

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
    const sx = Math.cos(sunA), sy = Math.sin(sunA);
    const ng = ctx.createLinearGradient(rx + sx * Rr, ry + sy * Rr, rx - sx * Rr, ry - sy * Rr);
    ng.addColorStop(0, 'rgba(0,0,0,0)');
    ng.addColorStop(0.42, 'rgba(0,0,0,.12)');
    ng.addColorStop(0.66, 'rgba(2,4,10,.62)');
    ng.addColorStop(1, 'rgba(2,4,10,.86)');
    ctx.fillStyle = ng;
    ctx.fillRect(rx - Rr, ry - Rr, Rr * 2, Rr * 2);
    // cities are the one thing you can still pick out on the dark side
    if (b.sites && Rr * zoom > 40) {
      ctx.globalCompositeOperation = 'lighter';
      for (const st of b.sites) {
        const night = 1 - U.clamp((Math.cos(U.wrap(st.theta - sunA)) + 0.14) / 0.3, 0, 1);
        if (night < 0.15) continue;
        const gr = W.terrain(b, st.theta);
        const lx = rx + Math.cos(st.theta) * gr, ly = ry + Math.sin(st.theta) * gr;
        const lr = Math.max(Rr * 0.02, 3.5 / zoom);
        const lg = ctx.createRadialGradient(lx, ly, 0, lx, ly, lr);
        lg.addColorStop(0, 'rgba(255,214,140,' + (0.85 * night).toFixed(3) + ')');
        lg.addColorStop(1, 'rgba(255,180,80,0)');
        ctx.fillStyle = lg;
        ctx.beginPath(); ctx.arc(lx, ly, lr, 0, U.TAU); ctx.fill();
      }
    }
    ctx.restore();

    ctx.restore();
  }

  /** surface-band colour at a given angle, seen from orbit */
  function matAt(b, th, dth) {
    const r = W.terrain(b, th, dth);
    if (!b.sea) return r > b.seaLevel + 900 ? b.col.rock : b.col.land;
    if (r < b.seaLevel) return r < b.seaLevel - 1400 ? b.col.waterDeep : b.col.water;
    if (b.biomes) {
      if (r > b.seaLevel + 2750) return SNOWCAP;         // caps on the high ground
      return GROUND[W.biome(b, th, r)] || b.col.land;
    }
    return r > b.seaLevel + 1500 ? b.col.rock : b.col.land;
  }

  /** what each sort of country looks like from above */
  const GROUND = {
    ocean: '#1f6fa8', beach: '#d8c390', desert: '#c9ae6d', plains: '#6f8f42',
    forest: '#375f2c', mountain: '#8a8175', city: '#7c7b78'
  };
  const SNOWCAP = '#e8eef5';

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
    // on a world with biomes the ground itself tells you where you are:
    // sand through the desert, dark green under forest, grey through a city,
    // bare rock and snow on the tops
    const matOf = b.biomes
      ? i => {
        if (b.sea && rr[i] < b.seaLevel + 45) return b.col.sand;
        if (rr[i] > b.seaLevel + 2750) return SNOWCAP;
        return GROUND[W.biome(b, th[i], rr[i])] || b.col.land;
      }
      : i => {
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
    if (b.sites) for (const st of b.sites) drawPad(ctx, b, st, rx, ry, th0, th0 + span, zoom);
    else if (b.pad) drawPad(ctx, b, b.pad, rx, ry, th0, th0 + span, zoom);
    drawNight(ctx, b, t, rx, ry, th, rr, n, viewR);
    if (b.sites) drawSmog(ctx, b, t, rx, ry, th0, th0 + span, zoom);
    if (b.clouds) drawClouds(ctx, b, t, rx, ry, th0, th0 + span, zoom, viewR);

    ctx.restore();
  }

  /**
   * Nightfall over the ground. The land and everything standing on it is
   * already drawn by now, so darkness is one veil laid over the lot — graded
   * along the arc, so from high up you can watch the terminator crossing the
   * landscape rather than the whole view dimming at once.
   */
  function drawNight(ctx, b, t, rx, ry, th, rr, n, viewR) {
    if (!b.spin) return;
    const d0 = W.daylight(b, th[0], t), d1 = W.daylight(b, th[n], t);
    const a0 = (1 - d0) * 0.78, a1 = (1 - d1) * 0.78;
    if (a0 < 0.01 && a1 < 0.01) return;
    const depth = viewR * 3.2;
    const outer = i => (b.sea ? Math.max(rr[i], b.seaLevel) : rr[i]);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
      const r = outer(i);
      const x = rx + Math.cos(th[i]) * r, y = ry + Math.sin(th[i]) * r;
      if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    let minR = Infinity;
    for (let i = 0; i <= n; i++) minR = Math.min(minR, rr[i]);
    const rin = Math.max(b.radius * 0.35, minR - depth);
    for (let i = n; i >= 0; i--) ctx.lineTo(rx + Math.cos(th[i]) * rin, ry + Math.sin(th[i]) * rin);
    ctx.closePath();
    const nc = NIGHT_GROUND.join(',');
    const g = ctx.createLinearGradient(
      rx + Math.cos(th[0]) * b.radius, ry + Math.sin(th[0]) * b.radius,
      rx + Math.cos(th[n]) * b.radius, ry + Math.sin(th[n]) * b.radius);
    g.addColorStop(0, 'rgba(' + nc + ',' + a0.toFixed(3) + ')');
    g.addColorStop(1, 'rgba(' + nc + ',' + a1.toFixed(3) + ')');
    ctx.fillStyle = g;
    ctx.fill();
  }

  /** the brown lid a city keeps over itself on a still day */
  function drawSmog(ctx, b, t, rx, ry, th0, th1, zoom) {
    for (const st of b.sites) {
      if (st.theta + st.span < th0 || st.theta - st.span > th1) continue;
      const wx = W.weather(b, st.theta, t);
      if (wx.smog < 0.05) continue;
      const gr = W.terrain(b, st.theta);
      const top = gr + 1500;
      if ((top - gr) * zoom < 1.5) continue;
      const a0 = Math.max(th0, st.theta - st.span * 1.25);
      const a1 = Math.min(th1, st.theta + st.span * 1.25);
      const steps = 26;
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const a = a0 + (a1 - a0) * i / steps;
        const r = W.terrain(b, a);
        const x = rx + Math.cos(a) * r, y = ry + Math.sin(a) * r;
        if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      for (let i = steps; i >= 0; i--) {
        const a = a0 + (a1 - a0) * i / steps;
        // thickest over the middle of town, thinning out at the edges
        const k = Math.cos((a - st.theta) / (st.span * 1.25) * Math.PI / 2);
        ctx.lineTo(rx + Math.cos(a) * (W.terrain(b, a) + 1500 * k * k),
          ry + Math.sin(a) * (W.terrain(b, a) + 1500 * k * k));
      }
      ctx.closePath();
      const g = ctx.createRadialGradient(rx, ry, gr, rx, ry, top);
      const day = W.daylight(b, st.theta, t);
      const col = css(mixRGB('#3a3126', '#b39a6e', day));
      g.addColorStop(0, 'rgba(' + rgb(col).map(Math.round).join(',') + ',' + (0.5 * wx.smog).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(' + rgb(col).map(Math.round).join(',') + ',0)');
      ctx.fillStyle = g;
      ctx.fill();
    }
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
      windows(ctx, o, -w / 2, 0, w, h);
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
    /** a desert saguaro — trunk and a raised arm or two */
    cactus(ctx, o) {
      const w = o.w, h = o.h;
      ctx.strokeStyle = '#3f6b39'; ctx.lineCap = 'round';
      ctx.lineWidth = w * 0.34;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(0, h);
      ctx.stroke();
      ctx.lineWidth = w * 0.24;
      const arms = U.hash(o.seed, 1, 2) > 0.4 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(0, h * 0.45); ctx.lineTo(-w * 0.42, h * 0.45); ctx.lineTo(-w * 0.42, h * 0.72);
      if (arms > 1) { ctx.moveTo(0, h * 0.58); ctx.lineTo(w * 0.4, h * 0.58); ctx.lineTo(w * 0.4, h * 0.8); }
      ctx.stroke();
    },
    /** a palm: a leaning trunk with a crown of fronds */
    palm(ctx, o) {
      const w = o.w, h = o.h;
      const lean = (U.hash(o.seed, 2, 3) - 0.5) * w * 0.5;
      ctx.strokeStyle = '#7a6242'; ctx.lineWidth = w * 0.13; ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(lean * 0.5, h * 0.55, lean, h * 0.86);
      ctx.stroke();
      ctx.strokeStyle = '#3f7d3d'; ctx.lineWidth = w * 0.1;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI * (0.12 + i * 0.152);
        ctx.moveTo(lean, h * 0.86);
        ctx.quadraticCurveTo(lean + Math.cos(a) * w * 0.4, h * 0.86 + Math.sin(a) * h * 0.22,
          lean + Math.cos(a) * w * 0.78, h * 0.86 + Math.sin(a) * h * 0.16 - h * 0.1);
      }
      ctx.stroke();
    },
    /** a downtown tower — the tall stuff a city is built round */
    tower(ctx, o, t) {
      const w = o.w, h = o.h;
      const step = U.hash(o.seed, 3, 1) > 0.55;      // some of them set back near the top
      const upW = step ? w * 0.62 : w;
      const brk = step ? h * 0.72 : h;
      ctx.fillStyle = '#767d8a';
      ctx.fillRect(-w / 2, 0, w, brk);
      if (step) ctx.fillRect(-upW / 2, brk, upW, h - brk);
      ctx.strokeStyle = 'rgba(24,28,36,.55)'; ctx.lineWidth = Math.max(0.06, w * 0.01);
      ctx.strokeRect(-w / 2, 0, w, brk);
      if (step) ctx.strokeRect(-upW / 2, brk, upW, h - brk);
      windows(ctx, o, -w / 2, 0, w, brk);
      if (step) windows(ctx, o, -upW / 2, brk, upW, h - brk);
      // aircraft warning light on top, blinking after dark
      if (scene.day < 0.7) {
        ctx.fillStyle = 'rgba(255,70,70,' + (0.5 + 0.5 * Math.sin(o.seed + t * 3)).toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(0, h + w * 0.1, w * 0.09, 0, U.TAU); ctx.fill();
      }
    },
    /** a stadium/gasholder dome, for a bit of variety downtown */
    dome(ctx, o) {
      const w = o.w, h = o.h;
      ctx.fillStyle = '#9aa0a8';
      ctx.beginPath();
      ctx.ellipse(0, 0, w / 2, h, 0, 0, Math.PI, true);
      ctx.fill();
      ctx.strokeStyle = 'rgba(30,34,42,.5)'; ctx.lineWidth = Math.max(0.06, w * 0.012);
      ctx.stroke();
      ctx.fillStyle = 'rgba(60,68,80,.5)';
      ctx.fillRect(-w / 2, 0, w, h * 0.08);
    },
    /** a farm silo out on the plains */
    silo(ctx, o) {
      const w = o.w, h = o.h;
      ctx.fillStyle = '#c9c4b6';
      ctx.fillRect(-w * 0.3, 0, w * 0.6, h * 0.82);
      ctx.strokeStyle = 'rgba(40,36,30,.45)'; ctx.lineWidth = Math.max(0.05, w * 0.02);
      ctx.strokeRect(-w * 0.3, 0, w * 0.6, h * 0.82);
      ctx.beginPath();
      ctx.moveTo(-w * 0.34, h * 0.82); ctx.lineTo(0, h); ctx.lineTo(w * 0.34, h * 0.82);
      ctx.closePath();
      ctx.fillStyle = '#8a8f96'; ctx.fill();
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

  /**
   * A grid of windows. How many are lit depends on the hour: a wall of glass in
   * daylight, a scattering of warm squares once it is dark — which is what
   * turns a city into a skyline at night.
   */
  function windows(ctx, o, x0, y0, w, h) {
    const cols = Math.max(2, Math.round(w / 3.2)), rows = Math.max(2, Math.round(h / 3.6));
    const night = 1 - scene.day;
    const lit = 0.12 + 0.55 * night;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const on = U.hash(o.seed, r, c) < lit;
      ctx.fillStyle = on
        ? 'rgba(255,226,155,' + (0.35 + 0.6 * night).toFixed(2) + ')'
        : 'rgba(45,58,75,.75)';
      ctx.fillRect(x0 + w * (c + 0.26) / cols, y0 + h * (r + 0.28) / rows,
        w * 0.48 / cols, h * 0.42 / rows);
    }
  }

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

  /** a launch complex sitting on its flattened plateau */
  function drawPad(ctx, b, site, rx, ry, th0, th1, zoom) {
    const pt = site.theta;
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
    // floodlights, which are only worth anything after dark
    if (scene.day < 0.75) {
      const glow = (1 - scene.day) * 0.8;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (const lx of [-38, -20, 20, 38]) {
        const g = ctx.createRadialGradient(lx, 6, 0, lx, 6, 26);
        g.addColorStop(0, 'rgba(255,231,170,' + (0.5 * glow).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,210,120,0)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(lx, 6, 26, 0, U.TAU); ctx.fill();
      }
      ctx.restore();
    }
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
      // clouds take their colour from the light they are standing in: white at
      // noon, gold at sunset, near-black under a thunderhead, and only just
      // visible against the night sky
      const lit = U.lerp(0.20, 1, scene.day);
      const storm = c.storm || 0;
      let top = mixRGB('#ffffff', '#4c5360', storm * 0.8);
      let mid = mixRGB('#eef3fa', '#3d4450', storm * 0.8);
      let base = mixRGB('#b9c6d8', '#252a33', storm * 0.85);
      if (scene.dusk > 0.02) {
        top = mixRGB(top, '#ffc489', scene.dusk * 0.7);
        mid = mixRGB(mid, '#f0975c', scene.dusk * 0.6);
      }
      const g = ctx.createLinearGradient(0, c.h * 0.95, 0, -c.h * 0.1);
      g.addColorStop(0, css(shade(top, lit)));
      g.addColorStop(0.55, css(shade(mid, lit)));
      g.addColorStop(1, css(shade(base, lit)));           // shaded underside
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
    // shrouds last: they close over the hardware they are covering
    if (v.shrouds && v.shrouds.length) {
      for (const sh of v.shrouds) {
        v.worldOfLocal(sh.lx, sh.ly, _pw);
        ctx.save();
        ctx.translate(_pw.x - cam.x, _pw.y - cam.y);
        ctx.rotate(v.angle);
        S.drawShroud(ctx, sh);
        ctx.restore();
      }
    }
    if (v.heatGlow > 0.08) drawPlasma(ctx, v, t, zoom);
  };

  /** shock-heated air piling up on the windward face during a hot re-entry */
  function drawPlasma(ctx, v, t, zoom) {
    const R0 = v.radius();
    if (R0 * zoom < 1.6) return;
    const k = U.clamp(v.heatGlow / 0.6, 0, 1);
    // the shock stands off whichever face the heat is arriving on, centred on
    // the part meeting it rather than on the middle of the craft
    const d = v.heatDir;
    let ux, uy;
    if (d) { ux = d.x; uy = d.y; }
    else {
      const sp = Math.hypot(v.vx, v.vy) || 1;
      ux = v.vx / sp; uy = v.vy / sp;
    }
    let hit = null, lead = -Infinity, hitR = R0;
    for (const p of v.parts) {
      v.worldOf(p, _hw);
      const s2 = (_hw.x - v.x) * ux + (_hw.y - v.y) * uy;
      if (s2 > lead) { lead = s2; hit = { x: _hw.x, y: _hw.y }; hitR = Math.hypot(p.def.w, p.def.h) * 0.5; }
    }
    const bx = hit ? hit.x : v.x, by = hit ? hit.y : v.y;
    const cx = bx - cam.x + ux * hitR * 0.55;
    const cy = by - cam.y + uy * hitR * 0.55;
    const rr = Math.max(hitR * 1.6, R0 * 0.5) * (0.75 + 0.45 * k) * (0.94 + 0.06 * Math.sin(t * 29));
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

  // Particles used to live in a frame where the world stood still, so "slows
  // to a stop" meant stopping at the origin. Earth now laps the Sun at two
  // kilometres a second, and settling into *that* frame drags every puff off
  // the pad — smoke drifted metres clear of the nozzle within a second.
  // Everything that damps toward rest, or is born at rest, measures against
  // this instead: the velocity of the world the effects are happening on.
  // FX.update refreshes it each frame from the body it is handed.
  const frame = { x: 0, y: 0 };

  // The sim advances in sub-steps and effects are spawned part-way through a
  // frame, but FX.update then integrates everything by the whole frame. That
  // over-shoot was worth a metre back when a puff's velocity was its speed
  // through the air; now it also carries its planet's two-kilometre-a-second
  // trip round the Sun, and half a sub-step of that leaves the smoke hanging
  // ten metres above the nozzle. So a particle records the sim time it was
  // born at and only ever integrates the time it has actually existed.
  FX.clock = 0;

  function push(o) {
    o.born = FX.clock;
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

  /** Point the effects at the world they are happening on (see `frame`). */
  FX.frameFrom = function (body, t) {
    const bv = body ? W.bodyVel(body, t) : null;
    frame.x = bv ? bv.x : 0;
    frame.y = bv ? bv.y : 0;
  };

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

  const _hw = { x: 0, y: 0 };

  /**
   * The burning trail a craft drags while it is being cooked. `k` is 0..1 hot;
   * physics.js drives it every step and leaves the direction the heat is
   * arriving from in `v.heatDir` (the airflow on re-entry, the Sun when you
   * are too close to it).
   *
   * Embers come off the parts actually taking the heat — the ones on the
   * windward face, weighted by how hot each has got — and stream away from the
   * source. Spraying them from the middle of the hull instead used to put the
   * fire down one side of the rocket regardless of which end was into the flow.
   */
  FX.reentry = function (v, k, dt, dx, dy) {
    const want = dt * 46 * k;
    let n = Math.floor(want);
    if (Math.random() < want - n) n++;
    if (!n) return;
    // the direction the heat arrives from: the airflow, as passed in by the
    // caller, or failing that whatever last cooked the hull
    let ux, uy;
    const dl = dx == null ? 0 : Math.hypot(dx, dy);
    if (dl > 1e-6) { ux = dx / dl; uy = dy / dl; }
    else if (v.heatDir) { ux = v.heatDir.x; uy = v.heatDir.y; }
    else {
      const sp = Math.hypot(v.vx, v.vy) || 1;
      ux = v.vx / sp; uy = v.vy / sp;
    }
    const ps = v.parts;
    if (!ps.length) return;
    const R0 = v.radius();

    // how far each part sticks out toward the heat, and how hot it is
    let lead = -Infinity;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      v.worldOf(p, _hw);
      p._fxX = _hw.x; p._fxY = _hw.y;
      p._fxLead = (_hw.x - v.x) * ux + (_hw.y - v.y) * uy;
      if (p._fxLead > lead) lead = p._fxLead;
    }
    const reach = Math.max(1, R0 * 0.8);
    let tot = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const face = U.clamp(1 - (lead - p._fxLead) / reach, 0, 1);
      const hot = U.clamp(p.temp / (p.def.heatTol || 1200), 0, 1);
      p._fxW = face * face * (0.2 + hot);
      tot += p._fxW;
    }
    if (tot <= 0) return;

    // the source direction in the craft's own axes, so a part's half-extent
    // toward the heat (and across it) is exact rather than a bounding circle
    const ca = Math.cos(v.angle), sa = Math.sin(v.angle);
    const ulx = ux * ca + uy * sa, uly = -ux * sa + uy * ca;
    const ax = Math.abs(ulx), ay = Math.abs(uly);

    for (let i = 0; i < n; i++) {
      let r = Math.random() * tot, pick = ps[0];
      for (let j = 0; j < ps.length; j++) { r -= ps[j]._fxW; if (r <= 0) { pick = ps[j]; break; } }
      const w = pick.def.w, h = pick.def.h;
      const front = 0.5 * (w * ax + h * ay);          // toward the source
      const side = 0.5 * (w * ay + h * ax);           // across it
      const j2 = (Math.random() - 0.5) * side * 1.9;
      const back = 30 + Math.random() * 90;
      const sz = Math.max(0.6, Math.min(side, R0));
      push({
        x: pick._fxX + ux * front * 0.9 - uy * j2,
        y: pick._fxY + uy * front * 0.9 + ux * j2,
        // trails back through the air, so the fraction kept is of the speed
        // through the air — not of the raw heliocentric velocity
        vx: frame.x + (v.vx - frame.x) * 0.6 - ux * back,
        vy: frame.y + (v.vy - frame.y) * 0.6 - uy * back,
        life: 0, max: 0.45 + Math.random() * 1.1,
        r0: sz * 0.35, r1: sz * (1.3 + Math.random() * 2.2),
        col: Math.random() < 0.55 ? [255, 214, 138] : [255, 138, 58],
        a0: 0.55 * k, drag: 1.1, grav: 0, gdrag: 0.9, bounce: 0
      });
    }
  };

  FX.dust = function (v, b, t, speed) {
    const n = Math.min(22, 4 + speed * 1.2);
    const bp = W.bodyPos(b, t), bv = W.bodyVel(b, t);
    const nx = (v.x - bp.x), ny = (v.y - bp.y);
    const l = Math.hypot(nx, ny) || 1;
    for (let i = 0; i < n; i++) {
      const a = (Math.random() - 0.5) * 2.4;
      const s = 4 + Math.random() * speed * 0.9;
      const dx = -ny / l, dy = nx / l;
      push({
        x: v.x, y: v.y,
        vx: bv.x + (v.vx - bv.x) * 0.2 + dx * s * Math.cos(a) + (nx / l) * s * 0.5,
        vy: bv.y + (v.vy - bv.y) * 0.2 + dy * s * Math.cos(a) + (ny / l) * s * 0.5,
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
        x, y, vx: frame.x + Math.cos(a) * s, vy: frame.y + Math.sin(a) * s,
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
        vx: frame.x + Math.cos(a) * s, vy: frame.y + Math.sin(a) * s,
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
        vx: frame.x + (v.vx - frame.x) * 0.5 + Math.cos(a) * s,
        vy: frame.y + (v.vy - frame.y) * 0.5 + Math.sin(a) * s,
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
        vx: frame.x + (v.vx - frame.x) * 0.5 + Math.cos(a) * s,
        vy: frame.y + (v.vy - frame.y) * 0.5 + Math.sin(a) * s,
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
        vx: frame.x + (v.vx - frame.x) * 0.5 + Math.cos(a) * s,
        vy: frame.y + (v.vy - frame.y) * 0.5 + Math.sin(a) * s,
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
        x, y, vx: frame.x + Math.cos(a) * s, vy: frame.y + Math.sin(a) * s,
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
    FX.frameFrom(body, t);
    // only bother with terrain for particles actually near the surface
    const nearR = body ? body.radius + 5000 : 0;

    for (let i = parts.length - 1; i >= 0; i--) {
      const p = parts[i];
      // only the slice of this frame the particle has been alive for
      // (a load or a revert can wind the clock back under a live particle —
      // anything not born inside this frame just takes the whole step)
      const h = p.born > t - dt && p.born <= t ? t - p.born : dt;
      p.life += h;
      if (p.life >= p.max) { parts.splice(i, 1); continue; }
      if (!h) continue;
      if (p.grav) {
        W.gravity(p.x, p.y, t, g);
        p.vx += g.x * p.grav * h;
        p.vy += g.y * p.grav * h;
      }
      // drag bleeds off motion *through the air*, and the air travels with
      // its world — damping the raw velocity would blow every particle off a
      // moving planet at that planet's orbital speed
      const d = Math.exp(-p.drag * h);
      p.vx = frame.x + (p.vx - frame.x) * d;
      p.vy = frame.y + (p.vy - frame.y) * d;
      p.x += p.vx * h; p.y += p.vy * h;

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
      // into-ground speed is measured against the ground, which is moving
      const vn = (p.vx - frame.x) * nx + (p.vy - frame.y) * ny;
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
      const k = Math.pow(p.gdrag, h * 60);
      p.vx = frame.x + (p.vx - frame.x) * k;
      p.vy = frame.y + (p.vy - frame.y) * k;
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

    // every orbit, drawn round whatever it goes round — the planets about the
    // Sun, the moons about their planets
    ctx.strokeStyle = 'rgba(120,150,200,.22)';
    ctx.lineWidth = 1 / z;
    for (const b of W.bodies) {
      if (!b.orbit) continue;
      const pp = W.bodyPos(b.parent, t);
      if (b.orbit.a * z < 8) continue;                  // too small to bother with
      ctx.beginPath();
      ctx.arc(pp.x - cam.x, pp.y - cam.y, b.orbit.a, 0, U.TAU);
      ctx.stroke();
    }

    for (const b of W.bodies) {
      const bp = W.bodyPos(b, t);
      const rx = bp.x - cam.x, ry = bp.y - cam.y;
      if (b.star) { drawStar(ctx, b, rx, ry, z, t); continue; }
      if (b.atmo) {
        ctx.beginPath();
        ctx.arc(rx, ry, b.radius + b.atmo.height, 0, U.TAU);
        ctx.fillStyle = 'rgba(80,150,225,.16)';
        ctx.fill();
      }
      // zoomed out to see the whole system a planet is a fraction of a pixel
      // across, so give it a floor size — and a name, since at that scale one
      // dot looks much like another
      if (b.radius * z < 3) {
        ctx.beginPath();
        ctx.arc(rx, ry, 3.5 / z, 0, U.TAU);
        ctx.fillStyle = b.col.core;
        ctx.fill();
      } else {
        drawOrbital(ctx, b, rx, ry, z, 1);
      }
      if (b.orbit && b.orbit.a * z > 40) {
        ctx.save();
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(190,205,230,.75)';
        ctx.textAlign = 'center';
        ctx.fillText(b.name, rx * z + cw / 2, -ry * z + ch / 2 - Math.max(6, b.radius * z) - 5);
        ctx.restore();
        setWorldTf(ctx, cw, ch, dpr, z, 0);
      }
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
        // the impact point is stored in the path's own frame (see W.predict)
        markX(ctx, pr.hit.x + rp.x - cam.x, pr.hit.y + rp.y - cam.y, 7 / z, '#ff6b60');
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
    // same frame the HUD and the autopilot use: the sphere of influence
    const b = v.refBody || v.nearBody || W.earth;
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
    const dt = G.dt > 0 ? Math.min(G.dt, 0.1) : 1 / 60;
    const v = G.focus;
    // the sky belongs to whatever world we are over — Earth's blue, Mars'
    // thin rust-coloured haze, or nothing at all above an airless rock
    const skyBody = (v && v.nearBody) || W.earth;
    const alt = v && v.altASL != null ? v.altASL : 1e9;
    const atmoF = v ? W.atmoFrac(skyBody, alt) : 0;

    // Where we are standing, in the local sense: which longitude the craft is
    // over decides what time of day it is down there and what the weather is
    // doing. Everything drawn this frame reads it off `scene`.
    const sbp = W.bodyPos(skyBody, t);
    const th = v ? Math.atan2(v.y - sbp.y, v.x - sbp.x) : 0;
    const el = skyBody.spin ? W.sunHeight(skyBody, th, t) : 1;
    scene.day = skyBody.spin ? W.daylight(skyBody, th, t) : 1;
    scene.dusk = Math.exp(-Math.pow((el - 0.02) / 0.22, 2));
    scene.wx = W.weather(skyBody, th, t);

    drawSky(ctx, cw, ch, dpr, atmoF, skyBody, th, t);
    // stars come out to match the darkening sky above, rather than staying
    // hidden until the very top of the atmosphere — and they are out at night
    // from the ground too, as long as the cloud lets them through
    const nightStars = (1 - scene.day) * U.clamp(1 - scene.wx.cover * 1.25, 0, 1) * 0.95;
    drawStars(ctx, cw, ch, dpr,
      Math.max(U.clamp(1 - Math.pow(atmoF, 1.7) * 1.25, 0, 1), nightStars), t, cam.rot);
    drawSunInSky(ctx, cw, ch, dpr, skyBody, th, t, atmoF);

    setWorldTf(ctx, cw, ch, dpr, cam.zoom, cam.rot);
    const viewR = R.viewR(cw, ch);

    for (const b of W.bodies) drawBody(ctx, b, t, cw, ch, viewR);

    for (const ves of G.vessels) if (!ves.dead) R.drawVessel(ctx, ves, t, cam.zoom);

    FX.draw(ctx, cam.zoom, viewR);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // weather in front of everything: you are flying through it, not past it
    drawPrecip(ctx, cw, ch, dpr, t, dt, alt, (v && v.windSpd) || 0);
    drawLightning(ctx, cw, ch, dpr, dt, alt);
    drawVelocityMarker(ctx, cw, ch, dpr, G);
  };

})(window.SFS);
