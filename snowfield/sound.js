/*
 * Snowfield — 効果音
 * 音声ファイルは使わず、Web Audio で「実物の音」に近づけて作る：
 *   ・足音・かじる音・火のはぜる音などは、帯域を絞ったノイズの短いかたまり
 *   ・木や石をたたく音・鐘は、物体の響き方（いくつかの振動の重なり）をまねて、高い振動ほど早く減衰させる
 *   ・すべてに、ごく短い部屋の響き（リバーブ）をかけて、電子音っぽさを消す
 * 音の出し方は一か所（SOUNDS）にまとめてあるので、音色を変えたいときはここだけ触ればよい。
 */
(function () {
  'use strict';

  let ctx = null, master = null, rev = null, noise = null;
  let muted = false;
  try { muted = localStorage.getItem('snowfield.mute') === '1'; } catch (e) { /* 無視 */ }

  function init() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC(); } catch (e) { return false; }
    master = ctx.createGain(); master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp); comp.connect(ctx.destination);
    // 響き：減衰するノイズ（高域を丸めてある）
    const len = Math.floor(ctx.sampleRate * 1.3), imp = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = imp.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) { lp = lp * 0.62 + (Math.random() * 2 - 1) * 0.38; d[i] = lp * Math.pow(1 - i / len, 3.2); }
    }
    rev = ctx.createConvolver(); rev.buffer = imp;
    const wet = ctx.createGain(); wet.gain.value = 0.24;
    rev.connect(wet); wet.connect(master);
    const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    noise = nb;
    return true;
  }

  const rand = (a, b) => a + Math.random() * (b - a);
  function send(node, wet) {
    node.connect(master);
    if (wet > 0) { const g = ctx.createGain(); g.gain.value = wet; node.connect(g); g.connect(rev); }
  }

  // ノイズの短いかたまり（足音・かじる音・はぜる音・風）
  function burst(t, o) {
    const dur = o.dur || 0.05, atk = o.atk || 0.002;
    const src = ctx.createBufferSource(); src.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = o.type || 'bandpass'; f.Q.value = o.q || 0.9;
    f.frequency.setValueAtTime(o.f || 2000, t);
    if (o.f2) f.frequency.exponentialRampToValueAtTime(o.f2, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(o.gain || 0.3, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); send(g, o.wet == null ? 0.25 : o.wet);
    src.start(t, Math.random() * 1.5, dur + 0.05);
  }
  // 物体の響き：いくつかの振動を重ね、高いものほど早く消す
  function ring(t, freqs, o) {
    const gain = o.gain || 0.3, decay = o.decay || 0.2, jit = o.jitter == null ? 0.025 : o.jitter;
    const k = 1 + rand(-jit, jit);
    freqs.forEach((fr, i) => {
      const osc = ctx.createOscillator(); osc.type = 'sine';
      osc.frequency.value = fr * k * (1 + rand(-0.004, 0.004));
      const g = ctx.createGain(), d = decay / (1 + i * 0.7);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(gain / (1 + i * 0.55), t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d * 4);
      osc.connect(g); send(g, o.wet == null ? 0.3 : o.wet);
      osc.start(t); osc.stop(t + d * 4 + 0.05);
    });
  }
  const BELL = [1, 2.76, 5.4, 8.93];   // 小さな鐘の振動の比
  const bell = (t, f, o) => ring(t, BELL.map(r => f * r), Object.assign({ jitter: 0.004, wet: 0.5 }, o));
  const knock = (t, base, o) => {       // 木をたたく
    o = o || {};
    ring(t, [base, base * 2.3, base * 4.1], { gain: o.gain || 0.38, decay: o.decay || 0.09 });
    burst(t, { dur: 0.02, f: 1800, q: 0.7, gain: 0.25 });
  };
  const pops = (t, n, span, g) => { for (let i = 0; i < n; i++) burst(t + rand(0, span), { dur: 0.012, f: rand(2500, 6500), q: 2.2, gain: rand(0.06, 0.25) * (g || 1), wet: 0.35 }); };

  const SOUNDS = {
    step(t) { for (let i = 0; i < 3; i++) burst(t + i * 0.04 + rand(0, 0.015), { dur: 0.055, f: rand(2200, 3800), q: 0.8, gain: rand(0.14, 0.24) }); burst(t, { dur: 0.09, f: 320, type: 'lowpass', q: 0.5, gain: 0.16 }); },
    warm(t) { burst(t, { dur: 1.1, atk: 0.25, f: 420, type: 'lowpass', q: 0.4, gain: 0.1, wet: 0.2 }); pops(t, 11, 1.0); },
    stoke(t) { knock(t, 190, { gain: 0.4 }); pops(t + 0.08, 6, 0.5); },
    eat(t) { for (let i = 0; i < 3; i++) burst(t + i * 0.12, { dur: 0.07, f: rand(1300, 2000), q: 1.4, gain: rand(0.2, 0.32) }); burst(t, { dur: 0.3, f: 500, type: 'lowpass', gain: 0.07 }); },
    collect_tree(t) { knock(t, 250); },
    collect_stone(t) { ring(t, [1900, 2870, 4300], { gain: 0.18, decay: 0.07, wet: 0.35 }); ring(t, [520], { gain: 0.2, decay: 0.05 }); burst(t, { dur: 0.015, f: 4000, q: 1, gain: 0.2 }); },
    collect_veg(t) { burst(t, { dur: 0.16, f: 900, f2: 2400, q: 1, gain: 0.22 }); ring(t + 0.05, [380], { gain: 0.15, decay: 0.07 }); },
    attack(t) { burst(t, { dur: 0.06, f: 900, q: 0.8, gain: 0.4 }); ring(t, [140, 260], { gain: 0.42, decay: 0.1 }); },
    kill(t) { SOUNDS.attack(t); ring(t + 0.12, [110, 170], { gain: 0.35, decay: 0.3 }); },
    plant(t) { burst(t, { dur: 0.2, f: 480, type: 'lowpass', q: 0.5, gain: 0.3 }); burst(t + 0.05, { dur: 0.12, f: 1500, q: 0.7, gain: 0.1 }); },
    build(t) { [0, 0.17, 0.34].forEach((d, i) => knock(t + d, 300 * (1 + i * 0.04))); },
    repair(t) { [0, 0.18].forEach((d, i) => knock(t + d, 360 + i * 20, { gain: 0.3 })); },
    end(t) { knock(t, 300, { gain: 0.22, decay: 0.07 }); },
    tick(t) { ring(t, [1250], { gain: 0.14, decay: 0.03, wet: 0.2 }); },
    warn(t) { knock(t, 240, { gain: 0.3 }); knock(t + 0.16, 220, { gain: 0.3 }); },
    error(t) { ring(t, [120], { gain: 0.3, decay: 0.1 }); burst(t, { dur: 0.06, f: 300, type: 'lowpass', gain: 0.2 }); },
    turn(t) { bell(t, 880, { gain: 0.16, decay: 0.28 }); bell(t + 0.17, 1318, { gain: 0.14, decay: 0.3 }); },
    round(t) { bell(t, 330, { gain: 0.24, decay: 0.55 }); bell(t + 0.32, 440, { gain: 0.2, decay: 0.55 }); },
    storm(t) { burst(t, { dur: 2.2, atk: 0.8, f: 260, f2: 900, q: 0.7, gain: 0.2, wet: 0.5 }); burst(t + 0.4, { dur: 1.6, atk: 0.6, f: 700, f2: 300, q: 1.2, gain: 0.1, wet: 0.5 }); },
    collapse(t) { ring(t, [70, 110], { gain: 0.5, decay: 0.5, wet: 0.4 }); burst(t, { dur: 0.25, f: 250, type: 'lowpass', gain: 0.3 }); },
    crack(t) { for (let i = 0; i < 3; i++) burst(t + i * 0.05, { dur: 0.03, f: rand(2200, 3200), q: 1.5, gain: 0.3 }); ring(t, [150, 330], { gain: 0.3, decay: 0.18 }); },
    win(t) { [523, 659, 784, 1046].forEach((f, i) => bell(t + i * 0.22, f, { gain: 0.17, decay: 0.5 })); },
    lose(t) { bell(t, 196, { gain: 0.26, decay: 0.9 }); bell(t + 0.6, 147, { gain: 0.26, decay: 1.1 }); },
  };

  function play(name) {
    if (muted || !name || !SOUNDS[name]) return;
    if (!init()) return;
    if (ctx.state === 'suspended') ctx.resume();
    try { SOUNDS[name](ctx.currentTime + 0.01); } catch (e) { /* 音が出なくても進行には影響しない */ }
  }
  function unlock() { if (init() && ctx.state === 'suspended') ctx.resume(); }
  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem('snowfield.mute', muted ? '1' : '0'); } catch (e) { /* 無視 */ }
  }

  window.SnowSound = { play, unlock, setMuted, isMuted: () => muted, names: Object.keys(SOUNDS) };
})();
