/*
 * ハロウィンお菓子ゲーム — ルールの判定（状態を持たない純粋な関数だけ）
 * 乱数は rng（0以上1未満を返す関数）として外から渡す。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./config'));
  else root.HalloweenEngine = factory(root.HalloweenConfig);
})(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  function randInt(rng, n) {
    return Math.min(n - 1, Math.floor(rng() * n));
  }

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(rng, i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // 袋から非復元抽出。袋が空になったらもう一組足して続けて引く
  function drawAmounts(n, bag, rng) {
    const out = [];
    let pool = [];
    while (out.length < n) {
      if (!pool.length) pool = bag.slice();
      out.push(pool.splice(randInt(rng, pool.length), 1)[0]);
    }
    return out;
  }

  function drawState(settings, rng) {
    const r = rng() * 100;
    if (r < settings.probRich) return 'rich';
    if (r < settings.probRich + settings.probAway) return 'away';
    if (r < settings.probRich + settings.probAway + settings.probWitch) return 'witch';
    return 'normal';
  }

  function makeHouses(settings, rng) {
    return drawAmounts(settings.houses, settings.candyBag, rng)
      .map(amount => ({ amount, state: drawState(settings, rng) }));
  }

  // ヒントの配り方：全ての家をランダムな順で1人1軒ずつ割り当て、余った人にはランダムな家。
  // プレイヤー数 < 家の数なら重複なし。戻り値は { playerId: 家の番号(0始まり) }
  function dealHints(playerIds, nHouses, rng) {
    const ids = shuffle(playerIds.slice(), rng);
    const houses = shuffle(Array.from({ length: nHouses }, (_, i) => i), rng);
    const hints = {};
    ids.forEach((id, i) => { hints[id] = i < houses.length ? houses[i] : randInt(rng, nHouses); });
    return hints;
  }

  // 先頭：お菓子が最多の人（同点なら全員）。全員0なら先頭なし
  function leadersOf(players) {
    let max = 0;
    for (const p of players) max = Math.max(max, p.candy);
    if (max <= 0) return [];
    return players.filter(p => p.candy === max).map(p => p.id);
  }

  // 1人だけで訪問したときの家からの増減
  function soloDelta(house, settings) {
    switch (house.state) {
      case 'normal': return house.amount;
      case 'rich': return house.amount + settings.richBonus;
      case 'away': return 0;
      case 'witch': return -settings.witchPenalty;
    }
    return 0;
  }

  function randomMission(rng) {
    return C.MISSIONS[randInt(rng, C.MISSIONS.length)].id;
  }

  /*
   * ミッション判定。ctx:
   *   state, amount  … 訪問した家
   *   gotCandy       … お菓子をもらったか（1人だけで訪問し、普通かお金持ち）
   *   house, round   … 訪問した家の番号・今のラウンド
   *   lastGot        … 前回お菓子をもらった家 { house, round } または null
   *   missionFrom    … このミッションを持って最初に迎えたラウンド
   */
  function checkMission(missionId, ctx) {
    const m = C.missionById(missionId);
    if (!m) return false;
    switch (m.id) {
      case 'guest': return ctx.state === 'rich';
      case 'keeper': return ctx.state === 'away';
      case 'regular':
        return ctx.gotCandy && !!ctx.lastGot &&
          ctx.lastGot.house === ctx.house && ctx.lastGot.round === ctx.round - 1 &&
          ctx.missionFrom <= ctx.round - 1;
    }
    if (m.amount !== undefined) return ctx.gotCandy && ctx.amount === m.amount;
    return false;
  }

  /*
   * 1ラウンドの結果を計算する（仕様書「結果の計算順」どおり）。
   * input:
   *   settings, houses: [{ amount, state }], round, rng
   *   players: [{ id, candy, choice, mission, missionFrom, lastGot }]
   * 戻り値:
   *   leaders, visitors: [[id...] 家ごと], collided: [bool], revealed: [state|null],
   *   thefts: [{ thief, leader, house, amount }],
   *   perPlayer: { id: { choice, collided, houseDelta, steal, mission, missionBonus,
   *                      newMission, gotCandy, clampFix, total, newCandy, lastGot } }
   */
  function resolveRound(input) {
    const { settings, houses, players, round, rng } = input;
    const byId = {};
    for (const p of players) byId[p.id] = p;

    // 1. ラウンド開始時のお菓子で先頭を確定
    const leaders = leadersOf(players);
    const isLeader = id => leaders.indexOf(id) >= 0;

    // 2. 家ごとに訪問人数を数え、家からの増減を決める
    const visitors = houses.map(() => []);
    for (const p of players) visitors[p.choice].push(p.id);
    const collided = visitors.map(v => v.length >= 2);
    const revealed = houses.map((h, i) => (visitors[i].length ? h.state : null));

    const per = {};
    for (const p of players) {
      const house = houses[p.choice];
      const alone = visitors[p.choice].length === 1;
      let houseDelta;
      if (alone) houseDelta = soloDelta(house, settings);
      else houseDelta = house.state === 'witch' ? -settings.witchPenalty : 0;
      per[p.id] = {
        choice: p.choice, collided: !alone, houseDelta, steal: 0,
        gotCandy: alone && (house.state === 'normal' || house.state === 'rich'),
        mission: null, missionBonus: 0, newMission: null,
      };
    }

    // 3. 奪取：衝突した家に先頭がいれば、先頭以外の各自が先頭ごとに 0〜最大数 を抽選して奪う。
    //    先頭の残り（開始時＋手順2の増減、0未満は0）を超えては奪えない
    const thefts = [];
    const remaining = {};
    for (const id of leaders) remaining[id] = Math.max(0, byId[id].candy + per[id].houseDelta);
    if (settings.stealMax > 0) {
      visitors.forEach((ids, h) => {
        if (ids.length < 2) return;
        const here = ids.filter(isLeader);
        if (!here.length) return;
        const thieves = shuffle(ids.filter(id => !isLeader(id)), rng);
        for (const thief of thieves) {
          for (const leader of here) {
            const want = randInt(rng, settings.stealMax + 1);
            const take = Math.min(want, remaining[leader]);
            remaining[leader] -= take;
            per[thief].steal += take;
            per[leader].steal -= take;
            thefts.push({ thief, leader, house: h, amount: take });
          }
        }
      });
    }

    // 4. ミッション判定：達成者にボーナスを加算し、新しいミッションを配る
    for (const p of players) {
      if (!settings.missions || !p.mission) continue;
      const r = per[p.id];
      const house = houses[p.choice];
      const ok = checkMission(p.mission, {
        state: house.state, amount: house.amount, gotCandy: r.gotCandy,
        house: p.choice, round, lastGot: p.lastGot || null, missionFrom: p.missionFrom || 1,
      });
      if (ok) {
        r.mission = p.mission;
        r.missionBonus = C.missionById(p.mission).bonus;
        r.newMission = randomMission(rng);
      }
    }

    // 5. 合計し、0未満なら0にする。 7. お菓子をもらった家の番号を記録
    for (const p of players) {
      const r = per[p.id];
      const sum = p.candy + r.houseDelta + r.steal + r.missionBonus;
      r.newCandy = Math.max(0, sum);
      r.clampFix = r.newCandy - sum;
      r.total = r.newCandy - p.candy;
      r.lastGot = r.gotCandy ? { house: p.choice, round } : null;
    }

    return { leaders, visitors, collided, revealed, thefts, perPlayer: per };
  }

  // 順位（同点は同順位）。list: [{ id, candy }] → { id: 順位 }
  function rankOf(list) {
    const sorted = list.slice().sort((a, b) => b.candy - a.candy);
    const ranks = {};
    sorted.forEach((p, i) => {
      ranks[p.id] = i > 0 && sorted[i - 1].candy === p.candy ? ranks[sorted[i - 1].id] : i + 1;
    });
    return ranks;
  }

  return {
    randInt, shuffle, drawAmounts, drawState, makeHouses, dealHints, leadersOf,
    soloDelta, randomMission, checkMission, resolveRound, rankOf,
  };
});
