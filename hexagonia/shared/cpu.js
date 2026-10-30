/*
 * ヘキサゴニア — CPU の考え方
 * 人間と同じ公開情報（盤面・全員のトークン数）だけで、次の1手を決める。
 * 手番では「できる行動に点数を付けて一番高いもの」を選び、よい行動がなければ手番終了。
 *
 * decide(state, id, rng) → action（engine.apply に渡せる形）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.HexCpu = factory(root.HexEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const R = E.RULES;
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

  // 相手の防御トークンの数の見積もり（実際の数は見ない）。
  // 見えている増減（最初の2個・強化、守られた攻防）に、見えない生産の分を1個ぶん足しておく
  const estDefense = foe => Math.max(0, foe.defenseSeen == null ? foe.defense : foe.defenseSeen) + 1;

  function scoreActions(g, id, rng) {
    const me = playerById(g, id);
    const foes = g.players.filter(p => p.alive && p.id !== id);
    const foeCores = foes.map(p => E.parseKey(p.core));
    const late = g.round >= g.rounds - 2;               // 終盤は一番大きなかたまりを重視
    const myGroup = new Set(E.largestGroup(g, id));
    // 一番大きなかたまりが最大の相手（12ラウンド終了の勝敗に効く）
    const leaderGroups = new Set(foes.map(p => E.largestGroup(g, p.id)).sort((a, b) => b.length - a.length)[0] || []);
    const touchesMine = c => E.neighbors(c.q, c.r).some(([q, r]) => myGroup.has(E.key(q, r)));
    const danger = threat(g, me);
    // 食料：手番終了時に「貯え + 作る量 − 食べる量」が足りないとセルを捨てることになる
    const foodLeft = (me.food || 0) + E.foodMade(g, id) - E.foodEaten(g, id);
    const out = [];
    const noise = () => (rng() - 0.5) * 0.6;

    if (!E.actionBlocked(g, id, 'expand')) {
      for (const k of E.targets(g, id, 'expand')) {
        const c = g.board[k];
        const near = Math.min(...foeCores.map(f => E.dist([c.q, c.r], f)));
        const own = E.neighbors(c.q, c.r).filter(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner === id; }).length;
        let s = 2 + own * 0.25 + Math.max(0, 8 - near) * 0.12;
        if (c.terrain === 'mine') s += me.attack <= 1 ? 2.5 : 1.2;   // 鉱山は取ると攻撃トークン +1
        if (c.terrain === 'farm') s += foodLeft < 3 ? 2.5 : 1.2;     // 農地は毎手番の食料 +1（食べる分を自分でまかなえる）
        if (c.terrain === 'forest') s += late ? 0.2 : 1.1;           // 森林は毎手番の資源 +1（終盤は元が取れない）
        if (c.terrain === 'mountain') s += danger > 0 || me.defense <= 1 ? 1.8 : 0.8;   // 山岳は取ると防御トークン +1
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
        out.push({ s: s + noise(), a: { type: 'expand', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'strengthen')) {
      for (const k of E.targets(g, id, 'strengthen')) {
        const c = g.board[k];
        // 強化すると毎手番の資源 +1 と攻撃トークン +1。終盤は元が取れない
        let s = late ? 1 : 3.2;
        if (foodLeft < 3) s += late ? 4 : 2;               // 強化すると食料 +1
        if (c.core) s += 2.5;
        if (c.terrain === 'mine') s += 1.2;
        if (c.terrain === 'mountain') s += danger > 0 ? 1.2 : 0.6;
        if (me.attack === 0 && frontier(g, id) > 0) s += 1.5;
        // 強化済のセルは破壊の拠点で、隣の自分のセルを守る城壁にもなる。前線に置くほど役に立つ
        const foesNext = foeNeighbors(g, id, c);
        if (foesNext > 0) {
          const newTargets = E.neighbors(c.q, c.r).filter(([q, r]) => {
            const n = cellAt(g, q, r);
            return n && n.owner && n.owner !== id && !E.adjacentToStrong(g, id, q, r);
          }).length;
          s += Math.min(3, newTargets) * 0.9;            // 新しく破壊できるようになる相手のセル
          // 相手のコアを狙える拠点になるなら大きい
          if (E.neighbors(c.q, c.r).some(([q, r]) => { const n = cellAt(g, q, r); return n && n.core && n.owner && n.owner !== id; })) s += 4;
          if (E.parseKey(me.core).join() !== [c.q, c.r].join() && E.wallOf(g, c) === 0) s -= 0.4;   // 自分は守られない
        }
        const shielded = E.neighbors(c.q, c.r).filter(([q, r]) => {
          const n = cellAt(g, q, r);
          return n && n.owner === id && !E.adjacentToStrong(g, id, q, r) && foeNeighbors(g, id, n) > 0;
        }).length;
        s += Math.min(3, shielded) * (danger > 0 ? 0.8 : 0.5);    // 新しく城壁で守られる前線のセル
        out.push({ s: s + noise(), a: { type: 'strengthen', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'destroy')) {
      for (const k of E.targets(g, id, 'destroy')) {
        const c = g.board[k];
        const foe = playerById(g, c.owner);
        // 相手が防御トークンを全部出しても破りきれそうか（見積もり。破りきれないときは読み合いになる）
        const wall = E.wallOf(g, c);
        const est = estDefense(foe) + wall;               // 城壁の分は相手が出さなくても足される
        const canBreak = me.attack >= est;
        let s;
        if (c.core) s = canBreak ? 30 : 3;                  // コアは最優先
        else if (est <= 1) s = 5;
        else s = canBreak ? 3.2 : 0.8;
        s += 0.8;   // 破壊に成功すると、そのマスが自分のセルになる
        if (c.strong) s += 1 + (E.dist([c.q, c.r], E.parseKey(me.core)) <= 3 ? 1.5 : 0);   // 近くの相手の拠点は崩したい
        if (wall) s -= canBreak ? 0.5 : 1.8;              // 城壁で守られたセルは、破りきれないなら狙わない
        // 城壁のない強化済のセルを崩すと、その隣のセルの城壁もなくなる
        if (c.strong && !wall) s += 0.7 * Math.min(2, E.neighbors(c.q, c.r).filter(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner === c.owner && !n.strong; }).length);
        if (late) s += 1.5;
        if (late && leaderGroups.has(k)) s += 2;          // 首位のかたまりを削る
        if (touchesMine(c)) s += 0.5;                       // 取ったマスが自分のかたまりにつながる
        // 自分のコアの隣にいる相手セルは優先して壊す
        if (E.dist([c.q, c.r], E.parseKey(me.core)) <= 1) s += 3;
        out.push({ s: s + noise(), a: { type: 'destroy', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'produceAttack')) {
      // 生産（攻撃トークン）：攻撃トークンがないと破壊できない
      const front = frontier(g, id) > 0;
      let s = me.attack === 0 && front ? 3.5 : me.attack < 2 && front ? 1.2 : 0.1;
      // 相手のコアの隣に拠点があるなら、コアを破りきれる数まで攻撃トークンをためる
      const coreFoe = foes.find(f => { const [q, r] = E.parseKey(f.core); return E.adjacentToStrong(g, id, q, r); });
      if (coreFoe && me.attack < estDefense(coreFoe) + E.wallOf(g, g.board[coreFoe.core])) s = Math.max(s, 4);
      out.push({ s: s + noise(), a: { type: 'produceAttack' } });
    }
    if (!E.actionBlocked(g, id, 'reinforce')) {
      // 補強は防御トークン +1 だけ（行動回数は使わない）
      let s = danger > 0 ? 5.5 - me.defense * 1.6 + danger * 0.5 : me.defense <= 1 && g.round >= 3 ? 1.8 : 0.2;
      out.push({ s: s + noise(), a: { type: 'reinforce' } });
    }
    return out;
  }

  function decide(g, id, rng) {
    rng = rng || Math.random;
    const me = playerById(g, id);
    if (g.abandon) return g.abandon.player === id ? { type: 'abandon', cells: E.suggestAbandon(g, id) } : null;
    const pd = g.pending;
    if (pd) {
      // 出す数を伏せて決める。相手が出せる最大数は見えている
      const target = g.board[pd.target];
      if (pd.atk === null && pd.attacker === id) {
        const foe = playerById(g, pd.defender);
        let n;
        const est = estDefense(foe) + (pd.wall || 0);
        if (me.attack >= est) n = Math.max(1, est);                  // 相手が全部出しても破れそうな最小の数（1個以上）
        else if (target.core) n = me.attack;                         // コアを狙うなら全部
        else n = rng() < 0.6 ? me.attack : 1 + Math.floor(rng() * me.attack);
        return { type: 'bid', count: n };
      }
      if (pd.def === null && pd.defender === id) {
        const foe = playerById(g, pd.attacker);
        const sure = Math.max(0, foe.attack + 1 - (pd.wall || 0));   // 相手が全部出しても守れる数（城壁の分を引く）
        const keep = target.core ? 0 : threat(g, me) > 0 ? 1 : 0;    // コアのために残しておく数
        let n;
        if (me.defense - keep >= sure) n = sure;
        else if (target.core) n = me.defense;
        else if (me.defense - keep <= 0) n = 0;
        else n = rng() < 0.5 ? 0 : 1 + Math.floor(rng() * (me.defense - keep));
        return { type: 'bid', count: Math.min(n, me.defense) };
      }
      return null;
    }
    if (E.current(g).id !== id || g.over) return null;
    // 行動回数を使い切ったら、資源を払ってでもやりたい行動があれば行動 +1 を買う
    if (g.actionsLeft <= 0) {
      // 補強は行動回数を使わないので、狙われていれば先に補強
      if (!E.actionBlocked(g, id, 'reinforce') && threat(g, me) > 0 && me.defense < 3) return { type: 'reinforce' };
      const cost = E.extraActionCost(g);
      if (me.resource < cost + 1) return { type: 'endTurn' };
      g.actionsLeft = 1; me.resource -= cost;           // 買ったつもりで考えてみる
      const top = scoreActions(g, id, rng).sort((a, b) => b.s - a.s)[0];
      g.actionsLeft = 0; me.resource += cost;
      return top && top.s >= 3 ? { type: 'buyAction' } : { type: 'endTurn' };
    }
    const best = scoreActions(g, id, rng).sort((a, b) => b.s - a.s)[0];
    return best && best.s > 0.5 ? best.a : { type: 'endTurn' };
  }

  return { decide };
});
