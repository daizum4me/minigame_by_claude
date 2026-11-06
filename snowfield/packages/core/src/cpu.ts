import type { Action } from './game';
import { buildCheck } from './game';
import type { BuildableType, GameState, Resource } from './types';
import { animalAt, fireBuilding, isReachable, locationOf, nearFire, pawnAt, resourceAt, route } from './board';
import { warmAmount } from './rules';
import { pick, type RandomSource } from './rng';

/**
 * CPU の思考。状態から「次の1手」を返す（何もしないなら endTurn）。
 * 方針：食べる → 寒ければ焚き火へ戻って温まる → 火が弱ければ焚べる → 資源を集める／動物を狩る
 *       → 建てる → 手番の最後は焚き火か防寒建物で終える。
 * 行動力を使う手は必ず行動力が減るので、繰り返しても手番は終わる（呼び出し側は念のため回数も制限する）。
 */
export function cpuNextAction(s: GameState, pi: number, rng: RandomSource): Action {
  const p = s.players[pi];
  const end: Action = { type: 'endTurn', player: pi };
  const it = s.items;
  const loc = () => locationOf(s, p);
  const move = (x: number, y: number, maxCost: number, keepTemp: number): Action | null => {
    const r = route(s, pi, x, y);
    return r.ok && r.cost <= maxCost && p.temp - r.cost >= keepTemp ? { type: 'move', player: pi, x, y } : null;
  };
  const fire = fireBuilding(s);
  const goFire = (keepTemp: number): Action | null => {
    const tiles: Array<[number, number]> = [];
    for (let j = 0; j < fire.h; j++) for (let i = 0; i < fire.w; i++) tiles.push([fire.x + i, fire.y + j]);
    let best: { a: Action; c: number } | null = null;
    for (const [x, y] of tiles) {
      const r = route(s, pi, x, y);
      if (r.ok && p.temp - r.cost >= keepTemp && (!best || r.cost < best.c)) best = { a: { type: 'move', player: pi, x, y }, c: r.cost };
    }
    return best?.a ?? null;
  };

  // 食べる（行動力0）
  if (p.food <= 6 && it.meat > 0) return { type: 'eat', player: pi, item: 'meat' };
  if (p.food <= 7 && it.veg > 0) return { type: 'eat', player: pi, item: 'veg' };

  // 行動不能中は温まるだけ
  if (p.incapacitated) {
    if (p.ap >= 2 && loc() !== 'outdoor' && p.temp < s.config.maxTemp) return { type: 'warm', player: pi };
    return end;
  }

  // 寒ければ焚き火へ戻る
  if (loc() === 'outdoor' && p.temp <= 5) { const a = goFire(0); if (a) return a; }
  // 温まる
  const wa = warmAmount(loc(), s.fire);
  if (p.ap >= 2 && wa >= 2 && p.temp <= s.config.maxTemp - 3) return { type: 'warm', player: pi };
  if (p.ap >= 2 && wa >= 1 && p.temp <= 5) return { type: 'warm', player: pi };

  // 焚べる
  if (p.ap >= 1 && s.fire <= 2 && it.wood >= 1 && s.fire < s.config.maxFire && nearFire(s, p)) return { type: 'stoke', player: pi };
  if (p.ap >= 1 && s.fire <= 2 && it.wood >= 1 && s.fire < s.config.maxFire && loc() === 'outdoor') {
    const a = goFire(2); if (a) return a;
  }

  // 足元の資源を集める
  const total = Object.values(it).reduce((a, b) => a + b, 0);
  const full = total >= 2 * s.players.length + 10 + 10 * s.buildings.filter((b) => b.t === 'storage').length;
  if (p.ap >= 1 && resourceAt(s, p.x, p.y) && !full) return { type: 'collect', player: pi };

  // 隣の動物を倒す（食料が少ないとき）
  if (p.ap >= 1 && it.meat + it.veg < 3) {
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const a = animalAt(s, p.x + dx, p.y + dy);
      if (a) return { type: 'attack', player: pi, x: a.x, y: a.y };
    }
  }

  // 建てる
  if (p.ap >= 2) {
    const wants: BuildableType[] = [];
    const count = (t: string) => s.buildings.filter((b) => b.t === t).length;
    if (it.snow >= 5 && count('igloo') < 2) wants.push('igloo');
    if (it.wood >= 4 && it.stone >= 4 && p.ap >= 4 && count('storage') < 1) wants.push('storage');
    for (const t of wants) {
      const size = t === 'igloo' ? 2 : 4;
      const spots: Array<[number, number]> = [];
      for (let y = fire.y - size - 1; y <= fire.y + 4; y++) for (let x = fire.x - size - 1; x <= fire.x + 4; x++) {
        if (!buildCheck(s, x, y, t)) spots.push([x, y]);
      }
      if (spots.length) { const [x, y] = pick(rng, spots); return { type: 'build', player: pi, building: t, x, y }; }
    }
  }

  // 資源・動物へ向かう
  if (p.ap >= 1 && !full) {
    const need = (r: Resource) => (r.t === 'tree' ? (it.wood < 5 ? 3 : 1) : r.t === 'stone' ? (it.stone < 4 ? 2 : 0.5) : it.veg + it.meat < 4 ? 3 : 1);
    let best: { a: Action; score: number } | null = null;
    for (const r of s.resources) {
      if (pawnAt(s, r.x, r.y, pi) || animalAt(s, r.x, r.y) || !isReachable(s, r.x, r.y)) continue;
      const a = move(r.x, r.y, 3, 6);
      if (!a) continue;
      const rt = route(s, pi, r.x, r.y);
      const score = need(r) - rt.cost * 0.8;
      if (!best || score > best.score) best = { a, score };
    }
    if (it.meat + it.veg < 2) {
      for (const an of s.animals) {
        for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          const x = an.x + dx, y = an.y + dy;
          if (pawnAt(s, x, y, pi) || animalAt(s, x, y) || (x === p.x && y === p.y)) continue;
          const a = move(x, y, 3, 6);
          if (!a) continue;
          const score = 2.5 - route(s, pi, x, y).cost * 0.8;
          if (!best || score > best.score) best = { a, score };
        }
      }
    }
    if (best && best.score > 0) return best.a;
  }

  // 手番の最後：安全な場所で終える
  if (p.ap >= 2 && loc() !== 'outdoor' && warmAmount(loc(), s.fire) > 0 && p.temp < s.config.maxTemp) return { type: 'warm', player: pi };
  if (loc() === 'outdoor') {
    const a = goFire(1);
    if (a) return a;
  }
  return end;
}

/** 捨てる投票へのCPUの票：余っているものは賛成、少ないものは反対 */
export function cpuVote(s: GameState, item: keyof GameState['items']): 1 | -1 {
  const keep: Record<string, number> = { wood: 4, stone: 3, veg: 2, meat: 2, snow: 5, sapling: 1 };
  return s.items[item] > keep[item] ? 1 : -1;
}
