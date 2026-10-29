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
];

function newGame(n, seed) { return E.createGame(PLAYERS.slice(0, n), seeded(seed || 1)); }
const cur = g => E.current(g).id;
const P = (g, id) => g.players.find(p => p.id === id);

// 盤面を空にして、自分で決めた配置にする
function setCell(g, q, r, props) { Object.assign(g.board[E.key(q, r)], { owner: null, strong: false, core: false, terrain: 'plain' }, props); }

test('人数ごとの盤面の大きさ', () => {
  for (const [n, cells] of [[2, 61], [3, 91], [4, 127]]) {
    const g = newGame(n);
    assert.strictEqual(Object.keys(g.board).length, cells);
    assert.strictEqual(g.radius, E.RULES.radius[n]);
  }
});

test('コアは外周寄りで等間隔、周囲1マスは平原', () => {
  for (const n of [2, 3, 4]) {
    const g = newGame(n, 7);
    const cores = g.players.map(p => E.parseKey(p.core));
    for (const c of cores) {
      assert.strictEqual(E.dist(c, [0, 0]), g.radius - 1);
      assert.strictEqual(g.board[E.key(...c)].terrain, 'plain');
      for (const [q, r] of E.neighbors(...c)) assert.strictEqual(g.board[E.key(q, r)].terrain, 'plain');
    }
    // 隣どうしのコアの距離がほぼ等しい
    const ds = cores.map((c, i) => E.dist(c, cores[(i + 1) % n]));
    assert.ok(Math.max(...ds) - Math.min(...ds) <= 2, ds.join(','));
  }
});

test('地形はおおよそ 6:2:2', () => {
  const g = newGame(4, 3);
  const cnt = { plain: 0, mountain: 0, mine: 0 };
  Object.values(g.board).forEach(c => cnt[c.terrain]++);
  assert.ok(cnt.mountain >= 20 && cnt.mine >= 20, JSON.stringify(cnt));
});

test('初期状態：資源3・攻撃防御0・コア未強化', () => {
  const g = newGame(3);
  for (const p of g.players) {
    assert.deepStrictEqual([p.resource, p.attack, p.defense, p.alive], [3, 0, 0, true]);
    const c = g.board[p.core];
    assert.ok(c.core && !c.strong && c.owner === p.id);
  }
  assert.strictEqual(g.round, 1);
  assert.strictEqual(g.actionsLeft, 3);
});

test('拡張：隣接する空きマスだけ、山岳はコスト2で防御+1', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  const [nq, nr] = E.neighbors(cq, cr)[0];
  // 離れたマスは不可
  const far = Object.values(g.board).find(c => !c.owner && E.dist([c.q, c.r], [cq, cr]) >= 3);
  assert.strictEqual(E.apply(g, me, { type: 'expand', q: far.q, r: far.r }).ok, false);
  assert.ok(E.apply(g, me, { type: 'expand', q: nq, r: nr }).ok);
  assert.strictEqual(P(g, me).resource, 2);
  assert.strictEqual(g.actionsLeft, 2);
  // 山岳マス
  const [mq, mr] = E.neighbors(nq, nr).find(([q, r]) => g.board[E.key(q, r)] && !g.board[E.key(q, r)].owner);
  g.board[E.key(mq, mr)].terrain = 'mountain';
  assert.ok(E.apply(g, me, { type: 'expand', q: mq, r: mr }).ok);
  assert.strictEqual(P(g, me).resource, 0);
  assert.strictEqual(P(g, me).defense, 1);
});

