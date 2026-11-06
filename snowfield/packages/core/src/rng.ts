/** 乱数源。テストでは固定列を返すものに差し替える */
export interface RandomSource { next(): number }

/** mulberry32：状態は GameState.rng に保存する */
export function stateRng(holder: { rng: number }): RandomSource {
  return {
    next() {
      holder.rng = (holder.rng + 0x6d2b79f5) | 0;
      let t = holder.rng;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

/** 与えた列を順番に返す（尽きたら最後の値を繰り返す）。テスト用 */
export function fixedRng(values: number[]): RandomSource {
  let i = 0;
  return { next: () => values[Math.min(i++, values.length - 1)] };
}

export const randInt = (r: RandomSource, min: number, max: number): number => min + Math.floor(r.next() * (max - min + 1));
export function pick<T>(r: RandomSource, arr: T[]): T { return arr[Math.floor(r.next() * arr.length)]; }
