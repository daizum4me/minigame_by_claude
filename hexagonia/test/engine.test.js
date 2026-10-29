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

// イベントは結果がばらつくので、イベントのテスト以外は起こさない
function newGame(n, seed) { return E.createGame(PLAYERS.slice(0, n), seeded(seed || 1), { events: false }); }
const cur = g => E.current(g).id;
const P = (g, id) => g.players.find(p => p.id === id);

// 盤面の中にある隣のマス（コアは一番外側にあるので、隣のマスは3〜4つ）
const nb = (g, q, r) => E.neighbors(q, r).filter(([nq, nr]) => g.board[E.key(nq, nr)]);

// その人の手番になるまで、ほかの人は手番終了する
function untilTurn(g, id) {
  for (let i = 0; i < 50 && cur(g) !== id; i++) E.apply(g, cur(g), { type: 'endTurn' });
  assert.strictEqual(cur(g), id);
}

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
  assert.throws(() => E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 11 }));
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

test('地形は平原・鉱山・農地・森林（平原 約73%、ほかは約9%ずつ）と河川', () => {
  for (const n of [2, 4, 8]) {
    const g = newGame(n, 3);
    const cnt = {};
    Object.values(g.board).forEach(c => { cnt[c.terrain] = (cnt[c.terrain] || 0) + 1; });
    assert.deepStrictEqual(Object.keys(cnt).sort(), ['farm', 'forest', 'mine', 'plain', 'river'], JSON.stringify(cnt));
    // コアとその周りは平原、河川は河川。残りのマスの 2/22 ずつ
    const fixed = g.players.reduce((k, p) => k + 1 + nb(g, ...E.parseKey(p.core)).length, 0);
    const free = Object.keys(g.board).length - fixed - (cnt.river || 0);
    const each = Math.round(free * 2 / 22);
    assert.deepStrictEqual([cnt.mine, cnt.farm, cnt.forest], [each, each, each], JSON.stringify(cnt));
  }
});

test('初期状態：資源3・攻撃0・防御2・コア未強化', () => {
  const g = newGame(3);
  for (const p of g.players) {
    assert.deepStrictEqual([p.resource, p.attack, p.defense, p.alive], [3, 0, 2, true]);
    const c = g.board[p.core];
    assert.ok(c.core && !c.strong && c.owner === p.id);
  }
  assert.strictEqual(g.round, 1);
  assert.strictEqual(g.actionsLeft, 3);
});

test('拡張：隣接する空きマスだけ、資源1', () => {
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
  assert.strictEqual(g.board[E.key(nq, nr)].owner, me);
});

