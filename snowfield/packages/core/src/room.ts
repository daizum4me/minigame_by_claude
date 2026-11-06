import { applyAction, createGame, type Action } from './game';
import { cpuNextAction, cpuVote } from './cpu';
import type { GameConfig, GameState } from './types';
import { DEFAULT_CONFIG } from './config';
import type { RandomSource } from './rng';

/**
 * 部屋（ロビー・ゲーム進行・CPU・切断の扱い）。通信方法には依存しない。
 * ホストのブラウザで動かし、参加者からのメッセージを handle() で受けて、
 * 「その人が操作してよい席か」を確かめてから core の applyAction で状態を更新し、全員へ配信する。
 *
 * member＝通信相手（人）。seat＝ゲーム内の席（プレイヤー1〜N）。
 * 通常は 1 member = 1 seat。同じ画面で遊ぶ場合（multi）は 1 member が複数の席を操作できる。
 */
export interface Seat { name: string; cpu: boolean; connected: boolean; token: string; member: string | null }
export interface PublicSeat { name: string; cpu: boolean; connected: boolean }

export type ClientMsg =
  | { type: 'join'; token: string; name: string }
  | { type: 'action'; action: Action }
  | { type: 'addCpu' }
  | { type: 'addLocal'; name?: string }
  | { type: 'removeSeat'; seat: number }
  | { type: 'start' }
  | { type: 'toLobby' };

export type ServerMsg =
  | { type: 'room'; phase: 'lobby' | 'playing'; code: string; seats: PublicSeat[]; hostSeat: number; you: number | null; controls: number[]; state: GameState | null }
  | { type: 'result'; ok: boolean; message: string }
  | { type: 'log'; seat: number | null; message: string }
  | { type: 'error'; text: string };

export interface RoomOptions {
  code?: string;
  send: (member: string, msg: ServerMsg) => void;
  rng?: RandomSource;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  config?: Partial<GameConfig>;
  /** 同じ画面で遊ぶ：ホストの member が全席を操作できる */
  multi?: boolean;
  /** CPU が1手ごとに待つ時間（ms） */
  cpuDelayMs?: number;
  /** 【未確定】切断中の人の手番を自動で終えるまでの時間（ms） */
  skipDisconnectedMs?: number;
}

const MAX_CPU_ACTIONS_PER_TURN = 40;
const cleanName = (s: unknown, fallback: string) => {
  const t = Array.from(String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 12).join('').trim();
  return t || fallback;
};

export class Room {
  readonly code: string;
  seats: Seat[] = [];
  phase: 'lobby' | 'playing' = 'lobby';
  game: GameState | null = null;
  hostMember: string | null = null;
  closed = false;
  private o: Required<Pick<RoomOptions, 'send'>> & RoomOptions;
  private rng: RandomSource;
  private setT: (fn: () => void, ms: number) => unknown;
  private clearT: (id: unknown) => void;
  private turnTimer: unknown = null;
  private bcastTimer: unknown = null;
  private cpuActs = 0;
  private cpuVoteTimers = new Map<number, unknown>();
  private cpuTurnKey = '';

  constructor(opts: RoomOptions) {
    this.o = opts;
    this.code = opts.code ?? '';
    this.rng = opts.rng ?? { next: Math.random };
    this.setT = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  }

  private get cfg(): GameConfig { return { ...DEFAULT_CONFIG, ...this.o.config }; }
  private get cpuDelay() { return this.o.cpuDelayMs ?? 450; }
  private get skipMs() { return this.o.skipDisconnectedMs ?? 3000; }

  controlsOf(member: string): number[] {
    return this.seats.flatMap((s, i) => (s.member === member ? [i] : []));
  }
  private seatOfMember(member: string): number { return this.seats.findIndex((s) => s.member === member); }

