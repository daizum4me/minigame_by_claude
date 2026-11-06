/*
 * Snowfield — マップの描画と操作（canvas）
 * 無限のマップを、ズームと移動ができるカメラで描く。駒のドラッグ移動・お絵かきもここで受ける。
 * 状態の更新は行わず、操作の結果は create() に渡されたコールバックで知らせる。
 */
(function () {
  'use strict';

  const E = window.SnowEngine;
  const T = 52;                       // 1マスの大きさ（ワールド座標）
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
    tree: ['M12 3l6 9h-3l4 6H5l4-6H6z', 'M12 18v3'],
    stone: ['M4 18l3-9 6-4 6 6 2 7z'],
    veg: ['M12 21c-4-3-5-8-2-12 3 1 5 3 5 6 0 2-1 4-3 6z', 'M10 9c0-3 2-5 4-6'],
    animal: [EL(11, 15, 6, 4.5), C(17, 9, 2.6), 'M16 6.5l1-3M18.5 7l2-2'],
    plant: ['M12 21v-9', 'M12 12c0-4-3-6-7-6 0 4 3 6 7 6z', 'M12 14c0-3 2-5 6-5 0 3-2 5-6 5z'],
    wood: [RC(3, 8, 18, 9), EL(18, 12.5, 1.6, 2.4), 'M7 10.5h6'],
    stoneItem: ['M4 9l8-4 8 4v7l-8 4-8-4z', 'M4 9l8 4 8-4M12 13v7'],
    meat: ['M5 14c0-5 4-9 9-9a5 5 0 0 1 5 5c0 5-4 9-9 9-3 0-5-2-5-5z', 'M8.5 15.5L4 20M4 20l-1.5-.5M4 20l.5-1.5'],
    snow: ['M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9', 'M9.5 4.8L12 6.5l2.5-1.7M9.5 19.2L12 17.5l2.5 1.7'],
    sapling: ['M12 21v-9', 'M12 12l-4-3M12 15l4-3', C(8, 7.5, 2.5), C(16, 9, 2.5), C(12, 5, 2.5)],
  };
  ICONS.vegItem = ICONS.veg;
  const ITEM_ICON = { wood: 'wood', stone: 'stoneItem', veg: 'veg', meat: 'meat', snow: 'snow', sapling: 'sapling' };
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
      road: '#c3cfd8', roadBd: '#8497a8', hpTrack: 'rgba(36,50,63,.16)', hpOk: '#3c8f66', hpLow: '#c0463b', penA: '#2d5b88', penB: '#8a97a3',
      temp: '#4a90c8', tempLow: '#c0463b', food: '#e0a030', foodLow: '#c0463b', redFg: '#a8312a', ok: '#2f9a6a', ng: '#c0463b',
      bg: '#e9eff4', tile: '#f8fafc', reach: '#e8f1f7', grid: '#dbe5ed', accent: '#2f6fb5', text: '#24323f', panel: '#ffffff',
      card: { fire: ['#fff1e4', '#e9722f', '#5c2a0c'], igloo: ['#e6f0f8', '#8fb2cf', '#24323f'], storage: ['#e7eaee', '#8a97a5', '#24323f'], tower: ['#eef0e6', '#9aa684', '#33402a'], off: ['#eceff1', '#b7c0c8', '#5d6f7e'] },
      chip: { ok: ['#dcf0e4', '#1d5a3a'], lost: ['#fbe0dd', '#8f261e'], fire: ['#ffe0c8', '#8a3a0e'] },
      fireOn: '#e9722f', fireOff: '#f3d9c6',
      res: { tree: ['#e3f1e8', '#3c8f66', '#2c6e4c'], stone: ['#e9edf1', '#7d8b97', '#55626d'], veg: ['#fdeccf', '#d98a2b', '#8a520f'], animal: ['#f6e4da', '#b4694a', '#7c4128'], plant: ['#eef7e4', '#7aa84a', '#4a7a22'] },
      item: { wood: ['#f3e8dc', '#8a5a2b'], stone: ['#e9edf1', '#55626d'], veg: ['#fdeccf', '#8a520f'], meat: ['#f8e1dc', '#9b3a2e'], snow: ['#e1eefa', '#2f6fb5'], sapling: ['#e3f1e8', '#2c6e4c'] },
      tint: { clear: 'rgba(255,236,190,0.10)', snow: 'rgba(120,150,185,0.10)', blizzard: 'rgba(120,150,185,0.22)', rain: 'rgba(70,105,150,0.18)', storm: 'rgba(55,85,130,0.34)' },
      flake: '#7fa3c2', rain: '#4b79a8',
    },
    dark: {
      road: '#3a4958', roadBd: '#7089a0', hpTrack: 'rgba(255,255,255,.16)', hpOk: '#4fb27f', hpLow: '#ff6b5e', penA: '#7fb4e8', penB: '#9fb0bf',
      temp: '#5aaee8', tempLow: '#ff6b5e', food: '#f0b94a', foodLow: '#ff6b5e', redFg: '#ff9a90', ok: '#4fb27f', ng: '#ff6b5e',
      bg: '#0f1620', tile: '#121b26', reach: '#1b2a3b', grid: '#25364a', accent: '#5aa0e6', text: '#e6edf3', panel: '#17212d',
      card: { fire: ['#3a2314', '#e9722f', '#ffd9bd'], igloo: ['#1b2e42', '#4a7aa6', '#dbe9f6'], storage: ['#252e39', '#6f7f90', '#e6edf3'], tower: ['#2a3220', '#7c8a5f', '#dfe8cf'], off: ['#1f2730', '#4a5663', '#8d9dab'] },
      chip: { ok: ['#1c3d2e', '#8fe0b3'], lost: ['#4a2224', '#ffab9f'], fire: ['#4a2f1a', '#ffc9a0'] },
      fireOn: '#f08a4b', fireOff: '#4a3526',
      res: { tree: ['#1a3326', '#4fb27f', '#8fe0b3'], stone: ['#252e37', '#8696a5', '#c2cfda'], veg: ['#3a2b14', '#e0a040', '#ffd08a'], animal: ['#3a2619', '#d08a66', '#f1c0a6'], plant: ['#24331a', '#8cc25a', '#c4e89a'] },
      item: { wood: ['#3a2c1e', '#e0b27a'], stone: ['#2a323b', '#b7c4cf'], veg: ['#3a2b14', '#ffd08a'], meat: ['#3d2220', '#f2a89c'], snow: ['#1a2e44', '#8ec3f5'], sapling: ['#1a3326', '#8fe0b3'] },
      tint: { clear: 'rgba(0,0,0,0)', snow: 'rgba(150,185,225,0.07)', blizzard: 'rgba(170,200,235,0.16)', rain: 'rgba(40,80,140,0.22)', storm: 'rgba(190,215,245,0.26)' },
      flake: '#b8d4ee', rain: '#6f9fd0',
    },
  };
  const PLAYER_COLORS = { blue: '#2f6fb5', purple: '#8059c4', green: '#2e8a74', orange: '#c26a2a', rose: '#b8467a' };
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
      s.press = { vx: v.x, vy: v.y, kind: (me && tx === me.x && ty === me.y) ? 'pawn' : 'pan', cam0: { x: s.cam.x, y: s.cam.y }, moved: false };
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
      if (!s.press) {
        if (!s.hover || s.hover.x !== tx || s.hover.y !== ty) { s.hover = { x: tx, y: ty }; o.onHover(E.bAt(g, tx, ty), v); board.request(); }
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
        if (d.ok) o.onMove(d.x, d.y);
        else if (d.why && d.why !== 'いまいるマスです') o.onMoveFail(d.why);
        return;
      }
      if (pr.moved) return;
      const v = pos(e), w = toWorld(v.x, v.y), tx = Math.floor(w.x), ty = Math.floor(w.y);
      if (pr.kind === 'pawn') { o.onPawn(); return; }
      const b = E.bAt(g, tx, ty);
      o.onBackground(b);
    }
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', () => { s.press = null; s.drag = null; s.cur = null; o.onDrag(null); board.request(); });
    cv.addEventListener('pointerleave', () => { if (s.hover) { s.hover = null; o.onHover(null); board.request(); } });
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
      const M = E.RULES.moveRange;
      for (const b of g.b) ctx.fillRect(X(b.x - M), Y(b.y - M), (b.w + 2 * M) * S, (b.h + 2 * M) * S);
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

      // 道（隣り合う道は一つにつながって見える）
      const road = (x, y) => g.b.some(q => q.t === 'road' && q.x === x && q.y === y);
      for (const b of g.b) {
        if (b.t !== 'road' || !vis(b.x, b.y)) continue;
        const n = road(b.x, b.y - 1), e = road(b.x + 1, b.y), so = road(b.x, b.y + 1), w = road(b.x - 1, b.y);
        const x = X(b.x), y = Y(b.y), r = 10 * z;
        const rad = (a, c) => ((!a && !c) ? r : 0);
        ctx.fillStyle = th.road;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, S, S, [rad(n, w), rad(n, e), rad(so, e), rad(so, w)]); ctx.fill(); } else ctx.fillRect(x, y, S, S);
        ctx.strokeStyle = th.roadBd; ctx.lineWidth = 3 * z; ctx.lineCap = 'butt'; ctx.beginPath();
        const h = 1.5 * z;
        if (!n) { ctx.moveTo(x, y + h); ctx.lineTo(x + S, y + h); }
        if (!so) { ctx.moveTo(x, y + S - h); ctx.lineTo(x + S, y + S - h); }
        if (!w) { ctx.moveTo(x + h, y); ctx.lineTo(x + h, y + S); }
        if (!e) { ctx.moveTo(x + S - h, y); ctx.lineTo(x + S - h, y + S); }
        ctx.stroke();
        if (o.sel() === b.id) { ctx.strokeStyle = th.accent; ctx.lineWidth = 3 * z; rr(ctx, x + 1.5, y + 1.5, S - 3, S - 3, 4 * z); ctx.stroke(); }
      }

      // 建物
      for (const b of g.b) {
        if (b.t === 'road' || !(b.x <= vx1 && b.x + b.w >= vx0 && b.y <= vy1 && b.y + b.h >= vy0)) continue;
        const isFire = b.t === 'fire', warm = b.t === 'igloo' || b.t === 'storage', ins = E.insul(b), lost = warm && !ins;
        const col = th.card[lost ? 'off' : b.t];
        const x = X(b.x) + 3 * z, y = Y(b.y) + 3 * z, w = b.w * S - 6 * z, h = b.h * S - 6 * z;
        ctx.fillStyle = col[0]; rr(ctx, x, y, w, h, 10 * z); ctx.fill();
        ctx.strokeStyle = col[1]; ctx.lineWidth = 2 * z; rr(ctx, x, y, w, h, 10 * z); ctx.stroke();
        if (o.sel() === b.id) { ctx.strokeStyle = th.accent; ctx.lineWidth = 3 * z; rr(ctx, x - 2 * z, y - 2 * z, w + 4 * z, h + 4 * z, 12 * z); ctx.stroke(); }
        if (z < 0.5) continue;
        const px = x + 8 * z; let py = y + 7 * z + 9 * z;
        icon(ctx, b.t, px + 9 * z, py, 18 * z, col[2]);
        text(({ fire: '焚き火', igloo: 'かまくら', storage: '倉庫', tower: '見張り台' })[b.t], px + 24 * z, py, 13 * z, col[2], 700);
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
      for (const k of Object.keys(g.res)) { const [x, y] = E.parseKey(k); put(x, y, { kind: g.res[k].t, frac: g.res[k].hp / (g.res[k].max || E.RULES.resHpMax) }); }
      for (const p of g.plants) put(p.x, p.y, { kind: 'plant', badge: '苗' });
      for (const a of g.animals) put(a.x, a.y, { kind: 'animal', frac: a.hp / (a.max || E.RULES.animalHpMax) });
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
            pawn(ox + ax * z, oy + ay * z, 26 * z, PLAYER_COLORS[p.color] || '#888', p.no, me && p.id === me.id, th, p.down > 0);
            ctx.globalAlpha = 1;
          } else {
            const [ax, ay] = n === 1 ? [11, 11] : (entIdx++ === 0 ? [T - 33, 3] : [3, 3]);
            entity(ox + ax * z, oy + ay * z, 30 * z, v.kind, v.badge, v.frac, th);
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
          pawn(X(d.wx) - 15 * z, Y(d.wy) - 15 * z, 30 * z, th.accent, me.no, true, th, false);
          ctx.globalAlpha = 1;
        }
      }
    };

    function pawn(x, y, size, color, no, mine, th, down) {
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, 7); ctx.fill();
      if (mine) { ctx.strokeStyle = th.text; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 + 2, 0, 7); ctx.stroke(); }
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 - 1, 0, 7); ctx.stroke();
      text(String(no), x + size / 2, y + size / 2 + 1, size * 0.5, '#fff', 700, 'center');
      if (down) { ctx.fillStyle = 'rgba(15,22,32,.6)'; ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2 - 1, 0, 7); ctx.fill(); text('zz', x + size / 2, y + size / 2, size * 0.42, '#fff', 700, 'center'); }
    }
    // 資源・動物：円の下に体力のゲージ（苗は「苗」の札）
    function entity(x, y, size, kind, badge, frac, th) {
      const c = th.res[kind];
      ctx.fillStyle = c[0]; ctx.beginPath(); ctx.arc(x + size / 2, y + size / 2, size / 2, 0, 7); ctx.fill();
      ctx.strokeStyle = c[1]; ctx.lineWidth = Math.max(1, size / 15); ctx.stroke();
      icon(ctx, kind, x + size / 2, y + size / 2, size * 0.57, c[2]);
      if (frac != null) {
        const w = size * 0.86, h = size * 0.2, gx = x + (size - w) / 2, gy = y + size - h * 0.6;
        ctx.fillStyle = '#0f1620'; rr(ctx, gx - 1, gy - 1, w + 2, h + 2, h / 2 + 1); ctx.fill();
        ctx.fillStyle = frac > 0.5 ? th.hpOk : th.hpLow;
        rr(ctx, gx, gy, Math.max(h, w * Math.max(0, Math.min(1, frac))), h, h / 2); ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 1; rr(ctx, gx - 1, gy - 1, w + 2, h + 2, h / 2 + 1); ctx.stroke();
      } else if (badge) {
        ctx.font = `700 ${size * 0.4}px ${FONT}`;
        const w = Math.max(size * 0.53, ctx.measureText(badge).width + size * 0.2);
        const bx = x + size - w + size * 0.23, by = y + size - size * 0.3;
        ctx.fillStyle = '#0f1620'; rr(ctx, bx, by, w, size * 0.53, size * 0.27); ctx.fill();
        text(badge, bx + w / 2, by + size * 0.28, size * 0.4, '#fff', 700, 'center');
      }
    }

    if (window.ResizeObserver) new ResizeObserver(() => board.resize()).observe(cv);
    window.addEventListener('resize', () => board.resize());
    return board;
  }

  window.SnowBoard = { create, THEMES, PLAYER_COLORS, ICONS, ITEM_ICON, svgIcon, T };
})();
