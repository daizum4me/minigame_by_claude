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
  const LEAF_BIAS = 1.8, BRANCH_W = 0.3, CLIMB = 0.03, BRANCH_COST = 0, AHEAD_W = 0.3, ATTACK = 0.8, MISTLE_W = 1.0;   // 葉を枝より優先する（枝は葉を置くための手段）
  const LEVEL_NAMES = { weak: 'よわい', normal: 'ふつう', strong: 'つよい' };

  // 葉を置いたときの価値：自分の得点の増え分 − 相手の増え分（ATTACK 倍。相手の点を奪う手を重く見る）。折れずに残る見込みと残りターンを掛ける
  function leafValue(state, geo, me, ck, extraLeaves, surv, horizon, isMist) {
    const c = geo.cells[ck];
    const list = [];
    for (const [k, lf] of Object.entries(state.leaves)) if (k.split(',')[0] === String(c.c)) list.push({ k, r: +k.split(',')[1], owner: lf.owner, mist: !!lf.host });
    for (const k of extraLeaves) if (k.split(',')[0] === String(c.c)) list.push({ k, r: +k.split(',')[1], owner: me });
    const np = state.players.length;
    const before = E.scoreColumn(list, np);
    const after = E.scoreColumn(list.concat([{ k: ck, r: c.r, owner: me, mist: !!isMist }]), np);
    let mine = after[after.length - 1], others = 0;
    list.forEach((x, i) => {
      const d = after[i] - before[i];
      if (x.owner === me) mine += d; else others += d;
    });
    return (mine - ATTACK * others) * horizon * surv;
  }

  // 保険：自分の葉がその列の一番上にあるとき、2枚目以降の葉は点にならないが、一番上が折れたときの控えになる
  function insurance(state, geo, me, ck, ctx, surv, horizon) {
    const c = geo.cells[ck];
    let top = null;
    for (const [k, lf] of Object.entries(state.leaves)) {
      const [kc, kr] = k.split(',').map(Number);
      if (kc === c.c && (!top || kr > top.r)) top = { k, r: kr, owner: lf.owner };
    }
    if (!top || top.owner !== me || top.r <= c.r) return 0;
    let topSurv = 0;
    for (const ek of geo.cells[top.k].edges) if (state.edges[ek] && state.edges[ek].owner === me) topSurv = Math.max(topSurv, survival(ctx, ek, 0, horizon));
    return (1 - topSurv) * horizon * 1.0 * surv;
  }

  // 辺 ek から根本までが horizon ターン残る見込み。add：その辺から先に、さらに足す枝の数（根本ほど重くなる）
  function survival(ctx, ek, add, horizon) {
    let s = 1;
    for (let k = ek; k && ctx.all[k]; k = ctx.all[k].parent) s *= Math.pow(1 - E.breakProb(ctx.all[k].h, ctx.w[k] + add), horizon);
    return s;
  }

  // 新しく枝を置いたときの、その辺から根本までの見込み
  function newEdgeSurvival(ctx, h, parent, horizon) {
    return Math.pow(1 - E.breakProb(h, 1), horizon) * (parent ? survival(ctx, parent, 1, horizon) : 1);
  }

  // 列 c で、自分より下にある相手の一番上の葉（覆えば相手の点を奪える）
  function opponentTopBelow(state, me, c, r) {
    let top = null;
    for (const [k, lf] of Object.entries(state.leaves)) {
      const [kc, kr] = k.split(',').map(Number);
      if (kc === c && (!top || kr > top.r)) top = { r: kr, owner: lf.owner };
    }
    return top && top.owner !== me && top.r < r;
  }

  function nextAction(state, id, rng, level) {
    rng = rng || Math.random;
    const lv = LEVELS[level] || LEVELS.normal;
    const p = E.playerById(state, id);
    if (!p || state.over || E.planCost(p.plan) >= E.RULES.ap) return null;
    const geo = E.geometry(state.cols);
    const pr = E.project(state, id, p.plan);
    if (pr.error) return null;
    const cand = E.candidates(state, id);
    const left = state.turns - state.round;
    const horizon = Math.min(left, 14), noise = () => (rng() - 0.5) * lv.noise;
    // 計画中の枝も、置いたものとして（高さ・親）積み上げる。支えている枝の数はそれも込みで数える
    const all = {};
    for (const [k, e] of Object.entries(state.edges)) all[k] = { h: e.h, parent: e.parent };
    const net = E.ownNet(state, geo, p);
    for (const it of p.plan) {
      if (it.t !== 'b') continue;
      const e = geo.edges[it.e];
      const ia = net.v.get(e.a), ib = net.v.get(e.b);
      const at = ia || ib, to = ia ? e.b : e.a;
      all[it.e] = { h: e.h, parent: at.edge };
      net.v.set(to, { l: at.l + 1, edge: it.e });
      net.edges.add(it.e);
    }
    const ctx = { all, w: E.loads({ edges: all }) };
    const extraLeaves = p.plan.filter(it => it.t === 'l').map(it => it.c);
    let best = null;
    const consider = (s, a) => { if (!best || s > best.s) best = { s, a }; };

    // 葉
    for (const ck of cand.cells) {
      // その葉を支える枝の中で一番残りやすいもの
      let surv = 0;
      for (const ek of geo.cells[ck].edges) {
        if ((state.edges[ek] && state.edges[ek].owner === id) || (all[ek] && !state.edges[ek])) surv = Math.max(surv, survival(ctx, ek, 0, horizon / 2));
      }
      const v = leafValue(state, geo, id, ck, extraLeaves, surv, horizon) * LEAF_BIAS + insurance(state, geo, id, ck, ctx, surv, horizon);
      consider(v + (v > 0 ? 0.3 : 0) + noise(), { type: 'addLeaf', cell: ck });
    }
    // ヤドリギ：他人の枝に接するセルに葉を置く（行動力2）。宿主の枝が折れると一緒に消えるので、宿主の残りやすさで割り引く。
    // 行動力あたりの価値で、ふつうの葉・枝と比べる
    for (const ck of cand.mistle || []) {
      const r = E.checkMistletoe(geo, state, net, ck, pr.pendingLeaves);
      if (typeof r === 'string') continue;
      const surv = survival(ctx, r.host, 1, horizon / 2);
      // 養分を吸う：宿主から奪うぶん（自分の得＋相手の損）を、残りターンと残りやすさで掛ける
      const drain = E.RULES.mistletoeDrain * (1 + ATTACK) * horizon * surv;
      const v = (leafValue(state, geo, id, ck, extraLeaves, surv, horizon, true) * LEAF_BIAS + drain) * MISTLE_W / E.RULES.mistletoeCost;
      consider(v + (v > 0 ? 0.3 : 0) + noise(), { type: 'addMistletoe', cell: ck });
    }
    // 枝：新しい辺に接するセルに葉を置く価値（の一部）。高い・根本が重いほど折れやすいので割り引く。
    // すでに自分の枝に接している（もう葉を置ける）セルは、枝を足しても増えないので数えない。
    // 攻め：その先（もう1辺）で、相手の一番上の葉を覆えるセルに届くなら、その価値も少し足す
    const reach = new Set();
    for (const ek of net.edges) for (const ck of geo.edges[ek].cells) reach.add(ck);
    for (const ek of cand.edges) {
      const e = geo.edges[ek];
      const ia = net.v.has(e.a), at = net.v.get(e.a) || net.v.get(e.b), to = ia ? e.b : e.a;
      const surv = newEdgeSurvival(ctx, e.h, at.edge, horizon / 2);
      let gain = 0;
      for (const ck of e.cells) {
        if (state.leaves[ck] || extraLeaves.includes(ck) || reach.has(ck)) continue;
        gain = Math.max(gain, leafValue(state, geo, id, ck, extraLeaves, surv, horizon));   // 同じ列の葉は1枚あれば足りるので、合計ではなく一番よいものだけ
      }
      let ahead = 0;
      for (const ek2 of geo.verts[to].edges) {
        if (ek2 === ek || geo.reserved.has(ek2) || state.edges[ek2] || all[ek2]) continue;
        const e2 = geo.edges[ek2];
        for (const ck of e2.cells) {
          if (state.leaves[ck] || reach.has(ck) || e.cells.includes(ck)) continue;
          const c = geo.cells[ck];
          if (!opponentTopBelow(state, id, c.c, c.r)) continue;
          ahead = Math.max(ahead, leafValue(state, geo, id, ck, extraLeaves, surv, horizon));
        }
      }
      consider((gain + AHEAD_W * ahead) * BRANCH_W + CLIMB * e.h * surv + noise() - BRANCH_COST, { type: 'addBranch', edge: ek });
    }
    return best && best.s > 0.15 ? best.a : null;
  }

  return { nextAction, LEVELS, LEVEL_NAMES };
});
