/*
 * ヘキサブルグ — ルール判定
 * 盤面の生成・行動の検証と実行・ターンの処理・勝敗をここで扱う。
 * 手番はなく、だれでもいつでも行動できる（トークンがあるかぎり）。30秒ごとの「ターン」で全員いっせいに資源と戦力を受け取る。
 * 行動は「拡張」「回復」「狙い」「攻撃」「反撃」。狙いは次のターンから攻撃に使える。セルは体力（最初は6）を持ち、0 になると壊れて空きマスに戻る。
 * 最後のターンが終わったとき、つながっている一番大きなかたまりが大きい人の勝ち。
 * 状態（state）はただのオブジェクト（JSON にそのまま変換できる）。
 * ホストのブラウザでもテスト（Node.js）でも同じものを使う。
 *
 * 座標はアキシャル座標（q, r）。マスのキーは "q,r"。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HexEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ルールの数値はすべてここ
  const RULES = {
    minPlayers: 2,
    maxPlayers: 12,
    rt: {
      tickSeconds: 30,                      // 1ターンの長さ（秒）
      ticks: [[4, 18], [8, 16], [12, 14]],  // ターンの回数（[この人数まで, 回数]）。部屋の設定で変えられる
      ticksRange: [8, 40],
    },
    // 人数ごとの盤面の半径（直径 = 半径×2+1）。部屋の設定で変えられる
    radius: { 2: 4, 3: 4, 4: 5, 5: 6, 6: 6, 7: 7, 8: 7, 9: 8, 10: 8, 11: 8, 12: 8 },
    radiusRange: [3, 10],               // 設定できる半径（直径 7〜21 マス）
    innerCoresFrom: 7,                  // この人数からは、コアの約3分の1を盤面の内側（中心と外周のあいだ）に置く
    startResource: 3,
    startPower: 3,                      // 戦力トークン（攻撃・反撃に使う）
    cost: { expand: 1, heal: 3 },
    income: { core: 3, power: 1 },   // ターンごとに：資源はコア +3、戦力は +1
    bonus: { chance: 0.25 },         // ターンごとに、セル1つにつき 25% で資源 +1、別に 25% で戦力 +1
    heal: 1,                         // 回復で戻る体力
    hp: 6,                              // セルの体力（0 になると壊れる）
    attack: { cost: 2, maxAimers: 6 },   // 攻撃：戦力2で、前のターンまでに狙っていた自分のセルの数 n（最大6）だけ体力を減らす
    // 反撃：自分のセルを狙っている相手のセルが k マスなら、戦力5で、その全部の体力を k 減らす
    counter: { cost: 5 },
  };

  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const key = (q, r) => q + ',' + r;
  const parseKey = k => k.split(',').map(Number);
  const dist = (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[0] + a[1] - b[0] - b[1])) / 2;
  const neighbors = (q, r) => DIRS.map(([dq, dr]) => [q + dq, r + dr]);

  const ACTION_NAMES = { expand: '拡張', heal: '回復', aim: '狙い', unaim: '狙いを外す', attack: '攻撃', counter: '反撃', ready: '行動完了' };

  function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  // 中心から距離 n の輪のマスを、角から順に一周ぶん並べる
  function ring(n) {
    if (n === 0) return [[0, 0]];
    const out = [];
    let q = DIRS[4][0] * n, r = DIRS[4][1] * n;
    for (let side = 0; side < 6; side++) {
      for (let i = 0; i < n; i++) {
        out.push([q, r]);
        q += DIRS[side][0]; r += DIRS[side][1];
      }
    }
    return out;
  }

  // コアの位置：盤面の一番外側の輪に、人数で等間隔に並べる。
  // 全員が同じ条件になるよう、全員が角（隣のマス3つ）か、全員が辺（隣のマス4つ）にする。
  // 等間隔ではどうしても角と辺が混ざるときは、角に来たコアを辺へ1マスずらす（間隔は1マスくらい違ってよい）
  function outerPositions(radius, count) {
    const cells = ring(radius);
    const n = cells.length;
    const isCorner = i => i % radius === 0;
    const gapOf = idx => {
      const pos = idx.map(i => cells[i]);
      let gap = Infinity;
      for (let i = 0; i < count; i++) for (let j = i + 1; j < count; j++) gap = Math.min(gap, dist(pos[i], pos[j]));
      return gap;
    };
    let best = null;
    for (let o = 0; o < radius; o++) {
      let idx = Array.from({ length: count }, (_, i) => Math.round(o + i * n / count) % n);
      const corners = idx.filter(isCorner).length;
      let moved = 0;
      if (corners !== 0 && corners !== count) {
        // 角に来たものを、となりの辺のマスへ（間隔が広く残るほうへ）
        for (let j = 0; j < count; j++) {
          if (!isCorner(idx[j])) continue;
          const opts = [(idx[j] + 1) % n, (idx[j] + n - 1) % n].map(v => { const t = idx.slice(); t[j] = v; return t; });
          idx = gapOf(opts[0]) >= gapOf(opts[1]) ? opts[0] : opts[1];
          moved++;
        }
      }
      const gap = gapOf(idx);
      if (!best || moved < best.moved || (moved === best.moved && gap > best.gap)) best = { idx, gap, moved };
    }
    return best.idx.map(i => cells[i]);
  }

  /*
   * コアの位置。6人までは全員を盤面の一番外側に等間隔に置く。
   * 7人以上は外側だけだと窮屈なので、約3分の1を内側の輪（中心と外周のあいだくらい）に置く
   */
  function corePositions(radius, count) {
    const inner = count >= RULES.innerCoresFrom ? Math.floor(count / 3) : 0;
    const outer = outerPositions(radius, count - inner);
    if (!inner) return outer;
    const cells = ring(Math.max(2, Math.round(radius / 2)));
    const n = cells.length;
    // 外側のコアからも内側どうしでも、なるべく離れる回し方を選ぶ
    let best = null;
    for (let o = 0; o < n; o++) {
      const pos = Array.from({ length: inner }, (_, i) => cells[Math.round(o + i * n / inner) % n]);
      let gap = Infinity;
      for (const a of pos) for (const b of outer.concat(pos)) if (a !== b) gap = Math.min(gap, dist(a, b));
      if (!best || gap > best.gap) best = { pos, gap };
    }
    // 外側と内側が交互に並ぶよう、角度の順にまとめる
    return outer.concat(best.pos).sort((p, q) => angleOf(...p) - angleOf(...q));
  }

  // 盤面の座標 → 角度
  const angleOf = (q, r) => Math.atan2(1.5 * r, Math.sqrt(3) * (q + r / 2));

  // 盤面：すべて平原。コアはこの関数で決めた位置に置く
  function generateBoard(count, rng, radius) {
    radius = radius || RULES.radius[count];
    if (radius * 6 < count * 3) throw new Error('人数に対して盤面が小さすぎます');
    const cores = corePositions(radius, count);
    const board = {};
    for (let q = -radius; q <= radius; q++) {
      for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
        board[key(q, r)] = { q, r, owner: null, core: false, hp: 0, aim: null, aimRound: -1 };
      }
    }
    return { radius, board, cores };
  }

  /*
   * players: [{ id, name, color }]（2〜12人）
   * opts.radius：盤面の半径、opts.rounds：ターン数（省略すると人数に合わせる）
   * 盤面上の配置はランダムな順に並べる。
   */
  function createGame(players, rng, opts) {
    rng = rng || Math.random;
    opts = opts || {};
    if (players.length < RULES.minPlayers || players.length > RULES.maxPlayers) throw new Error('人数が正しくありません');
    let radius = opts.radius;
    if (radius && (radius < RULES.radiusRange[0] || radius > RULES.radiusRange[1])) throw new Error('盤面の大きさが正しくありません');
    const { board, cores } = generateBoard(players.length, rng, radius);
    radius = radius || RULES.radius[players.length];
    const order = shuffle(players.slice(), rng);
    const rt = RULES.rt;
    const rounds = opts.rounds || autoTicks(players.length);
    if (rounds < rt.ticksRange[0] || rounds > rt.ticksRange[1]) throw new Error('ターン数が正しくありません');
    const state = {
      radius,
      board,
      players: order.map((p, i) => {
        const [q, r] = cores[i];
        Object.assign(board[key(q, r)], { owner: p.id, core: true, hp: RULES.hp });
        return { id: p.id, name: p.name, color: p.color, resource: RULES.startResource, power: RULES.startPower, alive: true, core: key(q, r) };
      }),
      rounds,
      round: 0,              // 済んだターンの数
      tickInfo: {},          // 人ごとの、最後のターンで増えた資源と戦力（画面の演出用）
      over: false,
      winners: [],
      endReason: '',
      log: [],
      logSeq: 0,
    };
    addLog(state, `ゲーム開始。${rt.tickSeconds}秒ごとのターンを ${rounds} 回`, 'info');
    return state;
  }

  // 人数に合わせたターン数
  function autoTicks(count) {
    const row = RULES.rt.ticks.find(([n]) => count <= n) || RULES.rt.ticks[RULES.rt.ticks.length - 1];
    return row[1];
  }

  // ターンの終わり（部屋が30秒ごとに呼ぶ）：全員いっせいに資源をもらう。決まった回数で終わる
  function rtTick(state, rng) {
    if (state.over) return;
    rng = rng || Math.random;
    state.round++;
    for (const p of state.players) { p.ready = false; p.readyOff = false; }
    addLog(state, `ターン ${state.round} / ${state.rounds}`, 'round');
    const seq = state.logSeq;
    for (const p of state.players) {
      if (!p.alive) continue;
      // セルごとのおまけ（資源と戦力は別々に判定するので、両方もらえることもある）
      const bonus = [];
      for (const c of cellsOf(state, p.id)) {
        const res = rng() < RULES.bonus.chance ? 1 : 0, pow = rng() < RULES.bonus.chance ? 1 : 0;
        if (res || pow) bonus.push({ k: key(c.q, c.r), res, pow });
      }
      const n = income(state, p.id) + bonus.reduce((a, b) => a + b.res, 0);
      const pw = RULES.income.power + bonus.reduce((a, b) => a + b.pow, 0);
      state.tickInfo[p.id] = { seq, player: p.id, resBefore: p.resource, resource: n, powBefore: p.power, power: pw, bonus };
      p.resource += n;
      p.power += pw;
    }
    if (state.round >= state.rounds) finishByGroup(state);
  }

  function addLog(state, text, tone) {
    state.log.push({ seq: ++state.logSeq, text, tone: tone || 'info' });
    if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
  }

  const playerById = (state, id) => state.players.find(p => p.id === id);
  const cellsOf = (state, id) => Object.values(state.board).filter(c => c.owner === id);
  const cellLabel = c => `(${c.q},${c.r})`;

  function adjacentToOwn(state, id, q, r) {
    return neighbors(q, r).some(([nq, nr]) => { const c = state.board[key(nq, nr)]; return c && c.owner === id; });
  }

  // ターンごとに必ず受け取る資源（コア +2）。ほかにセルごとのおまけがある
  function income(state, id) {
    return cellsOf(state, id).filter(c => c.core).length * RULES.income.core;
  }

  // ターンごとに必ず受け取る戦力（+3）。ほかにセルごとのおまけがある
  function powerIncome() {
    return RULES.income.power;
  }

  // おまけの期待値（セルの数 × 25%）
  function bonusExpect(state, id) {
    return cellsOf(state, id).length * RULES.bonus.chance;
  }

  // 反撃：そのセルを狙っている相手のセル（k マス）と、かかる戦力（いつも5）。減らす体力は k
  function counterInfo(state, id, k) {
    const list = aimersOf(state, k).filter(c => c.owner !== id);
    return { list, k: list.length, cost: RULES.counter.cost };
  }

  // 今その行動ができるか（マスの指定がいらない判定）。できなければ理由を返す
  function actionBlocked(state, id, type) {
    if (state.over) return 'ゲームは終わっています';
    const p = playerById(state, id);
    if (!p || !p.alive) return '脱落しています';
    if (!(type in ACTION_NAMES)) return '不明な行動です';
    if (type === 'expand' && p.resource < RULES.cost.expand) return '資源トークンが足りません';
    if (type === 'heal' && p.resource < RULES.cost.heal) return '資源トークンが足りません';
    return '';
  }

  // そのセル（キー）を狙っている、ほかの人のセル（攻撃するときは自分のセルだけを数える）
  function aimersOf(state, k, owner) {
    return Object.values(state.board).filter(c => c.owner && c.aim === k && (owner === undefined || c.owner === owner));
  }

  // 狙いが攻撃に使えるか（前のターンまでに決めた狙いだけ。決めたターンのうちは「準備中」）
  const isArmed = (state, c) => !!c.aim && c.aimRound < state.round;

  // 攻撃：前のターンまでに狙っていた自分のセルの数 n（1〜6）と、かかる戦力（いつも2）。pending は準備中の狙いの数
  function attackInfo(state, id, k) {
    const all = aimersOf(state, k, id);
    const n = Math.min(RULES.attack.maxAimers, all.filter(c => isArmed(state, c)).length);
    return { n, cost: RULES.attack.cost, pending: all.length - all.filter(c => isArmed(state, c)).length };
  }

  // このターンに、そのセルの狙いを新しく決めたり変えたりできるか
  const canReaim = (state, c) => c.aimRound !== state.round;

  // 自分のセルの隣にある相手のセル（狙える相手）
  const foeNeighbors = (state, c) => neighbors(c.q, c.r).map(([q, r]) => state.board[key(q, r)]).filter(n => n && n.owner && n.owner !== c.owner);

  // 行動の対象にできるマスのキー一覧（画面のハイライト用）
  function targets(state, id, type) {
    if (actionBlocked(state, id, type)) return [];
    const p = playerById(state, id);
    const out = [];
    for (const [k, c] of Object.entries(state.board)) {
      if (type === 'expand') { if (!c.owner && adjacentToOwn(state, id, c.q, c.r)) out.push(k); }
      else if (type === 'attack') { if (c.owner && c.owner !== id) { const a = attackInfo(state, id, k); if (a.n > 0 && p.power >= a.cost) out.push(k); } }
      else if (type === 'counter') { if (c.owner === id) { const ci = counterInfo(state, id, k); if (ci.k > 0 && p.power >= ci.cost) out.push(k); } }
      else if (type === 'heal') { if (c.owner === id && c.hp < RULES.hp) out.push(k); }
      else if (type === 'aim') { if (c.owner === id && canReaim(state, c) && foeNeighbors(state, c).length) out.push(k); }
    }
    return out;
  }

  function fail(error) { return { ok: false, error }; }

  /*
   * 行動を実行する。state は書き換わる。
   * action: { type: 'expand' | 'heal' | 'attack' | 'counter', q, r }
   *         { type: 'aim', q, r, to }（自分のセル (q,r) から、隣の相手のセル to（キー）を狙う） / { type: 'unaim', q, r }
   *         { type: 'ready', on }（行動完了。全員がそろうと部屋が次のターンへ進める）
   */
  function apply(state, id, action) {
    if (!action || typeof action.type !== 'string') return fail('不明な行動です');
    const blocked = actionBlocked(state, id, action.type);
    if (blocked) return fail(blocked);
    const p = playerById(state, id);
    // 行動完了：このターンはもう行動しない、という印（もう一度押すと取り消し）。ターンが変わると外れる
    if (action.type === 'ready') {
      p.ready = action.on === undefined ? !p.ready : !!action.on;
      p.readyOff = !p.ready;   // 自分で外したら、このターンは自動では行動完了にしない
      return { ok: true };
    }
    const k = key(Number(action.q), Number(action.r));
    const cell = state.board[k];
    if (!cell) return fail('盤面の外です');
    // 狙い：自分のセルから、隣の相手のセルを狙う（トークンは使わない。攻撃に使えるのは次のターンから）。ひとつのセルの狙いは1ターンに1回しか決めたり変えたりできない
    if (action.type === 'aim' || action.type === 'unaim') {
      if (cell.owner !== id) return fail('自分のセルを選んでください');
      if (!canReaim(state, cell)) return fail('このセルの狙いは、このターンはもう変えられません');
      if (action.type === 'unaim') {
        if (!cell.aim) return fail('このセルは何も狙っていません');
        cell.aim = null;
      } else {
        const t = state.board[String(action.to)];
        if (!t || !foeNeighbors(state, cell).includes(t)) return fail('隣の相手のセルを選んでください');
        if (cell.aim === action.to) return fail('もうそのセルを狙っています');
        cell.aim = String(action.to);
      }
      cell.aimRound = state.round;
      return { ok: true };
    }
    if (!targets(state, id, action.type).includes(k)) {
      if (action.type === 'attack') { const a = attackInfo(state, id, k); return fail(a.n ? '戦力トークンが足りません' : a.pending ? '狙いは次のターンから攻撃に使えます' : 'このセルを狙っている自分のセルがありません'); }
      if (action.type === 'counter') return fail(counterInfo(state, id, k).k ? '戦力トークンが足りません' : 'このセルを狙っている相手のセルがありません');
      if (action.type === 'heal') return fail('体力の減っている自分のセルを選んでください');
      return fail('そのマスには拡張できません');
    }
    if (action.type === 'expand') {
      p.resource -= RULES.cost.expand;
      Object.assign(cell, { owner: id, hp: RULES.hp, aim: null, aimRound: -1 });
      addLog(state, `${p.name} がマス${cellLabel(cell)}に拡張`, 'expand');
    } else if (action.type === 'heal') {
      // 回復：資源 3 で体力 +1
      p.resource -= RULES.cost.heal;
      cell.hp = Math.min(RULES.hp, cell.hp + RULES.heal);
      addLog(state, `${p.name} が${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}を回復（体力 +${RULES.heal}）`, 'heal');
    } else if (action.type === 'attack') {
      // 攻撃：戦力 2 で、体力を n 減らす（n は狙っている自分のセルの数）
      const { n, cost } = attackInfo(state, id, k);
      const foe = playerById(state, cell.owner);
      p.power -= cost;
      addLog(state, `${p.name} が ${foe.name} の${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}を攻撃（体力 −${n}）`, 'attack');
      recordHit(state, id, [cell]);
      damage(state, p, cell, n);
    } else if (action.type === 'counter') {
      // 反撃：狙ってきている相手のセル k マスに、戦力 2k で、それぞれ体力 −k
      const { list, k: n, cost } = counterInfo(state, id, k);
      p.power -= cost;
      addLog(state, `${p.name} が${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}から反撃（${n}マスの体力 −${n}）`, 'counter');
      recordHit(state, id, list);
      for (const c of list) damage(state, p, c, n);
    }
    return { ok: true };
  }

  // 攻撃・反撃の記録（画面で、当たったマスを光らせ、やられた人に知らせるため。新しいものだけ残す）
  function recordHit(state, by, cells) {
    const hit = { seq: state.logSeq, by, keys: cells.map(c => key(c.q, c.r)), victims: [...new Set(cells.map(c => c.owner))] };
    state.hits = (state.hits || []).concat(hit).slice(-20);
  }

  // 体力を減らす。0 になったら壊れて空きマスに戻る（コアなら持ち主は脱落）
  function damage(state, by, cell, n) {
    if (!cell.owner) return;
    cell.hp = Math.max(0, cell.hp - n);
    if (cell.hp > 0) return;
    const owner = playerById(state, cell.owner), wasCore = cell.core;
    addLog(state, `${owner.name} の${wasCore ? 'コア' : 'セル'}${cellLabel(cell)}が壊れた`, 'break');
    breakCell(state, cell);
    if (wasCore) eliminate(state, owner, by);
  }

  // セルを空きマスに戻す。そのセルの狙いも、そのセルへの狙いも消える
  function breakCell(state, cell) {
    const k = key(cell.q, cell.r);
    Object.assign(cell, { owner: null, core: false, hp: 0, aim: null, aimRound: -1 });
    for (const c of Object.values(state.board)) if (c.aim === k) c.aim = null;
  }

  // 脱落。セルは空きマスに戻る。heir（コアを壊した人）がいれば、資源と戦力を受け継ぐ
  function eliminate(state, p, heir) {
    p.alive = false;
    for (const c of cellsOf(state, p.id)) breakCell(state, c);
    if (heir) { heir.resource += p.resource; heir.power += p.power; }
    p.resource = 0; p.power = 0;
    addLog(state, heir ? `💀 ${p.name} のコアが壊され、脱落（資源と戦力は ${heir.name} のものに）` : `💀 ${p.name} が脱落`, 'out');
    const alive = state.players.filter(x => x.alive);
    if (alive.length === 1) finish(state, alive, `${alive[0].name} 以外の全員が脱落`);
  }

  function finish(state, winners, reason) {
    state.over = true;
    state.winners = winners.map(p => p.id);
    state.endReason = reason;
    addLog(state, `🏆 ${winners.map(p => p.name).join('・')} の${winners.length > 1 ? '同率優勝' : '勝利'}（${reason}）`, 'win');
  }

  // 最後のターンが終わったら：つながっている一番大きなかたまりが大きい人の勝利
  function finishByGroup(state) {
    state.round = state.rounds;
    const alive = state.players.filter(p => p.alive);
    const sizes = alive.map(p => largestGroup(state, p.id).length);
    const best = Math.max(...sizes);
    finish(state, alive.filter((p, i) => sizes[i] === best), `${state.rounds}ターン終了・最大のかたまり ${best} マス`);
  }

  // つながっている自分のセルのかたまりのうち、一番大きいもの（マスのキーの配列）
  function largestGroup(state, id) {
    const seen = new Set();
    let best = [];
    for (const c of cellsOf(state, id)) {
      const k0 = key(c.q, c.r);
      if (seen.has(k0)) continue;
      const group = [], stack = [k0];
      seen.add(k0);
      while (stack.length) {
        const k = stack.pop();
        group.push(k);
        const [q, r] = parseKey(k);
        for (const [nq, nr] of neighbors(q, r)) {
          const nk = key(nq, nr), n = state.board[nk];
          if (n && n.owner === id && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
        }
      }
      if (group.length > best.length) best = group;
    }
    return best;
  }

  // 何か行動（拡張・回復・攻撃・反撃）できるか。できなければ自動で行動完了にする
  // （狙いはトークンを使わないので数えない）
  function hasMoves(state, id) {
    const p = playerById(state, id);
    if (!p || !p.alive || state.over) return false;
    return ['expand', 'heal', 'attack', 'counter'].some(t => targets(state, id, t).length > 0);
  }

  // 脱落させる（切断したまま戻らないときなどに使う）
  function forfeit(state, id) {
    const p = playerById(state, id);
    if (!p || !p.alive || state.over) return;
    eliminate(state, p);
  }

  return {
    RULES, DIRS, ACTION_NAMES,
    key, parseKey, dist, neighbors, ring, corePositions, generateBoard,
    createGame, apply, targets, actionBlocked, income, cellsOf, forfeit, aimersOf, attackInfo, counterInfo, powerIncome, bonusExpect, foeNeighbors, canReaim,
    autoTicks, rtTick, hasMoves, isArmed, largestGroup,
  };
});
