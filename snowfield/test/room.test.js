const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const CPU = require('../shared/cpu');
const { Room } = require('../shared/room');

// タイマーと時計は手で進める
function makeRoom(seed, o) {
  const inbox = {};
  const timers = [];
  const clock = { t: 1000 };
  let s = seed || 7;
  const room = new Room({
    code: 'TEST1',
    send: (id, msg) => { (inbox[id] = inbox[id] || []).push(JSON.parse(JSON.stringify(msg))); },
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimer: t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    now: () => clock.t,
    rng: () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; },
  });
  if (!(o && o.simul)) room.settings.simul = false;       // 既存のテストは、順番に動く設定で書いてある（同時に動く設定は別のテストで確かめる）
  const last = id => [...inbox[id]].reverse().find(m => m.type === 'state');
  // タイマーを1つ進める（時計も進める）
  const step = () => { const t = timers.shift(); if (!t) return false; clock.t += t.ms; t.fn(); return true; };
  return { room, inbox, timers, last, clock, step };
}

test('参加・CPU追加・人数・開始', () => {
  const { room, inbox, last } = makeRoom();
  const h = room.join('t1', 'ホスト').id;
  const g = room.join('t2', 'ホスト').id;
  assert.strictEqual(last(g).room.players[1].name, 'ホスト2');
  room.handle(g, { type: 'addCpu' });                       // ホスト以外は不可
  assert.strictEqual(last(h).room.players.length, 2);
  room.handle(h, { type: 'start' });                        // 2人では始められない
  assert.strictEqual(inbox[h].at(-1).type, 'error');
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'addCpu' });                       // 6人目は入れない
  assert.strictEqual(last(h).room.players.length, 5);
  assert.deepStrictEqual(last(h).room.players.map(p => p.color), ['blue', 'red', 'green', 'orange', 'purple']);
  room.handle(h, { type: 'removeCpu', id: last(h).room.players[4].id });
  assert.strictEqual(last(h).room.players.length, 4);
  room.handle(g, { type: 'start' });
  assert.strictEqual(last(g).room.phase, 'lobby');
  room.handle(h, { type: 'start' });
  assert.strictEqual(last(g).room.phase, 'game');
  assert.strictEqual(last(g).game.players.length, 4);
  assert.ok(room.join('t9', 'x').error);                    // ゲーム中は新規参加できない
});

