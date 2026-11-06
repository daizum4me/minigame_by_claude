import Peer, { type DataConnection } from 'peerjs';
import { Room, type ClientMsg, type ServerMsg } from '@snowfield/core';

/**
 * 通信層。どの形でも画面からは同じ Session として扱える。
 *  - local : このブラウザだけ（同じ画面で遊ぶ／CPUと遊ぶ）
 *  - host  : 部屋を作る。ホストのブラウザで Room を動かし、参加者は PeerJS で直接つながる
 *  - guest : 部屋IDで参加する
 */
export interface Session {
  send(msg: ClientMsg): void;
  close(): void;
}
export interface Handlers {
  onMsg(msg: ServerMsg): void;
  /** 接続の状態表示（再接続中など）。null で表示なし */
  onStatus(text: string | null): void;
  onFatal(text: string): void;
}

const P2P = {
  idPrefix: 'snowfield-v1-',
  codeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  codeLength: 5,
  pingMs: 3000,
  dropMs: 20000,
  maxRetry: 15,
  joinTimeoutMs: 15000,
};

export function getToken(): string {
  try {
    let t = sessionStorage.getItem('snowfield-token');
    if (!t) { t = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem('snowfield-token', t); }
    return t;
  } catch { return Math.random().toString(36).slice(2); }
}

const clone = <T,>(m: T): T => JSON.parse(JSON.stringify(m));
const safeSend = (c: DataConnection, m: unknown) => { try { if (c.open) c.send(m); } catch { /* 切断済み */ } };

export function p2pErrorText(err: unknown): string {
  const t = (err as { type?: string })?.type;
  if (t === 'peer-unavailable') return '部屋が見つかりません。部屋IDを確認してください';
  if (t === 'browser-incompatible') return 'このブラウザはオンライン対戦に対応していません';
  if (t === 'network' || t === 'server-error' || t === 'socket-error') return '通信サーバーに接続できませんでした。インターネット接続を確かめてください';
  return '接続できませんでした。少し待ってからもう一度試してください';
}

/** 自前の PeerServer を使うときは window.SNOWFIELD_P2P = { host, port, path, secure } を先に置く（テスト用） */
const peerOptions = (): Record<string, unknown> => (window as unknown as { SNOWFIELD_P2P?: Record<string, unknown> }).SNOWFIELD_P2P ?? {};

function openPeer(id?: string): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const peer = id ? new Peer(id, peerOptions()) : new Peer(peerOptions());
    let opened = false;
    peer.on('open', () => { opened = true; resolve(peer); });
    peer.on('error', (err) => { if (!opened) { peer.destroy(); reject(err); } });
  });
}

/* ---------------- local ---------------- */
export function createLocal(h: Handlers, opts: { multi: boolean; name: string; cpus: number; autoStart: boolean }): Session {
  const M = 'L';
  const room = new Room({ code: '', multi: opts.multi, send: (to, msg) => { if (to === '*' || to === M) setTimeout(() => h.onMsg(clone(msg)), 0); } });
  room.join(M, 'local0', opts.name);
  for (let i = 0; i < opts.cpus; i++) room.handle(M, { type: 'addCpu' });
  if (opts.autoStart) room.handle(M, { type: 'start' });
  return { send: (m) => room.handle(M, m), close: () => { room.closed = true; } };
}

