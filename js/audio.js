/* ============================================================
   audio.js — tiny WebAudio engine rumble + one-shot effects
   ============================================================ */
(function (S) {
  'use strict';

  const A = S.audio = {
    ctx: null, ready: false, muted: false,
    _noise: null, _src: null, _filt: null, _gain: null, _master: null
  };

  function makeNoise(ctx) {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;      // brown-ish noise: deeper rumble
      d[i] = last * 3.2;
    }
    return buf;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  A.init = function () {
    if (A.ready) { if (A.ctx.state === 'suspended') A.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      const ctx = A.ctx = new AC();
      A._master = ctx.createGain();
      A._master.gain.value = 0.5;
      A._master.connect(ctx.destination);

      A._noise = makeNoise(ctx);
      const src = A._src = ctx.createBufferSource();
      src.buffer = A._noise; src.loop = true;

      const filt = A._filt = ctx.createBiquadFilter();
      filt.type = 'lowpass'; filt.frequency.value = 400; filt.Q.value = 1.4;

      const g = A._gain = ctx.createGain();
      g.gain.value = 0;

      src.connect(filt); filt.connect(g); g.connect(A._master);
      src.start();
      A.ready = true;
    } catch (e) { /* audio unavailable */ }
  };

  /** Continuous engine sound. thrustFrac 0..1, atmo 0..1 (muffled in vacuum). */
  A.engine = function (thrustFrac, atmo) {
    if (!A.ready || A.muted) { if (A.ready) A._gain.gain.value = 0; return; }
    const t = A.ctx.currentTime;
    const target = thrustFrac * (0.16 + 0.5 * atmo);
    A._gain.gain.setTargetAtTime(target, t, 0.08);
    A._filt.frequency.setTargetAtTime(180 + 700 * thrustFrac * (0.3 + 0.7 * atmo), t, 0.1);
  };

  A.blip = function (freq, dur, type, vol) {
    if (!A.ready || A.muted) return;
    const ctx = A.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol || 0.14, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.12));
    o.connect(g); g.connect(A._master);
    o.start(t); o.stop(t + (dur || 0.12) + 0.03);
  };

  A.stage = function () { A.blip(150, 0.22, 'sawtooth', 0.2); A.blip(90, 0.3, 'square', 0.12); };
  A.ui = function () { A.blip(660, 0.05, 'sine', 0.05); };

  A.boom = function (power) {
    if (!A.ready || A.muted) return;
    const ctx = A.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = A._noise;
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass';
    filt.frequency.setValueAtTime(1800, t);
    filt.frequency.exponentialRampToValueAtTime(90, t + 0.9);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(0.55, 0.3 * (power || 1)), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    src.connect(filt); filt.connect(g); g.connect(A._master);
    src.start(t); src.stop(t + 1.2);
  };

  A.splash = function () {
    if (!A.ready || A.muted) return;
    const ctx = A.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = A._noise;
    const filt = ctx.createBiquadFilter(); filt.type = 'bandpass';
    filt.frequency.setValueAtTime(900, t);
    filt.frequency.exponentialRampToValueAtTime(280, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    src.connect(filt); filt.connect(g); g.connect(A._master);
    src.start(t); src.stop(t + 0.7);
  };

  A.setMuted = function (m) {
    A.muted = m;
    if (A.ready) A._master.gain.value = m ? 0 : 0.5;
  };

})(window.SFS);
