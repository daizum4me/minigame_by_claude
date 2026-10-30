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
  const TURN_MS = E.RULES.turnSeconds.normal * 1000;   // 1手番の持ち時間（7人以上は E.turnMs で60秒）。攻防のあいだも止まらない
  const BID_MS = 30000;     // 攻防で出す数を決める時間。切れたら 0 個
  const ABANDON_MS = 60000; // 食料が足りないとき、捨てるセルを選ぶ時間（60秒）。切れたら自動で選ぶ
  const GRACE_MS = 30000;   // 切断した人の手番は、これだけ待ってから自動で終える
  const LOG_SEND = 80;      // 配信するログの件数
  const CPU_DELAY_MS = 900;     // CPU が1回行動するまでの間（人が目で追えるように）
  const CPU_REPLY_MS = 700;     // CPU が攻防で応答するまでの間
  const CPU_RT_MS = 2500;       // リアルタイムモードで CPU が考える間隔
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
      // 盤面の直径（マス）・1手番の行動回数・ラウンド数。0 は人数に合わせる
      // mode：'turn'（ターン制）か 'realtime'（リアルタイム・実験）。ticks はリアルタイムのターン数（0 は人数に合わせる）
      this.settings = { diameter: 0, actions: 0, rounds: 0, mode: 'turn', ticks: 0 };
      this.events = true;       // イベントを起こすか（チュートリアルでは起こさない）
      this.chat = [];           // { seq, from, name, color, text }（ロビーとゲームで続けて使う）
      this.chatSeq = 0;
      this.game = null;
      this.seq = 0;
      this.timers = {};         // turn / bid / grace / cpu
      this.turnKey = null;      // いまの手番（"ラウンド:何番目"）
      this.turnDeadline = 0;
      this.turnExpired = false; // 攻防のあいだに持ち時間が切れた（攻防が終わったらすぐ手番終了）
      this.bidFor = null;       // 時間を計っている攻防
      this.bidDeadline = 0;
      this.graceFor = null;
      this.graceDeadline = 0;
      this.cpuAt = null;
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
          if (!t || !CPU.LEVELS[msg.level] || msg.level === 'test') return;   // tutorial はチュートリアルで使う
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
          if ('actions' in msg) {
            const a = Number(msg.actions);
            const [lo, hi] = E.RULES.actionsRange;
            if (a !== 0 && !(Number.isInteger(a) && a >= lo && a <= hi)) return err('行動回数が正しくありません');
            next.actions = a;
          }
          if ('rounds' in msg) {
            const r = Number(msg.rounds);
            const [lo, hi] = E.RULES.roundsRange;
            if (r !== 0 && !(Number.isInteger(r) && r >= lo && r <= hi)) return err('ラウンド数が正しくありません');
            next.rounds = r;
          }
          if ('mode' in msg) {
            if (!['turn', 'realtime'].includes(msg.mode)) return err('モードが正しくありません');
            next.mode = msg.mode;
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
          const { actions, mode, ticks } = this.settings;
          const rounds = mode === 'realtime' ? ticks : this.settings.rounds;
          try {
            this.game = E.createGame(this.players.map(x => ({ id: x.id, name: x.name, color: x.color })), this.rng, { radius, actions, rounds, mode, events: this.events });
          } catch (e) {
            return err(e.message);
          }
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

    // 持ち時間（120秒）・攻防で数を決める時間（30秒）・切断した人の待ち時間（30秒）
    checkTimers() {
      const g = this.game;
      const now = this.now();
      if (!g || this.phase !== 'game' || g.over) {
        ['turn', 'bid', 'grace', 'abandon', 'rtTick', 'rtRegen'].forEach(n => this.stop(n));
        this.turnKey = this.bidFor = this.graceFor = this.abandonFor = null;
        return;
      }
      if (g.mode === 'realtime') {
        // リアルタイム：15秒ごとのターンと、5秒ごとの行動力の回復だけ（手番の持ち時間はない）
        const rt = E.RULES.rt;
        if (!this.timers.rtTick) {
          this.tickDeadline = now + rt.tickSeconds * 1000;
          this.timer('rtTick', () => { E.rtTick(this.game, this.rng); this.changed(); }, rt.tickSeconds * 1000);
        }
        if (!this.timers.rtRegen) {
          this.regenDeadline = now + rt.apSeconds * 1000;
          this.timer('rtRegen', () => { E.rtRegen(this.game); this.changed(); }, rt.apSeconds * 1000);
        }
        return;
      }
      if (g.abandon) {
        // 捨てるセルを選ぶあいだ（手番はもう終わっている）
        ['turn', 'grace', 'bid'].forEach(n => this.stop(n));
        this.graceFor = this.bidFor = null;
        if (this.abandonFor !== g.abandon) {
          const ab = this.abandonFor = g.abandon;
          this.abandonDeadline = now + ABANDON_MS;
          this.timer('abandon', () => this.abandonTimeout(ab), ABANDON_MS);
        }
        return;
      }
      this.stop('abandon');
      this.abandonFor = null;
      if (g.pending) {
        // 攻防のあいだも持ち時間は止めない（切れたら、攻防が終わってから手番終了）
        this.stop('grace');
        this.graceFor = null;
        if (this.bidFor !== g.pending) {
          const pd = this.bidFor = g.pending;
          this.bidDeadline = now + BID_MS;
          this.timer('bid', () => this.bidTimeout(pd), BID_MS);
        }
        return;
      }
      this.stop('bid');
      this.bidFor = null;
      const key = `${g.round}:${g.turn}`;
      if (key !== this.turnKey) {
        this.turnKey = key;
        this.turnExpired = false;
        this.turnDeadline = now + E.turnMs(g);
        this.timer('turn', () => this.turnTimeout(key, '持ち時間が切れました'), E.turnMs(g));
      } else if (this.turnExpired && !this.timers.turn) {
        this.timer('turn', () => this.turnTimeout(key, '持ち時間が切れました'), 0);
      }
      // 手番の人が切断していたら、持ち時間より早く（30秒で）進める
      const cur = E.current(g).id;
      const p = this.player(cur);
      const need = p && !p.connected && !p.cpu ? key : null;
      if (need !== this.graceFor) {
        this.stop('grace');
        this.graceFor = need;
        if (need) {
          this.graceDeadline = now + GRACE_MS;
          this.timer('grace', () => this.turnTimeout(key, '切断中のため手番を終えます'), GRACE_MS);
        }
      }
    }

    turnTimeout(key, why) {
      const g = this.game;
      if (this.closed || !g || g.over || `${g.round}:${g.turn}` !== key) return;
      if (g.pending) { this.turnExpired = true; return; }   // 攻防が終わってから手番終了
      const p = E.current(g);
      this.note(`⏳ ${p.name}：${why}`);
      E.apply(g, p.id, { type: 'endTurn' });
      this.changed();
    }

    // 時間切れ：おすすめのセルを捨てる
    abandonTimeout(ab) {
      const g = this.game;
      if (this.closed || !g || g.abandon !== ab) return;
      const p = g.players.find(x => x.id === ab.player);
      this.note(`⏳ ${p.name}：時間切れのため、捨てるセルを自動で選びます`);
      E.apply(g, ab.player, { type: 'abandon', cells: E.suggestAbandon(g, ab.player) });
      this.changed();
    }

    // 決めていない人は、出せる最小の数（攻撃側は1個、防御側は0個）
    bidTimeout(pd) {
      const g = this.game;
      if (this.closed || !g || g.pending !== pd) return;
      for (const id of E.waiting(g)) {
        const n = E.minBid(pd.attacker === id ? 'atk' : 'def');
        this.note(`⏳ ${g.players.find(x => x.id === id).name}：時間切れのため ${n} 個`);
        E.apply(g, id, { type: 'bid', count: n });
      }
      this.changed();
    }

    // CPU の操作待ちなら、少し間をおいて CPU に打たせる（攻防では2人とも CPU のこともある）
    checkCpu() {
      const g = this.game;
      if (g && g.mode === 'realtime') {
        // リアルタイム：CPU は一定の間隔で考えて、行動力があれば1つずつ動く
        const any = this.phase === 'game' && !g.over && this.players.some(p => p.cpu && g.players.some(x => x.id === p.id && x.alive));
        if (!any) { this.stop('cpu'); return; }
        if (!this.timers.cpu) this.timer('cpu', () => this.cpuActRealtime(), CPU_RT_MS);
        return;
      }
      const cpus = g && this.phase === 'game' && !g.over ? E.waiting(g).filter(id => (this.player(id) || {}).cpu) : [];
      if (!cpus.length) { this.stop('cpu'); this.cpuAt = null; return; }
      const pd = g.pending;
      const at = `${g.logSeq}:${pd ? `${pd.atk}/${pd.def}` : ''}:${g.abandon ? 'ab' : ''}:${cpus.join(',')}`;
      if (this.timers.cpu && this.cpuAt === at) return;   // 同じ局面にはすでに予約済み
      this.cpuAt = at;
      this.timer('cpu', () => this.cpuAct(), pd ? CPU_REPLY_MS : CPU_DELAY_MS);
    }

    cpuAct() {
      this.cpuAt = null;
      const g = this.game;
      if (this.closed || !g || g.over) return;
      for (const id of E.waiting(g)) {
        if (!(this.player(id) || {}).cpu || !E.waiting(g).includes(id)) continue;
        const action = CPU.decide(g, id, this.rng, (this.player(id) || {}).level);
        const r = action ? E.apply(g, id, action) : { ok: false };
        // 万一ルール上できない手を選んだら、止まらないように進める
        if (!r.ok) {
          if (g.pending) E.apply(g, id, { type: 'bid', count: E.minBid(g.pending.attacker === id ? 'atk' : 'def') });
          else if (g.abandon) E.apply(g, id, { type: 'abandon', cells: E.suggestAbandon(g, id) });
          else E.apply(g, id, { type: 'endTurn' });
        }
      }
      this.changed();
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

    // その人に見せてよい情報：攻防で相手が決めた数は、公開されるまで「決めたかどうか」だけ
    view(forId) {
      const g = this.game;
      const now = this.now();
      let game = null;
      if (g) {
        // ほかの人の戦力トークンの数は見せない
        game = Object.assign({}, g, {
          log: g.log.slice(-LOG_SEND),
          players: g.players.map(p => p.id === forId ? p : Object.assign({}, p, { power: null })),
          eventPlan: undefined,
          // セルの防御の数は、そのセルの持ち主にしか見せない（ほかの人には、防御があることだけ：def = -1）
          board: g.mode === 'realtime' ? Object.fromEntries(Object.entries(g.board).map(([k, c]) => [k, c.def > 0 && c.owner !== forId ? Object.assign({}, c, { def: -1 }) : c])) : g.board,
          // 取り消しの記録は、手番の人にだけ、何を取り消せるかだけ届ける（生産したことや戦力トークンの数がわからないように）
          undo: g.over || g.mode === 'realtime' || E.current(g).id !== forId ? [] : (g.undo || []).map(u => ({ label: u.label })),   // 先のラウンドのイベントは送らない（今のラウンドの分だけ）
          // 攻防で出した数は、当人の分だけ見せる（ほかの人には成功か失敗かだけ）
          lastClash: g.lastClash && Object.assign({}, g.lastClash, {
            atk: forId === g.lastClash.attacker ? g.lastClash.atk : null,
            def: forId === g.lastClash.defender ? g.lastClash.def : null,
          }),
        });
        const pd = g.pending;
        if (pd) {
          game.pending = Object.assign({}, pd, {
            atk: forId === pd.attacker ? pd.atk : null,
            def: forId === pd.defender ? pd.def : null,
            atkReady: pd.atk !== null,
            defReady: pd.def !== null,
          });
        }
      }
      const live = g && !g.over && this.phase === 'game';
      return {
        code: this.code,
        phase: this.phase,
        hostId: this.hostId,
        settings: this.settings,
        players: this.players.map(p => ({ id: p.id, name: p.name, color: p.color, connected: p.connected, cpu: !!p.cpu, level: p.cpu ? p.level : undefined })),
        turnLeftMs: live && !g.abandon && g.mode !== 'realtime' ? Math.max(0, this.turnDeadline - now) : 0,
        tickLeftMs: live && g.mode === 'realtime' ? Math.max(0, this.tickDeadline - now) : 0,
        regenLeftMs: live && g.mode === 'realtime' ? Math.max(0, this.regenDeadline - now) : 0,
        abandonLeftMs: live && g.abandon ? Math.max(0, this.abandonDeadline - now) : 0,
        bidLeftMs: live && g.pending ? Math.max(0, this.bidDeadline - now) : 0,
        graceFor: live && this.graceFor ? E.current(g).id : null,
        graceLeftMs: live && this.graceFor ? Math.max(0, this.graceDeadline - now) : 0,
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

  return { Room, COLORS, TURN_MS, BID_MS, GRACE_MS, ABANDON_MS, CHAT_KEEP, CHAT_LEN };
});
