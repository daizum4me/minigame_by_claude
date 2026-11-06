/*
 * Snowfield — マップの描画と操作（canvas）
 * 無限のマップを、ズームと移動ができるカメラで描く。駒のドラッグ移動・お絵かきもここで受ける。
 * 状態の更新は行わず、操作の結果は create() に渡されたコールバックで知らせる。
 */
(function () {
  'use strict';

  const E = window.SnowEngine;
  const T = 52;                       // 1マスの大きさ（ワールド座標）
  const ENT = 20;                     // 資源・動物・苗の大きさ
  const Z_MIN = 0.35, Z_MAX = 2.4;

  // ---------- アイコン（24×24 の線画） ----------
  const C = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
  const EL = (cx, cy, rx, ry) => `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`;
  const RC = (x, y, w, h) => `M${x} ${y}h${w}v${h}h${-w}z`;
  const ICONS = {
    fire: ['M12 3c1 3.5 5 5.5 5 10a5 5 0 0 1-10 0c0-2.2 1-3.6 2.4-5 .2 1.8 1 2.6 2 2.6C11.4 8.6 11 6 12 3z'],
    igloo: ['M3 19a9 9 0 0 1 18 0z', 'M10 19v-3a2 2 0 0 1 4 0v3'],
    storage: ['M3 10l9-6 9 6v10H3z', 'M9 20v-6h6v6'],
    tower: ['M8 21l2-12h4l2 12', 'M7 9h10l-1-4H8z', 'M9 15h6'],
    workshop: ['M3 15h18v3H3z', 'M6 18v3M18 18v3', 'M8 15V9l4-3 4 3v6', 'M11 11h2'],     // 作業台
    fur: ['M5 6c3-2 11-2 14 0l2 5-3 2v6l-3-1-3 2-3-2-3 1v-6l-3-2z'],
    steak: ['M5 12c0-4 4-7 9-7a5 5 0 0 1 5 5c0 5-5 9-10 8-2-.5-4-2-4-6z', C(13, 11, 2)],
    soup: ['M3 12h18a9 9 0 0 1-18 0z', 'M9 8c0-2 2-2 2-4M14 8c0-2 2-2 2-4'],
    coat: ['M8 4L3 8l2 4 3-1v9h8v-9l3 1 2-4-5-4-2 2h-4z'],
    axe: ['M4 20L14 9', 'M13 4l7 3-3 4-6-2z'],
    pick: ['M4 9c4-4 12-4 16 0', 'M12 6v14'],
    shovel: ['M12 3v9', 'M8 12h8l-1 6a3 3 0 0 1-6 0z'],
    spear: ['M5 20L18 7', 'M13 4h7v7z'],
    bow: ['M7 3c9 3 9 15 0 18', 'M7 3v18', 'M4 12h14M15 9l3 3-3 3'],
    firewood: [RC(3, 6, 18, 5), RC(3, 13, 18, 5), 'M6 8.5h5M6 15.5h5'],
    // ルール説明などで使う絵
    road: ['M4 20L9 4M20 20L15 4', 'M12 5v3M12 11v3M12 17v3'],
    bridge: ['M3 15h18', 'M5 15v4M19 15v4', 'M3 15c3-8 15-8 18 0'],
    grilled: ['M3 12c3-5 9-6 13-2l5-3v10l-5-3c-4 4-10 3-13-2z', 'M7 9l4 6M11 8l4 6'],
    sun: [C(12, 12, 4), 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1'],
    blizzard: ['M3 8h10a3 3 0 1 0-3-3', 'M3 12h14a3 3 0 1 1-3 3', 'M3 16h7'],
    rain: ['M6 15a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.2A4 4 0 0 1 17 15H6z', 'M8 18l-1 3M12 18l-1 3M16 18l-1 3'],
    storm: ['M6 14a4 4 0 0 1 0-8 5 5 0 0 1 9.6-1.2A4 4 0 0 1 17 14H6z', 'M12 13l-2 4h4l-2 5'],
    temp: ['M10 4a2 2 0 0 1 4 0v9.5a4 4 0 1 1-4 0z', 'M12 9v8'],
    food: ['M3 11h18a9 9 0 0 1-18 0z', 'M8 7c0-2 2-2 2-4M14 7c0-2 2-2 2-4'],
    bolt: ['M13 2L5 14h6l-1 8 8-12h-6z'],
    move: ['M4 12h16M16 8l4 4-4 4M8 8l-4 4 4 4'],
    hand: ['M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V10M14 10V6a1.5 1.5 0 0 1 3 0v6c0 5-2.5 8-6 8-2.5 0-4-1-6-4l-1-2a1.5 1.5 0 0 1 2.4-1.7L8 14'],
    sword: ['M14 4l6-1-1 6-9 9-5-5z', 'M7 15l-3 5M10 18l-3 3'],
    hammer: ['M13 5l6 6-3 3-6-6z', 'M11 9L4 16l4 4 7-7'],
    wrench: ['M15 4a4 4 0 0 0-4 5.5L4 16.5l3.5 3.5 7-7A4 4 0 0 0 20 9l-3 3-3-1-1-3z'],
    clock: [C(12, 12, 9), 'M12 7v5l3 2'],
    check: ['M4 4h16v16H4z', 'M8 12l3 3 5-6'],
    people: [C(9, 8, 3), 'M3 20a6 6 0 0 1 12 0', C(17, 9, 2.5), 'M16 20a5 5 0 0 1 5.5-4.8'],
    pencil: ['M4 20l1-4L16 5l3 3L8 19z', 'M14 7l3 3'],
    flag: ['M6 3v18', 'M6 4h11l-2 4 2 4H6'],
    eye: ['M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z', C(12, 12, 3)],
    tree: ['M12 3l6 9h-3l4 6H5l4-6H6z', 'M12 18v3'],
    stone: ['M4 18l3-9 6-4 6 6 2 7z'],
    veg: ['M12 21c-4-3-5-8-2-12 3 1 5 3 5 6 0 2-1 4-3 6z', 'M10 9c0-3 2-5 4-6'],
    animal: [EL(11, 15, 6, 4.5), C(17, 9, 2.6), 'M16 6.5l1-3M18.5 7l2-2'],
    fish: ['M3 12c3-5 9-6 13-2l5-3v10l-5-3c-4 4-10 3-13-2z', 'M8 11.5h.01'],
    rod: ['M4 20L16 5', 'M16 5c4 0 5 5 3 9', 'M19 14v3'],
    plant: ['M12 21v-9', 'M12 12c0-4-3-6-7-6 0 4 3 6 7 6z', 'M12 14c0-3 2-5 6-5 0 3-2 5-6 5z'],
    wood: [RC(3, 8, 18, 9), EL(18, 12.5, 1.6, 2.4), 'M7 10.5h6'],
    stoneItem: ['M4 9l8-4 8 4v7l-8 4-8-4z', 'M4 9l8 4 8-4M12 13v7'],
    meat: ['M5 14c0-5 4-9 9-9a5 5 0 0 1 5 5c0 5-4 9-9 9-3 0-5-2-5-5z', 'M8.5 15.5L4 20M4 20l-1.5-.5M4 20l.5-1.5'],
    snow: ['M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9', 'M9.5 4.8L12 6.5l2.5-1.7M9.5 19.2L12 17.5l2.5 1.7'],
    sapling: ['M12 21v-9', 'M12 12l-4-3M12 15l4-3', C(8, 7.5, 2.5), C(16, 9, 2.5), C(12, 5, 2.5)],
  };
  ICONS.vegItem = ICONS.veg;
  const ITEM_ICON = { fur: 'fur', steak: 'steak', soup: 'soup', wood: 'wood', firewood: 'firewood', stone: 'stoneItem', veg: 'veg', meat: 'meat', fish: 'fish', grilled: 'grilled', snow: 'snow', sapling: 'sapling' };
  const P2D = {};
  function svgIcon(name, size) {
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name].map(d => `<path d="${d}"/>`).join('')}</svg>`;
  }
  function icon(ctx, name, cx, cy, size, color) {
    const list = P2D[name] || (P2D[name] = ICONS[name].map(d => new Path2D(d)));
    ctx.save();
    ctx.translate(cx - size / 2, cy - size / 2);
    ctx.scale(size / 24, size / 24);
    ctx.lineWidth = 2.6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = color;
    for (const p of list) ctx.stroke(p);
    ctx.restore();
  }

  // ---------- 配色（添付デザインのライト／ダーク） ----------
  const THEMES = {
    light: {
      road: '#c3cfd8', roadBd: '#8497a8', bridge: '#d9b98a', bridgeBd: '#8a6a3c', hpTrack: 'rgba(36,50,63,.16)', hpOk: '#3c8f66', hpLow: '#c0463b', penA: '#2d5b88', penB: '#8a97a3',
      temp: '#4a90c8', tempLow: '#c0463b', food: '#e0a030', foodLow: '#c0463b', redFg: '#a8312a', ok: '#2f9a6a', ng: '#c0463b',
      bg: '#e9eff4', river: '#bcd9ee', tile: '#f8fafc', reach: '#e8f1f7', grid: '#dbe5ed', accent: '#2f6fb5', text: '#24323f', panel: '#ffffff',
      card: { fire: ['#fff1e4', '#e9722f', '#5c2a0c'], igloo: ['#e6f0f8', '#8fb2cf', '#24323f'], storage: ['#e7eaee', '#8a97a5', '#24323f'], tower: ['#eef0e6', '#9aa684', '#33402a'], workshop: ['#f3ebe0', '#a88b62', '#4a3820'], off: ['#eceff1', '#b7c0c8', '#5d6f7e'] },
      chip: { ok: ['#dcf0e4', '#1d5a3a'], lost: ['#fbe0dd', '#8f261e'], fire: ['#ffe0c8', '#8a3a0e'] },
      fireOn: '#e9722f', fireOff: '#f3d9c6',
      res: { tree: ['#e3f1e8', '#3c8f66', '#2c6e4c'], stone: ['#e9edf1', '#7d8b97', '#55626d'], veg: ['#fdeccf', '#d98a2b', '#8a520f'], animal: ['#f6e4da', '#b4694a', '#7c4128'], fish: ['#dcecf8', '#3b86c6', '#1f5f99'], plant: ['#eef7e4', '#7aa84a', '#4a7a22'], plantTree: ['#e1f3e6', '#2f8f5a', '#1f6b43'], plantVeg: ['#fff3d6', '#c9a227', '#8a6a0a'] },
      item: { fur: ['#efe6e0', '#7a5a48'], steak: ['#f8dcd4', '#a3392b'], grilled: ['#fbe3cc', '#b5651d'], soup: ['#fdf0d0', '#b07a10'], wood: ['#f3e8dc', '#8a5a2b'], firewood: ['#f6e6d2', '#b3651f'], stone: ['#e9edf1', '#55626d'], veg: ['#fdeccf', '#8a520f'], meat: ['#f8e1dc', '#9b3a2e'], snow: ['#e1eefa', '#2f6fb5'], sapling: ['#e3f1e8', '#2c6e4c'] },
      tint: { clear: 'rgba(255,236,190,0.10)', snow: 'rgba(120,150,185,0.10)', blizzard: 'rgba(120,150,185,0.22)', rain: 'rgba(70,105,150,0.18)', storm: 'rgba(55,85,130,0.34)' },
      flake: '#7fa3c2', rain: '#4b79a8',
    },
    dark: {
      road: '#3a4958', roadBd: '#7089a0', bridge: '#6b5330', bridgeBd: '#b99560', hpTrack: 'rgba(255,255,255,.16)', hpOk: '#4fb27f', hpLow: '#ff6b5e', penA: '#7fb4e8', penB: '#9fb0bf',
      temp: '#5aaee8', tempLow: '#ff6b5e', food: '#f0b94a', foodLow: '#ff6b5e', redFg: '#ff9a90', ok: '#4fb27f', ng: '#ff6b5e',
      bg: '#0f1620', river: '#1c3a57', tile: '#121b26', reach: '#1b2a3b', grid: '#25364a', accent: '#5aa0e6', text: '#e6edf3', panel: '#17212d',
      card: { fire: ['#3a2314', '#e9722f', '#ffd9bd'], igloo: ['#1b2e42', '#4a7aa6', '#dbe9f6'], storage: ['#252e39', '#6f7f90', '#e6edf3'], tower: ['#2a3220', '#7c8a5f', '#dfe8cf'], workshop: ['#33291c', '#a8895a', '#f0e0c4'], off: ['#1f2730', '#4a5663', '#8d9dab'] },
      chip: { ok: ['#1c3d2e', '#8fe0b3'], lost: ['#4a2224', '#ffab9f'], fire: ['#4a2f1a', '#ffc9a0'] },
      fireOn: '#f08a4b', fireOff: '#4a3526',
      res: { tree: ['#1a3326', '#4fb27f', '#8fe0b3'], stone: ['#252e37', '#8696a5', '#c2cfda'], veg: ['#3a2b14', '#e0a040', '#ffd08a'], animal: ['#3a2619', '#d08a66', '#f1c0a6'], fish: ['#14293d', '#4a9ae0', '#9cd0f5'], plant: ['#24331a', '#8cc25a', '#c4e89a'], plantTree: ['#16301f', '#3fbf7a', '#9be8bd'], plantVeg: ['#3a3314', '#e0c040', '#fff0a0'] },
      item: { fur: ['#3a2f2a', '#d8b8a0'], steak: ['#4a2420', '#ff9a88'], grilled: ['#4a2f1a', '#f0a868'], soup: ['#40361a', '#f5d070'], wood: ['#3a2c1e', '#e0b27a'], firewood: ['#40281a', '#f0a05a'], stone: ['#2a323b', '#b7c4cf'], veg: ['#3a2b14', '#ffd08a'], meat: ['#3d2220', '#f2a89c'], snow: ['#1a2e44', '#8ec3f5'], sapling: ['#1a3326', '#8fe0b3'] },
      tint: { clear: 'rgba(0,0,0,0)', snow: 'rgba(150,185,225,0.07)', blizzard: 'rgba(170,200,235,0.16)', rain: 'rgba(40,80,140,0.22)', storm: 'rgba(190,215,245,0.26)' },
      flake: '#b8d4ee', rain: '#6f9fd0',
    },
  };
  // 駒の色と形（ロビーで選ぶ）
  const PLAYER_COLORS = {
    red: '#e5534b', orange: '#f08a2e', yellow: '#f0c020', green: '#3fae74', cyan: '#2dbfc7', blue: '#3b82d6',
    indigo: '#3f4db0', purple: '#a066db', pink: '#e56ab0', white: '#f4f4f4', brown: '#8b5a3c', black: '#1b1b1f',
  };
  const COLOR_NAMES = { red: '赤', orange: '橙', yellow: '黄', green: '緑', cyan: '水', blue: '青', indigo: '藍', purple: '紫', pink: '桃', white: '白', brown: '茶', black: '黒' };
  const SHAPE_NAMES = { circle: '丸', square: '四角', diamond: 'ひし形', up: '上向き三角形', down: '下向き三角形', hex: '六角形' };
  // 形の輪郭（中心 (0,0)・半径 1 の点列。丸は null）
  const hexPts = [0, 1, 2, 3, 4, 5].map(i => [Math.cos(Math.PI / 3 * i - Math.PI / 2), Math.sin(Math.PI / 3 * i - Math.PI / 2)]);
  const SHAPE_PTS = {
    circle: null,
    square: [[-0.82, -0.82], [0.82, -0.82], [0.82, 0.82], [-0.82, 0.82]],
    diamond: [[0, -1.1], [1.1, 0], [0, 1.1], [-1.1, 0]],
    up: [[0, -1.05], [1.05, 0.82], [-1.05, 0.82]],
    down: [[0, 1.05], [1.05, -0.82], [-1.05, -0.82]],
    hex: hexPts,
  };
  // 塗りの色に近い、枠の色（明るい色は暗めに、暗い色は明るめに）
  const mixHex = (hex, t, to) => {
    const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    return '#' + c.map(v => Math.round(v + (to - v) * t).toString(16).padStart(2, '0')).join('');
  };
  const borderOf = c => { const h = PLAYER_COLORS[c] || '#888888'; return isLight(c) ? mixHex(h, 0.45, 0) : mixHex(h, 0.5, 255); };
  const isLight = c => { const h = PLAYER_COLORS[c] || '#888888'; const n = parseInt(h.slice(1), 16); return ((n >> 16) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114) > 170; };
  function shapePath(ctx, shape, cx, cy, r) {
    ctx.beginPath();
    const pts = SHAPE_PTS[shape];
    if (!pts) { ctx.arc(cx, cy, r, 0, 7); return; }
    pts.forEach((p, i) => (i ? ctx.lineTo(cx + p[0] * r, cy + p[1] * r) : ctx.moveTo(cx + p[0] * r, cy + p[1] * r)));
    ctx.closePath();
  }
  // 画面の部品（ロビー・プレイヤー一覧）に使う駒の絵
  function shapeSvg(shape, color, size) {
    const fill = PLAYER_COLORS[color] || '#888', stroke = borderOf(color);
    const pts = SHAPE_PTS[shape || 'circle'];
    const body = pts ? `<polygon points="${pts.map(p => (12 + p[0] * 9).toFixed(1) + ',' + (12 + p[1] * 9).toFixed(1)).join(' ')}"` : '<circle cx="12" cy="12" r="9"';
    return `<svg class="pawn-ico" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${body} fill="${fill}" stroke="${stroke}" stroke-width="1.8" stroke-linejoin="round"/></svg>`;
  }
  const FONT = "'Noto Sans JP', system-ui, sans-serif";

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else ctx.rect(x, y, w, h);
  }

  function create(o) {
    const cv = o.canvas, ctx = cv.getContext('2d');
    const s = {
      cam: { x: 0, y: 0, z: 1 }, W: 0, H: 0, dpr: 1, hover: null, press: null, drag: null, preview: null,
      mode: 'play', tool: 'pen', color: 'a', live: [], cur: null, lastErase: 0, raf: 0, mm: null, mmKey: '',
    };
    const board = { state: s, T };

    const toWorld = (px, py) => ({ x: (px - s.cam.x) / (T * s.cam.z), y: (py - s.cam.y) / (T * s.cam.z) });
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    board.hoverInfo = (g, x, y) => {
      const b = E.bAt(g, x, y), res = E.resAt(g, x, y), animal = E.animalAt(g, x, y), plant = E.plantAt(g, x, y), fish = E.fishAt(g, x, y), river = E.isRiver(g, x, y);
      return (b || res || animal || plant || fish || river) ? { b, res, animal, plant, fish, river } : null;
    };
    board.tileScreen = (x, y) => ({ x: s.cam.x + x * T * s.cam.z, y: s.cam.y + y * T * s.cam.z, size: T * s.cam.z });

    board.resize = function () {
      const r = cv.getBoundingClientRect();
      s.dpr = window.devicePixelRatio || 1;
      s.W = r.width; s.H = r.height;
      cv.width = Math.max(1, Math.round(r.width * s.dpr));
      cv.height = Math.max(1, Math.round(r.height * s.dpr));
      board.draw();
    };
    board.centerOn = function (tx, ty) {
      s.cam.x = s.W / 2 - tx * T * s.cam.z;
      s.cam.y = s.H / 2 - ty * T * s.cam.z;
    };
    board.reset = function () { s.cam.z = 1; board.centerOn(0.5, 0.5); board.request(); o.onView && o.onView(); };
    board.zoom = function (f, cx, cy) {
      const z0 = s.cam.z, z1 = Math.max(Z_MIN, Math.min(Z_MAX, z0 * f));
      const wx = (cx - s.cam.x) / z0, wy = (cy - s.cam.y) / z0;
      s.cam.z = z1; s.cam.x = cx - wx * z1; s.cam.y = cy - wy * z1;
      board.request(); o.onView && o.onView();
    };
    board.setMode = function (m) { s.mode = m; s.press = null; s.cur = null; s.drag = null; board.request(); };
    board.setPen = function (tool, color) { s.tool = tool; s.color = color; };
    board.setPreview = function (p) { s.preview = p; board.request(); };
    // 建設モード：カードを選ぶと、マップをクリックして連続で置ける
    board.setArmed = function (t) { s.armed = t || null; if (!t) s.preview = null; board.request(); };
    board.request = function () { if (!s.raf) s.raf = requestAnimationFrame(() => { s.raf = 0; board.draw(); }); };
    board.liveClear = function () { s.live = s.live.filter(l => !l.sent); board.request(); };
    board.tileAt = function (clientX, clientY) {
      const r = cv.getBoundingClientRect();
      if (clientX < r.left || clientX > r.right || clientY < r.top || clientY > r.bottom) return null;
      const w = toWorld(clientX - r.left, clientY - r.top);
      return { x: Math.floor(w.x), y: Math.floor(w.y), fx: w.x, fy: w.y };
    };

    // 自分の移動できるマス（状態が変わるまで使い回す）
    function moveMap(g, me) {
      const k = g.v + ':' + me.x + ',' + me.y + ':' + me.down;
      if (s.mmKey !== k) { s.mmKey = k; s.mm = E.moveMap(g, me); }
      return s.mm;
    }
    board.moveInfo = function (g, me, x, y) {
      const why = E.moveWhy(g, me, x, y);
      if (why) return { ok: false, why };
      const d = moveMap(g, me).get(E.key(x, y));
      if (d == null) return { ok: false, why: 'そこまでの道がありません' };
      return { ok: true, cost: E.moveCost(d) };
    };

    // ---------- 操作 ----------
    function flushLive(force) {
      const c = s.cur;
      if (!c || c.pts.length < 2) return;
      if (!force && c.pts.length < 60 && Date.now() - c.at < 160) return;
      o.onDraw(c.c, c.pts.slice());
      c.sent.push(...c.pts);
      const last = c.pts.slice(-2);
      c.pts.length = 0; c.pts.push(...last);
      c.at = Date.now();
    }
    cv.addEventListener('pointerdown', e => {
      const g = o.game(); if (!g) return;
      cv.setPointerCapture(e.pointerId);
      const v = pos(e), w = toWorld(v.x, v.y);
      if (s.mode === 'draw') {
        if (s.tool === 'pen') {
          s.cur = { c: s.color, pts: [w.x, w.y], sent: [], at: Date.now() };
          s.live.push(s.cur);
        } else { s.cur = { eraser: true }; erase(w); }
        board.request();
        return;
      }
      const me = o.me();
      const tx = Math.floor(w.x), ty = Math.floor(w.y);
      const other = me ? g.players.find(q => q.id !== me.id && q.x === tx && q.y === ty) : null;     // ほかの人の駒
      s.press = { vx: v.x, vy: v.y, kind: (me && tx === me.x && ty === me.y) ? 'pawn' : other ? 'other' : 'pan', other, cam0: { x: s.cam.x, y: s.cam.y }, moved: false };
    });
    function erase(w) {
      const now = Date.now();
      if (now - s.lastErase < 50) return;
      s.lastErase = now;
      o.onErase(w.x, w.y, 0.3);
    }
    cv.addEventListener('pointermove', e => {
      const g = o.game(); if (!g) return;
      const v = pos(e), w = toWorld(v.x, v.y);
      if (s.mode === 'draw') {
        const c = s.cur;
        if (c && c.eraser) erase(w);
        else if (c) {
          const lx = c.pts[c.pts.length - 2], ly = c.pts[c.pts.length - 1];
          if (Math.hypot(w.x - lx, w.y - ly) > 0.04) { c.pts.push(+w.x.toFixed(3), +w.y.toFixed(3)); flushLive(false); board.request(); }
        }
        return;
      }
      const tx = Math.floor(w.x), ty = Math.floor(w.y);
      if (s.armed) {
        const sz = E.BUILD[s.armed].size;
        s.preview = { t: s.armed, x: Math.floor(w.x - sz / 2 + 0.5), y: Math.floor(w.y - sz / 2 + 0.5) };
        board.request();
      }
      if (!s.press) {
        if (!s.hover || s.hover.x !== tx || s.hover.y !== ty) { s.hover = { x: tx, y: ty }; o.onHover(board.hoverInfo(g, tx, ty), v); board.request(); }
        return;
      }
      const pr = s.press;
      if (!pr.moved && Math.hypot(v.x - pr.vx, v.y - pr.vy) > 6) { pr.moved = true; s.hover = null; o.onHover(null); }
      if (!pr.moved) return;
      if (pr.kind === 'pawn') {
        const me = o.me();
        const info = board.moveInfo(g, me, tx, ty);
        s.drag = { x: tx, y: ty, ok: info.ok, cost: info.cost, why: info.why, wx: w.x, wy: w.y, vx: v.x, vy: v.y };
        o.onDrag(s.drag);
      } else {
        s.cam.x = pr.cam0.x + (v.x - pr.vx); s.cam.y = pr.cam0.y + (v.y - pr.vy);
        o.onView && o.onView();
      }
      board.request();
    });
    function up(e) {
      const g = o.game();
      if (s.mode === 'draw') { flushLive(true); s.cur = null; return; }
      const pr = s.press; s.press = null;
      const d = s.drag; s.drag = null;
      o.onDrag(null);
      board.request();
      if (!pr || !g) return;
      if (d) {
        if (d.ok) o.onMove(d.x, d.y, { x: d.vx, y: d.vy });
        else if (d.why && d.why !== 'いまいるマスです') o.onMoveFail(d.why, d.x, d.y, { x: d.vx, y: d.vy });
        return;
      }
      if (pr.moved) return;
      if (s.armed && s.preview) { o.onBuild(s.armed, s.preview.x, s.preview.y); return; }
      const v = pos(e), w = toWorld(v.x, v.y), tx = Math.floor(w.x), ty = Math.floor(w.y);
      if (pr.kind === 'other') { o.onOtherPawn(pr.other, { x: v.x, y: v.y }); return; }
      if (pr.kind === 'pawn') { o.onPawn(); return; }
      const b = E.bAt(g, tx, ty);
      o.onBackground(b);
    }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => { s.press = null; s.drag = null; s.cur = null; o.onDrag(null); board.request(); });
    cv.addEventListener('pointerleave', () => { if (s.hover) { s.hover = null; o.onHover(null); board.request(); } if (s.armed) { s.preview = null; board.request(); } });
    cv.addEventListener('contextmenu', e => { if (s.armed) { e.preventDefault(); o.onDisarm(); } });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const v = pos(e);
      board.zoom(e.deltaY < 0 ? 1.12 : 1 / 1.12, v.x, v.y);
    }, { passive: false });

    // ---------- 描画 ----------
    function text(t, x, y, size, color, weight, align) {
      ctx.font = `${weight || 500} ${size}px ${FONT}`;
      ctx.fillStyle = color; ctx.textAlign = align || 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(t, x, y);
    }
    function wrap(t, maxW, size) {
      ctx.font = `500 ${size}px ${FONT}`;
      const out = []; let line = '';
      for (const ch of t) {
        if (ctx.measureText(line + ch).width > maxW && line) { out.push(line); line = ch; } else line += ch;
      }
      if (line) out.push(line);
      return out;
    }

    board.draw = function () {
      const g = o.game();
      if (!g || !s.W) return;
      const th = THEMES[o.theme()];
      const me = o.me();
      const z = s.cam.z, S = T * z, cx = s.cam.x, cy = s.cam.y;
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      ctx.fillStyle = th.bg; ctx.fillRect(0, 0, s.W, s.H);
      const vx0 = Math.floor(-cx / S) - 1, vx1 = Math.ceil((s.W - cx) / S) + 1, vy0 = Math.floor(-cy / S) - 1, vy1 = Math.ceil((s.H - cy) / S) + 1;
      const vis = (x, y) => x >= vx0 && x <= vx1 && y >= vy0 && y <= vy1;
      const X = x => cx + x * S, Y = y => cy + y * S;

      // 地面（生成済みの範囲）・移動できる範囲・方眼
      ctx.fillStyle = th.tile;
      for (const r of g.gen) ctx.fillRect(X(r[0]), Y(r[2]), (r[1] - r[0] + 1) * S, (r[3] - r[2] + 1) * S);
      ctx.fillStyle = th.reach;
      for (const b of g.b) { const M = E.rangeOf(b); ctx.fillRect(X(b.x - M), Y(b.y - M), (b.w + 2 * M) * S, (b.h + 2 * M) * S); }
      ctx.fillStyle = th.river;                                   // 川のマス
      for (const r of g.gen) {
        for (let y = Math.max(r[2], vy0); y <= Math.min(r[3], vy1); y++) for (let x = Math.max(r[0], vx0); x <= Math.min(r[1], vx1); x++) if (E.isRiver(g, x, y)) ctx.fillRect(X(x), Y(y), S + 0.5, S + 0.5);
      }
      ctx.strokeStyle = th.grid; ctx.lineWidth = 1; ctx.beginPath();
      for (const r of g.gen) {
        const a = Math.max(r[0], vx0), b2 = Math.min(r[1] + 1, vx1), c2 = Math.max(r[2], vy0), d2 = Math.min(r[3] + 1, vy1);
        for (let x = a; x <= b2; x++) { ctx.moveTo(Math.round(X(x)) + .5, Y(c2)); ctx.lineTo(Math.round(X(x)) + .5, Y(d2)); }
        for (let y = c2; y <= d2; y++) { ctx.moveTo(X(a), Math.round(Y(y)) + .5); ctx.lineTo(X(b2), Math.round(Y(y)) + .5); }
      }
      ctx.stroke();

      // お絵かき（保存済みと、描いている途中のもの）
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(1.5, 3.4 * z);
      for (const c of ['a', 'b']) {
        ctx.strokeStyle = c === 'a' ? th.penA : th.penB; ctx.beginPath();
        for (const k of Object.keys(g.draw)) {
          const [kx, ky] = E.parseKey(k);
          if (!vis(kx, ky)) continue;
          for (const st of g.draw[k]) {
            if (st.c !== c) continue;
            const p = st.p;
            ctx.moveTo(X(kx + p[0] / 100), Y(ky + p[1] / 100));
            for (let i = 2; i < p.length; i += 2) ctx.lineTo(X(kx + p[i] / 100), Y(ky + p[i + 1] / 100));
          }
        }
        for (const l of s.live) {
          if (l.c !== c) continue;
          const sp = l.sent.length ? l.sent.concat(l.pts) : l.pts;
          if (sp.length < 2) continue;
          ctx.moveTo(X(sp[0]), Y(sp[1]));
          if (sp.length === 2) ctx.lineTo(X(sp[0]) + .01, Y(sp[1]));
          for (let i = 2; i < sp.length; i += 2) ctx.lineTo(X(sp[i]), Y(sp[i + 1]));
        }
        ctx.stroke();
      }

      // 道：建物と同じ角丸の札。隣り合う道は一つにつながって見える（枠 → 中の塗り の順に重ねる）
      const road = (x, y) => g.b.some(q => E.isPath(q.t) && q.x === x && q.y === y);
      const roads = g.b.filter(b => E.isPath(b.t) && vis(b.x, b.y));
      const roadShape = (b, pad) => {
        const n = road(b.x, b.y - 1), e = road(b.x + 1, b.y), so = road(b.x, b.y + 1), w = road(b.x - 1, b.y);
        const ins = 3 * z - pad, x = X(b.x) + (w ? -0.5 : ins), y = Y(b.y) + (n ? -0.5 : ins);
        const x2 = X(b.x + 1) - (e ? -0.5 : ins), y2 = Y(b.y + 1) - (so ? -0.5 : ins);
        const r = 10 * z + pad, rad = (a, c) => ((!a && !c) ? r : 0);
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, x2 - x, y2 - y, [rad(n, w), rad(n, e), rad(so, e), rad(so, w)]); else ctx.rect(x, y, x2 - x, y2 - y);
      };
      for (const b of roads) { ctx.fillStyle = b.t === 'bridge' ? th.bridgeBd : th.roadBd; roadShape(b, 2 * z); ctx.fill(); }
      for (const b of roads) { ctx.fillStyle = b.t === 'bridge' ? th.bridge : th.road; roadShape(b, 0); ctx.fill(); }
      for (const b of roads) {
        if (o.sel() === b.id) { ctx.strokeStyle = th.accent; ctx.lineWidth = 3 * z; roadShape(b, 3 * z); ctx.stroke(); }
      }

      // 建物
      for (const b of g.b) {
        if (E.isPath(b.t) || !(b.x <= vx1 && b.x + b.w >= vx0 && b.y <= vy1 && b.y + b.h >= vy0)) continue;
        const isFire = b.t === 'fire', warm = b.t === 'igloo' || b.t === 'storage', ins = E.insul(b), lost = warm && !ins;
        const col = th.card[lost ? 'off' : b.t];
        const x = X(b.x) + 3 * z, y = Y(b.y) + 3 * z, w = b.w * S - 6 * z, h = b.h * S - 6 * z;
        ctx.fillStyle = col[0]; rr(ctx, x, y, w, h, 10 * z); ctx.fill();
        ctx.strokeStyle = col[1]; ctx.lineWidth = 2 * z; rr(ctx, x, y, w, h, 10 * z); ctx.stroke();
        if (o.sel() === b.id) { ctx.strokeStyle = th.accent; ctx.lineWidth = 3 * z; rr(ctx, x - 2 * z, y - 2 * z, w + 4 * z, h + 4 * z, 12 * z); ctx.stroke(); }
        if (z < 0.5) continue;
        const px = x + 8 * z; let py = y + 7 * z + 9 * z;
        icon(ctx, b.t, px + 9 * z, py, 18 * z, col[2]);
        text(({ fire: '焚き火', igloo: 'かまくら', storage: '倉庫', tower: '見張り台', workshop: '作業場' })[b.t], px + 24 * z, py, 13 * z, col[2], 700);
        py += 16 * z;
        let chip = null, label = '';
        if (isFire) { chip = th.chip.fire; label = `火力 ${g.fire} / ${E.RULES.fireMax}`; }
        else if (warm) { chip = ins ? th.chip.ok : th.chip.lost; label = ins ? '防寒 有効' : '防寒 消失'; }
        if (chip && h > 50 * z) {
          ctx.font = `700 ${12 * z}px ${FONT}`;
          const tw = ctx.measureText(label).width;
          ctx.fillStyle = chip[0]; rr(ctx, px, py - 8 * z, tw + 16 * z, 16 * z, 8 * z); ctx.fill();
          text(label, px + 8 * z, py, 12 * z, chip[1], 700);
          py += 17 * z;
        }
        if (isFire) {
          const sw = (w - 16 * z - 3 * z * (E.RULES.fireMax - 1)) / E.RULES.fireMax;
          for (let i = 0; i < E.RULES.fireMax; i++) { ctx.fillStyle = i < g.fire ? th.fireOn : th.fireOff; ctx.fillRect(px + i * (sw + 3 * z), py - 4 * z, sw, 8 * z); }
          py += 14 * z;
        } else {
          const bw = w - 16 * z - 60 * z;
          ctx.fillStyle = th.hpTrack; rr(ctx, px, py - 3 * z, Math.max(10, bw), 6 * z, 3 * z); ctx.fill();
          ctx.fillStyle = b.hp * 2 > b.max ? th.hpOk : th.hpLow; rr(ctx, px, py - 3 * z, Math.max(10, bw) * b.hp / b.max, 6 * z, 3 * z); ctx.fill();
          text(`HP ${b.hp}/${b.max}`, px + Math.max(10, bw) + 6 * z, py, 12 * z, col[2], 700);
          py += 16 * z;
        }
        if (b.w >= 3) {
          const info = isFire ? '上に立って「温まる」＝火力ぶん体温回復。「焚べる」＝木材1で火力+1。' : '共有アイテムの上限 +10。';
          wrap(info, w - 16 * z, 12 * z).forEach((ln, i) => text(ln, px, py + 8 * z + i * 18 * z, 12 * z, col[2], 500));
        }
      }

      // 資源・動物・苗・駒（同じマスに重なるときは位置をずらす）
      const tiles = new Map();
      const put = (x, y, v) => { if (!vis(x, y)) return; const k = E.key(x, y); (tiles.get(k) || tiles.set(k, []).get(k)).push(v); };
      for (const k of Object.keys(g.res)) { const [x, y] = E.parseKey(k); put(x, y, { kind: g.res[k].t, hp: g.res[k].hp, max: g.res[k].max || E.RULES.resHpMax }); }
      for (const p of g.plants) put(p.x, p.y, { kind: p.t === 'veg' ? 'plantVeg' : 'plantTree', hp: p.left, max: E.RULES.growMax });
      for (const a of g.animals) put(a.x, a.y, { kind: 'animal', hp: a.hp, max: a.max || E.RULES.animalHpMax });
      for (const f of g.fish || []) put(f.x, f.y, { kind: 'fish', hp: f.hp, max: f.max || E.RULES.fishHpMax });
      g.players.forEach(p => put(p.x, p.y, { kind: 'pawn', p }));
      for (const [k, list] of tiles) {
        const [tx, ty] = E.parseKey(k), n = list.length;
        let entIdx = 0;
        for (const v of list) {
          const ox = X(tx), oy = Y(ty);
          if (v.kind === 'pawn') {
            const p = v.p;
            const [ax, ay] = n === 1 ? [13, 13] : [3, T - 29];
            const dragging = s.drag && me && p.id === me.id;
            ctx.globalAlpha = dragging ? 0.35 : 1;
            pawn(ox + ax * z, oy + ay * z, 26 * z, p, me && p.id === me.id, th, p.down > 0);
            ctx.globalAlpha = 1;
          } else {
            const [ax, ay] = n === 1 ? [16, 16] : (entIdx++ === 0 ? [T - 23, 3] : [3, 3]);
            entity(ox + ax * z, oy + ay * z, ENT * z, v.kind, v.badge, v, th);
          }
        }
      }

      // 建設の置き場所・移動先の目印
      const pv = s.preview;
      if (pv) {
        const d = E.BUILD[pv.t], bad = !!E.buildWhy(g, pv.t, pv.x, pv.y);
        ctx.fillStyle = bad ? 'rgba(220,70,60,.2)' : 'rgba(60,170,120,.22)'; ctx.fillRect(X(pv.x), Y(pv.y), d.size * S, d.size * S);
        ctx.setLineDash([6, 4]); ctx.strokeStyle = bad ? th.ng : th.ok; ctx.lineWidth = 2; ctx.strokeRect(X(pv.x), Y(pv.y), d.size * S, d.size * S); ctx.setLineDash([]);
      }
      if (s.drag) {
        const d = s.drag;
        ctx.fillStyle = d.ok ? 'rgba(60,170,120,.22)' : 'rgba(220,70,60,.2)'; ctx.fillRect(X(d.x), Y(d.y), S, S);
        ctx.strokeStyle = d.ok ? th.ok : th.ng; ctx.lineWidth = 2; rr(ctx, X(d.x) + 1, Y(d.y) + 1, S - 2, S - 2, 8 * z); ctx.stroke();
        if (me) {
          ctx.globalAlpha = .92;
          pawn(X(d.wx) - 15 * z, Y(d.wy) - 15 * z, 30 * z, me, true, th, false);
          ctx.globalAlpha = 1;
        }
      }
    };

    // 駒：プレイヤーが選んだ形と色。うすく透けて、後ろの文字が読める。枠は塗りと同系色。自分の駒は外側にリング
    function pawn(x, y, size, p, mine, th, down) {
      const cx = x + size / 2, cy = y + size / 2, r = size / 2 * 0.92, sh = p.shape || 'circle';
      const a0 = ctx.globalAlpha;
      ctx.globalAlpha = a0 * 0.55;
      ctx.fillStyle = PLAYER_COLORS[p.color] || '#888';
      shapePath(ctx, sh, cx, cy, r); ctx.fill();
      ctx.globalAlpha = a0 * 0.95;
      ctx.strokeStyle = borderOf(p.color); ctx.lineWidth = Math.max(1.5, size / 11); ctx.lineJoin = 'round';
      shapePath(ctx, sh, cx, cy, r); ctx.stroke();
      if (mine) {
        ctx.strokeStyle = th.text; ctx.lineWidth = Math.max(1.5, size / 13);
        ctx.beginPath(); ctx.arc(cx, cy, size / 2 + 3 * (size / 26), 0, 7); ctx.stroke();
      }
      if (down) { ctx.fillStyle = 'rgba(15,22,32,.5)'; shapePath(ctx, sh, cx, cy, r); ctx.fill(); text('zz', cx, cy, size * 0.42, '#fff', 700, 'center'); }
      ctx.globalAlpha = a0;
    }
    // 資源・動物・苗：丸。外側の線は塗りにぴったり接していて、ひと続きの線を区切りの印で等分する。
    // 資源・動物は区切り1つが体力1、苗は「育つまであと1ラウンド」（なくなった分はうすく残す）
    const ENT_ICON = { plantTree: 'sapling', plantVeg: 'plant' };
    function entity(x, y, size, kind, badge, v, th) {
      const c = th.res[kind], cx = x + size / 2, cy = y + size / 2;
      const lw = Math.max(1.6, size / 8), rf = size / 2;
      ctx.fillStyle = c[0]; ctx.beginPath(); ctx.arc(cx, cy, rf, 0, 7); ctx.fill();
      icon(ctx, ENT_ICON[kind] || kind, cx, cy, size * 0.6, c[2]);
      if (!v || !v.max) return;
      const n = v.max, frac = Math.max(0, Math.min(1, v.hp / n));
      const rr_ = rf + lw / 2;                                   // 線の中心：塗りの縁から線の太さの半分だけ外側（すきまなし）
      const at = f => [cx + Math.cos(-Math.PI / 2 + f * Math.PI * 2) * rr_, cy + Math.sin(-Math.PI / 2 + f * Math.PI * 2) * rr_];
      const trace = (f0, f1) => { ctx.beginPath(); ctx.arc(cx, cy, rr_, -Math.PI / 2 + f0 * Math.PI * 2, -Math.PI / 2 + f1 * Math.PI * 2); ctx.stroke(); };
      ctx.lineCap = 'butt'; ctx.lineWidth = lw; ctx.strokeStyle = c[1];
      ctx.globalAlpha = 0.18; trace(0, 0.9999); ctx.globalAlpha = 1;
      if (frac > 0) trace(0, frac >= 1 ? 0.9999 : frac);
      if (n > 1) {                                                // 区切りの印
        ctx.strokeStyle = th.tile; ctx.lineWidth = Math.max(0.8, size / 20);
        for (let i = 0; i < n; i++) {
          const q = at(i / n), dx = q[0] - cx, dy = q[1] - cy, d = Math.hypot(dx, dy) || 1;
          ctx.beginPath(); ctx.moveTo(q[0] - dx / d * lw * 0.6, q[1] - dy / d * lw * 0.6); ctx.lineTo(q[0] + dx / d * lw * 0.6, q[1] + dy / d * lw * 0.6); ctx.stroke();
        }
      }
    }

    if (window.ResizeObserver) new ResizeObserver(() => board.resize()).observe(cv);
    window.addEventListener('resize', () => board.resize());
    return board;
  }

  window.SnowBoard = { borderOf, create, THEMES, PLAYER_COLORS, COLOR_NAMES, SHAPE_NAMES, shapeSvg, ICONS, ITEM_ICON, svgIcon, T };
})();
