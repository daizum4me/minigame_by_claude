const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const CPU = require('../shared/cpu');
const { Room } = require('../shared/room');

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

const PLAYERS = 'abcdefghijkl'.split('').map(id => ({ id, name: id.toUpperCase(), color: 'red' }));

test('CPU どうしで最後まで遊べる（ルール違反の手を選ばない。強さが混ざっていても）', () => {
  const stats = { core: 0, rounds: 0 };
  for (let seed = 1; seed <= 33; seed++) {
    const n = 2 + seed % 11;   // 2〜12人
    const rng = seeded(seed);
    const g = E.createGame(PLAYERS.slice(0, n), rng);
    let steps = 0;
    while (!g.over) {
      assert.ok(++steps < 5000, `seed ${seed} で終わらない`);
      for (const id of E.waiting(g)) {
        const level = ['weak', 'normal', 'strong'][(id.charCodeAt(0) + seed) % 3];
        const a = CPU.decide(g, id, rng, level);
        const r = E.apply(g, id, a);
        assert.ok(r.ok, `seed ${seed}: ${JSON.stringify(a)} → ${r.error}`);
      }
    }
    if (g.endReason.includes('脱落')) stats.core++; else stats.rounds++;
  }
  assert.strictEqual(stats.core + stats.rounds, 33);
});

test('2人戦では、攻め合いでの決着と、最後のラウンドでの決着の両方が起きる', () => {
  const stats = { core: 0, rounds: 0 };
  // コアを破壊するには、コアの隣に強化済のセル（拠点）を作る必要があるので、攻め合いでの決着はまれ（100戦に1〜3回ほど）。
  // 両方が起きるまで回す
  for (let seed = 1; seed <= 250 && !(stats.core && stats.rounds); seed++) {
    const rng = seeded(seed);
    const g = E.createGame(PLAYERS.slice(0, 2), rng);
    while (!g.over) for (const id of E.waiting(g)) E.apply(g, id, CPU.decide(g, id, rng));
    if (g.endReason.includes('脱落')) stats.core++; else stats.rounds++;
  }
  assert.ok(stats.core > 0 && stats.rounds > 0, JSON.stringify(stats));
});

test('CPU は何もしない相手に勝つ', () => {
  let wins = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const rng = seeded(seed);
    const g = E.createGame(PLAYERS.slice(0, 2), rng);
    while (!g.over) {
      for (const id of E.waiting(g)) {
        const a = id === 'a' ? (g.pending ? { type: 'bid', count: 0 } : { type: 'endTurn' }) : CPU.decide(g, id, rng);
        E.apply(g, id, a);
      }
    }
    if (g.winners.length === 1 && g.winners[0] === 'b') wins++;
  }
  assert.strictEqual(wins, 10);
});

test('CPU はコアを守れる数を出し、攻撃では相手の戦力トークンを（実際の数を見ずに）見積もって出す', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(3));
  const [a, b] = g.players;
  const [cq, cr] = E.parseKey(b.core);
  const [nq, nr] = E.neighbors(cq, cr).find(([q, r]) => g.board[E.key(q, r)]);
  Object.assign(g.board[E.key(nq, nr)], { owner: a.id, strong: true });
  b.power = 3;
  a.power = 2;
  a.resource = 10;
  E.apply(g, a.id, { type: 'destroy', q: cq, r: cr });
  // 相手の数は見えないので、見えている数（最初の2個）＋見えない生産の分1個 = 3個と見積もる。
  // 同じ数では負けるので、守りきるには4個要る。足りないが、コアなので全部（3個）出す
  assert.deepStrictEqual(CPU.decide(g, b.id, Math.random), { type: 'bid', count: 3 });
  // 攻撃側も、相手を3個と見積もり、同じ数なら勝てるので3個出す
  a.power = 5; b.power = 0;
  assert.deepStrictEqual(CPU.decide(g, a.id, Math.random), { type: 'bid', count: 3 });
});

