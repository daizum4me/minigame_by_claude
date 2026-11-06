/*
 * Snowfield — CPU の考え方
 * decide(state, playerId, mem) は「いまやる行動」を1つ返す（やることがなければ { type:'end' }）。
 * mem は CPU ごとの覚え書き（同じ手番で何度も行ったり来たりしないための回数）。
 * 方針：食べる → 体温が低ければ暖かい場所へ → 防寒施設を建てる → 資源を集める・動物を狩る → 焚き火へ戻って温まる
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.SnowCpu = factory(root.SnowEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const MAX_MOVES = 4;      // 1手番に動く回数の上限
  const SAFE_TEMP = 4;      // これ以下なら暖かい場所へ戻る
  const MOVE_MARGIN = 3;    // 移動した後に残しておきたい体温
  // これを超えた分は「余り」として捨ててよい
  const SURPLUS = { snow: 6, sapling: 2, stone: 9, veg: 9, wood: 11, meat: 10 };
  const WANT = { wood: 10, stone: 8, veg: 8 };
  const MAX_ROADS = 2;      // 1手番に道を建てる数の上限

  const FOOD_STOCK = 4;       // 1人あたりこれだけ（満腹度ぶん）の食料を持っていたい
  const surplus = (st, k) => st.items[k] > SURPLUS[k];
  const foodStock = st => st.items.meat * E.RULES.eat.meat + st.items.veg * E.RULES.eat.veg;

  function findSpot(st, t) {
    const d = E.BUILD[t], f = E.fireOf(st);
    let best = null;
    for (let y = f.y - 6; y <= f.y + f.h + 5; y++) {
      for (let x = f.x - 6; x <= f.x + f.w + 5; x++) {
        if (E.buildWhy(st, t, x, y)) continue;
        let gap = Infinity;
        for (const b of st.b) {
          const gx = Math.max(x - (b.x + b.w), b.x - (x + d.size), 0), gy = Math.max(y - (b.y + b.h), b.y - (y + d.size), 0);
          gap = Math.min(gap, gx + gy);
        }
        const far = Math.abs(x + d.size / 2 - (f.x + 1.5)) + Math.abs(y + d.size / 2 - (f.y + 1.5));
        const score = gap * 10 + far;
        if (!best || score < best.score) best = { x, y, score };
      }
    }
    return best;
  }

  // 範囲の外にある資源・動物のうち、建物にいちばん近いものへ向かって道を置く場所
  function roadToward(st, p, needFood) {
    const it = st.items, gapOf = (x, y) => Math.min(...st.b.map(b => { const g = E.rectGap(b, x, y); return Math.max(g.dx, g.dy); }));
    const targets = [];
    for (const k of Object.keys(st.res)) {
      const [x, y] = E.parseKey(k), item = E.RES_ITEM[st.res[k].t];
      if (it[item] < WANT[item] && !E.reach(st, x, y) && (!needFood || item === 'veg')) targets.push([x, y]);
    }
    if (it.meat < 5 || needFood) for (const a of st.animals) if (!E.reach(st, a.x, a.y)) targets.push([a.x, a.y]);
    const near = targets.filter(([x, y]) => gapOf(x, y) <= 6);   // 道1本で届くものだけ
    if (!near.length) return null;
    targets.length = 0; targets.push(...near);
    targets.sort((u, v) => gapOf(u[0], u[1]) - gapOf(v[0], v[1]));
    const [tx, ty] = targets[0];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const b of st.b) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w - 1); y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.h - 1); }
    let best = null;
    for (let y = y0 - 5; y <= y1 + 5; y++) {
      for (let x = x0 - 5; x <= x1 + 5; x++) {
        if (E.reach(st, x, y) || E.buildWhy(st, 'road', x, y)) continue;
        const g = gapOf(x, y);
        if (g > 5) continue;
        const d = Math.max(Math.abs(x - tx), Math.abs(y - ty)) * 10 + (5 - g);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    return best;
  }

  function decide(st, pid, mem) {
    const p = E.pl(st, pid), it = st.items, R = E.RULES;
    const tk = st.round + ':' + st.turn;
    if (mem.tk !== tk) { mem.tk = tk; mem.moves = 0; mem.roads = 0; }
    const here = E.where(st, p);
    const warmHere = E.warmAmount(st, p);
    const end = { type: 'end' };

    // 復帰中の手番は「温まる」「食べる」だけ
    if (p.down === 2) {
      if (p.food <= 7 && it.meat > 0) return { type: 'eat', k: 'meat' };
      if (p.food <= 8 && it.veg > 0) return { type: 'eat', k: 'veg' };
      if (p.ap >= R.ap.warm && p.temp < R.maxTemp && warmHere > 0) return { type: 'warm' };
      return end;
    }

    if (p.food <= 7 && it.meat > 0) return { type: 'eat', k: 'meat' };
    if (p.food <= 8 && it.veg > 0) return { type: 'eat', k: 'veg' };

    const needFood = foodStock(st) < FOOD_STOCK * st.players.length;
    const map = E.moveMap(st, p);
    const costAt = (x, y) => { const d = map.get(E.key(x, y)); return d == null ? null : E.moveCost(d); };
    const canMove = mem.moves < MAX_MOVES;
    const go = (x, y) => { mem.moves++; return { type: 'move', x, y }; };
    // いちばん近い暖かい場所（焚き火を優先）
    const warmSpot = () => {
      let best = null;
      for (const [k, d] of map) {
        const [x, y] = E.parseKey(k);
        const w = E.where(st, { x, y });
        if (w.kind === 'out') continue;
        const c = E.moveCost(d) + (w.kind === 'fire' ? 0 : 0.5);
        if (!best || c < best.c) best = { x, y, c };
      }
      return best;
    };

    if (E.nearFire(st, p) && p.ap >= R.ap.stoke && it.wood > 0 && st.fire < (it.wood >= 4 ? R.fireMax : 3)) return { type: 'stoke' };

    // 体温が低い：暖かい場所へ戻って温まる
    if (p.temp <= SAFE_TEMP) {
      if (here.kind === 'out' && canMove) { const w = warmSpot(); if (w) return go(w.x, w.y); }
      if (p.ap >= R.ap.warm && warmHere > 0 && p.temp < R.maxTemp) return { type: 'warm' };
    }

    // 防寒施設・倉庫・見張り台を建てる
    const tryBuild = t => {
      const d = E.BUILD[t];
      if (p.ap < d.ap || E.lacking(st, d.cost)) return null;
      const s = findSpot(st, t);
      return s ? { type: 'build', t, x: s.x, y: s.y } : null;
    };
    let a;
    if (!needFood && it.snow >= 6 && !st.b.some(b => E.insul(b)) && (a = tryBuild('igloo'))) return a;
    if (E.count(st, 'storage') < 1 && it.wood >= 8 && (a = tryBuild('storage'))) return a;
    if (!E.hasTower(st) && it.wood >= 10 && (a = tryBuild('tower'))) return a;

    // 壊れかけの防寒施設を直す
    if (it.stone > 0) {
      for (const b of st.b) {
        if (b.hp === null || b.hp >= b.max || b.hp * 2 > b.max + 2) continue;
        if (E.nearB(b, p) && p.ap >= b.w) return { type: 'repair', id: b.id };
        if (canMove && p.ap >= b.w && p.temp >= MOVE_MARGIN + 2) {
          let best = null;
          for (const [k, d] of map) {
            const [x, y] = E.parseKey(k);
            if (!E.nearB(b, { x, y })) continue;
            const c = E.moveCost(d);
            if (!best || c < best.c) best = { x, y, c };
          }
          if (best && p.temp - best.c >= MOVE_MARGIN) return go(best.x, best.y);
        }
      }
    }

    // 集める・狩る・植える
    if (p.ap >= 1) {
      const onTile = E.resAt(st, p.x, p.y);
      if (onTile && E.room(st) >= 1 && it[E.RES_ITEM[onTile.t]] < WANT[E.RES_ITEM[onTile.t]]) return { type: 'collect' };
      if (it.meat < 5) {
        for (const [dx, dy] of E.DIRS) if (E.animalAt(st, p.x + dx, p.y + dy)) return { type: 'attack', x: p.x + dx, y: p.y + dy };
      }
      if (it.veg >= 4 && here.kind === 'out' && !here.b && !onTile && !E.plantAt(st, p.x, p.y)) return { type: 'plant', kind: 'veg' };
      if (it.sapling > 0 && here.kind === 'out' && !here.b && !onTile && !E.plantAt(st, p.x, p.y)) return { type: 'plant', kind: 'tree' };
    }
    if (p.ap >= 1 && canMove && p.temp - MOVE_MARGIN > 0) {
      let best = null;
      const consider = (x, y, bonus) => {
        const c = costAt(x, y);
        if (c == null || p.temp - 2 * c < MOVE_MARGIN) return;   // 帰り道の分も残す
        const s = c - bonus;
        if (!best || s < best.s) best = { x, y, s };
      };
      if (it.meat < 5 || needFood) {
        for (const an of st.animals) for (const [dx, dy] of E.DIRS) consider(an.x + dx, an.y + dy, 8);
      }
      if (E.room(st) >= 1) {
        for (const k of Object.keys(st.res)) {
          const r = st.res[k], item = E.RES_ITEM[r.t];
          if (it[item] >= WANT[item]) continue;
          const [x, y] = E.parseKey(k);
          consider(x, y, item === 'veg' && needFood ? 6 : item === 'wood' && it.wood < 4 ? 3 : 0);
        }
      }
      if (best && (best.x !== p.x || best.y !== p.y)) return go(best.x, best.y);
    }

    // 移動できる範囲に目当てがない：道を伸ばして範囲を広げる（道から2マス以内に移動できる）
    if (p.ap >= E.BUILD.road.ap && it.snow >= 1 && mem.roads < MAX_ROADS) {
      const spot = roadToward(st, p, needFood);
      if (spot) { mem.roads++; return { type: 'build', t: 'road', x: spot.x, y: spot.y }; }
    }

    // 手番の終わりじたく：余った行動力で温まり、暖かい場所に戻る
    if (here.kind === 'out' && canMove) {
      const w = warmSpot();
      if (w && p.temp - w.c > 0) return go(w.x, w.y);
    }
    if (E.nearFire(st, p) && p.ap >= R.ap.stoke && it.wood > 0 && st.fire < R.fireMax) return { type: 'stoke' };
    if (p.ap >= R.ap.warm && warmHere > 0 && p.temp <= R.maxTemp - 2) return { type: 'warm' };
    return end;
  }

  // 捨てる投票：CPU の考え方。{ type:'vote', k } か { type:'voteCast', val } か null
  function voteIntent(st, pid) {
    if (st.vote) {
      if (st.vote.v[pid]) return null;
      return { type: 'voteCast', val: surplus(st, st.vote.k) ? 1 : -1 };
    }
    if (E.room(st) > 0) return null;
    const k = Object.keys(SURPLUS).find(x => st.items[x] > SURPLUS[x]);
    return k ? { type: 'vote', k } : null;
  }

  return { decide, voteIntent, surplus, findSpot };
});
