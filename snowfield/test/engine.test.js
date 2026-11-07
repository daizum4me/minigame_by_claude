const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');

const P3 = [1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, color: 'blue' }));
// 既存のテストは、焚き火が3×3（-1〜1）の配置で書いてあるので、fireDiv=1（人数と同じ辺）にして作る。人数による大きさは別のテストで確かめる
const mk = (seed = 1) => {
  const d = E.RULES.fireDiv; E.RULES.fireDiv = 1;
  const st = E.createGame({ seed, players: P3, simul: false });      // 順番に動く設定（同時に動く設定は別のテストで確かめる）
  E.RULES.fireDiv = d;
  Object.defineProperty(st, 'fire', { get: () => E.fireOf(st).fire, set: v => { E.fireOf(st).fire = v; } });   // テストの書きやすさ用（焚き火が1つのとき）
  for (const k of Object.keys(st.items)) st.items[k] = 0;   // 最初に配られるアイテムは別のテストで確かめる
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

test('手番終了：満腹度-3・次の手番。ラウンドの終わりに、火力が減り（雨は多く）、動物が動く', () => {
  const st = mk();
  st.weather = 'rain';
  const a = me(st);
  const before = JSON.stringify(st.animals);
  assert.ok(doIt(st, { type: 'end' }).ok);
  assert.strictEqual(a.food, 7);
  assert.strictEqual(st.fire, 3);                            // 火力は、ラウンドの終わりまで減らない
  assert.strictEqual(JSON.stringify(st.animals), before);
  assert.strictEqual(me(st).id, 'p2');
  assert.strictEqual(me(st).ap, 7);
  // 手番外の行動は不可
  assert.match(E.act(st, 'p3', { type: 'warm' }).why, /手番/);
  doIt(st, { type: 'end' }); doIt(st, { type: 'end' });      // ラウンドの終わり
  assert.strictEqual(st.round, 2);
  assert.strictEqual(st.fire, Math.max(0, 3 - (E.RULES.fireDrain + 1)));   // 雨は、さらに-1
  assert.notStrictEqual(JSON.stringify(st.animals), before);
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
  const pid = me(st).id;
  assert.deepStrictEqual(st.pending, [{ pid, k: 'stone', n: 1 }, { pid, k: 'snow', n: 1 }]);   // 上限で入らない雪も、自動では捨てず、選ばせる
  assert.strictEqual(st.items.snow, 1);
  assert.match(doIt(st, { type: 'warm' }).why, /どうするか選んで/);
  assert.match(doIt(st, { type: 'overflow', drop: { stone: 1 } }).why, /不正/);      // 同じ種類は捨てられない
  assert.match(doIt(st, { type: 'overflow', drop: { wood: 2 } }).why, /入らない数/);
  assert.ok(doIt(st, { type: 'overflow', drop: { wood: 1 } }).ok);                   // 石材と木材を入れ替える
  assert.strictEqual(st.items.stone, 1);
  assert.strictEqual(st.pending.length, 1);
  assert.ok(doIt(st, { type: 'overflow', drop: {} }).ok);                            // 雪はあきらめる
  assert.deepStrictEqual([st.items.snow, E.total(st), st.pending.length], [1, 16, 0]);
  st.res['3,0'] = { t: 'stone', hp: 3 };
  assert.ok(doIt(st, { type: 'collect' }).ok);
  assert.ok(doIt(st, { type: 'overflow', drop: {} }).ok);
  assert.ok(doIt(st, { type: 'overflow', drop: {} }).ok);
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
  for (let i = 0; i < 3 * 3; i++) { st.fire = 5; doIt(st, { type: 'end' }, me(st).id); }   // 焚き火が消えたまま続くと負けるので、火を保つ
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
  assert.match(doIt(st, { type: 'build', t: 'road', x: 5, y: 5 }).why, /隣接|川/);   // 離れた場所には建てられない
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
  // 資源のあるマスにも建てられる（その資源は消える）
  const rs = Object.keys(st.res).map(E.parseKey).find(([x, y]) => E.reach(st, x, y) && !E.buildWhy(st, 'road', x, y));
  assert.ok(rs, '建てられる資源のマスがある');
  st.items.snow = 6; me(st).ap = 7;
  const res = doIt(st, { type: 'build', t: 'road', x: rs[0], y: rs[1] });
  assert.ok(res.ok && /資源1個は消えた/.test(res.msg));
  assert.strictEqual(E.resAt(st, rs[0], rs[1]), null);
  // 苗のあるマスには建てられない
  st.plants.push({ x: rs[0] + 1, y: rs[1], t: 'veg', left: 2 });
  assert.match(E.buildWhy(st, 'road', rs[0] + 1, rs[1]), /苗/);
  // 道は建物に上書きされて消える
  st.items.snow = 6; me(st).ap = 7;
  let rd = null;
  for (let y = -3; y < 4 && !rd; y++) for (let x = -3; x < 6; x++) if (!E.buildWhy(st, 'road', x, y)) { rd = [x, y]; break; }
  assert.ok(doIt(st, { type: 'build', t: 'road', x: rd[0], y: rd[1] }).ok);
  assert.ok(doIt(st, { type: 'build', t: 'igloo', x: rd[0], y: rd[1] }).ok);
  assert.ok(!st.b.some(b => b.t === 'road' && b.x === rd[0] && b.y === rd[1]));
});

test('猛吹雪：ラウンドの始めに建物HPが減る・焚き火と道は壊れない・0で消える', () => {
  const st = mk();
  st.weather = 'storm'; st.next = 'storm';
  const dmg = E.RULES.stormDmg;
  st.b.push({ id: 90, t: 'workshop', x: 4, y: 0, w: 2, h: 2, hp: 4, max: 4 }, { id: 91, t: 'road', x: 7, y: 0, w: 1, h: 1, hp: null, max: null });
  const round = () => { for (let i = 0; i < 3; i++) { for (const p of st.players) { p.temp = 10; p.food = 10; } st.fire = 5; doIt(st, { type: 'end' }); } };
  round();                                          // ラウンド2の始め
  assert.strictEqual(st.round, 2);
  assert.strictEqual(st.b.find(b => b.id === 90).hp, 4 - dmg);
  while (st.b.some(b => b.id === 90) && st.phase === 'play') round();
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

test('直す：石材は直径÷2の切り上げ（倉庫は2個）', () => {
  const st = mk();
  const p = me(st);
  st.b.push({ id: 91, t: 'storage', x: 3, y: 0, w: 4, h: 4, hp: 2, max: 8 });
  p.x = 2; p.y = 0; p.ap = 6;
  st.items.stone = 1;
  assert.match(doIt(st, { type: 'repair', id: 91 }).why, /石材が足りません/);
  st.items.stone = 3;
  assert.ok(doIt(st, { type: 'repair', id: 91 }).ok);
  assert.strictEqual(st.items.stone, 1);
  assert.strictEqual(E.repairStone({ w: 1 }), 1);
  assert.strictEqual(E.repairStone({ w: 2 }), 1);
  assert.strictEqual(E.repairStone({ w: 3 }), 2);
});

test('弓：木材1石材3で作れて、5マス以内（斜めも）の動物を攻撃できる。素手と同じ攻撃力で、耐久度7', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const p = me(st);
  st.b.push({ id: 90, t: 'workshop', x: 4, y: 0, w: 2, h: 2, hp: 4, max: 4 });
  p.x = 4; p.y = 0; p.ap = 7;
  st.items.wood = 1; st.items.stone = 3;
  assert.ok(doIt(st, { type: 'craft', recipe: 'bow' }).ok);
  assert.deepStrictEqual([st.items.wood, st.items.stone, st.gear[0].k, st.gear[0].dur], [0, 0, 'bow', 7]);
  st.animals = [{ id: 800, x: 4 + 5, y: 0 + 4, hp: 5, max: 5 }, { id: 801, x: 4 + 6, y: 0, hp: 5, max: 5 }];
  p.x = 4; p.y = 0;
  assert.match(doIt(st, { type: 'attack', x: 9, y: 4 }).why, /隣/);   // 弓なしでは届かない
  assert.ok(doIt(st, { type: 'equip', id: st.gear[0].id }).ok);
  assert.ok(doIt(st, { type: 'attack', x: 9, y: 4 }).ok);
  assert.strictEqual(st.animals.find(a => a.id === 800).hp, 4);
  assert.strictEqual(p.tool.dur, 6);
  assert.match(doIt(st, { type: 'attack', x: 10, y: 0 }).why, /5マス/);
});

test('川：焚き火の周りにはなく、建設も移動もできない。魚は人数ぶんいて、川の上だけを動く', () => {
  const st = mk();
  const R = E.RULES;
  for (let y = -R.riverClear; y <= R.riverClear; y++) for (let x = -R.riverClear; x <= R.riverClear; x++) assert.ok(!E.isRiver(st, x, y));
  assert.strictEqual(st.fish.length, st.players.length * R.fishPerPlayer);
  assert.ok(st.fish.every(f => E.isRiver(st, f.x, f.y) && f.hp >= R.fishHpMin && f.hp <= R.fishHpMax));
  const river = E.genCells ? null : null;
  // 川のマスには建てられない・移動できない・資源や動物がいない
  const cells = []; for (let y = -14; y <= 14; y++) for (let x = -14; x <= 14; x++) if (E.isRiver(st, x, y)) cells.push([x, y]);
  assert.ok(cells.length > 0);
  for (const [x, y] of cells) assert.ok(!E.resAt(st, x, y) && !E.animalAt(st, x, y));
  const p = me(st);
  assert.ok(![...E.moveMap(st, p).keys()].some(k => { const [x, y] = E.parseKey(k); return E.isRiver(st, x, y); }));
  const [rx, ry] = [st.fish[0].x, st.fish[0].y];
  assert.match(E.buildWhy(st, 'road', rx, ry), /川/);
  // 魚は、何手番たっても川の上だけ
  for (let i = 0; i < 60; i++) { doIt(st, { type: 'end' }); if (st.phase !== 'play') break; }
  assert.ok(st.fish.every(f => E.isRiver(st, f.x, f.y)));
});

test('川は、途切れずにつながって流れる（ほとんどのマスに、上下左右の川のマスが隣にある）', () => {
  let cells = 0, joined = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const st = { seed };
    for (let y = -40; y <= 40; y++) for (let x = -40; x <= 40; x++) {
      if (!E.isRiver(st, x, y)) continue;
      cells++;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => E.isRiver(st, x + dx, y + dy))) joined++;
    }
  }
  assert.ok(cells > 500, `川が少なすぎる：${cells}`);
  assert.ok(joined / cells > 0.93, `川が途切れている：${(joined / cells).toFixed(2)}`);
});

