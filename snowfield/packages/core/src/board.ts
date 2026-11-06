import type { Animal, Building, GameState, ItemKey, Plant, Player, Resource } from './types';
import { ITEM_ORDER } from './types';

export const inBounds = (s: GameState, x: number, y: number) => x >= 0 && y >= 0 && x < s.config.cols && y < s.config.rows;
export const buildingAt = (s: GameState, x: number, y: number): Building | null =>
  s.buildings.find((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) ?? null;
export const resourceAt = (s: GameState, x: number, y: number): Resource | null => s.resources.find((r) => r.x === x && r.y === y) ?? null;
export const animalAt = (s: GameState, x: number, y: number): Animal | null => s.animals.find((a) => a.x === x && a.y === y) ?? null;
export const plantAt = (s: GameState, x: number, y: number): Plant | null => s.plants.find((p) => p.x === x && p.y === y) ?? null;
export const pawnAt = (s: GameState, x: number, y: number, skip = -1): Player | null =>
  s.players.find((p, i) => i !== skip && p.x === x && p.y === y) ?? null;
export const fireBuilding = (s: GameState): Building => s.buildings.find((b) => b.t === 'fire') as Building;

/** 矩形（建物）までのマス距離（x,y それぞれ） */
export function rectDist(b: Building, x: number, y: number): { dx: number; dy: number } {
  return { dx: Math.max(b.x - x, 0, x - (b.x + b.w - 1)), dy: Math.max(b.y - y, 0, y - (b.y + b.h - 1)) };
}

/** 建物から2マス以内（建物の上も含む）＝移動できる範囲 */
export function isReachable(s: GameState, x: number, y: number): boolean {
  return s.buildings.some((b) => { const d = rectDist(b, x, y); return d.dx <= 2 && d.dy <= 2; });
}

export const totalItems = (s: GameState): number => ITEM_ORDER.reduce((a, k) => a + s.items[k], 0);
export const itemCap = (s: GameState): number =>
  2 * s.players.length + 10 + 10 * s.buildings.filter((b) => b.t === 'storage').length;
export const itemRoom = (s: GameState): number => Math.max(0, itemCap(s) - totalItems(s));

/** 上限を超える分は入らない。入った個数を返す */
export function addItem(s: GameState, k: ItemKey, n: number): number {
  const a = Math.min(n, itemRoom(s));
  s.items[k] += a;
  return a;
}

/** 防寒が有効：かまくら・倉庫で、HPが最大の半分を超えている */
export const isInsulated = (b: Building | null): boolean =>
  !!b && (b.t === 'igloo' || b.t === 'storage') && b.hp !== null && b.max !== null && b.hp * 2 > b.max;

export type Location = 'fire' | 'insulated' | 'outdoor';
export function locationOf(s: GameState, p: Player): Location {
  const b = buildingAt(s, p.x, p.y);
  if (b?.t === 'fire') return 'fire';
  if (isInsulated(b)) return 'insulated';
  return 'outdoor';
}

export function nearFire(s: GameState, p: Player): boolean {
  const d = rectDist(fireBuilding(s), p.x, p.y);
  return Math.max(d.dx, d.dy) <= s.config.stokeRange;
}

export interface Route { ok: boolean; cost: number; why?: string }

/** 移動の可否と体温コスト（雪原に入るたび1。建物・道の上だけを通るなら0） */
export function route(s: GameState, pi: number, tx: number, ty: number): Route {
  const p = s.players[pi];
  const no = (why: string): Route => ({ ok: false, cost: 0, why });
  if (!inBounds(s, tx, ty)) return no('盤面の外です');
  if (tx === p.x && ty === p.y) return no('いまいるマスです');
  if (!isReachable(s, tx, ty)) return no('建物から2マス以内の雪原にだけ移動できます');
  if (animalAt(s, tx, ty)) return no('動物のいるマスには入れません');
  if (pawnAt(s, tx, ty, pi)) return no('他のプレイヤーと重なれません');
  const { cols, rows } = s.config;
  const N = cols * rows, INF = 1e9;
  const dist = new Array<number>(N).fill(INF), done = new Array<boolean>(N).fill(false);
  const id = (x: number, y: number) => y * cols + x;
  dist[id(p.x, p.y)] = 0;
  for (;;) {
    let u = -1, best = INF;
    for (let i = 0; i < N; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
    if (u < 0) break;
    done[u] = true;
    const ux = u % cols, uy = Math.floor(u / cols);
    for (const [ddx, ddy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const x = ux + ddx, y = uy + ddy;
      if (!inBounds(s, x, y) || !isReachable(s, x, y) || animalAt(s, x, y) || pawnAt(s, x, y, pi)) continue;
      const c = (buildingAt(s, x, y) ? 0 : 100) + 1, v = id(x, y);
      if (dist[u] + c < dist[v]) dist[v] = dist[u] + c;
    }
  }
  const d = dist[id(tx, ty)];
  if (d >= INF) return no('そこまでの道がありません');
  return { ok: true, cost: Math.floor(d / 100) };
}

/** 資源・動物・建物・苗・駒のいない雪原マス（動物の再出現用） */
export function freeSnowTiles(s: GameState, onlyReachable: boolean): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let y = 0; y < s.config.rows; y++) for (let x = 0; x < s.config.cols; x++) {
    if (onlyReachable && !isReachable(s, x, y)) continue;
    if (buildingAt(s, x, y) || resourceAt(s, x, y) || animalAt(s, x, y) || plantAt(s, x, y) || pawnAt(s, x, y)) continue;
    out.push([x, y]);
  }
  return out;
}
