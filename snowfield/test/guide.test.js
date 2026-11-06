const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../shared/engine');

// ブラウザ向けのファイルなので、必要な部分だけ用意して読み込む
global.window = { SnowEngine: E, SnowBoard: { ITEM_ICON: { wood: 'wood', firewood: 'firewood', stone: 'stoneItem', veg: 'veg', meat: 'meat', snow: 'snow', sapling: 'sapling' }, svgIcon: n => `<svg data-i="${n}"></svg>` } };
require('../guide.js');
const G = global.window.SnowGuide;

test('ルールの全ページが作れて、数値がルールに合っている', () => {
  assert.ok(G.PAGES.length >= 10);
  const ids = new Set();
  for (const p of G.PAGES) {
    assert.ok(!ids.has(p.id), '項目の id が重複');
    ids.add(p.id);
    const html = p.html();
    assert.ok(html.length > 100, p.title);
    assert.ok(!/undefined|NaN|\[object/.test(html), `${p.title} に壊れた表示がある`);
  }
  const all = G.PAGES.map(p => p.html()).join('');
  assert.ok(all.includes(`${E.RULES.turnLimitMs / 1000}秒`));                                           // 制限時間
  for (const k of Object.keys(E.BUILD)) assert.ok(all.includes(E.BUILD[k].name), E.BUILD[k].name);   // すべての建物の説明がある
  assert.ok(all.includes('3人＝2×2') && all.includes('5人＝4×4'));                                       // 焚き火の大きさ
  assert.ok(all.includes('木3：石2：野菜2'));                                                             // 資源の比率
});

test('ルールのアイコンは、すべて board.js の絵として用意されている', () => {
  const src = fs.readFileSync(path.join(__dirname, '../board.js'), 'utf8');
  const have = new Set([...src.matchAll(/^\s{4}(\w+): \[/gm)].map(m => m[1]));
  const used = new Set([...G.PAGES.map(p => p.html()).join('').matchAll(/data-i="(\w+)"/g)].map(m => m[1]));
  G.PAGES.forEach(p => used.add(p.icon));
  const items = { wood: 'wood', firewood: 'firewood', stone: 'stoneItem', veg: 'veg', meat: 'meat', snow: 'snow', sapling: 'sapling' };
  for (const u of used) assert.ok(have.has(u) || have.has(items[u]), `絵がない：${u}`);
});
