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
const P = (g, id) => g.players.find(p => p.id === id);

// 盤面の中にある隣のマス（コアは一番外側にあるので、隣のマスは3〜4つ）
const nb = (g, q, r) => E.neighbors(q, r).filter(([nq, nr]) => g.board[E.key(nq, nr)]);

// 盤面を空にして、自分で決めた配置にする
function setCell(g, q, r, props) { Object.assign(g.board[E.key(q, r)], { owner: null, strong: false, core: false, terrain: 'plain', def: 0 }, props); }

function rtGame(seed) {
  const g = newGame(2, seed);
  g.players.forEach(p => { p.ap = 3; });   // 行動力は最初は0なので、テストでは3からにしておく
  const [a, b] = g.players.map(p => p.id);
  return { g, a, b };
}

// 自分のコアの隣の空きマス（河川以外）
const freeNext = (g, id) => nb(g, ...E.parseKey(P(g, id).core)).find(([q, r]) => !g.board[E.key(q, r)].owner && g.board[E.key(q, r)].terrain !== 'river');

test('人数ごとの盤面の大きさ（2〜3人は直径 9・4人は 11・5〜6人は 13）と、大きさの指定', () => {
  for (const [n, cells] of [[2, 61], [3, 61], [4, 91], [6, 127]]) {
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

test('12人まで遊べる：6人までは全員が外周、7人以上は約3分の1のコアが内側。人数が多いほどターン数は少ない', () => {
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
    assert.strictEqual(g.rounds, E.autoTicks(n));
  }
  assert.deepStrictEqual([E.autoTicks(2), E.autoTicks(8), E.autoTicks(12)], [18, 16, 14]);
  assert.throws(() => E.createGame([...PLAYERS, { id: 'm', name: 'M', color: 'red' }], seeded(1)));   // 13人は不可
  assert.throws(() => E.createGame(PLAYERS.slice(0, 12), seeded(1), { radius: 3 }));   // 盤面が小さすぎる
  assert.strictEqual(E.createGame(PLAYERS.slice(0, 2), seeded(1), { rounds: 10 }).rounds, 10);
  assert.throws(() => E.createGame(PLAYERS.slice(0, 2), seeded(1), { rounds: 7 }));
});

test('初期状態：資源10・戦力2・行動力0・コア未強化。手番はない', () => {
  const g = newGame(3);
  assert.strictEqual(g.mode, 'realtime');
  for (const p of g.players) {
    assert.deepStrictEqual([p.resource, p.power, p.ap, p.alive], [10, 2, 0, true]);
    const c = g.board[p.core];
    assert.ok(c.core && !c.strong && c.owner === p.id);
  }
  assert.strictEqual(g.round, 0);
  assert.strictEqual(E.apply(g, 'a', { type: 'endTurn' }).ok, false);   // 手番終了はない
  assert.strictEqual(E.apply(g, 'a', { type: 'bid', count: 1 }).ok, false);
});

test('だれでもいつでも行動できる。行動力は5秒に1回復（上限5）、拡張・強化・発展・攻撃で1使う', () => {
  const { g, a, b } = rtGame();
  for (const id of [a, b]) {
    const [q, r] = freeNext(g, id);
    assert.ok(E.apply(g, id, { type: 'expand', q, r }).ok);
  }
  assert.deepStrictEqual(g.players.map(p => p.ap), [2, 2]);
  P(g, a).ap = 0;
  assert.match(E.actionBlocked(g, a, 'strengthen'), /行動力/);
  assert.match(E.actionBlocked(g, a, 'destroy'), /行動力/);
  assert.strictEqual(E.actionBlocked(g, a, 'fortify'), '');            // 防御も使わない
  for (let i = 0; i < 8; i++) E.rtRegen(g);
  assert.strictEqual(P(g, a).ap, 5);
});

test('拡張：隣接する空きマスだけ、資源2。資源不足は不可', () => {
  const { g, a } = rtGame();
  const [q, r] = freeNext(g, a);
  assert.ok(E.targets(g, a, 'expand').includes(E.key(q, r)));
  assert.strictEqual(E.apply(g, a, { type: 'expand', q: 0, r: 0 }).ok, false);   // 離れたマス
  assert.ok(E.apply(g, a, { type: 'expand', q, r }).ok);
  assert.strictEqual(P(g, a).resource, 8);
  P(g, a).resource = 1;
  assert.match(E.actionBlocked(g, a, 'expand'), /資源/);
});

test('強化：資源4で戦力+1。強化済はもう強化できない', () => {
  const { g, a } = rtGame();
  const [q, r] = E.parseKey(P(g, a).core);
  assert.ok(E.apply(g, a, { type: 'strengthen', q, r }).ok);
  assert.deepStrictEqual([P(g, a).resource, P(g, a).power, g.board[P(g, a).core].strong], [6, 3, true]);
  P(g, a).resource = 5;
  assert.strictEqual(E.apply(g, a, { type: 'strengthen', q, r }).ok, false);
});

test('ターンの終わりに全員いっせいに資源（強化済+1・コア+2・強化済のコア+3・森林+1）と食料。決まった回数で終わる', () => {
  const { g, a, b } = rtGame();
  const [q, r] = freeNext(g, a);
  setCell(g, q, r, { owner: a, strong: true });
  const [q2, r2] = freeNext(g, a);
  setCell(g, q2, r2, { owner: a, terrain: 'forest' });
  g.board[P(g, a).core].strong = true;
  E.rtTick(g);
  assert.strictEqual(g.round, 1);
  assert.deepStrictEqual([g.tickInfo[a].resource, P(g, a).resource], [3 + 1 + 1, 15]);
  assert.strictEqual(g.tickInfo[b].resource, 2);
  // 食料：コア +7（強化しても増えない）、セル1つにつき1を食べる
  assert.deepStrictEqual([g.tickInfo[a].made, g.tickInfo[a].eaten, P(g, a).food], [7, 3, 4]);
  for (let i = 1; i < g.rounds; i++) E.rtTick(g);
  assert.ok(g.over);
  assert.match(g.endReason, /ターン終了/);
});

test('食料が足りなければ、ターンの終わりに自動でセルを捨てる（一番大きなかたまりから外れたもの・未強化から。コアは捨てない）', () => {
  const { g, a } = rtGame();
  const me = P(g, a);
  Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain').slice(0, 9).forEach(c => { c.owner = a; });
  me.food = 0;
  const cells = E.cellsOf(g, a).length;
  E.rtTick(g);
  assert.strictEqual(g.tickInfo[a].made, 7);
  assert.strictEqual(E.cellsOf(g, a).length, cells - (10 - 7));      // 10マスで食べる10・作る7 → 3つ捨てる
  assert.ok(g.board[me.core].owner === a);
  assert.ok(g.log.some(l => l.tone === 'abandon'));
  // おすすめ：離れたセルから
  const h = rtGame(3);
  const hc = E.parseKey(P(h.g, h.a).core);
  setCell(h.g, ...nb(h.g, ...hc)[0], { owner: h.a });
  setCell(h.g, 0, 0, { owner: h.a });
  assert.deepStrictEqual(E.suggestAbandon(h.g, h.a, 1), ['0,0']);
});

test('発展：資源4・行動力1で、自分の平原のセル（コア以外）を農地か工場にする。農地はターンごとに食料 +2、工場は戦力 +1', () => {
  const { g, a } = rtGame();
  const [q, r] = freeNext(g, a);
  setCell(g, q, r, { owner: a });
  assert.ok(!E.targets(g, a, 'develop').includes(P(g, a).core));
  assert.strictEqual(E.apply(g, a, { type: 'develop', q, r, to: 'mine' }).ok, false);   // 農地か工場だけ
  assert.ok(E.apply(g, a, { type: 'develop', q, r, to: 'farm' }).ok);
  assert.deepStrictEqual([g.board[E.key(q, r)].terrain, P(g, a).resource, P(g, a).ap], ['farm', 6, 2]);
  assert.strictEqual(E.foodMade(g, a), 9);
  assert.ok(!E.targets(g, a, 'develop').includes(E.key(q, r)));            // 発展ずみの土地はもう発展できない
  // 工場：ターンの終わりに戦力 +1
  const [q2, r2] = nb(g, ...E.parseKey(P(g, a).core)).find(([x, y]) => !g.board[E.key(x, y)].owner && g.board[E.key(x, y)].terrain !== 'river');
  setCell(g, q2, r2, { owner: a });
  P(g, a).resource = 4;
  assert.ok(E.apply(g, a, { type: 'develop', q: q2, r: r2, to: 'factory' }).ok);
  assert.match(g.log.at(-1).text, /工場/);
  assert.strictEqual(E.powerMade(g, a), 1);
  const before = P(g, a).power;
  E.rtTick(g);
  assert.deepStrictEqual([P(g, a).power, g.tickInfo[a].power], [before + 1, 1]);
});

test('鉱山マス：拡張したとき・強化したときに戦力トークン +1', () => {
  const { g, a, b } = rtGame();
  const [q, r] = freeNext(g, a);
  setCell(g, q, r, { terrain: 'mine' });
  P(g, a).resource = 10;
  assert.ok(E.apply(g, a, { type: 'expand', q, r }).ok);
  assert.strictEqual(P(g, a).power, 3);
  assert.ok(E.apply(g, a, { type: 'strengthen', q, r }).ok);
  assert.strictEqual(P(g, a).power, 5);
});

test('生産（資源で戦力を作る）はない', () => {
  const { g, a } = rtGame();
  assert.strictEqual(E.apply(g, a, { type: 'produce' }).ok, false);
  assert.strictEqual(P(g, a).power, 2);
});

test('攻撃は行動力1と戦力トークン1個ですぐ決まる。強化済のセル（拠点）の隣だけ。防御があれば防御が1減るだけで、0のときに壊して空きマスに戻す', () => {
  const { g, a, b } = rtGame();
  const core = P(g, a).core;
  const [cq, cr] = E.parseKey(core);
  const [tq, tr] = nb(g, cq, cr)[0];
  const t = E.key(tq, tr);
  setCell(g, tq, tr, { owner: b });
  assert.ok(!E.targets(g, a, 'destroy').includes(t));           // 未強化のセルの隣からは攻撃できない
  P(g, a).ap = 1;
  assert.strictEqual(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok, false);
  g.board[core].strong = true;                                   // コアを強化すると拠点になる
  assert.ok(E.targets(g, a, 'destroy').includes(t));
  // b がセル t に防御を2つぎ込む（1回で1。行動力は使わない）
  P(g, b).power = 3; P(g, b).ap = 0;
  assert.ok(E.apply(g, b, { type: 'fortify', q: tq, r: tr }).ok);
  assert.ok(E.apply(g, b, { type: 'fortify', q: tq, r: tr }).ok);
  assert.deepStrictEqual([g.board[t].def, P(g, b).power, P(g, b).ap], [2, 1, 0]);
  assert.strictEqual(E.apply(g, b, { type: 'fortify', q: cq, r: cr }).ok, false);   // 相手のセルには置けない
  // 行動力が 0 だと攻撃できない。1回目・2回目は防御が減るだけ、3回目で壊す
  P(g, a).power = 3; P(g, a).ap = 0;
  assert.strictEqual(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok, false);
  P(g, a).ap = 3;
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.deepStrictEqual([g.board[t].owner, g.board[t].def], [b, 1]);
  assert.match(g.log.at(-1).text, /攻撃（防御を削った）/);
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.ok(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok);
  assert.deepStrictEqual([g.board[t].owner, g.board[t].def || 0, P(g, a).power, P(g, a).ap], [null, 0, 0, 0]);   // 攻撃側のセルにはならない
  assert.match(g.log.at(-1).text, /^攻撃成功：.*を壊した（空きマスに戻る）/);
  // 攻撃の記録（攻撃されたことを画面で知らせる）
  assert.deepStrictEqual(g.attacks.map(x => [x.by, x.victim, x.key, x.took]), [[a, b, t, false], [a, b, t, false], [a, b, t, true]]);
  assert.strictEqual(E.apply(g, a, { type: 'destroy', q: tq, r: tr }).ok, false);   // 戦力がない
});

test('リアルタイム：防御を解除すると、つぎ込んだ戦力トークンが全部戻る（行動力は使わない）。セルを失うと防御もなくなる', () => {
  const { g, a, b } = rtGame();
  const core = P(g, a).core;
  const [cq, cr] = E.parseKey(core);
  P(g, a).power = 3; P(g, a).ap = 3;
  E.apply(g, a, { type: 'fortify', q: cq, r: cr });
  E.apply(g, a, { type: 'fortify', q: cq, r: cr });
  assert.deepStrictEqual([g.board[core].def, P(g, a).power], [2, 1]);
  assert.strictEqual(E.apply(g, b, { type: 'unfortify', q: cq, r: cr }).ok, false);   // ほかの人は解除できない
  P(g, a).ap = 0;
  assert.ok(E.apply(g, a, { type: 'unfortify', q: cq, r: cr }).ok);
  assert.deepStrictEqual([g.board[core].def, P(g, a).power], [0, 3]);
  // 防御のあるセルを捨てると、防御もなくなる
  const [nq, nr] = nb(g, cq, cr)[0];
  setCell(g, nq, nr, { owner: a, def: 2 });
  P(g, a).food = 0;
  Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain').slice(0, 9).forEach(c => { c.owner = a; });
  E.rtTick(g);
  const lost = Object.values(g.board).filter(c => c.owner === null && c.def);
  assert.deepStrictEqual(lost, []);
});

test('リアルタイム：セルの防御は6まで', () => {
  const { g, a } = rtGame();
  const [cq, cr] = E.parseKey(P(g, a).core);
  P(g, a).power = 10;
  for (let i = 0; i < 6; i++) assert.ok(E.apply(g, a, { type: 'fortify', q: cq, r: cr }).ok);
  const r = E.apply(g, a, { type: 'fortify', q: cq, r: cr });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual([g.board[P(g, a).core].def, P(g, a).power], [6, 4]);
});

test('橋：河川マスへの拡張は資源5。強化できる。攻撃で壊されると河川に戻る', () => {
  const { g, a, b } = rtGame();
  const [rq, rr] = freeNext(g, a);
  const rk = E.key(rq, rr);
  g.board[rk].terrain = 'river';
  P(g, a).resource = 4;
  assert.ok(!E.targets(g, a, 'expand').includes(rk));     // 資源4では足りない
  P(g, a).resource = 10;
  assert.ok(E.apply(g, a, { type: 'expand', q: rq, r: rr }).ok);
  assert.strictEqual(P(g, a).resource, 5);
  assert.ok(E.apply(g, a, { type: 'strengthen', q: rq, r: rr }).ok);
  const [bq, br] = nb(g, rq, rr).find(([q, r]) => !g.board[E.key(q, r)].owner && g.board[E.key(q, r)].terrain !== 'river');
  setCell(g, bq, br, { owner: b, strong: true });
  assert.ok(E.apply(g, b, { type: 'destroy', q: rq, r: rr }).ok);
  assert.deepStrictEqual([g.board[rk].owner, g.board[rk].terrain, g.board[rk].strong], [null, 'river', false]);
});

test('コアを壊すと脱落し、残りのセルは空きマスに戻る（だれのものにもならない）。トークンは壊した人が受け継ぐ。最後の1人が勝つ', () => {
  const g = newGame(3);
  const [a, b, c] = g.players.map(p => p.id);
  const [bq, br] = E.parseKey(P(g, b).core);
  const [nq, nr] = nb(g, bq, br).find(([q, r]) => !g.board[E.key(q, r)].owner);
  setCell(g, nq, nr, { owner: a, strong: true });
  const [xq, xr] = freeNext(g, b);
  setCell(g, xq, xr, { owner: b, strong: true });
  P(g, b).resource = 7; P(g, b).food = 4; P(g, a).ap = 1;
  assert.ok(E.apply(g, a, { type: 'destroy', q: bq, r: br }).ok);
  assert.strictEqual(P(g, b).alive, false);
  assert.deepStrictEqual([g.board[E.key(bq, br)].owner, g.board[E.key(bq, br)].core, g.board[E.key(xq, xr)].owner, g.board[E.key(xq, xr)].strong], [null, false, null, false]);
  assert.deepStrictEqual([P(g, a).resource, P(g, a).power, P(g, a).food], [10 + 7, 1 + 2, 4]);
  assert.ok(!g.over);
  E.forfeit(g, c);
  assert.ok(g.over);
  assert.deepStrictEqual(g.winners, [a]);
});

test('途中で脱落させる（切断）：セルは空きマスに戻る', () => {
  const g = newGame(3);
  const [a, b] = g.players.map(p => p.id);
  E.forfeit(g, b);
  assert.strictEqual(P(g, b).alive, false);
  assert.deepStrictEqual(E.cellsOf(g, b), []);
  assert.strictEqual(g.board[P(g, b).core].owner, null);
  assert.ok(!g.over);
  const [bq, br] = E.parseKey(P(g, b).core), [aq, ar] = E.parseKey(P(g, a).core);
  assert.strictEqual(E.apply(g, b, { type: 'fortify', q: bq, r: br }).ok, false);
  assert.ok(E.apply(g, a, { type: 'fortify', q: aq, r: ar }).ok);
});

test('勝敗はセルの総数ではなく、つながっている一番大きなかたまりで決まる。同じなら同率優勝', () => {
  const { g, a, b } = rtGame();
  // a：コア + 離れたセル2つ（かたまり1・合計3）、b：コア + つながったセル1つ（かたまり2・合計2）
  setCell(g, ...freeNext(g, b), { owner: b });
  const lone = () => Object.values(g.board).find(c => !c.owner && c.terrain !== 'river' && !nb(g, c.q, c.r).some(([q, r]) => g.board[E.key(q, r)].owner));
  for (let i = 0; i < 2; i++) { const c = lone(); setCell(g, c.q, c.r, { owner: a }); }
  assert.deepStrictEqual([E.cellsOf(g, a).length, E.largestGroup(g, a).length], [3, 1]);
  for (let i = 0; i < g.rounds; i++) E.rtTick(g);
  assert.ok(g.over);
  assert.deepStrictEqual(g.winners, [b]);
  const h = rtGame(2);
  for (let i = 0; i < h.g.rounds; i++) E.rtTick(h.g);
  assert.deepStrictEqual(h.g.winners.sort(), [h.a, h.b].sort());
});

test('イベント：ターン4〜8回ごとに起き、1ターンのあいだ続く。効果（不作・豊作・枯渇・発見・豊漁・洪水・祭事・疫病）', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(5), { rounds: 40 });
  let seen = 0;
  for (let i = 0; i < 30 && !g.over; i++) {
    E.rtTick(g);
    if (g.event) { seen++; assert.strictEqual(g.eventUntil, g.round + 1); }
  }
  assert.ok(seen >= 3);
  const { g: h, a } = rtGame();
  const base = [E.income(h, a), E.foodMade(h, a)];
  const at = ev => { h.event = ev; return [E.income(h, a), E.foodMade(h, a)]; };
  assert.deepStrictEqual(at('famine'), [base[0], 3]);
  assert.deepStrictEqual(at('harvest'), [base[0], 10]);
  assert.deepStrictEqual(at('depletion'), [1, base[1]]);
  assert.deepStrictEqual(at('discovery'), [3, base[1]]);
  h.event = 'festival';
  assert.strictEqual(E.apMax(h), 6);
  for (let i = 0; i < 5; i++) E.rtRegen(h);
  assert.strictEqual(P(h, a).ap, 6);
  h.event = 'plague';
  assert.strictEqual(E.apMax(h), 4);
  const no = E.createGame(PLAYERS.slice(0, 2), seeded(5), { events: false });
  for (let i = 0; i < 30; i++) E.rtTick(no);
  assert.strictEqual(no.event, null);
});
