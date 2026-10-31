const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');
const CPU = require('../shared/cpu');

function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const PLAYERS = 'abcde'.split('').map(id => ({ id, name: id }));

// CPU どうしで最後まで遊ぶ。CPU が選んだ手は、ルール上できるものでなければならない
function play(n, seed, levelOf) {
  const rng = seeded(seed);
  const g = E.createGame(PLAYERS.slice(0, n), rng);
  while (!g.over) {
    for (const p of g.players) {
      for (let i = 0; i < E.RULES.ap; i++) {
        const a = CPU.nextAction(g, p.id, rng, levelOf(p.id));
        if (!a) break;
        const r = E.apply(g, p.id, a);
        assert.ok(r.ok, `${JSON.stringify(a)} → ${r.error}`);
      }
      E.apply(g, p.id, { type: 'finish', on: true });
    }
    E.resolveTurn(g, rng);
  }
  return g;
}

test('CPU どうしで最後まで遊べる（ルール違反の手を選ばない。強さが混ざっていても。2〜5人）', () => {
  for (let seed = 1; seed <= 4; seed++) {
    const n = 2 + (seed % 4);
    const g = play(n, seed, id => ['weak', 'normal', 'strong'][(id.charCodeAt(0) + seed) % 3]);
    assert.ok(g.over);
    assert.strictEqual(g.round, 36);
    assert.ok(Object.keys(g.leaves).length > 0, '葉が1枚もない');
    assert.ok(g.players.some(p => p.score > 0));
  }
});

test('CPU は何も置けない・置く価値がないときは null を返す（行動力を使い切らなくてよい）', () => {
  const g = E.createGame(PLAYERS.slice(0, 2), seeded(1));
  g.over = true;
  assert.strictEqual(CPU.nextAction(g, 'a', seeded(1), 'normal'), null);
  const h = E.createGame(PLAYERS.slice(0, 2), seeded(1));
  for (let i = 0; i < 3; i++) E.apply(h, 'a', CPU.nextAction(h, 'a', seeded(i), 'normal'));
  assert.strictEqual(CPU.nextAction(h, 'a', seeded(9), 'normal'), null);   // 3つ置いたあと
});

test('CPU は最初のターンに、まず枝を置く（葉を置ける枝がないので）', () => {
  const g = E.createGame(PLAYERS.slice(0, 3), seeded(2));
  const a = CPU.nextAction(g, 'a', seeded(1), 'strong');
  assert.ok(a && a.type === 'addBranch');
});
