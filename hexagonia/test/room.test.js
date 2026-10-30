const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const { Room, TURN_MS, BID_MS, GRACE_MS, ABANDON_MS, CHAT_KEEP, CHAT_LEN } = require('../shared/room');

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
function declareOnCore(r, gPower, hPower) {
  const { room, h, g } = r;
  const gp = room.game.players.find(p => p.id === g);
  const hp = room.game.players.find(p => p.id === h);
  gp.power = gPower;
  hp.power = hPower;
  const [cq, cr] = E.parseKey(gp.core);
  const [nq, nr] = E.neighbors(cq, cr).find(([q, r]) => room.game.board[E.key(q, r)]);
  Object.assign(room.game.board[E.key(nq, nr)], { owner: h, strong: true });
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
  room.handle(other, { type: 'act', action: { type: 'produce' } });
  assert.strictEqual(inbox[other].at(-1).type, 'error');
  room.handle(turn, { type: 'act', action: { type: 'endTurn' } });
  assert.strictEqual(E.current(last(other).room.game).id, other);
});

test('持ち時間120秒で自動で手番終了。攻防のあいだも止まらず、攻防中に切れたら攻防のあとで手番終了', () => {
  const r = startTwo();
  const { room, h, g, clock, last, fire } = r;
  assert.strictEqual(last(h).room.turnLeftMs, TURN_MS);
  clock.t += 50000;
  // 攻防が始まっても持ち時間は進む
  declareOnCore(r, 2, 2);
  assert.ok(room.game.pending);
  assert.strictEqual(last(h).room.turnLeftMs, TURN_MS - 50000);
  clock.t += 20000;
  assert.strictEqual(room.view(h).turnLeftMs, TURN_MS - 70000);
  // 攻防中に持ち時間が切れても、攻防が終わるまでは手番は終わらない
  const before = `${room.game.round}:${room.game.turn}`;
  fire(TURN_MS);
  assert.ok(room.game.pending);
  assert.strictEqual(`${room.game.round}:${room.game.turn}`, before);
  room.handle(g, { type: 'act', action: { type: 'bid', count: 2 } });
  room.handle(h, { type: 'act', action: { type: 'bid', count: 1 } });
  assert.strictEqual(room.game.pending, null);
  // 攻防が終わったらすぐ手番終了
  fire(0);
  assert.notStrictEqual(`${room.game.round}:${room.game.turn}`, before);
  assert.ok(room.game.log.some(l => l.text.includes('持ち時間が切れました')));
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
  // 結果は成功か失敗かだけ。出した数は当人にしか見えない
  const lh = last(h).room.game.lastClash, lg = last(g).room.game.lastClash;
  assert.deepStrictEqual([lh.atk, lh.def, lh.success], [1, null, false]);
  assert.deepStrictEqual([lg.atk, lg.def, lg.success], [null, 2, false]);
  assert.ok(!last(h).room.game.log.some(l => /防御トークン 2 個/.test(l.text)));
});

test('攻防で30秒決めなければ、出せる最小の数（攻撃側は1個・防御側は0個）', () => {
  const r = startTwo();
  const { room, h, g, fire } = r;
  const { gp } = declareOnCore(r, 1, 2);
  fire(BID_MS);
  assert.strictEqual(room.game.pending, null);
  assert.strictEqual(gp.alive, false);   // 防御トークンを出さなかったのでコアが破壊された
  assert.ok(room.game.over);
  assert.deepStrictEqual(room.game.winners, [h]);
  assert.ok(room.game.log.some(l => l.text.includes('B：時間切れのため 0 個')));
  assert.ok(room.game.log.some(l => l.text.includes('A：時間切れのため 1 個')));
  assert.notStrictEqual(g, h);
});

