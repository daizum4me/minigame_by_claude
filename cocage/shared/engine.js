/*
 * Cocage — ルール判定
 * 幹から枝と葉を伸ばし、各列の「一番上の葉」で得点を競う2〜5人用のヘックス盤ゲーム。全36ターン。
 * 全員が同時に（最大3回の行動を）決め、ターンの終わりにまとめて解決する：
 *   行動（同じ辺・セルを選んだら抽選）→ 幹の成長 → 枝の折れ判定 → 光合成（得点）
 * 状態（state）はただのオブジェクト（JSON にそのまま変換できる）。ホストのブラウザでもテスト（Node.js）でも同じものを使う。
 *
 * ---- 盤面の座標 ----
 * 盤面は 18 行 × (6×人数) 列のフラットトップ（頂点が左右）のヘックスで、左右がつながった横ループ。奇数列は半セル下がる。
 * セルのキーは "列,行"（行は下から 0〜17）。
 * 頂点・辺は、六角形の外接円の半径 S の半分を 1 とする整数座標 (x, y) で表す：
 *   セル (c, r) の中心は x = 3c、y = 偶数列なら 2r+1、奇数列なら 2r（y は上向きに 1 = 半セルの高さの半分… つまり √3/2·S の単位）。
 *   角は 中心から (±2, 0)、(±1, ±1)。
 * 幹は、列 2+6i と その右隣の列の境界を、下から上へジグザグに伸びる（1行 = 2辺。全部で 36 辺）。最初から1辺伸びていて、毎ターン1辺ずつ伸びる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CocageEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ルールの数値はすべてここ
  const RULES = {
    minPlayers: 2,
    maxPlayers: 5,
    rows: 18,
    colsPerPlayer: 6,
    trunkCol0: 2,            // 幹の位置：列 2+6i
    trunkStep: 6,
    turns: 36,
    ap: 3,                   // 行動力：毎ターン全員3（繰越しなし）
    turnSeconds: 90,
    // 枝の折れる確率（毎ターン・辺ごと）p = base + height×h + load×w
    //   w：その辺が支えている枝の数（その辺と、その先の枝すべて）。根本ほど重さがかかって折れやすい
    break: { base: 0.0005, height: 0.0003, load: 0.0015 },
    // 得点：一番上の葉は 1 + min(3, 下にある他人の葉の数) + 0.1 × 行番号。一番上でない葉は、上に他人の葉があれば 0.3
    score: { top: 1, bonusMax: 3, covered: 0.3, height: 0.1 },   // height：一番上の葉に 0.1 × 行番号（1〜18）を足す
    scarTurns: 3,            // 傷あと：枝が折れた根元の頂点からは、その持ち主は次の3ターン枝を伸ばせない
    trunkStart: 1,           // 最初から伸びている幹の辺の数（そこから毎ターン1辺ずつ伸びる）
    leafOnTrunk: false,      // 幹に接するだけのセルに葉を置けるか（仕様では「自分の枝に接するセル」なので false）
  };
  const AP = RULES.ap;

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ---------- 盤面の形（人数＝列数ごとに1度だけ作る） ----------

  const geoCache = {};

  function edgeKeyOf(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  function geometry(cols) {
    if (geoCache[cols]) return geoCache[cols];
    const rows = RULES.rows, W = 3 * cols;
    const nx = x => ((x % W) + W) % W;
    const vk = (x, y) => nx(x) + ',' + y;
    const verts = {};       // 頂点キー → { x, y, edges: [辺キー] }
    const edges = {};       // 辺キー → { k, a, b, h, cells: [セルキー] }
    const cells = {};       // セルキー → { c, r, x, y, verts: [6頂点], edges: [6辺] }
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        const y0 = c % 2 === 0 ? 2 * r + 1 : 2 * r, x0 = 3 * c;
        const pts = [[x0 + 2, y0], [x0 + 1, y0 + 1], [x0 - 1, y0 + 1], [x0 - 2, y0], [x0 - 1, y0 - 1], [x0 + 1, y0 - 1]];
        const keys = pts.map(([x, y]) => vk(x, y));
        const ck = c + ',' + r;
        const cell = { c, r, x: x0, y: y0, verts: keys, edges: [] };
        cells[ck] = cell;
        keys.forEach((k, i) => {
          if (!verts[k]) verts[k] = { x: nx(pts[i][0]), y: pts[i][1], edges: [] };
        });
        for (let i = 0; i < 6; i++) {
          const a = keys[i], b = keys[(i + 1) % 6], ek = edgeKeyOf(a, b);
          if (!edges[ek]) {
            const ymid = (verts[a].y + verts[b].y) / 2;
            edges[ek] = { k: ek, a, b, h: clamp(Math.floor(ymid / 2) + 1, 1, rows), cells: [] };
            verts[a].edges.push(ek); verts[b].edges.push(ek);
          }
          edges[ek].cells.push(ck);
          cell.edges.push(ek);
        }
      }
    }
    // 幹：列 2+6i と右隣の列のあいだ。下（根）から上へ 37 頂点・36 辺
    const trunks = [];
    const reserved = new Set();
    for (let i = 0; i < cols / RULES.colsPerPlayer; i++) {
      const c = RULES.trunkCol0 + RULES.trunkStep * i;
      const tv = [];
      for (let k = 0; k <= rows * 2; k++) tv.push(k % 2 === 0 ? vk(3 * c + 1, k) : vk(3 * c + 2, k));
      const te = [null];
      for (let k = 1; k <= rows * 2; k++) {
        const ek = edgeKeyOf(tv[k - 1], tv[k]);
        te.push(ek);
        reserved.add(ek);
      }
      trunks.push({ col: c, verts: tv, edges: te });
    }
    const geo = { cols, rows, W, verts, edges, cells, trunks, reserved };
    geoCache[cols] = geo;
    return geo;
  }

  // ---------- 折れる確率 ----------

  // h：辺の高さ（行番号 1〜18）、w：その辺が支えている枝の数（その辺を含む。先端の辺は 1）
  function breakProb(h, w) {
    const b = RULES.break;
    return b.base + b.height * h + b.load * w;
  }

  function breakParts(h, w) {
    const b = RULES.break;
    return { base: b.base, height: b.height * h, load: b.load * w, w, p: breakProb(h, w) };
  }

  // 辺キー → その辺が支えている枝の数（その辺と子孫の辺の数）
  function loads(state) {
    const kids = {}, out = {};
    for (const [k, e] of Object.entries(state.edges)) if (e.parent) (kids[e.parent] = kids[e.parent] || []).push(k);
    const count = k => {
      if (out[k]) return out[k];
      let n = 1;
      for (const c of kids[k] || []) n += count(c);
      return (out[k] = n);
    };
    for (const k of Object.keys(state.edges)) count(k);
    return out;
  }

  // ---------- ゲームの作成 ----------

  function createGame(players, rng, opts) {
    opts = opts || {};
    if (players.length < RULES.minPlayers || players.length > RULES.maxPlayers) throw new Error('人数が正しくありません');
    const turns = opts.turns || RULES.turns;
    const cols = RULES.colsPerPlayer * players.length;
    geometry(cols);
    return {
      cols,
      rows: RULES.rows,
      turns,
      round: 0,               // 済んだターンの数
      over: false,
      winners: [],
      players: players.map((p, i) => ({
        id: p.id, name: p.name, color: i, trunk: i, trunkLen: RULES.trunkStart,
        score: 0, gain: 0, history: [0],
        plan: [],             // このターンの行動：{ t: 'b', e: 辺キー } / { t: 'l', c: セルキー }、done：確定ずみ
        finished: false,      // このターンの行動を確定しおえた
      })),
      edges: {},              // 辺キー → { owner, from, to, parent, l, h, round }（幹は含まない）
      leaves: {},             // セルキー → { owner, round }
      top: {},                // 列 → 一番上の葉の持ち主（入れ替わりを数えるため）
      scars: {},              // 頂点キー → { owner, until }：傷あと。state.round < until のあいだ、持ち主はそこから枝を伸ばせない
      lastTurn: null,         // 直前のターンに起きたこと
    };
  }

  const playerById = (state, id) => state.players.find(p => p.id === id);

  // ---------- 自分の幹・枝のつながり ----------

  // v：頂点 → { l: そこまでの長さ, edge: そこに至る枝（幹なら null） }、edges：自分の枝の辺キー
  function ownNet(state, geo, p) {
    const v = new Map(), edges = new Set(), owner = p.id;
    const tr = geo.trunks[p.trunk];
    for (let k = 0; k <= p.trunkLen; k++) v.set(tr.verts[k], { l: 0, edge: null });
    for (const [ek, e] of Object.entries(state.edges)) {
      if (e.owner !== p.id) continue;
      edges.add(ek);
      if (!v.has(e.to)) v.set(e.to, { l: e.l, edge: ek });
    }
    return { v, edges, owner };
  }

  // 傷あとで、あと何ターン枝を伸ばせないか（0 なら伸ばせる）
  function scarLeft(state, vk, owner) {
    const sc = state.scars && state.scars[vk];
    return sc && sc.owner === owner && state.round < sc.until ? sc.until - state.round : 0;
  }

  // 枝を置けるか。置けるなら { from, to, l, parent, h }、だめなら理由の文字列
  function checkBranch(geo, state, net, ek, pendingEdges) {
    const e = geo.edges[ek];
    if (!e) return 'そこに辺はありません';
    if (geo.reserved.has(ek)) return '幹が通る辺には枝を置けません';
    if (state.edges[ek] || pendingEdges.has(ek)) return 'その辺にはもう枝があります';
    const ia = net.v.has(e.a), ib = net.v.has(e.b);
    if (!ia && !ib) return '自分の幹か枝の頂点につながる辺を選んでください';
    if (ia && ib) return '両端がもう自分の幹か枝につながっています';
    const from = ia ? e.a : e.b, to = ia ? e.b : e.a, at = net.v.get(from);
    const scar = scarLeft(state, from, net.owner);
    if (scar) return `折れたあと（傷あと）なので、ここからはあと${scar}ターン枝を伸ばせません`;
    return { from, to, l: at.l + 1, parent: at.edge, h: e.h };
  }

  // 葉の土台が残っているか：自分の枝（gone に入っていないもの）か、（許されていれば）自分の幹
  function leafAnchored(state, geo, ck, owner, gone) {
    const cell = geo.cells[ck];
    if (cell.edges.some(k => state.edges[k] && state.edges[k].owner === owner && !(gone && gone.has(k)))) return true;
    if (!RULES.leafOnTrunk) return false;
    const p = playerById(state, owner), tr = geo.trunks[p.trunk];
    return cell.edges.some(k => { const i = tr.edges.indexOf(k); return i > 0 && i <= p.trunkLen; });
  }

  // 葉を置けるか。だめなら理由の文字列、置けるなら null
  function checkLeaf(geo, state, net, ck, pendingLeaves, p) {
    const c = geo.cells[ck];
    if (!c) return 'そこにセルはありません';
    if (state.leaves[ck] || pendingLeaves.has(ck)) return 'そのセルにはもう葉があります';
    let ok = c.edges.some(ek => net.edges.has(ek));
    if (!ok && RULES.leafOnTrunk) {
      const tr = geo.trunks[p.trunk];
      ok = c.edges.some(ek => { const k = tr.edges.indexOf(ek); return k > 0 && k <= p.trunkLen; });
    }
    return ok ? null : '自分の枝に接するセルを選んでください';
  }

  // 今の計画を順に置いたと仮定したときの状態。plan のどれかがだめなら error と index
  function project(state, id, plan) {
    const geo = geometry(state.cols), p = playerById(state, id);
    const net = ownNet(state, geo, p);
    const pendingEdges = new Set(), pendingLeaves = new Set();
    for (let i = 0; i < plan.length; i++) {
      const it = plan[i];
      if (it.t === 'b') {
        const r = checkBranch(geo, state, net, it.e, pendingEdges);
        if (typeof r === 'string') return { error: r, index: i };
        pendingEdges.add(it.e); net.edges.add(it.e);
        if (!net.v.has(r.to)) net.v.set(r.to, { l: r.l, edge: it.e });
      } else {
        const r = checkLeaf(geo, state, net, it.c, pendingLeaves, p);
        if (r) return { error: r, index: i };
        pendingLeaves.add(it.c);
      }
    }
    return { geo, net, pendingEdges, pendingLeaves };
  }

  // 次に置ける辺・セル（計画がいっぱいなら空）
  function candidates(state, id) {
    const p = playerById(state, id);
    if (!p || state.over || p.plan.length >= AP) return { edges: [], cells: [] };
    const pr = project(state, id, p.plan);
    if (pr.error) return { edges: [], cells: [] };
    const { geo, net, pendingEdges, pendingLeaves } = pr;
    const edges = [], cells = new Set();
    for (const v of net.v.keys()) {
      for (const ek of geo.verts[v].edges) {
        if (typeof checkBranch(geo, state, net, ek, pendingEdges) !== 'string') edges.push(ek);
      }
    }
    const bases = [...net.edges];
    if (RULES.leafOnTrunk) for (let k = 1; k <= p.trunkLen; k++) bases.push(geo.trunks[p.trunk].edges[k]);
    for (const ek of bases) {
      for (const ck of geo.edges[ek].cells) if (!checkLeaf(geo, state, net, ck, pendingLeaves, p)) cells.add(ck);
    }
    return { edges: [...new Set(edges)], cells: [...cells] };
  }

  // ---------- 行動 ----------

  function fail(error) { return { ok: false, error }; }

  /*
   * action:
   *   { type: 'addBranch', edge }  枝を計画に加える（行動力1）
   *   { type: 'addLeaf', cell }    葉を計画に加える（行動力1）
   *   { type: 'remove', index }    計画から外す
   *   { type: 'confirm', index, on }  1つだけ確定／取り消し
   *   { type: 'finish', on }       すべて確定して待つ／取り消す
   * 計画は、ターンの終わりにまとめて解決される。確定は、全員が確定するまで取り消せる。
   */
  function apply(state, id, action) {
    if (!action || typeof action.type !== 'string') return fail('不明な行動です');
    if (state.over) return fail('ゲームは終わっています');
    const p = playerById(state, id);
    if (!p) return fail('参加していません');
    if (action.type === 'addBranch' || action.type === 'addLeaf') {
      if (p.plan.length >= AP) return fail(`行動力は ${AP} までです`);
      const it = action.type === 'addBranch' ? { t: 'b', e: String(action.edge) } : { t: 'l', c: String(action.cell) };
      const pr = project(state, id, p.plan.concat([it]));
      if (pr.error) return fail(pr.error);
      p.plan.push(it);
      p.finished = false;
      return { ok: true };
    }
    if (action.type === 'remove') {
      const i = Number(action.index);
      if (!Number.isInteger(i) || i < 0 || i >= p.plan.length) return fail('その行動はありません');
      p.plan.splice(i, 1);
      // 枝を外すと、それにつながる行動がだめになることがあるので、だめになった行動も外す
      while (true) {
        const pr = project(state, id, p.plan);
        if (!pr.error) break;
        p.plan.splice(pr.index, 1);
      }
      p.finished = false;
      return { ok: true };
    }
    if (action.type === 'confirm') {
      const it = p.plan[Number(action.index)];
      if (!it) return fail('その行動はありません');
      it.done = action.on === undefined ? !it.done : !!action.on;
      p.finished = p.plan.length >= AP && p.plan.every(x => x.done);
      return { ok: true };
    }
    if (action.type === 'finish') {
      const on = action.on === undefined ? !p.finished : !!action.on;
      for (const it of p.plan) it.done = on;
      p.finished = on;
      return { ok: true };
    }
    return fail('不明な行動です');
  }

  // ---------- 得点 ----------

  // 1列ぶん：list は { r, owner } の配列。それぞれの得点を、同じ並びで返す。
  //   一番上の葉：1 + min(3, 下にある他人の葉の数)
  //   ほかの葉：その人の、その列で一番上の葉（上に他人の葉がある）だけが 0.3。同じ人の2枚目以降は 0
  //   例（上から）：A=2・B=0.3・A=0・A=0・A=0
  function scoreColumn(list) {
    const order = list.map((x, i) => i).sort((a, b) => list[b].r - list[a].r);
    const pts = list.map(() => 0);
    const seen = new Set();
    order.forEach((idx, n) => {
      const owner = list[idx].owner;
      if (n === 0) {
        const below = order.slice(1).filter(j => list[j].owner !== owner).length;
        pts[idx] = RULES.score.top + Math.min(RULES.score.bonusMax, below) + RULES.score.height * (list[idx].r + 1);
      } else if (!seen.has(owner)) {
        pts[idx] = RULES.score.covered;
      }
      seen.add(owner);
    });
    return pts;
  }

  // 全セルの得点（セルキー → 点）と、列ごとの一番上の葉（列 → { cell, owner }）
  function scoreBoard(state) {
    const byCol = {};
    for (const [ck, lf] of Object.entries(state.leaves)) {
      const [c, r] = ck.split(',').map(Number);
      (byCol[c] = byCol[c] || []).push({ ck, r, owner: lf.owner });
    }
    const points = {}, tops = {};
    for (const [c, list] of Object.entries(byCol)) {
      const pts = scoreColumn(list);
      let top = 0;
      list.forEach((x, i) => { points[x.ck] = pts[i]; if (x.r > list[top].r) top = i; });
      tops[c] = { cell: list[top].ck, owner: list[top].owner };
    }
    return { points, tops };
  }

  // ---------- 折れやすさ（ツールキット用） ----------

  // 辺とそこから先（子孫）の辺のキー
  function subtree(state, ek) {
    const kids = {};
    for (const [k, e] of Object.entries(state.edges)) if (e.parent) (kids[e.parent] = kids[e.parent] || []).push(k);
    const out = [], stack = [ek];
    while (stack.length) {
      const k = stack.pop();
      out.push(k);
      for (const c of kids[k] || []) stack.push(c);
    }
    return out;
  }

  // その辺をたどってきた辺（その辺まで）
  function pathTo(state, ek) {
    const out = [];
    for (let k = ek; k && state.edges[k]; k = state.edges[k].parent) out.push(k);
    return out;
  }

  // 枝の辺の折れやすさ：確率・内訳・10ターン残る確率（その辺まですべて）・折れると失うもの
  function edgeStats(state, ek, horizon) {
    const e = state.edges[ek];
    if (!e) return null;
    const geo = geometry(state.cols);
    const w = loads(state);
    const parts = breakParts(e.h, w[ek]);
    let survive = 1;
    for (const k of pathTo(state, ek)) survive *= Math.pow(1 - breakProb(state.edges[k].h, w[k]), horizon || 10);
    const lost = subtree(state, ek), gone = new Set(lost);
    let lostLeaves = 0;
    for (const [ck, lf] of Object.entries(state.leaves)) {
      if (!leafAnchored(state, geo, ck, lf.owner, gone)) lostLeaves++;
    }
    return { edge: e, parts, p: parts.p, survive, lostEdges: lost.length, lostLeaves, expectedLoss: parts.p * (lost.length + lostLeaves) };
  }

  // ---------- ターンの解決 ----------

  function resolveTurn(state, rng) {
    if (state.over) return null;
    rng = rng || Math.random;
    const geo = geometry(state.cols);
    const turn = state.round + 1;
    const info = {
      turn, placedBranches: 0, placedLeaves: 0, contested: 0, lost: [],
      broken: [], removed: [], removedLeaves: 0, removedLeafList: [], topChanges: 0, gains: {},
    };

    // 1. 行動：同じ辺・セルを選んだ人が複数いたら、等確率の抽選で1人だけが成功
    const acts = [];
    for (const p of state.players) {
      p.plan.forEach((it, idx) => acts.push({ p, idx, it, key: it.t === 'b' ? 'b:' + it.e : 'l:' + it.c }));
    }
    const groups = {};
    for (const a of acts) (groups[a.key] = groups[a.key] || []).push(a);
    const winners = new Set();
    for (const list of Object.values(groups)) {
      if (list.length > 1) info.contested++;
      winners.add(list[Math.floor(rng() * list.length)]);
    }
    for (const p of state.players) {
      const net = ownNet(state, geo, p);
      const none = new Set();
      for (const a of acts.filter(x => x.p === p)) {
        let ok = winners.has(a);
        if (ok && a.it.t === 'b') {
          const r = checkBranch(geo, state, net, a.it.e, none);
          if (typeof r === 'string') ok = false;
          else {
            state.edges[a.it.e] = { owner: p.id, from: r.from, to: r.to, parent: r.parent, l: r.l, h: r.h, round: turn };
            net.edges.add(a.it.e);
            if (!net.v.has(r.to)) net.v.set(r.to, { l: r.l, edge: a.it.e });
            info.placedBranches++;
          }
        } else if (ok) {
          if (checkLeaf(geo, state, net, a.it.c, none, p)) ok = false;
          else { state.leaves[a.it.c] = { owner: p.id, round: turn }; info.placedLeaves++; }
        }
        if (!ok) info.lost.push({ owner: p.id, t: a.it.t, key: a.it.t === 'b' ? a.it.e : a.it.c });
      }
    }

    // 2. 幹の成長
    for (const p of state.players) if (p.trunkLen < RULES.rows * 2) p.trunkLen++;

    // 3. 折れ判定：すべての枝の辺を、1本ずつ独立に抽選。折れたら、その辺とその先の枝・葉が消える
    const brokenNow = [], w = loads(state);
    for (const [ek, e] of Object.entries(state.edges)) if (rng() < breakProb(e.h, w[ek])) brokenNow.push(ek);
    const goneEdges = new Set();
    for (const ek of brokenNow) for (const k of subtree(state, ek)) goneEdges.add(k);
    const brokenMeta = brokenNow.map(ek => ({ owner: state.edges[ek].owner, from: state.edges[ek].from, parent: state.edges[ek].parent }));
    for (const k of goneEdges) {
      const e = state.edges[k];
      info.removed.push({ key: k, owner: e.owner, l: e.l, primary: brokenNow.includes(k) });
      delete state.edges[k];
    }
    info.broken = brokenNow;
    // 傷あと：折れた辺の根元の頂点（まだ自分の幹・枝につながっている側）。次の scarTurns ターン、持ち主はそこから枝を伸ばせない
    if (!state.scars) state.scars = {};
    for (const vk of Object.keys(state.scars)) if (state.scars[vk].until <= turn) delete state.scars[vk];
    info.scars = [];
    if (RULES.scarTurns > 0) {
      for (const e of brokenMeta) {
        if (e.parent && goneEdges.has(e.parent)) continue;   // もっと根本で折れた枝の先は数えない
        state.scars[e.from] = { owner: e.owner, until: turn + RULES.scarTurns };
        info.scars.push({ vert: e.from, owner: e.owner });
      }
    }
    for (const [ck, lf] of Object.entries(state.leaves)) {
      if (!leafAnchored(state, geo, ck, lf.owner)) { info.removedLeafList.push({ cell: ck, owner: lf.owner }); delete state.leaves[ck]; info.removedLeaves++; }
    }

    // 4. 光合成：列ごとに得点
    const { points, tops } = scoreBoard(state);
    for (const p of state.players) p.gain = 0;
    for (const [ck, pt] of Object.entries(points)) {
      const p = playerById(state, state.leaves[ck].owner);
      p.gain += pt;
    }
    for (const p of state.players) {
      p.score += p.gain;
      p.history.push(p.score);
      info.gains[p.id] = p.gain;
    }
    const nextTop = {};
    for (const [c, t] of Object.entries(tops)) {
      nextTop[c] = t.owner;
      if (state.top[c] && state.top[c] !== t.owner) info.topChanges++;
    }
    state.top = nextTop;

    state.round = turn;
    state.lastTurn = info;
    for (const p of state.players) { p.plan = []; p.finished = false; }
    if (state.round >= state.turns) {
      state.over = true;
      const best = Math.max(...state.players.map(p => p.score));
      state.winners = state.players.filter(p => p.score >= best - 1e-9).map(p => p.id);
    }
    return info;
  }

  const allFinished = (state, skip) => state.players.every(p => p.finished || (skip && skip(p.id)));

  return {
    RULES, geometry, breakProb, breakParts, loads, createGame, apply, project, candidates,
    resolveTurn, scoreColumn, scoreBoard, edgeStats, subtree, pathTo, ownNet, allFinished,
    playerById, edgeKeyOf,
  };
});
