import { describe, expect, it } from 'vitest';
import { applyAction, createGame, buildCheck, fixedRng, itemCap, route, type Action, type GameState } from '../src';

/** 決定論的なテスト用の盤面：資源・動物なし、天候は晴れ */
function bare(players = 3, patch: Partial<GameState> = {}): GameState {
  const s = createGame({ players, seed: 1, config: { initialItems: {} } });
  s.resources = []; s.animals = []; s.plants = [];
  s.weather = 'clear'; s.nextWeather = 'clear';
  return Object.assign(s, patch);
}
const run = (s: GameState, a: Action, rng = fixedRng([0.5])) => applyAction(s, a, rng);
const ok = (s: GameState, a: Action, rng = fixedRng([0.5])) => {
  const r = run(s, a, rng);
  expect(r.ok, r.message).toBe(true);
  return r.state;
};
const fire = (s: GameState) => s.buildings.find((b) => b.t === 'fire')!;

describe('初期状態', () => {
  it('体温・満腹10、行動力7、同じseedで同じ盤面', () => {
    const a = createGame({ players: 3, seed: 42 }), b = createGame({ players: 3, seed: 42 });
    expect(a.players.every((p) => p.temp === 10 && p.food === 10 && p.ap === 7)).toBe(true);
    expect(a).toEqual(b);
    expect(createGame({ players: 3, seed: 43 }).resources).not.toEqual(a.resources);
  });
  it('人数範囲外は作れない', () => {
    expect(() => createGame({ players: 1 })).toThrow();
    expect(() => createGame({ players: 6 })).toThrow();
  });
  it('上限＝2×人数＋10＋10×倉庫', () => {
    const s = bare(3);
    expect(itemCap(s)).toBe(16);
    s.buildings.push({ id: 99, t: 'storage', x: 0, y: 0, w: 4, h: 4, hp: 8, max: 8 });
    expect(itemCap(s)).toBe(26);
  });
});

describe('移動', () => {
  it('雪原に入るたび体温-1、建物・道の上だけなら無料', () => {
    const s = bare();
    const f = fire(s);
    // 焚き火の外周（雪原）へ。ポーン0は焚き火の上
    const r = route(s, 0, f.x + 3, f.y + 2);
    expect(r).toMatchObject({ ok: true, cost: 1 });
    expect(route(s, 0, f.x + 2, f.y)).toMatchObject({ ok: true, cost: 0 });
    const s2 = ok(s, { type: 'move', player: 0, x: f.x + 3, y: f.y + 2 });
    expect(s2.players[0].temp).toBe(9);
  });
  it('建物から2マスより遠い雪原、他プレイヤー、動物のマスには行けない', () => {
    const s = bare();
    const f = fire(s);
    expect(route(s, 0, f.x + 5, f.y).ok).toBe(false);
    expect(route(s, 0, s.players[1].x, s.players[1].y).ok).toBe(false);
    s.animals.push({ id: 90, x: f.x + 3, y: f.y, hp: 3 });
    expect(route(s, 0, f.x + 3, f.y).ok).toBe(false);
  });
  it('道でつなぐと遠くまで無料で歩ける', () => {
    const s = bare();
    const f = fire(s);
    s.items.snow = 3; s.players[0].ap = 7;
    let st = s;
    for (let i = 0; i < 3; i++) st = ok(st, { type: 'build', player: 0, building: 'road', x: f.x + 3 + i, y: f.y + 2 });
    expect(route(st, 0, f.x + 5, f.y + 2)).toMatchObject({ ok: true, cost: 0 });
  });
});

describe('手番外の制限', () => {
  it('手番外は移動とお絵かき以外できない', () => {
    const s = bare();
    expect(run(s, { type: 'warm', player: 1 }).ok).toBe(false);
    expect(run(s, { type: 'draw', x0: 1, y0: 1, x1: 1.5, y1: 1, color: '#000' }).ok).toBe(true);
    const f = fire(s);
    expect(run(s, { type: 'move', player: 1, x: f.x + 3, y: f.y + 2 }).ok).toBe(true);
  });
});