test('橋：川にだけ木材1で建てられ、道と同じように歩ける。橋の上には建物を建てて上書きできる。川に道や建物は直接建てられない', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const p = me(st);
  // 焚き火から川へ向かって道を伸ばし、川に橋をかける
  const cells = []; for (let y = -14; y <= 14; y++) for (let x = -14; x <= 14; x++) if (E.isRiver(st, x, y)) cells.push([x, y]);
  st.items.wood = 6; st.items.snow = 12; p.ap = 20;
  const target = cells.find(([x, y]) => !E.isRiver(st, x - 1, y));      // 左隣が雪原の川のマス
  assert.ok(target);
  // 川の左隣に道を置いて（テストなので直接）、その周りを生成済みにする
  st.b.push({ id: 95, t: 'road', x: target[0] - 1, y: target[1], w: 1, h: 1, hp: null, max: null });
  st.gen.push([target[0] - 4, target[0] + 4, target[1] - 4, target[1] + 4]);
  assert.match(E.buildWhy(st, 'road', target[0], target[1]), /川/);
  assert.match(E.buildWhy(st, 'igloo', target[0], target[1]), /川/);
  const nonRiver = [target[0] - 1, target[1]];
  assert.match(E.buildWhy(st, 'bridge', nonRiver[0], nonRiver[1]), /重なり|川にだけ/);
  assert.strictEqual(E.buildWhy(st, 'bridge', target[0], target[1]), null);
  const w = st.items.wood;
  p.x = target[0] - 1; p.y = target[1];
  assert.ok(doIt(st, { type: 'build', t: 'bridge', x: target[0], y: target[1] }).ok);
  assert.strictEqual(st.items.wood, w - 1);
  assert.ok(E.bridgeAt(st, target[0], target[1]));
  assert.ok(E.moveMap(st, p).has(E.key(target[0], target[1])));        // 橋の上へ歩ける
  assert.ok(!E.moveMap(st, p).has(E.key(target[0] + 1, target[1])) || !E.isRiver(st, target[0] + 1, target[1]) || E.bAt(st, target[0] + 1, target[1]));
  assert.match(E.buildWhy(st, 'bridge', target[0], target[1]), /重なり/);
});

