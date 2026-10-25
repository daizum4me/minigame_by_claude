'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../shared/config');
const E = require('../shared/engine');

const settings = (over) => C.normalizeSettings(over || {});
const always = v => () => v;          // 一定の乱数（0.999…なら奪取は常に最大）
const MAX = always(0.999999);

function pl(id, candy, choice, extra) {
  return Object.assign({ id, candy, choice, mission: null, missionFrom: 1, lastGot: null }, extra || {});
}

function resolve(houses, players, opts) {
  return E.resolveRound(Object.assign({ settings: settings(), houses, players, round: 1, rng: MAX }, opts || {}));
}

test('1人だけで訪問：状態どおりにもらえる', () => {
  const houses = [{ amount: 3, state: 'normal' }, { amount: 2, state: 'rich' }, { amount: 7, state: 'away' }, { amount: 1, state: 'witch' }];
  const r = resolve(houses, [pl('a', 6, 0), pl('b', 0, 1), pl('c', 0, 2), pl('d', 0, 3)]);
  assert.equal(r.perPlayer.a.newCandy, 9);
  assert.equal(r.perPlayer.b.newCandy, 7);     // 2 + 5
  assert.equal(r.perPlayer.c.newCandy, 0);
  assert.equal(r.perPlayer.d.newCandy, 0);     // −5 でも0で止まる
  assert.equal(r.perPlayer.d.clampFix, 5);
  assert.equal(r.perPlayer.a.gotCandy, true);
  assert.equal(r.perPlayer.c.gotCandy, false);
});

test('衝突：誰ももらえない。訪問された家だけ状態を公開', () => {
  const houses = [{ amount: 7, state: 'rich' }, { amount: 1, state: 'normal' }, { amount: 2, state: 'away' }];
  const r = resolve(houses, [pl('a', 0, 0), pl('b', 0, 0), pl('c', 0, 1)]);
  assert.equal(r.perPlayer.a.newCandy, 0);
  assert.equal(r.perPlayer.b.newCandy, 0);
  assert.equal(r.perPlayer.c.newCandy, 1);
  assert.deepEqual(r.collided, [true, false, false]);
  assert.deepEqual(r.revealed, ['rich', 'normal', null]);
});

test('魔女で衝突：全員 −5。先頭の残りが0なら奪えない', () => {
  const houses = [{ amount: 3, state: 'witch' }, { amount: 1, state: 'normal' }];
  const r = resolve(houses, [pl('a', 3, 0), pl('b', 1, 0), pl('c', 0, 1)]);
  assert.deepEqual(r.leaders, ['a']);
  assert.equal(r.perPlayer.a.houseDelta, -5);
  assert.equal(r.perPlayer.b.houseDelta, -5);
  assert.equal(r.perPlayer.b.steal, 0);
  assert.equal(r.perPlayer.a.newCandy, 0);
  assert.equal(r.perPlayer.b.newCandy, 0);
});

test('魔女で衝突しても奪取は起きる（−5の後に残った分から奪う）', () => {
  const houses = [{ amount: 3, state: 'witch' }];
  const r = resolve(houses, [pl('lead', 6, 0), pl('x', 2, 0)]);
  // 先頭の残り = 6 − 5 = 1 → 最大2のところ1しか奪えない
  assert.equal(r.perPlayer.x.steal, 1);
  assert.equal(r.perPlayer.lead.steal, -1);
  assert.equal(r.perPlayer.lead.newCandy, 0);
  // x: 2 − 5 + 1 = −2 → 合計してから0にする
  assert.equal(r.perPlayer.x.newCandy, 0);
  assert.equal(r.perPlayer.x.clampFix, 2);
});

test('先頭が複数：先頭以外は先頭ごとに奪う。先頭同士では奪わない', () => {
  const houses = [{ amount: 3, state: 'normal' }];
  const r = resolve(houses, [pl('a', 5, 0), pl('b', 5, 0), pl('c', 2, 0)]);
  assert.deepEqual(r.leaders.sort(), ['a', 'b']);
  assert.equal(r.perPlayer.c.steal, 4);
  assert.equal(r.perPlayer.a.steal, -2);
  assert.equal(r.perPlayer.b.steal, -2);
  assert.equal(r.perPlayer.a.newCandy, 3);
  assert.equal(r.perPlayer.c.newCandy, 6);
  assert.equal(r.thefts.length, 2);
});

