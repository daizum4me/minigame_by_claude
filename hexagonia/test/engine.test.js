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

test('人数ごとの盤面の大きさ（2〜3人は直径 7・4人は 9・5〜6人は 11）と、大きさの指定', () => {
  for (const [n, cells] of [[2, 37], [3, 37], [4, 61], [6, 91]]) {
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

test('地形：どのコアにも距離2〜3のマスに鉱山・森林が1つずつあり、ほかにも散らす。効果のあるマスは2種類に均等。農地は最初はない', () => {
  for (const n of [2, 4, 8, 12]) {
    for (const seed of [1, 2, 3]) {
      const g = newGame(n, seed);
      const cnt = {};
      Object.values(g.board).forEach(c => { cnt[c.terrain] = (cnt[c.terrain] || 0) + 1; });
      // コアとその周りは平原
      for (const p of g.players) {
        const core = E.parseKey(p.core);
        assert.strictEqual(g.board[p.core].terrain, 'plain');
        nb(g, ...core).forEach(([q, r]) => assert.strictEqual(g.board[E.key(q, r)].terrain, 'plain'));
        for (const t of E.TERRAIN_KINDS) assert.ok(Object.values(g.board).some(c => c.terrain === t && [2, 3].includes(E.dist([c.q, c.r], core))), `${n}人 seed${seed}: ${t}`);
      }
      const fixed = g.players.reduce((k, p) => k + 1 + nb(g, ...E.parseKey(p.core)).length, 0);
      const free = Object.keys(g.board).length - fixed - (cnt.river || 0);
      const kinds = E.TERRAIN_KINDS.map(t => cnt[t] || 0);
      const sum = kinds.reduce((a, b) => a + b, 0);
      assert.strictEqual(sum, Math.max(2 * n + Math.round(free * E.RULES.centerShare), Math.round(free * 4 / 20)), JSON.stringify(cnt));
      assert.ok(!cnt.farm, JSON.stringify(cnt));
      assert.ok(Math.max(...kinds) - Math.min(...kinds) <= 1, JSON.stringify(cnt));
    }
  }
});

test('初期状態：資源3・戦力2・コア未強化', () => {
  const g = newGame(3);
  for (const p of g.players) {
    assert.deepStrictEqual([p.resource, p.power, p.alive], [3, 2, true]);
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

test('行動は最大3回（生産は行動回数を使わない）、資源不足は不可、他人の手番は不可', () => {
  const g = newGame(2);
  const me = cur(g), other = g.players.find(p => p.id !== me).id;
  P(g, me).resource = 20;
  assert.strictEqual(E.apply(g, other, { type: 'produce' }).ok, false);
  const [cq, cr] = E.parseKey(P(g, me).core);
  assert.ok(E.apply(g, me, { type: 'strengthen', q: cq, r: cr }).ok);
  for (let i = 0; i < 2; i++) {
    const [q, r] = E.parseKey(E.targets(g, me, 'expand').find(k => g.board[k].terrain === 'plain'));
    assert.ok(E.apply(g, me, { type: 'expand', q, r }).ok);
  }
  assert.strictEqual(g.actionsLeft, 0);
  const [q, r] = E.parseKey(E.targets(g, me, 'expand').length ? E.targets(g, me, 'expand')[0] : Object.keys(g.board).find(k => !g.board[k].owner));
  assert.strictEqual(E.apply(g, me, { type: 'expand', q, r }).ok, false);
  // 生産は行動回数を使い切っていてもできる。戦力トークン +1。ログには出ない
  const logLen = g.log.length;
  assert.ok(E.apply(g, me, { type: 'produce' }).ok);
  assert.ok(E.apply(g, me, { type: 'produce' }).ok);
  assert.strictEqual(g.log.length, logLen);
  // 最初の2 + 強化の1 + 生産の2
  assert.strictEqual(P(g, me).power, 5);
  assert.strictEqual(g.actionsLeft, 0);
  E.apply(g, me, { type: 'endTurn' });
  P(g, other).resource = 1;
  const res = E.apply(g, other, { type: 'produce' });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /資源/);
});

test('強化：戦力+1。強化済はもう強化できない', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  P(g, me).resource = 10;
  assert.ok(E.apply(g, me, { type: 'strengthen', q: cq, r: cr }).ok);
  assert.deepStrictEqual([P(g, me).power, P(g, me).resource], [3, 8]);
  assert.strictEqual(E.apply(g, me, { type: 'strengthen', q: cq, r: cr }).ok, false);
  const [nq, nr] = nb(g, cq, cr)[1];
  setCell(g, nq, nr, { owner: me });
  assert.ok(E.apply(g, me, { type: 'strengthen', q: nq, r: nr }).ok);
  assert.strictEqual(P(g, me).power, 4);
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
  g.board[P(g, a).core].strong = true;   // 破壊できるのは、自分の強化済のセルに隣接するセルだけ
  P(g, a).resource = 10;
  P(g, a).power = 1;   // 破壊には戦力トークンが1個以上必要
  return { g, a, b, t: E.key(tq, tr), tq, tr };
}

test('破壊：資源2・戦力トークン1個以上が必要。相手が戦力トークンを持っていなくても攻防になり、0個なら成功してそのマスが攻撃側のセルになる', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  P(g, b).power = 0;
  P(g, a).power = 0;
  const r = E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /戦力トークン/);
  assert.deepStrictEqual(E.targets(g, a, 'destroy'), []);
  P(g, a).power = 1;                         // 1個しかなければ1個に決まる
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.deepStrictEqual(E.waiting(g), [b]);  // 戦力トークンがなくても、防御側は（0個を）選ぶ
  assert.ok(E.apply(g, b, { type: 'bid', count: 0 }).ok);
  assert.strictEqual(g.pending, null);
  assert.deepStrictEqual([g.board[t].owner, g.board[t].strong], [a, false]);
  assert.strictEqual(P(g, a).resource, 8);
  assert.strictEqual(P(g, a).power, 0);      // 出した1個はなくなる
  assert.strictEqual(g.actionsLeft, 2);       // そのまま拡張しても行動回数は減らない
  assert.ok(P(g, b).alive);
});

test('破壊：出す数を伏せて決め、そろったら公開。攻撃 ≧ 防御なら成功（同じ数なら攻撃側の勝ち）', () => {
  for (const [atk, def, ok] of [[2, 1, true], [1, 1, true], [1, 0, true], [1, 2, false], [2, 2, true], [3, 2, true]]) {
    const { g, a, b, t, tq, tr } = clashSetup();
    P(g, a).power = 3;
    P(g, b).power = 2;
    E.apply(g, a, { type: 'destroy', q: tq, r: tr });
    assert.deepStrictEqual(E.waiting(g).sort(), [a, b].sort());
    // 攻防中は他の行動はできない
    assert.strictEqual(E.apply(g, a, { type: 'produce' }).ok, false);
    // 持っている数より多くは出せない・2回は決められない
    assert.strictEqual(E.apply(g, b, { type: 'bid', count: 3 }).ok, false);
    assert.ok(E.apply(g, b, { type: 'bid', count: def }).ok);
    assert.strictEqual(E.apply(g, b, { type: 'bid', count: 0 }).ok, false);
    assert.deepStrictEqual(E.waiting(g), [a]);
    assert.strictEqual(P(g, b).power, 2); // 公開まではまだ減らない
    assert.strictEqual(E.apply(g, a, { type: 'bid', count: 0 }).ok, false);   // 攻撃は1個以上
    assert.ok(E.apply(g, a, { type: 'bid', count: atk }).ok);
    assert.strictEqual(g.pending, null);
    assert.strictEqual(g.board[t].owner, ok ? a : b, `${atk} vs ${def}`);
    // 出したトークンはすべてなくなる
    assert.deepStrictEqual([P(g, a).power, P(g, b).power], [3 - atk, 2 - def]);
    assert.deepStrictEqual([g.lastClash.atk, g.lastClash.def, g.lastClash.success], [atk, def, ok]);
    assert.strictEqual(P(g, a).resource, 8); // 失敗しても資源は戻らない
  }
});

test('破壊：相手が戦力トークンを持っていなくても、攻撃側は出す数を選ぶ（相手の数は見えないので）', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  P(g, b).power = 0;
  P(g, a).power = 3;
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  assert.deepStrictEqual(E.waiting(g).sort(), [a, b].sort());   // 戦力トークンがなくても、防御側は選ぶ（0個しか出せない）
  assert.strictEqual(E.apply(g, b, { type: 'bid', count: 1 }).ok, false);
  E.apply(g, b, { type: 'bid', count: 0 });
  E.apply(g, a, { type: 'bid', count: 2 });
  assert.strictEqual(g.board[t].owner, a);
  assert.strictEqual(P(g, a).power, 1);
});

test('破壊の取りやめ：決着する前なら攻撃側が取り消せる。資源と行動回数が戻り、何回でもできる', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  P(g, a).power = 3;
  P(g, b).power = 2;
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.deepStrictEqual([P(g, a).resource, g.actionsLeft], [8, 2]);
  assert.ok(E.apply(g, b, { type: 'bid', count: 2 }).ok);           // 防御側が決めたあとでも取りやめられる
  assert.strictEqual(E.apply(g, b, { type: 'cancelDestroy' }).ok, false);   // 防御側は取りやめられない
  assert.ok(E.apply(g, a, { type: 'cancelDestroy' }).ok);
  assert.strictEqual(g.pending, null);
  assert.deepStrictEqual([P(g, a).resource, g.actionsLeft, P(g, a).power, P(g, b).power, g.board[t].owner], [10, 3, 3, 2, b]);
  assert.match(g.log.at(-1).text, /取りやめ/);
  // 同じ手番に2回目もできる
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.ok(E.apply(g, a, { type: 'cancelDestroy' }).ok);
  assert.deepStrictEqual([P(g, a).resource, g.actionsLeft], [10, 3]);
  // 攻防中でなければできない
  assert.strictEqual(E.apply(g, a, { type: 'cancelDestroy' }).ok, false);
});

test('拠点：破壊できるのは、自分の強化済のセルに隣接する相手のセルだけ', () => {
  const { g, a, t } = clashSetup();
  assert.ok(E.targets(g, a, 'destroy').includes(t));
  g.board[P(g, a).core].strong = false;
  assert.ok(!E.targets(g, a, 'destroy').includes(t));
  assert.strictEqual(E.apply(g, a, { type: 'destroy', q: E.parseKey(t)[0], r: E.parseKey(t)[1] }).ok, false);
});

test('城壁はない：強化済のセルの隣のセルでも、守る側に上乗せはない', () => {
  const { g, a, b, t, tq, tr } = clashSetup();
  const [wq, wr] = nb(g, tq, tr).find(([q, r]) => !g.board[E.key(q, r)].owner);
  setCell(g, wq, wr, { owner: b, strong: true });
  P(g, a).power = 2;
  P(g, b).power = 2;
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  E.apply(g, b, { type: 'bid', count: 2 });
  E.apply(g, a, { type: 'bid', count: 2 });
  assert.strictEqual(g.board[t].owner, a);
});

test('コアを破壊すると脱落し、破壊した人がセル・トークンをまるごと奪う。脱落した人の手番は飛ばされ、最後の1人が勝利', () => {
  const g = newGame(3);
  const [a, b, c] = g.players.map(p => p.id);
  const bc = E.parseKey(P(g, b).core);
  const [nq, nr] = nb(g, ...bc)[0];
  setCell(g, nq, nr, { owner: a, strong: true });
  const [oq, or] = nb(g, ...bc).at(-1);
  setCell(g, oq, or, { owner: b, strong: true });
  P(g, b).resource = 5; P(g, b).power = 0; P(g, b).food = 3;
  P(g, a).power = 5;
  const aRes = P(g, a).resource, aFood = P(g, a).food;
  E.apply(g, a, { type: 'destroy', q: bc[0], r: bc[1] });
  E.apply(g, b, { type: 'bid', count: 0 });
  E.apply(g, a, { type: 'bid', count: 1 });   // 相手の戦力トークンは見えないので、攻撃側は数を選ぶ
  assert.strictEqual(P(g, b).alive, false);
  assert.strictEqual(E.cellsOf(g, b).length, 0);
  assert.strictEqual(g.board[E.key(...bc)].owner, a); // コアのマスも攻撃側のセルになる
  // b のセルは強化済のまま a のものに（コアではなくなる）。資源・食料も a へ
  assert.deepStrictEqual([g.board[E.key(oq, or)].owner, g.board[E.key(oq, or)].strong], [a, true]);
  assert.ok(!Object.values(g.board).some(c => c.core && c.owner === a && E.key(c.q, c.r) !== P(g, a).core));
  assert.deepStrictEqual([P(g, b).resource, P(g, b).power, P(g, b).food], [0, 0, 0]);
  assert.deepStrictEqual([P(g, a).resource, P(g, a).food], [aRes - E.RULES.cost.destroy + 5, aFood + 3]);   // 破壊の資源2を払ったうえで、b の5を受け取る
  assert.ok(g.log.find(l => l.tone === 'out').text.endsWith(`${P(g, a).name} のものに`));
  E.apply(g, a, { type: 'endTurn' });
  assert.strictEqual(cur(g), c);                       // 脱落した b は飛ばされる
  E.apply(g, c, { type: 'endTurn' });
  assert.strictEqual(g.round, 2);
  assert.strictEqual(cur(g), a);
  // c のコアも破壊
  const cc = E.parseKey(P(g, c).core);
  const [mq, mr] = nb(g, ...cc)[0];
  setCell(g, mq, mr, { owner: a, strong: true });
  P(g, c).power = 0;
  P(g, a).resource = 10;
  E.apply(g, a, { type: 'destroy', q: cc[0], r: cc[1] });
  E.apply(g, c, { type: 'bid', count: 0 });
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
  assert.deepStrictEqual(E.targets(g, a, 'strengthen'), []);   // コアは強化済にしてある
  g.board[P(g, a).core].strong = false;
  assert.deepStrictEqual(E.targets(g, a, 'strengthen'), [P(g, a).core]);
  assert.deepStrictEqual(E.targets(g, a, 'destroy'), []);       // 強化済のセルに隣接していなければ破壊できない
  P(g, a).resource = 1;
  assert.deepStrictEqual(E.targets(g, a, 'strengthen'), []);
});

test('途中で脱落させる（切断）：セルは空きマスに戻る', () => {
  const g = newGame(3);
  const [a, b] = g.players.map(p => p.id);
  E.forfeit(g, a);
  assert.strictEqual(P(g, a).alive, false);
  assert.strictEqual(E.cellsOf(g, a).length, 0);
  assert.strictEqual(g.board[P(g, a).core].owner, null);
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



test('もう何もできなくなっても、取り消せる行動があるあいだは手番を終えない。取り消せなくなったら自動で手番終了', () => {
  const g = newGame(2);
  const me = cur(g);
  // 資源3：拡張3回で資源0。何もできないが、取り消せるので手番は続く
  for (let i = 0; i < 3; i++) {
    const t = E.targets(g, me, 'expand').find(k => g.board[k].terrain === 'plain');
    const [q, r] = E.parseKey(t);
    assert.ok(E.apply(g, me, { type: 'expand', q, r }).ok);
  }
  assert.strictEqual(cur(g), me);
  assert.strictEqual(g.undo.length, 3);
  assert.ok(E.apply(g, me, { type: 'endTurn' }).ok);
  assert.notStrictEqual(cur(g), me);
  // 破壊のあとは取り消せないので、もう何もできなければ自動で手番終了
  const { g: h, a, b, tq, tr } = clashSetup();
  P(h, a).resource = 2;
  P(h, a).power = 1;
  P(h, b).power = 0;
  E.apply(h, a, { type: 'destroy', q: tq, r: tr });
  E.apply(h, b, { type: 'bid', count: 0 });
  assert.notStrictEqual(cur(h), a);
  assert.ok(h.log.some(l => l.text.includes('もう行動できないため、自動で手番終了')));
});

test('行動の取り消し：拡張・強化・開墾・生産・行動 +1 は、手番のあいだなら新しいものから取り消せる', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  const [mq, mr] = nb(g, cq, cr)[0];
  setCell(g, mq, mr, { terrain: 'mine' });
  P(g, me).resource = 20;
  const start = { res: P(g, me).resource, power: P(g, me).power, seen: P(g, me).powerSeen, left: g.actionsLeft };
  assert.strictEqual(E.apply(g, me, { type: 'undo' }).ok, false);   // まだ何もしていない
  E.apply(g, me, { type: 'expand', q: mq, r: mr });          // 鉱山：戦力 +1
  E.apply(g, me, { type: 'strengthen', q: mq, r: mr });      // 戦力 +1・鉱山 +1
  E.apply(g, me, { type: 'produce' });
  const [fq, fr] = nb(g, cq, cr)[1];
  setCell(g, fq, fr, { owner: me });
  E.apply(g, me, { type: 'cultivate', q: fq, r: fr });
  assert.strictEqual(g.board[E.key(fq, fr)].terrain, 'farm');
  assert.strictEqual(g.undo.length, 4);
  // 開墾 → 生産 → 強化 → 拡張の順に戻る
  E.apply(g, me, { type: 'undo' });
  assert.strictEqual(g.board[E.key(fq, fr)].terrain, 'plain');
  E.apply(g, me, { type: 'undo' });
  E.apply(g, me, { type: 'undo' });
  assert.strictEqual(g.board[E.key(mq, mr)].strong, false);
  E.apply(g, me, { type: 'undo' });
  assert.deepStrictEqual([g.board[E.key(mq, mr)].owner, P(g, me).resource, P(g, me).power, P(g, me).powerSeen, g.actionsLeft], [null, start.res, start.power, start.seen, start.left]);
  assert.match(g.log.at(-1).text, /拡張を取り消した/);
  // ほかの人は取り消せない・手番が変わると取り消せない
  E.apply(g, me, { type: 'produce' });
  const other = g.players.find(p => p.id !== me).id;
  assert.strictEqual(E.apply(g, other, { type: 'undo' }).ok, false);
  E.apply(g, me, { type: 'endTurn' });
  assert.deepStrictEqual(g.undo, []);
});

test('行動の取り消し：破壊を宣言すると、それより前の行動も取り消せなくなる', () => {
  const { g, a, b, tq, tr } = clashSetup();
  P(g, a).power = 3;
  E.apply(g, a, { type: 'produce' });
  assert.strictEqual(g.undo.length, 1);
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  assert.deepStrictEqual(g.undo, []);
  E.apply(g, b, { type: 'bid', count: 0 });
  E.apply(g, a, { type: 'bid', count: 1 });
  assert.strictEqual(E.apply(g, a, { type: 'undo' }).ok, false);
});

test('セルを捨てる：数が違う・コア・ほかの人のセルは不可。おすすめは一番大きなかたまりから外れたものから', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 6, events: false });
  const me = cur(g), other = g.players.find(p => p.id !== me).id;
  const mine = Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain').slice(0, 12);
  mine.forEach(c => { c.owner = me; });                 // 12＋コア = 13 マス：食べる13・作る6
  P(g, me).food = 5;                                    // 貯え5 → 2 足りない
  E.apply(g, me, { type: 'endTurn' });
  assert.deepStrictEqual(g.abandon, { player: me, count: 2 });
  assert.strictEqual(cur(g), me);                       // 捨てるまで次の人に回らない
  assert.deepStrictEqual(E.waiting(g), [me]);
  assert.strictEqual(E.apply(g, me, { type: 'produce' }).ok, false);
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

test('橋：河川マスへの拡張は資源3。強化できる。破壊されると河川に戻る', () => {
  const { g, a, b } = clashSetup();
  const ac = E.parseKey(P(g, a).core);
  const [rq, rr] = nb(g, ...ac).find(([q, r]) => !g.board[E.key(q, r)].owner);
  const rk = E.key(rq, rr);
  g.board[rk].terrain = 'river';
  P(g, a).resource = 2;
  assert.ok(!E.targets(g, a, 'expand').includes(rk));     // 資源2では足りない
  P(g, a).resource = 10;
  assert.ok(E.apply(g, a, { type: 'expand', q: rq, r: rr }).ok);
  assert.strictEqual(P(g, a).resource, 7);
  assert.deepStrictEqual([g.board[rk].owner, g.board[rk].terrain], [a, 'river']);
  assert.ok(E.apply(g, a, { type: 'strengthen', q: rq, r: rr }).ok);
  assert.strictEqual(g.board[rk].strong, true);
  // b が橋を破壊すると河川に戻る（b のセルにはならない）
  untilTurn(g, b);
  setCell(g, ...nb(g, rq, rr).find(([q, r]) => !g.board[E.key(q, r)].owner && g.board[E.key(q, r)].terrain !== 'river'), { owner: b, strong: true });
  P(g, b).resource = 5;
  P(g, b).power = 2;
  P(g, a).power = 0;
  assert.ok(E.apply(g, b, { type: 'destroy', q: rq, r: rr }).ok);
  assert.ok(E.apply(g, a, { type: 'bid', count: 0 }).ok);
  assert.ok(E.apply(g, b, { type: 'bid', count: 1 }).ok);
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

test('手番の順はラウンドが変わってもずらさない（脱落した人は飛ばす）', () => {
  const g = newGame(3);
  const ids = g.players.map(p => p.id);
  const seen = [];
  for (let i = 0; i < 9; i++) { seen.push(cur(g)); E.apply(g, cur(g), { type: 'endTurn' }); }
  assert.deepStrictEqual(seen, [...ids, ...ids, ...ids]);
  assert.strictEqual(g.round, 4);
  assert.ok(g.log.some(l => l.text === `ラウンド 2 / ${g.rounds}`));
  E.forfeit(g, ids[1]);
  const order = [];
  while (g.round === 4) { order.push(cur(g)); E.apply(g, cur(g), { type: 'endTurn' }); }
  assert.deepStrictEqual(order, [ids[0], ids[2]]);
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

test('食料：手番終了時にコア +6・強化済のセル（コアも）+1 を作り、セル1つにつき1を食べる。余りは持ち越す', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 6, events: false });
  const me = cur(g);
  assert.strictEqual(P(g, me).food, 0);
  const free = Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain');
  free.slice(0, 3).forEach(c => { c.owner = me; });           // セル4つ（コアを含む）
  free[0].strong = true;                                        // 強化済1つ
  assert.deepStrictEqual([E.foodMade(g, me), E.foodEaten(g, me)], [6 + 1, 4]);
  E.apply(g, me, { type: 'endTurn' });
  assert.strictEqual(P(g, me).food, 3);                         // 0 + 7 − 4
  assert.ok(g.log.some(l => l.text.includes('食料 +7 −4')));
  // 強化済のコアも +1
  g.board[P(g, me).core].strong = true;
  assert.strictEqual(E.foodMade(g, me), 6 + 1 + 1);
});

test('食料が足りなければ、足りない数だけセルを選んで捨てる（コアは捨てられない）', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1), { radius: 6, events: false });
  const me = cur(g), other = g.players.find(p => p.id !== me).id;
  const mine = Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain').slice(0, 8);
  mine.forEach(c => { c.owner = me; });                          // セル9つ：作る6・食べる9 → 3 足りない
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
  P(g, a).power = 0;
  assert.ok(E.apply(g, a, { type: 'expand', q: mq, r: mr }).ok);
  assert.strictEqual(P(g, a).power, 1);
  assert.ok(E.apply(g, a, { type: 'strengthen', q: mq, r: mr }).ok);
  assert.strictEqual(P(g, a).power, 1 + 1 + 1);       // 強化の +1 と鉱山の +1
  // 破壊で鉱山マスを取ったときも +1
  g.board[t].terrain = 'mine';
  P(g, b).power = 0;
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  E.apply(g, b, { type: 'bid', count: 0 });
  E.apply(g, a, { type: 'bid', count: 1 });
  assert.strictEqual(g.board[t].owner, a);
  assert.strictEqual(P(g, a).power, 3 - 1 + 1);
});

