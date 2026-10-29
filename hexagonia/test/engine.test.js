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

// 盤面の中にある隣のマス（コアは一番外側にあるので、隣のマスは3〜4つ）
const nb = (g, q, r) => E.neighbors(q, r).filter(([nq, nr]) => g.board[E.key(nq, nr)]);

// 盤面を空にして、自分で決めた配置にする
function setCell(g, q, r, props) { Object.assign(g.board[E.key(q, r)], { owner: null, strong: false, core: false, terrain: 'plain' }, props); }

test('人数ごとの盤面の大きさ（直径 7・9・11）と、大きさの指定', () => {
  for (const [n, cells] of [[2, 37], [3, 61], [4, 91]]) {
    const g = newGame(n);
    assert.strictEqual(Object.keys(g.board).length, cells);
    assert.strictEqual(g.radius, E.RULES.radius[n]);
  }
  // 直径 15（半径 7）を指定
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 7 });
  assert.strictEqual(Object.keys(g.board).length, 169);
  assert.strictEqual(g.radius, 7);
  assert.throws(() => E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 2 }));
  assert.throws(() => E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 8 }));
});

test('コアは一番外側に等間隔、全員同じ条件（隣のマスの数が同じ）、周囲1マスは平原', () => {
  for (const n of [2, 3, 4]) {
    const g = newGame(n, 7);
    const cores = g.players.map(p => E.parseKey(p.core));
    for (const c of cores) {
      assert.strictEqual(E.dist(c, [0, 0]), g.radius);
      assert.strictEqual(g.board[E.key(...c)].terrain, 'plain');
      for (const [q, r] of nb(g, ...c)) assert.strictEqual(g.board[E.key(q, r)].terrain, 'plain');
    }
    assert.strictEqual(new Set(cores.map(c => nb(g, ...c).length)).size, 1);
    // 隣どうしのコアの距離がほぼ等しい
    const ds = cores.map((c, i) => E.dist(c, cores[(i + 1) % n]));
    assert.ok(Math.max(...ds) - Math.min(...ds) <= 2, ds.join(','));
  }
});

test('地形はおおよそ 70%：15%：15%', () => {
  const g = newGame(4, 3);
  const cnt = { plain: 0, mountain: 0, mine: 0 };
  Object.values(g.board).forEach(c => cnt[c.terrain]++);
  // コアとその周りのマスは平原。残りのマスの15%ずつ
  const fixed = g.players.reduce((n, p) => n + 1 + nb(g, ...E.parseKey(p.core)).length, 0);
  const free = Object.keys(g.board).length - fixed;
  assert.deepStrictEqual([cnt.mountain, cnt.mine], [Math.round(free * 0.15), Math.round(free * 0.15)], JSON.stringify(cnt));
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
  const [nq, nr] = nb(g, cq, cr)[0];
  P(g, me).resource = 4;   // 資源が尽きると自動で手番が終わるので、少し多めに
  // 離れたマスは不可
  const far = Object.values(g.board).find(c => !c.owner && E.dist([c.q, c.r], [cq, cr]) >= 3);
  assert.strictEqual(E.apply(g, me, { type: 'expand', q: far.q, r: far.r }).ok, false);
  assert.ok(E.apply(g, me, { type: 'expand', q: nq, r: nr }).ok);
  assert.strictEqual(P(g, me).resource, 3);
  assert.strictEqual(g.actionsLeft, 2);
  // 山岳マス
  const [mq, mr] = E.neighbors(nq, nr).find(([q, r]) => g.board[E.key(q, r)] && !g.board[E.key(q, r)].owner);
  g.board[E.key(mq, mr)].terrain = 'mountain';
  assert.ok(E.apply(g, me, { type: 'expand', q: mq, r: mr }).ok);
  assert.strictEqual(P(g, me).resource, 1);
  assert.strictEqual(P(g, me).defense, 1);
});

