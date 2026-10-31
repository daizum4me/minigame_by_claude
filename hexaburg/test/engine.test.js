const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');

// 再現できる乱数
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const PLAYERS = [
  { id: 'a', name: 'A', color: 'red' },
  { id: 'b', name: 'B', color: 'blue' },
  { id: 'c', name: 'C', color: 'green' },
  { id: 'd', name: 'D', color: 'yellow' },
  ...'efghijkl'.split('').map(id => ({ id, name: id.toUpperCase(), color: 'red' })),
];

function newGame(n, seed) { return E.createGame(PLAYERS.slice(0, n), seeded(seed || 1)); }
const P = (g, id) => g.players.find(p => p.id === id);
const nb = (g, q, r) => E.neighbors(q, r).filter(([nq, nr]) => g.board[E.key(nq, nr)]);
const freeNext = (g, id) => nb(g, ...E.parseKey(P(g, id).core)).find(([q, r]) => !g.board[E.key(q, r)].owner);
function rtGame(seed) { const g = newGame(2, seed); const [a, b] = g.players.map(p => p.id); return { g, a, b }; }

test('人数ごとの盤面の大きさ（2〜3人は直径 9・4人は 11・5〜6人は 13）と、大きさの指定。すべて平原（地形・河川なし）', () => {
  for (const [n, cells] of [[2, 61], [3, 61], [4, 91], [6, 127]]) {
    const g = newGame(n);
    assert.strictEqual(Object.keys(g.board).length, cells);
    assert.ok(Object.values(g.board).every(c => !('terrain' in c)));
  }
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 7 });
  assert.strictEqual(Object.keys(g.board).length, 169);
  assert.throws(() => E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 2 }));
  assert.throws(() => E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 11 }));
});

test('コアは一番外側に等間隔、全員同じ条件（隣のマスの数が同じ）。7人以上は約3分の1が内側', () => {
  for (const n of [2, 3, 4]) {
    const g = newGame(n, 7);
    const cores = g.players.map(p => E.parseKey(p.core));
    for (const c of cores) assert.strictEqual(E.dist(c, [0, 0]), g.radius);
    assert.strictEqual(new Set(cores.map(c => nb(g, ...c).length)).size, 1);
  }
  for (const n of [7, 12]) {
    const g = newGame(n);
    const outer = g.players.filter(p => E.dist(E.parseKey(p.core), [0, 0]) === g.radius).length;
    assert.strictEqual(n - outer, Math.floor(n / 3));
  }
  assert.throws(() => E.createGame([...PLAYERS, { id: 'm', name: 'M', color: 'red' }], seeded(1)));   // 13人は不可
});

test('初期状態：資源10・行動力3・コアだけ。ターン数は人数に合わせる（4人まで18・8人まで16・12人まで14）', () => {
  const g = newGame(3);
  for (const p of g.players) {
    assert.deepStrictEqual([p.resource, p.ap, p.alive, E.cellsOf(g, p.id).length], [10, 3, true, 1]);
    assert.ok(g.board[p.core].core);
  }
  assert.deepStrictEqual([E.autoTicks(2), E.autoTicks(8), E.autoTicks(12)], [18, 16, 14]);
  assert.strictEqual(E.createGame(PLAYERS.slice(0, 2), seeded(1), { rounds: 10 }).rounds, 10);
  assert.throws(() => E.createGame(PLAYERS.slice(0, 2), seeded(1), { rounds: 7 }));
});

