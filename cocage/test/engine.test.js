const test = require('node:test');
const assert = require('node:assert');
const E = require('../shared/engine');

// 再現できる乱数
function seeded(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const NEVER = () => 0.9999;   // 折れも抽選の「先頭以外」も起きない乱数
const FIRST = () => 0;        // 抽選では先頭の人が勝ち、折れ判定は全部折れる

const PLAYERS = 'abcde'.split('').map(id => ({ id, name: id.toUpperCase() }));
const newGame = n => E.createGame(PLAYERS.slice(0, n), seeded(1));
const P = (g, id) => g.players.find(p => p.id === id);
const act = (g, id, a) => { const r = E.apply(g, id, a); assert.ok(r.ok, r.error); };

// 幹を s 辺まで伸ばす
function grow(g, s) { for (const p of g.players) p.trunkLen = s; }

test('盤面：18行・列数は 6×人数。セルの数・幹の位置・隣の幹との間は通常の列がちょうど4列', () => {
  for (const n of [2, 3, 4, 5]) {
    const g = newGame(n), geo = E.geometry(g.cols);
    assert.strictEqual(g.cols, 6 * n);
    assert.strictEqual(Object.keys(geo.cells).length, 18 * 6 * n);
    assert.deepStrictEqual(geo.trunks.map(t => t.col), [2, 8, 14, 20, 26].slice(0, n));
    // 幹のそばの2列（幹の列とその右隣）を除くと、次の幹までに通常の列が4列
    const near = new Set(geo.trunks.flatMap(t => [t.col, t.col + 1]));
    let run = 0, started = false;
    const runs = [];
    for (let c = 0; c < g.cols * 2; c++) {
      if (near.has(c % g.cols)) { if (started && run) runs.push(run); run = 0; started = true; } else run++;
    }
    assert.ok(runs.length && runs.every(r => r === 4), `通常の列の並び ${runs}`);
  }
  assert.throws(() => E.createGame(PLAYERS.slice(0, 1), seeded(1)));
  assert.throws(() => E.createGame([...PLAYERS, { id: 'f', name: 'F' }], seeded(1)));
});

test('頂点には辺が3本ずつ集まり（上下の端を除く）、幹の辺は36本・根から最上部まで続く', () => {
  const geo = E.geometry(12);
  const deg = {};
  for (const v of Object.values(geo.verts)) deg[v.edges.length] = (deg[v.edges.length] || 0) + 1;
  assert.deepStrictEqual(deg, { 2: 24, 3: 432 });
  for (const t of geo.trunks) {
    assert.strictEqual(t.verts.length, 37);
    assert.ok(t.edges.slice(1).every(ek => geo.edges[ek]));
    assert.strictEqual(geo.verts[t.verts[0]].y, 0);
    assert.strictEqual(geo.verts[t.verts[36]].y, 36);
    // 1行 = 2辺。辺の高さは 1,1,2,2,…,18,18
    assert.deepStrictEqual(t.edges.slice(1).map(ek => geo.edges[ek].h), Array.from({ length: 36 }, (_, i) => Math.floor(i / 2) + 1));
  }
  assert.strictEqual(geo.reserved.size, 72);
});

test('折れる確率：p = 0.05% + 0.03%×高さ + 0.15%×支えている枝の数。根本ほど折れやすい。長さ8・高さ9の先端の葉は10ターン生き残る確率が約45%', () => {
  assert.ok(Math.abs(E.breakProb(9, 8) - 0.0152) < 1e-12);
  assert.ok(Math.abs(E.breakProb(1, 1) - 0.0023) < 1e-12);
  const g = newGame(2);
  let parent = null;
  for (let l = 1; l <= 8; l++) { const k = 'e' + l; g.edges[k] = { owner: 'a', from: 'x', to: 'y', parent, l, h: 9, round: 0 }; parent = k; }
  const st = E.edgeStats(g, 'e8', 10);
  assert.ok(Math.abs(st.survive - 0.45) < 0.02, `生存率 ${st.survive}`);
  assert.ok(Math.abs(st.p - 0.0047) < 1e-12);                       // 先端は自分だけを支える（1本）
  assert.strictEqual(E.edgeStats(g, 'e1', 10).parts.w, 8);           // 根本は8本を支える
  assert.ok(Math.abs(E.edgeStats(g, 'e1', 10).p - 0.0152) < 1e-12);
  assert.deepStrictEqual(E.loads(g), { e1: 8, e2: 7, e3: 6, e4: 5, e5: 4, e6: 3, e7: 2, e8: 1 });
});

test('幹の成長：最初から1辺伸びていて、毎ターン1辺ずつ伸びる。最上部に達したら止まり、ゲームが終わる', () => {
  const g = newGame(2);
  assert.deepStrictEqual(g.players.map(p => p.trunkLen), [1, 1]);
  for (let t = 1; t <= 36; t++) {
    assert.strictEqual(g.over, false);
    E.resolveTurn(g, NEVER);
    assert.deepStrictEqual(g.players.map(p => p.trunkLen), [Math.min(36, t + 1), Math.min(36, t + 1)]);
  }
  assert.ok(g.over);
  assert.strictEqual(g.round, 36);
  const geo = E.geometry(g.cols);
  assert.strictEqual(geo.verts[geo.trunks[0].verts[g.players[0].trunkLen]].y, 36);   // 18行目の頂点
  assert.deepStrictEqual(g.winners, ['a', 'b']);                                      // 何も置かなければ同点
  assert.strictEqual(E.resolveTurn(g, NEVER), null);
});

test('最初から伸びている幹の先（頂点1）にも、枝をつなげられる', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  const tip = geo.trunks[0].verts[1];
  const ek = geo.verts[tip].edges.find(k => !geo.reserved.has(k));
  assert.ok(ek);
  assert.ok(E.apply(g, 'a', { type: 'addBranch', edge: ek }).ok);
  const far = geo.trunks[0].verts[2];
  // まだ伸びていない先の頂点には、つなげない
  assert.match(E.apply(g, 'a', { type: 'addBranch', edge: geo.verts[far].edges.find(k => !geo.reserved.has(k)) }).error, /つながる/);
});