test('行動は最大3回（補強は行動回数を使わない）、資源不足は不可、他人の手番は不可', () => {
  const g = newGame(2);
  const me = cur(g), other = g.players.find(p => p.id !== me).id;
  P(g, me).resource = 20;
  assert.strictEqual(E.apply(g, other, { type: 'reinforce' }).ok, false);
  const [cq, cr] = E.parseKey(P(g, me).core);
  assert.ok(E.apply(g, me, { type: 'strengthen', q: cq, r: cr }).ok);
  for (let i = 0; i < 2; i++) {
    const [q, r] = E.parseKey(E.targets(g, me, 'expand').find(k => g.board[k].terrain === 'plain'));
    assert.ok(E.apply(g, me, { type: 'expand', q, r }).ok);
  }
  assert.strictEqual(g.actionsLeft, 0);
  const [q, r] = E.parseKey(E.targets(g, me, 'expand').length ? E.targets(g, me, 'expand')[0] : Object.keys(g.board).find(k => !g.board[k].owner));
  assert.strictEqual(E.apply(g, me, { type: 'expand', q, r }).ok, false);
  // 補強は行動回数を使い切っていてもできる。防御トークン +1 だけ（攻撃トークンは増えない）。ログには出ない
  const logLen = g.log.length;
  assert.ok(E.apply(g, me, { type: 'reinforce' }).ok);
  assert.ok(E.apply(g, me, { type: 'reinforce' }).ok);
  assert.strictEqual(g.log.length, logLen);
  // 防御：最初の2 + 強化の1 + 補強の2、攻撃：強化の1だけ
  assert.deepStrictEqual([P(g, me).defense, P(g, me).attack], [5, 1]);
  assert.strictEqual(g.actionsLeft, 0);
  E.apply(g, me, { type: 'endTurn' });
  P(g, other).resource = 1;
  const res = E.apply(g, other, { type: 'reinforce' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /資源/);
});

test('強化：攻撃+1・防御+1。強化済はもう強化できない', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  P(g, me).resource = 10;
  assert.ok(E.apply(g, me, { type: 'strengthen', q: cq, r: cr }).ok);
  assert.deepStrictEqual([P(g, me).attack, P(g, me).defense, P(g, me).resource], [1, 3, 8]);
  assert.strictEqual(E.apply(g, me, { type: 'strengthen', q: cq, r: cr }).ok, false);
  const [nq, nr] = nb(g, cq, cr)[1];
  setCell(g, nq, nr, { owner: me });
  assert.ok(E.apply(g, me, { type: 'strengthen', q: nq, r: nr }).ok);
  assert.deepStrictEqual([P(g, me).attack, P(g, me).defense], [2, 4]);
});

test('ターン終了時の資源：強化済+1（鉱山も同じ）、コア+2（強化済のコアは+3）', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  assert.strictEqual(E.income(g, me), 2);
  const ns = nb(g, cq, cr);
  setCell(g, ...ns[0], { owner: me });                       // 未強化：0
  setCell(g, ...ns[1], { owner: me, strong: true });         // 強化済：+1
  setCell(g, ...ns[2], { owner: me, strong: true, terrain: 'mine' }); // 鉱山の強化済：+1
  setCell(g, 0, 0, { owner: me, terrain: 'mine' });          // 鉱山の未強化：0
  assert.strictEqual(E.income(g, me), 2 + 1 + 1);
  g.board[P(g, me).core].strong = true;
  assert.strictEqual(E.income(g, me), 3 + 1 + 1);
  const before = P(g, me).resource;
  E.apply(g, me, { type: 'endTurn' });
  assert.strictEqual(P(g, me).resource, before + 5);
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
  P(g, a).attack = 1;   // 破壊には攻撃トークンが1個以上必要
  return { g, a, b, t: E.key(tq, tr), tq, tr };
}

test('破壊：資源2・攻撃トークン1個以上が必要。防御トークンがなければ成功し、そのマスが攻撃側のセルになる', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  P(g, b).defense = 0;
  P(g, a).attack = 0;
  const r = E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /攻撃トークン/);
  assert.deepStrictEqual(E.targets(g, a, 'destroy'), []);
  P(g, a).attack = 1;                         // 1個しかなければ1個に決まる
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.strictEqual(g.pending, null);
  assert.deepStrictEqual([g.board[t].owner, g.board[t].strong], [a, false]);
  assert.strictEqual(P(g, a).resource, 8);
  assert.strictEqual(P(g, a).attack, 0);      // 出した1個はなくなる
  assert.strictEqual(g.actionsLeft, 2);       // そのまま拡張しても行動回数は減らない
  assert.ok(P(g, b).alive);
});

