const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');

const P3 = [1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, color: 'blue' }));
// 既存のテストは、焚き火が3×3（-1〜1）の配置で書いてあるので、fireDiv=1（人数と同じ辺）にして作る。人数による大きさは別のテストで確かめる
const mk = (seed = 1) => {
  const d = E.RULES.fireDiv; E.RULES.fireDiv = 1;
  const st = E.createGame({ seed, players: P3 });
  E.RULES.fireDiv = d;
  st.items.veg = 0;   // 最初の野菜は別のテストで確かめる
  return st;
};
const me = st => E.cur(st);
// 建てられる場所を探す
const spotFor = (st, t, skip = 0) => { let n = 0; for (let y = -8; y < 8; y++) for (let x = -8; x < 8; x++) if (!E.buildWhy(st, t, x, y) && n++ >= skip) return [x, y]; return null; };
const doIt = (st, a, pid) => E.act(st, pid || me(st).id, a);
// 手番プレイヤーが雪原の空きマスにいるようにする
function freeSpot(st) {
  const f = E.genCells(st).find(([x, y]) => E.reach(st, x, y) && !E.bAt(st, x, y) && !E.resAt(st, x, y) && !E.animalAt(st, x, y) && !E.playerAt(st, x, y));
  return f;
}

test('ゲーム開始：動物は人数+2体・資源・初期値', () => {
  const st = mk();
  const f = E.fireOf(st);
  assert.deepStrictEqual([f.w, f.h, f.hp], [3, 3, null]);   // mk は fireDiv=1
  assert.strictEqual(st.fire, 3);
  assert.strictEqual(st.animals.length, 5);   // 人数+2
  assert.ok(Object.keys(st.res).length > 20);
  assert.ok(st.players.every(p => p.temp === 10 && p.food === 10));
  assert.strictEqual(me(st).ap, 7);
  assert.strictEqual(E.cap(st), 2 * 3 + 10);
  // 同じシードなら同じマップ
  assert.deepStrictEqual(mk(5).res, mk(5).res);
});

test('体温低下：場所と天候の組み合わせ', () => {
  const st = mk();
  const p = me(st);
  const loss = w => E.tempLoss(st, p, w);
  assert.deepStrictEqual(['clear', 'snow', 'blizzard', 'rain', 'storm'].map(loss), [0, 1, 2, 0, 4]);   // 焚き火の上（軽減なし）
  const [x, y] = freeSpot(st);
  p.x = x; p.y = y;
  assert.deepStrictEqual(['clear', 'snow', 'blizzard', 'rain', 'storm'].map(loss), [2, 3, 4, 2, 6]);   // 雪原
  st.b.push({ id: 99, t: 'igloo', x, y, w: 2, h: 2, hp: 4, max: 4 });
  assert.deepStrictEqual(['clear', 'snow', 'blizzard', 'rain', 'storm'].map(loss), [1, 1, 1, 1, 3]);   // かまくらの中：猛吹雪でも -3
  st.b[st.b.length - 1].hp = 2;                                                                        // 半分以下で防寒が消える
  assert.strictEqual(loss('clear'), 2);
});

test('手番終了：満腹度-3・火力-1（雨は-2）・動物が動く・次の手番', () => {
  const st = mk();
  st.weather = 'rain';
  const a = me(st);
  const before = JSON.stringify(st.animals);
  assert.ok(doIt(st, { type: 'end' }).ok);
  assert.strictEqual(a.food, 7);
  assert.strictEqual(st.fire, 1);
  assert.notStrictEqual(JSON.stringify(st.animals), before);
  assert.strictEqual(me(st).id, 'p2');
  assert.strictEqual(me(st).ap, 7);
  // 手番外の行動は不可
  assert.match(E.act(st, 'p3', { type: 'warm' }).why, /手番/);
});