test('幹に接するだけのセルへの葉：既定ではだめ。RULES.leafOnTrunk を true にすると置けて、枝がなくても消えない', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  const trunkCell = geo.edges[geo.trunks[0].edges[1]].cells[0];
  assert.ok(!E.candidates(g, 'a').cells.includes(trunkCell));
  assert.match(E.apply(g, 'a', { type: 'addLeaf', cell: trunkCell }).error, /枝に接する/);
  E.RULES.leafOnTrunk = true;
  try {
    assert.ok(E.candidates(g, 'a').cells.includes(trunkCell));
    assert.ok(E.apply(g, 'a', { type: 'addLeaf', cell: trunkCell }).ok);
    E.apply(g, 'a', { type: 'finish' }); E.apply(g, 'b', { type: 'finish' });
    E.resolveTurn(g, NEVER);
    assert.ok(g.leaves[trunkCell]);                       // 幹は折れないので、葉も残る
  } finally { E.RULES.leafOnTrunk = false; }
});

test('枝：自分の幹・枝の頂点から1本つなぐ。幹の辺・使われた辺・つながらない辺・両端がつながった辺は置けない', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  const root = geo.trunks[0].verts[0];
  const around = geo.verts[root].edges;
  const trunkEdge = geo.trunks[0].edges[1];
  assert.ok(around.includes(trunkEdge));
  assert.match(E.apply(g, 'a', { type: 'addBranch', edge: trunkEdge }).error, /幹が通る/);
  assert.match(E.apply(g, 'a', { type: 'addBranch', edge: geo.trunks[1].edges[1] }).error, /幹が通る/);   // 相手の幹の予約もだめ
  const far = Object.keys(geo.edges).find(k => !geo.edges[k].a.startsWith('7,') && !geo.edges[k].b.startsWith('7,') && !geo.reserved.has(k));
  assert.match(E.apply(g, 'a', { type: 'addBranch', edge: far }).error, /つながる/);
  assert.match(E.apply(g, 'a', { type: 'addBranch', edge: 'x|y' }).error, /辺はありません/);
  const ok = around.find(k => !geo.reserved.has(k));
  act(g, 'a', { type: 'addBranch', edge: ok });
  assert.match(E.apply(g, 'a', { type: 'addBranch', edge: ok }).error, /もう枝/);
  // 幹はまだ根だけ。幹の先（これから伸びる頂点）にはつなげない
  const c = E.candidates(g, 'a');
  assert.ok(c.edges.every(k => !geo.reserved.has(k)));
  assert.ok(c.cells.length > 0);
});