test('破壊：出す数を伏せて決め、そろったら公開。攻撃 ≧ 防御なら成功', () => {
  for (const [atk, def, ok] of [[2, 1, true], [1, 1, true], [1, 0, true], [1, 2, false], [2, 2, true]]) {
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
    assert.strictEqual(E.apply(g, a, { type: 'bid', count: 0 }).ok, false);   // 攻撃は1個以上
    assert.ok(E.apply(g, a, { type: 'bid', count: atk }).ok);
    assert.strictEqual(g.pending, null);
    assert.strictEqual(g.board[t].owner, ok ? a : b, `${atk} vs ${def}`);
    // 出したトークンはすべてなくなる
    assert.deepStrictEqual([P(g, a).attack, P(g, b).defense], [3 - atk, 2 - def]);
    assert.deepStrictEqual([g.lastClash.atk, g.lastClash.def, g.lastClash.success], [atk, def, ok]);
    assert.strictEqual(P(g, a).resource, 8); // 失敗しても資源は戻らない
  }
});

test('破壊：防御トークンがなくても、攻撃側は出す数を選ぶ（相手の防御トークンは見えないので）', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  P(g, b).defense = 0;
  P(g, a).attack = 3;
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  assert.deepStrictEqual(E.waiting(g), [a]);   // 防御側は0個に決まっている
  E.apply(g, a, { type: 'bid', count: 2 });
  assert.strictEqual(g.board[t].owner, a);
  assert.strictEqual(P(g, a).attack, 1);
});

test('コアを破壊すると脱落、セルとトークンが消えて手番が飛ばされる、最後の1人が勝利', () => {
  const g = newGame(3);
  const [a, b, c] = g.players.map(p => p.id);
  const bc = E.parseKey(P(g, b).core);
  const [nq, nr] = nb(g, ...bc)[0];
  setCell(g, nq, nr, { owner: a });
  const [oq, or] = nb(g, ...bc).at(-1);
  setCell(g, oq, or, { owner: b, strong: true });
  P(g, b).resource = 5; P(g, b).attack = 2; P(g, b).defense = 0;
  P(g, a).attack = 5;
  E.apply(g, a, { type: 'destroy', q: bc[0], r: bc[1] });
  E.apply(g, a, { type: 'bid', count: 1 });   // 相手の防御トークンは見えないので、攻撃側は数を選ぶ
  assert.strictEqual(P(g, b).alive, false);
  assert.strictEqual(E.cellsOf(g, b).length, 0);
  assert.strictEqual(g.board[E.key(...bc)].owner, a); // コアのマスも攻撃側のセルになる
  assert.strictEqual(g.board[E.key(oq, or)].owner, null);
  assert.deepStrictEqual([P(g, b).resource, P(g, b).attack], [0, 0]);
  E.apply(g, a, { type: 'endTurn' });
  assert.strictEqual(cur(g), c);                       // 脱落した b は飛ばされる
  E.apply(g, c, { type: 'endTurn' });
  // ラウンド2は最初の人が1人ずれる（b は脱落しているので c から）
  assert.strictEqual(g.round, 2);
  assert.strictEqual(cur(g), c);
  E.apply(g, c, { type: 'endTurn' });
  assert.strictEqual(cur(g), a);
  // c のコアも破壊
  const cc = E.parseKey(P(g, c).core);
  const [mq, mr] = nb(g, ...cc)[0];
  setCell(g, mq, mr, { owner: a });
  P(g, c).defense = 0;
  P(g, a).resource = 10;
  E.apply(g, a, { type: 'destroy', q: cc[0], r: cc[1] });
  E.apply(g, a, { type: 'bid', count: 1 });
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
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(4), { radius: 5, events: false });
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
  g.actionsLeft = 0;                                   // 行動回数を使い切ったことにする
  for (const cost of [6, 10, 14]) {
    assert.strictEqual(E.extraActionCost(g), cost);
    assert.ok(E.apply(g, me, { type: 'buyAction' }).ok);
    assert.strictEqual(g.actionsLeft, 1);
    assert.strictEqual(E.apply(g, me, { type: 'buyAction' }).ok, false); // 1回ずつ
    g.actionsLeft = 0;
  }
  assert.strictEqual(P(g, me).resource, 100 - 6 - 10 - 14);
  // 資源が足りなければ買えない
  P(g, me).resource = 17;
  const r = E.apply(g, me, { type: 'buyAction' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /資源/);
  E.apply(g, me, { type: 'endTurn' });
  assert.strictEqual(E.extraActionCost(g), 6);
  assert.strictEqual(g.actionsLeft, 3);
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
  assert.notStrictEqual(cur(h), hm);   // 資源0で何もできない（行動回数は残っているが、拡張も資源1が要る）
  const k = newGame(2, 3);
  const km = cur(k);
  P(k, km).resource = 10;
  E.apply(k, km, { type: 'reinforce' });
  assert.strictEqual(cur(k), km);      // まだできる
});

