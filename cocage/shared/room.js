/*
 * Cocage — 部屋（ロビー・ゲーム進行・切断の扱い）
 * ホスト権威型：ホストのブラウザでこの Room を動かし、参加者からの要求を handle() で受けて、
 * ルール上可能かを確かめてから状態を更新し、全員に最新の状態を配信する。CPU もここで動かす。
 * 行動は同時に決める。ほかの人の計画・確定の状況は、本人以外には見せない（確定の順番や時刻が勝敗に影響しないように）。
 *
 * new Room({ code, send(playerId, msg), rng, now, setTimer, clearTimer })
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./cpu'));
  else root.CocageRoom = factory(root.CocageEngine, root.CocageCpu);
})(typeof self !== 'undefined' ? self : this, function (E, CPU) {
  'use strict';

  const CPU_MS = [1500, 4000];   // CPU が行動を決めるまでの時間（この範囲でばらつかせる）
  const CPU_STEP_MS = 350;       // CPU が1つ置くごとの間

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
      this.now = opts.now || (() => Date.now());
      this.players = [];        // { id, token, name, connected, cpu, level }
      this.hostId = null;
      this.phase = 'lobby';
      this.game = null;
      this.seq = 0;
      this.timers = {};         // turn / cpu:<id>
      this.turnDeadline = 0;
      this.turnSeq = 0;         // 何ターン目の予約か（古い予約を捨てるため）
      this.closed = false;
    }

    // 戻り値 { id } または { error }
    join(token, name) {
      if (this.closed) return { error: '部屋が見つかりません' };
      const back = this.players.find(p => !p.cpu && p.token === token);
      if (back) {
        back.connected = true;
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
      const p = { id: 'p' + (++this.seq), token, name: n, connected: true, cpu };
      if (cpu) p.level = 'normal';
      this.players.push(p);
      return p;
    }

    disconnect(id) {
      const p = this.players.find(x => x.id === id);
      if (!p || !p.connected) return;
      p.connected = false;
      if (this.phase === 'lobby') this.players = this.players.filter(x => x !== p);
      this.changed();
    }

    handle(id, msg) {
      if (this.closed || !msg || typeof msg !== 'object') return;
      const p = this.players.find(x => x.id === id);
      if (!p) return;
      const err = text => this.sendFn(id, { type: 'error', text });
      switch (msg.type) {
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
        case 'removePlayer': {
          if (id !== this.hostId || this.phase !== 'lobby') return;
          const t = this.players.find(x => x.id === msg.target && x.cpu);
          if (!t) return;
          this.players = this.players.filter(x => x !== t);
          this.changed();
          return;
        }
        case 'start': {
          if (id !== this.hostId) return err('ゲームを始められるのはホストだけです');
          if (this.phase !== 'lobby') return;
          if (this.players.length < E.RULES.minPlayers) return err(`${E.RULES.minPlayers}人以上でないと始められません`);
          this.game = E.createGame(this.players.map(x => ({ id: x.id, name: x.name })), this.rng);
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

    // 状態が変わったら：全員そろっていれば次へ → 時間切れ・CPU の予約を見直す → 全員に配信
    changed() {
      this.checkAdvance();
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

    // 確定を待つ相手か（CPU と、接続中の人）。切断中の人は、いまの計画のまま確定したものとみなす
    isPlaying(id) {
      const info = this.player(id);
      return !!info && (info.cpu || info.connected);
    }

    live() { return !!this.game && this.phase === 'game' && !this.game.over; }

    // 待つ相手の全員が確定したら、制限時間を待たずに次へ
    checkAdvance() {
      if (!this.live()) return;
      const g = this.game;
      if (g.players.every(p => p.finished || !this.isPlaying(p.id))) this.resolve();
    }

    resolve() {
      this.stop('turn');
      for (const p of this.players) this.stop('cpu:' + p.id);
      E.resolveTurn(this.game, this.rng);
      this.turnSeq++;
    }

    // 1ターン 90 秒。時間になったら、その時点の計画のまま自動で確定して進める
    checkTimers() {
      if (!this.live()) {
        this.stop('turn');
        return;
      }
      if (!this.timers.turn) {
        const ms = E.RULES.turnSeconds * 1000;
        this.turnDeadline = this.now() + ms;
        this.timer('turn', () => { this.resolve(); this.changed(); }, ms);
      }
    }

    // CPU：ターンの始まりのあと、ばらつきのある時間をおいて、行動を決めて確定する
    checkCpu() {
      const live = this.live();
      for (const p of this.players) {
        if (!p.cpu) continue;
        const name = 'cpu:' + p.id;
        const gp = live ? this.game.players.find(x => x.id === p.id) : null;
        if (!gp || gp.finished) { this.stop(name); continue; }
        if (!this.timers[name]) {
          const seq = this.turnSeq;
          this.timer(name, () => this.cpuAct(p.id, seq), CPU_MS[0] + Math.floor(this.rng() * (CPU_MS[1] - CPU_MS[0])));
        }
      }
    }

    // CPU が1つ置く。置けなくなるか3つ置いたら確定する
    cpuAct(id, seq) {
      const g = this.game;
      if (this.closed || !this.live() || seq !== this.turnSeq) return;
      const gp = g.players.find(x => x.id === id), info = this.player(id);
      if (!gp || !info || gp.finished) return;
      const a = E.planCost(gp.plan) < E.RULES.ap ? CPU.nextAction(g, id, this.rng, info.level) : null;
      if (a && E.apply(g, id, a).ok) {
        this.broadcast();
        this.timer('cpu:' + id, () => this.cpuAct(id, seq), CPU_STEP_MS);
        return;
      }
      E.apply(g, id, { type: 'finish', on: true });
      this.changed();
    }

    // その人に送る状態。ほかの人の計画と確定の状況は伏せる（確定した人の数だけ知らせる）
    view(forId) {
      const g = this.game;
      let game = null, finishedCount = 0;
      if (g) {
        finishedCount = g.players.filter(p => p.finished && !g.over).length;
        game = Object.assign({}, g, {
          players: g.players.map(p => p.id === forId ? p : Object.assign({}, p, { plan: [], finished: false })),
        });
      }
      return {
        code: this.code,
        phase: this.phase,
        hostId: this.hostId,
        players: this.players.map(p => ({ id: p.id, name: p.name, connected: p.connected, cpu: !!p.cpu, level: p.cpu ? p.level : undefined })),
        turnLeftMs: this.live() ? Math.max(0, this.turnDeadline - this.now()) : 0,
        finishedCount,
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

  return { Room, CPU_MS, CPU_STEP_MS };
});