test('先頭同士だけの衝突では奪取なし', () => {
  const r = resolve([{ amount: 3, state: 'normal' }], [pl('a', 4, 0), pl('b', 4, 0)]);
  assert.equal(r.perPlayer.a.steal, 0);
  assert.equal(r.perPlayer.b.steal, 0);
  assert.equal(r.thefts.length, 0);
});

test('先頭のお菓子が少なくて奪いきれない', () => {
  const houses = [{ amount: 2, state: 'normal' }];
  const r = resolve(houses, [pl('lead', 3, 0), pl('x', 0, 0), pl('y', 0, 0)]);
  const stolen = r.perPlayer.x.steal + r.perPlayer.y.steal;
  assert.equal(stolen, 3);                          // 2 + 2 ほしいが3しかない
  assert.equal(r.perPlayer.lead.newCandy, 0);
  assert.ok(r.perPlayer.x.steal >= 1 && r.perPlayer.y.steal >= 1);
});

test('全員0なら先頭なし・奪取なし', () => {
  const r = resolve([{ amount: 2, state: 'normal' }], [pl('a', 0, 0), pl('b', 0, 0)]);
  assert.deepEqual(r.leaders, []);
  assert.equal(r.thefts.length, 0);
});

test('奪う最大数0なら奪取なし', () => {
  const r = resolve([{ amount: 2, state: 'normal' }], [pl('a', 5, 0), pl('b', 0, 0)], { settings: settings({ stealMax: 0 }) });
  assert.equal(r.perPlayer.b.steal, 0);
});

test('ミッション達成と魔女が同時：ボーナスは加算され、魔女の減算は0で止まる', () => {
  const houses = [{ amount: 3, state: 'normal' }, { amount: 2, state: 'witch' }, { amount: 1, state: 'rich' }];
  const r = resolve(houses, [
    pl('m', 1, 0, { mission: 'amount3' }),
    pl('w', 2, 1, { mission: 'amount2' }),       // 魔女の家は「もらう」に当たらない
    pl('g1', 0, 2, { mission: 'guest' }),        // お金持ちで衝突してもOK
    pl('g2', 0, 2),
  ]);
  assert.equal(r.perPlayer.m.mission, 'amount3');
  assert.equal(r.perPlayer.m.missionBonus, 2);
  assert.equal(r.perPlayer.m.newCandy, 1 + 3 + 2);
  assert.ok(C.missionById(r.perPlayer.m.newMission));
  assert.equal(r.perPlayer.w.mission, null);
  assert.equal(r.perPlayer.w.newCandy, 0);
  assert.equal(r.perPlayer.g1.mission, 'guest');
  assert.equal(r.perPlayer.g1.newCandy, 4);
  // 魔女の家にいる人がボーナスをもらう場合も、合計してから0で止める
  const r2 = resolve([{ amount: 3, state: 'witch' }], [pl('k', 0, 0, { mission: 'guest' })]);
  assert.equal(r2.perPlayer.k.mission, null);
  const r3 = resolve([{ amount: 3, state: 'away' }, { amount: 1, state: 'witch' }], [
    pl('k', 1, 0, { mission: 'keeper' }), pl('z', 1, 0), pl('w', 0, 1),
  ]);
  assert.equal(r3.perPlayer.k.newCandy, 1 + 0 + 4);  // 留守で衝突しても達成
  assert.equal(r3.perPlayer.w.newCandy, 0);
});

test('ミッションなしの設定では判定しない', () => {
  const r = resolve([{ amount: 3, state: 'normal' }], [pl('a', 0, 0, { mission: 'amount3' })], { settings: settings({ missions: false }) });
  assert.equal(r.perPlayer.a.missionBonus, 0);
});

