import { DEFAULT_CONFIG, BUILDING_DEFS, BUILDING_NAME, ITEM_LABEL } from './config';
import type { Animal, BuildableType, GameConfig, GameState, ItemKey, PlantKind, Resource } from './types';
import { pick, randInt, stateRng, type RandomSource } from './rng';
import {
  addItem, animalAt, buildingAt, fireBuilding, freeSnowTiles, itemCap, locationOf,
  nearFire, pawnAt, plantAt, rectDist, resourceAt, route, totalItems,
} from './board';
import {
  buildingMaxHp, fireDecay, isBlizzardFinal, tempLoss, warmAmount, weatherForRound,
} from './rules';
import { addSegment, clearCells, erase } from './drawing';

export const PLAYER_COLORS = ['#2f6fb5', '#8059c4', '#2e8a74', '#c0803a', '#b5476a'];

export type Action =
  | { type: 'move'; player: number; x: number; y: number }
  | { type: 'warm'; player: number }
  | { type: 'stoke'; player: number }
  | { type: 'eat'; player: number; item: 'meat' | 'veg' }
  | { type: 'collect'; player: number }
  | { type: 'attack'; player: number; x: number; y: number }
  | { type: 'plant'; player: number; kind: PlantKind }
  | { type: 'build'; player: number; building: BuildableType; x: number; y: number }
  | { type: 'repair'; player: number; building: number }
  | { type: 'endTurn'; player: number }
  | { type: 'startVote'; player: number; item: ItemKey }
  | { type: 'castVote'; player: number; value: 1 | -1 }
  | { type: 'cancelVote' }
  | { type: 'draw'; x0: number; y0: number; x1: number; y1: number; color: string }
  | { type: 'erase'; x: number; y: number; r: number };

export interface Result {
  state: GameState;
  ok: boolean;
  /** プレイヤーに見せるメッセージ */
  message: string;
}

export interface NewGameOptions { players: number; seed?: number; config?: Partial<GameConfig>; names?: string[] }

const emptyItems = () => ({ wood: 0, stone: 0, veg: 0, meat: 0, snow: 0, sapling: 0 });

/** 新しいゲームを作る。同じ seed なら同じ盤面になる */
export function createGame(opts: NewGameOptions): GameState {
  const config: GameConfig = { ...DEFAULT_CONFIG, ...opts.config };
  if (opts.players < config.minPlayers || opts.players > config.maxPlayers) {
    throw new Error(`プレイヤー人数は ${config.minPlayers}〜${config.maxPlayers} 人です`);
  }
  const s: GameState = {
    config, phase: 'playing', round: 1, turn: 0, weather: 'clear', nextWeather: null,
    fire: config.initialFire, items: { ...emptyItems(), ...config.initialItems },
    players: [], buildings: [], resources: [], animals: [], plants: [], vote: null, drawing: {},
    nextId: 1, rng: (opts.seed ?? 1) | 0,
  };
  const rng = stateRng(s);
  const fx = Math.floor((config.cols - 3) / 2) - 1, fy = Math.floor((config.rows - 3) / 2) - 1;
  s.buildings.push({ id: s.nextId++, t: 'fire', x: fx, y: fy, w: 3, h: 3, hp: null, max: null });
  const starts: Array<[number, number]> = [[1, 1], [0, 1], [2, 1], [1, 0], [1, 2], [0, 0], [2, 2], [0, 2], [2, 0]];
  for (let i = 0; i < opts.players; i++) {
    const [dx, dy] = starts[i];
    s.players.push({
      name: opts.names?.[i] ?? `プレイヤー${i + 1}`, color: PLAYER_COLORS[i % PLAYER_COLORS.length],
      x: fx + dx, y: fy + dy, temp: config.maxTemp, food: config.maxFood, ap: config.apPerTurn, incapacitated: false,
    });
  }
  generateMap(s, rng);
  s.weather = weatherForRound(config, 1, rng);
  s.nextWeather = weatherForRound(config, 2, rng);
  applyTurnStart(s);
  return s;
}

