/*
 * ヘキサゴニア — 盤面の描画と操作（canvas）
 * 拡大・縮小（ホイール／ピンチ）、移動（ドラッグ）、マスの選択（クリック／タップ）、
 * ホバー・長押しでのマス情報（onHover）を扱う。
 *
 * const view = new HexBoardView(canvas, { onSelect(key), onHover(key, x, y, scale, byLongPress), onView() })
 * view.setData({ game, colors, patterns, targets, selected, marked, me })
 */
(function () {
  'use strict';

  const E = window.HexEngine;
  const SQRT3 = Math.sqrt(3);
  const DRAG_PX = 6;          // これ以上動いたらドラッグ扱い
  const LONG_PRESS_MS = 450;
  const FLASH_MS = 900;       // 変化したマスを光らせる時間
  const FOCUS_MS = 450;       // 行動があったマスへ視点を動かす時間
  const MIN_HEX_PX = 9;       // 拡大率の下限・上限（マスの半径のピクセル数）
  const MAX_HEX_PX = 140;
  const FIT_MAX_HEX_PX = 90;  // 全体表示のときの上限（小さい画面以外で大きくなりすぎないように）

  const COL = {
    page: '#1F1F1D',
    frame: '#2A2A28',
    cell: '#3A3A38',
    edge: '#56554F',
    mark: '#A3A198',
    river: '#2E4250',
    riverEdge: '#45606F',
    wave: '#7FA4BC',
    plank: '#B9A88C',
  };

  // アキシャル座標 → 世界座標（マスの半径 = 1、とがった頂点が上）
  const toWorld = (q, r) => [SQRT3 * (q + r / 2), 1.5 * r];
  function toAxial(x, y) {
    const q = (SQRT3 / 3 * x - y / 3), r = (2 / 3 * y);
    // 丸め（キューブ座標）
    let rq = Math.round(q), rr = Math.round(r), rs = Math.round(-q - r);
    const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs + q + r);
    if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
    return [rq, rr];
  }

  function hexPath(ctx, cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 180 * (60 * i - 90);
      const x = cx + size * Math.cos(a), y = cy + size * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function rgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
  }

  class HexBoardView {
    constructor(canvas, handlers) {
      this.canvas = canvas;
      canvas.hexView = this; // 動作確認用
      this.ctx = canvas.getContext('2d');
      this.h = handlers || {};
      this.data = null;
      this.scale = 30;        // マスの半径のピクセル数
      this.ox = 0; this.oy = 0; // 画面上の盤面中心
      this.moved = false;     // 利用者が動かしたか（大きさが変わったときに合わせ直すか）
      this.pointers = new Map();
      this.hoverKey = null;
      this.radius = 0;
      this.frame = 0;
      this.flashes = new Map(); // 光らせているマス → { t: 始めた時刻, color }
      this.bind();
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
    }

    setData(data) {
      const first = !this.data || !this.data.game || this.radius !== data.game.radius;
      this.data = data;
      this.radius = data.game.radius;
      if (first) { this.moved = false; this.fit(); }
      this.draw();
      this.animate();
    }

    // ---------- 表示範囲 ----------

    resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      if (!w || !h) return;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.dpr = dpr;
      if (!this.moved) this.fit(); else this.clamp();
      this.draw();
    }

    // 盤面の下に浮いている自分の情報の高さ（その上の範囲に盤面を収める）
    setInsetBottom(px) {
      if (Math.abs((this.insetBottom || 0) - px) < 2) return;
      this.insetBottom = px;
      if (!this.moved) this.fit();
      this.draw();
    }

    fitScale() {
      const w = this.canvas.clientWidth, h = Math.max(120, this.canvas.clientHeight - (this.insetBottom || 0));
      const R = this.radius + 0.8;
      // 盤面全体（大きな六角形）が収まる大きさ
      return Math.max(1, Math.min(w / (SQRT3 * (2 * R + 0.2)), h / (3 * R + 1.2)) * 0.98);
    }

    fit() {
      this.scale = Math.min(FIT_MAX_HEX_PX, this.fitScale());
      this.ox = this.canvas.clientWidth / 2;
      this.oy = Math.max(60, (this.canvas.clientHeight - (this.insetBottom || 0)) / 2);
    }

    reset() { this.moved = false; this.fit(); this.draw(); }

    // 変化したマスを一瞬光らせる
    flash(keys, color) {
      const t = performance.now();
      for (const k of keys) this.flashes.set(k, { t, color: color || '255,255,255' });
      if (keys.length) this.animate();
    }

    // 行動があったマスへ、なめらかに視点を動かす（全体表示のときは少し拡大する）
    focusOn(keys) {
      if (!keys.length || this.pointers.size || !this.dpr) return;
      let sx = 0, sy = 0;
      for (const k of keys) { const [q, r] = E.parseKey(k); const [x, y] = toWorld(q, r); sx += x; sy += y; }
      const wx = sx / keys.length, wy = sy / keys.length;
      const [, hi] = this.limits();
      const scale = this.moved ? this.scale : Math.min(hi, this.fitScale() * 1.8);
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      this.focusAnim = {
        t0: performance.now(),
        from: { ox: this.ox, oy: this.oy, scale: this.scale },
        to: { ox: w / 2 - wx * scale, oy: (h - (this.insetBottom || 0)) / 2 - wy * scale, scale },
      };
      this.moved = true;
      this.animate();
    }

    stepFocus(t) {
      const f = this.focusAnim;
      if (!f) return;
      const k = Math.min(1, (t - f.t0) / FOCUS_MS);
      const e = 1 - Math.pow(1 - k, 3);
      this.ox = f.from.ox + (f.to.ox - f.from.ox) * e;
      this.oy = f.from.oy + (f.to.oy - f.from.oy) * e;
      this.scale = f.from.scale + (f.to.scale - f.from.scale) * e;
      if (k >= 1) { this.focusAnim = null; this.clamp(); }
    }

    setSelected(key) {
      if (!this.data || this.data.selected === key) return;
      this.data.selected = key;
      this.draw();
    }

    limits() { const f = this.fitScale(); return [Math.min(MIN_HEX_PX, f * 0.6), Math.max(MAX_HEX_PX, f * 2.5)]; }

    // 盤面が画面の外に完全に消えないようにする
    clamp() {
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      const half = (this.radius + 1) * this.scale * SQRT3;
      const keep = Math.min(80, w / 3, h / 3);
      this.ox = Math.min(Math.max(this.ox, keep - half), w - keep + half);
      this.oy = Math.min(Math.max(this.oy, keep - half), h - keep + half);
    }

    zoomAt(px, py, factor) {
      const [lo, hi] = this.limits();
      const ns = Math.min(hi, Math.max(lo, this.scale * factor));
      const k = ns / this.scale;
      this.ox = px - (px - this.ox) * k;
      this.oy = py - (py - this.oy) * k;
      this.scale = ns;
      this.moved = true;
      this.clamp();
      this.draw();
    }

    screenOf(key) {
      const [q, r] = E.parseKey(key);
      const [x, y] = toWorld(q, r);
      return [this.ox + x * this.scale, this.oy + y * this.scale];
    }

    keyAt(px, py) {
      if (!this.data) return null;
      const [q, r] = toAxial((px - this.ox) / this.scale, (py - this.oy) / this.scale);
      const k = E.key(q, r);
      return this.data.game.board[k] ? k : null;
    }

    // ---------- 操作 ----------

    bind() {
      const c = this.canvas;
      const pos = e => { const b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; };

      c.addEventListener('wheel', e => {
        e.preventDefault();
        const [x, y] = pos(e);
        const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        this.zoomAt(x, y, Math.exp(-d * 0.0015));
      }, { passive: false });

      c.addEventListener('pointerdown', e => {
        c.setPointerCapture(e.pointerId);
        const [x, y] = pos(e);
        this.pointers.set(e.pointerId, { x, y, sx: x, sy: y, type: e.pointerType });
        if (this.pointers.size === 1) {
          this.dragging = false;
          this.longPressed = false;
          clearTimeout(this.lpTimer);
          if (e.pointerType !== 'mouse') {
            this.lpTimer = setTimeout(() => {
              if (this.dragging || this.pointers.size !== 1) return;
              this.longPressed = true;
              const k = this.keyAt(x, y);
              this.setHover(k, true);
            }, LONG_PRESS_MS);
          }
        } else {
          // 2本指になったらピンチ
          this.dragging = true;
          clearTimeout(this.lpTimer);
          this.pinch = this.pinchInfo();
        }
      });

      c.addEventListener('pointermove', e => {
        const [x, y] = pos(e);
        const p = this.pointers.get(e.pointerId);
        if (!p) {
          if (e.pointerType === 'mouse') this.setHover(this.keyAt(x, y), false);
          return;
        }
        const dx = x - p.x, dy = y - p.y;
        p.x = x; p.y = y;
        if (this.pointers.size >= 2) {
          const now = this.pinchInfo();
          if (this.pinch && this.pinch.d > 0) {
            this.ox += now.cx - this.pinch.cx;
            this.oy += now.cy - this.pinch.cy;
            this.zoomAt(now.cx, now.cy, now.d / this.pinch.d);
          }
          this.pinch = now;
          return;
        }
        if (!this.dragging && Math.hypot(x - p.sx, y - p.sy) >= DRAG_PX) {
          this.dragging = true;
          clearTimeout(this.lpTimer);
          if (this.longPressed) this.setHover(null, true);
        }
        if (this.dragging) {
          this.ox += dx; this.oy += dy;
          this.moved = true;
          this.clamp();
          this.draw();
        }
        if (e.pointerType === 'mouse') this.setHover(this.dragging ? null : this.keyAt(x, y), false);
      });

      const end = e => {
        const p = this.pointers.get(e.pointerId);
        if (!p) return;
        this.pointers.delete(e.pointerId);
        clearTimeout(this.lpTimer);
        if (this.pointers.size === 1) { this.pinch = null; return; }
        if (this.pointers.size > 0) { this.pinch = this.pinchInfo(); return; }
        const click = e.type === 'pointerup' && !this.dragging && !this.longPressed;
        if (click) {
          const k = this.keyAt(p.x, p.y);
          if (e.pointerType !== 'mouse') this.setHover(null, true);
          if (this.h.onSelect) this.h.onSelect(k);  // 盤面の外なら null（選択を外す）
        }
        this.dragging = false;
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !this.pointers.size) this.setHover(null, false); });
    }

    pinchInfo() {
      const ps = [...this.pointers.values()];
      if (ps.length < 2) return null;
      const [a, b] = ps;
      return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
    }

    setHover(k, byLongPress) {
      if (k === this.hoverKey && !byLongPress) return;
      this.hoverKey = k;
      this.draw();
      if (this.h.onHover) {
        if (!k) this.h.onHover(null);
        else { const [x, y] = this.screenOf(k); this.h.onHover(k, x, y, this.scale, byLongPress); }
      }
    }

    // 攻防中・対象マスがあるときだけゆっくり点滅させる
    animate() {
      if (this.anim) return;
      const loop = () => {
        const d = this.data;
        const need = d && (d.targets.length || (d.game.pending && !d.game.over) || this.flashes.size || this.focusAnim);
        if (!need) { this.anim = 0; this.draw(); return; }
        this.draw();
        this.anim = requestAnimationFrame(loop);
      };
      this.anim = requestAnimationFrame(loop);
    }

    // ---------- 描画 ----------

    draw() {
      const ctx = this.ctx, d = this.data;
      if (!this.dpr) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      ctx.fillStyle = COL.page;
      ctx.fillRect(0, 0, w, h);
      if (!d) return;
      this.stepFocus(performance.now());
      const s = this.scale, g = d.game;
      const t = performance.now();
      const pulse = 0.55 + 0.45 * Math.sin(t / 260);

      // 盤面外枠（とがった頂点が上のマスを並べた大きな六角形は、辺が平らな向き）
      ctx.save();
      ctx.translate(this.ox, this.oy);
      ctx.rotate(Math.PI / 6);
      hexPath(ctx, 0, 0, (this.radius + 0.9) * s * SQRT3);
      ctx.restore();
      ctx.fillStyle = COL.frame;
      ctx.fill();

      const cells = Object.entries(g.board);
      const targets = new Set(d.targets);
      // 地形
      for (const [, c] of cells) {
        const [wx, wy] = toWorld(c.q, c.r);
        const x = this.ox + wx * s, y = this.oy + wy * s;
        if (x < -s || y < -s || x > w + s || y > h + s) continue;
        const river = c.terrain === 'river';
        hexPath(ctx, x, y, s * 0.97);
        ctx.fillStyle = river ? COL.river : COL.cell;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = river ? COL.riverEdge : COL.edge;
        ctx.stroke();
        if (river) {
          if (c.owner) {
            // 橋：板を並べた形
            ctx.strokeStyle = COL.plank;
            ctx.lineWidth = Math.max(1, s * 0.07);
            ctx.beginPath();
            ctx.moveTo(x - s * 0.45, y - s * 0.22); ctx.lineTo(x + s * 0.45, y - s * 0.22);
            ctx.moveTo(x - s * 0.45, y + s * 0.22); ctx.lineTo(x + s * 0.45, y + s * 0.22);
            for (let i = -2; i <= 2; i++) { ctx.moveTo(x + i * s * 0.18, y - s * 0.22); ctx.lineTo(x + i * s * 0.18, y + s * 0.22); }
            ctx.stroke();
          } else {
            // 河川：波の線
            ctx.strokeStyle = COL.wave;
            ctx.lineWidth = Math.max(1, s * 0.05);
            for (const dy of [-0.12, 0.12]) {
              ctx.beginPath();
              for (let i = 0; i <= 8; i++) {
                const px = x - s * 0.3 + i * s * 0.075, py = y + dy * s + Math.sin(i / 8 * Math.PI * 2) * s * 0.05;
                if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
              }
              ctx.stroke();
            }
          }
        } else if (c.terrain === 'mine') {
          // 鉱山：◆
          ctx.beginPath();
          ctx.moveTo(x, y - s * 0.27);
          ctx.lineTo(x + s * 0.2, y);
          ctx.lineTo(x, y + s * 0.27);
          ctx.lineTo(x - s * 0.2, y);
          ctx.closePath();
          ctx.fillStyle = COL.mark;
          ctx.fill();
        } else if (c.terrain === 'forest') {
          // 森林：▽（縁取りだけ）
          ctx.beginPath();
          ctx.moveTo(x, y + s * 0.25);
          ctx.lineTo(x + s * 0.27, y - s * 0.2);
          ctx.lineTo(x - s * 0.27, y - s * 0.2);
          ctx.closePath();
          ctx.strokeStyle = COL.mark;
          ctx.lineWidth = Math.max(1.2, s * 0.06);
          ctx.lineJoin = 'round';
          ctx.stroke();
        } else if (c.terrain === 'farm') {
          // 農地：●
          ctx.beginPath();
          ctx.arc(x, y, s * 0.2, 0, Math.PI * 2);
          ctx.fillStyle = COL.mark;
          ctx.fill();
        }
      }
      // セル（半透明なので下の地形マークが透ける）
      for (const [, c] of cells) {
        if (!c.owner) continue;
        const col = d.colors[c.owner];
        if (!col) continue;
        const [wx, wy] = toWorld(c.q, c.r);
        const x = this.ox + wx * s, y = this.oy + wy * s;
        if (x < -s || y < -s || x > w + s || y > h + s) continue;
        const pat = d.patterns ? col.pattern : 'solid';
        hexPath(ctx, x, y, s * 0.93);
        ctx.fillStyle = rgba(col.base, 0.42);
        ctx.fill();
        ctx.save();
        if (c.core) { ctx.shadowColor = col.light; ctx.shadowBlur = Math.max(6, s * 0.5); }
        this.edge(ctx, x, y, s * 0.88, c.core ? Math.max(2.5, s * 0.11) : Math.max(1.5, s * 0.06), col.light, pat);
        ctx.restore();
        if (c.strong) {
          hexPath(ctx, x, y, s * 0.62);
          ctx.lineWidth = Math.max(1.2, s * 0.05);
          ctx.strokeStyle = col.light;
          ctx.setLineDash([]);
          ctx.stroke();
        }
        if (c.core) {
          ctx.beginPath();
          ctx.arc(x, y, s * 0.27, 0, Math.PI * 2);
          ctx.fillStyle = col.base;
          ctx.fill();
          ctx.lineWidth = Math.max(1, s * 0.04);
          ctx.strokeStyle = col.light;
          ctx.stroke();
        }
      }
      // 捨てるセルとして選んだマス：赤い枠と×
      for (const k of d.marked || []) {
        if (!g.board[k]) continue;
        const [x, y] = this.screenOf(k);
        hexPath(ctx, x, y, s * 0.86);
        ctx.fillStyle = 'rgba(255,90,90,0.25)';
        ctx.fill();
        ctx.lineWidth = Math.max(2, s * 0.08);
        ctx.strokeStyle = 'rgba(255,120,120,0.95)';
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(x - s * 0.3, y - s * 0.3); ctx.lineTo(x + s * 0.3, y + s * 0.3);
        ctx.moveTo(x + s * 0.3, y - s * 0.3); ctx.lineTo(x - s * 0.3, y + s * 0.3);
        ctx.stroke();
      }
      // 行動できるマス（薄く光らせる）
      for (const k of targets) {
        const [x, y] = this.screenOf(k);
        hexPath(ctx, x, y, s * 0.8);
        ctx.fillStyle = `rgba(255,255,255,${0.04 + 0.06 * pulse})`;
        ctx.fill();
        ctx.lineWidth = Math.max(1, s * 0.045);
        ctx.strokeStyle = `rgba(255,255,255,${0.25 + 0.3 * pulse})`;
        ctx.setLineDash([]);
        ctx.stroke();
      }
      // 変化したマス：明るく光って消えていく
      for (const [k, f] of this.flashes) {
        const age = (t - f.t) / FLASH_MS;
        if (age >= 1 || !g.board[k]) { this.flashes.delete(k); continue; }
        const a = (1 - age) * (1 - age);
        const [x, y] = this.screenOf(k);
        ctx.save();
        ctx.shadowColor = `rgba(${f.color},${a})`;
        ctx.shadowBlur = s * 0.8;
        hexPath(ctx, x, y, s * (0.92 + 0.12 * age));
        ctx.fillStyle = `rgba(${f.color},${0.5 * a})`;
        ctx.fill();
        ctx.lineWidth = Math.max(2, s * 0.1);
        ctx.strokeStyle = `rgba(${f.color},${a})`;
        ctx.setLineDash([]);
        ctx.stroke();
        ctx.restore();
      }
      // 選んでいるマス
      if (d.selected && g.board[d.selected]) {
        const [x, y] = this.screenOf(d.selected);
        hexPath(ctx, x, y, s * 0.99);
        ctx.lineWidth = Math.max(2, s * 0.09);
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.setLineDash([]);
        ctx.stroke();
      }
      // 攻防中のマス
      if (g.pending && !g.over) {
        const [x, y] = this.screenOf(g.pending.target);
        ctx.beginPath();
        ctx.arc(x, y, s * (0.95 + 0.1 * pulse), 0, Math.PI * 2);
        ctx.lineWidth = Math.max(2, s * 0.09);
        ctx.strokeStyle = `rgba(255,120,120,${0.5 + 0.5 * pulse})`;
        ctx.stroke();
      }
      // ホバー中のマス
      if (this.hoverKey && g.board[this.hoverKey]) {
        const [x, y] = this.screenOf(this.hoverKey);
        hexPath(ctx, x, y, s * 0.97);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.setLineDash([]);
        ctx.stroke();
      }
      if (this.h.onView) this.h.onView();
    }

    // セルの縁（陣営ごとの模様：実線・点線・二重線・破線）
    edge(ctx, x, y, size, lw, color, pattern) {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.setLineDash(pattern === 'dashed' ? [lw * 3, lw * 2] : pattern === 'dotted' ? [lw * 0.1, lw * 2] : []);
      ctx.lineCap = pattern === 'dotted' ? 'round' : 'butt';
      if (pattern === 'double') {
        ctx.lineWidth = lw * 0.55;
        hexPath(ctx, x, y, size + lw * 0.45); ctx.stroke();
        hexPath(ctx, x, y, size - lw * 0.75); ctx.stroke();
      } else {
        hexPath(ctx, x, y, size);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.lineCap = 'butt';
    }
  }

  window.HexBoardView = HexBoardView;
})();
