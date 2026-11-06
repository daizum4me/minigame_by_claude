import { useState } from 'react';
import type { PublicSeat } from '@snowfield/core';

export type StartChoice =
  | { kind: 'cpu'; name: string; cpus: number }
  | { kind: 'hotseat'; name: string; players: number }
  | { kind: 'host'; name: string }
  | { kind: 'join'; name: string; code: string };

const NAME_KEY = 'snowfield-name';
const loadName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };

export function Menu({ onStart, error, initialCode }: { onStart: (c: StartChoice) => void; error: string | null; initialCode: string }) {
  const [name, setName] = useState(loadName);
  const [cpus, setCpus] = useState(2);
  const [players, setPlayers] = useState(3);
  const [code, setCode] = useState(initialCode);
  const nm = () => { const n = name.trim() || 'プレイヤー'; try { localStorage.setItem(NAME_KEY, n); } catch { /* 保存できなくても動く */ } return n; };
  const Seg = ({ v, set, opts, suffix }: { v: number; set: (n: number) => void; opts: number[]; suffix: string }) => (
    <div className="seg">{opts.map((n) => (
      <button key={n} aria-pressed={v === n} onClick={() => set(n)} style={{ background: v === n ? 'var(--text)' : 'var(--btn)', color: v === n ? 'var(--panel)' : 'var(--text)' }}>{n}{suffix}</button>
    ))}</div>
  );
  const box: React.CSSProperties = { border: '1px solid var(--pb)', borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--bg)' };
  return (
    <div className="modal-bg"><div className="modal" style={{ width: 560, maxHeight: '92vh', overflow: 'auto' }} role="dialog" aria-label="Snowfield">
      <div style={{ fontSize: 26, fontWeight: 700 }}>Snowfield</div>
      <div style={{ color: 'var(--muted2)', lineHeight: 1.7, fontSize: 13 }}>協力して準備期間の10ラウンドを乗り切り、最終猛吹雪の3ラウンドを生き延びよう。ブラウザを開くだけで遊べます。</div>
      {error && <div role="alert" style={{ background: 'var(--redBg)', color: 'var(--redFg)', padding: '8px 12px', borderRadius: 8, fontSize: 13 }}>{error}</div>}
      <label className="row" style={{ fontSize: 13, fontWeight: 700 }}>あなたの名前
        <input value={name} maxLength={12} placeholder="プレイヤー" onChange={(e) => setName(e.target.value)} aria-label="あなたの名前"
          style={{ flex: 1, height: 34, border: '1px solid var(--bb)', borderRadius: 8, padding: '0 10px', background: 'var(--btn)', color: 'var(--text)', fontSize: 14 }} /></label>

      <div style={box}>
        <div style={{ fontWeight: 700 }}>CPUと遊ぶ</div>
        <div className="row"><span className="tiny">CPUの人数</span><Seg v={cpus} set={setCpus} opts={[1, 2, 3, 4]} suffix="人" /><div style={{ flex: 1 }} />
          <button className="primary" style={{ padding: '0 18px' }} onClick={() => onStart({ kind: 'cpu', name: nm(), cpus })}>はじめる</button></div>
      </div>
      <div style={box}>
        <div style={{ fontWeight: 700 }}>みんなで遊ぶ（オンライン）</div>
        <div className="row"><button className="primary" onClick={() => onStart({ kind: 'host', name: nm() })}>部屋を作る</button>
          <div className="tiny" style={{ flex: 1 }}>部屋IDまたは招待リンクを友だちに送ります。CPUを混ぜることもできます。</div></div>
        <div className="row">
          <input value={code} maxLength={5} placeholder="部屋ID（5文字）" onChange={(e) => setCode(e.target.value.toUpperCase())} aria-label="部屋ID"
            style={{ width: 150, height: 34, border: '1px solid var(--bb)', borderRadius: 8, padding: '0 10px', background: 'var(--btn)', color: 'var(--text)', fontSize: 14, letterSpacing: '.15em' }} />
          <button className="primary" disabled={code.trim().length < 5} onClick={() => onStart({ kind: 'join', name: nm(), code })}>参加する</button>
        </div>
      </div>
      <div style={box}>
        <div style={{ fontWeight: 700 }}>同じ画面で遊ぶ</div>
        <div className="row"><span className="tiny">人数</span><Seg v={players} set={setPlayers} opts={[2, 3, 4, 5]} suffix="人" /><div style={{ flex: 1 }} />
          <button className="primary" style={{ padding: '0 18px' }} onClick={() => onStart({ kind: 'hotseat', name: nm(), players })}>はじめる</button></div>
      </div>
    </div></div>
  );
}

export function Lobby({ code, seats, you, hostSeat, online, onAddCpu, onRemove, onStart, onLeave, status }: {
  code: string; seats: PublicSeat[]; you: number | null; hostSeat: number; online: boolean;
  onAddCpu: () => void; onRemove: (i: number) => void; onStart: () => void; onLeave: () => void; status: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const isHost = you !== null && you === hostSeat;
  const link = `${location.origin}${location.pathname}?room=${code}`;
  const copy = async () => { try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { window.prompt('招待リンク', link); } };
  return (
    <div className="modal-bg"><div className="modal" style={{ width: 480 }} role="dialog" aria-label="ロビー">
      <div style={{ fontSize: 22, fontWeight: 700 }}>ロビー</div>
      {online && (
        <div style={{ border: '1px solid var(--pb)', borderRadius: 10, padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--bg)' }}>
          <div className="tiny">部屋ID</div>
          <div style={{ fontSize: 30, fontWeight: 700, letterSpacing: '.25em' }} aria-label={`部屋ID ${code}`}>{code || '…'}</div>
          <button className="smallbtn" style={{ height: 32, alignSelf: 'flex-start' }} disabled={!code} onClick={copy}>{copied ? 'コピーしました' : '招待リンクをコピー'}</button>
        </div>
      )}
      {status && <div className="tiny">{status}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {seats.map((s, i) => (
          <div key={i} className="row" style={{ border: '1px solid var(--pb)', borderRadius: 8, padding: '6px 10px' }}>
            <div style={{ fontWeight: 700 }}>{i + 1}</div><div style={{ flex: 1 }}>{s.name}{i === you ? '（あなた）' : ''}</div>
            {s.cpu && <span className="pill" style={{ background: 'var(--chip)', padding: '1px 8px' }}>CPU</span>}
            {i === hostSeat && <span className="pill" style={{ background: 'var(--accBg)', color: 'var(--accFg)', padding: '1px 8px' }}>ホスト</span>}
            {isHost && i !== hostSeat && <button className="smallbtn" aria-label={`${s.name}を外す`} onClick={() => onRemove(i)}>外す</button>}
          </div>
        ))}
      </div>
      {isHost ? (
        <div className="row">
          <button className="smallbtn" style={{ height: 40 }} disabled={seats.length >= 5} onClick={onAddCpu}>CPUを追加</button>
          <button className="primary" style={{ flex: 1 }} disabled={seats.length < 2} onClick={onStart}>ゲーム開始（{seats.length}人）</button>
        </div>
      ) : <div className="tiny">ホストが開始するのを待っています…</div>}
      <button className="smallbtn" style={{ height: 34 }} onClick={onLeave}>やめる</button>
    </div></div>
  );
}