test('橋の上には、ほかの建物を建てて上書きできる（橋がないと川には建てられない）', () => {
  const st = mk();
  let spot = null;
  for (let y = -14; y <= 14 && !spot; y++) for (let x = -14; x <= 14 && !spot; x++) {
    if (E.isRiver(st, x, y) && !E.isRiver(st, x - 1, y) && !E.isRiver(st, x - 1, y + 1) && !E.isRiver(st, x, y + 1)) spot = [x, y];
  }
  assert.ok(spot);
  const [x, y] = spot;
  st.gen.push([x - 5, x + 5, y - 5, y + 5]);
  st.b.push({ id: 90, t: 'road', x: x - 2, y, w: 1, h: 1, hp: null, max: null });
  assert.match(E.buildWhy(st, 'igloo', x - 1, y), /川/);
  st.b.push({ id: 91, t: 'bridge', x, y, w: 1, h: 1, hp: null, max: null });
  assert.strictEqual(E.buildWhy(st, 'igloo', x - 1, y), null);
  const p = me(st); p.ap = 9; p.x = x - 2; p.y = y; st.items.snow = 5;
  assert.ok(doIt(st, { type: 'build', t: 'igloo', x: x - 1, y }).ok);
  assert.ok(!st.b.some(b => b.t === 'bridge'));                 // 橋は、建物に置き換わる
  assert.ok(E.bAt(st, x, y) && E.bAt(st, x, y).t === 'igloo');
});

test('焼き魚：焚き火で魚1から作れて、食べると満腹度+5（ステーキと同じ）', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const p = me(st);
  const f = E.fireOf(st);
  p.x = f.x; p.y = f.y; p.ap = 5; p.food = 2;
  st.items.fish = 1;
  assert.ok(doIt(st, { type: 'craft', recipe: 'grilled' }).ok);
  assert.deepStrictEqual([st.items.fish, st.items.grilled, p.ap], [0, 1, 4]);
  assert.ok(doIt(st, { type: 'eat', k: 'grilled' }).ok);
  assert.strictEqual(p.food, 2 + E.RULES.eat.steak);
  assert.strictEqual(E.RULES.eat.grilled, E.RULES.eat.steak);
});

