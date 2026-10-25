'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Room } = require('../shared/room');

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const inbox = {};
  const room = new Room({
    code: 'TEST',
    send(pid, msg) { (inbox[pid] = inbox[pid] || []).push(msg); },
  });
  const tick = ms => t.mock.timers.tick(ms);
  const last = pid => inbox[pid].filter(m => m.type === 'state').slice(-1)[0].state;
  return { room, inbox, tick, last };
}

test('ロビー：名前の重複に番号、ホスト、満員・ゲーム中の参加拒否', t => {
  const { room, tick, last } = setup(t);
  const a = room.join('ta', 'おばけ', '🎃').id;
  const b = room.join('tb', 'おばけ', '🎃').id;
  room.attach(a); room.attach(b);
  tick(1);
  const v = last(a);
  assert.equal(v.hostId, a);
  assert.deepEqual(v.players.map(p => p.name), ['おばけ', 'おばけ2']);
  assert.notEqual(v.players[0].icon, v.players[1].icon);
  room.handle(b, { type: 'start' });          // ホスト以外は開始できない
  tick(1);
  assert.equal(last(a).phase, 'lobby');
  room.handle(a, { type: 'start' });
  tick(1);
  assert.equal(last(a).phase, 'talk');
  assert.ok(room.join('tc', 'x').error);
  assert.equal(room.join('tb', 'x').id, b, '同じ識別子なら復帰できる');
});

test('CPU入りで最後まで遊べて、他人の秘密は送られない', t => {
  const { room, inbox, tick, last } = setup(t);
  const me = room.join('me', 'あなた', '🎃').id;
  room.attach(me);
  room.handle(me, { type: 'settings', settings: { rounds: 3, houses: 4 } });
  for (let i = 0; i < 3; i++) room.handle(me, { type: 'addCpu' });
  room.handle(me, { type: 'start' });
  tick(1);
  assert.equal(last(me).players.length, 4);

  for (let round = 1; round <= 3; round++) {
    let v = last(me);
    assert.equal(v.phase, 'talk');
    assert.equal(v.round, round);
    assert.ok(v.me.hint, 'ヒントが見える');
    assert.ok(v.me.mission, 'ミッションが見える');
    const text = JSON.stringify(v);
    // 家の状態は自分のヒントの1軒以外届かない
    assert.equal(v.houses.filter(h => h.state).length, 0);
    assert.ok(!('hints' in v));
    assert.ok(!text.includes('"token"'));

    room.handle(me, { type: 'skip' });          // CPUはスキップに同意している
    tick(1);
    v = last(me);
    assert.equal(v.phase, 'choose');
    room.handle(me, { type: 'confirm', house: 0 });
    tick(1);
    v = last(me);
    assert.equal(v.me.choice, 0);
    assert.ok(!('result' in v), '公開前の選択は送らない');
    tick(5000);                                // CPUが確定する
    v = last(me);
    assert.equal(v.phase, 'result');
    assert.equal(v.result.visitors.flat().length, 4);
    v.houses.forEach((h, i) => assert.equal(!!h.state, v.result.visitors[i].length > 0, '訪問された家だけ公開'));
    room.handle(me, { type: 'next' });          // 演出中はまだ押せない
    tick(1);
    assert.equal(last(me).phase, 'result');
    tick(3000);
    room.handle(me, { type: 'next' });
    tick(1);
  }
  const v = last(me);
  assert.equal(v.phase, 'final');
  assert.equal(v.final.ranking.length, 4);
  v.final.ranking.forEach(r => {
    const p = v.players.find(q => q.id === r.id);
    assert.equal(r.candy, p.candy);
    assert.equal(r.stats.house + r.stats.steal + r.stats.mission, r.candy, '内訳の合計＝お菓子');
  });
  assert.ok(inbox[me].some(m => m.type === 'chat' && m.msg.kind === 'sys'));

  room.handle(me, { type: 'playAgain' });
  tick(1);
  assert.equal(last(me).phase, 'lobby');
  assert.equal(last(me).players.length, 4);
});

test('時間切れ・切断中の人はランダムな家へ。切断中の人はスキップの合意に含めない', t => {
  const { room, tick, last } = setup(t);
  const a = room.join('ta', 'A').id;
  const b = room.join('tb', 'B').id;
  room.attach(a); room.attach(b);
  room.handle(a, { type: 'start' });
  tick(1);
  room.disconnect(b);
  room.handle(a, { type: 'skip' });
  tick(1);
  assert.equal(last(a).phase, 'choose');
  assert.equal(last(a).skip.need, 1);
  room.handle(a, { type: 'confirm', house: 1 });   // 切断中の人は待たない
  tick(1);
  const v = last(a);
  assert.equal(v.phase, 'result');
  assert.equal(v.result.deltas[b].timedOut, true);
  // 時間切れ
  tick(10000);
  assert.equal(last(a).phase, 'talk');
  room.join('tb', 'B');
  room.attach(b);
  tick(120000);
  tick(30000);
  const w = last(a);
  assert.equal(w.phase, 'result');
  assert.equal(w.result.deltas[a].timedOut, true);
  assert.equal(w.result.deltas[b].timedOut, true);
});

test('宣言はチャットに流れ、全員に見える。キックしたら戻れない', t => {
  const { room, inbox, tick, last } = setup(t);
  const a = room.join('ta', 'A').id;
  const b = room.join('tb', 'B').id;
  const c = room.join('tc', 'C').id;
  room.attach(a); room.attach(b); room.attach(c);
  room.handle(a, { type: 'kick', id: c });
  tick(1);
  assert.ok(inbox[c].some(m => m.type === 'kicked'));
  assert.ok(room.join('tc', 'C').error);
  room.handle(a, { type: 'start' });
  tick(1);
  room.handle(b, { type: 'declare', house: 2 });
  tick(1);
  assert.equal(last(a).players.find(p => p.id === b).declare, 2);
  assert.ok(inbox[a].some(m => m.type === 'chat' && m.msg.text.includes('3番')));
  room.handle(b, { type: 'declare', house: null });
  tick(1);
  assert.equal(last(a).players.find(p => p.id === b).declare, null);
});

test('ホストが抜けたら次に古い参加者が引き継ぐ', t => {
  const { room, tick, last } = setup(t);
  const a = room.join('ta', 'A').id;
  const b = room.join('tb', 'B').id;
  room.attach(b);
  room.disconnect(a);
  tick(31000);
  assert.equal(last(b).hostId, b);
  assert.equal(last(b).players.length, 1);
});
