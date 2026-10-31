/*
 * ヘキサゴニア — CPU の考え方
 * 人間と同じ公開情報（盤面・全員のトークン数。相手の防御の数は見ない）で、次の1手を決める。
 * 部屋が2.5秒ごとに呼ぶ。「できる行動に点数を付けて一番高いもの」を選び、よい行動がなければ何もしない（待つ）。
 *
 * decideRealtime(state, id, rng, level) → action（engine.apply に渡せる形）か null
 * level：'weak'（よわい）・'normal'（ふつう）・'strong'（つよい）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.HexCpu = factory(root.HexEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const R = E.RULES;

  // 強さ。noise：点数のゆらぎ（大きいほど気まぐれ）、endBelow：これより点数が低い行動しかなければ待つ、
  // bias：行動の種類ごとの点数の上乗せ
  const LEVELS = {
    weak: { noise: 4, endBelow: 1.5, bias: {} },
    normal: { noise: 0.6, endBelow: 0.5, bias: {} },
    strong: { noise: 0.15, endBelow: 0.5, bias: { strengthen: 1.5, expand: -0.5 } },
  };
  const LEVEL_NAMES = { weak: 'よわい', normal: 'ふつう', strong: 'つよい' };   // ロビーで選べる強さ
  const cellAt = (g, q, r) => g.board[E.key(q, r)];
  const playerById = (g, id) => g.players.find(p => p.id === id);

  // 自分のコアの周り（距離2まで）にある相手セルの数
  function threat(g, me) {
    const core = E.parseKey(me.core);
    return Object.values(g.board).filter(c => c.owner && c.owner !== me.id && E.dist([c.q, c.r], core) <= 2).length;
  }

  // 相手セルに隣接している自分のセルの数（前線の広さ）
  function frontier(g, id) {
    return E.cellsOf(g, id).filter(c => E.neighbors(c.q, c.r).some(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner && n.owner !== id; })).length;
  }

  // そのマスの隣にある相手のセルの数
  const foeNeighbors = (g, id, c) => E.neighbors(c.q, c.r).filter(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner && n.owner !== id; }).length;

  function scoreActions(g, id, rng, lv) {
    const me = playerById(g, id);
    const foes = g.players.filter(p => p.alive && p.id !== id);
    const foeCores = foes.map(p => E.parseKey(p.core));
    const late = g.round >= g.rounds - 2;               // 終盤は一番大きなかたまりを重視
    const myGroup = new Set(E.largestGroup(g, id));
    // 一番大きなかたまりが最大の相手（最後のターンが終わったときの勝敗に効く）
    const leaderGroups = new Set(foes.map(p => E.largestGroup(g, p.id)).sort((a, b) => b.length - a.length)[0] || []);
    const touchesMine = c => E.neighbors(c.q, c.r).some(([q, r]) => myGroup.has(E.key(q, r)));
    const danger = threat(g, me);
    // 食料：ターンの終わりに「貯え + 作る量 − 食べる量」が足りないとセルを捨てることになる
    const foodLeft = (me.food || 0) + E.foodMade(g, id) - E.foodEaten(g, id);
    const out = [];
    const noise = () => (rng() - 0.5) * lv.noise;

    if (!E.actionBlocked(g, id, 'expand')) {
      for (const k of E.targets(g, id, 'expand')) {
        const c = g.board[k];
        const near = Math.min(...foeCores.map(f => E.dist([c.q, c.r], f)));
        const own = E.neighbors(c.q, c.r).filter(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner === id; }).length;
        // 相手のコアに近づくほど高い（コアを壊せば、相手のセルとトークンをまるごと受け継げる）
        let s = 2 + own * 0.25 + Math.max(0, 8 - near) * 0.35;
        if (c.terrain === 'mine') s += me.power <= 1 ? 2.5 : 1.2;    // 鉱山は取ると戦力トークン +1
                if (c.terrain === 'forest') s += late ? 0.2 : 1.1;           // 森林はターンごとの資源 +1（終盤は元が取れない）
        if (c.terrain === 'river') {
          // 橋は高い（資源4）。向こう側に新しく取れる土地があるときだけ
          const beyond = E.neighbors(c.q, c.r).filter(([q, r]) => {
            const n = cellAt(g, q, r);
            return n && !n.owner && n.terrain !== 'river' && !E.neighbors(q, r).some(([a, b]) => { const m = cellAt(g, a, b); return m && m.owner === id; });
          }).length;
          s += beyond ? beyond * 0.5 - 1.5 : -3;
        }
        // 広げると食料を1つ多く食べる。食べさせきれないなら広げない
        if (foodLeft - 1 < 0) s -= 6;
        else if (foodLeft - 1 < 2) s -= 1.5;
        // 一番大きなかたまりにつながる拡張を重視（終盤は特に）
        if (touchesMine(c)) s += late ? 2.8 : 0.6;
        else if (late) s += 0.3;
        out.push({ s: s + noise() + (lv.bias.expand || 0), a: { type: 'expand', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'strengthen')) {
      for (const k of E.targets(g, id, 'strengthen')) {
        const c = g.board[k];
        // 強化するとターンごとの資源 +1 と戦力トークン +1。終盤は元が取れない
        let s = late ? 1 : 3.2;
        if (foodLeft < 3) s += late ? 4 : 2;               // 強化すると食料 +1
        if (c.core) s += 2.5;
        if (c.terrain === 'mine') s += 1.2;
        if (me.power === 0 && frontier(g, id) > 0) s += 1.5;
        // 強化済のセルは攻撃の拠点。新しく攻撃できるようになる相手のセルが多いほど、相手のコアを狙えるならさらに
        if (foeNeighbors(g, id, c) > 0) {
          const newTargets = E.neighbors(c.q, c.r).filter(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner && n.owner !== id && !E.adjacentToStrong(g, id, q, r); }).length;
          s += Math.min(3, newTargets) * 0.6;
          if (E.neighbors(c.q, c.r).some(([q, r]) => { const n = cellAt(g, q, r); return n && n.core && n.owner && n.owner !== id; })) s += 4;
        }
        out.push({ s: s + noise() + (lv.bias.strengthen || 0), a: { type: 'strengthen', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'develop')) {
      // 発展：前線から遠い（壊されにくい）平原のセルを、食料が足りなくなりそうなら農地に、そうでなければ工場に
      const ks = E.targets(g, id, 'develop');
      if (ks.length) {
        const k = ks.map(k => ({ k, f: foeNeighbors(g, id, g.board[k]) })).sort((a, b) => a.f - b.f)[0].k;
        const [q, r] = E.parseKey(k);
        let farm = foodLeft < 0 ? 5 : foodLeft < 2 ? 3.5 : foodLeft < 4 ? 1.8 : 0.4;
        let factory = foodLeft < 2 ? 0.5 : 4 - E.powerMade(g, id) * 0.4;   // 工場は毎ターン戦力 +1。多すぎると使いきれない
        if (danger > 0 && me.power < 3) factory += 1;                        // コアの近くに相手がいれば、守るための戦力がほしい
        if (late) { farm -= 1.5; factory -= 2; }                              // 終盤は元が取れない
        out.push({ s: farm + noise(), a: { type: 'develop', q, r, to: 'farm' } });
        out.push({ s: factory + noise(), a: { type: 'develop', q, r, to: 'factory' } });
      }
    }
    if (!E.actionBlocked(g, id, 'destroy')) {
      for (const k of E.targets(g, id, 'destroy')) {
        const c = g.board[k];
        // 攻防はなく、防御の分だけ攻撃を重ねれば壊せる。相手の防御の数は見えないので、セルの種類から見積もる（c.def は見ない）
        const need = (c.core ? 3 : c.strong ? 2 : 1) + 1;
        const canBreak = me.power >= need;
        let s = c.core ? (canBreak ? 30 : 3) : canBreak ? 4 : -1.5;   // 防御を削りきれないなら控える
        if (c.strong) s += 1 + (E.dist([c.q, c.r], E.parseKey(me.core)) <= 3 ? 1.5 : 0);   // 近くの相手の拠点は崩したい
        if (late) s += 1.5;
        if (late && leaderGroups.has(k)) s += 2;          // 首位のかたまりを削る
        // 自分のコアの隣にいる相手セルは優先して壊す
        if (E.dist([c.q, c.r], E.parseKey(me.core)) <= 1) s += 3;
        out.push({ s: s + noise() + (lv.bias.destroy || 0), a: { type: 'destroy', q: c.q, r: c.r } });
      }
    }
    return out;
  }

  // 一番よい行動を1つ選ぶ（よい行動がなければ何もしない＝待つ）
  function decideRealtime(g, id, rng, level) {
    rng = rng || Math.random;
    const lv = LEVELS[level] || LEVELS.normal;
    const me = playerById(g, id);
    if (!me || !me.alive || g.over) return null;
    const out = scoreActions(g, id, rng, lv);
    const noise = () => (rng() - 0.5) * lv.noise;
    const foeCells = [];
    for (const f of g.players) if (f.alive && f.id !== id) foeCells.push(...E.cellsOf(g, f.id));
    const foeDist = (q, r) => foeCells.reduce((m, f) => Math.min(m, E.dist([q, r], [f.q, f.r])), 99);
    // 防御：相手のセルと接している（または相手が2マス以内に来ている）自分のセルに、戦力トークンをつぎ込む。
    // 欲しい防御はコア3・強化済のセル2・ほかは1。コア以外は、攻める分の戦力を1個残す
    {
      for (const c of E.cellsOf(g, id)) {
        const want = c.core ? 3 : c.strong ? 2 : 1;
        if ((c.def || 0) >= want || me.power < (c.core ? 1 : 2)) continue;
        const hostile = E.neighbors(c.q, c.r).some(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner && n.owner !== id; });
        if (!hostile && foeDist(c.q, c.r) > 2) continue;
        const base = c.core ? 8 : c.strong ? 4.5 : 2.8;
        out.push({ s: base * (hostile ? 1 : 0.8) - (c.def || 0) * 1.5 + noise(), a: { type: 'fortify', q: c.q, r: c.r } });
      }
    }
    const best = out.sort((a, b) => b.s - a.s)[0];
    return best && best.s > lv.endBelow ? best.a : null;
  }

  return { decideRealtime, LEVELS, LEVEL_NAMES };
});