test('行動は拡張だけ：隣接する空きマスに、資源2・行動力1。ほかの行動はない', () => {
  const { g, a, b } = rtGame();
  const [q, r] = freeNext(g, a);
  assert.ok(E.targets(g, a, 'expand').includes(E.key(q, r)));
  assert.strictEqual(E.apply(g, a, { type: 'expand', q: 0, r: 0 }).ok, false);   // 離れたマス
  assert.ok(E.apply(g, a, { type: 'expand', q, r }).ok);
  assert.deepStrictEqual([P(g, a).resource, P(g, a).ap, g.board[E.key(q, r)].owner], [8, 2, a]);
  assert.strictEqual(E.apply(g, b, { type: 'expand', q, r }).ok, false);         // 相手のマスには置けない
  for (const t of ['strengthen', 'destroy', 'fortify', 'develop', 'produce']) assert.strictEqual(E.apply(g, a, { type: t, q, r }).ok, false);
  P(g, a).ap = 0;
  assert.match(E.actionBlocked(g, a, 'expand'), /行動力/);
  P(g, a).ap = 3; P(g, a).resource = 1;
  assert.match(E.actionBlocked(g, a, 'expand'), /資源/);
});

test('行動力は5秒に1回復（上限5）。ターンの終わりに全員いっせいに資源（コア +2）。決まった回数で終わる', () => {
  const { g, a } = rtGame();
  P(g, a).ap = 0;
  for (let i = 0; i < 8; i++) E.rtRegen(g);
  assert.strictEqual(P(g, a).ap, 5);
  E.rtTick(g);
  assert.deepStrictEqual([g.round, P(g, a).resource, g.tickInfo[a].resource], [1, 12, 2]);
  for (let i = 1; i < g.rounds; i++) E.rtTick(g);
  assert.ok(g.over);
  assert.match(g.endReason, /ターン終了/);
});

test('勝敗はセルの総数ではなく、つながっている一番大きなかたまりで決まる。同じなら同率優勝', () => {
  const { g, a, b } = rtGame();
  const set = (q, r, owner) => { g.board[E.key(q, r)].owner = owner; };
  set(...freeNext(g, b), b);                                         // b：かたまり2
  const lone = () => Object.values(g.board).find(c => !c.owner && !nb(g, c.q, c.r).some(([q, r]) => g.board[E.key(q, r)].owner));
  for (let i = 0; i < 2; i++) { const c = lone(); set(c.q, c.r, a); }   // a：離れたセル（かたまり1・合計3）
  assert.deepStrictEqual([E.cellsOf(g, a).length, E.largestGroup(g, a).length], [3, 1]);
  for (let i = 0; i < g.rounds; i++) E.rtTick(g);
  assert.deepStrictEqual(g.winners, [b]);
  const h = rtGame(2);
  for (let i = 0; i < h.g.rounds; i++) E.rtTick(h.g);
  assert.deepStrictEqual(h.g.winners.sort(), [h.a, h.b].sort());
});

test('行動完了：押すと印がつき、もう一度押すと外れる。ターンが変わると外れる。拡張できなければ hasMoves は false', () => {
  const { g, a, b } = rtGame();
  P(g, a).ap = 0;
  assert.ok(E.apply(g, a, { type: 'ready' }).ok);
  assert.strictEqual(P(g, a).ready, true);
  assert.ok(E.apply(g, a, { type: 'ready' }).ok);
  assert.strictEqual(P(g, a).ready, false);
  E.apply(g, b, { type: 'ready', on: true });
  E.rtTick(g);
  assert.deepStrictEqual(g.players.map(p => !!p.ready), [false, false]);
  assert.strictEqual(E.hasMoves(g, a), true);                        // 行動力がなくても、回復すれば拡張できる
  P(g, a).resource = 1;
  assert.strictEqual(E.hasMoves(g, a), false);                       // 資源が足りない
});

test('途中で脱落させる（切断）：セルは空きマスに戻る。残りが1人なら勝ち', () => {
  const g = newGame(3);
  const [a, b, c] = g.players.map(p => p.id);
  E.forfeit(g, b);
  assert.strictEqual(P(g, b).alive, false);
  assert.deepStrictEqual(E.cellsOf(g, b), []);
  assert.ok(!g.over);
  assert.strictEqual(E.apply(g, b, { type: 'ready' }).ok, false);
  E.forfeit(g, c);
  assert.ok(g.over);
  assert.deepStrictEqual(g.winners, [a]);
});
