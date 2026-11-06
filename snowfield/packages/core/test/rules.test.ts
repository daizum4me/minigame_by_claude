import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, tempLoss, fireDecay, warmAmount, buildingMaxHp, drawWeather, fixedRng, isInsulated } from '../src';
import type { Building } from '../src';

describe('体温低下（手番終了時）', () => {
  it('焚き火：基本0＋補正そのまま', () => {
    expect(tempLoss('fire', 'clear')).toBe(0);
    expect(tempLoss('fire', 'snow')).toBe(1);
    expect(tempLoss('fire', 'blizzard')).toBe(2);
    expect(tempLoss('fire', 'final')).toBe(4);
  });
  it('防寒建物：基本1、補正は最大2まで軽減（最終猛吹雪は合計3）', () => {
    expect(tempLoss('insulated', 'clear')).toBe(1);
    expect(tempLoss('insulated', 'snow')).toBe(1);
    expect(tempLoss('insulated', 'blizzard')).toBe(1);
    expect(tempLoss('insulated', 'final')).toBe(3);
  });
  it('屋外：基本2＋補正そのまま', () => {
    expect(tempLoss('outdoor', 'clear')).toBe(2);
    expect(tempLoss('outdoor', 'snow')).toBe(3);
    expect(tempLoss('outdoor', 'blizzard')).toBe(4);
    expect(tempLoss('outdoor', 'final')).toBe(6);
  });
  it('雨は体温補正なし', () => {
    expect(tempLoss('outdoor', 'rain')).toBe(2);
    expect(tempLoss('fire', 'rain')).toBe(0);
  });
});

describe('その他の計算', () => {
  it('焚き火の火力低下：通常1、雨は2', () => {
    expect(fireDecay('clear')).toBe(1);
    expect(fireDecay('rain')).toBe(2);
  });
  it('温まる：焚き火は火力、防寒建物は+1、屋外は0', () => {
    expect(warmAmount('fire', 4)).toBe(4);
    expect(warmAmount('insulated', 4)).toBe(1);
    expect(warmAmount('outdoor', 4)).toBe(0);
  });
  it('建物の最大HP＝一辺×2', () => {
    expect(buildingMaxHp(2)).toBe(4);
    expect(buildingMaxHp(4)).toBe(8);
  });
  it('防寒はHPが最大の半分を超えている間だけ有効', () => {
    const mk = (hp: number): Building => ({ id: 1, t: 'igloo', x: 0, y: 0, w: 2, h: 2, hp, max: 4 });
    expect(isInsulated(mk(4))).toBe(true);
    expect(isInsulated(mk(3))).toBe(true);
    expect(isInsulated(mk(2))).toBe(false);
    expect(isInsulated({ ...mk(8), t: 'tower' })).toBe(false);
  });
  it('天候の抽選は重みに従う（乱数を差し替え可能）', () => {
    const cfg = { ...DEFAULT_CONFIG, weatherWeights: { clear: 1, snow: 1, blizzard: 1, rain: 1, final: 1 } };
    expect(drawWeather(cfg, fixedRng([0.0]))).toBe('clear');
    expect(drawWeather(cfg, fixedRng([0.99]))).toBe('final');
  });
});
