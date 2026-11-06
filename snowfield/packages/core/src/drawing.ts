import type { Drawing, Seg } from './types';

/**
 * お絵かき。座標は「マス単位の小数」（x=3.5 はマス3の真ん中）。
 * 線分はマス境界で分割して、1×1マスごとに保持する（マス単位のデータ・後勝ち）。
 */
export const cellKey = (x: number, y: number) => `${x},${y}`;

/** 線分 (x0,y0)-(x1,y1) をマスで分割して追加する。同じ点なら点（丸い点）になる */
export function addSegment(d: Drawing, x0: number, y0: number, x1: number, y1: number, c: string): void {
  const ts = [0, 1];
  const dx = x1 - x0, dy = y1 - y0;
  if (dx !== 0) {
    const lo = Math.min(x0, x1), hi = Math.max(x0, x1);
    for (let gx = Math.floor(lo) + 1; gx <= hi; gx++) { const t = (gx - x0) / dx; if (t > 0 && t < 1) ts.push(t); }
  }
  if (dy !== 0) {
    const lo = Math.min(y0, y1), hi = Math.max(y0, y1);
    for (let gy = Math.floor(lo) + 1; gy <= hi; gy++) { const t = (gy - y0) / dy; if (t > 0 && t < 1) ts.push(t); }
  }
  ts.sort((a, b) => a - b);
  for (let i = 0; i < ts.length - 1; i++) {
    const a = ts[i], b = ts[i + 1];
    const seg: Seg = { x0: x0 + dx * a, y0: y0 + dy * a, x1: x0 + dx * b, y1: y0 + dy * b, c };
    const mx = (seg.x0 + seg.x1) / 2, my = (seg.y0 + seg.y1) / 2;
    const k = cellKey(Math.floor(mx), Math.floor(my));
    (d[k] ??= []).push(seg);
  }
}

const distToSeg = (px: number, py: number, s: Seg): number => {
  const vx = s.x1 - s.x0, vy = s.y1 - s.y0, l2 = vx * vx + vy * vy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.x0) * vx + (py - s.y0) * vy) / l2));
  return Math.hypot(px - (s.x0 + vx * t), py - (s.y0 + vy * t));
};

/** 円（中心・半径はマス単位）に触れた線分を消す。誰の線でも消せる */
export function erase(d: Drawing, cx: number, cy: number, r: number): void {
  for (let y = Math.floor(cy - r); y <= Math.floor(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.floor(cx + r); x++) {
    const k = cellKey(x, y), list = d[k];
    if (!list) continue;
    const rest = list.filter((s) => distToSeg(cx, cy, s) >= r);
    if (rest.length) d[k] = rest; else delete d[k];
  }
}

/** 建物・道ができたマスの絵を消す */
export function clearCells(d: Drawing, x: number, y: number, w: number, h: number): void {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) delete d[cellKey(x + i, y + j)];
}