test('部屋に CPU を入れて遊べる', () => {
  const timers = [];
  const inbox = {};
  const room = new Room({
    code: 'X', rng: seeded(9),
    send: (id, m) => { (inbox[id] = inbox[id] || []).push(m); },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const h = room.join('t1', 'H').id;
  for (let i = 0; i < 12; i++) room.handle(h, { type: 'addCpu' }); // 13人目は入れない
  assert.strictEqual(room.players.length, 12);
  assert.deepStrictEqual(room.players.filter(p => p.cpu).map(p => p.name), Array.from({ length: 11 }, (_, i) => `CPU ${i + 1}`));
  assert.strictEqual(new Set(room.players.map(p => p.color)).size, 12);   // 12色すべて違う
  while (room.players.length > 3) room.handle(h, { type: 'removeCpu', target: room.players.at(-1).id });
  assert.strictEqual(room.players.length, 3);
  assert.ok(inbox[h].at(-1).room.players.some(p => p.cpu));
  room.handle(h, { type: 'start' });
  let steps = 0;
  while (!room.game.over) {
    assert.ok(++steps < 5000);
    if (E.waiting(room.game).includes(h)) {
      room.handle(h, { type: 'act', action: room.game.pending ? { type: 'bid', count: 0 } : { type: 'endTurn' } });
      continue;
    }
    // CPU の行動の予約（持ち時間などのタイマーとは長さで見分ける）
    const i = timers.findIndex(t => t.ms < 1000);
    assert.ok(i >= 0, 'CPU の行動が予約されている');
    timers.splice(i, 1)[0].fn();
  }
  // CPU には何も送らない
  assert.deepStrictEqual(Object.keys(inbox), [h]);
  room.handle(h, { type: 'lobby' });
  assert.strictEqual(room.players.length, 3);
});

test('CPU の強さ：つよいはふつうに勝ち越し、よわいはふつうに負け越す（2人戦）', () => {
  const share = level => {
    let w = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rng = seeded(seed * 7);
      const g = E.createGame(PLAYERS.slice(0, 2), rng);
      const test = g.players[seed % 2].id;
      while (!g.over) for (const id of E.waiting(g)) E.apply(g, id, CPU.decide(g, id, rng, id === test ? level : 'normal'));
      if (g.winners.includes(test)) w += 1 / g.winners.length;
    }
    return w / 40;
  };
  const strong = share('strong'), weak = share('weak');
  assert.ok(strong > 0.5, `つよい ${strong}`);
  assert.ok(weak < 0.4, `よわい ${weak}`);
});

// リアルタイムモードの CPU：防御を置く・壊す
function rtSetup() {
  const rng = seeded(5);
  const g = E.createGame(PLAYERS.slice(0, 2), rng, { mode: 'realtime', events: false });
  const [a, b] = g.players;
  Object.values(g.board).forEach(c => { if (!c.core && c.owner) c.owner = null; });
  return { g, a, b, rng };
}

test('リアルタイムの CPU：相手のセルが近づいてきたら、コアに先に防御をつぎ込む', () => {
  const { g, a, b, rng } = rtSetup();
  const [cq, cr] = E.parseKey(a.core);
  const [nq, nr] = E.neighbors(cq, cr).find(([q, r]) => g.board[E.key(q, r)] && g.board[E.key(q, r)].terrain !== 'river');
  const far = E.neighbors(nq, nr).find(([q, r]) => g.board[E.key(q, r)] && E.dist([q, r], [cq, cr]) === 2 && !g.board[E.key(q, r)].owner && g.board[E.key(q, r)].terrain !== 'river');
  Object.assign(g.board[E.key(...far)], { owner: b.id });
  a.resource = 0; a.power = 3; a.ap = 3;      // 資源がないので、拡張・強化などはできず、防御だけ選べる
  const act = CPU.decideRealtime(g, a.id, rng, 'strong');
  assert.deepStrictEqual([act.type, E.key(act.q, act.r)], ['fortify', a.core]);
  assert.ok(E.apply(g, a.id, act).ok);
  assert.strictEqual(g.board[a.core].def, 1);
});

test('リアルタイムの CPU：防御のある相手のコアは、攻撃を重ねて防御を削ってから奪う。練習相手は防御しない', () => {
  const { g, a, b, rng } = rtSetup();
  const [fq, fr] = E.parseKey(b.core);
  const [nq, nr] = E.neighbors(fq, fr).find(([q, r]) => g.board[E.key(q, r)] && g.board[E.key(q, r)].terrain !== 'river');
  Object.assign(g.board[E.key(nq, nr)], { owner: a.id });
  g.board[b.core].def = 1;
  a.resource = 0; a.power = 5; a.ap = 2;      // 攻撃は行動力を1使う
  const act = CPU.decideRealtime(g, a.id, rng, 'strong');
  assert.deepStrictEqual([act.type, E.key(act.q, act.r)], ['destroy', b.core]);
  assert.ok(E.apply(g, a.id, act).ok);
  assert.strictEqual(g.board[b.core].def, 0);   // 1回目は防御が減るだけ
  const act2 = CPU.decideRealtime(g, a.id, rng, 'strong');
  assert.ok(E.apply(g, a.id, act2).ok);
  assert.strictEqual(b.alive, false);          // 2回目でコアを奪う
  // 練習相手（passive）は、相手が隣にいても防御しない
  const t = rtSetup();
  const [cq, cr] = E.parseKey(t.a.core);
  const [q2, r2] = E.neighbors(cq, cr).find(([q, r]) => t.g.board[E.key(q, r)] && t.g.board[E.key(q, r)].terrain !== 'river');
  Object.assign(t.g.board[E.key(q2, r2)], { owner: t.b.id });
  t.a.resource = 0; t.a.power = 3; t.a.ap = 3;
  const tt = CPU.decideRealtime(t.g, t.a.id, t.rng, 'tutorial');
  assert.ok(!tt || tt.type !== 'fortify');
});
