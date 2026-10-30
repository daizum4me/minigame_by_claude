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

// 部屋と同じ間隔で進める：CPU は2.5秒ごと、行動力の回復は5秒ごと、ターンは15秒ごと。
// levelOf(id) が null の人は何もしない。CPU が選んだ手は、ルール上できるものでなければならない
function play(g, rng, levelOf) {
  for (let t = 0; t < 200 && !g.over; t++) {
    for (let step = 1; step <= 6 && !g.over; step++) {
      for (const p of g.players) {
        const level = levelOf(p.id);
        if (!p.alive || !level || g.over) continue;
        const a = CPU.decideRealtime(g, p.id, rng, level);
        if (!a) continue;
        const r = E.apply(g, p.id, a);
        assert.ok(r.ok, `${JSON.stringify(a)} → ${r.error}`);
      }
      if (step % 2 === 0) E.rtRegen(g);
    }
    E.rtTick(g, rng);
  }
  assert.ok(g.over, '終わらない');
  return g;
}

test('CPU どうしで最後まで遊べる（ルール違反の手を選ばない。強さが混ざっていても。2〜12人）', () => {
  for (let seed = 1; seed <= 11; seed++) {
    const n = 2 + seed % 11;
    const rng = seeded(seed);
    const g = E.createGame(PLAYERS.slice(0, n), rng, { rounds: 20 });
    play(g, rng, id => ['weak', 'normal', 'strong'][(id.charCodeAt(0) + seed) % 3]);
    assert.ok(g.winners.length >= 1);
  }
});

test('CPU は何もしない相手に勝つ', () => {
  let wins = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const rng = seeded(seed);
    const g = E.createGame(PLAYERS.slice(0, 2), rng);
    play(g, rng, id => (id === 'a' ? null : 'normal'));
    if (g.winners.length === 1 && g.winners[0] === 'b') wins++;
  }
  assert.ok(wins >= 9, `${wins} / 10`);
});

test('CPU の強さ：よわいはふつうに負け越す（2人戦）', () => {
  let w = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rng = seeded(seed * 7);
    const g = E.createGame(PLAYERS.slice(0, 2), rng);
    const weak = g.players[seed % 2].id;
    play(g, rng, id => (id === weak ? 'weak' : 'normal'));
    if (g.winners.includes(weak)) w += 1 / g.winners.length;
  }
  assert.ok(w / 60 < 0.4, `よわい ${w / 60}`);
});

test('部屋に CPU を入れて遊べる（CPU は2.5秒ごとに考える。CPU には何も送らない）', () => {
  const timers = [];
  const inbox = {};
  let now = 0;   // 時計を進めながら、来たタイマーから順に動かす
  const room = new Room({
    code: 'X', rng: seeded(9), now: () => now,
    send: (id, m) => { (inbox[id] = inbox[id] || []).push(m); },
    setTimer: (fn, ms) => { const t = { fn, ms, at: now + ms }; timers.push(t); return t; },
    clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const h = room.join('t1', 'H').id;
  for (let i = 0; i < 12; i++) room.handle(h, { type: 'addCpu' }); // 13人目は入れない
  assert.strictEqual(room.players.length, 12);
  assert.deepStrictEqual(room.players.filter(p => p.cpu).map(p => p.name), Array.from({ length: 11 }, (_, i) => `CPU ${i + 1}`));
  assert.strictEqual(new Set(room.players.map(p => p.color)).size, 12);   // 12色すべて違う
  while (room.players.length > 3) room.handle(h, { type: 'removeCpu', target: room.players.at(-1).id });
  assert.ok(inbox[h].at(-1).room.players.some(p => p.cpu));
  room.handle(h, { type: 'settings', ticks: 10 });
  room.handle(h, { type: 'start' });
  const g = room.game;
  let acted = 0;
  for (let i = 0; i < 2000 && !g.over; i++) {
    const t = timers.slice().sort((x, y) => x.at - y.at)[0];
    timers.splice(timers.indexOf(t), 1);
    now = t.at;
    const before = g.logSeq;
    t.fn();
    if (t.ms === 2500 && g.logSeq > before) acted++;
  }
  assert.ok(g.over);
  assert.ok(acted > 0, 'CPU が行動した');
  assert.deepStrictEqual(Object.keys(inbox), [h]);
  room.handle(h, { type: 'lobby' });
  assert.strictEqual(room.players.length, 3);
});

function rtSetup() {
  const rng = seeded(5);
  const g = E.createGame(PLAYERS.slice(0, 2), rng, { events: false });
  const [a, b] = g.players;
  return { g, a, b, rng };
}

test('CPU：相手のセルが近づいてきたら、コアに先に防御をつぎ込む', () => {
  const { g, a, b, rng } = rtSetup();
  const [cq, cr] = E.parseKey(a.core);
  const [nq, nr] = E.neighbors(cq, cr).find(([q, r]) => g.board[E.key(q, r)] && g.board[E.key(q, r)].terrain !== 'river');
  const far = E.neighbors(nq, nr).find(([q, r]) => g.board[E.key(q, r)] && E.dist([q, r], [cq, cr]) === 2 && !g.board[E.key(q, r)].owner && g.board[E.key(q, r)].terrain !== 'river');
  Object.assign(g.board[E.key(...far)], { owner: b.id });
  a.resource = 0; a.power = 3; a.ap = 0;      // 資源・行動力がないので、防御だけ選べる
  const act = CPU.decideRealtime(g, a.id, rng, 'strong');
  assert.deepStrictEqual([act.type, E.key(act.q, act.r)], ['fortify', a.core]);
  assert.ok(E.apply(g, a.id, act).ok);
  assert.strictEqual(g.board[a.core].def, 1);
});

test('CPU：防御のある相手のコアは、攻撃を重ねて防御を削ってから奪う（相手の防御の数は見ずに見積もる）', () => {
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
});
