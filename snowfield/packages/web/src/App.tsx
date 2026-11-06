import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BUILDING_DEFS, ITEM_LABEL, ITEM_ORDER, WEATHER_LABEL, applyAction, createGame, isInsulated, itemCap, totalItems,
  type Action, type BuildableType, type GameState, type ItemKey,
} from '@snowfield/core';
import { Board, type BoardHandle, type CardDrag } from './Board';
import { DARK, LIGHT } from './theme';
import { DESC, IDESC, T, WEATHER_FX, costText, isWarm, phaseLabel } from './ui';
import { buildMenu } from './menu';
import { Icon, itemIcon } from './icons';

const THEME_KEY = 'snowfield-theme';

export default function App() {
  const [game, setGame] = useState<GameState | null>(null);
  const [viewer, setViewer] = useState(0);
  const [dark, setDark] = useState(() => { try { return localStorage.getItem(THEME_KEY) !== 'light'; } catch { return true; } });
  const [toast, setToast] = useState<{ text: string; ok: boolean } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tray, setTray] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const [drawMode, setDrawMode] = useState(false);
  const [tool, setTool] = useState<'pen' | 'eraser'>('pen');
  const [color, setColor] = useState<'a' | 'b'>('a');
  const [cardDrag, setCardDrag] = useState<CardDrag | null>(null);
  const [itip, setItip] = useState<{ k: ItemKey; x: number; y: number } | null>(null);
  const [setup, setSetup] = useState(true);
  const [count, setCount] = useState(3);
  const board = useRef<BoardHandle>(null);
  const timer = useRef<number>();
  const gameRef = useRef<GameState | null>(null);
  gameRef.current = game;
  const th = dark ? DARK : LIGHT;

  useEffect(() => { try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* 保存できなくても動く */ } }, [dark]);

  const say = (text: string, ok = true) => {
    if (!text) return;
    setToast({ text, ok });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 5000);
  };

  /** 行動を適用する。state は常に最新の ref から取る（ドラッグ中の連続呼び出し対策） */
  const act = (a: Action, quiet = false) => {
    const g = gameRef.current; if (!g) return;
    const r = applyAction(g, a);
    gameRef.current = r.state;
    setGame(r.state);
    if (!quiet || !r.ok) say(r.message, r.ok);
    if (a.type === 'endTurn' && r.ok) { setViewer(r.state.turn); setMenuOpen(false); }
    if (a.type === 'build' && r.ok) { setSel(r.state.buildings[r.state.buildings.length - 1].id); }
  };

  const start = () => {
    const g = createGame({ players: count, seed: (Math.random() * 2 ** 31) | 0 });
    gameRef.current = g; setGame(g); setViewer(0); setSetup(false); setSel(null); setMenuOpen(false); setTray(false); setDrawMode(false);
    say('ゲーム開始。駒をドラッグで移動、クリックで行動できます');
  };

  /* 建設カードのドラッグ（ウィンドウ全体でポインタを追う） */
  const dragging = useRef<BuildableType | null>(null);
  useEffect(() => {
    const move = (e: PointerEvent) => { if (dragging.current) setCardDrag({ t: dragging.current, x: e.clientX, y: e.clientY }); };
    const up = (e: PointerEvent) => {
      const t = dragging.current; if (!t) return;
      dragging.current = null; setCardDrag(null);
      const c = board.current?.cellAt(e.clientX, e.clientY, BUILDING_DEFS[t].size);
      if (!c) { say('盤面の上にドロップしてください', false); return; }
      act({ type: 'build', player: gameRef.current!.turn === viewerRef.current ? viewerRef.current : viewerRef.current, building: t, x: c.x, y: c.y });
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  }, []);
  const viewerRef = useRef(0); viewerRef.current = viewer;

  const menu = useMemo(
    () => (game && menuOpen && !drawMode ? buildMenu(game, viewer, (a) => act(a), () => { setTray(true); say('左下に建設カードの一覧を出しました。盤面へドラッグして置いてください'); }) : null),
    [game, viewer, menuOpen, drawMode],
  );

  if (!game) {
    return <div className="app" style={themeStyle(th)}>{<SetupModal count={count} setCount={setCount} start={start} min={2} max={5} />}</div>;
  }
  const g = game, me = g.players[viewer], myTurn = g.turn === viewer;
  const cap = itemCap(g), total = totalItems(g);
  const ph = phaseLabel(g);
  const hasTower = g.buildings.some((b) => b.t === 'tower');
  const sb = g.buildings.find((b) => b.id === sel) ?? null;

  const itemPct = (n: number) => `${Math.round((n / 10) * 100)}%`;
  void itemPct;

  const trayWhy = (t: BuildableType) => {
    const d = BUILDING_DEFS[t];
    if (!myTurn) return '自分の手番ではありません';
    if (me.incapacitated) return '行動不能：温まる／食べるだけ';
    if (me.ap < d.ap) return '行動力が足りません';
    for (const [k, n] of Object.entries(d.cost) as Array<[ItemKey, number]>) if (g.items[k] < n) return ITEM_LABEL[k] + 'が足りません';
    return '';
  };

  return (
    <div className="app" style={themeStyle(th)}>
      {/* 上部バー */}
      <header className="topbar">
        <h1>Snowfield</h1>
        <div className="pill" style={{ background: 'var(--chip)' }}>{ph.round}</div>
        {ph.until && <div className="pill" style={{ background: 'var(--orgBg)', color: 'var(--orgFg)' }}>{ph.until}</div>}
        {hasTower && <div className="pill" style={{ background: 'var(--grnBg)', color: 'var(--grnFg)' }}>予報（見張り台）：{g.nextWeather ? `次ラウンドは${WEATHER_LABEL[g.nextWeather]}` : '次はありません'}</div>}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>現在の天候：<b style={{ color: 'var(--text)' }}>{WEATHER_LABEL[g.weather]}</b>（{WEATHER_FX[g.weather]}）</div>
        <div className="seg" role="group" aria-label="操作するプレイヤー">
          {g.players.map((p, i) => (
            <button key={i} aria-label={`${p.name}を操作`} aria-pressed={i === viewer} onClick={() => { setViewer(i); setMenuOpen(false); }}
              style={{ background: i === viewer ? 'var(--text)' : 'var(--btn)', color: i === viewer ? 'var(--panel)' : 'var(--text)' }}>{i + 1}</button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="表示テーマ">
          {[['ライト', false], ['ダーク', true]].map(([l, d]) => (
            <button key={String(l)} aria-pressed={dark === d} onClick={() => setDark(d as boolean)}
              style={{ background: dark === d ? 'var(--text)' : 'var(--btn)', color: dark === d ? 'var(--panel)' : 'var(--text)' }}>{l}</button>
          ))}
        </div>
        <button aria-label="手番を終える" disabled={g.turn !== viewer || g.phase !== 'playing'} onClick={() => act({ type: 'endTurn', player: viewer })}
          style={{ height: 34, padding: '0 14px', border: '1px solid var(--accent)', background: 'var(--accBg)', color: 'var(--accFg)', borderRadius: 8, fontSize: 13, fontWeight: 700 }}>手番を終える</button>
        <button aria-label="新しいゲーム" onClick={() => setSetup(true)} className="smallbtn" style={{ height: 34 }}>新規</button>
      </header>

      <div className="body">
        {/* 左 */}
        <div className="col-l">
          {g.players.map((p, i) => (
            <div key={i} className="pcard" style={{ border: `2px solid ${i === viewer ? 'var(--accent)' : 'var(--pb)'}` }}>
              <div className="row">
                <div style={{ width: 22, height: 22, borderRadius: '50%', background: p.color, color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{i + 1}</div>
                <div style={{ fontWeight: 700 }}>{p.name}</div><div style={{ flex: 1 }} />
                {p.incapacitated && <div style={{ fontSize: 12, background: 'var(--redBg)', color: 'var(--redFg)', borderRadius: 999, padding: '2px 8px', fontWeight: 700 }}>行動不能</div>}
                {g.turn === i && <div style={{ fontSize: 12, background: 'var(--accBg)', color: 'var(--accFg)', borderRadius: 999, padding: '2px 8px', fontWeight: 700 }}>手番中</div>}
              </div>
              <Gauge label="体温" v={p.temp} max={g.config.maxTemp} col={p.temp <= 3 ? th.tempLow : th.temp} low={p.temp <= 3} />
              <Gauge label="満腹度" v={p.food} max={g.config.maxFood} col={p.food <= 3 ? th.foodLow : th.food} low={p.food <= 3} />
              {i === viewer && <Gauge label="行動力" v={p.ap} max={g.config.apPerTurn} col="var(--ap)" />}
            </div>
          ))}
          <div style={{ flex: 1, minHeight: 120, background: 'var(--panel)', border: '1px dashed var(--bb)', borderRadius: 12, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, overflow: 'auto' }}>
            <div className="row"><div style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700 }}>建設カード</div><div style={{ flex: 1 }} />
              {tray && <button aria-label="建設カードをしまう" onClick={() => setTray(false)} style={{ width: 24, height: 24, border: 'none', background: 'var(--chip)', borderRadius: 6, fontSize: 13, fontWeight: 700, color: 'var(--muted2)', padding: 0 }}>×</button>}
            </div>
            {!tray ? <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>駒をクリック →「建てる」を選ぶと、ここに建設カードの一覧が出ます。</div> : (
              <>
                <div className="tiny">カードを盤面へドラッグして置くと建設します。</div>
                {(['road', 'igloo', 'storage', 'tower'] as BuildableType[]).map((k) => {
                  const d = BUILDING_DEFS[k], why = trayWhy(k), isR = k === 'road', c = th.card[isR ? 'storage' : k];
                  return (
                    <div key={k} role="button" tabIndex={0} aria-label={`${d.name}を建てる（盤面へドラッグ）`} aria-disabled={!!why}
                      onPointerDown={(e) => { if (why) { say(why, false); return; } e.preventDefault(); dragging.current = k; setCardDrag({ t: k, x: e.clientX, y: e.clientY }); }}
                      style={{ padding: '8px 10px', border: `2px solid ${isR ? th.roadBd : c[1]}`, background: isR ? th.road : c[0], color: isR ? th.vars.text : c[2], borderRadius: 10, cursor: why ? 'not-allowed' : 'grab', opacity: why ? 0.55 : 1, touchAction: 'none', display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap' }}>{d.name}（{d.size}×{d.size}）</div>
                      <div style={{ fontSize: 12, color: why ? th.redFg : 'inherit' }}>{why || costText(k)}</div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>

        {/* 中央 */}
        <div className="col-c">
          <Board ref={board} game={g} viewer={viewer} theme={th} drawMode={drawMode} tool={tool} color={color} selectedId={sel}
            menu={menu} cardDrag={cardDrag} dispatch={act} say={say} toast={toast}
            onSelect={setSel} onPawnClick={() => setMenuOpen((o) => !o)} onMenuClose={() => setMenuOpen(false)} />
        </div>

        {/* 右 */}
        <div className="col-r">
          <div className="panel" style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>共有アイテム</div><div style={{ flex: 1 }} />
              <div style={{ fontSize: 13, fontWeight: 700, color: total >= cap ? th.redFg : 'var(--text)' }}>{total} / {cap}</div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {(() => {
                const slots: JSX.Element[] = [];
                ITEM_ORDER.forEach((k) => {
                  for (let i = 0; i < g.items[k]; i++) {
                    const c = th.item[k];
                    slots.push(
                      <button key={k + i} aria-label={ITEM_LABEL[k] + 'を1個捨てる（投票）'}
                        onClick={() => act({ type: 'startVote', player: viewer, item: k })}
                        onPointerMove={(e) => setItip({ k, x: e.clientX, y: e.clientY })} onPointerLeave={() => setItip(null)}
                        style={{ width: 28, height: 28, borderRadius: 7, border: `1px solid ${c[1]}66`, background: c[0], color: c[1], padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name={itemIcon(k)} />
                      </button>,
                    );
                  }
                });
                while (slots.length < cap) slots.push(<div key={'e' + slots.length} style={{ width: 28, height: 28, borderRadius: 7, border: '1px dashed var(--bb)' }} />);
                return slots;
              })()}
            </div>
            <div className="tiny" style={{ lineHeight: 1.6 }}>{ITEM_ORDER.map((k) => ITEM_LABEL[k] + g.items[k]).join('　')}</div>
            <div className="tiny">アイコンをクリックすると「捨てる」投票を始めます。上限＝2×人数＋10＋10×倉庫数。</div>
          </div>

          {g.vote && (
            <div className="panel" style={{ border: '2px solid var(--accent)', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>「{ITEM_LABEL[g.vote.item]}」を1個捨てる投票</div>
              {g.players.map((p, i) => {
                const v = g.vote!.votes[i];
                return (
                  <div key={i} className="row" style={{ fontSize: 13, gap: 6 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>{p.name}</div>
                    <b style={{ color: v > 0 ? th.ok : v < 0 ? th.redFg : 'var(--muted)' }}>{v > 0 ? '賛成' : v < 0 ? '反対' : '未投票'}</b>
                    {v === 0 && <>
                      <button className="smallbtn" aria-label={`${p.name}の賛成`} onClick={() => act({ type: 'castVote', player: i, value: 1 })}>賛成</button>
                      <button className="smallbtn" aria-label={`${p.name}の反対`} onClick={() => act({ type: 'castVote', player: i, value: -1 })}>反対</button>
                    </>}
                  </div>
                );
              })}
              <div className="row"><div className="tiny" style={{ flex: 1 }}>過半数の賛成で捨てます。他プレイヤーの票はここで代わりに押せます。</div>
                <button className="smallbtn" onClick={() => act({ type: 'cancelVote' })}>取り下げ</button></div>
            </div>
          )}

          <div className="panel" style={{ flex: 1, minHeight: 0, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, overflow: 'auto' }}>
            <div className="tiny" style={{ fontWeight: 700 }}>建物の詳細（建物をクリック）</div>
            {!sb ? <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6 }}>建物をクリックすると、説明・効果・建設と修理のコストがここに表示されます。</div> : (() => {
              const dsc = DESC[sb.t], ins = isInsulated(sb), warm = isWarm(sb);
              const meta: Array<[string, string]> = [['サイズ', `${sb.w}×${sb.h}`]];
              let status = '', chip: string[] | null = null;
              if (sb.t === 'fire') { meta.push(['火力', `${g.fire} / ${g.config.maxFire}`]); status = '壊れない'; chip = th.chip.fire; }
              else if (sb.t === 'road') { status = '壊れない'; chip = [th.vars.chip, th.vars.muted2]; }
              else {
                meta.push(['HP', `${sb.hp} / ${sb.max}`]);
                if (warm) { status = ins ? '防寒 有効' : '防寒 消失'; chip = ins ? th.chip.ok : th.chip.lost; meta.push(['防寒', ins ? '有効' : '消失（HPが半分以下）']); }
              }
              const canRepair = sb.hp !== null && sb.max !== null;
              const dis = !myTurn || me.incapacitated || !canRepair || (sb.hp ?? 0) >= (sb.max ?? 0) || me.ap < sb.w || g.items.stone < 1;
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div className="row"><div style={{ fontSize: 18, fontWeight: 700 }}>{dsc.name}</div>
                    {status && chip && <div style={{ fontSize: 12, fontWeight: 700, padding: '1px 8px', borderRadius: 999, background: chip[0], color: chip[1] }}>{status}</div>}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>{meta.map(([k, v]) => <div key={k} style={{ display: 'flex', fontSize: 13 }}><div style={{ width: 52, color: 'var(--muted)' }}>{k}</div><div style={{ fontWeight: 500 }}>{v}</div></div>)}</div>
                  <div style={{ fontSize: 13, lineHeight: 1.65 }}>{dsc.desc}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div className="tiny" style={{ fontWeight: 700 }}>効果</div>
                    {dsc.eff.map((t) => <div key={t} style={{ fontSize: 13, lineHeight: 1.5, paddingLeft: 10, borderLeft: '3px solid var(--bb)' }}>{t}</div>)}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
                    <div className="tiny" style={{ fontWeight: 700 }}>コスト</div><div>建設：{dsc.build}</div><div>修理：{dsc.repair}</div>
                  </div>
                  {canRepair && <button className="primary" disabled={dis} aria-label="建物を直す" onClick={() => act({ type: 'repair', player: viewer, building: sb.id })}>直す（行動力{sb.w}・石材1）</button>}
                </div>
              );
            })()}
          </div>

          <div className="panel" style={{ flex: 'none', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <button onClick={() => { setDrawMode(!drawMode); setMenuOpen(false); say(drawMode ? '通常の操作に戻りました' : 'お絵かきモード：ドラッグで描きます。建物や道ができたマスの絵は消えます'); }}
              style={{ width: '100%', height: 36, border: `1px solid ${drawMode ? 'var(--accent)' : 'var(--bb)'}`, background: drawMode ? 'var(--accBg)' : 'var(--btn)', borderRadius: 8, padding: '0 12px', textAlign: 'left', fontSize: 13, fontWeight: 700 }}>
              {drawMode ? 'お絵かきモード：ON' : 'お絵かきモード'}</button>
            {drawMode && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {([['ペン', th.vars.text, tool === 'pen', () => setTool('pen')], ['消しゴム', th.vars.panel, tool === 'eraser', () => setTool('eraser')],
                  ['青', th.penA, color === 'a' && tool === 'pen', () => { setColor('a'); setTool('pen'); }], ['灰', th.penB, color === 'b' && tool === 'pen', () => { setColor('b'); setTool('pen'); }]] as Array<[string, string, boolean, () => void]>).map(([l, sw, on, fn]) => (
                  <button key={l} onClick={fn} aria-pressed={on} style={{ height: 34, border: `1px solid ${on ? 'var(--accent)' : 'var(--bb)'}`, background: on ? 'var(--accBg)' : 'var(--btn)', borderRadius: 8, padding: '0 8px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 13, fontWeight: 700 }}>
                    <div style={{ width: 14, height: 14, borderRadius: '50%', background: sw, border: '1px solid var(--bb)' }} />{l}</button>
                ))}
              </div>
            )}
            <div className="tiny">{drawMode ? 'お絵かき中は行動できません（手番外を想定）' : '手番外のプレイヤーは、雪原のマスに絵を描ける'}</div>
          </div>
        </div>
      </div>

      {itip && (
        <div className="tip glass" style={{ position: 'fixed', left: Math.max(4, itip.x - 246), top: itip.y + 14 }}>
          <div className="row"><div style={{ fontSize: 14, fontWeight: 700 }}>{ITEM_LABEL[itip.k]}</div><div style={{ flex: 1 }} /><div style={{ fontSize: 12, color: 'var(--muted2)' }}>所持 {g.items[itip.k]}個</div></div>
          <div style={{ fontSize: 12, lineHeight: 1.55 }}>{IDESC[itip.k]}</div>
        </div>
      )}
      {cardDrag && (() => {
        const d = BUILDING_DEFS[cardDrag.t], isR = cardDrag.t === 'road', c = th.card[isR ? 'storage' : cardDrag.t];
        const w = Math.max(40, d.size * T - 6);
        return <div style={{ position: 'fixed', left: cardDrag.x - w / 2, top: cardDrag.y - w / 2, width: w, height: w, background: isR ? th.road : c[0], border: `2px solid ${isR ? th.roadBd : c[1]}`, borderRadius: 10, padding: '6px 8px', color: isR ? th.vars.text : c[2], opacity: .82, pointerEvents: 'none', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', boxShadow: 'var(--shadow)', zIndex: 40 }}>{d.name}</div>;
      })()}

      {g.phase !== 'playing' && (
        <div className="modal-bg"><div className="modal" role="dialog" aria-label="ゲーム終了">
          <div style={{ fontSize: 22, fontWeight: 700 }}>{g.phase === 'won' ? '生還！' : 'ゲームオーバー'}</div>
          <div style={{ lineHeight: 1.7 }}>{g.endReason}</div>
          <button className="primary" onClick={() => setSetup(true)}>もう一度あそぶ</button>
        </div></div>
      )}
      {setup && <SetupModal count={count} setCount={setCount} start={start} min={2} max={5} onCancel={() => setSetup(false)} />}
    </div>
  );
}

function Gauge({ label, v, max, col, low }: { label: string; v: number; max: number; col: string; low?: boolean }) {
  return (
    <div className="row" role="meter" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={max}>
      <div className="lbl">{label}</div>
      <div className="track"><div className="fill" style={{ width: `${(v / max) * 100}%`, background: col }} /></div>
      <div className="num" style={{ color: low ? 'var(--redFg)' : 'var(--text)' }}>{v}</div>
    </div>
  );
}

function SetupModal({ count, setCount, start, min, max, onCancel }: { count: number; setCount: (n: number) => void; start: () => void; min: number; max: number; onCancel?: () => void }) {
  return (
    <div className="modal-bg"><div className="modal" role="dialog" aria-label="新しいゲーム">
      <div style={{ fontSize: 22, fontWeight: 700 }}>Snowfield</div>
      <div style={{ color: 'var(--muted2)', lineHeight: 1.7, fontSize: 13 }}>協力して準備期間の10ラウンドを乗り切り、最終猛吹雪の3ラウンドを生き延びよう。1つの画面で、手番のプレイヤーを順番に操作して遊びます。</div>
      <div className="row"><div style={{ fontSize: 13, fontWeight: 700 }}>人数</div><div className="seg">
        {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
          <button key={n} aria-pressed={count === n} onClick={() => setCount(n)} style={{ background: count === n ? 'var(--text)' : 'var(--btn)', color: count === n ? 'var(--panel)' : 'var(--text)' }}>{n}人</button>
        ))}</div></div>
      <div className="row"><button className="primary" style={{ flex: 1 }} onClick={start}>ゲーム開始</button>{onCancel && <button className="smallbtn" style={{ height: 40 }} onClick={onCancel}>閉じる</button>}</div>
    </div></div>
  );
}

function themeStyle(th: typeof DARK): React.CSSProperties {
  return Object.fromEntries(Object.entries(th.vars).map(([k, v]) => ['--' + k, v])) as React.CSSProperties;
}
