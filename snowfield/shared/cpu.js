/*
 * Snowfield — CPU の考え方
 * decide(state, playerId, mem) は「いまやる行動」を1つ返す（やることがなければ { type:'end' }）。
 * mem は CPU ごとの覚え書き（同じ手番で何度も行ったり来たりしないための回数）。
 *
 * 方針（このゲームで生き延びるための要点）
 *  ・手番の終わりは焚き火の上にいる（焚き火の上は体温の低下が天候補正だけ）。火力が0でも、準備期間なら体温はほとんど減らない
 *  ・雪原に入るたび体温 -1。建物・道の上は減らないので、資源や動物に向かって道を伸ばし、遠出の体温コストをなくす
 *  ・火力は「必要なときだけ」焚べる（毎手番-1されるので、焚べすぎは薪のむだ）。最終猛吹雪の前に薪を貯め、最終は火力5を保つ
 *  ・満腹度は毎手番-3。動物（肉1〜7）と野菜で食料を貯める。苗木・野菜の苗を焚き火のそばで育てて、食料と薪を増やす
 *  ・上限いっぱいで集められないときは、余ったアイテム（雪・石材など）を多数決で捨てる
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.SnowCpu = factory(root.SnowEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const FIREWOOD_MAX = 8;   // 薪をこれ以上は貯めない（持ち物の枠がもったいない）
  const FUEL_RESERVE = 2;   // 焚き火を保つために残しておく薪の数
  const SWAP_GAP = 2;       // 持ち物を入れ替えるのは、価値がこれ以上違うときだけ（往復を防ぐ）
  const USE_BOW = true;     // 弓を作る
  const STEAK_FIRST = true;  // 焚き火のそばでは、肉を先にステーキにする
  const VEG_MIN = 2, VEG_FOOD = 0, VEG_LATE = 5;   // 野菜の苗を植える：野菜2個から・食料が足りていても・準備期間の終わり5ラウンド前まで
  const MAX_MOVES = 6;      // 1手番に動く回数の上限
  const MAX_ROADS = 4;      // 1手番に道を建てる数の上限
  const SAFE_TEMP = 4;      // これ以下なら暖かい場所へ戻って温まる
  const MIN_END_TEMP = 4;   // 手番の終わりにこれ以上は残しておきたい体温
  // これを超えた分は「余り」として捨ててよい
  const SURPLUS = { snow: 3, stone: 4, sapling: 3, veg: 9, wood: 15, meat: 9, firewood: 99, fur: 12, steak: 99, soup: 99 };

  const surplus = (st, k) => st.items[k] > SURPLUS[k];
  const foodStock = st => Object.keys(E.RULES.eat).reduce((x, k) => x + st.items[k] * E.RULES.eat[k], 0);
  const last = st => st.round > E.RULES.prepRounds;
  // 薪の貯まり具合（木材ぶんに換算。作業場があれば、木材1が薪2になるので、薪は木材の半分）
  const woodEq = (st, cnt) => (cnt || st.items).wood + (cnt || st.items).firewood * (st.b.some(b => b.t === 'workshop') ? 0.5 : 1);
  const fuelOf = st => st.items.wood + st.items.firewood;

  // 必要な量の目安（人数・ラウンドで変わる）
  function targets(st) {
    const nP = st.players.length, cap = E.cap(st);
    const fin = last(st);
    return {
      food: (fin ? 6 : (st.round >= 8 ? 5 : 3)) * nP,                                    // 食料（満腹度ぶん）
      wood: Math.min(cap - 4, 2 + st.round + Math.max(0, nP - 3)), // 薪：最終猛吹雪に向けて増やす
      fire: fin ? E.RULES.fireMax : (st.round >= E.RULES.prepRounds ? 4 : 0),
    };
  }

  const gapOf = (st, x, y) => Math.min(...st.b.map(b => { const g = E.rectGap(b, x, y); return Math.max(g.dx, g.dy); }));

  // 新しい建物を置く場所（既存の建物に隣接する場所のうち、焚き火に近いもの）
  function findSpot(st, t) {
    const d = E.BUILD[t], f = E.fireOf(st);
    let best = null;
    for (let y = f.y - 7; y <= f.y + f.h + 6; y++) {
      for (let x = f.x - 7; x <= f.x + f.w + 6; x++) {
        if (E.buildWhy(st, t, x, y) || E.resAt(st, x, y)) continue;
        const far = Math.abs(x + d.size / 2 - (f.x + f.w / 2)) + Math.abs(y + d.size / 2 - (f.y + f.h / 2));
        if (!best || far < best.score) best = { x, y, score: far };
      }
    }
    return best;
  }

  // 範囲の外にある目当てへ向かって道を置く場所（道は既存の建物に隣接する場所にだけ置ける）
  function roadToward(st, goals, far) {
    const near = goals.filter(([x, y]) => gapOf(st, x, y) <= far);   // 道を数本つなげて届くものだけ
    if (!near.length) return null;
    near.sort((u, v) => gapOf(st, u[0], u[1]) - gapOf(st, v[0], v[1]));
    const [tx, ty] = near[0];
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const b of st.b) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w - 1); y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.h - 1); }
    let best = null;
    for (let y = y0 - 1; y <= y1 + 1; y++) {
      for (let x = x0 - 1; x <= x1 + 1; x++) {
        if (E.buildWhy(st, 'road', x, y) || E.resAt(st, x, y)) continue;
        const d = Math.max(Math.abs(x - tx), Math.abs(y - ty)) * 10 + Math.abs(x - tx) + Math.abs(y - ty);
        if (!best || d < best.d) best = { x, y, d };
      }
    }
    return best;
  }

  // 持ち物1個の価値（上限でいっぱいのとき、何を捨てて何を持つかを決める目安）
  function worth(st, k, cnt, T) {
    switch (k) {
      case 'wood': return woodEq(st, cnt) < 3 ? 10 : (woodEq(st, cnt) < T.wood ? 7 : 1);
      case 'firewood': return woodEq(st, cnt) < 3 ? 10 : (woodEq(st, cnt) < T.wood ? 6 : 1);
      case 'meat': return foodStock(st) < T.food ? 7 : 2;
      case 'veg': return cnt.veg < 4 ? 5 : 2;
      case 'stone': return cnt.stone < 4 && E.count(st, 'storage') < 1 ? 3 : 0.5;
      case 'sapling': return cnt.sapling < 2 ? 3 : 0.5;
      case 'fur': return cnt.fur < 4 ? 4 : 1;
      case 'steak': return 8;
      case 'soup': return 4;
      case 'snow': return cnt.snow < 2 ? 4 : (cnt.snow < 5 ? 1.5 : 0.2);
      default: return 0;
    }
  }
  // 上限を超えた分：価値の低い持ち物を捨てて、新しいものを持つ
  function overflowDrop(st, pend) {
    const T = targets(st), cnt = Object.assign({}, st.items), drop = {};
    cnt[pend.k] = (cnt[pend.k] || 0) + 0;
    for (let i = 0; i < pend.n; i++) {
      let low = null;
      for (const k of E.ITEMS) {
        if (k === pend.k || cnt[k] < 1) continue;
        const w = worth(st, k, cnt, T);
        if (!low || w < low.w) low = { k, w };
      }
      // 雪は集めるついでに付いてくるだけなので入れ替えない。ほかも、価値の差が小さいと入れ替えが往復するので、差が大きいときだけ
      if (pend.k === 'snow' || !low || low.w + SWAP_GAP > worth(st, pend.k, cnt, T)) break;
      cnt[low.k]--; cnt[pend.k]++;
      drop[low.k] = (drop[low.k] || 0) + 1;
    }
    return drop;
  }
  // 上限でも、価値の低い持ち物と入れ替えられるなら集める意味がある
  function canSwap(st, k, T) {
    if (E.room(st) >= 1) return true;
    const cnt = st.items, w = worth(st, k, cnt, T);
    return E.ITEMS.some(o => o !== k && cnt[o] > 0 && worth(st, o, cnt, T) + SWAP_GAP <= w);
  }

  function decide(st, pid, mem) {
    const p = E.pl(st, pid), it = st.items, R = E.RULES, nP = st.players.length;
    const tk = st.round + ':' + st.turn;
    if (mem.tk !== tk) { mem.tk = tk; mem.moves = 0; mem.roads = 0; mem.noTrip = false; mem.tripped = {}; mem.shedTrip = false; mem.repairTrip = false; }
    // 上限を超えたアイテムの扱いを選ぶ
    const pend = st.pending && st.pending[0];
    if (pend && pend.pid === pid) return { type: 'overflow', drop: overflowDrop(st, pend) };
    const here = E.where(st, p);
    const warmHere = E.warmAmount(st, p);
    const end = { type: 'end' };
    const T = targets(st);
    const fin = last(st);

    // 食べるもの：満腹度の空きに収まるものの中で、いちばん回復が大きいもの（ステーキ・肉・スープ）
    const miss = R.maxFood - p.food;
    const cooked = ['steak', 'meat', 'soup'].filter(k => it[k] > 0 && R.eat[k] <= miss + 1).sort((a, b) => R.eat[b] - R.eat[a])[0];

    // 復帰中の手番は「温まる」「食べる」だけ
    if (p.down === 2) {
      if (p.food <= 7 && cooked) return { type: 'eat', k: cooked };
      if (p.food <= 8 && it.veg > 0) return { type: 'eat', k: 'veg' };
      if (p.ap >= R.ap.warm && p.temp < R.maxTemp && warmHere > 0) return { type: 'warm' };
      return end;
    }

    // 食べる（手番の終わりに満腹度が3減るので、3以下で終わらないように）
    if (p.food <= 7 && cooked) return { type: 'eat', k: cooked };
    if (p.food <= 8 && it.veg > 0 && (!cooked || p.food <= 4)) return { type: 'eat', k: 'veg' };

    // 肉は、焚き火のそばでステーキにしてから食べると満腹度が5（行動力1で+2）
    if (STEAK_FIRST && it.meat >= 1 && p.ap >= 2 && E.nearFire(st, p)) return { type: 'craft', recipe: 'steak' };

    const map = E.moveMap(st, p);
    const costAt = (x, y) => { const d = map.get(E.key(x, y)); return d == null ? null : E.moveCost(d); };
    const canMove = mem.moves < MAX_MOVES;
    const go = (x, y, why) => { mem.moves++; return { type: 'move', x, y, why }; };
    const nearFire = E.nearFire(st, p);
    const wMod = R.tempMod[st.weather];

    // 暖かい場所（焚き火を優先）
    const warmSpot = () => {
      let best = null;
      for (const [k, d] of map) {
        const [x, y] = E.parseKey(k);
        const w = E.where(st, { x, y });
        if (w.kind === 'out') continue;
        // 手番を終える場所は、道や道の出入り口（道に接するマス）をなるべく避ける（ほかの人の通り道をふさがない）
        const roadNb = E.DIRS.filter(([dx, dy]) => st.b.some(b => b.t === 'road' && E.inRect(b, x + dx, y + dy))).length;
        const c = E.moveCost(d) + (w.kind === 'fire' ? 0 : 0.5) + roadNb * 0.15;
        if (!best || c < best.c) best = { x, y, c };
      }
      return best;
    };
    const lowest = Math.min(...st.players.map(q => q.temp));
    // 焚き火が消えたまま手番が続いている（3手番続くと敗北）：最優先で火を点ける
    const fireAlert = st.fire <= 0 && st.fireOut >= 1;
    const wantFire = Math.max(T.fire, lowest <= 4 ? 3 : 0, p.temp <= 5 ? 2 : 0, fireAlert ? 1 : 0);
    // 焚き火のそば（歩いて体温が減らない所を優先）
    const tileNear = pred => {
      let best = null;
      for (const [k, d] of map) {
        const [x, y] = E.parseKey(k);
        if (!pred({ x, y })) continue;
        if (!best || d < best.d) best = { x, y, d };
      }
      return best;
    };
    if (fireAlert && p.ap >= R.ap.stoke && fuelOf(st) > 0 && !nearFire && canMove) {
      const t = tileNear(q => E.nearFire(st, q));
      if (t) return go(t.x, t.y, 'fire');
    }
    // 焚き火を消さないための薪（3手番連続で消えると敗北）は、温まるために使い切らない（体温がとても低いときと、消えかけのときは使う）
    const fuelFloor = fireAlert || p.temp <= 3 ? 0 : FUEL_RESERVE;
    const stoke = () => nearFire && p.ap >= R.ap.stoke && fuelOf(st) > fuelFloor && st.fire < Math.min(R.fireMax, wantFire);

    // 火力：必要なぶんだけ焚べる
    if (stoke()) return { type: 'stoke' };
    // 猛吹雪：避難所（倉庫）にいて体温が低ければ、焚き火へ温まりに行く
    if (st.weather === 'storm' && here.kind === 'warm' && st.fire >= 2 && p.temp <= 7 && p.ap >= 3 && canMove && !mem.noTrip) {
      const t = tileNear(q => E.where(st, q).kind === 'fire' && E.moveCost(map.get(E.key(q.x, q.y))) === 0);
      if (t) return go(t.x, t.y, 'warmup');
    }
    // 焚き火の上で、温まる効果が大きいなら先に温まっておく（遠出の体温の備え）
    if (warmHere >= 2 && p.ap >= R.ap.warm + 1 && p.temp <= (st.weather === 'storm' ? 7 : R.maxTemp - Math.min(3, warmHere))) return { type: 'warm' };

    // 猛吹雪のあいだは、防寒施設のHPが毎手番1減るので、早めに直し続ける（HPが半分以下になると防寒が消える）
    if (st.weather === 'storm') {
      for (const b of st.b) {
        if (b.hp === null || b.hp > b.max - 2 || (b.t !== 'storage' && b.t !== 'igloo') || p.ap < b.w || it.stone < E.repairStone(b)) continue;
        if (E.nearB(b, p)) return { type: 'repair', id: b.id };
        if (canMove && !mem.noTrip && !mem.repairTrip) {
          const t = tileNear(q => E.nearB(b, q) && E.moveCost(map.get(E.key(q.x, q.y))) <= 1);
          if (t) { mem.repairTrip = true; return go(t.x, t.y, 'repair'); }
        }
      }
    }

    // 倉庫（共有アイテムの上限+10）
    if (!fin && E.count(st, 'storage') < 1 && it.wood >= 8 && it.stone >= 4 && p.ap >= E.BUILD.storage.ap) {
      const s = findSpot(st, 'storage');
      if (s) return { type: 'build', t: 'storage', x: s.x, y: s.y };
    }

    const hasShop = st.b.some(b => b.t === 'workshop');
    // 作業場（木材3）：薪（木材1→薪2）・防寒着・道具を作る
    if (!hasShop && !fin && st.round >= 2 && it.wood >= 6 && p.ap >= E.BUILD.workshop.ap) {
      const sp = findSpot(st, 'workshop');
      if (sp) return { type: 'build', t: 'workshop', x: sp.x, y: sp.y };
    }
    const keepWood = E.count(st, 'storage') < 1 && it.stone >= 3 && !fin ? 4 : 0;
    // 持ち物の防寒着・道具を着ける（行動力0）
    const coatInPool = st.gear.find(x => x.k === 'coat'), toolInPool = st.gear.find(x => E.GEAR[x.k].slot === 'tool');
    if (coatInPool && !p.gear) return { type: 'equip', id: coatInPool.id };
    if (toolInPool && !p.tool) return { type: 'equip', id: toolInPool.id };
    // 作業場で作るもの
    const wantCraft = () => {
      if (!hasShop || p.ap < 1) return null;
      if (!p.gear && !coatInPool && it.fur >= 3) return 'coat';
      if (!p.tool && !toolInPool && USE_BOW && it.wood >= 1 && it.stone >= 3) return 'bow';
      if (!p.tool && !toolInPool && !fin && it.fur >= 1 && it.wood >= 1 && it.stone >= 1) return 'axe';
      if (it.wood > keepWood && it.firewood < FIREWOOD_MAX && E.room(st) >= 1) return 'firewood';
      return null;
    };
    const cr = wantCraft();
    if (cr) {
      if (E.nearStation(st, p, 'workshop')) return { type: 'craft', recipe: cr };
      // 作業場のそばへ行く（暖かい場所を優先。1手番に1回だけ）
      if ((cr !== 'firewood' || it.wood >= keepWood + 2) && canMove && !mem.noTrip && !mem.shedTrip && p.ap >= 2) {
        let best = null;
        for (const [k, d] of map) {
          const [x, y] = E.parseKey(k);
          if (!E.nearStation(st, { x, y }, 'workshop')) continue;
          const c = E.moveCost(d) + (E.where(st, { x, y }).kind === 'out' ? 1 : 0);
          if (!best || c < best.c) best = { x, y, c };
        }
        if (best && best.c <= 1) { mem.shedTrip = true; return go(best.x, best.y, 'shed'); }
      }
    }

    // 目当ての価値
    // 石材：倉庫（避難所・上限+10）のため（3人では、倉庫のために石材を追うと負担のほうが大きいので、4人以上）。倉庫があれば、猛吹雪の修理のために貯める
    const toolStone = hasShop && !p.tool && !toolInPool && it.stone < (USE_BOW ? 3 : 1);   // 道具の材料
    const stoneWant = toolStone || (nP >= 4 && E.count(st, 'storage') < 1 && it.stone < 4) || (E.count(st, 'storage') >= 1 && st.round >= 6 && it.stone < 3);
    const needSnow = it.snow < 2;
    const resValue = r => {
      const item = E.RES_ITEM[r.t];
      let v = 0;
      if (item === 'wood') v = woodEq(st) < 3 ? 10 : (woodEq(st) < T.wood ? 7 : 0);
      else if (item === 'veg') v = foodStock(st) < T.food ? 5 : (it.veg < 4 ? 2 : 0);
      else if (item === 'stone') v = stoneWant ? 3 : 0;
      if (needSnow) v += 2;
      return v;
    };
    const hasBow = !!(p.tool && p.tool.k === 'bow');
    const wantMeat = foodStock(st) < T.food;
    const farmVeg = it.veg >= VEG_MIN && foodStock(st) >= T.food * VEG_FOOD && st.round <= R.prepRounds - VEG_LATE;
    const farmTree = it.sapling > 0 && st.round <= R.prepRounds + 1;

    // いまの場所でできる仕事（集める・攻撃・植える）
    const workHere = () => {
      if (p.ap < 1) return null;
      const onTile = E.resAt(st, p.x, p.y);
      if (onTile && resValue(onTile) > 0 && canSwap(st, E.RES_ITEM[onTile.t], T)) return { type: 'collect' };
      // 隣に動物がいれば、体力が少ないものから攻撃
      if (wantMeat) {
        let target = null;
        if (hasBow) {
          for (const a of st.animals) { const d = Math.max(Math.abs(a.x - p.x), Math.abs(a.y - p.y)); if (d >= 1 && d <= R.bowRange && (!target || a.hp < target.hp)) target = a; }
        } else for (const [dx, dy] of E.DIRS) { const a = E.animalAt(st, p.x + dx, p.y + dy); if (a && (!target || a.hp < target.hp)) target = a; }
        if (target && (target.hp <= p.ap + 1 || p.ap >= 4)) return { type: 'attack', x: target.x, y: target.y };
      }
      // 苗木・野菜の苗を、いる場所（雪原の空きマス）に植える
      if (!here.b && !onTile && !E.plantAt(st, p.x, p.y)) {
        if (farmTree) return { type: 'plant', kind: 'tree' };
        if (farmVeg) return { type: 'plant', kind: 'veg' };
      }
      return null;
    };

    // 体温が低い：暖かい場所へ戻って、薪を焚べて温まる。ただし、来たついでの仕事は済ませてから戻る
    // （仕事を残したまま戻ると、また同じ場所へ出かけて、行ったり来たりを繰り返してしまう）
    if (p.temp <= SAFE_TEMP) {
      if (here.kind === 'out' && canMove) {
        const w = warmSpot();
        if (w) {
          const wk = workHere();
          if (wk && p.temp - Math.max(0, w.c) >= 2) return wk;
          mem.noTrip = true;                    // 戻ったあとは、この手番ではもう出かけない
          return go(w.x, w.y, 'cold');
        }
      }
      if (stoke() && st.fire < 3) return { type: 'stoke' };
      if (p.ap >= R.ap.warm && warmHere > 0 && p.temp < R.maxTemp) return { type: 'warm' };
    }

    { const wk = workHere(); if (wk) return wk; }

    // 体温の予算：帰り道ぶんと、手番の終わりの低下ぶんを残す
    // 薪も火力もないときは、少しの無理をしてでも薪を探しに行く
    const urgent = fuelOf(st) === 0 && st.fire <= 1;
    const budget = p.temp - (urgent ? 1 : MIN_END_TEMP) - Math.max(0, wMod) - (fin ? 1 : 0);
    // 往復の体温コスト：行きは雪原に入る回数、帰りは目当ての雪原を除いた回数（道・建物の上は0）
    const tripCost = c => (c > 0 ? 2 * c - 1 : 0);

    // 苗を植えに行く（いちばん近い空きの雪原）
    if (p.ap >= 2 && canMove && !mem.noTrip && budget >= 1 && (farmTree || farmVeg)) {
      let best = null;
      for (const [k, d] of map) {
        const [x, y] = E.parseKey(k), c = E.moveCost(d);
        if (c > 1 || E.bAt(st, x, y) || E.resAt(st, x, y) || E.plantAt(st, x, y) || (x === p.x && y === p.y) || mem.tripped[x + ',' + y]) continue;
        const sc = c * 10 + gapOf(st, x, y);
        if (!best || sc < best.sc) best = { x, y, sc };
      }
      if (best) { mem.tripped[best.x + ',' + best.y] = true; return go(best.x, best.y, 'plant'); }
    }

    // 集める・狩るために出かける：価値が高く、体温コストの小さいものを選ぶ
    if (p.ap >= 1 && canMove && !mem.noTrip) {
      let best = null;
      const consider = (x, y, value) => {
        const c = costAt(x, y);
        if (c == null || (x === p.x && y === p.y) || mem.tripped[x + ',' + y] || tripCost(c) > budget) return;
        const sc = value - 2.5 * c;
        if (sc > 0 && (!best || sc > best.sc)) best = { x, y, sc };
      };
      if (wantMeat) {
        for (const a of st.animals) {
          if (a.hp > p.ap + 1) continue;
          if (hasBow) {
            for (const [k] of map) { const [x, y] = E.parseKey(k); if (Math.max(Math.abs(a.x - x), Math.abs(a.y - y)) <= R.bowRange && !E.bAt(st, x, y)) consider(x, y, 40 / a.hp + 4); }
          } else for (const [dx, dy] of E.DIRS) consider(a.x + dx, a.y + dy, 40 / a.hp + 4);
        }
      }
      {
        for (const k of Object.keys(st.res)) {
          const r = st.res[k], v = resValue(r);
          if (!canSwap(st, E.RES_ITEM[r.t], T)) continue;
          if (v <= 0) continue;
          const [x, y] = E.parseKey(k);
          consider(x, y, v * Math.min(r.hp, Math.max(1, p.ap - 1)));
        }
      }
      if (best) { mem.tripped[best.x + ',' + best.y] = true; return go(best.x, best.y, 'trip'); }
    }

    // 範囲の中に目当てがない：道を伸ばして範囲を広げる
    if (p.ap >= E.BUILD.road.ap && it.snow >= 1 && mem.roads < MAX_ROADS) {
      const goals = [];
      if (wantMeat) for (const a of st.animals) if (!E.reach(st, a.x, a.y)) goals.push([a.x, a.y]);
      for (const k of Object.keys(st.res)) {
        const [x, y] = E.parseKey(k);
        if (!E.reach(st, x, y) && resValue(st.res[k]) > 0) goals.push([x, y]);
      }
      const spot = roadToward(st, goals, it.snow >= 4 ? 9 : 5);   // 雪が余っているなら、遠くまで道を伸ばす
      if (spot) { mem.roads++; return { type: 'build', t: 'road', x: spot.x, y: spot.y }; }
    }

    // 手番の終わりじたく：暖かい場所に戻り、必要なら焚べて温まる
    if (here.kind === 'out' && canMove) {
      const w = warmSpot();
      if (w) { mem.noTrip = true; return go(w.x, w.y, 'home'); }   // 戻ったら、この手番ではもう出かけない
    }
    if (stoke()) return { type: 'stoke' };
    if (p.ap >= R.ap.warm && warmHere >= (here.kind === 'warm' ? 1 : 2) && p.temp <= R.maxTemp - Math.min(2, warmHere)) return { type: 'warm' };
    // 焚き火のそばで、余った行動力で料理（肉→ステーキ、野菜2＋雪1→スープ3）
    if (p.ap >= 1 && nearFire && E.room(st) >= 0) {
      if (it.meat >= 1) return { type: 'craft', recipe: 'steak' };
      if (it.veg >= 2 && it.snow >= 1 && !farmVeg) return { type: 'craft', recipe: 'soup' };
    }
    // 猛吹雪：温まってから、防寒が有効な建物の上へ移る（焚き火の上は−4、防寒の中は−3）。歩いて体温が減らない所だけ
    if (st.weather === 'storm' && here.kind === 'fire' && canMove && p.ap >= 0) {
      const t = tileNear(q => E.where(st, q).kind === 'warm' && E.moveCost(map.get(E.key(q.x, q.y))) === 0 && !st.b.some(b => b.t === 'road' && E.inRect(b, q.x, q.y)));
      if (t) { mem.noTrip = true; return go(t.x, t.y, 'shelter'); }
    }
    return end;
  }

  // 捨てる投票：CPU の考え方。{ type:'vote', k } か { type:'voteCast', val } か null
  function voteIntent(st, pid) {
    if (st.vote) {
      if (st.vote.v[pid]) return null;
      return { type: 'voteCast', val: surplus(st, st.vote.k) ? 1 : -1 };
    }
    if (E.room(st) > 2) return null;
    const k = Object.keys(SURPLUS).find(x => st.items[x] > SURPLUS[x]);
    return k ? { type: 'vote', k } : null;
  }

  return { decide, voteIntent, surplus, findSpot };
});