test('セルを捨てる：数が違う・コア・ほかの人のセルは不可。おすすめは一番大きなかたまりから外れたものから', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 6, events: false });
  const me = cur(g), other = g.players.find(p => p.id !== me).id;
  const mine = Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain').slice(0, 12);
  mine.forEach(c => { c.owner = me; });                 // 12＋コア = 13 マス：食べる13・作る5
  P(g, me).food = 6;                                    // 貯え6 → 2 足りない
  E.apply(g, me, { type: 'endTurn' });
  assert.deepStrictEqual(g.abandon, { player: me, count: 2 });
  assert.strictEqual(cur(g), me);                       // 捨てるまで次の人に回らない
  assert.deepStrictEqual(E.waiting(g), [me]);
  assert.strictEqual(E.apply(g, me, { type: 'reinforce' }).ok, false);
  // 数が違う・コア・他人のセルは不可
  const k = E.key(mine[0].q, mine[0].r), k2 = E.key(mine[1].q, mine[1].r);
  assert.strictEqual(E.apply(g, me, { type: 'abandon', cells: [k] }).ok, false);
  assert.strictEqual(E.apply(g, me, { type: 'abandon', cells: [k, P(g, me).core] }).ok, false);
  assert.strictEqual(E.apply(g, me, { type: 'abandon', cells: [k, P(g, other).core] }).ok, false);
  assert.strictEqual(E.apply(g, other, { type: 'abandon', cells: [k, k2] }).ok, false);
  assert.ok(E.apply(g, me, { type: 'abandon', cells: [k, k2] }).ok);
  assert.strictEqual(g.board[k].owner, null);
  assert.strictEqual(g.abandon, null);
  assert.strictEqual(cur(g), other);
  // おすすめ：一番大きなかたまりから外れたセル・未強化・コアから遠いものから
  const h = E.createGame(PLAYERS.slice(0, 2), seeded(2), { radius: 6, events: false });
  const hm = cur(h);
  const hc = E.parseKey(P(h, hm).core);
  const near = nb(h, ...hc)[0];
  setCell(h, ...near, { owner: hm });
  setCell(h, 0, 0, { owner: hm });                      // 離れたセル
  h.abandon = { player: hm, count: 1 };
  assert.deepStrictEqual(E.suggestAbandon(h, hm), ['0,0']);
});

test('河川：端から端へ流れる本流（大きい盤面は支流も）。コアの周りには流れず、どのコアも十分な土地を持てる', () => {
  for (const n of [2, 3, 4, 6, 8, 12]) {
    for (let seed = 1; seed <= 4; seed++) {
      const g = E.createGame(PLAYERS.slice(0, n), seeded(seed * 7 + n));
      const river = Object.values(g.board).filter(c => c.terrain === 'river');
      assert.ok(river.length >= g.radius, `${n}人 seed ${seed}：河川が短い`);
      // 本流は盤面の端から始まる
      assert.ok(river.some(c => E.dist([c.q, c.r], [0, 0]) === g.radius));
      // コアとその周りは河川にならない
      for (const p of g.players) for (const [q, r] of [E.parseKey(p.core), ...nb(g, ...E.parseKey(p.core))]) assert.notStrictEqual(g.board[E.key(q, r)].terrain, 'river');
      // どのコアも、河川を渡らずに盤面の (1 / 人数 / 3) 以上の土地を持てる
      const need = Math.floor(Object.keys(g.board).length / (n * 3));
      for (const p of g.players) {
        const seen = new Set([p.core]), stack = [p.core];
        while (stack.length) {
          const [q, r] = E.parseKey(stack.pop());
          for (const [nq, nr] of nb(g, q, r)) {
            const k = E.key(nq, nr);
            if (!seen.has(k) && g.board[k].terrain !== 'river') { seen.add(k); stack.push(k); }
          }
        }
        assert.ok(seen.size >= need, `${n}人 seed ${seed}：${seen.size} < ${need}`);
      }
    }
  }
});