test('行動は最大3回、資源不足は不可、他人の手番は不可', () => {
  const g = newGame(2);
  const me = cur(g), other = g.players.find(p => p.id !== me).id;
  P(g, me).resource = 20;
  assert.strictEqual(E.apply(g, other, { type: 'reinforce' }).ok, false);
  for (let i = 0; i < 3; i++) assert.ok(E.apply(g, me, { type: 'reinforce' }).ok);
  assert.strictEqual(E.apply(g, me, { type: 'reinforce' }).ok, false);
  assert.strictEqual(P(g, me).defense, 3);
  assert.strictEqual(P(g, me).resource, 14);
  E.apply(g, me, { type: 'endTurn' });
  P(g, other).resource = 1;
  const r = E.apply(g, other, { type: 'reinforce' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /資源/);
});

test('強化：攻撃+1、山岳なら防御+1も。強化済は再強化不可', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  P(g, me).resource = 10;
  assert.ok(E.apply(g, me, { type: 'strengthen', q: cq, r: cr }).ok);
  assert.deepStrictEqual([P(g, me).attack, P(g, me).defense, P(g, me).resource], [1, 0, 8]);
  assert.strictEqual(E.apply(g, me, { type: 'strengthen', q: cq, r: cr }).ok, false);
  const [nq, nr] = E.neighbors(cq, cr)[1];
  setCell(g, nq, nr, { owner: me, terrain: 'mountain' });
  assert.ok(E.apply(g, me, { type: 'strengthen', q: nq, r: nr }).ok);
  assert.deepStrictEqual([P(g, me).attack, P(g, me).defense], [2, 1]);
});

test('ターン終了時の資源：強化済+1、鉱山+1、コア+2（強化済コアは+1も）', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  assert.strictEqual(E.income(g, me), 2);
  const ns = E.neighbors(cq, cr);
  setCell(g, ...ns[0], { owner: me });                       // 未強化：0
  setCell(g, ...ns[1], { owner: me, strong: true });         // 強化済：+1
  setCell(g, ...ns[2], { owner: me, strong: true, terrain: 'mine' }); // 鉱山の強化済：+2
  setCell(g, ...ns[3], { owner: me, terrain: 'mine' });      // 鉱山の未強化：0
  assert.strictEqual(E.income(g, me), 2 + 1 + 2);
  g.board[P(g, me).core].strong = true;
  assert.strictEqual(E.income(g, me), 3 + 1 + 2);
  const before = P(g, me).resource;
  E.apply(g, me, { type: 'endTurn' });
  assert.strictEqual(P(g, me).resource, before + 6);
  assert.notStrictEqual(cur(g), me);
});

// 2人を隣り合わせにした盤面を作る
function clashSetup() {
  const g = newGame(2);
  const a = cur(g), b = g.players.find(p => p.id !== a).id;
  const [cq, cr] = E.parseKey(P(g, a).core);
  const [tq, tr] = E.neighbors(cq, cr)[0];
  setCell(g, tq, tr, { owner: b });
  P(g, a).resource = 10;
  return { g, a, b, t: E.key(tq, tr), tq, tr };
}

test('破壊：防御トークンがなければそのまま成功、空きマスに戻る', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.strictEqual(g.pending, null);
  assert.strictEqual(g.board[t].owner, null);
  assert.strictEqual(P(g, a).resource, 9);
  assert.ok(P(g, b).alive);
});

test('破壊：防御を出さなければ成功', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  P(g, b).defense = 2;
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  assert.strictEqual(g.pending.stage, 'defend');
  assert.strictEqual(E.waitingFor(g), b);
  // 攻防中は他の行動はできない
  assert.strictEqual(E.apply(g, a, { type: 'reinforce' }).ok, false);
  assert.ok(E.apply(g, b, { type: 'defend', use: false }).ok);
  assert.strictEqual(g.board[t].owner, null);
  assert.strictEqual(P(g, b).defense, 2);
});

test('破壊：防御→攻撃→防御→諦める、出したトークンはすべて消費', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  P(g, b).defense = 2;
  P(g, a).attack = 3;
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  assert.strictEqual(E.apply(g, a, { type: 'attack', use: true }).ok, false); // まだ防御側の番
  E.apply(g, b, { type: 'defend', use: true });
  assert.strictEqual(g.pending.stage, 'attack');
  E.apply(g, a, { type: 'attack', use: true });
  assert.strictEqual(g.pending.stage, 'defend');
  E.apply(g, b, { type: 'defend', use: true });
  E.apply(g, a, { type: 'attack', use: false });
  assert.strictEqual(g.pending, null);
  assert.strictEqual(g.board[t].owner, b);
  assert.deepStrictEqual([P(g, a).attack, P(g, b).defense], [2, 0]);
  assert.deepStrictEqual([g.lastClash.def, g.lastClash.atk, g.lastClash.success], [2, 1, false]);
  assert.strictEqual(P(g, a).resource, 9); // 失敗しても資源は戻らない
});

