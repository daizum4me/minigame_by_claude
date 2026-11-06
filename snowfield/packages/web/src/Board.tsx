import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  BUILDING_DEFS, animalAt, buildCheck, buildingAt, isInsulated, isReachable, resourceAt, route,
  type Action, type BuildableType, type GameState,
} from '@snowfield/core';
import type { Theme } from './theme';
import { DESC, T, isWarm } from './ui';
import { Icon } from './icons';

export interface MenuEntry {
  label: string; cost: string; why: string; head?: string; run: () => void;
}
export interface MenuModel { title: string; sub: string; entries: MenuEntry[] }
export interface CardDrag { t: BuildableType; x: number; y: number }
export interface BoardHandle { cellAt(clientX: number, clientY: number, size: number): { x: number; y: number } | null }

interface Props {
  game: GameState; viewer: number; theme: Theme;
  drawMode: boolean; tool: 'pen' | 'eraser'; color: 'a' | 'b';
  selectedId: number | null; menu: MenuModel | null; cardDrag: CardDrag | null;
  dispatch: (a: Action, quiet?: boolean) => void;
  say: (m: string, ok?: boolean) => void;
  onSelect: (id: number) => void; onPawnClick: () => void; onMenuClose: () => void;
  toast: { text: string; ok: boolean } | null;
}

interface Press { vx: number; vy: number; kind: 'pawn' | 'pan'; pan0: { x: number; y: number }; moved: boolean }

