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
  let pendingEnd = null;                  // { title, text, delay, wreck } — holds the destroyed panel back while the wreck burns
  let echoVessels = [];                   // spent stages still burning after separation, kept audible until off screen
  let inAtmo = null;                      // null = not tracking yet; true/false once we know, so we can toast on the flip
  let wreckFocus = null;                  // a destroyed craft the camera deliberately stays with (see cleanup)
  let pinned = null;                      // the craft the player last chose to fly — debris included
  let burn = null;                        // { need, done } while the plotted transfer burn is actually running
  let approachSet = false;                // does the path we're on already reach the target?

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
    { id: 'demolition', label: 'Flatten 25 buildings' },
    { id: 'interplanetary', label: 'Escape into solar orbit' },
    { id: 'marsSoi', label: 'Reach Mars' },
    { id: 'marsOrbit', label: 'Orbit Mars' },
    { id: 'marsLand', label: 'Land on Mars' },
    { id: 'koreLand', label: 'Land on Kore' },
    { id: 'sunDive', label: 'Skim the Sun and survive' }
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

  /** keep the mission-id counter past anything a resumed save restored —
      otherwise the next launch is handed an id a live mission already has,
      and everything keyed on it (the save's focus, the missions widget)
      starts confusing one craft for another */
  function seedMissionSeq(id) {
    const n = parseInt(String(id).replace(/^m/, ''), 10);
    if (n >= missionSeq) missionSeq = n + 1;
  }

  /** Build a fresh vessel from a blueprint and sit it on the pad, nose
      straight up. Shared by a brand-new game, an additional launch
      alongside missions already flying, and a per-mission revert. */
  function spawnOnPad(bp, missionOverride) {
    const v = S.vessel.fromBlueprint(bp);
    if (!v) return null;

    // if another craft is still sitting on the pad (e.g. launching a second
    // rocket before the first has lifted off), nudge this one along the pad
    // instead of spawning it stacked directly inside the other one
    const pad = W.padPoint(F.t);
    const parked = F.vessels.filter(x => !x.dead && Math.hypot(x.x - pad.x, x.y - pad.y) < 400).length;
    const th = W.padTheta + (parked ? Math.ceil(parked / 2) * (parked % 2 ? 1 : -1) * 0.002 : 0);

    const g = W.terrain(W.earth, th);
    let lo = Infinity;
    for (const p of v.parts) lo = Math.min(lo, p.ly - p.def.h / 2);
    const clearance = v.com.y - lo;
    const r = g + clearance + 0.06;
    // Earth is going round the Sun, so the pad is a moving place: sit the
    // craft at Earth's position plus the pad offset, and give it Earth's
    // velocity or it would be left behind at two kilometres a second
    const ep = W.bodyPos(W.earth, F.t), ev = W.bodyVel(W.earth, F.t);
    // nose straight up: rot(a)·(0,1) must equal the outward radial at θ
    v.angle = th - Math.PI / 2;
    v.x = ep.x + Math.cos(th) * r;
    v.y = ep.y + Math.sin(th) * r;
    v.vx = ev.x; v.vy = ev.y; v.omega = 0;
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
    wreckFocus = null;
    pinned = null;
    burn = null;
    approachSet = false;
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

  /**
   * Close a mission out for good — the way to clear a finished flight (and
   * free one of the MAX_MISSIONS slots) without having to crash it. Offered
   * from the active-missions widget on the menu and in the hangar.
   */
  F.recover = function (v) {
    if (!v) return false;
    const name = (v.mission && v.mission.name) || describe(v);
    const home = !!(v.landed || v.inWater);
    const i = F.vessels.indexOf(v);
    if (i >= 0) F.vessels.splice(i, 1);
    if (F.target === v) { F.target = null; F.plan = null; F.paintXfer(); }
    if (v === wreckFocus) { wreckFocus = null; pendingEnd = null; }
    if (v === pinned) pinned = null;
    if (v === F.focus) {
      F.focus = F.vessels.find(x => x.mission && x.hasControl()) || F.vessels[0] || null;
      if (F.focus) {
        F.refreshStages();
        syncSasButtons(F.focus.sas);
        F.syncThrottle();
        F.predict(true);
      }
    }
    if (!F.vessels.length) { F.running = false; F.over = null; }
    F.toast(home ? 'Recovered ' + name : name + ' was scrapped in flight',
      home ? 'gold' : 'bad');
    F.saveGame();
    return true;
  };

  /**
   * Cut a canopy loose. Useful the moment you're down — a chute still pulling
   * will drag a lander over — and as a last resort if one opens at the wrong
   * time. The pack is spent afterwards; there's no repacking it in flight.
   */
  F.cutChute = function (v, p) {
    if (!v || !p || !p.def.chute) return false;
    if (!p.chuteOut && p.chute <= 0.001) { F.toast('That parachute is still packed', 'bad'); return false; }
    if (!v.hasControl()) { F.toast('No command pod aboard to cut it', 'bad'); return false; }
    p.chuteOut = false;
    p.chute = 0;
    p.cut = true;                       // staging can't redeploy a cut chute
    const wp = v.worldOf(p, {});
    if (S.fx) S.fx.puff(wp.x, wp.y, Math.max(2, p.def.chute.width * 0.35));
    if (S.audio) S.audio.ui();
    F.toast('Parachute cut');
    return true;
  };

  /* ═══════════════════ staging ═══════════════════ */

  F.stage = function (idx) {
    const v = F.focus;
    if (!v || v.dead || F.over || !v.hasControl() || warpBlocked()) return;
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
    const v = F.focus;
    if (v && v.hasControl() && !warpBlocked()) v.throttle = U.clamp(t, 0, 1);
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
    if (!v || !v.hasControl() || warpBlocked()) return;
    v.sas = mode;
    if (mode !== 'off') v.sasTarget = v.angle;
    syncSasButtons(mode);
  };

  /**
   * Two things take the controls away, and both used to do it silently.
   *
   * Debris — a spent stage, or any piece with no command pod — can be flown
   * along with: the camera follows it and the map draws its path, but there is
   * no brain aboard to steer with. And above 500× the sim runs on rails, where
   * craft only slide along their orbits: thrust and steering do nothing at all
   * there. Either way the controls go grey and say which it is.
   */
  function syncControlLock() {
    const v = F.focus;
    const debris = !!v && !v.hasControl();
    const warped = F.warpIdx >= RAILS_FROM;
    const ctr = document.getElementById('controls');
    const sas = document.getElementById('sasWrap');
    const note = document.getElementById('noCtrl');
    if (ctr) ctr.classList.toggle('locked', debris || warped);
    if (sas) sas.classList.toggle('locked', debris || warped);
    if (note) {
      note.classList.toggle('hidden', !(debris || warped));
      note.textContent = debris
        ? 'Debris — no command pod aboard, so there is nothing to steer with'
        : 'Time warp ' + WARPS[F.warpIdx] + '× — controls are off until you slow down (,)';
    }
  }

  /** true when the controls are inert because of time warp — and says so, at
      most every few seconds, so a player pressing keys isn't left guessing */
  let warpWarn = 0;
  function warpBlocked() {
    if (F.warpIdx < RAILS_FROM) return false;
    if (hudActive && warpWarn <= 0) {
      warpWarn = 4;
      F.toast('Controls are off at ' + WARPS[F.warpIdx] + '× — press , to slow the time warp', 'bad');
    }
    return true;
  }

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
    syncControlLock();          // rails warp greys the controls out
  };

  function maxWarpIdx() {
    const v = F.focus;
    if (!v) return 0;
    // clear of the air of whatever world we're over — measured against that
    // world's own atmosphere, since Mars' is thin and the Moon has none
    const near = v.nearBody || W.earth;
    const clear = near.atmo ? near.atmo.height + 2000 : 5000;
    const onRailsOk = v.altASL > clear && !v.landed && !v.touching && (v.liveThrust || 0) <= 0;
    if (!onRailsOk) return RAILS_FROM - 1;
    // Closing on another world, ease off. A substep at top warp covers more
    // ground than the Moon's whole sphere of influence is wide, so the craft
    // jumps clean over the arrival it spent a transfer aiming at — the pass
    // goes unsampled, the goal never fires, and the approach integrates badly
    // just where it matters most. The sphere we are already inside doesn't
    // count, or sitting in low orbit would peg the warp for the whole flight.
    const here = v.refBody || W.soiBody(v.x, v.y, F.t);
    for (const b of W.bodies) {
      if (!b.soi || b === here) continue;
      const bp = W.bodyPos(b, F.t), bv = W.bodyVel(b, F.t);
      const dx = v.x - bp.x, dy = v.y - bp.y;
      if (dx * dx + dy * dy > (b.soi * 3) * (b.soi * 3)) continue;
      // Only ease off for a world we are *closing on*. Pulling away from one
      // is no risk at all, and clamping there made every departure crawl for
      // as long as it took to coast clear of the planet just left behind.
      if ((v.vx - bv.x) * dx + (v.vy - bv.y) * dy < 0) return Math.min(WARPS.length - 1, 5);
    }
    return WARPS.length - 1;
  }

  /** Switch which vessel the player is flying/looking at — every other
      control (keys, throttle, staging, SAS) already just reads F.focus, so
      retargeting it is all that's needed to redirect control. */
  F.setFocus = function (v) {
    if (!v) return;
    // remember that this was the player's own choice: cleanup() must not undo
    // it by handing control back to a craft that still has a pod, which is the
    // whole reason a piece of debris can be flown at all
    pinned = v;
    if (v === F.focus) return;
    wreckFocus = null;
    F.focus = v;
    R.cam.zoomT = U.clamp(130 / Math.max(6, v.radius() * 2), 1.2, 9);
    F.refreshStages();
    syncSasButtons(v.sas);       // just reflect its current mode — don't reassign sasTarget
    F.setWarp(Math.min(F.warpIdx, maxWarpIdx()));
    F.syncThrottle();
    syncControlLock();
    F.predict(true);
    F.toast(v.hasControl()
      ? 'Now flying ' + (v.mission ? v.mission.name : describe(v))
      : 'Following ' + describe(v) + ' — no pod aboard, so no controls');
  };

  /* ═══════════════════ per-frame update ═══════════════════ */

  F.update = function (dt, real) {
    if (!F.running) return;
    const v = F.focus;

    // clamp warp if conditions changed under us
    const capIdx = maxWarpIdx();
    if (F.warpIdx > capIdx) {
      const was = F.warpIdx;
      F.setWarp(capIdx);
      if (hudActive && capIdx >= RAILS_FROM && was > capIdx) {
        F.toast('Easing off the time warp — closing on ' + (v && v.nearBody ? v.nearBody.name : 'a world'));
      }
    }
    const warp = WARPS[F.warpIdx];
    const rails = F.warpIdx >= RAILS_FROM;

    if (warpWarn > 0) warpWarn -= real;
    if (v && !F.over && hudActive) applyInput(v, real);

    const simDt = dt * warp;
    // effects spawned inside the step below belong to the world under the
    // craft, and settle into its motion rather than into the Sun's frame
    S.fx.frameFrom(v ? (v.nearBody || W.earth) : W.earth, F.t);

    if (rails) {
      // craft still collide with each other and with the ground while the
      // clock is wound forward — see PH.rails for the swept tests that makes
      // possible at these step sizes
      PH.rails(F.vessels, simDt, F.t, 4);
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
    S.fx.clock = F.t;                      // anything spawned below is born now
    cleanup();
    checkGoals();

    // Let the wreck burn on screen for the full five seconds before the panel
    // covers it — the camera stays with the destroyed craft the whole time
    // (see cleanup) rather than cutting away to some other mission.
    // Only actually pops the modal if we're still looking at this vessel —
    // if the player switched away in the meantime, a toast covers it instead,
    // since popping a delayed modal now would set the (global, singleton)
    // F.over flag and block whatever *other* mission they've moved on to.
    if (pendingEnd) {
      pendingEnd.delay -= real;
      if (pendingEnd.delay <= 0) {
        const holding = F.focus === pendingEnd.wreck;
        if (hudActive && !F.over && holding) {
          F.overMission = pendingEnd.mission;
          endMission(pendingEnd.title, pendingEnd.text);
        } else {
          if (pendingEnd.mission) {
            F.toast((pendingEnd.mission.name || 'A craft') + ' was lost', 'bad');
          }
          wreckFocus = null;          // let cleanup hand the camera to something alive
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

      heatWatch(v);

      hudTimer -= real;
      if (hudTimer <= 0) { F.hud(); if (F.target) F.paintXfer(); hudTimer = 1 / 15; }

      // A full replan is expensive, so it only runs when the orbit has really
      // changed — shortly after a burn ends, or once a window has slipped past
      // unused. While the burn is actually happening the panel is kept live
      // from the Δv delivered so far instead (see trackBurn).
      if (F.target) {
        trackBurn(v, simDt);
        watchApproach();
        if (replanIn > 0) {
          replanIn -= real;
          if (replanIn <= 0) F.replan();
        }
        if (replanCool > 0) replanCool -= real;
        // A correction or a capture node is cheap to work out (~5 ms) and goes
        // stale quickly as the craft falls, so it refreshes on a short leash —
        // otherwise the player lines up on a figure that was true a minute ago
        // and always ends up a little short. A full transfer search costs four
        // times as much and only needs redoing once its window has slipped by.
        const p = F.plan;
        const cheap = !!(p && p.ok && (p.correction || p.capture));
        // A cheap plan goes stale by *age* — it describes a burn from where the
        // craft is right now. A transfer plan describes a window in the future
        // and must be left alone until that window has actually gone by;
        // ageing those out too would keep sliding the countdown forward and it
        // would never reach zero.
        const age = F.t - (p && p.madeAt != null ? p.madeAt : F.t);
        const toNode = p ? p.tBurn - F.t : 0;
        // A departure window days away is only worth what the craft's actual
        // position makes it: warp there and a little integration drift moves
        // the ejection point, which for an interplanetary shot is the whole
        // ballgame. So a transfer plan is also refreshed while it waits — often
        // enough to stay true, rarely enough not to cost anything, and never
        // once the node is close (see the freeze below).
        const since = cheap
          ? age
          : (toNode < -45 ? 1e9
            : (toNode > 600 && age > Math.max(300, toNode * 0.1)) ? 1e9 : 0);
        // Hands off once the node is nearly here. Re-solving a capture in the
        // last few seconds can hand back a completely different burn — the
        // node it was aiming at slips behind the craft and the next one is an
        // orbit away — and the player, already lined up and reaching for the
        // throttle, would burn that instead. Whatever we told them to do is
        // what stands until the burn is over.
        const node = !!(p && p.ok && p.tBurn > (p.madeAt || 0) + 1);
        const imminent = node && p.tBurn - F.t < burnLead() + 25;
        if (!burn && !imminent && replanIn <= 0 && replanCool <= 0 && p && p.ok &&
          since > (cheap ? 8 : 45)) {
          // real seconds, stretched when the planner is working hard
          replanCool = U.clamp(planMs / 12, cheap ? 1.5 : 6, 25);
          F.replan();
        }
      }
    }
  };

  function applyInput(v, real) {
    if (!v.hasControl()) return;
    const k = F.keys;
    const held = k.a || k.d || k.w || k.s ||
      k.arrowleft || k.arrowright || k.arrowup || k.arrowdown;
    if (held && warpBlocked()) { v.steer = 0; return; }

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
          // Hold the camera on the wreck for the whole five seconds instead of
          // cutting to another craft the instant this one dies. ves is about to
          // be spliced out of F.vessels, so wreckFocus is what keeps F.focus
          // pointing at it — and its mission is carried along explicitly so
          // "Revert to Launch" reverts *this* craft, whatever happens next.
          wreckFocus = ves;
          pendingEnd = {
            title: 'Spacecraft Destroyed', text: 'Your craft ' + ves.crash + '.',
            delay: 5, mission: ves.mission, wreck: ves
          };
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
    // If the piece we're flying lost its brain, hand over to one that has one —
    // unless the player deliberately picked this piece (that's what flying
    // debris *is*), or we're holding on a wreck until its panel comes up.
    if (v && !v.hasControl() && v !== pinned && v !== wreckFocus) {
      const alt = F.vessels.find(x => x !== v && x.hasControl());
      if (alt) { F.focus = alt; F.refreshStages(); syncControlLock(); F.toast('Control handed to ' + (alt.mission ? alt.mission.name : describe(alt))); }
    }
    if (F.focus && F.focus !== wreckFocus && F.vessels.indexOf(F.focus) < 0) {
      F.focus = F.vessels[0] || null;
      syncControlLock();
    }
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
    if (b === W.earth && v.altASL > 60000) { unlock('space'); v.reachedSpace = true; }

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
    if (soi === W.mars) unlock('marsSoi');
    if (soi === W.sun && v.reachedSpace) unlock('interplanetary');

    // Close enough to the Sun to be in real trouble. Set at the range where an
    // unshielded hull cooks in under a minute but a shield pointed sunward
    // holds — so the badge means "went there and came back", not "went there".
    const sp = W.bodyPos(W.sun, F.t);
    if (Math.hypot(v.x - sp.x, v.y - sp.y) < W.sun.radius * 4.5) unlock('sunDive');

    const el = F.el;
    if (el && el.e < 1) {
      if (el.body === W.earth && el.pe > W.earth.radius + 60000) unlock('orbit');
      if (el.body === W.moon && el.pe > W.moon.radius + 3000 && !v.landed) unlock('moonOrbit');
      if (el.body === W.mars && el.pe > W.mars.radius + 28000 && !v.landed) unlock('marsOrbit');
    }

    if (v.landed) {
      if (b === W.moon) unlock('moonLand');
      if (b === W.mars) unlock('marsLand');
      if (b === W.byId.kore) unlock('koreLand');
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
  let replanIn = 0, wasBurning = false, replanCool = 0;

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
    burn = null;
    approachSet = false;
    if (!b || b === F.target) { F.target = null; F.plan = null; F.paintXfer(); return; }
    if (!F.focus) return;                 // nothing left flying to plan a route for
    if (F.isVesselTarget(b)) {
      if (b === F.focus) { F.toast("Can't target your own craft", 'bad'); return; }
      const d = Math.hypot(b.x - F.focus.x, b.y - F.focus.y);
      if (d < 5000) { F.toast('You are already at ' + F.targetName(b), 'bad'); return; }
    } else if (b === W.soiBody(F.focus.x, F.focus.y, F.t) || W.isAncestor(b, W.soiBody(F.focus.x, F.focus.y, F.t))) {
      // a world we are already inside the sphere of: targeting it means "plan
      // me into a low orbit round it", which works from anywhere but the pad
      if (F.focus.landed) { F.toast('Get off the ground first', 'bad'); return; }
    }
    F.target = b;
    F.replan();
  };

  /** every plan carries when it was worked out, so the loop above can tell a
      fresh one from a stale one whatever kind it is */
  function stamped(p) {
    if (p) p.madeAt = F.t;
    return p;
  }

  // How long the last plan took to work out, in milliseconds. A trim around
  // Earth costs a few; a crossing between planets costs a hundred, because it
  // has to fly the whole route to score it. Backing the refresh rate off in
  // proportion keeps the expensive ones from stuttering the frame rate.
  let planMs = 5;
  function timedPlan(fn) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    const p = fn();
    if (t0) planMs = 0.7 * planMs + 0.3 * (performance.now() - t0);
    return p;
  }

  F.replan = function () {
    const v = F.focus;
    if (!F.target || !v || v.dead) { F.plan = null; F.paintXfer(); return; }
    if (arrived(v)) { F.paintXfer(); return; }           // rendezvous done

    // Within the target world's own sphere of influence — or targeting the
    // world everything else orbits, which we are always inside — the job is no
    // longer "get there" but "settle into a low orbit around it".
    if (!F.isVesselTarget(F.target)) {
      const b = F.target;
      const here = W.soiBody(v.x, v.y, F.t);
      // Already inside that world's sphere — either orbiting it, or orbiting
      // something that orbits it (the Moon, from Earth's point of view). Either
      // way the job is "settle into a low orbit round it", not "fly there".
      if (b === here || W.isAncestor(b, here)) {
        F.plan = stamped(timedPlan(() => W.planCapture(v, b, F.t)));
        F.paintXfer();
        return;
      }
    }

    // Already climbing out of a planet's grip with another world targeted?
    // Then the departure window is behind us and the useful answer is the trim
    // that fixes where we come out — not a scolding about escape paths.
    if (!F.isVesselTarget(F.target)) {
      const elHere = W.elements(W.soiBody(v.x, v.y, F.t), v.x, v.y, v.vx, v.vy, F.t);
      if (elHere.e >= 1) {
        const c = timedPlan(() => W.planCorrection(v, F.target, F.t));
        if (c && c.ok) { F.plan = stamped(c); F.paintXfer(); return; }
      }
    }

    // a vessel target has no closed-form orbit — hand the planner a fresh
    // propagated snapshot of it each time, since it may have moved since
    // the last replan
    const tg = F.isVesselTarget(F.target) ? W.vesselTarget(F.target, F.t) : F.target;
    // Already on our way? Then the useful answer is the nudge that fixes where
    // we arrive, not a brand-new departure window days from now.
    const ap = liveApproach();
    if (ap && ap.inSoi && !v.landed) {
      const c = timedPlan(() => W.planCorrection(v, tg, F.t));
      if (c) { F.plan = stamped(c); F.paintXfer(); return; }
    }
    F.plan = stamped(timedPlan(() => W.planTransfer(v, tg, F.t)));
    F.paintXfer();
  };

  /**
   * The target wrapped so W.predict can measure how close the path we are
   * *actually* on comes to it. That's the number that tells a player whether
   * the burn worked, live, instead of only after the next full replan.
   */
  function watchOf() {
    const tg = F.target;
    if (!tg) return null;
    if (!F.isVesselTarget(tg)) {
      // "closest approach" means nothing for the world we are already going
      // round — that one is handled as a capture, not a transfer
      if (!tg.orbit) return null;
      return { posAt: tt => W.bodyPos(tg, tt), radius: tg.radius, soi: tg.soi || tg.radius * 2.5 };
    }
    // a craft has no closed-form orbit, so reuse the propagated track the
    // current plan already built for it rather than integrating another one
    const wrap = (F.plan && F.plan.ok && F.plan.target && F.plan.target.isVessel) ? F.plan.target : null;
    if (!wrap || !wrap.track) return null;
    return { posAt: tt => wrap.track.at(tt), radius: Math.max(8, tg.radius()), soi: wrap.soi || 5000 };
  }

  /** have we actually got where we were going? (worlds report this through
      the capture plan's `done` flag instead — being in the neighbourhood of a
      world isn't the same as being in orbit around it) */
  function arrived(v) {
    const tg = F.target;
    if (!tg || !v || !F.isVesselTarget(tg)) return false;
    return Math.hypot(tg.x - v.x, tg.y - v.y) < 3000;
  }

  /** closest approach along the currently predicted path, or null if we're
      not pointed anywhere near the target yet */
  function liveApproach() {
    const pr = F.path, w = watchOf();
    if (!pr || !pr.closest || !w || !isFinite(pr.closest.d)) return null;
    const soi = w.soi || w.radius * 3;
    if (pr.closest.d > soi * 3) return null;
    return {
      d: pr.closest.d, soi,
      alt: pr.closest.d - w.radius,
      eta: pr.closest.t - F.t,
      inSoi: pr.closest.d < soi
    };
  }

  /**
   * Watch the plotted burn as it actually happens: count the Δv delivered so
   * the panel can show what is *left* rather than the figure it started with,
   * and say plainly when it's done. A burn that overshoots or undershoots is
   * picked up by the replan that follows it.
   */
  function trackBurn(v, simDt) {
    const p = F.plan;
    const burning = !!(v && !v.dead && (v.liveThrust || 0) > 0);
    if (p && p.ok) {
      const lead = burnLead();
      if (!p._opened && F.t >= p.tBurn - lead) {
        p._opened = true;
        // a correction is "open" the moment it's planned; only the once-per-
        // transfer departure window is worth interrupting the player for
        if (!burning && !p.correction && hudActive) {
          F.toast('Burn window open — point prograde and throttle up');
        }
      }
      // anything lit within half a minute of the window counts as *this* burn
      if (burning && F.t >= p.tBurn - lead - 30) {
        if (!burn) burn = { need: p.dv, done: 0, announced: false };
        burn.done += (v.liveThrust / Math.max(1, v.mass)) * simDt;
        if (!burn.announced && burn.done >= burn.need) {
          burn.announced = true;
          if (hudActive) F.toast('Burn complete — cut the throttle (X)', 'gold');
          if (S.audio) S.audio.blip(720, 0.16, 'sine', 0.1);
        }
      }
    }
    if (wasBurning && !burning) { replanIn = 1.2; burn = null; }
    wasBurning = burning;
  }

  /** the moment the path we're on genuinely reaches the target, say so */
  function watchApproach() {
    const ap = liveApproach();
    if (ap && ap.inSoi && !approachSet) {
      approachSet = true;
      if (hudActive) {
        F.toast('Approach set — ' + F.targetName(F.target) + ' in ' + U.time(Math.max(0, ap.eta)), 'gold');
        if (S.audio) S.audio.blip(880, 0.2, 'sine', 0.12);
      }
    } else if (!ap || ap.d > ap.soi * 1.2) {
      approachSet = false;
    }
  }

  /**
   * How early to light the engine. The planner works in instantaneous kicks,
   * but a real burn takes time — start it on the node and half of it lands
   * late, which is exactly the sort of thing that leaves a beginner wondering
   * why a "correct" burn missed. Splitting the burn either side of the node
   * puts its centre of effort where the plan assumed it.
   */
  function burnLead() {
    const p = F.plan;
    if (!p || !p.ok || !F.focus) return 0;
    const s = burnSeconds(F.focus, p.dv);
    // a capture burn happens *at* its node with no travel to speak of, so the
    // only sensible cap there is half the burn itself
    const cap = p.travel > 0 ? p.travel * 0.25 : Infinity;
    return s ? Math.min(s / 2, cap) : 0;
  }

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

    const body = document.getElementById('xBody');
    const pro = document.getElementById('xPro');
    const p = F.plan;
    const v = F.focus;
    const heading = (p && p.capture) ? 'ORBIT → ' : 'TRANSFER → ';
    document.getElementById('xTitle').textContent = heading + F.targetName(F.target).toUpperCase();

    // got there: stop offering routes to somewhere we already are, and say
    // what to do next instead
    if (v && arrived(v)) {
      body.innerHTML = '<div class="go ok">Arrived at ' + F.targetName(F.target) + '</div>' +
        '<div class="note">Close the last of the gap on <b>retrograde</b> to match speed.</div>';
      if (pro) pro.classList.add('hidden');
      return;
    }
    if (p && p.done) {
      body.innerHTML = '<div class="go ok">In a low orbit around ' + F.targetName(F.target) + '</div>' +
        '<div class="note">Circular at ' + U.dist(Math.max(0, p.orbitAlt)) +
        ' — nothing left to burn. Point retrograde and burn again when you want to come down.</div>';
      if (pro) pro.classList.add('hidden');
      return;
    }

    if (!p || !p.ok) {
      body.innerHTML = '<div class="why">' + ((p && p.reason) || 'No route found.') + '</div>';
      if (pro) pro.classList.add('hidden');
      return;
    }

    const row = (k, val, cls) => '<div class="r' + (cls ? ' ' + cls : '') +
      '"><span>' + k + '</span><b>' + val + '</b></div>';
    // count down to lighting the engine, not to the node itself
    const left = p.tBurn - burnLead() - F.t;
    const ap = liveApproach();
    // once the engine is lit, the panel counts down what is still to be burned
    // rather than repeating the figure the burn started at
    const dvLeft = burn ? Math.max(0, burn.need - burn.done) : p.dv;
    const secs = v ? burnSeconds(v, dvLeft) : null;
    const name = F.targetName(F.target);

    // Is the correction the planner found actually worth burning? It has to
    // move the arrival somewhere better, by enough to matter — and if the path
    // already reaches the target's sphere of influence, only a cheap trim is
    // worth it out here: arriving and then burning at periapsis buys far more
    // than the same fuel spent mid-crossing.
    const gain = p.correction
      ? Math.abs(p.nowPeriapsis - p.wantAlt) - Math.abs(p.periapsis - p.wantAlt) : 0;
    const willArrive = !!(ap && ap.inSoi);
    const worthIt = !!p.correction && p.dv >= 0.5 &&
      gain > Math.max(15000, Math.abs(p.wantAlt)) &&
      (!willArrive || p.dv < 60);
    const aim = p.retro ? 'Retrograde' : 'Prograde';

    let h = '';
    if (burn) {
      const done = U.clamp(burn.done / Math.max(1e-6, burn.need), 0, 1);
      h += row('Δv still to burn', U.speed(dvLeft), 'live')
        + (secs != null ? row('Hold for', secs.toFixed(1) + ' s') : '')
        + '<div class="bBar"><div class="bFill" style="width:' + (done * 100).toFixed(1) + '%"></div></div>';
    } else if (p.correction) {
      if (worthIt) {
        h += row('Correction', U.speed(p.dv) + ' ' + aim.toLowerCase())
          + (secs != null ? row('Burn for', secs.toFixed(1) + ' s') : '')
          + row(p.toOrbit ? 'Pass becomes' : 'Would arrive at',
            p.periapsis <= 0 ? 'impact' : U.dist(Math.max(0, p.periapsis)));
      }
    } else if (p.capture) {
      h += row('Burn at ' + (p.at || 'apsis'), left > 0 ? U.time(left) : 'now')
        + row('Δv needed', U.speed(p.dv))
        + (secs != null ? row('Burn for', secs.toFixed(1) + ' s') : '')
        + row('Leaves you at', U.dist(Math.max(0, p.orbitAlt)));
    } else {
      h += row('Burn in', left > 0 ? U.time(left) : 'now')
        + row('Δv needed', U.speed(p.dv))
        + (secs != null ? row('Burn for', secs.toFixed(1) + ' s') : '');
    }
    if (!p.capture) {
      if (ap) {
        h += row('Closest pass', ap.alt <= 0 ? 'impact' : U.dist(ap.alt), 'live')
          + row('Arrives in', U.time(Math.max(0, ap.eta)), 'live');
      } else {
        h += row('Travel time', U.time(p.travel))
          + row(p.intercept ? 'Arrival alt' : 'Miss by',
            p.periapsis <= 0 ? 'impact' : U.dist(Math.max(0, p.periapsis)));
      }
    }

    if (burn) {
      h += '<div class="go hot">BURNING — hold ' + aim.toLowerCase() + ' until Δv hits zero</div>';
    } else if (p.correction) {
      h += worthIt
        ? '<div class="go hot">' + (p.toOrbit ? 'BURN NOW' : 'TRIM NOW') +
          ' — point <b>' + aim + '</b> and hold it</div>'
        : '<div class="go ok">On course for ' + name + '</div>';
    } else if (!p.capture && ap && ap.inSoi) {
      // (a capture plan is past "on course" — it's the arrival burn itself,
      // and it needs its own countdown, not a reassuring green banner)
      h += '<div class="go ok">On course for ' + name + '</div>';
    } else if (left > 6) {
      h += '<div class="go">Point <b>' + aim + '</b>, then throttle up at zero</div>';
    } else if (left > -Math.max(20, (secs || 20) * 1.5)) {
      h += '<div class="go hot">BURN NOW — ' + aim.toLowerCase() + ', full throttle</div>';
    } else {
      h += '<div class="go">Window passed — replanning…</div>';
    }

    // there is no point counting down to a burn the craft cannot afford
    const have = v ? v.stageDv() : 0;
    if (!burn && have > 0 && have < p.dv * 0.97) {
      h += '<div class="note warn">Only ' + U.speed(have) + ' left in this stage, and the burn needs ' +
        U.speed(p.dv) + '. Stage first, or expect to come up short.</div>';
    }

    if (p.capture && p.at) {
      h += '<div class="note">' + (p.at === 'apoapsis'
        ? 'Burning at the high point lifts the other side of the orbit up to meet it.'
        : 'Burning at the low point pulls the far side of the orbit down to meet it.') + '</div>';
    } else if (ap && ap.inSoi && !worthIt) {
      h += '<div class="note">' + (F.isVesselTarget(F.target)
        ? 'Coast in, then burn retrograde as you close, to match speed.'
        : 'Coast in, then burn <b>retrograde</b> at the closest point to drop into orbit around ' +
        name + '. Land from there.') + '</div>';
    } else if (!p.intercept && !p.correction) {
      h += '<div class="note">The best pass found still misses ' + name +
        '. Burn it anyway — the plan refines itself once you are on your way.</div>';
    }
    body.innerHTML = h;

    // the "point me the right way" button follows whichever way the burn needs
    if (pro) {
      const want = p.retro ? 'retro' : 'pro';
      pro.textContent = p.retro ? '🧭 Point retrograde' : '🧭 Point prograde';
      pro.dataset.sas = want;
      pro.classList.toggle('hidden', !v || !v.hasControl() || v.sas === want);
    }
  };

  /* ═══════════════════ prediction ═══════════════════ */

  F.predict = function () {
    const v = F.focus;
    if (!v || v.dead) { F.path = null; F.el = null; return; }
    const soi = W.soiBody(v.x, v.y, F.t);
    F.el = W.elements(soi, v.x, v.y, v.vx, v.vy, F.t);
    if (v.landed) { F.path = null; return; }
    // on an escape path there is no lap to close, so look further ahead with a
    // longer stride — that's what lets the panel report a closest pass at a
    // planet days away instead of trailing off in empty space
    const esc = F.el && F.el.e >= 1;
    F.path = W.predict(v.x, v.y, v.vx, v.vy, F.t, {
      maxSteps: esc ? 3000 : 2000, dtCap: esc ? 5400 : 1200, watch: watchOf()
    });
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
    // altitude is measured against the ground we could hit; speed against the
    // world whose gravity we are actually orbiting. Those are the same body
    // almost everywhere, and where they differ (the wide band near the Moon
    // that is still Earth's sphere of influence) each reading is the one that
    // matters — and speed now matches what the autopilot calls prograde.
    const b = v.nearBody || W.earth;
    const rb = v.refBody || b;
    const bp = W.bodyPos(b, F.t);
    const dx = v.x - bp.x, dy = v.y - bp.y;
    const r = Math.hypot(dx, dy) || 1;
    const gi = W.terrain(b, Math.atan2(dy, dx));
    const agl = r - gi, asl = r - b.seaLevel;

    const rp = W.bodyPos(rb, F.t), bv = W.bodyVel(rb, F.t);
    const sdx = v.x - rp.x, sdy = v.y - rp.y;
    const sr = Math.hypot(sdx, sdy) || 1;
    const rvx = v.vx - bv.x, rvy = v.vy - bv.y;
    const spd = Math.hypot(rvx, rvy);
    const vs = (rvx * sdx + rvy * sdy) / sr;

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

    // friction heating, as a share of what the most stressed part can take —
    // only worth screen space once there's actually something to watch
    const heatRow = document.getElementById('heatRow');
    const hf = v.heatFrac || 0;
    if (heatRow) {
      heatRow.classList.toggle('hidden', hf < 0.05);
      heatRow.classList.toggle('hot', hf > 0.6);
    }
    set('hHeat', Math.round(hf * 100) + '%');

    paintFuel(v);

    F.syncThrottle();
    syncControlLock();
    updateStageHighlight();
  };

  /** shout before a re-entry cooks the craft, not after */
  function heatWatch(v) {
    if (!v || v.dead) return;
    const f = v.heatFrac || 0;
    const lvl = f > 0.8 ? 2 : f > 0.45 ? 1 : 0;
    const was = v._heatWarn || 0;
    if (lvl > was) {
      v._heatWarn = lvl;
      F.toast(lvl === 2
        ? 'Heat critical — parts are burning away!'
        : 'Friction heating — the hull is glowing. Slow down, or get a shield in front', 'bad');
    } else if (!lvl && was) v._heatWarn = 0;
  }

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
    syncControlLock();
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
    // the camera was parked on the wreck for the panel — release it, and
    // cleanup() will hand it to whatever is still flying
    wreckFocus = null;
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
      if (v) { F.vessels.push(v); if (v.mission) seedMissionSeq(v.mission.id); } else dropped++;
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
    wreckFocus = null;
    pinned = null;
    burn = null;
    approachSet = false;
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
    syncControlLock();
    F.predict(true);
    if (dropped) F.toast(dropped + ' craft could not be restored (parts changed).', 'bad');
    F.toast('Welcome back — resumed ' + F.vessels.filter(v => v.mission).length + ' mission(s).');
    return true;
  };

})(window.SFS);