/* ---------------- host ---------------- */
export function createHost(h: Handlers, name: string): Session {
  const H = 'host';
  const conns = new Map<string, { conn: DataConnection; lastSeen: number }>();
  let peer: Peer | null = null, room: Room | null = null, closed = false, timer: number | undefined, nextId = 1;
  const queue: ClientMsg[] = [];

  const deliver = (to: string, msg: ServerMsg) => {
    if (to === '*') { deliver(H, msg); conns.forEach((c) => safeSend(c.conn, clone(msg))); return; }
    if (to === H) { setTimeout(() => h.onMsg(clone(msg)), 0); return; }
    const c = conns.get(to);
    if (c) safeSend(c.conn, clone(msg));
  };

  (async () => {
    let code = '';
    for (let attempt = 0; !peer; attempt++) {
      code = Array.from({ length: P2P.codeLength }, () => P2P.codeChars[Math.floor(Math.random() * P2P.codeChars.length)]).join('');
      try { peer = await openPeer(P2P.idPrefix + code); }
      catch (err) { if ((err as { type?: string }).type !== 'unavailable-id' || attempt >= 4) throw err; }
    }
    if (closed) { peer.destroy(); return; }
    peer.on('disconnected', () => { if (!closed && peer && !peer.destroyed) peer.reconnect(); });
    peer.on('error', () => { /* 参加者側の一時的なエラーは無視 */ });
    room = new Room({ code, send: deliver });
    room.join(H, getToken(), name);
    queue.splice(0).forEach((m) => room!.handle(H, m));
    peer.on('connection', (conn) => {
      const member = 'c' + nextId++;
      let joined = false;
      conn.on('data', (raw) => {
        const msg = raw as { type?: string; token?: unknown; name?: unknown };
        if (closed || !msg || typeof msg.type !== 'string') return;
        const info = conns.get(member);
        if (info) info.lastSeen = Date.now();
        if (msg.type === 'ping') return;
        if (!joined) {
          if (msg.type !== 'join') return;
          const r = room!.join(member, String(msg.token ?? '').slice(0, 64), String(msg.name ?? ''));
          if ('error' in r) { safeSend(conn, { type: 'error', text: r.error, fatal: true }); setTimeout(() => conn.close(), 300); return; }
          joined = true;
          // 同じ席に前の接続が残っていたら閉じる
          conns.forEach((c, k) => { if (k !== member && c.conn.peer === conn.peer) { c.conn.close(); conns.delete(k); } });
          conns.set(member, { conn, lastSeen: Date.now() });
          room!.join(member, String(msg.token ?? '').slice(0, 64), String(msg.name ?? ''));
          return;
        }
        room!.handle(member, msg as ClientMsg);
      });
      const gone = () => { if (conns.get(member)?.conn === conn) { conns.delete(member); room?.leave(member); } };
      conn.on('close', gone); conn.on('error', gone);
    });
    timer = window.setInterval(() => {
      const now = Date.now();
      conns.forEach((c, k) => { if (now - c.lastSeen > P2P.dropMs) { c.conn.close(); conns.delete(k); room?.leave(k); } });
    }, P2P.pingMs);
  })().catch((err) => { if (!closed) h.onFatal(p2pErrorText(err)); });

  return {
    send: (m) => { if (room) room.handle(H, m); else queue.push(m); },
    close: () => { closed = true; window.clearInterval(timer); room?.close(); conns.forEach((c) => c.conn.close()); peer?.destroy(); },
  };
}

/* ---------------- guest ---------------- */
export function createGuest(h: Handlers, code: string, name: string): Session {
  const token = getToken();
  let peer: Peer | null = null, conn: DataConnection | null = null, closed = false, retry = 0, ping: number | undefined;
  let joined = false;
  const hostId = P2P.idPrefix + code.trim().toUpperCase();

  const connect = async () => {
    try {
      if (!peer || peer.destroyed) peer = await openPeer();
      const c = peer.connect(hostId, { reliable: true });
      conn = c;
      const timeout = window.setTimeout(() => { if (!c.open) { c.close(); if (!joined) h.onFatal('部屋が見つかりません。部屋IDを確認してください'); } }, P2P.joinTimeoutMs);
      c.on('open', () => {
        window.clearTimeout(timeout);
        retry = 0; h.onStatus(null);
        safeSend(c, { type: 'join', token, name });
        window.clearInterval(ping);
        ping = window.setInterval(() => safeSend(c, { type: 'ping' }), P2P.pingMs);
      });
      c.on('data', (raw) => {
        const m = raw as ServerMsg & { fatal?: boolean };
        if (m.type === 'room') joined = true;
        if (m.type === 'error' && m.fatal) { closed = true; h.onFatal(m.text); return; }
        h.onMsg(m);
      });
      c.on('close', () => { window.clearInterval(ping); lost(); });
      c.on('error', () => { /* close で処理 */ });
    } catch (err) {
      if (!joined) { h.onFatal(p2pErrorText(err)); return; }
      lost();
    }
  };
  const lost = () => {
    if (closed) return;
    if (!joined) { h.onFatal('部屋が見つかりません。部屋IDを確認してください'); return; }
    if (retry >= P2P.maxRetry) { h.onFatal('ホストとの接続が切れました'); return; }
    retry++;
    h.onStatus(`接続が切れました。再接続しています…（${retry}/${P2P.maxRetry}）`);
    window.setTimeout(() => { if (!closed) connect(); }, 1500);
  };
  connect();
  return {
    send: (m) => { if (conn) safeSend(conn, m); },
    close: () => { closed = true; window.clearInterval(ping); conn?.close(); peer?.destroy(); },
  };
}
