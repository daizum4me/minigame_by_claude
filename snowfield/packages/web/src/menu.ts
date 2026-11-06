import {
  BUILDING_NAME, buildingAt, isInsulated, itemCap, nearFire, plantAt, rectDist, resourceAt, totalItems, animalAt,
  type Action, type GameState,
} from '@snowfield/core';
import type { MenuEntry, MenuModel } from './Board';
import { DESC } from './ui';

/** 駒クリックで出す行動メニュー（可否の理由を文字で返す。理由が空なら実行可能） */
export function buildMenu(g: GameState, viewer: number, act: (a: Action) => void, openTray: () => void): MenuModel {
  const p = g.players[viewer], it = g.items;
  const myTurn = g.turn === viewer;
  const E: MenuEntry[] = [];
  const need = (n: number) => (p.ap < n ? '行動力が足りません' : '');
  const add = (label: string, cost: string, why0: string, run: () => void, head?: string, incapOk = false) => {
    const why = !myTurn ? '自分の手番ではありません' : p.incapacitated && !incapOk ? '行動不能：温まる／食べるだけ' : why0;
    E.push({ label, cost, why, run, head });
  };
  const here = buildingAt(g, p.x, p.y), r = resourceAt(g, p.x, p.y);
  let first = true;
  const hd = (h: string) => { if (first) { first = false; return h; } return undefined; };
  void hd;

  let amt = 'ここでは回復0';
  if (here?.t === 'fire') amt = '火力' + g.fire + 'ぶん回復';
  else if (isInsulated(here)) amt = '回復 +1';
  add('温まる', '行動力2・' + amt, need(2), () => act({ type: 'warm', player: viewer }), '行動', true);
  if (nearFire(g, p)) add('焚べる', '行動力1・木材1', g.fire >= g.config.maxFire ? '火力は最大です' : it.wood < 1 ? '木材がありません' : need(1), () => act({ type: 'stoke', player: viewer }));
  if (r) add('集める', '行動力1', need(1) || (itemCap(g) - totalItems(g) < 1 ? '所持上限です' : ''), () => act({ type: 'collect', player: viewer }));
  for (const [name, dx, dy] of [['上', 0, -1], ['下', 0, 1], ['左', -1, 0], ['右', 1, 0]] as const) {
    const a = animalAt(g, p.x + dx, p.y + dy);
    if (a) add(`攻撃：${name}の動物`, '行動力1・体力' + a.hp, need(1), () => act({ type: 'attack', player: viewer, x: a.x, y: a.y }));
  }
  if (!here && !r && !plantAt(g, p.x, p.y)) {
    add('植える：野菜の苗', '行動力1・野菜2', it.veg < 2 ? '野菜が2個必要です' : need(1), () => act({ type: 'plant', player: viewer, kind: 'veg' }));
    add('植える：樹木の苗', '行動力1・苗木1', it.sapling < 1 ? '苗木がありません' : need(1), () => act({ type: 'plant', player: viewer, kind: 'tree' }));
  }
  for (const b of g.buildings) {
    if (b.hp === null || b.max === null) continue;
    const d = rectDist(b, p.x, p.y);
    if (d.dx + d.dy <= 1) add('直す：' + BUILDING_NAME[b.t], `行動力${b.w}・石材1`, b.hp >= b.max ? 'HPは最大です' : need(b.w) || (it.stone < 1 ? '石材がありません' : ''), () => act({ type: 'repair', player: viewer, building: b.id }));
  }
  E.push(...[]);
  const eat = (label: string, cost: string, key: 'meat' | 'veg', name: string, head?: string) =>
    add(label, cost, it[key] < 1 ? name + 'がありません' : '', () => act({ type: 'eat', player: viewer, item: key }), head, true);
  eat('食べる：肉', '行動力0・満腹+3', 'meat', '肉', '持ち物');
  eat('食べる：野菜', '行動力0・満腹+2', 'veg', '野菜');
  add('建てる', 'カード一覧を左下に表示', '', openTray, '建設');

  const place = here ? DESC[here.t].name + 'の上' : r ? { tree: '木', stone: '石', veg: '野菜' }[r.t] + 'のマス' : '雪原';
  return { title: `${p.name}${myTurn ? '（手番）' : ''}`, sub: 'いる場所：' + place, entries: E };
}