test('葉：自分の枝に接するセルに置ける（幹に接するだけではだめ）。計画した枝にもつなげられる', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  const trunkCell = geo.edges[geo.trunks[0].edges[1]].cells[0];
  assert.match(E.apply(g, 'a', { type: 'addLeaf', cell: trunkCell }).error, /枝に接する/);
  const ek = geo.verts[geo.trunks[0].verts[0]].edges.find(k => !geo.reserved.has(k));
  act(g, 'a', { type: 'addBranch', edge: ek });
  const cell = E.candidates(g, 'a').cells[0];
  assert.ok(geo.cells[cell].edges.includes(ek));
  act(g, 'a', { type: 'addLeaf', cell });
  assert.match(E.apply(g, 'a', { type: 'addLeaf', cell }).error, /もう葉/);
  assert.strictEqual(P(g, 'a').plan.length, 2);
});

test('行動力は毎ターン3。4つ目は計画できない。外すと、それにつながる行動も外れる。確定は全員そろうまで取り消せる', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  const ek = geo.verts[geo.trunks[0].verts[0]].edges.find(k => !geo.reserved.has(k));
  act(g, 'a', { type: 'addBranch', edge: ek });
  const cell = E.candidates(g, 'a').cells[0];
  act(g, 'a', { type: 'addLeaf', cell });
  const farV = geo.edges[ek].a === geo.trunks[0].verts[0] ? geo.edges[ek].b : geo.edges[ek].a;
  const next = E.candidates(g, 'a').edges.find(k => geo.edges[k].a === farV || geo.edges[k].b === farV);   // 最初の枝の先につなぐ
  act(g, 'a', { type: 'addBranch', edge: next });
  assert.strictEqual(E.apply(g, 'a', { type: 'addLeaf', cell: E.candidates(g, 'a').cells[0] || cell }).ok, false);   // もう3つ
  assert.deepStrictEqual(E.candidates(g, 'a'), { edges: [], cells: [], mistle: [] });
  act(g, 'a', { type: 'remove', index: 0 });                              // 最初の枝を外す → つながる葉・枝も外れる
  assert.deepStrictEqual(P(g, 'a').plan, []);
  act(g, 'a', { type: 'addBranch', edge: ek });
  act(g, 'a', { type: 'confirm', index: 0 });
  assert.strictEqual(P(g, 'a').plan[0].done, true);
  assert.strictEqual(P(g, 'a').finished, false);                         // 3つそろっていないので、まだ待たない
  act(g, 'a', { type: 'finish' });
  assert.strictEqual(P(g, 'a').finished, true);
  act(g, 'a', { type: 'finish', on: false });
  assert.deepStrictEqual([P(g, 'a').finished, P(g, 'a').plan[0].done], [false, false]);
  act(g, 'a', { type: 'finish' });
  act(g, 'a', { type: 'addBranch', edge: E.candidates(g, 'a').edges[0] });   // 計画を変えると、確定は外れる
  assert.strictEqual(P(g, 'a').finished, false);
  assert.strictEqual(E.apply(g, 'a', { type: 'dance' }).ok, false);
});