test('破壊：攻撃トークンがなければ防御された時点で失敗、防御が尽きれば成功', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  P(g, b).defense = 1;
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  E.apply(g, b, { type: 'defend', use: true });
  assert.strictEqual(g.pending, null);
  assert.strictEqual(g.board[t].owner, b);
  // 2回目：攻撃トークンで防御を破り、防御が0なら自動で成功
  P(g, b).defense = 1;
  P(g, a).attack = 1;
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  E.apply(g, b, { type: 'defend', use: true });
  E.apply(g, a, { type: 'attack', use: true });
  assert.strictEqual(g.pending, null);
  assert.strictEqual(g.board[t].owner, null);
});

test('コアを破壊すると脱落、セルとトークンが消えて手番が飛ばされる、最後の1人が勝利', () => {
  const g = newGame(3);
  const [a, b, c] = g.players.map(p => p.id);
  const bc = E.parseKey(P(g, b).core);
  const [nq, nr] = E.neighbors(...bc)[0];
  setCell(g, nq, nr, { owner: a });
  const [oq, or] = E.neighbors(...bc)[3];
  setCell(g, oq, or, { owner: b, strong: true });
  P(g, b).resource = 5; P(g, b).attack = 2;
  E.apply(g, a, { type: 'destroy', q: bc[0], r: bc[1] });
  assert.strictEqual(P(g, b).alive, false);
  assert.strictEqual(E.cellsOf(g, b).length, 0);
  assert.deepStrictEqual([P(g, b).resource, P(g, b).attack], [0, 0]);
  E.apply(g, a, { type: 'endTurn' });
  assert.strictEqual(cur(g), c);
  E.apply(g, c, { type: 'endTurn' });
  assert.strictEqual(cur(g), a);
  assert.strictEqual(g.round, 2);
  // c のコアも破壊
  const cc = E.parseKey(P(g, c).core);
  const [mq, mr] = E.neighbors(...cc)[0];
  setCell(g, mq, mr, { owner: a });
  E.apply(g, a, { type: 'destroy', q: cc[0], r: cc[1] });
  assert.ok(g.over);
  assert.deepStrictEqual(g.winners, [a]);
  assert.strictEqual(E.apply(g, a, { type: 'endTurn' }).ok, false);
});

test('12ラウンド終了でセルの多い人の勝利、同数は同率優勝', () => {
  const g = newGame(2);
  const [a, b] = g.players.map(p => p.id);
  for (let i = 0; i < 24; i++) {
    assert.strictEqual(g.over, false, `round ${g.round}`);
    E.apply(g, cur(g), { type: 'endTurn' });
  }
  assert.ok(g.over);
  assert.strictEqual(g.round, 12);
  assert.deepStrictEqual(g.winners.sort(), [a, b].sort());

  const h = newGame(2, 5);
  const ha = cur(h);
  const [hq, hr] = E.neighbors(...E.parseKey(P(h, ha).core))[0];
  E.apply(h, ha, { type: 'expand', q: hq, r: hr });
  for (let i = 0; i < 24; i++) E.apply(h, cur(h), { type: 'endTurn' });
  assert.deepStrictEqual(h.winners, [ha]);
});

test('対象マスの一覧', () => {
  const { g, a, t } = clashSetup();
  assert.ok(E.targets(g, a, 'destroy').includes(t));
  assert.ok(!E.targets(g, a, 'expand').includes(t));
  assert.deepStrictEqual(E.targets(g, a, 'strengthen'), [P(g, a).core]);
  P(g, a).resource = 1;
  assert.deepStrictEqual(E.targets(g, a, 'strengthen'), []);
});

test('途中で脱落させる（切断）', () => {
  const g = newGame(3);
  const [a, b] = g.players.map(p => p.id);
  E.forfeit(g, a);
  assert.strictEqual(P(g, a).alive, false);
  assert.strictEqual(cur(g), b);
  assert.strictEqual(g.actionsLeft, 3);
});