test('行動は最大3回、資源不足は不可、他人の手番は不可', () => {
  const g = newGame(2);
  const me = cur(g), other = g.players.find(p => p.id !== me).id;
  P(g, me).resource = 20;
  assert.strictEqual(E.apply(g, other, { type: 'reinforce' }).ok, false);
  for (let i = 0; i < 3; i++) assert.ok(E.apply(g, me, { type: 'reinforce' }).ok);
  assert.strictEqual(E.apply(g, me, { type: 'reinforce' }).ok, false);
  // 補強は防御トークン +1 と攻撃トークン +1
  assert.deepStrictEqual([P(g, me).defense, P(g, me).attack], [3, 3]);
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
  const [nq, nr] = nb(g, cq, cr)[1];
  setCell(g, nq, nr, { owner: me, terrain: 'mountain' });
  assert.ok(E.apply(g, me, { type: 'strengthen', q: nq, r: nr }).ok);
  assert.deepStrictEqual([P(g, me).attack, P(g, me).defense], [2, 1]);
});

test('ターン終了時の資源：強化済+1、鉱山+1、コア+2（強化済コアは+1も）', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  assert.strictEqual(E.income(g, me), 2);
  const ns = nb(g, cq, cr);
  setCell(g, ...ns[0], { owner: me });                       // 未強化：0
  setCell(g, ...ns[1], { owner: me, strong: true });         // 強化済：+1
  setCell(g, ...ns[2], { owner: me, strong: true, terrain: 'mine' }); // 鉱山の強化済：+2
  setCell(g, 0, 0, { owner: me, terrain: 'mine' });          // 鉱山の未強化：0
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
  const [tq, tr] = nb(g, cq, cr)[0];
  setCell(g, tq, tr, { owner: b });
  P(g, a).resource = 10;
  return { g, a, b, t: E.key(tq, tr), tq, tr };
}

test('破壊：防御トークンがなければそのまま成功、そのマスが攻撃側のセルになる', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.strictEqual(g.pending, null);
  assert.deepStrictEqual([g.board[t].owner, g.board[t].strong], [a, false]);
  assert.strictEqual(P(g, a).resource, 9);
  assert.strictEqual(g.actionsLeft, 2); // そのまま拡張しても行動回数は減らない
  assert.ok(P(g, b).alive);
});

test('破壊で取った山岳マスは防御トークン +1', () => {
  const { g, a, t, tq, tr } = clashSetup();
  g.board[t].terrain = 'mountain';
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  assert.strictEqual(g.board[t].owner, a);
  assert.strictEqual(P(g, a).defense, 1);
});

test('破壊：出す数を伏せて決め、そろったら公開。攻撃 ≧ 防御なら成功', () => {
  for (const [atk, def, ok] of [[2, 1, true], [1, 1, true], [0, 0, true], [1, 2, false], [0, 1, false]]) {
    const { g, a, b, t, tq, tr } = clashSetup();
    P(g, a).attack = 3;
    P(g, b).defense = 2;
    E.apply(g, a, { type: 'destroy', q: tq, r: tr });
    assert.deepStrictEqual(E.waiting(g).sort(), [a, b].sort());
    // 攻防中は他の行動はできない
    assert.strictEqual(E.apply(g, a, { type: 'reinforce' }).ok, false);
    // 持っている数より多くは出せない・2回は決められない
    assert.strictEqual(E.apply(g, b, { type: 'bid', count: 3 }).ok, false);
    assert.ok(E.apply(g, b, { type: 'bid', count: def }).ok);
    assert.strictEqual(E.apply(g, b, { type: 'bid', count: 0 }).ok, false);
    assert.deepStrictEqual(E.waiting(g), [a]);
    assert.strictEqual(P(g, b).defense, 2); // 公開まではまだ減らない
    assert.ok(E.apply(g, a, { type: 'bid', count: atk }).ok);
    assert.strictEqual(g.pending, null);
    assert.strictEqual(g.board[t].owner, ok ? a : b, `${atk} vs ${def}`);
    // 出したトークンはすべてなくなる
    assert.deepStrictEqual([P(g, a).attack, P(g, b).defense], [3 - atk, 2 - def]);
    assert.deepStrictEqual([g.lastClash.atk, g.lastClash.def, g.lastClash.success], [atk, def, ok]);
    assert.strictEqual(P(g, a).resource, 9); // 失敗しても資源は戻らない
  }
});

