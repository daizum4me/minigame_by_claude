/*
 * Cocage — CPU の考え方
 * 公開情報（盤面・葉・枝）だけで、このターンの行動（最大3つ）を1つずつ決める。
 * 葉は「置いたときの列の得点の増減（相手を覆えば相手の損）」、枝は「その先に置ける葉の価値」と「折れやすさ」で点をつける。
 *
 * nextAction(state, id, rng, level) → engine.apply に渡せる行動か null
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.CocageCpu = factory(root.CocageEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // noise：点数のゆらぎ（大きいほど気まぐれ）
  const LEVELS = { weak: { noise: 1.2 }, normal: { noise: 0.3 }, strong: { noise: 0.05 } };
  const LEVEL_NAMES = { weak: 'よわい', normal: 'ふつう', strong: 'つよい' };

  // 葉を置いたときの価値：自分の得点の増え分 − 相手の増え分の6割。折れずに残る見込みと残りターンを掛ける
  function leafValue(state, geo, me, ck, extraLeaves, surv, horizon) {
    const c = geo.cells[ck];
    const list = [];
    for (const [k, lf] of Object.entries(state.leaves)) if (k.split(',')[0] === String(c.c)) list.push({ k, r: +k.split(',')[1], owner: lf.owner });
    for (const k of extraLeaves) if (k.split(',')[0] === String(c.c)) list.push({ k, r: +k.split(',')[1], owner: me });
    const before = E.scoreColumn(list);
    const after = E.scoreColumn(list.concat([{ k: ck, r: c.r, owner: me }]));
    let mine = after[after.length - 1], others = 0;
    list.forEach((x, i) => {
      const d = after[i] - before[i];
      if (x.owner === me) mine += d; else others += d;
    });
    return (mine - 0.6 * others) * horizon * surv;
  }

  // 辺 ek の先まで残る見込み（horizon ターン）
  function survival(state, geo, ek, pendingMeta, horizon) {
    let s = 1;
    const m = pendingMeta[ek];
    if (m) s *= Math.pow(1 - E.breakProb(m.h, m.l), horizon);
    for (let k = m ? m.parent : ek; k && state.edges[k]; k = state.edges[k].parent) s *= Math.pow(1 - E.breakProb(state.edges[k].h, state.edges[k].l), horizon);
    return s;
  }

  function nextAction(state, id, rng, level) {
    rng = rng || Math.random;
    const lv = LEVELS[level] || LEVELS.normal;
    const p = E.playerById(state, id);
    if (!p || state.over || p.plan.length >= E.RULES.ap) return null;
    const geo = E.geometry(state.cols);
    const pr = E.project(state, id, p.plan);
    if (pr.error) return null;
    const cand = E.candidates(state, id);
    const left = state.turns - state.round;
    const horizon = Math.min(left, 14), noise = () => (rng() - 0.5) * lv.noise;
    // 計画中の枝のメタ（長さ・親）を、計画した順に積み上げる
    const meta = {};
    const net = E.ownNet(state, geo, p);
    for (const it of p.plan) {
      if (it.t !== 'b') continue;
      const e = geo.edges[it.e];
      const ia = net.v.get(e.a), ib = net.v.get(e.b);
      const at = ia || ib, to = ia ? e.b : e.a;
      meta[it.e] = { h: e.h, l: at.l + 1, parent: at.edge };
      net.v.set(to, { l: at.l + 1, edge: it.e });
      net.edges.add(it.e);
    }
    const extraLeaves = p.plan.filter(it => it.t === 'l').map(it => it.c);
    let best = null;
    const consider = (s, a) => { if (!best || s > best.s) best = { s, a }; };

    // 葉
    for (const ck of cand.cells) {
      // その葉を支える枝の中で一番残りやすいもの
      let surv = 0;
      for (const ek of geo.cells[ck].edges) {
        if (state.edges[ek] && state.edges[ek].owner === id) surv = Math.max(surv, survival(state, geo, ek, meta, horizon / 2));
        else if (meta[ek]) surv = Math.max(surv, survival(state, geo, ek, meta, horizon / 2));
      }
      consider(leafValue(state, geo, id, ck, extraLeaves, surv, horizon) + noise(), { type: 'addLeaf', cell: ck });
    }
    // 枝：新しい辺に接するセルに葉を置く価値の合計（の一部）。遠く・高いほど折れやすいので割り引く。
    // すでに自分の枝に接している（もう葉を置ける）セルは、枝を足しても増えないので数えない
    const reach = new Set();
    for (const ek of net.edges) for (const ck of geo.edges[ek].cells) reach.add(ck);
    for (const ek of cand.edges) {
      const e = geo.edges[ek];
      const at = net.v.get(e.a) || net.v.get(e.b);
      const l = at.l + 1;
      const m = { h: e.h, l, parent: at.edge };
      const surv = Math.pow(1 - E.breakProb(e.h, l), horizon / 2) * (m.parent ? survival(state, geo, m.parent, {}, horizon / 2) : 1);
      let gain = 0;
      for (const ck of e.cells) {
        if (state.leaves[ck] || extraLeaves.includes(ck) || reach.has(ck)) continue;
        gain = Math.max(gain, leafValue(state, geo, id, ck, extraLeaves, surv, horizon));   // 同じ列の葉は1枚あれば足りるので、合計ではなく一番よいものだけ
      }
      consider(gain * 0.5 + 0.03 * e.h * surv + noise(), { type: 'addBranch', edge: ek });
    }
    return best && best.s > 0.15 ? best.a : null;
  }

  return { nextAction, LEVELS, LEVEL_NAMES };
});