test('温まる：焚き火は火力ぶん・外では0', () => {
  const st = mk(); st.weather = 'clear';
  const p = me(st);
  p.temp = 4;
  assert.ok(doIt(st, { type: 'warm' }).ok);
  assert.strictEqual(p.temp, 7);
  assert.strictEqual(p.ap, 5);
  const [x, y] = freeSpot(st);
  p.x = x; p.y = y;
  doIt(st, { type: 'warm' });
  assert.strictEqual(p.temp, 7);
});

test('移動：雪原に入るたび体温-1・建物の上は0・範囲外や生物のマスは不可', () => {
  const st = mk(); st.weather = 'clear';
  const p = me(st);
  E.pl(st, 'p2').x = 1; E.pl(st, 'p2').y = -1; E.pl(st, 'p3').x = -1; E.pl(st, 'p3').y = 1;
  p.x = 1; p.y = 1;
  // 焚き火(-1..1)の外へ。(2,1)は雪原
  const r = doIt(st, { type: 'move', x: 2, y: 1 });
  assert.ok(r.ok);
  assert.strictEqual(p.temp, 9);
  assert.ok(doIt(st, { type: 'move', x: 1, y: 1 }).ok);     // 焚き火の上へ戻る（体温は減らない）
  assert.strictEqual(p.temp, 9);
  assert.match(doIt(st, { type: 'move', x: 20, y: 20 }).why, /マス.*以内/);
  const a = st.animals[0]; a.x = 2; a.y = 0;
  assert.match(doIt(st, { type: 'move', x: 2, y: 0 }).why, /動物/);
  assert.match(doIt(st, { type: 'move', x: 1, y: -1 }).why, /重なれません/);
  // 手番外でも移動できる
  const o = E.pl(st, 'p3');
  const before = o.temp;
  assert.ok(E.act(st, 'p3', { type: 'move', x: 2, y: 1 }).ok);
  assert.ok(o.temp < before);   // 遠回りの経路でも雪原に入った分だけ減る
});

test('集める・攻撃・食べる・上限', () => {
  const st = mk(); st.weather = 'clear';
  const p = me(st);
  st.res['3,0'] = { t: 'tree', hp: 1 };
  p.x = 3; p.y = 0;
  const r = doIt(st, { type: 'collect' });
  assert.ok(r.ok);
  assert.strictEqual(st.items.wood, 1);
  assert.strictEqual(st.items.snow, 1);       // 雪原で採集すると雪も1個
  assert.strictEqual(E.resAt(st, 3, 0), null);   // 体力0で消滅
  // 上限
  st.items.sapling = 0; st.items.wood = 16 - st.items.snow;
  assert.strictEqual(E.room(st), 0);
  st.res['3,0'] = { t: 'stone', hp: 3 };
  // 上限でも集められる。入らない分は、本人が「入れ替える／あきらめる」を選ぶまで保留（その間はほかの行動ができない）
  assert.ok(doIt(st, { type: 'collect' }).ok);
  assert.deepStrictEqual(st.pending, [{ pid: me(st).id, k: 'stone', n: 1 }]);
  assert.strictEqual(st.items.snow, 1);       // 雪は自動で付くだけなので、入らなくても選ばせない
  assert.match(doIt(st, { type: 'warm' }).why, /どうするか選んで/);
  assert.match(doIt(st, { type: 'overflow', drop: { stone: 1 } }).why, /不正/);      // 同じ種類は捨てられない
  assert.match(doIt(st, { type: 'overflow', drop: { wood: 2 } }).why, /入らない数/);
  assert.ok(doIt(st, { type: 'overflow', drop: { wood: 1 } }).ok);
  assert.strictEqual(st.items.stone, 1);
  assert.strictEqual(st.items.wood, 16 - st.items.snow - 1 - 0);
  assert.strictEqual(E.total(st), 16);
  assert.strictEqual(st.pending.length, 0);
  st.res['3,0'] = { t: 'stone', hp: 3 };
  assert.ok(doIt(st, { type: 'collect' }).ok);
  assert.ok(doIt(st, { type: 'overflow', drop: {} }).ok);                            // あきらめる
  assert.strictEqual(st.items.stone, 1);
  // 動物を倒すと肉
  st.items.wood = 0; st.items.stone = 0;
  st.animals = [{ id: 50, x: 4, y: 0, hp: 1 }, { id: 51, x: 9, y: 9, hp: 4 }, { id: 52, x: 8, y: 9, hp: 4 }];
  const m = doIt(st, { type: 'attack', x: 4, y: 0 });
  assert.ok(m.ok);
  assert.ok(st.items.meat >= 1 && st.items.meat <= 7);
  assert.strictEqual(st.animals.length, 3);     // 再出現
  // 食べる
  p.food = 2;
  st.items.meat = 1; st.items.veg = 1;
  doIt(st, { type: 'eat', k: 'meat' }); doIt(st, { type: 'eat', k: 'veg' });
  assert.strictEqual(p.food, 7);
});