test('釣り竿：木材1石材1で作れて、3マス以内の魚を攻撃できる。倒すと魚1〜3個。竿なしでは攻撃できない', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const p = me(st);
  st.b.push({ id: 90, t: 'workshop', x: 4, y: 0, w: 2, h: 2, hp: 4, max: 4 });
  p.x = 4; p.y = 0; p.ap = 8;
  st.items.wood = 1; st.items.stone = 1;
  assert.ok(doIt(st, { type: 'craft', recipe: 'rod' }).ok);
  assert.deepStrictEqual([st.items.wood, st.items.stone, st.gear[0].k, st.gear[0].dur], [0, 0, 'rod', 7]);
  const cells = []; for (let y = -14; y <= 14; y++) for (let x = -14; x <= 14; x++) if (E.isRiver(st, x, y)) cells.push([x, y]);
  const near = cells[0];
  p.x = near[0] - 3; p.y = near[1];                 // 魚から3マスの所へ（テストなので直接置く）
  const far = cells.find(([x, y]) => Math.max(Math.abs(x - p.x), Math.abs(y - p.y)) >= 5);
  assert.ok(near && far);
  st.fish = [{ id: 800, x: near[0], y: near[1], hp: 2, max: 3 }, { id: 801, x: far[0], y: far[1], hp: 1, max: 3 }];
  assert.match(doIt(st, { type: 'attack', x: near[0], y: near[1] }).why, /釣り竿/);
  assert.ok(doIt(st, { type: 'equip', id: st.gear[0].id }).ok);
  assert.match(doIt(st, { type: 'attack', x: far[0], y: far[1] }).why, /3マス/);
  assert.ok(doIt(st, { type: 'attack', x: near[0], y: near[1] }).ok);
  assert.strictEqual(st.fish.find(f => f.id === 800).hp, 1);
  assert.ok(doIt(st, { type: 'attack', x: near[0], y: near[1] }).ok);
  assert.ok(!st.fish.some(f => f.id === 800));
  assert.ok(st.items.fish >= 1 && st.items.fish <= 3);
  assert.strictEqual(st.fish.length, 2);          // 倒された魚は、別の川に現れる
  assert.strictEqual(p.tool.dur, 5);
  const food = p.food; p.food = 3;
  assert.ok(doIt(st, { type: 'eat', k: 'fish' }).ok);
  assert.strictEqual(p.food, 3 + E.RULES.eat.fish);
});

const mkN = (n, o) => E.createGame(Object.assign({ seed: 3, players: Array.from({ length: n }, (_, i) => ({ id: 'p' + (i + 1), name: 'P' + (i + 1), color: 'blue' })) }, o));

test('大人数：8人以上は焚き火が2つになり、プレイヤーが分かれて始まる。焚き火の大きさは、そこで始まる人数に比例', () => {
  const st = mkN(16);
  const fs = E.fires(st);
  assert.strictEqual(fs.length, 2);
  assert.deepStrictEqual(fs.map(f => f.w), [E.fireSize(8), E.fireSize(8)]);
  for (const f of fs) assert.strictEqual(st.players.filter(p => p.home === f.id).length, 8);
  // 全員が、自分の焚き火の上にいて、重ならない
  for (const p of st.players) assert.strictEqual(E.where(st, p).b.id, p.home);
  assert.strictEqual(new Set(st.players.map(p => p.x + ',' + p.y)).size, 16);
  // 7人以下は1つ。9人（5人と4人）は、人数に応じた大きさ
  assert.strictEqual(E.fires(mkN(7)).length, 1);
  const st9 = mkN(9);
  assert.deepStrictEqual(E.fires(st9).map(f => f.w).sort(), [E.fireSize(4), E.fireSize(5)]);
  // 焚き火の周りは川にならず、動物・魚・資源・配布が人数に比例して増える
  assert.strictEqual(st.animals.length, 16 + E.RULES.animalsExtra);
  assert.ok(st.items.veg === 16 && st.items.firewood === 16 && st.items.snow >= 16);
  assert.ok(Object.keys(st.res).length > Object.keys(mkN(3).res).length * 2);
  for (const f of fs) for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) assert.ok(!E.isRiver(st, x, y));
});

test('焚き火が2つ：それぞれに火力があり、ラウンドごとに減る。すべて消えたまま3ラウンドで敗北', () => {
  const st = mkN(16);
  st.weather = 'clear'; st.next = 'clear';
  const [a, b] = E.fires(st);
  assert.deepStrictEqual([a.fire, b.fire], [3, 3]);
  const p = st.players.find(q => q.home === b.id);
  st.items.firewood = 3; p.ap = 7;
  assert.ok(E.act(st, p.id, { type: 'stoke' }).ok);
  assert.deepStrictEqual([a.fire, b.fire], [3, 4]);                    // 隣の焚き火に焚べる
  assert.strictEqual(E.warmAmount(st, p), 4);                           // 温まる量は、自分のいる焚き火の火力
  const endRound = () => { for (const q of st.players) { q.temp = 10; q.food = 10; E.act(st, q.id, { type: 'end' }); } };
  endRound();
  assert.strictEqual(st.round, 2);
  assert.deepStrictEqual([a.fire, b.fire], [3 - E.RULES.fireDrain, 4 - E.RULES.fireDrain].map(v => Math.max(0, v)));
  a.fire = 0; b.fire = 0;
  endRound(); assert.strictEqual(st.fireOut, 1);
  a.fire = 1;                                                           // 片方でも点いていれば、数え直し
  endRound(); assert.strictEqual(st.fireOut, 0);
  a.fire = 0; b.fire = 0;
  endRound(); endRound(); endRound();
  assert.deepStrictEqual([st.phase, st.over.reason], ['lost', 'fire']);
});

