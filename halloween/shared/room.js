/*
 * ハロウィンお菓子ゲーム — ルーム（ロビー・ゲーム進行・チャット・CPU）
 * 判定と進行はすべてここで行い、各プレイヤーには viewFor() で
 * 「その人が見てよい情報」だけを送る。
 * サーバー（server.js）でもブラウザのCPU対戦でも同じものを使う。
 *
 * new Room({ code, offline, send(playerId, msg), onEmpty(), rng, now })
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./config'), require('./engine'), require('./cpu'));
  } else {
    root.HalloweenRoom = factory(root.HalloweenConfig, root.HalloweenEngine, root.HalloweenCpu);
  }
})(typeof self !== 'undefined' ? self : this, function (C, E, CPU) {
  'use strict';

  const R = C.RULES;

  function chars(s) { return Array.from(String(s)); }

  function cleanText(s, max) {
    return chars(String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, max).join('').trim();
  }

  class Room {
    constructor(opts) {
      this.code = opts.code || '';
      this.offline = !!opts.offline;
      this.sendFn = opts.send;
      this.onEmpty = opts.onEmpty || (() => {});
      this.rng = opts.rng || Math.random;
      this.now = opts.now || (() => Date.now());
      this.settings = C.normalizeSettings({});
      this.players = [];            // 参加順
      this.hostId = null;
      this.kicked = new Set();      // キックされた識別子
      this.seq = 0;
      this.chatSeq = 0;
      this.chat = [];
      this.phase = 'lobby';
      this.round = 0;
      this.houses = [];
      this.hints = {};
      this.leaders = [];
      this.deadline = 0;
      this.phaseStart = 0;
      this.result = null;
      this.final = null;
      this.timer = null;
      this.cpuTimers = [];
      this.removeTimers = {};
      this.emptyTimer = null;
      this.flushQueued = false;
      this.closed = false;
    }

    // ---------- 参加・切断 ----------

    // 戻り値 { id } または { error }
    join(token, name, icon) {
      if (this.closed) return { error: 'ルームが見つかりません' };
      const back = this.players.find(p => !p.cpu && p.token === token);
      if (back) {
        back.connected = true;
        this.clearRemoveTimer(back.id);
        this.cancelEmpty();
        this.sys(`🔌 ${back.name} が戻ってきました`, 'info');
        this.checkProgress();
        return { id: back.id };
      }
      if (this.kicked.has(token)) return { error: 'このルームからキックされました' };
      if (this.phase !== 'lobby') return { error: 'ゲーム中のため参加できません' };
      if (this.players.length >= R.maxPlayers) return { error: `満員です（最大${R.maxPlayers}人）` };
      const p = this.addPlayer({ token, name, icon, cpu: false });
      this.cancelEmpty();
      this.sys(`👋 ${p.icon}${p.name} が参加しました`, 'info');
      return { id: p.id };
    }

    // 接続がそろったら呼ぶ：最初の状態とチャット履歴を送る
    attach(id) {
      const p = this.get(id);
      if (!p) return;
      this.sendFn(id, { type: 'welcome', id, code: this.code, offline: this.offline });
      this.sendFn(id, { type: 'chatlog', list: this.chat });
      this.queueFlush();
    }

    disconnect(id) {
      const p = this.get(id);
      if (!p || p.cpu || !p.connected) return;
      p.connected = false;
      if (this.phase === 'lobby') {
        this.removeTimers[id] = setTimeout(() => this.removePlayer(id, `🚪 ${p.name} が抜けました`), R.lobbyGrace * 1000);
      } else {
        this.sys(`🔌 ${p.name} の接続が切れました`, 'info');
      }
      if (!this.players.some(q => !q.cpu && q.connected)) {
        this.emptyTimer = setTimeout(() => this.close(), R.emptyRoomGrace * 1000);
      }
      this.checkProgress();
      this.queueFlush();
    }

    addPlayer({ token, name, icon, cpu }) {
      const p = {
        id: 'p' + (++this.seq), token, cpu, connected: true,
        name: this.uniqueName(cleanText(name, R.nameMax) || 'ゲスト', null),
        icon: this.freeIcon(icon, null),
        lastChat: 0,
      };
      this.resetPlayer(p);
      this.players.push(p);
      if (!cpu && !this.hostId) this.hostId = p.id;
      this.queueFlush();
      return p;
    }

    resetPlayer(p) {
      Object.assign(p, {
        candy: 0, stats: { house: 0, steal: 0, mission: 0 },
        mission: null, missionFrom: 1, achieved: [], lastGot: null,
        choice: null, confirmed: false, timedOut: false, skip: false, next: false, declare: null,
      });
    }

    removePlayer(id, message) {
      const i = this.players.findIndex(p => p.id === id);
      if (i < 0) return;
      this.clearRemoveTimer(id);
      this.players.splice(i, 1);
      if (message) this.sys(message, 'info');
      if (this.hostId === id) {
        const next = this.players.find(p => !p.cpu && p.connected) || this.players.find(p => !p.cpu);
        this.hostId = next ? next.id : null;
        if (next) this.sys(`🏠 ${next.name} が新しいホストになりました`, 'info');
      }
      if (!this.players.some(p => !p.cpu)) { this.close(); return; }
      this.checkProgress();
      this.queueFlush();
    }

    clearRemoveTimer(id) {
      if (this.removeTimers[id]) { clearTimeout(this.removeTimers[id]); delete this.removeTimers[id]; }
    }

    cancelEmpty() {
      if (this.emptyTimer) { clearTimeout(this.emptyTimer); this.emptyTimer = null; }
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.clearTimers();
      this.cancelEmpty();
      Object.keys(this.removeTimers).forEach(id => this.clearRemoveTimer(id));
      this.onEmpty();
    }

    get(id) { return this.players.find(p => p.id === id) || null; }
    humans() { return this.players.filter(p => !p.cpu); }

    uniqueName(name, selfId) {
      const taken = n => this.players.some(p => p.id !== selfId && p.name === n);
      if (!taken(name)) return name;
      for (let k = 2; ; k++) {
        const suffix = String(k);
        const cand = chars(name).slice(0, R.nameMax - suffix.length).join('') + suffix;
        if (!taken(cand)) return cand;
      }
    }

    freeIcon(icon, selfId) {
      const used = new Set(this.players.filter(p => p.id !== selfId).map(p => p.icon));
      if (C.ICONS.indexOf(icon) >= 0 && !used.has(icon)) return icon;
      return C.ICONS.find(i => !used.has(i)) || C.ICONS[0];
    }

    // ---------- 送信 ----------

    sys(text, tone) {
      this.pushChat({ kind: 'sys', tone: tone || 'info', text });
    }

    pushChat(entry) {
      entry.id = ++this.chatSeq;
      entry.ts = this.now();
      this.chat.push(entry);
      if (this.chat.length > R.chatLog) this.chat.shift();
      for (const p of this.players) if (!p.cpu && p.connected) this.sendFn(p.id, { type: 'chat', msg: entry });
    }

    queueFlush() {
      if (this.flushQueued || this.closed) return;
      this.flushQueued = true;
      setTimeout(() => {
        this.flushQueued = false;
        if (this.closed) return;
        for (const p of this.players) if (!p.cpu && p.connected) this.sendFn(p.id, { type: 'state', state: this.viewFor(p.id) });
      }, 0);
    }

    // ---------- 操作 ----------

    handle(id, msg) {
      const p = this.get(id);
      if (!p || !msg || typeof msg.type !== 'string' || this.closed) return;
      const isHost = id === this.hostId;
      const lobby = this.phase === 'lobby';
      switch (msg.type) {
        case 'chat': return this.onChat(p, msg.text, false);
        case 'stamp': return this.onChat(p, msg.emoji, true);
        case 'profile':
          if (!lobby) return;
          if (msg.name !== undefined) p.name = this.uniqueName(cleanText(msg.name, R.nameMax) || p.name, p.id);
          if (msg.icon !== undefined) p.icon = this.freeIcon(msg.icon, p.id) === msg.icon ? msg.icon : p.icon;
          return this.queueFlush();
        case 'settings':
          if (!lobby || !isHost) return;
          this.settings = C.normalizeSettings(msg.settings, this.settings);
          return this.queueFlush();
        case 'resetSettings':
          if (!lobby || !isHost) return;
          this.settings = C.normalizeSettings({});
          return this.queueFlush();
        case 'addCpu':
          if (!lobby || !isHost || this.players.length >= R.maxPlayers) return;
          this.addCpu();
          return;
        case 'removeCpu': {
          const t = this.get(msg.id);
          if (!lobby || !isHost || !t || !t.cpu) return;
          return this.removePlayer(t.id, null);
        }
        case 'kick': {
          const t = this.get(msg.id);
          if (!lobby || !isHost || !t || t.cpu || t.id === id) return;
          this.kicked.add(t.token);
          this.sendFn(t.id, { type: 'kicked' });
          return this.removePlayer(t.id, `🚪 ${t.name} はキックされました`);
        }
        case 'start':
          if (!lobby || !isHost || this.players.length < R.minPlayers) return;
          return this.startGame();
        case 'skip':
          if (this.phase !== 'talk') return;
          p.skip = !p.skip;
          this.checkProgress();
          return this.queueFlush();
        case 'declare': return this.onDeclare(p, msg.house);
        case 'confirm': {
          const h = msg.house;
          if (this.phase !== 'choose' || p.confirmed || !Number.isInteger(h) || h < 0 || h >= this.houses.length) return;
          p.choice = h;
          p.confirmed = true;
          this.checkProgress();
          return this.queueFlush();
        }
        case 'next':
          if (this.phase !== 'result' || this.now() < this.phaseStart + R.resultMinTime * 1000) return;
          p.next = true;
          this.checkProgress();
          return this.queueFlush();
        case 'playAgain':
          if (this.phase !== 'final') return;
          return this.toLobby();
      }
    }

    onChat(p, raw, stamp) {
      const t = this.now();
      if (t - p.lastChat < 300) return;
      if (stamp) {
        if (C.STAMPS.indexOf(raw) < 0) return;
      }
      const text = stamp ? raw : cleanText(raw, R.chatMax);
      if (!text) return;
      p.lastChat = t;
      this.pushChat({ kind: stamp ? 'stamp' : 'user', pid: p.id, name: p.name, icon: p.icon, text });
    }

    onDeclare(p, house) {
      if (this.phase !== 'talk' && this.phase !== 'choose') return;
      const h = house === null ? null : house;
      if (h !== null && (!Number.isInteger(h) || h < 0 || h >= this.houses.length)) return;
      if (p.declare === h) return;
      p.declare = h;
      if (h === null) this.pushChat({ kind: 'sys', tone: 'declare', text: `📣 ${p.icon}${p.name} が宣言を取り消しました` });
      else this.pushChat({ kind: 'sys', tone: 'declare', text: `📣 ${p.icon}${p.name}「${h + 1}番の家に行く！」` });
      this.queueFlush();
    }

    addCpu() {
      const usedNames = new Set(this.players.map(p => p.name));
      const name = C.CPU_NAMES.find(n => !usedNames.has(n)) || 'CPU';
      const free = C.ICONS.filter(i => !this.players.some(p => p.icon === i));
      const icon = free.length ? free[E.randInt(this.rng, free.length)] : C.ICONS[0];
      const p = this.addPlayer({ token: null, name, icon, cpu: true });
      this.sys(`🤖 CPU ${p.icon}${p.name} が参加しました`, 'info');
      return p;
    }

    // ---------- 進行 ----------

    clearTimers() {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.cpuTimers.forEach(t => clearTimeout(t));
      this.cpuTimers = [];
    }

    setPhase(phase, seconds, onTimeout) {
      this.clearTimers();
      this.phase = phase;
      this.phaseStart = this.now();
      this.deadline = seconds ? this.phaseStart + seconds * 1000 : 0;
      if (seconds) this.timer = setTimeout(onTimeout, seconds * 1000);
    }

    cpuLater(seconds, fn) {
      this.cpuTimers.push(setTimeout(() => { if (!this.closed) fn(); }, seconds * 1000));
    }

    startGame() {
      for (const p of this.players) {
        this.resetPlayer(p);
        if (this.settings.missions) p.mission = E.randomMission(this.rng);
      }
      this.round = 0;
      this.final = null;
      this.sys(`🎃 ゲーム開始！ ${this.players.length}人・${this.settings.rounds}集落`, 'arrive');
      this.startRound();
    }

    startRound() {
      this.round++;
      this.result = null;
      this.houses = E.makeHouses(this.settings, this.rng);
      this.hints = this.settings.hints ? E.dealHints(this.players.map(p => p.id), this.houses.length, this.rng) : {};
      this.leaders = E.leadersOf(this.players);
      for (const p of this.players) Object.assign(p, { choice: null, confirmed: false, timedOut: false, skip: false, next: false, declare: null });
      this.setPhase('talk', this.settings.talkTime, () => this.startChoose());
      const lead = this.leaders.length
        ? `👑 先頭：${this.leaders.map(id => this.get(id).name).join('・')}（${this.get(this.leaders[0]).candy}🍬）`
        : '👑 先頭：なし';
      this.sys(`🎃 第${this.round}集落に到着！（${this.round}/${this.settings.rounds}） ${lead}`, 'arrive');
      this.scheduleCpuTalk();
      this.checkProgress();
      this.queueFlush();
    }

    startChoose() {
      this.setPhase('choose', this.settings.chooseTime, () => this.resolve());
      this.sys('🏠 家を選ぶ時間です', 'arrive');
      const [lo, hi] = R.cpuChooseDelay;
      for (const p of this.players) {
        if (!p.cpu) continue;
        this.cpuLater(lo + this.rng() * (hi - lo), () => {
          if (this.phase !== 'choose' || p.confirmed) return;
          p.choice = CPU.chooseHouse(this.cpuContext(p), this.rng);
          p.confirmed = true;
          this.checkProgress();
          this.queueFlush();
        });
      }
      this.checkProgress();
      this.queueFlush();
    }

    cpuContext(p) {
      const declares = {};
      for (const q of this.players) if (q.declare !== null) declares[q.id] = q.declare;
      return {
        id: p.id, settings: this.settings, round: this.round,
        houses: this.houses.map(h => ({ amount: h.amount })),
        hint: this.hints[p.id] !== undefined ? { house: this.hints[p.id], state: this.houses[this.hints[p.id]].state } : null,
        players: this.players.map(q => ({ id: q.id, candy: q.candy })),
        leaders: this.leaders, declares,
        mission: p.mission, missionFrom: p.missionFrom, lastGot: p.lastGot,
      };
    }

    scheduleCpuTalk() {
      const windowSec = Math.min(R.cpuTalkWindow, this.settings.talkTime / 2);
      for (const p of this.players) {
        if (!p.cpu) continue;
        this.cpuLater(1 + this.rng() * windowSec, () => {
          if (this.phase !== 'talk') return;
          const line = CPU.chooseTalk(this.cpuContext(p), this.rng);
          if (line) this.pushChat({ kind: 'user', pid: p.id, name: p.name, icon: p.icon, text: line });
        });
        if (this.rng() < 0.7) {
          this.cpuLater(2 + this.rng() * windowSec, () => {
            if (this.phase !== 'talk') return;
            this.onDeclare(p, CPU.chooseDeclare(this.cpuContext(p), this.rng));
          });
        }
      }
    }

    // 待っている人がそろったら次へ進める
    checkProgress() {
      const active = this.players.filter(p => !p.cpu && p.connected);
      if (this.phase === 'talk') {
        if (active.length && active.every(p => p.skip)) this.startChoose();
      } else if (this.phase === 'choose') {
        if (this.players.every(p => p.confirmed || (!p.cpu && !p.connected))) this.resolve();
      } else if (this.phase === 'result') {
        if (active.length && active.every(p => p.next) && this.now() >= this.phaseStart + R.resultMinTime * 1000) this.advance();
      }
    }

    skipStatus() {
      const active = this.players.filter(p => !p.cpu && p.connected);
      return { count: active.filter(p => p.skip).length, need: active.length };
    }

    resolve() {
      if (this.phase !== 'choose') return;
      for (const p of this.players) {
        if (!p.confirmed) {
          p.choice = E.randInt(this.rng, this.houses.length);
          p.confirmed = true;
          p.timedOut = true;
          this.sys(`⏳ ${p.name} は${p.connected || p.cpu ? '時間切れ' : '切断中'} → ランダムな家へ`, 'info');
        }
      }
      const res = E.resolveRound({
        settings: this.settings, houses: this.houses, round: this.round, rng: this.rng,
        players: this.players.map(p => ({
          id: p.id, candy: p.candy, choice: p.choice,
          mission: p.mission, missionFrom: p.missionFrom, lastGot: p.lastGot,
        })),
      });
      for (const p of this.players) {
        const r = res.perPlayer[p.id];
        p.candy = r.newCandy;
        p.stats.house += r.houseDelta + r.clampFix;
        p.stats.steal += r.steal;
        p.stats.mission += r.missionBonus;
        p.lastGot = r.lastGot;
        if (r.mission) {
          p.achieved.push({ mission: r.mission, round: this.round });
          p.mission = r.newMission;
          p.missionFrom = this.round + 1;
        }
      }
      this.result = res;
      this.announce(res);
      this.setPhase('result', R.resultTime, () => this.advance());
      this.queueFlush();
    }

    announce(res) {
      const name = id => this.get(id).name;
      res.visitors.forEach((ids, h) => {
        if (!ids.length) return;
        const st = C.STATES[this.houses[h].state];
        const who = ids.map(name).join('・');
        if (res.collided[h]) {
          const witch = this.houses[h].state === 'witch' ? ` ${st.emoji}魔女！全員 −${this.settings.witchPenalty}` : `（${st.emoji}${st.name}）`;
          this.sys(`💥 ${h + 1}番の家で衝突：${who}${witch}`, this.houses[h].state === 'witch' ? 'witch' : 'collision');
        } else if (this.houses[h].state === 'witch') {
          this.sys(`🧙‍♀️ ${h + 1}番は魔女！ ${who} −${this.settings.witchPenalty}`, 'witch');
        } else if (this.houses[h].state === 'rich') {
          this.sys(`💰 ${h + 1}番はお金持ち！ ${who} +${res.perPlayer[ids[0]].houseDelta}🍬`, 'good');
        } else if (this.houses[h].state === 'away') {
          this.sys(`💤 ${h + 1}番は留守… ${who} +0`, 'info');
        } else {
          this.sys(`🍬 ${h + 1}番 ${who} +${res.perPlayer[ids[0]].houseDelta}🍬`, 'good');
        }
      });
      for (const t of res.thefts) {
        if (t.amount > 0) this.sys(`🤚 ${name(t.thief)} が 👑${name(t.leader)} から ${t.amount}個奪った！`, 'steal');
      }
      for (const p of this.players) {
        const r = res.perPlayer[p.id];
        if (r.mission) {
          const m = C.missionById(r.mission);
          this.sys(`📜 ${p.name} がミッション「${m.emoji}${m.name}」達成！ +${r.missionBonus}🍬`, 'mission');
        }
      }
    }

    advance() {
      if (this.phase !== 'result') return;
      if (this.round >= this.settings.rounds) this.finish();
      else this.startRound();
    }

    finish() {
      const ranks = E.rankOf(this.players);
      const ranking = this.players
        .map(p => ({
          id: p.id, rank: ranks[p.id], candy: p.candy, stats: Object.assign({}, p.stats),
          achieved: p.achieved.slice(), mission: p.mission,
        }))
        .sort((a, b) => a.rank - b.rank);
      this.final = { ranking };
      this.setPhase('final', 0);
      const winners = ranking.filter(r => r.rank === 1).map(r => this.get(r.id).name);
      this.sys(`🏆 ${winners.length > 1 ? '共同優勝' : '優勝'}：${winners.join('・')}（${ranking[0].candy}🍬）`, 'mission');
      this.queueFlush();
    }

    toLobby() {
      this.clearTimers();
      for (const p of this.players.slice()) {
        if (!p.cpu && !p.connected) this.removePlayer(p.id, `🚪 ${p.name} が抜けました`);
      }
      if (this.closed) return;
      this.players.forEach(p => this.resetPlayer(p));
      this.phase = 'lobby';
      this.round = 0;
      this.houses = [];
      this.hints = {};
      this.leaders = [];
      this.result = null;
      this.final = null;
      this.deadline = 0;
      this.sys('🏠 ロビーに戻りました', 'info');
      this.queueFlush();
    }

    // ---------- 見せる情報 ----------

    viewFor(id) {
      const me = this.get(id);
      const ph = this.phase;
      const inGame = ph !== 'lobby';
      const showDeclare = ph === 'talk' || ph === 'choose';
      const view = {
        you: id, code: this.code, offline: this.offline, hostId: this.hostId,
        phase: ph, round: this.round, serverNow: this.now(), deadline: this.deadline, phaseStart: this.phaseStart,
        resultMinTime: R.resultMinTime,
        settings: this.settings,
        players: this.players.map(p => ({
          id: p.id, name: p.name, icon: p.icon, cpu: p.cpu, connected: p.connected,
          candy: p.candy, leader: inGame && this.leaders.indexOf(p.id) >= 0,
          ready: ph === 'talk' ? p.skip : ph === 'choose' ? p.confirmed : ph === 'result' ? p.next : false,
          declare: showDeclare ? p.declare : null,
        })),
      };
      if (!inGame || !me) return view;

      const res = this.result;
      const reveal = (ph === 'result' || ph === 'final') && res;
      view.houses = this.houses.map((h, i) => ({ amount: h.amount, state: reveal ? res.revealed[i] : null }));
      view.skip = this.skipStatus();
      const hintHouse = this.hints[id];
      view.me = {
        hint: hintHouse !== undefined ? { house: hintHouse, state: this.houses[hintHouse].state } : null,
        mission: me.mission,
        choice: me.confirmed ? me.choice : null,
        timedOut: me.timedOut,
      };
      if (reveal) {
        view.result = {
          visitors: res.visitors, collided: res.collided,
          thefts: res.thefts.filter(t => t.amount > 0),
          deltas: {},
        };
        for (const p of this.players) {
          const r = res.perPlayer[p.id];
          view.result.deltas[p.id] = {
            choice: r.choice, house: r.houseDelta, steal: r.steal,
            mission: r.mission, missionBonus: r.missionBonus, total: r.total, timedOut: p.timedOut,
          };
        }
      }
      if (ph === 'final') view.final = this.final;
      return view;
    }
  }

  return { Room, cleanText };
});