test('農地マス：このセルがあると手番終了時に食料 +1（強化の +1 とは別）', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  const [fq, fr] = nb(g, cq, cr)[0];
  assert.strictEqual(E.foodMade(g, me), 6);
  setCell(g, fq, fr, { owner: me, terrain: 'farm' });
  assert.strictEqual(E.foodMade(g, me), 6 + 1);
  g.board[E.key(fq, fr)].strong = true;
  assert.strictEqual(E.foodMade(g, me), 6 + 1 + 1);
});

test('開墾：資源2・行動1回で、自分の平原のセル（コア以外）を農地にする。毎手番 食料 +1', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  const [aq, ar] = nb(g, cq, cr)[0], [bq, br] = nb(g, cq, cr)[1];
  setCell(g, aq, ar, { owner: me });
  setCell(g, bq, br, { owner: me, terrain: 'forest' });
  P(g, me).resource = 10;
  const t = E.targets(g, me, 'cultivate');
  assert.ok(t.includes(E.key(aq, ar)));
  assert.ok(!t.includes(E.key(bq, br)));       // 森林は不可
  assert.ok(!t.includes(P(g, me).core));       // コアは不可
  const made = E.foodMade(g, me);
  assert.ok(E.apply(g, me, { type: 'cultivate', q: aq, r: ar }).ok);
  assert.deepStrictEqual([g.board[E.key(aq, ar)].terrain, P(g, me).resource, g.actionsLeft], ['farm', 8, 2]);
  assert.strictEqual(E.foodMade(g, me), made + 1);
  assert.match(g.log.at(-1).text, /開墾/);
  assert.strictEqual(E.apply(g, me, { type: 'cultivate', q: aq, r: ar }).ok, false);   // 農地はもう開墾できない
});

