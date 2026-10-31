/*
 * ヘキサブルグ — 効果音（Web Audio で合成。音声ファイルなし）
 * HexSound.play(name) / HexSound.setOn(bool) / HexSound.on
 */
(function () {
  'use strict';

  let ctx = null, master = null, noiseBuf = null;
  let on = true;
  try { on = localStorage.getItem('hexaburg.sound') !== 'off'; } catch (e) { /* 保存できなくても既定はON */ }

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function env(g, t0, vol, attack, dur) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  function tone({ freq, freqEnd, type = 'sine', t = 0, dur = 0.2, vol = 0.15, attack = 0.008 }) {
    const t0 = ctx.currentTime + t;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    const g = ctx.createGain();
    env(g, t0, vol, attack, dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  function noise({ t = 0, dur = 0.2, vol = 0.15, type = 'bandpass', freq = 1000, freqEnd, q = 1, attack = 0.005 }) {
    const t0 = ctx.currentTime + t;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq, t0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    const g = ctx.createGain();
    env(g, t0, vol, attack, dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  const sounds = {
    round() {       // ターンが始まった：低めの2音
      tone({ freq: 392, dur: 0.22, vol: 0.1, type: 'triangle' });
      tone({ freq: 523, t: 0.14, dur: 0.34, vol: 0.1, type: 'triangle' });
    },
    count() {       // 開始のカウントダウン（3・2・1）：ぴっ
      tone({ freq: 660, dur: 0.14, vol: 0.12, type: 'square' });
    },
    go() {          // 開始：ぴーっ（高く長め）
      tone({ freq: 1320, dur: 0.5, vol: 0.12, type: 'square' });
    },
    pip(n) {        // 終了時の数え上げ：数えるたびに少しずつ高くなる「ぴっ」
      tone({ freq: Math.min(1600, 520 + (n || 0) * 22), dur: 0.06, vol: 0.07, type: 'triangle' });
    },
    block() {       // 攻撃・反撃が当たった：かきん
      tone({ freq: 1320, dur: 0.25, vol: 0.08, type: 'square' });
      tone({ freq: 1760, dur: 0.2, vol: 0.05, type: 'square' });
      noise({ dur: 0.08, type: 'highpass', freq: 4000, vol: 0.1 });
    },
    success() {     // セルを壊した：がしゃん
      noise({ dur: 0.45, type: 'lowpass', freq: 3000, freqEnd: 300, vol: 0.3 });
      tone({ freq: 140, freqEnd: 60, dur: 0.35, vol: 0.2 });
    },
    attacked() {    // 自分のセルが攻撃された：警報のように2回
      [0, 0.16].forEach(t => tone({ freq: 880, freqEnd: 520, t, dur: 0.13, vol: 0.11, type: 'square' }));
      noise({ t: 0, dur: 0.2, type: 'lowpass', freq: 1500, freqEnd: 300, vol: 0.15 });
    },
    expand() {      // 拡張：ぽん
      tone({ freq: 420, freqEnd: 760, dur: 0.12, vol: 0.16 });
    },
    out() {         // 脱落：下がる3音
      [523, 415, 311].forEach((f, i) => tone({ freq: f, t: i * 0.16, dur: 0.3, vol: 0.12, type: 'triangle' }));
    },
    win() {         // 勝利：上がる和音
      [523, 659, 784, 1046].forEach((f, i) => tone({ freq: f, t: i * 0.11, dur: 0.6, vol: 0.1, type: 'triangle' }));
    },
    lose() {        // 敗北：低く下がる
      [392, 330, 262].forEach((f, i) => tone({ freq: f, t: i * 0.2, dur: 0.45, vol: 0.1 }));
    },
  };

  // 最初の操作で音を出せるようにしておく（ブラウザは操作の前に音を鳴らせない）
  const unlock = () => { if (on) ensure(); };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('keydown', unlock);

  window.HexSound = {
    get on() { return on; },
    setOn(v) {
      on = !!v;
      try { localStorage.setItem('hexaburg.sound', on ? 'on' : 'off'); } catch (e) { /* 無視 */ }
      if (on) ensure();
    },
    play(name, arg) {
      if (!on || !sounds[name] || !ensure()) return;
      try { sounds[name](arg); } catch (e) { /* 音が出せなくても続ける */ }
    },
  };
})();