test('橋：河川マスへの拡張は資源4。強化できる。破壊されると河川に戻る', () => {
  const { g, a, b } = clashSetup();
  const ac = E.parseKey(P(g, a).core);
  const [rq, rr] = nb(g, ...ac).find(([q, r]) => !g.board[E.key(q, r)].owner);
  const rk = E.key(rq, rr);
  g.board[rk].terrain = 'river';
  P(g, a).resource = 3;
  assert.ok(!E.targets(g, a, 'expand').includes(rk));     // 資源3では足りない
  P(g, a).resource = 10;
  assert.ok(E.apply(g, a, { type: 'expand', q: rq, r: rr }).ok);
  assert.strictEqual(P(g, a).resource, 6);
  assert.deepStrictEqual([g.board[rk].owner, g.board[rk].terrain], [a, 'river']);
  assert.ok(E.apply(g, a, { type: 'strengthen', q: rq, r: rr }).ok);
  assert.strictEqual(g.board[rk].strong, true);
  // b が橋を破壊すると河川に戻る（b のセルにはならない）
  untilTurn(g, b);
  setCell(g, ...nb(g, rq, rr).find(([q, r]) => !g.board[E.key(q, r)].owner && g.board[E.key(q, r)].terrain !== 'river'), { owner: b });
  P(g, b).resource = 5;
  P(g, b).attack = 1;
  P(g, a).defense = 0;
  assert.ok(E.apply(g, b, { type: 'destroy', q: rq, r: rr }).ok);
  assert.deepStrictEqual([g.board[rk].owner, g.board[rk].terrain, g.board[rk].strong], [null, 'river', false]);
});

test('12人まで遊べる：6人までは全員が外周、7人以上は約3分の1のコアが内側。7人以上は持ち時間60秒', () => {
  for (const n of [5, 6, 7, 9, 12]) {
    const g = E.createGame(PLAYERS.slice(0, n), seeded(n));
    assert.strictEqual(g.players.length, n);
    const cores = g.players.map(p => E.parseKey(p.core));
    assert.strictEqual(new Set(g.players.map(p => p.core)).size, n);
    const outer = cores.filter(c => E.dist(c, [0, 0]) === g.radius).length;
    assert.strictEqual(n - outer, n >= 7 ? Math.floor(n / 3) : 0, `${n}人の内側のコア`);
    let gap = Infinity;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) gap = Math.min(gap, E.dist(cores[i], cores[j]));
    assert.ok(gap >= 3, `${n}人のコアの間隔 ${gap}`);
    assert.strictEqual(E.turnMs(g), n >= 7 ? 60000 : 120000);
    // 人数が多いほどラウンドが少なく、行動回数が多い
    const auto = E.autoSettings(n);
    assert.deepStrictEqual([g.actionsPerTurn, g.rounds], [auto.actions, auto.rounds]);
  }
  assert.deepStrictEqual(E.autoSettings(2), { actions: 3, rounds: 12 });
  assert.deepStrictEqual(E.autoSettings(12), { actions: 5, rounds: 6 });
  assert.throws(() => E.createGame([...PLAYERS, { id: 'm', name: 'M', color: 'red' }], seeded(1)));   // 13人は不可
  assert.throws(() => E.createGame(PLAYERS.slice(0, 12), seeded(1), { radius: 3 }));   // 盤面が小さすぎる
});

