/*
 * ハロウィンお菓子ゲーム — 画面
 * 画面はサーバー（またはCPU対戦ではブラウザ内のルーム）から届く
 * 「自分に見えてよい情報」だけで描く。
 */
(function () {
  'use strict';

  const C = window.HalloweenConfig;
  const R = C.RULES;
  const $ = sel => document.querySelector(sel);

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

  const store = {
    get(k) { try { return localStorage.getItem('halloween.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('halloween.' + k, v); } catch (e) { /* 無視 */ } },
  };

  function token() {
    let t = store.get('token');
    if (!t) {
      t = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
      store.set('token', t);
    }
    return t;
  }

  const params = new URLSearchParams(location.search);
  const SERVER = params.get('server') || window.HALLOWEEN_SERVER || '';

  // サーバーなし（GitHub Pages など）のときの P2P 通信の設定
  const P2P = Object.assign({
    peerjsSrc: 'https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.4/peerjs.min.js',
    peerOptions: {},            // 自前の PeerServer を使うときは { host, port, path, secure }
    idPrefix: 'halloween-candy-v1-',
    codeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    codeLength: 5,
    joinTimeoutMs: 15000,
    pingMs: 3000,               // 生存確認の間隔
    dropMs: 20000,              // これだけ音沙汰がなければ切断とみなす
    maxRetry: 15,               // 参加者が再接続を試す回数
  }, window.HALLOWEEN_P2P || {}); // テスト用の上書き（URLからは変えられない）

  // サーバー（server.js）があればそれを使い、なければ P2P。?mode=p2p で P2P を強制
  const modeReady = (async () => {
    if (params.get('mode') === 'p2p') return 'p2p';
    if (SERVER) return 'server';
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return 'p2p';
    try {
      const res = await fetch('health', { cache: 'no-store' });
      if (res.ok && (await res.text()).trim() === 'ok') return 'server';
    } catch (e) { /* サーバーなし */ }
    return 'p2p';
  })();

  const PHASE_NAMES = { lobby: 'ロビー', talk: '作戦タイム', choose: '家を選ぶ', result: '結果', final: '最終結果' };
  const TONES = ['info', 'arrive', 'collision', 'witch', 'steal', 'mission', 'good', 'declare'];

  const app = {
    conn: null,
    online: false,
    code: '',
    me: null,
    state: null,
    chat: [],
    offset: 0,
    selected: null,
    selectedKey: '',
    tab: 'game',
    unread: 0,
    animKey: '',
    reconnecting: false,
    rulesOpen: false,
  };

  // ---------- 通信 ----------

  class WsTransport {
    constructor(first) {
      this.first = first;
      this.closedByUser = false;
      this.welcomed = false;
      this.retry = 0;
      this.connect();
    }
    url() {
      if (SERVER) return SERVER.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
      return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
    }
    connect() {
      let ws;
      try { ws = new WebSocket(this.url()); } catch (e) { return this.failed(); }
      this.ws = ws;
      ws.onopen = () => { this.retry = 0; ws.send(JSON.stringify(this.first)); };
      ws.onmessage = e => {
        let msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (msg.type === 'welcome') {
          this.welcomed = true;
          // 再接続のときは同じ部屋・同じ識別子で入り直す
          this.first = { type: 'join', code: msg.code, token: this.first.token, name: this.first.name, icon: this.first.icon };
          setReconnecting(false);
        }
        onMessage(msg);
      };
      ws.onclose = () => {
        if (this.closedByUser || this.ws !== ws) return;
        if (!this.welcomed) return this.failed();
        setReconnecting(true);
        this.retry++;
        setTimeout(() => { if (!this.closedByUser) this.connect(); }, Math.min(5000, 800 * this.retry));
      };
    }
    failed() {
      if (this.closedByUser) return;
      if (this.welcomed && this.retry < 30) {
        this.retry++;
        setTimeout(() => this.connect(), 3000);
        return;
      }
      leaveRoom('サーバーにつながりませんでした');
    }
    send(msg) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
    }
    close() {
      this.closedByUser = true;
      if (this.ws) this.ws.close();
    }
  }

  // ---------- P2P（サーバーなし）：ルームを作った人のブラウザがサーバーの代わりをする ----------

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
    if (t === 'peer-unavailable') return 'ルームが見つかりません。コードを確認してください';
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

  class PeerHostTransport {
    constructor(name, icon) {
      this.isHost = true;
      this.conns = new Map();   // conn → { id, lastSeen }
      this.closed = false;
      this.queue = [];
      this.start(name, icon).catch(err => { if (!this.closed) leaveRoom(p2pError(err)); });
    }
    async start(name, icon) {
      await loadPeerJS();
      let code = '';
      for (let attempt = 0; !this.peer; attempt++) {
        code = Array.from({ length: P2P.codeLength }, () => P2P.codeChars[Math.floor(Math.random() * P2P.codeChars.length)]).join('');
        try {
          this.peer = await openPeer(P2P.idPrefix + code);
        } catch (err) {
          if (err.type !== 'unavailable-id' || attempt >= 4) throw err; // コードが使用中なら作り直す
        }
      }
      if (this.closed) { this.peer.destroy(); return; }
      this.peer.on('connection', conn => this.onConnection(conn));
      this.peer.on('disconnected', () => { if (!this.closed && !this.peer.destroyed) this.peer.reconnect(); });
      this.peer.on('error', () => { /* 参加者側の一時的なエラーは無視 */ });
      const clone = m => JSON.parse(JSON.stringify(m));
      this.room = new window.HalloweenRoom.Room({ code, send: (pid, msg) => this.deliver(pid, clone(msg)) });
      this.token = token();
      this.id = this.room.join(this.token, name, icon).id;
      this.room.attach(this.id);
      this.timer = setInterval(() => this.tick(), P2P.pingMs);
      this.queue.forEach(m => this.send(m));
      this.queue = [];
    }
    deliver(pid, msg) {
      if (pid === this.id) { setTimeout(() => onMessage(msg), 0); return; }
      for (const [conn, info] of this.conns) {
        if (info.id !== pid) continue;
        safeSend(conn, msg);
        if (msg.type === 'kicked') setTimeout(() => conn.close(), 300);
      }
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
        const r = this.room.join(tok, msg.name, msg.icon);
        if (r.error) return reject(r.error);
        // 同じ人の古い接続は閉じる
        for (const [c, i] of this.conns) if (i.id === r.id) { this.conns.delete(c); c.close(); }
        this.conns.set(conn, { id: r.id, lastSeen: Date.now() });
        this.room.attach(r.id);
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
      for (const conn of this.conns.keys()) safeSend(conn, { type: 'error', text: 'ホストがルームを閉じました', fatal: true });
      if (this.room) this.room.close();
      const peer = this.peer;
      setTimeout(() => { try { if (peer) peer.destroy(); } catch (e) { /* 無視 */ } }, 300);
    }
  }

  class PeerGuestTransport {
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
          else if (++this.unavailable >= 4) leaveRoom('ホストがいなくなったため、ルームが終わりました');
          else if (this.conn) this.lost(this.conn);
        }
      });
      peer.on('disconnected', () => { if (!this.closed && !peer.destroyed) peer.reconnect(); });
      this.timer = setInterval(() => this.tick(), P2P.pingMs);
      this.connect();
    }
    connect() {
      const conn = this.peer.connect(P2P.idPrefix + this.first.code, { reliable: true, serialization: 'json' });
      this.conn = conn;
      setTimeout(() => { if (this.conn === conn && !conn.open) this.lost(conn); }, P2P.joinTimeoutMs);
      conn.on('open', () => { this.lastSeen = Date.now(); safeSend(conn, this.first); });
      conn.on('data', msg => {
        if (this.conn !== conn || !msg) return;
        this.lastSeen = Date.now();
        if (msg.type === 'pong') return;
        if (msg.type === 'welcome') { this.welcomed = true; this.retry = 0; this.unavailable = 0; setReconnecting(false); }
        onMessage(msg);
      });
      conn.on('close', () => this.lost(conn));
      conn.on('error', () => {});
    }
    lost(conn) {
      if (this.closed || this.conn !== conn) return;
      this.conn = null;
      try { conn.close(); } catch (e) { /* 無視 */ }
      if (!this.welcomed) { leaveRoom('ルームにつながりませんでした。コードを確認してください'); return; }
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

  // CPU対戦：ブラウザの中でルームを動かす（通信なし）
  class LocalTransport {
    constructor(name, icon) {
      const clone = m => JSON.parse(JSON.stringify(m));
      this.room = new window.HalloweenRoom.Room({
        code: '', offline: true,
        send: (pid, msg) => { const m = clone(msg); setTimeout(() => onMessage(m), 0); },
      });
      const r = this.room.join('local', name, icon);
      this.id = r.id;
      for (let i = 0; i < R.offlineCpuCount; i++) this.room.addCpu();
      this.room.attach(this.id);
    }
    send(msg) { setTimeout(() => this.room.handle(this.id, msg), 0); }
    close() { this.room.close(); }
  }

  function send(msg) { if (app.conn) app.conn.send(msg); }

  function onMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        app.me = msg.id;
        app.code = msg.code;
        showRoom();
        // P2Pのホストは開き直すとルームが消えるので、URLにコードを残さない
        if (!msg.offline && !(app.conn && app.conn.isHost)) {
          const u = new URL(location.href);
          u.searchParams.set('room', msg.code);
          history.replaceState(null, '', u);
        }
        break;
      case 'chatlog':
        app.chat = msg.list;
        renderChat(true);
        break;
      case 'chat':
        app.chat.push(msg.msg);
        if (app.chat.length > R.chatLog) app.chat.shift();
        appendChat(msg.msg);
        if (app.tab !== 'chat' && isNarrow()) { app.unread++; renderUnread(); }
        break;
      case 'state':
        app.state = msg.state;
        app.offset = msg.state.serverNow - Date.now();
        render();
        break;
      case 'error':
        toast(msg.text);
        if (msg.fatal) leaveRoom();
        break;
      case 'kicked':
        leaveRoom('ルームからキックされました');
        break;
    }
  }

  // ---------- 画面の切り替え ----------

  function savedName() { return store.get('name') || ''; }
  function nameInput() { return $('#in-name').value.trim() || 'ゲスト'; }

  async function startOnline(type, code) {
    const name = nameInput();
    store.set('name', name);
    const mode = await modeReady;
    closeConn();
    app.online = true;
    const icon = store.get('icon') || '';
    if (mode === 'server') app.conn = new WsTransport({ type, code, token: token(), name, icon });
    else if (type === 'create') app.conn = new PeerHostTransport(name, icon);
    else app.conn = new PeerGuestTransport({ type: 'join', code, token: token(), name, icon });
  }

  function startOffline() {
    const name = nameInput();
    store.set('name', name);
    closeConn();
    app.online = false;
    app.conn = new LocalTransport(name, store.get('icon') || '');
  }

  function closeConn() {
    if (app.conn) app.conn.close();
    app.conn = null;
  }

  function leaveRoom(message) {
    closeConn();
    Object.assign(app, { code: '', me: null, state: null, chat: [], selected: null, unread: 0, animKey: '' });
    setReconnecting(false);
    const u = new URL(location.href);
    u.searchParams.delete('room');
    history.replaceState(null, '', u);
    $('#room').hidden = true;
    $('#top').hidden = false;
    $('#chat-log').innerHTML = '';
    if (message) toast(message);
  }

  function showRoom() {
    $('#top').hidden = true;
    $('#room').hidden = false;
  }

  function setReconnecting(on) {
    app.reconnecting = on;
    $('#banner').hidden = !on;
  }

  function isNarrow() { return window.matchMedia('(max-width: 899px)').matches; }

  function setTab(tab) {
    app.tab = tab;
    $('#room').dataset.tab = tab;
    document.querySelectorAll('#tabs button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    if (tab === 'chat') { app.unread = 0; renderUnread(); scrollChat(); }
  }

  function renderUnread() {
    const el = $('#unread');
    el.hidden = !app.unread;
    el.textContent = app.unread > 99 ? '99+' : String(app.unread);
  }

  let toastTimer = 0;
  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---------- 共通の部品 ----------

  const now = () => Date.now() + app.offset;
  const remain = deadline => Math.max(0, Math.ceil((deadline - now()) / 1000));
  const player = id => (app.state ? app.state.players.find(p => p.id === id) : null);
  const isHost = () => app.state && app.state.hostId === app.me;

  function stateLabel(state) {
    const s = C.STATES[state];
    return s ? `${s.emoji}${s.name}` : '';
  }

  function missionHtml(id, withText) {
    const m = C.missionById(id);
    if (!m) return '<span class="muted">なし</span>';
    return `<span class="mission-name">${m.emoji}${esc(m.name)}</span>` +
      (withText ? `<span class="mission-text">${esc(m.text)}（+${m.bonus}🍬）</span>` : '');
  }

  function playerTag(p) {
    if (!p) return '';
    return `<span class="ptag">${esc(p.icon)}${esc(p.name)}</span>`;
  }

  function fmtSigned(n) { return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0'; }

  function rulesHtml(settings) {
    const box = document.createElement('div');
    box.innerHTML = $('#rules-template').innerHTML;
    box.querySelectorAll('[data-s]').forEach(el => { el.textContent = settings[el.dataset.s]; });
    return box.innerHTML;
  }

  // ---------- 描画 ----------

  function render() {
    const s = app.state;
    if (!s) return;
    const view = $('#view');
    // 入力中の欄は描き直しても値とカーソルを残す
    const active = document.activeElement;
    let keep = null;
    if (active && view.contains(active) && active.id) {
      keep = { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd };
    }
    if (s.phase === 'lobby') view.innerHTML = renderLobby(s);
    else if (s.phase === 'final') view.innerHTML = renderFinal(s);
    else view.innerHTML = renderGame(s);
    view.dataset.phase = s.phase;
    if (keep) {
      const el = document.getElementById(keep.id);
      if (el) {
        if (el.type === 'text' || el.type === 'number') el.value = keep.value;
        el.focus();
        try { if (keep.start !== null) el.setSelectionRange(keep.start, keep.end); } catch (e) { /* 数値欄など */ }
      }
    }
    if (s.phase === 'result') animateResult(s);
    tick();
  }

  // ---------- ロビー ----------

  function renderLobby(s) {
    const host = isHost();
    const me = player(app.me);
    const used = new Set(s.players.filter(p => p.id !== app.me).map(p => p.icon));
    const invite = (() => {
      const u = new URL(location.href);
      u.search = '';
      u.searchParams.set('room', s.code);
      if (SERVER) u.searchParams.set('server', SERVER);
      if (params.get('mode')) u.searchParams.set('mode', params.get('mode'));
      return u.toString();
    })();

    const head = s.offline
      ? `<div class="room-code"><span class="big-emoji">🤖</span> CPU対戦<button class="small" data-act="leave">🚪 トップへ</button></div>`
      : `<div class="room-code">
          <div>ルームコード <b class="code">${esc(s.code)}</b> <button class="small" data-copy="${esc(s.code)}">📋 コピー</button></div>
          <div class="invite"><span class="url">${esc(invite)}</span> <button class="small" data-copy="${esc(invite)}">📋 招待URLをコピー</button></div>
          <button class="small" data-act="leave">🚪 退出</button>
          ${app.conn && app.conn.isHost ? '<p class="host-warn">⚠️ このルームはあなたのブラウザで動いています。ゲームが終わるまで、このページを閉じたり再読み込みしたりしないでください（スマホならスリープや別アプリへの切り替えにも注意）。</p>' : ''}
        </div>`;

    const rows = s.players.map(p => `
      <li class="lobby-player ${p.connected ? '' : 'off'}">
        <span class="picon">${esc(p.icon)}</span>
        <span class="pname">${esc(p.name)}</span>
        ${p.id === s.hostId ? '<span class="badge-tag">ホスト</span>' : ''}
        ${p.cpu ? '<span class="badge-tag cpu">🤖 CPU</span>' : ''}
        ${p.id === app.me ? '<span class="badge-tag you">あなた</span>' : ''}
        ${p.connected ? '' : '<span title="切断中">🔌</span>'}
        ${host && p.id !== app.me ? `<button class="small danger" data-act="${p.cpu ? 'removeCpu' : 'kick'}" data-id="${p.id}">${p.cpu ? '外す' : 'キック'}</button>` : ''}
      </li>`).join('');

    const canAdd = host && s.players.length < R.maxPlayers;
    const icons = C.ICONS.map(i => `<button class="icon-pick" data-icon="${esc(i)}" aria-pressed="${me && me.icon === i}" ${used.has(i) ? 'disabled' : ''}>${esc(i)}</button>`).join('');

    return `
      <div class="lobby">
        ${head}
        <section class="box">
          <h2>👥 参加者 ${s.players.length}/${R.maxPlayers}</h2>
          <ul class="lobby-players">${rows}</ul>
          ${canAdd ? '<button data-act="addCpu">🤖 CPUを追加</button>' : ''}
        </section>
        <section class="box">
          <h2>🙂 あなた</h2>
          <div class="row">
            <input id="lobby-name" type="text" maxlength="24" value="${esc(me ? me.name : '')}">
            <button data-act="rename">名前を変更</button>
          </div>
          <div class="icon-grid">${icons}</div>
        </section>
        ${renderSettings(s, host)}
        <details class="rules box" id="rules-lobby" ${app.rulesOpen ? 'open' : ''}>${rulesHtml(s.settings)}</details>
        <div class="start-bar">
          ${host
            ? `<button class="primary big" data-act="start" ${s.players.length < R.minPlayers ? 'disabled' : ''}>🎃 ゲーム開始</button>
               ${s.players.length < R.minPlayers ? `<p class="note">${R.minPlayers}人以上で開始できます（CPUを追加できます）</p>` : ''}`
            : '<p class="note">ホストがゲームを開始するのを待っています…</p>'}
        </div>
      </div>`;
  }

  function renderSettings(s, host) {
    const st = s.settings;
    const L = C.SETTING_LIMITS;
    const dis = host ? '' : 'disabled';
    const num = (key, label, unit, extra) => `
      <label class="set">
        <span>${label}</span>
        <span class="set-input"><input id="set-${key}" type="number" data-set="${key}" min="${L[key].min}" max="${L[key].max}" value="${st[key]}" ${dis}>${unit || ''}</span>
        ${extra || ''}
      </label>`;
    const chk = (key, label) => `
      <label class="set check"><input id="set-${key}" type="checkbox" data-set="${key}" ${st[key] ? 'checked' : ''} ${dis}><span>${label}</span></label>`;
    const rec = C.recommendedHouses(s.players.length);
    return `
      <section class="box settings">
        <h2>⚙️ 設定 ${host ? '' : '<span class="muted small-text">（ホストのみ変更できます）</span>'}</h2>
        <div class="set-grid">
          ${num('houses', '🏠 1集落の家の数', '軒', `<small class="hint-rec">目安：${rec}軒（${s.players.length}人×3/4）</small>`)}
          ${num('rounds', '🎃 集落の数', '')}
          ${num('talkTime', '💬 作戦タイム', '秒')}
          ${num('chooseTime', '⏳ 家を選ぶ時間', '秒')}
          <label class="set wide">
            <span>🍬 家のお菓子の袋（カンマ区切り）</span>
            <input id="set-candyBag" type="text" data-set="candyBag" value="${esc(st.candyBag.join(','))}" ${dis}>
          </label>
          ${num('probRich', '💰 お金持ちの確率', '%')}
          ${num('probAway', '💤 留守の確率', '%')}
          ${num('probWitch', '🧙‍♀️ 魔女の確率', '%')}
          <div class="set"><span>🍬 普通の確率</span><span class="set-value">${100 - st.probRich - st.probAway - st.probWitch}%</span></div>
          ${num('richBonus', '💰 お金持ちの加算', '')}
          ${num('witchPenalty', '🧙‍♀️ 魔女の減算', '')}
          ${num('stealMax', '🤚 先頭から奪う最大数', '', '<small class="hint-rec">0で奪取なし</small>')}
          ${chk('missions', '📜 ミッションあり')}
          ${chk('hints', '🔍 秘密のヒントあり')}
        </div>
        ${host ? '<button class="small" data-act="resetSettings">↩️ 既定値に戻す</button>' : ''}
      </section>`;
  }

  // ---------- ゲーム ----------

  function renderGame(s) {
    const me = player(app.me);
    const roundKey = `${s.round}`;
    if (app.selectedKey !== roundKey) { app.selected = null; app.selectedKey = roundKey; }
    const myChoice = s.me ? s.me.choice : null;
    const res = s.result;
    const n = s.players.length;

    // 上部
    let action = '';
    if (s.phase === 'talk') {
      action = `<button class="${me && me.ready ? 'on' : ''}" data-act="skip">⏭ スキップ ${s.skip.count}/${s.skip.need}</button>`;
    } else if (s.phase === 'choose') {
      action = `<span class="chip">✅ 確定 ${s.players.filter(p => p.ready).length}/${n}</span>`;
    } else if (s.phase === 'result') {
      const active = s.players.filter(p => !p.cpu && p.connected);
      action = `<button id="btn-next" class="primary ${me && me.ready ? 'on' : ''}" data-act="next" disabled>▶ 次へ ${active.filter(p => p.ready).length}/${active.length}</button>`;
    }
    const header = `
      <header class="game-head">
        <span class="chip round">🎃 ${s.round}/${s.settings.rounds}</span>
        <span class="phase phase-${s.phase}">${PHASE_NAMES[s.phase]}</span>
        <span class="chip timer" data-deadline="${s.deadline}">⏳ ${remain(s.deadline)}</span>
        <span class="head-action">${action}</span>
      </header>`;

    // 家
    const declaresOn = i => s.players.filter(p => p.declare === i);
    const houses = s.houses.map((h, i) => {
      const visitors = res ? res.visitors[i] : [];
      const collided = res && res.collided[i];
      const selected = s.phase === 'choose' && myChoice === null && app.selected === i;
      const mine = myChoice === i;
      const hinted = s.me && s.me.hint && s.me.hint.house === i;
      const decl = declaresOn(i);
      const revealed = h.state;
      const cls = ['house'];
      if (selected) cls.push('selected');
      if (mine) cls.push('mine');
      if (collided) cls.push('collided');
      if (revealed) cls.push('revealed', 'st-' + revealed);
      if (s.phase === 'choose' && myChoice === null) cls.push('pickable');
      const back = revealed ? `<span class="state-emoji">${C.STATES[revealed].emoji}</span><span class="state-name">${C.STATES[revealed].name}</span>` : '';
      return `
        <button class="${cls.join(' ')}" data-house="${i}" ${s.phase === 'choose' && myChoice === null ? '' : 'tabindex="-1"'}>
          <span class="house-no">${i + 1}番${hinted ? ' <span title="ヒント">🔍</span>' : ''}</span>
          <span class="flip"><span class="flip-inner">
            <span class="face front">🏠</span>
            <span class="face back">${back}</span>
          </span></span>
          <span class="amount">🍬×${h.amount}</span>
          ${s.phase === 'talk' || s.phase === 'choose'
            ? `<span class="declarers">${decl.length ? '📣' + decl.map(p => `<span title="${esc(p.name)}">${esc(p.icon)}</span>`).join('') : ''}</span>`
            : `<span class="visitors">${collided ? '💥' : ''}${visitors.map(id => { const p = player(id); return p ? `<span title="${esc(p.name)}">${esc(p.icon)}</span>` : ''; }).join('')}</span>`}
          ${mine ? '<span class="mine-tag">あなた</span>' : ''}
        </button>`;
    }).join('');

    // 自分のパネル
    let hintText = '<span class="muted">ヒントなし</span>';
    if (s.me && s.me.hint) hintText = `${s.me.hint.house + 1}番の家は <b>${stateLabel(s.me.hint.state)}</b>`;
    const missionRow = s.settings.missions
      ? `<div class="mypanel-row"><span class="label">📜 ミッション</span><span>${missionHtml(s.me && s.me.mission, true)}</span></div>`
      : '';
    let declareRow = '';
    if (s.phase === 'talk' || s.phase === 'choose') {
      const cur = me ? me.declare : null;
      declareRow = `
        <div class="mypanel-row declare-row">
          <span class="label">📣 宣言</span>
          <span class="declare-buttons">
            ${s.houses.map((_, i) => `<button class="small decl" data-declare="${i}" aria-pressed="${cur === i}">${i + 1}</button>`).join('')}
            <button class="small decl" data-declare="none" ${cur === null ? 'disabled' : ''}>取消</button>
          </span>
        </div>`;
    }
    let choiceRow = '';
    if (s.phase === 'talk') {
      choiceRow = '<p class="note">💬 作戦タイム：話し合いや宣言をしよう。時間になったら家を選びます。</p>';
    } else if (s.phase === 'choose') {
      choiceRow = myChoice !== null
        ? `<p class="confirmed-note">✅ ${myChoice + 1}番の家に確定しました。ほかの人を待っています…</p>`
        : `<div class="confirm-bar">
            <span>${app.selected !== null ? `🏠 <b>${app.selected + 1}番</b>を選択中` : '👆 行く家をタップ'}</span>
            <button class="primary" data-act="confirm" ${app.selected === null ? 'disabled' : ''}>✅ この家に決定</button>
          </div>`;
    } else if (s.phase === 'result' && res) {
      const d = res.deltas[app.me];
      if (d) choiceRow = `<p class="result-note">${d.timedOut ? '⏳ 時間切れで' : ''}${d.choice + 1}番の家へ → ${d.house || d.steal || d.missionBonus ? deltaChips(d) + ' ＝ ' : ''}<b>${fmtSigned(d.total)}🍬</b></p>`;
    }
    const mypanel = `
      <section class="mypanel box">
        <div class="mypanel-row"><span class="label">🔍 ヒント</span><span>${hintText}</span></div>
        ${missionRow}
        ${declareRow}
        ${choiceRow}
      </section>`;

    return `
      <div class="game">
        ${header}
        <section class="houses" style="--cols:${Math.min(s.houses.length, s.houses.length <= 4 ? s.houses.length : s.houses.length <= 6 ? 3 : 4)}">${houses}</section>
        ${mypanel}
        ${renderPlayers(s)}
      </div>`;
  }

  function deltaChips(d) {
    if (!d) return '';
    const out = [];
    if (d.house > 0) out.push(`<span class="d good">+${d.house}🍬</span>`);
    else if (d.house < 0) out.push(`<span class="d bad">${fmtSigned(d.house)}🧙‍♀️</span>`);
    if (d.steal > 0) out.push(`<span class="d good">🤚+${d.steal}</span>`);
    else if (d.steal < 0) out.push(`<span class="d bad">🤚${fmtSigned(d.steal)}</span>`);
    if (d.missionBonus) out.push(`<span class="d mission">📜+${d.missionBonus}</span>`);
    if (!out.length) out.push('<span class="d zero">±0</span>');
    return out.join('');
  }

  function renderPlayers(s) {
    const res = s.result;
    const rows = s.players.map(p => {
      const d = res ? res.deltas[p.id] : null;
      let status = '';
      if (s.phase === 'talk') status = p.ready ? '<span class="st">⏭</span>' : '';
      else if (s.phase === 'choose') status = p.ready ? '<span class="st ok">✅選択済み</span>' : '<span class="st wait">🤔</span>';
      else if (s.phase === 'result') status = p.ready ? '<span class="st">▶</span>' : '';
      return `
        <li class="pl ${p.id === app.me ? 'me' : ''} ${p.connected ? '' : 'off'}">
          <span class="picon">${esc(p.icon)}</span>
          <span class="pname">${esc(p.name)}${p.cpu ? ' <small>🤖</small>' : ''}${p.leader ? ' 👑' : ''}${p.connected ? '' : ' 🔌'}</span>
          <span class="pcandy">🍬${p.candy}</span>
          <span class="pdelta">${d ? `<span class="pop">${deltaChips(d)}</span>` : ''}</span>
          <span class="pstatus">${status}${(s.phase === 'talk' || s.phase === 'choose') && p.declare !== null ? `<span class="st decl-st">📣${p.declare + 1}</span>` : ''}</span>
        </li>`;
    }).join('');
    return `<section class="box players"><h2>👥 プレイヤー</h2><ul class="plist">${rows}</ul></section>`;
  }

  // 結果は最初の1回だけめくる・弾ませる
  function animateResult(s) {
    const key = `${s.round}`;
    const view = $('#view');
    if (app.animKey === key) {
      view.querySelectorAll('.house.revealed').forEach(el => el.classList.add('flipped', 'no-anim'));
      view.querySelectorAll('.pop').forEach(el => el.classList.add('no-anim'));
      return;
    }
    app.animKey = key;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      view.querySelectorAll('.house.revealed').forEach((el, i) => {
        setTimeout(() => el.classList.add('flipped'), 150 * i);
      });
      view.querySelectorAll('.pop').forEach(el => el.classList.add('popping'));
    }));
  }

  // ---------- 最終結果 ----------

  function renderFinal(s) {
    const medals = ['🥇', '🥈', '🥉'];
    const winners = s.final.ranking.filter(r => r.rank === 1);
    const rows = s.final.ranking.map(r => {
      const p = player(r.id);
      const achieved = r.achieved.length
        ? r.achieved.map(a => { const m = C.missionById(a.mission); return `<span class="ach">✅${m.emoji}${esc(m.name)}<small>（${a.round}集落目）</small></span>`; }).join('')
        : '<span class="muted">達成なし</span>';
      return `
        <li class="final-row rank-${r.rank} ${r.id === app.me ? 'me' : ''}">
          <span class="rank">${medals[r.rank - 1] || r.rank + '位'}</span>
          <span class="picon">${esc(p ? p.icon : '')}</span>
          <span class="pname">${esc(p ? p.name : '')}${p && p.cpu ? ' <small>🤖</small>' : ''}</span>
          <span class="fcandy">🍬${r.candy}</span>
          <span class="breakdown">🏠家 ${fmtSigned(r.stats.house)} ／ 🤚奪取 ${fmtSigned(r.stats.steal)} ／ 📜ミッション ${fmtSigned(r.stats.mission)}</span>
          ${s.settings.missions ? `<span class="missions">${achieved}<span class="held">📜所持：${missionHtml(r.mission, false)}</span></span>` : ''}
        </li>`;
    }).join('');
    return `
      <div class="final">
        <h1>🏆 ${winners.length > 1 ? '共同優勝' : '優勝'}</h1>
        <p class="winners">${winners.map(w => playerTag(player(w.id))).join('')}</p>
        <ol class="final-list">${rows}</ol>
        <div class="start-bar">
          <button class="primary big" data-act="playAgain">🔁 もう一度遊ぶ（ロビーへ）</button>
          <button data-act="leave">🚪 ${s.offline ? 'トップへ' : '退出'}</button>
        </div>
      </div>`;
  }

  // ---------- チャット ----------

  function chatItem(m) {
    const t = new Date(m.ts);
    const time = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    if (m.kind === 'sys') {
      const tone = TONES.indexOf(m.tone) >= 0 ? m.tone : 'info';
      return `<li class="msg sys tone-${tone}"><span class="time">${time}</span><span class="text">${esc(m.text)}</span></li>`;
    }
    return `<li class="msg ${m.kind === 'stamp' ? 'stamp' : 'user'} ${m.pid === app.me ? 'mine' : ''}">
      <span class="time">${time}</span><span class="who">${esc(m.icon)}${esc(m.name)}</span><span class="text">${esc(m.text)}</span></li>`;
  }

  function renderChat() {
    $('#chat-log').innerHTML = app.chat.map(chatItem).join('');
    scrollChat(true);
  }

  function appendChat(m) {
    const log = $('#chat-log');
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    log.insertAdjacentHTML('beforeend', chatItem(m));
    while (log.children.length > R.chatLog) log.firstElementChild.remove();
    if (atBottom || m.pid === app.me) scrollChat(true);
  }

  function scrollChat() {
    const log = $('#chat-log');
    log.scrollTop = log.scrollHeight;
  }

  // ---------- 時計 ----------

  function tick() {
    const s = app.state;
    if (!s) return;
    document.querySelectorAll('[data-deadline]').forEach(el => {
      const d = Number(el.dataset.deadline);
      if (!d) { el.hidden = true; return; }
      const r = remain(d);
      el.textContent = `⏳ ${r}`;
      el.classList.toggle('hurry', r <= 5);
    });
    const next = document.getElementById('btn-next');
    if (next) next.disabled = now() < s.phaseStart + s.resultMinTime * 1000 || (player(app.me) || {}).ready;
  }
  setInterval(tick, 250);

  // ---------- 操作 ----------

  function onClick(e) {
    const t = e.target.closest('button');
    if (!t || t.disabled) return;
    const s = app.state;

    if (t.dataset.copy !== undefined) {
      const text = t.dataset.copy;
      (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
        .then(() => toast('📋 コピーしました'), () => { window.prompt('コピーしてください', text); });
      return;
    }
    if (t.dataset.icon !== undefined) {
      store.set('icon', t.dataset.icon);
      send({ type: 'profile', icon: t.dataset.icon });
      return;
    }
    if (t.dataset.house !== undefined) {
      if (!s || s.phase !== 'choose' || !s.me || s.me.choice !== null) return;
      app.selected = Number(t.dataset.house);
      render();
      return;
    }
    if (t.dataset.declare !== undefined) {
      send({ type: 'declare', house: t.dataset.declare === 'none' ? null : Number(t.dataset.declare) });
      return;
    }
    if (t.dataset.tab) { setTab(t.dataset.tab); return; }

    switch (t.dataset.act) {
      case 'leave': leaveRoom(); break;
      case 'addCpu': send({ type: 'addCpu' }); break;
      case 'removeCpu': send({ type: 'removeCpu', id: t.dataset.id }); break;
      case 'kick': {
        const p = player(t.dataset.id);
        if (p && confirm(`${p.name} をキックしますか？`)) send({ type: 'kick', id: p.id });
        break;
      }
      case 'rename': {
        const v = $('#lobby-name').value.trim();
        if (v) { store.set('name', v); send({ type: 'profile', name: v }); }
        break;
      }
      case 'resetSettings': send({ type: 'resetSettings' }); break;
      case 'start': send({ type: 'start' }); break;
      case 'skip': send({ type: 'skip' }); break;
      case 'confirm':
        if (app.selected !== null) send({ type: 'confirm', house: app.selected });
        break;
      case 'next': send({ type: 'next' }); t.disabled = true; break;
      case 'playAgain': send({ type: 'playAgain' }); break;
    }
  }

  function onChange(e) {
    const el = e.target;
    if (!el.dataset || !el.dataset.set) return;
    const key = el.dataset.set;
    let value;
    if (el.type === 'checkbox') value = el.checked;
    else if (key === 'candyBag') {
      if (!C.parseBag(el.value)) { toast(`🍬 袋は0〜${R.bagMaxValue}の整数をカンマ区切りで（${R.bagMaxLength}個まで）`); render(); return; }
      value = el.value;
    } else value = Number(el.value);
    send({ type: 'settings', settings: { [key]: value } });
  }

  function init() {
    $('#rules-top').innerHTML = rulesHtml(C.DEFAULT_SETTINGS);
    $('#in-name').value = savedName();
    const code = (params.get('room') || '').toUpperCase();
    if (code) $('#in-code').value = code;
    modeReady.then(mode => {
      if (mode !== 'p2p') return;
      const note = $('#online-note');
      note.hidden = false;
      note.textContent = '🔗 サーバーなしモード：ルームを作った人のブラウザがゲームを進めます（ブラウザ同士で直接通信）。';
    });
    // P2Pのホストがページを閉じたら、参加者にすぐ知らせる
    window.addEventListener('pagehide', () => { if (app.conn && app.conn.isHost) app.conn.close(); });
    // P2Pのホストがページを閉じるとルームが終わるので確認する
    window.addEventListener('beforeunload', e => {
      if (app.conn && app.conn.isHost && app.state) { e.preventDefault(); e.returnValue = ''; }
    });

    $('#btn-create').addEventListener('click', () => startOnline('create'));
    $('#btn-join').addEventListener('click', () => {
      const c = $('#in-code').value.trim().toUpperCase();
      if (!c) { toast('ルームコードを入れてください'); return; }
      startOnline('join', c);
    });
    $('#in-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('#btn-join').click(); });
    $('#btn-cpu').addEventListener('click', startOffline);

    document.addEventListener('click', onClick);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', e => {
      if (e.key === 'Enter' && e.target.id === 'lobby-name') { e.preventDefault(); onClick({ target: document.querySelector('[data-act="rename"]') }); }
    });
    // ロビーのルール説明は描き直しても開いたままにする
    document.addEventListener('toggle', e => {
      if (e.target.id === 'rules-lobby') app.rulesOpen = e.target.open;
    }, true);

    $('#stamps').innerHTML = C.STAMPS.map(s => `<button class="stamp-btn" data-stamp="${esc(s)}">${esc(s)}</button>`).join('');
    $('#stamps').addEventListener('click', e => {
      const b = e.target.closest('[data-stamp]');
      if (b) send({ type: 'stamp', emoji: b.dataset.stamp });
    });
    $('#chat-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = $('#chat-in');
      const text = input.value.trim();
      if (!text) return;
      send({ type: 'chat', text });
      input.value = '';
    });
    setTab('game');

    // 招待URL・再読み込み：名前が保存されていればそのまま入る（同じ識別子なら同じプレイヤーとして復帰）
    if (code && savedName()) startOnline('join', code);
  }

  init();
})();
