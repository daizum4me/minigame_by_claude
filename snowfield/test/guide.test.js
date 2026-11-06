const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');

// ブラウザ向けのファイルなので、必要な部分だけ用意して読み込む
global.window = { SnowEngine: E, SnowBoard: { ITEM_ICON: { wood: 'wood', firewood: 'firewood', stone: 'stoneItem', veg: 'veg', meat: 'meat', snow: 'snow', sapling: 'sapling' }, svgIcon: () => '<svg></svg>' } };
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
  assert.ok(all.includes(`${E.RULES.turnLimitMs / 1000}秒`));          // 制限時間
  for (const k of Object.keys(E.BUILD)) assert.ok(all.includes(E.BUILD[k].name), E.BUILD[k].name);   // すべての建物の説明がある
  assert.ok(all.includes('見張り台') && all.includes('薪割り台'));
});