describe('温まる・焚べる・食べる', () => {
  it('焚き火の上では火力ぶん回復、屋外は0、行動力2', () => {
    const s = bare();
    s.players[0].temp = 2;
    const s2 = ok(s, { type: 'warm', player: 0 });
    expect(s2.players[0].temp).toBe(5);
    expect(s2.players[0].ap).toBe(5);
    const f = fire(s);
    const out = ok(s, { type: 'move', player: 0, x: f.x + 3, y: f.y + 2 });
    out.players[0].temp = 2;
    expect(ok(out, { type: 'warm', player: 0 }).players[0].temp).toBe(2);
  });
  it('焚べる：木材1＋行動力1で火力+1、最大5', () => {
    const s = bare();
    s.items.wood = 5;
    let st = s;
    st = ok(st, { type: 'stoke', player: 0 });
    st = ok(st, { type: 'stoke', player: 0 });
    expect(st.fire).toBe(5);
    expect(run(st, { type: 'stoke', player: 0 }).ok).toBe(false);
    expect(st.items.wood).toBe(3);
  });
  it('食べる：肉+3、野菜+2、行動力0', () => {
    const s = bare();
    s.players[0].food = 2; s.items.meat = 1; s.items.veg = 1;
    const s2 = ok(ok(s, { type: 'eat', player: 0, item: 'meat' }), { type: 'eat', player: 0, item: 'veg' });
    expect(s2.players[0].food).toBe(7);
    expect(s2.players[0].ap).toBe(7);
  });
});

describe('手番終了', () => {
  it('焚き火の上：満腹-3、火力-1、体温は晴れなら減らない', () => {
    const s = ok(bare(), { type: 'endTurn', player: 0 });
    expect(s.players[0]).toMatchObject({ temp: 10, food: 7 });
    expect(s.fire).toBe(2);
    expect(s.turn).toBe(1);
  });
  it('屋外：晴れで-2、雪で-3', () => {
    const s = bare();
    const f = fire(s);
    let st = ok(s, { type: 'move', player: 0, x: f.x + 3, y: f.y + 2 });
    st = ok(st, { type: 'endTurn', player: 0 });
    expect(st.players[0].temp).toBe(9 - 2);
    const s2 = bare(3, { weather: 'snow' });
    let st2 = ok(s2, { type: 'move', player: 0, x: f.x + 3, y: f.y + 2 });
    st2 = ok(st2, { type: 'endTurn', player: 0 });
    expect(st2.players[0].temp).toBe(9 - 3);
  });
  it('雨は火力が2下がる', () => {
    const s = ok(bare(3, { weather: 'rain' }), { type: 'endTurn', player: 0 });
    expect(s.fire).toBe(1);
  });
  it('行動不能：焚き火へ移動し0の方が3に回復、次の手番は温まる/食べるだけ、その後は通常', () => {
    const s = bare(3);
    const f = fire(s);
    let st = ok(s, { type: 'move', player: 0, x: f.x + 3, y: f.y + 2 });
    st.players[0].temp = 2; // 屋外で -2 → 0
    st = ok(st, { type: 'endTurn', player: 0 });
    const p = st.players[0];
    expect(p.incapacitated).toBe(true);
    expect(p.temp).toBe(3);
    expect(p.food).toBe(7);
    expect(p.x >= f.x && p.x < f.x + 3 && p.y >= f.y && p.y < f.y + 3).toBe(true);
    st = ok(ok(st, { type: 'endTurn', player: 1 }), { type: 'endTurn', player: 2 });
    expect(st.turn).toBe(0);
    st.items.wood = 3;
    expect(run(st, { type: 'stoke', player: 0 }).ok).toBe(false);
    expect(run(st, { type: 'collect', player: 0 }).ok).toBe(false);
    st = ok(st, { type: 'warm', player: 0 });
    st = ok(st, { type: 'endTurn', player: 0 });
    expect(st.players[0].incapacitated).toBe(false);
  });
  it('満腹度が0でも行動不能（満腹が3に回復）', () => {
    const s = bare(3);
    s.players[0].food = 3;
    const st = ok(s, { type: 'endTurn', player: 0 });
    expect(st.players[0]).toMatchObject({ incapacitated: true, food: 3 });
  });
  it('行動不能の直後の手番でまた0になったら敗北（仮ルール）', () => {
    const s = bare(2);
    s.players[0].food = 3;
    let st = ok(s, { type: 'endTurn', player: 0 });
    st = ok(st, { type: 'endTurn', player: 1 });
    st.players[0].food = 3;
    st = ok(st, { type: 'endTurn', player: 0 });
    expect(st.phase).toBe('lost');
  });
});