test('ロビーで切断した人は外れ、ゲーム中は戻ってこられる', () => {
  const { room, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.disconnect(g);
  assert.strictEqual(last(h).room.players.length, 1);
  const g2 = room.join('t2', 'B').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  room.disconnect(g2);
  assert.strictEqual(last(h).game.players.find(p => p.id === g2).away, true);
  assert.strictEqual(room.join('t2', 'B').id, g2);
  assert.strictEqual(last(h).game.players.find(p => p.id === g2).away, false);
});

test('手番の行動はホストが検証する（手番外は拒否）', () => {
  const { room, inbox, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  const turn = last(h).game.players[last(h).game.turn].id;
  const other = turn === h ? g : h;
  room.handle(other, { type: 'act', a: { type: 'warm' } });
  assert.match(inbox[other].at(-1).text, /手番/);
  room.handle(turn, { type: 'act', a: { type: 'warm' } });
  assert.strictEqual(inbox[turn].at(-2).type, 'toast');
});

test('切断中の人の手番は自動で終わる', () => {
  const { room, last, step } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  room.disconnect(h); room.disconnect(g);
  for (let i = 0; i < 30 && step(); i++);
  const gm = last(g) ? last(g).game : room.game;
  assert.ok(room.game.round > 1 || room.game.turn > 0);
  void gm;
});

// CPU だけで最後まで遊ぶ（止まらない・エラーが出ない・状態が壊れない）
function playAll(seed, n) {
  const { room, step } = makeRoom(seed);
  const h = room.join('t1', 'A').id;
  for (let i = 1; i < n; i++) room.handle(h, { type: 'addCpu' });
  // 人間役も CPU のように自動進行させるため、切断扱いにする（手番は自動で終わる）…のではなく、人間役を CPU に置き換える
  room.players[0].cpu = true;
  room.handle(h, { type: 'start' });
  let guard = 0;
  while (room.game.phase === 'play' && guard++ < 200000 && step());
  return room.game;
}

test('CPUだけの対戦が最後まで進む（3〜5人）', () => {
  const results = [];
  for (const n of [3, 4, 5]) {
    for (let seed = 1; seed <= 6; seed++) {
      const g = playAll(seed * 11 + n, n);
      assert.notStrictEqual(g.phase, 'play', `n=${n} seed=${seed} が終わらない`);
      assert.ok(g.players.every(p => p.temp >= 0 && p.temp <= 10 && p.food >= 0 && p.food <= 10));
      assert.ok(E.total(g) <= E.cap(g) + 10 * 0);
      results.push(g.phase + ':' + g.round);
    }
  }
  console.log('CPU対戦の結果:', results.join(' '));
});

test('CPU：食べる・復帰中は温まる/食べるだけ・捨てる投票', () => {
  const st = E.createGame({ seed: 3, simul: false, players: [1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, color: 'blue', cpu: true })) });
  const p = E.cur(st);
  p.food = 3; st.items.meat = 2;
  assert.deepStrictEqual(CPU.decide(st, p.id, {}), { type: 'eat', k: 'meat' });
  p.food = 10; p.down = 2; p.temp = 5;
  assert.deepStrictEqual(CPU.decide(st, p.id, {}), { type: 'warm' });
  p.ap = 0;
  assert.deepStrictEqual(CPU.decide(st, p.id, {}), { type: 'end' });
  // 余りがあって上限なら捨てる、人が言い出した投票には余りなら賛成
  st.items.snow = 16;
  assert.deepStrictEqual(CPU.voteIntent(st, 'p2'), { type: 'vote', k: 'snow' });
  E.act(st, 'p1', { type: 'vote', k: 'snow' });
  assert.deepStrictEqual(CPU.voteIntent(st, 'p2'), { type: 'voteCast', val: 1 });
});

test('駒の形と色：選べる・ほかの人と、形と色の組み合わせが同じなのは不可（色だけ同じならよい）・ゲーム中は変えられない', () => {
  const { room, inbox, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(g, { type: 'style', shape: 'hex', color: 'black' });
  assert.deepStrictEqual([last(h).room.players[1].shape, last(h).room.players[1].color], ['hex', 'black']);
  room.handle(h, { type: 'style', color: 'black' });                       // 形が違うので、同じ色でもよい
  assert.deepStrictEqual([last(g).room.players[0].shape, last(g).room.players[0].color], ['circle', 'black']);
  room.handle(h, { type: 'style', shape: 'hex' });                         // 形も色も同じになるので不可
  assert.match(inbox[h].at(-1).text, /形も色も同じ/);
  assert.strictEqual(last(g).room.players[0].shape, 'circle');
  room.handle(h, { type: 'style', shape: 'nope', color: 'zzz' });
  assert.strictEqual(last(g).room.players[0].color, 'black');
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  room.handle(g, { type: 'style', shape: 'up' });
  assert.strictEqual(last(g).game.players[1].shape, 'hex');
  assert.strictEqual(last(g).game.players[1].color, 'black');
});

test('16人までの部屋：形と色の組み合わせが、全員ちがう', () => {
  const { room, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  for (let i = 1; i < 16; i++) room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'addCpu' });                                       // 17人目は入れない
  const ps = last(h).room.players;
  assert.strictEqual(ps.length, 16);
  assert.strictEqual(new Set(ps.map(p => p.color + '/' + p.shape)).size, 16);
});