test('切断中の人の番は30秒で終わる・戻ってきたら続けられる・ホストが脱落させられる', () => {
  const r = startTwo();
  const { room, h, g, last, fire } = r;
  // g の手番まで進める（ラウンドごとに最初の人がずれるので、h が続けて手番のこともある）
  while (E.current(room.game).id !== g) room.handle(E.current(room.game).id, { type: 'act', action: { type: 'endTurn' } });
  room.disconnect(g);
  assert.strictEqual(last(h).room.graceFor, g);
  assert.strictEqual(last(h).room.graceLeftMs, GRACE_MS);
  const before = `${room.game.round}:${room.game.turn}`;
  fire(GRACE_MS);
  assert.notStrictEqual(`${room.game.round}:${room.game.turn}`, before);   // 手番が進んだ
  assert.ok(room.game.log.some(l => l.text.includes('B：切断中のため手番を終えます')));
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
  room.handle(h, { type: 'settings', diameter: 23 });   // 範囲外
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  room.handle(h, { type: 'settings', diameter: 13 });
  assert.strictEqual(last(g).room.settings.diameter, 13);
  room.handle(h, { type: 'start' });
  assert.strictEqual(room.game.radius, 6);
  assert.strictEqual(Object.keys(room.game.board).length, 127);
});

test('ほかの人の戦力トークンの数は届かない', () => {
  const r = startTwo();
  const { room, h, g, last } = r;
  const mine = last(h).room.game.players.find(p => p.id === h);
  const other = last(h).room.game.players.find(p => p.id === g);
  assert.strictEqual(mine.power, 2);
  assert.strictEqual(other.power, null);
  assert.strictEqual(last(g).room.game.players.find(p => p.id === g).power, 2);
});

test('ホストは行動回数とラウンド数を設定できる（0 は人数に合わせる）', () => {
  const { room, inbox, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  room.join('t2', 'B');
  room.handle(h, { type: 'settings', actions: 9 });
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  room.handle(h, { type: 'settings', actions: 5, rounds: 8 });
  assert.deepStrictEqual(last(h).room.settings, { diameter: 0, actions: 5, rounds: 8 });
  room.handle(h, { type: 'start' });
  assert.deepStrictEqual([room.game.actionsPerTurn, room.game.rounds], [5, 8]);
});

test('イベントは今のラウンドの分だけ届く（先のラウンドの予定は届かない）', () => {
  const r = startTwo();
  const st = r.last(r.h).room.game;
  assert.strictEqual(st.eventPlan, undefined);
  assert.ok('event' in st && !('nextEvent' in st));
});

test('イベントを起こさない設定（チュートリアル用）', () => {
  const { room } = makeRoom();
  const h = room.join('t1', 'A').id;
  room.handle(h, { type: 'addCpu' });
  room.events = false;
  room.handle(h, { type: 'start' });
  assert.ok(room.game.eventPlan.every(e => !e));
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

test('食料が足りないとき、捨てるセルを選ぶ時間は60秒。決めなければ自動で選ぶ', () => {
  const r = startTwo();
  const { room, h, last, fire } = r;
  assert.strictEqual(ABANDON_MS, 60000);
  const g = room.game, me = g.players.find(p => p.id === h);
  Object.values(g.board).filter(c => !c.owner && c.terrain === 'plain').slice(0, 9).forEach(c => { c.owner = h; });
  me.food = 0;
  room.handle(h, { type: 'act', action: { type: 'endTurn' } });
  assert.ok(g.abandon && g.abandon.player === h);
  assert.strictEqual(last(h).room.abandonLeftMs, ABANDON_MS);
  const before = E.cellsOf(g, h).length, count = g.abandon.count;
  fire(ABANDON_MS);
  assert.strictEqual(g.abandon, null);
  assert.strictEqual(E.cellsOf(g, h).length, before - count);
  assert.ok(g.log.some(l => l.text.includes('時間切れのため、捨てるセルを自動で選びます')));
});

test('取り消しの記録は手番の人にだけ、何を取り消せるかだけ届く。生産の取り消しはログに出ない', () => {
  const r = startTwo();
  const { room, h, g, last } = r;
  room.game.players.find(p => p.id === h).resource = 10;
  room.handle(h, { type: 'act', action: { type: 'produce' } });
  assert.deepStrictEqual(last(h).room.game.undo, [{ label: '生産' }]);
  assert.deepStrictEqual(last(g).room.game.undo, []);          // ほかの人には届かない
  const logLen = room.game.log.length;
  room.handle(h, { type: 'act', action: { type: 'undo' } });
  assert.deepStrictEqual(last(h).room.game.undo, []);
  assert.strictEqual(room.game.log.length, logLen);            // 生産の取り消しはログに出ない
});
