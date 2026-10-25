/*
 * ハロウィンお菓子ゲーム — CPUの考え方
 * CPUは人間と同じく「自分に見えてよい情報」（家のお菓子の量、自分のヒント、宣言、
 * 全員のお菓子の数、自分のミッション）だけを使って決める。
 *
 * ctx:
 *   id, settings, round, houses: [{ amount }], hint: { house, state } | null,
 *   players: [{ id, candy }], leaders: [id], declares: { playerId: house },
 *   mission, missionFrom, lastGot
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config'), require('./engine'));
  else root.HalloweenCpu = factory(root.HalloweenConfig, root.HalloweenEngine);
})(typeof self !== 'undefined' ? self : this, function (C, E) {
  'use strict';

  const AI = {
    temperature: 0.6,      // 選び方のばらつき（大きいほどランダム）
    declareTrust: 0.6,     // 他人の宣言をどれくらい信じるか
    othersTemp: 0.8,       // 他人の選び方のばらつきの見込み
    othersIters: 30,       // 他人の動きを読む繰り返し回数
    truthfulDeclare: 0.6,  // 宣言で本当の行き先を言う確率
    talkChance: 0.5,       // 作戦タイムにヒントの話をする確率
    lieChance: 0.3,        // ヒントの話で嘘をつく確率
  };

  function stateProbs(settings, i, hint) {
    if (hint && hint.house === i) {
      return { normal: 0, rich: 0, away: 0, witch: 0, [hint.state]: 1 };
    }
    const rich = settings.probRich / 100;
    const away = settings.probAway / 100;
    const witch = settings.probWitch / 100;
    return { normal: Math.max(0, 1 - rich - away - witch), rich, away, witch };
  }

  // 家ごとの見込み値
  function evaluate(ctx) {
    const s = ctx.settings;
    const n = ctx.players.length;
    const me = ctx.players.find(p => p.id === ctx.id);
    const amILeader = ctx.leaders.indexOf(ctx.id) >= 0;
    const mission = ctx.settings.missions ? C.missionById(ctx.mission) : null;

    // 他人がどの家に来そうか：ヒントを知らない人の見込み値と宣言から
    const declCount = ctx.houses.map(() => 0);
    const leaderDecl = ctx.houses.map(() => 0);
    for (const pid of Object.keys(ctx.declares || {})) {
      if (pid === ctx.id) continue;
      const h = ctx.declares[pid];
      if (h === null || h === undefined || !ctx.houses[h]) continue;
      declCount[h]++;
      if (ctx.leaders.indexOf(pid) >= 0) leaderDecl[h]++;
    }
    const baseEv = ctx.houses.map((h, i) => {
      const pr = stateProbs(s, i, null);
      return pr.normal * h.amount + pr.rich * (h.amount + s.richBonus) - pr.witch * s.witchPenalty;
    });
    // 「みんなが被りを避けて散らばる」とした読み：家の値×ひとりになれる確率がそろうまで繰り返す
    const others = Math.max(0, n - 1);
    let q = ctx.houses.map(() => 1 / ctx.houses.length);
    for (let it = 0; it < AI.othersIters; it++) {
      const ev = baseEv.map((v, i) => v * Math.pow(1 - q[i], Math.max(0, others - 1)));
      const max = Math.max.apply(null, ev);
      const w = ev.map(v => Math.exp((v - max) / AI.othersTemp));
      const sw = w.reduce((a, b) => a + b, 0);
      q = q.map((x, i) => 0.7 * x + 0.3 * w[i] / sw);
    }
    // 宣言された家は（嘘もあるので割り引いて）人が来やすいとみる
    const attract = q.map((x, i) => x * (1 + AI.declareTrust * declCount[i]));
    const sumA = attract.reduce((a, b) => a + b, 0) || 1;

    return ctx.houses.map((h, i) => {
      const pr = stateProbs(s, i, ctx.hint);
      const qi = attract[i] / sumA;
      const pAlone = Math.pow(1 - qi, others);
      const pGot = pr.normal + pr.rich;
      let solo = pr.normal * h.amount + pr.rich * (h.amount + s.richBonus) - pr.witch * s.witchPenalty;
      let crowd = -pr.witch * s.witchPenalty;

      // 奪取：先頭が宣言した家で衝突すれば奪える／先頭なら奪われる
      const leaderShare = Math.min(1, leaderDecl[i] * AI.declareTrust);
      if (!amILeader && leaderShare > 0) crowd += leaderShare * s.stealMax / 2;
      if (amILeader && me) crowd -= Math.min(me.candy, s.stealMax / 2 * others * qi);

      // ミッション
      let bonus = 0;
      if (mission) {
        if (mission.id === 'guest') bonus = pr.rich * mission.bonus;
        else if (mission.id === 'keeper') bonus = pr.away * mission.bonus;
        else if (mission.amount !== undefined && mission.amount === h.amount) solo += pGot * mission.bonus;
        else if (mission.id === 'regular' && ctx.lastGot && ctx.lastGot.house === i &&
          ctx.lastGot.round === ctx.round - 1 && (ctx.missionFrom || 1) <= ctx.round - 1) solo += pGot * mission.bonus;
        // 常連さん狙い：今もらえれば次のラウンドにつながる
        if (mission.id === 'regular') solo += pGot * 0.8;
      }
      return pAlone * solo + (1 - pAlone) * crowd + bonus;
    });
  }

  function pickByValue(values, rng, temperature) {
    const max = Math.max.apply(null, values);
    const w = values.map(v => Math.exp((v - max) / temperature));
    let r = rng() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < w.length; i++) {
      r -= w[i];
      if (r <= 0) return i;
    }
    return w.length - 1;
  }

  function chooseHouse(ctx, rng) {
    return pickByValue(evaluate(ctx), rng, AI.temperature);
  }

  // 作戦タイムの宣言：本当の行き先か、ほかの人を遠ざけたい家（いちばん多い家）
  function chooseDeclare(ctx, rng) {
    const intent = chooseHouse(ctx, rng);
    if (rng() < AI.truthfulDeclare) return intent;
    let best = 0;
    ctx.houses.forEach((h, i) => { if (h.amount > ctx.houses[best].amount) best = i; });
    return best === intent ? E.randInt(rng, ctx.houses.length) : best;
  }

  // 作戦タイムのひとこと（ヒントの話。嘘をつくこともある）。言わないときは null
  function chooseTalk(ctx, rng) {
    if (!ctx.hint || rng() >= AI.talkChance) return null;
    const no = ctx.hint.house + 1;
    const st = C.STATES;
    if (rng() < AI.lieChance) {
      // 嘘：いちばん多い家を魔女だと言って遠ざける
      let best = 0;
      ctx.houses.forEach((h, i) => { if (h.amount > ctx.houses[best].amount) best = i; });
      return `${best + 1}番の家、${st.witch.emoji}魔女だったよ…近づかないほうがいい`;
    }
    switch (ctx.hint.state) {
      case 'witch': return `${no}番は${st.witch.emoji}魔女！行っちゃだめ！`;
      case 'away': return `${no}番は${st.away.emoji}留守みたい`;
      case 'rich': return pickLine(rng, [`${no}番、なんでもないよ`, `${no}番は${st.normal.emoji}普通だった`]);
      default: return `${no}番は${st.normal.emoji}普通だったよ`;
    }
  }

  function pickLine(rng, lines) {
    return lines[E.randInt(rng, lines.length)];
  }

  return { AI, evaluate, chooseHouse, chooseDeclare, chooseTalk };
});
