/*
 * Cocage — 画面と通信
 * 通信は PeerJS（WebRTC の P2P）。部屋を作った人（ホスト）のブラウザで Room を動かし、
 * 参加者は行動の要求をホストへ送る。ホストが検証して、全員に最新の状態を配信する。
 */
(function () {
  'use strict';

  const E = window.CocageEngine;
  const R = E.RULES;
  const $ = sel => document.querySelector(sel);

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);

  const store = {
    get(k) { try { return localStorage.getItem('cocage.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('cocage.' + k, v); } catch (e) { /* 無視 */ } },
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
    idPrefix: 'cocage-v1-',     // ほかのゲームの部屋とは混ざらないように
    codeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    codeLength: 5,
    joinTimeoutMs: 15000,
    pingMs: 3000,               // 生存確認の間隔
    dropMs: 20000,              // これだけ音沙汰がなければ切断とみなす
    maxRetry: 15,               // 参加者が再接続を試す回数
  }, window.COCAGE_P2P || {});  // テスト用の上書き（URLからは変えられない）

  // プレイヤー色（P1〜P5）
  const PLAYER_COLORS = ['#6FB1F2', '#F2766D', '#7BD39A', '#B596EE', '#F2C46D'];
  const colorOf = i => PLAYER_COLORS[i % PLAYER_COLORS.length];
  const swatch = i => `<span class="swatch" style="background:${colorOf(i)}"></span>`;

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
      this.room = new window.CocageRoom.Room({ code, send: (pid, msg) => this.deliver(pid, clone(msg)) });
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
      this.room = new window.CocageRoom.Room({ code: '', send: (pid, msg) => { if (pid === this.id) { const m = clone(msg); setTimeout(() => onMessage(m), 0); } } });
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
    overlay: 'normal',  // 折れやすさの表示：normal／p／loss
    graceAt: 0,
  };

  function send(msg) { if (app.conn) app.conn.send(msg); }
  const act = action => send({ type: 'act', action });

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

  function setReconnecting(on) { if (on && $('#reconnecting').hidden) window.CocageSound.play('warn'); $('#reconnecting').hidden = !on; }

  function onMessage(msg) {
    if (msg.type === 'error') {
      if (msg.fatal) leaveRoom(msg.text);
      else { toast(msg.text, 'bad'); window.CocageSound.play('deny'); }
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
    if (prev && prev.phase === 'lobby' && msg.room.phase === 'game') window.CocageSound.play('start');
    if (!prev || prev.phase !== msg.room.phase) {
      app.endPlayed = false;
      app.prevPlan = null;
      app.prevTops = null;
      app.resultHidden = false;
      app.lastRound = null;
      hideTip();
      if (board) board.panInit = false;
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
    $('#lobby-players').innerHTML = room.players.map((p, i) =>
      `<li>${swatch(i)}<span class="seat" style="color:${colorOf(i)}">P${i + 1}</span><span class="pname">${esc(p.name)}</span>${p.cpu ? `<span class="badge cpu">CPU</span>${isHost
        ? `<select data-cpu-level="${p.id}" aria-label="${esc(p.name)} の強さ">${Object.entries(window.CocageCpu.LEVEL_NAMES).map(([k, v]) => `<option value="${k}"${p.level === k ? ' selected' : ''}>${v}</option>`).join('')}</select><button class="small remove" data-remove="${p.id}">外す</button>`
        : `<span class="badge">${window.CocageCpu.LEVEL_NAMES[p.level] || ''}</span>`}` : ''}${p.id === room.hostId && !local ? '<span class="badge">ホスト</span>' : ''}${p.id === app.me ? '<span class="badge me">あなた</span>' : ''}</li>`).join('');
    $('#btn-add-cpu').hidden = !isHost;
    $('#btn-add-cpu').disabled = room.players.length >= R.maxPlayers;
    const enough = room.players.length >= R.minPlayers;
    $('#btn-start').hidden = !isHost;
    $('#btn-start').disabled = !enough;
    const n = Math.max(R.minPlayers, room.players.length);
    $('#lobby-board').textContent = `${n}人なら 盤面は18行×${R.colsPerPlayer * n}列。全${R.turns}ターン、1ターン${R.turnSeconds}秒（全員が確定したら次へ）`;
    $('#lobby-wait').textContent = isHost
      ? (enough ? `${room.players.length}人で始められます` : `あと${R.minPlayers - room.players.length}人以上集まると始められます。${local ? 'CPUを追加してください' : '招待URLを送るか、CPUを追加してください'}`)
      : 'ホストがゲームを始めるのを待っています…';
  }

  let board = null;
  function boardView() {
    if (!board) board = new window.CocageBoard($('#board'), { onHover, onPick, onCancel });
    return board;
  }

  const fmt = v => String(Math.round(v * 10) / 10);
  const pct = (v, d) => (v * 100).toFixed(d == null ? 2 : d) + '%';

  function renderGame(room) {
    const g = room.game;
    const me = g.players.find(p => p.id === app.me);
    const colors = {};
    g.players.forEach(p => { colors[p.id] = colorOf(p.color); });
    const live = !g.over && !!me;
    const candidates = live && !me.finished ? E.candidates(g, app.me) : null;
    boardView().setData({ game: g, me: app.me, overlay: app.overlay, colors, candidates });
    // 新しいターンが解決されたら、点数を稼いだ葉から数字をこぼす（最初に画面を開いたときは出さない）
    if (app.lastRound == null && g.over) app.endPlayed = true;   // 終わったあとに開いたときは、鳴らさない
    if (app.lastRound != null && g.round > app.lastRound) {
      soundTurn(g);
      const { points } = E.scoreBoard(g);
      board.playTurn(Object.entries(points).filter(([, v]) => v > 0).map(([ck, v]) => ({ cell: ck, pts: v, color: colors[g.leaves[ck].owner] })), g.lastTurn);
    }
    app.lastRound = g.round;

    // 上のバーとオーバーレイ
    $('#hud-round').textContent = g.over ? '終了' : `${g.round + 1} / ${g.turns}`;
    document.querySelectorAll('[data-overlay]').forEach(b => b.classList.toggle('on', b.dataset.overlay === app.overlay));
    $('#overlay-legend').hidden = app.overlay === 'normal';
    $('#overlay-note').textContent = app.overlay === 'p' ? '毎ターンの折れる確率（いまの盤面で相対）' : '確率 × 失う枝と葉の数（いまの盤面で相対）';

    // 下のバー：置くもの・計画・確定
    $('#btn-finish').hidden = !live;
    const plan = me ? me.plan : [];
    const geo = E.geometry(g.cols);
    const desc = it => it.t === 'b'
      ? `枝（高さ${geo.edges[it.e].h}）`
      : `葉（${geo.cells[it.c].c + 1}列・${geo.cells[it.c].r + 1}行）`;
    $('#plan').innerHTML = !live ? '' : Array.from({ length: R.ap }, (_, i) => {
      const it = plan[i];
      return it
        ? `<li class="slot used${it.done ? ' done' : ''}"><b>${i + 1}</b><span class="grow">${desc(it)}</span><button data-confirm="${i}" title="この行動を確定／取り消し">${it.done ? '✓ 確定' : '確定'}</button><button data-remove="${i}" title="この行動を外す">✕</button></li>`
        : `<li class="slot empty"><b>${i + 1}</b><span class="grow">空き</span></li>`;
    }).join('');
    const btn = $('#btn-finish');
    btn.textContent = me && me.finished ? '✓ 確定ずみ（取り消す）' : '全て確定';
    btn.classList.toggle('on', !!(me && me.finished));
    const n = g.players.length;
    $('#hint').textContent = g.over ? ''
      : !me ? '観戦中です'
      : me.finished ? `確定ずみ。ほかの人を待っています（確定した人：${room.finishedCount}/${n}人）。時間まで、取り消して変更できます`
      : '白く光っている辺（枝）かセル（葉）をクリックして置きます（行動力1）。右クリックで取り消し。ホイールで拡大・縮小、ドラッグで移動'
        + (candidates && !candidates.cells.length ? '。葉は自分の枝に接するセルに置けます（幹だけでは置けないので、まず枝を）' : '');
    $('#tickbar').hidden = g.over;

    renderScores(g);
    renderChart(g);
    renderEvents(g);
    renderResult(room);
    soundState(g, me);
    tickTimer();
  }

  function renderScores(g) {
    const max = Math.max(1, ...g.players.map(p => p.score));
    const order = g.players.slice().sort((a, b) => b.score - a.score || a.trunk - b.trunk);
    $('#scores').innerHTML = order.map(p => `<li><span class="who">${swatch(p.color)}<b style="color:${colorOf(p.color)}">P${p.trunk + 1}</b><span class="pname">${esc(p.name)}</span>${p.id === app.me ? '<span class="badge me">あなた</span>' : ''}${connected(p.id) ? '' : '<span class="badge warn">切断中</span>'}</span>`
      + `<span class="num">${fmt(p.score)}<small>${g.round > 0 ? '+' + fmt(p.gain) : ''}</small></span>`
      + `<span class="bar"><i style="width:${(p.score / max * 100).toFixed(1)}%;background:${colorOf(p.color)}"></i></span></li>`).join('');
  }

  const connected = id => { const p = app.room && app.room.players.find(x => x.id === id); return !p || p.connected; };

  // ターンごとの合計点の折れ線グラフ
  function renderChart(g) {
    const W = 300, H = 130, L = 26, Rr = 8, T = 8, B = 16;
    const max = Math.max(4, ...g.players.map(p => p.score));
    const nice = max <= 10 ? Math.ceil(max / 2) * 2 : max <= 50 ? Math.ceil(max / 10) * 10 : Math.ceil(max / 50) * 50;
    const x = t => L + (W - L - Rr) * t / g.turns;
    const y = v => T + (H - T - B) * (1 - v / nice);
    let s = '';
    for (const f of [0, 0.5, 1]) s += `<line class="${f === 0 ? 'axis' : 'grid'}" x1="${L}" x2="${W - Rr}" y1="${y(nice * f)}" y2="${y(nice * f)}"/><text x="${L - 4}" y="${y(nice * f) + 3}" text-anchor="end">${fmt(nice * f)}</text>`;
    for (const t of [0, 9, 18, 27, 36].filter(t => t <= g.turns)) s += `<text x="${x(t)}" y="${H - 3}" text-anchor="middle">${t}</text>`;
    for (const p of g.players) s += `<polyline stroke="${colorOf(p.color)}" points="${p.history.map((v, t) => `${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>`;
    $('#chart').innerHTML = s;
  }

  function renderEvents(g) {
    const lt = g.lastTurn;
    if (!lt) { $('#events').innerHTML = '<li class="muted">まだ何も起きていません</li>'; return; }
    const primary = lt.removed.filter(r => r.primary).length;
    const li = (n, label, sub) => `<li><b>${n}</b><span>${label}${sub ? ` <span class="muted">${sub}</span>` : ''}</span></li>`;
    $('#events').innerHTML = `<li class="muted">ターン${lt.turn}の結果</li>`
      + li(lt.placedBranches + lt.placedLeaves, '成功した行動', `枝${lt.placedBranches}・葉${lt.placedLeaves}`)
      + li(lt.contested, '抽選になった場所', lt.lost.length ? `負けた行動 ${lt.lost.length}` : '')
      + li(primary, '折れた枝', primary ? `失った枝${lt.removed.length}・葉${lt.removedLeaves}` : '')
      + li(lt.topChanges, '一番上の入れ替わり');
  }

  function renderResult(room) {
    const g = room.game, box = $('#result');
    if (!g.over || app.resultHidden) { box.hidden = true; return; }
    const order = g.players.slice().sort((a, b) => b.score - a.score || a.trunk - b.trunk);
    const win = g.winners.map(id => g.players.find(p => p.id === id).name).join('・');
    const isHost = room.hostId === app.me;
    box.innerHTML = `<div class="card"><h2>結果</h2><p>${esc(win)} の勝ち！</p><ol class="rank">${order.map(p => `<li class="${g.winners.includes(p.id) ? 'win' : ''}">${swatch(p.color)}<span class="grow pname">P${p.trunk + 1} ${esc(p.name)}</span><b>${fmt(p.score)}</b></li>`).join('')}</ol>`
      + `<div class="row"><button data-act="hide-result">盤面を見る</button>${isHost ? '<button class="primary" data-act="to-lobby">ロビーに戻る</button>' : ''}<button data-act="leave">退出する</button></div></div>`;
    box.hidden = false;
  }

  // ---------- ツールチップ（枝の折れやすさ） ----------

  function onHover(h, x, y) {
    const g = app.room && app.room.game;
    if (!g || !h) { hideTip(); return; }
    const geo = E.geometry(g.cols);
    let html = '';
    if (h.edge && g.edges[h.edge]) {
      const st = E.edgeStats(g, h.edge, 10);
      html = edgeTip('この枝が折れる確率（毎ターン）', st.parts, st.edge.h, st.survive, st.lostEdges, st.lostLeaves, null);
    } else if (h.edge) {
      html = `<div class="tt-head">幹</div><div class="tt-big">壊れません</div>`;
    } else if (h.cand && h.cand.t === 'b') {
      const me = g.players.find(p => p.id === app.me), pr = E.project(g, app.me, me.plan);
      const e = geo.edges[h.cand.key];
      const parts = E.breakParts(e.h, 1);
      html = edgeTip('この枝を置くと、折れる確率（毎ターン）', parts, e.h, null, null, null, 'まだ置いていません');
    } else { hideTip(); return; }
    const tip = $('#tooltip');
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const rect = $('#board').getBoundingClientRect();
    let tx = rect.left + x + 16, ty = rect.top + y + 16;
    if (tx + r.width > window.innerWidth - 8) tx = rect.left + x - r.width - 16;
    if (ty + r.height > window.innerHeight - 8) ty = rect.top + y - r.height - 16;
    tip.style.left = Math.max(8, tx) + 'px';
    tip.style.top = Math.max(8, ty) + 'px';
  }

  function edgeTip(head, parts, h, survive, lostEdges, lostLeaves, note) {
    const rows = [
      ['基本', pct(parts.base)],
      [`高さ（${h}行目）`, '+' + pct(parts.height)],
      [`重さ（支える枝${parts.w}本）`, '+' + pct(parts.load)],
    ];
    if (survive == null) rows.push(['根本側の枝', '支える枝が1本ずつ増える']);
    if (survive != null) rows.push(['10ターン残る確率', pct(survive, 0)], ['折れると失う', `枝${lostEdges}・葉${lostLeaves}`]);
    return `<div class="tt-head">${head}</div><div class="tt-big">${pct(parts.p)}${note ? `<small>${note}</small>` : ''}</div>`
      + `<dl class="tt-rows">${rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('')}</dl>`;
  }

  function hideTip() { const t = $('#tooltip'); if (t) t.hidden = true; }

  // 右クリック：置いた計画を取り消す（計画に当たらなかったら、いちばん新しいもの）
  function onCancel(index) {
    const g = app.room && app.room.game;
    if (!g || g.over) return;
    const me = g.players.find(p => p.id === app.me);
    if (!me || !me.plan.length) return;
    act({ type: 'remove', index: index >= 0 ? index : me.plan.length - 1 });
  }

  function onPick(c) {
    if (!app.room || !app.room.game || app.room.game.over) return;
    if (c.t === 'b') act({ type: 'addBranch', edge: c.key });
    else act({ type: 'addLeaf', cell: c.key });
  }

  // ---------- 効果音 ----------

  // 自分の計画・確定の変化（置いた・取り消した・確定した）と、ゲームの終わり
  function soundState(g, me) {
    const S = window.CocageSound;
    // 一番上の持ち主（入れ替わりの音のため。毎回覚えておく）
    const tops = {};
    for (const [c, t] of Object.entries(E.scoreBoard(g).tops)) tops[c] = t.owner;
    app.prevTops = tops;
    if (me && !g.over) {
      const sig = it => it.t + ':' + (it.e || it.c);
      const cur = { round: g.round, keys: me.plan.map(sig), done: me.plan.map(it => !!it.done), finished: !!me.finished };
      const prev = app.prevPlan;
      app.prevPlan = cur;
      if (prev && prev.round === cur.round) {
        const added = cur.keys.filter(k => !prev.keys.includes(k)), removed = prev.keys.filter(k => !cur.keys.includes(k));
        if (added.length) S.play(added[0][0] === 'b' ? 'planBranch' : 'planLeaf');
        else if (removed.length) S.play('cancel');
        else if (cur.finished !== prev.finished) S.play(cur.finished ? 'finish' : 'unfinish');
        else if (cur.done.some((d, i) => d !== prev.done[i])) S.play('confirm');
      }
    }
    if (g.over && !app.endPlayed) {
      app.endPlayed = true;
      S.play('end', { delay: 0.6 });
      S.play(me && g.winners.includes(me.id) ? 'win' : 'lose', { delay: 1.8 });
    }
  }

  // ターンが解決されたときの音：風が通り → 置かれる → 抽選に負ける → 点数が散る → 一番上の入れ替わり → （数字がこぼれたあとに）枝が折れる
  function soundTurn(g) {
    const S = window.CocageSound, lt = g.lastTurn, me = app.me;
    if (!lt) return;
    S.play('resolve');
    for (let i = 0; i < Math.min(4, lt.placedBranches); i++) S.play('placedBranch', { delay: 0.12 + i * 0.07, vol: 1 - i * 0.15 });
    for (let i = 0; i < Math.min(4, lt.placedLeaves); i++) S.play('placedLeaf', { delay: 0.2 + i * 0.09, vol: 1 - i * 0.15 });
    const mine = lt.lost.filter(l => l.owner === me).length;
    if (lt.lost.length) S.play('lost', { delay: 0.38, vol: mine ? 1 : 0.45 });
    S.play('grow', { delay: 0.5 });
    // 点数（点数の大きい葉から、最大10枚。自分の葉は大きめ）
    const { points, tops } = E.scoreBoard(g);
    Object.entries(points).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 10)
      .forEach(([ck, v], i) => S.play('spill', { delay: 0.05 + i * 0.06, pts: v, vol: g.leaves[ck].owner === me ? 1 : 0.5 }));
    // 一番上の入れ替わり
    let up = 0, down = 0;
    for (const [c, t] of Object.entries(tops)) {
      const was = app.prevTops && app.prevTops[c];
      if (was && was !== t.owner) { if (t.owner === me) up++; else if (was === me) down++; }
    }
    if (up) S.play('topUp', { delay: 0.75 });
    if (down) S.play('topDown', { delay: 0.8 });
    // 枝が折れる（盤面の演出に合わせて、数字がこぼれたあと）
    const leaves = lt.removedLeafList || [];
    if (lt.removed.length || leaves.length) {
      const base = window.CocageBoard.PART_MS / 1000;
      const prim = lt.removed.filter(r => r.primary).slice(0, 3);
      prim.forEach((r, i) => {
        const own = r.owner === me ? 1.2 : 0.8;
        S.play('breakFlash', { delay: base + i * 0.05 });
        S.play('snap', { delay: base + 0.2 + i * 0.09, vol: own });
        S.play('label', { delay: base + 0.3 + i * 0.09, vol: r.owner === me ? 1 : 0.6 });
        S.play('fall', { delay: base + 0.6 + i * 0.08 });
      });
      lt.removed.filter(r => !r.primary).slice(0, 6).forEach((r, i) => S.play('fall', { delay: base + 0.5 + i * 0.1 }));
      if (leaves.length) S.play('leafGone', { delay: base + 0.5, vol: leaves.some(l => l.owner === me) ? 1.2 : 0.7 });
    }
  }

  function renderSoundButtons() {
    const on = window.CocageSound.isOn();
    document.querySelectorAll('[data-sound-toggle]').forEach(b => { b.textContent = on ? '🔊 音あり' : '🔇 音なし'; b.setAttribute('aria-pressed', String(on)); });
  }

  // ターンの残り時間
  function tickTimer() {
    const room = app.room;
    if (!room || room.phase !== 'game' || !room.game || room.game.over) return;
    const left = Math.max(0, room.turnLeftMs - (Date.now() - app.graceAt));
    const total = R.turnSeconds * 1000;
    const bar = $('#tickbar');
    bar.classList.toggle('low', left <= 10000);
    bar.firstElementChild.style.width = `${Math.min(100, left / total * 100)}%`;
    // 残り10秒からは、小枝を鳴らすような音で知らせる（確定していない人だけ）
    const me = room.game.players.find(p => p.id === app.me), sec = Math.ceil(left / 1000);
    if (me && !me.finished && sec >= 1 && sec <= 10 && sec !== app.lastTickSec) window.CocageSound.play('tick', { hot: sec <= 3 });
    app.lastTickSec = sec;
  }

  // ---------- 初期化 ----------

  function init() {
    const params = new URLSearchParams(location.search);
    $('#in-name').value = store.get('name') || '';
    const code = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    if (code) { $('#in-code').value = code; topMsg(`部屋ID ${code} に招待されています。なまえを入れて「参加する」を押してください`, 'info'); }

    $('#btn-create').onclick = () => enterRoom('create');
    $('#btn-join').onclick = () => enterRoom('join');
    $('#btn-local').onclick = () => enterRoom('local');
    $('#in-code').addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom('join'); });
    $('#btn-copy').onclick = async () => {
      const url = $('#invite-url').value;
      try { await navigator.clipboard.writeText(url); toast('招待URLをコピーしました', 'info'); }
      catch (e) { $('#invite-url').select(); toast('コピーできませんでした。URLを選択してコピーしてください'); }
    };
    $('#btn-leave').onclick = () => leaveRoom('');
    $('#btn-start').onclick = () => send({ type: 'start' });
    $('#btn-add-cpu').onclick = () => send({ type: 'addCpu' });
    $('#lobby-players').addEventListener('change', e => { const s = e.target.closest('[data-cpu-level]'); if (s) send({ type: 'cpuLevel', target: s.dataset.cpuLevel, level: s.value }); });
    $('#lobby-players').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b) send({ type: 'removePlayer', target: b.dataset.remove }); });

    document.querySelectorAll('[data-overlay]').forEach(b => { b.onclick = () => { app.overlay = b.dataset.overlay; render(); }; });
    $('#btn-center').onclick = () => boardView().centerOn(app.me);
    $('#btn-fit').onclick = () => boardView().fit();
    $('#plan').addEventListener('click', e => {
      const c = e.target.closest('[data-confirm]'), r = e.target.closest('[data-remove]');
      if (c) act({ type: 'confirm', index: Number(c.dataset.confirm) });
      if (r) act({ type: 'remove', index: Number(r.dataset.remove) });
    });
    $('#btn-finish').onclick = () => act({ type: 'finish' });
    $('#result').addEventListener('click', e => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'hide-result') { app.resultHidden = true; render(); addResultButton(); }
      if (b.dataset.act === 'to-lobby') send({ type: 'lobby' });
      if (b.dataset.act === 'leave') leaveRoom('');
    });
    document.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => { const d = $('#' + b.dataset.open); d.showModal(); d.scrollTop = 0; }));
    document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => b.closest('dialog').close()));

    document.querySelectorAll('[data-sound-toggle]').forEach(b => b.addEventListener('click', () => {
      window.CocageSound.setOn(!window.CocageSound.isOn());
      renderSoundButtons();
      window.CocageSound.play('ui');
    }));
    renderSoundButtons();
    // ボタンを押したときの小さな音（計画の確定などは、それぞれ別の音）
    document.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b || b.closest('#plan') || b.id === 'btn-finish' || b.hasAttribute('data-sound-toggle')) return;
      window.CocageSound.play('ui');
    });
    setInterval(tickTimer, 250);
    window.addEventListener('pagehide', () => { if (app.conn && app.conn.isHost) app.conn.close(); });
    window.addEventListener('beforeunload', e => {
      if (app.conn && app.conn.isHost && app.room) { e.preventDefault(); e.returnValue = ''; }
    });
    show('top');
  }

  // 結果を閉じたあと、もう一度開くためのボタン
  function addResultButton() {
    if ($('#btn-show-result')) return;
    const b = document.createElement('button');
    b.id = 'btn-show-result';
    b.className = 'tool';
    b.textContent = '結果';
    b.onclick = () => { app.resultHidden = false; render(); b.remove(); };
    $('.board-tools').prepend(b);
  }

  init();
})();
