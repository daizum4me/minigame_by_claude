/*
 * ヘキサゴニア — CPU の考え方
 * 人間と同じ公開情報（盤面・全員のトークン数）だけで、次の1手を決める。
 * 手番では「できる行動に点数を付けて一番高いもの」を選び、よい行動がなければ手番終了。
 *
 * decide(state, id, rng, level) → action（engine.apply に渡せる形）
 * level：'weak'（よわい）・'normal'（ふつう）・'strong'（つよい）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.HexCpu = factory(root.HexEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const R = E.RULES;

  // 強さ。noise：点数のゆらぎ（大きいほど気まぐれ）、endBelow：これより点数が低い行動しかなければ手番終了、
  // buyAt：行動 +1 を買うのに必要な点数、bidRandom：攻防で出す数をでたらめに決める、
  // bias：行動の種類ごとの点数の上乗せ（CPU どうしの対戦で、強化を多め・拡張を控えめにするのが一番勝てた）
  const LEVELS = {
    weak: { noise: 4, endBelow: 1.5, buyAt: Infinity, bidRandom: true, bias: {} },
    normal: { noise: 0.6, endBelow: 0.5, buyAt: 3, bidRandom: false, bias: {} },
    strong: { noise: 0.15, endBelow: 0.5, buyAt: 3, bidRandom: false, bias: { strengthen: 1.5, expand: -0.5 } },
    // チュートリアルの相手：破壊をせず、相手から離れる向きにゆっくり広げる（passive）
    tutorial: { noise: 2, endBelow: 1.5, buyAt: Infinity, bidRandom: true, bias: {}, passive: true },
  };
  const LEVEL_NAMES = { weak: 'よわい', normal: 'ふつう', strong: 'つよい' };   // ロビーで選べる強さ（tutorial はチュートリアル専用）
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

  // 相手の戦力トークンの数の見積もり（実際の数は見ない）。
  // 見えている増え方（最初の2個・強化・鉱山）から攻防で少なくとも出したはずの数を引き、見えない生産の分を1個ぶん足しておく
  const estPower = foe => Math.max(0, foe.powerSeen == null ? foe.power : foe.powerSeen) + 1;

  function scoreActions(g, id, rng, lv) {
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
    const noise = () => (rng() - 0.5) * lv.noise;

    if (!E.actionBlocked(g, id, 'expand')) {
      for (const k of E.targets(g, id, 'expand')) {
        const c = g.board[k];
        const near = Math.min(...foeCores.map(f => E.dist([c.q, c.r], f)));
        const own = E.neighbors(c.q, c.r).filter(([q, r]) => { const n = cellAt(g, q, r); return n && n.owner === id; }).length;
        // 相手のコアに近づくほど高い（コアを破壊すれば、相手のセルとトークンをまるごと奪える）
        let s = 2 + own * 0.25 + Math.max(0, 8 - near) * (lv.passive ? -0.4 : 0.35);   // passive は相手から離れる向きに
        if (c.terrain === 'mine') s += me.power <= 1 ? 2.5 : 1.2;    // 鉱山は取ると戦力トークン +1
        if (c.terrain === 'farm') s += foodLeft < 3 ? 2.5 : 1.2;     // 農地は毎手番の食料 +1（食べる分を自分でまかなえる）
        if (c.terrain === 'forest') s += late ? 0.2 : 1.1;           // 森林は毎手番の資源 +1（終盤は元が取れない）
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
        // 強化すると毎手番の資源 +1 と戦力トークン +1。終盤は元が取れない
        let s = late ? 1 : 3.2;
        if (foodLeft < 3) s += late ? 4 : 2;               // 強化すると食料 +1
        if (c.core) s += 2.5;
        if (c.terrain === 'mine') s += 1.2;
        if (me.power === 0 && frontier(g, id) > 0) s += 1.5;
        // 強化済のセルは破壊の拠点。前線に置くほど役に立つ
        const foesNext = foeNeighbors(g, id, c);
        if (foesNext > 0) {
          const newTargets = E.neighbors(c.q, c.r).filter(([q, r]) => {
            const n = cellAt(g, q, r);
            return n && n.owner && n.owner !== id && !E.adjacentToStrong(g, id, q, r);
          }).length;
          s += Math.min(3, newTargets) * 0.9;            // 新しく破壊できるようになる相手のセル
          // 相手のコアを狙える拠点になるなら大きい
          if (E.neighbors(c.q, c.r).some(([q, r]) => { const n = cellAt(g, q, r); return n && n.core && n.owner && n.owner !== id; })) s += 4;
        }
        out.push({ s: s + noise() + (lv.bias.strengthen || 0), a: { type: 'strengthen', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'cultivate')) {
      // 開墾：食料が足りなくなりそうなら、前線から遠い（奪われにくい）平原のセルを農地にする
      const ks = E.targets(g, id, 'cultivate');
      if (ks.length) {
        const k = ks.map(k => ({ k, f: foeNeighbors(g, id, g.board[k]) })).sort((a, b) => a.f - b.f)[0].k;
        let s = foodLeft < 0 ? 5 : foodLeft < 2 ? 3.5 : foodLeft < 4 ? 1.8 : 0.4;
        if (late) s -= 1.5;                                  // 終盤は元が取れない
        const [q, r] = E.parseKey(k);
        out.push({ s: s + noise(), a: { type: 'cultivate', q, r } });
      }
    }
    if (!lv.passive && !E.actionBlocked(g, id, 'destroy')) {
      for (const k of E.targets(g, id, 'destroy')) {
        const c = g.board[k];
        const foe = playerById(g, c.owner);
        // 相手が戦力トークンを全部出しても破りきれそうか（見積もり。破りきれないときは読み合いになる）
        const est = estPower(foe);
        // リアルタイムモードは攻防がなく、狙えればかならず壊せる
        const canBreak = g.mode === 'realtime' || me.power >= est;   // 同じ数なら攻撃側の勝ち
        let s;
        if (c.core) s = canBreak ? 30 : 6;                  // コアは最優先（破りきれなくても、読み合いで狙う）
        else if (est <= 1) s = 5;
        else s = canBreak ? 3.2 : -1.5;   // 守る側はためた数を全部使えるので、破りきれないなら控える
        s += 0.8;   // 破壊に成功すると、そのマスが自分のセルになる
        if (c.strong) s += 1 + (E.dist([c.q, c.r], E.parseKey(me.core)) <= 3 ? 1.5 : 0);   // 近くの相手の拠点は崩したい
        if (late) s += 1.5;
        if (late && leaderGroups.has(k)) s += 2;          // 首位のかたまりを削る
        if (touchesMine(c)) s += 0.5;                       // 取ったマスが自分のかたまりにつながる
        // 自分のコアの隣にいる相手セルは優先して壊す
        if (E.dist([c.q, c.r], E.parseKey(me.core)) <= 1) s += 3;
        out.push({ s: s + noise() + (lv.bias.destroy || 0), a: { type: 'destroy', q: c.q, r: c.r } });
      }
    }
    if (!E.actionBlocked(g, id, 'produce')) {
      // 生産（戦力トークン）：攻めるにも守るにも使う
      const front = frontier(g, id) > 0;
      let s = me.power === 0 && front ? 3.5 : me.power < 2 && front ? 1.2 : 0.1;
      // 自分のコアの近くに相手がいれば、守るためにためる
      if (danger > 0) s = Math.max(s, 5.5 - me.power * 1.3 + danger * 0.5);
      else if (me.power <= 1 && g.round >= 3) s = Math.max(s, 1.8);
      // 相手のコアの隣に拠点があるなら、コアを破りきれる数までためる
      const coreFoe = foes.find(f => { const [q, r] = E.parseKey(f.core); return E.adjacentToStrong(g, id, q, r); });
      if (coreFoe && me.power < estPower(coreFoe)) s = Math.max(s, 4);
      out.push({ s: s + noise(), a: { type: 'produce' } });
    }
    return out;
  }

  function decide(g, id, rng, level) {
    rng = rng || Math.random;
    const lv = LEVELS[level] || LEVELS.normal;
    const me = playerById(g, id);
    if (g.abandon) return g.abandon.player === id ? { type: 'abandon', cells: E.suggestAbandon(g, id) } : null;
    const pd = g.pending;
    if (pd) {
      // 出す数を伏せて決める。相手が出せる最大数は見えている
      const target = g.board[pd.target];
      if (pd.atk === null && pd.attacker === id) {
        if (lv.bidRandom) return { type: 'bid', count: 1 + Math.floor(rng() * me.power) };
        const foe = playerById(g, pd.defender);
        let n;
        const need = Math.max(1, estPower(foe));                    // 同じ数なら攻撃側の勝ち
        if (me.power >= need) n = need;                              // 相手が全部出しても破れそうな最小の数
        else if (target.core) n = me.power;                          // コアを狙うなら全部
        else n = rng() < 0.6 ? me.power : 1 + Math.floor(rng() * me.power);
        return { type: 'bid', count: n };
      }
      if (pd.def === null && pd.defender === id) {
        if (lv.bidRandom) return { type: 'bid', count: Math.floor(rng() * (me.power + 1)) };
        const foe = playerById(g, pd.attacker);
        // 相手が全部出しても守れそうな数（相手の数は見えないので見積もり。同じ数では負けるので1個多く）
        const sure = estPower(foe) + 1;
        const keep = target.core ? 0 : threat(g, me) > 0 ? 1 : 0;    // コアのために残しておく数
        let n;
        if (me.power - keep >= sure) n = sure;
        else if (target.core) n = me.power;
        else if (me.power - keep <= 0) n = 0;
        else n = rng() < 0.5 ? 0 : 1 + Math.floor(rng() * (me.power - keep));
        return { type: 'bid', count: Math.min(n, me.power) };
      }
      return null;
    }
    if (E.current(g).id !== id || g.over) return null;
    // 行動回数を使い切ったら、資源を払ってでもやりたい行動があれば行動 +1 を買う
    if (g.actionsLeft <= 0) {
      // 生産は行動回数を使わないので、狙われていれば先に生産
      if (!E.actionBlocked(g, id, 'produce') && threat(g, me) > 0 && me.power < 3) return { type: 'produce' };
      const cost = E.extraActionCost(g);
      if (me.resource < cost + 1) return { type: 'endTurn' };
      g.actionsLeft = 1; me.resource -= cost;           // 買ったつもりで考えてみる
      const top = scoreActions(g, id, rng, lv).sort((a, b) => b.s - a.s)[0];
      g.actionsLeft = 0; me.resource += cost;
      return top && top.s >= lv.buyAt ? { type: 'buyAction' } : { type: 'endTurn' };
    }
    const best = scoreActions(g, id, rng, lv).sort((a, b) => b.s - a.s)[0];
    return best && best.s > lv.endBelow ? best.a : { type: 'endTurn' };
  }

  // リアルタイムモード：行動力があれば、一番よい行動を1つ選ぶ（よい行動がなければ何もしない＝待つ）
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
    // 防御：相手のセルに面した辺を固める。コアは特に厚く。相手が近づいてきた（2マス以内）辺には、攻められる前に先に置く
    if (!lv.passive && (me.ap || 0) >= 1) {
      for (const c of E.cellsOf(g, id)) {
        const ck = E.key(c.q, c.r);
        const want = c.core ? 3 : c.strong ? 2 : 1;                 // 欲しい体力
        if (me.power < (c.core ? 1 : 2)) continue;                  // コア以外は、攻める分を1個残す
        for (const [q, r] of E.neighbors(c.q, c.r)) {
          const n = cellAt(g, q, r);
          if (!n || n.terrain === 'river' && !n.owner) continue;
          const hostile = !!n.owner && n.owner !== id;
          const near = !n.owner && foeDist(q, r) <= 2;              // 空きマスだが、相手がすぐ隣に広げてくる
          if (!hostile && !near) continue;
          const w = g.walls[E.wallKey(ck, E.key(q, r))];
          const hp = w ? w.hp : 0;
          if (hp >= want) continue;
          const base = c.core ? 8 : c.strong ? 4.5 : 2.8;
          const count = Math.max(1, Math.min(want - hp, me.power - (c.core ? 0 : 1)));
          out.push({ s: base * (hostile ? 1 : 0.8) - hp * 1.5 + noise(), a: { type: 'wall', from: ck, to: E.key(q, r), count } });
        }
      }
    }
    // 防御を壊す：防御で攻められない相手のセルのうち、壊す価値のあるもの（コア＞強化済のセル＞ふつうのセル）
    if (!lv.passive && (me.ap || 0) >= 2) {
      for (const f of g.players) {
        if (!f.alive || f.id === id) continue;
        for (const x of E.cellsOf(g, f.id)) {
          const xk = E.key(x.q, x.r);
          for (const [q, r] of E.neighbors(x.q, x.r)) {
            const y = cellAt(g, q, r);
            if (!y || y.owner !== id) continue;
            const w = g.walls[E.wallKey(xk, E.key(q, r))];          // 相手のセルの、こちらに面した辺
            if (!w || w.owner === id || me.power < w.hp + 1) continue;   // 壊したあと破壊する1個も残す
            const value = x.core ? 9 : x.strong ? 4.5 : 2.5;
            out.push({ s: value - w.hp * 0.6 + noise(), a: { type: 'breakWall', from: xk, to: E.key(q, r), count: w.hp } });
          }
        }
      }
    }
    const best = out.sort((a, b) => b.s - a.s)[0];
    return best && best.s > lv.endBelow ? best.a : null;
  }

  return { decide, decideRealtime, LEVELS, LEVEL_NAMES };
});
