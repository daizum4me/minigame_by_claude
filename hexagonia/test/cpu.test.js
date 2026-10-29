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

test('CPU どうしで最後まで遊べる（ルール違反の手を選ばない）', () => {
  const stats = { core: 0, rounds: 0 };
  for (let seed = 1; seed <= 33; seed++) {
    const n = 2 + seed % 11;   // 2〜12人
    const rng = seeded(seed);
    const g = E.createGame(PLAYERS.slice(0, n), rng);
    let steps = 0;
    while (!g.over) {
      assert.ok(++steps < 5000, `seed ${seed} で終わらない`);
      for (const id of E.waiting(g)) {
        const a = CPU.decide(g, id, rng);
        const r = E.apply(g, id, a);
        assert.ok(r.ok, `seed ${seed}: ${JSON.stringify(a)} → ${r.error}`);
      }
    }
    if (g.endReason.includes('脱落')) stats.core++; else stats.rounds++;
  }
  // 攻め合いでの決着と、12ラウンドでの決着の両方が起きる
  assert.ok(stats.core > 0, JSON.stringify(stats));
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

test('CPU はコアを守れる数を出し、破りきれるときは必要な数だけ攻撃トークンを出す', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(3));
  const [a, b] = g.players;
  const [cq, cr] = E.parseKey(b.core);
  const [nq, nr] = E.neighbors(cq, cr).find(([q, r]) => g.board[E.key(q, r)]);
  Object.assign(g.board[E.key(nq, nr)], { owner: a.id });
  b.defense = 3;
  a.attack = 1;
  E.apply(g, a.id, { type: 'destroy', q: cq, r: cr });
  // 相手の攻撃トークンは1個なので、2個出せば必ず守れる
  assert.deepStrictEqual(CPU.decide(g, b.id, Math.random), { type: 'bid', count: 2 });
  // 攻撃トークンが相手の防御トークン以上なら、相手の防御トークンと同じ数を出す（相手が全部出しても破れる）
  a.attack = 5; b.defense = 2;
  assert.deepStrictEqual(CPU.decide(g, a.id, Math.random), { type: 'bid', count: 2 });
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