describe('ラウンドと天候', () => {
  it('全員が終えるとラウンドが進み、天候が予報どおりに切り替わる', () => {
    const s = bare(2);
    s.nextWeather = 'rain';
    let st = ok(s, { type: 'endTurn', player: 0 });
    expect(st.round).toBe(1);
    st = ok(st, { type: 'endTurn', player: 1 });
    expect(st.round).toBe(2);
    expect(st.weather).toBe('rain');
    expect(st.turn).toBe(0);
  });
  it('準備10ラウンドの後は最終猛吹雪3ラウンド、生き延びれば勝ち', () => {
    let st = bare(2);
    st.items.wood = 0;
    const play = (n: number) => {
      for (let i = 0; i < n; i++) {
        for (const p of [0, 1]) {
          st.players.forEach((q) => { q.temp = 10; q.food = 10; });
          st.fire = 5;
          st = ok(st, { type: 'endTurn', player: p });
          if (st.phase !== 'playing') return;
        }
      }
    };
    play(10);
    expect(st.round).toBe(11);
    expect(st.weather).toBe('final');
    play(2);
    expect(st.round).toBe(13);
    expect(st.phase).toBe('playing');
    play(1);
    expect(st.phase).toBe('won');
  });
  it('猛吹雪では手番開始ごとに建物HP-1（焚き火・道は対象外）、0で消える', () => {
    const s = bare(2, { weather: 'final', nextWeather: 'final' });
    s.buildings.push({ id: 50, t: 'igloo', x: 0, y: 0, w: 2, h: 2, hp: 2, max: 4 });
    s.buildings.push({ id: 51, t: 'road', x: 5, y: 0, w: 1, h: 1, hp: null, max: null });
    let st = ok(s, { type: 'endTurn', player: 0 });
    expect(st.buildings.find((b) => b.id === 50)!.hp).toBe(1);
    st = ok(st, { type: 'endTurn', player: 1 });
    expect(st.buildings.find((b) => b.id === 50)).toBeUndefined();
    expect(st.buildings.some((b) => b.t === 'fire')).toBe(true);
    expect(st.buildings.some((b) => b.t === 'road')).toBe(true);
  });
});

