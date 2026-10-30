/*
 * ヘキサゴニア — 画面と通信
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
    get(k) { try { return localStorage.getItem('hexagonia.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('hexagonia.' + k, v); } catch (e) { /* 無視 */ } },
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
    idPrefix: 'hexagonia-v1-',
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

  // focus：行動があったマスに視点を動かす（ほかの人の行動のとき）
  const settings = { cb: store.get('cb') === '1', patterns: store.get('patterns') === '1', focus: store.get('focus') === '1' };

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
    // 戦力：赤の六芒星（攻めにも守りにも使う）
    power: `<svg viewBox="0 0 24 24" class="tk"><path d="M12 2 L14.89 7 L20.66 7 L17.77 12 L20.66 17 L14.89 17 L12 22 L9.11 17 L3.34 17 L6.23 12 L3.34 7 L9.11 7 Z" fill="rgba(255,105,130,.5)" stroke="#FFA8B8" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    // 食料：黄色の丸
    food: `<svg viewBox="0 0 24 24" class="tk"><circle cx="12" cy="12" r="8" fill="rgba(240,200,40,.5)" stroke="#FFE27A" stroke-width="1.6"/></svg>`,
  };
  const TOKEN_NAMES = { resource: '資源', power: '戦力', food: '食料' };

  // ルール説明のアイコン（盤面の見た目に合わせた小さな絵）
  const HEX = 'M12 2 L20.7 7 L20.7 17 L12 22 L3.3 17 L3.3 7 Z';
  const hexAt = r => { const k = r / 10; return `M12 ${12 - 10 * k} L${12 + 8.7 * k} ${12 - 5 * k} L${12 + 8.7 * k} ${12 + 5 * k} L12 ${12 + 10 * k} L${12 - 8.7 * k} ${12 + 5 * k} L${12 - 8.7 * k} ${12 - 5 * k} Z`; };
  const svg = body => `<svg viewBox="0 0 24 24" class="tk">${body}</svg>`;
  const tile = (fill, stroke, extra) => svg(`<path d="${HEX}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>${extra || ''}`);
  const CELL_FILL = 'rgba(76,142,218,.45)', CELL_LINE = '#9CC6F2';
  const ICONS = {
    resource: TOKEN_SVG.resource,
    food: TOKEN_SVG.food,
    power: TOKEN_SVG.power,
    cell: tile(CELL_FILL, CELL_LINE),
    'cell-strong': tile(CELL_FILL, CELL_LINE, `<path d="${hexAt(6.2)}" fill="none" stroke="${CELL_LINE}" stroke-width="1.2"/>`),
    core: tile('rgba(227,155,0,.4)', '#FFD36B', '<circle cx="12" cy="12" r="3.6" fill="#E39B00" stroke="#FFD36B" stroke-width="1"/>'),
    'hex-plain': tile('#3A3A38', '#6A695F'),
    'hex-mine': tile('#3A3A38', '#6A695F', '<path d="M12 7.5 L14.8 12 L12 16.5 L9.2 12 Z" fill="#A3A198"/>'),
    'hex-forest': tile('#3A3A38', '#6A695F', '<path d="M12 15.6 L15.2 9.4 L8.8 9.4 Z" fill="none" stroke="#A3A198" stroke-width="1.3" stroke-linejoin="round"/>'),
    'hex-farm': tile('#3A3A38', '#6A695F', '<circle cx="12" cy="12" r="2.6" fill="#A3A198"/>'),
    'hex-river': tile('#2E4250', '#5B7A8C', '<path d="M7.5 10.5 q2.2 -1.6 4.5 0 t4.5 0 M7.5 13.8 q2.2 -1.6 4.5 0 t4.5 0" fill="none" stroke="#7FA4BC" stroke-width="1.2"/>'),
    bridge: tile('#2E4250', '#5B7A8C', '<path d="M6.5 9.6 H17.5 M6.5 14.4 H17.5 M8.5 9.6 V14.4 M10.8 9.6 V14.4 M13.2 9.6 V14.4 M15.5 9.6 V14.4" stroke="#B9A88C" stroke-width="1.2"/>'),
    'act-expand': svg(`<path d="${HEX}" fill="none" stroke="#9CC6F2" stroke-width="1.4" stroke-dasharray="2.5 1.8"/><path d="M12 8 V16 M8 12 H16" stroke="#9CC6F2" stroke-width="2" stroke-linecap="round"/>`),
    'act-destroy': svg(`<path d="${HEX}" fill="rgba(255,120,120,.18)" stroke="#FF9C94" stroke-width="1.3"/><path d="M8.5 8.5 L15.5 15.5 M15.5 8.5 L8.5 15.5" stroke="#FF9C94" stroke-width="2.2" stroke-linecap="round"/>`),
    group: svg(`<g fill="rgba(76,142,218,.45)" stroke="#9CC6F2" stroke-width="1"><path d="M7 3.5 L11 5.8 L11 10.2 L7 12.5 L3 10.2 L3 5.8 Z"/><path d="M15 3.5 L19 5.8 L19 10.2 L15 12.5 L11 10.2 L11 5.8 Z"/><path d="M11 10.5 L15 12.8 L15 17.2 L11 19.5 L7 17.2 L7 12.8 Z"/></g>`),
    event: svg('<path d="M12 3 L13.8 8.6 L19.6 8.6 L14.9 12 L16.7 17.6 L12 14.2 L7.3 17.6 L9.1 12 L4.4 8.6 L10.2 8.6 Z" fill="rgba(255,211,107,.35)" stroke="#FFD36B" stroke-width="1.3" stroke-linejoin="round"/>'),
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
      if (this.room && this.room.graceFor) this.room.broadcast(); // 自動で進めるまでの残り時間を更新
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
    // tutorial：チュートリアル（攻めてこない練習相手の CPU 1人と2人戦・イベントなし・すぐ始める）
    constructor(name, tutorial) {
      this.isLocal = true;
      const clone = m => JSON.parse(JSON.stringify(m));
      this.room = new window.HexRoom.Room({ code: '', send: (pid, msg) => { if (pid === this.id) { const m = clone(msg); setTimeout(() => onMessage(m), 0); } } });
      this.id = this.room.join(token(), name).id;
      this.room.handle(this.id, { type: 'addCpu' });
      if (tutorial) {
        this.room.events = false;
        this.room.handle(this.id, { type: 'cpuLevel', target: this.room.players.find(p => p.cpu).id, level: 'tutorial' });
        this.room.handle(this.id, { type: 'start' });
      }
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
    wasMyTurn: false,
    prevCells: null,    // 前回の盤面（変化したマスを光らせるため）
    clashResult: null,  // 公開された攻防の結果を少しのあいだ見せる { ...lastClash, until }
    bid: null,          // 攻防で出す数の入力中の値 { key, n }
    abandonSel: new Set(), // 捨てるセルとして選んだマス
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
      app.clashResult = null;
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
    } else if (type === 'local' || type === 'tutorial') {
      app.tutorial = type === 'tutorial' ? { step: 0, base: null } : null;
      app.conn = new LocalTransport(name, type === 'tutorial');
      return;
    } else {
      const code = $('#in-code').value.trim().toUpperCase();
      if (!code) { topMsg('部屋IDを入れてください'); return; }
      app.conn = new GuestTransport({ type: 'join', code, token: token(), name });
    }
    topMsg('接続しています…', 'info');
    $('#btn-create').disabled = $('#btn-join').disabled = $('#btn-local').disabled = $('#btn-tutorial').disabled = true;
  }

  function leaveRoom(text) {
    if (app.conn) app.conn.close();
    app.conn = null;
    app.room = null;
    app.me = null;
    app.tutorial = null;
    app.chatSeq = 0;
    app.chatUnread = 0;
    $('#chat').hidden = true;
    $('#coach').hidden = true;
    setReconnecting(false);
    hideTip();
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    $('#btn-create').disabled = $('#btn-join').disabled = $('#btn-local').disabled = $('#btn-tutorial').disabled = false;
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
    const auto = E.autoSettings(Math.max(R.minPlayers, room.players.length));
    const st = room.settings || {};
    for (const [id, val] of [['#set-actions', st.actions || 0], ['#set-rounds', st.rounds || 0]]) { $(id).disabled = !isHost; $(id).value = String(val); }
    $('#play-note').textContent = `いまの人数なら自動で ${auto.actions} 行動・${auto.rounds} ラウンド`;
    $('#diameter-note').textContent = dia ? `${diameterCells(dia)}マス` : autoDia ? `いまの人数では直径 ${autoDia}（${diameterCells(autoDia)}マス）` : '人数に合わせる（2人 7・4人 11・8人 15・12人 17 など）';
    $('#lobby-wait').textContent = isHost
      ? (enough ? `${room.players.length}人で始められます（盤面の直径 ${dia || autoDia}）` : `あと${R.minPlayers - room.players.length}人以上集まると始められます。${local ? 'CPUを追加してください' : '招待URLを送るか、CPUを追加してください'}`)
      : 'ホストがゲームを始めるのを待っています…';
  }

  // 直径 d の六角形の盤面のマスの数
  const diameterCells = d => { const r = (d - 1) / 2; return 3 * r * (r + 1) + 1; };

  let view = null;
  function boardView() {
    if (!view) view = new window.HexBoardView($('#board'), { onSelect: onCellSelect, onHover: onCellHover, onView: positionTip });
    return view;
  }

  function myTurn(g) { return !g.over && !g.pending && E.current(g).id === app.me; }

  function renderGame(room) {
    const g = room.game;
    const pl = id => g.players.find(p => p.id === id);
    const me = pl(app.me);
    const cur = E.current(g);
    const conn = id => { const p = room.players.find(x => x.id === id); return p ? p.connected : false; };
    const cpuOf = id => { const p = room.players.find(x => x.id === id); return p && p.cpu ? p : null; };   // CPU ならその人

    // 自分の手番では、何か行動できるマスを薄く光らせる
    const targets = myTurn(g) ? [...new Set(CELL_ACTIONS.flatMap(t => E.targets(g, app.me, t)))] : [];

    const colors = {};
    g.players.forEach(p => { colors[p.id] = colorOf(p.color); });
    boardView().setData({ game: g, colors, patterns: patternsOn(), targets, selected: app.tip && app.tip.pinned ? app.tip.key : null, marked: abandoning(g) ? [...app.abandonSel] : [], me: app.me });

    // 変化したマス（拡張・強化・破壊・脱落）を一瞬光らせる
    const cells = {};
    for (const [k, c] of Object.entries(g.board)) cells[k] = `${c.owner}|${c.strong}|${c.core}`;
    const changedCells = app.prevCells ? Object.keys(cells).filter(k => cells[k] !== app.prevCells[k]) : [];
    if (app.prevCells) view.flash(changedCells);
    // フォーカスモード：ほかの人の行動があったマス、自分が狙われた攻防のマスへ視点を動かす
    const pendKey = g.pending ? `${g.pending.attacker}|${g.pending.target}|${g.round}|${g.turn}` : null;
    if (settings.focus && app.prevCells && !g.over) {
      if (pendKey && pendKey !== app.lastPendKey && g.pending.attacker !== app.me) view.focusOn([g.pending.target]);
      else if (changedCells.length && E.current(g).id !== app.me) view.focusOn(changedCells);
    }
    app.lastPendKey = pendKey;
    app.prevCells = cells;

    // 上部の表示
    $('#hud-round').textContent = g.round === 0 ? '先行' : `${g.round} / ${g.rounds}`;
    // このラウンドのイベント
    const EV = E.EVENTS;
    const evNow = !g.over && g.round >= 1 && g.event ? EV[g.event] : null;
    const good = k => ['harvest', 'discovery', 'fishing', 'festival'].includes(k);
    $('#hud-event').hidden = !evNow;
    $('#hud-event').innerHTML = (evNow ? `<span class="${good(g.event) ? 'k-good' : 'k-bad'}" title="${esc(evNow.text)}"><b>${esc(evNow.name)}</b> <small>${esc(evNow.text.replace('このラウンド、', ''))}</small></span>` : '');
    $('#hud-turn').innerHTML = g.over ? '<strong>ゲーム終了</strong>'
      : `${swatch(cur.color)}<strong>${esc(cur.name)}</strong><span class="muted">の手番${cur.id === app.me ? '（あなた）' : ''}・残り行動 ${g.actionsLeft}</span>`;

    // 自分
    $('#me-swatch').innerHTML = me ? swatch(me.color) : '';
    $('#me-name').textContent = me ? me.name : '';
    $('#me-actions').textContent = !me ? '' : !me.alive ? '脱落' : myTurn(g) ? `残り行動 ${g.actionsLeft} / ${g.actionsPerTurn}` : '';
    renderMyTokens(me);

    // 拡張・強化・破壊はマスを選んで出るツールチップから。マスに関係ない生産と手番終了はここ
    const canAct = me && me.alive && myTurn(g);
    // 生産：資源でトークンを作る（行動回数を使わない）
    const prod = (type, kind, label) => `<button class="act prod" data-act="${type}" ${canAct && !E.actionBlocked(g, app.me, type) ? '' : 'disabled'} title="生産：資源 ${R.cost[type]} で${label}トークン +1（行動回数を使わない・ログに出ない）">${TOKEN_SVG[kind]}<b>生産</b><small>資源 ${R.cost[type]} → ${label} +1</small></button>`;
    // 取り消し：この手番の行動を、新しいものから1つずつ戻す
    const undoLast = g.undo && g.undo.length ? g.undo[g.undo.length - 1].label : '';
    $('#actions').innerHTML = `<button class="act undo" data-act="undo" ${canAct && undoLast ? '' : 'disabled'} title="この手番の行動を、新しいものから1つずつ取り消す（Ctrl+Z）"><b>↶ 取り消す</b><small>${undoLast ? esc(undoLast) : '取り消せる行動なし'}</small></button>`
      + prod('produce', 'power', '戦力')
      + `<button class="act end" data-act="endTurn" ${canAct ? '' : 'disabled'}><b>手番終了</b><small>${me ? netText(g) : ''}</small></button>`
      + (canAct && g.actionsLeft === 0 ? `<button class="act buy" data-act="buyAction" ${E.actionBlocked(g, app.me, 'buyAction') ? 'disabled' : ''}><b>行動 +1</b><small>資源 ${E.extraActionCost(g)} を払う</small></button>` : '');

    let hint = '';
    if (g.over) hint = '';
    else if (!me || !me.alive) hint = '脱落しました。観戦できます';
    else if (g.abandon) hint = g.abandon.player === app.me ? '食料が足りません。捨てるセルを選んでください' : `${(g.players.find(p => p.id === g.abandon.player) || {}).name} が捨てるセルを選んでいます`;
    else if (g.pending) hint = '破壊の攻防中です';
    else if (!myTurn(g)) hint = `${cur.name} の手番です`;
    else if (['produce', 'buyAction'].every(t => E.actionBlocked(g, app.me, t)) && ['expand', 'strengthen', 'cultivate', 'destroy'].every(t => !E.targets(g, app.me, t).length)) hint = 'もう行動できません。「手番終了」を押してください（「取り消す」で戻すこともできます）';
    else if (g.actionsLeft === 0) hint = `行動回数を使い切りました。「手番終了」か、資源 ${E.extraActionCost(g)} を払って「行動 +1」`;
    else hint = 'あなたの手番です。光っているマスを選ぶと、拡張・強化・破壊のボタンが出ます';
    $('#hint').textContent = hint;

    // プレイヤー一覧
    const isHost = room.hostId === app.me;
    $('#players').classList.toggle('compact', g.players.length > 6);
    // 手番の順に並べる
    const n = g.players.length;
    const roundOrder = g.players.map((_, k) => g.players[((g.roundStart || 0) + k) % n]);
    $('#players').innerHTML = roundOrder.map(p => {
      const cells = E.cellsOf(g, p.id).length;
      const group = E.largestGroup(g, p.id).length;
      const turn = !g.over && p.id === cur.id;
      return `<li class="${p.alive ? '' : 'out'}${turn ? ' turn' : ''}">
        <div class="prow">${turn ? '<span class="turn-mark">▶</span>' : ''}${swatch(p.color)}<span class="pname">${esc(p.name)}</span>${cpuOf(p.id) ? `<span class="badge cpu">CPU・${cpuOf(p.id).level === 'tutorial' ? '練習相手' : window.HexCpu.LEVEL_NAMES[cpuOf(p.id).level] || 'ふつう'}</span>` : ''}${p.id === app.me ? '<span class="badge me">あなた</span>' : ''}${conn(p.id) ? '' : '<span class="badge warn" title="切断中">切断中</span>'}${p.alive ? '' : '<span class="badge">脱落</span>'}</div>
        <div class="pstats"><span class="cells" title="つながっている一番大きなかたまり（勝敗はこれで決まる）／セルの総数"><svg viewBox="0 0 24 24" class="tk"><path d="M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z" fill="none" stroke="currentColor" stroke-width="2"/></svg><b>${group}</b><small>/${cells}</small></span>${tokenChip('resource', p.resource)}${tokenChip('power', p.power)}${tokenChip('food', p.food)}</div>
        ${isHost && p.alive && !conn(p.id) && !g.over ? `<button class="small" data-forfeit="${p.id}">脱落させる</button>` : ''}
      </li>`;
    }).join('');

    // ログ（新しいものほど下）
    const logEl = $('#log');
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    logEl.innerHTML = g.log.map(l => `<li class="lg-${l.tone}">${esc(l.text)}</li>`).join('');
    if (atBottom || !app.lastLogSeq) logEl.scrollTop = logEl.scrollHeight;
    const fresh = app.lastLogSeq ? g.log.filter(l => l.seq > app.lastLogSeq) : [];
    for (const l of fresh) {
      if (/^破壊(成功|失敗)/.test(l.text) || l.tone === 'out' || l.tone === 'hit') toast(l.text, l.tone === 'defend' ? 'info' : 'bad');
      else if (me && l.text === `${me.name} はもう行動できないため、自動で手番終了`) toast('もう行動できないため、自動で手番を終えました', 'info');
    }
    // コアに命中したら、コアを赤く光らせる（マスは変わらないので）
    if (g.lastClash && fresh.some(l => l.tone === 'hit')) view.flash([g.lastClash.target], '255,110,110');
    playSounds(g, fresh);
    // 自分の手番終了：どのマスで何が増えたかを盤面に浮かべ、下のバーの数字を「増えてから減る」順に動かす
    const le = g.lastEndTurn;
    if (le && le.player === app.me && fresh.some(l => l.seq === le.seq)) playEndTurn(g, le);
    app.lastLogSeq = g.log.length ? g.log[g.log.length - 1].seq : 0;

    // 公開された攻防の結果を少しのあいだ見せる
    const lc = g.lastClash;
    if (lc && fresh.some(l => l.tone === 'clash')) {   // 出し合いがあったときだけ
      app.clashResult = Object.assign({}, lc, { until: Date.now() + 3500 });
      setTimeout(() => { if (app.room && app.room.game) renderClash(app.room.game, id => app.room.game.players.find(p => p.id === id)); }, 3600);
      if (!lc.success) view.flash([lc.target], '120,190,255');   // 守られたマスは青く光らせる
    }

    // 自分の番が来たら知らせる
    // 攻防のあいだも自分の手番は続いているので、攻防の前後では知らせない
    const mine = !g.over && E.current(g).id === app.me && !!me && me.alive;
    if (mine && !app.wasMyTurn) { toast('あなたの手番です', 'good'); window.HexSound.play('turn'); }
    app.wasMyTurn = mine;

    updateDock();
    renderCoach();
    renderClash(g, pl);
    renderExtra(g, me);
    renderAbandon(g, me);
    updateDock();   // 捨てるセルの表示でバーの高さが変わるので、盤面の余白を合わせ直す
    tickTimers();
    renderResult(room, g);
    if (app.tip) showTip(app.tip);
  }

  // 下のバーの自分のトークン。手番終了の演出中は、演出の途中の数を見せる
  function renderMyTokens(me) {
    const v = app.tokenView;
    $('#me-tokens').innerHTML = me
      ? tokenChip('resource', v ? v.resource : me.resource, true) + tokenChip('power', me.power, true) + tokenChip('food', v ? v.food : me.food, true)
      : '';
    if (v && v.flash) for (const [kind, cls] of Object.entries(v.flash)) {
      const chip = $(`#me-tokens .tk-${kind}`);
      if (chip) chip.classList.add(cls);
    }
  }

  // 手番終了の演出（自分の手番だけ）。数は lastEndTurn の合計に合わせ、マスごとの内訳は盤面から数える
  function playEndTurn(g, le) {
    const inc = R.income, f = R.food;
    const me = g.players.find(p => p.id === app.me);
    let baseRes = 0, baseFood = 0;
    for (const c of E.cellsOf(g, app.me)) {
      const res = (c.core ? inc.core + (c.strong && inc.coreStrongBonus ? inc.strong : 0) : c.strong ? inc.strong : 0) + (c.terrain === 'forest' ? R.forestResource : 0);
      const food = (c.core ? f.core : 0) + (c.strong ? f.strong : 0) + (c.terrain === 'farm' ? R.farmFood : 0);
      baseRes += res; baseFood += food;
      if (res || food) floater(E.key(c.q, c.r), (res ? `<span class="fl-res">${TOKEN_SVG.resource}+${res}</span>` : '') + (food ? `<span class="fl-food">${TOKEN_SVG.food}+${food}</span>` : ''), 'gain', 0);
    }
    // イベント（豊作・不作など）で変わった分は、コアの上にまとめて出す
    const dRes = le.resource - baseRes, dFood = le.made - baseFood;
    const sign = n => (n > 0 ? '+' : '−') + Math.abs(n);
    if (dRes || dFood) floater(me.core, `<span class="fl-ev">イベント ${dRes ? `資源 ${sign(dRes)}` : ''}${dRes && dFood ? '・' : ''}${dFood ? `食料 ${sign(dFood)}` : ''}</span>`, 'gain', 250);
    // 少し遅れて、食べた分をコアの上に（セル1つずつ出すとうるさいので合計で）
    floater(me.core, `<span class="fl-food">${TOKEN_SVG.food}−${le.eaten}</span>${le.hungry ? `<span class="fl-short">${le.hungry} 足りない</span>` : ''}`, 'loss', 900);
    // 下のバー：増える前 → 増えた → 減った
    const set = (resource, food, flash) => { app.tokenView = { resource, food, flash }; renderMyTokens(app.room && app.room.game.players.find(p => p.id === app.me)); };
    clearTimeout(app.tokenTimer1); clearTimeout(app.tokenTimer2); clearTimeout(app.tokenTimer3);
    set(le.resBefore, le.foodBefore, null);
    app.tokenTimer1 = setTimeout(() => set(le.resBefore + le.resource, le.foodBefore + le.made, { resource: 'up', food: 'up' }), 200);
    app.tokenTimer2 = setTimeout(() => set(le.resBefore + le.resource, Math.max(0, le.foodBefore + le.made - le.eaten), { food: le.hungry ? 'short' : 'down' }), 1100);
    app.tokenTimer3 = setTimeout(() => { app.tokenView = null; renderMyTokens(app.room && app.room.game && app.room.game.players.find(p => p.id === app.me)); }, 2000);
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

  // 破壊の攻防：攻撃側と防御側が出す数を伏せて決める。そろったら同時に公開
  function renderClash(g, pl) {
    const el = $('#clash');
    const pd = g.pending;
    const res = app.clashResult && app.clashResult.until > Date.now() ? app.clashResult : null;
    if ((!pd && !res) || g.over) { el.hidden = true; return; }
    const info = pd || res;
    const a = pl(info.attacker), d = pl(info.defender);
    const cell = g.board[info.target];
    const what = pd ? (cell.core ? 'コア' : 'セル') : 'マス';
    const head = `<div class="clash-head">${swatch(a.color)}<b>${esc(a.name)}</b><span class="arrow">→</span>${swatch(d.color)}<b>${esc(d.name)}</b><span class="muted">の${what} (${cell.q},${cell.r}) に破壊</span></div>`;
    if (!pd) {
      // 公開された結果
      el.innerHTML = `${head}
        <p class="clash-result ${res.success ? 'bad' : 'good'}">${res.success ? '破壊成功' : '破壊失敗（守られた）'}</p>
        <p class="muted small" style="text-align:center">${res.atk != null ? `あなたは戦力トークンを ${res.atk} 個出しました。` : res.def != null ? `あなたは戦力トークンを ${res.def} 個出しました。` : ''}出した数はほかの人には公開されません</p>`;
      el.hidden = false;
      return;
    }
    const side = pd.attacker === app.me ? 'atk' : pd.defender === app.me ? 'def' : null;
    const status = (name, ready) => `<span class="${ready ? 'ready' : ''}">${esc(name)}：${ready ? '決定済み' : '考え中…'}</span>`;
    let body;
    if (side && pd[side] === null) {
      const me = side === 'atk' ? a : d;
      const foe = side === 'atk' ? d : a;
      const have = me.power;   // 相手の戦力トークンの数は見えない
      const key = `${pd.attacker}|${pd.target}|${g.round}|${g.turn}|${side}`;
      const lo = E.minBid(side);
      if (!app.bid || app.bid.key !== key) app.bid = { key, n: Math.min(have, 2) };
      // 同じ手番に同じマスへもう一度宣言したときなど、前の数が持っている数を超えていたら直す
      app.bid.n = Math.max(lo, Math.min(have, app.bid.n));
      app.bid.lo = lo;
      const n = app.bid.n;
      const kind = 'power';
      body = `<p class="ask">${side === 'atk'
        ? `出す戦力トークンの数を決めてください（1個以上。${esc(foe.name)} の戦力トークンの数は見えません）`
        : `あなたの${what}が狙われています。出す戦力トークンの数を決めてください（${esc(foe.name)} の戦力トークンの数は見えません）`}</p>
        <p class="muted small">相手には公開まで見えません。攻撃側が防御側と同じ数以上出したら破壊成功（同じ数なら攻撃側の勝ち）。出したトークンはなくなります</p>
        <div class="bid">
          <span class="bid-n tk-${kind}">${TOKEN_SVG[kind]}<b data-bid-n>${n}</b><small>/ ${have}</small></span>
          <input type="range" class="bid-range" data-bid-range min="${lo}" max="${have}" step="1" value="${n}" ${have <= lo ? 'disabled' : ''} aria-label="出す戦力トークンの数">
        </div>
        <button class="primary bid-ok${side === 'atk' ? ' danger' : ''}" data-bid-ok><span data-bid-label>${n}</span> 個で決定</button>`;
    } else if (side) {
      body = `<p class="muted">あなたは ${pd[side]} 個に決めました。相手を待っています…</p>`;
    } else {
      body = '<p class="muted">出す数を伏せて選んでいます…</p>';
    }
    // 攻撃側は、決着する前なら破壊を取りやめられる
    if (pd.attacker === app.me) body += '<button class="link cancel-destroy" data-cancel-destroy>破壊をやめる（資源と行動回数が戻る）</button>';
    el.innerHTML = `${head}${body}
      <div class="clash-status">${status(a.name, pd.atkReady)}${status(d.name, pd.defReady)}<span class="muted" data-left="bid"></span></div>`;
    el.hidden = false;
    tickTimers();
  }

  // 行動回数を使い切ったら、画面中央で「手番終了」か「資源を払って行動 +1」かを選ぶ
  function renderExtra(g, me) {
    const el = $('#extra');
    const show = myTurn(g) && me && me.alive && g.actionsLeft === 0 && !g.abandon;
    const key = `${g.round}:${g.turn}:${g.extraBought}`;
    if (!show || app.extraHidden === key) { el.hidden = true; return; }
    const cost = E.extraActionCost(g);
    const lack = cost - me.resource;
    el.innerHTML = `<div class="extra-card">
      <h3>行動回数を使い切りました</h3>
      <div class="extra-btns">
        <button data-extra="endTurn"><b>手番終了</b><small>${netText(g)}</small></button>
        <button class="primary" data-extra="buyAction" ${lack > 0 ? 'disabled' : ''}><b>行動 +1</b><small>${TOKEN_SVG.resource}${cost} を払う${lack > 0 ? `（あと ${lack} 足りない）` : ''}</small></button>
      </div>
      <p class="muted small">行動 +1 に必要な資源は、同じ手番で買うたびに +${R.extraAction.step}（手番が変わると ${R.extraAction.base} に戻る）</p>
      <button class="link" data-extra="hide">盤面を見る</button>
    </div>`;
    el.dataset.key = key;
    el.hidden = false;
  }

  // 手番終了で受け取る資源と、作る・食べる食料
  function netText(g) {
    const inc = E.income(g, app.me);
    const made = E.foodMade(g, app.me), eaten = E.foodEaten(g, app.me);
    const me = g.players.find(p => p.id === app.me);
    const short = Math.max(0, eaten - made - ((me && me.food) || 0));
    return `資源 +${inc}・食料 +${made} −${eaten}` + (short ? `（${short} 足りない）` : '');
  }

  // 自分が捨てるセルを選んでいるところか
  function abandoning(g) { return !!(g && g.abandon && g.abandon.player === app.me); }

  // 食料が足りないとき：捨てるセルを盤面で選ぶ（コアは選べない）
  function renderAbandon(g, me) {
    const el = $('#abandon');
    $('#dock').classList.toggle('abandoning', abandoning(g));
    if (!abandoning(g)) { el.hidden = true; app.abandonSel = new Set(); return; }
    if (app.tip) hideTip();   // 選んでいたマスのツールチップは閉じる（マスを選ぶと捨てる候補になるので）
    const n = g.abandon.count;
    for (const k of [...app.abandonSel]) { const c = g.board[k]; if (!c || c.owner !== app.me || c.core) app.abandonSel.delete(k); }
    const k = app.abandonSel.size;
    el.innerHTML = `<div class="extra-card abandon-card">
      <h3>食料が足りません</h3>
      <p>捨てるセルを <b>${n}</b> つ、盤面で選んでください（コアは選べません）</p>
      <p class="abandon-count ${k === n ? 'ok' : ''}">選んだ数 <b>${k}</b> / ${n}</p>
      <div class="extra-btns">
        <button data-abandon="auto">おまかせで選ぶ</button>
        <button class="primary danger" data-abandon="ok" ${k === n ? '' : 'disabled'}>このセルを捨てる</button>
      </div>
      <p class="muted small" data-left="abandon"></p>
    </div>`;
    el.hidden = false;
    tickTimers();
  }

  // ---------- チュートリアル ----------
  // 1ステップずつ案内する。「やってみよう」のステップは、やったら自動で次へ進む
  const myCells = g => E.cellsOf(g, app.me);
  const TUTORIAL = [
    { title: 'ヘキサゴニアへようこそ', next: true,
      text: '六角形のマスで<b>セル</b>（自分の陣地）を広げるゲームです。<br>最後のラウンドが終わったとき、<b>つながっている一番大きなかたまり</b>が一番大きい人の勝ち。<br>中心に円のある光るセルが、あなたの<b>コア</b>です。コアを壊されると脱落なので、守りましょう。' },
    { title: '盤面の見方', next: true,
      text: 'マスには地形があります。<br>◆ <b>鉱山</b>：取ると戦力トークン +1　▽ <b>森林</b>：毎手番 資源 +1<br>● <b>農地</b>：自分の平原のセルを<b>開墾</b>（資源2）すると農地になり、毎手番 食料 +1<br>〜 <b>河川</b>：資源3で橋をかけないと渡れません。<br>マスにカーソルを合わせると（スマホは選ぶと）、説明が出ます。' },
    { title: 'やってみよう：拡張', myTurn: true, target: '#tooltip [data-cell-act="expand"]',
      text: '自分のセルの隣の、<b>光っている空きマス</b>を選んでください。出てきた<b>「拡張」</b>を押すと、そこがあなたのセルになります（資源1）。<br>押しまちがえたら、手番のあいだなら下のバーの<b>「取り消す」</b>で戻せます。',
      done: (g, base) => myCells(g).length > base.cells },
    { title: 'やってみよう：強化', myTurn: true, target: '#tooltip [data-cell-act="strengthen"]',
      text: '自分のセル（コアでもOK）を選んで<b>「強化」</b>を押してください（資源2）。<br>強化すると、戦力トークン +1、そして毎手番 資源 +1・食料 +1 がもらえます。<br>強化済のセルは、あとで説明する<b>拠点</b>にもなります。',
      done: g => myCells(g).some(c => c.strong) },
    { title: 'トークンと食料', next: true, target: '#me-tokens',
      text: '下のバーに、あなたの持ち物が出ています。<br><span class="k-res">資源</span>：行動に使う　<span class="k-pow">戦力</span>：攻めにも守りにも使う（ほかの人からは数が見えません）　<span class="k-food">食料</span>：セルが食べる<br>手番の終わりに、セル1つにつき食料を1食べます。足りないとセルを捨てることになります。<br>手番を終えると、どのマスで何が増えたかが盤面に浮かび、下のバーの数字も「増えてから減る」順に動きます。食料が足りなくなりそうなら、セルを選んで<b>開墾</b>しましょう。' },
    { title: 'やってみよう：生産', myTurn: true, target: '#actions [data-act="produce"]', skippable: true,
      text: '下のバーの<b>「生産」</b>で、資源から戦力トークンを作れます（資源2）。行動回数は使いません。<br>作ってみましょう。資源が足りなければ「次へ」で進めます。',
      done: (g, base) => { const me = g.players.find(p => p.id === app.me); return me && me.power > base.power; } },
    { title: 'やってみよう：手番終了', myTurn: true, target: '#actions [data-act="endTurn"]',
      text: '行動を使ったら<b>「手番終了」</b>を押します。資源と食料をもらい、食料を食べてから次の人の番です。<br>ボタンに、もらえる量と食べる量が出ています。',
      done: (g, base) => g.turnNo !== base.turnNo },
    { title: '破壊と読み合い', next: true,
      text: '相手のセルは<b>破壊</b>できます（資源2・戦力トークンが1個以上必要）。<br>攻撃側と防御側が、出す戦力トークンの数を<b>伏せて</b>決め、<b>攻撃側が防御側と同じ数以上なら</b>成功（同じ数なら攻撃側の勝ち）。成功したマスは自分のセルになります。<br>結果は成功か失敗かだけが知らされ、出した数は相手にはわかりません。' },
    { title: 'どこを強化するか：拠点', next: true,
      text: '<b>拠点</b>：破壊できるのは、<b>自分の強化済のセルの隣</b>にある相手のセルだけ。攻めたい方向のセルを強化しましょう。<br>前線に強化すれば攻めの足がかりになるけれど、相手もその近くを狙ってきます。後方に強化すれば安全に稼げるけれど、攻めには使えません。' },
    { title: 'もう少しだけ', next: true,
      text: 'ラウンドの始まりに、ときどき<b>イベント</b>（豊作・不作など）が起きます。起きたイベントは画面上部に出ます。<br>行動回数を使い切ったら、資源を払って<b>行動 +1</b> もできます。' },
    { title: 'これでおしまい', next: true, last: true,
      text: 'あとはこのまま CPU と最後まで遊んでみてください。<br>ルールはいつでも右上の <b>？</b> で見られます。' },
  ];

  function tutorialBase(g) {
    const me = g.players.find(p => p.id === app.me) || {};
    return { cells: myCells(g).length, power: me.power || 0, turnNo: g.turnNo };
  }

  function renderCoach() {
    const el = $('#coach');
    document.querySelectorAll('.coach-target').forEach(n => n.classList.remove('coach-target'));
    const t = app.tutorial;
    const g = app.room && app.room.game;
    if (!t || !g || g.over || t.step >= TUTORIAL.length) { el.hidden = true; return; }
    if (!t.base) t.base = tutorialBase(g);
    let st = TUTORIAL[t.step];
    // やってみようのステップは、やったら次へ
    while (st.done && st.done(g, t.base)) {
      t.step++;
      t.base = tutorialBase(g);
      if (t.step >= TUTORIAL.length) { el.hidden = true; return; }
      st = TUTORIAL[t.step];
    }
    const mine = !g.pending && !g.abandon && E.current(g).id === app.me;
    const wait = st.myTurn && !mine;
    el.innerHTML = `<div class="coach-head"><b>${st.title}</b><span class="muted">${t.step + 1} / ${TUTORIAL.length}</span></div>
      <p>${st.text}</p>
      ${wait ? '<p class="muted small">相手の手番です。あなたの手番になるまで少し待ってください…</p>' : ''}
      <div class="coach-btns">
        <button class="link" data-coach="quit">チュートリアルをやめる</button>
        ${st.next ? `<button class="primary" data-coach="next">${st.last ? 'おわる' : '次へ'}</button>` : st.skippable ? '<button data-coach="next">次へ</button>' : ''}
      </div>`;
    el.hidden = false;
    if (st.target && !wait) { const n = document.querySelector(st.target); if (n) n.classList.add('coach-target'); }
  }

  // 効果音：新しいログから、いちばん大事なものを1つ鳴らす
  function playSounds(g, fresh) {
    if (!fresh.length) return;
    const order = ['win', 'out', 'success', 'fail', 'abandon', 'event', 'declare', 'buy', 'strengthen', 'expand', 'endTurn'];
    const found = new Set();
    for (const l of fresh) {
      if (l.tone === 'win') found.add('win');
      else if (l.tone === 'out') found.add('out');
      else if (/^破壊成功/.test(l.text) || l.tone === 'hit') found.add('success');
      else if (l.tone === 'abandon') found.add('abandon');
      else if (l.tone === 'event' && l.text.startsWith('イベント：')) found.add('event');
      else if (/^破壊失敗/.test(l.text)) found.add('fail');
      else if (l.tone === 'destroy') found.add('declare');
      else if (l.tone in { strengthen: 1, expand: 1, buy: 1 }) found.add(l.tone);
      else if (l.tone === 'income') found.add('endTurn');
    }
    const name = order.find(n => found.has(n));
    if (name === 'win') window.HexSound.play(g.winners.includes(app.me) ? 'win' : 'lose');
    else if (name) window.HexSound.play(name);
  }

  // 残り時間の表示（持ち時間・攻防・切断）。届いた時刻からの経過で数える
  let lastTickSec = null;
  function tickTimers() {
    const room = app.room;
    const g = room && room.game;
    const el = $('#hud-timer');
    if (!g || room.phase !== 'game' || g.over || g.abandon) { el.hidden = true; return; }
    const pass = Date.now() - (app.graceAt || Date.now());
    const sec = ms => Math.max(0, Math.ceil(ms / 1000));
    const turnSec = sec(room.turnLeftMs - pass);
    const mm = `${Math.floor(turnSec / 60)}:${String(turnSec % 60).padStart(2, '0')}`;
    el.hidden = false;
    el.className = 'pill timer' + (turnSec <= 10 ? ' low' : '');
    el.innerHTML = `<span class="muted">持ち時間</span> <strong>${mm}</strong>`;
    // 自分の手番の残り10秒は時計の音
    if (myTurn(g) && turnSec <= 10 && turnSec > 0 && turnSec !== lastTickSec) window.HexSound.play('tick');
    lastTickSec = turnSec;
    const abEl = document.querySelector('[data-left="abandon"]');
    if (abEl) abEl.textContent = `あと ${sec(room.abandonLeftMs - pass)} 秒（時間切れのときは自動で選びます）`;
    const bidEl = document.querySelector('[data-left="bid"]');
    if (bidEl) bidEl.textContent = `あと ${sec(room.bidLeftMs - pass)} 秒`;
    const grace = $('#grace');
    if (room.graceFor) {
      const p = g.players.find(x => x.id === room.graceFor);
      grace.textContent = `${p ? p.name : ''} の接続が切れています。あと ${sec(room.graceLeftMs - pass)} 秒で手番を終えます`;
    }
    grace.hidden = !room.graceFor;
  }

  function renderResult(room, g) {
    const el = $('#result');
    if (!g.over) { el.hidden = true; return; }
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
    const g = app.room && app.room.game;
    if (abandoning(g)) {
      // 捨てるセルを選ぶあいだは、ツールチップは出さない（出ていたら閉じる）。盤面の外や自分以外のマスを選んでも閉じるだけ
      hideTip();
      const c = key && g.board[key];
      if (!c || c.owner !== app.me) return;
      if (c.core) { toast('コアは捨てられません'); return; }
      if (app.abandonSel.has(key)) app.abandonSel.delete(key);
      else if (app.abandonSel.size < g.abandon.count) app.abandonSel.add(key);
      else toast(`捨てるのは ${g.abandon.count} つまでです`);
      render();
      return;
    }
    if (!key || (app.tip && app.tip.pinned && app.tip.key === key)) { hideTip(); return; }
    showTip({ key, pinned: true });
  }

  function onCellHover(key, x, y, scale, byLongPress) {
    if (byLongPress) { if (key && !abandoning(app.room && app.room.game)) showTip({ key, pinned: true }); return; }
    if (app.tip && app.tip.pinned) return;   // 選んでいるマスがあるあいだは、そちらを出したまま
    if (!key) hideTip(); else showTip({ key, pinned: false });
  }

  const TERRAIN_EFFECTS = {
    plain: `効果なし。自分のセルなら、資源 ${R.cost.cultivate} で開墾して農地にできる`,
    mine: `拡張したとき（破壊で取ったときも）と強化したときに、戦力トークン +${R.minePower}`,
    farm: `開墾した土地。このセルがあると、手番終了時に食料 +${R.farmFood}（強化の +${R.food.strong} とは別）`,
    forest: `このセルがあると、手番終了時に資源 +${R.forestResource}（強化の +${R.income.strong} とは別）`,
    river: `セルを置くには橋をかける（資源 ${R.cost.bridge}）。橋は強化できる。破壊されると橋が落ちて河川に戻る`,
  };

  const CELL_ACTIONS = ['expand', 'strengthen', 'destroy'];

  // そのマスでできる行動と、できないときの理由（自分のセルなら強化と開墾の2つになることがある）
  function cellActions(g, key) {
    const c = g.board[key];
    const me = g.players.find(p => p.id === app.me);
    if (!me || !me.alive || g.over) return null;
    const list = [];
    if (!c.owner) {
      list.push({ type: 'expand', cost: E.expandCost(c),
        gain: c.terrain === 'mine' ? `戦力トークン +${R.minePower}` : c.terrain === 'farm' ? `手番終了時の食料 +${R.farmFood}` : c.terrain === 'forest' ? `手番終了時の資源 +${R.forestResource}` : c.terrain === 'river' ? '橋をかけて河川を渡る' : '' });
    } else if (c.owner === app.me) {
      if (!c.strong) {
        const inc = c.core ? (R.income.coreStrongBonus ? R.income.strong : 0) : R.income.strong;
        list.push({ type: 'strengthen', cost: R.cost.strengthen,
          gain: `戦力トークン +${R.strengthenPower + (c.terrain === 'mine' ? R.minePower : 0)}・手番終了時の資源 +${inc}・食料 +${R.food.strong}。隣の相手セルを破壊できる拠点になる` });
      }
      if (!c.core && c.terrain === 'plain') list.push({ type: 'cultivate', cost: R.cost.cultivate, gain: `農地にする。手番終了時の食料 +${R.farmFood}（強化の +${R.food.strong} とは別）` });
      if (!list.length) return { note: c.strong ? '強化済のセルです' : 'このセルでできる行動はありません' };
    } else {
      const foe = g.players.find(p => p.id === c.owner);
      list.push({ type: 'destroy', cost: R.cost.destroy,
        gain: '戦力トークンが1個以上必要（相手の戦力トークンの数は見えない）。' + (c.core
          ? `成功するとコアを破壊（${foe.name} は脱落し、セルとトークンをまるごと奪える）`
          : c.terrain === 'river'
            ? '成功すると橋が落ちて河川に戻る'
            : '成功するとこのマスが自分のセルになる') });
    }
    for (const a of list) {
      a.why = '';
      if (E.targets(g, app.me, a.type).includes(key)) continue;
      const cur = E.current(g);
      if (g.pending) a.why = '破壊の攻防が終わるまで待ってください';
      else if (cur.id !== app.me) a.why = `${cur.name} の手番です`;
      else if (g.abandon) a.why = '捨てるセルを選んでいるところです';
      else if (g.actionsLeft <= 0) a.why = '行動回数を使い切りました';
      else if (me.resource < a.cost) a.why = `資源トークンが足りません（あと ${a.cost - me.resource}）`;
      else if (a.type === 'destroy' && me.power < 1) a.why = '戦力トークンが1個以上必要です（強化・鉱山・生産で増やせる）';
      else if (a.type === 'destroy') a.why = '自分の強化済のセル（拠点）に隣接していません。隣のセルを強化すると狙えます';
      else a.why = '自分のセルに隣接していません';
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
    const state = !owner ? (c.terrain === 'river' ? '河川（橋なし）' : '空きマス') : (c.terrain === 'river' ? '橋・' : '') + (c.core ? 'コア・' : '') + (c.strong ? '強化済' : '未強化');
    let acts = '';
    if (tip.pinned) {
      const r = cellActions(g, tip.key);
      if (r && r.list) {
        // 理由は同じことが多いので、まとめて最後に1回だけ出す
        const whys = [...new Set(r.list.map(a => a.why).filter(Boolean))];
        acts = `<div class="tt-acts">${r.list.map(a => `<button class="tt-act${a.type === 'destroy' ? ' danger' : ''}" data-cell-act="${a.type}" ${a.why ? 'disabled' : ''}>
          <b>${a.type === 'expand' && c.terrain === 'river' ? '橋をかける' : E.ACTION_NAMES[a.type]}</b><span class="tt-cost">${TOKEN_SVG.resource}${a.cost}</span>${a.gain ? `<small>${esc(a.gain)}</small>` : ''}</button>`).join('')}
          ${whys.map(w => `<p class="tt-why">${esc(w)}</p>`).join('')}</div>`;
      } else if (r && r.note) {
        acts = `<div class="tt-acts"><p class="tt-why">${esc(r.note)}</p></div>`;
      }
    }
    const el = $('#tooltip');
    el.innerHTML = `<div class="tt-head">${{ plain: '', mine: '◆ ', farm: '● ', forest: '▽ ', river: '〜 ' }[c.terrain]}${E.TERRAIN_NAMES[c.terrain]}<span class="muted">(${c.q},${c.r})</span></div>
      <div>所有者：${owner ? `${swatch(owner.color)}${esc(owner.name)}` : '<span class="muted">なし</span>'}</div>
      <div>状態：${state}</div>
      <div class="tt-eff">${TERRAIN_EFFECTS[c.terrain]}</div>${acts}`;
    el.classList.toggle('pinned', !!tip.pinned);
    el.hidden = false;
    positionTip();
    if (app.tutorial) renderCoach();   // ツールチップのボタンを光らせる
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

  // ---------- 設定 ----------

  function renderSettings() {
    $('#set-cb').checked = settings.cb;
    $('#set-pattern').checked = settings.patterns;
    $('#set-sound').checked = window.HexSound.on;
    $('#set-focus').checked = settings.focus;
    $('#set-preview').innerHTML = window.HexRoom.COLORS.map(c =>
      `<span>${swatch(c, 'big')}${colorOf(c).name}${patternsOn() ? `<small>${PATTERN_NAMES[PATTERNS[c]]}</small>` : ''}</span>`).join('');
  }

  // ---------- イベント ----------

  // 盤面の下に浮かせた自分の情報の高さを、盤面の表示範囲・攻防のパネル・盤面のボタンの位置に反映
  function updateDock() {
    const h = $('#dock').offsetHeight;
    if (!h) return;
    $('.board-wrap').style.setProperty('--dock-h', h + 'px');
    if (view) view.setInsetBottom(h + 20);
    placeChat();
  }

  // ルール説明などの <i data-icon="…"> にアイコンを入れる
  function fillIcons() {
    document.querySelectorAll('[data-icon]').forEach(el => { if (ICONS[el.dataset.icon]) el.innerHTML = ICONS[el.dataset.icon]; });
  }

  function init() {
    fillIcons();
    new ResizeObserver(updateDock).observe($('#dock'));
    const params = new URLSearchParams(location.search);
    $('#in-name').value = store.get('name') || '';
    const code = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code) { $('#in-code').value = code; topMsg(`部屋ID ${code} に招待されています。なまえを入れて「参加する」を押してください`, 'info'); }

    $('#btn-create').onclick = () => enterRoom('create');
    $('#btn-join').onclick = () => enterRoom('join');
    $('#btn-local').onclick = () => enterRoom('local');
    $('#btn-tutorial').onclick = () => enterRoom('tutorial');
    $('#coach').onclick = e => {
      const b = e.target.closest('[data-coach]');
      if (!b || !app.tutorial) return;
      if (b.dataset.coach === 'quit') { app.tutorial = null; renderCoach(); return; }
      app.tutorial.step++;
      app.tutorial.base = null;
      if (app.tutorial.step >= TUTORIAL.length) app.tutorial = null;
      renderCoach();
    };
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

    $('#extra').onclick = e => {
      const b = e.target.closest('[data-extra]');
      if (!b || b.disabled) return;
      if (b.dataset.extra === 'hide') { app.extraHidden = $('#extra').dataset.key; $('#extra').hidden = true; return; }
      send({ type: 'act', action: { type: b.dataset.extra } });
    };
    $('#abandon').onclick = e => {
      const b = e.target.closest('[data-abandon]');
      const g = app.room && app.room.game;
      if (!b || b.disabled || !abandoning(g)) return;
      if (b.dataset.abandon === 'auto') { app.abandonSel = new Set(E.suggestAbandon(g, app.me)); render(); return; }
      send({ type: 'act', action: { type: 'abandon', cells: [...app.abandonSel] } });
    };
    $('#set-diameter').onchange = e => send({ type: 'settings', diameter: Number(e.target.value) });
    $('#actions').onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      // 生産はログに出ないので、効果音はここで鳴らす（自分にだけ聞こえる）
      if (b.dataset.act === 'produce') window.HexSound.play('produce');
      send({ type: 'act', action: { type: b.dataset.act } });
    };
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
      send({ type: 'act', action: { type, q, r } });
      // 拡張・強化のあとは同じマスを選んだまま（続けて強化できるように）。破壊は攻防の画面へ
      if (type === 'destroy') hideTip();
    };
    $('#clash').onclick = e => {
      if (e.target.closest('[data-cancel-destroy]')) { send({ type: 'act', action: { type: 'cancelDestroy' } }); return; }
      const b = e.target.closest('[data-bid-ok]');
      if (!b || b.disabled || !app.bid) return;
      window.HexSound.play('bid');
      send({ type: 'act', action: { type: 'bid', count: app.bid.n } });
    };
    // スライダーで出す数を選ぶ（画面は数字だけ書き換える）
    $('#clash').addEventListener('input', e => {
      if (!e.target.matches('[data-bid-range]') || !app.bid) return;
      app.bid.n = Number(e.target.value);
      $('#clash [data-bid-n]').textContent = app.bid.n;
      $('#clash [data-bid-label]').textContent = app.bid.n;
    });
    setInterval(tickTimers, 250);
    $('#players').onclick = e => {
      const b = e.target.closest('[data-forfeit]');
      if (b && confirm('この人を脱落させますか？（セルはすべて空きマスに戻ります）')) send({ type: 'forfeit', target: b.dataset.forfeit });
    };
    $('#result').onclick = e => {
      if (e.target.id === 'btn-lobby') { app.resultHidden = false; send({ type: 'lobby' }); }
      if (e.target.id === 'btn-hide-result') { app.resultHidden = true; $('#result').hidden = true; toast('もう一度結果を見るには「結果」を押してください', 'info'); renderResultButton(); }
    };
    $('#btn-fit').onclick = () => { boardView().reset(); hideTip(); };
    const setFocus = on => {
      settings.focus = on;
      store.set('focus', on ? '1' : '0');
      $('#btn-focus').classList.toggle('on', on);
      $('#btn-focus').setAttribute('aria-pressed', on ? 'true' : 'false');
    };
    setFocus(settings.focus);
    $('#btn-focus').onclick = () => { setFocus(!settings.focus); toast(settings.focus ? 'フォーカス：ほかの人の行動があったマスに視点を動かします' : 'フォーカスをやめました', 'info'); };
    $('#set-focus').onchange = e => setFocus(e.target.checked);
    $('#set-actions').onchange = e => send({ type: 'settings', actions: Number(e.target.value) });
    $('#set-rounds').onchange = e => send({ type: 'settings', rounds: Number(e.target.value) });
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
      // Ctrl+Z（Mac は ⌘+Z）で取り消し。チャットなどの入力中は除く
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.target.closest('input, textarea')) {
        const g = app.room && app.room.game;
        if (g && !E.actionBlocked(g, app.me, 'undo')) { e.preventDefault(); send({ type: 'act', action: { type: 'undo' } }); }
      }
    });

    document.querySelectorAll('[data-open]').forEach(b => {
      b.addEventListener('click', () => {
        const d = $('#' + b.dataset.open);
        if (d.id === 'settings') renderSettings();
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
