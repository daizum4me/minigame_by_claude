import type { GameConfig } from './types';

/**
 * 既定の設定値。「【未確定】」の付いた項目は仕様書で確定していないため仮の値。
 * 値を変えるだけで挙動が変わるよう、ルール側にはベタ書きしない。
 */
export const DEFAULT_CONFIG: GameConfig = {
  cols: 15,
  rows: 14,
  minPlayers: 2,
  maxPlayers: 5,
  prepRounds: 10,
  finalRounds: 3,
  maxTemp: 10,
  maxFood: 10,
  apPerTurn: 7,
  foodPerTurn: 3,
  maxFire: 5,
  initialFire: 3,
  initialItems: { wood: 3, veg: 1, meat: 1 },
  weatherWeights: { clear: 35, snow: 30, blizzard: 12, rain: 15, final: 8 },
  blizzardBuildingDamage: 1,
  loseOnRepeatedIncapacitation: true,
  growMin: 1,
  growMax: 3,
  grownHpMin: 3,
  grownHpMax: 7,
  animalHpMin: 3,
  animalHpMax: 5,
  stokeRange: 1,
  initialSpawn: { tree: 5, stone: 4, veg: 4, animal: 3, guaranteedNearFire: 1, scatterRadius: 6 },
  penColors: ['a', 'b'],
};

export const WEATHER_LABEL = { clear: '晴れ', snow: '雪', blizzard: '吹雪', rain: '雨', final: '猛吹雪' } as const;
export const ITEM_LABEL = { wood: '木材', stone: '石材', veg: '野菜', meat: '肉', snow: '雪', sapling: '苗木' } as const;

export const BUILDING_DEFS = {
  road: { name: '道', size: 1, ap: 1, cost: { snow: 1 } },
  igloo: { name: 'かまくら', size: 2, ap: 2, cost: { snow: 5 } },
  storage: { name: '倉庫', size: 4, ap: 4, cost: { wood: 4, stone: 4 } },
  tower: { name: '見張り台', size: 2, ap: 2, cost: { wood: 5, stone: 3 } },
} as const;

export const BUILDING_NAME = { fire: '焚き火', ...Object.fromEntries(Object.entries(BUILDING_DEFS).map(([k, v]) => [k, v.name])) } as Record<string, string>;