describe('資源・動物・植える', () => {
  it('集める：行動力1、雪原では雪も+1、HP0で消滅。木は50%で苗木', () => {
    const s = bare();
    const f = fire(s);
    let st = ok(s, { type: 'move', player: 0, x: f.x + 3, y: f.y + 2 });
    st.resources.push({ id: 80, t: 'tree', x: st.players[0].x, y: st.players[0].y, hp: 1 });
    const got = ok(st, { type: 'collect', player: 0 }, fixedRng([0.1]));
    expect(got.items).toMatchObject({ wood: 1, snow: 1, sapling: 1 });
    expect(got.resources).toHaveLength(0);
    const no = ok(st, { type: 'collect', player: 0 }, fixedRng([0.9]));
    expect(no.items.sapling).toBe(0);
  });
  it('建物の上で集めても雪は付かない', () => {
    const s = bare();
    const f = fire(s);
    s.buildings.push({ id: 60, t: 'road', x: f.x + 3, y: f.y, w: 1, h: 1, hp: null, max: null });
    s.resources.push({ id: 81, t: 'stone', x: f.x, y: f.y, hp: 3 });
    // 資源は建物の上に置かない前提だが、ロジック上は雪が付かないことを確認
    s.players[0].x = f.x; s.players[0].y = f.y;
    const st = ok(s, { type: 'collect', player: 0 });
    expect(st.items.snow).toBe(0);
  });
  it('所持上限を超えると集められない', () => {
    const s = bare();
    s.items.wood = itemCap(s);
    s.resources.push({ id: 82, t: 'stone', x: s.players[0].x, y: s.players[0].y, hp: 3 });
    expect(run(s, { type: 'collect', player: 0 }).ok).toBe(false);
  });
  it('動物：隣から攻撃、倒すと肉1〜7個と別マスに再出現', () => {
    const s = bare();
    const f = fire(s);
    const p = s.players[0];
    s.animals.push({ id: 70, x: p.x, y: p.y - 1, hp: 1 });
    expect(f.y).toBeLessThanOrEqual(p.y);
    expect(run(s, { type: 'attack', player: 0, x: p.x + 1, y: p.y }).ok).toBe(false);
    const st = ok(s, { type: 'attack', player: 0, x: p.x, y: p.y - 1 }, fixedRng([0.99, 0.5]));
    expect(st.items.meat).toBe(7);
    expect(st.animals).toHaveLength(1);
    expect(st.animals[0]).not.toMatchObject({ x: p.x, y: p.y - 1 });
  });
  it('植える：雪原のみ。野菜2個／苗木1個、1〜3ラウンドで資源になる', () => {
    const s = bare(2);
    const f = fire(s);
    s.items.veg = 2; s.items.sapling = 1;
    expect(run(s, { type: 'plant', player: 0, kind: 'veg' }).ok).toBe(false); // 焚き火の上
    let st = ok(s, { type: 'move', player: 0, x: f.x + 3, y: f.y + 2 });
    st = ok(st, { type: 'plant', player: 0, kind: 'veg' }, fixedRng([0.99])); // growIn=3
    expect(st.items.veg).toBe(0);
    expect(st.plants[0].growIn).toBe(3);
    expect(run(st, { type: 'plant', player: 0, kind: 'tree' }).ok).toBe(false); // 苗のあるマス
    for (let r = 0; r < 3; r++) {
      st.players.forEach((q) => { q.temp = 10; q.food = 10; });
      st = ok(ok(st, { type: 'endTurn', player: 0 }), { type: 'endTurn', player: 1 }, fixedRng([0.5]));
    }
    expect(st.plants).toHaveLength(0);
    expect(st.resources).toHaveLength(1);
    expect(st.resources[0]).toMatchObject({ t: 'veg', x: f.x + 3, y: f.y + 2 });
    expect(st.resources[0].hp).toBeGreaterThanOrEqual(3);
    expect(st.resources[0].hp).toBeLessThanOrEqual(7);
  });
});