test('同時行動：自分だけが選んだ辺・セルは必ず成功。同じ辺を複数人が選ぶと等確率の抽選で1人だけが成功し、負けても行動力は戻らない', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  // a と b の枝が同じ辺を選ぶ状況を作る：b の幹の根を a の枝の先につなげる（b の幹の頂点から）
  const ek = geo.verts[geo.trunks[0].verts[0]].edges.find(k => !geo.reserved.has(k));
  const e = geo.edges[ek];
  const farV = geo.trunks[0].verts.includes(e.a) ? e.b : e.a;
  // b の枝を、a の枝の先の頂点（farV）に伸びる辺まで届く形で用意する
  g.edges['b-pre'] = { owner: 'b', from: geo.trunks[1].verts[0], to: farV, parent: null, l: 1, h: 1, round: 0 };
  P(g, 'b').trunkLen = 0;
  act(g, 'a', { type: 'addBranch', edge: ek });
  // b は farV を自分の頂点として持つので、b の側から同じ辺は「両端がつながった」になるため、別の辺で衝突を作る
  const other = geo.verts[farV].edges.find(k => k !== ek && !geo.reserved.has(k) && !g.edges[k]);
  assert.ok(other);
  act(g, 'b', { type: 'addBranch', edge: other });
  act(g, 'a', { type: 'finish' }); act(g, 'b', { type: 'finish' });
  const info = E.resolveTurn(g, NEVER);
  assert.deepStrictEqual([info.contested, info.lost.length, info.placedBranches], [0, 0, 2]);   // 選んだ人が1人なら必ず成功

  // 同じセルに葉：a と b が同じセルを選ぶ。a・b ともにそのセルに接する枝を持つ
  const g2 = newGame(2), geo2 = E.geometry(g2.cols);
  const cell = Object.keys(geo2.cells)[100];
  const ce = geo2.cells[cell].edges;
  g2.edges[ce[0]] = { owner: 'a', from: 'x', to: 'y', parent: null, l: 1, h: 1, round: 0 };
  g2.edges[ce[3]] = { owner: 'b', from: 'x', to: 'y', parent: null, l: 1, h: 1, round: 0 };
  act(g2, 'a', { type: 'addLeaf', cell }); act(g2, 'b', { type: 'addLeaf', cell });
  const info2 = E.resolveTurn(g2, () => 0);   // 先頭（a）が勝つ。折れ判定は rng()<p で全部折れてしまうので、枝の判定は別に
  assert.strictEqual(info2.contested, 1);
  assert.strictEqual(info2.lost.length, 1);
  assert.deepStrictEqual(info2.lost[0], { owner: 'b', t: 'l', key: cell });
  // 勝敗は等確率：多数回やって、ほぼ半々
  let aWins = 0;
  const rng = seeded(5);
  for (let i = 0; i < 400; i++) {
    const h = newGame(2), hg = E.geometry(h.cols);
    h.edges[hg.cells[cell].edges[0]] = { owner: 'a', from: 'x', to: 'y', parent: null, l: 1, h: 1, round: 0 };
    h.edges[hg.cells[cell].edges[3]] = { owner: 'b', from: 'x', to: 'y', parent: null, l: 1, h: 1, round: 0 };
    act(h, 'a', { type: 'addLeaf', cell }); act(h, 'b', { type: 'addLeaf', cell });
    const calls = [rng(), 0.9999, 0.9999, 0.9999];
    let n = 0;
    E.resolveTurn(h, () => (n < 1 ? calls[n++] : 0.9999));
    if (h.leaves[cell] && h.leaves[cell].owner === 'a') aWins++;
  }
  assert.ok(aWins > 140 && aWins < 260, `a の勝ち ${aWins}/400`);
});

test('折れる：その辺とその先の枝・葉がすべて消え、あとから作り直せる。折れたターンの記録が残る', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  // a：根から3本の枝（e1 → e2 → e3）と、e3 に接するセルの葉。ほかに e1 から分かれる e2b
  const path = [];
  let v = geo.trunks[0].verts[0];
  const seen = new Set([v]);
  for (let i = 0; i < 3; i++) {
    const ek = geo.verts[v].edges.find(k => !geo.reserved.has(k) && !g.edges[k] && !seen.has(geo.edges[k].a === v ? geo.edges[k].b : geo.edges[k].a));
    const e = geo.edges[ek], to = e.a === v ? e.b : e.a;
    g.edges[ek] = { owner: 'a', from: v, to, parent: path.length ? path[path.length - 1] : null, l: i + 1, h: e.h, round: 0 };
    path.push(ek); seen.add(to); v = to;
  }
  const cell = geo.edges[path[2]].cells[0];
  g.leaves[cell] = { owner: 'a', round: 0 };
  // 真ん中の辺（path[1]）だけが折れる乱数：辺の順に判定される。path[1] は2番目
  const order = Object.keys(g.edges);
  const idx = order.indexOf(path[1]);
  let n = 0;
  const info = E.resolveTurn(g, () => (n++ === idx ? 0 : 0.9999));
  assert.deepStrictEqual(info.broken, [path[1]]);
  assert.ok(g.edges[path[0]] && !g.edges[path[1]] && !g.edges[path[2]]);
  assert.strictEqual(g.leaves[cell], undefined);
  assert.deepStrictEqual(info.removed.map(r => [r.key, r.primary]).sort(), [[path[1], true], [path[2], false]].sort());
  assert.strictEqual(info.removedLeaves, 1);
  // 傷あと：折れた根元の頂点からは、3ターンのあいだ枝を伸ばせない（ほかの人は置ける）
  assert.deepStrictEqual(info.scars, [{ vert: g.edges[path[0]].to, owner: 'a' }]);
  const r = E.apply(g, 'a', { type: 'addBranch', edge: path[1] });
  assert.ok(!r.ok && /傷あと/.test(r.error), r.error);
  assert.ok(!E.candidates(g, 'a').edges.includes(path[1]));
  E.resolveTurn(g, NEVER); E.resolveTurn(g, NEVER);
  assert.ok(!E.apply(g, 'a', { type: 'addBranch', edge: path[1] }).ok);   // 3ターン目もまだ
  E.resolveTurn(g, NEVER);
  // 3ターンたったら作り直せる
  act(g, 'a', { type: 'addBranch', edge: path[1] });
  assert.deepStrictEqual(g.scars, {});
});

