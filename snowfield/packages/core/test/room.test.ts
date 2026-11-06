import { describe, expect, it } from 'vitest';
import { Room, cpuNextAction, createGame, applyAction, stateRng, type ClientMsg, type ServerMsg } from '../src';

/** 手動で進められるタイマーと、送信内容の記録 */
function harness(opts: ConstructorParameters<typeof Room>[0] extends infer O ? Partial<O> : never = {}) {
  const sent: Array<{ to: string; msg: ServerMsg }> = [];
  const timers: Array<{ id: number; fn: () => void; ms: number }> = [];
  let nid = 1;
  const room = new Room({
    code: 'TEST1', cpuDelayMs: 0, skipDisconnectedMs: 0,
    send: (to, msg) => sent.push({ to, msg }),
    setTimer: (fn, ms) => { const id = nid++; timers.push({ id, fn, ms }); return id; },
    clearTimer: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    ...opts,
  });
  const run = (limit = 20000) => {
    let n = 0;
    while (timers.length && n++ < limit) timers.shift()!.fn();
    return n;
  };
  const last = (to: string) => [...sent].reverse().find((s) => s.to === to && s.msg.type === 'room')?.msg as Extract<ServerMsg, { type: 'room' }> | undefined;
  const lastResult = (to: string) => [...sent].reverse().find((s) => s.to === to && s.msg.type === 'result')?.msg as Extract<ServerMsg, { type: 'result' }> | undefined;
  return { room, sent, timers, run, last, lastResult };
}
const send = (h: ReturnType<typeof harness>, m: string, msg: ClientMsg) => h.room.handle(m, msg);

describe('ロビー', () => {
  it('参加・CPU追加・開始（ホストだけ）', () => {
    const h = harness();
    h.room.join('A', 'tokA', 'アリス');
    h.room.join('B', 'tokB', 'ボブ');
    send(h, 'B', { type: 'addCpu' });
    expect(h.room.seats).toHaveLength(2);
    send(h, 'A', { type: 'addCpu' });
    expect(h.room.seats.map((s) => s.name)).toEqual(['アリス', 'ボブ', 'CPU1']);
    send(h, 'B', { type: 'start' });
    expect(h.room.phase).toBe('lobby');
    send(h, 'A', { type: 'start' });
    expect(h.room.phase).toBe('playing');
    expect(h.last('B')).toMatchObject({ you: 1, hostSeat: 0 });
    expect(h.room.game!.players.map((p) => p.name)).toEqual(['アリス', 'ボブ', 'CPU1']);
  });
  it('人数が足りなければ開始できず、満員で参加できない', () => {
    const h = harness();
    h.room.join('A', 'a', 'A');
    send(h, 'A', { type: 'start' });
    expect(h.room.phase).toBe('lobby');
    for (let i = 0; i < 4; i++) send(h, 'A', { type: 'addCpu' });
    expect(h.room.seats).toHaveLength(5);
    expect('error' in h.room.join('Z', 'z', 'Z')).toBe(true);
  });
  it('ゲーム開始後は新規参加できないが、同じtokenなら戻れる', () => {
    const h = harness();
    h.room.join('A', 'a', 'A'); h.room.join('B', 'b', 'B');
    send(h, 'A', { type: 'start' });
    expect('error' in h.room.join('C', 'c', 'C')).toBe(true);
    h.room.leave('B');
    expect(h.room.seats[1].connected).toBe(false);
    expect(h.room.join('B2', 'b', 'B')).toEqual({ seat: 1 });
    expect(h.room.seats[1]).toMatchObject({ connected: true, member: 'B2' });
  });
  it('ロビーでホストが抜けると部屋は閉じる', () => {
    const h = harness();
    h.room.join('A', 'a', 'A'); h.room.join('B', 'b', 'B');
    h.room.leave('A');
    expect(h.room.closed).toBe(true);
  });
});

