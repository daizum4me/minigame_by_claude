import type { GameConfig, Weather } from './types';
import type { Location } from './board';
import type { RandomSource } from './rng';

/** 天候による体温低下の補正 */
export const WEATHER_TEMP_MOD: Record<Weather, number> = { clear: 0, snow: 1, blizzard: 2, rain: 0, final: 4 };
/** 防寒施設が軽減できる天候補正の最大値 */
export const INSULATION_MAX_REDUCTION = 2;
/** 場所ごとの基本低下 */
export const BASE_TEMP_LOSS: Record<Location, number> = { fire: 0, insulated: 1, outdoor: 2 };

/** 手番終了時の体温低下量 */
export function tempLoss(loc: Location, weather: Weather): number {
  const mod = WEATHER_TEMP_MOD[weather];
  const reduced = loc === 'insulated' ? Math.max(0, mod - INSULATION_MAX_REDUCTION) : mod;
  return BASE_TEMP_LOSS[loc] + reduced;
}

/** 手番終了時の焚き火の火力低下量（雨は+1） */
export const fireDecay = (weather: Weather): number => 1 + (weather === 'rain' ? 1 : 0);

/** 猛吹雪（ランダム・最終は同一）か */
export const isBlizzardFinal = (w: Weather): boolean => w === 'final';

/** 「温まる」の回復量 */
export function warmAmount(loc: Location, firePower: number): number {
  if (loc === 'fire') return firePower;
  if (loc === 'insulated') return 1;
  return 0;
}

/** 建物の最大HP＝一辺のマス数×2 */
export const buildingMaxHp = (size: number): number => size * 2;

/** 準備期間の天候を重み付きで抽選 */
export function drawWeather(cfg: GameConfig, rng: RandomSource): Weather {
  const entries = Object.entries(cfg.weatherWeights) as Array<[Weather, number]>;
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let r = rng.next() * total;
  for (const [k, w] of entries) { r -= w; if (r < 0) return k; }
  return entries[entries.length - 1][0];
}

/** そのラウンドの天候（最終猛吹雪ラウンドは固定） */
export function weatherForRound(cfg: GameConfig, round: number, rng: RandomSource): Weather {
  return round > cfg.prepRounds ? 'final' : drawWeather(cfg, rng);
}
