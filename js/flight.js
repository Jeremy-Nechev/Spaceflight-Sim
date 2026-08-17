/* ============================================================
   flight.js — the flying scene: simulation loop, controls,
               time warp, HUD, staging and mission log
   ============================================================ */
(function (S) {
  'use strict';

  const U = S.util;
  const W = S.world;
  const PH = S.physics;
  const R = S.render;
  const F = S.flight = {};

  const WARPS = [1, 2, 5, 10, 50, 500, 5000, 50000];
  const RAILS_FROM = 4;                 // index at which we go on rails
  const PHYS_DT = 1 / 120;
  const MAX_MISSIONS = 6;               // player-controllable craft alive at once

  F.vessels = [];
  F.focus = null;
  F.t = 0;
  F.warpIdx = 0;
  F.running = false;
  F.over = null;
  F.overMission = null;   // which mission the end-of-mission modal is about (see F.revert)
  F.bp = null;
  F.keys = Object.create(null);
  F.path = null;
  F.el = null;

  let predTimer = 0, hudTimer = 0, smashCount = 0;
  let pendingEnd = null;                  // { title, text, delay } — holds the mission-failed panel back while the wreck burns
  let echoVessels = [];                   // spent stages still burning after separation, kept audible until off screen
  let inAtmo = null;                      // null = not tracking yet; true/false once we know, so we can toast on the flip

  // whether the flight scene is actually on screen — the sim itself keeps
  // running regardless (background missions), but there's no point painting
  // the HUD or playing engine audio for a craft nobody is looking at
  let hudActive = true;
  F.setSceneActive = function (active) { hudActive = active; };

  /* ═══════════════════ mission log ═══════════════════ */

  const GOALS = [
    { id: 'space', label: 'Reach space (60 km)' },
    { id: 'orbit', label: 'Orbit the Earth' },
    { id: 'splash', label: 'Splash down in an ocean' },
    { id: 'moonSoi', label: 'Reach the Moon' },
    { id: 'moonOrbit', label: 'Orbit the Moon' },
    { id: 'moonLand', label: 'Land on the Moon' },
    { id: 'home', label: 'Return home safely' },
    { id: 'demolition', label: 'Flatten 25 buildings' }
  ];
  F.GOALS = GOALS;
  F.progress = U.store.get('progress', {});

  function unlock(id) {
    if (F.progress[id]) return;
    F.progress[id] = true;
    U.store.set('progress', F.progress);
    const g = GOALS.find(x => x.id === id);
    F.toast('★ ' + (g ? g.label : id), 'gold');
    if (S.audio) S.audio.blip(880, 0.18, 'sine', 0.12);
  }
  F.unlock = unlock;

  /* ═══════════════════ toasts ═══════════════════ */

  F.toast = function (msg, kind) {
    const box = document.getElementById('toast');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'toastMsg' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .4s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 420);
    }, 2600);
    while (box.children.length > 4) box.removeChild(box.firstChild);
  };
  S.fx.onNote = (m, k) => F.toast(m, k);

  /* ═══════════════════ launch / revert ═══════════════════ */

  let missionSeq = 1;

  /** Build a fresh vessel from a blueprint and sit it on the pad, nose
      straight up. Shared by a brand-new game, an additional launch
      alongside missions already flying, and a per-mission revert. */
  function spawnOnPad(bp, missionOverride) {
    const v = S.vessel.fromBlueprint(bp);
    if (!v) return null;

    // if another craft is still sitting on the pad (e.g. launching a second
    // rocket before the first has lifted off), nudge this one along the pad
    // instead of spawning it stacked directly inside the other one
    const pad = W.padPoint();
    const parked = F.vessels.filter(x => !x.dead && Math.hypot(x.x - pad.x, x.y - pad.y) < 400).length;
    const th = W.padTheta + (parked ? Math.ceil(parked / 2) * (parked % 2 ? 1 : -1) * 0.002 : 0);

    const g = W.terrain(W.earth, th);
    let lo = Infinity;
    for (const p of v.parts) lo = Math.min(lo, p.ly - p.def.h / 2);
    const clearance = v.com.y - lo;
    const r = g + clearance + 0.06;
    // nose straight up: rot(a)·(0,1) must equal the outward radial at θ
    v.angle = th - Math.PI / 2;
    v.x = Math.cos(th) * r;
    v.y = Math.sin(th) * r;
    v.vx = 0; v.vy = 0; v.omega = 0;
    v.throttle = 1;
    v.sas = 'off';
    v.sasTarget = v.angle;

    v.mission = missionOverride || {
      id: 'm' + (missionSeq++), name: bp.name || 'Rocket',
      launchedAt: F.t, controllable: true,
      bp: JSON.parse(JSON.stringify(bp))
    };
    return v;
  }

  F.launch = function (bp) {
    F.bp = JSON.parse(JSON.stringify(bp));
    return F.reset();
  };

  /** Wipes the whole sim and starts a brand-new game with one vessel. */
  F.reset = function () {
    W.resetScenery();
    S.fx.clear();
    F.vessels.length = 0;
    F.t = 0;
    W.t = 0;
    F.warpIdx = 0;
    F.over = null;
    F.overMission = null;
    smashCount = 0;
    pendingEnd = null;
    echoVessels = [];
    inAtmo = null;
    F.target = null;
    F.plan = null;

    const v = spawnOnPad(F.bp);
    if (!v) return false;

    F.vessels.push(v);
    F.focus = v;
    F.running = true;

    R.cam.zoomT = U.clamp(130 / Math.max(6, v.radius() * 2), 1.2, 9);
    R.follow(v, 0, 0, true);
    F.syncUI();
    F.refreshStages();
    F.predict(true);
    return true;
  };

  /** Launches a second (or third...) craft alongside whatever is already
      flying, without touching sim time, scenery, or any other mission. */
  F.launchAdditional = function (bp) {
    const missions = F.vessels.filter(x => x.mission);
    if (missions.length >= MAX_MISSIONS) {
      F.toast('Too many active missions (max ' + MAX_MISSIONS + '). Recover or lose one first.', 'bad');
      return false;
    }
    const v = spawnOnPad(bp);
    if (!v) return false;
    F.vessels.push(v);
    F.running = true;
    F.setFocus(v);
    return true;
  };

  /** Per-mission revert: rebuild a craft from its own launch blueprint,
      leaving every other mission running untouched. Normally that's whatever
      is currently focused — but when called from the end-of-mission modal
      (F.overMission), the vessel that actually crashed is very likely no
      longer F.focus by the time the modal appears (cleanup() reassigns focus
      the instant the crash is detected, well before the delayed modal shows
      up — see endMission/F.overMission), so that mission takes priority. */
  F.revert = function () {
    const mission = F.overMission || (F.focus && F.focus.mission);
    F.overMission = null;
    if (!mission || !mission.bp) { hideEnd(); return; }
    const idx = F.vessels.findIndex(x => x.mission === mission);
    if (idx >= 0) F.vessels.splice(idx, 1);
    const nv = spawnOnPad(mission.bp, mission);
    if (nv) {
      F.vessels.push(nv);
      F.setFocus(nv);
    } else if (F.vessels.length) {
      F.focus = F.vessels[0];
    } else {
      F.focus = null; F.running = false;
    }
    hideEnd();
  };

  /* ═══════════════════ staging ═══════════════════ */

  F.stage = function (idx) {
    const v = F.focus;
    if (!v || v.dead || F.over) return;
    if (idx != null) {
      // jump straight to a chosen group
      if (idx < v.stageIdx || idx >= v.stages.length) return;
      while (v.stageIdx < idx) v.stageIdx++;
    }
    if (v.stageIdx >= v.stages.length) return;
    const sep = v.fireStage();
    if (S.audio) S.audio.stage();
    if (sep) {
      const res = S.vessel.split(v);
      for (const j of res.junk) S.fx.puff(j.x, j.y, 1.6);
      const i = F.vessels.indexOf(v);
      if (i >= 0) F.vessels.splice(i, 1);
      for (const nv of res.vessels) {
        // the pieces start out touching — let them drift clear before hulls bite
        nv.noHitUntil = F.t + 0.45;
        F.vessels.push(nv);
      }
      if (res.primary) {
        res.primary.mission = v.mission;   // V.split() builds a fresh Vessel — carry the tag over
        if (v === F.focus) F.focus = res.primary;
      }
      // a discarded piece can still be burning down (e.g. a booster cut loose
      // mid-flame) — its engine sound keeps playing until it drifts off screen
      // instead of snapping silent the instant we stop flying it
      for (const nv of res.vessels) {
        if (nv !== F.focus && nv.parts.some(p => p.def.type === 'engine' && p.active)) {
          echoVessels.push(nv);
        }
      }
    }
    F.refreshStages();
    F.predict(true);
  };

  /* ═══════════════════ controls ═══════════════════ */

  F.setThrottle = function (t) {
    if (F.focus) F.focus.throttle = U.clamp(t, 0, 1);
    F.syncThrottle();
  };

  const SAS_HINT = {
    off: 'Autopilot off: steer by hand with A / D',
    hold: 'Holding the heading the rocket had when you switched this on',
    pro: 'Prograde: nose along your direction of travel. Burn to go faster',
    retro: 'Retrograde: nose against your travel. Burn to slow down or land',
    up: 'Away: nose pointed straight up, away from the world below'
  };

  /** UI-only: reflect a mode in the SAS buttons/hint without touching the
      vessel — used when merely displaying a newly-focused craft's already-set
      autopilot state, as opposed to the player actually changing it. */
  function syncSasButtons(mode) {
    U.$$('#sasBox button').forEach(b => b.classList.toggle('on', b.dataset.sas === mode));
    const hint = document.getElementById('sasHint');
    if (hint) hint.textContent = SAS_HINT[mode] || '';
  }

  F.setSas = function (mode) {
    const v = F.focus;
    if (!v) return;
    v.sas = mode;
    if (mode !== 'off') v.sasTarget = v.angle;
    syncSasButtons(mode);
  };

  F.cycleSas = function () {
    const order = ['off', 'hold', 'pro', 'retro', 'up'];
    const v = F.focus;
    if (!v) return;
    F.setSas(order[(order.indexOf(v.sas) + 1) % order.length]);
  };

  F.setWarp = function (i) {
    const max = maxWarpIdx();
    i = U.clamp(i, 0, max);
    if (i === F.warpIdx) return;
    F.warpIdx = i;
    const d = document.getElementById('warpDisp');
    if (d) d.textContent = WARPS[i] + '×';
  };

  function maxWarpIdx() {
    const v = F.focus;
    if (!v) return 0;
    const onRailsOk = v.altASL > 62000 && !v.landed && !v.touching && (v.liveThrust || 0) <= 0;
    return onRailsOk ? WARPS.length - 1 : RAILS_FROM - 1;
  }

  /** Switch which vessel the player is flying/looking at — every other
      control (keys, throttle, staging, SAS) already just reads F.focus, so
      retargeting it is all that's needed to redirect control. */
  F.setFocus = function (v) {
    if (!v || v === F.focus) return;
    F.focus = v;
    R.cam.zoomT = U.clamp(130 / Math.max(6, v.radius() * 2), 1.2, 9);
    F.refreshStages();
    syncSasButtons(v.sas);       // just reflect its current mode — don't reassign sasTarget
    F.setWarp(Math.min(F.warpIdx, maxWarpIdx()));
    F.syncThrottle();
    F.predict(true);
    F.toast('Now flying ' + (v.mission ? v.mission.name : describe(v)));
  };

  /* ═══════════════════ per-frame update ═══════════════════ */

  F.update = function (dt, real) {
    if (!F.running) return;
    const v = F.focus;

    // clamp warp if conditions changed under us
    if (F.warpIdx > maxWarpIdx()) F.setWarp(maxWarpIdx());
    const warp = WARPS[F.warpIdx];
    const rails = F.warpIdx >= RAILS_FROM;

    if (v && !F.over && hudActive) applyInput(v, real);

    const simDt = dt * warp;
    if (rails) {
      for (const ves of F.vessels) if (!ves.dead) PH.coast(ves, simDt, F.t, 10);
      F.t += simDt;
    } else {
      let left = simDt;
      let guard = 0;
      while (left > 1e-6 && guard++ < 140) {
        const h = Math.min(PHYS_DT, left);
        PH.step(F.vessels, h, F.t);
        F.t += h;
        left -= h;
      }
    }
    W.t = F.t;

    S.fx.update(rails ? 0 : dt, F.t, v ? (v.nearBody || W.earth) : W.earth);
    cleanup();
    checkGoals();

    // let the explosion play out before the mission-failed panel covers it.
    // Only actually pops the modal if we're still looking at this vessel —
    // if the player switched away in the meantime, a toast already covered
    // it (see cleanup()), and popping a delayed modal now would set the
    // (global, singleton) F.over flag and block whatever *other* mission
    // they've since switched their attention to.
    if (pendingEnd) {
      pendingEnd.delay -= real;
      if (pendingEnd.delay <= 0) {
        if (hudActive && !F.over) {
          F.overMission = pendingEnd.mission;
          endMission(pendingEnd.title, pendingEnd.text);
        }
        pendingEnd = null;
      }
    }

    if (hudActive && S.audio && v) {
      const thr = v.liveThrust ? U.clamp(v.liveThrust / (v.mass * 12), 0, 1) : 0;
      let hi = rails ? 0 : thr, atmoF = v.atmoF || 0;

      // a spent stage can still be lit when we cut it loose (e.g. a booster
      // burning out) — keep its engine noise alive until it drifts off screen
      // rather than cutting straight to whatever the new focus is doing
      for (let i = echoVessels.length - 1; i >= 0; i--) {
        const ev = echoVessels[i];
        const spent = ev.dead || F.vessels.indexOf(ev) < 0 || !(ev.liveThrust > 0);
        const offscreen = Math.hypot(ev.x - v.x, ev.y - v.y) > R.viewR() * 1.4;
        if (spent || offscreen) { echoVessels.splice(i, 1); continue; }
        if (!rails) {
          const eThr = U.clamp(ev.liveThrust / (ev.mass * 12), 0, 1);
          if (eThr > hi) { hi = eThr; atmoF = ev.atmoF || 0; }
        }
      }

      S.audio.engine(hi, atmoF);
    }

    predTimer -= real;
    if (predTimer <= 0) { F.predict(); predTimer = 0.3; }
    F.predictOthers(real);

    if (hudActive) {
      // a vessel target that crashed or got pruned is gone — drop it instead
      // of planning a rendezvous with wreckage
      if (F.target && F.isVesselTarget(F.target) && (F.target.dead || F.vessels.indexOf(F.target) < 0)) {
        F.toast('Target lost', 'bad');
        F.target = null; F.plan = null;
        F.paintXfer();
      }

      hudTimer -= real;
      if (hudTimer <= 0) { F.hud(); if (F.target) F.paintXfer(); hudTimer = 1 / 15; }

      // planning is expensive, so only redo it when the orbit has actually
      // changed — i.e. shortly after a burn ends
      if (F.target) {
        const burning = (v && v.liveThrust > 0);
        if (wasBurning && !burning) replanIn = 1.2;
        wasBurning = burning;
        if (replanIn > 0) {
          replanIn -= real;
          if (replanIn <= 0) F.replan();
        }
      }
    }
  };

  function applyInput(v, real) {
    const k = F.keys;
    let steer = 0;
    if (k.a || k.arrowleft) steer += 1;
    if (k.d || k.arrowright) steer -= 1;
    v.steer = steer;

    if (k.w || k.arrowup) F.setThrottle(v.throttle + real * 0.85);
    if (k.s || k.arrowdown) F.setThrottle(v.throttle - real * 0.85);
  }

  function cleanup() {
    const v = F.focus;
    for (let i = F.vessels.length - 1; i >= 0; i--) {
      const ves = F.vessels[i];
      if (ves.crash && !ves.dead) {
        ves.dead = true;
        S.fx.explode(ves);
        if (ves === v && !pendingEnd && hudActive) {
          // ves is about to be spliced out and F.focus reassigned below, well
          // before the delayed modal actually appears — carry its mission
          // along explicitly so "Revert to Launch" reverts *this* craft, not
          // whatever F.focus has drifted to by then
          pendingEnd = { title: 'Mission Failed', text: 'Your craft ' + ves.crash + '.', delay: 5, mission: ves.mission };
        } else if (ves.mission) {
          // a background/non-focus mission was lost — say so, but don't pop
          // the (flight-scene-only) mission-failed modal over whatever screen
          // the player is actually looking at
          F.toast((ves.mission.name || 'A craft') + ' was lost: ' + ves.crash, 'bad');
        }
      }
      if (ves.dead) { F.vessels.splice(i, 1); continue; }
      // only ephemeral junk (spent stages/debris) ever gets pruned by distance
      // or headcount — a tagged mission sticks around until it actually dies
      if (ves !== v && ves.debris && !ves.mission) {
        const d = v ? Math.hypot(ves.x - v.x, ves.y - v.y) : Infinity;
        const junkCount = F.vessels.reduce((n, x) => n + (x.mission ? 0 : 1), 0);
        if (d > 60000 || junkCount > 10) F.vessels.splice(i, 1);
      }
    }
    // if the piece we're flying lost its brain, hand over to one that has one
    if (v && !v.hasControl()) {
      const alt = F.vessels.find(x => x !== v && x.hasControl());
      if (alt) { F.focus = alt; F.refreshStages(); F.toast('Control handed to ' + (alt.mission ? alt.mission.name : describe(alt))); }
    }
    if (F.focus && F.vessels.indexOf(F.focus) < 0) F.focus = F.vessels[0] || null;
  }

  function describe(v) {
    return v.parts.length + '-part section';
  }

  /* ═══════════════════ goals ═══════════════════ */

  function checkGoals() {
    const v = F.focus;
    if (!v || v.dead) return;
    const b = v.nearBody || W.earth;

    // per-vessel, not global — otherwise a fresh second rocket still sitting on
    // the pad (already "landed") would count as "come home" the instant any
    // *other* mission had ever reached space
    if (v.altASL > 60000) { unlock('space'); v.reachedSpace = true; }

    // small notice on the way through the atmosphere's edge, in either direction
    if (b.atmo) {
      const nowIn = v.altASL < b.atmo.height;
      if (inAtmo == null) inAtmo = nowIn;           // first look — just set the baseline, no toast
      else if (nowIn !== inAtmo) {
        F.toast(nowIn ? 'Entering the atmosphere' : 'Leaving the atmosphere');
        inAtmo = nowIn;
      }
    } else {
      inAtmo = null;   // nothing to track here (e.g. the Moon) — re-baseline silently next time we're back near an atmosphere
    }

    const soi = W.soiBody(v.x, v.y, F.t);
    if (soi === W.moon) unlock('moonSoi');

    const el = F.el;
    if (el && el.e < 1) {
      if (el.body === W.earth && el.pe > W.earth.radius + 60000) unlock('orbit');
      if (el.body === W.moon && el.pe > W.moon.radius + 3000 && !v.landed) unlock('moonOrbit');
    }

    if (v.landed) {
      if (b === W.moon) unlock('moonLand');
      if (b === W.earth && v.reachedSpace) {
        unlock('home');
        if (v.inWater) unlock('splash');
        // once per vessel — otherwise this fires every frame it sits landed
        if (!v.homeAnnounced) {
          v.homeAnnounced = true;
          // the end-of-mission modal only makes sense for the craft you're
          // actually looking at; a background mission just gets a toast, so
          // it can't leave the global F.over flag set and block whatever
          // *other* mission the player is flying/looking at right now
          if (hudActive && v === F.focus && !F.over) {
            F.overMission = v.mission;
            endMission('Welcome Home', 'You landed back on Earth in one piece.');
          } else {
            F.toast((v.mission ? v.mission.name : 'A craft') + ' made it home safely.', 'gold');
          }
        }
      } else if (b === W.earth && v.inWater) unlock('splash');
    }

    if (W.wrecked.size >= 25) unlock('demolition');
    smashCount = W.wrecked.size;
  }

  /* ═══════════════════ transfer planning ═══════════════════ */

  F.target = null;
  F.plan = null;
  let replanIn = 0, wasBurning = false;

  /** a target is either a celestial body (from W.bodies) or a live vessel
      (picked off the map — see R.pickVessel / the vessel chip) */
  F.isVesselTarget = function (t) { return !!(t && t.parts); };

  F.targetName = function (t) {
    if (!t) return '';
    return F.isVesselTarget(t) ? (t.mission ? t.mission.name : describe(t)) : t.name;
  };

  /** current world position of whatever's targeted, for map drawing */
  F.targetPos = function (t) {
    return F.isVesselTarget(t) ? { x: t.x, y: t.y } : W.bodyPos(t, F.t);
  };

  F.setTarget = function (b) {
    if (!b || b === F.target) { F.target = null; F.plan = null; F.paintXfer(); return; }
    if (F.isVesselTarget(b)) {
      if (b === F.focus) { F.toast("Can't target your own craft", 'bad'); return; }
      const d = Math.hypot(b.x - F.focus.x, b.y - F.focus.y);
      if (d < 5000) { F.toast('You are already at ' + F.targetName(b), 'bad'); return; }
    } else if (b === W.soiBody(F.focus.x, F.focus.y, F.t) && !b.orbit) {
      F.toast('You are already orbiting ' + b.name, 'bad');
      return;
    }
    F.target = b;
    F.replan();
  };

  F.replan = function () {
    if (!F.target || !F.focus || F.focus.dead) { F.plan = null; F.paintXfer(); return; }
    // a vessel target has no closed-form orbit — hand planTransfer a fresh
    // propagated snapshot of it each time, since it may have moved since
    // the last replan
    const t = F.isVesselTarget(F.target) ? W.vesselTarget(F.target, F.t) : F.target;
    F.plan = W.planTransfer(F.focus, t, F.t);
    F.paintXfer();
  };

  /** seconds of burn needed at full throttle to deliver the planned Δv */
  function burnSeconds(v, dv) {
    let T = 0;
    for (const p of v.parts) {
      if (p.def.type !== 'engine' || !p.active) continue;
      const e = p.def.engine;
      const solid = e.solid;
      const fuel = solid ? p.fuel > 0 : v.fuelIn(p.comp).cur > 0;
      if (fuel) T += e.thrust;
    }
    if (T <= 0) return null;
    return (dv * v.mass) / T;
  }

  F.paintXfer = function () {
    const panel = document.getElementById('xferPanel');
    const tip = document.getElementById('mapTip');
    if (!panel) return;
    if (tip) tip.classList.toggle('hidden', !S.render.cam.map || !!F.target);
    if (!F.target) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    document.getElementById('xTitle').textContent = 'TRANSFER → ' + F.targetName(F.target).toUpperCase();

    const body = document.getElementById('xBody');
    const p = F.plan;
    if (!p || !p.ok) {
      body.innerHTML = '<div class="why">' + ((p && p.reason) || 'No route found.') + '</div>';
      return;
    }
    const left = p.tBurn - F.t;
    const row = (k, v2) => '<div class="r"><span>' + k + '</span><b>' + v2 + '</b></div>';
    const secs = burnSeconds(F.focus, p.dv);
    const impact = p.intercept && p.periapsis <= 0;
    let h = row('Burn in', left > 0 ? U.time(left) : 'now')
      + row('Δv needed', U.speed(p.dv))
      + (secs != null ? row('Burn for', secs.toFixed(1) + ' s') : '')
      + row('Travel time', U.time(p.travel))
      + row(p.intercept ? 'Arrival alt' : 'Miss by',
        impact ? 'impact' : U.dist(Math.max(0, p.periapsis)));
    if (left > 0) {
      h += '<div class="go">Point <b>Prograde</b>, wait for zero</div>';
    } else if (left > -Math.max(20, (secs || 20) * 1.5)) {
      h += '<div class="go hot">BURN NOW: prograde</div>';
    } else {
      h += '<div class="go">Window passed. Recalculate</div>';
    }
    if (!p.intercept) {
      h += '<div class="note">This path misses ' + F.targetName(F.target) +
        '. Burn anyway, then recalculate for a correction.</div>';
    } else if (impact) {
      h += '<div class="note">You will arrive on a collision course. Burn ' +
        'retrograde on the way in to slow down and land.</div>';
    }
    body.innerHTML = h;
  };

  /* ═══════════════════ prediction ═══════════════════ */

  F.predict = function () {
    const v = F.focus;
    if (!v || v.dead) { F.path = null; F.el = null; return; }
    const soi = W.soiBody(v.x, v.y, F.t);
    F.el = W.elements(soi, v.x, v.y, v.vx, v.vy, F.t);
    if (v.landed) { F.path = null; return; }
    F.path = W.predict(v.x, v.y, v.vx, v.vy, F.t, { maxSteps: 2000 });
  };

  /** lighter-weight, throttled path prediction for every other vessel in the
      world — other missions *and* junk (spent stages/debris) — so the map
      can show their trajectories too. Only runs while the map is actually
      open (nobody's looking at these paths otherwise), and only bothers with
      craft close enough to the current view to matter; missions get a more
      detailed path than junk since they're the more likely rendezvous target. */
  F.predictOthers = function (real) {
    if (!R.cam.map) return;
    for (const ves of F.vessels) {
      if (ves === F.focus || ves.dead) continue;
      ves._predTimer = (ves._predTimer || 0) - real;
      if (ves._predTimer > 0) continue;
      // stagger by uid so not every vessel recomputes on the same tick
      ves._predTimer = 0.3 + (ves.uid % 5) * 0.15;
      if (ves.landed) { ves.path = null; continue; }
      const d = Math.hypot(ves.x - R.cam.x, ves.y - R.cam.y);
      if (d > R.viewR() * 1.5) { ves.path = null; continue; }   // well off-screen — skip
      ves.path = W.predict(ves.x, ves.y, ves.vx, ves.vy, F.t, { maxSteps: ves.mission ? 1200 : 500 });
    }
  };

  /* ═══════════════════ HUD ═══════════════════ */

  const set = (id, txt) => {
    const e = document.getElementById(id);
    if (e && e.textContent !== txt) e.textContent = txt;
  };

  /** one bar per fuel compartment, so separated boosters no longer get
      blended into the same reading as the main stack */
  let fuelSig = '';
  function paintFuel(v) {
    const box = document.getElementById('fuelBars');
    if (!box) return;
    const groups = v.fuelGroups();
    if (!groups.length) {
      if (fuelSig !== 'none') { box.innerHTML = '<div class="fuelNone">no tanks</div>'; fuelSig = 'none'; }
      return;
    }
    const sig = groups.map(g => g.comp).join(',');
    if (sig !== fuelSig) {
      box.innerHTML = groups.map((_, i) =>
        '<div class="fuelRow"><div class="fuelBar"><div class="fuelFill" data-i="' + i + '"></div></div>' +
        '<span class="fuelPct" data-i="' + i + '"></span></div>'
      ).join('');
      fuelSig = sig;
    }
    groups.forEach((g, i) => {
      const pct = g.cap > 0 ? g.cur / g.cap : 0;
      const fill = box.querySelector('.fuelFill[data-i="' + i + '"]');
      const txt = box.querySelector('.fuelPct[data-i="' + i + '"]');
      const row = fill && fill.closest('.fuelRow');
      if (fill) { fill.style.width = (pct * 100).toFixed(1) + '%'; fill.classList.toggle('empty', pct <= 0.001); }
      if (txt) txt.textContent = Math.round(pct * 100) + '%';
      if (row) row.classList.toggle('firing', g.firing);
    });
  }

  F.hud = function () {
    const v = F.focus;
    if (!v) return;
    const b = v.nearBody || W.earth;
    const bp = W.bodyPos(b, F.t), bv = W.bodyVel(b, F.t);
    const dx = v.x - bp.x, dy = v.y - bp.y;
    const r = Math.hypot(dx, dy) || 1;
    const gi = W.terrain(b, Math.atan2(dy, dx));
    const agl = r - gi, asl = r - b.seaLevel;

    const rvx = v.vx - bv.x, rvy = v.vy - bv.y;
    const spd = Math.hypot(rvx, rvy);
    const vs = (rvx * dx + rvy * dy) / r;

    set('hAlt', (agl < 20000 ? U.dist(agl) + ' AGL' : U.dist(asl)));
    set('hSpd', U.speed(spd));
    set('hVs', (vs >= 0 ? '+' : '') + U.speed(vs));

    const el = F.el;
    if (v.landed) {
      set('hAp', 'N/A'); set('hPe', 'N/A');
    } else if (el && el.e < 1 && isFinite(el.ap)) {
      set('hAp', U.dist(el.ap - el.body.seaLevel));
      // below the surface the periapsis is a re-entry point, not an orbit
      set('hPe', el.pe < el.body.seaLevel ? 'impact' : U.dist(el.pe - el.body.seaLevel));
    } else if (el) {
      set('hAp', 'escape');
      set('hPe', el.pe < el.body.seaLevel ? 'impact' : U.dist(el.pe - el.body.seaLevel));
    }

    const gLoc = b.mu / (r * r);
    set('hTwr', ((v.liveThrust || 0) / (v.mass * gLoc)).toFixed(2));
    set('hDv', U.speed(v.stageDv()));
    set('hSoi', (W.soiBody(v.x, v.y, F.t)).name + (v.landed ? ' · landed' : ''));

    paintFuel(v);

    F.syncThrottle();
    updateStageHighlight();
  };

  F.syncThrottle = function () {
    const v = F.focus;
    if (!v) return;
    const fill = document.getElementById('throttleFill');
    if (fill) fill.style.height = (v.throttle * 100).toFixed(0) + '%';
    set('throttleTxt', Math.round(v.throttle * 100) + '%');
  };

  F.syncUI = function () {
    F.setSas('off');
    F.setWarp(0);
    F.syncThrottle();
  };

  /* ═══════════════════ stage list ═══════════════════ */

  const ICON = { engine: '🔥', sep: '⊟', chute: '🪂' };

  F.refreshStages = function () {
    const panel = document.getElementById('stagePanel');
    const v = F.focus;
    if (!panel || !v) return;
    panel.innerHTML = '';
    v.stages.forEach((g, i) => {
      const row = document.createElement('div');
      row.className = 'stageRow' + (i < v.stageIdx ? ' spent' : (i === v.stageIdx ? ' next' : ''));
      const kinds = {};
      for (const uid of g) {
        const p = v.byUid(uid);
        if (p) kinds[p.def.type] = (kinds[p.def.type] || 0) + 1;
      }
      const label = Object.keys(kinds)
        .map(k => (ICON[k] || '•') + (kinds[k] > 1 ? '×' + kinds[k] : ''))
        .join(' ') || 'N/A';
      row.innerHTML = '<i>' + (i + 1) + '</i><span>' + label + '</span>';
      row.onclick = () => F.stage(i);
      panel.appendChild(row);
    });
  };

  function updateStageHighlight() {
    const panel = document.getElementById('stagePanel');
    const v = F.focus;
    if (!panel || !v) return;
    const rows = panel.children;
    if (rows.length !== v.stages.length) { F.refreshStages(); return; }
    for (let i = 0; i < rows.length; i++) {
      rows[i].className = 'stageRow' + (i < v.stageIdx ? ' spent' : (i === v.stageIdx ? ' next' : ''));
    }
  }

  /* ═══════════════════ mission end ═══════════════════ */

  function endMission(title, text) {
    if (F.over) return;
    F.over = title;
    const ov = document.getElementById('endOverlay');
    if (!ov) return;
    document.getElementById('endTitle').textContent = title;
    document.getElementById('endText').textContent = text;
    ov.classList.remove('hidden');
  }
  F.endMission = endMission;

  function hideEnd() {
    // F.revert() previously always ran through a full F.reset(), which
    // happened to clear F.over/F.overMission as a side effect of wiping
    // everything. Now that revert is per-mission, this is the one place both
    // dismissal paths (Revert, and "Back to Hangar") funnel through, so it
    // has to clear them explicitly — otherwise F.over stays stuck true and
    // silently blocks input/staging on every craft from here on.
    F.over = null;
    F.overMission = null;
    const ov = document.getElementById('endOverlay');
    if (ov) ov.classList.add('hidden');
  }
  F.hideEnd = hideEnd;

  F.smashCount = () => smashCount;
  F.warpLabel = () => WARPS[F.warpIdx] + '×';

  /* ═══════════════════ pause / resume (save games) ═══════════════════
     Unlike sfs_lastBlueprint (the VAB design), this captures the whole
     in-progress world — every mission's exact position/velocity/fuel/stage,
     sim time and which craft has focus — so the player can close the tab
     and pick every active flight back up unchanged. */

  const SAVE_KEY = 'saveGame';

  F.saveGame = function () {
    if (!F.running || !F.vessels.length) { U.store.del(SAVE_KEY); return; }
    U.store.set(SAVE_KEY, {
      version: 1, savedAt: Date.now(),
      simTime: F.t, warpIdx: F.warpIdx,
      focusMissionId: (F.focus && F.focus.mission) ? F.focus.mission.id : null,
      vessels: F.vessels.filter(v => !v.dead).map(S.vessel.toState),
      camera: { map: R.cam.map, mapZoom: R.cam.mapZoom, offX: R.cam.offX, offY: R.cam.offY },
      wrecked: [...W.wrecked]
    });
  };

  /** Called once on boot. Returns true if a paused game was restored. */
  F.loadGame = function () {
    const st = U.store.get(SAVE_KEY, null);
    if (!st || !st.vessels || !st.vessels.length) return false;

    W.resetScenery();
    for (const key of st.wrecked || []) W.wrecked.add(key);

    F.vessels.length = 0;
    let dropped = 0;
    for (const vs of st.vessels) {
      const v = S.vessel.fromState(vs);
      if (v) F.vessels.push(v); else dropped++;
      // keep the uid counter (shared with the VAB) past anything we just restored
      for (const p of vs.parts) S.vessel.seedUid(p.uid);
    }
    if (!F.vessels.length) return false;

    F.t = st.simTime || 0;
    W.t = F.t;
    F.warpIdx = U.clamp(st.warpIdx || 0, 0, 7);
    F.focus = F.vessels.find(v => v.mission && v.mission.id === st.focusMissionId) || F.vessels[0];
    F.running = true;
    F.over = null;
    pendingEnd = null;
    echoVessels = [];
    inAtmo = null;
    // a resumed vessel may already be well past first-space; setting this
    // conservatively true just means a landed craft can unlock "home" again
    // (harmless — unlock() is idempotent) instead of silently never being able to
    for (const rv of F.vessels) rv.reachedSpace = true;

    if (st.camera) {
      R.cam.map = !!st.camera.map;
      R.cam.mapZoom = R.cam.mapZoomT = st.camera.mapZoom || R.cam.mapDefault;
      R.cam.offX = st.camera.offX || 0;
      R.cam.offY = st.camera.offY || 0;
    }

    F.refreshStages();
    F.predict(true);
    if (dropped) F.toast(dropped + ' craft could not be restored (parts changed).', 'bad');
    F.toast('Welcome back — resumed ' + F.vessels.filter(v => v.mission).length + ' mission(s).');
    return true;
  };

})(window.SFS);
