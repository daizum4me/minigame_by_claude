/*
 * Snowfield — 画面と通信
 * 通信は PeerJS（WebRTC の P2P）。部屋を作った人（ホスト）のブラウザで Room を動かし、
 * 参加者は行動の要求をホストへ送る。ホストが検証して、全員に最新の状態を配信する。
 * CPUと遊ぶときは通信せず、自分のブラウザの中で Room を動かす。
 */
(function () {
  'use strict';

  const E = window.SnowEngine;
  const B = window.SnowBoard;
  const R = E.RULES;
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC[c]);
  const clone = o => JSON.parse(JSON.stringify(o));

  const store = {
    get(k) { try { return localStorage.getItem('snowfield.' + k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem('snowfield.' + k, v); } catch (e) { /* 無視 */ } },
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
    idPrefix: 'snowfield-v1-',
    codeChars: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
    codeLength: 5,
    joinTimeoutMs: 15000,
    pingMs: 3000,               // 生存確認の間隔
    dropMs: 20000,              // これだけ音沙汰がなければ切断とみなす
    maxRetry: 15,               // 参加者が再接続を試す回数
  }, window.SNOWFIELD_P2P || {});

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
  function safeSend(conn, msg) { try { if (conn && conn.open) conn.send(msg); } catch (e) { /* 切断済み */ } }
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
      this.room = new window.SnowRoom.Room({ code, send: (pid, msg) => this.deliver(pid, clone(msg)) });
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
        const r = this.room.join(tok, msg.name, msg.v == null ? '0' : String(msg.v));   // バージョンが違う人は入れない
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
    constructor(name, opts) {
      this.isLocal = true;
      this.room = new window.SnowRoom.Room({ code: '', send: (pid, msg) => { if (pid === this.id) { const m = clone(msg); setTimeout(() => onMessage(m), 0); } } });
      this.id = this.room.join(token(), name).id;
      for (let i = 0; i < R.minPlayers - 1; i++) this.room.handle(this.id, { type: 'addCpu' });
      if (opts && opts.tutorial) { this.room.tutorial = true; this.room.settings.simul = false; this.room.handle(this.id, { type: 'start' }); }   // チュートリアルは、すぐに始める
    }
    send(msg) { setTimeout(() => { if (!this.room.closed) this.room.handle(this.id, msg); }, 0); }
    close() { this.room.close(); }
  }

  // ---------- アプリの状態 ----------

  const app = {
    conn: null, me: null, room: null, game: null,
    sel: null,           // 選んでいる建物の id
    menu: false, tray: 'build',
    mode: 'play', tool: 'pen', color: 'a',
    lastLogN: -1, gameKey: null, resultHidden: false, weatherKey: '',
    card: null,          // ドラッグ中の建設カード
  };
  let board = null;
  let guide = null;

  const theme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const TH = () => B.THEMES[theme()];
  const myP = () => (app.game ? E.pl(app.game, app.me) : null);
  const myTurn = () => !!app.game && E.isTurn(app.game, app.me);
  const tkey = g => (E.simul(g) ? 'r' + g.round : g.round + ':' + g.turn);   // 手番（同時ならラウンド）が変わったか見分けるキー
  const simulOf = g => !!g && E.simul(g);
  const pcol = c => B.PLAYER_COLORS[c] || '#888';
  const pawnIco = (p, size) => B.shapeSvg(p.shape, p.color, size || 22);
  const send = msg => { if (app.conn) app.conn.send(msg); };
  const act = a => send({ type: 'act', a });

  function show(id) { for (const s of ['top', 'lobby', 'game']) $('#' + s).hidden = s !== id; }

  let toastTimer = 0;
  function toast(text, tone) {
    const el = $('#toast');
    el.textContent = text;
    el.className = 'toast ' + (tone || '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }
  let mapToastTimer = 0;
  function mapToast(text, tone) {
    if ($('#game').hidden) { toast(text, tone); return; }
    const el = $('#maptoast');
    el.textContent = text;
    el.className = 'pill toast-map ' + (tone || '');
    el.hidden = false;
    clearTimeout(mapToastTimer);
    mapToastTimer = setTimeout(() => { el.hidden = true; }, 4500);
  }
  function setReconnecting(on) { $('#reconnecting').hidden = !on; }

  function onMessage(msg) {
    if (msg.type === 'error') {
      if (msg.fatal) leaveRoom(msg.text);
      else { mapToast(msg.text, 'bad'); SnowSound.play('error'); }
      return;
    }
    if (msg.type === 'moveReq') {                         // ほかの人から、移動のお願い
      const el = $('#movein');
      el.innerHTML = `<b>${esc(msg.fromName)}さんが、移動をお願いしています</b><span class="small muted">あなたの駒が、行きたい道をふさいでいます。</span><div><button class="primary" data-mi="yes">場所を空ける</button><button data-mi="no">ことわる</button></div>`;
      el.hidden = false;
      SnowSound.play('warn');
      clearTimeout(onMessage.t);
      onMessage.t = setTimeout(() => { el.hidden = true; }, 30000);
      return;
    }
    if (msg.type === 'toast') { if (msg.text) mapToast(msg.text, msg.tone); if (msg.sfx) SnowSound.play(msg.sfx); return; }
    if (msg.type !== 'state') return;
    if (!app.conn || !app.conn.isHost && !app.conn.isLocal) {
      if (msg.room.version !== E.VERSION) { leaveRoom(`この部屋は v${msg.room.version || '不明（古い版）'} です（あなたは v${E.VERSION}）。ページを再読み込みして、最新版にしてください`); return; }
    }
    app.me = msg.you;
    app.room = msg.room;
    app.roomAt = Date.now();
    app.game = msg.game;
    if (board) board.liveClear();
    if (msg.room.code) {
      const url = new URL(location.href);
      if (url.searchParams.get('room') !== msg.room.code) {
        url.searchParams.set('room', msg.room.code);
        history.replaceState(null, '', url);
      }
    }
    render();
  }

  function render() {
    if (!app.room) return;
    if (app.room.phase === 'lobby') { show('lobby'); renderLobby(); $('#result').hidden = true; return; }
    if (!app.game) return;
    show('game');
    const g = app.game;
    if (app.gameKey !== g.seed) {
      app.gameKey = g.seed; app.turnKey = null; app.annRound = null; app.over = null; app.endPopDismiss = null; app.lastLogN = -1; app.sel = null; app.menu = false; app.tray = 'build'; app.resultHidden = false;
      setMode('play');
      requestAnimationFrame(() => { board.resize(); board.reset(); });
    }
    if (app.mode === 'draw' && myTurn()) { setMode('play'); mapToast('あなたの手番です。お絵かきを終えました'); }
    if (app.menu && !myP()) app.menu = false;
    toastNewLog(g);
    announce(g);
    renderGame();
    guide.onState();
  }

  function toastNewLog(g) {
    const fresh = g.log.filter(l => l.n > app.lastLogN);
    const first = app.lastLogN < 0;
    app.lastLogN = g.log.length ? g.log[g.log.length - 1].n : 0;
    if (first) return;
    if (fresh.some(l => /行動不能になり/.test(l.t))) SnowSound.play('collapse');
    if (fresh.some(l => /壊れた/.test(l.t))) SnowSound.play('crack');
    const imp = fresh.filter(l => /行動不能|壊れた|クリア|ゲームオーバー|育って|投票|復帰|戻って|切れ|ラウンド/.test(l.t));
    if (imp.length) mapToast(imp[imp.length - 1].t, /行動不能|壊れた|ゲームオーバー/.test(imp[imp.length - 1].t) ? 'bad' : '');
  }

  // ---------- 手番・ラウンドのお知らせ ----------

  const bannerQ = [];
  let bannerBusy = false;
  function banner(title, sub, tone, sfx) {
    bannerQ.push({ title, sub, tone, sfx });
    if (!bannerBusy) nextBanner();
  }
  function nextBanner() {
    const b = bannerQ.shift(), el = $('#banner');
    if (!b) { bannerBusy = false; el.hidden = true; return; }
    bannerBusy = true;
    el.className = 'banner ' + (b.tone || '');
    el.innerHTML = `<b>${esc(b.title)}</b><span>${esc(b.sub)}</span>`;
    el.hidden = false;
    el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
    (b.sfx || []).forEach((n, i) => setTimeout(() => SnowSound.play(n), i * 450));
    setTimeout(nextBanner, 1900);
  }
  // 手番が変わったとき・ラウンドが変わったときに、画面の中央でお知らせする
  function announce(g) {
    if (g.phase !== 'play') {
      if (app.over !== g.phase) { app.over = g.phase; SnowSound.play(g.phase === 'won' ? 'win' : 'lose'); }
      return;
    }
    const key = tkey(g);
    if (app.turnKey === key) return;
    const roundChanged = app.annRound !== g.round;
    app.turnKey = key; app.annRound = g.round;
    if (roundChanged) {
      const fin = g.round > g.prep, storm = g.weather === 'storm';
      banner(fin ? `最終猛吹雪 ${g.round - g.prep} / ${g.fin}` : `ラウンド ${g.round}`,
        `${fin ? '' : `準備期間 ${g.round} / ${g.prep}　`}天候：${E.WEATHER_NAMES[g.weather]}（${FX[g.weather]}）`, storm ? 'storm' : 'round', storm ? ['round', 'storm'] : ['round']);
    }
    if (!E.simul(g) && E.cur(g).id === app.me) banner('あなたの手番です', `行動力 ${R.maxAp}`, 'turn', ['turn']);
  }

  // 持ち物のアイコンをクリックして出る、操作のボタン（食べる・着ける・捨てる投票）
  function renderItemPop(g, th) {
    const el = $('#itempop'), ip = app.itemPop;
    if (!ip || !g) { el.hidden = true; return; }
    const btn = (label, action, r) => `<button class="ip-btn" data-ip="${action}" ${r.ok ? '' : 'disabled'}>${esc(label)}</button>${r.ok ? '' : `<div class="ip-why">${esc(r.why)}</div>`}`;
    let html = '';
    if (ip.k) {
      const k = ip.k, n = g.items[k];
      if (!n) { app.itemPop = null; el.hidden = true; return; }
      const c = th.item[k];
      html = `<div class="ip-head"><span class="ovr-ico" style="background:${c[0]};color:${c[1]}">${B.svgIcon(iconOf(k), 20)}</span><b>${E.ITEM_NAMES[k]}</b><span class="muted">所持 ${n}個</span><button class="x" data-ip="close" aria-label="閉じる">×</button></div>
        <div class="small">${esc(IDESC[k])}</div>`;
      if (R.eat[k]) html += btn(`食べる（満腹度 +${R.eat[k]}・行動力0）`, 'eat', probe({ type: 'eat', k }));
      html += btn('捨てる（みんなで投票）', 'vote', probe({ type: 'vote', k }));
    } else {
      const x = g.gear.find(q => q.id === ip.gear);
      if (!x) { app.itemPop = null; el.hidden = true; return; }
      const d = E.GEAR[x.k], me = myP(), cur = me && (d.slot === 'gear' ? me.gear : me.tool);
      html = `<div class="ip-head"><span class="ovr-ico" style="background:var(--accBg);color:var(--accent)">${B.svgIcon(x.k, 20)}</span><b>${esc(d.name)}</b><span class="muted">${x.dur ? `耐久 ${x.dur}` : ''}</span><button class="x" data-ip="close" aria-label="閉じる">×</button></div>
        <div class="small">${esc(d.desc)}。${d.slot === 'gear' ? '装備' : '道具'}の枠は1つです。</div>`;
      html += btn(cur ? `着ける（${E.GEAR[cur.k].name}を外す・行動力1）` : '着ける（行動力0）', 'equip', probe({ type: 'equip', id: x.id }));
    }
    el.innerHTML = html;
    el.hidden = false;
    const at = app.itemPopAt || { x: window.innerWidth - 320, y: 120 };
    el.style.left = Math.max(8, at.x - 282) + 'px';
    el.style.top = Math.max(8, Math.min(at.y, window.innerHeight - el.offsetHeight - 8)) + 'px';
  }

  // このまま手番を終えたときの予測
  function renderEndProj(g) {
    const el = $('#endproj');
    if (!myTurn()) { el.hidden = true; return; }
    const e = E.endProjection(g, app.me);
    el.hidden = false;
    const place = { fire: '焚き火の上', warm: '防寒の中', out: '屋外' }[e.place];
    const wn = E.WEATHER_NAMES[g.weather];
    const cls = (v, lim) => (v <= lim ? 'bad' : '');
    el.innerHTML = `<b class="t">このまま${E.simul(g) ? '行動を終える' : '手番を終える'}と</b>
      <div class="ep-row"><span class="k">満腹度</span><span class="v ${cls(e.food, 0)}">${e.food0} → ${e.food}</span><span class="n">−${e.hunger}</span></div>
      <div class="ep-row"><span class="k">体温</span><span class="v ${cls(e.temp, 2)}">${e.temp0} → ${e.temp}</span><span class="n">−${e.loss}（${place}・${wn}）</span></div>
      <div class="ep-row"><span class="k">火力</span><span class="v">${e.fire0} → ${e.fire}</span><span class="n">−${e.fireLoss}</span></div>
      ${e.fireOutNext ? `<div class="${e.fireLose ? 'warnbox' : 'ep-row bad'}">${e.fireLose ? '焚き火が消えたまま手番を終えると、敗北します！ 先に焚べましょう' : `焚き火が消えたままです（終えると ${e.fireOutNext} / ${R.fireOutLimit}）`}</div>` : ''}
      ${e.collapse ? `<div class="warnbox">${e.temp <= 0 && e.food <= 0 ? '体温と満腹度が0になり' : e.temp <= 0 ? '体温が0になり' : '満腹度が0になり'}、行動不能になります！</div>` : ''}`;
  }

  // 手番の制限時間の表示
  function updateTimer() {
    const chip = $('#chip-turn'), g = app.game;
    if (!g || !app.room) return;
    const base = chip.dataset.base || '';
    let left = app.room.turnLeft;
    if (left != null) left = Math.max(0, left - (Date.now() - app.roomAt));
    const secs = left == null ? null : Math.ceil(left / 1000);
    chip.classList.toggle('timer', secs != null);
    chip.classList.toggle('low', secs != null && secs <= 10);
    chip.textContent = secs == null ? base : `${base}　残り ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if (secs != null && secs <= 10 && myTurn() && app.warnedKey !== tkey(g)) { app.warnedKey = tkey(g); SnowSound.play('warn'); }
  }

  // 上限を超えたアイテム：既存の物を捨てて持つか、新しい物をあきらめるかを選ぶ
  function renderOverflow(g, th) {
    const el = $('#overflow'), note = $('#ovr-note');
    const pd = (g.pending || []).find(q => q.pid === app.me);        // 選ぶ必要があるのは、持ち主だけ（ほかの人は、そのまま行動できる）
    const others = (g.pending || []).filter(q => q.pid !== app.me).map(q => (g.players.find(p => p.id === q.pid) || {}).name).filter(Boolean);
    note.hidden = !others.length || !!pd;
    if (others.length) note.textContent = `${others.length > 2 ? others.slice(0, 2).join('・') + `ほか${others.length - 2}人` : others.join('・')}が、持ち物の入れ替えを選んでいます`;
    if (!pd) { el.hidden = true; app.ovrKey = null; return; }
    const key = pd.k + ':' + pd.n + ':' + g.pending.length;
    if (app.ovrKey !== key) { app.ovrKey = key; app.ovrDrop = {}; }
    const drop = app.ovrDrop, total = Object.values(drop).reduce((a, b) => a + b, 0);
    const rows = E.ITEMS.filter(k => k !== pd.k && g.items[k] > 0).map(k => {
      const c = th.item[k], n = drop[k] || 0;
      return `<div class="ovr-row"><span class="ovr-ico" style="background:${c[0]};color:${c[1]}">${B.svgIcon(iconOf(k), 20)}</span><span class="grow">${E.ITEM_NAMES[k]}（${g.items[k]}個）</span>
        <button data-ovr="${k}:-1" ${n < 1 ? 'disabled' : ''}>−</button><b class="ovr-n">${n}</b><button data-ovr="${k}:1" ${n >= g.items[k] || total >= pd.n ? 'disabled' : ''}>＋</button></div>`;
    }).join('');
    const nc = th.item[pd.k];
    el.hidden = false;
    el.innerHTML = `<div class="card ovr-card">
      <h3 style="margin:0">持ち物がいっぱいです（${E.total(g)} / ${E.cap(g)}）</h3>
      <div class="ovr-new"><span class="ovr-ico" style="background:${nc[0]};color:${nc[1]}">${B.svgIcon(iconOf(pd.k), 22)}</span><b>${E.ITEM_NAMES[pd.k]} ×${pd.n}</b> が入りません</div>
      <div class="small muted">持っている物を捨てて入れ替えるか、新しく得た物を捨てるかを選んでください。捨てる数（最大${pd.n}個）：</div>
      ${rows || '<div class="small muted">入れ替えられる持ち物がありません</div>'}
      <div class="row">
        <button class="primary" data-ovr-ok ${total ? '' : 'disabled'}>入れ替えて持つ（${total}個）</button>
        <button data-ovr-skip>${E.ITEM_NAMES[pd.k]}を捨てる</button>
      </div></div>`;
  }

  // 猛吹雪（最終3ラウンド）を生き延びるのに必要な食料
  function renderFoodNeed(g) {
    const el = $('#food-need'), f = E.foodNeed(g);
    if (g.phase !== 'play') { el.hidden = true; return; }
    el.hidden = false;
    const meats = Math.ceil(f.short / R.eat.meat);
    const what = f.final ? `残り${f.turns}回の手番の終わりごとに−${R.hunger}。いまの満腹度を引いた分` : `${g.players.length}人 × ${g.fin}ラウンド × −${R.hunger}`;
    el.innerHTML = `<b>最終猛吹雪を生き延びるのに必要な食料</b><div><b>${f.need}</b>（満腹度ぶん。${what}）</div>
      <div>持ち物の食料：<b>${f.have}</b>　${f.short > 0 ? `<span style="color:var(--redFg);font-weight:700">不足 ${f.short}（肉なら約${meats}個）</span>` : '<span style="color:var(--ok);font-weight:700">足りています</span>'}</div>`;
  }

  // 行動力がなくなったら、手番を終えるよう促す
  function renderEndPop(g) {
    const el = $('#endpop'), me = myP();
    const key = tkey(g);
    const show = !!(myTurn() && me && me.ap === 0 && app.endPopDismiss !== key && !app.card);
    if (show === !el.hidden) return;
    el.hidden = !show;
    if (show) {
      const pj = E.endProjection(g, app.me);
      const warn = pj && pj.fireLose ? '<span style="color:var(--redFg);font-weight:700">焚き火が消えたまま終えると敗北します！ 先に焚べましょう</span>' : (pj && pj.collapse ? '<span style="color:var(--redFg);font-weight:700">このまま終えると行動不能になります！ 食べる・温まる・焚き火へ移動を先に</span>' : '');
      el.innerHTML = '<b>行動力がなくなりました</b><span>手番を終えますか？（移動や食べるは、まだできます）</span>' + warn + '<div><button class="primary" data-endpop-end>手番を終える</button><button data-endpop-close>あとで</button></div>';
      SnowSound.play('warn');
    }
  }

  // ---------- トップ・ロビー ----------

  function enterRoom(type) {
    const name = $('#in-name').value.trim() || 'ゲスト';
    store.set('name', name);
    const msg = $('#top-msg');
    msg.hidden = true;
    if (type === 'join') {
      const code = $('#in-code').value.trim().toUpperCase();
      if (!code) { msg.textContent = '部屋IDを入れてください'; msg.hidden = false; return; }
      app.conn = new GuestTransport({ type: 'join', token: token(), name, code, v: E.VERSION });
    } else if (type === 'create') {
      app.conn = new HostTransport(name);
    } else if (type === 'tutorial') {
      guide.start();
      app.conn = new LocalTransport(name, { tutorial: true });
    } else {
      app.conn = new LocalTransport(name);
    }
    $('#btn-create').disabled = $('#btn-join').disabled = $('#btn-local').disabled = $('#btn-tutorial').disabled = true;
    if (app.conn.isLocal) { app.conn.room.broadcast(); }
  }

  function leaveRoom(text) {
    if (guide) guide.stop();
    $('#movein').hidden = true; $('#movereq').hidden = true;
    if (app.conn) { app.conn.close(); app.conn = null; }
    app.room = null; app.game = null; app.me = null; app.gameKey = null; app.styleSent = false;
    $('#result').hidden = true;
    setReconnecting(false);
    const url = new URL(location.href);
    url.searchParams.delete('room');
    history.replaceState(null, '', url);
    show('top');
    $('#btn-create').disabled = $('#btn-join').disabled = $('#btn-local').disabled = $('#btn-tutorial').disabled = false;
    const msg = $('#top-msg');
    msg.textContent = text || '';
    msg.hidden = !text;
  }

  function renderLobby() {
    const r = app.room, host = r.hostId === app.me, local = !r.code;
    $('#lobby-online').hidden = local;
    $('#lobby-local').hidden = !local;
    $('#lobby-code').textContent = r.code || '';
    const url = new URL(location.href);
    url.search = ''; url.hash = '';
    if (r.code) url.searchParams.set('room', r.code);
    $('#invite-url').value = url.toString();
    $('#host-warn').hidden = !(host && !local);
    $('#lobby-count').textContent = `${r.players.length} / ${r.max}人`;
    $('#lobby-players').innerHTML = r.players.map((p, i) => `<li>
        ${pawnIco(p, 24)}
        <span class="name">${esc(p.name)}</span>
        ${p.id === r.hostId ? '<span class="tag">ホスト</span>' : ''}${p.cpu ? '<span class="tag">CPU</span>' : ''}${p.id === app.me ? '<span class="tag">あなた</span>' : ''}
        ${host && p.cpu ? `<button data-rm-cpu="${p.id}">外す</button>` : ''}
      </li>`).join('');
    const mine = r.players.find(p => p.id === app.me);
    if (mine && !app.styleSent) {
      app.styleSent = true;
      const sh = store.get('shape'), co = store.get('color');
      if (sh && sh !== mine.shape) send({ type: 'style', shape: sh });
      if (co && co !== mine.color && !r.players.some(p => p !== mine && p.color === co && p.shape === (sh || mine.shape)) && B.PLAYER_COLORS[co]) send({ type: 'style', color: co });
    }
    $('#style-box').hidden = !mine;
    if (mine) {
      $('#style-shapes').innerHTML = Object.keys(B.SHAPE_NAMES).map(k => `<button class="sty ${mine.shape === k ? 'on' : ''}" data-shape="${k}" ${r.players.some(p => p !== mine && p.color === mine.color && p.shape === k) ? 'disabled' : ''} title="${B.SHAPE_NAMES[k]}" aria-label="${B.SHAPE_NAMES[k]}">${B.shapeSvg(k, mine.color, 26)}</button>`).join('');
      $('#style-colors').innerHTML = Object.keys(B.PLAYER_COLORS).map(k => {
        const taken = r.players.some(p => p !== mine && p.color === k && p.shape === mine.shape);
        return `<button class="sw ${mine.color === k ? 'on' : ''}" data-color="${k}" ${taken ? 'disabled' : ''} title="${B.COLOR_NAMES[k]}${taken ? '（この形では使用中）' : ''}" aria-label="${B.COLOR_NAMES[k]}" style="background:${B.PLAYER_COLORS[k]}"></button>`;
      }).join('');
    }
    $('#btn-add-cpu').hidden = !host || r.players.length >= r.max;
    const sim = !r.settings || r.settings.simul !== false;
    $('#opt-simul').checked = sim; $('#opt-simul').disabled = !host;
    $('#lobby-opt span').textContent = host ? '全員が同時に動く（オフなら、1人ずつ順番に動く）' : (sim ? '全員が同時に動きます' : '1人ずつ順番に動きます');
    $('#btn-start').hidden = !host;
    $('#btn-start').disabled = r.players.length < r.min;
    $('#lobby-hint').textContent = r.players.length < r.min
      ? `あと${r.min - r.players.length}人（CPUでもOK）で始められます。人数は${r.min}〜${r.max}人です。`
      : (host ? '「ゲーム開始」を押すと始まります。' : 'ホストがゲームを始めるのを待っています…');
    $('#btn-leave').textContent = local ? 'やめる' : '部屋を出る';
  }

  // ---------- ゲーム画面 ----------

  const FX = { clear: '補正なし', snow: '体温低下 +1', blizzard: '体温低下 +2', rain: '焚き火の火力低下 +1', storm: '体温低下 +4・建物HP減少' };
  const DESC = {
    fire: { name: '焚き火', tip: '上で温まると火力ぶん回復。薪を焚べると火力+1。', desc: '唯一の本格的な暖房。上に立って「温まる」と、火力の値だけ体温が回復する。',
      eff: ['焚き火の上の体温低下は 0＋天候補正（軽減なし）', `温まる：行動力${R.ap.warm}、火力の値だけ体温回復`, `焚べる：行動力${R.ap.stoke}＋木材1 → 火力+1（最大${R.fireMax}）`], build: '最初からある', repair: '壊れない' },
    bridge: { name: '橋', tip: '川にだけ建てられる。木材1。道と同じように歩ける。', desc: '川の上にかける橋。道と同じ扱い（建物の仲間・体温が減らない・壊れない）。橋の上には、ほかの建物を建てて上書きできる。',
      eff: ['川にだけ建てられる', '建物の仲間として扱われ、橋から1マス以内に移動できる', '橋の上には、ほかの建物を建てられる（上書き）'], build: null, repair: '壊れない' },
    road: { name: '道', tip: '雪1個で作れる最小の建物。移動できる範囲が広がる。', desc: '雪1個で作れる最小の建物。建物の仲間として扱われ、道から1マス以内に移動できる。',
      eff: ['道・建物の上に入るときは体温が減らない', '隣り合う道は一つにつながって表示される'], build: null, repair: '壊れない' },
    igloo: { name: 'かまくら', tip: '防寒施設。中では体温低下が軽くなる。', desc: '雪で作る防寒施設。',
      eff: ['体温低下 -1＋天候補正（補正は最大2まで軽減）', '温まる回復量 +1', 'HPが半分以下になると防寒が消える'], build: null, repair: null },
    storage: { name: '倉庫', tip: '防寒施設。共有アイテムの上限が+10される。', desc: '大きな防寒施設。',
      eff: ['共有アイテムの上限 +10', '防寒効果はかまくらと同じ'], build: null, repair: null },
    tower: { name: '見張り台', tip: '1ラウンド先の天候予報が見え、ここから2マス以内に移動できる。', desc: '高い場所から先を見渡す。屋外扱いで防寒はない。',
      eff: ['1ラウンド先の天候の予報が見える', '見張り台からは2マス以内に移動できる（ほかの建物は1マス）'], build: null, repair: null },
    workshop: { name: '作業場', tip: '上かすぐ隣で「作る」と、薪・防寒着・道具が作れる。', desc: '薪を割ったり、毛皮や木材から防寒着や道具を作る作業台。屋外扱いで防寒はなく、猛吹雪ではHPが減る。',
      eff: ['作る：木材1 → 薪2', '作る：毛皮3 → 防寒着', '作る：木材1・石材1・毛皮1 → 斧・ツルハシ・シャベル・槍、木材1・石材3 → 弓、木材1・石材1 → 釣り竿', '薪は焚べるときに、木材より先に使われる'], build: null, repair: null },
  };
  const IDESC = {
    wood: '焚き火に焚べると火力+1。倉庫・見張り台の建設に使う。',
    stone: '建物の修理に使う（1個でHP+2）。倉庫・見張り台の建設に使う。',
    veg: '食べると満腹度+2。2個で野菜の苗を植えられる。',
    meat: '食べると満腹度+3。',
    fish: '食べると満腹度+3。川で、釣り竿で釣れる。焚き火で焼き魚にできる。',
    grilled: '食べると満腹度+5。焚き火で、魚1から作れる。',
    snow: 'かまくら・道の建設に使う。雪原で資源を集めると1個ついてくる。',
    sapling: '植えると樹木の苗になる。木を集めたとき50%で落ちる。',
    firewood: '焚べると火力+1。木材より先に使われる。作業場で、木材1から2本作れる。',
    fur: '動物が落とす（1〜5個）。作業場で、防寒着（3個）や道具（1個）の材料になる。',
    steak: '食べると満腹度+5。焚き火で、肉1から作れる。',
    soup: '食べると満腹度+2。焚き火で、野菜2と雪1から3個作れる。',
  };
  const costText = d => '行動力' + d.ap + '・' + Object.keys(d.cost).map(k => E.ITEM_NAMES[k] + d.cost[k]).join(' ');
  const iconOf = k => B.ITEM_ICON[k];

  function renderGame() {
    const g = app.game, th = TH();
    renderBar(g);
    renderPlayers(g, th);
    renderItems(g, th);
    renderVote(g, th);
    renderDetail(g, th);
    renderDrawBox(g);
    renderTray(g, th);
    renderMenu(g, th);
    renderWeather(g, th);
    renderResult(g);
    renderEndPop(g);
    renderOverflow(g, th);
    renderFoodNeed(g);
    renderEndProj(g);
    renderItemPop(g, th);
    updateTimer();
    renderHint();
    board.request();
  }

  function renderBar(g) {
    const r = g.round, fin = r > g.prep;
    $('#chip-round').textContent = fin ? `最終猛吹雪 ${r - g.prep} / ${g.fin}` : `ラウンド ${r} / ${g.prep}（準備）`;
    $('#chip-final').textContent = fin ? `あと${g.total - r + 1}ラウンドで クリア` : `猛吹雪まで あと${g.prep - r + 1}ラウンド`;
    const fore = $('#chip-fore');
    fore.hidden = !E.hasTower(g);
    fore.textContent = g.next ? `予報：次は${E.WEATHER_NAMES[g.next]}` : '予報：最後のラウンド';
    const fc = $('#chip-fire');
    const nf = E.fires(g).length, out = E.fires(g).filter(b => b.fire <= 0).length;
    fc.hidden = !(g.phase === 'play' && (g.fireOut > 0 || out > 0));
    fc.textContent = nf > 1 && !E.allFiresOut(g) ? `焚き火が消えています ${out} / ${nf}` : `焚き火が消えています ${g.fireOut} / ${R.fireOutLimit}`;
    fc.title = `すべての焚き火が火力0のままラウンドが終わるのが${R.fireOutLimit}回続くと敗北です。薪を焚べて火を点けましょう`;
    const doneN = g.players.filter(q => q.done).length;
    if (g.phase === 'play' && E.simul(g)) $('#chip-turn').dataset.base = `全員が行動中（終了 ${doneN} / ${g.players.length}）`;
    else { const c = E.cur(g); $('#chip-turn').dataset.base = g.phase === 'play' ? `手番：${c.name}${c.id === app.me ? '（あなた）' : ''}` : (g.phase === 'won' ? 'クリア' : 'ゲームオーバー'); }
    if (g.phase !== 'play') $('#chip-turn').dataset.base = g.phase === 'won' ? 'クリア' : 'ゲームオーバー';
    $('#weather').innerHTML = `現在の天候：<b>${E.WEATHER_NAMES[g.weather]}</b>（${FX[g.weather]}）`;
    $('#btn-endturn').disabled = !myTurn();
    $('#btn-endturn').textContent = E.simul(g) ? (myTurn() ? '行動を終える' : '他の人を待っています') : (myTurn() ? '手番を終える' : '手番を待っています');
    const logPop = $('#log-pop');
    if (!logPop.hidden) logPop.innerHTML = logHtml(g);
  }
  const logHtml = g => g.log.slice().reverse().slice(0, 50).map(l => `<div><span>R${l.r}</span>${esc(l.t)}</div>`).join('');

  // 着けている装備・道具（道具は残りの耐久度つき）
  const wornIcons = p => [p.gear, p.tool].filter(Boolean).map(x => `<span class="worn" title="${esc(E.GEAR[x.k].name)}：${esc(E.GEAR[x.k].desc)}${x.dur ? `（残り${x.dur}）` : ''}">${B.svgIcon(x.k, 15)}${x.dur ? `<small>${x.dur}</small>` : ''}</span>`).join('');
  function mini(label, v, pct, color, fg, cls) {
    return `<div class="ms ${cls || ''}"><span class="k">${label}</span><span class="tr"><i style="width:${pct}%;background:${color}"></i></span><b style="color:${fg}">${v}</b></div>`;
  }
  function renderPlayers(g, th) {
    $('#players').innerHTML = g.players.map(p => {
      const sim = E.simul(g);
      const turn = g.phase === 'play' && (sim ? !p.done : E.cur(g).id === p.id);
      const me = p.id === app.me;
      const tags = [
        p.cpu ? '<span class="badge gray">CPU</span>' : '',
        p.away ? '<span class="badge red">切断中</span>' : '',
        p.down === 1 ? '<span class="badge red">行動不能</span>' : p.down === 2 ? '<span class="badge red">復帰中</span>' : '',
        g.phase === 'play' && sim ? (p.done ? '<span class="badge gray">終了</span>' : '') : (turn ? '<span class="badge">手番中</span>' : ''),
      ].join('');
      if (g.players.length > 6 && !me) {          // 大人数：ほかの人は1行に詰める
        return `<div class="pcard compact">${pawnIco(p, 16)}<span class="pn">${esc(p.name)}</span>${wornIcons(p)}<span class="grow"></span>${tags}
          <span class="cmp ${p.temp <= 3 ? 'low' : ''}" title="体温">体${p.temp}</span><span class="cmp ${p.food <= 3 ? 'low' : ''}" title="満腹度">満${p.food}</span></div>`;
      }
      return `<div class="pcard ${me ? 'me' : ''}">
        <div class="phead">${pawnIco(p, 20)}<span class="pn">${esc(p.name)}${me ? '（あなた）' : ''}</span>${wornIcons(p)}<span class="grow"></span>${tags}</div>
        <div class="pstats">
          ${mini('体温', p.temp, p.temp * 10, p.temp <= 3 ? th.tempLow : th.temp, p.temp <= 3 ? th.redFg : 'var(--text)')}
          ${mini('満腹', p.food, p.food * 10, p.food <= 3 ? th.foodLow : th.food, p.food <= 3 ? th.redFg : 'var(--text)')}
          ${turn && (!sim || me) ? mini('行動力', p.ap, Math.round(p.ap / R.maxAp * 100), 'var(--ap)', 'var(--text)', 'ap') : ''}
        </div>
      </div>`;
    }).join('');
  }

  function renderItems(g, th) {
    const cap = E.cap(g), tot = E.total(g);
    const capEl = $('#cap');
    capEl.textContent = `${tot} / ${cap}`;
    capEl.className = tot >= cap ? 'full' : '';
    let html = '';
    for (const k of E.ITEMS) {
      const c = th.item[k];
      for (let i = 0; i < g.items[k]; i++) {
        html += `<button class="slot" data-item="${k}" aria-label="${E.ITEM_NAMES[k]}：クリックで操作" style="background:${c[0]};color:${c[1]};border-color:${c[1]}66">${B.svgIcon(iconOf(k), 18)}</button>`;
      }
    }
    for (const x of g.gear) {
      const d = E.GEAR[x.k];
      html += `<button class="slot gear" data-gear="${x.id}" title="${esc(d.name)}${x.dur ? `（耐久${x.dur}）` : ''}：${esc(d.desc)}。クリックで「着ける」" style="color:var(--accent)">${B.svgIcon(x.k, 18)}</button>`;
    }
    for (let i = tot; i < cap; i++) html += '<div class="slot"></div>';
    $('#slots').innerHTML = html;
    $('#item-summary').textContent = E.ITEMS.filter(k => g.items[k] > 0).map(k => E.ITEM_NAMES[k] + g.items[k]).concat(g.gear.map(x => E.GEAR[x.k].name)).join('　') || 'なし';
  }

  function renderVote(g, th) {
    const el = $('#vote');
    const v = g.vote;
    el.hidden = !v;
    if (!v) return;
    const rows = g.players.map(p => {
      const x = v.v[p.id] || 0;
      const st = x > 0 ? '賛成' : x < 0 ? '反対' : (p.away ? '反対（切断中）' : '未投票');
      const col = x > 0 ? th.ok : (x < 0 || p.away) ? th.redFg : 'var(--muted)';
      const can = p.id === app.me && !x;
      return `<div class="vr"><span class="n">${esc(p.name)}</span><b style="color:${col}">${st}</b>${can ? '<button data-vote="1">賛成</button><button data-vote="-1">反対</button>' : ''}</div>`;
    }).join('');
    el.innerHTML = `<b style="font-size:13px">「${E.ITEM_NAMES[v.k]}」を1個捨てる投票</b>${rows}
      <div class="vr"><span class="n small muted">過半数の賛成で捨てます。反対が半数以上で否決。</span>${v.by === app.me ? '<button data-vote-cancel>取り下げ</button>' : ''}</div>`;
  }

  function probe(a) { return E.act(clone(app.game), app.me, a); }

  function renderDetail(g, th) {
    const el = $('#detail');
    const b = g.b.find(x => x.id === app.sel);
    if (!b) {
      el.innerHTML = '<div class="small muted" style="font-weight:700">建物の詳細（建物をクリック）</div><div class="muted" style="line-height:1.6">建物をクリックすると、説明・効果・建設と修理のコストがここに表示されます。</div>';
      return;
    }
    const d = DESC[b.t], bd = E.BUILD[b.t], warm = b.t === 'igloo' || b.t === 'storage', ins = E.insul(b);
    const meta = [['サイズ', `${b.w}×${b.h}`]];
    let status = '', chip = null;
    if (b.t === 'fire') { meta.push(['火力', `${b.fire} / ${R.fireMax}`]); status = '壊れない'; chip = th.chip.fire; }
    else if (E.isPath(b.t)) { status = '壊れない'; chip = ['var(--chip)', 'var(--muted2)']; }
    else {
      meta.push(['HP', `${b.hp} / ${b.max}`]);
      if (warm) { status = ins ? '防寒 有効' : '防寒 消失'; chip = ins ? th.chip.ok : th.chip.lost; meta.push(['防寒', ins ? '有効' : '消失（HPが半分以下）']); }
    }
    const build = d.build || costText(bd);
    const repair = d.repair || `行動力${b.w}＋石材${E.repairStone(b)} → HP+${R.repairHp}`;
    let btn = '';
    if (b.hp !== null) {
      const r = myTurn() ? probe({ type: 'repair', id: b.id }) : { ok: false, why: '自分の手番ではありません' };
      btn = `<button class="rep" data-repair="${b.id}" ${r.ok ? '' : 'disabled'} title="${esc(r.ok ? '' : r.why)}">直す（行動力${b.w}・石材${E.repairStone(b)}）</button>${r.ok ? '' : `<div class="small muted">${esc(r.why)}</div>`}`;
    }
    el.innerHTML = `<div class="dn">${esc(d.name)}${status ? `<span class="sec-chip" style="background:${chip[0]};color:${chip[1]}">${status}</span>` : ''}</div>
      <div class="meta">${meta.map(m => `<div><span>${m[0]}</span><span>${m[1]}</span></div>`).join('')}</div>
      <div style="line-height:1.65;margin-top:6px">${esc(d.desc)}</div>
      <div class="sec">効果</div>${d.eff.map(t => `<div class="ef">${esc(t)}</div>`).join('')}
      <div class="sec">コスト</div><div>建設：${esc(build)}</div><div>修理：${esc(repair)}</div>${btn}`;
  }

  function renderDrawBox(g) {
    const inDraw = app.mode === 'draw', th = TH();
    const t = $('#btn-draw');
    t.textContent = inDraw ? 'お絵かきモード：ON' : 'お絵かきモード';
    t.style.background = inDraw ? 'var(--accBg)' : 'var(--btn)';
    t.style.borderColor = inDraw ? 'var(--accent)' : 'var(--bb)';
    const tool = (id, label, sw, on) => `<button data-tool="${id}" style="background:${on ? 'var(--accBg)' : 'var(--btn)'};border-color:${on ? 'var(--accent)' : 'var(--bb)'}"><i style="background:${sw}"></i>${label}</button>`;
    $('#draw-tools').innerHTML = inDraw ? [
      tool('pen', 'ペン', th.text, app.tool === 'pen'), tool('eraser', '消しゴム', th.panel, app.tool === 'eraser'),
      tool('a', '青', th.penA, app.color === 'a' && app.tool === 'pen'), tool('b', '灰', th.penB, app.color === 'b' && app.tool === 'pen'),
    ].join('') : '';
    $('#draw-hint').textContent = inDraw ? 'お絵かき中は行動できません（手番が来ると自動で戻ります）' : '手番でないとき、雪原のマスに絵を描ける（ゲームには影響しません）';
  }
  function setMode(m) {
    app.mode = m; app.menu = false;
    if (board) board.setMode(m);
    if (app.game) { renderDrawBox(app.game); renderMenu(app.game, TH()); renderHint(); }
  }

  function renderHint() {
    const el = $('#hint');
    let t = '駒をドラッグで移動／駒クリックで行動／背景ドラッグで視点移動／ホイールで拡大縮小';
    if (app.mode === 'draw') t = 'ドラッグで描く。他の人の絵も編集できる';
    else if (app.armed) t = `建設モード（${E.BUILD[app.armed].name}）：マップをクリックで置く／Escか右クリックで解除`;
    else if (board && board.state.drag) t = '離したマスへ移動します';
    el.textContent = t;
    $('#z-pct').textContent = Math.round((board ? board.state.cam.z : 1) * 100) + '%';
  }

  // 建設カード／レシピ（「建てる」「作る」で共用）
  function renderTray(g, th) {
    const mode = app.tray === 'craft' ? 'craft' : 'build';
    $$('[data-tray]').forEach(b => b.classList.toggle('on', b.dataset.tray === mode));
    const el = $('#tray');
    const me = myP();
    if (mode === 'craft') {
      const card = k => {
        const rc = E.RECIPES[k], lack = E.lacking(g, rc.in);
        const nIn = Object.values(rc.in).reduce((a, b) => a + b, 0), nOut = rc.gear ? 1 : Object.values(rc.out).reduce((a, b) => a + b, 0);
        const why = !myTurn() ? '自分の手番ではありません' : me.down === 2 ? '復帰中は作れません'
          : !E.nearStation(g, me, rc.station) ? `${E.STATION_NAMES[rc.station]}の上かすぐ隣で` : me.ap < rc.ap ? '行動力が足りません'
          : lack ? E.ITEM_NAMES[lack] + 'が足りません' : nOut - nIn > E.room(g) ? '持ち物がいっぱいです' : '';
        const c = th.card[rc.station === 'fire' ? 'fire' : 'workshop'];
        return `<div class="bcard" data-recipe="${k}" data-why="${esc(why)}" style="border-color:${c[1]};background:${c[0]};color:${c[2]};opacity:${why ? .55 : 1};cursor:${why ? 'not-allowed' : 'pointer'}">
          <b>${esc(rc.name)}</b><span style="color:${why ? th.redFg : 'inherit'}">${esc(why || recipeText(rc))}</span></div>`;
      };
      const group = st => `<div class="small muted" style="font-weight:700;margin-top:4px">${E.STATION_NAMES[st]}で作る${g.b.some(b => b.t === st) ? '' : '（まだありません）'}</div>` + Object.keys(E.RECIPES).filter(k => E.RECIPES[k].station === st).map(card).join('');
      el.innerHTML = '<div class="small muted" style="line-height:1.5">レシピをクリックすると作ります（焚き火・作業場の上かすぐ隣で）。</div>' + group('fire') + group('workshop');
      return;
    }
    const cards = ['road', 'bridge', 'igloo', 'storage', 'tower', 'workshop'].map(k => {
      const d = E.BUILD[k], c = th.card[E.isPath(k) ? 'storage' : k], isR = E.isPath(k), rBd = k === 'bridge' ? th.bridgeBd : th.roadBd, rBg = k === 'bridge' ? th.bridge : th.road;
      const lack = E.lacking(g, d.cost);
      const why = !myTurn() ? '自分の手番ではありません' : me.down === 2 ? '復帰中は建てられません' : me.ap < d.ap ? '行動力が足りません' : lack ? E.ITEM_NAMES[lack] + 'が足りません' : '';
      return `<div class="bcard ${app.armed === k ? 'armed' : ''}" data-card="${k}" data-why="${esc(why)}" style="border-color:${isR ? rBd : c[1]};background:${isR ? rBg : c[0]};color:${isR ? 'var(--text)' : c[2]};opacity:${why ? .55 : 1};cursor:${why ? 'not-allowed' : 'grab'}">
        <b>${d.name}（${d.size}×${d.size}）</b><span style="color:${why ? th.redFg : 'inherit'}">${esc(why || costText(d))}</span></div>`;
    }).join('');
    el.innerHTML = '<div class="small muted" style="line-height:1.5">カードを盤面へドラッグして置くか、クリックで選んでマップをクリックすると建設します（選んだままなら続けて置けます）。</div>' + cards;
  }
  const recipeText = rc => `行動力${rc.ap}・${Object.keys(rc.in).map(k => E.ITEM_NAMES[k] + rc.in[k]).join('・')} → ${rc.gear ? E.GEAR[rc.gear].name : Object.keys(rc.out).map(k => E.ITEM_NAMES[k] + rc.out[k]).join('・')}`;

  // 駒のメニュー
  function renderMenu(g, th) {
    const el = $('#menu');
    const me = myP();
    if (!app.menu || !me || app.mode === 'draw' || (board && board.state.drag)) { el.hidden = true; return; }
    const it = g.items, here = E.bAt(g, me.x, me.y), res = E.resAt(g, me.x, me.y);
    const entries = [];
    let head = '行動';
    const add = (label, cost, a, fn) => {
      const r = a ? probe(a) : { ok: true };
      const why = r.ok ? '' : r.why;
      entries.push({ label, cost: why || cost, ok: !why, a, fn, head });
      head = '';
    };
    const w = E.where(g, me);
    add('温まる', `行動力${R.ap.warm}・` + (w.kind === 'fire' ? `火力${w.b.fire}ぶん回復` : w.kind === 'warm' ? '回復 +1' : 'ここでは回復0'), { type: 'warm' });
    if (E.nearFire(g, me)) add('焚べる', `行動力${R.ap.stoke}・薪（なければ木材）1`, { type: 'stoke' });
    if (res) add('集める', `行動力${R.ap.collect}`, { type: 'collect' });
    if (me.tool && me.tool.k === 'rod') {
      (g.fish || []).map(f => ({ f, d: Math.max(Math.abs(f.x - me.x), Math.abs(f.y - me.y)) })).filter(o => o.d <= R.fishRange).sort((u, v) => u.d - v.d)
        .forEach(o => add(`釣る：魚（${o.d}マス先）`, `行動力${R.ap.attack}・体力${o.f.hp}`, { type: 'attack', x: o.f.x, y: o.f.y }));
    }
    if (me.tool && me.tool.k === 'bow') {
      g.animals.map(a => ({ a, d: Math.max(Math.abs(a.x - me.x), Math.abs(a.y - me.y)) })).filter(o => o.d >= 1 && o.d <= R.bowRange).sort((u, v) => u.d - v.d)
        .forEach(o => add(`攻撃：弓で動物（${o.d}マス先）`, `行動力${R.ap.attack}・体力${o.a.hp}`, { type: 'attack', x: o.a.x, y: o.a.y }));
    } else [['上', 0, -1], ['下', 0, 1], ['左', -1, 0], ['右', 1, 0]].forEach(d => {
      const a = E.animalAt(g, me.x + d[1], me.y + d[2]);
      if (a) add(`攻撃：${d[0]}の動物`, `行動力${R.ap.attack}・体力${a.hp}`, { type: 'attack', x: a.x, y: a.y });
    });
    if (!here && !res && !E.plantAt(g, me.x, me.y)) {
      add('植える：野菜の苗', `行動力${R.ap.plant}・野菜2`, { type: 'plant', kind: 'veg' });
      add('植える：樹木の苗', `行動力${R.ap.plant}・苗木1`, { type: 'plant', kind: 'tree' });
    }
    g.b.forEach(b => { if (b.hp !== null && E.nearB(b, me)) add(`直す：${E.BUILD[b.t].name}`, `行動力${b.w}・石材${E.repairStone(b)}`, { type: 'repair', id: b.id }); });
    if (me.gear || me.tool) {
      head = '装備・道具';
      if (me.gear) add(`外す：${E.GEAR[me.gear.k].name}`, '行動力1', { type: 'unequip', slot: 'gear' });
      if (me.tool) add(`外す：${E.GEAR[me.tool.k].name}（耐久${me.tool.dur}）`, '行動力1', { type: 'unequip', slot: 'tool' });
    }
    void it;
    app.menuEntries = entries;
    const tail = '<div class="small muted" style="padding:4px 6px 0">建てる・作るは左下のボタン、食べる・着けるは右の共有アイテムのクリックで選びます。</div>';
    const nm = here ? DESC[here.t].name + 'の上' : res ? ({ tree: '木', stone: '石', veg: '野菜' })[res.t] + 'のマス' : '雪原';
    el.innerHTML = `<div class="mh"><div><b>${esc(me.name)}（あなた）</b><small>いる場所：${nm}</small></div><button class="x" data-menu-close aria-label="メニューを閉じる">×</button></div>` +
      entries.map((e, i) => `${e.head ? `<div class="sec">${e.head}</div>` : ''}<button class="ent ${e.ok ? '' : 'no'}" data-ent="${i}"><b>${esc(e.label)}</b><span>${esc(e.cost)}</span></button>`).join('') + tail;
    el.hidden = false;
    const wr = $('#mapwrap').getBoundingClientRect();
    const ts = board.tileScreen(me.x, me.y);
    let left = ts.x + ts.size + 10;
    if (left + 292 > wr.width - 4) left = ts.x - 292 - 10;
    left = Math.max(4, left);
    const h = el.offsetHeight;
    el.style.left = left + 'px';
    el.style.top = Math.max(4, Math.min(ts.y - 20, wr.height - h - 4)) + 'px';
  }

  // 天候の演出
  function renderWeather(g, th) {
    $('#tint').style.background = th.tint[g.weather];
    const key = g.weather + theme();
    if (key === app.weatherKey) return;
    app.weatherKey = key;
    const cfg = { snow: [26, 'sf-fall'], blizzard: [60, 'sf-blow'], rain: [48, 'sf-rain'], storm: [100, 'sf-blow'], clear: [0, ''] }[g.weather];
    let html = '';
    for (let i = 0; i < cfg[0]; i++) {
      const r1 = ((i * 73) % 100) / 100, r2 = ((i * 41 + 17) % 100) / 100, r3 = ((i * 29 + 5) % 100) / 100;
      if (g.weather === 'rain') {
        html += `<div class="sf-p" style="left:${(r1 * 110).toFixed(1)}%;width:2px;height:${12 + Math.round(r2 * 10)}px;background:${th.rain};opacity:.6;border-radius:1px;animation:sf-rain ${(0.7 + r3 * 0.5).toFixed(2)}s linear ${(-r2 * 2).toFixed(2)}s infinite"></div>`;
      } else {
        const big = g.weather === 'storm' ? 5 : g.weather === 'blizzard' ? 4 : 3;
        const sz = 2 + Math.round(r2 * big);
        const dur = g.weather === 'storm' ? 0.8 + r3 * 0.7 : g.weather === 'blizzard' ? 1.2 + r3 : 4 + r3 * 3;
        const left = g.weather === 'snow' ? r1 * 100 : r1 * 135;
        html += `<div class="sf-p" style="left:${left.toFixed(1)}%;width:${sz}px;height:${sz}px;border-radius:50%;background:${th.flake};opacity:.8;animation:${cfg[1]} ${dur.toFixed(2)}s linear ${(-r2 * 6).toFixed(2)}s infinite"></div>`;
      }
    }
    $('#particles').innerHTML = html;
  }

  // 結果
  function renderResult(g) {
    const el = $('#result');
    if (g.phase === 'play' || app.resultHidden) { el.hidden = true; return; }
    const won = g.phase === 'won';
    $('#result-title').textContent = won ? 'クリア！ 最終猛吹雪を生き延びた' : 'ゲームオーバー';
    $('#result-sub').textContent = won ? `みんなで協力して、準備期間と最終猛吹雪の${g.total}ラウンドを乗り越えました。` : (g.over.reason === 'fire' ? `ラウンド${g.over.round}で、焚き火が消えたまま${R.fireOutLimit}手番が過ぎました。` : `ラウンド${g.over.round}で、全員が同時に行動不能になりました。`);
    const S = g.stats, cols = [['ap', '行動力', '使った行動力'], ['collect', '集めた', '集めた回数'], ['kills', '狩り', '倒した動物'], ['built', '建てた', '建てた建物'], ['crafted', '作った', '作った回数'], ['stoked', '焚べた', '焚べた回数'], ['planted', '植えた', '植えた苗'], ['repaired', '直した', '直した回数'], ['eaten', '食べた', '食べて増えた満腹度'], ['warmed', '温まり', '温まって増えた体温'], ['downs', '行動不能', '行動不能になった回数']];
    const top = {};
    cols.forEach(([k]) => { const m = Math.max(...g.players.map(p => S.players[p.id][k])); top[k] = k === 'downs' ? -1 : m; });
    const rows = g.players.map(p => `<tr><td style="white-space:nowrap"><span style="display:inline-flex;align-items:center;gap:4px">${pawnIco(p, 18)}${esc(p.name)}</span></td>${cols.map(([k]) => { const v = S.players[p.id][k]; return `<td class="${v > 0 && v === top[k] ? 'top' : ''}">${v}</td>`; }).join('')}</tr>`).join('');
    const gained = S.team.gained, gtxt = E.ITEMS.filter(k => gained[k]).map(k => `${E.ITEM_NAMES[k]}${gained[k]}`).join('　') || 'なし';
    $('#result-players').innerHTML = `<div class="team-stats">
        <div>生き延びたラウンド<b>${g.over.round} / ${g.total}</b></div><div>建てた建物<b>${S.team.built}</b></div><div>壊れた建物<b>${S.team.destroyed}</b></div><div>捨てた物<b>${S.team.discarded}</b></div></div>
      <div class="small muted">手に入れた物：${gtxt}</div>
      <div style="overflow:auto"><table class="stat-table"><thead><tr><th>プレイヤー</th>${cols.map(c => `<th title="${c[2]}">${c[1]}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>
      <div class="small muted">濃い色は、その項目でいちばん多い人（行動不能は数えません）</div>`;
    const host = app.room.hostId === app.me;
    $('#btn-result-lobby').hidden = !host;
    $('#result-wait').hidden = host;
    el.hidden = false;
  }

  // ---------- マップ・操作の組み立て ----------

  function setupBoard() {
    board = B.create({
      canvas: $('#map'),
      game: () => app.game, me: myP, theme, sel: () => app.sel,
      onView: () => { renderHint(); if (app.menu && app.game) renderMenu(app.game, TH()); },
      onHover: (info, v) => {
        const tip = $('#tip');
        if (!info || !v || app.mode === 'draw') { tip.hidden = true; return; }
        const g = app.game, th = TH();
        let html = '';
        const b = info.b;
        if (b) {
          const d = DESC[b.t], warm = b.t === 'igloo' || b.t === 'storage', ins = E.insul(b);
          const status = warm ? (ins ? '防寒 有効' : '防寒 消失') : b.t === 'fire' ? `火力 ${b.fire} / ${R.fireMax}` : '';
          html += `<div class="tn">${esc(d.name)}<span class="grow"></span><span style="font-size:12px;color:${warm ? (ins ? th.chip.ok[1] : th.chip.lost[1]) : th.chip.fire[1]}">${status}</span></div><div class="tt">${esc(d.tip)}</div>${b.hp === null ? '' : `<div class="th">HP ${b.hp} / ${b.max}</div>`}`;
        }
        if (info.res) {
          const r = info.res, nm = ({ tree: '樹木（木材）', stone: '石（石材）', veg: '野菜' })[r.t];
          html += `<div class="tn">${nm}</div><div class="tt">体力 ${r.hp} / ${r.max || R.resHpMax}（外側の線の区切り1つ＝体力1。集めるたびに1減る）</div>`;
        }
        if (info.animal) html += `<div class="tn">動物</div><div class="tt">体力 ${info.animal.hp} / ${info.animal.max || R.animalHpMax}。倒すと肉が${R.meatMin}〜${R.meatMax}個</div>`;
        if (info.fish) html += `<div class="tn">魚</div><div class="tt">体力 ${info.fish.hp} / ${info.fish.max || R.fishHpMax}。釣り竿で${R.fishRange}マス以内から攻撃。倒すと魚が${R.fishMin}〜${R.fishMax}個</div>`;
        else if (info.river) html += `<div class="tn">川</div><div class="tt">雪原ではないので、移動も建設もできない。魚がいる</div>`;
        if (info.plant) html += `<div class="tn">${info.plant.t === 'veg' ? '野菜' : '樹木'}の苗</div><div class="tt">あと${info.plant.left}ラウンドで育つ（外側の線の区切り1つ＝あと1ラウンド）</div>`;
        tip.innerHTML = html;
        const wr = $('#mapwrap').getBoundingClientRect();
        tip.hidden = false;
        tip.style.left = Math.max(4, Math.min(v.x + 16, wr.width - 240)) + 'px';
        tip.style.top = Math.max(4, Math.min(v.y + 12, wr.height - 110)) + 'px';
      },
      onDrag: d => {
        const tip = $('#tip');
        renderHint();
        if (!d) { tip.hidden = true; renderMenu(app.game, TH()); return; }
        $('#menu').hidden = true;
        const wr = $('#mapwrap').getBoundingClientRect();
        tip.innerHTML = `<div class="tn">${esc(d.ok ? (d.cost > 0 ? `移動：体温 -${d.cost}` : '移動：体温は減りません') : d.why)}</div>`;
        tip.hidden = false;
        tip.style.left = Math.max(4, Math.min(d.vx + 16, wr.width - 250)) + 'px';
        tip.style.top = Math.max(4, d.vy - 44) + 'px';
      },
      onMove: (x, y, v) => {
        const info = myP() ? E.pathBlockers(app.game, myP(), x, y) : null;
        // ほかの駒が道をふさいでいて、遠回りになる（体温が余計に減る）なら、どいてもらうお願いもできる
        if (info && info.blockers.length && info.real != null && info.real > info.ideal) showMoveReq(info.blockers, x, y, v, false, info);
        else act({ type: 'move', x, y });
      },
      onBuild: (t, x, y) => act({ type: 'build', t, x, y }),
      onDisarm: () => disarm(),
      onMoveFail: (why, x, y, v) => {
        const info = myP() ? E.pathBlockers(app.game, myP(), x, y) : null;
        if (info && info.blockers.length) showMoveReq(info.blockers, x, y, v, false, info); else mapToast('移動できません：' + why, 'bad');
      },
      onOtherPawn: (q, v) => { if (myP() && app.mode !== 'draw') showMoveReq([q], undefined, undefined, v, true); },
      onPawn: () => { app.menu = !app.menu; renderMenu(app.game, TH()); },
      onBackground: b => {
        app.menu = false;
        if (b) app.sel = b.id;
        renderGame();
      },
      onDraw: (c, pts) => act({ type: 'draw', c, pts }),
      onErase: (x, y, r) => act({ type: 'erase', x, y, r }),
    });
    $('#z-in').onclick = () => board.zoom(1.2, board.state.W / 2, board.state.H / 2);
    $('#z-out').onclick = () => board.zoom(1 / 1.2, board.state.W / 2, board.state.H / 2);
    $('#z-reset').onclick = () => board.reset();
  }

  // ほかの駒が道をふさいでいるとき、どいてもらうようお願いする（CPUはすぐに動く。人間には確認が出る）
  function showMoveReq(players, x, y, v, direct, info) {
    const el = $('#movereq');
    const names = players.map(p => esc(p.name)).join('・');
    const detour = info && info.real != null ? `<button data-mr="go|${x}|${y}">遠回りで行く（体温 −${info.real}）</button>` : '';
    el.innerHTML = `<b>${direct ? `${names}に、移動をお願いしますか？` : `${names}が道をふさいでいます`}</b>
      <span>${direct ? 'どいてもらいます（CPUはすぐに動き、人にはお願いが届きます）。' : `どいてもらえば、体温 −${info ? info.ideal : 0} で行けます。${info && info.real != null ? `このまま行くと −${info.real} です。` : ''}`}</span>
      ${players.map(p => `<button data-mr="${p.id}|${x == null ? '' : x}|${y == null ? '' : y}">${esc(p.name)}に、どいてもらう</button>`).join('')}
      ${detour}
      <button data-mr="close">やめる</button>`;
    el.hidden = false;
    const wr = $('#mapwrap').getBoundingClientRect(), p = v || { x: wr.width / 2, y: wr.height / 2 };
    el.style.left = Math.max(4, Math.min(p.x + 12, wr.width - 280)) + 'px';
    el.style.top = Math.max(4, Math.min(p.y - 20, wr.height - el.offsetHeight - 8)) + 'px';
    clearTimeout(showMoveReq.t);
    showMoveReq.t = setTimeout(() => { el.hidden = true; }, 12000);
  }

  // 建設モード：カードをクリックして選ぶと、マップをクリックして連続で置ける（もう一度クリック・Esc・右クリックで解除）
  function arm(t) {
    app.armed = t;
    if (board) board.setArmed(t);
    if (app.game) { renderTray(app.game, TH()); renderHint(); }
    if (t) mapToast(`${E.BUILD[t].name}：マップをクリックして置きます（続けて置けます。Escか右クリックで解除）`);
  }
  function disarm() { if (app.armed) arm(null); }

  // 建設カードのドラッグ
  function onCardMove(e) {
    const c = app.card;
    if (!c) return;
    const gh = $('#ghost');
    gh.style.left = (e.clientX - c.w / 2) + 'px';
    gh.style.top = (e.clientY - c.w / 2) + 'px';
    const t = board.tileAt(e.clientX, e.clientY);
    const s = E.BUILD[c.t].size;
    board.setPreview(t ? { t: c.t, x: Math.floor(t.fx - s / 2 + 0.5), y: Math.floor(t.fy - s / 2 + 0.5) } : null);
  }
  function onCardUp(e) {
    const c = app.card;
    if (!c) return;
    app.card = null;
    $('#ghost').hidden = true;
    window.removeEventListener('pointermove', onCardMove);
    window.removeEventListener('pointerup', onCardUp);
    // 動かさずに離した（クリック）なら、建設モードの切り替え
    if (Math.hypot(e.clientX - c.sx, e.clientY - c.sy) < 6) { board.setPreview(null); app.armed === c.t ? disarm() : arm(c.t); return; }
    const pv = board.state.preview;
    board.setPreview(null);
    if (!pv) { mapToast('盤面の上にドロップしてください', 'bad'); return; }
    act({ type: 'build', t: c.t, x: pv.x, y: pv.y });      // 一覧は、建設しても閉じない
    renderGame();
    void e;
  }

  // ---------- イベント ----------

  function bind() {
    $('#btn-create').onclick = () => enterRoom('create');
    $('#btn-join').onclick = () => enterRoom('join');
    $('#btn-local').onclick = () => enterRoom('local');
    $('#btn-tutorial').onclick = () => enterRoom('tutorial');
    $('#in-code').addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom('join'); });
    $('#btn-copy').onclick = () => {
      const v = $('#invite-url').value;
      (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => toast('招待URLをコピーしました'), () => { $('#invite-url').select(); toast('URLを選択しました。コピーしてください'); });
    };
    $('#btn-add-cpu').onclick = () => send({ type: 'addCpu' });
    $('#style-box').addEventListener('click', e => {
      const a = e.target.closest('[data-shape]'), c = e.target.closest('[data-color]');
      if (a) { store.set('shape', a.dataset.shape); send({ type: 'style', shape: a.dataset.shape }); }
      if (c && !c.disabled) { store.set('color', c.dataset.color); send({ type: 'style', color: c.dataset.color }); }
    });
    $('#btn-start').onclick = () => send({ type: 'start' });
    $('#btn-leave').onclick = () => leaveRoom('');
    $('#opt-simul').addEventListener('change', e => send({ type: 'settings', simul: e.target.checked }));
    $('#lobby-players').addEventListener('click', e => { const b = e.target.closest('[data-rm-cpu]'); if (b) send({ type: 'removeCpu', id: b.dataset.rmCpu }); });

    $$('[data-open]').forEach(b => { b.onclick = () => { if (b.dataset.open === 'rules') guide.openRules(); else if (b.dataset.open === 'changelog') openChangelog(); else $('#' + b.dataset.open).hidden = false; }; });
    $$('[data-close]').forEach(b => { b.onclick = () => { $('#' + b.dataset.close).hidden = true; }; });
    $('#rules').addEventListener('click', e => { if (e.target === $('#rules')) $('#rules').hidden = true; });
    $$('[data-act="theme"]').forEach(b => { b.onclick = () => applyTheme(theme() === 'dark' ? 'light' : 'dark'); });
    const soundLabel = () => $$('[data-act="sound"]').forEach(b => { b.textContent = SnowSound.isMuted() ? '音：OFF' : '音：ON'; });
    $$('[data-act="sound"]').forEach(b => { b.onclick = () => { SnowSound.setMuted(!SnowSound.isMuted()); soundLabel(); SnowSound.play('tick'); }; });
    soundLabel();
    document.addEventListener('pointerdown', () => SnowSound.unlock(), { once: true });
    $('#overflow').addEventListener('click', e => {
      const pd = app.game && app.game.pending && app.game.pending[0];
      if (!pd) return;
      const b = e.target.closest('[data-ovr]');
      if (b) {
        const [k, d] = b.dataset.ovr.split(':'), cur = app.ovrDrop[k] || 0;
        app.ovrDrop[k] = Math.max(0, cur + +d);
        renderOverflow(app.game, TH());
      }
      if (e.target.closest('[data-ovr-ok]')) { const drop = {}; for (const k of Object.keys(app.ovrDrop)) if (app.ovrDrop[k] > 0) drop[k] = app.ovrDrop[k]; act({ type: 'overflow', drop }); }
      if (e.target.closest('[data-ovr-skip]')) act({ type: 'overflow', drop: {} });
    });
    $('#endpop').addEventListener('click', e => {
      if (e.target.closest('[data-endpop-end]')) { app.menu = false; act({ type: 'end' }); }
      else if (e.target.closest('[data-endpop-close]')) { app.endPopDismiss = tkey(app.game); $('#endpop').hidden = true; }
    });

    $('#btn-endturn').onclick = () => { app.menu = false; act({ type: 'end' }); renderMenu(app.game, TH()); };
    $('#btn-log').onclick = () => { const p = $('#log-pop'); p.hidden = !p.hidden; if (!p.hidden && app.game) p.innerHTML = logHtml(app.game); };
    $$('[data-tray]').forEach(b => { b.onclick = () => { app.tray = b.dataset.tray; if (b.dataset.tray === 'craft') disarm(); if (app.game) renderTray(app.game, TH()); }; });
    $('#btn-draw').onclick = () => {
      if (app.mode === 'draw') { setMode('play'); return; }
      if (myTurn()) { mapToast('お絵かきは、自分の手番以外で使えます', 'bad'); return; }
      setMode('draw');
      mapToast('お絵かきモード：ドラッグで描きます。建物や道ができたマスの絵は消えます');
    };
    $('#draw-tools').addEventListener('click', e => {
      const b = e.target.closest('[data-tool]'); if (!b) return;
      const t = b.dataset.tool;
      if (t === 'pen' || t === 'eraser') app.tool = t; else { app.color = t; app.tool = 'pen'; }
      board.setPen(app.tool, app.color);
      renderDrawBox(app.game);
    });

    $('#slots').addEventListener('click', e => {
      const b = e.target.closest('[data-item],[data-gear]');
      if (!b) return;
      const r = b.getBoundingClientRect();
      app.itemPop = b.dataset.item ? { k: b.dataset.item } : { gear: +b.dataset.gear };
      app.itemPopAt = { x: r.left, y: r.top };
      $('#itip').hidden = true;
      renderItemPop(app.game, TH());
    });
    $('#itempop').addEventListener('click', e => {
      const b = e.target.closest('[data-ip]');
      if (!b || b.disabled) return;
      const a = b.dataset.ip, ip = app.itemPop;
      if (a === 'close') app.itemPop = null;
      else if (a === 'eat') act({ type: 'eat', k: ip.k });                           // 続けて食べられるよう、開いたままにする
      else if (a === 'vote') { act({ type: 'vote', k: ip.k }); app.itemPop = null; }
      else if (a === 'equip') { act({ type: 'equip', id: ip.gear }); app.itemPop = null; }
      renderItemPop(app.game, TH());
    });
    document.addEventListener('pointerdown', e => {
      if (!app.itemPop || e.target.closest('#itempop') || e.target.closest('[data-item],[data-gear]')) return;
      app.itemPop = null; $('#itempop').hidden = true;
    });
    $('#movereq').addEventListener('click', e => {
      const b = e.target.closest('[data-mr]');
      if (!b) return;
      if (b.dataset.mr !== 'close') {
        const [to, x, y] = b.dataset.mr.split('|');
        if (to === 'go') act({ type: 'move', x: +x, y: +y });                       // 遠回りで行く
        else send({ type: 'moveReq', to, x: x === '' ? undefined : +x, y: y === '' ? undefined : +y });
      }
      $('#movereq').hidden = true;
    });
    $('#movein').addEventListener('click', e => {
      const b = e.target.closest('[data-mi]');
      if (!b) return;
      send({ type: 'moveReqReply', accept: b.dataset.mi === 'yes' });
      $('#movein').hidden = true;
    });
    $('#slots').addEventListener('pointermove', e => {
      const b = e.target.closest('[data-item]'), tip = $('#itip');
      if (!b || !app.game || app.itemPop) { tip.hidden = true; return; }
      const k = b.dataset.item;
      tip.innerHTML = `<div class="tn">${E.ITEM_NAMES[k]}<span class="grow"></span><span style="font-size:12px;color:var(--muted2);font-weight:400">所持 ${app.game.items[k]}個</span></div><div class="tt">${IDESC[k]}</div>`;
      tip.hidden = false;
      tip.style.left = Math.max(4, e.clientX - 246) + 'px';
      tip.style.top = Math.min(e.clientY + 14, window.innerHeight - 100) + 'px';
    });
    $('#slots').addEventListener('pointerleave', () => { $('#itip').hidden = true; });
    $('#vote').addEventListener('click', e => {
      const b = e.target.closest('[data-vote]');
      if (b) act({ type: 'voteCast', val: +b.dataset.vote });
      if (e.target.closest('[data-vote-cancel]')) act({ type: 'voteCancel' });
    });
    $('#detail').addEventListener('click', e => { const b = e.target.closest('[data-repair]'); if (b) act({ type: 'repair', id: +b.dataset.repair }); });
    $('#menu').addEventListener('click', e => {
      if (e.target.closest('[data-menu-close]')) { app.menu = false; renderMenu(app.game, TH()); return; }
      const b = e.target.closest('[data-ent]');
      if (!b) return;
      const ent = app.menuEntries[+b.dataset.ent];
      if (!ent.ok) { mapToast(ent.cost, 'bad'); return; }
      if (ent.fn) ent.fn(); else act(ent.a);
    });
    $('#tray').addEventListener('click', e => {
      const c = e.target.closest('[data-recipe]');
      if (!c) return;
      if (c.dataset.why) { mapToast(c.dataset.why, 'bad'); return; }
      act({ type: 'craft', recipe: c.dataset.recipe });
    });
    $('#tray').addEventListener('pointermove', e => {
      const rcEl = e.target.closest('[data-recipe]'), tip = $('#itip');
      if (rcEl && app.game) {
        const rc = E.RECIPES[rcEl.dataset.recipe], g = app.game;
        const mats = Object.keys(rc.in).map(m => `<span style="color:${g.items[m] >= rc.in[m] ? 'var(--ok)' : 'var(--redFg)'};font-weight:700">${E.ITEM_NAMES[m]} ${g.items[m]}/${rc.in[m]}</span>`).join('　');
        tip.innerHTML = `<div class="tn">${esc(rc.name)}を作る<span class="grow"></span><span style="font-size:12px;color:var(--muted2);font-weight:400">行動力 ${rc.ap}</span></div>
          <div class="tt"><b>必要な材料</b>（持っている数/必要）<br>${mats}</div><div class="tt">できるもの：${rc.gear ? E.GEAR[rc.gear].name + '（' + E.GEAR[rc.gear].desc + (E.GEAR[rc.gear].slot === 'tool' ? `。耐久度${R.toolDur}` : '') + '）' : Object.keys(rc.out).map(k => E.ITEM_NAMES[k] + rc.out[k]).join('・')}</div>
          <div class="th">${E.STATION_NAMES[rc.station]}の上かすぐ隣で作れます</div>`;
        tip.hidden = false;
        const r = rcEl.getBoundingClientRect();
        tip.style.left = Math.min(r.right + 10, window.innerWidth - 246) + 'px';
        tip.style.top = Math.max(4, Math.min(r.top, window.innerHeight - tip.offsetHeight - 8)) + 'px';
        return;
      }
      const c = e.target.closest('[data-card]');
      if (!c || !app.game || app.card) { tip.hidden = true; return; }
      const k = c.dataset.card, d = E.BUILD[k], ds = DESC[k], g = app.game;
      const mats = Object.keys(d.cost).map(m => `<span style="color:${g.items[m] >= d.cost[m] ? 'var(--ok)' : 'var(--redFg)'};font-weight:700">${E.ITEM_NAMES[m]} ${g.items[m]}/${d.cost[m]}</span>`).join('　');
      const hp = E.isPath(k) ? '壊れない' : `HP ${d.size * 2}`;
      tip.innerHTML = `<div class="tn">${d.name}<span class="grow"></span><span style="font-size:12px;color:var(--muted2);font-weight:400">${d.size}×${d.size}・${hp}</span></div>
        <div class="tt"><b>必要な材料</b>（持っている数/必要）<br>${mats}<br>行動力 ${d.ap}</div>
        <div class="tt">${esc(ds.desc)}</div>${ds.eff.map(t => `<div class="tt">・${esc(t)}</div>`).join('')}
        <div class="th">既存の建物（道を含む）に隣接する場所に置けます</div>`;
      tip.hidden = false;
      const r = c.getBoundingClientRect();
      tip.style.left = Math.min(r.right + 10, window.innerWidth - 246) + 'px';
      tip.style.top = Math.max(4, Math.min(r.top, window.innerHeight - tip.offsetHeight - 8)) + 'px';
    });
    $('#tray').addEventListener('pointerleave', () => { $('#itip').hidden = true; });
    $('#tray').addEventListener('pointerdown', e => {
      $('#itip').hidden = true;
      const c = e.target.closest('[data-card]');
      if (!c) return;
      if (c.dataset.why) { mapToast(c.dataset.why, 'bad'); return; }
      e.preventDefault();
      const k = c.dataset.card, d = E.BUILD[k], th = TH();
      const w = Math.max(40, d.size * B.T * board.state.cam.z - 6);
      app.card = { t: k, w, sx: e.clientX, sy: e.clientY };
      const gh = $('#ghost'), col = th.card[E.isPath(k) ? 'storage' : k];
      gh.textContent = d.name;
      gh.style.cssText = `width:${w}px;height:${w}px;background:${k === 'road' ? th.road : k === 'bridge' ? th.bridge : col[0]};border-color:${k === 'road' ? th.roadBd : k === 'bridge' ? th.bridgeBd : col[1]};color:${E.isPath(k) ? th.text : col[2]}`;
      gh.hidden = false;
      window.addEventListener('pointermove', onCardMove);
      window.addEventListener('pointerup', onCardUp);
      onCardMove(e);
    });
    document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) $('#log-pop').hidden = true; });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      $('#rules').hidden = true; $('#changelog').hidden = true;
      disarm();
      if (app.menu) { app.menu = false; renderMenu(app.game, TH()); }
    });

    $('#btn-result-lobby').onclick = () => send({ type: 'toLobby' });
    $('#btn-result-view').onclick = () => { app.resultHidden = true; $('#result').hidden = true; };

    window.addEventListener('beforeunload', e => {
      if (app.conn && app.conn.isHost && app.room && app.room.phase === 'game') { e.preventDefault(); e.returnValue = ''; }
    });
  }

  // 更新履歴（新しい版が上）
  function openChangelog() {
    $('#changelog-body').innerHTML = window.SnowChangelog.map(v => `<div class="cl-ver"><b>v${esc(v.version)}</b><span>${esc(v.date)}　${esc(v.title)}</span></div>${'<ul>' + v.items.map(t => `<li>${esc(t)}</li>`).join('') + '</ul>'}`).join('');
    $('#changelog').hidden = false;
  }

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    store.set('theme', t);
    app.weatherKey = '';
    if (app.game && !$('#game').hidden) renderGame();
  }

  function init() {
    document.documentElement.dataset.theme = store.get('theme') === 'light' ? 'light' : 'dark';
    $('#in-name').value = store.get('name') || '';
    const room = new URLSearchParams(location.search).get('room');
    if (room) { $('#in-code').value = room.toUpperCase().slice(0, 6); }
    $$('[data-ver]').forEach(el => { el.textContent = 'v' + E.VERSION; });
    setupBoard();
    guide = window.SnowGuide.create({ app, $, board: () => board, leave: () => leaveRoom(''), sound: SnowSound });
    bind();
    setInterval(() => { if (app.game && !$('#game').hidden) updateTimer(); }, 250);
    show('top');
    // テスト用：ブラウザの検証から状態を見られるようにする
    window.__snowfield = { app, E, get board() { return board; } };
  }
  init();
})();
