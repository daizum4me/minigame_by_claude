/* 豆鉄砲 (gunlet) — rules engine
 * Board: 7x7 points, idx = y * 7 + x  (x: a..g, y: rank 1..7)
 * Player 0 = 先手 (bottom), player 1 = 後手 (top)
 */
(function (root) {
  'use strict';

  const N = 7;
  const MAX_PLY = 200; // 膠着対策: 200手で引き分け

  const DIRS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
    [1, 1], [1, -1], [-1, 1], [-1, -1],
  ];

  const TYPES = {
    general: { name: '将', short: '将', hp: 2 },
    archer:  { name: '弓兵', short: '弓', hp: 1 },
    gunner:  { name: '銃兵', short: '銃', hp: 1 },
    shield:  { name: '盾兵', short: '盾', hp: 2 },
  };

  const RANGE = {
    archer: { min: 2, max: 3, skip: 1 },
    gunner: { min: 1, max: 3, skip: 0 },
  };

  const idx = (x, y) => y * N + x;
  const xy = (i) => [i % N, Math.floor(i / N)];
  const inside = (x, y) => x >= 0 && x < N && y >= 0 && y < N;
  const label = (i) => { const [x, y] = xy(i); return 'abcdefg'[x] + (y + 1); };

  function newPiece(type, owner) {
    return { type, owner, hp: TYPES[type].hp, loaded: type === 'gunner' };
  }

  function initialState() {
    const cells = [];
    for (let i = 0; i < N * N; i++) cells.push({ piece: null, terrain: null });
    const setup = [
      ['archer', 0, 0], ['gunner', 2, 0], ['general', 3, 0], ['gunner', 4, 0], ['archer', 6, 0],
      ['shield', 2, 1], ['shield', 4, 1],
    ];
    for (const [type, x, y] of setup) {
      cells[idx(x, y)].piece = newPiece(type, 0);
      cells[idx(N - 1 - x, N - 1 - y)].piece = newPiece(type, 1);
    }
    return {
      cells,
      reserve: [{ wall: 2, tower: 1 }, { wall: 2, tower: 1 }],
      turn: 0,
      ply: 0,
      winner: null, // 0 | 1 | 'draw' | null
    };
  }

  function clone(s) {
    return {
      cells: s.cells.map((c) => ({
        piece: c.piece ? { ...c.piece } : null,
        terrain: c.terrain ? { ...c.terrain } : null,
      })),
      reserve: s.reserve.map((r) => ({ ...r })),
      turn: s.turn,
      ply: s.ply,
      winner: s.winner,
    };
  }

  const isWall = (c) => c.terrain && c.terrain.kind === 'wall';
  const isTower = (c) => c.terrain && c.terrain.kind === 'tower';
  const blocks = (c) => !!c.piece || isWall(c);
  const walkable = (c) => !c.piece && !isWall(c);

  function moveTargets(s, from) {
    const p = s.cells[from].piece;
    const [x, y] = xy(from);
    const out = [];
    const reach = p.type === 'shield' ? 2 : 1;
    for (const [dx, dy] of DIRS) {
      for (let d = 1; d <= reach; d++) {
        const nx = x + dx * d, ny = y + dy * d;
        if (!inside(nx, ny)) break;
        const c = s.cells[idx(nx, ny)];
        if (!walkable(c)) break;
        out.push(idx(nx, ny));
      }
    }
    return out;
  }

  function shotTargets(s, from) {
    const cell = s.cells[from];
    const p = cell.piece;
    const r = RANGE[p.type];
    if (!r) return [];
    if (p.type === 'gunner' && !p.loaded) return [];
    const max = r.max + (isTower(cell) ? 1 : 0);
    const [x, y] = xy(from);
    const out = [];
    for (const [dx, dy] of DIRS) {
      let over = 0;
      for (let d = 1; d <= max; d++) {
        const nx = x + dx * d, ny = y + dy * d;
        if (!inside(nx, ny)) break;
        const c = s.cells[idx(nx, ny)];
        const enemy = c.piece && c.piece.owner !== p.owner;
        const wallHit = isWall(c) && p.type === 'gunner';
        if (d >= r.min && (enemy || wallHit)) out.push(idx(nx, ny));
        if (blocks(c)) {
          over++;
          if (over > r.skip) break;
        }
      }
    }
    return out;
  }

  function meleeTargets(s, from) {
    const p = s.cells[from].piece;
    if (p.type !== 'general') return [];
    const [x, y] = xy(from);
    const out = [];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!inside(nx, ny)) continue;
      const c = s.cells[idx(nx, ny)];
      if (c.piece && c.piece.owner !== p.owner) out.push(idx(nx, ny));
    }
    return out;
  }

  function placeTargets(s) {
    const out = [];
    for (let i = 0; i < N * N; i++) {
      const c = s.cells[i];
      if (!c.piece && !c.terrain) out.push(i);
    }
    return out;
  }

  /** All actions available to a piece at `from`. */
  function pieceActions(s, from) {
    const p = s.cells[from].piece;
    if (!p || p.owner !== s.turn || s.winner !== null) return [];
    const acts = [];
    for (const to of moveTargets(s, from)) acts.push({ type: 'move', from, to });
    for (const to of shotTargets(s, from)) acts.push({ type: 'shoot', from, to });
    for (const to of meleeTargets(s, from)) acts.push({ type: 'melee', from, to });
    if (p.type === 'gunner' && !p.loaded) acts.push({ type: 'reload', from });
    return acts;
  }

  function legalActions(s) {
    if (s.winner !== null) return [];
    const acts = [];
    for (let i = 0; i < N * N; i++) {
      const p = s.cells[i].piece;
      if (p && p.owner === s.turn) acts.push(...pieceActions(s, i));
    }
    const res = s.reserve[s.turn];
    if (res.wall > 0 || res.tower > 0) {
      for (const at of placeTargets(s)) {
        if (res.wall > 0) acts.push({ type: 'place', kind: 'wall', at });
        if (res.tower > 0) acts.push({ type: 'place', kind: 'tower', at });
      }
    }
    return acts;
  }

  /** Damage whatever stands on `at`. Returns description of the result. */
  function hit(s, at) {
    const c = s.cells[at];
    if (c.piece) {
      c.piece.hp -= 1;
      if (c.piece.hp <= 0) {
        const dead = c.piece;
        c.piece = null;
        return { kind: 'piece', killed: true, victim: dead };
      }
      return { kind: 'piece', killed: false, victim: c.piece };
    }
    if (isWall(c)) {
      c.terrain.hp -= 1;
      if (c.terrain.hp <= 0) { c.terrain = null; return { kind: 'wall', killed: true }; }
      return { kind: 'wall', killed: false };
    }
    return { kind: 'none' };
  }

  /** Apply an action; returns { state, event }. Does not mutate the input. */
  function apply(s0, a) {
    const s = clone(s0);
    const me = s.turn;
    const ev = { action: a, player: me, result: null };

    if (a.type === 'move') {
      s.cells[a.to].piece = s.cells[a.from].piece;
      s.cells[a.from].piece = null;
    } else if (a.type === 'shoot') {
      const shooter = s.cells[a.from].piece;
      ev.result = hit(s, a.to);
      if (shooter.type === 'gunner') shooter.loaded = false;
    } else if (a.type === 'melee') {
      ev.result = hit(s, a.to);
      if (ev.result.killed) {
        s.cells[a.to].piece = s.cells[a.from].piece;
        s.cells[a.from].piece = null;
      }
    } else if (a.type === 'reload') {
      s.cells[a.from].piece.loaded = true;
    } else if (a.type === 'place') {
      s.cells[a.at].terrain = a.kind === 'wall' ? { kind: 'wall', hp: 2 } : { kind: 'tower' };
      s.reserve[me][a.kind] -= 1;
    }

    if (ev.result && ev.result.kind === 'piece' && ev.result.killed && ev.result.victim.type === 'general') {
      s.winner = me;
    }

    s.ply += 1;
    s.turn = 1 - me;
    if (s.winner === null && s.ply >= MAX_PLY) s.winner = 'draw';
    // 手が無い側はパス、両者とも無ければ引き分け
    if (s.winner === null && legalActions(s).length === 0) {
      s.turn = me;
      if (legalActions(s).length === 0) s.winner = 'draw';
      ev.passed = true;
    }
    return { state: s, event: ev };
  }

  function notation(s, a) {
    if (a.type === 'place') return (a.kind === 'wall' ? '壁' : '塔') + ' ' + label(a.at);
    const p = s.cells[a.from].piece;
    const name = TYPES[p.type].short;
    if (a.type === 'move') return `${name} ${label(a.from)}–${label(a.to)}`;
    if (a.type === 'reload') return `${name} ${label(a.from)} 装填`;
    return `${name} ${label(a.from)}×${label(a.to)}`;
  }

  function findGeneral(s, owner) {
    for (let i = 0; i < N * N; i++) {
      const p = s.cells[i].piece;
      if (p && p.type === 'general' && p.owner === owner) return i;
    }
    return -1;
  }

  const api = {
    N, MAX_PLY, TYPES, DIRS,
    idx, xy, label, inside,
    initialState, clone,
    moveTargets, shotTargets, meleeTargets, placeTargets,
    pieceActions, legalActions, apply, notation, findGeneral,
    isWall, isTower,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Gunlet = api;
})(typeof self !== 'undefined' ? self : this);