test('同時に動く：全員が行動できて、全員が終えるとラウンドが進む。終えた人は行動できない', () => {
  const st = mkN(3);
  assert.strictEqual(E.simul(st), true);
  assert.ok(st.players.every(p => p.ap === 7 && !p.done));
  const [p1, p2, p3] = st.players;
  const f = E.fireOf(st);
  for (const p of st.players) assert.ok(E.act(st, p.id, { type: 'warm' }).ok);   // 手番に関係なく、全員が行動できる
  assert.ok(st.players.every(p => p.ap === 7 - E.RULES.ap.warm));
  assert.ok(E.act(st, p1.id, { type: 'end' }).ok);
  assert.strictEqual(p1.done, true);
  assert.match(E.act(st, p1.id, { type: 'warm' }).why, /終えて/);        // 終えたあとは行動できない
  assert.ok(E.act(st, p1.id, { type: 'draw', c: 'a', pts: [0, 0, 20, 20] }) !== null);
  assert.strictEqual(st.round, 1);
  E.act(st, p2.id, { type: 'end' });
  E.act(st, p3.id, { type: 'end' });
  assert.strictEqual(st.round, 2);                                      // 全員が終えたので、次のラウンド
  assert.ok(st.players.every(p => p.ap === 7 && !p.done && p.food === 10 - E.RULES.hunger));
  void f;
});