describe('行動の権限', () => {
  function started() {
    const h = harness();
    h.room.join('A', 'a', 'A'); h.room.join('B', 'b', 'B');
    send(h, 'A', { type: 'start' });
    return h;
  }
  it('他人の席の行動はできない', () => {
    const h = started();
    send(h, 'B', { type: 'action', action: { type: 'endTurn', player: 0 } });
    expect(h.room.game!.turn).toBe(0);
    expect(h.lastResult('B')?.ok).toBe(false);
  });
  it('自分の席なら通り、全員に状態が配信される', () => {
    const h = started();
    send(h, 'A', { type: 'action', action: { type: 'endTurn', player: 0 } });
    expect(h.room.game!.turn).toBe(1);
    expect(h.last('B')!.state!.turn).toBe(1);
  });
  it('お絵かきは手番外でもでき、まとめて配信される', () => {
    const h = started();
    const before = h.sent.length;
    send(h, 'B', { type: 'action', action: { type: 'draw', x0: 1, y0: 1, x1: 1.5, y1: 1, color: 'a' } });
    send(h, 'B', { type: 'action', action: { type: 'draw', x0: 1.5, y0: 1, x1: 2, y1: 1, color: 'a' } });
    expect(h.sent.length).toBe(before);   // まだ配信されない
    h.run();
    expect(h.last('A')!.state!.drawing['1,1']).toHaveLength(2);
  });
  it('投票は自分の席でだけ入れられる', () => {
    const h = started();
    h.room.game!.items.wood = 2;
    send(h, 'A', { type: 'action', action: { type: 'startVote', player: 0, item: 'wood' } });
    send(h, 'A', { type: 'action', action: { type: 'castVote', player: 1, value: 1 } });
    expect(h.room.game!.vote!.votes).toEqual([1, 0]);
    send(h, 'B', { type: 'action', action: { type: 'castVote', player: 1, value: 1 } });
    expect(h.room.game!.items.wood).toBe(1);
  });
});

describe('同じ画面で遊ぶ（multi）', () => {
  it('1つのmemberが全席を操作できる', () => {
    const h = harness({ multi: true });
    h.room.join('L', 'local0', 'あ');
    send(h, 'L', { type: 'addLocal', name: 'い' });
    send(h, 'L', { type: 'start' });
    send(h, 'L', { type: 'action', action: { type: 'endTurn', player: 0 } });
    send(h, 'L', { type: 'action', action: { type: 'endTurn', player: 1 } });
    expect(h.room.game!.round).toBe(2);
    expect(h.last('L')!.controls).toEqual([0, 1]);
  });
});

describe('CPU', () => {
  it('CPUの手番は自動で進み、人間の手番で止まる', () => {
    const h = harness();
    h.room.join('A', 'a', 'A');
    send(h, 'A', { type: 'addCpu' });
    send(h, 'A', { type: 'start' });
    send(h, 'A', { type: 'action', action: { type: 'endTurn', player: 0 } });
    expect(h.room.game!.turn).toBe(1);
    h.run();
    expect(h.room.game!.turn).toBe(0);
    expect(h.room.game!.round).toBe(2);
  });
  it('CPUが捨てる投票に自動で票を入れる', () => {
    const h = harness();
    h.room.join('A', 'a', 'A'); send(h, 'A', { type: 'addCpu' }); send(h, 'A', { type: 'start' });
    h.room.game!.items.snow = 9;
    send(h, 'A', { type: 'action', action: { type: 'startVote', player: 0, item: 'snow' } });
    h.run();
    expect(h.room.game!.vote).toBeNull();
    expect(h.room.game!.items.snow).toBe(8);
  });
  it('CPUだけで最後まで遊べる（不正な行動を出さず、必ず終わる）', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      let rejected = 0;
      let g = createGame({ players: 3, seed });
      const rng = stateRng({ rng: seed * 7919 });
      let guard = 0;
      while (g.phase === 'playing' && guard++ < 5000) {
        const a = cpuNextAction(g, g.turn, rng);
        const r = applyAction(g, a);
        if (!r.ok) { rejected++; g = applyAction(g, { type: 'endTurn', player: g.turn }).state; } else g = r.state;
      }
      expect(guard, `seed ${seed}`).toBeLessThan(5000);
      expect(rejected, `seed ${seed} 不正な行動`).toBe(0);
      expect(['won', 'lost']).toContain(g.phase);
    }
  });
  it('Roomの中でもCPUだけで最後まで進む', () => {
    const h = harness();
    h.room.join('A', 'a', 'A');
    send(h, 'A', { type: 'addCpu' }); send(h, 'A', { type: 'addCpu' });
    send(h, 'A', { type: 'start' });
    // 人間の席は切断扱いにして自動で手番を終える
    h.room.leave('A');
    h.run();
    expect(h.room.game!.phase).not.toBe('playing');
  });
});

describe('切断', () => {
  it('切断中の人の手番は自動で終わり、投票は反対になる', () => {
    const h = harness();
    h.room.join('A', 'a', 'A'); h.room.join('B', 'b', 'B'); send(h, 'A', { type: 'start' });
    h.room.leave('B');
    send(h, 'A', { type: 'action', action: { type: 'endTurn', player: 0 } });
    h.run();
    expect(h.room.game!.turn).toBe(0);
    expect(h.room.game!.round).toBe(2);
    h.room.game!.items.wood = 2;
    send(h, 'A', { type: 'action', action: { type: 'startVote', player: 0, item: 'wood' } });
    h.run();
    expect(h.room.game!.vote).toBeNull();
    expect(h.room.game!.items.wood).toBe(2);
  });
});