test('焚べる：隣接のみ・最大5', () => {
  const st = mk();
  const p = me(st);
  st.items.wood = 5;
  assert.ok(doIt(st, { type: 'stoke' }).ok);
  assert.strictEqual(st.fire, 4);
  doIt(st, { type: 'stoke' });
  assert.match(doIt(st, { type: 'stoke' }).why, /最大/);
  p.x = 5; p.y = 0;
  st.fire = 1;
  assert.match(doIt(st, { type: 'stoke' }).why, /焚き火/);
});

test('植える：苗→1〜3ラウンド後に資源へ', () => {
  const st = mk(); st.weather = 'clear';
  const p = me(st);
  const [x, y] = freeSpot(st);
  p.x = x; p.y = y;
  st.items.veg = 2;
  assert.ok(doIt(st, { type: 'plant', kind: 'veg' }).ok);
  assert.strictEqual(st.items.veg, 0);
  assert.match(doIt(st, { type: 'plant', kind: 'tree' }).why, /ここには植えられません/);
  for (let i = 0; i < 3 * 3; i++) doIt(st, { type: 'end' }, me(st).id);
  assert.strictEqual(st.plants.length, 0);
  assert.strictEqual(E.resAt(st, x, y).t, 'veg');
  assert.ok(E.resAt(st, x, y).hp >= 3 && E.resAt(st, x, y).hp <= 7);
});

test('建設：素材・行動力・重なり・HP・道を上書き・周囲が生成される', () => {
  const st = mk(); st.weather = 'clear';
  const p = me(st);
  assert.match(doIt(st, { type: 'build', t: 'igloo', x: 2, y: -1 }).why, /雪が足りません/);
  st.items.snow = 12;
  assert.match(doIt(st, { type: 'build', t: 'igloo', x: 0, y: 0 }).why, /重なり/);
  assert.match(doIt(st, { type: 'build', t: 'road', x: 5, y: 5 }).why, /隣接/);   // 離れた場所には建てられない
  const r1 = spotFor(st, 'road');
  assert.ok(doIt(st, { type: 'build', t: 'road', x: r1[0], y: r1[1] }).ok);
  const r2 = spotFor(st, 'road', 1);
  assert.ok(doIt(st, { type: 'build', t: 'road', x: r2[0], y: r2[1] }).ok);
  const nb = st.gen.length;
  const spot = [];
  for (let y = -6; y < 6 && !spot.length; y++) for (let x = 2; x < 8; x++) if (!E.buildWhy(st, 'igloo', x, y)) { spot.push(x, y); break; }
  assert.ok(doIt(st, { type: 'build', t: 'igloo', x: spot[0], y: spot[1] }).ok);
  const ig = st.b.find(b => b.t === 'igloo');
  assert.deepStrictEqual([ig.hp, ig.max], [4, 4]);
  assert.strictEqual(st.items.snow, 12 - 2 - 5);
  assert.strictEqual(p.ap, 7 - 2 - 2);
  assert.ok(st.gen.length > nb);
  // 資源のあるマス
  const rs = Object.keys(st.res).map(E.parseKey).find(([x, y]) => E.reach(st, x, y));
  assert.match(E.buildWhy(st, 'road', rs[0], rs[1]), /資源/);
  // 道は建物に上書きされて消える
  st.items.snow = 6; me(st).ap = 7;
  let rd = null;
  for (let y = -3; y < 4 && !rd; y++) for (let x = -3; x < 6; x++) if (!E.buildWhy(st, 'road', x, y)) { rd = [x, y]; break; }
  assert.ok(doIt(st, { type: 'build', t: 'road', x: rd[0], y: rd[1] }).ok);
  assert.ok(doIt(st, { type: 'build', t: 'igloo', x: rd[0], y: rd[1] }).ok);
  assert.ok(!st.b.some(b => b.t === 'road' && b.x === rd[0] && b.y === rd[1]));
});