test('葉は、ほかの枝にも支えられていれば残る（支えがすべてなくなると消える）', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  const cell = Object.keys(geo.cells)[60], ce = geo.cells[cell].edges;
  g.edges[ce[0]] = { owner: 'a', from: 'x', to: 'y', parent: null, l: 1, h: 1, round: 0 };
  g.edges[ce[2]] = { owner: 'a', from: 'x2', to: 'y2', parent: null, l: 1, h: 1, round: 0 };
  g.leaves[cell] = { owner: 'a', round: 0 };
  const order = Object.keys(g.edges);
  let n = 0;
  E.resolveTurn(g, () => (n++ === order.indexOf(ce[0]) ? 0 : 0.9999));
  assert.ok(g.leaves[cell]);                       // ce[2] が残っている
  n = 0;
  const order2 = Object.keys(g.edges);
  E.resolveTurn(g, () => (n++ === order2.indexOf(ce[2]) ? 0 : 0.9999));
  assert.strictEqual(g.leaves[cell], undefined);
});

// 高さボーナスを0にして、基本の得点だけを確かめる
function noHeight(fn) {
  const h = E.RULES.score.height;
  E.RULES.score.height = 0;
  try { fn(); } finally { E.RULES.score.height = h; }
}

test('得点：一番上の葉は 1 + min(3, 下にある他人の葉の数)。ほかは、その人の一番上の葉（上に他人の葉がある）だけが 0.3、同じ人の2枚目以降は 0', () => noHeight(() => {
  const s = list => E.scoreColumn(list.map(([r, owner]) => ({ r, owner })));
  assert.deepStrictEqual(s([[5, 'a']]), [1]);                                     // 自分だけでも 1 点
  assert.deepStrictEqual(s([[5, 'a'], [2, 'b']]), [2, 0.3]);                      // 上が a：1+1。下の b は覆われている
  assert.deepStrictEqual(s([[5, 'a'], [2, 'a']]), [1, 0]);                        // 下も自分の葉：他人ではないので +0、上が自分だけなので 0
  assert.deepStrictEqual(s([[9, 'a'], [8, 'b'], [7, 'a'], [6, 'c'], [5, 'd']]), [4, 0.3, 0, 0.3, 0.3]);   // 下の他人は4枚でも上限3。a の2枚目は 0
  assert.deepStrictEqual(s([[9, 'a'], [8, 'b'], [7, 'a'], [6, 'a'], [5, 'a']]), [2, 0.3, 0, 0, 0]);          // 上から □■□□□ = 2・0.3・0・0・0
  assert.deepStrictEqual(s([[9, 'a'], [8, 'b'], [7, 'b'], [6, 'b']]), [4, 0.3, 0, 0]);                       // b の2枚目以降も 0
  assert.deepStrictEqual(s([[9, 'a'], [8, 'a'], [7, 'b']]), [2, 0, 0.3]);         // 上が自分の葉と他人の葉
  assert.deepStrictEqual(s([[3, 'b'], [8, 'a'], [5, 'c']]), [0.3, 3, 0.3]);       // 並びは順不同でよい
}));

