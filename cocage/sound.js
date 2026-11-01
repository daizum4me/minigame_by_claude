/*
 * Cocage — 効果音
 * 葉と枝の音を、WebAudio で合成する（音声ファイルなし）。電子音（ピコピコ）にならないように、
 *   ・葉のこすれる音：短いノイズの粒を、ばらばらの高さ・間隔で何個も重ねる（くしゃっ）
 *   ・木をたたく音：高さの違う共鳴を何本か重ね、それぞれを短く減衰させる（コッ）
 *   ・枝の折れる音：鋭いノイズ＋木の共鳴＋細かい破片の粒（パキッ）
 *   ・風：ゆっくり揺れるノイズ
 * を材料にする。どの音も、ほんの少しずつランダムにゆらぐ（同じ音が機械的に続かない）。
 *
 * CocageSound.play(name, { delay, vol, ... })  delay は秒
 * CocageSound.setOn(bool) / isOn() / unlock()
 */
(function () {
  'use strict';

  const KEY = 'cocage.sound';
  let on = true;
  try { on = localStorage.getItem(KEY) !== '0'; } catch (e) { /* 無視 */ }

  let ctx = null, master = null, dry = null, wet = null, white = null, pink = null;
  const rand = (a, b) => a + Math.random() * (b - a);
  const jit = (v, r) => v * (1 + (Math.random() - 0.5) * 2 * r);   // ±r 割ゆらがせる

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 11000;
    master.connect(lp);
    lp.connect(ctx.destination);
    dry = ctx.createGain(); dry.gain.value = 1; dry.connect(master);
    // 森の空気感：ごく短く、やわらかい残響
    wet = ctx.createGain(); wet.gain.value = 0.16;
    const conv = ctx.createConvolver();
    const len = Math.floor(ctx.sampleRate * 0.55), ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    conv.buffer = ir;
    wet.connect(conv); conv.connect(master);
    // ノイズ（白と、やわらかい桃色）
    const n = ctx.sampleRate * 3;
    white = ctx.createBuffer(1, n, ctx.sampleRate);
    pink = ctx.createBuffer(1, n, ctx.sampleRate);
    const w = white.getChannelData(0), p = pink.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < n; i++) {
      const x = Math.random() * 2 - 1;
      w[i] = x;
      b0 = 0.997 * b0 + x * 0.029591; b1 = 0.985 * b1 + x * 0.032534; b2 = 0.95 * b2 + x * 0.048056;
      p[i] = (b0 + b1 + b2 + x * 0.1848) * 3.2;
    }
    return ctx;
  }

  // ---------- 材料 ----------

  // 出力（乾いた音と残響に分ける）
  function out(node, send) {
    node.connect(dry);
    if (send) { const g = ctx.createGain(); g.gain.value = send; node.connect(g); g.connect(wet); }
  }

  // ノイズの粒：t 秒後に、dur 秒のあいだ、周波数 f のあたりだけを通す
  function grain(t, { f = 4000, q = 1.2, dur = 0.01, vol = 0.1, type = 'bandpass', buf = null, send = 0.4 }) {
    const s = ctx.createBufferSource();
    s.buffer = buf || white;
    const flt = ctx.createBiquadFilter();
    flt.type = type; flt.frequency.value = f; flt.Q.value = q;
    const g = ctx.createGain();
    const t0 = ctx.currentTime + t;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.0008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(0.004, dur));
    s.connect(flt); flt.connect(g); out(g, send);
    s.start(t0, Math.random() * 2.5, dur + 0.05);
  }

  // 葉のこすれる音（くしゃっ）：粒をたくさん、前のほうに寄せて散らす
  function crinkle(t, { dur = 0.15, n = 8, lo = 2500, hi = 8000, vol = 0.1, decay = 0.011 }) {
    for (let i = 0; i < n; i++) {
      const at = t + Math.pow(Math.random(), 1.6) * dur;
      grain(at, { f: rand(lo, hi), q: rand(0.9, 2.2), dur: jit(decay, 0.5), vol: vol * rand(0.35, 1) * 2.4, send: 0.5 });
    }
  }

  // 木をたたく音（コッ）：共鳴を重ねて、それぞれを短く減衰させる
  function wood(t, { f = 450, vol = 0.25, decay = 0.09, ratios = [1, 2.76, 5.4], gains = [1, 0.45, 0.2], click = true }) {
    const t0 = ctx.currentTime + t;
    const f0 = jit(f, 0.03);
    ratios.forEach((r, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f0 * r * jit(1, 0.004);
      const g = ctx.createGain();
      const d = decay / (1 + i * 0.7);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.linearRampToValueAtTime(vol * gains[i % gains.length], t0 + 0.0015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
      o.connect(g); out(g, 0.35);
      o.start(t0); o.stop(t0 + d + 0.05);
    });
    if (click) grain(t, { f: Math.min(5200, f0 * 4.5), q: 1.4, dur: 0.006, vol: vol * 0.55, send: 0.2 });
  }

  // 風・葉ずれ：ゆっくり立ち上がって消える、ゆらぐノイズ。f0 → f1 へ明るさが動く
  function wind(t, { dur = 0.8, vol = 0.1, f0 = 900, f1 = 2400, leaves = 0.6 }) {
    const t0 = ctx.currentTime + t;
    const s = ctx.createBufferSource();
    s.buffer = pink; s.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass'; flt.Q.value = 0.8;
    flt.frequency.setValueAtTime(f0, t0);
    flt.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + dur * 0.4);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    // ゆらぎ
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = rand(4, 8); lg.gain.value = vol * 0.35;
    lfo.connect(lg); lg.connect(g.gain);
    s.connect(flt); flt.connect(g); out(g, 0.5);
    s.start(t0, Math.random() * 2); s.stop(t0 + dur + 0.05);
    lfo.start(t0); lfo.stop(t0 + dur + 0.05);
    if (leaves) crinkle(t + dur * 0.15, { dur: dur * 0.7, n: Math.round(dur * 26 * leaves), lo: Math.min(f0, f1) * 1.4, hi: Math.max(f0, f1) * 3, vol: vol * 0.6 });
  }

  // 低い、にぶい音（どすっ）
  function thud(t, { f = 120, vol = 0.25, dur = 0.14 }) {
    const t0 = ctx.currentTime + t;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f * 1.5, t0);
    o.frequency.exponentialRampToValueAtTime(f * 0.7, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); out(g, 0.3);
    o.start(t0); o.stop(t0 + dur + 0.05);
    grain(t, { f: 380, q: 0.7, dur: 0.05, vol: vol * 0.5, type: 'lowpass', send: 0.2 });
  }

  // 枝がぱきっと折れる：鋭いノイズ＋木の共鳴＋破片
  function snap(t, { vol = 0.35 }) {
    grain(t, { f: 1800, q: 0.5, dur: 0.012, vol: vol * 1.1, type: 'highpass', send: 0.3 });
    grain(t + 0.002, { f: jit(2300, 0.1), q: 3, dur: 0.05, vol: vol * 0.8, send: 0.4 });
    wood(t + 0.004, { f: jit(170, 0.1), vol: vol * 0.9, decay: 0.16, ratios: [1, 2.2, 3.7], gains: [1, 0.5, 0.25], click: false });
    for (let i = 0; i < 4; i++) grain(t + 0.03 + Math.random() * 0.12, { f: rand(1800, 5200), q: 2, dur: 0.008, vol: vol * rand(0.25, 0.5), send: 0.4 });
  }

  // 木のきしみ
  function creak(t, { vol = 0.05, dur = 0.35 }) {
    const t0 = ctx.currentTime + t;
    const s = ctx.createBufferSource();
    s.buffer = white;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass'; flt.Q.value = 9;
    flt.frequency.setValueAtTime(rand(170, 210), t0);
    flt.frequency.linearRampToValueAtTime(rand(230, 300), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol * 12, t0 + dur * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t0 + dur);
    s.connect(flt); flt.connect(g); out(g, 0.3);
    s.start(t0, Math.random() * 2); s.stop(t0 + dur + 0.05);
  }

  // ---------- 音の一覧 ----------

  // opts.vol で全体の大きさ、opts.delay で鳴らすまでの秒数
  const SOUNDS = {
    // ボタン類
    ui:       (t, o) => wood(t, { f: 900, vol: 0.1 * o.vol, decay: 0.04, ratios: [1, 2.76] }),
    // 自分の操作
    planBranch: (t, o) => { wood(t, { f: 470, vol: 0.28 * o.vol, decay: 0.1 }); crinkle(t + 0.01, { dur: 0.05, n: 3, lo: 3000, hi: 7000, vol: 0.05 * o.vol }); },
    planLeaf:   (t, o) => { crinkle(t, { dur: 0.13, n: 9, lo: 2600, hi: 9000, vol: 0.13 * o.vol }); wood(t + 0.02, { f: 1300, vol: 0.05 * o.vol, decay: 0.04, ratios: [1, 2.3] }); },
    deny:       (t, o) => { wood(t, { f: 190, vol: 0.22 * o.vol, decay: 0.07, ratios: [1, 1.52], click: false }); },
    cancel:     (t, o) => { crinkle(t, { dur: 0.08, n: 5, lo: 1600, hi: 4200, vol: 0.1 * o.vol }); thud(t + 0.01, { f: 220, vol: 0.06 * o.vol, dur: 0.05 }); },
    confirm:    (t, o) => wood(t, { f: 720, vol: 0.2 * o.vol, decay: 0.07, ratios: [1, 2.5] }),
    finish:     (t, o) => { wood(t, { f: 560, vol: 0.2 * o.vol, decay: 0.07 }); wood(t + 0.075, { f: 840, vol: 0.2 * o.vol, decay: 0.09 }); crinkle(t + 0.05, { dur: 0.2, n: 7, lo: 2200, hi: 6500, vol: 0.07 * o.vol }); },
    unfinish:   (t, o) => { wood(t, { f: 640, vol: 0.14 * o.vol, decay: 0.05 }); crinkle(t + 0.02, { dur: 0.08, n: 4, lo: 1500, hi: 3800, vol: 0.07 * o.vol }); },
    tick:       (t, o) => wood(t, { f: o.hot ? 1500 : 1100, vol: (o.hot ? 0.16 : 0.1) * o.vol, decay: 0.03, ratios: [1, 3.2], gains: [1, 0.3] }),
    // ターンの解決
    resolve:    (t, o) => wind(t, { dur: 0.75, vol: 0.1 * o.vol, f0: 700, f1: 2200 }),
    placedBranch: (t, o) => wood(t, { f: jit(360, 0.12), vol: 0.2 * o.vol, decay: 0.11, ratios: [1, 2.4, 4.6] }),
    placedLeaf:   (t, o) => { crinkle(t, { dur: 0.16, n: 10, lo: 2400, hi: 8500, vol: 0.12 * o.vol }); wood(t + 0.03, { f: jit(1500, 0.1), vol: 0.06 * o.vol, decay: 0.05, ratios: [1, 2.1] }); },
    lost:         (t, o) => { thud(t, { f: 140, vol: 0.22 * o.vol, dur: 0.12 }); crinkle(t + 0.03, { dur: 0.1, n: 4, lo: 1400, hi: 3000, vol: 0.06 * o.vol }); },
    grow:         (t, o) => creak(t, { vol: 0.045 * o.vol }),
    // 点数：葉が散る（点数が大きいほど明るく、木の音が混ざる）
    spill:        (t, o) => {
      const p = o.pts || 1, hi = 5500 + Math.min(4, p) * 900;
      crinkle(t, { dur: 0.1, n: 4 + Math.min(4, Math.round(p)), lo: 2800, hi, vol: 0.1 * o.vol });
      if (p >= 2) wood(t + 0.02, { f: 900 + p * 160, vol: 0.07 * o.vol * Math.min(1.6, p / 2), decay: 0.12, ratios: [1, 3.99, 9.2], gains: [1, 0.3, 0.1], click: false });
    },
    topUp:        (t, o) => { wind(t, { dur: 0.45, vol: 0.1 * o.vol, f0: 1500, f1: 4200 }); wood(t + 0.2, { f: 980, vol: 0.12 * o.vol, decay: 0.16, ratios: [1, 3.99, 9.2], gains: [1, 0.3, 0.1] }); },
    topDown:      (t, o) => { wind(t, { dur: 0.45, vol: 0.09 * o.vol, f0: 3200, f1: 900 }); thud(t + 0.25, { f: 150, vol: 0.12 * o.vol, dur: 0.1 }); },
    // 枝が折れる
    breakFlash:   (t, o) => { grain(t, { f: 3200, q: 1.2, dur: 0.14, vol: 0.08 * o.vol, send: 0.4 }); creak(t, { vol: 0.07 * o.vol, dur: 0.2 }); },
    snap:         (t, o) => snap(t, { vol: 0.34 * o.vol }),
    label:        (t, o) => thud(t, { f: 110, vol: 0.24 * o.vol, dur: 0.16 }),
    // 落雷：鋭いひび割れ → 低いごろごろ
    thunder:      (t, o) => {
      grain(t, { f: 2600, q: 0.5, dur: 0.05, vol: 0.4 * o.vol, type: 'highpass', send: 0.5 });
      grain(t + 0.01, { f: 900, q: 0.6, dur: 0.2, vol: 0.22 * o.vol, type: 'bandpass', send: 0.5 });
      thud(t + 0.05, { f: 55, vol: 0.34 * o.vol, dur: 0.5 });
      thud(t + 0.3, { f: 70, vol: 0.18 * o.vol, dur: 0.6 });
      wind(t + 0.1, { dur: 0.9, vol: 0.06 * o.vol, f0: 300, f1: 120, leaves: 0 });
    },
    fall:         (t, o) => { for (let i = 0; i < 3; i++) wood(t + i * rand(0.05, 0.11), { f: rand(1700, 3300), vol: 0.07 * o.vol, decay: 0.03, ratios: [1, 2.9], gains: [1, 0.4] }); },
    leafGone:     (t, o) => crinkle(t, { dur: 0.32, n: 9, lo: 1500, hi: 5000, vol: 0.09 * o.vol, decay: 0.014 }),
    // ゲームの流れ
    start:        (t, o) => { wind(t, { dur: 0.95, vol: 0.12 * o.vol, f0: 600, f1: 2600 }); wood(t + 0.75, { f: 330, vol: 0.22 * o.vol, decay: 0.2 }); wood(t + 0.9, { f: 495, vol: 0.2 * o.vol, decay: 0.24 }); },
    end:          (t, o) => wind(t, { dur: 1.5, vol: 0.13 * o.vol, f0: 2400, f1: 700 }),
    win:          (t, o) => {
      [392, 494, 587, 784].forEach((f, i) => wood(t + i * 0.13, { f, vol: 0.2 * o.vol, decay: 0.5, ratios: [1, 3.99, 9.2], gains: [1, 0.35, 0.12], click: false }));
      crinkle(t + 0.5, { dur: 0.5, n: 14, lo: 3000, hi: 9000, vol: 0.08 * o.vol });
    },
    lose:         (t, o) => { wood(t, { f: 196, vol: 0.26 * o.vol, decay: 0.35, ratios: [1, 2.4, 4.4], click: false }); wind(t + 0.1, { dur: 0.8, vol: 0.07 * o.vol, f0: 1800, f1: 500 }); },
    warn:         (t, o) => { wood(t, { f: 300, vol: 0.16 * o.vol, decay: 0.07 }); wood(t + 0.14, { f: 300, vol: 0.12 * o.vol, decay: 0.07 }); },
  };

  // 短い間にたくさん鳴りすぎないように
  const recent = [];
  const CHEAP = new Set(['spill', 'fall', 'placedBranch', 'placedLeaf', 'tick']);
  function crowded(name) {
    const now = performance.now();
    while (recent.length && now - recent[0] > 120) recent.shift();
    if (CHEAP.has(name) && recent.length > 18) return true;
    recent.push(now);
    return false;
  }

  function play(name, opts) {
    if (!on || !SOUNDS[name]) return;
    if (!ensure()) return;
    if (ctx.state === 'suspended') { try { ctx.resume(); } catch (e) { /* 無視 */ } }
    if (crowded(name)) return;
    const o = Object.assign({ vol: 1, delay: 0 }, opts);
    try { SOUNDS[name](Math.max(0, o.delay), o); } catch (e) { /* 音が鳴らなくても、ゲームは続ける */ }
  }

  function setOn(v) {
    on = !!v;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) { /* 無視 */ }
  }

  // 最初の操作で音を出せるようにしておく（ブラウザは操作の前に音を鳴らせない）
  function unlock() {
    if (!on) return;
    const c = ensure();
    if (c && c.state === 'suspended') { try { c.resume(); } catch (e) { /* 無視 */ } }
  }
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });

  window.CocageSound = { play, setOn, isOn: () => on, unlock, names: Object.keys(SOUNDS) };
})();