test('同時に動く：上限を超えたアイテムの選択は、人ごとに残る。時間切れで全員のラウンドが終わる', () => {
  const st = mkN(3);
  const [p1, p2] = st.players;
  st.pending.push({ pid: p1.id, k: 'snow', n: 1 }, { pid: p2.id, k: 'wood', n: 2 });
  assert.match(E.act(st, p2.id, { type: 'warm' }).why, /先に/);          // 自分の選択が残っていると、ほかの行動はできない
  assert.ok(E.act(st, p2.id, { type: 'overflow', drop: {} }).ok);       // 順番に関係なく、自分の分を選べる
  assert.deepStrictEqual(st.pending.map(q => q.pid), [p1.id]);
  E.forceEndRound(st);                                                  // 時間切れ
  assert.strictEqual(st.round, 2);
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

test('最終ラウンドを終えるとクリア・最終猛吹雪は最後の2ラウンド・予報は1ラウンド先', () => {
  const st = mk();
  const R = E.RULES, seen = [];
  for (let i = 0; i < 200 && st.phase === 'play'; i++) {
    for (const p of st.players) { p.temp = 10; p.food = 10; }
    st.fire = 5;
    seen[st.round] = st.weather;
    if (st.round < E.TOTAL_ROUNDS) assert.ok(st.next);
    doIt(st, { type: 'end' });
  }
  assert.strictEqual(st.phase, 'won');
  assert.strictEqual(st.next, null);
  assert.strictEqual(E.TOTAL_ROUNDS, R.prepRounds + R.finalRounds);
  assert.deepStrictEqual([R.prepRounds, R.finalRounds], [6, 2]);
  for (let r = R.prepRounds + 1; r <= E.TOTAL_ROUNDS; r++) assert.strictEqual(seen[r], 'storm');
  for (let r = 1; r <= R.prepRounds; r++) assert.notStrictEqual(seen[r], 'storm');
});

test('天候の出現比率（晴れ3：雪2：吹雪1：雨2）・準備期間に猛吹雪は出ない・最終猛吹雪は必ず猛吹雪', () => {
  const st = mk();
  const count = round => {
    const n = { clear: 0, snow: 0, blizzard: 0, rain: 0, storm: 0 };
    for (let i = 0; i < 20000; i++) n[E.rollWeather(st, round)]++;
    return n;
  };
  const tot = 20000;
  for (const round of [2, 4, E.RULES.prepRounds]) {
    const a = count(round);
    assert.strictEqual(a.storm, 0, `ラウンド${round}`);
    [['clear', 3], ['snow', 2], ['blizzard', 1], ['rain', 2]].forEach(([k, w]) => assert.ok(Math.abs(a[k] / tot - w / 8) < 0.02, k));
  }
  assert.strictEqual(count(E.RULES.prepRounds + 1).storm, tot);
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
  const R = E.RULES.finalRounds;
  // 準備期間：最終猛吹雪のラウンド数 × 3人 × 3
  assert.deepStrictEqual([E.foodNeed(st).need, E.foodNeed(st).short, E.foodNeed(st).turns], [3 * R * 3, 3 * R * 3, R]);
  st.items.meat = 2; st.items.veg = 2;
  assert.strictEqual(E.foodNeed(st).have, 10);
  assert.strictEqual(E.foodNeed(st).short, 3 * R * 3 - 10);
  // 最終猛吹雪の中：残りのラウンドの終わりごとに3、最後に1以上残す
  st.round = E.RULES.prepRounds + 1;
  for (const p of st.players) p.food = 4;
  const n = E.foodNeed(st);
  assert.strictEqual(n.final, true);
  assert.strictEqual(n.turns, R);
  assert.strictEqual(n.need, 3 * Math.max(0, R * 3 + 1 - 4));
  st.players[0].food = 2;
  assert.strictEqual(E.foodNeed(st).need, Math.max(0, R * 3 + 1 - 2) + 2 * Math.max(0, R * 3 + 1 - 4));
});

test('ゲーム開始：人数ぶんの野菜と薪、雪3個が配られる', () => {
  const st = E.createGame({ seed: 1, players: P3 });
  assert.deepStrictEqual([st.items.veg, st.items.firewood, st.items.snow, st.items.wood], [3, 3, 3, 0]);
  assert.strictEqual(E.createGame({ seed: 1, players: [...P3, { id: 'p4', name: 'P4', color: 'red' }] }).items.veg, 4);
});

test('作業場：建てる（木材3）・木材1→薪2・薪を先に焚べる・壊れる', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const p = me(st);
  const sp = spotFor(st, 'workshop');
  st.items.wood = 5;
  assert.ok(doIt(st, { type: 'build', t: 'workshop', x: sp[0], y: sp[1] }).ok);
  const sh = st.b.find(b => b.t === 'workshop');
  assert.deepStrictEqual([sh.hp, sh.max, st.items.wood], [4, 4, 2]);
  p.ap = 7;
  p.x = sh.x + 5; p.y = sh.y + 5;                                                   // 離れていると作れない
  assert.match(doIt(st, { type: 'craft', recipe: 'firewood' }).why, /作業場/);
  p.x = sh.x + 1; p.y = sh.y;                                                       // 上
  assert.ok(doIt(st, { type: 'craft', recipe: 'firewood' }).ok);
  assert.deepStrictEqual([st.items.wood, st.items.firewood, p.ap], [1, 2, 6]);
  p.x = sh.x + 2; p.y = sh.y;                                                       // すぐ隣
  assert.ok(doIt(st, { type: 'craft', recipe: 'firewood' }).ok);
  assert.match(doIt(st, { type: 'craft', recipe: 'firewood' }).why, /木材が足りません/);
  // 焚べるときは、薪を先に使う
  st.items.wood = 2; st.fire = 1; p.x = 0; p.y = 0;
  assert.ok(doIt(st, { type: 'stoke' }).ok);
  assert.deepStrictEqual([st.items.firewood, st.items.wood], [3, 2]);
  // 持ち物がいっぱいなら作れない（木材1が薪2になると +1 個）
  p.x = sh.x + 1; p.y = sh.y;
  for (const k of Object.keys(st.items)) st.items[k] = 0;
  st.items.wood = 1; st.items.snow = 15;
  assert.match(doIt(st, { type: 'craft', recipe: 'firewood' }).why, /いっぱい/);
  // 猛吹雪で壊れる（HPがある）
  st.weather = 'storm'; st.next = 'storm';
  for (let i = 0; i < 30 && st.b.some(b => b.t === 'workshop') && st.phase === 'play'; i++) { for (const q of st.players) { q.temp = 10; q.food = 10; } st.fire = 5; doIt(st, { type: 'end' }, me(st).id); }
  assert.ok(!st.b.some(b => b.t === 'workshop'));
});

// 焚き火の上に立って、アイテムを持たせる
function atFire(st) { const f = E.fireOf(st), p = me(st); p.x = f.x; p.y = f.y; p.ap = 7; return p; }

test('毛皮：動物を倒すと、肉と毛皮（1〜5個）が手に入る', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const p = me(st);
  const [x, y] = freeSpot(st);
  p.x = x; p.y = y; p.ap = 7;
  st.animals = [{ id: 50, x: x + 1, y, hp: 1, max: 1 }, ...st.animals.slice(1)];
  const r = doIt(st, { type: 'attack', x: x + 1, y });
  assert.ok(r.ok && /毛皮/.test(r.msg));
  assert.ok(st.items.fur >= 1 && st.items.fur <= 5);
  assert.ok(st.items.meat >= 1 && st.items.meat <= 7);
});

test('料理：ステーキ（肉1→満腹度+5）・スープ（野菜2＋雪1→3個・+2）。焚き火の近くで、行動力1', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const p = atFire(st);
  st.items.meat = 1; st.items.veg = 2; st.items.snow = 1;
  assert.ok(doIt(st, { type: 'craft', recipe: 'steak' }).ok);
  assert.deepStrictEqual([st.items.meat, st.items.steak, p.ap], [0, 1, 6]);
  assert.ok(doIt(st, { type: 'craft', recipe: 'soup' }).ok);
  assert.deepStrictEqual([st.items.veg, st.items.snow, st.items.soup, p.ap], [0, 0, 3, 5]);
  p.food = 2;
  assert.ok(doIt(st, { type: 'eat', k: 'steak' }).ok); assert.strictEqual(p.food, 7);
  assert.ok(doIt(st, { type: 'eat', k: 'soup' }).ok); assert.strictEqual(p.food, 9);
  p.x = 5; p.y = 5;
  st.items.meat = 1;
  assert.match(doIt(st, { type: 'craft', recipe: 'steak' }).why, /焚き火/);           // 焚き火から離れると作れない
  // 必要な食料の「持ち物の食料」にも入る
  st.items.steak = 2; st.items.soup = 1; st.items.meat = 0;
  assert.strictEqual(E.foodNeed(st).have, 2 * 5 + 2);
});

