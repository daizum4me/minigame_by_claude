const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');

global.window = {};
require('../changelog.js');
const L = global.window.SnowChangelog;

test('更新履歴：先頭の版が、いまのバージョンと同じ。版は重複せず、新しい順', () => {
  assert.ok(L.length >= 1);
  assert.strictEqual(L[0].version, E.VERSION);
  const ver = v => v.split('.').map(Number);
  const cmp = (a, b) => { const x = ver(a), y = ver(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
  for (let i = 1; i < L.length; i++) assert.ok(cmp(L[i - 1].version, L[i].version) > 0, '新しい順に並べる');
  for (const e of L) {
    assert.ok(e.date && e.title && e.items.length >= 1, e.version);
    assert.ok(e.items.every(t => typeof t === 'string' && t.length > 5));
  }
});