test('猛吹雪：各手番の開始時に建物HPが1減る・焚き火と道は壊れない・0で消える', () => {
  const st = mk();
  st.weather = 'storm'; st.next = 'storm';
  st.b.push({ id: 90, t: 'igloo', x: 4, y: 0, w: 2, h: 2, hp: 4, max: 4 }, { id: 91, t: 'road', x: 7, y: 0, w: 1, h: 1, hp: null, max: null });
  doIt(st, { type: 'end' });                      // 次の人の手番開始
  assert.strictEqual(st.b.find(b => b.id === 90).hp, 3);
  doIt(st, { type: 'end' }); doIt(st, { type: 'end' }); doIt(st, { type: 'end' });
  assert.ok(!st.b.some(b => b.id === 90));
  assert.ok(st.b.some(b => b.id === 91) && st.b.some(b => b.t === 'fire'));
});

test('直す：隣接・行動力は直径ぶん・石材1でHP+2', () => {
  const st = mk();
  const p = me(st);
  st.b.push({ id: 90, t: 'igloo', x: 3, y: 0, w: 2, h: 2, hp: 1, max: 4 });
  p.x = 1; p.y = 0;
  st.items.stone = 1;
  assert.match(doIt(st, { type: 'repair', id: 90 }).why, /隣/);
  p.x = 2; p.y = 0;
  assert.ok(doIt(st, { type: 'repair', id: 90 }).ok);
  assert.strictEqual(st.b.find(b => b.id === 90).hp, 3);
  assert.strictEqual(p.ap, 5);
  assert.strictEqual(st.items.stone, 0);
});

test('行動不能：焚き火へ強制移動・3に回復・次の手番は温まる/食べるだけ', () => {
  const st = mk(); st.weather = 'clear';
  const a = me(st);
  const [x, y] = freeSpot(st);
  a.x = x; a.y = y; a.temp = 1; a.food = 8;
  doIt(st, { type: 'end' });                      // 体温 1-2 → 0
  assert.strictEqual(a.down, 1);
  assert.strictEqual(a.temp, 3);
  assert.strictEqual(a.food, 5);
  assert.ok(E.bAt(st, a.x, a.y).t === 'fire');
  doIt(st, { type: 'end' }); doIt(st, { type: 'end' });   // 他の2人
  assert.strictEqual(me(st).id, a.id);
  assert.strictEqual(a.down, 2);
  assert.match(doIt(st, { type: 'stoke' }).why, /復帰中/);
  assert.match(doIt(st, { type: 'move', x: 2, y: 1 }).why, /行動不能/);
  assert.ok(doIt(st, { type: 'warm' }).ok);
  doIt(st, { type: 'end' });
  assert.strictEqual(a.down, 0);
});

test('両方0なら両方3・全員が同時に行動不能でゲームオーバー', () => {
  const st = mk(); st.weather = 'clear';
  for (const p of st.players) { p.temp = 1; p.food = 3; const [x, y] = freeSpot(st); p.x = x; p.y = y; }
  // 全員を別々の雪原へ
  st.players.forEach((p, i) => { p.x = 2 + i * 0; p.y = 2; });
  st.players[1].x = 3; st.players[2].x = 4;
  doIt(st, { type: 'end' }); doIt(st, { type: 'end' });
  assert.strictEqual(st.phase, 'play');
  assert.strictEqual(st.players[0].temp, 3); assert.strictEqual(st.players[0].food, 3);
  doIt(st, { type: 'end' });
  assert.strictEqual(st.phase, 'lost');
  assert.strictEqual(st.over.result, 'lost');
});