/** 【仮】初期配置：焚き火から一定距離内にランダム。種類ごとに最低数は移動できる範囲（焚き火の2マス以内）に置く */
function generateMap(s: GameState, rng: RandomSource): void {
  const sp = s.config.initialSpawn;
  const fire = fireBuilding(s);
  const dist = (x: number, y: number) => { const d = rectDist(fire, x, y); return Math.max(d.dx, d.dy); };
  const free = (maxD: number, minD: number) => freeSnowTiles(s, false).filter(([x, y]) => dist(x, y) <= maxD && dist(x, y) >= minD);
  const place = (n: number, add: (x: number, y: number) => void) => {
    for (let i = 0; i < n; i++) {
      const near = i < sp.guaranteedNearFire;
      const cand = free(near ? 2 : sp.scatterRadius, near ? 1 : 3);
      if (!cand.length) return;
      const [x, y] = pick(rng, cand);
      add(x, y);
    }
  };
  const res = (t: Resource['t']) => (x: number, y: number) => s.resources.push({ id: s.nextId++, t, x, y, hp: randInt(rng, s.config.grownHpMin, s.config.grownHpMax) });
  place(sp.tree, res('tree'));
  place(sp.stone, res('stone'));
  place(sp.veg, res('veg'));
  place(sp.animal, (x, y) => s.animals.push({ id: s.nextId++, x, y, hp: randInt(rng, s.config.animalHpMin, s.config.animalHpMax) }));
}

const clone = (s: GameState): GameState => structuredClone(s);

/** 手番開始：行動力回復、猛吹雪なら建物HP減少 */
function applyTurnStart(s: GameState): string {
  const p = s.players[s.turn];
  p.ap = s.config.apPerTurn;
  let msg = '';
  if (isBlizzardFinal(s.weather)) {
    const lost: string[] = [];
    for (const b of s.buildings) {
      if (b.hp === null) continue;
      b.hp = Math.max(0, b.hp - s.config.blizzardBuildingDamage);
    }
    for (const b of s.buildings.filter((q) => q.hp === 0)) lost.push(BUILDING_NAME[b.t]);
    s.buildings = s.buildings.filter((b) => b.hp !== 0);
    msg = '猛吹雪：建物のHPが減った' + (lost.length ? `（${lost.join('・')}が壊れた）` : '');
  }
  return msg;
}

/** ラウンド開始：天候更新、苗の成長 */
function startRound(s: GameState, rng: RandomSource): string[] {
  const msgs: string[] = [];
  s.weather = s.nextWeather ?? weatherForRound(s.config, s.round, rng);
  s.nextWeather = s.round >= s.config.prepRounds + s.config.finalRounds ? null : weatherForRound(s.config, s.round + 1, rng);
  const grown: string[] = [];
  s.plants = s.plants.filter((pl) => {
    pl.growIn -= 1;
    if (pl.growIn > 0) return true;
    s.resources.push({ id: s.nextId++, t: pl.t, x: pl.x, y: pl.y, hp: randInt(rng, s.config.grownHpMin, s.config.grownHpMax) });
    grown.push(pl.t === 'veg' ? '野菜' : '木');
    return false;
  });
  if (grown.length) msgs.push(`苗が育った（${grown.join('・')}）`);
  return msgs;
}