test('高さボーナス：一番上の葉にだけ 0.1 × 行番号（下から1〜18）を足す', () => {
  const s = list => E.scoreColumn(list.map(([r, owner]) => ({ r, owner }))).map(v => Math.round(v * 1000) / 1000);
  assert.deepStrictEqual(s([[0, 'a']]), [1.1]);                     // 1行目
  assert.deepStrictEqual(s([[17, 'a'], [2, 'b']]), [3.8, 0.3]);     // 18行目：1+1+1.8。覆われた葉には付かない
});

test('光合成：ターンの終わりに列ごとに得点が入り、合計・加点・推移が記録される。一番上の入れ替わりを数える', () => noHeight(() => {
  const g = newGame(2), geo = E.geometry(g.cols);
  const colCells = Object.keys(geo.cells).filter(k => k.startsWith('4,')).sort((x, y) => +x.split(',')[1] - +y.split(',')[1]);
  const mk = (cell, owner) => {
    const ek = geo.cells[cell].edges[0];
    g.edges[ek] = { owner, from: 'x', to: 'y', parent: null, l: 1, h: 1, round: 0 };
    g.leaves[cell] = { owner, round: 0 };
  };
  mk(colCells[3], 'a'); mk(colCells[1], 'b');
  const info = E.resolveTurn(g, NEVER);
  assert.deepStrictEqual([P(g, 'a').gain, P(g, 'b').gain], [2, 0.3]);
  assert.deepStrictEqual([P(g, 'a').score, P(g, 'b').score], [2, 0.3]);
  assert.deepStrictEqual(P(g, 'a').history, [0, 2]);
  assert.strictEqual(info.topChanges, 0);
  // b が上に葉を置く → 一番上が入れ替わる
  mk(colCells[6], 'b');
  const info2 = E.resolveTurn(g, NEVER);
  assert.strictEqual(info2.topChanges, 1);
  assert.deepStrictEqual([P(g, 'a').gain, P(g, 'b').gain], [0.3, 2]);     // b：一番上（下の他人は a の1枚）→ 2、b の下の葉は 2枚目なので 0。a は 0.3
  assert.deepStrictEqual(P(g, 'a').history, [0, 2, 2.3]);
  assert.deepStrictEqual(P(g, 'b').history, [0, 0.3, 2.3]);
}));

test('ターンの解決で計画と確定はクリアされる。勝者は合計点が最高の人（同点は全員）', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  const ek = geo.verts[geo.trunks[0].verts[0]].edges.find(k => !geo.reserved.has(k));
  act(g, 'a', { type: 'addBranch', edge: ek });
  act(g, 'a', { type: 'finish' });
  E.resolveTurn(g, NEVER);
  assert.deepStrictEqual(g.players.map(p => [p.plan.length, p.finished]), [[0, false], [0, false]]);
  assert.ok(g.edges[ek]);
  assert.strictEqual(g.edges[ek].round, 1);
  g.round = 35;
  P(g, 'a').score = 5.5; P(g, 'b').score = 5;
  E.resolveTurn(g, NEVER);
  assert.ok(g.over);
  assert.deepStrictEqual(g.winners, ['a']);
});

test('枝の折れやすさ：確率・内訳・失うもの', () => {
  const g = newGame(2), geo = E.geometry(g.cols);
  g.edges['e1'] = { owner: 'a', from: 'x', to: 'y', parent: null, l: 1, h: 4, round: 0 };
  g.edges['e2'] = { owner: 'a', from: 'y', to: 'z', parent: 'e1', l: 2, h: 5, round: 0 };
  const st = E.edgeStats(g, 'e1', 10);
  assert.ok(Math.abs(st.p - (0.0005 + 0.0003 * 4 + 0.0015 * 2)) < 1e-12);   // e1 は e1・e2 の2本を支える
  assert.deepStrictEqual([st.lostEdges, st.parts.base], [2, 0.0005]);
  assert.deepStrictEqual(E.subtree(g, 'e1').sort(), ['e1', 'e2']);
  assert.deepStrictEqual(E.pathTo(g, 'e2'), ['e2', 'e1']);
  assert.strictEqual(E.edgeStats(g, 'nope'), null);
});