test('13ラウンドを終えるとクリア・最終猛吹雪は11〜13・予報は1ラウンド先', () => {
  const st = mk();
  const seen = [];
  for (let i = 0; i < 200 && st.phase === 'play'; i++) {
    for (const p of st.players) { p.temp = 10; p.food = 10; }
    seen[st.round] = st.weather;
    if (st.round < 13) assert.ok(st.next);
    doIt(st, { type: 'end' });
  }
  assert.strictEqual(st.phase, 'won');
  assert.strictEqual(st.next, null);
  assert.deepStrictEqual([11, 12, 13].map(r => seen[r]), ['storm', 'storm', 'storm']);
  assert.ok([1, 2, 3].every(r => seen[r] !== 'storm'));
});

test('天候の出現比率（晴れ3：雪2：吹雪1：雨2）・準備期間に猛吹雪は出ない・最終猛吹雪は必ず猛吹雪', () => {
  const st = mk();
  const count = round => {
    const n = { clear: 0, snow: 0, blizzard: 0, rain: 0, storm: 0 };
    for (let i = 0; i < 20000; i++) n[E.rollWeather(st, round)]++;
    return n;
  };
  const tot = 20000;
  for (const round of [2, 5, 10]) {
    const a = count(round);
    assert.strictEqual(a.storm, 0, `ラウンド${round}`);
    [['clear', 3], ['snow', 2], ['blizzard', 1], ['rain', 2]].forEach(([k, w]) => assert.ok(Math.abs(a[k] / tot - w / 8) < 0.02, k));
  }
  assert.strictEqual(count(11).storm, tot);
});

test('焚き火の大きさ：一辺は 人数÷1.5 の切り上げ', () => {
  const mkN = n => E.createGame({ seed: 3, players: Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, color: 'blue' })) });
  assert.deepStrictEqual([3, 4, 5].map(n => E.fireOf(mkN(n)).w), [2, 3, 4]);
  for (const n of [3, 4, 5]) {
    const st = mkN(n), f = E.fireOf(st);
    assert.strictEqual(f.w, f.h);
    // 全員が焚き火の上にいて、重なっていない
    assert.ok(st.players.every(p => p.x >= f.x && p.x < f.x + f.w && p.y >= f.y && p.y < f.y + f.h));
    assert.strictEqual(new Set(st.players.map(p => p.x + ',' + p.y)).size, n);
  }
});

test('資源の比率：木3：石2：野菜2', () => {
  const st = E.createGame({ seed: 11, players: P3 });
  const c = { tree: 0, stone: 0, veg: 0 };
  for (let seed = 1; seed <= 12; seed++) { const g = E.createGame({ seed, players: P3 }); for (const k of Object.keys(g.res)) c[g.res[k].t]++; }
  const tot = c.tree + c.stone + c.veg;
  assert.ok(Math.abs(c.tree / tot - 3 / 7) < 0.06 && Math.abs(c.stone / tot - 2 / 7) < 0.06 && Math.abs(c.veg / tot - 2 / 7) < 0.06, JSON.stringify(c));
  void st;
});

test('捨てる投票：過半数の賛成で1個・反対が半数以上で否決・切断中は反対', () => {
  const st = mk();
  st.items.snow = 3;
  assert.ok(E.act(st, 'p1', { type: 'vote', k: 'snow' }).ok);
  assert.match(E.act(st, 'p2', { type: 'vote', k: 'snow' }).why, /進行中/);
  assert.ok(E.act(st, 'p2', { type: 'voteCast', val: 1 }).ok);       // 2/3
  assert.strictEqual(st.items.snow, 2);
  assert.strictEqual(st.vote, null);
  E.act(st, 'p1', { type: 'vote', k: 'snow' });
  E.act(st, 'p2', { type: 'voteCast', val: -1 });
  assert.ok(st.vote);
  E.act(st, 'p3', { type: 'voteCast', val: -1 });
  assert.strictEqual(st.vote, null);
  assert.strictEqual(st.items.snow, 2);
  // 切断中の人は反対
  E.pl(st, 'p2').away = true; E.pl(st, 'p3').away = true;
  E.act(st, 'p1', { type: 'vote', k: 'snow' });
  assert.strictEqual(st.vote, null);
  assert.strictEqual(st.items.snow, 2);
});

