/*
 * ヘキサゴニア（仮）— 画面と通信
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

  const COLOR_NAMES = { red: '赤', blue: '青', green: '緑', yellow: '黄' };
  const COLOR_SETS = {
    normal: {
      red: { base: '#E5534B', light: '#FF9C94' },
      blue: { base: '#4C8EDA', light: '#9CC6F2' },
      green: { base: '#3FAE74', light: '#8EDDB2' },
      yellow: { base: '#E39B00', light: '#FFD36B' },  // 半透明で薄くならないよう山吹色寄り
    },
    // Okabe-Ito 配色
    cb: {
      red: { base: '#D55E00', light: '#FFA466' },
      blue: { base: '#0072B2', light: '#56B4E9' },
      green: { base: '#009E73', light: '#5FD6B2' },
      yellow: { base: '#F0E442', light: '#FFF6A0' },
    },
  };
  const PATTERNS = { red: 'solid', blue: 'dashed', green: 'double', yellow: 'dotted' };
  const PATTERN_NAMES = { solid: '実線', dashed: '破線', double: '二重線', dotted: '点線' };

  const settings = { cb: store.get('cb') === '1', patterns: store.get('patterns') === '1' };

  function colorOf(c) {
    const set = COLOR_SETS[settings.cb ? 'cb' : 'normal'][c] || COLOR_SETS.normal.red;
    return Object.assign({ name: COLOR_NAMES[c], pattern: PATTERNS[c] }, set);
  }

  // 陣営色の小さな六角形（模様のオプションがオンなら縁の模様も）
  function swatch(c, cls) {
    const col = colorOf(c);
    const pat = settings.patterns ? col.pattern : 'solid';
    const hex = 'M12 2 L20.7 7 L20.7 17 L12 22 L3.3 17 L3.3 7 Z';
    const dash = pat === 'dashed' ? ' stroke-dasharray="4 2.5"' : pat === 'dotted' ? ' stroke-dasharray="0.1 3" stroke-linecap="round"' : '';
    const stroke = pat === 'double'
      ? `<path d="${hex}" fill="none" stroke="${col.light}" stroke-width="1.3"/><path d="M12 5.6 L17.6 8.8 L17.6 15.2 L12 18.4 L6.4 15.2 L6.4 8.8 Z" fill="none" stroke="${col.light}" stroke-width="1.3"/>`
      : `<path d="${hex}" fill="none" stroke="${col.light}" stroke-width="2"${dash}/>`;
    return `<svg viewBox="0 0 24 24" class="swatch ${cls || ''}" role="img" aria-label="${col.name}"><title>${col.name}</title><path d="${hex}" fill="${col.base}" fill-opacity=".55"/>${stroke}</svg>`;
  }

  // ---------- トークンの絵（すべて半透明・平面的・形がすべて違う） ----------

  const TOKEN_SVG = {
    // 資源：オレンジの六角形
    resource: `<svg viewBox="0 0 24 24" class="tk"><path d="M12 2.5 L20.2 7.25 L20.2 16.75 L12 21.5 L3.8 16.75 L3.8 7.25 Z" fill="rgba(255,150,40,.5)" stroke="#FFB868" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
    // 攻撃：赤の六芒星
    attack: `<svg viewBox="0 0 24 24" class="tk"><path d="M12 2 L14.89 7 L20.66 7 L17.77 12 L20.66 17 L14.89 17 L12 22 L9.11 17 L3.34 17 L6.23 12 L3.34 7 L9.11 7 Z" fill="rgba(255,105,130,.5)" stroke="#FFA8B8" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
    // 防御：青の正方形
    defense: `<svg viewBox="0 0 24 24" class="tk"><rect x="4.5" y="4.5" width="15" height="15" rx="1.2" fill="rgba(100,175,255,.5)" stroke="#A8D6FF" stroke-width="1.6"/></svg>`,
  };
  const TOKEN_NAMES = { resource: '資源', attack: '攻撃', defense: '防御' };
  const tokenChip = (kind, n, label) =>
    `<span class="tchip tk-${kind}" title="${TOKEN_NAMES[kind]}トークン">${TOKEN_SVG[kind]}<b>${n}</b>${label ? `<small>${TOKEN_NAMES[kind]}</small>` : ''}</span>`;

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
    wasMyTurn: false,
    prevCells: null,    // 前回の盤面（変化したマスを光らせるため）
    clashResult: null,  // 公開された攻防の結果を少しのあいだ見せる { ...lastClash, until }
    bid: null,          // 攻防で出す数の入力中の値 { key, n }
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
      `<li>${swatch(p.color)}<span class="pname">${esc(p.name)}</span>${p.cpu ? '<span class="badge cpu">CPU</span>' : ''}${p.id === room.hostId && !local ? '<span class="badge">ホスト</span>' : ''}${p.id === app.me ? '<span class="badge me">あなた</span>' : ''}${isHost && p.cpu ? `<button class="small remove" data-remove-cpu="${p.id}" title="このCPUを外す">外す</button>` : ''}</li>`).join('');
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
    $('#diameter-note').textContent = dia ? `${diameterCells(dia)}マス` : autoDia ? `いまの人数では直径 ${autoDia}（${diameterCells(autoDia)}マス）` : '2人 7・3人 9・4人 11';
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
    const cpuOf = id => { const p = room.players.find(x => x.id === id); return !!(p && p.cpu); };

    // 自分の手番では、何か行動できるマスを薄く光らせる
    const targets = myTurn(g) ? [...new Set(CELL_ACTIONS.flatMap(t => E.targets(g, app.me, t)))] : [];

    const colors = {};
    g.players.forEach(p => { colors[p.id] = colorOf(p.color); });
    boardView().setData({ game: g, colors, patterns: settings.patterns, targets, selected: app.tip && app.tip.pinned ? app.tip.key : null, me: app.me });

    // 変化したマス（拡張・強化・破壊・脱落）を一瞬光らせる
    const cells = {};
    for (const [k, c] of Object.entries(g.board)) cells[k] = `${c.owner}|${c.strong}|${c.core}`;
    if (app.prevCells) view.flash(Object.keys(cells).filter(k => cells[k] !== app.prevCells[k]));
    app.prevCells = cells;

    // 上部の表示
    $('#hud-round').textContent = `${g.round} / ${R.rounds}`;
    $('#hud-turn').innerHTML = g.over ? '<strong>ゲーム終了</strong>'
      : `${swatch(cur.color)}<strong>${esc(cur.name)}</strong><span class="muted">の手番${cur.id === app.me ? '（あなた）' : ''}</span>`;

    // 自分
    $('#me-swatch').innerHTML = me ? swatch(me.color) : '';
    $('#me-name').textContent = me ? me.name : '';
    $('#me-actions').textContent = !me ? '' : !me.alive ? '脱落' : myTurn(g) ? `残り行動 ${g.actionsLeft} / ${R.actionsPerTurn}` : '';
    $('#me-tokens').innerHTML = me ? tokenChip('resource', me.resource, true) + tokenChip('attack', me.attack, true) + tokenChip('defense', me.defense, true) : '';

    // 拡張・強化・破壊はマスを選んで出るツールチップから。マスに関係ない補強と手番終了はここ
    const canAct = me && me.alive && myTurn(g);
    $('#actions').innerHTML = `<button class="act" data-act="reinforce" ${canAct && !E.actionBlocked(g, app.me, 'reinforce') ? '' : 'disabled'}><b>補強</b><small>資源 ${R.cost.reinforce} → 防御 +1・攻撃 +1</small></button>`
      + `<button class="act end" data-act="endTurn" ${canAct ? '' : 'disabled'}><b>手番終了</b><small>資源 +${me ? E.income(g, app.me) : 0}</small></button>`
      + (canAct && g.actionsLeft === 0 ? `<button class="act buy" data-act="buyAction" ${E.actionBlocked(g, app.me, 'buyAction') ? 'disabled' : ''}><b>行動 +1</b><small>資源 ${E.extraActionCost(g)} を払う</small></button>` : '');

    let hint = '';
    if (g.over) hint = '';
    else if (!me || !me.alive) hint = '脱落しました。観戦できます';
    else if (g.pending) hint = '破壊の攻防中です';
    else if (!myTurn(g)) hint = `${cur.name} の手番です`;
    else if (g.actionsLeft === 0) hint = `行動回数を使い切りました。「手番終了」か、資源 ${E.extraActionCost(g)} を払って「行動 +1」`;
    else hint = 'あなたの手番です。光っているマスを選ぶと、拡張・強化・破壊のボタンが出ます';
    $('#hint').textContent = hint;

    // プレイヤー一覧
    const isHost = room.hostId === app.me;
    $('#players').innerHTML = g.players.map(p => {
      const cells = E.cellsOf(g, p.id).length;
      const group = E.largestGroup(g, p.id).length;
      const turn = !g.over && p.id === cur.id;
      return `<li class="${p.alive ? '' : 'out'}${turn ? ' turn' : ''}">
        <div class="prow">${turn ? '<span class="turn-mark">▶</span>' : ''}${swatch(p.color)}<span class="pname">${esc(p.name)}</span>${cpuOf(p.id) ? '<span class="badge cpu">CPU</span>' : ''}${p.id === app.me ? '<span class="badge me">あなた</span>' : ''}${conn(p.id) ? '' : '<span class="badge warn" title="切断中">切断中</span>'}${p.alive ? '' : '<span class="badge">脱落</span>'}</div>
        <div class="pstats"><span class="cells" title="つながっている一番大きなかたまり（勝敗はこれで決まる）／セルの総数"><svg viewBox="0 0 24 24" class="tk"><path d="M12 3 L20 7.5 L20 16.5 L12 21 L4 16.5 L4 7.5 Z" fill="none" stroke="currentColor" stroke-width="2"/></svg><b>${group}</b><small>/${cells}</small></span>${tokenChip('resource', p.resource)}${tokenChip('attack', p.attack)}${tokenChip('defense', p.defense)}</div>
        ${isHost && p.alive && !conn(p.id) && !g.over ? `<button class="small" data-forfeit="${p.id}">脱落させる</button>` : ''}
      </li>`;
    }).join('');

    // ログ（新しいものほど下）
    const logEl = $('#log');
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    logEl.innerHTML = g.log.map(l => `<li class="lg-${l.tone}">${esc(l.text)}</li>`).join('');
    if (atBottom || !app.lastLogSeq) logEl.scrollTop = logEl.scrollHeight;
    const fresh = app.lastLogSeq ? g.log.filter(l => l.seq > app.lastLogSeq) : [];
    for (const l of fresh) if (/^破壊(成功|失敗)/.test(l.text) || l.tone === 'out') toast(l.text, l.tone === 'defend' ? 'info' : 'bad');
    playSounds(g, fresh);
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

    renderClash(g, pl);
    renderExtra(g, me);
    tickTimers();
    renderResult(room, g);
    if (app.tip) showTip(app.tip);
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
        <div class="clash-count reveal"><span>${TOKEN_SVG.attack}攻撃 <b>${res.atk}</b></span><span class="vs">vs</span><span>${TOKEN_SVG.defense}防御 <b>${res.def}</b></span></div>
        <p class="clash-result ${res.success ? 'bad' : 'good'}">${res.success ? '破壊成功' : '破壊失敗（守られた）'}</p>`;
      el.hidden = false;
      return;
    }
    const side = pd.attacker === app.me ? 'atk' : pd.defender === app.me ? 'def' : null;
    const status = (name, ready) => `<span class="${ready ? 'ready' : ''}">${esc(name)}：${ready ? '決定済み' : '考え中…'}</span>`;
    let body;
    if (side && pd[side] === null) {
      const me = side === 'atk' ? a : d;
      const foe = side === 'atk' ? d : a;
      const have = side === 'atk' ? me.attack : me.defense;
      const foeHave = side === 'atk' ? foe.defense : foe.attack;
      const key = `${pd.attacker}|${pd.target}|${g.round}|${g.turn}|${side}`;
      if (!app.bid || app.bid.key !== key) app.bid = { key, n: Math.min(have, side === 'atk' ? foeHave : foeHave + 1) };
      const n = app.bid.n;
      const kind = side === 'atk' ? 'attack' : 'defense';
      body = `<p class="ask">${side === 'atk'
        ? `出す攻撃トークンの数を決めてください（${esc(foe.name)} の防御トークンは ${foeHave} 個）`
        : `あなたの${what}が狙われています。出す防御トークンの数を決めてください（${esc(foe.name)} の攻撃トークンは ${foeHave} 個）`}</p>
        <p class="muted small">相手には公開まで見えません。攻撃 ≧ 防御なら破壊成功。出したトークンはなくなります</p>
        <div class="bid">
          <button class="step" data-bid-step="-1" ${n <= 0 ? 'disabled' : ''} aria-label="1個減らす">−</button>
          <span class="bid-n tk-${kind}">${TOKEN_SVG[kind]}<b>${n}</b><small>/ ${have}</small></span>
          <button class="step" data-bid-step="1" ${n >= have ? 'disabled' : ''} aria-label="1個増やす">＋</button>
          <button class="primary${side === 'atk' ? ' danger' : ''}" data-bid-ok>${n} 個で決定</button>
        </div>`;
    } else if (side) {
      body = `<p class="muted">あなたは ${pd[side]} 個に決めました。相手を待っています…</p>`;
    } else {
      body = '<p class="muted">出す数を伏せて選んでいます…</p>';
    }
    el.innerHTML = `${head}${body}
      <div class="clash-status">${status(a.name, pd.atkReady)}${status(d.name, pd.defReady)}<span class="muted" data-left="bid"></span></div>`;
    el.hidden = false;
    tickTimers();
  }

  // 行動回数を使い切ったら、画面中央で「手番終了」か「資源を払って行動 +1」かを選ぶ
  function renderExtra(g, me) {
    const el = $('#extra');
    const show = myTurn(g) && me && me.alive && g.actionsLeft === 0;
    const key = `${g.round}:${g.turn}:${g.extraBought}`;
    if (!show || app.extraHidden === key) { el.hidden = true; return; }
    const cost = E.extraActionCost(g);
    const lack = cost - me.resource;
    el.innerHTML = `<div class="extra-card">
      <h3>行動回数を使い切りました</h3>
      <div class="extra-btns">
        <button data-extra="endTurn"><b>手番終了</b><small>資源 +${E.income(g, app.me)}</small></button>
        <button class="primary" data-extra="buyAction" ${lack > 0 ? 'disabled' : ''}><b>行動 +1</b><small>${TOKEN_SVG.resource}${cost} を払う${lack > 0 ? `（あと ${lack} 足りない）` : ''}</small></button>
      </div>
      <p class="muted small">行動 +1 に必要な資源は、同じ手番で買うたびに +${R.extraAction.step}（手番が変わると ${R.extraAction.base} に戻る）</p>
      <button class="link" data-extra="hide">盤面を見る</button>
    </div>`;
    el.dataset.key = key;
    el.hidden = false;
  }

  // 効果音：新しいログから、いちばん大事なものを1つ鳴らす
  function playSounds(g, fresh) {
    if (!fresh.length) return;
    const order = ['win', 'out', 'success', 'fail', 'declare', 'buy', 'strengthen', 'reinforce', 'expand', 'endTurn'];
    const found = new Set();
    for (const l of fresh) {
      if (l.tone === 'win') found.add('win');
      else if (l.tone === 'out') found.add('out');
      else if (/^破壊成功/.test(l.text)) found.add('success');
      else if (/^破壊失敗/.test(l.text)) found.add('fail');
      else if (l.tone === 'destroy') found.add('declare');
      else if (l.tone in { strengthen: 1, reinforce: 1, expand: 1, buy: 1 }) found.add(l.tone);
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
    if (!g || room.phase !== 'game' || g.over) { el.hidden = true; return; }
    const pass = Date.now() - (app.graceAt || Date.now());
    const sec = ms => Math.max(0, Math.ceil(ms / 1000));
    const turnSec = room.turnPaused ? sec(room.turnLeftMs) : sec(room.turnLeftMs - pass);
    const mm = `${Math.floor(turnSec / 60)}:${String(turnSec % 60).padStart(2, '0')}`;
    el.hidden = false;
    el.className = 'pill timer' + (room.turnPaused ? ' paused' : turnSec <= 10 ? ' low' : '');
    el.innerHTML = `<span class="muted">持ち時間</span> <strong>${mm}</strong>${room.turnPaused ? '<span class="muted">（攻防中は停止）</span>' : ''}`;
    // 自分の手番の残り10秒は時計の音
    if (myTurn(g) && !room.turnPaused && turnSec <= 10 && turnSec > 0 && turnSec !== lastTickSec) window.HexSound.play('tick');
    lastTickSec = turnSec;
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
    if (!key || (app.tip && app.tip.pinned && app.tip.key === key)) { hideTip(); return; }
    showTip({ key, pinned: true });
  }

  function onCellHover(key, x, y, scale, byLongPress) {
    if (byLongPress) { if (key) showTip({ key, pinned: true }); return; }
    if (app.tip && app.tip.pinned) return;   // 選んでいるマスがあるあいだは、そちらを出したまま
    if (!key) hideTip(); else showTip({ key, pinned: false });
  }

  const TERRAIN_EFFECTS = {
    plain: '効果なし',
    mountain: `拡張コスト +1（資源 ${R.cost.expandMountain}）。拡張すると防御トークン +1、強化すると攻撃トークン +1 に加えて防御トークン +1`,
    mine: '強化済セルなら、手番終了時の資源 +1（強化済セルの +1 に加えて）',
  };

  const CELL_ACTIONS = ['expand', 'strengthen', 'destroy'];

  // そのマスでできる行動（1つ）と、できないときの理由
  function cellAction(g, key) {
    const c = g.board[key];
    const me = g.players.find(p => p.id === app.me);
    if (!me || !me.alive || g.over) return null;
    let type, cost, gain;
    if (!c.owner) {
      type = 'expand';
      cost = E.expandCost(c);
      gain = c.terrain === 'mountain' ? '防御トークン +1' : '';
    } else if (c.owner === app.me) {
      if (c.strong) return { note: '強化済のセルです' };
      type = 'strengthen';
      cost = R.cost.strengthen;
      const inc = R.income.strong + (c.terrain === 'mine' ? R.income.mineBonus : 0);
      gain = '攻撃トークン +1' + (c.terrain === 'mountain' ? '・防御トークン +1' : '') + `・手番終了時の資源 +${inc}`;
    } else {
      type = 'destroy';
      cost = R.cost.destroy;
      const foe = g.players.find(p => p.id === c.owner);
      gain = `${foe.name} の防御トークン ${foe.defense} 個。成功するとこのマスが自分のセルになる`;
    }
    let why = '';
    if (!E.targets(g, app.me, type).includes(key)) {
      const cur = E.current(g);
      if (g.pending) why = '破壊の攻防が終わるまで待ってください';
      else if (cur.id !== app.me) why = `${cur.name} の手番です`;
      else if (g.actionsLeft <= 0) why = '行動回数を使い切りました';
      else if (me.resource < cost) why = `資源トークンが足りません（あと ${cost - me.resource}）`;
      else why = '自分のセルに隣接していません';
    }
    return { type, cost, gain, why };
  }

  function showTip(tip) {
    const g = app.room && app.room.game;
    if (!g || !g.board[tip.key]) { hideTip(); return; }
    const changed = !app.tip || app.tip.key !== tip.key || app.tip.pinned !== tip.pinned;
    app.tip = tip;
    const c = g.board[tip.key];
    const owner = c.owner && g.players.find(p => p.id === c.owner);
    const state = !owner ? '空きマス' : (c.core ? 'コア・' : '') + (c.strong ? '強化済' : '未強化');
    let acts = '';
    if (tip.pinned) {
      const a = cellAction(g, tip.key);
      if (a && a.type) {
        acts = `<div class="tt-acts"><button class="tt-act${a.type === 'destroy' ? ' danger' : ''}" data-cell-act="${a.type}" ${a.why ? 'disabled' : ''}>
          <b>${E.ACTION_NAMES[a.type]}</b><span class="tt-cost">${TOKEN_SVG.resource}${a.cost}</span>${a.gain ? `<small>${esc(a.gain)}</small>` : ''}</button>
          ${a.why ? `<p class="tt-why">${esc(a.why)}</p>` : ''}</div>`;
      } else if (a && a.note) {
        acts = `<div class="tt-acts"><p class="tt-why">${esc(a.note)}</p></div>`;
      }
    }
    const el = $('#tooltip');
    el.innerHTML = `<div class="tt-head">${{ plain: '', mountain: '▲ ', mine: '★ ' }[c.terrain]}${E.TERRAIN_NAMES[c.terrain]}<span class="muted">(${c.q},${c.r})</span></div>
      <div>所有者：${owner ? `${swatch(owner.color)}${esc(owner.name)}` : '<span class="muted">なし</span>'}</div>
      <div>状態：${state}</div>
      <div class="tt-eff">${TERRAIN_EFFECTS[c.terrain]}</div>${acts}`;
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
    let left = x - s * 1.05 - w;
    if (left < 8) left = x + s * 1.05;
    left = Math.max(8, Math.min(left, W - w - 8));
    const top = Math.max(8, Math.min(y - h / 2, H - h - 8));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
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
    $('#set-preview').innerHTML = window.HexRoom.COLORS.map(c =>
      `<span>${swatch(c, 'big')}${colorOf(c).name}${settings.patterns ? `<small>${PATTERN_NAMES[PATTERNS[c]]}</small>` : ''}</span>`).join('');
  }

  // ---------- イベント ----------

  function init() {
    const params = new URLSearchParams(location.search);
    $('#in-name').value = store.get('name') || '';
    const code = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code) { $('#in-code').value = code; topMsg(`部屋ID ${code} に招待されています。なまえを入れて「参加する」を押してください`, 'info'); }

    $('#btn-create').onclick = () => enterRoom('create');
    $('#btn-join').onclick = () => enterRoom('join');
    $('#btn-local').onclick = () => enterRoom('local');
    $('#btn-add-cpu').onclick = () => send({ type: 'addCpu' });
    $('#lobby-players').onclick = e => { const b = e.target.closest('[data-remove-cpu]'); if (b) send({ type: 'removeCpu', target: b.dataset.removeCpu }); };
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
    $('#set-diameter').onchange = e => send({ type: 'settings', diameter: Number(e.target.value) });
    $('#actions').onclick = e => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      send({ type: 'act', action: { type: b.dataset.act } });
    };
    $('#tooltip').onclick = e => {
      const b = e.target.closest('[data-cell-act]');
      if (!b || b.disabled || !app.tip) return;
      const type = b.dataset.cellAct;
      const [q, r] = E.parseKey(app.tip.key);
      send({ type: 'act', action: { type, q, r } });
      // 拡張・強化のあとは同じマスを選んだまま（続けて強化できるように）。破壊は攻防の画面へ
      if (type === 'destroy') hideTip();
    };
    $('#clash').onclick = e => {
      const b = e.target.closest('[data-bid-step], [data-bid-ok]');
      if (!b || b.disabled || !app.bid) return;
      if (b.dataset.bidStep) {
        app.bid.n += Number(b.dataset.bidStep);
        renderClash(app.room.game, id => app.room.game.players.find(p => p.id === id));
        return;
      }
      window.HexSound.play('bid');
      send({ type: 'act', action: { type: 'bid', count: app.bid.n } });
    };
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
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && app.tip) hideTip();
    });

    document.querySelectorAll('[data-open]').forEach(b => {
      b.addEventListener('click', () => { const d = $('#' + b.dataset.open); if (d.id === 'settings') renderSettings(); d.showModal(); });
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
