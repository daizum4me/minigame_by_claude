/*
 * ヘキサブルグ — CPU の考え方
 * 人間と同じ公開情報（盤面・全員の資源）だけで、次の1手を決める。
 * 部屋が CPU ごとに1.5〜3.5秒のばらつきのある間隔で呼ぶ。拡張・狙い・攻撃・反撃に点数を付けて一番高いものを選び、
 * よい行動がなければ何もしない（待つ）。
 *
 * decideRealtime(state, id, rng, level) → action（engine.apply に渡せる形）か null
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.HexCpu = factory(root.HexEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // 強さ。noise：点数のゆらぎ（大きいほど気まぐれ）
  const LEVELS = {
    weak: { noise: 6 },
    normal: { noise: 1 },
    strong: { noise: 0.3 },
  };
  const LEVEL_NAMES = { weak: 'よわい', normal: 'ふつう', strong: 'つよい' };   // ロビーで選べる強さ
  const cellAt = (g, q, r) => g.board[E.key(q, r)];
  const playerById = (g, id) => g.players.find(p => p.id === id);

  // 拡張できるマスに点数を付ける
  function scoreExpands(g, id, rng, lv) {
    const myGroup = new Set(E.largestGroup(g, id));
    const foes = g.players.filter(p => p.alive && p.id !== id);
    const out = [];
    for (const k of E.targets(g, id, 'expand')) {
      const c = g.board[k];
      const nb = E.neighbors(c.q, c.r).map(([q, r]) => cellAt(g, q, r)).filter(Boolean);
      let s = 2;
      if (nb.some(n => myGroup.has(E.key(n.q, n.r)))) s += 3;             // 一番大きなかたまりを伸ばす
      s += nb.filter(n => !n.owner).length * 0.4;                          // まだ広がれる方向
      s += nb.filter(n => n.owner && n.owner !== id).length * 0.6;         // 相手と接するマスは先に押さえる（取られると伸びられない）
      const near = Math.min(...foes.map(f => { const [q, r] = E.parseKey(f.core); return E.dist([c.q, c.r], [q, r]); }));
      s += Math.max(0, 6 - near) * 0.2;                                    // 相手の方へ（取り合いになる場所から）
      out.push({ s: s + (rng() - 0.5) * lv.noise, a: { type: 'expand', q: c.q, r: c.r } });
    }
    return out;
  }

  // 狙い・攻撃・反撃に点数を付ける
  function scoreBattle(g, id, rng, lv) {
    const me = playerById(g, id);
    const noise = () => (rng() - 0.5) * lv.noise;
    const out = [];
    // 狙い：まだ何も狙っていないセルから、隣の相手のセルを狙う（行動力・戦力は使わない）。
    // 自分がすでに狙っているセル（集中させると攻撃が安く強くなる）・体力の少ないセル・コアを選ぶ
    for (const k of E.targets(g, id, 'aim')) {
      const c = g.board[k];
      if (c.aim) continue;
      const best = E.foeNeighbors(g, c).map(t => {
        const tk = E.key(t.q, t.r);
        return { tk, v: E.aimersOf(g, tk, id).length * 1.5 + (6 - t.hp) * 0.5 + (t.core ? 3 : 0) };
      }).sort((a, b) => b.v - a.v)[0];
      out.push({ s: 4 + best.v * 0.3 + noise(), a: { type: 'aim', q: c.q, r: c.r, to: best.tk } });
    }
    // 攻撃：狙っているセルが多いほど安く強い。壊せるなら大きく、コアなら最優先。1つだけの狙いでは高くつくので控える
    for (const k of E.targets(g, id, 'attack')) {
      const t = g.board[k];
      const { n, cost } = E.attackInfo(g, id, k);
      const kills = t.hp <= n;
      let s = kills ? (t.core ? 40 : 9) : n >= 3 ? 3 + n : n === 2 ? 2.5 : -2;
      if (me.power - cost < 5 && mostThreat(g, id) >= 2) s -= 2;   // 反撃する分の戦力は残したい
      out.push({ s: s + noise(), a: { type: 'attack', q: t.q, r: t.r } });
    }
    // 反撃：狙っている相手のセルが多いほどお得（戦力5で全部に −3）。壊せるセル・コアを守るときは大きく
    for (const k of E.targets(g, id, 'counter')) {
      const c = g.board[k];
      const list = E.aimersOf(g, k).filter(x => x.owner !== id);
      const kills = list.filter(x => x.hp <= 3).length;
      let s = list.length * 2 + kills * 2 + (c.core ? 3 : 0) - 3;
      if (list.length === 1 && !kills && !c.core) s -= 3;
      out.push({ s: s + noise(), a: { type: 'counter', q: c.q, r: c.r } });
    }
    return out;
  }

  // 自分のセルのうち、一番多く狙われているセルを狙っている相手のセルの数
  function mostThreat(g, id) {
    return Math.max(0, ...E.cellsOf(g, id).map(c => E.aimersOf(g, E.key(c.q, c.r)).filter(x => x.owner !== id).length));
  }

  // 一番よい行動を1つ選ぶ（よい行動がなければ何もしない＝待つ）
  function decideRealtime(g, id, rng, level) {
    rng = rng || Math.random;
    const lv = LEVELS[level] || LEVELS.normal;
    const me = playerById(g, id);
    if (!me || !me.alive || g.over) return null;
    const best = scoreExpands(g, id, rng, lv).concat(scoreBattle(g, id, rng, lv)).sort((a, b) => b.s - a.s)[0];
    return best && best.s > 0 ? best.a : null;
  }

  // 行動力が満タンだったとしても、もうやりたい行動がないか（ないなら行動完了にする）
  function wantsMore(g, id, level) {
    const me = playerById(g, id);
    if (!me || !me.alive || g.over) return false;
    const ap = me.ap;
    me.ap = E.RULES.rt.apMax;
    const a = decideRealtime(g, id, () => 0.5, level);   // ゆらぎなしで考える
    me.ap = ap;
    return !!a;
  }

  return { decideRealtime, wantsMore, LEVELS, LEVEL_NAMES };
});