  /** 参加。同じ token なら元の席に戻る（ゲーム中でも可）。 */
  join(member: string, token: string, name: string): { seat: number } | { error: string } {
    if (this.closed) return { error: '部屋が見つかりません' };
    const back = this.seats.findIndex((s) => !s.cpu && s.token === token);
    if (back >= 0) {
      this.seats[back].member = member; this.seats[back].connected = true;
      this.changed();
      return { seat: back };
    }
    if (this.phase !== 'lobby') return { error: 'ゲーム中のため参加できません' };
    if (this.seats.length >= this.cfg.maxPlayers) return { error: `満員です（最大${this.cfg.maxPlayers}人）` };
    this.seats.push({ name: this.uniqueName(cleanName(name, 'ゲスト')), cpu: false, connected: true, token, member });
    if (this.hostMember === null) this.hostMember = member;
    this.changed();
    return { seat: this.seats.length - 1 };
  }

  private uniqueName(base: string): string {
    let n = base, i = 2;
    while (this.seats.some((s) => s.name === n)) n = `${base}${i++}`;
    return n;
  }

  /** 通信が切れた */
  leave(member: string): void {
    if (this.closed) return;
    const idxs = this.controlsOf(member);
    if (this.phase === 'lobby') {
      this.seats = this.seats.filter((s) => s.member !== member);
      if (member === this.hostMember) { this.close(); return; }
    } else {
      for (const i of idxs) { this.seats[i].connected = false; this.seats[i].member = null; }
    }
    this.changed();
  }

  close(): void {
    this.closed = true;
    this.clearTimers();
    this.o.send('*', { type: 'error', text: 'ホストが退出したため、部屋が閉じられました' });
  }

  private clearTimers() {
    if (this.turnTimer) this.clearT(this.turnTimer);
    this.turnTimer = null;
    for (const t of this.cpuVoteTimers.values()) this.clearT(t);
    this.cpuVoteTimers.clear();
  }

  handle(member: string, msg: ClientMsg): void {
    if (this.closed || !msg || typeof msg !== 'object') return;
    const isHost = member === this.hostMember;
    const err = (text: string) => this.o.send(member, { type: 'result', ok: false, message: text });
    switch (msg.type) {
      case 'action': return this.handleAction(member, msg.action);
      case 'addCpu': {
        if (!isHost || this.phase !== 'lobby') return;
        if (this.seats.length >= this.cfg.maxPlayers) return err('満員です');
        let n = 1; while (this.seats.some((s) => s.name === `CPU${n}`)) n++;
        this.seats.push({ name: `CPU${n}`, cpu: true, connected: true, token: '', member: null });
        return this.changed();
      }
      case 'addLocal': {
        if (!isHost || this.phase !== 'lobby' || !this.o.multi) return;
        if (this.seats.length >= this.cfg.maxPlayers) return err('満員です');
        this.seats.push({ name: this.uniqueName(cleanName(msg.name, `プレイヤー${this.seats.length + 1}`)), cpu: false, connected: true, token: 'local' + this.seats.length, member });
        return this.changed();
      }
      case 'removeSeat': {
        if (!isHost || this.phase !== 'lobby') return;
        const s = this.seats[msg.seat];
        if (!s || s.member === this.hostMember && !this.o.multi) return; // 自分自身は外せない
        this.seats.splice(msg.seat, 1);
        return this.changed();
      }
      case 'start': {
        if (!isHost || this.phase !== 'lobby') return;
        if (this.seats.length < this.cfg.minPlayers) return err(`${this.cfg.minPlayers}人以上必要です（CPUを追加できます）`);
        this.game = createGame({ players: this.seats.length, seed: (this.rng.next() * 2 ** 31) | 0, config: this.o.config, names: this.seats.map((s) => s.name) });
        this.phase = 'playing';
        this.cpuTurnKey = '';
        return this.changed();
      }
      case 'toLobby': {
        if (!isHost) return;
        this.clearTimers();
        this.phase = 'lobby'; this.game = null;
        this.seats = this.seats.filter((s) => s.cpu || s.connected);
        return this.changed();
      }
    }
  }

  private handleAction(member: string, a: Action): void {
    if (this.phase !== 'playing' || !this.game) return;
    const fail = (message: string) => this.o.send(member, { type: 'result', ok: false, message });
    if (!a || typeof a !== 'object') return;
    const mine = this.controlsOf(member);
    if (!mine.length) return;
    if ('player' in a && !mine.includes(a.player)) return fail('他のプレイヤーの操作はできません');
    if (a.type === 'cancelVote' && this.game.vote && !mine.includes(this.game.vote.votes.findIndex((v) => v === 1))) {
      return fail('投票を始めた人だけが取り下げられます');
    }
    this.apply(a, 'player' in a ? a.player : mine[0], member);
  }

