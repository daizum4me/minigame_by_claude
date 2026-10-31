/*
 * ヘキサブルグ — CPU の考え方
 * 人間と同じ公開情報（盤面・全員の資源）だけで、次の1手を決める。
 * 部屋が CPU ごとに1.5〜3.5秒のばらつきのある間隔で呼ぶ。「拡張できるマスに点数を付けて一番高いもの」を選び、
 * よいマスがなければ何もしない（待つ）。
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

  // 一番よい行動を1つ選ぶ（行動できなければ何もしない＝待つ）
  function decideRealtime(g, id, rng, level) {
    rng = rng || Math.random;
    const lv = LEVELS[level] || LEVELS.normal;
    const me = playerById(g, id);
    if (!me || !me.alive || g.over) return null;
    const best = scoreExpands(g, id, rng, lv).sort((a, b) => b.s - a.s)[0];
    return best ? best.a : null;
  }

  // 行動力が満タンだったとしても、もうやれる行動がないか（ないなら行動完了にする）
  function wantsMore(g, id) {
    return E.hasMoves(g, id);
  }

  return { decideRealtime, wantsMore, LEVELS, LEVEL_NAMES };
});
