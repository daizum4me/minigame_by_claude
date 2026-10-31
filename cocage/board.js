/*
 * Cocage — 盤面の描画（canvas）と操作
 * 暗い背景に、六角形のセルと細い線だけで描く（アニメーションは、点数を稼いだ葉から数字がこぼれる演出だけ）。
 * 数値は六角形の外接円の半径 S（= 2k）を基準にする。座標は engine.js と同じ整数座標（1 = k）。
 * 盤面は左右がつながった横ループ。ドラッグで回せる（pan）。
 *
 * new CocageBoard(canvas, { onHover(info|null), onPick({ t:'b'|'l', key }) })
 * setData({ game, me, mode, overlay, colors, candidates })
 */
(function () {
  'use strict';

  const E = window.CocageEngine;
  const SQRT3 = Math.sqrt(3);
  const MARGIN = 14;           // 台のふちとセルの余白
  const LABEL_H = 34;          // 盤面の下の、幹の名前の置き場
  const PART_MS = 1300;        // こぼれる数字が消えるまで
  const TOP_RESERVE = 46;      // 上のバー（ターン・表示切り替え）の分

  const COL = { page: '#1F1F1D', frame: '#2A2A28', cell: '#3A3A38', edge: '#56554F', text: '#E9E7E0', muted: '#9A988F', broken: '#FF9C94', trunkGray: '#8A8880' };
  const FONT = '"Noto Sans CJK JP", "Noto Sans JP", "Hiragino Sans", "Yu Gothic UI", system-ui, sans-serif';

  const hex = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const rgba = (c, a) => { const [r, g, b] = hex(c); return `rgba(${r},${g},${b},${a})`; };
  const lighten = (c, f) => { const [r, g, b] = hex(c); const m = v => Math.round(v + (255 - v) * f); return `rgb(${m(r)},${m(g)},${m(b)})`; };
  const mix = (c1, c2, t) => { const a = hex(c1), b = hex(c2); return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`; };

  // 緑 → 黄 → 赤
  function heat(t) {
    t = Math.max(0, Math.min(1, t));
    return t < 0.5 ? mix('#7BD39A', '#FFD36B', t / 0.5) : mix('#FFD36B', '#FF6E64', (t - 0.5) / 0.5);
  }

  class CocageBoard {
    constructor(canvas, handlers) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.h = handlers || {};
      this.data = null;
      this.pan = 0;               // 回転（x の単位）
      this.panInit = false;
      this.k = 8;
      this.hover = null;          // { edge, cand }
      this.drag = null;
      this.raf = 0;
      this.dpr = 1;
      this.parts = [];            // こぼれる数字
      canvas.view = this;   // テストや調べもの用
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(canvas.parentElement || canvas);
      canvas.addEventListener('pointerdown', e => this.onDown(e));
      canvas.addEventListener('pointermove', e => this.onMove(e));
      canvas.addEventListener('pointerup', e => this.onUp(e));
      canvas.addEventListener('pointercancel', () => { this.drag = null; });
      canvas.addEventListener('pointerleave', () => { if (!this.drag) this.setHover(null); });
      canvas.addEventListener('wheel', e => { e.preventDefault(); this.pan += (e.deltaX || e.deltaY) / this.k * 0.5; this.hover = null; this.redraw(); }, { passive: false });
      this.resize();
    }

    setData(d) {
      const prev = this.data;
      this.data = d;
      if (d && d.game) {
        this.geo = E.geometry(d.game.cols);
        this.W = 3 * d.game.cols;
        if (!prev || !prev.game || prev.game.cols !== d.game.cols || !this.panInit) { this.centerOn(d.me); this.panInit = true; }
        this.score = E.scoreBoard(d.game);
        this.stats = null;
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
      this.pan = this.W / 2 - (3 * col + 1.5);
      this.hover = null;
      this.redraw();
    }

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

    // 台の大きさとセルの大きさ（幅と高さの両方に収まるように）
    layout() {
      if (!this.data || !this.data.game) return;
      const aw = this.cw - 16, ah = this.ch - TOP_RESERVE - 8;
      const kx = (aw - 2 * MARGIN) / this.W;
      const ky = (ah - 2 * MARGIN - LABEL_H) / (37 * SQRT3);
      this.k = Math.max(2.5, Math.min(kx, ky, 20));
      this.S = this.k * 2;
      this.hu = SQRT3 * this.k;                       // 高さの単位
      this.boardW = this.W * this.k + 2 * MARGIN;
      this.boardH = 37 * this.hu + 2 * MARGIN + LABEL_H;
      this.bx = Math.round((this.cw - this.boardW) / 2);
      this.by = TOP_RESERVE + Math.max(0, Math.round((this.ch - TOP_RESERVE - 8 - this.boardH) / 2));
      this.left = this.bx + MARGIN;                   // x = 0 の位置
    }

    px(x, dx) { return this.left + (x + this.pan + dx) * this.k; }
    py(y) { return this.by + MARGIN + (36 - y) * this.hu; }
    wrapD(d) { return d > this.W / 2 ? d - this.W : d < -this.W / 2 ? d + this.W : d; }

    // ---------- 操作 ----------

    local(e) {
      const r = this.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    onDown(e) {
      if (!this.data) return;
      const [x, y] = this.local(e);
      this.drag = { x0: x, y0: y, px: x, pan0: this.pan, moved: false, id: e.pointerId };
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* 無視 */ }
    }

    onMove(e) {
      const [x, y] = this.local(e);
      const d = this.drag;
      if (d) {
        if (!d.moved && Math.hypot(x - d.x0, y - d.y0) > 6) d.moved = true;
        if (d.moved) {
          this.pan = d.pan0 + (x - d.x0) / this.k;
          this.setHover(null);
          this.redraw();
        }
        return;
      }
      this.setHover(this.hit(x, y), x, y);
    }

    onUp(e) {
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
        const t = Math.max(0, Math.min(1, ((x - x1) * vx + (y - y1) * vy) / L2));
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

    // 点にあるもの：置ける辺・セル（cand）と、合わせると折れやすさを見られる辺（edge）
    hit(x, y) {
      const d = this.data;
      if (!d || !d.game || !this.geo) return null;
      const thr = Math.max(7, this.S * 0.3);
      const out = { edge: null, cand: null };
      if (d.mode === 'b' && d.candidates) {
        let best = thr;
        for (const ek of d.candidates.edges) { const dist = this.distToEdge(ek, x, y); if (dist < best) { best = dist; out.cand = { t: 'b', key: ek }; } }
      } else if (d.mode === 'l' && d.candidates) {
        let best = this.S * 0.87;
        for (const ck of d.candidates.cells) { const dist = this.distToCell(ck, x, y); if (dist < best) { best = dist; out.cand = { t: 'l', key: ck }; } }
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

    // 点数を稼いだ葉から、数字がこぼれる演出：items = [{ cell, pts, color }]
    spill(items) {
      if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const now = performance.now();
      for (const it of items) {
        const n = Math.min(5, Math.ceil(it.pts) + 1);
        for (let i = 0; i < n; i++) {
          this.parts.push({
            cell: it.cell, color: it.color, text: String(Math.round(it.pts * 10) / 10), t0: now + i * 70,
            vx: (Math.random() - 0.5) * 6, vy: -(2.4 + Math.random() * 2.6),   // 1 = セルの半径あたり / 秒
          });
        }
      }
      this.redraw();
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

    draw() {
      const ctx = this.ctx, d = this.data;
      if (!this.dpr) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = COL.page;
      ctx.fillRect(0, 0, this.cw, this.ch);
      if (!d || !d.game || !this.geo) return;
      const g = d.game, geo = this.geo, S = this.S, k = this.k;
      const colors = d.colors;

      // 台（角丸16）
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(this.bx, this.by, this.boardW, this.boardH, 16); else ctx.rect(this.bx, this.by, this.boardW, this.boardH);
      ctx.fillStyle = COL.frame;
      ctx.fill();

      // 台の中だけに描く（左右のつなぎ目の向こう側は、反対側が見える）
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.bx + 1, this.by + 1, this.boardW - 2, this.boardH - 2);
      ctx.clip();

      const overlay = d.overlay || 'normal';
      const ov = overlay === 'normal' ? null : this.edgeValues(g, overlay === 'p' ? 'p' : 'loss');
      const { points, tops } = this.score;
      const topCells = new Set(Object.values(tops).map(t => t.cell));
      const hoverEdge = this.hover && this.hover.edge;
      const plan = (g.players.find(p => p.id === d.me) || {}).plan || [];

      for (const dx of [-this.W, 0, this.W]) {
        // セル
        ctx.lineWidth = 1;
        ctx.strokeStyle = COL.edge;
        ctx.fillStyle = COL.cell;
        for (const c of Object.values(geo.cells)) {
          const cx = this.px(c.x, dx);
          if (cx < this.bx - S || cx > this.bx + this.boardW + S) continue;
          this.hexPath(ctx, cx, this.py(c.y), S);
          ctx.fill(); ctx.stroke();
        }
        const cellXY = ck => { const c = geo.cells[ck]; return [this.px(c.x, dx), this.py(c.y)]; };
        const inView = x => x > this.bx - S * 2 && x < this.bx + this.boardW + S * 2;

        // 葉
        for (const [ck, lf] of Object.entries(g.leaves)) {
          const [x, y] = cellXY(ck);
          if (!inView(x)) continue;
          const color = colors[lf.owner];
          const fresh = g.round > 0 && lf.round === g.round;
          this.hexPath(ctx, x, y, S * 0.78);
          ctx.fillStyle = rgba(color, 0.45);
          ctx.fill();
          ctx.lineWidth = fresh ? 2.4 : 2;
          ctx.strokeStyle = fresh ? '#FFFFFF' : color;
          ctx.stroke();
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

        // 折れた枝（折れたターンだけ）
        const lt = g.lastTurn;
        if (lt && lt.turn === g.round) {
          ctx.strokeStyle = COL.broken;
          ctx.lineWidth = 3;
          ctx.setLineDash([3, 4]);
          for (const r of lt.removed) this.line(ctx, r.key, dx);
          ctx.setLineDash([]);
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

        // 置ける場所
        const me = d.me, mycol = colors[me] || '#FFFFFF';
        if (d.candidates && d.mode === 'b') {
          ctx.lineWidth = 2; ctx.setLineDash([2, 4]); ctx.strokeStyle = rgba(mycol, 0.8);
          for (const ek of d.candidates.edges) this.line(ctx, ek, dx);
          ctx.setLineDash([]);
        }
        if (d.candidates && d.mode === 'l') {
          ctx.lineWidth = 1.6; ctx.setLineDash([3, 3]); ctx.strokeStyle = rgba(mycol, 0.75);
          for (const ck of d.candidates.cells) { const [x, y] = cellXY(ck); if (inView(x)) { this.hexPath(ctx, x, y, S * 0.78); ctx.stroke(); } }
          ctx.setLineDash([]);
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
        // 合わせているもの
        const hv = this.hover;
        if (hv && hv.cand) {
          ctx.setLineDash([]);
          if (hv.cand.t === 'b') { ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3.6; this.line(ctx, hv.cand.key, dx); }
          else { const [x, y] = cellXY(hv.cand.key); if (inView(x)) { this.hexPath(ctx, x, y, S * 0.78); ctx.fillStyle = 'rgba(255,255,255,.16)'; ctx.fill(); ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 2.4; ctx.stroke(); } }
        }
        if (hoverEdge) {
          ctx.setLineDash([]);
          ctx.strokeStyle = '#FFFFFF'; ctx.lineWidth = 3.6;
          this.line(ctx, hoverEdge, dx);
        }

        // こぼれる数字：上へはじけてから、重力で落ちながら消える
        const nowT = performance.now();
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
      // こぼれる数字が残っているあいだは描き続ける
      const nowT = performance.now();
      this.parts = this.parts.filter(q => nowT - q.t0 < PART_MS);
      if (this.parts.length) this.redraw();
    }
  }

  window.CocageBoard = CocageBoard;
  window.CocageBoardColors = { COL, heat, rgba, lighten };
})();
