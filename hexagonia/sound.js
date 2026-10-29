/*
 * ヘキサゴニア（仮）— 効果音（Web Audio で合成。音声ファイルなし）
 * HexSound.play(name) / HexSound.setOn(bool) / HexSound.on
 */
(function () {
  'use strict';

  let ctx = null, master = null, noiseBuf = null;
  let on = true;
  try { on = localStorage.getItem('hexagonia.sound') !== 'off'; } catch (e) { /* 保存できなくても既定はON */ }

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
    turn() {        // 自分の手番：上がる2音
      tone({ freq: 660, dur: 0.18, vol: 0.12 });
      tone({ freq: 990, t: 0.12, dur: 0.3, vol: 0.12 });
    },
    expand() {      // 拡張：ぽん
      tone({ freq: 420, freqEnd: 760, dur: 0.12, vol: 0.16 });
    },
    strengthen() {  // 強化：きらっ
      tone({ freq: 784, dur: 0.16, vol: 0.1, type: 'triangle' });
      tone({ freq: 1175, t: 0.07, dur: 0.28, vol: 0.09, type: 'triangle' });
    },
    reinforce() {   // 補強：ごとっ＋きらっ
      tone({ freq: 160, freqEnd: 110, dur: 0.16, vol: 0.2 });
      tone({ freq: 1046, t: 0.06, dur: 0.22, vol: 0.06, type: 'triangle' });
    },
    declare() {     // 破壊の宣言：ひゅっ
      noise({ dur: 0.28, type: 'bandpass', freq: 600, freqEnd: 2400, q: 2, vol: 0.18 });
      tone({ freq: 220, freqEnd: 330, type: 'sawtooth', dur: 0.25, vol: 0.05 });
    },
    bid() {         // 出す数を決めた：かちっ
      noise({ dur: 0.04, type: 'highpass', freq: 3000, vol: 0.2, attack: 0.001 });
    },
    success() {     // 破壊成功：がしゃん
      noise({ dur: 0.45, type: 'lowpass', freq: 3000, freqEnd: 300, vol: 0.3 });
      tone({ freq: 140, freqEnd: 60, dur: 0.35, vol: 0.2 });
    },
    fail() {        // 破壊失敗（守られた）：かきん
      tone({ freq: 1320, dur: 0.25, vol: 0.08, type: 'square' });
      tone({ freq: 1760, dur: 0.2, vol: 0.05, type: 'square' });
      noise({ dur: 0.08, type: 'highpass', freq: 4000, vol: 0.1 });
    },
    buy() {         // 行動 +1：ちゃりん
      tone({ freq: 1568, dur: 0.12, vol: 0.08, type: 'triangle' });
      tone({ freq: 2093, t: 0.08, dur: 0.3, vol: 0.08, type: 'triangle' });
    },
    endTurn() {     // 手番終了：とん
      tone({ freq: 330, freqEnd: 260, dur: 0.1, vol: 0.1 });
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
    tick() {        // 持ち時間が残りわずか：こつ
      tone({ freq: 1500, dur: 0.05, vol: 0.06, type: 'square' });
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
      try { localStorage.setItem('hexagonia.sound', on ? 'on' : 'off'); } catch (e) { /* 無視 */ }
      if (on) ensure();
    },
    play(name) {
      if (!on || !sounds[name] || !ensure()) return;
      try { sounds[name](); } catch (e) { /* 音が出せなくても続ける */ }
    },
  };
})();