test('破壊：攻撃トークンがなければ攻撃側は 0 個に決まり、防御側だけが選ぶ', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  P(g, b).defense = 1;
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  assert.deepStrictEqual(E.waiting(g), [b]);
  E.apply(g, b, { type: 'bid', count: 1 });
  assert.strictEqual(g.board[t].owner, b);
  assert.strictEqual(P(g, b).defense, 0);
});

test('コアを破壊すると脱落、セルとトークンが消えて手番が飛ばされる、最後の1人が勝利', () => {
  const g = newGame(3);
  const [a, b, c] = g.players.map(p => p.id);
  const bc = E.parseKey(P(g, b).core);
  const [nq, nr] = nb(g, ...bc)[0];
  setCell(g, nq, nr, { owner: a });
  const [oq, or] = nb(g, ...bc).at(-1);
  setCell(g, oq, or, { owner: b, strong: true });
  P(g, b).resource = 5; P(g, b).attack = 2;
  P(g, b).coreHp = 1;   // 残り耐久1
  E.apply(g, a, { type: 'destroy', q: bc[0], r: bc[1] });
  assert.strictEqual(P(g, b).alive, false);
  assert.strictEqual(E.cellsOf(g, b).length, 0);
  assert.strictEqual(g.board[E.key(...bc)].owner, a); // コアのマスも攻撃側のセルになる
  assert.strictEqual(g.board[E.key(oq, or)].owner, null);
  assert.deepStrictEqual([P(g, b).resource, P(g, b).attack], [0, 0]);
  E.apply(g, a, { type: 'endTurn' });
  assert.strictEqual(cur(g), c);
  E.apply(g, c, { type: 'endTurn' });
  assert.strictEqual(cur(g), a);
  assert.strictEqual(g.round, 2);
  // c のコアも破壊
  const cc = E.parseKey(P(g, c).core);
  const [mq, mr] = nb(g, ...cc)[0];
  setCell(g, mq, mr, { owner: a });
  P(g, c).coreHp = 1;
  E.apply(g, a, { type: 'destroy', q: cc[0], r: cc[1] });
  assert.ok(g.over);
  assert.deepStrictEqual(g.winners, [a]);
  assert.strictEqual(E.apply(g, a, { type: 'endTurn' }).ok, false);
});

test('12ラウンド終了で一番大きなかたまりが大きい人の勝利、同じなら同率優勝', () => {
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
  const [hq, hr] = nb(h, ...E.parseKey(P(h, ha).core))[0];
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

test('勝敗はセルの総数ではなく、つながっている一番大きなかたまりで決まる', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(4), { radius: 5 });
  const [a, b] = g.players.map(p => p.id);
  const ac = E.parseKey(P(g, a).core), bc = E.parseKey(P(g, b).core);
  // a：コアにつながる2マス＋離れた2マス（総数5・最大のかたまり3）
  const an = nb(g, ...ac);
  setCell(g, ...an[0], { owner: a });
  setCell(g, ...an[1], { owner: a });
  setCell(g, 0, 0, { owner: a });
  setCell(g, 1, 0, { owner: a, terrain: 'plain' });
  // b：コアにつながる3マス（総数4・最大のかたまり4）
  const bn = nb(g, ...bc);
  setCell(g, ...bn[0], { owner: b });
  setCell(g, ...bn[1], { owner: b });
  setCell(g, ...bn[2], { owner: b });
  assert.strictEqual(E.cellsOf(g, a).length, 5);
  assert.strictEqual(E.largestGroup(g, a).length, 3);
  assert.strictEqual(E.largestGroup(g, b).length, 4);
  g.round = 12;
  E.apply(g, cur(g), { type: 'endTurn' });
  E.apply(g, cur(g), { type: 'endTurn' });
  assert.ok(g.over);
  assert.deepStrictEqual(g.winners, [b]);
  assert.match(g.endReason, /最大のかたまり 4 セル/);
});

