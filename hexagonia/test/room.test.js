const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const { Room, CHAT_KEEP, CHAT_LEN } = require('../shared/room');

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
  // その長さのタイマーを1つ取り出して動かす
  const fire = ms => {
    const i = timers.findIndex(t => t.ms === ms);
    assert.ok(i >= 0, `${ms}ms のタイマーがない（${timers.map(t => t.ms).join(',')}）`);
    const [t] = timers.splice(i, 1);
    t.fn();
  };
  return { room, inbox, timers, last, clock, fire };
}

// 2人で始める
function startTwo() {
  const r = makeRoom();
  const h = r.room.join('t1', 'A').id;
  const g = r.room.join('t2', 'B').id;
  r.room.handle(h, { type: 'start' });
  r.fire(3000);   // カウントダウン
  return Object.assign(r, { h, g });
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

test('ロビーで切断した人は外れる', () => {
  const { room, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.disconnect(g);
  assert.strictEqual(last(h).room.players.length, 1);
});

test('ホストは盤面の直径を設定できる', () => {
  const { room, inbox, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(g, { type: 'settings', diameter: 13 });   // ホスト以外は変えられない
  assert.strictEqual(last(h).room.settings.diameter, 0);
  room.handle(h, { type: 'settings', diameter: 8 });    // 偶数は不可
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  room.handle(h, { type: 'settings', diameter: 23 });   // 範囲外
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  room.handle(h, { type: 'settings', diameter: 13 });
  assert.strictEqual(last(g).room.settings.diameter, 13);
  room.handle(h, { type: 'start' });
  assert.strictEqual(room.game.radius, 6);
  assert.strictEqual(Object.keys(room.game.board).length, 127);
});

test('チャット：全員に届き、ロビーからゲームまで続く。文字数・件数・連投に上限がある', () => {
  const { room, inbox, last, clock } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'chat', text: '  よろしく\n ' });
  assert.deepStrictEqual(last(g).room.chat.map(c => [c.from, c.name, c.text]), [[h, 'A', 'よろしく']]);
  assert.strictEqual(last(h).room.chat.length, 1);
  // 空は送らない・すぐの連投は断る
  room.handle(g, { type: 'chat', text: '   ' });
  assert.strictEqual(last(h).room.chat.length, 1);
  room.handle(h, { type: 'chat', text: 'もう一度' });
  assert.match(inbox[h].at(-1).text, /少し待って/);
  // 長すぎる分は切る
  clock.t += 1000;
  room.handle(g, { type: 'chat', text: 'あ'.repeat(200) });
  assert.strictEqual(last(h).room.chat.at(-1).text.length, CHAT_LEN);
  // ゲームが始まっても残る
  room.handle(h, { type: 'start' });
  assert.strictEqual(last(g).room.chat.length, 2);
  // 古いものから消える
  for (let i = 0; i < CHAT_KEEP + 5; i++) { clock.t += 1000; room.handle(h, { type: 'chat', text: 'm' + i }); }
  const chat = last(g).room.chat;
  assert.strictEqual(chat.length, CHAT_KEEP);
  assert.strictEqual(chat.at(-1).text, 'm' + (CHAT_KEEP + 4));
});

test('CPU の強さはホストだけがロビーで変えられ、配信される', () => {
  const { room, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'addCpu' });
  const cpu = room.players.find(p => p.cpu);
  assert.strictEqual(last(g).room.players.find(p => p.cpu).level, 'normal');
  room.handle(g, { type: 'cpuLevel', target: cpu.id, level: 'strong' });   // ホスト以外は変えられない
  assert.strictEqual(cpu.level, 'normal');
  room.handle(h, { type: 'cpuLevel', target: cpu.id, level: 'unknown' });
  assert.strictEqual(cpu.level, 'normal');
  room.handle(h, { type: 'cpuLevel', target: cpu.id, level: 'strong' });
  assert.strictEqual(last(g).room.players.find(p => p.cpu).level, 'strong');
  assert.strictEqual(last(g).room.players.find(p => p.id === h).level, undefined);
});

test('セルの防御は、そのセルの持ち主にしか見えない（ほかの人には、あるかどうかもわからない）。ログにも出ない', () => {
  const { room, last, fire } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'start' });
  fire(3000);
  const gm = room.game, me = gm.players.find(p => p.id === h);
  const [cq, cr] = E.parseKey(me.core);
  me.power = 4; me.ap = 3;
  room.handle(h, { type: 'act', action: { type: 'fortify', q: cq, r: cr } });
  room.handle(h, { type: 'act', action: { type: 'fortify', q: cq, r: cr } });
  assert.strictEqual(gm.board[me.core].def, 2);
  assert.strictEqual(last(h).room.game.board[me.core].def, 2);
  assert.strictEqual(last(g).room.game.board[me.core].def, 0);
  assert.ok(!gm.log.some(l => /防御/.test(l.text)));
});

test('ゲーム開始の前に3秒のカウントダウン。そのあいだは行動できず、ターンも進まない', () => {
  const { room, inbox, last, fire, timers } = makeRoom();
  const h = room.join('t1', 'A').id;
  room.join('t2', 'B');
  room.handle(h, { type: 'start' });
  assert.deepStrictEqual([last(h).room.countdownMs, last(h).room.tickLeftMs], [3000, 0]);
  assert.ok(!timers.some(t => t.ms === 30000));
  const me = room.game.players.find(p => p.id === h);
  const [q, r] = E.parseKey(me.core);
  room.handle(h, { type: 'act', action: { type: 'fortify', q, r } });
  assert.match(inbox[h].at(-1).text, /まだ始まっていません/);
  fire(3000);
  assert.deepStrictEqual([last(h).room.countdownMs, last(h).room.tickLeftMs], [0, 30000]);
  room.handle(h, { type: 'act', action: { type: 'fortify', q, r } });
  assert.strictEqual(room.game.board[me.core].def, 1);
});