export const Board = forwardRef<BoardHandle, Props>(function Board(props, ref) {
  const { game: g, viewer, theme: th, drawMode, tool, color, selectedId, menu, cardDrag, dispatch, say } = props;
  const { cols, rows } = g.config;
  const WW = cols * T, WH = rows * T;
  const el = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number; ok: boolean; cost: number; why?: string; wx: number; wy: number; vx: number; vy: number } | null>(null);
  const press = useRef<Press | null>(null);
  const stroke = useRef<{ x: number; y: number } | null>(null);
  const centered = useRef(false);
  const me = g.players[viewer];

  useEffect(() => {
    const n = el.current; if (!n) return;
    const measure = () => { const r = n.getBoundingClientRect(); setVp({ w: r.width, h: r.height }); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(n);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!centered.current && vp.w > 0) { centered.current = true; setPan({ x: (vp.w - WW) / 2, y: (vp.h - WH) / 2 }); }
  }, [vp, WW, WH]);

  const clampPan = useCallback((z: number, p: { x: number; y: number }) => {
    const w = WW * z, h = WH * z, m = 120;
    return { x: Math.min(vp.w - m, Math.max(m - w, p.x)), y: Math.min(vp.h - m, Math.max(m - h, p.y)) };
  }, [WW, WH, vp]);
  const zoomAt = (z: number, cx: number, cy: number) => {
    const nz = Math.max(0.6, Math.min(2, z));
    const wx = (cx - pan.x) / zoom, wy = (cy - pan.y) / zoom;
    setZoom(nz); setPan(clampPan(nz, { x: cx - wx * nz, y: cy - wy * nz }));
  };

  const local = (e: { clientX: number; clientY: number }) => {
    const r = el.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const toWorld = (v: { x: number; y: number }) => ({ x: (v.x - pan.x) / zoom, y: (v.y - pan.y) / zoom });
  const inB = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows;

  useImperativeHandle(ref, () => ({
    cellAt(cx, cy, size) {
      const r = el.current!.getBoundingClientRect();
      const v = { x: cx - r.left, y: cy - r.top };
      if (v.x < 0 || v.y < 0 || v.x >= r.width || v.y >= r.height) return null;
      const w = toWorld(v);
      return { x: Math.floor(w.x / T - size / 2 + 0.5), y: Math.floor(w.y / T - size / 2 + 0.5) };
    },
  }));

  /* ホイールは passive:false で止める */
  useEffect(() => {
    const n = el.current; if (!n) return;
    const h = (e: WheelEvent) => {
      e.preventDefault();
      const r = n.getBoundingClientRect();
      zoomAt(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12), e.clientX - r.left, e.clientY - r.top);
    };
    n.addEventListener('wheel', h, { passive: false });
    return () => n.removeEventListener('wheel', h);
  });

  /* ---- ポインタ ---- */
  const onDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const v = local(e), w = toWorld(v);
    if (drawMode) {
      const p = { x: w.x / T, y: w.y / T };
      stroke.current = p;
      if (tool === 'pen') dispatch({ type: 'draw', x0: p.x, y0: p.y, x1: p.x, y1: p.y, color }, true);
      else dispatch({ type: 'erase', x: p.x, y: p.y, r: 12 / zoom / T }, true);
      return;
    }
    const tx = Math.floor(w.x / T), ty = Math.floor(w.y / T);
    press.current = { vx: v.x, vy: v.y, kind: tx === me.x && ty === me.y ? 'pawn' : 'pan', pan0: { ...pan }, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const v = local(e), w = toWorld(v);
    if (drawMode) {
      if (!stroke.current) return;
      const p = { x: w.x / T, y: w.y / T }, l = stroke.current;
      if (tool === 'pen') {
        if (Math.hypot(p.x - l.x, p.y - l.y) * T * zoom > 2.5) { dispatch({ type: 'draw', x0: l.x, y0: l.y, x1: p.x, y1: p.y, color }, true); stroke.current = p; }
      } else dispatch({ type: 'erase', x: p.x, y: p.y, r: 12 / zoom / T }, true);
      return;
    }
    const pr = press.current;
    if (!pr) {
      const tx = Math.floor(w.x / T), ty = Math.floor(w.y / T);
      const h = inB(tx, ty) ? { x: tx, y: ty } : null;
      setHover((o) => (o?.x === h?.x && o?.y === h?.y ? o : h));
      return;
    }
    const dist = Math.hypot(v.x - pr.vx, v.y - pr.vy);
    if (!pr.moved && dist > 6) { pr.moved = true; setHover(null); }
    if (pr.moved && pr.kind === 'pawn') {
      const tx = Math.floor(w.x / T), ty = Math.floor(w.y / T);
      const r = route(g, viewer, tx, ty);
      setDrag({ x: tx, y: ty, ok: r.ok, cost: r.cost, why: r.why, wx: w.x, wy: w.y, vx: v.x, vy: v.y });
    } else if (pr.moved) {
      setPan(clampPan(zoom, { x: pr.pan0.x + (v.x - pr.vx), y: pr.pan0.y + (v.y - pr.vy) }));
    }
  };
  const onUp = (e: React.PointerEvent) => {
    if (drawMode) { stroke.current = null; return; }
    const pr = press.current; press.current = null;
    if (!pr) return;
    if (drag) {
      const d = drag; setDrag(null);
      if (d.ok) dispatch({ type: 'move', player: viewer, x: d.x, y: d.y });
      else if (d.why && d.why !== 'いまいるマスです') say('移動できません：' + d.why, false);
      return;
    }
    if (pr.moved) return;
    if (pr.kind === 'pawn') { props.onPawnClick(); return; }
    const w = toWorld(local(e)), tx = Math.floor(w.x / T), ty = Math.floor(w.y / T);
    const b = inB(tx, ty) ? buildingAt(g, tx, ty) : null;
    if (b) props.onSelect(b.id);
  };
  const onLeave = () => { setHover(null); stroke.current = null; if (press.current) { press.current = null; setDrag(null); } };

  /* ---- 描画データ ---- */
  const tiles = useMemo(() => {
    const out: JSX.Element[] = [];
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      out.push(<div key={x + ',' + y} style={{ position: 'absolute', left: x * T, top: y * T, width: T, height: T, background: isReachable(g, x, y) ? th.vars.reach : th.vars.tile, borderRight: '1px solid var(--grid)', borderBottom: '1px solid var(--grid)' }} />);
    }
    return out;
  }, [g.buildings, cols, rows, th]);

  const pathFor = (c: string) => {
    let d = '';
    for (const list of Object.values(g.drawing)) for (const s of list) {
      if (s.c !== c) continue;
      d += `M${(s.x0 * T).toFixed(1)} ${(s.y0 * T).toFixed(1)}L${(s.x1 * T + (s.x0 === s.x1 && s.y0 === s.y1 ? 0.01 : 0)).toFixed(2)} ${(s.y1 * T).toFixed(1)}`;
    }
    return d;
  };
  const pathA = useMemo(() => pathFor('a'), [g.drawing]);
  const pathB = useMemo(() => pathFor('b'), [g.drawing]);

  const roadAt = (x: number, y: number) => g.buildings.some((q) => q.t === 'road' && q.x === x && q.y === y);
  const pawnTile = (x: number, y: number) => g.players.some((p) => p.x === x && p.y === y);

  const weather = g.weather;
  const wcfg = ({ snow: [26, 'sf-fall'], blizzard: [60, 'sf-blow'], rain: [48, 'sf-rain'], final: [100, 'sf-blow'], clear: [0, ''] } as const)[weather];
  const particles = useMemo(() => {
    const out: JSX.Element[] = [];
    for (let i = 0; i < wcfg[0]; i++) {
      const r1 = ((i * 73) % 100) / 100, r2 = ((i * 41 + 17) % 100) / 100, r3 = ((i * 29 + 5) % 100) / 100;
      if (weather === 'rain') {
        out.push(<div key={i} className="sf-p" style={{ position: 'absolute', top: 0, left: (r1 * 110).toFixed(1) + '%', width: 2, height: 12 + Math.round(r2 * 10), background: th.rain, opacity: .6, borderRadius: 1, animation: `sf-rain ${(0.7 + r3 * 0.5).toFixed(2)}s linear ${(-r2 * 2).toFixed(2)}s infinite` }} />);
      } else {
        const big = weather === 'final' ? 5 : weather === 'blizzard' ? 4 : 3;
        const sz = 2 + Math.round(r2 * big);
        const dur = weather === 'final' ? 0.8 + r3 * 0.7 : weather === 'blizzard' ? 1.2 + r3 : 4 + r3 * 3;
        out.push(<div key={i} className="sf-p" style={{ position: 'absolute', top: 0, left: (weather === 'snow' ? r1 * 100 : r1 * 135).toFixed(1) + '%', width: sz, height: sz, borderRadius: '50%', background: th.flake, opacity: .8, animation: `${wcfg[1]} ${dur.toFixed(2)}s linear ${(-r2 * 6).toFixed(2)}s infinite` }} />);
      }
    }
    return out;
  }, [weather, th]);

  /* 建設プレビュー */
  let preview: { x: number; y: number; size: number; bad: boolean } | null = null;
  if (cardDrag) {
    const size = BUILDING_DEFS[cardDrag.t].size;
    const r = el.current?.getBoundingClientRect();
    if (r && cardDrag.x >= r.left && cardDrag.x < r.right && cardDrag.y >= r.top && cardDrag.y < r.bottom) {
      const w = toWorld({ x: cardDrag.x - r.left, y: cardDrag.y - r.top });
      const x = Math.floor(w.x / T - size / 2 + 0.5), y = Math.floor(w.y / T - size / 2 + 0.5);
      preview = { x, y, size, bad: !!buildCheck(g, x, y, cardDrag.t) };
    }
  }

  const sw = T * zoom;
  const hb = hover && !drag && !drawMode && !cardDrag ? buildingAt(g, hover.x, hover.y) : null;

  const cursor = drawMode ? 'crosshair' : drag ? 'grabbing' : 'default';
  const hint = drawMode ? 'ドラッグで描く。他の人の絵も編集できる' : drag ? '離したマスへ移動します' : '駒をドラッグで移動／駒クリックで行動／背景ドラッグで視点移動／ホイールで拡大縮小';

  const roadCol = th.road;
  const warmStyle = (b: { t: string; hp: number | null; max: number | null }, lost: boolean) => {
    const c = th.card[lost ? 'off' : b.t];
    return { fill: c[0], bd: c[1], fg: c[2] };
  };

  /* メニュー位置 */
  let menuPos = { left: 0, top: 0 };
  if (menu) {
    const px0 = pan.x + me.x * sw, py0 = pan.y + me.y * sw;
    const h = 56 + menu.entries.length * 36 + menu.entries.filter((q) => q.head).length * 24;
    let left = px0 + sw + 10;
    if (left + 292 > vp.w - 4) left = px0 - 292 - 10;
    menuPos = { left: Math.max(4, left), top: Math.max(4, Math.min(py0 - 20, vp.h - h - 4)) };
  }

  const dragTip = drag ? (drag.ok ? (drag.cost > 0 ? '移動：体温 -' + drag.cost : '移動：体温は減りません') : drag.why ?? '') : '';

  return (
    <div className="map" ref={el}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: WW, height: WH, transformOrigin: '0 0', transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})` }}>
        {tiles}
        <svg width={WW} height={WH} viewBox={`0 0 ${WW} ${WH}`} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }} aria-hidden="true">
          <path d={pathA} fill="none" style={{ stroke: th.penA }} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
          <path d={pathB} fill="none" style={{ stroke: th.penB }} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {g.buildings.filter((b) => b.t === 'road').map((b) => {
          const n = roadAt(b.x, b.y - 1), e = roadAt(b.x + 1, b.y), s2 = roadAt(b.x, b.y + 1), w = roadAt(b.x - 1, b.y);
          const rr = (a: boolean, c: boolean) => (!a && !c ? '10px' : '0');
          return <div key={b.id} style={{ position: 'absolute', left: b.x * T, top: b.y * T, width: T, height: T, background: roadCol, borderStyle: 'solid', borderColor: th.roadBd, borderWidth: [n, e, s2, w].map((o) => (o ? '0' : '3px')).join(' '), borderRadius: [rr(n, w), rr(n, e), rr(s2, e), rr(s2, w)].join(' '), boxShadow: selectedId === b.id ? `inset 0 0 0 3px ${th.vars.accent}` : 'none' }} />;
        })}

        {g.buildings.filter((b) => b.t !== 'road').map((b) => {
          const isFire = b.t === 'fire', ins = isInsulated(b), warm = isWarm(b), lost = warm && !ins;
          const c = warmStyle(b, lost);
          let status = '', chip: string[] | null = null;
          if (isFire) { status = `火力 ${g.fire} / ${g.config.maxFire}`; chip = th.chip.fire; }
          else if (warm) { status = ins ? '防寒 有効' : '防寒 消失'; chip = ins ? th.chip.ok : th.chip.lost; }
          return (
            <div key={b.id} style={{ position: 'absolute', left: b.x * T + 3, top: b.y * T + 3, width: b.w * T - 6, height: b.h * T - 6, background: c.fill, border: `2px solid ${c.bd}`, borderRadius: 10, padding: '7px 8px', display: 'flex', flexDirection: 'column', gap: 5, color: c.fg, boxShadow: selectedId === b.id ? `0 0 0 3px ${th.vars.accent}` : 'none', overflow: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                <Icon name={b.t} /><div style={{ fontWeight: 700, fontSize: 13 }}>{DESC[b.t].name}</div>
              </div>
              {status && chip && <div style={{ alignSelf: 'flex-start', fontSize: 12, fontWeight: 700, padding: '1px 8px', borderRadius: 999, background: chip[0], color: chip[1], whiteSpace: 'nowrap' }}>{status}</div>}
              {isFire && (
                <div style={{ display: 'flex', gap: 3 }}>
                  {Array.from({ length: g.config.maxFire }, (_, i) => <div key={i} style={{ flex: 1, height: 8, borderRadius: 2, background: i + 1 <= g.fire ? th.fireOn : th.fireOff }} />)}
                </div>
              )}
              {!isFire && b.hp !== null && b.max !== null && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ flex: 1, height: 6, borderRadius: 3, background: th.hpTrack, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.round((b.hp / b.max) * 100)}%`, height: '100%', background: b.hp * 2 > b.max ? th.hpOk : th.hpLow }} />
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>HP {b.hp}/{b.max}</div>
                </div>
              )}
              {b.w >= 3 && <div style={{ fontSize: 12, lineHeight: 1.5 }}>{isFire ? '上に立って「温まる」＝火力ぶん体温回復。「焚べる」＝木材1で火力+1。' : '共有アイテムの上限 +10。'}</div>}
            </div>
          );
        })}

        {[...g.resources.map((r) => ({ k: r.t === 'tree' ? 'tree' : r.t, x: r.x, y: r.y, badge: String(r.hp), id: 'r' + r.id })),
          ...g.animals.map((a) => ({ k: 'animal', x: a.x, y: a.y, badge: String(a.hp), id: 'a' + a.id })),
          ...g.plants.map((p) => ({ k: 'plant', x: p.x, y: p.y, badge: '苗', id: 'p' + p.id }))].map((e) => {
          const s = th.res[e.k], occ = pawnTile(e.x, e.y);
          return (
            <div key={e.id} style={{ position: 'absolute', left: occ ? e.x * T + T - 33 : e.x * T + 11, top: occ ? e.y * T + 3 : e.y * T + 11, width: 30, height: 30, borderRadius: '50%', background: s[0], border: `2px solid ${s[1]}`, color: s[2], display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={e.k} size={17} />
              <div style={{ position: 'absolute', right: -7, bottom: -7, minWidth: 16, height: 16, borderRadius: 8, background: '#0f1620', color: '#fff', border: '1px solid rgba(255,255,255,.55)', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '0 3px' }}>{e.badge}</div>
            </div>
          );
        })}

        {g.players.map((p, i) => {
          const other = !!(resourceAt(g, p.x, p.y) || animalAt(g, p.x, p.y) || g.plants.some((q) => q.x === p.x && q.y === p.y));
          return (
            <div key={i} style={{ position: 'absolute', left: other ? p.x * T + 3 : p.x * T + 13, top: other ? p.y * T + T - 29 : p.y * T + 13, width: 26, height: 26, borderRadius: '50%', background: p.color, color: '#fff', border: '2px solid #fff', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: i === viewer ? `0 0 0 2px ${th.vars.text}` : '0 1px 3px rgba(0,0,0,.4)', opacity: i === viewer && drag ? 0.35 : 1 }}>{i + 1}</div>
          );
        })}

        {preview && <div style={{ position: 'absolute', left: preview.x * T, top: preview.y * T, width: preview.size * T, height: preview.size * T, border: `2px dashed ${preview.bad ? th.ng : th.ok}`, background: preview.bad ? 'rgba(220,70,60,.2)' : 'rgba(60,170,120,.22)', borderRadius: 8, pointerEvents: 'none' }} />}
        {drag && (
          <>
            <div style={{ position: 'absolute', left: drag.x * T, top: drag.y * T, width: T, height: T, border: `2px solid ${drag.ok ? th.ok : th.ng}`, background: drag.ok ? 'rgba(60,170,120,.22)' : 'rgba(220,70,60,.2)', borderRadius: 8, pointerEvents: 'none' }} />
            <div style={{ position: 'absolute', left: drag.wx - 15, top: drag.wy - 15, width: 30, height: 30, borderRadius: '50%', background: 'var(--accent)', color: '#fff', border: '2px solid #fff', boxShadow: '0 0 0 2px var(--text)', opacity: .92, display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, pointerEvents: 'none' }}>{viewer + 1}</div>
          </>
        )}
      </div>

      <div style={{ position: 'absolute', inset: 0, background: th.tint[weather], pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>{particles}</div>

      <div role="application" aria-label="マップ" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={onLeave}
        style={{ position: 'absolute', inset: 0, cursor, touchAction: 'none' }} />

      <div className="glass" style={{ position: 'absolute', left: 10, top: 10, fontSize: 12, fontWeight: 500, borderRadius: 999, padding: '3px 12px', pointerEvents: 'none' }}>{hint}</div>
      <div className="glass" style={{ position: 'absolute', right: 10, top: 10, display: 'flex', alignItems: 'center', gap: 4, borderRadius: 999, padding: 3 }}>
        <button aria-label="縮小" onClick={() => zoomAt(zoom / 1.2, vp.w / 2, vp.h / 2)} style={zb}>−</button>
        <div style={{ minWidth: 44, textAlign: 'center', fontSize: 12, fontWeight: 700 }}>{Math.round(zoom * 100)}%</div>
        <button aria-label="拡大" onClick={() => zoomAt(zoom * 1.2, vp.w / 2, vp.h / 2)} style={zb}>＋</button>
        <button aria-label="表示をリセット" onClick={() => { setZoom(1); setPan({ x: (vp.w - WW) / 2, y: (vp.h - WH) / 2 }); }} style={{ height: 28, border: 'none', borderRadius: 999, background: 'var(--menuBtn)', fontSize: 12, fontWeight: 700, padding: '0 10px' }}>リセット</button>
      </div>
      {props.toast && <div className="glass" style={{ position: 'absolute', left: '50%', bottom: 14, transform: 'translateX(-50%)', maxWidth: 700, border: `1px solid ${props.toast.ok ? 'var(--menuB)' : th.ng}`, borderRadius: 999, padding: '6px 16px', fontSize: 13, fontWeight: 500, color: props.toast.ok ? 'var(--text)' : th.redFg, pointerEvents: 'none' }}>{props.toast.text}</div>}

      {hb && (() => {
        const dsc = DESC[hb.t], warm = isWarm(hb), ins = isInsulated(hb);
        let left = pan.x + (hb.x + hb.w) * sw + 10;
        if (left + 232 > vp.w - 4) left = pan.x + hb.x * sw - 232 - 10;
        const top = Math.max(4, Math.min(pan.y + hb.y * sw, vp.h - 110));
        const st = warm ? (ins ? '防寒 有効' : '防寒 消失') : hb.t === 'fire' ? `火力 ${g.fire} / ${g.config.maxFire}` : '';
        return (
          <div className="tip glass" style={{ left: Math.max(4, left), top }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}><div style={{ fontSize: 14, fontWeight: 700 }}>{dsc.name}</div><div style={{ flex: 1 }} /><div style={{ fontSize: 12, fontWeight: 700, color: warm ? (ins ? th.chip.ok[1] : th.chip.lost[1]) : th.chip.fire[1] }}>{st}</div></div>
            <div style={{ fontSize: 12, lineHeight: 1.55 }}>{dsc.tip}</div>
            {hb.hp !== null && <div style={{ fontSize: 12, color: 'var(--muted2)' }}>HP {hb.hp} / {hb.max}</div>}
          </div>
        );
      })()}
      {drag && <div className="tip glass" style={{ left: Math.max(4, Math.min(drag.vx + 16, vp.w - 250)), top: Math.max(4, drag.vy - 44) }}><div style={{ fontSize: 14, fontWeight: 700 }}>{dragTip}</div></div>}

      {menu && !drawMode && !drag && (
        <div className="menu glass" style={{ left: menuPos.left, top: menuPos.top }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 4px 4px' }}>
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 14, fontWeight: 700 }}>{menu.title}</div><div style={{ fontSize: 12, color: 'var(--muted2)' }}>{menu.sub}</div></div>
            <button aria-label="メニューを閉じる" onClick={props.onMenuClose} style={{ width: 26, height: 26, border: 'none', background: 'var(--menuBtn)', borderRadius: 6, fontSize: 14, fontWeight: 700, padding: 0 }}>×</button>
          </div>
          {menu.entries.map((e, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {e.head && <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--muted2)', padding: '6px 4px 0' }}>{e.head}</div>}
              <button className="it" aria-disabled={!!e.why} aria-label={e.label}
                onClick={() => { if (e.why) say(e.why, false); else e.run(); }}
                style={{ borderColor: e.why ? 'transparent' : 'var(--menuB)', background: e.why ? 'transparent' : 'var(--menuBtn)', color: e.why ? 'var(--muted2)' : 'var(--text)' }}>
                <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{e.label}</div><div style={{ flex: 1 }} />
                <div style={{ fontSize: 12, whiteSpace: 'nowrap', color: e.why ? th.redFg : 'var(--muted2)' }}>{e.why || e.cost}</div>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

const zb: React.CSSProperties = { width: 28, height: 28, border: 'none', borderRadius: '50%', background: 'transparent', fontSize: 16, fontWeight: 700, padding: 0 };
