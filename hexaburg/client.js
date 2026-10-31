/*
 * ヘキサブルグ — 画面と通信
 * 通信は PeerJS（WebRTC の P2P）。部屋を作った人（ホスト）のブラウザで Room を動かし、
 * 参加者は行動の要求をホストへ送る。ホストが検証して、全員に最新の状態を配信する。
 */
(function () {
  'use strict';

  const E = window.HexEngine;
  const R = E.RULES;
  const $ = sel => document.querySelector(sel);

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

  const store = {
    get(k) { try { return localStorage.getItem('hexaburg.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('hexaburg.' + k, v); } catch (e) { /* 無視 */ } },
  };

  function token() {
    let t = store.get('token');
    if (!t) {
      t = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      store.set('token', t);
    }
    return t;
  }

  // P2P 通信の設定
  const P2P = Object.assign({
    peerjsSrc: 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js',
    peerOptions: {},            // 自前の PeerServer を使うときは { host, port, path, secure }
    idPrefix: 'hexaburg-v1-',   // ヘキサゴニアの部屋とは混ざらないように
    codeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    codeLength: 5,
    joinTimeoutMs: 15000,
    pingMs: 3000,               // 生存確認の間隔
    dropMs: 20000,              // これだけ音沙汰がなければ切断とみなす
    maxRetry: 15,               // 参加者が再接続を試す回数
  }, window.HEXAGONIA_P2P || {}); // テスト用の上書き（URLからは変えられない）

  // ---------- 陣営色 ----------

  const COLOR_NAMES = {
    red: '赤', blue: '青', green: '緑', yellow: '黄', purple: '紫', orange: '橙',
    cyan: '水', pink: '桃', lime: '草', brown: '茶', white: '白', indigo: '藍',
  };
  const COLOR_SETS = {
    // 暗い背景で見分けやすい12色
    normal: {
      red: { base: '#E5534B', light: '#FF9C94' },
      blue: { base: '#4C8EDA', light: '#9CC6F2' },
      green: { base: '#3FAE74', light: '#8EDDB2' },
      yellow: { base: '#E39B00', light: '#FFD36B' },  // 半透明で薄くならないよう山吹色寄り
      purple: { base: '#A66BDB', light: '#D4B0F5' },
      orange: { base: '#F07A2E', light: '#FFB27D' },
      cyan: { base: '#2DBFC7', light: '#8DE7EC' },
      pink: { base: '#E065A8', light: '#F7AED5' },
      lime: { base: '#9BC53D', light: '#CDEB8B' },
      brown: { base: '#A8744A', light: '#D9B08D' },
      white: { base: '#CFCBC0', light: '#F5F2EA' },
      indigo: { base: '#5E6AD8', light: '#A9B1F5' },
    },
    // Okabe-Ito 配色（8色。9人目からは同じ色を縁の模様で見分ける）
    cb: {
      red: { base: '#D55E00', light: '#FFA466' },
      blue: { base: '#0072B2', light: '#56B4E9' },
      green: { base: '#009E73', light: '#5FD6B2' },
      yellow: { base: '#F0E442', light: '#FFF6A0' },
      purple: { base: '#CC79A7', light: '#EDB5D3' },
      orange: { base: '#E69F00', light: '#FFCF66' },
      cyan: { base: '#56B4E9', light: '#A8DBF7' },
      white: { base: '#E8E8E8', light: '#FFFFFF' },
      pink: { base: '#D55E00', light: '#FFA466' },
      lime: { base: '#009E73', light: '#5FD6B2' },
      brown: { base: '#F0E442', light: '#FFF6A0' },
      indigo: { base: '#0072B2', light: '#56B4E9' },
    },
  };
  // 縁の模様。Okabe-Ito で同じ色になる組（赤と桃など）は、違う模様になるようにしてある
  const PATTERNS = {
    red: 'solid', blue: 'dashed', green: 'double', yellow: 'dotted', purple: 'solid', orange: 'dashed',
    cyan: 'double', white: 'dotted', pink: 'dotted', lime: 'solid', brown: 'dashed', indigo: 'double',
  };
  const PATTERN_NAMES = { solid: '実線', dashed: '破線', double: '二重線', dotted: '点線' };

  const settings = { cb: store.get('cb') === '1', patterns: store.get('patterns') === '1' };

  // 縁の模様を使うか：設定でオンにしたとき、または Okabe-Ito で9人以上（同じ色があるので模様で見分ける）
  function patternsOn() {
    const n = app.room ? app.room.players.length : 0;
    return settings.patterns || (settings.cb && n > 8);
  }

  function colorOf(c) {
    const set = COLOR_SETS[settings.cb ? 'cb' : 'normal'][c] || COLOR_SETS.normal.red;
    return Object.assign({ name: COLOR_NAMES[c], pattern: PATTERNS[c] }, set);
  }

  // 陣営色の小さな六角形（模様のオプションがオンなら縁の模様も）
  function swatch(c, cls) {
    const col = colorOf(c);
    const pat = patternsOn() ? col.pattern : 'solid';
    const hex = 'M12 2 L20.7 7 L20.7 17 L12 22 L3.3 17 L3.3 7 Z';
    const dash = pat === 'dashed' ? ' stroke-dasharray="4 2.5"' : pat === 'dotted' ? ' stroke-dasharray="0.1 3" stroke-linecap="round"' : '';
    const stroke = pat === 'double'
      ? `<path d="${hex}" fill="none" stroke="${col.light}" stroke-width="1.3"/><path d="M12 5.6 L17.6 8.8 L17.6 15.2 L12 18.4 L6.4 15.2 L6.4 8.8 Z" fill="none" stroke="${col.light}" stroke-width="1.3"/>`
      : `<path d="${hex}" fill="none" stroke="${col.light}" stroke-width="2"${dash}/>`;
    return `<svg viewBox="0 0 24 24" class="swatch ${cls || ''}" role="img" aria-label="${col.name}"><title>${col.name}</title><path d="${hex}" fill="${col.base}" fill-opacity=".55"/>${stroke}</svg>`;
  }

  // ---------- トークンの絵（すべて半透明・平面的・形がすべて違う） ----------

  const TOKEN_SVG = {
    // 資源：オレンジの四角（セルの六角形と見分けがつくように）
    resource: `<svg viewBox="0 0 24 24" class="tk"><rect x="4.5" y="4.5" width="15" height="15" rx="1.2" fill="rgba(255,150,40,.5)" stroke="#FFB868" stroke-width="1.6"/></svg>`,
    // 戦力：赤の六芒星（攻撃・反撃に使う）
    power: `<svg viewBox="0 0 24 24" class="tk"><path d="M12 2 L14.89 7 L20.66 7 L17.77 12 L20.66 17 L14.89 17 L12 22 L9.11 17 L3.34 17 L6.23 12 L3.34 7 L9.11 7 Z" fill="rgba(255,105,130,.5)" stroke="#FFA8B8" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  };
  const TOKEN_NAMES = { resource: '資源', power: '戦力' };

  // ルール説明のアイコン（盤面の見た目に合わせた小さな絵）
  const HEX = 'M12 2 L20.7 7 L20.7 17 L12 22 L3.3 17 L3.3 7 Z';
  const hexAt = r => { const k = r / 10; return `M12 ${12 - 10 * k} L${12 + 8.7 * k} ${12 - 5 * k} L${12 + 8.7 * k} ${12 + 5 * k} L12 ${12 + 10 * k} L${12 - 8.7 * k} ${12 + 5 * k} L${12 - 8.7 * k} ${12 - 5 * k} Z`; };
  const svg = body => `<svg viewBox="0 0 24 24" class="tk">${body}</svg>`;
  const tile = (fill, stroke, extra) => svg(`<path d="${HEX}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>${extra || ''}`);
  const CELL_FILL = 'rgba(76,142,218,.45)', CELL_LINE = '#9CC6F2';
  const ICONS = {
    resource: TOKEN_SVG.resource,
    cell: tile(CELL_FILL, CELL_LINE),
    core: tile('rgba(227,155,0,.4)', '#FFD36B', '<circle cx="12" cy="12" r="3.6" fill="#E39B00" stroke="#FFD36B" stroke-width="1"/>'),
    'hex-plain': tile('#3A3A38', '#6A695F'),
    power: TOKEN_SVG.power,
    'act-attack': svg(`<path d="M5 19 L17 7" stroke="#FF9C94" stroke-width="2.4" stroke-linecap="round"/><path d="M19 5 L12.5 6.8 L17.2 11.5 Z" fill="#FF9C94"/>`),
    'act-counter': svg(`<path d="M12 4 L12 20 M4 12 L20 12" stroke="#FF9C94" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="7.5" fill="none" stroke="#FF9C94" stroke-width="1.6"/>`),
    'hex-heal': tile('#3A3A38', '#6A695F', '<path d="M10.6 7.5h2.8v3.1h3.1v2.8h-3.1v3.1h-2.8v-3.1H7.5v-2.8h3.1z" fill="#A3A198"/>'),
    'act-expand': svg(`<path d="${HEX}" fill="none" stroke="#9CC6F2" stroke-width="1.4" stroke-dasharray="2.5 1.8"/><path d="M12 8 V16 M8 12 H16" stroke="#9CC6F2" stroke-width="2" stroke-linecap="round"/>`),
    ap: svg('<circle cx="6" cy="12" r="3" fill="#9CC6F2"/><circle cx="12" cy="12" r="3" fill="#9CC6F2"/><circle cx="18" cy="12" r="3" fill="rgba(255,255,255,.18)"/>'),
    ready: svg('<circle cx="12" cy="12" r="9" fill="rgba(142,221,178,.18)" stroke="#8EDDB2" stroke-width="1.5"/><path d="M7.5 12.5 L10.8 15.6 L16.6 8.8" fill="none" stroke="#8EDDB2" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>'),
    group: svg(`<g fill="rgba(76,142,218,.45)" stroke="#9CC6F2" stroke-width="1"><path d="M7 3.5 L11 5.8 L11 10.2 L7 12.5 L3 10.2 L3 5.8 Z"/><path d="M15 3.5 L19 5.8 L19 10.2 L15 12.5 L11 10.2 L11 5.8 Z"/><path d="M11 10.5 L15 12.8 L15 17.2 L11 19.5 L7 17.2 L7 12.8 Z"/></g>`),
    clock: svg('<circle cx="12" cy="12" r="8.5" fill="none" stroke="#C9C6BC" stroke-width="1.6"/><path d="M12 7 V12 L15.5 14" fill="none" stroke="#C9C6BC" stroke-width="1.8" stroke-linecap="round"/>'),
    hand: svg('<path d="M9 12 V5.5 a1.5 1.5 0 0 1 3 0 V11 M12 10 V4.5 a1.5 1.5 0 0 1 3 0 V11 M15 10.5 V6 a1.5 1.5 0 0 1 3 0 V14 c0 4 -2.5 6.5 -6 6.5 c-2.6 0 -4.2 -1.3 -5.6 -3.4 L4 13 a1.5 1.5 0 0 1 2.5 -1.6 L9 14" fill="none" stroke="#C9C6BC" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'),
  };
  const tokenChip = (kind, n, label) =>
    `<span class="tchip tk-${kind}" title="${TOKEN_NAMES[kind]}トークン${n == null ? '（ほかの人の数は見えない）' : ''}">${TOKEN_SVG[kind]}<b>${n == null ? '?' : n}</b>${label ? `<small>${TOKEN_NAMES[kind]}</small>` : ''}</span>`;

  // ---------- P2P ----------

  function loadPeerJS() {
    if (window.Peer) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = P2P.peerjsSrc;
      el.onload = () => (window.Peer ? resolve() : reject(new Error('load')));
      el.onerror = () => reject(Object.assign(new Error('load'), { type: 'load' }));
      document.head.appendChild(el);
    });
  }

  function safeSend(conn, msg) {
    try { if (conn && conn.open) conn.send(msg); } catch (e) { /* 切断済み */ }
  }

  function p2pError(err) {
    const t = err && err.type;
    if (t === 'peer-unavailable') return '部屋が見つかりません。部屋IDを確認してください';
    if (t === 'load') return '通信ライブラリを読み込めませんでした。インターネット接続を確かめてください';
    if (t === 'browser-incompatible') return 'このブラウザはオンライン対戦に対応していません';
    return '接続できませんでした。少し待ってからもう一度試してください';
  }

  function openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new window.Peer(id, P2P.peerOptions) : new window.Peer(P2P.peerOptions);
      let opened = false;
      peer.on('open', () => { opened = true; resolve(peer); });
      peer.on('error', err => { if (!opened) { peer.destroy(); reject(err); } });
    });
  }

  // ホスト：自分のブラウザで Room を動かす
  class HostTransport {
    constructor(name) {
      this.isHost = true;
      this.conns = new Map();   // conn → { id, lastSeen }
      this.closed = false;
      this.queue = [];
      this.start(name).catch(err => { if (!this.closed) leaveRoom(p2pError(err)); });
    }
    async start(name) {
      await loadPeerJS();
      let code = '';
      for (let attempt = 0; !this.peer; attempt++) {
        code = Array.from({ length: P2P.codeLength }, () => P2P.codeChars[Math.floor(Math.random() * P2P.codeChars.length)]).join('');
        try {
          this.peer = await openPeer(P2P.idPrefix + code);
        } catch (err) {
          if (err.type !== 'unavailable-id' || attempt >= 4) throw err; // IDが使用中なら作り直す
        }
      }
      if (this.closed) { this.peer.destroy(); return; }
      this.peer.on('connection', conn => this.onConnection(conn));
      this.peer.on('disconnected', () => { if (!this.closed && !this.peer.destroyed) this.peer.reconnect(); });
      this.peer.on('error', () => { /* 参加者側の一時的なエラーは無視 */ });
      const clone = m => JSON.parse(JSON.stringify(m));
      this.room = new window.HexRoom.Room({ code, send: (pid, msg) => this.deliver(pid, clone(msg)) });
      this.token = token();
      this.id = this.room.join(this.token, name).id;
      this.room.broadcast();
      this.timer = setInterval(() => this.tick(), P2P.pingMs);
      this.queue.forEach(m => this.send(m));
      this.queue = [];
    }
    deliver(pid, msg) {
      if (pid === this.id) { setTimeout(() => onMessage(msg), 0); return; }
      for (const [conn, info] of this.conns) if (info.id === pid) safeSend(conn, msg);
    }
    onConnection(conn) {
      conn.on('data', msg => {
        if (this.closed || !msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        const info = this.conns.get(conn);
        if (info) {
          info.lastSeen = Date.now();
          if (msg.type !== 'ping') this.room.handle(info.id, msg);
          return;
        }
        if (msg.type !== 'join') return;
        const tok = typeof msg.token === 'string' ? msg.token.slice(0, 64) : '';
        const reject = text => { safeSend(conn, { type: 'error', text, fatal: true }); setTimeout(() => conn.close(), 300); };
        if (!tok) return reject('接続情報が正しくありません');
        if (tok === this.token) return reject('ホストと同じブラウザからは参加できません（別のブラウザかシークレットウィンドウで開いてください）');
        // 同じ人の古い接続は閉じる
        for (const [c, i] of this.conns) {
          const p = this.room.players.find(x => x.id === i.id);
          if (p && p.token === tok) { this.conns.delete(c); c.close(); }
        }
        const id = (this.room.players.find(x => x.token === tok) || {}).id;
        if (id) this.conns.set(conn, { id, lastSeen: Date.now() }); // 戻ってきた人には join の配信を届ける
        const r = this.room.join(tok, msg.name);
        if (r.error) { this.conns.delete(conn); return reject(r.error); }
        if (!id) { this.conns.set(conn, { id: r.id, lastSeen: Date.now() }); this.room.broadcast(); }
      });
      conn.on('close', () => this.drop(conn));
      conn.on('error', () => {});
    }
    drop(conn) {
      const info = this.conns.get(conn);
      if (!info) return;
      this.conns.delete(conn);
      if (!this.closed && ![...this.conns.values()].some(i => i.id === info.id)) this.room.disconnect(info.id);
    }
    // 生存確認：返事のない参加者は切断扱い（タブを閉じても通知が来ないことがあるため）
    tick() {
      const now = Date.now();
      for (const [conn, info] of this.conns) {
        if (now - info.lastSeen > P2P.dropMs) { this.drop(conn); try { conn.close(); } catch (e) { /* 無視 */ } }
        else safeSend(conn, { type: 'pong' });
      }
    }
    send(msg) {
      if (!this.room) { this.queue.push(msg); return; }
      setTimeout(() => { if (!this.closed) this.room.handle(this.id, msg); }, 0);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      clearInterval(this.timer);
      for (const conn of this.conns.keys()) safeSend(conn, { type: 'error', text: 'ホストが部屋を閉じました', fatal: true });
      if (this.room) this.room.close();
      const peer = this.peer;
      setTimeout(() => { try { if (peer) peer.destroy(); } catch (e) { /* 無視 */ } }, 300);
    }
  }

  // 参加者：ホストに行動の要求を送り、届いた状態で画面を描く
  class GuestTransport {
    constructor(first) {
      this.first = first;
      this.closed = false;
      this.welcomed = false;
      this.retry = 0;
      this.lastSeen = 0;
      this.unavailable = 0;
      this.start().catch(err => { if (!this.closed) leaveRoom(p2pError(err)); });
    }
    async start() {
      await loadPeerJS();
      const peer = await openPeer(null);
      if (this.closed) { peer.destroy(); return; }
      this.peer = peer;
      peer.on('error', err => {
        if (this.closed) return;
        if (err.type === 'peer-unavailable') {
          if (!this.welcomed) leaveRoom(p2pError(err));
          // ホストのページが閉じられた（何度つないでも見つからない）
          else if (++this.unavailable >= 4) leaveRoom('ホストがいなくなったため、部屋が終わりました');
          else if (this.conn) this.lost(this.conn);
        }
      });
      peer.on('disconnected', () => { if (!this.closed && !peer.destroyed) peer.reconnect(); });
      this.timer = setInterval(() => this.tick(), P2P.pingMs);
      this.connect();
    }
    connect() {
      // 状態は 16KB を超えることがあるので、大きなメッセージを分割して送れる binary を使う（json は 16KB まで）
      const conn = this.peer.connect(P2P.idPrefix + this.first.code, { reliable: true, serialization: 'binary' });
      this.conn = conn;
      setTimeout(() => { if (this.conn === conn && !conn.open) this.lost(conn); }, P2P.joinTimeoutMs);
      conn.on('open', () => { this.lastSeen = Date.now(); safeSend(conn, this.first); });
      conn.on('data', msg => {
        if (this.conn !== conn || !msg) return;
        this.lastSeen = Date.now();
        if (msg.type === 'pong') return;
        if (msg.type === 'state') { this.welcomed = true; this.retry = 0; this.unavailable = 0; setReconnecting(false); }
        onMessage(msg);
      });
      conn.on('close', () => this.lost(conn));
      conn.on('error', () => {});
    }
    lost(conn) {
      if (this.closed || this.conn !== conn) return;
      this.conn = null;
      try { conn.close(); } catch (e) { /* 無視 */ }
      if (!this.welcomed) { leaveRoom('部屋につながりませんでした。部屋IDを確認してください'); return; }
      if (++this.retry > P2P.maxRetry) { leaveRoom('ホストとの接続が切れました'); return; }
      setReconnecting(true);
      setTimeout(() => { if (!this.closed) this.connect(); }, 2000);
    }
    tick() {
      if (!this.conn || !this.conn.open) return;
      if (Date.now() - this.lastSeen > P2P.dropMs) this.lost(this.conn);
      else safeSend(this.conn, { type: 'ping' });
    }
    send(msg) { safeSend(this.conn, msg); }
    close() {
      this.closed = true;
      clearInterval(this.timer);
      try { if (this.conn) this.conn.close(); } catch (e) { /* 無視 */ }
      const peer = this.peer;
      setTimeout(() => { try { if (peer) peer.destroy(); } catch (e) { /* 無視 */ } }, 100);
    }
  }

  // CPU対戦（通信なし）：自分のブラウザで Room を動かす
  class LocalTransport {
    constructor(name) {
      this.isLocal = true;
      const clone = m => JSON.parse(JSON.stringify(m));
      this.room = new window.HexRoom.Room({ code: '', send: (pid, msg) => { if (pid === this.id) { const m = clone(msg); setTimeout(() => onMessage(m), 0); } } });
      this.id = this.room.join(token(), name).id;
      this.room.handle(this.id, { type: 'addCpu' });
    }
    send(msg) { setTimeout(() => { if (!this.room.closed) this.room.handle(this.id, msg); }, 0); }
    close() { this.room.close(); }
  }

  // ---------- アプリの状態 ----------

  const app = {
    conn: null,
    me: null,
    room: null,
    lastLogSeq: 0,
    prevCells: null,    // 前回の盤面（変化したマスを光らせるため）
    tip: null,          // ツールチップを出しているマス { key, pinned }。pinned なら行動のボタンも出す
  };

  function send(msg) { if (app.conn) app.conn.send(msg); }

  function show(id) {
    for (const s of ['top', 'lobby', 'game']) $('#' + s).hidden = s !== id;
  }

  let toastTimer = 0;
  function toast(text, tone) {
    const el = $('#toast');
    el.textContent = text;
    el.className = 'toast ' + (tone || '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  function setReconnecting(on) { $('#reconnecting').hidden = !on; }

  function onMessage(msg) {
    if (msg.type === 'error') {
      if (msg.fatal) leaveRoom(msg.text);
      else toast(msg.text, 'bad');
      return;
    }
    if (msg.type !== 'state') return;
    const prev = app.room;
    app.me = msg.you;
    app.room = msg.room;
    app.graceAt = Date.now();
    if (msg.room.code) {
      const url = new URL(location.href);
      if (url.searchParams.get('room') !== msg.room.code) {
        url.searchParams.set('room', msg.room.code);
        history.replaceState(null, '', url);
      }
    }
    if (!prev || prev.phase !== msg.room.phase) {
      app.lastLogSeq = 0;
      app.prevCells = null;
      app.finale = null;
      app.finaleDone = false;
      if (view) view.setCounted(null);
      app.resultHidden = false;
      const b = $('#btn-show-result');
      if (b) b.remove();
      hideTip();
    }
    render();
    renderChat(msg.room, prev);
  }

  // チャット：新しい発言があるときだけ書き直す（入力中の文字はそのまま）
  function renderChat(room, prev) {
    const list = room.chat || [];
    const lastSeq = list.length ? list[list.length - 1].seq : 0;
    if (prev && app.chatSeq === lastSeq) { renderChatBox(); return; }
    const fresh = prev ? list.filter(c => c.seq > (app.chatSeq || 0)) : [];
    app.chatSeq = lastSeq;
    const others = fresh.filter(c => c.from !== app.me);
    const colorOfPlayer = c => { const p = room.players.find(x => x.id === c.from); return p ? p.color : c.color; };
    const html = list.length
      ? list.map(c => `<li class="${c.from === app.me ? 'mine' : ''}">${swatch(colorOfPlayer(c))}<b>${esc(c.name)}</b><span>${esc(c.text)}</span></li>`).join('')
      : '<li class="muted empty">まだ発言はありません</li>';
    const el = $('#chat .chat-list');
    el.innerHTML = html;
    el.scrollTop = el.scrollHeight;
    // 閉じているときは、未読の数を出し、ほかの人の発言をお知らせにも出す
    if (!app.chatOpen && others.length) {
      app.chatUnread = (app.chatUnread || 0) + others.length;
      const last = others[others.length - 1];
      toast(`💬 ${last.name}：${last.text}`, 'info');
    }
    renderChatBox();
  }

  // チャット欄の開け閉めと未読の数
  function renderChatBox() {
    const box = $('#chat');
    box.hidden = !app.room;
    box.classList.toggle('closed', !app.chatOpen);
    box.querySelector('[data-chat-toggle]').setAttribute('aria-expanded', String(app.chatOpen));
    const badge = box.querySelector('.chat-unread');
    badge.hidden = app.chatOpen || !app.chatUnread;
    badge.textContent = app.chatUnread || '';
    placeChat();
  }

  // チャット欄の高さ：左下の角に置けるなら角に、自分の情報のバーと重なるならバーの上に
  function placeChat() {
    const box = $('#chat');
    let bottom = 12;
    const dock = $('#dock');
    if (!box.hidden && !$('#game').hidden && dock.offsetHeight && window.innerWidth > 820) {
      const r = dock.getBoundingClientRect();
      if (r.left < box.offsetWidth + 24) bottom = window.innerHeight - r.top + 10;
    }
    document.documentElement.style.setProperty('--chat-bottom', bottom + 'px');
  }

  function enterRoom(type) {
    const name = $('#in-name').value.trim() || 'ゲスト';
    store.set('name', name);
    if (type === 'create') {
      app.conn = new HostTransport(name);
    } else if (type === 'local') {
      app.conn = new LocalTransport(name);
      return;
    } else {
      const code = $('#in-code').value.trim().toUpperCase();
      if (!code) { topMsg('部屋IDを入れてください'); return; }
      app.conn = new GuestTransport({ type: 'join', code, token: token(), name });
    }
    topMsg('接続しています…', 'info');
    $('#btn-create').disabled = $('#btn-join').disabled = $('#btn-local').disabled = true;
  }

  function leaveRoom(text) {
    if (app.conn) app.conn.close();
    app.conn = null;
    app.room = null;
    app.me = null;
    app.chatSeq = 0;
    app.chatUnread = 0;
    $('#chat').hidden = true;
    setReconnecting(false);
    hideTip();
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    $('#btn-create').disabled = $('#btn-join').disabled = $('#btn-local').disabled = false;
    show('top');
    topMsg(text || '');
  }

  function topMsg(text, tone) {
    const el = $('#top-msg');
    el.textContent = text;
    el.className = 'msg ' + (tone || 'bad');
    el.hidden = !text;
  }

  // ---------- 描画 ----------

  function render() {
    const room = app.room;
    if (!room) { show('top'); return; }
    if (room.phase === 'lobby') { show('lobby'); renderLobby(room); }
    else { show('game'); renderGame(room); }
  }

  function inviteUrl(code) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', code);
    return url.toString();
  }

  function renderLobby(room) {
    const local = !!(app.conn && app.conn.isLocal);
    const isHost = room.hostId === app.me;
    $('#lobby-online').hidden = local;
    $('#lobby-local').hidden = !local;
    $('#lobby-code').textContent = room.code || '-----';
    $('#invite-url').value = room.code ? inviteUrl(room.code) : '';
    $('#host-warn').hidden = !(app.conn && app.conn.isHost);
    $('#lobby-count').textContent = `${room.players.length} / ${R.maxPlayers}人`;
    $('#lobby-players').innerHTML = room.players.map(p =>
      `<li>${swatch(p.color)}<span class="pname">${esc(p.name)}</span>${p.cpu ? `<span class="badge cpu">CPU</span>${isHost
        ? `<select class="cpu-level" data-cpu-level="${p.id}" aria-label="${esc(p.name)} の強さ">${Object.entries(window.HexCpu.LEVEL_NAMES).map(([k, v]) => `<option value="${k}"${p.level === k ? ' selected' : ''}>${v}</option>`).join('')}</select>`
        : `<span class="badge">${window.HexCpu.LEVEL_NAMES[p.level] || ''}</span>`}` : ''}${p.id === room.hostId && !local ? '<span class="badge">ホスト</span>' : ''}${p.id === app.me ? '<span class="badge me">あなた</span>' : ''}${isHost && p.cpu ? `<button class="small remove" data-remove-cpu="${p.id}" title="このCPUを外す">外す</button>` : ''}</li>`).join('');
    $('#btn-add-cpu').hidden = !isHost;
    $('#btn-add-cpu').disabled = room.players.length >= R.maxPlayers;
    const mine = room.players.find(p => p.id === app.me);
    $('#color-pick').innerHTML = window.HexRoom.COLORS.map(c => {
      const owner = room.players.find(p => p.color === c);
      const taken = owner && owner.id !== app.me;
      return `<button class="color-btn${mine && mine.color === c ? ' on' : ''}" data-color="${c}" ${taken ? 'disabled' : ''}>${swatch(c)}${colorOf(c).name}${taken ? `<small>${esc(owner.name)}</small>` : ''}</button>`;
    }).join('');
    const enough = room.players.length >= R.minPlayers;
    $('#btn-start').hidden = !isHost;
    $('#btn-start').disabled = !enough;
    const dia = room.settings ? room.settings.diameter : 0;
    const sel = $('#set-diameter');
    sel.disabled = !isHost;
    sel.value = String(dia);
    const autoDia = enough ? R.radius[room.players.length] * 2 + 1 : 0;
    const st = room.settings || {};
    $('#set-ticks').disabled = !isHost;
    $('#set-ticks').value = String(st.ticks || 0);
    const autoT = E.autoTicks(Math.max(R.minPlayers, room.players.length));
    $('#ticks-note').textContent = `いまの人数なら自動で ${autoT} ターン（${ticksTime(autoT)}）`;
    $('#diameter-note').textContent = dia ? `${diameterCells(dia)}マス` : autoDia ? `いまの人数では直径 ${autoDia}（${diameterCells(autoDia)}マス）` : '人数に合わせる（2〜3人 9・4人 11・5〜6人 13・7〜8人 15・9〜12人 17）';
    $('#lobby-wait').textContent = isHost
      ? (enough ? `${room.players.length}人で始められます（盤面の直径 ${dia || autoDia}）` : `あと${R.minPlayers - room.players.length}人以上集まると始められます。${local ? 'CPUを追加してください' : '招待URLを送るか、CPUを追加してください'}`)
      : 'ホストがゲームを始めるのを待っています…';
  }

  // ターン数 → 遊ぶ時間（「7分」「約9分」）
  const ticksTime = n => { const m = n * R.rt.tickSeconds / 60; return Number.isInteger(m) ? `${m}分` : `約${Math.round(m)}分`; };

  // 直径 d の六角形の盤面のマスの数
  const diameterCells = d => { const r = (d - 1) / 2; return 3 * r * (r + 1) + 1; };

  let view = null;
  function boardView() {
    if (!view) view = new window.HexBoardView($('#board'), { onSelect: onCellSelect, onAim, onHover: onCellHover, onView: positionTip });
    return view;
  }

  // 自分が行動できるか。手番はなく、脱落していなければいつでも
  function canPlay(g) { const me = g.players.find(p => p.id === app.me); return !g.over && !!me && me.alive; }

  function renderGame(room) {
    const g = room.game;
    const pl = id => g.players.find(p => p.id === id);
    const me = pl(app.me);
    const conn = id => { const p = room.players.find(x => x.id === id); return p ? p.connected : false; };
    const cpuOf = id => { const p = room.players.find(x => x.id === id); return p && p.cpu ? p : null; };   // CPU ならその人

    // 何か行動できるマスを薄く光らせる
    // 拡張できるマスを薄く光らせる
    const targets = canPlay(g) ? E.targets(g, app.me, 'expand') : [];
    // 狙い：このターンにまだ狙いを決めていない自分のセルの中心から、隣の相手のセルへドラッグする
    const canAim = k => canPlay(g) && !app.finale && E.targets(g, app.me, 'aim').includes(k);
    const aimTargets = k => E.foeNeighbors(g, g.board[k]).map(c => E.key(c.q, c.r)).filter(t => t !== g.board[k].aim);

    const colors = {};
    g.players.forEach(p => { colors[p.id] = colorOf(p.color); });
    boardView().setData({ game: g, colors, patterns: patternsOn(), targets: app.finale ? [] : targets, selected: app.tip && app.tip.pinned ? app.tip.key : null, me: app.me, canAim, aimTargets });

    // 変化したマス（拡張・脱落）を一瞬光らせる
    const cells = {};
    for (const [k, c] of Object.entries(g.board)) cells[k] = `${c.owner}|${c.core}|${c.hp}`;
    const changedCells = app.prevCells ? Object.keys(cells).filter(k => cells[k] !== app.prevCells[k]) : [];
    if (app.prevCells) view.flash(changedCells);
    app.prevCells = cells;

    // 上部の表示
    $('#hud-round').textContent = `${g.round} / ${g.rounds}`;
    $('#hud-over').hidden = !g.over;

    // 自分：次のターンまではバーで
    $('#me-swatch').innerHTML = me ? swatch(me.color) : '';
    $('#me-name').textContent = me ? me.name : '';
    const meAct = $('#me-actions');
    const actHtml = me && !me.alive ? '脱落' : '';
    if (meAct._html !== actHtml) { meAct.innerHTML = actHtml; meAct._html = actHtml; }
    $('#dock-tickbar').hidden = g.over;
    // 行動完了：全員（切断中の人は押したものとみなす。CPU はやることがなくなると押す）がそろうと、待たずに次のターンへ
    const readyBtn = $('#btn-ready');
    readyBtn.hidden = !me || !me.alive || g.over;
    if (!readyBtn.hidden) {
      const alive = g.players.filter(p => p.alive).length, n = (room.readyIds || []).length;
      const html = me.ready ? `✓ 行動完了<small>${n}/${alive}人・押すと取り消し</small>` : `行動完了<small>${n}/${alive}人</small>`;
      if (readyBtn._html !== html) { readyBtn.innerHTML = html; readyBtn._html = html; }
      readyBtn.classList.toggle('on', !!me.ready);
      readyBtn.title = '全員が押すと、待たずに次のターンへ進みます（切断中の人は押したものとみなします。CPU はやることがなくなると押します。できる行動がなくなると自動で押されます）';
      // 自分で押していないのに行動完了になったら（もうできる行動がない）、お知らせ
      if (me.ready && !app.wasReady && Date.now() - (app.readyClickAt || 0) > 1500) toast('もうできる行動がないので、自動で行動完了にしました', 'info');
    }
    app.wasReady = !!(me && me.ready);
    renderMyTokens(me);


    $('#hint').textContent = g.over ? '' : !me || !me.alive ? '脱落しました。観戦できます'
      : 'マスを選ぶと行動のボタンが出ます。自分のセルの中心から、隣の相手のセルへドラッグすると狙えます（攻撃に使えるのは次のターンから）';

    // プレイヤー一覧
    const isHost = room.hostId === app.me;
    $('#players').classList.toggle('compact', g.players.length > 6);
    $('#players').innerHTML = g.players.map(p => {
      const cells = E.cellsOf(g, p.id).length;
      const group = E.largestGroup(g, p.id).length;
      return `<li class="${p.alive ? '' : 'out'}">
        <div class="prow">${swatch(p.color)}<span class="pname">${esc(p.name)}</span>${cpuOf(p.id) ? `<span class="badge cpu">CPU・${window.HexCpu.LEVEL_NAMES[cpuOf(p.id).level] || 'ふつう'}</span>` : ''}${p.id === app.me ? '<span class="badge me">あなた</span>' : ''}${conn(p.id) ? '' : '<span class="badge warn" title="切断中">切断中</span>'}${p.alive ? '' : '<span class="badge">脱落</span>'}${p.alive && p.ready ? '<span class="badge ready" title="行動完了">✓ 完了</span>' : ''}</div>
        <div class="pstats"><span class="cells" title="つながっている一番大きなかたまり（勝敗はこれで決まる）／セルの総数"><svg viewBox="0 0 24 24" class="tk"><path d="M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z" fill="none" stroke="currentColor" stroke-width="2"/></svg><b>${group}</b><small>/${cells}</small></span>${tokenChip('resource', p.resource)}${tokenChip('power', p.power)}</div>
        ${isHost && p.alive && !conn(p.id) && !g.over ? `<button class="small" data-forfeit="${p.id}">脱落させる</button>` : ''}
      </li>`;
    }).join('');

    // ログ（新しいものほど下）
    const logEl = $('#log');
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    logEl.innerHTML = g.log.map(l => `<li class="lg-${l.tone}">${esc(l.text)}</li>`).join('');
    if (atBottom || !app.lastLogSeq) logEl.scrollTop = logEl.scrollHeight;
    const fresh = app.lastLogSeq ? g.log.filter(l => l.seq > app.lastLogSeq) : [];
    for (const l of fresh) if (l.tone === 'out') toast(l.text, 'bad');
    // 攻撃・反撃が当たったマスを赤く光らせる。自分のセルがやられたら、お知らせと音
    const hits = app.lastLogSeq ? (g.hits || []).filter(h => h.seq > app.lastLogSeq) : [];
    for (const h of hits) view.flash(h.keys, '255,90,90', 1600);
    const mine = hits.filter(h => h.by !== app.me && h.victims.includes(app.me));
    if (mine.length) {
      const by = [...new Set(mine.map(h => (pl(h.by) || {}).name))].join('・');
      toast(`${by} に攻撃されました`, 'bad');
      window.HexSound.play('attacked');
    } else if (hits.some(h => h.by === app.me)) {
      window.HexSound.play(fresh.some(l => l.tone === 'break') ? 'success' : 'block');
    } else {
      playSounds(g, fresh);
    }
    // 自分のセルが新しく狙われたら、そのセルを橙に光らせ、お知らせと音（攻撃に使われるのは次のターンから）
    const aimedNow = new Set(Object.entries(g.board).filter(([, c]) => c.owner && c.owner !== app.me && c.aim && g.board[c.aim] && g.board[c.aim].owner === app.me).map(([k, c]) => `${k}>${c.aim}`));
    if (app.prevAimed && me && me.alive && !g.over) {
      const fresh2 = [...aimedNow].filter(x => !app.prevAimed.has(x));
      if (fresh2.length) {
        const keys = fresh2.map(x => x.split('>'));
        view.flash([...new Set(keys.map(([, t]) => t))], '255,170,60', 1800);
        view.flash(keys.map(([f]) => f), '255,170,60', 900);
        const by = [...new Set(keys.map(([f]) => (pl(g.board[f].owner) || {}).name))].join('・');
        toast(`⚠ ${by} に狙われました（次のターンから攻撃されます）`, 'warn');
        if (!mine.length) window.HexSound.play('aimed');
      }
    }
    app.prevAimed = aimedNow;
    // ターンが始まったら音で知らせる（ほかの音と重なってもよい）
    if (fresh.some(l => l.tone === 'round')) window.HexSound.play('round');
    // ターンの終わり：資源が増えたマスに数字を浮かべ、下のバーの数字を動かす
    const ti = g.tickInfo && g.tickInfo[app.me];
    if (ti && fresh.some(l => l.seq === ti.seq)) playTick(g, ti);
    app.lastLogSeq = g.log.length ? g.log[g.log.length - 1].seq : 0;

    // ゲーム開始前のカウントダウン（終わる時刻を覚えて、tickCountdown で数える）
    if (room.countdownMs > 0) app.countdownEnd = Date.now() + room.countdownMs;
    updateDock();
    tickTimers();
    tickCountdown();
    // ゲームが終わったら、かたまりの大きさを1マスずつ数え上げてから結果を出す
    if (g.over && !app.finaleDone && !app.finale) startFinale(g);
    renderResult(room, g);
    if (app.tip) showTip(app.tip);
  }

  // 下のバーの自分のトークン。ターンの終わりの演出中は、演出の途中の数を見せる
  function renderMyTokens(me) {
    const v = app.tokenView;
    $('#me-tokens').innerHTML = me ? tokenChip('resource', v ? v.resource : me.resource, true) + tokenChip('power', v ? v.power : me.power, true) : '';
    // ターンごとの収支。チップの横に出す
    const g = app.room && app.room.game;
    if (me && me.alive && g && !g.over) {
      const net = (kind, n, title) => { const chip = $(`#me-tokens .tk-${kind}`); chip.insertAdjacentHTML('beforeend', `<em class="tnet up">+${n}/ターン</em>`); chip.title = title; };
      const ex = E.bonusExpect(g, app.me), pct = Math.round(R.bonus.chance * 100);
      const exs = Number.isInteger(ex) ? ex : ex.toFixed(1);
      net('resource', E.income(g, app.me), `資源の収支（ターンごと）：+${E.income(g, app.me)}（コア +${R.income.core}）＋おまけ（セル1つにつき ${pct}% で +1・平均 +${exs}）。拡張・回復に使う`);
      net('power', E.powerIncome(g, app.me), `戦力の収支（ターンごと）：+${E.powerIncome(g, app.me)}（毎ターン +${R.income.power}）＋おまけ（セル1つにつき ${pct}% で +1・平均 +${exs}）。攻撃・反撃に使う`);
    }
    if (v && v.flash) for (const kind of ['resource', 'power']) { const chip = $(`#me-tokens .tk-${kind}`); if (chip) chip.classList.add(v.flash); }
  }

  // ターンの終わりの演出：コアの上に増えた資源を浮かべ、下のバーの数字を「増える前 → 増えた」と動かす
  function playTick(g, le) {
    const me = g.players.find(p => p.id === app.me);
    // コアの上に基本の分、おまけの出たセルの上にそれぞれの分を浮かべる
    const cb = (le.bonus || []).find(b => b.k === me.core) || { res: 0, pow: 0 };   // コアのおまけは基本の分に足して見せる
    floater(me.core, `<span class="fl-res">${TOKEN_SVG.resource}+${R.income.core + cb.res}</span><span class="fl-pow">${TOKEN_SVG.power}+${R.income.power + cb.pow}</span>`, 'gain', 0);
    for (const b of (le.bonus || []).filter(b => b.k !== me.core)) {
      floater(b.k, `${b.res ? `<span class="fl-res">${TOKEN_SVG.resource}+1</span>` : ''}${b.pow ? `<span class="fl-pow">${TOKEN_SVG.power}+1</span>` : ''}`, 'gain', 120);
    }
    const set = (resource, power, flash) => { app.tokenView = { resource, power, flash }; renderMyTokens(app.room && app.room.game.players.find(p => p.id === app.me)); };
    clearTimeout(app.tokenTimer1); clearTimeout(app.tokenTimer3);
    set(le.resBefore, le.powBefore, null);
    app.tokenTimer1 = setTimeout(() => set(le.resBefore + le.resource, le.powBefore + le.power, 'up'), 200);
    app.tokenTimer3 = setTimeout(() => { app.tokenView = null; renderMyTokens(app.room && app.room.game && app.room.game.players.find(p => p.id === app.me)); }, 1400);
  }

  // 盤面のマスの上に、数字をふわっと浮かべて消す
  function floater(key, html, kind, delay) {
    setTimeout(() => {
      if (!view) return;
      const [x, y] = view.screenOf(key);
      const el = document.createElement('div');
      el.className = 'floater ' + kind;
      el.innerHTML = html;
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      $('#floaters').appendChild(el);
      setTimeout(() => el.remove(), 1600);
    }, delay);
  }

  // 効果音：新しいログから、いちばん大事なものを1つ鳴らす
  function playSounds(g, fresh) {
    if (!fresh.length) return;
    // 勝敗の音は、数え上げの演出の最後に鳴らす
    const order = ['out', 'expand', 'heal'];
    const found = new Set(fresh.map(l => l.tone));
    const name = order.find(n => found.has(n));
    if (name) window.HexSound.play(name);
  }

  // ゲーム開始前の 3・2・1 のカウントダウン。数が変わるたびに音を鳴らし、0 で「スタート！」
  function tickCountdown() {
    const el = $('#countdown');
    if (!app.countdownEnd) { el.hidden = true; return; }
    const left = app.countdownEnd - Date.now();
    const n = left > 0 ? Math.ceil(left / 1000) : 0;
    if (left < -800) { app.countdownEnd = 0; app.countdownShown = null; el.hidden = true; return; }   // 「スタート！」を少し見せてから消す
    if (n === app.countdownShown) return;
    app.countdownShown = n;
    el.innerHTML = n ? `<b>${n}</b>` : '<b class="go">スタート！</b>';
    el.hidden = false;
    el.firstElementChild.style.animation = 'none'; void el.offsetWidth; el.firstElementChild.style.animation = '';
    window.HexSound.play(n ? 'count' : 'go');
  }

  // 次のターンまでの時間を、バーで（満タンから減っていく）。届いた時刻からの経過で数える
  function tickTimers() {
    const room = app.room;
    const g = room && room.game;
    if (!g || room.phase !== 'game' || g.over) return;
    const pass = Date.now() - (app.graceAt || Date.now());
    const left = Math.max(0, room.tickLeftMs - pass), total = R.rt.tickSeconds * 1000;
    const bar = $('#dock-tickbar');
    bar.classList.toggle('low', left <= 3000);
    bar.firstElementChild.style.width = `${Math.min(100, left / total * 100)}%`;
  }

  // ---------- 終了時の数え上げ ----------
  // 最後まで残った人の一番大きなかたまりを、かたまりが小さい人から順に、1マスずつ数え上げる。
  // 全員数え終わったら、勝った人を光らせて音を鳴らし、結果を出す（脱落で決まったときは数えない）
  function startFinale(g) {
    const alive = g.players.filter(p => p.alive);
    if (alive.length < 2 || !/ターン終了/.test(g.endReason)) { app.finaleDone = true; return; }
    hideTip();
    const list = alive.map(p => ({ p, cells: E.largestGroup(g, p.id), n: 0 })).sort((a, b) => a.cells.length - b.cells.length);
    app.finale = { list, i: 0, k: 0 };
    const counted = new Map();
    view.setCounted(counted);
    const el = $('#finale');
    const draw = () => {
      el.innerHTML = `<h3>かたまりを数えます</h3><ol>${list.map((x, j) => `<li class="${j === app.finale.i ? 'now' : ''}${x.win ? ' win' : ''}">${swatch(x.p.color)}<span class="pname">${esc(x.p.name)}</span><b>${x.n}</b></li>`).join('')}</ol>`;
    };
    el.hidden = false;
    draw();
    const step = () => {
      const f = app.finale;
      if (!f) return;
      const cur = f.list[f.i];
      if (cur && f.k < cur.cells.length) {
        const k = cur.cells[f.k++];
        counted.set(k, colorOf(cur.p.color).light);
        cur.n = f.k;
        view.draw();
        window.HexSound.play('pip', f.k);
        draw();
        setTimeout(step, Math.max(45, Math.min(160, 2400 / cur.cells.length)));
        return;
      }
      if (cur) { f.i++; f.k = 0; draw(); setTimeout(step, 600); return; }
      // 全員数え終わった：勝った人だけ残して光らせる
      for (const x of f.list) x.win = g.winners.includes(x.p.id);
      for (const x of f.list) if (!x.win) for (const k of x.cells) counted.delete(k);
      view.flash(f.list.filter(x => x.win).flatMap(x => x.cells), '255,211,107', 1800);
      view.draw();
      draw();
      window.HexSound.play(g.winners.includes(app.me) ? 'win' : 'lose');
      setTimeout(() => { app.finale = null; app.finaleDone = true; el.hidden = true; view.setCounted(null); render(); }, 2200);
    };
    setTimeout(step, 700);
  }

  function renderResult(room, g) {
    const el = $('#result');
    if (!g.over || app.finale) { el.hidden = true; return; }
    const rank = g.players.map(p => ({ p, cells: E.cellsOf(g, p.id).length, group: E.largestGroup(g, p.id).length }))
      .sort((x, y) => (y.p.alive - x.p.alive) || (y.group - x.group) || (y.cells - x.cells));
    const win = g.winners.includes(app.me);
    el.innerHTML = `<div class="card result-card">
      <h2>${win ? (g.winners.length > 1 ? '同率優勝！' : 'あなたの勝利！') : 'ゲーム終了'}</h2>
      <p class="muted">${esc(g.endReason)}</p>
      <ol class="rank">${rank.map(({ p, cells, group }) => `<li class="${g.winners.includes(p.id) ? 'win' : ''}">${g.winners.includes(p.id) ? '<span class="crown">🏆</span>' : ''}${swatch(p.color)}<span class="pname">${esc(p.name)}</span><span class="muted">${p.alive ? `かたまり <b>${group}</b>（セル ${cells}）` : '脱落'}</span></li>`).join('')}</ol>
      ${room.hostId === app.me ? '<button class="primary" id="btn-lobby">ロビーに戻る</button>' : '<p class="muted">ホストがロビーに戻すのを待っています…</p>'}
      <button class="link" id="btn-hide-result">盤面を見る</button>
    </div>`;
    if (!app.resultHidden) el.hidden = false;
  }

  // ---------- 盤面の操作 ----------

  // マスを選ぶ：そのマスの情報と、できる行動のボタンをツールチップに出す
  function onCellSelect(key) {
    if (!key || (app.tip && app.tip.pinned && app.tip.key === key)) { hideTip(); return; }
    showTip({ key, pinned: true });
  }

  // ドラッグで狙った：狙いを送る
  function onAim(from, to) {
    const [q, r] = E.parseKey(from);
    send({ type: 'act', action: { type: 'aim', q, r, to } });
  }

  function onCellHover(key, x, y, scale, byLongPress) {
    if (byLongPress) { if (key) showTip({ key, pinned: true }); return; }
    if (app.tip && app.tip.pinned) return;   // 選んでいるマスがあるあいだは、そちらを出したまま
    if (!key) hideTip(); else showTip({ key, pinned: false });
  }

  // そのマスでできる行動と、できないときの理由
  function cellActions(g, key) {
    const c = g.board[key];
    const me = g.players.find(p => p.id === app.me);
    if (!me || !me.alive || g.over) return null;
    const list = [];
    const why = (type, extra) => E.targets(g, app.me, type).includes(key) ? '' : (E.actionBlocked(g, app.me, type) || extra);
    if (!c.owner) {
      list.push({ type: 'expand', cost: R.cost.expand, kind: 'resource', gain: '自分のセルにする',
        why: E.targets(g, app.me, 'expand').includes(key) ? '' : E.actionBlocked(g, app.me, 'expand') || '自分のセルに隣接していません' });
    } else if (c.owner === app.me) {
      const foes = E.foeNeighbors(g, c);
      const locked = !E.canReaim(g, c) ? 'このセルの狙いは、このターンはもう変えられません' : '';
      if (c.aim) list.push({ type: 'unaim', name: '狙いを外す', gain: '1ターンに1回', why: locked });
      if (c.hp < R.hp) list.push({ type: 'heal', cost: R.cost.heal, kind: 'resource', gain: `体力 +${R.heal}`, why: why('heal', '') });
      const ci = E.counterInfo(g, app.me, key);
      if (ci.k) list.push({ type: 'counter', cost: ci.cost, kind: 'power', gain: `狙ってきている相手のセル ${ci.k} マスの体力をそれぞれ −${ci.k}`, why: why('counter', `戦力トークンが足りません（あと ${ci.cost - me.power}）`) });
    } else {
      const { n, cost, pending } = E.attackInfo(g, app.me, key);
      const wait = pending ? `・準備中の狙い ${pending}（次のターンから）` : '';
      list.push(n ? { type: 'attack', cost, kind: 'power', gain: `体力 −${n}（狙っている自分のセル ${n}${wait}）`, why: why('attack', `戦力トークンが足りません（あと ${cost - me.power}）`) }
        : pending ? { type: 'attack', cost, kind: 'power', gain: `準備中の狙い ${pending}`, why: '狙いは、決めた次のターンから攻撃に使えます' }
        : { type: 'attack', cost, kind: 'power', gain: '自分のセルから狙うと攻撃できる', why: '隣の自分のセルから、まずこのセルを狙ってください（次のターンから攻撃に使える）' });
    }
    return { list };
  }

  function showTip(tip) {
    const g = app.room && app.room.game;
    if (!g || !g.board[tip.key]) { hideTip(); return; }
    const changed = !app.tip || app.tip.key !== tip.key || app.tip.pinned !== tip.pinned;
    app.tip = tip;
    const c = g.board[tip.key];
    const owner = c.owner && g.players.find(p => p.id === c.owner);
    const aimedBy = c.owner ? E.aimersOf(g, tip.key).filter(x => x.owner !== c.owner).length : 0;
    const state = !owner ? '空きマス' : `${c.core ? 'コア' : 'セル'}・体力 ${c.hp} / ${R.hp}${aimedBy ? `・${aimedBy}マスから狙われている` : ''}`;
    let acts = '';
    if (tip.pinned) {
      const r = cellActions(g, tip.key);
      if (r && r.list) {
        // 理由は同じことが多いので、まとめて最後に1回だけ出す
        const whys = [...new Set(r.list.map(a => a.why).filter(Boolean))];
        acts = `<div class="tt-acts">${r.list.map(a => `<button class="tt-act${a.type === 'attack' || a.type === 'counter' ? ' danger' : ''}" data-cell-act="${a.type}"${a.to ? ` data-to="${a.to}"` : ''} ${a.why ? 'disabled' : ''}>
          <b>${a.name || E.ACTION_NAMES[a.type]}</b>${a.cost ? `<span class="tt-cost">${TOKEN_SVG[a.kind]}${a.cost}</span>` : ''}${a.gain ? `<small>${esc(a.gain)}</small>` : ''}</button>`).join('')}
          ${whys.map(w => `<p class="tt-why">${esc(w)}</p>`).join('')}</div>`;
      } else if (r && r.note) {
        acts = `<div class="tt-acts"><p class="tt-why">${esc(r.note)}</p></div>`;
      }
    }
    const el = $('#tooltip');
    // 自分のセルなら、狙い方の案内（中心からドラッグ）
    const aimNote = c.owner === app.me && g.players.some(p => p.id === app.me && p.alive) && E.foeNeighbors(g, c).length
      ? `<div class="tt-eff">${E.canReaim(g, c) ? `中心から隣の相手のセルへドラッグして${c.aim ? '狙いを変える' : '狙う'}（1ターンに1回・攻撃に使えるのは次のターンから）` : 'このセルの狙いは、このターンはもう変えられません'}</div>` : '';
    const html = `<div class="tt-head">${state}<span class="muted">(${c.q},${c.r})</span></div>
      <div>所有者：${owner ? `${swatch(owner.color)}${esc(owner.name)}` : '<span class="muted">なし</span>'}</div>${aimNote}${acts}`;
    // 中身が同じなら作り直さない（数秒ごとに画面が描き直されるので、操作が途切れないように）
    if (el._html !== html) { el.innerHTML = html; el._html = html; }
    el.classList.toggle('pinned', !!tip.pinned);
    el.hidden = false;
    positionTip();
    if (changed && view) view.setSelected(tip.pinned ? tip.key : null);
  }

  // マスの左に出す（はみ出すなら右）。盤面を動かしたときもついていく
  function positionTip() {
    const el = $('#tooltip');
    if (!app.tip || el.hidden || !view) return;
    const [x, y] = view.screenOf(app.tip.key);
    const s = view.scale;
    const wrap = $('.board-wrap');
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const w = el.offsetWidth, h = el.offsetHeight;
    // マスの左に出す（入りきらなければ右）。クリックして反対側に移したあとは、そちらを先に
    const toLeft = x - s * 1.05 - w, toRight = x + s * 1.05;
    let left = app.tip.flip ? toRight : toLeft;
    if (left < 8 || left + w > W - 8) left = app.tip.flip ? toLeft : toRight;
    left = Math.max(8, Math.min(left, W - w - 8));
    // 選んだマスなら、行動のボタンがマスと同じ高さに来るように（マスから横に動かすと、そのままボタンに届く）
    const acts = app.tip.pinned && el.querySelector('.tt-acts');
    const anchor = acts ? acts.offsetTop + acts.offsetHeight / 2 : h / 2;
    const top = Math.max(8, Math.min(y - anchor, H - h - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  // 選んだマスのツールチップをクリックしたら（行動のボタンは除く）、マスの反対側に移す。
  // ツールチップの下のマスを選びやすくするため
  function flipTip() {
    if (!app.tip || !app.tip.pinned) return;
    app.tip.flip = !app.tip.flip;
    positionTip();
  }

  function hideTip() {
    const had = app.tip && app.tip.pinned;
    app.tip = null;
    $('#tooltip').hidden = true;
    if (had && view) view.setSelected(null);
  }

  // ---------- ルール（ページに分けて、アイコンと動く図つき） ----------

  function initRulesPages() {
    const pages = [...document.querySelectorAll('#rules .r-page')];
    $('#r-tabs').innerHTML = pages.map((pg, i) => `<button type="button" data-rules-page="${i}">${esc(pg.dataset.title)}</button>`).join('');
    $('#r-tabs').onclick = e => { const b = e.target.closest('[data-rules-page]'); if (b) showRulesPage(Number(b.dataset.rulesPage)); };
    $('#r-prev').onclick = () => showRulesPage((app.rulesPage || 0) - 1);
    $('#r-next').onclick = () => showRulesPage((app.rulesPage || 0) + 1);
  }

  function showRulesPage(n) {
    const pages = [...document.querySelectorAll('#rules .r-page')];
    n = Math.max(0, Math.min(pages.length - 1, n));
    app.rulesPage = n;
    pages.forEach((pg, i) => {
      pg.hidden = i !== n;
    });
    document.querySelectorAll('#r-tabs button').forEach((b, i) => { b.classList.toggle('on', i === n); b.setAttribute('aria-current', i === n ? 'page' : 'false'); });
    $('#r-prev').disabled = n === 0;
    $('#r-next').disabled = n === pages.length - 1;
    $('#r-pos').textContent = `${n + 1} / ${pages.length}`;
    $('#rules').scrollTop = 0;
  }

  // ルール説明などの <i data-icon="…"> にアイコンを入れる
  function fillIcons() {
    document.querySelectorAll('[data-icon]').forEach(el => { if (ICONS[el.dataset.icon]) el.innerHTML = ICONS[el.dataset.icon]; });
  }

  // ---------- 設定 ----------

  function renderSettings() {
    $('#set-cb').checked = settings.cb;
    $('#set-pattern').checked = settings.patterns;
    $('#set-sound').checked = window.HexSound.on;
    $('#set-preview').innerHTML = window.HexRoom.COLORS.map(c =>
      `<span>${swatch(c, 'big')}${colorOf(c).name}${patternsOn() ? `<small>${PATTERN_NAMES[PATTERNS[c]]}</small>` : ''}</span>`).join('');
  }

  // ---------- イベント ----------

  // 盤面の下に浮かせた自分の情報の高さを、盤面の表示範囲・盤面のボタンの位置に反映
  function updateDock() {
    const h = $('#dock').offsetHeight;
    if (!h) return;
    $('.board-wrap').style.setProperty('--dock-h', h + 'px');
    if (view) view.setInsetBottom(h + 20);
    placeChat();
  }

  function init() {
    fillIcons();
    initRulesPages();
    new ResizeObserver(updateDock).observe($('#dock'));
    const params = new URLSearchParams(location.search);
    $('#in-name').value = store.get('name') || '';
    const code = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code) { $('#in-code').value = code; topMsg(`部屋ID ${code} に招待されています。なまえを入れて「参加する」を押してください`, 'info'); }

    $('#btn-create').onclick = () => enterRoom('create');
    $('#btn-join').onclick = () => enterRoom('join');
    $('#btn-local').onclick = () => enterRoom('local');
    $('#btn-add-cpu').onclick = () => send({ type: 'addCpu' });
    $('#lobby-players').onclick = e => { const b = e.target.closest('[data-remove-cpu]'); if (b) send({ type: 'removeCpu', target: b.dataset.removeCpu }); };
    $('#lobby-players').onchange = e => { const s = e.target.closest('[data-cpu-level]'); if (s) send({ type: 'cpuLevel', target: s.dataset.cpuLevel, level: s.value }); };
    $('#in-code').addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom('join'); });
    $('#btn-copy').onclick = async () => {
      const url = $('#invite-url').value;
      try { await navigator.clipboard.writeText(url); toast('招待URLをコピーしました', 'good'); }
      catch (e) { $('#invite-url').select(); toast('コピーできませんでした。URLを選択してコピーしてください'); }
    };
    $('#btn-leave').onclick = () => leaveRoom('');
    $('#btn-start').onclick = () => send({ type: 'start' });
    $('#color-pick').onclick = e => { const b = e.target.closest('[data-color]'); if (b && !b.disabled) send({ type: 'color', color: b.dataset.color }); };

    $('#set-diameter').onchange = e => send({ type: 'settings', diameter: Number(e.target.value) });
    $('#btn-ready').onclick = () => { app.readyClickAt = Date.now(); send({ type: 'act', action: { type: 'ready' } }); };
    $('#set-ticks').onchange = e => send({ type: 'settings', ticks: Number(e.target.value) });
    document.querySelectorAll('#set-ticks option').forEach(o => { const n = Number(o.value); if (n) o.textContent = `${n}ターン（${ticksTime(n)}）`; });
    // ツールチップの上でホイールを回しても、盤面を拡大・縮小する
    $('#tooltip').addEventListener('wheel', e => {
      e.preventDefault();
      $('#board').dispatchEvent(new WheelEvent('wheel', { clientX: e.clientX, clientY: e.clientY, deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, bubbles: true, cancelable: true }));
    }, { passive: false });
    $('#tooltip').onclick = e => {
      const b = e.target.closest('[data-cell-act]');
      if (!b) { flipTip(); return; }
      if (b.disabled || !app.tip) return;
      const type = b.dataset.cellAct;
      const [q, r] = E.parseKey(app.tip.key);
      send({ type: 'act', action: b.dataset.to ? { type, q, r, to: b.dataset.to } : { type, q, r } });
      // 行動のあとも同じマスを選んだまま（続けて強化・攻撃できるように）
    };
    setInterval(tickTimers, 250);
    setInterval(tickCountdown, 100);
    $('#players').onclick = e => {
      const b = e.target.closest('[data-forfeit]');
      if (b && confirm('この人を脱落させますか？（セルはすべて空きマスに戻ります）')) send({ type: 'forfeit', target: b.dataset.forfeit });
    };
    $('#result').onclick = e => {
      if (e.target.id === 'btn-lobby') { app.resultHidden = false; send({ type: 'lobby' }); }
      if (e.target.id === 'btn-hide-result') { app.resultHidden = true; $('#result').hidden = true; toast('もう一度結果を見るには「結果」を押してください', 'info'); renderResultButton(); }
    };
    $('#btn-fit').onclick = () => { boardView().reset(); hideTip(); };
    // チャット：PC は開いた状態、スマホは閉じた状態から（前回の状態を覚えておく）
    app.chatOpen = store.get('chatOpen') ? store.get('chatOpen') === '1' : window.innerWidth > 820;
    $('#chat [data-chat-toggle]').onclick = () => {
      app.chatOpen = !app.chatOpen;
      store.set('chatOpen', app.chatOpen ? '1' : '0');
      if (app.chatOpen) {
        app.chatUnread = 0;
        const list = $('#chat .chat-list');
        list.scrollTop = list.scrollHeight;
      }
      renderChatBox();
      if (app.chatOpen) $('#chat .chat-form input').focus();
    };
    $('#chat .chat-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = e.currentTarget.querySelector('input');
      const text = input.value.trim();
      if (!text) return;
      send({ type: 'chat', text });
      input.value = '';
    });
    window.addEventListener('resize', placeChat);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && app.tip) hideTip();
    });

    document.querySelectorAll('[data-open]').forEach(b => {
      b.addEventListener('click', () => {
        const d = $('#' + b.dataset.open);
        if (d.id === 'settings') renderSettings();
        if (d.id === 'rules') showRulesPage(app.rulesPage || 0);
        d.showModal();
        d.scrollTop = 0;   // 「閉じる」ボタンに自動で移るフォーカスで、いちばん下から始まらないように
      });
    });
    $('#set-cb').onchange = e => { settings.cb = e.target.checked; store.set('cb', settings.cb ? '1' : '0'); renderSettings(); render(); };
    $('#set-pattern').onchange = e => { settings.patterns = e.target.checked; store.set('patterns', settings.patterns ? '1' : '0'); renderSettings(); render(); };
    $('#set-sound').onchange = e => { window.HexSound.setOn(e.target.checked); if (e.target.checked) window.HexSound.play('expand'); };

    window.addEventListener('pagehide', () => { if (app.conn && app.conn.isHost) app.conn.close(); });
    window.addEventListener('beforeunload', e => {
      if (app.conn && app.conn.isHost && app.room) { e.preventDefault(); e.returnValue = ''; }
    });

    // 前回の部屋に入っていた参加者は、招待URLを開き直せば同じプレイヤーとして戻れる
    show('top');
  }

  // 結果を閉じたあと、もう一度開くためのボタン
  function renderResultButton() {
    let b = $('#btn-show-result');
    if (!b) {
      b = document.createElement('button');
      b.id = 'btn-show-result';
      b.className = 'tool';
      b.textContent = '結果';
      b.onclick = () => { app.resultHidden = false; render(); b.remove(); };
      $('.board-tools').prepend(b);
    }
  }

  init();
})();