/** 手番終了の処理（満腹・火力・体温・行動不能・手番交代・ラウンド進行・終了判定） */
function endTurn(s: GameState, rng: RandomSource): string {
  const pi = s.turn, p = s.players[pi];
  const cfg = s.config;
  const parts: string[] = [];
  const wasIncap = p.incapacitated;
  const loc = locationOf(s, p);

  s.fire = Math.max(0, s.fire - fireDecay(s.weather));
  p.food = Math.max(0, p.food - cfg.foodPerTurn);
  const loss = tempLoss(loc, s.weather);
  p.temp = Math.max(0, p.temp - loss);
  parts.push(`満腹度 -${cfg.foodPerTurn}、体温 -${loss}、焚き火 -${fireDecay(s.weather)}`);

  p.incapacitated = false;
  if (p.temp === 0 || p.food === 0) {
    if (wasIncap && cfg.loseOnRepeatedIncapacitation) {
      s.phase = 'lost';
      s.endReason = `${p.name} が回復できないまま再び行動不能になりました`;
      return s.endReason;
    }
    const fire = fireBuilding(s);
    const tiles: Array<[number, number]> = [];
    for (let j = 0; j < fire.h; j++) for (let i = 0; i < fire.w; i++) {
      if (!pawnAt(s, fire.x + i, fire.y + j, pi) && !animalAt(s, fire.x + i, fire.y + j)) tiles.push([fire.x + i, fire.y + j]);
    }
    if (tiles.length) { [p.x, p.y] = tiles[0]; }
    if (p.temp === 0) p.temp = 3;
    if (p.food === 0) p.food = 3;
    p.incapacitated = true;
    parts.push(`${p.name} は行動不能になり、焚き火へ運ばれた（次の手番は「温まる／食べる」だけ）`);
  }

  // 手番交代
  s.turn += 1;
  if (s.turn >= s.players.length) {
    s.turn = 0;
    if (s.round >= cfg.prepRounds + cfg.finalRounds) {
      s.phase = 'won';
      s.endReason = '最終猛吹雪を生き延びました！';
      return s.endReason;
    }
    s.round += 1;
    parts.push(...startRound(s, rng));
  }
  const bl = applyTurnStart(s);
  if (bl) parts.push(bl);
  return parts.join('。');
}

const fail = (s: GameState, message: string): Result => ({ state: s, ok: false, message });