  /** 行動を適用して配信。ok なら全員へログ、失敗なら本人へ通知 */
  private apply(a: Action, seat: number, member: string | null): boolean {
    if (!this.game) return false;
    const r = applyAction(this.game, a);
    const stateChanged = r.state !== this.game;   // 否決のように、失敗扱いでも状態が変わる場合がある
    if (stateChanged) this.game = r.state;
    if (r.message) {
      if (r.ok || stateChanged) this.o.send('*', { type: 'log', seat, message: r.message });
      else if (member) this.o.send(member, { type: 'result', ok: false, message: r.message });
    }
    if (r.ok || stateChanged) this.changed(a.type === 'draw' || a.type === 'erase');
    return r.ok;
  }

  private snapshot(member: string): ServerMsg {
    const controls = this.controlsOf(member);
    return {
      type: 'room', phase: this.phase, code: this.code,
      seats: this.seats.map((s) => ({ name: s.name, cpu: s.cpu, connected: s.connected })),
      hostSeat: this.seats.findIndex((s) => s.member === this.hostMember),
      you: controls.length ? controls[0] : null, controls, state: this.game,
    };
  }

  /** 全員へ最新状態を配信。お絵かきは細かく来るのでまとめて送る */
  private changed(lazy = false): void {
    if (this.closed) return;
    const send = () => {
      this.bcastTimer = null;
      for (const m of this.members()) this.o.send(m, this.snapshot(m));
    };
    if (lazy) { if (!this.bcastTimer) this.bcastTimer = this.setT(send, 60); }
    else { if (this.bcastTimer) { this.clearT(this.bcastTimer); this.bcastTimer = null; } send(); }
    this.drive();
  }

  private members(): string[] {
    return [...new Set(this.seats.flatMap((s) => (s.member ? [s.member] : [])))];
  }

  /** CPU・切断中の人の手番、CPUの投票を進める */
  private drive(): void {
    const g = this.game;
    if (this.phase !== 'playing' || !g) return;
    if (g.phase !== 'playing') return;
    // 投票
    if (g.vote) {
      g.players.forEach((_, i) => {
        const seat = this.seats[i];
        const auto = seat.cpu || !seat.connected;
        if (!auto || g.vote!.votes[i] !== 0 || this.cpuVoteTimers.has(i)) return;
        this.cpuVoteTimers.set(i, this.setT(() => {
          this.cpuVoteTimers.delete(i);
          const cur = this.game;
          if (!cur?.vote || cur.vote.votes[i] !== 0) return;
          // 切断中の人は反対（誰も同意していないものは捨てない）
          this.apply({ type: 'castVote', player: i, value: seat.cpu ? cpuVote(cur, cur.vote.item) : -1 }, i, null);
        }, this.cpuDelay));
      });
    } else if (this.cpuVoteTimers.size) {
      for (const t of this.cpuVoteTimers.values()) this.clearT(t);
      this.cpuVoteTimers.clear();
    }
    // 手番
    const seat = this.seats[g.turn];
    const key = `${g.round}:${g.turn}`;
    if (key !== this.cpuTurnKey) { this.cpuTurnKey = key; this.cpuActs = 0; }
    if (seat && (seat.cpu || !seat.connected) && !this.turnTimer) {
      const turn = g.turn;
      this.turnTimer = this.setT(() => {
        this.turnTimer = null;
        const cur = this.game;
        if (!cur || cur.phase !== 'playing' || cur.turn !== turn) { this.drive(); return; }
        const s = this.seats[turn];
        if (!s) return;
        if (!s.cpu && s.connected) return;
        if (!s.cpu || this.cpuActs++ >= MAX_CPU_ACTIONS_PER_TURN) { this.apply({ type: 'endTurn', player: turn }, turn, null); return; }
        const act = cpuNextAction(cur, turn, this.rng);
        if (!this.apply(act, turn, null)) this.apply({ type: 'endTurn', player: turn }, turn, null);
      }, seat.cpu ? this.cpuDelay : this.skipMs);
    }
  }
}
