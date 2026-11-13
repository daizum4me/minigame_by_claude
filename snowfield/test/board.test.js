const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');

// board.js の描画ロジック（駒の滑らかな移動・パーティクル）を、偽の canvas で確かめる
function makeBoard(st) {
  global.window = { addEventListener() {}, devicePixelRatio: 1 };
  global.document = {};
  global.Path2D = class {};
  global.requestAnimationFrame = () => 0;                 // 描画は、テストが呼ぶ
  global.window.SnowEngine = E;
  global.self = global.window;
  const ctx = new Proxy({}, { get: (t, k) => (k === 'measureText' ? () => ({ width: 10 }) : () => {}), set: () => true });
  const cv = { getContext: () => ctx, addEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), style: {}, width: 800, height: 600 };
  delete require.cache[require.resolve('../board.js')];
  require('../board.js');
  const board = global.window.SnowBoard.create({ canvas: cv, game: () => st, me: () => st.players[0], theme: () => 'light', sel: () => null, onHover() {}, onView() {} });
  board.resize();
  return board;
}

test('駒が動くと、いまの見た目の位置から新しい位置へ、滑らかに動く（瞬間移動しない）', () => {
  const st = E.createGame({ seed: 4, players: [1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, color: 'blue' })) });
  const board = makeBoard(st);
  const s = board.state;
  board.draw();
  assert.strictEqual(Object.keys(s.anims).length, 0);        // 最初は、動いていない
  const p = st.players[0], x0 = p.x;
  p.x += 3;
  board.draw();
  const a = s.anims[p.id];
  assert.ok(a, '動きの記録ができる');
  assert.deepStrictEqual([a.fx, a.tx], [x0, x0 + 3]);
  assert.ok(a.dur >= 140 && a.dur <= 560);
  assert.ok(board.fxActive());
  // 途中で、さらに動かしたら、いまの見た目の位置から続ける
  p.x += 2;
  board.draw();
  assert.strictEqual(s.anims[p.id].tx, x0 + 5);
  assert.ok(s.anims[p.id].fx >= x0 && s.anims[p.id].fx <= x0 + 3);
});

test('パーティクル：出して、時間がたつと消える。種類ごとの見本がある', () => {
  const st = E.createGame({ seed: 4, players: [1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, color: 'blue' })) });
  const board = makeBoard(st);
  const s = board.state;
  for (const k of ['tree', 'stone', 'veg', 'hit', 'kill', 'splash', 'build', 'crumble', 'repair', 'stoke', 'plant', 'eat', 'warm']) {
    s.parts = [];
    board.fx(k, 1, 1, 1);
    assert.ok(s.parts.length > 0, k);
  }
  s.parts = [];
  board.fx('nope', 1, 1, 1);
  assert.strictEqual(s.parts.length, 0);
  board.fx('build', 1, 1, 2);
  const n = s.parts.length;
  assert.ok(n > 20);
  s.lastT = 0;
  for (const q of s.parts) q.age = q.life + 1;                // 寿命が来たら消える
  board.draw();
  assert.strictEqual(s.parts.length, 0);
});

test('すべてのアイテムに、両方のテーマの色と、アイコンがある（持ち物の表示が止まらない）', () => {
  const st = E.createGame({ seed: 4, players: [1, 2, 3].map(i => ({ id: 'p' + i, name: 'P' + i, color: 'blue' })) });
  makeBoard(st);
  const B = global.window.SnowBoard;
  for (const theme of Object.keys(B.THEMES)) {
    for (const k of E.ITEMS) {
      const c = B.THEMES[theme].item[k];
      assert.ok(Array.isArray(c) && c.length >= 2, `${theme}：${k} の色がない`);
      assert.ok(B.ICONS[B.ITEM_ICON[k] || k], `${k} のアイコンがない`);
    }
  }
});