test('行動はホストが検証して全員に配信。だれでもいつでも行動できる', () => {
  const { room, inbox, last, h, g } = startTwo();
  const fort = id => { const [q, r] = E.parseKey(room.game.players.find(p => p.id === id).core); room.handle(id, { type: 'act', action: { type: 'fortify', q, r } }); };
  fort(g);
  assert.strictEqual(room.game.players.find(p => p.id === g).power, 1);
  fort(h);
  assert.strictEqual(last(h).room.game.players.find(p => p.id === h).power, 1);
  room.handle(h, { type: 'act', action: { type: 'endTurn' } });
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  assert.ok(!('turnLeftMs' in last(h).room));
});

test('30秒ごとにターンが進み、5秒ごとに行動力が回復。ターン数はホストが設定できる', () => {
  const { room, inbox, last, fire, timers } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'settings', ticks: 7 });
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  room.handle(g, { type: 'settings', ticks: 12 });   // ホスト以外は変えられない
  assert.strictEqual(room.settings.ticks, 0);
  room.handle(h, { type: 'settings', ticks: 12 });
  assert.deepStrictEqual(last(g).room.settings, { diameter: 0, ticks: 12 });
  room.handle(h, { type: 'start' });
  fire(3000);
  const gm = room.game;
  assert.deepStrictEqual([gm.mode, gm.rounds], ['realtime', 12]);
  assert.strictEqual(last(h).room.tickLeftMs, 30000);
  const me = gm.players.find(p => p.id === h);
  me.ap = 0;
  fire(5000);
  assert.strictEqual(me.ap, 1);
  fire(30000);
  assert.strictEqual(gm.round, 1);
  assert.ok(timers.some(t => t.ms === 30000) && timers.some(t => t.ms === 5000));   // 次のターン・回復も予約される
});

test('CPU は2.5秒ごとに考えて動く', () => {
  const { room, fire } = makeRoom();
  const h = room.join('t1', 'A').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  fire(3000);
  const g = room.game;
  const cpu = g.players.find(p => p.id !== h);
  cpu.resource = 20; cpu.ap = 5;
  const before = g.log.length;
  for (let i = 0; i < 4; i++) fire(2500);
  assert.ok(g.log.length > before);
});

test('ほかの人の戦力トークンの数は届かない', () => {
  const { h, g, last } = startTwo();
  assert.strictEqual(last(h).room.game.players.find(p => p.id === h).power, 2);
  assert.strictEqual(last(h).room.game.players.find(p => p.id === g).power, null);
  assert.strictEqual(last(g).room.game.players.find(p => p.id === g).power, 2);
});

test('切断しても戻ってきたら続けられる。ホストが脱落させられる。終わったらタイマーは残らない', () => {
  const r = startTwo();
  const { room, h, g, last } = r;
  room.disconnect(g);
  assert.ok(room.game.log.some(l => l.text.includes('B の接続が切れました')));
  assert.strictEqual(room.join('t2', 'B').id, g);
  assert.strictEqual(last(g).room.players.find(p => p.id === g).connected, true);
  room.handle(h, { type: 'forfeit', target: g });      // 接続中は脱落させられない
  assert.ok(!room.game.over);
  room.disconnect(g);
  room.handle(h, { type: 'forfeit', target: g });
  assert.ok(room.game.over);
  assert.deepStrictEqual(room.game.winners, [h]);
  assert.strictEqual(r.timers.length, 0);
  room.handle(h, { type: 'lobby' });
  assert.strictEqual(last(h).room.phase, 'lobby');
  assert.strictEqual(last(h).room.players.length, 1);
});

test('行動完了：人間の全員が押したら、待たずに次のターンへ。飛ばした時間のぶん行動力も回復（CPU と切断中の人は押したものとみなす）', () => {
  const { room, last, fire, timers, clock } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  fire(3000);
  const gm = room.game;
  const cpu = gm.players.find(p => p.id !== h && p.id !== g).id;
  gm.players.forEach(p => { p.ap = 0; });
  clock.t += 12000;                                                  // 12秒たったところで（あと18秒）
  room.handle(h, { type: 'act', action: { type: 'ready' } });
  assert.strictEqual(gm.round, 0);                                   // まだ B が押していない
  assert.deepStrictEqual(last(g).room.readyIds.sort(), [h, cpu].sort());
  room.handle(g, { type: 'act', action: { type: 'ready' } });
  assert.strictEqual(gm.round, 1);                                   // すぐ次のターンへ
  // 飛ばした18秒のぶん、行動力が回復する（5秒ごと：15・20・25・30秒の4回。回復のタイマーはテストでは動かしていない）
  assert.deepStrictEqual(gm.players.map(p => p.ap), [4, 4, 4]);
  assert.ok(gm.log.some(l => l.text.includes('全員が行動完了')));
  assert.deepStrictEqual(last(h).room.readyIds, [cpu]);              // 印は外れる
  assert.strictEqual(last(h).room.tickLeftMs, 30000);                // 次のターンの時間は数え直し
  assert.strictEqual(timers.filter(t => t.ms === 30000).length, 1);
  // B が切断したら、A が押すだけで進む
  room.disconnect(g);
  room.handle(h, { type: 'act', action: { type: 'ready' } });
  assert.strictEqual(gm.round, 2);
  // A が押したあとに B が切断しても進む
  room.join('t2', 'B');
  room.handle(h, { type: 'act', action: { type: 'ready' } });
  assert.strictEqual(gm.round, 2);
  room.disconnect(g);
  assert.strictEqual(gm.round, 3);
});