test('ラウンドごとに最初の人が1人ずつずれる（脱落した人は飛ばす）', () => {
  const g = newGame(3);
  const ids = g.players.map(p => p.id);
  const seen = [];
  for (let i = 0; i < 9; i++) { seen.push(cur(g)); E.apply(g, cur(g), { type: 'endTurn' }); }
  assert.deepStrictEqual(seen, [ids[0], ids[1], ids[2], ids[1], ids[2], ids[0], ids[2], ids[0], ids[1]]);
  assert.strictEqual(g.round, 4);
  assert.ok(g.log.some(l => l.text === `ラウンド 2 / ${g.rounds}（最初は ${g.players[1].name}）`));
  // 次のラウンドの最初の人が脱落していたら、その次の人から
  E.forfeit(g, ids[1]);
  const order = [];
  while (g.round === 4) { order.push(cur(g)); E.apply(g, cur(g), { type: 'endTurn' }); }
  assert.strictEqual(cur(g), ids[2]);   // ラウンド5：本来は ids[1] からだが脱落しているので ids[2]
});

test('2人戦は最初の人をずらさない（同じ人が2手番続けて動かない）', () => {
  const g = newGame(2);
  const [a, b] = g.players.map(p => p.id);
  const seen = [];
  for (let i = 0; i < 8; i++) { seen.push(cur(g)); E.apply(g, cur(g), { type: 'endTurn' }); }
  assert.deepStrictEqual(seen, [a, b, a, b, a, b, a, b]);
});

test('行動回数とラウンド数は指定できる', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1), { actions: 5, rounds: 4 });
  assert.deepStrictEqual([g.actionsPerTurn, g.rounds, g.actionsLeft], [5, 4, 5]);
  for (let i = 0; i < 8; i++) E.apply(g, cur(g), { type: 'endTurn' });
  assert.ok(g.over);
  assert.throws(() => E.createGame(PLAYERS.slice(0, 2), seeded(1), { actions: 7 }));
  assert.throws(() => E.createGame(PLAYERS.slice(0, 2), seeded(1), { rounds: 30 }));
});

test('内側にコアがある人は、ラウンド1の前に1手番ずつ先に動く', () => {
  const g = newGame(7, 3);
  const inner = g.players.filter(p => E.dist(E.parseKey(p.core), [0, 0]) < g.radius).map(p => p.id);
  assert.strictEqual(inner.length, 2);
  assert.strictEqual(g.round, 0);
  const pre = [];
  while (g.round === 0) { pre.push(cur(g)); E.apply(g, cur(g), { type: 'endTurn' }); }
  assert.deepStrictEqual(pre, inner);
  assert.strictEqual(g.round, 1);
  assert.strictEqual(g.roundPos, 0);
  // 6人以下は先行なし
  assert.strictEqual(newGame(6).round, 1);
});

test('食料：手番終了時にコア +5・強化済のセル（コアも）+1 を作り、セル1つにつき1を食べる。余りは持ち越す', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 6, events: false });
  const me = cur(g);
  assert.strictEqual(P(g, me).food, 0);
  const free = Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain');
  free.slice(0, 3).forEach(c => { c.owner = me; });           // セル4つ（コアを含む）
  free[0].strong = true;                                        // 強化済1つ
  assert.deepStrictEqual([E.foodMade(g, me), E.foodEaten(g, me)], [5 + 1, 4]);
  E.apply(g, me, { type: 'endTurn' });
  assert.strictEqual(P(g, me).food, 2);                         // 0 + 6 − 4
  assert.ok(g.log.some(l => l.text.includes('食料 +6 −4')));
  // 強化済のコアも +1
  g.board[P(g, me).core].strong = true;
  assert.strictEqual(E.foodMade(g, me), 5 + 1 + 1);
});

