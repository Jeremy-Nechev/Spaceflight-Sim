/* ============================================================
   main.js — canvas, game loop, scene switching and all UI wiring
   ============================================================ */
(function (S) {
  'use strict';

  const U = S.util;
  const B = S.builder;
  const F = S.flight;
  const R = S.render;

  let canvas, ctx, cw = 0, ch = 0, dpr = 1;
  let scene = 'menu';
  let last = 0;
  const pointers = new Map();
  let pinchD = 0;
  let mapDrag = null;

  /* ═══════════════════ boot ═══════════════════ */

  function init() {
    canvas = document.getElementById('game');
    ctx = canvas.getContext('2d', { alpha: false });
    window.addEventListener('resize', resize);
    resize();

    buildPalette();
    wireMenu();
    wireBuild();
    wireFlight();
    wireInput();

    B.onChange = () => { refreshStats(); refreshStageEdit(); };
    const saved = U.store.get('lastBlueprint', null);
    B.load(saved || B.presets()[0]);
    renderProgress();

    requestAnimationFrame(loop);
  }

  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    cw = window.innerWidth;
    ch = window.innerHeight;
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = cw + 'px';
    canvas.style.height = ch + 'px';
    B.setSize(cw, ch);
  }

  function setScene(s) {
    scene = s;
    document.getElementById('menu').classList.toggle('hidden', s !== 'menu');
    document.getElementById('buildUI').classList.toggle('hidden', s !== 'build');
    document.getElementById('flightUI').classList.toggle('hidden', s !== 'flight');
    if (s === 'build') { B.fit(); refreshStats(); refreshStageEdit(); }
    if (s === 'menu') renderProgress();
  }
  S.setScene = setScene;

  /* ═══════════════════ loop ═══════════════════ */

  function loop(ts) {
    const now = ts / 1000;
    let dt = now - last;
    if (!last || dt > 0.25 || dt <= 0) dt = 1 / 60;
    last = now;

    if (scene === 'flight') {
      F.update(dt, dt);
      R.follow(F.focus, F.t, dt);
      R.frame(ctx, cw, ch, dpr, {
        t: F.t, vessels: F.vessels, focus: F.focus, path: F.path, el: F.el,
        plan: F.plan, targetBody: F.target
      });
    } else {
      B.draw(ctx, cw, ch, dpr);
    }
    requestAnimationFrame(loop);
  }

  /* ═══════════════════ palette ═══════════════════ */

  function buildPalette() {
    const cats = document.getElementById('palCats');
    S.PART_CATS.forEach(c => {
      const b = document.createElement('button');
      b.textContent = c;
      b.dataset.cat = c;
      if (c === B.cat) b.classList.add('on');
      b.onclick = () => {
        B.cat = c;
        U.$$('#palCats button').forEach(x => x.classList.toggle('on', x.dataset.cat === c));
        renderPalette();
      };
      cats.appendChild(b);
    });
    renderPalette();
  }

  function renderPalette() {
    const list = document.getElementById('palList');
    list.innerHTML = '';
    for (const id of S.PART_ORDER) {
      const d = S.PARTS[id];
      if (d.cat !== B.cat) continue;
      const el = document.createElement('div');
      el.className = 'palItem';
      el.dataset.id = id;
      el.appendChild(S.partIcon(d, 50));
      const sp = document.createElement('span');
      sp.textContent = d.name;
      el.appendChild(sp);
      el.onclick = () => {
        B.held = { def: d };
        B.sel = null;
        U.$$('#palList .palItem').forEach(x => x.classList.toggle('sel', x.dataset.id === id));
        if (S.audio) S.audio.ui();
      };
      el.onmouseenter = e => showTip(d, e);
      el.onmousemove = e => moveTip(e);
      el.onmouseleave = hideTip;
      list.appendChild(el);
    }
  }

  const tip = () => document.getElementById('partTip');

  function showTip(d, e) {
    const t = tip();
    let s = '<b>' + d.name + '</b><i>' + U.mass(d.mass + d.fuel) + (d.fuel ? '  ·  ' + U.mass(d.fuel) + ' fuel' : '') + '</i>';
    if (d.engine) {
      s += '<i>' + U.force(d.engine.thrust) + ' thrust</i>';
      s += '<i>Isp ' + d.engine.ispSl + ' → ' + d.engine.ispVac + ' s</i>';
      if (d.engine.solid) s += '<i>solid · no throttle</i>';
    }
    if (d.chute) s += '<i>' + d.chute.area + ' m² canopy</i>';
    if (d.authority) s += '<i>+' + d.authority.toFixed(2) + ' rad/s² control</i>';
    s += '<em>' + d.desc + '</em>';
    t.innerHTML = s;
    t.classList.remove('hidden');
    moveTip(e);
  }
  function moveTip(e) {
    const t = tip();
    t.style.left = Math.min(cw - 230, e.clientX + 16) + 'px';
    t.style.top = Math.min(ch - 130, e.clientY + 10) + 'px';
  }
  function hideTip() { tip().classList.add('hidden'); }

  /* ═══════════════════ build UI ═══════════════════ */

  function refreshStats() {
    const s = B.stats();
    const el = document.getElementById('buildStats');
    if (!el) return;
    const row = (k, v) => '<div class="r"><span>' + k + '</span><b>' + v + '</b></div>';
    let h = row('Mass', U.mass(s.mass)) +
      row('Fuel', U.mass(s.fuel)) +
      row('Height', s.height.toFixed(1) + ' m') +
      row('Parts', s.count) +
      row('Stages', s.stages) +
      row('Lift-off TWR', s.twr ? s.twr.toFixed(2) : '—') +
      row('Total Δv', U.speed(s.dv));
    const warn = [];
    if (!s.count) warn.push('Nothing built yet.');
    else {
      if (!s.pods) warn.push('⚠ No command pod — no steering.');
      if (!s.engines) warn.push('⚠ No engines.');
      else if (s.twr && s.twr < 1.02) warn.push('⚠ TWR ' + s.twr.toFixed(2) + ' — it can\'t lift off.');
      if (B.unassigned().length) warn.push('⚠ ' + B.unassigned().length + ' part(s) in no stage group.');
    }
    if (warn.length) h += '<div class="warn">' + warn.join('<br>') + '</div>';
    el.innerHTML = h;
  }

  function refreshStageEdit() {
    const list = document.getElementById('seList');
    if (!list) return;
    list.innerHTML = '';
    B.stages.forEach((g, i) => list.appendChild(stageRow(g, i)));
    const un = B.unassigned();
    if (un.length) list.appendChild(stageRow(un, -1));
    if (!B.stages.length && !un.length) {
      const d = document.createElement('div');
      d.className = 'seHint';
      d.textContent = 'Add engines, separators or parachutes and they will appear here.';
      list.appendChild(d);
    }
  }

  function stageRow(group, i) {
    const row = document.createElement('div');
    row.className = 'seRow' + (i < 0 ? ' unassigned' : '');
    row.title = i < 0 ? 'Not staged — these will never fire' : 'Stage ' + (i + 1);

    const num = document.createElement('div');
    num.className = 'seNum';
    num.textContent = i < 0 ? '!' : (i + 1);
    row.appendChild(num);

    const chips = document.createElement('div');
    chips.className = 'seChips';
    for (const uid of group) {
      const p = B.parts.find(z => z.uid === uid);
      if (!p) continue;
      const c = document.createElement('div');
      c.className = 'seChip' + (B.chip === uid ? ' sel' : '');
      c.title = p.def.name;
      c.appendChild(S.partIcon(p.def, 18));
      c.onclick = ev => {
        ev.stopPropagation();
        B.chip = (B.chip === uid) ? null : uid;
        B.sel = p;
        refreshStageEdit();
      };
      chips.appendChild(c);
    }
    row.appendChild(chips);

    const btns = document.createElement('div');
    btns.className = 'seBtns';
    if (i >= 0) {
      [['▲', () => B.moveStage(i, -1)], ['▼', () => B.moveStage(i, 1)], ['✕', () => B.delStage(i)]]
        .forEach(([txt, fn]) => {
          const b = document.createElement('button');
          b.textContent = txt;
          b.onclick = ev => { ev.stopPropagation(); fn(); };
          btns.appendChild(b);
        });
    }
    row.appendChild(btns);

    row.onclick = () => {
      if (B.chip != null) { B.moveToStage(B.chip, i); B.chip = null; }
    };
    return row;
  }

  function wireBuild() {
    document.querySelectorAll('#buildUI [data-act]').forEach(b => {
      b.onclick = () => {
        const a = b.dataset.act;
        if (S.audio) S.audio.ui();
        if (a === 'menu') setScene('menu');
        else if (a === 'mirror') {
          B.mirror = !B.mirror;
          document.getElementById('mirrorBtn').textContent = 'Mirror: ' + (B.mirror ? 'ON' : 'OFF');
        } else if (a === 'undo') B.undo();
        else if (a === 'clear') B.clear();
        else if (a === 'save' || a === 'load') openBlueprints();
        else if (a === 'launch') doLaunch();
      };
    });
    document.getElementById('seAuto').onclick = () => { B.autoStage(); B.changed(); };
    document.getElementById('seAdd').onclick = () => B.addStage();
    document.getElementById('bpClose').onclick = () => document.getElementById('blueprintPanel').classList.add('hidden');
    document.getElementById('bpSave').onclick = () => {
      const n = document.getElementById('bpName').value.trim();
      if (!n) return;
      B.saveAs(n);
      openBlueprints();
      F.toast('Saved "' + n + '"');
    };
  }

  function doLaunch() {
    const s = B.stats();
    if (!s.count) { F.toast('Build something first!', 'bad'); return; }
    const bp = B.blueprint();
    U.store.set('lastBlueprint', bp);
    if (F.launch(bp)) {
      setScene('flight');
      F.toast('Throttle is at ' + Math.round(F.focus.throttle * 100) + '% — press Space to launch');
    }
  }

  function openBlueprints() {
    const panel = document.getElementById('blueprintPanel');
    const list = document.getElementById('bpList');
    document.getElementById('bpName').value = B.name;
    list.innerHTML = '';

    const add = (name, tip, loadFn, delFn) => {
      const r = document.createElement('div');
      r.className = 'bpRow';
      const s = document.createElement('span');
      s.textContent = name;
      if (tip) s.title = tip;
      r.appendChild(s);
      const lb = document.createElement('button');
      lb.textContent = 'Load';
      lb.onclick = loadFn;
      r.appendChild(lb);
      if (delFn) {
        const db = document.createElement('button');
        db.textContent = '✕';
        db.className = 'del';
        db.onclick = delFn;
        r.appendChild(db);
      }
      list.appendChild(r);
    };

    B.presets().forEach(p => add('★ ' + p.name, p.tip, () => {
      B.load({ name: p.name, parts: p.parts, stages: null });
      panel.classList.add('hidden');
    }));
    B.saved().forEach(bp => add(bp.name, null,
      () => { B.load(bp); panel.classList.add('hidden'); },
      () => { B.deleteSaved(bp.name); openBlueprints(); }));

    panel.classList.remove('hidden');
  }

  /* ═══════════════════ flight UI ═══════════════════ */

  function wireFlight() {
    document.querySelectorAll('#flightUI [data-act]').forEach(b => {
      b.onclick = () => {
        const a = b.dataset.act;
        if (S.audio) S.audio.ui();
        if (a === 'menu') setScene('menu');
        else if (a === 'build') { F.hideEnd(); setScene('build'); }
        else if (a === 'revert') F.revert();
        else if (a === 'map') toggleMap();
        else if (a === 'warpUp') F.setWarp(F.warpIdx + 1);
        else if (a === 'warpDown') F.setWarp(F.warpIdx - 1);
      };
    });

    U.$$('#sasBox button').forEach(b => { b.onclick = () => F.setSas(b.dataset.sas); });

    document.getElementById('btnStage').onclick = () => F.stage();
    document.getElementById('xClose').onclick = () => F.setTarget(null);
    document.getElementById('xRecalc').onclick = () => F.replan();
    document.getElementById('endRevert').onclick = () => F.revert();
    document.getElementById('endBuild').onclick = () => { F.hideEnd(); setScene('build'); };

    // throttle slider
    const bar = document.getElementById('throttleBar');
    const setFromY = e => {
      const r = bar.getBoundingClientRect();
      F.setThrottle(1 - (e.clientY - r.top) / r.height);
    };
    bar.addEventListener('pointerdown', e => {
      bar.setPointerCapture(e.pointerId);
      bar.dataset.drag = '1';
      setFromY(e);
    });
    bar.addEventListener('pointermove', e => { if (bar.dataset.drag) setFromY(e); });
    bar.addEventListener('pointerup', e => {
      bar.releasePointerCapture(e.pointerId);
      delete bar.dataset.drag;
    });

    // hold-to-rotate buttons
    const hold = (id, key) => {
      const el = document.getElementById(id);
      el.addEventListener('pointerdown', e => { e.preventDefault(); F.keys[key] = true; });
      const off = () => { F.keys[key] = false; };
      el.addEventListener('pointerup', off);
      el.addEventListener('pointerleave', off);
      el.addEventListener('pointercancel', off);
    };
    hold('rotL', 'a');
    hold('rotR', 'd');
  }

  function toggleMap() {
    R.cam.map = !R.cam.map;
    document.getElementById('mapBtn').classList.toggle('on', R.cam.map);
    if (R.cam.map) {
      R.cam.offX = 0; R.cam.offY = 0;
      const v = F.focus;
      const r = v ? Math.max(4e5, Math.hypot(v.x, v.y) * 1.6) : 1e6;
      const scr = Math.max(320, Math.min(cw, ch));   // never 0 before first resize
      R.cam.mapZoomT = R.cam.mapZoom =
        U.clamp(0.42 * scr / r, R.cam.mapMin, R.cam.mapMax);
    }
    F.paintXfer();
  }

  /* ═══════════════════ menu ═══════════════════ */

  function wireMenu() {
    document.getElementById('mBuild').onclick = () => setScene('build');
    document.getElementById('mQuick').onclick = () => {
      if (!B.parts.length) B.load(B.presets()[0]);
      doLaunch();
    };
    document.getElementById('mHelp').onclick = () => document.getElementById('help').classList.remove('hidden');
    document.getElementById('helpClose').onclick = () => document.getElementById('help').classList.add('hidden');
  }

  function renderProgress() {
    const el = document.getElementById('progressList');
    if (!el) return;
    el.innerHTML = '';
    F.GOALS.forEach(g => {
      const d = document.createElement('div');
      d.className = F.progress[g.id] ? 'done' : '';
      d.textContent = (F.progress[g.id] ? '★ ' : '☆ ') + g.label;
      el.appendChild(d);
    });
  }

  /* ═══════════════════ input ═══════════════════ */

  function wireInput() {
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    canvas.addEventListener('pointerdown', e => {
      if (S.audio) S.audio.init();
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) { pinchD = pinchDist(); return; }
      if (scene === 'build') B.pointerDown(e.clientX, e.clientY, e.button);
      else if (scene === 'flight' && R.cam.map) {
        mapDrag = { x: e.clientX, y: e.clientY, ox: R.cam.offX || 0, oy: R.cam.offY || 0 };
      }
    });

    canvas.addEventListener('pointermove', e => {
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        const d = pinchDist();
        if (pinchD > 0 && d > 0) {
          const f = d / pinchD;
          if (scene === 'build') B.wheel(f > 1 ? -1 : 1);
          else R.zoomBy(f);
        }
        pinchD = d;
        return;
      }
      if (scene === 'build') B.pointerMove(e.clientX, e.clientY);
      else if (scene === 'flight' && mapDrag) {
        const z = R.cam.mapZoom;
        R.cam.offX = mapDrag.ox - (e.clientX - mapDrag.x) / z;
        R.cam.offY = mapDrag.oy + (e.clientY - mapDrag.y) / z;
      }
    });

    const up = e => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchD = 0;
      if (scene === 'build') B.pointerUp();
      // a click (not a drag) on a world in map view plans a transfer to it
      if (scene === 'flight' && mapDrag && e.button !== 2) {
        const moved = Math.hypot(e.clientX - mapDrag.x, e.clientY - mapDrag.y);
        if (moved < 5) {
          const b = R.pickBody(e.clientX, e.clientY, cw, ch, F.t);
          if (b) { F.setTarget(b); if (S.audio) S.audio.ui(); }
        }
      }
      mapDrag = null;
    };
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      if (scene === 'build') B.wheel(e.deltaY);
      else R.zoomBy(e.deltaY < 0 ? 1.16 : 1 / 1.16);
    }, { passive: false });

    window.addEventListener('keydown', e => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
      if (S.audio) S.audio.init();
      const k = e.key.toLowerCase();
      F.keys[k] = true;

      if (k === 'escape') {
        const help = document.getElementById('help');
        if (!help.classList.contains('hidden')) { help.classList.add('hidden'); return; }
        setScene(scene === 'menu' ? (F.running ? 'flight' : 'build') : 'menu');
        return;
      }

      if (scene === 'flight') {
        if (k === ' ') { e.preventDefault(); F.stage(); }
        else if (k === 'z') F.setThrottle(1);
        else if (k === 'x') F.setThrottle(0);
        else if (k === 't') F.cycleSas();
        else if (k === 'm') toggleMap();
        else if (k === ',') F.setWarp(F.warpIdx - 1);
        else if (k === '.') F.setWarp(F.warpIdx + 1);
        else if (k === 'r') F.revert();
        else if (k === 'b') { F.hideEnd(); setScene('build'); }
        else if (k === 'g') {
          const v = F.focus;
          if (v) v.parts.forEach(p => { if (p.def.type === 'leg') p.deployed = !p.deployed; });
        }
        if (k === 'arrowup' || k === 'arrowdown' || k === 'arrowleft' || k === 'arrowright') e.preventDefault();
      } else if (scene === 'build') {
        if (k === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); B.undo(); }
        else if (k === 'delete' || k === 'backspace') {
          if (B.sel) { e.preventDefault(); B.remove(B.sel); }
        } else if (k === 'm') {
          B.mirror = !B.mirror;
          document.getElementById('mirrorBtn').textContent = 'Mirror: ' + (B.mirror ? 'ON' : 'OFF');
        }
      }
    });

    window.addEventListener('keyup', e => { F.keys[e.key.toLowerCase()] = false; });
    window.addEventListener('blur', () => { for (const k in F.keys) F.keys[k] = false; });
  }

  function pinchDist() {
    const it = Array.from(pointers.values());
    return it.length < 2 ? 0 : Math.hypot(it[0].x - it[1].x, it[0].y - it[1].y);
  }

  /* ═══════════════════ go ═══════════════════ */

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})(window.SFS);
