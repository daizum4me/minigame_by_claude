/*
 * ヘキサゴニア — 部屋（ロビー・ゲーム進行・切断の扱い）
 * ホスト権威型：ホストのブラウザでこの Room を動かし、参加者からの要求を handle() で受けて
 * ルール上可能かを確かめてから状態を更新し、全員に最新の状態を配信する。
 * CPU もここで動かす（ホストのブラウザの中で考えて行動する）。
 *
 * new Room({ code, send(playerId, msg), rng, now, setTimer, clearTimer })
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./cpu'));
  else root.HexRoom = factory(root.HexEngine, root.HexCpu);
})(typeof self !== 'undefined' ? self : this, function (E, CPU) {
  'use strict';

  const COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'cyan', 'pink', 'lime', 'brown', 'white', 'indigo'];
  const LOG_SEND = 80;      // 配信するログの件数
  const CPU_RT_MS = 2500;   // CPU が考える間隔
  const COUNTDOWN_MS = 3000; // ゲーム開始前のカウントダウン（このあいだは行動できず、時間も進まない）
  const CHAT_KEEP = 30;         // 残して配信するチャットの件数
  const CHAT_LEN = 80;          // チャット1件の文字数の上限
  const CHAT_GAP_MS = 800;      // 続けて送れる間隔（連投よけ）

  function cleanName(s) {
    const t = Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 12).join('').trim();
    return t || 'ゲスト';
  }

  function cleanChat(s) {
    return Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, CHAT_LEN).join('').trim();
  }

  class Room {
    constructor(opts) {
      this.code = opts.code || '';
      this.sendFn = opts.send;
      this.rng = opts.rng || Math.random;
      this.setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
      this.clearTimer = opts.clearTimer || (id => clearTimeout(id));
      this.now = opts.now || (() => Date.now());
      this.players = [];        // { id, token, name, color, connected, cpu }
      this.hostId = null;
      this.phase = 'lobby';
      // 盤面の直径（マス）・ターン数。0 は人数に合わせる
      this.settings = { diameter: 0, ticks: 0 };
      this.events = true;       // イベントを起こすか
      this.chat = [];           // { seq, from, name, color, text }（ロビーとゲームで続けて使う）
      this.chatSeq = 0;
      this.game = null;
      this.seq = 0;
      this.timers = {};         // rtTick / rtRegen / cpu
      this.tickDeadline = 0;
      this.regenDeadline = 0;
      this.countdownUntil = 0;  // ゲーム開始前のカウントダウンが終わる時刻
      this.closed = false;
    }

    // 戻り値 { id } または { error }
    join(token, name) {
      if (this.closed) return { error: '部屋が見つかりません' };
      const back = this.players.find(p => !p.cpu && p.token === token);
      if (back) {
        back.connected = true;
        if (this.game) this.note(`🔌 ${back.name} が戻ってきました`);
        this.changed();
        return { id: back.id };
      }
      if (this.phase !== 'lobby') return { error: 'ゲーム中のため参加できません' };
      if (this.players.length >= E.RULES.maxPlayers) return { error: `満員です（最大${E.RULES.maxPlayers}人）` };
      const p = this.addPlayer({ token, name: cleanName(name), cpu: false });
      if (!this.hostId) this.hostId = p.id;
      this.changed();
      return { id: p.id };
    }

    addPlayer({ token, name, cpu }) {
      let n = name, i = 2;
      while (this.players.some(p => p.name === n)) n = name + (i++);
      const p = { id: 'p' + (++this.seq), token, name: n, color: COLORS.find(c => !this.players.some(x => x.color === c)), connected: true, cpu };
      if (cpu) p.level = 'normal';   // CPU の強さ（よわい・ふつう・つよい）
      this.players.push(p);
      return p;
    }

    disconnect(id) {
      const p = this.players.find(x => x.id === id);
      if (!p || !p.connected) return;
      p.connected = false;
      if (this.phase === 'lobby') {
        // ロビーでは抜けた扱い
        this.players = this.players.filter(x => x !== p);
      } else if (this.game) {
        this.note(`🔌 ${p.name} の接続が切れました`);
        this.checkReady();   // 切断した人は行動完了とみなす
      }
      this.changed();
    }

    note(text) {
      if (this.game) { this.game.log.push({ seq: ++this.game.logSeq, text, tone: 'info' }); }
    }

    handle(id, msg) {
      if (this.closed || !msg || typeof msg !== 'object') return;
      const p = this.players.find(x => x.id === id);
      if (!p) return;
      const err = text => this.sendFn(id, { type: 'error', text });
      switch (msg.type) {
        case 'color': {
          if (this.phase !== 'lobby') return;
          if (!COLORS.includes(msg.color)) return;
          if (this.players.some(x => x !== p && x.color === msg.color)) return err('その色はほかの人が使っています');
          p.color = msg.color;
          this.changed();
          return;
        }
        case 'chat': {
          const text = cleanChat(msg.text);
          if (!text) return;
          const now = this.now();
          if (p.lastChat && now - p.lastChat < CHAT_GAP_MS) return err('少し待ってから送ってください');
          p.lastChat = now;
          this.chat.push({ seq: ++this.chatSeq, from: p.id, name: p.name, color: p.color, text });
          if (this.chat.length > CHAT_KEEP) this.chat.splice(0, this.chat.length - CHAT_KEEP);
          this.broadcast();
          return;
        }
        case 'addCpu': {
          if (id !== this.hostId || this.phase !== 'lobby') return;
          if (this.players.length >= E.RULES.maxPlayers) return err(`満員です（最大${E.RULES.maxPlayers}人）`);
          let k = 1;
          while (this.players.some(x => x.name === 'CPU ' + k)) k++;
          this.addPlayer({ token: null, name: 'CPU ' + k, cpu: true });
          this.changed();
          return;
        }
        case 'cpuLevel': {
          if (id !== this.hostId || this.phase !== 'lobby') return;
          const t = this.players.find(x => x.id === msg.target && x.cpu);
          if (!t || !CPU.LEVELS[msg.level]) return;
          t.level = msg.level;
          this.changed();
          return;
        }
        case 'removeCpu': {
          if (id !== this.hostId || this.phase !== 'lobby') return;
          const t = this.players.find(x => x.id === msg.target && x.cpu);
          if (!t) return;
          this.players = this.players.filter(x => x !== t);
          this.changed();
          return;
        }
        case 'settings': {
          if (id !== this.hostId || this.phase !== 'lobby') return;
          const next = Object.assign({}, this.settings);
          if ('diameter' in msg) {
            const d = Number(msg.diameter);
            const [lo, hi] = E.RULES.radiusRange;
            if (d !== 0 && !(Number.isInteger(d) && d % 2 === 1 && d >= lo * 2 + 1 && d <= hi * 2 + 1)) return err('盤面の大きさが正しくありません');
            next.diameter = d;
          }
          if ('ticks' in msg) {
            const t = Number(msg.ticks);
            const [lo, hi] = E.RULES.rt.ticksRange;
            if (t !== 0 && !(Number.isInteger(t) && t >= lo && t <= hi)) return err('ターン数が正しくありません');
            next.ticks = t;
          }
          this.settings = next;
          this.changed();
          return;
        }
        case 'start': {
          if (id !== this.hostId) return err('ゲームを始められるのはホストだけです');
          if (this.phase !== 'lobby') return;
          if (this.players.length < E.RULES.minPlayers) return err(`${E.RULES.minPlayers}人以上でないと始められません`);
          const radius = this.settings.diameter ? (this.settings.diameter - 1) / 2 : 0;
          try {
            this.game = E.createGame(this.players.map(x => ({ id: x.id, name: x.name, color: x.color })), this.rng, { radius, rounds: this.settings.ticks, events: this.events });
          } catch (e) {
            return err(e.message);
          }
          this.phase = 'game';
          this.countdownUntil = this.now() + COUNTDOWN_MS;
          this.timer('countdown', () => { this.countdownUntil = 0; this.changed(); }, COUNTDOWN_MS);
          this.changed();
          return;
        }
        case 'act': {
          if (this.phase !== 'game' || !this.game) return;
          if (this.countdownUntil) return err('まだ始まっていません');
          const r = E.apply(this.game, id, msg.action);
          if (!r.ok) return err(r.error);
          if (msg.action.type === 'ready') this.checkReady();
          this.changed();
          return;
        }
        case 'forfeit': {
          // 切断したまま戻らない人をホストが脱落させる
          if (id !== this.hostId || this.phase !== 'game' || !this.game) return;
          const t = this.players.find(x => x.id === msg.target);
          if (!t || t.connected) return err('接続中の人は脱落させられません');
          this.note(`ホストが ${t.name} を脱落させました`);
          E.forfeit(this.game, t.id);
          this.changed();
          return;
        }
        case 'lobby': {
          if (id !== this.hostId || this.phase !== 'game' || !this.game || !this.game.over) return;
          this.phase = 'lobby';
          this.game = null;
          this.players = this.players.filter(x => x.connected);
          this.changed();
          return;
        }
        default:
      }
    }

    // 状態が変わったら：時間切れ・CPU の予約を見直してから全員に配信
    changed() {
      this.checkTimers();
      this.checkCpu();
      this.broadcast();
    }

    timer(name, fn, ms) {
      this.stop(name);
      this.timers[name] = this.setTimer(() => { this.timers[name] = null; fn(); }, ms);
    }

    stop(name) {
      if (this.timers[name]) this.clearTimer(this.timers[name]);
      this.timers[name] = null;
    }

    player(id) { return this.players.find(x => x.id === id); }

    // 15秒ごとのターンと、5秒ごとの行動力の回復
    checkTimers() {
      const g = this.game;
      const now = this.now();
      if (!g || this.phase !== 'game' || g.over) {
        ['rtTick', 'rtRegen', 'countdown'].forEach(n => this.stop(n));
        this.countdownUntil = 0;
        return;
      }
      if (this.countdownUntil) return;   // カウントダウンが終わってから時間を進める
      const rt = E.RULES.rt;
      if (!this.timers.rtTick) {
        this.tickDeadline = now + rt.tickSeconds * 1000;
        this.timer('rtTick', () => { E.rtTick(this.game, this.rng); this.changed(); }, rt.tickSeconds * 1000);
      }
      if (!this.timers.rtRegen) {
        this.regenDeadline = now + rt.apSeconds * 1000;
        this.timer('rtRegen', () => { E.rtRegen(this.game); this.changed(); }, rt.apSeconds * 1000);
      }
    }

    // 行動完了の人（CPU と切断中の人は、押したものとみなす）
    readyIds() {
      const g = this.game;
      return g ? g.players.filter(p => p.alive && (p.ready || (this.player(p.id) || {}).cpu || !(this.player(p.id) || {}).connected)).map(p => p.id) : [];
    }

    // 生きている人間のプレイヤーがひとりでもいて、全員が行動完了なら、待たずに次のターンへ
    checkReady() {
      const g = this.game;
      if (!g || g.over || this.phase !== 'game' || this.countdownUntil) return;
      const humans = g.players.filter(p => p.alive && !(this.player(p.id) || {}).cpu && (this.player(p.id) || {}).connected);
      if (!humans.length || !humans.every(p => p.ready)) return;
      this.note('全員が行動完了したので、次のターンへ');
      this.stop('rtTick');
      E.rtTick(g, this.rng);
      // checkTimers が次のターンのタイマーをかけ直す
    }

    // CPU は一定の間隔で考えて、行動力があれば1つずつ動く
    checkCpu() {
      const g = this.game;
      const any = g && this.phase === 'game' && !g.over && !this.countdownUntil && this.players.some(p => p.cpu && g.players.some(x => x.id === p.id && x.alive));
      if (!any) { this.stop('cpu'); return; }
      if (!this.timers.cpu) this.timer('cpu', () => this.cpuActRealtime(), CPU_RT_MS);
    }

    cpuActRealtime() {
      const g = this.game;
      if (this.closed || !g || g.over) return;
      for (const p of g.players) {
        const info = this.player(p.id);
        if (!p.alive || !info || !info.cpu) continue;
        const action = CPU.decideRealtime(g, p.id, this.rng, info.level);
        if (action) E.apply(g, p.id, action);
      }
      this.changed();
    }

    // その人に見せてよい情報：ほかの人の戦力トークンの数と、セルの防御の数は見せない
    view(forId) {
      const g = this.game;
      const now = this.now();
      let game = null;
      if (g) {
        // ほかの人の戦力トークンの数は見せない
        game = Object.assign({}, g, {
          log: g.log.slice(-LOG_SEND),
          players: g.players.map(p => p.id === forId ? p : Object.assign({}, p, { power: null })),
          // セルの防御の数は、そのセルの持ち主にしか見せない（ほかの人には、あるかどうかもわからない）
          board: Object.fromEntries(Object.entries(g.board).map(([k, c]) => [k, c.def && c.owner !== forId ? Object.assign({}, c, { def: 0 }) : c])),
        });
      }
      const live = g && !g.over && this.phase === 'game';
      return {
        code: this.code,
        phase: this.phase,
        hostId: this.hostId,
        settings: this.settings,
        players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, connected: p.connected, cpu: !!p.cpu, level: p.cpu ? p.level : undefined })),
        readyIds: live ? this.readyIds() : [],
        countdownMs: live && this.countdownUntil ? Math.max(0, this.countdownUntil - now) : 0,
        tickLeftMs: live && !this.countdownUntil ? Math.max(0, this.tickDeadline - now) : 0,
        regenLeftMs: live ? Math.max(0, this.regenDeadline - now) : 0,
        chat: this.chat,
        game,
      };
    }

    broadcast() {
      if (this.closed) return;
      for (const p of this.players) if (p.connected && !p.cpu) this.sendFn(p.id, { type: 'state', you: p.id, room: this.view(p.id) });
    }

    close() {
      this.closed = true;
      Object.keys(this.timers).forEach(n => this.stop(n));
    }
  }

  return { Room, COLORS, CHAT_KEEP, CHAT_LEN, COUNTDOWN_MS };
});