test('防寒着：毛皮3→作業場で作る・着けると手番の終わりの体温の低下が1減る（0未満にはならない）', () => {
  const st = mk(); st.weather = 'snow'; st.next = 'snow';
  const p = me(st);
  st.b.push({ id: 90, t: 'workshop', x: 4, y: 0, w: 2, h: 2, hp: 4, max: 4 });
  p.x = 4; p.y = 0; p.ap = 7;
  st.items.fur = 3;
  assert.ok(doIt(st, { type: 'craft', recipe: 'coat' }).ok);
  assert.deepStrictEqual([st.items.fur, st.gear.length, E.total(st)], [0, 1, 1]);        // 作ったものは持ち物（上限に数える）
  const before = E.tempLoss(st, p);
  const id = st.gear[0].id;
  assert.ok(doIt(st, { type: 'equip', id }).ok);                                          // 着けるのは行動力0
  assert.deepStrictEqual([p.ap, st.gear.length, p.gear.k], [6, 0, 'coat']);
  assert.strictEqual(E.tempLoss(st, p), before - 1);
  p.x = E.fireOf(st).x; p.y = E.fireOf(st).y; st.weather = 'clear';
  assert.strictEqual(E.tempLoss(st, p), 0);                                                // 焚き火の上の晴れ＝もともと0
  // 外すのは行動力1。持ち物に戻る
  const ap0 = p.ap;
  assert.ok(doIt(st, { type: 'unequip', slot: 'gear' }).ok);
  assert.deepStrictEqual([p.ap, p.gear, st.gear.length], [ap0 - 1, null, 1]);
});

test('道具：斧・ツルハシ・シャベルは集める量+1、槍は攻撃力+1。耐久度7で壊れる。枠は1つで、入れ替えは行動力1', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const p = me(st);
  st.b.push({ id: 90, t: 'workshop', x: 4, y: 0, w: 2, h: 2, hp: 4, max: 4 });
  p.x = 4; p.y = 0; p.ap = 7;
  st.items.wood = 4; st.items.stone = 4; st.items.fur = 4;
  assert.ok(doIt(st, { type: 'craft', recipe: 'axe' }).ok);
  assert.deepStrictEqual([st.items.wood, st.items.stone, st.items.fur], [3, 3, 3]);
  assert.strictEqual(st.gear[0].dur, 7);
  assert.ok(doIt(st, { type: 'equip', id: st.gear[0].id }).ok);
  // 木：体力が2減って、木材が2個
  p.x = 6; p.y = 6; st.res['6,6'] = { t: 'tree', hp: 5, max: 5 };
  st.items.wood = 0;
  assert.ok(doIt(st, { type: 'collect' }).ok);
  assert.deepStrictEqual([st.items.wood, st.res['6,6'].hp, p.tool.dur], [2, 3, 6]);
  // 石は、斧では増えない
  st.res['6,6'] = { t: 'stone', hp: 5, max: 5 }; st.items.stone = 0;
  assert.ok(doIt(st, { type: 'collect' }).ok);
  assert.deepStrictEqual([st.items.stone, st.res['6,6'].hp, p.tool.dur], [1, 4, 6]);
  // 体力1の木では、増えるのは1個だけ
  st.res['6,6'] = { t: 'tree', hp: 1, max: 1 }; st.items.wood = 0; p.ap = 7;
  assert.ok(doIt(st, { type: 'collect' }).ok);
  assert.strictEqual(st.items.wood, 1);
  // 耐久度が0になると壊れる
  p.tool.dur = 1; st.res['6,6'] = { t: 'tree', hp: 4, max: 4 };
  const r = doIt(st, { type: 'collect' });
  assert.ok(/壊れた/.test(r.msg));
  assert.strictEqual(p.tool, null);
  // 槍：攻撃力2
  st.gear.push({ id: 700, k: 'spear', dur: 7 }, { id: 701, k: 'pick', dur: 7 });
  assert.ok(doIt(st, { type: 'equip', id: 700 }).ok);
  const [x, y] = freeSpot(st);
  p.x = x; p.y = y; p.ap = 7;
  st.animals = [{ id: 50, x: x + 1, y, hp: 5, max: 5 }, ...st.animals.slice(1)];
  assert.ok(doIt(st, { type: 'attack', x: x + 1, y }).ok);
  assert.deepStrictEqual([st.animals[0].hp, p.tool.dur], [3, 6]);
  // 道具の枠は1つ：入れ替えるには、外す行動力1
  const ap1 = p.ap;
  assert.ok(doIt(st, { type: 'equip', id: 701 }).ok);
  assert.deepStrictEqual([p.tool.k, p.ap, st.gear.map(g => g.k)], ['pick', ap1 - 1, ['spear']]);
  assert.strictEqual(st.gear[0].dur, 6);                    // 外した道具は、耐久度を保ったまま持ち物に戻る
  p.ap = 0;
  assert.match(doIt(st, { type: 'equip', id: st.gear[0].id }).why, /行動力が足りません/);
});