test('ヤドリギ：他人の枝に接するセルに行動力3（そのターンすべて）で葉を置ける（1ターン1回）。宿主の枝が折れると一緒に消え、宿主を重くする', () => {
  const g = newGame(3), geo = E.geometry(g.cols);
  // b の枝を1本（根から）。a はそこに接するセルへヤドリギ
  const v0 = geo.trunks[1].verts[2];       // 2行目の幹の頂点から出る、セルが2つ接する辺
  const ek = geo.verts[v0].edges.find(k => !geo.reserved.has(k) && geo.edges[k].cells.length === 2);
  const e = geo.edges[ek], to = e.a === v0 ? e.b : e.a;
  g.edges[ek] = { owner: 'b', from: v0, to, parent: null, l: 1, h: e.h, round: 0 };
  const cand = E.candidates(g, 'a').mistle;
  assert.ok(cand.length > 1 && cand.every(ck => geo.cells[ck].edges.includes(ek)));
  const ck = cand[0];
  assert.ok(!E.candidates(g, 'b').mistle.includes(ck));                      // 自分の枝に接するセルには要らない
  assert.ok(!E.apply(g, 'b', { type: 'addMistletoe', cell: ck }).ok);
  act(g, 'a', { type: 'addMistletoe', cell: ck });
  assert.strictEqual(E.planCost(P(g, 'a').plan), 3);                         // 行動力3＝そのターンすべて
  assert.deepStrictEqual(E.candidates(g, 'a'), { edges: [], cells: [], mistle: [] });   // 1ターン1回。ほかには何も置けない
  assert.ok(!E.apply(g, 'a', { type: 'addMistletoe', cell: cand[1] }).ok);
  assert.ok(!E.apply(g, 'a', { type: 'addBranch', edge: geo.verts[geo.trunks[0].verts[0]].edges.find(k => !geo.reserved.has(k)) }).ok);
  // 先に枝を置いてしまうと、行動力が足りなくてヤドリギは置けない
  act(g, 'c', { type: 'addBranch', edge: geo.verts[geo.trunks[2].verts[0]].edges.find(k => !geo.reserved.has(k)) });
  assert.deepStrictEqual(E.candidates(g, 'c').mistle, []);
  E.resolveTurn(g, NEVER);
  assert.deepStrictEqual(g.leaves[ck], { owner: 'a', round: 1, host: ek });
  assert.strictEqual(E.loads(g)[ek], 2);                                     // 宿主は葉の分、重くなる
  // 宿主が折れると、ヤドリギの葉も消える
  const order = Object.keys(g.edges), idx = order.indexOf(ek);
  let n = 0;
  const info = E.resolveTurn(g, () => (n++ === idx ? 0 : 0.9999));
  assert.deepStrictEqual(info.broken, [ek]);
  assert.strictEqual(g.leaves[ck], undefined);
  assert.strictEqual(info.removedLeaves, 1);
});

test('ヤドリギ：同じセルを選んだら抽選。自分の枝に接するセルや、他人の枝に接しないセルには置けない', () => {
  const g = newGame(3), geo = E.geometry(g.cols);
  const v0 = geo.trunks[2].verts[2];
  const ek = geo.verts[v0].edges.find(k => !geo.reserved.has(k) && geo.edges[k].cells.length === 2);
  const e = geo.edges[ek], to = e.a === v0 ? e.b : e.a;
  g.edges[ek] = { owner: 'c', from: v0, to, parent: null, l: 1, h: e.h, round: 0 };
  const ck = geo.edges[ek].cells[0];
  act(g, 'a', { type: 'addMistletoe', cell: ck });
  act(g, 'b', { type: 'addMistletoe', cell: ck });
  let n = 0;
  const info = E.resolveTurn(g, () => (n++ === 0 ? 0 : 0.9999));            // 抽選は先頭（a）が勝つ。折れは起きない
  assert.strictEqual(g.leaves[ck].owner, 'a');
  assert.deepStrictEqual(info.lost.map(l => [l.owner, l.t]), [['b', 'm']]);
  const far = Object.keys(geo.cells).find(k => !geo.cells[k].edges.includes(ek) && !g.leaves[k] && !geo.cells[k].edges.some(x => g.edges[x]));
  const r = E.apply(g, 'a', { type: 'addMistletoe', cell: far });
  assert.ok(!r.ok && /他の人の枝/.test(r.error), r.error);
});

