/*
 * ハロウィンお菓子ゲーム — ルールの数値と固定データ
 * ルールの数値はすべてここにまとめる（コードに直書きしない）。
 * Node（サーバー）とブラウザ（CPU対戦）の両方から読み込む。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HalloweenConfig = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ロビーで変更できる設定の既定値
  const DEFAULT_SETTINGS = {
    houses: 6,                                  // 1集落の家の数
    rounds: 9,                                  // 集落の数（ラウンド数）
    talkTime: 120,                              // 作戦タイム（秒）
    chooseTime: 30,                             // 家を選ぶ時間（秒）
    candyBag: [1, 1, 1, 2, 2, 2, 3, 3, 3, 7],   // 家のお菓子の袋
    probRich: 10,                               // お金持ちの確率（%）
    probAway: 10,                               // 留守の確率（%）
    probWitch: 5,                               // 魔女の確率（%）
    richBonus: 5,                               // お金持ちの加算
    witchPenalty: 5,                            // 魔女の減算
    stealMax: 2,                                // 先頭から奪う最大数（0で奪取なし）
    missions: true,                             // ミッションあり／なし
    hints: true,                                // 秘密のヒントあり／なし
  };

  // 数値設定の範囲
  const SETTING_LIMITS = {
    houses: { min: 3, max: 12 },
    rounds: { min: 3, max: 15 },
    talkTime: { min: 30, max: 300 },
    chooseTime: { min: 10, max: 120 },
    probRich: { min: 0, max: 30 },
    probAway: { min: 0, max: 30 },
    probWitch: { min: 0, max: 30 },
    richBonus: { min: 0, max: 10 },
    witchPenalty: { min: 0, max: 10 },
    stealMax: { min: 0, max: 5 },
  };

  // 設定以外の固定ルール・進行の数値
  const RULES = {
    minPlayers: 2,
    maxPlayers: 12,
    nameMax: 12,            // 名前の最大文字数
    chatMax: 200,           // チャット1件の最大文字数
    chatLog: 300,           // ルームに残すチャットの件数
    bagMaxLength: 30,       // お菓子の袋に入れられる個数
    bagMaxValue: 99,        // 袋の中身1つの最大値
    resultTime: 10,         // 結果表示の最長時間（秒）
    resultMinTime: 2.5,     // 「次へ」を押せるようになるまでの演出時間（秒）
    lobbyGrace: 30,         // ロビーで切断した人を残しておく時間（秒）
    emptyRoomGrace: 120,    // 人間が全員切断したルームを破棄するまでの時間（秒）
    cpuChooseDelay: [1.5, 4], // CPUが家を確定するまでの時間（秒）
    cpuTalkWindow: 20,      // CPUが作戦タイムに発言する時間帯（秒、作戦タイムの半分と小さいほう）
    offlineCpuCount: 7,     // CPU対戦で最初に入れておくCPUの人数
  };

  const STATES = {
    normal: { emoji: '🍬', name: '普通' },
    rich: { emoji: '💰', name: 'お金持ち' },
    away: { emoji: '💤', name: '留守' },
    witch: { emoji: '🧙‍♀️', name: '魔女' },
  };

  // ミッション（名前は仮）。check の中身は engine.js の checkMission
  const MISSIONS = [
    { id: 'guest', name: 'お客さん', emoji: '🎩', bonus: 4, text: 'お金持ちの家に訪問する（衝突してもOK）' },
    { id: 'keeper', name: '留守番', emoji: '🔑', bonus: 4, text: '留守の家に訪問する（衝突してもOK）' },
    { id: 'amount3', name: '3の家', emoji: '3️⃣', bonus: 2, amount: 3, text: 'お菓子の量が3の家でお菓子をもらう' },
    { id: 'amount2', name: '2の家', emoji: '2️⃣', bonus: 2, amount: 2, text: 'お菓子の量が2の家でお菓子をもらう' },
    { id: 'amount1', name: '1の家', emoji: '1️⃣', bonus: 2, amount: 1, text: 'お菓子の量が1の家でお菓子をもらう' },
    { id: 'regular', name: '常連さん', emoji: '🔁', bonus: 4, text: '同じ番号の家で2ラウンド連続お菓子をもらう' },
  ];

  const ICONS = ['🎃', '👻', '🐈‍⬛', '🦇', '🕷️', '💀', '🧛', '🧟', '🍭', '🌙', '🦉', '🍄', '🧹', '🕯️', '🐺', '🍫'];
  const STAMPS = ['🎃', '👻', '😱', '🤔', '👍', '🙏', '😂', '🍬'];
  const CPU_NAMES = ['ジャック', 'ミイラ', 'クロ', 'ルナ', 'ドラキュラ', 'ゴースト', 'ウィッチ', 'ボーン', 'パンプ', 'モリー', 'バット', 'スカル'];

  function clampInt(v, min, max, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  // "1,1,2, 3" → [1,1,2,3]。正しくなければ null
  function parseBag(input) {
    const list = Array.isArray(input) ? input : String(input).split(/[,、\s]+/).filter(s => s !== '');
    const out = [];
    for (const s of list) {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0 || n > RULES.bagMaxValue) return null;
      out.push(n);
    }
    if (!out.length || out.length > RULES.bagMaxLength) return null;
    return out;
  }

  // 外から来た設定を範囲内に収める。base にない／おかしな値は base のまま
  function normalizeSettings(input, base) {
    const b = base || DEFAULT_SETTINGS;
    const src = input && typeof input === 'object' ? input : {};
    const out = Object.assign({}, b, { candyBag: b.candyBag.slice() });
    for (const key of Object.keys(SETTING_LIMITS)) {
      if (src[key] === undefined) continue;
      const lim = SETTING_LIMITS[key];
      out[key] = clampInt(src[key], lim.min, lim.max, b[key]);
    }
    if (src.candyBag !== undefined) {
      const bag = parseBag(src.candyBag);
      if (bag) out.candyBag = bag;
    }
    for (const key of ['missions', 'hints']) {
      if (src[key] !== undefined) out[key] = !!src[key];
    }
    return out;
  }

  function missionById(id) {
    return MISSIONS.find(m => m.id === id) || null;
  }

  // 人数に合わせた家の数の目安（人数の3/4程度）
  function recommendedHouses(players) {
    const lim = SETTING_LIMITS.houses;
    return Math.min(lim.max, Math.max(lim.min, Math.round(players * 3 / 4)));
  }

  return {
    DEFAULT_SETTINGS, SETTING_LIMITS, RULES, STATES, MISSIONS, ICONS, STAMPS, CPU_NAMES,
    normalizeSettings, parseBag, missionById, recommendedHouses,
  };
});
