const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const { Room, TURN_MS, BID_MS, GRACE_MS } = require('../shared/room');

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

// 2人で始めて、h の手番にする
function startTwo() {
  const r = makeRoom();
  const h = r.room.join('t1', 'A').id;
  const g = r.room.join('t2', 'B').id;
  r.room.handle(h, { type: 'start' });
  if (E.current(r.room.game).id !== h) r.room.handle(g, { type: 'act', action: { type: 'endTurn' } });
  return Object.assign(r, { h, g });
}

// h のセルを g のコアの隣に置いて、g のコアに破壊を宣言する
function declareOnCore(r, gDefense, hAttack) {
  const { room, h, g } = r;
  const gp = room.game.players.find(p => p.id === g);
  const hp = room.game.players.find(p => p.id === h);
  gp.defense = gDefense;
  hp.attack = hAttack;
  const [cq, cr] = E.parseKey(gp.core);
  const [nq, nr] = E.neighbors(cq, cr).find(([q, r]) => room.game.board[E.key(q, r)]);
  Object.assign(room.game.board[E.key(nq, nr)], { owner: h });
  room.handle(h, { type: 'act', action: { type: 'destroy', q: cq, r: cr } });
  return { gp, hp };
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
  assert.strictEqual(Object.keys(st.game.board).length, 37);
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

test('持ち時間120秒で自動で手番終了、攻防のあいだは止まる', () => {
  const r = startTwo();
  const { room, h, g, clock, last, fire } = r;
  assert.strictEqual(last(h).room.turnLeftMs, TURN_MS);
  clock.t += 50000;
  // 攻防が始まると持ち時間は止まる
  const { gp } = declareOnCore(r, 1, 1);
  assert.ok(room.game.pending);
  assert.strictEqual(last(h).room.turnPaused, true);
  assert.strictEqual(last(h).room.turnLeftMs, TURN_MS - 50000);
  clock.t += 20000;
  room.handle(g, { type: 'act', action: { type: 'bid', count: 1 } });
  room.handle(h, { type: 'act', action: { type: 'bid', count: 0 } });
  assert.strictEqual(room.game.pending, null);
  assert.ok(gp.alive);
  // 攻防のあとは残り70秒から再開
  assert.strictEqual(last(h).room.turnLeftMs, TURN_MS - 50000);
  fire(TURN_MS - 50000);
  assert.strictEqual(E.current(room.game).id, g);
  assert.ok(room.game.log.some(l => l.text.includes('持ち時間が切れました')));
  // 次の人は120秒から
  assert.strictEqual(last(g).room.turnLeftMs, TURN_MS);
});

test('攻防で出す数は、公開されるまで相手には見えない', () => {
  const r = startTwo();
  const { room, h, g, last } = r;
  declareOnCore(r, 2, 2);
  room.handle(g, { type: 'act', action: { type: 'bid', count: 2 } });
  const ph = last(h).room.game.pending, pg = last(g).room.game.pending;
  assert.deepStrictEqual([ph.def, ph.defReady, ph.atk, ph.atkReady], [null, true, null, false]);
  assert.deepStrictEqual([pg.def, pg.defReady], [2, true]);
  assert.strictEqual(JSON.stringify(last(h).room).includes('"def":2'), false);
  room.handle(h, { type: 'act', action: { type: 'bid', count: 1 } });
  // 公開されたら両方の数が見える
  const lc = last(h).room.game.lastClash;
  assert.deepStrictEqual([lc.atk, lc.def, lc.success], [1, 2, false]);
});

test('攻防で30秒決めなければ 0 個', () => {
  const r = startTwo();
  const { room, h, g, fire } = r;
  room.game.players.find(p => p.id === g).coreHp = 1;   // 残り耐久1
  const { gp } = declareOnCore(r, 1, 0);
  fire(BID_MS);
  assert.strictEqual(room.game.pending, null);
  assert.strictEqual(gp.alive, false);   // 防御トークンを出さなかったのでコアが破壊された
  assert.ok(room.game.over);
  assert.deepStrictEqual(room.game.winners, [h]);
  assert.ok(room.game.log.some(l => l.text.includes('B：時間切れのため 0 個')));
  assert.notStrictEqual(g, h);
});

test('切断中の人の番は30秒で終わる・戻ってきたら続けられる・ホストが脱落させられる', () => {
  const r = startTwo();
  const { room, h, g, last, fire } = r;
  room.handle(h, { type: 'act', action: { type: 'endTurn' } });
  assert.strictEqual(E.current(room.game).id, g);
  room.disconnect(g);
  assert.strictEqual(last(h).room.graceFor, g);
  assert.strictEqual(last(h).room.graceLeftMs, GRACE_MS);
  fire(GRACE_MS);
  assert.strictEqual(E.current(room.game).id, h);
  assert.ok(room.game.log.some(l => l.text.includes('切断中のため手番を終えます')));
  // 戻ってくる
  assert.strictEqual(room.join('t2', 'B').id, g);
  assert.strictEqual(last(g).room.players.find(p => p.id === g).connected, true);
  // ホストが脱落させる
  room.disconnect(g);
  room.handle(h, { type: 'forfeit', target: g });
  assert.ok(room.game.over);
  assert.deepStrictEqual(room.game.winners, [h]);
  assert.strictEqual(r.timers.length, 0); // 終わったらタイマーは残らない
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

test('ホストは盤面の直径を設定できる', () => {
  const { room, inbox, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(g, { type: 'settings', diameter: 13 });   // ホスト以外は変えられない
  assert.strictEqual(last(h).room.settings.diameter, 0);
  room.handle(h, { type: 'settings', diameter: 8 });    // 偶数は不可
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  room.handle(h, { type: 'settings', diameter: 17 });   // 範囲外
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  room.handle(h, { type: 'settings', diameter: 13 });
  assert.strictEqual(last(g).room.settings.diameter, 13);
  room.handle(h, { type: 'start' });
  assert.strictEqual(room.game.radius, 6);
  assert.strictEqual(Object.keys(room.game.board).length, 127);
});
