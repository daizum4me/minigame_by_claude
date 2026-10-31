const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const { Room, CPU_MS } = require('../shared/room');

// タイマーと時計は手で進める
function makeRoom() {
  const inbox = {};
  const timers = [];
  const clock = { t: 1000 };
  const room = new Room({
    code: 'TEST1',
    send: (id, msg) => { (inbox[id] = inbox[id] || []).push(msg); },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    now: () => clock.t,
  });
  const last = id => [...inbox[id]].reverse().find(m => m.type === 'state');
  const fire = ms => {
    const i = timers.findIndex(t => t.ms === ms);
    assert.ok(i >= 0, `${ms}ms のタイマーがない（${timers.map(t => t.ms).join(',')}）`);
    const [t] = timers.splice(i, 1);
    t.fn();
  };
  return { room, inbox, timers, last, clock, fire };
}

function startTwo() {
  const r = makeRoom();
  const h = r.room.join('t1', 'A').id;
  const g = r.room.join('t2', 'B').id;
  r.room.handle(h, { type: 'start' });
  return Object.assign(r, { h, g });
}

const firstEdge = (room, id) => {
  const geo = E.geometry(room.game.cols), p = room.game.players.find(x => x.id === id);
  return geo.verts[geo.trunks[p.trunk].verts[0]].edges.find(k => !geo.reserved.has(k));
};

test('参加・CPU・開始・状態の配信。ゲーム中は新規参加できない。5人まで', () => {
  const { room, last } = makeRoom();
  const h = room.join('t1', 'ホスト').id;
  const g = room.join('t2', 'ホスト').id;
  assert.strictEqual(last(g).room.players[1].name, 'ホスト2');
  room.handle(g, { type: 'start' });
  assert.strictEqual(last(g).room.phase, 'lobby');            // ホスト以外は始められない
  room.handle(h, { type: 'addCpu' }); room.handle(h, { type: 'addCpu' }); room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'addCpu' });                          // 6人目は入れない
  assert.strictEqual(last(h).room.players.length, 5);
  room.handle(h, { type: 'cpuLevel', target: last(h).room.players[2].id, level: 'strong' });
  assert.strictEqual(last(h).room.players[2].level, 'strong');
  room.handle(h, { type: 'start' });
  const st = last(g).room;
  assert.strictEqual(st.phase, 'game');
  assert.strictEqual(st.game.cols, 30);
  assert.ok(room.join('t9', 'x').error);
  assert.strictEqual(room.join('t2', 'ホスト').id, g);          // 同じ人は戻ってこられる
});

test('ほかの人の計画と確定は見えない。自分のものだけ見える。確定した人の数だけ分かる', () => {
  const { room, last, h, g } = startTwo();
  const ek = firstEdge(room, h);
  room.handle(h, { type: 'act', action: { type: 'addBranch', edge: ek } });
  room.handle(h, { type: 'act', action: { type: 'finish' } });
  const mine = last(h).room, theirs = last(g).room;
  assert.deepStrictEqual(mine.game.players.find(p => p.id === h).plan.map(x => x.e), [ek]);
  assert.strictEqual(mine.game.players.find(p => p.id === h).finished, true);
  assert.deepStrictEqual(theirs.game.players.find(p => p.id === h).plan, []);
  assert.strictEqual(theirs.game.players.find(p => p.id === h).finished, false);
  assert.strictEqual(theirs.finishedCount, 1);
  assert.strictEqual(room.game.players.find(p => p.id === h).plan.length, 1);   // ホストの中では保たれている
});

test('全員が確定したら90秒を待たずに次のターンへ。次のターンの時間は数え直し', () => {
  const { room, last, timers, h, g, clock } = startTwo();
  assert.strictEqual(last(h).room.turnLeftMs, 90000);
  assert.ok(timers.some(t => t.ms === 90000));
  const ek = firstEdge(room, h);
  room.handle(h, { type: 'act', action: { type: 'addBranch', edge: ek } });
  room.handle(h, { type: 'act', action: { type: 'finish' } });
  assert.strictEqual(room.game.round, 0);                      // まだ B が確定していない
  clock.t += 20000;
  room.handle(g, { type: 'act', action: { type: 'finish' } });
  assert.strictEqual(room.game.round, 1);
  assert.ok(room.game.edges[ek]);
  assert.strictEqual(last(h).room.turnLeftMs, 90000);
  assert.strictEqual(timers.filter(t => t.ms === 90000).length, 1);
  assert.deepStrictEqual(room.game.players.map(p => [p.plan.length, p.finished]), [[0, false], [0, false]]);
});

test('90秒たったら、その時点の計画のまま自動で確定して進む', () => {
  const { room, fire, h } = startTwo();
  const ek = firstEdge(room, h);
  room.handle(h, { type: 'act', action: { type: 'addBranch', edge: ek } });   // 確定していない
  fire(90000);
  assert.strictEqual(room.game.round, 1);
  assert.ok(room.game.edges[ek]);
});

test('切断中の人は確定したものとみなす。戻ってきたら待つ対象に戻る', () => {
  const { room, h, g } = startTwo();
  room.disconnect(g);
  room.handle(h, { type: 'act', action: { type: 'finish' } });
  assert.strictEqual(room.game.round, 1);
  room.join('t2', 'B');
  room.handle(h, { type: 'act', action: { type: 'finish' } });
  assert.strictEqual(room.game.round, 1);                      // B は戻ってきたので待つ
  room.handle(g, { type: 'act', action: { type: 'finish' } });
  assert.strictEqual(room.game.round, 2);
});

test('CPU はばらつきのある時間をおいて、行動を1つずつ置いて確定する。人が確定していれば全員そろった時点で進む', () => {
  const { room, timers, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  const cpu = timers.filter(t => t.ms >= CPU_MS[0] && t.ms < CPU_MS[1]);
  assert.strictEqual(cpu.length, 1);
  room.handle(h, { type: 'act', action: { type: 'finish' } });
  assert.strictEqual(room.game.round, 0);                      // CPU がまだ
  for (let i = 0; i < 12 && room.game.round === 0; i++) {
    const t = timers.filter(x => x.ms < 5000).sort((a, b) => a.ms - b.ms)[0];
    assert.ok(t, 'CPU のタイマーがない');
    timers.splice(timers.indexOf(t), 1);
    t.fn();
  }
  assert.strictEqual(room.game.round, 1);
  assert.ok(last(h).room.game.lastTurn.turn === 1);
});

test('最後まで進んだら終了。ホストがロビーに戻せる。タイマーは残らない', () => {
  const { room, fire, timers, last, h, g } = startTwo();
  for (let i = 0; i < 36; i++) fire(90000);
  assert.ok(room.game.over);
  assert.strictEqual(timers.length, 0);
  assert.strictEqual(last(g).room.game.over, true);
  room.handle(g, { type: 'lobby' });                            // ホスト以外は戻せない
  assert.strictEqual(last(g).room.phase, 'game');
  room.handle(h, { type: 'lobby' });
  assert.strictEqual(last(h).room.phase, 'lobby');
});

test('だめな行動はエラーで返す', () => {
  const { room, inbox, h } = startTwo();
  room.handle(h, { type: 'act', action: { type: 'addBranch', edge: 'x|y' } });
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  room.handle(h, { type: 'act', action: { type: 'dance' } });
  assert.strictEqual(inbox[h].at(-1).type, 'error');
});