test('ヤドリギ：2人戦では使えない。ヤドリギの葉も、宿主のボーナスの「下にある他人の葉」に数えられる（上限は設定できる）', () => {
  const g2 = newGame(2), geo = E.geometry(g2.cols);
  const v0 = geo.trunks[1].verts[2];
  const ek = geo.verts[v0].edges.find(k => !geo.reserved.has(k) && geo.edges[k].cells.length === 2);
  const e = geo.edges[ek], to = e.a === v0 ? e.b : e.a;
  g2.edges[ek] = { owner: 'b', from: v0, to, parent: null, l: 1, h: e.h, round: 0 };
  assert.deepStrictEqual(E.candidates(g2, 'a').mistle, []);
  assert.ok(!E.apply(g2, 'a', { type: 'addMistletoe', cell: geo.edges[ek].cells[0] }).ok);
  // 得点：宿主 a が一番上、下に b・c のヤドリギの葉が3枚（ほかの人の葉は他に無い）
  const col = n => E.scoreColumn([{ r: 9, owner: 'a' }, { r: 4, owner: 'b', mist: true }, { r: 3, owner: 'c', mist: true }, { r: 2, owner: 'd', mist: true }], n).map(v => Math.round(v * 1000) / 1000);
  const h = E.RULES.score.height, f = E.RULES.mistletoeFeedMax;
  E.RULES.score.height = 0;
  try {
    assert.strictEqual(col(3)[0], 1 + 3);                       // 初期値：ヤドリギの葉もふつうの葉と同じく数える（上限3）
    E.RULES.mistletoeFeedMax = { 3: 1, 4: 2, 5: 2 };
    assert.strictEqual(col(3)[0], 1 + 1);     // 3人戦：ヤドリギの葉は1枚まで
    assert.strictEqual(col(5)[0], 1 + 2);     // 5人戦：2枚まで
    E.RULES.mistletoeFeedMax = 0;
    assert.strictEqual(col(5)[0], 1);         // 0：数えない
    assert.strictEqual(E.scoreColumn([{ r: 9, owner: 'a' }, { r: 4, owner: 'b' }, { r: 3, owner: 'c', mist: true }], 3)[0], 1 + 1);   // ふつうの葉だけ数える
  } finally { E.RULES.score.height = h; E.RULES.mistletoeFeedMax = f; }
});

test('ヤドリギ：養分を吸う。宿主の枝が残っているあいだ毎ターン、宿主から drain 点を奪う。宿主の持ち点が足りなければ奪えない', () => {
  const g = newGame(3), geo = E.geometry(g.cols);
  const v0 = geo.trunks[1].verts[2];
  const ek = geo.verts[v0].edges.find(k => !geo.reserved.has(k) && geo.edges[k].cells.length === 2);
  const e = geo.edges[ek], to = e.a === v0 ? e.b : e.a;
  g.edges[ek] = { owner: 'b', from: v0, to, parent: null, l: 1, h: e.h, round: 0 };
  const ck = geo.edges[ek].cells[0];
  g.leaves[ck] = { owner: 'a', round: 0, host: ek };
  const drain = E.drainFor(3), h = E.RULES.score.height;
  E.RULES.score.height = 0;
  try {
    P(g, 'b').score = 10;
    const info = E.resolveTurn(g, NEVER);
    // a の葉：その列で自分だけの一番上 → 1点 + 吸った drain。b は持ち点 10 から drain を奪われる
    assert.ok(Math.abs(P(g, 'a').gain - (1 + drain)) < 1e-9, String(P(g, 'a').gain));
    assert.ok(Math.abs(P(g, 'b').gain + drain) < 1e-9);
    assert.ok(Math.abs(info.drained - drain) < 1e-9);
    P(g, 'b').score = 0; P(g, 'b').gain = 0;
    E.resolveTurn(g, NEVER);
    assert.ok(Math.abs(P(g, 'b').score) < 1e-9, '持ち点 0 のときは奪えない');
    // 宿主の枝がなくなったら、吸えない（葉も消える）
    delete g.edges[ek];
    const info3 = E.resolveTurn(g, NEVER);
    assert.strictEqual(info3.drained, 0);
  } finally { E.RULES.score.height = h; }
});