test('行動回数を使い切ったら、資源を払って行動 +1（6, 10, 14…、手番が変わると 6 に戻る）', () => {
  const g = newGame(2);
  const me = cur(g);
  P(g, me).resource = 100;
  // まだ行動が残っているうちは買えない
  assert.strictEqual(E.apply(g, me, { type: 'buyAction' }).ok, false);
  for (let i = 0; i < 3; i++) E.apply(g, me, { type: 'reinforce' });
  assert.strictEqual(g.actionsLeft, 0);
  assert.strictEqual(P(g, me).resource, 94);
  for (const cost of [6, 10, 14]) {
    assert.strictEqual(E.extraActionCost(g), cost);
    assert.ok(E.apply(g, me, { type: 'buyAction' }).ok);
    assert.strictEqual(g.actionsLeft, 1);
    assert.strictEqual(E.apply(g, me, { type: 'buyAction' }).ok, false); // 1回ずつ
    E.apply(g, me, { type: 'reinforce' });
  }
  assert.strictEqual(P(g, me).resource, 94 - 6 - 10 - 14 - 2 * 3);
  // 資源が足りなければ買えない
  P(g, me).resource = 17;
  const r = E.apply(g, me, { type: 'buyAction' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /資源/);
  E.apply(g, me, { type: 'endTurn' });
  assert.strictEqual(E.extraActionCost(g), 6);
  assert.strictEqual(g.actionsLeft, 3);
});

test('コアは攻撃が3回成功すると破壊される（耐久は手番をまたいでも戻らない）', () => {
  const { g, a, b } = clashSetup();
  const bc = E.parseKey(P(g, b).core);
  setCell(g, ...nb(g, ...bc)[0], { owner: a });
  P(g, a).resource = 20;
  for (const left of [2, 1]) {
    assert.ok(E.apply(g, a, { type: 'destroy', q: bc[0], r: bc[1] }).ok);
    assert.strictEqual(P(g, b).coreHp, left);
    assert.ok(P(g, b).alive);
    const core = g.board[E.key(...bc)];
    assert.deepStrictEqual([core.owner, core.core], [b, true]);   // コアは残り、攻撃側のセルにもならない
    E.apply(g, a, { type: 'endTurn' });
    E.apply(g, b, { type: 'endTurn' });
    P(g, a).resource = 20;
  }
  // 守られた攻撃は数えない
  P(g, b).defense = 1;
  E.apply(g, a, { type: 'destroy', q: bc[0], r: bc[1] });
  E.apply(g, b, { type: 'bid', count: 1 });
  assert.strictEqual(P(g, b).coreHp, 1);
  // 3回目の成功で破壊
  E.apply(g, a, { type: 'destroy', q: bc[0], r: bc[1] });
  assert.strictEqual(P(g, b).alive, false);
  assert.ok(g.over);
  assert.ok(g.log.some(l => l.text.includes('残り耐久 1 / 3')));
});

test('もう何もできなくなったら自動で手番終了', () => {
  const g = newGame(2);
  const me = cur(g);
  // 資源3：拡張3回で資源0 → 行動 +1 も買えず、何もできないので自動で手番終了
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(cur(g), me);
    const t = E.targets(g, me, 'expand').find(k => g.board[k].terrain === 'plain');
    const [q, r] = E.parseKey(t);
    assert.ok(E.apply(g, me, { type: 'expand', q, r }).ok);
  }
  assert.notStrictEqual(cur(g), me);
  assert.ok(g.log.some(l => l.text.includes('もう行動できないため、自動で手番終了')));
  // 資源が残っていて、行動回数が残っていれば終わらない
  const h = newGame(2, 2);
  const hm = cur(h);
  P(h, hm).resource = 2;
  E.apply(h, hm, { type: 'reinforce' });
  assert.notStrictEqual(cur(h), hm);   // 資源0で何もできない
  const k = newGame(2, 3);
  const km = cur(k);
  P(k, km).resource = 10;
  E.apply(k, km, { type: 'reinforce' });
  assert.strictEqual(cur(k), km);      // まだできる
});