test('CPUだけでもクリアできる（3人・20通りのマップのうち、複数回）', () => {
  let wins = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const st = E.createGame({ seed, simul: false, players: [1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, color: 'blue', cpu: true })) });
    const mem = {};
    for (let n = 0; st.phase === 'play' && n < 30000; n++) {
      const p = E.cur(st);
      for (const q of st.players) { const v = CPU.voteIntent(st, q.id); if (v) E.act(st, q.id, v); }
      const a = CPU.decide(st, p.id, mem[p.id] || (mem[p.id] = {}));
      if (!E.act(st, p.id, a).ok) E.act(st, p.id, { type: 'end' });
    }
    if (st.phase === 'won') wins++;
  }
  assert.ok(wins >= 4, `クリアは${wins}/20回`);
});

test('CPUは、同じ場所を行ったり来たりしない（1手番に、仕事をはさまない移動を3回続けない）', () => {
  for (const n of [3, 5]) {
    for (let seed = 1; seed <= 8; seed++) {
      const st = E.createGame({ seed, simul: false, players: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, color: 'blue', cpu: true })) });
      const mem = {};
      let key = '', run = 0;
      for (let k = 0; st.phase === 'play' && k < 30000; k++) {
        const p = E.cur(st), tk = st.round + ':' + st.turn;
        if (tk !== key) { key = tk; run = 0; }
        for (const q of st.players) { const v = CPU.voteIntent(st, q.id); if (v) E.act(st, q.id, v); }
        const a = CPU.decide(st, p.id, mem[p.id] || (mem[p.id] = {}));
        run = a.type === 'move' ? run + 1 : 0;
        assert.ok(run < 3, `n=${n} seed=${seed} R${st.round}：移動が${run}回続いた`);
        if (!E.act(st, p.id, a).ok) E.act(st, p.id, { type: 'end' });
      }
    }
  }
});

test('手番の制限時間：人間の手番は制限時間で自動的に終わる。CPUには制限がない', () => {
  const { room, timers, last, clock, inbox } = makeRoom();
  const h = room.join('t1', 'A').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  const first = E.cur(room.game);
  assert.strictEqual(first.id, h);
  assert.strictEqual(last(h).room.turnLeft, E.RULES.turnLimitMs);
  clock.t += 60000;
  assert.strictEqual(room.view().turnLeft, E.RULES.turnLimitMs - 60000);
  const t = timers.find(x => x.ms === E.RULES.turnLimitMs);
  assert.ok(t);
  timers.splice(timers.indexOf(t), 1);
  t.fn();                                              // 時間切れ
  assert.notStrictEqual(E.cur(room.game).id, h);
  assert.strictEqual(room.view().turnLeft, null);       // CPUの手番
  assert.match(room.game.log.map(l => l.t).join('|'), /制限時間/);
  void inbox;
});

test('移動のお願い：CPUはすぐに道を空け、人間には確認が届く。ふさいでいない相手にはお願いできない', () => {
  const { room, inbox, last, clock } = makeRoom();
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  const st = room.game, f = E.fireOf(st);
  for (let x = f.x + f.w; x < f.x + f.w + 4; x++) st.b.push({ id: 500 + x, t: 'road', x, y: f.y, w: 1, h: 1, hp: null, max: null });
  const a = E.pl(st, h), human = E.pl(st, g), cpu = st.players.find(p => p.cpu);
  a.x = f.x + f.w - 1; a.y = f.y; a.temp = 10; cpu.temp = 10; human.temp = 10;
  cpu.x = f.x + f.w + 1; cpu.y = f.y;
  human.x = f.x; human.y = f.y + 1;
  const far = f.x + f.w + 3;
  room.handle(h, { type: 'moveReq', to: g, x: far, y: f.y });                    // 人間はふさいでいない
  assert.match(inbox[h].at(-1).text, /ふさいでいません/);
  clock.t += 3000;
  room.handle(h, { type: 'moveReq', to: cpu.id, x: far, y: f.y });               // CPUは、すぐに空ける
  assert.ok(!(cpu.x === f.x + f.w + 1 && cpu.y === f.y));
  assert.match(inbox[h].at(-2).text + inbox[h].at(-1).text, /道を空けました/);
  // 人間がふさいでいるとき：確認が届き、「空ける」で動く／「ことわる」では動かない
  clock.t += 3000;
  human.x = f.x + f.w + 2; human.y = f.y;
  room.handle(h, { type: 'moveReq', to: g, x: far, y: f.y });
  assert.strictEqual(inbox[g].find(m => m.type === 'moveReq').fromName, 'A');
  room.handle(g, { type: 'moveReqReply', accept: false });
  assert.deepStrictEqual([human.x, human.y], [f.x + f.w + 2, f.y]);
  assert.match(inbox[h].at(-1).text, /ことわりました/);
  clock.t += 3000;
  room.handle(h, { type: 'moveReq', to: g, x: far, y: f.y });
  room.handle(g, { type: 'moveReqReply', accept: true });
  assert.ok(!(human.x === f.x + f.w + 2 && human.y === f.y));
  assert.ok(last(h).game.players.find(p => p.id === g).x !== f.x + f.w + 2 || last(h).game.players.find(p => p.id === g).y !== f.y);
});

