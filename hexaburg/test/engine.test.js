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
const NOB = () => 0.99;   // おまけが出ない乱数
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

test('拡張：隣接する空きマスに、資源1・行動力1。ない行動はできない', () => {
  const { g, a, b } = rtGame();
  const [q, r] = freeNext(g, a);
  assert.ok(E.targets(g, a, 'expand').includes(E.key(q, r)));
  assert.strictEqual(E.apply(g, a, { type: 'expand', q: 0, r: 0 }).ok, false);   // 離れたマス
  assert.ok(E.apply(g, a, { type: 'expand', q, r }).ok);
  assert.deepStrictEqual([P(g, a).resource, P(g, a).ap, g.board[E.key(q, r)].owner], [9, 2, a]);
  assert.strictEqual(E.apply(g, b, { type: 'expand', q, r }).ok, false);         // 相手のマスには置けない
  for (const t of ['strengthen', 'destroy', 'fortify', 'develop']) assert.strictEqual(E.apply(g, a, { type: t, q, r }).ok, false);
  P(g, a).ap = 0;
  assert.match(E.actionBlocked(g, a, 'expand'), /行動力/);
  P(g, a).ap = 3; P(g, a).resource = 0;
  assert.match(E.actionBlocked(g, a, 'expand'), /資源/);
});

