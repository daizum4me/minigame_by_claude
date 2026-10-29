/*
 * ヘキサゴニア（仮）— 部屋（ロビー・ゲーム進行・切断の扱い）
 * ホスト権威型：ホストのブラウザでこの Room を動かし、参加者からの要求を handle() で受けて
 * ルール上可能かを確かめてから状態を更新し、全員に最新の状態を配信する。
 *
 * new Room({ code, send(playerId, msg), rng, now, setTimer, clearTimer })
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.HexRoom = factory(root.HexEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  const COLORS = ['red', 'blue', 'green', 'yellow'];
  const GRACE_MS = 30000;   // 切断した人の操作待ちを、これだけ待ってから自動で進める
  const LOG_SEND = 80;      // 配信するログの件数

  function cleanName(s) {
    const t = Array.from(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 12).join('').trim();
    return t || 'ゲスト';
  }

  class Room {
    constructor(opts) {
      this.code = opts.code || '';
      this.sendFn = opts.send;
      this.rng = opts.rng || Math.random;
      this.setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
      this.clearTimer = opts.clearTimer || (id => clearTimeout(id));
      this.players = [];        // { id, token, name, color, connected }
      this.hostId = null;
      this.phase = 'lobby';
      this.game = null;
      this.seq = 0;
      this.graceTimer = null;
      this.graceFor = null;
      this.closed = false;
    }

    // 戻り値 { id } または { error }
    join(token, name) {
      if (this.closed) return { error: '部屋が見つかりません' };
      const back = this.players.find(p => p.token === token);
      if (back) {
        back.connected = true;
        if (this.game) this.note(`🔌 ${back.name} が戻ってきました`);
        this.changed();
        return { id: back.id };
      }
      if (this.phase !== 'lobby') return { error: 'ゲーム中のため参加できません' };
      if (this.players.length >= E.RULES.maxPlayers) return { error: `満員です（最大${E.RULES.maxPlayers}人）` };
      let base = cleanName(name), n = base, i = 2;
      while (this.players.some(p => p.name === n)) n = base + (i++);
      const p = { id: 'p' + (++this.seq), token, name: n, color: COLORS.find(c => !this.players.some(x => x.color === c)), connected: true };
      this.players.push(p);
      if (!this.hostId) this.hostId = p.id;
      this.changed();
      return { id: p.id };
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
        case 'start': {
          if (id !== this.hostId) return err('ゲームを始められるのはホストだけです');
          if (this.phase !== 'lobby') return;
          if (this.players.length < E.RULES.minPlayers) return err(`${E.RULES.minPlayers}人以上でないと始められません`);
          this.game = E.createGame(this.players.map(x => ({ id: x.id, name: x.name, color: x.color })), this.rng);
          this.phase = 'game';
          this.changed();
          return;
        }
        case 'act': {
          if (this.phase !== 'game' || !this.game) return;
          const r = E.apply(this.game, id, msg.action);
          if (!r.ok) return err(r.error);
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

    // 状態が変わったら：切断した人を待っていないか確かめてから全員に配信
    changed() {
      this.checkGrace();
      this.broadcast();
    }

    checkGrace() {
      const wait = this.game && this.phase === 'game' ? E.waitingFor(this.game) : null;
      const p = wait && this.players.find(x => x.id === wait);
      const need = p && !p.connected ? wait : null;
      if (need === this.graceFor) return;
      if (this.graceTimer) this.clearTimer(this.graceTimer);
      this.graceTimer = null;
      this.graceFor = need;
      if (!need) return;
      this.graceUntil = Date.now() + GRACE_MS;
      this.graceTimer = this.setTimer(() => this.autoAct(need), GRACE_MS);
    }

    // 切断中の人の代わりに進める（暫定）：
    // 防御は防御トークンがあれば出す・攻撃は諦める・手番は終了
    autoAct(id) {
      this.graceTimer = null;
      this.graceFor = null;
      const g = this.game;
      if (this.closed || !g || g.over || E.waitingFor(g) !== id) return;
      const p = this.players.find(x => x.id === id);
      if (p && p.connected) return;
      const gp = g.players.find(x => x.id === id);
      let action;
      if (g.pending && g.pending.stage === 'defend') action = { type: 'defend', use: gp.defense > 0 };
      else if (g.pending) action = { type: 'attack', use: false };
      else action = { type: 'endTurn' };
      this.note(`⏳ ${gp.name} が切断中のため自動で進めます`);
      E.apply(g, id, action);
      this.changed();
    }

    view() {
      const g = this.game;
      return {
        code: this.code,
        phase: this.phase,
        hostId: this.hostId,
        players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, connected: p.connected })),
        graceFor: this.graceFor,
        graceLeftMs: this.graceFor ? Math.max(0, this.graceUntil - Date.now()) : 0,
        game: g ? Object.assign({}, g, { log: g.log.slice(-LOG_SEND) }) : null,
      };
    }

    broadcast() {
      if (this.closed) return;
      const room = this.view();
      for (const p of this.players) if (p.connected) this.sendFn(p.id, { type: 'state', you: p.id, room });
    }

    close() {
      this.closed = true;
      if (this.graceTimer) this.clearTimer(this.graceTimer);
    }
  }

  return { Room, COLORS, GRACE_MS };
});