test('復帰中の手番は、作る・着けるもできない（温まる・食べるだけ）', () => {
  const st = mk();
  const p = atFire(st);
  p.down = 2; st.items.meat = 1; st.gear.push({ id: 5, k: 'coat', dur: null });
  assert.match(doIt(st, { type: 'craft', recipe: 'steak' }).why, /復帰中/);
  assert.match(doIt(st, { type: 'equip', id: 5 }).why, /復帰中/);
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
  assert.deepStrictEqual([e.food, e.temp, e.fire, e.place, e.collapse], [7, 9, 3 - E.RULES.fireDrain, 'fire', false]);
  const [x, y] = freeSpot(st);
  p.x = x; p.y = y; p.temp = 3; p.food = 3;
  e = E.endProjection(st, p.id);
  assert.deepStrictEqual([e.food, e.temp, e.collapse, e.loss], [0, 0, true, 3]);
  st.weather = 'rain';
  assert.strictEqual(E.endProjection(st, p.id).fire, 3 - E.RULES.fireDrain - 1);
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

test('焚き火が消えたまま3ラウンドが続くと敗北（火力1以上でラウンドを終えると数え直し）', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const rnd = () => { for (let i = 0; i < 3; i++) { for (const p of st.players) { p.temp = 10; p.food = 10; } doIt(st, { type: 'end' }); } };
  st.fire = 0;
  rnd();
  assert.deepStrictEqual([st.fireOut, st.phase], [1, 'play']);
  assert.strictEqual(E.endProjection(st, me(st).id).fireOutNext, 2);
  // 薪を入れてラウンドを終えると、数え直し
  st.items.firewood = 1;
  doIt(st, { type: 'stoke' });
  rnd();
  assert.strictEqual(st.fireOut, 0);
  assert.strictEqual(st.fire, 0);                                       // 火力は、ラウンドの終わりに減って0に戻る
  rnd(); assert.strictEqual(st.fireOut, 1);
  rnd(); assert.strictEqual(st.fireOut, 2);
  assert.strictEqual(E.endProjection(st, me(st).id).fireLose, true);
  rnd();
  assert.deepStrictEqual([st.phase, st.over.reason], ['lost', 'fire']);
});

test('道をふさぐ駒：駒を無視すれば通れる道と、ふさいでいる駒がわかる。どいてもらう移動は、その道を避ける', () => {
  const st = mk(); st.weather = 'clear'; st.next = 'clear';
  const a = me(st), b = E.pl(st, 'p2');
  // 道を作る（焚き火の右に一直線）。aは焚き火の端、bは道の途中にいる
  const f = E.fireOf(st);
  for (let x = f.x + f.w; x < f.x + f.w + 4; x++) st.b.push({ id: 500 + x, t: 'road', x, y: f.y, w: 1, h: 1, hp: null, max: null });
  a.x = f.x + f.w - 1; a.y = f.y;
  const mid = f.x + f.w + 1;
  b.x = mid; b.y = f.y;
  const far = f.x + f.w + 3;
  const info = E.pathBlockers(st, a, far, f.y);
  assert.ok(info.blockers.some(q => q.id === 'p2'), 'bが道をふさいでいる');
  assert.ok(info.path.includes(mid + ',' + f.y));
  assert.strictEqual(info.ideal, 0);                                           // 道の上だけを通れば、体温は減らない
  assert.ok(info.real == null || info.real > 0);                               // 道をふさがれると、遠回り（雪原を通る）か、行けない
  // 行き先そのものにいても、ふさいでいる
  b.x = far; b.y = f.y;
  assert.ok(E.pathBlockers(st, a, far, f.y).blockers.some(q => q.id === 'p2'));
  // どいてもらう：道のマスを避けて動く
  b.x = mid; b.y = f.y;
  const avoid = E.pathBlockers(st, a, far, f.y).path;
  const r = E.act(st, 'p2', { type: 'moveAside', avoid });
  assert.ok(r.ok, r.why);
  assert.ok(!avoid.includes(b.x + ',' + b.y));
  assert.ok(E.moveMap(st, a).has(far + ',' + f.y));                      // これで通れる
  // 体温が低いときは動かない／行動不能中も動けない
  b.x = mid; b.y = f.y; b.temp = 3;
  const noRoad = E.act(st, 'p2', { type: 'moveAside', avoid: [] });
  assert.ok(noRoad.ok || /体温/.test(noRoad.why));
  b.down = 1;
  assert.match(E.act(st, 'p2', { type: 'moveAside', avoid: [] }).why, /行動不能/);
});