test('常連さん：同じ番号の家で2ラウンド連続。受け取る前のラウンドは数えない', () => {
  const houses = [{ amount: 1, state: 'normal' }, { amount: 2, state: 'normal' }];
  const base = { mission: 'regular', lastGot: { house: 1, round: 2 } };
  let r = resolve(houses, [pl('a', 0, 1, Object.assign({ missionFrom: 1 }, base))], { round: 3 });
  assert.equal(r.perPlayer.a.mission, 'regular');
  r = resolve(houses, [pl('a', 0, 1, Object.assign({ missionFrom: 3 }, base))], { round: 3 });
  assert.equal(r.perPlayer.a.mission, null, '前のラウンドはミッションを持っていなかった');
  r = resolve(houses, [pl('a', 0, 0, Object.assign({ missionFrom: 1 }, base))], { round: 3 });
  assert.equal(r.perPlayer.a.mission, null, '別の家');
  r = resolve(houses, [pl('a', 0, 1, { mission: 'regular', missionFrom: 1, lastGot: { house: 1, round: 1 } })], { round: 3 });
  assert.equal(r.perPlayer.a.mission, null, '連続していない');
  assert.deepEqual(r.perPlayer.a.lastGot, { house: 1, round: 3 });
});

test('お菓子をもらえなかったら記録を空にする', () => {
  const r = resolve([{ amount: 1, state: 'away' }], [pl('a', 0, 0, { lastGot: { house: 0, round: 0 } })]);
  assert.equal(r.perPlayer.a.lastGot, null);
});

test('お菓子の袋：非復元抽出。足りなければもう一組足す', () => {
  const bag = [1, 1, 1, 2, 2, 2, 3, 3, 3, 7];
  for (let k = 0; k < 20; k++) {
    const a = E.drawAmounts(10, bag, Math.random).sort((x, y) => x - y);
    assert.deepEqual(a, bag);
    const b = E.drawAmounts(12, bag, Math.random);
    assert.equal(b.filter(v => v === 7).length >= 1, true);
    assert.ok(b.filter(v => v === 7).length <= 2);
    assert.ok(b.filter(v => v === 1).length <= 5);
  }
});

test('ヒント：人数≧家の数ならどの家も誰かが知っている／人数＜家の数なら重複なし', () => {
  for (let k = 0; k < 50; k++) {
    const h1 = E.dealHints(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 6, Math.random);
    assert.equal(new Set(Object.values(h1)).size, 6);
    const h2 = E.dealHints(['a', 'b', 'c'], 6, Math.random);
    assert.equal(new Set(Object.values(h2)).size, 3);
    Object.values(h2).forEach(v => assert.ok(v >= 0 && v < 6));
  }
});

test('状態の確率', () => {
  const s = settings();
  const n = 20000;
  const count = { normal: 0, rich: 0, away: 0, witch: 0 };
  for (let i = 0; i < n; i++) count[E.drawState(s, Math.random)]++;
  assert.ok(Math.abs(count.normal / n - 0.75) < 0.02);
  assert.ok(Math.abs(count.witch / n - 0.05) < 0.01);
});

test('順位：同点は同順位', () => {
  const ranks = E.rankOf([{ id: 'a', candy: 5 }, { id: 'b', candy: 9 }, { id: 'c', candy: 9 }, { id: 'd', candy: 1 }]);
  assert.deepEqual(ranks, { b: 1, c: 1, a: 3, d: 4 });
});

test('設定の正規化：範囲外は収め、おかしな値は無視', () => {
  const s = C.normalizeSettings({ houses: 99, rounds: 'x', candyBag: '1, 2,abc', probWitch: -3, missions: false });
  assert.equal(s.houses, 12);
  assert.equal(s.rounds, 9);
  assert.deepEqual(s.candyBag, C.DEFAULT_SETTINGS.candyBag);
  assert.equal(s.probWitch, 0);
  assert.equal(s.missions, false);
  assert.deepEqual(C.normalizeSettings({ candyBag: '1,2, 5' }).candyBag, [1, 2, 5]);
});
