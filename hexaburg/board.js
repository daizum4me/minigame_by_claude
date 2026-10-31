/*
 * ヘキサブルグ — 盤面の描画と操作（canvas）
 * 拡大・縮小（ホイール／ピンチ）、移動（ドラッグ）、マスの選択（クリック／タップ）、
 * ホバー・長押しでのマス情報（onHover）を扱う。
 *
 * const view = new HexBoardView(canvas, { onSelect(key), onHover(key, x, y, scale, byLongPress), onView() })
 * view.setData({ game, colors, patterns, targets, selected, me, canAim(k), aimTargets(k) })
 * 狙い：自分のセルの中心付近から、隣の相手のセルまでドラッグする（handlers.onAim(from, to)）
 */
(function () {
  'use strict';

  const E = window.HexEngine;
  const SQRT3 = Math.sqrt(3);
  const DRAG_PX = 6;          // これ以上動いたらドラッグ扱い
  const LONG_PRESS_MS = 450;
  const FLASH_MS = 900;       // 変化したマスを光らせる時間
  const MIN_HEX_PX = 9;       // 拡大率の下限・上限（マスの半径のピクセル数）
  const MAX_HEX_PX = 140;
  const FIT_MAX_HEX_PX = 90;  // 全体表示のときの上限（小さい画面以外で大きくなりすぎないように）

  const COL = {
    page: '#1F1F1D',
    frame: '#2A2A28',
    cell: '#3A3A38',
    edge: '#56554F',
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
    flash(keys, color, ms) {
      const t = performance.now();
      for (const k of keys) this.flashes.set(k, { t, color: color || '255,255,255', ms: ms || FLASH_MS });
      if (keys.length) this.animate();
    }

    // 終了時の数え上げで塗るマス（Map：キー → 色）。null で消す
    setCounted(map) {
      this.counted = map;
      this.draw();
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
          // 狙えるセルの中心付近を押したら、狙いのドラッグ（盤面は動かさない）
          const from = this.aimStartAt(x, y);
          if (from) { this.pointers.get(e.pointerId).aim = { from, active: false }; return; }
          if (e.pointerType !== 'mouse') {
            this.lpTimer = setTimeout(() => {
              if (this.dragging || this.pointers.size !== 1) return;
              this.longPressed = true;
              const k = this.keyAt(x, y);
              this.setHover(k, true);
            }, LONG_PRESS_MS);
          }
        } else {
          // 2本指になったらピンチ（狙いのドラッグは取りやめ）
          for (const q of this.pointers.values()) delete q.aim;
          this.aimDrag = null;
          this.dragging = true;
          clearTimeout(this.lpTimer);
          this.pinch = this.pinchInfo();
        }
      });

      c.addEventListener('pointermove', e => {
        const [x, y] = pos(e);
        const p = this.pointers.get(e.pointerId);
        if (!p) {
          if (e.pointerType === 'mouse') {
            this.setHover(this.keyAt(x, y), false);
            c.style.cursor = this.aimStartAt(x, y) ? 'grab' : '';
          }
          return;
        }
        const dx = x - p.x, dy = y - p.y;
        p.x = x; p.y = y;
        if (p.aim) {
          if (!p.aim.active && Math.hypot(x - p.sx, y - p.sy) >= DRAG_PX) { p.aim.active = true; this.setHover(null, false); }
          if (p.aim.active) {
            const k = this.keyAt(x, y);
            const ok = k && this.data.aimTargets(p.aim.from).includes(k);
            this.aimDrag = { from: p.aim.from, x, y, to: ok ? k : null };
            c.style.cursor = 'grabbing';
            this.draw();
          }
          return;
        }
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
        // 狙いのドラッグ：狙える相手のセルの上で離したら狙う。それ以外は取りやめ
        if (p.aim && p.aim.active) {
          const to = this.aimDrag && this.aimDrag.to;
          this.aimDrag = null;
          c.style.cursor = '';
          this.draw();
          if (to && e.type === 'pointerup' && this.h.onAim) this.h.onAim(p.aim.from, to);
          return;
        }
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

    // 狙いのドラッグを始められる場所か：狙えるセルの中心付近（マスの大きさの 55% 以内）。始められるならそのマスのキー
    aimStartAt(x, y) {
      const d = this.data;
      if (!d || !d.canAim) return null;
      const k = this.keyAt(x, y);
      if (!k || !d.canAim(k)) return null;
      const [cx, cy] = this.screenOf(k);
      return Math.hypot(x - cx, y - cy) <= this.scale * 0.55 ? k : null;
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

    // 対象マスがあるとき・光らせているマスがあるときだけ動かす
    animate() {
      if (this.anim) return;
      const loop = () => {
        const d = this.data;
        const need = d && (d.targets.length || this.flashes.size || this.aimDrag);
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
      // マス（すべて平原）
      for (const [, c] of cells) {
        const [wx, wy] = toWorld(c.q, c.r);
        const x = this.ox + wx * s, y = this.oy + wy * s;
        if (x < -s || y < -s || x > w + s || y > h + s) continue;
        hexPath(ctx, x, y, s * 0.97);
        ctx.fillStyle = COL.cell;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = COL.edge;
        ctx.stroke();
      }
      // セル
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
        // 体力：縁の内側を、体力1つにつき辺1本ぶんずつ、明るい色で塗る（6で一周）
        if (c.hp > 0) this.hpRing(ctx, x, y, s, Math.min(6, c.hp), col);
        ctx.save();
        if (c.core) { ctx.shadowColor = col.light; ctx.shadowBlur = Math.max(6, s * 0.5); }
        this.edge(ctx, x, y, s * 0.88, c.core ? Math.max(2.5, s * 0.11) : Math.max(1.5, s * 0.06), col.light, pat);
        ctx.restore();
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
      // 狙い：狙っているセルから狙われているセルへの、弧を描く矢印（全員に見える。狙っている人の色）
      for (const [, c] of cells) {
        if (!c.owner || !c.aim || !g.board[c.aim]) continue;
        const col = d.colors[c.owner];
        if (!col) continue;
        if (this.aimDrag && this.aimDrag.from === E.key(c.q, c.r)) continue;   // ドラッグで狙い直しているあいだは、前の矢印を出さない
        const [x1, y1] = this.screenOf(E.key(c.q, c.r)), [x2, y2] = this.screenOf(c.aim);
        this.arcArrow(ctx, x1, y1, x2, y2, col.light, s, 0.42);
      }
      // ドラッグで狙っているところ：狙えるセルを光らせ、指の先まで矢印を伸ばす（狙えるセルの上ならそのセルへ）
      if (this.aimDrag) {
        const a = this.aimDrag;
        for (const k of d.aimTargets(a.from)) {
          const [x, y] = this.screenOf(k);
          hexPath(ctx, x, y, s * 0.86);
          ctx.lineWidth = Math.max(2, s * 0.08);
          ctx.strokeStyle = k === a.to ? 'rgba(255,211,107,0.95)' : `rgba(255,211,107,${0.3 + 0.3 * pulse})`;
          ctx.setLineDash([]);
          ctx.stroke();
        }
        const [x1, y1] = this.screenOf(a.from);
        const [x2, y2] = a.to ? this.screenOf(a.to) : [a.x, a.y];
        const col = d.colors[d.me] || { light: '#FFFFFF' };
        if (Math.hypot(x2 - x1, y2 - y1) > s * 0.4) this.arcArrow(ctx, x1, y1, x2, y2, col.light, s, a.to ? 0.42 : 0);
      }
      // 終了時の数え上げで数えたマス：明るい色で塗る
      if (this.counted) for (const [k, color] of this.counted) {
        if (!g.board[k]) continue;
        const [x, y] = this.screenOf(k);
        hexPath(ctx, x, y, s * 0.8);
        ctx.fillStyle = rgba(color, 0.75);
        ctx.fill();
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
        const age = (t - f.t) / f.ms;
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
      if (this.hoverKey && g.board[this.hoverKey]) {
        // ホバー中のマス
        const [x, y] = this.screenOf(this.hoverKey);
        hexPath(ctx, x, y, s * 0.97);
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.6)';
        ctx.setLineDash([]);
        ctx.stroke();
      }
      if (this.h.onView) this.h.onView();
    }

    // 弧を描く矢印（⤵ のように、進む向きの右側へふくらむ）。endGap：終わりを相手のマスの中心から手前に止める割合
    arcArrow(ctx, x1, y1, x2, y2, color, s, endGap) {
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      const sx = x1 + ux * s * 0.22, sy = y1 + uy * s * 0.22;
      const ex = x2 - ux * s * endGap, ey = y2 - uy * s * endGap;
      // 制御点：まん中から右へ（向かい合って狙い合っても、反対側にふくらむので重ならない）
      const bend = Math.min(len * 0.45, s * 0.9);
      const cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend;
      const tx = ex - cx, ty = ey - cy, tl = Math.hypot(tx, ty) || 1, vx = tx / tl, vy = ty / tl;   // 終わりの向き
      const head = Math.max(6, s * 0.28);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = Math.max(2, s * 0.09);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.quadraticCurveTo(cx, cy, ex - vx * head * 0.6, ey - vy * head * 0.6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - vx * head - vy * head * 0.6, ey - vy * head + vx * head * 0.6);
      ctx.lineTo(ex - vx * head + vy * head * 0.6, ey - vy * head - vx * head * 0.6);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // 体力の帯：縁と内側（0.71）のあいだの台形を、上の頂点から時計回りに n 本ぶん塗る
    hpRing(ctx, x, y, s, n, col) {
      const ro = s * 0.86, ri = s * 0.71;
      const pt = (r, i) => { const a = Math.PI / 180 * (60 * i - 90); return [x + r * Math.cos(a), y + r * Math.sin(a)]; };
      ctx.fillStyle = col.light;
      for (let i = 0; i < n; i++) {
        ctx.beginPath();
        ctx.moveTo(...pt(ro, i)); ctx.lineTo(...pt(ro, i + 1));
        ctx.lineTo(...pt(ri, i + 1)); ctx.lineTo(...pt(ri, i));
        ctx.closePath();
        ctx.fill();
      }
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