/** 行動を1つ適用する。state は書き換えず、新しい state を返す */
export function applyAction(state: GameState, action: Action, rngOverride?: RandomSource): Result {
  if (state.phase !== 'playing') return fail(state, 'ゲームは終了しています');
  const s = clone(state);
  const rng = rngOverride ?? stateRng(s);
  const done = (message: string): Result => ({ state: s, ok: true, message });
  const bad = (message: string): Result => fail(state, message);

  switch (action.type) {
    /* ===== 手番外でもできる ===== */
    case 'move': {
      const p = s.players[action.player];
      if (!p) return bad('プレイヤーがいません');
      const r = route(s, action.player, action.x, action.y);
      if (!r.ok) return bad('移動できません：' + r.why);
      p.x = action.x; p.y = action.y;
      p.temp = Math.max(0, p.temp - r.cost);
      return done('移動しました（行動力0）：' + (r.cost > 0 ? `雪原に${r.cost}回入って体温 -${r.cost}` : '建物・道の上だけを通ったので体温は減りません'));
    }
    case 'draw': {
      addSegment(s.drawing, action.x0, action.y0, action.x1, action.y1, action.color);
      return done('');
    }
    case 'erase': {
      erase(s.drawing, action.x, action.y, action.r);
      return done('');
    }
    case 'startVote': {
      if (s.vote) return bad('別の投票が進行中です');
      if (!s.items[action.item]) return bad(ITEM_LABEL[action.item] + 'がありません');
      s.vote = { item: action.item, votes: s.players.map((_, i) => (i === action.player ? 1 : 0)) };
      return resolveVote(s, done);
    }
    case 'castVote': {
      if (!s.vote) return bad('投票は行われていません');
      s.vote.votes[action.player] = action.value;
      return resolveVote(s, done);
    }
    case 'cancelVote': {
      s.vote = null;
      return done('投票を取り下げました');
    }
  }

  /* ===== 以降は自分の手番のみ ===== */
  const pi = action.player;
  const p = s.players[pi];
  if (!p) return bad('プレイヤーがいません');
  if (pi !== s.turn) return bad('自分の手番ではありません');
  const needAP = (n: number) => p.ap < n;
  const lowAp = (n: number) => bad(`行動力が足りません（必要 ${n}）`);
  const incapBlock = () => (p.incapacitated ? bad('行動不能のため「温まる」「食べる」だけ行えます') : null);

  switch (action.type) {
    case 'endTurn':
      return done(endTurn(s, rng));

    case 'warm': {
      if (needAP(2)) return lowAp(2);
      const loc = locationOf(s, p);
      const amt = warmAmount(loc, s.fire);
      p.ap -= 2;
      p.temp = Math.min(s.config.maxTemp, p.temp + amt);
      const why = loc === 'fire' ? `焚き火の火力 ${s.fire}` : loc === 'insulated' ? '防寒が有効な建物の中 +1' : '焚き火の外なので回復0';
      return done(`温まる：体温 +${amt}（${why}）`);
    }
    case 'eat': {
      if (s.items[action.item] < 1) return bad(ITEM_LABEL[action.item] + 'がありません');
      const up = action.item === 'meat' ? 3 : 2;
      s.items[action.item] -= 1;
      p.food = Math.min(s.config.maxFood, p.food + up);
      return done(`食べる：${ITEM_LABEL[action.item]} -1、満腹度 +${up}（行動力0）`);
    }
    case 'stoke': {
      const b = incapBlock(); if (b) return b;
      if (s.items.wood < 1) return bad('木材がありません');
      if (needAP(1)) return lowAp(1);
      if (!nearFire(s, p)) return bad('焚き火の上か、すぐ隣に移動してください');
      if (s.fire >= s.config.maxFire) return bad(`火力は最大（${s.config.maxFire}）です`);
      p.ap -= 1; s.items.wood -= 1; s.fire += 1;
      return done(`焚べる：木材 -1、火力 ${s.fire - 1} → ${s.fire}`);
    }
    case 'collect': {
      const b = incapBlock(); if (b) return b;
      if (needAP(1)) return lowAp(1);
      const r = resourceAt(s, p.x, p.y);
      if (!r) return bad('ここには集められる資源がありません');
      if (itemCap(s) - totalItems(s) < 1) return bad('所持上限です。右のアイテム欄で何かを捨ててください');
      const onSnow = !buildingAt(s, p.x, p.y);
      const key = ({ tree: 'wood', stone: 'stone', veg: 'veg' } as const)[r.t];
      p.ap -= 1; r.hp -= 1;
      addItem(s, key, 1);
      let m = `集める：${ITEM_LABEL[key]} +1`;
      if (onSnow) m += addItem(s, 'snow', 1) ? '、雪 +1' : '（雪は上限で入らず）';
      if (r.hp <= 0) {
        s.resources = s.resources.filter((x) => x.id !== r.id);
        m += '。資源が消滅';
        if (r.t === 'tree') {
          if (rng.next() < 0.5) m += addItem(s, 'sapling', 1) ? '。苗木を落とした（確率50%）' : '。苗木は上限で入らず';
          else m += '。苗木は落ちなかった（確率50%）';
        }
      } else m += `（残り体力 ${r.hp}）`;
      return done(m);
    }
    case 'attack': {
      const b = incapBlock(); if (b) return b;
      if (needAP(1)) return lowAp(1);
      const a = animalAt(s, action.x, action.y);
      if (!a || Math.abs(p.x - action.x) + Math.abs(p.y - action.y) !== 1) return bad('隣のマスの動物だけ攻撃できます');
      p.ap -= 1; a.hp -= 1;
      if (a.hp > 0) return done(`攻撃：動物の体力 -1（残り ${a.hp}）`);
      const n = randInt(rng, 1, 7);
      const got = addItem(s, 'meat', n);
      s.animals = s.animals.filter((q) => q.id !== a.id);
      const free = freeSnowTiles(s, true);
      if (free.length) {
        const [x, y] = pick(rng, free);
        s.animals.push({ id: s.nextId++, x, y, hp: randInt(rng, s.config.animalHpMin, s.config.animalHpMax) } as Animal);
      }
      return done(`動物を倒した：肉 ${n}個が出て、${got}個を入手${got < n ? '（上限で入りきらず）' : ''}。別の雪原に再出現`);
    }
    case 'plant': {
      const b = incapBlock(); if (b) return b;
      if (needAP(1)) return lowAp(1);
      if (buildingAt(s, p.x, p.y) || resourceAt(s, p.x, p.y) || plantAt(s, p.x, p.y)) return bad('ここには植えられません');
      if (action.kind === 'veg') {
        if (s.items.veg < 2) return bad('野菜が2個必要です');
        s.items.veg -= 2;
      } else {
        if (s.items.sapling < 1) return bad('苗木がありません');
        s.items.sapling -= 1;
      }
      p.ap -= 1;
      const growIn = randInt(rng, s.config.growMin, s.config.growMax);
      s.plants.push({ id: s.nextId++, t: action.kind, x: p.x, y: p.y, growIn });
      return done(`植える：${action.kind === 'veg' ? '野菜2個を使って野菜の苗' : '苗木1個を使って樹木の苗'}を植えた（${s.config.growMin}〜${s.config.growMax}ラウンド後に成長）`);
    }
    case 'build': {
      const b = incapBlock(); if (b) return b;
      const d = BUILDING_DEFS[action.building];
      const err = buildCheck(s, action.x, action.y, action.building);
      if (err) return bad(err);
      if (needAP(d.ap)) return lowAp(d.ap);
      const costs = Object.entries(d.cost) as Array<[ItemKey, number]>;
      const lack = costs.find(([k, n]) => s.items[k] < n);
      if (lack) return bad(ITEM_LABEL[lack[0]] + 'が足りません');
      const { x, y } = action, sz = d.size;
      s.buildings = s.buildings.filter((q) => !(q.t === 'road' && q.x >= x && q.x < x + sz && q.y >= y && q.y < y + sz));
      const max = action.building === 'road' ? null : buildingMaxHp(sz);
      s.buildings.push({ id: s.nextId++, t: action.building, x, y, w: sz, h: sz, hp: max, max });
      clearCells(s.drawing, x, y, sz, sz);
      p.ap -= d.ap;
      for (const [k, n] of costs) s.items[k] -= n;
      return done(`${d.name}を建てた（行動力${d.ap}）。そのマスに描かれていた絵は消えました`);
    }
    case 'repair': {
      const b = incapBlock(); if (b) return b;
      const bd = s.buildings.find((q) => q.id === action.building);
      if (!bd || bd.hp === null || bd.max === null) return bad('直せる建物ではありません');
      const dd = rectDist(bd, p.x, p.y);
      if (dd.dx + dd.dy > 1) return bad('建物の上か、すぐ隣に移動してください');
      if (bd.hp >= bd.max) return bad('HPは最大です');
      if (needAP(bd.w)) return lowAp(bd.w);
      if (s.items.stone < 1) return bad('石材がありません');
      p.ap -= bd.w; s.items.stone -= 1; bd.hp = Math.min(bd.max, bd.hp + 2);
      return done(`直す：${BUILDING_NAME[bd.t]}のHPが ${bd.hp} / ${bd.max} になりました`);
    }
  }
  return bad('不明な行動です');
}

