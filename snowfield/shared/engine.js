/*
 * Snowfield — ルールエンジン（UIにも通信にも依存しない）
 * 状態は JSON にできる素のオブジェクト。act(state, playerId, action) で状態を直接更新し、
 * { ok:true, msg } か { ok:false, why } を返す。数値は先頭の RULES にまとめてある。
 * 座標は整数のマス (x, y)。マップは無限に広がる（建物から8マス以内が生成済み）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnowEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RULES = {
    minPlayers: 3, maxPlayers: 5,
    prepRounds: 10, finalRounds: 3,
    maxTemp: 10, maxFood: 10, maxAp: 7,
    hunger: 3,                         // 手番終了時の満腹度の減少
    fireInit: 3, fireMax: 5,
    weights: { clear: 3, snow: 2, blizzard: 1, rain: 2 },
    stormFrom: 4, stormChance: 0.1,    // ランダム猛吹雪：ラウンド4以降に10%
    tempMod: { clear: 0, snow: 1, blizzard: 2, rain: 0, storm: 4 },
    base: { fire: 0, warm: 1, out: 2 }, // 手番終了時の体温低下の基本値
    relief: 2,                          // 防寒施設の中で天候補正を軽減する量
    moveRange: 1,                       // 建物（道を含む）からこのマス以内に移動できる
    recoverTo: 3,                       // 行動不能からの回復量
    growMin: 1, growMax: 3,
    resHpMin: 3, resHpMax: 7, resChance: 0.15, genRadius: 8,
    sapChance: 0.5,
    animals: 3, animalHpMin: 3, animalHpMax: 5, meatMin: 1, meatMax: 7,
    eat: { meat: 3, veg: 2 },
    ap: { warm: 2, stoke: 1, collect: 1, attack: 1, plant: 1 },
    capBase: 10, capPerPlayer: 2, capPerStorage: 10,
    repairHp: 2,
    startItems: {},                     // 最初の共有アイテム（仕様では空）
    // 開始時、焚き火から移動できる範囲に最低これだけの資源を置く（範囲内に資源が無いと雪も手に入らず詰むため）
    startReach: { tree: 2, stone: 1, veg: 1 },
  };
  const TOTAL_ROUNDS = RULES.prepRounds + RULES.finalRounds;

  const BUILD = {
    road: { name: '道', size: 1, ap: 1, cost: { snow: 1 } },
    igloo: { name: 'かまくら', size: 2, ap: 2, cost: { snow: 5 } },
    storage: { name: '倉庫', size: 4, ap: 4, cost: { wood: 4, stone: 4 } },
    tower: { name: '見張り台', size: 2, ap: 2, cost: { wood: 5, stone: 3 } },
  };
  const ITEMS = ['wood', 'stone', 'veg', 'meat', 'snow', 'sapling'];
  const ITEM_NAMES = { wood: '木材', stone: '石材', veg: '野菜', meat: '肉', snow: '雪', sapling: '苗木' };
  const WEATHER_NAMES = { clear: '晴れ', snow: '雪', blizzard: '吹雪', rain: '雨', storm: '猛吹雪' };
  const RES_ITEM = { tree: 'wood', stone: 'stone', veg: 'veg' };
  const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

  const key = (x, y) => x + ',' + y;
  const parseKey = k => k.split(',').map(Number);

  // ---------- 乱数（状態に入れて持ち回る） ----------
  function rnd(st) {
    st.rs = (st.rs + 0x6D2B79F5) | 0;
    let t = st.rs;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  const ri = (st, a, b) => a + Math.floor(rnd(st) * (b - a + 1));
  // マスごとに決まる乱数（マップ生成用。順番によらず同じ結果になる）
  function hash(seed, x, y, salt) {
    let h = (seed ^ Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1)) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  // ---------- 参照 ----------
  const cur = st => st.players[st.turn];
  const pl = (st, id) => st.players.find(p => p.id === id) || null;
  const isTurn = (st, id) => st.phase === 'play' && cur(st).id === id;
  const inRect = (b, x, y) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
  const bAt = (st, x, y) => st.b.find(b => inRect(b, x, y)) || null;
  const resAt = (st, x, y) => st.res[key(x, y)] || null;
  const animalAt = (st, x, y) => st.animals.find(a => a.x === x && a.y === y) || null;
  const plantAt = (st, x, y) => st.plants.find(a => a.x === x && a.y === y) || null;
  const playerAt = (st, x, y, skipId) => st.players.find(p => p.id !== skipId && p.x === x && p.y === y) || null;
  const rectGap = (b, x, y) => ({ dx: Math.max(b.x - x, 0, x - (b.x + b.w - 1)), dy: Math.max(b.y - y, 0, y - (b.y + b.h - 1)) });
  const inGen = (st, x, y) => st.gen.some(r => x >= r[0] && x <= r[1] && y >= r[2] && y <= r[3]);
  const reach = (st, x, y) => st.b.some(b => { const g = rectGap(b, x, y); return g.dx <= RULES.moveRange && g.dy <= RULES.moveRange; });
  const insul = b => !!b && (b.t === 'igloo' || b.t === 'storage') && b.hp * 2 > b.max;
  const fireOf = st => st.b.find(b => b.t === 'fire');
  const nearFire = (st, p) => { const g = rectGap(fireOf(st), p.x, p.y); return g.dx <= 1 && g.dy <= 1; };
  const nearB = (b, p) => { const g = rectGap(b, p.x, p.y); return g.dx + g.dy <= 1; };
  const count = (st, t) => st.b.filter(b => b.t === t).length;
  const cap = st => RULES.capPerPlayer * st.players.length + RULES.capBase + RULES.capPerStorage * count(st, 'storage');
  const total = st => ITEMS.reduce((s, k) => s + st.items[k], 0);
  const room = st => Math.max(0, cap(st) - total(st));
  const hasTower = st => st.b.some(b => b.t === 'tower');
  const phaseOf = round => (round > RULES.prepRounds ? 'final' : 'prep');

  function log(st, text) {
    st.log.push({ n: st.ln = (st.ln || 0) + 1, r: st.round, t: text });
    if (st.log.length > 80) st.log.shift();
  }
  // アイテムを得る。上限で入らない分は、本人が「既存の物を捨てて入れる／あきらめる」を選ぶまで保留にする
  function gain(st, pid, k, n) {
    const got = addItem(st, k, n);
    if (got < n) st.pending.push({ pid, k, n: n - got });
    return got;
  }
  function addItem(st, k, n) {
    const a = Math.max(0, Math.min(n, room(st)));
    st.items[k] += a;
    return a;
  }

  // 体温低下の内訳（UI・CPUでも使う）
  function where(st, p) {
    const b = bAt(st, p.x, p.y);
    if (b && b.t === 'fire') return { kind: 'fire', b };
    if (insul(b)) return { kind: 'warm', b };
    return { kind: 'out', b };
  }
  function tempLoss(st, p, weather) {
    const w = RULES.tempMod[weather || st.weather];
    const k = where(st, p).kind;
    if (k === 'fire') return RULES.base.fire + w;
    if (k === 'warm') return RULES.base.warm + Math.max(0, w - RULES.relief);
    return RULES.base.out + w;
  }
  function warmAmount(st, p) {
    const k = where(st, p).kind;
    return k === 'fire' ? st.fire : k === 'warm' ? 1 : 0;
  }

  // ---------- 天候 ----------
  function rollWeather(st, round) {
    if (round > RULES.prepRounds) return 'storm';
    if (round >= RULES.stormFrom && rnd(st) < RULES.stormChance) return 'storm';
    const w = RULES.weights;
    let r = rnd(st) * Object.keys(w).reduce((s, k) => s + w[k], 0);
    for (const k of Object.keys(w)) { r -= w[k]; if (r < 0) return k; }
    return 'clear';
  }

  // ---------- マップ ----------
  // 建物の周囲 genRadius マスを生成済みにする（新しく生成されたマスだけ資源が置かれる）
  function expandGen(st, b) {
    const R = RULES.genRadius;
    const r = [b.x - R, b.x + b.w - 1 + R, b.y - R, b.y + b.h - 1 + R];
    for (let y = r[2]; y <= r[3]; y++) {
      for (let x = r[0]; x <= r[1]; x++) {
        if (inGen(st, x, y) || bAt(st, x, y)) continue;
        if (hash(st.seed, x, y, 1) >= RULES.resChance) continue;
        const t = ['tree', 'stone', 'veg'][Math.floor(hash(st.seed, x, y, 2) * 3)];
        const hp = RULES.resHpMin + Math.floor(hash(st.seed, x, y, 3) * (RULES.resHpMax - RULES.resHpMin + 1));
        st.res[key(x, y)] = { t, hp, max: hp };
      }
    }
    st.gen.push(r);
  }
  function genCells(st) {
    const out = new Set();
    for (const r of st.gen) for (let y = r[2]; y <= r[3]; y++) for (let x = r[0]; x <= r[1]; x++) out.add(key(x, y));
    return [...out].map(parseKey);
  }
  // 生物・資源・苗・建物のない生成済みの雪原
  function freeSnow(st) {
    return genCells(st).filter(([x, y]) => !bAt(st, x, y) && !resAt(st, x, y) && !plantAt(st, x, y) && !animalAt(st, x, y) && !playerAt(st, x, y));
  }
  function spawnAnimal(st) {
    const f = freeSnow(st);
    if (!f.length) return;
    const [x, y] = f[Math.floor(rnd(st) * f.length)];
    const hp = ri(st, RULES.animalHpMin, RULES.animalHpMax);
    st.animals.push({ id: st.nid++, x, y, hp, max: hp });
  }
  function addBuilding(st, t, x, y) {
    const d = t === 'fire' ? { size: 3 } : BUILD[t];
    const hp = (t === 'fire' || t === 'road') ? null : d.size * 2;
    const b = { id: st.nid++, t, x, y, w: d.size, h: d.size, hp, max: hp };
    st.b.push(b);
    return b;
  }

  function guaranteeStart(st) {
    for (const t of Object.keys(RULES.startReach)) {
      const have = () => Object.keys(st.res).filter(k => st.res[k].t === t && reach(st, ...parseKey(k))).length;
      while (have() < RULES.startReach[t]) {
        const free = genCells(st).filter(([x, y]) => reach(st, x, y) && !bAt(st, x, y) && !resAt(st, x, y));
        const [x, y] = free[Math.floor(rnd(st) * free.length)];
        const hp = ri(st, RULES.resHpMin, RULES.resHpMax);
        st.res[key(x, y)] = { t, hp, max: hp };
      }
    }
  }

  function createGame(opts) {
    const seed = (opts.seed == null ? Math.floor(Math.random() * 4294967296) : opts.seed) | 0;
    const st = {
      v: 0, seed, rs: seed ^ 0x5bd1e995, round: 1, turn: 0, phase: 'play', over: null,
      weather: 'clear', next: 'clear', fire: RULES.fireInit,
      items: Object.assign({ wood: 0, stone: 0, veg: 0, meat: 0, snow: 0, sapling: 0 }, RULES.startItems),
      b: [], nid: 1, gen: [], res: {}, plants: [], animals: [], draw: {}, vote: null, pending: [], log: [],
      players: [],
    };
    const f = addBuilding(st, 'fire', -1, -1);
    expandGen(st, f);
    guaranteeStart(st);
    const spots = [[-1, 1], [1, 1], [0, 1], [-1, 0], [1, 0]];   // 焚き火の下側から（上側は焚き火のカードの文字がある）
    opts.players.forEach((p, i) => st.players.push({
      id: p.id, name: p.name, color: p.color, shape: p.shape || 'circle', cpu: !!p.cpu, no: i + 1, away: false,
      x: spots[i][0], y: spots[i][1], temp: RULES.maxTemp, food: RULES.maxFood, ap: 0, down: 0,
    }));
    for (let i = 0; i < RULES.animals; i++) spawnAnimal(st);
    st.weather = rollWeather(st, 1);
    st.next = rollWeather(st, 2);
    log(st, `ゲーム開始。最初の天候は${WEATHER_NAMES[st.weather]}`);
    startTurn(st);
    return st;
  }

  // ---------- 手番・ラウンド ----------
  function startRound(st, r) {
    st.round = r;
    st.weather = st.next;
    st.next = r + 1 <= TOTAL_ROUNDS ? rollWeather(st, r + 1) : null;
    const keep = [];
    for (const p of st.plants) {
      if (--p.left > 0) { keep.push(p); continue; }
      if (!resAt(st, p.x, p.y)) {
        const hp = ri(st, RULES.resHpMin, RULES.resHpMax);
        st.res[key(p.x, p.y)] = { t: p.t === 'veg' ? 'veg' : 'tree', hp, max: hp };
        log(st, `苗が育って${p.t === 'veg' ? '野菜' : '樹木'}になった`);
      }
    }
    st.plants = keep;
    log(st, `ラウンド${r}（${phaseOf(r) === 'final' ? '最終猛吹雪' : '準備期間'}）：天候は${WEATHER_NAMES[st.weather]}`);
  }
  function startTurn(st) {
    const p = cur(st);
    p.ap = RULES.maxAp;
    if (p.down === 1) { p.down = 2; log(st, `${p.name}：行動不能から復帰中（温まる・食べるだけ可能）`); }
    if (st.weather === 'storm') {
      const gone = [];
      for (const b of st.b) if (b.hp !== null) { b.hp--; if (b.hp <= 0) gone.push(b); }
      if (gone.length) {
        st.b = st.b.filter(b => !gone.includes(b));
        for (const b of gone) log(st, `猛吹雪で${BUILD[b.t].name}が壊れた`);
      }
    }
  }
  function moveToFire(st, p) {
    const f = fireOf(st);
    const tiles = [];
    for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) tiles.push([x, y]);
    const score = ([x, y]) => (playerAt(st, x, y, p.id) ? 100 : 0) + (animalAt(st, x, y) ? 10 : 0) + Math.abs(x - p.x) + Math.abs(y - p.y);
    tiles.sort((a, b) => score(a) - score(b));
    p.x = tiles[0][0]; p.y = tiles[0][1];
  }
  function moveAnimals(st) {
    for (const a of st.animals) {
      const order = DIRS.map(d => [rnd(st), d]).sort((u, v) => u[0] - v[0]);
      const d = order[0][1];
      const x = a.x + d[0], y = a.y + d[1];
      if (inGen(st, x, y) && !animalAt(st, x, y) && !playerAt(st, x, y)) { a.x = x; a.y = y; }
    }
  }
  function endTurn(st) {
    const p = cur(st);
    if (p.down === 2) p.down = 0;
    p.food = Math.max(0, p.food - RULES.hunger);
    st.fire = Math.max(0, st.fire - 1 - (st.weather === 'rain' ? 1 : 0));
    p.temp = Math.max(0, p.temp - tempLoss(st, p));
    if (p.temp <= 0 || p.food <= 0) {
      const what = [p.temp <= 0 ? '体温' : '', p.food <= 0 ? '満腹度' : ''].filter(Boolean).join('と');
      if (p.temp <= 0) p.temp = RULES.recoverTo;
      if (p.food <= 0) p.food = RULES.recoverTo;
      p.down = 1;
      moveToFire(st, p);
      log(st, `${p.name}：${what}が0になり行動不能。焚き火へ運ばれた`);
    }
    moveAnimals(st);
    if (st.players.every(q => q.down > 0)) {
      st.phase = 'lost'; st.over = { result: 'lost', round: st.round };
      log(st, '全員が行動不能になった…ゲームオーバー');
      return;
    }
    st.turn++;
    if (st.turn >= st.players.length) {
      st.turn = 0;
      if (st.round >= TOTAL_ROUNDS) {
        st.phase = 'won'; st.over = { result: 'won', round: st.round };
        log(st, '最終猛吹雪を生き延びた！ クリア');
        return;
      }
      startRound(st, st.round + 1);
    }
    startTurn(st);
  }

  // ---------- 移動 ----------
  function moveWhy(st, p, x, y) {
    if (p.down > 0) return '行動不能中は移動できません';
    if (x === p.x && y === p.y) return 'いまいるマスです';
    if (!reach(st, x, y)) return `建物から${RULES.moveRange}マス以内の雪原にだけ移動できます`;
    if (animalAt(st, x, y)) return '動物のいるマスには入れません';
    if (playerAt(st, x, y, p.id)) return '他のプレイヤーと重なれません';
    return null;
  }
  // 現在地から行ける全マスの経路コスト（雪原に入るたび100、建物・道は1）。体温コスト＝floor(値/100)
  function moveMap(st, p) {
    const dist = new Map();
    if (p.down > 0) return dist;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const b of st.b) { x0 = Math.min(x0, b.x); x1 = Math.max(x1, b.x + b.w - 1); y0 = Math.min(y0, b.y); y1 = Math.max(y1, b.y + b.h - 1); }
    const M = RULES.moveRange;
    x0 -= M; x1 += M; y0 -= M; y1 += M;
    const heap = [[0, p.x, p.y]];
    dist.set(key(p.x, p.y), 0);
    const push = it => { heap.push(it); let i = heap.length - 1; while (i > 0) { const q = (i - 1) >> 1; if (heap[q][0] <= heap[i][0]) break; [heap[q], heap[i]] = [heap[i], heap[q]]; i = q; } };
    const pop = () => {
      const top = heap[0], last = heap.pop();
      if (heap.length) { heap[0] = last; let i = 0; for (;;) { let m = i; const l = 2 * i + 1, r = l + 1; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
      return top;
    };
    const done = new Set();
    while (heap.length) {
      const [d, ux, uy] = pop();
      const uk = key(ux, uy);
      if (done.has(uk)) continue;
      done.add(uk);
      for (const [dx, dy] of DIRS) {
        const x = ux + dx, y = uy + dy;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        if (!reach(st, x, y) || animalAt(st, x, y) || playerAt(st, x, y, p.id)) continue;
        const nd = d + (bAt(st, x, y) ? 0 : 100) + 1, k = key(x, y);
        if (nd < (dist.has(k) ? dist.get(k) : Infinity)) { dist.set(k, nd); push([nd, x, y]); }
      }
    }
    return dist;
  }
  const moveCost = d => Math.floor(d / 100);

  // ---------- 建設 ----------
  function buildWhy(st, t, x, y) {
    const d = BUILD[t];
    if (!d) return 'その建物は建てられません';
    for (let j = 0; j < d.size; j++) {
      for (let i = 0; i < d.size; i++) {
        const tx = x + i, ty = y + j, b = bAt(st, tx, ty);
        if (!inGen(st, tx, ty)) return '生成されていない場所には建てられません';
        if (resAt(st, tx, ty)) return '資源のあるマスには建てられません';
        if (plantAt(st, tx, ty)) return '苗のあるマスには建てられません';
        if (b && (t === 'road' || b.t !== 'road')) return '他の建物と重なります';
      }
    }
    // 既存の建物（道を含む）に隣接していること（道の上に重ねて建てるのも隣接とみなす）
    const inside = (cx, cy) => cx >= x && cx < x + d.size && cy >= y && cy < y + d.size;
    for (let j = 0; j < d.size; j++) {
      for (let i = 0; i < d.size; i++) {
        if (bAt(st, x + i, y + j)) return null;
        for (const [dx, dy] of DIRS) {
          const nx = x + i + dx, ny = y + j + dy;
          if (!inside(nx, ny) && bAt(st, nx, ny)) return null;
        }
      }
    }
    return '既存の建物（道を含む）に隣接する場所にだけ建てられます';
  }
  function lacking(st, cost) {
    return Object.keys(cost).find(k => st.items[k] < cost[k]) || null;
  }

  // ---------- お絵かき ----------
  const DRAW_MAX_POLY = 80, DRAW_MAX_PTS = 800;
  const q100 = v => Math.max(0, Math.min(100, Math.round(v * 100)));
  function drawStroke(st, c, pts) {
    if (!Array.isArray(pts) || pts.length < 2 || pts.length > 600 || pts.length % 2) return 0;
    if (!pts.every(n => typeof n === 'number' && isFinite(n) && Math.abs(n) < 1e6)) return 0;
    let curCell = null, curPoly = null, made = 0;
    const flush = (k, pl_) => {
      const arr = st.draw[k] || (st.draw[k] = []);
      arr.push({ c, p: pl_ });
      while (arr.length > DRAW_MAX_POLY) arr.shift();
      made++;
    };
    const piece = (ax, ay, bx, by) => {
      const mx = Math.floor((ax + bx) / 2), my = Math.floor((ay + by) / 2);
      const k = key(mx, my);
      if (!inGen(st, mx, my) || bAt(st, mx, my)) { curCell = null; curPoly = null; return; }
      const a = [q100(ax - mx), q100(ay - my)], b = [q100(bx - mx), q100(by - my)];
      if (curCell === k && curPoly && curPoly[curPoly.length - 2] === a[0] && curPoly[curPoly.length - 1] === a[1]) {
        curPoly.push(b[0], b[1]);
      } else {
        curPoly = [a[0], a[1], b[0], b[1]];
        curCell = k;
        flush(k, curPoly);
      }
    };
    for (let i = 0; i + 3 < pts.length || (pts.length === 2 && i === 0); i += 2) {
      let x0 = pts[i], y0 = pts[i + 1], x1 = pts.length === 2 ? x0 + 0.002 : pts[i + 2], y1 = pts.length === 2 ? y0 : pts[i + 3];
      const ts = [0, 1];
      const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
      if (x1 !== x0) for (let n = Math.floor(lo) + 1; n <= hi; n++) ts.push((n - x0) / (x1 - x0));
      const lo2 = Math.min(y0, y1), hi2 = Math.max(y0, y1);
      if (y1 !== y0) for (let n = Math.floor(lo2) + 1; n <= hi2; n++) ts.push((n - y0) / (y1 - y0));
      ts.sort((u, v) => u - v);
      for (let j = 0; j + 1 < ts.length; j++) {
        if (ts[j + 1] - ts[j] < 1e-9) continue;
        piece(x0 + (x1 - x0) * ts[j], y0 + (y1 - y0) * ts[j], x0 + (x1 - x0) * ts[j + 1], y0 + (y1 - y0) * ts[j + 1]);
      }
    }
    for (const k of Object.keys(st.draw)) {
      let n = 0;
      for (const s of st.draw[k]) n += s.p.length / 2;
      while (n > DRAW_MAX_PTS && st.draw[k].length) n -= st.draw[k].shift().p.length / 2;
    }
    return made;
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }
  function erasePoint(st, x, y, r) {
    for (let cy = Math.floor(y - r); cy <= Math.floor(y + r); cy++) {
      for (let cx = Math.floor(x - r); cx <= Math.floor(x + r); cx++) {
        const k = key(cx, cy), arr = st.draw[k];
        if (!arr) continue;
        const out = [];
        for (const s of arr) {
          let run = null;
          const p = s.p;
          for (let i = 0; i + 3 < p.length; i += 2) {
            const hit = segDist(x - cx, y - cy, p[i] / 100, p[i + 1] / 100, p[i + 2] / 100, p[i + 3] / 100) < r;
            if (hit) { run = null; continue; }
            if (run) run.push(p[i + 2], p[i + 3]);
            else { run = [p[i], p[i + 1], p[i + 2], p[i + 3]]; out.push({ c: s.c, p: run }); }
          }
        }
        if (out.length) st.draw[k] = out; else delete st.draw[k];
      }
    }
  }

  // ---------- 捨てる投票 ----------
  function resolveVote(st) {
    const v = st.vote;
    if (!v) return;
    const n = st.players.length;
    let yes = 0, no = 0;
    for (const p of st.players) {
      const x = v.v[p.id] || 0;
      if (x > 0) yes++;
      else if (x < 0 || p.away) no++;      // 切断中の人は反対として扱う
    }
    if (yes * 2 > n) {
      if (st.items[v.k] > 0) st.items[v.k]--;
      st.vote = null;
      log(st, `投票で可決：${ITEM_NAMES[v.k]}を1個捨てた`);
    } else if (no * 2 >= n) {
      st.vote = null;
      log(st, `投票で否決：${ITEM_NAMES[v.k]}は捨てない`);
    }
  }

  // ---------- 行動 ----------
  const fail = why => ({ ok: false, why });
  const SFX = { move: 'step', warm: 'warm', stoke: 'stoke', eat: 'eat', plant: 'plant', build: 'build', repair: 'repair', end: 'end', vote: 'tick', voteCast: 'tick', voteCancel: 'tick' };
  const RECOVER_OK = ['warm', 'eat', 'end'];

  function act(st, pid, a) {
    if (!a || typeof a.type !== 'string') return fail('不正な操作です');
    const p = pl(st, pid);
    if (!p) return fail('プレイヤーが見つかりません');
    if (st.phase !== 'play') return fail('ゲームは終わっています');
    const mine = cur(st).id === pid;
    const t = a.type;
    let r;

    // 上限を超えたアイテムの扱いを選ぶまでは、ほかの行動はできない
    const pend = st.pending && st.pending[0];
    if (pend && pend.pid === pid && !['overflow', 'vote', 'voteCast', 'voteCancel'].includes(t)) {
      return fail(`先に、上限を超えた「${ITEM_NAMES[pend.k]}」をどうするか選んでください`);
    }

    if (t === 'overflow') {
      if (!pend || pend.pid !== pid) return fail('選ぶ必要のあるアイテムはありません');
      const drop = a.drop && typeof a.drop === 'object' ? a.drop : {};
      let total = 0;
      for (const k of Object.keys(drop)) {
        const n = drop[k];
        if (!ITEMS.includes(k) || k === pend.k || !Number.isInteger(n) || n < 0 || n > st.items[k]) return fail('不正な操作です');
        total += n;
      }
      if (total > pend.n) return fail('入らない数より多くは入れ替えられません');
      for (const k of Object.keys(drop)) st.items[k] -= drop[k];
      st.items[pend.k] += total;
      st.pending.shift();
      const lost = pend.n - total;
      const parts = Object.keys(drop).filter(k => drop[k] > 0).map(k => `${ITEM_NAMES[k]}${drop[k]}個`);
      r = { ok: true, sfx: 'tick', msg: total ? `${parts.join('・')}を捨てて、${ITEM_NAMES[pend.k]}${total}個を持った${lost ? `（${ITEM_NAMES[pend.k]}${lost}個は捨てた）` : ''}` : `${ITEM_NAMES[pend.k]}${pend.n}個を捨てた` };
      log(st, `${p.name}：${r.msg}`);
    } else if (t === 'move') r = doMove(st, p, a);
    else if (t === 'draw' || t === 'erase') {
      if (mine) return fail('お絵かきは自分の手番以外で使えます');
      if (t === 'draw') {
        if (a.c !== 'a' && a.c !== 'b') return fail('不正な色です');
        r = drawStroke(st, a.c, a.pts) ? { ok: true, msg: '' } : fail('そこには描けません');
      } else {
        if (![a.x, a.y, a.r].every(n => typeof n === 'number' && isFinite(n)) || a.r <= 0 || a.r > 2) return fail('不正な操作です');
        erasePoint(st, a.x, a.y, a.r);
        r = { ok: true, msg: '' };
      }
    } else if (t === 'vote') {
      if (st.vote) return fail('別の投票が進行中です');
      if (!ITEMS.includes(a.k) || st.items[a.k] < 1) return fail('捨てるアイテムがありません');
      st.vote = { k: a.k, by: pid, v: { [pid]: 1 } };
      resolveVote(st);
      r = { ok: true, msg: st.vote ? `「${ITEM_NAMES[a.k]}」を捨てる投票を始めました` : '' };
    } else if (t === 'voteCast') {
      if (!st.vote) return fail('投票は行われていません');
      if (a.val !== 1 && a.val !== -1) return fail('不正な操作です');
      if (st.vote.v[pid]) return fail('もう投票しました');
      st.vote.v[pid] = a.val;
      resolveVote(st);
      r = { ok: true, msg: '' };
    } else if (t === 'voteCancel') {
      if (!st.vote) return fail('投票は行われていません');
      if (st.vote.by !== pid) return fail('取り下げられるのは言い出した人だけです');
      st.vote = null;
      r = { ok: true, msg: '投票を取り下げました' };
    } else {
      if (!mine) return fail('自分の手番ではありません');
      if (p.down === 2 && !RECOVER_OK.includes(t)) return fail('復帰中の手番は「温まる」「食べる」だけできます');
      r = doTurnAction(st, p, a);
    }
    if (r.ok) { st.v++; if (!r.sfx) r.sfx = SFX[t] || ''; }
    return r;
  }

  function doMove(st, p, a) {
    if (!Number.isInteger(a.x) || !Number.isInteger(a.y)) return fail('不正な操作です');
    const why = moveWhy(st, p, a.x, a.y);
    if (why) return fail(why);
    const d = moveMap(st, p).get(key(a.x, a.y));
    if (d == null) return fail('そこまでの道がありません');
    const cost = moveCost(d);
    p.x = a.x; p.y = a.y;
    p.temp = Math.max(0, p.temp - cost);
    return { ok: true, msg: cost > 0 ? `移動：雪原に${cost}回入って体温 -${cost}` : '移動：体温は減りません' };
  }

  function doTurnAction(st, p, a) {
    const ap = RULES.ap, it = st.items;
    const needAp = n => (p.ap < n ? `行動力が足りません（必要 ${n}）` : null);
    let e;
    switch (a.type) {
      case 'end':
        endTurn(st);
        return { ok: true, msg: '' };
      case 'warm': {
        if ((e = needAp(ap.warm))) return fail(e);
        const amt = warmAmount(st, p);
        p.ap -= ap.warm;
        p.temp = Math.min(RULES.maxTemp, p.temp + amt);
        return { ok: true, msg: `温まる：体温 +${amt}`, good: amt > 0 };
      }
      case 'stoke': {
        if (it.wood < 1) return fail('木材がありません');
        if ((e = needAp(ap.stoke))) return fail(e);
        if (!nearFire(st, p)) return fail('焚き火の上か、すぐ隣に移動してください');
        if (st.fire >= RULES.fireMax) return fail(`火力は最大（${RULES.fireMax}）です`);
        p.ap -= ap.stoke; it.wood--; st.fire++;
        return { ok: true, msg: `焚べる：火力 ${st.fire - 1} → ${st.fire}` };
      }
      case 'eat': {
        const k = a.k;
        if (k !== 'meat' && k !== 'veg') return fail('食べられません');
        if (it[k] < 1) return fail(`${ITEM_NAMES[k]}がありません`);
        it[k]--;
        p.food = Math.min(RULES.maxFood, p.food + RULES.eat[k]);
        return { ok: true, msg: `食べる：${ITEM_NAMES[k]} -1、満腹度 +${RULES.eat[k]}` };
      }
      case 'collect': {
        if ((e = needAp(ap.collect))) return fail(e);
        const r = resAt(st, p.x, p.y);
        if (!r) return fail('ここには集められる資源がありません');
        const onSnow = !bAt(st, p.x, p.y), k = RES_ITEM[r.t];
        p.ap -= ap.collect; r.hp--;
        let m = `集める：${ITEM_NAMES[k]} +1`;
        const sfx = 'collect_' + r.t;
        if (!gain(st, p.id, k, 1)) m += '（上限で入りません）';
        if (onSnow) m += addItem(st, 'snow', 1) ? '、雪 +1' : '（雪は上限で入らず）';   // 雪は自動で付いてくるので、入らなくても選ばせない
        if (r.hp <= 0) {
          delete st.res[key(p.x, p.y)];
          m += '。資源が消えた';
          if (r.t === 'tree' && rnd(st) < RULES.sapChance) m += gain(st, p.id, 'sapling', 1) ? '。苗木を落とした' : '。苗木を落とした（上限で入りません）';
        }
        return { ok: true, msg: m, sfx };
      }
      case 'attack': {
        if ((e = needAp(ap.attack))) return fail(e);
        const an = animalAt(st, a.x, a.y);
        if (!an || Math.abs(p.x - a.x) + Math.abs(p.y - a.y) !== 1) return fail('隣のマスの動物だけ攻撃できます');
        p.ap -= ap.attack; an.hp--;
        if (an.hp > 0) return { ok: true, msg: `攻撃：動物の体力 -1（残り ${an.hp}）`, sfx: 'attack' };
        const n = ri(st, RULES.meatMin, RULES.meatMax), got = gain(st, p.id, 'meat', n);
        st.animals = st.animals.filter(q => q !== an);
        spawnAnimal(st);
        return { ok: true, msg: `動物を倒した：肉${n}個のうち${got}個を入手${got < n ? '（入りきらない分は、入れ替えるか選べます）' : ''}`, sfx: 'kill' };
      }
      case 'plant': {
        if ((e = needAp(ap.plant))) return fail(e);
        if (bAt(st, p.x, p.y) || resAt(st, p.x, p.y) || plantAt(st, p.x, p.y)) return fail('ここには植えられません（雪原の空きマスだけ）');
        if (a.kind === 'veg') { if (it.veg < 2) return fail('野菜が2個必要です'); it.veg -= 2; }
        else if (a.kind === 'tree') { if (it.sapling < 1) return fail('苗木がありません'); it.sapling--; }
        else return fail('不正な操作です');
        p.ap -= ap.plant;
        st.plants.push({ x: p.x, y: p.y, t: a.kind, left: ri(st, RULES.growMin, RULES.growMax) });
        return { ok: true, msg: `植える：${a.kind === 'veg' ? '野菜' : '樹木'}の苗を植えた（${RULES.growMin}〜${RULES.growMax}ラウンド後に成長）` };
      }
      case 'build': {
        const d = BUILD[a.t];
        if (!d || !Number.isInteger(a.x) || !Number.isInteger(a.y)) return fail('不正な操作です');
        if ((e = needAp(d.ap))) return fail(e);
        const lack = lacking(st, d.cost);
        if (lack) return fail(`${ITEM_NAMES[lack]}が足りません`);
        const why = buildWhy(st, a.t, a.x, a.y);
        if (why) return fail(why);
        st.b = st.b.filter(b => !(b.t === 'road' && inRect({ x: a.x, y: a.y, w: d.size, h: d.size }, b.x, b.y)));
        for (let j = 0; j < d.size; j++) for (let i = 0; i < d.size; i++) delete st.draw[key(a.x + i, a.y + j)];
        const b = addBuilding(st, a.t, a.x, a.y);
        expandGen(st, b);
        p.ap -= d.ap;
        for (const k of Object.keys(d.cost)) it[k] -= d.cost[k];
        return { ok: true, msg: `${d.name}を建てた`, id: b.id };
      }
      case 'repair': {
        const b = st.b.find(x => x.id === a.id);
        if (!b || b.hp === null) return fail('直せる建物ではありません');
        if (b.hp >= b.max) return fail('HPは最大です');
        if (!nearB(b, p)) return fail('建物の上か、隣のマスから直せます');
        if ((e = needAp(b.w))) return fail(e);
        if (it.stone < 1) return fail('石材がありません');
        p.ap -= b.w; it.stone--;
        b.hp = Math.min(b.max, b.hp + RULES.repairHp);
        return { ok: true, msg: `直す：${BUILD[b.t].name}のHP ${b.hp} / ${b.max}` };
      }
      default:
        return fail('不正な操作です');
    }
  }

  // 最後まで生き延びるのに必要な食料（満腹度ぶん）。手番の終わりごとに3減り、0になると行動不能になるので、最後に1以上残るぶん
  function foodNeed(st) {
    const out = { need: 0, have: 0, short: 0, turns: 0 };
    if (st.phase !== 'play') return out;
    out.have = st.items.meat * RULES.eat.meat + st.items.veg * RULES.eat.veg;
    st.players.forEach((p, i) => {
      const left = (TOTAL_ROUNDS - st.round) + (i >= st.turn ? 1 : 0);   // これから迎える手番の終わりの回数
      out.need += Math.max(0, left * RULES.hunger + 1 - p.food);
      if (i === st.turn) out.turns = left;
    });
    out.short = Math.max(0, out.need - out.have);
    return out;
  }

  return {
    RULES, BUILD, gain, foodNeed, ITEMS, ITEM_NAMES, WEATHER_NAMES, RES_ITEM, DIRS, TOTAL_ROUNDS,
    key, parseKey, createGame, act, rollWeather, log, endTurn, resolveVote,
    cur, pl, isTurn, bAt, resAt, animalAt, plantAt, playerAt, inGen, reach, insul, fireOf, nearFire, nearB, rectGap, inRect,
    count, cap, total, room, hasTower, phaseOf, where, tempLoss, warmAmount,
    moveMap, moveCost, moveWhy, buildWhy, lacking, genCells,
  };
});