test('お絵かき：手番外だけ・マスをまたぐ線は分割して保存・建物で消える・消しゴム', () => {
  const st = mk();
  assert.match(E.act(st, 'p1', { type: 'draw', c: 'a', pts: [3.2, 1.5, 3.8, 1.5] }).why, /手番以外/);
  const r = E.act(st, 'p2', { type: 'draw', c: 'a', pts: [3.5, 1.5, 5.5, 1.5] });
  assert.ok(r.ok);
  assert.deepStrictEqual(Object.keys(st.draw).sort(), ['3,1', '4,1', '5,1']);
  assert.deepStrictEqual(st.draw['4,1'][0].p, [0, 50, 100, 50]);
  // 建物の上には描けない
  assert.match(E.act(st, 'p2', { type: 'draw', c: 'a', pts: [0.5, 0.5, 0.7, 0.5] }).why, /描けません/);
  E.act(st, 'p2', { type: 'erase', x: 4.5, y: 1.5, r: 0.2 });
  assert.strictEqual(st.draw['4,1'], undefined);
  assert.ok(st.draw['3,1']);
  // 建てるとそのマスの絵は消える
  const sp = spotFor(st, 'igloo');
  E.act(st, 'p2', { type: 'draw', c: 'b', pts: [sp[0] + 0.2, sp[1] + 0.5, sp[0] + 0.7, sp[1] + 0.5] });
  assert.ok(st.draw[sp[0] + ',' + sp[1]]);
  st.items.snow = 5;
  assert.ok(E.act(st, 'p1', { type: 'build', t: 'igloo', x: sp[0], y: sp[1] }).ok);
  assert.strictEqual(st.draw[sp[0] + ',' + sp[1]], undefined);
});

test('猛吹雪を生き延びるのに必要な食料', () => {
  const st = mk();
  // 準備期間：最終猛吹雪の3ラウンド × 3人 × 3
  assert.deepStrictEqual([E.foodNeed(st).need, E.foodNeed(st).short, E.foodNeed(st).turns], [27, 27, 3]);
  st.items.meat = 5; st.items.veg = 5;
  assert.strictEqual(E.foodNeed(st).have, 25);
  assert.strictEqual(E.foodNeed(st).short, 2);
  // 最終猛吹雪の中：残りの手番の終わりごとに3、最後に1以上残す
  st.round = 11;
  const n = E.foodNeed(st);
  assert.strictEqual(n.final, true);
  assert.strictEqual(n.turns, 3);
  assert.strictEqual(n.need, 3 * (3 * 3 + 1 - 10));
  st.players[0].food = 2;
  assert.strictEqual(E.foodNeed(st).need, (3 * 3 + 1 - 2) + 0 + 0);
});

test('ゲーム開始：人数ぶんの野菜が配られる', () => {
  const st = E.createGame({ seed: 1, players: P3 });
  assert.strictEqual(st.items.veg, 3);
  assert.strictEqual(E.createGame({ seed: 1, players: [...P3, { id: 'p4', name: 'P4', color: 'red' }] }).items.veg, 4);
});

