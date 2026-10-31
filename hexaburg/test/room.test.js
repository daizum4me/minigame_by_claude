const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const { Room, CHAT_KEEP, CHAT_LEN, CPU_MS } = require('../shared/room');

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

const freeNext = (room, id) => { const g = room.game; const [q, r] = E.parseKey(g.players.find(p => p.id === id).core); return E.neighbors(q, r).find(([x, y]) => g.board[E.key(x, y)] && !g.board[E.key(x, y)].owner); };

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

test('ゲーム開始の前に3秒のカウントダウン。そのあいだは行動できず、ターンも進まない', () => {
  const { room, inbox, last, fire, timers } = makeRoom();
  const h = room.join('t1', 'A').id;
  room.join('t2', 'B');
  room.handle(h, { type: 'start' });
  assert.deepStrictEqual([last(h).room.countdownMs, last(h).room.tickLeftMs], [3000, 0]);
  assert.ok(!timers.some(t => t.ms === 30000));
  const [q, r] = freeNext(room, h);
  room.handle(h, { type: 'act', action: { type: 'expand', q, r } });
  assert.match(inbox[h].at(-1).text, /まだ始まっていません/);
  fire(3000);
  assert.deepStrictEqual([last(h).room.countdownMs, last(h).room.tickLeftMs], [0, 30000]);
  room.handle(h, { type: 'act', action: { type: 'expand', q, r } });
  assert.strictEqual(room.game.board[E.key(q, r)].owner, h);
});

test('行動はホストが検証して全員に配信。だれでもいつでも行動できる', () => {
  const { room, inbox, last, h, g } = startTwo();
  const exp = id => { const [q, r] = freeNext(room, id); room.handle(id, { type: 'act', action: { type: 'expand', q, r } }); };
  exp(g);
  assert.strictEqual(room.game.players.find(p => p.id === g).resource, 2);
  exp(h);
  assert.strictEqual(last(g).room.game.players.find(p => p.id === h).resource, 2);
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
  assert.strictEqual(gm.rounds, 12);
  assert.strictEqual(last(h).room.tickLeftMs, 30000);
  fire(30000);
  assert.strictEqual(gm.round, 1);
  assert.ok(timers.some(t => t.ms === 30000));                       // 次のターンも予約される
});

// CPU の考えるタイマー（1.5〜3.5秒のばらつき）を1つ動かす
function fireCpu(timers) {
  const i = timers.findIndex(t => t.ms >= CPU_MS[0] && t.ms < CPU_MS[1]);
  assert.ok(i >= 0, `CPU のタイマーがない（${timers.map(t => t.ms).join(',')}）`);
  timers.splice(i, 1)[0].fn();
}

test('CPU はばらつきのある間隔（1.5〜3.5秒）で考えて動く', () => {
  const { room, fire, timers } = makeRoom();
  const h = room.join('t1', 'A').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  fire(3000);
  const g = room.game;
  const cpuTimers = timers.filter(t => t.ms >= CPU_MS[0] && t.ms < CPU_MS[1]);
  assert.strictEqual(cpuTimers.length, 2);                              // CPU ごとに別のタイマー
  g.players.filter(p => p.id !== h).forEach(p => { p.resource = 20; });
  const before = g.log.length;
  for (let i = 0; i < 4; i++) fireCpu(timers);
  assert.ok(g.log.length > before);
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

test('行動完了：待つ相手の全員が押したら、待たずに次のターンへ。切断中の人は押したものとみなす', () => {
  const { room, last, fire, timers, clock } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'start' });
  fire(3000);
  const gm = room.game;
  clock.t += 12000;                                                  // 12秒たったところで（あと18秒）
  room.handle(h, { type: 'act', action: { type: 'ready' } });
  assert.strictEqual(gm.round, 0);                                   // まだ B が押していない
  assert.deepStrictEqual(last(g).room.readyIds, [h]);
  room.handle(g, { type: 'act', action: { type: 'ready' } });
  assert.strictEqual(gm.round, 1);                                   // すぐ次のターンへ
  assert.ok(gm.log.some(l => l.text.includes('全員が行動完了')));
  assert.deepStrictEqual(last(h).room.readyIds, []);                 // 印は外れる
  assert.strictEqual(last(h).room.tickLeftMs, 30000);                // 次のターンの時間は数え直し
  assert.strictEqual(timers.filter(t => t.ms === 30000).length, 1);
  // B が切断したら、A が押すだけで進む。A が押したあとに B が切断しても進む
  room.disconnect(g);
  room.handle(h, { type: 'act', action: { type: 'ready' } });
  assert.strictEqual(gm.round, 2);
  room.join('t2', 'B');
  room.handle(h, { type: 'act', action: { type: 'ready' } });
  assert.strictEqual(gm.round, 2);
  room.disconnect(g);
  assert.strictEqual(gm.round, 3);
});

test('CPU は、もうやりたい行動がないと判断したときだけ行動完了になる（動いたら外れる）', () => {
  const { room, last, fire, timers } = makeRoom();
  const h = room.join('t1', 'A').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  fire(3000);
  const gm = room.game;
  const cpu = gm.players.find(p => p.id !== h);
  room.handle(h, { type: 'act', action: { type: 'ready' } });
  assert.strictEqual(gm.round, 0);                                   // CPU はまだ行動完了ではないので進まない
  // 資源がなく、戦力も攻撃・反撃に足りない → やることがない → 行動完了 → 全員そろって次のターンへ
  cpu.resource = 0;
  fireCpu(timers);
  assert.strictEqual(gm.round, 1);
  // 資源があれば拡張したいので、行動完了にしない
  cpu.resource = 20;
  fireCpu(timers);
  assert.strictEqual(cpu.ready, false);
  assert.ok(!last(h).room.readyIds.includes(cpu.id));
});

test('もうできる行動がない人は、自動で行動完了になる（自分で外したターンは自動にしない）', () => {
  const { room, last, fire } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'start' });
  fire(3000);
  const gm = room.game;
  const A = gm.players.find(p => p.id === h);
  A.resource = 0;
  room.handle(g, { type: 'chat', text: 'x' });                        // 何か変化があったときに確かめる
  room.changed();
  assert.strictEqual(A.ready, true);
  assert.deepStrictEqual(last(g).room.readyIds, [h]);
  room.handle(h, { type: 'act', action: { type: 'ready' } });         // 自分で外す
  room.changed();
  assert.strictEqual(A.ready, false);
});
