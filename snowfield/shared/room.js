/*
 * Snowfield — 部屋（ロビー・ゲーム進行・CPU・切断の扱い）
 * ホスト権威型：ホストのブラウザで Room を動かし、参加者からの要求を handle() で受けて
 * ルール上できるかを engine で確かめてから状態を更新し、全員に最新の状態を配信する。
 * CPU もここで動かす（ホストのブラウザの中で考えて行動する）。
 *
 * new Room({ code, send(playerId, msg), rng, now, setTimer, clearTimer })
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'), require('./cpu'));
  else root.SnowRoom = factory(root.SnowEngine, root.SnowCpu);
})(typeof self !== 'undefined' ? self : this, function (E, CPU) {
  'use strict';

  // 駒の色（先頭から順に、空いている色が割り当てられる）と形
  const COLORS = ['blue', 'red', 'green', 'orange', 'purple', 'yellow', 'cyan', 'pink', 'indigo', 'brown', 'white', 'black'];
  const SHAPES = ['circle', 'square', 'diamond', 'up', 'down', 'hex'];
  const CPU_MS = [600, 1100];     // CPU が次の行動をするまでの間隔
  const AWAY_MS = 4000;           // 切断中の人の手番を自動で終えるまでの時間
  const CPU_ACTION_LIMIT = 60;    // CPU が1手番に行動する回数の上限（無限ループよけ）
  const VOTE_COOL_MS = 6000;      // 投票が終わってから、CPU が次の投票を言い出すまでの間隔

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
      this.players = [];      // { id, token, name, color, connected, cpu }
      this.hostId = null;
      this.phase = 'lobby';
      this.game = null;
      this.seq = 0;
      this.timer = null;
      this.turnTimer = null;     // 手番の制限時間
      this.turnKey = '';
      this.moveReqs = {};         // 「どいて」のお願い（相手の id → { from, avoid, at }）
      this.moveReqAt = {};
      this.tutorial = false;     // チュートリアル中は、手番の制限時間をつけない
      this.turnEndsAt = 0;
      this.mem = {};          // CPU ごとの覚え書き
      this.cpuActs = 0;
      this.voteCool = 0;
      this.settings = { simul: true };     // 同時に動くか（false なら、順番に動く）
      this.closed = false;
    }

    // 戻り値 { id } または { error }
    // version：参加者のバージョン（ホスト自身・CPU対戦は渡さない）。違うと入れない
    join(token, name, version) {
      if (this.closed) return { error: '部屋が見つかりません' };
      if (version !== undefined && version !== E.VERSION) return { error: `バージョンが違います（この部屋は v${E.VERSION}、あなたは v${version === '0' ? '不明（古い版）' : version}）。ページを再読み込みして、最新版にしてください` };
      const back = this.players.find(p => !p.cpu && p.token === token);
      if (back) {
        back.connected = true;
        this.setAway(back.id, false);
        if (this.game) this.note(`${back.name} が戻ってきました`);
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
      const free = (c, sh) => !this.players.some(x => x.color === c && x.shape === sh);
      // 形と色の組み合わせが、ほかの人と重ならないように割り当てる（まず色を、使い切ったら形を変える）
      let color = COLORS[0], shape = SHAPES[0];
      outer: for (const sh of SHAPES) for (const c of COLORS) if (free(c, sh)) { color = c; shape = sh; break outer; }
      const p = { id: 'p' + (++this.seq), token, name: n, connected: true, cpu, color, shape };
      this.players.push(p);
      return p;
    }

    note(text) { if (this.game) E.log(this.game, text); }

    setAway(id, away) {
      if (!this.game) return;
      const gp = E.pl(this.game, id);
      if (gp) gp.away = away;
      E.resolveVote(this.game);
    }

    disconnect(id) {
      const p = this.players.find(x => x.id === id);
      if (!p || p.cpu) return;
      if (this.phase === 'lobby') {
        this.players = this.players.filter(x => x !== p);
        if (this.hostId === id) this.hostId = (this.players.find(x => !x.cpu) || {}).id || null;
      } else {
        p.connected = false;
        this.setAway(id, true);
        this.note(`${p.name} の接続が切れました（手番は自動で終わります）`);
      }
      this.changed();
    }

    view() {
      return {
        turnLeft: this.turnEndsAt ? Math.max(0, this.turnEndsAt - this.now()) : null,
        version: E.VERSION, settings: this.settings, code: this.code, phase: this.phase, hostId: this.hostId, min: E.RULES.minPlayers, max: E.RULES.maxPlayers,
        players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, shape: p.shape, cpu: p.cpu, connected: p.connected })),
      };
    }

    broadcast() {
      const room = this.view();
      for (const p of this.players) {
        if (p.cpu || !p.connected) continue;
        this.sendFn(p.id, { type: 'state', you: p.id, room, game: this.game });
      }
    }
    changed() { this.syncTurnTimer(); this.broadcast(); this.schedule(); }

    // 制限時間：順番に動くときは、人間の手番ごと。同時に動くときは、ラウンドごと（人間がいるとき）。切れたら、自動で終える
    syncTurnTimer() {
      const g = this.game;
      const live = this.phase === 'game' && g && g.phase === 'play';
      const simul = live && E.simul(g);
      const c = live && !simul ? E.cur(g) : null;
      const key = !live ? '' : simul ? 'r' + g.round : g.round + ':' + g.turn;
      if (key === this.turnKey) return;
      this.turnKey = key;
      if (this.turnTimer) { this.clearTimer(this.turnTimer); this.turnTimer = null; }
      this.turnEndsAt = 0;
      const ms = simul ? E.RULES.roundLimitMs : E.RULES.turnLimitMs;
      const timed = simul ? g.players.some(p => !p.cpu && !p.away) : (c && !c.cpu && !c.away);
      if (live && timed && !this.tutorial) {
        this.turnEndsAt = this.now() + ms;
        this.turnTimer = this.setTimer(() => this.turnTimeout(key), ms);
      }
    }
    turnTimeout(key) {
      this.turnTimer = null;
      const g = this.game;
      if (this.closed || this.phase !== 'game' || !g || g.phase !== 'play' || key !== this.turnKey) return;
      if (E.simul(g)) {
        this.note('ラウンドの制限時間が切れた');
        for (const p of g.players) this.finishPending(p.id);
        E.forceEndRound(g);
        return this.changed();
      }
      const c = E.cur(g);
      this.note(`${c.name}：手番の制限時間が切れた`);
      this.finishPending(c.id);
      this.doAct(c.id, { type: 'end' });
    }
    // 上限を超えたアイテムの選択が残っていたら、「捨てる」にして閉じる
    finishPending(pid) {
      const g = this.game;
      let guard = 0;
      while (g.pending.some(q => q.pid === pid) && guard++ < 20) E.act(g, pid, { type: 'overflow', drop: {} });
    }
    human(id) { const p = this.players.find(x => x.id === id); return !!p && !p.cpu; }
    toast(id, text, tone, sfx) { if (this.human(id)) this.sendFn(id, { type: 'toast', text, tone: tone || '', sfx: sfx || '' }); }
    error(id, text) { if (this.human(id)) this.sendFn(id, { type: 'error', text }); }

    handle(id, msg) {
      if (this.closed || !msg || typeof msg.type !== 'string') return;
      const me = this.players.find(p => p.id === id);
      if (!me) return;
      const host = id === this.hostId;
      switch (msg.type) {
        case 'addCpu': {
          if (!host || this.phase !== 'lobby') return;
          if (this.players.length >= E.RULES.maxPlayers) return this.error(id, `満員です（最大${E.RULES.maxPlayers}人）`);
          const n = this.players.filter(p => p.cpu).length + 1;
          this.addPlayer({ token: null, name: `CPU${n}`, cpu: true });
          return this.changed();
        }
        case 'removeCpu': {
          if (!host || this.phase !== 'lobby') return;
          const p = this.players.find(x => x.id === msg.id && x.cpu);
          if (p) { this.players = this.players.filter(x => x !== p); this.changed(); }
          return;
        }
        case 'settings': {   // ホストが、ゲームの設定を変える（ロビーで）
          if (!host || this.phase !== 'lobby') return;
          if (typeof msg.simul === 'boolean') this.settings.simul = msg.simul;
          return this.changed();
        }
        case 'style': {      // 自分の駒の形と色（ロビーで）
          if (this.phase !== 'lobby') return;
          const shape = msg.shape !== undefined ? msg.shape : me.shape, color = msg.color !== undefined ? msg.color : me.color;
          if (!SHAPES.includes(shape) || !COLORS.includes(color)) return;
          if (this.players.some(p => p !== me && p.color === color && p.shape === shape)) return this.error(id, 'ほかの人と、形も色も同じです。どちらかを変えてください');
          me.shape = shape; me.color = color;
          return this.changed();
        }
        case 'start': {
          if (!host || this.phase !== 'lobby') return;
          if (this.players.length < E.RULES.minPlayers) return this.error(id, `${E.RULES.minPlayers}人以上で始められます（CPUも入れられます）`);
          this.phase = 'game';
          this.mem = {};
          this.voteCool = 0;
          this.game = E.createGame({
            seed: Math.floor(this.rng() * 4294967296),
            players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, shape: p.shape, cpu: p.cpu })),
            simul: this.settings.simul,
          });
          for (const p of this.players) if (!p.cpu && !p.connected) E.pl(this.game, p.id).away = true;
          return this.changed();
        }
        case 'toLobby': {
          if (!host || this.phase !== 'game' || !this.game || this.game.phase === 'play') return;
          this.phase = 'lobby';
          this.game = null;
          this.players = this.players.filter(p => p.cpu || p.connected);
          this.clearCpuTimer();
          return this.changed();
        }
        case 'moveReq': {     // ほかの駒が道をふさいでいるとき、移動をお願いする
          const g = this.game;
          if (this.phase !== 'game' || !g || g.phase !== 'play') return;
          const from = E.pl(g, id), to = E.pl(g, msg.to);
          if (!from || !to || to.id === id) return;
          if (this.now() - (this.moveReqAt[id] == null ? -1e9 : this.moveReqAt[id]) < 2000) return this.error(id, 'お願いは、少し間をあけてください');
          let avoid = [];
          if (Number.isInteger(msg.x) && Number.isInteger(msg.y)) {
            const info = E.pathBlockers(g, from, msg.x, msg.y);
            if (!info.blockers.some(b => b.id === to.id)) return this.error(id, `${to.name}は、道をふさいでいません`);
            avoid = info.path;
          }
          this.moveReqAt[id] = this.now();
          if (to.cpu || to.away) {                        // CPU と切断中の人は、すぐに空ける
            const r = E.act(g, to.id, { type: 'moveAside', avoid });
            this.toast(id, r.ok ? `${to.name}が道を空けました` : `${to.name}は動けません：${r.why}`, r.ok ? '' : 'bad');
            if (r.ok) this.changed();
          } else {
            this.moveReqs[to.id] = { from: id, avoid, at: this.now() };
            this.sendFn(to.id, { type: 'moveReq', from: id, fromName: from.name });
            this.toast(id, `${to.name}に、移動をお願いしました`);
          }
          return;
        }
        case 'moveReqReply': {
          const g = this.game, rq = this.moveReqs[id];
          if (!rq || !g || g.phase !== 'play') return;
          delete this.moveReqs[id];
          const me_ = E.pl(g, id);
          if (this.now() - rq.at > 60000) return;
          if (!msg.accept) { this.toast(rq.from, `${me_.name}は、ことわりました`, 'bad'); return; }
          const r = E.act(g, id, { type: 'moveAside', avoid: rq.avoid });
          this.toast(id, r.ok ? '道を空けました' : `動けません：${r.why}`, r.ok ? '' : 'bad');
          this.toast(rq.from, r.ok ? `${me_.name}が道を空けました` : `${me_.name}は動けません：${r.why}`, r.ok ? '' : 'bad');
          if (r.ok) this.changed();
          return;
        }
        case 'act': {
          if (this.phase !== 'game' || !this.game) return;
          return this.doAct(id, msg.a);
        }
        default:
      }
    }

    doAct(id, a) {
      const g = this.game;
      const had = !!g.vote;
      const r = E.act(g, id, a);
      if (!r.ok) { this.error(id, r.why); return r; }
      if (r.msg || r.sfx) this.toast(id, r.msg, r.good === false ? 'bad' : '', r.sfx);
      if (had && !g.vote) this.voteCool = this.now() + VOTE_COOL_MS;
      this.changed();
      return r;
    }

    // ---------- CPU・切断中の人の手番 ----------
    clearCpuTimer() { if (this.timer) { this.clearTimer(this.timer); this.timer = null; } }
    // 動かす必要のある CPU・切断中の人がいるか（1：CPU、2：切断中の人だけ）
    cpuWork() {
      const g = this.game;
      if (this.phase !== 'game' || !g || g.phase !== 'play') return 0;
      if (E.simul(g)) {
        if (g.players.some(p => p.cpu && !p.done)) return 1;
        if (g.players.some(p => p.away && !p.done)) return 2;
      } else {
        const c = E.cur(g);
        if (c.cpu) return 1;
        if (c.away) return 2;
      }
      for (const p of g.players) if (p.cpu && this.voteFor(p.id)) return 1;
      return 0;
    }
    voteFor(pid) {
      const g = this.game;
      if (!g.vote && this.now() < this.voteCool) return null;
      return CPU.voteIntent(g, pid);
    }
    schedule() {
      if (this.timer || this.closed) return;
      const w = this.cpuWork();
      if (!w) return;
      const ms = w === 2 ? AWAY_MS : CPU_MS[0] + Math.floor(this.rng() * (CPU_MS[1] - CPU_MS[0]));
      this.timer = this.setTimer(() => { this.timer = null; this.cpuStep(); }, ms);
    }
    cpuStep() {
      const g = this.game;
      if (this.closed || this.phase !== 'game' || !g || g.phase !== 'play') return;
      // 投票は手番に関係なく、CPU が1票ずつ入れる
      for (const p of g.players) {
        if (!p.cpu) continue;
        const v = this.voteFor(p.id);
        if (v) {
          if (!this.doAct(p.id, v).ok) this.voteCool = this.now() + VOTE_COOL_MS;
          this.schedule();
          return;
        }
      }
      if (E.simul(g)) {
        // 同時に動く：CPU が1人1回ずつ行動する（切断中の人は、すぐに行動を終える）
        const key = 'r' + g.round;
        if (this.cpuKey !== key) { this.cpuKey = key; this.cpuCount = {}; }
        for (const p of g.players.slice()) {
          if (g.phase !== 'play' || p.done) continue;
          if (p.cpu) {
            const mem = this.mem[p.id] || (this.mem[p.id] = {});
            const n = this.cpuCount[p.id] = (this.cpuCount[p.id] || 0) + 1;
            const a = n > CPU_ACTION_LIMIT ? { type: 'end' } : CPU.decide(g, p.id, mem);
            const r = this.doAct(p.id, a);
            if (!r.ok && a.type !== 'end') this.doAct(p.id, { type: 'end' });
          } else if (p.away) {
            this.finishPending(p.id);
            this.doAct(p.id, { type: 'end' });
          }
        }
        this.schedule();
        return;
      }
      const c = E.cur(g);
      if (c.cpu) {
        const mem = this.mem[c.id] || (this.mem[c.id] = {});
        const key = g.round + ':' + g.turn;
        if (this.cpuKey !== key) { this.cpuKey = key; this.cpuActs = 0; }
        let a = ++this.cpuActs > CPU_ACTION_LIMIT ? { type: 'end' } : CPU.decide(g, c.id, mem);
        let r = this.doAct(c.id, a);
        if (!r.ok && a.type !== 'end') r = this.doAct(c.id, { type: 'end' });   // できなかったら手番を終える
      } else if (c.away) {
        this.finishPending(c.id);
        this.doAct(c.id, { type: 'end' });
      }
      this.schedule();
    }

    close() {
      this.closed = true;
      if (this.turnTimer) { this.clearTimer(this.turnTimer); this.turnTimer = null; }
      this.clearCpuTimer();
    }
  }

  return { Room, COLORS, SHAPES, CPU_MS, AWAY_MS, VOTE_COOL_MS };
});