test('薪割り台：建てる・木材1→薪2・薪を先に焚べる・壊れる', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const p = me(st);
  const sp = spotFor(st, 'woodshed');
  st.items.wood = 5; st.items.stone = 1;
  assert.ok(doIt(st, { type: 'build', t: 'woodshed', x: sp[0], y: sp[1] }).ok);
  const sh = st.b.find(b => b.t === 'woodshed');
  assert.deepStrictEqual([sh.hp, sh.max, st.items.wood, st.items.stone], [4, 4, 2, 0]);
  p.ap = 7;
  // 離れていると作れない
  p.x = sh.x + 5; p.y = sh.y + 5;
  assert.match(doIt(st, { type: 'craft', recipe: 'firewood' }).why, /薪割り台/);
  p.x = sh.x + 1; p.y = sh.y;                       // 上
  assert.ok(doIt(st, { type: 'craft', recipe: 'firewood' }).ok);
  assert.deepStrictEqual([st.items.wood, st.items.firewood, p.ap], [1, 2, 6]);
  p.x = sh.x + 2; p.y = sh.y;                       // すぐ隣
  assert.ok(doIt(st, { type: 'craft', recipe: 'firewood' }).ok);
  assert.match(doIt(st, { type: 'craft', recipe: 'firewood' }).why, /木材が足りません/);
  assert.strictEqual(st.items.firewood, 4);
  // 焚べるときは、薪を先に使う
  st.items.wood = 2; st.fire = 1; p.x = 0; p.y = 0;
  assert.ok(doIt(st, { type: 'stoke' }).ok);
  assert.deepStrictEqual([st.items.firewood, st.items.wood], [3, 2]);
  st.items.firewood = 0;
  assert.ok(doIt(st, { type: 'stoke' }).ok);
  assert.strictEqual(st.items.wood, 1);
  // 持ち物がいっぱいなら作れない（木材1が薪2になると +1 個）
  p.x = sh.x + 1; p.y = sh.y;
  st.items = { wood: 1, firewood: 0, stone: 0, veg: 0, meat: 0, snow: 0, sapling: 0 }; st.items.snow = 15;
  assert.match(doIt(st, { type: 'craft', recipe: 'firewood' }).why, /いっぱい/);
  // 猛吹雪で壊れる（HPがある）
  st.weather = 'storm'; st.next = 'storm';
  for (let i = 0; i < 12; i++) doIt(st, { type: 'end' }, me(st).id);
  assert.ok(!st.b.some(b => b.t === 'woodshed'));
});

test('見張り台からは2マス以内に移動できる', () => {
  const st = mk();
  st.b.push({ id: 90, t: 'tower', x: 6, y: 0, w: 2, h: 2, hp: 4, max: 4 });
  assert.ok(E.reach(st, 9, 0));        // 見張り台から2マス
  assert.ok(!E.reach(st, 10, 0));
  assert.ok(E.reach(st, 2, 0));        // 焚き火から1マス
  assert.ok(!E.reach(st, 3, 0));       // 見張り台からは3マス、焚き火からは2マスなので届かない
});

test('手番を終えたときの予測', () => {
  const st = mk(); st.weather = 'snow';
  const p = me(st);
  let e = E.endProjection(st, p.id);
  assert.deepStrictEqual([e.food, e.temp, e.fire, e.place, e.collapse], [7, 9, 2, 'fire', false]);
  const [x, y] = freeSpot(st);
  p.x = x; p.y = y; p.temp = 3; p.food = 3;
  e = E.endProjection(st, p.id);
  assert.deepStrictEqual([e.food, e.temp, e.collapse, e.loss], [0, 0, true, 3]);
  st.weather = 'rain';
  assert.strictEqual(E.endProjection(st, p.id).fire, 1);
});

test('結果画面の統計：行動の集計', () => {
  const st = mk(); st.weather = 'clear';
  const p = me(st);
  p.temp = 5; st.items.meat = 1;
  doIt(st, { type: 'warm' });
  doIt(st, { type: 'eat', k: 'meat' });
  const ps = st.stats.players[p.id];
  assert.deepStrictEqual([ps.ap, ps.warmed, ps.eaten], [2, 3, 0]);   // 満腹度は10なので食べても増えない
  p.food = 4; st.items.meat = 1;
  doIt(st, { type: 'eat', k: 'meat' });
  assert.strictEqual(ps.eaten, 3);
  st.items.wood = 1; st.fire = 0;
  doIt(st, { type: 'stoke' });
  assert.strictEqual(ps.stoked, 1);
});
