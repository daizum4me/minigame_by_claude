/*
 * Cocage — 盤面の描画（canvas）と操作
 * 暗い背景に、六角形のセルと細い線だけで描く。動くのは、点数を稼いだ葉から数字がこぼれる演出と、そのあとの枝が折れる演出だけ。
 * 数値は六角形の外接円の半径 S（= 2k）を基準にする。座標は engine.js と同じ整数座標（1 = k）。
 * 盤面は左右がつながった横ループ。ホイールで拡縮、ドラッグで移動（横はループ）。ピンチでも拡縮できる。
 *
 * new CocageBoard(canvas, { onHover(info|null, x, y), onPick({ t:'b'|'l', key }), onCancel(index) })
 *   onCancel：右クリックで、置いた計画の何番目か（-1 はどこにも当たらなかった）
 * setData({ game, me, overlay, colors, candidates })
 * playTurn(items, lastTurn)：ターンが解決されたときに呼ぶ。数字がこぼれ、そのあとに枝が折れる
 */
(function () {
  'use strict';

  const E = window.CocageEngine;
  const SQRT3 = Math.sqrt(3);
  const MARGIN = 14;           // 台のふちとセルの余白
  const LABEL_H = 34;          // 盤面の下の、幹の名前の置き場
  const PART_MS = 1300;        // こぼれる数字が消えるまで
  const BREAK_MS = 1500;       // 枝が折れる演出の長さ（数字がこぼれたあとに始まる）
  const EDGE_MS = 800;         // 1本の枝が折れる時間
  const TOP_RESERVE = 46;      // 上のバー（ターン・表示切り替え）の分
  const ZOOM_MAX = 6;

  const COL = { page: '#1F1F1D', frame: '#2A2A28', cell: '#3A3A38', edge: '#56554F', text: '#E9E7E0', muted: '#9A988F', broken: '#FF9C94', hot: '#FF6E64', trunkGray: '#8A8880' };
  const FONT = '"Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif';

  const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r},${g},${b},${a})`; };
  const lighten = (c, f) => { const [r, g, b] = hex(c); const m = v => Math.round(v + (255 - v) * f); return `rgb(${m(r)},${m(g)},${m(b)})`; };
  const mix = (c1, c2, t) => { const a = hex(c1), b = hex(c2); return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  // 緑 → 黄 → 赤
  function heat(t) {
    t = clamp(t, 0, 1);
    return t < 0.5 ? mix('#7BD39A', '#FFD36B', t / 0.5) : mix('#FFD36B', '#FF6E64', (t - 0.5) / 0.5);
  }

  // キーから、いつも同じになる乱数（折れた枝のかけらの飛び方）
  function rnd(key, i) {
    let h = 0;
    for (let j = 0; j < key.length; j++) h = (h * 31 + key.charCodeAt(j)) >>> 0;
    const x = Math.sin(h * 12.9898 + i * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  class CocageBoard {
    constructor(canvas, handlers) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.h = handlers || {};
      this.data = null;
      this.pan = 0;               // 横の回転（x の単位。ループ）
      this.panY = 0;              // 縦の移動（px。拡大して盤面が縦にはみ出すときだけ）
      this.zoom = 1;
      this.panInit = false;
      this.k = 8;
      this.hover = null;          // { edge, cand }
      this.drag = null;
      this.pointers = new Map();
      this.pinch = null;
      this.raf = 0;
      this.dpr = 1;
      this.parts = [];            // こぼれる数字
      this.fx = null;             // 枝が折れる演出 { breakAt, lt }
      canvas.view = this;         // テストや調べもの用
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(canvas.parentElement || canvas);
      canvas.addEventListener('pointerdown', e => this.onDown(e));
      canvas.addEventListener('pointermove', e => this.onMove(e));
      canvas.addEventListener('pointerup', e => this.onUp(e));
      canvas.addEventListener('pointercancel', e => { this.pointers.delete(e.pointerId); this.drag = null; this.pinch = null; });
      canvas.addEventListener('pointerleave', () => { if (!this.drag) this.setHover(null); });
      canvas.addEventListener('wheel', e => this.onWheel(e), { passive: false });
      canvas.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (!this.data || !this.geo) return;
        const [x, y] = this.local(e);
        if (this.h.onCancel) this.h.onCancel(this.planHit(x, y));
      });
      this.resize();
    }

    setData(d) {
      const prev = this.data;
      this.data = d;
      if (d && d.game) {
        this.geo = E.geometry(d.game.cols);
        this.W = 3 * d.game.cols;
        if (!prev || !prev.game || prev.game.cols !== d.game.cols || !this.panInit) { this.zoom = 1; this.panY = 0; this.layout(); this.centerOn(d.me); this.panInit = true; }
        this.score = E.scoreBoard(d.game);
      }
      this.layout();
      this.redraw();
    }

    // 自分の幹が画面の中央に来るように回す
    centerOn(id) {
      const g = this.data && this.data.game;
      if (!g) return;
      const p = g.players.find(x => x.id === id) || g.players[0];
      const col = E.geometry(g.cols).trunks[p.trunk].col;
      this.setPan((this.cw / 2 - this.left) / this.k - (3 * col + 1.5));   // 幹の真ん中が画面の中央に来る
      this.hover = null;
      this.redraw();
    }

    // 全体が見えるところ（拡大を戻す）
    fit() {
      this.zoom = 1;
      this.panY = 0;
      this.layout();
      this.centerOn(this.data && this.data.me);
    }

    setPan(v) { this.pan = this.W ? ((v % this.W) + this.W) % this.W : v; }

    resize() {
      const r = (this.canvas.parentElement || this.canvas).getBoundingClientRect();
      const cw = Math.max(200, Math.floor(r.width)), ch = Math.max(200, Math.floor(r.height));
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.style.width = cw + 'px';
      this.canvas.style.height = ch + 'px';
      this.canvas.width = Math.floor(cw * this.dpr);
      this.canvas.height = Math.floor(ch * this.dpr);
      this.cw = cw; this.ch = ch;
      this.layout();
      this.redraw();
    }

    // 台の大きさとセルの大きさ。拡大していないときは、幅と高さの両方に収まる大きさ
    layout() {
      if (!this.data || !this.data.game) return;
      const vw = this.cw - 16;
      this.availTop = TOP_RESERVE;
      this.availH = this.ch - TOP_RESERVE - 8;
      const kx = (vw - 2 * MARGIN) / this.W;
      const ky = (this.availH - 2 * MARGIN - LABEL_H) / (37 * SQRT3);
      this.k0 = Math.max(2.5, Math.min(kx, ky, 20));
      this.k = this.k0 * this.zoom;
      this.S = this.k * 2;
      this.hu = SQRT3 * this.k;                       // 高さの単位
      this.boardW = this.W * this.k + 2 * MARGIN;
      this.boardH = 37 * this.hu + 2 * MARGIN + LABEL_H;
      this.clipW = Math.min(this.boardW, vw);
      this.bx = Math.round((this.cw - this.clipW) / 2);
      if (this.boardH <= this.availH + 0.5) {
        this.panY = 0;
        this.by = this.availTop + Math.round((this.availH - this.boardH) / 2);
      } else {
        this.panY = clamp(this.panY, this.availH - this.boardH, 0);
        this.by = this.availTop + this.panY;
      }
      this.left = this.bx + MARGIN;                   // x = 0 の位置（pan を足す）
    }

    px(x, dx) { return this.left + (x + this.pan + dx) * this.k; }
    py(y) { return this.by + MARGIN + (36 - y) * this.hu; }
    wrapD(d) { return d > this.W / 2 ? d - this.W : d < -this.W / 2 ? d + this.W : d; }

    // 画面の点 (mx, my) を動かさずに、拡大率を factor 倍する
    zoomAt(mx, my, factor) {
      if (!this.data || !this.data.game) return;
      const xu = (mx - this.left) / this.k - this.pan;
      const yu = 36 - (my - (this.by + MARGIN)) / this.hu;
      this.zoom = clamp(this.zoom * factor, 1, ZOOM_MAX);
      this.layout();
      this.setPan((mx - this.left) / this.k - xu);
      if (this.boardH > this.availH + 0.5) {
        this.panY = my - MARGIN - (36 - yu) * this.hu - this.availTop;
        this.layout();
      }
      this.hover = null;
      this.redraw();
    }

    // ---------- 操作 ----------

    local(e) {
      const r = this.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    onWheel(e) {
      e.preventDefault();
      if (!this.data || !this.data.game) return;
      const [x, y] = this.local(e);
      if (!e.deltaY) return;
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 0.5 : 0.0016;
      this.zoomAt(x, y, Math.exp(-e.deltaY * unit));
      this.setHover(null);
    }

    onDown(e) {
      if (!this.data || e.button > 0) return;     // 右クリックは取り消し（contextmenu）で扱う
      const [x, y] = this.local(e);
      this.pointers.set(e.pointerId, { x, y });
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
        this.drag = null;
        return;
      }
      this.drag = { x0: x, y0: y, pan0: this.pan, panY0: this.panY, moved: false };
    }

    onMove(e) {
      const [x, y] = this.local(e);
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x, y });
      if (this.pinch && this.pointers.size >= 2) {
        const [a, b] = [...this.pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
        this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / this.pinch.d);
        this.pinch.d = d;
        return;
      }
      const d = this.drag;
      if (d) {
        if (!d.moved && Math.hypot(x - d.x0, y - d.y0) > 6) d.moved = true;
        if (d.moved) {
          this.setPan(d.pan0 + (x - d.x0) / this.k);
          this.panY = d.panY0 + (y - d.y0);
          this.layout();
          this.setHover(null);
          this.redraw();
        }
        return;
      }
      if (this.pointers.size === 0) this.setHover(this.hit(x, y), x, y);
    }

    onUp(e) {
      this.pointers.delete(e.pointerId);
      if (this.pinch) { if (this.pointers.size < 2) this.pinch = null; this.drag = null; return; }
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved) return;
      const [x, y] = this.local(e);
      const h = this.hit(x, y);
      if (h && h.cand && this.h.onPick) this.h.onPick(h.cand);
    }

    setHover(h, x, y) {
      const same = (a, b) => (a && a.edge) === (b && b.edge) && (a && a.cand && a.cand.key) === (b && b.cand && b.cand.key);
      const changed = !same(h, this.hover);
      this.hover = h;
      if (this.h.onHover && (changed || h)) this.h.onHover(h, x, y);
      if (changed) this.redraw();
    }

    // 点 (x, y) から辺（線分）までの距離（ループのつなぎ目をまたぐ分も見る）
    distToEdge(ek, x, y) {
      const e = this.geo.edges[ek];
      const a = this.geo.verts[e.a], b = this.geo.verts[e.b];
      const bxu = a.x + this.wrapD(b.x - a.x);
      let best = Infinity;
      for (const m of [-1, 0, 1]) {
        const dx = m * this.W;
        const x1 = this.px(a.x, dx), y1 = this.py(a.y), x2 = this.px(bxu, dx), y2 = this.py(b.y);
        const vx = x2 - x1, vy = y2 - y1, L2 = vx * vx + vy * vy || 1;
        const t = clamp(((x - x1) * vx + (y - y1) * vy) / L2, 0, 1);
        best = Math.min(best, Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy)));
      }
      return best;
    }

    distToCell(ck, x, y) {
      const c = this.geo.cells[ck];
      let best = Infinity;
      for (const m of [-1, 0, 1]) best = Math.min(best, Math.hypot(x - this.px(c.x, m * this.W), y - this.py(c.y)));
      return best;
    }

    // 点にあるもの：置ける辺・セル（cand。辺が近ければ枝、そうでなければ葉）と、合わせると折れやすさを見られる辺（edge）
    hit(x, y) {
      const d = this.data;
      if (!d || !d.game || !this.geo) return null;
      const thr = Math.max(7, this.S * 0.3);
      const out = { edge: null, cand: null };
      if (d.candidates) {
        // 1) 光っている線のすぐそばなら枝 → 2) 光っている葉の六角形の中なら葉 → 3) 線の少し遠く → 4) セルの中のその他
        const nearEdge = lim => {
          let best = lim, hit = null;
          for (const ek of d.candidates.edges) { const dist = this.distToEdge(ek, x, y); if (dist < best) { best = dist; hit = { t: 'b', key: ek }; } }
          return hit;
        };
        const inCell = r => {
          let best = r, hit = null;
          for (const ck of d.candidates.cells) { const dist = this.distToCell(ck, x, y); if (dist < best) { best = dist; hit = { t: 'l', key: ck }; } }
          return hit;
        };
        out.cand = nearEdge(Math.max(4, this.S * 0.14)) || inCell(this.S * 0.68) || nearEdge(thr) || inCell(this.S * 0.87);
      }
      let best = thr;
      const g = d.game;
      for (const ek of Object.keys(g.edges)) { const dist = this.distToEdge(ek, x, y); if (dist < best) { best = dist; out.edge = ek; } }
      for (const p of g.players) {
        const tr = this.geo.trunks[p.trunk];
        for (let i = 1; i <= p.trunkLen; i++) { const dist = this.distToEdge(tr.edges[i], x, y); if (dist < best) { best = dist; out.edge = tr.edges[i]; } }
      }
      return out.edge || out.cand ? out : null;
    }

    // 点にある、自分の計画（何番目か。なければ -1）。葉の六角形の中なら葉、線のそばなら枝（置くときの判定と同じ順）
    planHit(x, y) {
      const g = this.data.game, me = g.players.find(p => p.id === this.data.me);
      if (!me) return -1;
      const nearest = (type, lim) => {
        let best = -1, bestD = lim;
        me.plan.forEach((it, i) => {
          if (it.t !== type) return;
          const dist = type === 'b' ? this.distToEdge(it.e, x, y) : this.distToCell(it.c, x, y);
          if (dist < bestD) { bestD = dist; best = i; }
        });
        return best;
      };
      const thr = Math.max(8, this.S * 0.35);
      const a = nearest('b', Math.max(4, this.S * 0.14));
      if (a >= 0) return a;
      const b = nearest('l', this.S * 0.68);
      if (b >= 0) return b;
      const c = nearest('b', thr);
      if (c >= 0) return c;
      return nearest('l', this.S * 0.87);
    }

    // ---------- 演出 ----------

    // ターンが解決された：点数を稼いだ葉から数字が1つこぼれ、そのあとで枝が折れる
    playTurn(items, lt) {
      if (reduced()) { this.fx = null; this.redraw(); return; }
      const now = performance.now();
      for (const it of items) {
        this.parts.push({
          cell: it.cell, color: it.color, text: String(Math.round(it.pts * 10) / 10), t0: now,
          vx: (Math.random() - 0.5) * 3.2, vy: -(2.6 + Math.random() * 1.6),   // 1 = セルの半径あたり / 秒
        });
      }
      this.fx = lt && (lt.removed.length || (lt.removedLeafList || []).length) ? { breakAt: now + PART_MS, lt } : null;
      this.redraw();
    }

    // ---------- 描画 ----------

    redraw() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
    }

    hexPath(ctx, cx, cy, r) {
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i;
        const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a);
        if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      }
      ctx.closePath();
    }

    // 数字（自分の明るい色）
    scoreText(ctx, text, x, y, color, size, alpha) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = `800 ${Math.max(7, size)}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = lighten(color, 0.55);
      ctx.fillText(text, x, y);
      ctx.restore();
    }

    // 辺の端の座標（ループのつなぎ目をまたぐ辺も、短いほうでつなぐ）
    edgePts(ek, dx) {
      const e = this.geo.edges[ek];
      const a = this.geo.verts[e.a], b = this.geo.verts[e.b];
      const bxu = a.x + this.wrapD(b.x - a.x);
      return [this.px(a.x, dx), this.py(a.y), this.px(bxu, dx), this.py(b.y)];
    }

    line(ctx, ek, dx) {
      const [x1, y1, x2, y2] = this.edgePts(ek, dx);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }

    // 折れやすさの値（オーバーレイ用）を辺ごとに出す
    edgeValues(g, kind) {
      const vals = {};
      let max = 1e-12;
      for (const ek of Object.keys(g.edges)) {
        const st = E.edgeStats(g, ek, 10);
        const v = kind === 'p' ? st.p : st.expectedLoss;
        vals[ek] = v;
        if (v > max) max = v;
      }
      return { vals, max };
    }

    // 葉を描く（得点の輪や数字はつけない）
    drawLeaf(ctx, x, y, color, scale, alpha, stroke, lw) {
      ctx.save();
      ctx.globalAlpha = alpha;
      this.hexPath(ctx, x, y, this.S * 0.78 * scale);
      ctx.fillStyle = rgba(color, 0.45);
      ctx.fill();
      ctx.lineWidth = lw || 2;
      ctx.strokeStyle = stroke || color;
      ctx.stroke();
      ctx.restore();
    }

    // 枝が折れる演出：t = 折れ始めてからの時間（ms）。折れた枝はかけらになって落ち、折れた場所に×と「折れた！」が出る
    drawBreak(ctx, dx, t, colors, inView) {
      const lt = this.data.game.lastTurn, S = this.S;
      const base = Math.min(...lt.removed.map(r => r.l), 99);
      for (const r of lt.removed) {
        const delay = r.primary ? 0 : 140 + 80 * Math.min(5, r.l - base);
        const u = (t - delay) / EDGE_MS;
        const [x1, y1, x2, y2] = this.edgePts(r.key, dx);
        const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        if (!inView(mx)) continue;
        ctx.setLineDash([]);
        if (u < 0) { ctx.strokeStyle = colors[r.owner]; ctx.lineWidth = 2.4; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); continue; }
        if (u < 0.25) {
          // ぴかっと光る（白く太く、赤くにじむ）
          ctx.save();
          ctx.shadowColor = COL.hot; ctx.shadowBlur = S * 1.3;
          ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3 + 4 * (u / 0.25);
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          ctx.restore();
        } else if (u < 1) {
          // 3つに割れて、落ちながら消える
          const v = (u - 0.25) / 0.75;
          ctx.lineWidth = 3;
          for (let i = 0; i < 3; i++) {
            const a0 = i / 3, a1 = (i + 1) / 3;
            const cx = x1 + (x2 - x1) * (a0 + a1) / 2, cy = y1 + (y2 - y1) * (a0 + a1) / 2;
            const ox = (rnd(r.key, i) - 0.5) * S * 1.8 * v, oy = (rnd(r.key, i + 5) * 0.6 + 0.2) * S * 1.2 * v + v * v * S * 2.4;
            const ang = (rnd(r.key, i + 9) - 0.5) * 2.4 * v;
            const hx = (x2 - x1) / 6, hy = (y2 - y1) / 6;
            const c = Math.cos(ang), s2 = Math.sin(ang);
            ctx.strokeStyle = COL.broken;
            ctx.globalAlpha = Math.max(0, 1 - Math.pow(v, 1.6));
            ctx.beginPath();
            ctx.moveTo(cx + ox - (hx * c - hy * s2), cy + oy - (hx * s2 + hy * c));
            ctx.lineTo(cx + ox + (hx * c - hy * s2), cy + oy + (hx * s2 + hy * c));
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        }
        if (r.primary && u >= 0 && u < 1.2) {
          // 折れたところに、広がる赤い輪・×・「折れた！」（読みやすいように、暗い台の上に出す）
          const pop = clamp(u * 5, 0, 1), fade = u < 0.7 ? 1 : clamp(1 - (u - 0.7) / 0.5, 0, 1);
          const size = (5 + 7 * pop) * Math.max(1, S / 16);
          ctx.save();
          ctx.globalAlpha = fade * (1 - clamp(u, 0, 1) * 0.5);
          ctx.strokeStyle = COL.hot; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(mx, my, S * (0.4 + 1.8 * clamp(u * 1.6, 0, 1)), 0, Math.PI * 2); ctx.stroke();
          ctx.globalAlpha = fade;
          ctx.lineWidth = 3.8;
          ctx.beginPath();
          ctx.moveTo(mx - size, my - size); ctx.lineTo(mx + size, my + size);
          ctx.moveTo(mx + size, my - size); ctx.lineTo(mx - size, my + size);
          ctx.stroke();
          const fs = Math.max(13, S * 0.95), ty = my - size - S * 0.9 - u * S * 0.5;
          ctx.font = `800 ${fs}px ${FONT}`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          const tw = ctx.measureText('折れた！').width + fs * 0.9;
          ctx.fillStyle = 'rgba(17,17,16,0.82)';
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(mx - tw / 2, ty - fs * 0.75, tw, fs * 1.5, fs * 0.45); else ctx.rect(mx - tw / 2, ty - fs * 0.75, tw, fs * 1.5);
          ctx.fill();
          ctx.fillStyle = COL.broken;
          ctx.fillText('折れた！', mx, ty + fs * 0.04);
          ctx.restore();
        }
      }
      // 一緒に消える葉：縮みながら赤くなって消える
      for (const lf of lt.removedLeafList || []) {
        const c = this.geo.cells[lf.cell];
        const x = this.px(c.x, dx), y = this.py(c.y);
        if (!inView(x)) continue;
        const w = clamp((t - 200) / 800, 0, 1);
        if (w >= 1) continue;
        this.drawLeaf(ctx, x, y, colors[lf.owner], 1 - 0.4 * w, 1 - w, mix(colors[lf.owner], COL.broken, 0.4 + 0.6 * w), 2.4);
      }
    }

    draw() {
      const ctx = this.ctx, d = this.data;
      if (!this.dpr) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = COL.page;
      ctx.fillRect(0, 0, this.cw, this.ch);
      if (!d || !d.game || !this.geo) return;
      const g = d.game, geo = this.geo, S = this.S;
      const colors = d.colors;
      const nowT = performance.now();

      // 台（角丸16）
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(this.bx, this.by, this.clipW, this.boardH, 16); else ctx.rect(this.bx, this.by, this.clipW, this.boardH);
      ctx.fillStyle = COL.frame;
      ctx.fill();

      // 台の中だけに描く（左右のつなぎ目の向こう側は、反対側が見える）
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.bx + 1, this.by + 1, this.clipW - 2, this.boardH - 2);
      ctx.clip();

      const overlay = d.overlay || 'normal';
      const ov = overlay === 'normal' ? null : this.edgeValues(g, overlay === 'p' ? 'p' : 'loss');
      const { points, tops } = this.score;
      const topCells = new Set(Object.values(tops).map(t => t.cell));
      const hoverEdge = this.hover && this.hover.edge;
      const plan = (g.players.find(p => p.id === d.me) || {}).plan || [];

      // 枝が折れる演出の段階：pre（数字がこぼれているあいだ。まだ折れていないように見せる）→ anim → 静止（赤い点線）
      const lt = g.lastTurn;
      const fresh = lt && lt.turn === g.round;
      let phase = 'static', bt = 0;
      if (this.fx && (!fresh || this.fx.lt.turn !== lt.turn)) this.fx = null;
      if (this.fx) {
        if (nowT < this.fx.breakAt) phase = 'pre';
        else if (nowT < this.fx.breakAt + BREAK_MS) { phase = 'anim'; bt = nowT - this.fx.breakAt; }
        else this.fx = null;
      }

      for (const dx of [-this.W, 0, this.W]) {
        const inView = x => x > this.bx - S * 2 && x < this.bx + this.clipW + S * 2;
        const inViewY = y => y > -S * 2 && y < this.ch + S * 2;
        // セル
        ctx.lineWidth = 1;
        ctx.strokeStyle = COL.edge;
        ctx.fillStyle = COL.cell;
        for (const c of Object.values(geo.cells)) {
          const cx = this.px(c.x, dx), cy = this.py(c.y);
          if (!inView(cx) || !inViewY(cy)) continue;
          this.hexPath(ctx, cx, cy, S);
          ctx.fill(); ctx.stroke();
        }
        const cellXY = ck => { const c = geo.cells[ck]; return [this.px(c.x, dx), this.py(c.y)]; };

        // 葉
        for (const [ck, lf] of Object.entries(g.leaves)) {
          const [x, y] = cellXY(ck);
          if (!inView(x) || !inViewY(y)) continue;
          const color = colors[lf.owner];
          const isNew = g.round > 0 && lf.round === g.round;
          this.drawLeaf(ctx, x, y, color, 1, 1, isNew ? '#FFFFFF' : color, isNew ? 2.4 : 2);
          if (topCells.has(ck)) {
            this.hexPath(ctx, x, y, S * 0.67);
            ctx.lineWidth = S * 0.2;
            ctx.strokeStyle = lighten(color, 0.55);
            ctx.globalAlpha = 0.6;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
          // 点数を稼いでいる葉すべてに、点数（自分の明るい色）
          if (points[ck] > 0) this.scoreText(ctx, String(Math.round(points[ck] * 10) / 10), x, y + S * 0.03, color, S * 0.4, 1);
        }
        // 折れる前（数字がこぼれているあいだ）は、これから折れる葉も残して見せる
        if (phase === 'pre') for (const lf of lt.removedLeafList || []) {
          const [x, y] = cellXY(lf.cell);
          if (inView(x) && inViewY(y)) this.drawLeaf(ctx, x, y, colors[lf.owner], 1, 1, colors[lf.owner], 2);
        }

        // 幹（根から今の長さまで）。次に伸びる1辺は点線
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        for (const p of g.players) {
          const tr = geo.trunks[p.trunk], color = colors[p.id];
          ctx.setLineDash([]);
          ctx.lineWidth = 2.4;
          ctx.strokeStyle = overlay === 'normal' ? color : COL.trunkGray;
          for (let i = 1; i <= p.trunkLen; i++) this.line(ctx, tr.edges[i], dx);
          if (!g.over && p.trunkLen < tr.edges.length - 1) {
            ctx.strokeStyle = overlay === 'normal' ? color : COL.trunkGray;
            ctx.setLineDash([1.5, 6]);
            this.line(ctx, tr.edges[p.trunkLen + 1], dx);
            ctx.setLineDash([]);
          }
        }

        // 枝
        for (const [ek, e] of Object.entries(g.edges)) {
          ctx.lineWidth = 2.4;
          ctx.setLineDash([]);
          ctx.strokeStyle = ov ? heat(ov.vals[ek] / ov.max) : colors[e.owner];
          this.line(ctx, ek, dx);
        }

        // 折れた枝
        if (fresh) {
          if (phase === 'pre') {
            ctx.lineWidth = 2.4; ctx.setLineDash([]);
            for (const r of lt.removed) { ctx.strokeStyle = colors[r.owner]; this.line(ctx, r.key, dx); }
          } else if (phase === 'anim') {
            this.drawBreak(ctx, dx, bt, colors, inView);
          } else {
            // 折れたターンのあいだ、赤い点線で残す
            ctx.strokeStyle = COL.broken;
            ctx.lineWidth = 3;
            ctx.setLineDash([3, 4]);
            for (const r of lt.removed) this.line(ctx, r.key, dx);
            ctx.setLineDash([]);
          }
          // 抽選に負けた行動：その場所に×
          for (const l of lt.lost) {
            let x, y;
            if (l.t === 'b') { const [x1, y1, x2, y2] = this.edgePts(l.key, dx); x = (x1 + x2) / 2; y = (y1 + y2) / 2; } else [x, y] = cellXY(l.key);
            if (!inView(x)) continue;
            ctx.strokeStyle = colors[l.owner];
            ctx.lineWidth = 2.4;
            ctx.beginPath();
            ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5);
            ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
            ctx.stroke();
          }
        }

        // 今置けるところ：白いハイライト（辺は枝、セルは葉）
        const mycol = colors[d.me] || '#FFFFFF';
        const hv = this.hover;
        if (d.candidates) {
          ctx.setLineDash([]);
          ctx.lineWidth = 3.4; ctx.strokeStyle = 'rgba(255,255,255,0.62)';
          for (const ek of d.candidates.edges) this.line(ctx, ek, dx);
          for (const ck of d.candidates.cells) {
            const [x, y] = cellXY(ck);
            if (!inView(x) || !inViewY(y)) continue;
            this.hexPath(ctx, x, y, S * 0.78);
            ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fill();
            ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.stroke();
          }
          if (hv && hv.cand) {
            if (hv.cand.t === 'b') { ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 4.6; this.line(ctx, hv.cand.key, dx); }
            else {
              const [x, y] = cellXY(hv.cand.key);
              if (inView(x)) { this.hexPath(ctx, x, y, S * 0.78); ctx.fillStyle = 'rgba(255,255,255,0.26)'; ctx.fill(); ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2.6; ctx.stroke(); }
            }
          }
        }
        // 自分の計画（ほかの人には見えない）
        plan.forEach((it, i) => {
          let x, y;
          ctx.setLineDash([5, 4]); ctx.lineWidth = 2.4; ctx.strokeStyle = mycol;
          if (it.t === 'b') {
            this.line(ctx, it.e, dx);
            const [x1, y1, x2, y2] = this.edgePts(it.e, dx); x = (x1 + x2) / 2; y = (y1 + y2) / 2;
          } else {
            [x, y] = cellXY(it.c);
            if (inView(x)) { this.hexPath(ctx, x, y, S * 0.78); ctx.fillStyle = rgba(mycol, 0.18); ctx.fill(); ctx.stroke(); }
          }
          ctx.setLineDash([]);
          if (inView(x)) {
            ctx.fillStyle = '#FFFFFF';
            ctx.font = `700 ${Math.max(9, S * 0.55)}px ${FONT}`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.lineWidth = 3;
            ctx.strokeText(String(i + 1), x, y);
            ctx.fillText(String(i + 1), x, y);
          }
        });
        // 合わせている枝（折れやすさを見ている）
        if (hoverEdge) {
          ctx.setLineDash([]);
          ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3.6;
          this.line(ctx, hoverEdge, dx);
        }

        // こぼれる数字：上へはじけてから、重力で落ちながら消える
        for (const q of this.parts) {
          const age = (nowT - q.t0) / PART_MS;
          if (age <= 0 || age >= 1 || !geo.cells[q.cell]) continue;
          const [cx, cy] = cellXY(q.cell);
          if (!inView(cx)) continue;
          const t = age * PART_MS / 1000;
          const x = cx + q.vx * S * t, y = cy + (q.vy * t + 5 * t * t) * S;
          this.scoreText(ctx, q.text, x, y, q.color, Math.max(10, S * 0.5), Math.min(1, (1 - age) * 1.6));
        }

        // 幹の名前（真下）
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        g.players.forEach(p => {
          const tr = geo.trunks[p.trunk];
          const x = this.px(3 * tr.col + 1.5, dx);
          if (!inView(x)) return;
          ctx.fillStyle = colors[p.id];
          ctx.font = `800 ${Math.max(10, Math.min(15, S * 0.8))}px ${FONT}`;
          const nm = Array.from(p.name).slice(0, 7).join('');
          ctx.fillText(`P${p.trunk + 1} ${nm}`, x, this.by + MARGIN + 37 * this.hu + LABEL_H * 0.55);
        });
      }
      ctx.restore();
      // 演出が残っているあいだは描き続ける
      this.parts = this.parts.filter(q => nowT - q.t0 < PART_MS);
      if (this.parts.length || this.fx) this.redraw();
    }
  }

  CocageBoard.PART_MS = PART_MS;
  CocageBoard.BREAK_MS = BREAK_MS;
  window.CocageBoard = CocageBoard;
  window.CocageBoardColors = { COL, heat, rgba, lighten };
})();