test('手番終了の記録：増える前の数・増えた数・減った数が残る（画面の演出用）', () => {
  const g = newGame(2);
  const me = cur(g);
  P(g, me).food = 4;
  const res = P(g, me).resource;
  E.apply(g, me, { type: 'endTurn' });
  const r = g.lastEndTurn;
  assert.deepStrictEqual([r.player, r.resBefore, r.resource, r.foodBefore, r.made, r.eaten, r.hungry], [me, res, 2, 4, 6, 1, 0]);
  assert.strictEqual(P(g, me).food, 4 + 6 - 1);
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

test('イベント：ラウンドの始まりに約1/3の確率で起き、そのラウンドの間続く。予告はしない', () => {
  let rounds = 0, withEvent = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const g = E.createGame(PLAYERS.slice(0, 2), seeded(seed));
    for (let r = 1; r <= g.rounds; r++) { rounds++; if (g.eventPlan[r]) withEvent++; }
    assert.strictEqual(g.event, g.eventPlan[1]);
    assert.strictEqual(g.nextEvent, undefined);
    assert.ok(!g.log.some(l => l.text.startsWith('予告')));
    // ラウンドが進むと入れ替わる
    E.apply(g, cur(g), { type: 'endTurn' });
    E.apply(g, cur(g), { type: 'endTurn' });
    if (!g.over) assert.deepStrictEqual([g.round, g.event], [2, g.eventPlan[2]]);
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
  assert.deepStrictEqual(base, { food: 6 + 1 + 1, eat: 3, res: 2 + 1, act: 3 });
  const as = ev => { g.event = ev; return { food: E.foodMade(g, me), eat: E.foodEaten(g, me), res: E.income(g, me), act: E.actionsThisTurn(g) }; };
  assert.strictEqual(as('famine').food, Math.floor(8 * 0.5));
  assert.strictEqual(as('harvest').food, Math.floor(8 * 1.5));
  assert.strictEqual(as('depletion').res, Math.floor(3 * 0.5));
  assert.strictEqual(as('discovery').res, Math.floor(3 * 1.5));
  assert.strictEqual(as('fishing').food, 8 + side);
  assert.deepStrictEqual([as('flood').food, as('flood').eat], [8, 3 + side]);
  assert.strictEqual(as('festival').act, 4);
  assert.strictEqual(as('plague').act, 2);
  // 行動回数は1回より少なくならない
  g.actionsPerTurn = 1;
  assert.strictEqual(as('plague').act, 1);
});

test('生産：資源2で戦力トークン +1。行動回数を使わず、ログに出ない', () => {
  const g = newGame(2);
  const me = cur(g);
  P(g, me).resource = 5;
  g.actionsLeft = 1;   // 資源1が残っても、拡張できるので手番は続く
  const logLen = g.log.length;
  assert.ok(E.apply(g, me, { type: 'produce' }).ok);
  assert.ok(E.apply(g, me, { type: 'produce' }).ok);
  assert.deepStrictEqual([P(g, me).power, P(g, me).resource, g.actionsLeft], [4, 1, 1]);
  assert.strictEqual(g.log.length, logLen);
  assert.strictEqual(E.apply(g, me, { type: 'produce' }).ok, false);   // 資源1では足りない
});

test('攻防の結果は成功か失敗かだけがログに出る（出した数は出ない）。見える数の目安は、少なくとも出したはずの分だけ減る', () => {
  const { g, a, b, tq, tr } = clashSetup();
  P(g, a).power = 2;
  P(g, b).power = 3;
  assert.deepStrictEqual([P(g, a).powerSeen, P(g, b).powerSeen], [2, 2]);
  E.apply(g, a, { type: 'destroy', q: tq, r: tr });
  E.apply(g, b, { type: 'bid', count: 3 });
  E.apply(g, a, { type: 'bid', count: 1 });
  assert.strictEqual(g.lastClash.success, false);
  assert.ok(!g.log.some(l => /トークン \d+ 個/.test(l.text)));
  assert.ok(g.log.some(l => l.text.includes('出した数は非公開')));
  // 攻撃側は少なくとも1個出した。守られた → 防御側は攻撃側の1個より多く、少なくとも2個出したはず
  assert.deepStrictEqual([P(g, a).powerSeen, P(g, b).powerSeen], [1, 0]);
});

test('鉱山・強化で増えた戦力トークンは、見える数の目安にも足される', () => {
  const g = newGame(2);
  const me = cur(g);
  const [cq, cr] = E.parseKey(P(g, me).core);
  const [mq, mr] = nb(g, cq, cr)[0];
  setCell(g, mq, mr, { terrain: 'mine' });
  P(g, me).resource = 10;
  assert.ok(E.apply(g, me, { type: 'expand', q: mq, r: mr }).ok);
  assert.ok(E.apply(g, me, { type: 'strengthen', q: mq, r: mr }).ok);
  assert.deepStrictEqual([P(g, me).power, P(g, me).powerSeen], [2 + 1 + 2, 2 + 1 + 2]);   // 最初の2・拡張で鉱山+1・強化で+1と鉱山+1
  E.apply(g, me, { type: 'produce' });
  assert.deepStrictEqual([P(g, me).power, P(g, me).powerSeen], [6, 5]);   // 生産は見えない
});

test('河川で区切られても、どのコアも「盤面 ÷ 人数」の 3/5 以上の島を持つ', () => {
  for (const n of [2, 3, 4, 6, 8, 12]) {
    for (let seed = 1; seed <= 10; seed++) {
      const g = newGame(n, seed);
      const total = Object.keys(g.board).length;
      for (const p of g.players) {
        const seen = new Set([p.core]), stack = [E.parseKey(p.core)];
        while (stack.length) {
          const [q, r] = stack.pop();
          for (const [nq, nr] of E.neighbors(q, r)) {
            const k = E.key(nq, nr);
            if (g.board[k] && g.board[k].terrain !== 'river' && !seen.has(k)) { seen.add(k); stack.push([nq, nr]); }
          }
        }
        assert.ok(seen.size >= Math.floor(total * E.RULES.islandShare / n), `${n}人 seed${seed}: ${seen.size}`);
      }
    }
  }
});

test('効果のあるマスは、盤面の中心に近いほど出やすい', () => {
  const inner = [0, 0], outer = [0, 0];
  for (let seed = 1; seed <= 20; seed++) {
    const g = newGame(6, seed);
    for (const c of Object.values(g.board)) {
      if (c.owner || c.terrain === 'river') continue;
      const side = E.dist([c.q, c.r], [0, 0]) <= 1 ? inner : outer;   // 中心とその周り
      side[1]++;
      if (E.TERRAIN_KINDS.includes(c.terrain)) side[0]++;
    }
  }
  assert.ok(inner[0] / inner[1] > outer[0] / outer[1] + 0.1, `中心 ${inner} 外側 ${outer}`);
});

// ---------- リアルタイムモード（実験） ----------

function rtGame(seed) {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(seed || 1), { mode: 'realtime', events: false });
  const [a, b] = g.players.map(p => p.id);
  return { g, a, b };
}

test('リアルタイム：手番がなく、だれでも行動できる。行動力は5秒に1回復（上限5）、行動で1使う', () => {
  const { g, a, b } = rtGame();
  assert.strictEqual(g.mode, 'realtime');
  assert.strictEqual(g.rounds, E.autoTicks(2));
  assert.deepStrictEqual(E.waiting(g), []);
  assert.deepStrictEqual(g.players.map(p => p.ap), [3, 3]);
  for (const id of [a, b]) {
    const [q, r] = E.parseKey(E.targets(g, id, 'expand').find(k => g.board[k].terrain !== 'river'));
    assert.ok(E.apply(g, id, { type: 'expand', q, r }).ok);
  }
  assert.strictEqual(P(g, a).ap, 2);
  P(g, a).ap = 0;
  assert.match(E.actionBlocked(g, a, 'strengthen'), /行動力/);
  assert.strictEqual(E.actionBlocked(g, a, 'produce'), '');            // 生産は行動力を使わない
  for (let i = 0; i < 8; i++) E.rtRegen(g);
  assert.strictEqual(P(g, a).ap, 5);
  assert.strictEqual(E.apply(g, a, { type: 'endTurn' }).ok, false);   // 手番終了はない
});

test('リアルタイム：区切りで全員いっせいに資源と食料。足りなければ自動でセルを捨てる。決まった回数で終わる', () => {
  const { g, a } = rtGame();
  const me = P(g, a);
  Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain').slice(0, 9).forEach(c => { c.owner = a; });
  me.food = 0;
  const cells = E.cellsOf(g, a).length;
  E.rtTick(g);
  assert.strictEqual(g.round, 1);
  assert.strictEqual(g.tickInfo[a].made, 6);
  assert.strictEqual(E.cellsOf(g, a).length, cells - (10 - 6));      // 10マスで食べる10・作る6 → 4つ捨てる
  assert.ok(g.log.some(l => l.tone === 'abandon'));
  for (let i = 1; i < g.rounds; i++) E.rtTick(g);
  assert.ok(g.over);
  assert.match(g.endReason, /回の区切り終了/);
});

test('リアルタイム：破壊は戦力トークン1個ですぐ決まる。隣のセルとのあいだに防御があると、その辺からは攻められない', () => {
  const { g, a, b } = rtGame();
  const [cq, cr] = E.parseKey(P(g, a).core);
  const [tq, tr] = nb(g, cq, cr)[0];
  const t = E.key(tq, tr);
  setCell(g, tq, tr, { owner: b });
  assert.ok(E.targets(g, a, 'destroy').includes(t));            // 強化していなくても、隣なら狙える
  // b が自分のセル t と a のコアのあいだに防御を置くと、そこからは攻められない
  P(g, b).power = 3;
  assert.ok(E.apply(g, b, { type: 'wall', from: t, to: P(g, a).core, count: 2 }).ok);
  assert.deepStrictEqual(g.walls[E.edgeKey(t, P(g, a).core)], { owner: b, hp: 2 });
  assert.strictEqual(P(g, b).power, 1);
  assert.ok(!E.targets(g, a, 'destroy').includes(t));
  // a が防御を壊す（戦力1個で体力1）
  P(g, a).power = 3;
  assert.ok(E.apply(g, a, { type: 'breakWall', from: P(g, a).core, to: t, count: 1 }).ok);
  assert.strictEqual(g.walls[E.edgeKey(t, P(g, a).core)].hp, 1);
  assert.ok(E.apply(g, a, { type: 'breakWall', from: P(g, a).core, to: t, count: 2 }).ok);   // 体力（1）より多くは使わない
  assert.strictEqual(g.walls[E.edgeKey(t, P(g, a).core)], undefined);
  assert.strictEqual(P(g, a).power, 1);
  // 破壊：戦力1個ですぐ自分のセルに
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.deepStrictEqual([g.board[t].owner, P(g, a).power, g.pending], [a, 0, null]);
});

test('リアルタイム：防御は自分のセルどうしのあいだにも置け、外せる。置いた人がどちらのマスも失うと消える', () => {
  const { g, a, b } = rtGame();
  const core = P(g, a).core;
  const [nq, nr] = nb(g, ...E.parseKey(core))[0];
  const n = E.key(nq, nr);
  setCell(g, nq, nr, { owner: a });
  P(g, a).power = 2;
  assert.ok(E.apply(g, a, { type: 'wall', from: n, to: core, count: 1 }).ok);
  assert.strictEqual(E.apply(g, b, { type: 'unwall', from: n, to: core }).ok, false);   // ほかの人は外せない
  assert.ok(E.apply(g, a, { type: 'unwall', from: n, to: core }).ok);
  assert.strictEqual(g.walls[E.edgeKey(n, core)], undefined);
  // 置いたあと、a がどちらのマスも失うと消える
  const far = Object.values(g.board).find(c => !c.owner && c.terrain === 'plain' && E.dist([c.q, c.r], [nq, nr]) === 1 && E.key(c.q, c.r) !== core);
  setCell(g, far.q, far.r, { owner: a });
  E.apply(g, a, { type: 'wall', from: E.key(far.q, far.r), to: n, count: 1 });
  Object.assign(g.board[n], { owner: null });
  Object.assign(g.board[E.key(far.q, far.r)], { owner: null });
  E.rtTick(g);
  assert.deepStrictEqual(g.walls, {});
});
