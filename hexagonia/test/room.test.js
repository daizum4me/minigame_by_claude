const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const { Room } = require('../shared/room');

function makeRoom() {
  const inbox = {};
  const timers = [];
  const room = new Room({
    code: 'TEST1',
    send: (id, msg) => { (inbox[id] = inbox[id] || []).push(msg); },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  });
  const last = id => [...inbox[id]].reverse().find(m => m.type === 'state');
  return { room, inbox, timers, last };
}

test('参加・色・開始・状態の配信', () => {
  const { room, inbox, last } = makeRoom();
  const h = room.join('t1', 'ホスト').id;
  const g = room.join('t2', 'ホスト').id;
  assert.strictEqual(last(g).room.players[1].name, 'ホスト2');
  assert.deepStrictEqual(last(h).room.players.map(p => p.color), ['red', 'blue']);
  room.handle(g, { type: 'color', color: 'red' });
  assert.match(inbox[g].at(-1).text, /ほかの人/);
  room.handle(g, { type: 'color', color: 'yellow' });
  assert.strictEqual(last(h).room.players[1].color, 'yellow');
  room.handle(g, { type: 'start' });
  assert.strictEqual(last(g).room.phase, 'lobby');
  room.handle(h, { type: 'start' });
  const st = last(g).room;
  assert.strictEqual(st.phase, 'game');
  assert.strictEqual(Object.keys(st.game.board).length, 61);
  // 5人目は入れない・ゲーム中は新規参加できない
  assert.ok(room.join('t3', 'x').error);
});

test('行動はホストが検証して全員に配信', () => {
  const { room, inbox, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'start' });
  const turn = E.current(room.game).id;
  const other = turn === h ? g : h;
  room.handle(other, { type: 'act', action: { type: 'reinforce' } });
  assert.strictEqual(inbox[other].at(-1).type, 'error');
  room.handle(turn, { type: 'act', action: { type: 'endTurn' } });
  assert.strictEqual(E.current(last(other).room.game).id, other);
});

test('切断中の人の番は30秒後に自動で進む・戻ってきたら続けられる', () => {
  const { room, timers, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'start' });
  if (E.current(room.game).id !== g) room.handle(h, { type: 'act', action: { type: 'endTurn' } });
  assert.strictEqual(E.current(room.game).id, g);
  room.disconnect(g);
  assert.strictEqual(timers.length, 1);
  assert.strictEqual(last(h).room.graceFor, g);
  timers.shift().fn();
  assert.strictEqual(E.current(room.game).id, h);
  // 戻ってくる
  assert.strictEqual(room.join('t2', 'B').id, g);
  assert.strictEqual(last(g).room.players.find(p => p.id === g).connected, true);
  // 切断中の防御側は、防御トークンがあれば自動で出す
  const gp = room.game.players.find(p => p.id === g);
  gp.defense = 1;
  const [cq, cr] = E.parseKey(gp.core);
  const [nq, nr] = E.neighbors(cq, cr)[0];
  Object.assign(room.game.board[E.key(nq, nr)], { owner: h });
  room.disconnect(g);
  room.handle(h, { type: 'act', action: { type: 'destroy', q: cq, r: cr } });
  assert.strictEqual(room.game.pending.defender, g);
  timers.shift().fn();
  assert.strictEqual(gp.defense, 0);
  assert.ok(gp.alive);
  // ホストが脱落させる
  room.handle(h, { type: 'forfeit', target: g });
  assert.ok(room.game.over);
  assert.deepStrictEqual(room.game.winners, [h]);
  room.handle(h, { type: 'lobby' });
  assert.strictEqual(last(h).room.phase, 'lobby');
  assert.strictEqual(last(h).room.players.length, 1);
});

test('ロビーで切断した人は外れる', () => {
  const { room, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.disconnect(g);
  assert.strictEqual(last(h).room.players.length, 1);
});