test('食料が足りなければ、足りない数だけセルを選んで捨てる（コアは捨てられない）', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 6, events: false });
  const me = cur(g), other = g.players.find(p => p.id !== me).id;
  const mine = Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain').slice(0, 7);
  mine.forEach(c => { c.owner = me; });                          // セル8つ：作る5・食べる8 → 3 足りない
  P(g, me).food = 1;                                            // 貯えが1あるので、足りないのは2
  E.apply(g, me, { type: 'endTurn' });
  assert.deepStrictEqual(g.abandon, { player: me, count: 2 });
  assert.strictEqual(P(g, me).food, 0);
  assert.ok(g.log.some(l => l.text.includes('食料が 2 足りないため、セルを 2 つ捨てる')));
  const cells = mine.slice(0, 2).map(c => E.key(c.q, c.r));
  assert.ok(E.apply(g, me, { type: 'abandon', cells }).ok);
  assert.strictEqual(cur(g), other);
});

test('鉱山マス：拡張したとき・強化したとき・破壊で取ったときに攻撃トークン +1', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  const ac = E.parseKey(P(g, a).core);
  const [mq, mr] = nb(g, ...ac).find(([q, r]) => !g.board[E.key(q, r)].owner);
  setCell(g, mq, mr, { terrain: 'mine' });
  P(g, a).attack = 0;
  assert.ok(E.apply(g, a, { type: 'expand', q: mq, r: mr }).ok);
  assert.strictEqual(P(g, a).attack, 1);
  assert.ok(E.apply(g, a, { type: 'strengthen', q: mq, r: mr }).ok);
  assert.strictEqual(P(g, a).attack, 1 + 1 + 1);       // 強化の +1 と鉱山の +1
  // 破壊で鉱山マスを取ったときも +1
  g.board[t].terrain = 'mine';
  P(g, b).defense = 0;
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  E.apply(g, a, { type: 'bid', count: 1 });
  assert.strictEqual(g.board[t].owner, a);
  assert.strictEqual(P(g, a).attack, 3 - 1 + 1);
});

test('農地マス：このセルがあると手番終了時に食料 +1（強化の +1 とは別）', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  const [fq, fr] = nb(g, cq, cr)[0];
  assert.strictEqual(E.foodMade(g, me), 5);
  setCell(g, fq, fr, { owner: me, terrain: 'farm' });
  assert.strictEqual(E.foodMade(g, me), 5 + 1);
  g.board[E.key(fq, fr)].strong = true;
  assert.strictEqual(E.foodMade(g, me), 5 + 1 + 1);
});

test('森林マス：このセルがあると手番終了時に資源 +1（強化の +1 とは別）', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  const [fq, fr] = nb(g, cq, cr)[0];
  assert.strictEqual(E.income(g, me), 2);
  setCell(g, fq, fr, { owner: me, terrain: 'forest' });
  assert.strictEqual(E.income(g, me), 2 + 1);
  g.board[E.key(fq, fr)].strong = true;
  assert.strictEqual(E.income(g, me), 2 + 1 + 1);
  const before = P(g, me).resource;
  E.apply(g, me, { type: 'endTurn' });
  assert.strictEqual(P(g, me).resource, before + 4);
});

test('イベント：ラウンドの始まりに約1/3の確率で起き、そのラウンドの間続く。次のラウンドの分は予告される', () => {
  let rounds = 0, withEvent = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = E.createGame(PLAYERS.slice(0, 2), seeded(seed));
    for (let r = 1; r <= g.rounds; r++) { rounds++; if (g.eventPlan[r]) withEvent++; }
    // ラウンド1のイベントと、ラウンド2の予告
    assert.strictEqual(g.event, g.eventPlan[1]);
    assert.strictEqual(g.nextEvent, g.eventPlan[2]);
    // ラウンドが進むと入れ替わる
    E.apply(g, cur(g), { type: 'endTurn' });
    E.apply(g, cur(g), { type: 'endTurn' });
    if (!g.over) assert.deepStrictEqual([g.round, g.event, g.nextEvent], [2, g.eventPlan[2], g.eventPlan[3]]);
  }
  assert.ok(withEvent / rounds > 0.25 && withEvent / rounds < 0.42, `${withEvent}/${rounds}`);
  assert.ok(E.createGame(PLAYERS.slice(0, 2), seeded(1), { events: false }).eventPlan.every(e => !e));
});