test('バージョン：違うバージョンの人は部屋に入れない', () => {
  const { room, last } = makeRoom();
  const h = room.join('t1', 'A').id;
  assert.strictEqual(last(h).room.version, E.VERSION);
  assert.match(room.join('t2', 'B', '0.9').error, /バージョンが違います/);
  assert.match(room.join('t3', 'C', '0').error, /古い版/);
  assert.ok(room.join('t4', 'D', E.VERSION).id);
  assert.strictEqual(room.players.length, 2);
});

test('同時に動く：ロビーで設定できる（ホストだけ）。ラウンドの制限時間が切れると、全員のラウンドが終わる', () => {
  const { room, last, timers, step, clock } = makeRoom(5, { simul: true });
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'addCpu' });
  assert.strictEqual(last(h).room.settings.simul, true);
  room.handle(g, { type: 'settings', simul: false });                      // ホスト以外は変えられない
  assert.strictEqual(room.settings.simul, true);
  room.handle(h, { type: 'start' });
  const game = room.game;
  assert.strictEqual(E.simul(game), true);
  assert.strictEqual(last(h).room.turnLeft, E.RULES.roundLimitMs);        // ラウンドごとの制限時間
  const t = timers.find(x => x.ms === E.RULES.roundLimitMs);
  assert.ok(t);
  // 人間が2人とも行動していなくても、時間切れでラウンドが進む（CPU は、その間に動く）
  clock.t += E.RULES.roundLimitMs;
  timers.splice(timers.indexOf(t), 1);
  t.fn();
  assert.strictEqual(game.round, 2);
  assert.ok(game.players.every(p => !p.done));
  void step;
});

test('同時に動く：CPUだけの対戦が、最後まで進む（3人・8人・16人）', () => {
  for (const n of [3, 8, 16]) {
    const { room, step } = makeRoom(n * 3, { simul: true });
    const h = room.join('t1', 'A').id;
    for (let i = 1; i < n; i++) room.handle(h, { type: 'addCpu' });
    room.players[0].cpu = true;
    room.handle(h, { type: 'start' });
    let guard = 0;
    while (room.game.phase === 'play' && guard++ < 100000 && step());
    assert.notStrictEqual(room.game.phase, 'play', `n=${n} が終わらない`);
    assert.ok(room.game.players.every(p => p.temp >= 0 && p.temp <= 10 && p.food >= 0 && p.food <= 10));
    assert.ok(E.total(room.game) <= E.cap(room.game));
  }
});

test('同時に動く：切断中の人は、すぐに行動を終える', () => {
  const { room, step } = makeRoom(2, { simul: true });
  const h = room.join('t1', 'A').id;
  const g = room.join('t2', 'B').id;
  room.handle(h, { type: 'addCpu' });
  room.handle(h, { type: 'start' });
  room.disconnect(h); room.disconnect(g);
  for (let i = 0; i < 20 && step(); i++);
  assert.ok(room.game.round > 1);
});
