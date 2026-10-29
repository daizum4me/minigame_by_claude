/*
 * ヘキサゴニア（仮）— CPU の考え方
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

  function scoreActions(g, id, rng) {
    const me = playerById(g, id);
    const foes = g.players.filter(p => p.alive && p.id !== id);
    const foeCores = foes.map(p => E.parseKey(p.core));
    const late = g.round >= R.rounds - 2;               // 終盤は一番大きなかたまりを重視
    const myGroup = new Set(E.largestGroup(g, id));
    // 一番大きなかたまりが最大の相手（12ラウンド終了の勝敗に効く）
    const leaderGroups = new Set(foes.map(p => E.largestGroup(g, p.id)).sort((a, b) => b.length - a.length)[0] || []);
    const touchesMine = c => E.neighbors(c.q, c.r).some(([q, r]) => myGroup.has(E.key(q, r)));
    const danger = threat(g, me);
    const net = E.income(g, id) - E.upkeep(g, id);      // 毎手番の資源の増え方（維持費を引いたあと）
    const out = [];
    const noise = () => (rng() - 0.5) * 0.6;

    if (!E.actionBlocked(g, id, 'expand')) {
      for (const k of E.targets(g, id, 'expand')) {
        const c = g.board[k];
        const near = Math.min(...foeCores.map(f => E.dist([c.q, c.r], f)));
        const own = E.neighbors(c.q, c.r).filter(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner === id; }).length;
        let s = 2 + own * 0.25 + Math.max(0, 8 - near) * 0.12;
        if (c.terrain === 'mine') s += 2.2;           // 鉱山は取っただけで毎手番 +1
        if (c.terrain === 'mountain') s += me.defense < 2 ? 0.8 : -0.3;
        if (c.terrain === 'river') {
          // 橋は高い（資源4）。向こう側に新しく取れる土地があるときだけ
          const beyond = E.neighbors(c.q, c.r).filter(([q, r]) => {
            const n = cellAt(g, q, r);
            return n && !n.owner && n.terrain !== 'river' && !E.neighbors(q, r).some(([a, b]) => { const m = cellAt(g, a, b); return m && m.owner === id; });
          }).length;
          s += beyond ? beyond * 0.5 - 1.5 : -3;
        }
        // 維持費で資源が増えなくなってきたら、広げるのを控える（平原は維持費が半分）
        if (net <= 1) s -= c.terrain === 'plain' ? 0.4 : 0.8;
        // 一番大きなかたまりにつながる拡張を重視（終盤は特に）
        if (touchesMine(c)) s += late ? 2.8 : 0.6;
        else if (late) s += 0.3;
        out.push({ s: s + noise(), a: { type: 'expand', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'strengthen')) {
      for (const k of E.targets(g, id, 'strengthen')) {
        const c = g.board[k];
        if (c.strong) {
          // 防御済にする：狙われそうなコアと前線のセルだけ（収入は増えない）
          const exposed = E.neighbors(c.q, c.r).some(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner && n.owner !== id; });
          let s = c.core ? (danger > 0 ? 6 : 1.5) : exposed ? 2 : -1;
          if (c.terrain === 'river' && exposed) s += 1;     // 橋は落とされると分断される
          out.push({ s: s + noise(), a: { type: 'strengthen', q: c.q, r: c.r } });
          continue;
        }
        // 強化すると毎手番の資源 +1 と攻撃トークン +1。終盤は元が取れない
        let s = late ? 1 : 3.2;
        if (c.core) s += 2.5;
        if (c.terrain === 'mine') s += 1.2;
        if (c.terrain === 'mountain') s += 0.8;
        if (me.attack === 0 && frontier(g, id) > 0) s += 1.5;
        out.push({ s: s + noise(), a: { type: 'strengthen', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'destroy')) {
      for (const k of E.targets(g, id, 'destroy')) {
        const c = g.board[k];
        const foe = playerById(g, c.owner);
        // 相手が防御トークンを全部出しても破りきれるか（破りきれないときは出す数の読み合いになる）
        const canBreak = me.attack >= foe.defense;
        let s;
        // コアは最優先（防御済なら2回要るので、1回目もそれなりに価値がある）
        if (c.core) s = c.fort ? (canBreak ? 9 : me.attack > 0 ? 2 : 0.5) : (canBreak ? 30 : me.attack > 0 ? 3 : 1);
        else if (foe.defense === 0) s = 5;
        else s = canBreak ? 3.2 : me.attack > 0 ? 0.8 : -1;
        if (c.fort && !c.core) s -= 1.5;                    // 防御済は1回目では取れない
        else s += 0.8;   // 破壊に成功すると、そのマスが自分のセルになる
        if (c.strong) s += 1;
        if (late) s += 1.5;
        if (late && leaderGroups.has(k)) s += 2;          // 首位のかたまりを削る
        if (touchesMine(c)) s += 0.5;                       // 取ったマスが自分のかたまりにつながる
        // 自分のコアの隣にいる相手セルは優先して壊す
        if (E.dist([c.q, c.r], E.parseKey(me.core)) <= 1) s += 3;
        out.push({ s: s + noise(), a: { type: 'destroy', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'reinforce')) {
      // 補強は防御トークン +1 と攻撃トークン +1
      let s = danger > 0 ? 5.5 - me.defense * 1.6 + danger * 0.5 : me.attack === 0 && frontier(g, id) > 0 ? 2.6 : me.defense === 0 && g.round >= 3 ? 1.8 : 0.2;
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
        if (me.attack >= foe.defense) n = foe.defense;               // 相手が全部出しても破れる最小の数
        else if (target.core) n = me.attack;                         // コアを狙うなら全部
        else n = rng() < 0.6 ? me.attack : Math.floor(rng() * (me.attack + 1));
        return { type: 'bid', count: n };
      }
      if (pd.def === null && pd.defender === id) {
        const foe = playerById(g, pd.attacker);
        const sure = foe.attack + 1;                                 // 相手が全部出しても守れる数
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