test('行動力は5秒に1回復（上限5）。ターンの終わりに全員いっせいに資源（コア +2）。決まった回数で終わる', () => {
  const { g, a } = rtGame();
  P(g, a).ap = 0;
  for (let i = 0; i < 8; i++) E.rtRegen(g);
  assert.strictEqual(P(g, a).ap, 5);
  E.rtTick(g, NOB);
  assert.deepStrictEqual([g.round, P(g, a).resource, g.tickInfo[a].resource], [1, 12, 2]);
  for (let i = 1; i < g.rounds; i++) E.rtTick(g, NOB);
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
  for (let i = 0; i < g.rounds; i++) E.rtTick(g, NOB);
  assert.deepStrictEqual(g.winners, [b]);
  const h = rtGame(2);
  for (let i = 0; i < h.g.rounds; i++) E.rtTick(h.g, NOB);
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
  E.rtTick(g, NOB);
  assert.deepStrictEqual(g.players.map(p => !!p.ready), [false, false]);
  assert.strictEqual(E.hasMoves(g, a), true);                        // 行動力がなくても、回復すれば拡張できる
  P(g, a).resource = 0;
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

// ---------- 狙い・攻撃・反撃 ----------

// a のコアの隣に b のセル t を置き、t の周りに a のセルを並べる（a のセルは t を狙える）
function battle(seed) {
  const { g, a, b } = rtGame(seed);
  const set = (k, owner) => Object.assign(g.board[k], { owner, hp: E.RULES.hp, aim: null, aimRound: -1 });
  const [cq, cr] = E.parseKey(P(g, a).core);
  const tk = E.key(...freeNext(g, a));
  set(tk, b);
  const [tq, tr] = E.parseKey(tk);
  const mine = [P(g, a).core, ...nb(g, tq, tr).map(([q, r]) => E.key(q, r)).filter(k => !g.board[k].owner).slice(0, 3)];
  mine.slice(1).forEach(k => set(k, a));
  return { g, a, b, tk, mine };
}

test('狙い：自分のセルから隣の相手のセルを狙う（行動力を使わない）。ひとつのセルの狙いは1ターンに1回だけ決めたり変えたりできる', () => {
  const { g, a, b, tk, mine } = battle();
  const [q, r] = E.parseKey(mine[0]);
  P(g, a).ap = 0;
  assert.ok(E.apply(g, a, { type: 'aim', q, r, to: tk }).ok);
  assert.strictEqual(g.board[mine[0]].aim, tk);
  assert.strictEqual(P(g, a).ap, 0);
  assert.match(E.apply(g, a, { type: 'unaim', q, r }).error, /このターンはもう/);    // 同じターンにもう一度は不可
  assert.strictEqual(E.apply(g, a, { type: 'aim', q: 0, r: 0, to: tk }).ok, false);  // 自分のセルではない
  const [bq, br] = E.parseKey(tk);
  assert.strictEqual(E.apply(g, b, { type: 'aim', q: bq, r: br, to: '0,0' }).ok, false);   // 隣の相手のセルではない
  E.rtTick(g, NOB);
  assert.ok(E.apply(g, a, { type: 'unaim', q, r }).ok);                              // 次のターンなら変えられる
  assert.strictEqual(g.board[mine[0]].aim, null);
});

test('攻撃：戦力 2 で、狙っている自分のセルの数 n だけ体力を減らす（行動力1）。体力が0になると壊れて空きマスに戻り、狙いも消える', () => {
  const { g, a, b, tk, mine } = battle();
  P(g, a).power = 30; P(g, a).ap = 5;
  assert.strictEqual(E.apply(g, a, { type: 'attack', ...Object.fromEntries(['q', 'r'].map((x, i) => [x, E.parseKey(tk)[i]])) }).ok, false);   // まだ狙っていない
  for (const k of mine) { const [q, r] = E.parseKey(k); assert.ok(E.apply(g, a, { type: 'aim', q, r, to: tk }).ok); }
  assert.deepStrictEqual(E.attackInfo(g, a, tk), { n: mine.length, cost: 2 });
  const [tq, tr] = E.parseKey(tk);
  assert.ok(E.apply(g, a, { type: 'attack', q: tq, r: tr }).ok);
  assert.deepStrictEqual([g.board[tk].hp, P(g, a).power, P(g, a).ap], [6 - mine.length, 28, 4]);
  assert.ok(E.apply(g, a, { type: 'attack', q: tq, r: tr }).ok);
  assert.deepStrictEqual([g.board[tk].owner, g.board[tk].hp], [null, 0]);              // 壊れて空きマスに
  assert.ok(mine.every(k => g.board[k].aim === null));                                 // 狙いも消える
  assert.ok(g.log.some(l => /が壊れた/.test(l.text)));
  assert.strictEqual(g.hits.at(-1).victims[0], b);
});

test('攻撃は狙っているセルが1つでも戦力2（−1）。戦力が足りなければできない', () => {
  const { g, a, tk, mine } = battle(3);
  const [q, r] = E.parseKey(mine[0]);
  E.apply(g, a, { type: 'aim', q, r, to: tk });
  assert.deepStrictEqual(E.attackInfo(g, a, tk), { n: 1, cost: 2 });
  P(g, a).power = 1;
  assert.ok(!E.targets(g, a, 'attack').includes(tk));
  P(g, a).power = 2;
  assert.ok(E.targets(g, a, 'attack').includes(tk));
});

test('生産：資源5を行動力1に変える（行動力は使わない）。資源が足りないとき・行動力が満タンのときはできない', () => {
  const { g, a } = rtGame();
  P(g, a).ap = 0; P(g, a).resource = 12;
  assert.ok(E.apply(g, a, { type: 'produce' }).ok);
  assert.deepStrictEqual([P(g, a).resource, P(g, a).ap], [7, 1]);
  P(g, a).resource = 4;
  assert.match(E.apply(g, a, { type: 'produce' }).error, /資源/);
  P(g, a).resource = 20; P(g, a).ap = 5;
  assert.match(E.apply(g, a, { type: 'produce' }).error, /満タン/);
  P(g, a).ap = 4;
  assert.ok(E.apply(g, a, { type: 'produce' }).ok);
  assert.strictEqual(P(g, a).ap, 5);
});

test('反撃：狙ってきている相手のセルが k マスなら、戦力 2k で、その全部の体力を k 減らす（行動力1）', () => {
  const { g, a, b, tk, mine } = battle();
  for (const k of mine) { const [q, r] = E.parseKey(k); E.apply(g, a, { type: 'aim', q, r, to: tk }); }
  const k = mine.length;
  const [tq, tr] = E.parseKey(tk);
  assert.deepStrictEqual([E.counterInfo(g, b, tk).k, E.counterInfo(g, b, tk).cost], [k, 2 * k]);
  P(g, b).power = 2 * k - 1;
  assert.match(E.apply(g, b, { type: 'counter', q: tq, r: tr }).error, /戦力/);
  P(g, b).power = 20;
  assert.ok(E.apply(g, b, { type: 'counter', q: tq, r: tr }).ok);
  assert.deepStrictEqual(mine.map(x => g.board[x].hp), mine.map(() => 6 - k));
  assert.deepStrictEqual([P(g, b).power, P(g, b).ap], [20 - 2 * k, 2]);
  assert.ok(E.apply(g, b, { type: 'counter', q: tq, r: tr }).ok);                     // もう一度で全部壊れる（コアも）
  assert.strictEqual(P(g, a).alive, false);                                           // コアが壊れたので a は脱落
  assert.ok(g.over);
  assert.deepStrictEqual(g.winners, [b]);
  const [cq, cr] = E.parseKey(P(g, b).core);
  assert.strictEqual(E.apply(g, b, { type: 'counter', q: cq, r: cr }).ok, false);     // 狙われていないセルからは反撃できない
});

test('おまけ：ターンの終わりに、セル1つにつき 25% で資源 +1、別に 25% で戦力 +1（両方のこともある）', () => {
  const { g, a } = rtGame();
  const [q, r] = freeNext(g, a);
  E.apply(g, a, { type: 'expand', q, r });                           // a のセルは2つ
  const before = [P(g, a).resource, P(g, a).power];
  // 乱数を順に 0.1（当たり）・0.9（外れ）…と返す：セルごとに 資源・戦力 の順で判定
  const seq = [0.1, 0.1, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9]; let n = 0;
  E.rtTick(g, () => seq[n++ % seq.length]);
  const ti = g.tickInfo[a];
  assert.deepStrictEqual([ti.resource, ti.power], [2 + 1, 3 + 2]);
  assert.deepStrictEqual(ti.bonus.map(b => [b.res, b.pow]), [[1, 1], [0, 1]]);
  assert.deepStrictEqual([P(g, a).resource, P(g, a).power], [before[0] + 3, before[1] + 5]);
  assert.strictEqual(E.bonusExpect(g, a), 0.5);
  E.rtTick(g, NOB);
  assert.deepStrictEqual([g.tickInfo[a].resource, g.tickInfo[a].power, g.tickInfo[a].bonus.length], [2, 3, 0]);
});

test('回復：資源3・行動力1で、体力の減った自分のセル（コアも）の体力を1戻す（最大6）', () => {
  const { g, a, b } = rtGame();
  const core = g.board[P(g, a).core];
  const [cq, cr] = E.parseKey(P(g, a).core);
  assert.strictEqual(E.apply(g, a, { type: 'heal', q: cq, r: cr }).ok, false);       // 体力が満タンなら不可
  core.hp = 4;
  assert.ok(E.apply(g, a, { type: 'heal', q: cq, r: cr }).ok);
  assert.deepStrictEqual([core.hp, P(g, a).resource, P(g, a).ap], [5, 7, 2]);
  const bc = g.board[P(g, b).core]; bc.hp = 3;
  assert.strictEqual(E.apply(g, a, { type: 'heal', q: bc.q, r: bc.r }).ok, false);   // 相手のセルは不可
  P(g, a).resource = 2;
  assert.match(E.apply(g, a, { type: 'heal', q: cq, r: cr }).error, /資源/);
  P(g, a).resource = 3; P(g, a).ap = 0;
  assert.match(E.apply(g, a, { type: 'heal', q: cq, r: cr }).error, /行動力/);
});

test('コアが壊れたら脱落し、残りのセルは空きマスに。資源と戦力は壊した人が受け継ぐ。戦力はターンごとに +3', () => {
  const g = newGame(3);
  const [a, b] = g.players.map(p => p.id);
  const bc = g.board[P(g, b).core];
  const [nq, nr] = nb(g, bc.q, bc.r).find(([q, r]) => !g.board[E.key(q, r)].owner);
  Object.assign(g.board[E.key(nq, nr)], { owner: a, hp: 6 });
  P(g, a).power = 50; P(g, a).ap = 5; P(g, b).resource = 7; P(g, b).power = 4;
  E.apply(g, a, { type: 'aim', q: nq, r: nr, to: P(g, b).core });
  for (let i = 0; i < 5; i++) { P(g, a).ap = 5; E.apply(g, a, { type: 'attack', q: bc.q, r: bc.r }); }
  assert.strictEqual(bc.hp, 1);
  P(g, a).ap = 5;
  assert.ok(E.apply(g, a, { type: 'attack', q: bc.q, r: bc.r }).ok);
  assert.strictEqual(P(g, b).alive, false);
  assert.deepStrictEqual(E.cellsOf(g, b), []);
  assert.deepStrictEqual([P(g, a).resource, P(g, a).power], [10 + 7, 50 - 12 + 4]);
  const before = P(g, a).power;
  E.rtTick(g, NOB);
  assert.strictEqual(P(g, a).power, before + 3);
});