/** 建設できるか（位置の検査のみ。行動力・素材は別） */
export function buildCheck(s: GameState, x: number, y: number, t: BuildableType): string | null {
  const d = BUILDING_DEFS[t];
  if (x < 0 || y < 0 || x + d.size > s.config.cols || y + d.size > s.config.rows) return '盤面の外にはみ出します';
  for (let j = 0; j < d.size; j++) for (let i = 0; i < d.size; i++) {
    const tx = x + i, ty = y + j, b = buildingAt(s, tx, ty);
    if (resourceAt(s, tx, ty)) return '資源のあるマスには建てられません';
    if (plantAt(s, tx, ty)) return '苗のあるマスには建てられません';
    if (animalAt(s, tx, ty)) return '動物のいるマスには建てられません';
    if (b && (t === 'road' || b.t !== 'road')) return '他の建物と重なります';
  }
  return null;
}

function resolveVote(s: GameState, done: (m: string) => Result): Result {
  const v = s.vote;
  if (!v) return done('');
  const n = s.players.length;
  const yes = v.votes.filter((x) => x > 0).length, no = v.votes.filter((x) => x < 0).length;
  if (yes * 2 > n) {
    if (s.items[v.item] > 0) s.items[v.item] -= 1;
    s.vote = null;
    return done(`可決：${ITEM_LABEL[v.item]}を1個捨てました`);
  }
  if (no * 2 >= n) {
    s.vote = null;
    return { state: s, ok: false, message: `否決：${ITEM_LABEL[v.item]}は捨てません` };
  }
  return done(`「${ITEM_LABEL[v.item]}を1個捨てる」投票を始めました`);
}

