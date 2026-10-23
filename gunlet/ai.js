/* 豆鉄砲 (gunlet) — simple CPU opponent (2-ply alpha-beta) */
(function (root) {
  'use strict';

  const G = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Gunlet;
  const { N } = G;

  const WIN = 1e6;

  function pieceValue(p) {
    switch (p.type) {
      case 'general': return p.hp * 90;
      case 'shield': return p.hp * 5;
      case 'archer': return 12;
      case 'gunner': return 11 + (p.loaded ? 2 : 0);
    }
    return 0;
  }

  function cheb(a, b) {
    const [ax, ay] = G.xy(a), [bx, by] = G.xy(b);
    return Math.max(Math.abs(ax - bx), Math.abs(ay - by));
  }

  /** Static evaluation from `me`'s point of view. */
  function evaluate(s, me) {
    if (s.winner === me) return WIN - s.ply;
    if (s.winner === 'draw') return 0;
    if (s.winner !== null) return -WIN + s.ply;

    const gen = [G.findGeneral(s, 0), G.findGeneral(s, 1)];
    let score = 0;
    const threat = [0, 0];
    const genThreat = [0, 0];

    for (let i = 0; i < N * N; i++) {
      const c = s.cells[i];
      const p = c.piece;
      if (!p) continue;
      const sign = p.owner === me ? 1 : -1;
      let v = pieceValue(p);
      const foe = gen[1 - p.owner];
      if (p.type === 'archer' || p.type === 'gunner') {
        if (G.isTower(c)) v += 2;
        if (foe >= 0) v -= 0.4 * Math.abs(cheb(i, foe) - 3);
        for (const t of G.shotTargets(s, i)) {
          const q = s.cells[t].piece;
          if (!q) { threat[p.owner] += 1; continue; }
          if (q.type === 'general') genThreat[p.owner] += 1;
          threat[p.owner] += Math.min(pieceValue(q), 15);
        }
      } else if (p.type === 'general') {
        for (const t of G.meleeTargets(s, i)) {
          const q = s.cells[t].piece;
          if (q.type === 'general') genThreat[p.owner] += 1;
          threat[p.owner] += Math.min(pieceValue(q), 15);
        }
      } else if (p.type === 'shield' && foe >= 0) {
        // 盾は自軍の将の近くにいてほしい
        const own = gen[p.owner];
        if (own >= 0) v -= 0.3 * Math.max(0, cheb(i, own) - 2);
      }
      score += sign * v;
    }
    for (const pl of [0, 1]) {
      const sign = pl === me ? 1 : -1;
      score += sign * (s.reserve[pl].wall * 3 + s.reserve[pl].tower * 3);
    }

    // 手番側の脅威は大きく、相手側の脅威は小さく評価
    const t = s.turn;
    const tf = (pl) => (pl === t ? 0.35 : 0.12);
    for (const pl of [0, 1]) {
      const sign = pl === me ? 1 : -1;
      score += sign * threat[pl] * tf(pl);
      const foeGen = gen[1 - pl];
      if (genThreat[pl] > 0 && foeGen >= 0) {
        const fragile = s.cells[foeGen].piece.hp === 1;
        if (pl === t && fragile) score += sign * WIN / 2; // 次に討ち取れる
        else score += sign * genThreat[pl] * (fragile ? 40 : 15) * (pl === t ? 1 : 0.6);
      }
    }
    return score;
  }

  /** Prune placements to points near own pieces to keep the search small. */
  function candidateActions(s) {
    const all = G.legalActions(s);
    const own = [];
    for (let i = 0; i < N * N; i++) {
      const p = s.cells[i].piece;
      if (p && p.owner === s.turn) own.push(i);
    }
    return all.filter((a) => a.type !== 'place' || own.some((o) => cheb(o, a.at) <= 2));
  }

  function search(s, depth, alpha, beta, me) {
    if (depth === 0 || s.winner !== null) return evaluate(s, me);
    const maximizing = s.turn === me;
    const acts = candidateActions(s);
    if (maximizing) {
      let best = -Infinity;
      for (const a of acts) {
        const v = search(G.apply(s, a).state, depth - 1, alpha, beta, me);
        if (v > best) best = v;
        if (best > alpha) alpha = best;
        if (alpha >= beta) break;
      }
      return best;
    }
    let best = Infinity;
    for (const a of acts) {
      const v = search(G.apply(s, a).state, depth - 1, alpha, beta, me);
      if (v < best) best = v;
      if (best < beta) beta = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  function chooseAction(s) {
    const me = s.turn;
    const acts = candidateActions(s);
    if (acts.length === 0) return null;
    // 1手読みで並べ替えて枝刈りを効かせる
    const scored = acts.map((a) => {
      const ns = G.apply(s, a).state;
      return { a, ns, quick: evaluate(ns, me) };
    }).sort((p, q) => q.quick - p.quick);

    let best = null, bestV = -Infinity, alpha = -Infinity;
    for (const { a, ns } of scored) {
      const v = search(ns, 1, alpha, Infinity, me) + Math.random() * 0.8;
      if (v > bestV) { bestV = v; best = a; }
      if (v > alpha) alpha = v;
    }
    return best;
  }

  const api = { chooseAction, evaluate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GunletAI = api;
})(typeof self !== 'undefined' ? self : this);