describe('建設・修理', () => {
  it('かまくら：雪5＋行動力2、HP4。素材・行動力不足は失敗', () => {
    const s = bare();
    const f = fire(s);
    expect(run(s, { type: 'build', player: 0, building: 'igloo', x: f.x + 4, y: f.y }).ok).toBe(false);
    s.items.snow = 5;
    const st = ok(s, { type: 'build', player: 0, building: 'igloo', x: f.x + 4, y: f.y });
    const b = st.buildings.find((q) => q.t === 'igloo')!;
    expect(b).toMatchObject({ w: 2, hp: 4, max: 4 });
    expect(st.items.snow).toBe(0);
    expect(st.players[0].ap).toBe(5);
  });
  it('倉庫は上限+10、HP8。見張り台は木材5石材3', () => {
    const s = bare();
    const f = fire(s);
    s.items.wood = 5; s.items.stone = 4;
    s.players[0].ap = 7;
    const st = ok(s, { type: 'build', player: 0, building: 'storage', x: f.x + 4, y: f.y + 4 });
    expect(st.buildings.find((q) => q.t === 'storage')).toMatchObject({ hp: 8, max: 8 });
    expect(itemCap(st)).toBe(26);
    const s2 = bare(); s2.items.wood = 5; s2.items.stone = 3;
    expect(ok(s2, { type: 'build', player: 0, building: 'tower', x: f.x + 4, y: f.y }).items).toMatchObject({ wood: 0, stone: 0 });
  });
  it('道以外は建物・資源・苗・動物のマスに建てられない。道の上には建てられ、道を置き換える', () => {
    const s = bare();
    const f = fire(s);
    expect(buildCheck(s, f.x, f.y, 'road')).not.toBeNull();
    expect(buildCheck(s, f.x - 1, f.y - 1, 'igloo')).not.toBeNull();
    s.resources.push({ id: 1, t: 'tree', x: 0, y: 0, hp: 3 });
    expect(buildCheck(s, 0, 0, 'road')).not.toBeNull();
    s.buildings.push({ id: 61, t: 'road', x: 10, y: 10, w: 1, h: 1, hp: null, max: null });
    expect(buildCheck(s, 10, 10, 'road')).not.toBeNull();
    expect(buildCheck(s, 10, 10, 'igloo')).toBeNull();
    s.items.snow = 5;
    const st = ok(s, { type: 'build', player: 0, building: 'igloo', x: 10, y: 10 });
    expect(st.buildings.some((b) => b.t === 'road')).toBe(false);
  });
  it('建設したマスの絵は消える', () => {
    const s = bare();
    const f = fire(s);
    s.items.snow = 1;
    let st = ok(s, { type: 'draw', x0: f.x + 3.2, y0: f.y + 0.5, x1: f.x + 4.8, y1: f.y + 0.5, color: '#000' });
    expect(Object.keys(st.drawing)).toHaveLength(2);
    st = ok(st, { type: 'build', player: 0, building: 'road', x: f.x + 3, y: f.y });
    expect(Object.keys(st.drawing)).toEqual([`${f.x + 4},${f.y}`]);
  });
  it('修理：行動力＝一辺、石材1でHP+2（最大HPが上限）。防寒は半分を超えて復活', () => {
    const s = bare();
    const f = fire(s);
    s.buildings.push({ id: 70, t: 'igloo', x: f.x + 3, y: f.y, w: 2, h: 2, hp: 2, max: 4 });
    s.items.stone = 2;
    s.players[0].x = f.x + 2; s.players[0].y = f.y; // 隣接
    let st = ok(s, { type: 'repair', player: 0, building: 70 });
    expect(st.buildings.find((b) => b.id === 70)!.hp).toBe(4);
    expect(st.players[0].ap).toBe(5);
    expect(st.items.stone).toBe(1);
    expect(run(st, { type: 'repair', player: 0, building: 70 }).ok).toBe(false);
    expect(run(st, { type: 'repair', player: 0, building: fire(st).id }).ok).toBe(false);
  });
});

describe('お絵かき', () => {
  it('隣のマスにまたがる線はマス単位に分かれ、消しゴムで他人の線も消せる', () => {
    const s = bare();
    let st = ok(s, { type: 'draw', x0: 1.5, y0: 1.5, x1: 2.5, y1: 1.5, color: 'a' });
    expect(Object.keys(st.drawing).sort()).toEqual(['1,1', '2,1']);
    st = ok(st, { type: 'erase', x: 2.4, y: 1.5, r: 0.3 });
    expect(Object.keys(st.drawing)).toEqual(['1,1']);
  });
});

describe('捨てる投票', () => {
  it('過半数の賛成で可決。開始者は賛成済み', () => {
    const s = bare(3);
    s.items.wood = 2;
    let st = ok(s, { type: 'startVote', player: 0, item: 'wood' });
    expect(st.vote).not.toBeNull();
    expect(run(st, { type: 'startVote', player: 1, item: 'wood' }).ok).toBe(false);
    st = ok(st, { type: 'castVote', player: 1, value: 1 });
    expect(st.vote).toBeNull();
    expect(st.items.wood).toBe(1);
  });
  it('反対が半数以上で否決', () => {
    const s = bare(4);
    s.items.wood = 1;
    let st = ok(s, { type: 'startVote', player: 0, item: 'wood' });
    st = ok(st, { type: 'castVote', player: 1, value: -1 });
    const r = run(st, { type: 'castVote', player: 2, value: -1 });
    expect(r.ok).toBe(false);
    expect(r.state.vote).toBeNull();
    expect(r.state.items.wood).toBe(1);
  });
});

describe('純粋性', () => {
  it('applyAction は元の state を書き換えない', () => {
    const s = bare();
    const snap = JSON.stringify(s);
    run(s, { type: 'warm', player: 0 });
    run(s, { type: 'endTurn', player: 0 });
    expect(JSON.stringify(s)).toBe(snap);
  });
});
