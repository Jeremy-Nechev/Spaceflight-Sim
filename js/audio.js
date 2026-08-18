/* ============================================================
   audio.js — tiny WebAudio engine rumble, one-shot effects and
              a generative ambient score
   ============================================================ */
(function (S) {
  'use strict';

  const A = S.audio = {
    ctx: null, ready: false, muted: false, music: true,
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
      musicSetup(ctx);
      if (A.music) A.setMusic(true);
    } catch (e) { /* audio unavailable */ }
  };

  /** Continuous engine sound. thrustFrac 0..1, atmo 0..1 (muffled in vacuum). */
  A.engine = function (thrustFrac, atmo) {
    if (!A.ready || A.muted) { if (A.ready) A._gain.gain.value = 0; return; }
    const t = A.ctx.currentTime;
    // the score steps back out of the way while a motor is running
    M.duck = 1 - 0.55 * Math.min(1, thrustFrac * 1.4);
    musicLevel();
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

  /* ═══════════════════ ambient score ═══════════════════
     No files: a few oscillators, a long delay and a slow chord clock. Pads
     drift underneath, single bell notes drop into the delay and ring away, and
     the whole thing sits far enough back that the engines and the HUD chirps
     still read over it. It ducks itself while a motor is burning. */

  const ROOT = 146.83;                       // D3 — low enough to sit under everything
  // semitone offsets: a slow four-chord turn round D minor, each voiced wide
  const CHORDS = [[0, 7, 15], [-4, 3, 12], [-7, 5, 10], [-2, 5, 14]];
  const BELLS = [12, 15, 19, 22, 24, 27, 31];    // minor-pentatonic degrees, up high
  const M = {
    on: false, gain: null, wet: null, chord: 0, next: 0, bellAt: 0, timer: null, duck: 1
  };

  const hz = n => ROOT * Math.pow(2, n / 12);

  function musicSetup(ctx) {
    M.gain = ctx.createGain();
    M.gain.gain.value = 0;
    M.gain.connect(A._master);

    // a long, dark delay doing the work of a reverb
    const dl = ctx.createDelay(2);
    dl.delayTime.value = 0.66;
    const fb = ctx.createGain(); fb.gain.value = 0.46;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2000;
    dl.connect(lp); lp.connect(fb); fb.connect(dl);
    dl.connect(M.gain);
    M.wet = dl;
  }

  /** one slow pad voice */
  function pad(freq, at, dur, vol) {
    const ctx = A.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    o.type = 'triangle';
    o.frequency.value = freq;
    o.detune.value = (Math.random() - 0.5) * 14;      // never quite in tune: it breathes
    f.type = 'lowpass';
    f.frequency.value = 700;
    f.frequency.setValueAtTime(520, at);
    f.frequency.linearRampToValueAtTime(1300, at + dur * 0.5);
    f.frequency.linearRampToValueAtTime(600, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(vol, at + dur * 0.35);
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
    o.connect(f); f.connect(g);
    g.connect(M.gain);
    g.connect(M.wet);
    o.start(at); o.stop(at + dur + 0.1);
  }

  /** one bell note, straight into the delay so it rings on */
  function bell(freq, at) {
    const ctx = A.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.09, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 4.5);
    o.connect(g);
    g.connect(M.gain);
    g.connect(M.wet);
    o.start(at); o.stop(at + 4.6);
  }

  /** schedule a little way ahead of the clock, every half second */
  function musicTick() {
    if (!A.ready || !M.on) return;
    const ctx = A.ctx, now = ctx.currentTime;
    const horizon = now + 1.5;

    if (M.next < now) M.next = now + 0.2;
    while (M.next < horizon) {
      const ch = CHORDS[M.chord % CHORDS.length];
      const span = 15 + Math.random() * 6;
      for (let i = 0; i < ch.length; i++) {
        pad(hz(ch[i]), M.next, span + 4, i === 0 ? 0.13 : 0.085);
      }
      pad(hz(ch[0] - 12), M.next, span + 6, 0.07);       // the drone underneath
      M.chord++;
      M.next += span;
    }

    if (M.bellAt < now) M.bellAt = now + 1;
    while (M.bellAt < horizon) {
      if (Math.random() < 0.75) bell(hz(BELLS[Math.floor(Math.random() * BELLS.length)]), M.bellAt);
      M.bellAt += 3.5 + Math.random() * 6;
    }
  }

  function musicLevel() {
    if (!A.ready) return;
    const want = (!A.muted && M.on) ? 0.5 * M.duck : 0;
    M.gain.gain.setTargetAtTime(want, A.ctx.currentTime, 0.6);
  }

  /** Turn the score on or off. Safe before the context exists. */
  A.setMusic = function (on) {
    A.music = !!on;
    M.on = !!on;
    if (!A.ready) return;
    if (M.on && !M.timer) {
      M.next = 0; M.bellAt = 0;
      musicTick();
      M.timer = setInterval(musicTick, 500);
    } else if (!M.on && M.timer) {
      clearInterval(M.timer); M.timer = null;
    }
    musicLevel();
  };

})(window.SFS);