test('イベントの効果：不作・豊作・枯渇・発見・豊漁・洪水・祭事・疫病', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  const ns = nb(g, cq, cr);
  setCell(g, ...ns[0], { owner: me, strong: true });            // 強化済：資源 +1・食料 +1
  setCell(g, ...ns[1], { owner: me, terrain: 'farm' });         // 農地：食料 +1
  const river = ns[2];
  setCell(g, ...river, { terrain: 'river' });                   // コアと ns[0]・ns[1] のどれかが河川の隣になる
  const side = E.riversideCells(g, me);
  assert.ok(side >= 1);
  const base = { food: E.foodMade(g, me), eat: E.foodEaten(g, me), res: E.income(g, me), act: E.actionsThisTurn(g) };
  assert.deepStrictEqual(base, { food: 5 + 1 + 1, eat: 3, res: 2 + 1, act: 3 });
  const as = ev => { g.event = ev; return { food: E.foodMade(g, me), eat: E.foodEaten(g, me), res: E.income(g, me), act: E.actionsThisTurn(g) }; };
  assert.strictEqual(as('famine').food, Math.floor(7 * 0.5));
  assert.strictEqual(as('harvest').food, Math.floor(7 * 1.5));
  assert.strictEqual(as('depletion').res, Math.floor(3 * 0.5));
  assert.strictEqual(as('discovery').res, Math.floor(3 * 1.5));
  assert.strictEqual(as('fishing').food, 7 + side);
  assert.deepStrictEqual([as('flood').food, as('flood').eat], [7, 3 + side]);
  assert.strictEqual(as('festival').act, 4);
  assert.strictEqual(as('plague').act, 2);
  // 行動回数は1回より少なくならない
  g.actionsPerTurn = 1;
  assert.strictEqual(as('plague').act, 1);
});

test('生産：資源2で防御トークン +1、資源3で攻撃トークン +1。行動回数を使わず、ログに出ない', () => {
  const g = newGame(2);
  const me = cur(g);
  P(g, me).resource = 10;
  g.actionsLeft = 0;
  const logLen = g.log.length;
  assert.ok(E.apply(g, me, { type: 'produceAttack' }).ok);
  assert.ok(E.apply(g, me, { type: 'reinforce' }).ok);
  assert.deepStrictEqual([P(g, me).attack, P(g, me).defense, P(g, me).resource], [1, 3, 5]);
  assert.strictEqual(g.log.length, logLen);
  P(g, me).resource = 2;
  assert.strictEqual(E.apply(g, me, { type: 'produceAttack' }).ok, false);
});

test('攻防の結果は成功か失敗かだけがログに出る（出した数は出ない）。守られたら、防御側の見える数の目安が減る', () => {
  const { g, a, b, tq, tr } = clashSetup();
  P(g, a).attack = 2;
  P(g, b).defense = 3;
  assert.strictEqual(P(g, b).defenseSeen, 2);
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  E.apply(g, b, { type: 'bid', count: 3 });
  E.apply(g, a, { type: 'bid', count: 1 });
  assert.strictEqual(g.lastClash.success, false);
  assert.ok(!g.log.some(l => /トークン \d+ 個/.test(l.text)));
  assert.ok(g.log.some(l => l.text.includes('出した数は非公開')));
  // 攻撃1で守られた → 防御側は2個以上出したはず
  assert.strictEqual(P(g, b).defenseSeen, 0);
});
