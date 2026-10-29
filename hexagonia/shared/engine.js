/*
 * ヘキサゴニア（仮）— ルール判定
 * 盤面の生成・行動の検証と実行・破壊の攻防・脱落・勝敗をここで扱う。
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
    // 人数ごとの盤面の半径（直径 = 半径×2+1）。部屋の設定で変えられる
    radius: { 2: 3, 3: 4, 4: 5, 5: 6, 6: 6, 7: 7, 8: 7, 9: 8, 10: 8, 11: 8, 12: 8 },
    radiusRange: [3, 10],               // 設定できる半径（直径 7〜21 マス）
    innerCoresFrom: 7,                  // この人数からは、コアの約3分の1を盤面の内側（中心と外周のあいだ）に置く
    turnSeconds: { normal: 120, many: 60, manyFrom: 7 }, // 1手番の持ち時間。7人以上は60秒
    // 平原：山岳：鉱山：農地：森林（河川は別に流す）。いまは山岳はお休み。平原 約57%・鉱山／農地／森林 約14%ずつ
    terrainRatio: { plain: 12, mountain: 0, mine: 3, farm: 3, forest: 3 },
    mineAttack: 1,                      // 鉱山マス：拡張（破壊で取ったときも）と強化のときに攻撃トークン +1
    farmFood: 1,                        // 農地マス：このセルがあると手番終了時に食料 +1（強化の +1 とは別）
    forestResource: 1,                  // 森林マス：このセルがあると手番終了時に資源 +1（強化の +1 とは別）
    startResource: 3,
    startDefense: 2,                    // 最初に防御トークンを2個配る
    // 1手番の行動回数とラウンド数。人数が多いほどラウンドを減らし、行動回数を増やす（部屋の設定で変えられる）
    auto: [ // [この人数まで, 行動回数, ラウンド数]
      [4, 3, 12],
      [6, 4, 10],
      [8, 4, 8],
      [12, 5, 6],
    ],
    actionsRange: [1, 6],
    roundsRange: [4, 20],
    preTurns: 1,                        // 内側にコアがある人は、ラウンド1の前に1手番ずつ先に動く
    extraAction: { base: 6, step: 4 },  // 行動回数を使い切ったあと、資源を払って行動 +1。同じ手番で買うたびに +4（6, 10, 14…）
    // 破壊は資源2で、攻撃トークンが1個以上必要（攻防で1個以上出す）。補強は行動回数を使わない
    cost: { expand: 1, expandMountain: 2, bridge: 4, strengthen: 2, destroy: 2, reinforce: 2 },
    // 手番終了時の資源。強化済セル +1、コアは +2（強化済ならさらに +1）。鉱山は資源ではなく攻撃トークンをくれる
    income: { strong: 1, mine: 0, mineStrong: 1, core: 2, coreStrongBonus: true },
    // 食料：手番終了時に、コア +5・強化済のセル（コアも）1つにつき +1 を作り、セル1つにつき1を食べる。
    // 余りは持ち越す。足りなければ、足りない数だけセルを選んで捨てる
    food: { start: 0, core: 5, strong: 1, perCell: 1 },
    strengthenGives: { attack: 1, defense: 1 },  // 強化でもらえるトークン
    // 維持費：セルが多いほど割る数が小さくなる（累進）。6つまでは4つにつき1、7〜12は3つにつき1、13より多い分は2つにつき1。合計を切り捨て
    // いまは試しに維持費なし（enabled: false）。戻すときは true にする
    upkeep: { enabled: false, brackets: [[6, 4], [12, 3], [Infinity, 2]] },
  };

  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const key = (q, r) => q + ',' + r;
  const parseKey = k => k.split(',').map(Number);
  const dist = (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[0] + a[1] - b[0] - b[1])) / 2;
  const neighbors = (q, r) => DIRS.map(([dq, dr]) => [q + dq, r + dr]);

  const TERRAIN_NAMES = { plain: '平原マス', mountain: '山岳マス', mine: '鉱山マス', farm: '農地マス', forest: '森林マス', river: '河川マス' };
  const ACTION_NAMES = { expand: '拡張', strengthen: '強化', destroy: '破壊', reinforce: '補強' };

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

  /*
   * 河川：対等さより自然さを重視する。
   * 本流が盤面の端から反対側の端へ、曲がりくねりながら流れる。盤面が大きいと支流が本流に合流する。
   * コアとその周りには流れない。コアが狭いところに閉じ込められる配置になったら作り直す
   */
  function makeRivers(radius, cores, fixed, rng) {
    const inBoard = (q, r) => dist([q, r], [0, 0]) <= radius;
    const total = 3 * radius * (radius + 1) + 1;
    const edge = ring(radius).filter(c => !fixed.has(key(...c)));
    const tributaries = radius >= 8 ? 2 : radius >= 5 ? 1 : 0;
    const DIR_KEY = (a, b) => `${b[0] - a[0]},${b[1] - a[1]}`;

    // start から goal（マスの集合のどれか）へ、向きを保ちつつ少し揺らぎながら進む
    function flow(start, goalOf, river, stopNear) {
      const path = [start];
      const mine = new Set([key(...start)]);
      let cur = start, dir = null;
      for (let step = 0; step < radius * 6; step++) {
        const goal = goalOf(cur);
        if (!goal || dist(cur, goal) === 0) break;
        if (stopNear && neighbors(...cur).some(([q, r]) => stopNear.has(key(q, r)))) break;
        const d = dist(cur, goal);
        const opts = neighbors(...cur).filter(([q, r]) => {
          const k = key(q, r);
          if (!inBoard(q, r) || fixed.has(k) || mine.has(k) || river.has(k)) return false;
          if (dist([q, r], goal) > d) return false;        // 遠ざかる向きには進まない
          // 幅1マスを保つ：自分の流れの直前のマス以外とは隣り合わない
          return !neighbors(q, r).some(([a, b]) => { const nk = key(a, b); return nk !== key(...cur) && mine.has(nk); });
        });
        if (!opts.length) break;
        const scored = opts.map(c => ({ c, s: dist(c, goal) + rng() * 1.4 + (dir && DIR_KEY(cur, c) !== dir ? 0.4 : 0) }));
        scored.sort((x, y) => x.s - y.s);
        const next = scored[0].c;
        dir = DIR_KEY(cur, next);
        cur = next;
        path.push(cur);
        mine.add(key(...cur));
      }
      return path;
    }

    function attempt() {
      const river = new Set();
      if (!edge.length) return river;
      // 本流：端のどこかから、反対側の端のあたりへ
      const start = edge[Math.floor(rng() * edge.length)];
      const target = angleOf(...start) + Math.PI + (rng() - 0.5) * 1.2;
      const goal = edge.slice().sort((a, b) => Math.abs(Math.atan2(Math.sin(angleOf(...a) - target), Math.cos(angleOf(...a) - target)))
        - Math.abs(Math.atan2(Math.sin(angleOf(...b) - target), Math.cos(angleOf(...b) - target))))[0];
      flow(start, () => goal, river).forEach(c => river.add(key(...c)));
      const main = new Set(river);
      // 支流：本流から離れた端から、本流のいちばん近いマスへ
      for (let t = 0; t < tributaries; t++) {
        const far = edge.filter(c => [...main].every(k => dist(c, parseKey(k)) >= 3));
        if (!far.length) break;
        const s0 = far[Math.floor(rng() * far.length)];
        const nearest = cur => [...main].map(parseKey).sort((a, b) => dist(cur, a) - dist(cur, b))[0];
        flow(s0, nearest, river, main).forEach(c => river.add(key(...c)));
      }
      return river;
    }

    // どのコアも、河川を渡らずに十分な広さの土地を持てること
    function fair(river) {
      const need = Math.floor(total / (cores.length * 3));
      return cores.every(c => {
        const seen = new Set([key(...c)]), stack = [c];
        while (stack.length && seen.size < need) {
          const [q, r] = stack.pop();
          for (const [nq, nr] of neighbors(q, r)) {
            const k = key(nq, nr);
            if (inBoard(nq, nr) && !seen.has(k) && !river.has(k)) { seen.add(k); stack.push([nq, nr]); }
          }
        }
        return seen.size >= need;
      });
    }

    let river = new Set();
    for (let i = 0; i < 40; i++) {
      river = attempt();
      if (river.size >= radius && fair(river)) return river;
    }
    return river;
  }

  function generateBoard(count, rng, radius) {
    radius = radius || RULES.radius[count];
    if (radius * 6 < count * 3) throw new Error('人数に対して盤面が小さすぎます');
    const cores = corePositions(radius, count);
    const board = {};
    for (let q = -radius; q <= radius; q++) {
      for (let r = Math.max(-radius, -q - radius); r <= Math.min(radius, -q + radius); r++) {
        board[key(q, r)] = { q, r, terrain: 'plain', owner: null, strong: false, core: false };
      }
    }
    // 公平さの補正：コアのマスとその周囲1マスは平原に固定
    const fixed = new Set();
    cores.forEach(([q, r]) => { fixed.add(key(q, r)); neighbors(q, r).forEach(([nq, nr]) => fixed.add(key(nq, nr))); });
    const river = makeRivers(radius, cores, fixed, rng);
    river.forEach(k => { board[k].terrain = 'river'; });
    const free = Object.keys(board).filter(k => !fixed.has(k) && !river.has(k));
    const ratio = RULES.terrainRatio;
    const kinds = ['mountain', 'mine', 'farm', 'forest'];
    const total = ratio.plain + kinds.reduce((n, t) => n + (ratio[t] || 0), 0);
    const counts = kinds.map(t => [t, Math.round(free.length * (ratio[t] || 0) / total)]);
    shuffle(free, rng);
    let i = 0;
    for (const [t, n] of counts) for (let j = 0; j < n && i < free.length; j++) board[free[i++]].terrain = t;
    return { radius, board, cores };
  }

  /*
   * players: [{ id, name, color }]（2〜12人）
   * opts.radius：盤面の半径、opts.actions：1手番の行動回数、opts.rounds：ラウンド数（省略すると人数に合わせる）
   * 手番順はランダム。盤面上の配置も手番順に並べる。
   */
  function createGame(players, rng, opts) {
    rng = rng || Math.random;
    if (players.length < RULES.minPlayers || players.length > RULES.maxPlayers) throw new Error('人数が正しくありません');
    let radius = opts && opts.radius;
    if (radius && (radius < RULES.radiusRange[0] || radius > RULES.radiusRange[1])) throw new Error('盤面の大きさが正しくありません');
    const { board, cores } = generateBoard(players.length, rng, radius);
    radius = radius || RULES.radius[players.length];
    const order = shuffle(players.slice(), rng);
    const auto = autoSettings(players.length);
    const actions = (opts && opts.actions) || auto.actions;
    const rounds = (opts && opts.rounds) || auto.rounds;
    if (actions < RULES.actionsRange[0] || actions > RULES.actionsRange[1]) throw new Error('行動回数が正しくありません');
    if (rounds < RULES.roundsRange[0] || rounds > RULES.roundsRange[1]) throw new Error('ラウンド数が正しくありません');
    const state = {
      radius,
      board,
      players: order.map((p, i) => {
        const [q, r] = cores[i];
        Object.assign(board[key(q, r)], { owner: p.id, core: true });
        return { id: p.id, name: p.name, color: p.color, resource: RULES.startResource, attack: 0, defense: RULES.startDefense, food: RULES.food.start, alive: true, core: key(q, r) };
      }),
      actionsPerTurn: actions,
      rounds,
      turn: 0,               // players の何番目の手番か
      turnNo: 1,             // 何回目の手番か（通し番号）
      round: 1,              // 0 は内側の人の先行
      preQueue: [],          // 先行で、このあと手番が来る人（players の何番目か）
      roundStart: 0,         // このラウンドの最初の人（players の何番目か）。ラウンドごとに1人ずつずれる
      roundPos: 0,           // このラウンドで何人目の手番か
      actionsLeft: actions,
      extraBought: 0,        // この手番で行動 +1 を買った回数
      pending: null,         // 破壊の攻防中： { attacker, defender, target, atk, def }（出す数。null はまだ決めていない）
      abandon: null,         // 維持費が払えず、セルを捨てる途中： { player, count }
      over: false,
      winners: [],
      endReason: '',
      log: [],
      logSeq: 0,
    };
    addLog(state, `ゲーム開始。手番順：${state.players.map(p => p.name).join(' → ')}（1手番 ${actions} 行動・${rounds} ラウンド）`, 'info');
    // 内側にコアがある人は、ラウンド1の前に先に2手番ずつ動く
    const inner = state.players.map((p, i) => i).filter(i => dist(parseKey(state.players[i].core), [0, 0]) < radius);
    if (inner.length) {
      for (let t = 0; t < RULES.preTurns; t++) state.preQueue.push(...inner);
      state.round = 0;
      state.turn = state.preQueue.shift();
      addLog(state, `先行：内側にコアがある人（${inner.map(i => state.players[i].name).join('・')}）が、ラウンド1の前に ${RULES.preTurns} 手番ずつ動く`, 'round');
    } else {
      addLog(state, `ラウンド 1 / ${rounds}`, 'round');
    }
    return state;
  }

  // 人数に合わせた行動回数とラウンド数
  function autoSettings(count) {
    const row = RULES.auto.find(([n]) => count <= n) || RULES.auto[RULES.auto.length - 1];
    return { actions: row[1], rounds: row[2] };
  }

  function addLog(state, text, tone) {
    state.log.push({ seq: ++state.logSeq, text, tone: tone || 'info' });
    if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
  }

  const playerById = (state, id) => state.players.find(p => p.id === id);
  const current = state => state.players[state.turn];
  const cellsOf = (state, id) => Object.values(state.board).filter(c => c.owner === id);
  const cellLabel = c => `(${c.q},${c.r})`;

  function adjacentToOwn(state, id, q, r) {
    return neighbors(q, r).some(([nq, nr]) => { const c = state.board[key(nq, nr)]; return c && c.owner === id; });
  }

  // ターン終了時に受け取る資源
  function income(state, id) {
    const inc = RULES.income;
    let n = 0;
    for (const c of cellsOf(state, id)) {
      if (c.core) n += inc.core + (c.strong && inc.coreStrongBonus ? inc.strong : 0);
      else if (c.terrain === 'mine') n += c.strong ? inc.mineStrong : inc.mine;
      else if (c.strong) n += inc.strong;
      if (c.terrain === 'forest') n += RULES.forestResource;   // 森林は強化とは別に +1
    }
    return n;
  }

  // 手番終了時に払う維持費：セルが多いほど割る数が小さくなる（累進）
  function upkeep(state, id) {
    if (!RULES.upkeep.enabled) return 0;
    const weight = cellsOf(state, id).length;
    let cost = 0, prev = 0;
    for (const [limit, per] of RULES.upkeep.brackets) {
      const part = Math.min(weight, limit) - prev;
      if (part <= 0) break;
      cost += part / per;
      prev = limit;
    }
    return Math.floor(cost + 1e-9);
  }

  function expandCost(cell) {
    if (cell.terrain === 'mountain') return RULES.cost.expandMountain;
    if (cell.terrain === 'river') return RULES.cost.bridge;   // 河川には橋をかける
    return RULES.cost.expand;
  }

  // 1手番の持ち時間（ミリ秒）
  function turnMs(state) {
    const t = RULES.turnSeconds;
    return (state.players.length >= t.manyFrom ? t.many : t.normal) * 1000;
  }

  // 今その行動ができるか（マスの指定がいらない判定）。できなければ理由を返す
  function actionBlocked(state, id, type) {
    if (state.over) return 'ゲームは終わっています';
    const p = current(state);
    if (!p || p.id !== id) return 'あなたの手番ではありません';
    if (state.pending) return '破壊の攻防が終わるまで待ってください';
    if (state.abandon) return '捨てるセルを選んでいるところです';
    if (type === 'endTurn') return '';
    if (type === 'buyAction') {
      if (state.actionsLeft > 0) return 'まだ行動回数が残っています';
      if (p.resource < extraActionCost(state)) return '資源トークンが足りません';
      return '';
    }
    if (!(type in ACTION_NAMES)) return '不明な行動です';
    // 補強は行動回数を使わない
    if (type !== 'reinforce' && state.actionsLeft <= 0) return 'この手番の行動回数を使い切りました';
    const min = type === 'expand' ? RULES.cost.expand : RULES.cost[type];
    if (p.resource < min) return '資源トークンが足りません';
    if (type === 'destroy' && p.attack < 1) return '破壊には攻撃トークンが1個以上必要です';
    return '';
  }

  // 行動の対象にできるマスのキー一覧（画面のハイライト用）
  function targets(state, id, type) {
    if (actionBlocked(state, id, type)) return [];
    const p = playerById(state, id);
    const out = [];
    for (const [k, c] of Object.entries(state.board)) {
      if (type === 'expand') {
        if (!c.owner && p.resource >= expandCost(c) && adjacentToOwn(state, id, c.q, c.r)) out.push(k);
      } else if (type === 'strengthen') {
        if (c.owner === id && !c.strong) out.push(k);
      } else if (type === 'destroy') {
        if (c.owner && c.owner !== id && adjacentToOwn(state, id, c.q, c.r)) out.push(k);
      }
    }
    return out;
  }

  function fail(error) { return { ok: false, error }; }

  /*
   * 行動を実行する。state は書き換わる。
   * action: { type: 'expand'|'strengthen'|'destroy', q, r } / { type: 'reinforce' } / { type: 'endTurn' }
   *         { type: 'bid', count }（破壊の攻防で、攻撃側・防御側が出すトークンの数を伏せて決める）
   */
  function apply(state, id, action) {
    const r = applyAction(state, id, action);
    if (r.ok) autoEndIfStuck(state);
    return r;
  }

  // 手番の人が資源を使い切るなどして、もう何もできなければ自動で手番終了
  function autoEndIfStuck(state) {
    while (!state.over && !state.pending && !state.abandon && !canAct(state, current(state).id)) {
      addLog(state, `${current(state).name} はもう行動できないため、自動で手番終了`, 'info');
      endTurn(state);
    }
  }

  function canAct(state, id) {
    if (!actionBlocked(state, id, 'reinforce') || !actionBlocked(state, id, 'buyAction')) return true;
    return ['expand', 'strengthen', 'destroy'].some(t => targets(state, id, t).length > 0);
  }

  function applyAction(state, id, action) {
    if (!action || typeof action.type !== 'string') return fail('不明な行動です');
    if (action.type === 'bid') return bid(state, id, action.count);
    if (action.type === 'abandon') return abandonCells(state, id, action.cells);
    const blocked = actionBlocked(state, id, action.type);
    if (blocked) return fail(blocked);
    const p = playerById(state, id);
    if (action.type === 'endTurn') { endTurn(state); return { ok: true }; }
    if (action.type === 'buyAction') {
      const cost = extraActionCost(state);
      p.resource -= cost;
      state.actionsLeft = 1;
      state.extraBought++;
      addLog(state, `${p.name} が資源トークン ${cost} 個を払って行動 +1`, 'buy');
      return { ok: true };
    }
    if (action.type === 'reinforce') {
      p.resource -= RULES.cost.reinforce;
      p.defense += 1;
      // 補強は防御トークン +1 だけ（攻撃トークンは増えない）。ログに出さない（防御トークンの数を相手にわかりにくくするため）
      return { ok: true };
    }
    const k = key(Number(action.q), Number(action.r));
    const cell = state.board[k];
    if (!cell) return fail('盤面の外です');
    if (!targets(state, id, action.type).includes(k)) return fail('そのマスには' + ACTION_NAMES[action.type] + 'できません');

    if (action.type === 'expand') {
      const cost = expandCost(cell);
      p.resource -= cost;
      Object.assign(cell, { owner: id, strong: false, core: false });
      let extra = '';
      if (cell.terrain === 'mountain') { p.defense += 1; extra = '（山岳：防御トークン +1）'; }
      if (cell.terrain === 'mine') { p.attack += RULES.mineAttack; extra = `（鉱山：攻撃トークン +${RULES.mineAttack}）`; }
      state.actionsLeft--;
      if (cell.terrain === 'river') addLog(state, `${p.name} が河川マス${cellLabel(cell)}に橋をかけた（資源 ${cost}）`, 'expand');
      else addLog(state, `${p.name} が${TERRAIN_NAMES[cell.terrain]}${cellLabel(cell)}に拡張${extra}`, 'expand');
    } else if (action.type === 'strengthen') {
      p.resource -= RULES.cost.strengthen;
      cell.strong = true;
      const gives = RULES.strengthenGives;
      p.attack += gives.attack;
      p.defense += gives.defense;
      let extra = `攻撃トークン +${gives.attack}・防御トークン +${gives.defense}`;
      if (cell.terrain === 'mountain') { p.defense += 1; extra += '・山岳：防御トークン +1'; }
      if (cell.terrain === 'mine') { p.attack += RULES.mineAttack; extra += `・鉱山：攻撃トークン +${RULES.mineAttack}`; }
      state.actionsLeft--;
      addLog(state, `${p.name} が${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}を強化（${extra}）`, 'strengthen');
    } else if (action.type === 'destroy') {
      const def = playerById(state, cell.owner);
      p.resource -= RULES.cost.destroy;
      state.actionsLeft--;
      addLog(state, `${p.name} が ${def.name} の${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}に破壊を宣言`, 'destroy');
      // 攻撃側（攻撃トークン1個以上）・防御側が、出すトークンの数を伏せて決める。
      // 防御トークンの数は相手に見えないので、防御側が0個でも攻撃側は数を選ぶ
      state.pending = { attacker: id, defender: def.id, target: k, atk: null, def: null };
      if (def.defense <= 0) state.pending.def = 0;
      if (p.attack === 1) state.pending.atk = 1;                     // 1個しかなければ1個に決まる
      if (state.pending.atk !== null && state.pending.def !== null) resolveDestroy(state, state.pending.atk, state.pending.def);
    }
    return { ok: true };
  }

  // 破壊の攻防：攻撃側と防御側が出す数を伏せて決め、そろったら同時に公開する。
  // 攻撃トークン1個で防御トークン1個を破るので、攻撃 ≧ 防御なら破壊成功。出したトークンはすべてなくなる
  function bid(state, id, count) {
    const pd = state.pending;
    if (state.over || !pd) return fail('いまは攻防中ではありません');
    const side = pd.attacker === id ? 'atk' : pd.defender === id ? 'def' : null;
    if (!side) return fail('この攻防には加わっていません');
    if (pd[side] !== null) return fail('もう決めました');
    const p = playerById(state, id);
    const have = side === 'atk' ? p.attack : p.defense;
    const n = Number(count);
    if (!Number.isInteger(n) || n < minBid(side) || n > have) return fail(side === 'atk' && n < 1 ? '攻撃トークンは1個以上出してください' : '出せる数ではありません');
    pd[side] = n;
    if (pd.atk !== null && pd.def !== null) resolveDestroy(state, pd.atk, pd.def);
    return { ok: true };
  }

  // 攻防で出す数の下限：攻撃側は1個以上、防御側は0個から
  function minBid(side) { return side === 'atk' ? 1 : 0; }

  function resolveDestroy(state, atk, def) {
    const pd = state.pending;
    state.pending = null;
    const cell = state.board[pd.target];
    const a = playerById(state, pd.attacker), d = playerById(state, pd.defender);
    a.attack -= atk;
    d.defense -= def;
    const success = atk >= def;
    state.lastClash = { seq: state.logSeq + 1, attacker: pd.attacker, defender: pd.defender, target: pd.target, def, atk, success };
    const what = cell.core ? 'コア' : 'セル';
    if (d.defense + def > 0) addLog(state, `攻防：${a.name} 攻撃トークン ${atk} 個 ／ ${d.name} 防御トークン ${def} 個`, 'clash');
    if (!success) { addLog(state, `破壊失敗：${d.name} の${what}${cellLabel(cell)}は守られた`, 'defend'); return; }
    const wasCore = cell.core;
    Object.assign(cell, { owner: null, strong: false, core: false });
    if (cell.terrain === 'river') {
      // 橋は破壊されると落ちて、河川に戻る（攻撃側のセルにはならない）
      addLog(state, `破壊成功：${a.name} が ${d.name} の橋${cellLabel(cell)}を落とした（河川に戻る）`, 'destroy');
      return;
    }
    addLog(state, `破壊成功：${a.name} が ${d.name} の${what}${cellLabel(cell)}を破壊`, 'destroy');
    if (wasCore) eliminate(state, d);
    // 破壊したマスはそのまま攻撃側のセル（未強化）になる。山岳マスなら拡張と同じく防御トークン +1
    Object.assign(cell, { owner: a.id, strong: false, core: false });
    let extra = '';
    if (cell.terrain === 'mountain') { a.defense += 1; extra = '（山岳：防御トークン +1）'; }
    if (cell.terrain === 'mine') { a.attack += RULES.mineAttack; extra = `（鉱山：攻撃トークン +${RULES.mineAttack}）`; }
    addLog(state, `${a.name} が${TERRAIN_NAMES[cell.terrain]}${cellLabel(cell)}にそのまま拡張${extra}`, 'expand');
  }

  function eliminate(state, p) {
    p.alive = false;
    for (const c of cellsOf(state, p.id)) Object.assign(c, { owner: null, strong: false, core: false });
    p.resource = 0; p.attack = 0; p.defense = 0; p.food = 0;
    addLog(state, `💀 ${p.name} のコアが破壊され、脱落`, 'out');
    const alive = state.players.filter(x => x.alive);
    if (alive.length === 1) finish(state, alive, `${alive[0].name} 以外の全員が脱落`);
  }

  function finish(state, winners, reason) {
    state.over = true;
    state.pending = null;
    state.abandon = null;
    state.winners = winners.map(p => p.id);
    state.endReason = reason;
    addLog(state, `🏆 ${winners.map(p => p.name).join('・')} の${winners.length > 1 ? '同率優勝' : '勝利'}（${reason}）`, 'win');
  }

  // 手番終了：資源を受け取り、維持費を払う。払えなければ足りない数だけセルを選んで捨ててから次へ
  // 手番終了：資源を受け取り、維持費（いまは無効）を払い、食料を作って食べる。
  // 維持費か食料が足りなければ、足りない数だけセルを選んで捨ててから次へ
  function endTurn(state) {
    const p = current(state);
    const n = income(state, p.id);
    p.resource += n;
    const cost = upkeep(state, p.id);
    const paid = Math.min(cost, p.resource);
    p.resource -= paid;
    const made = foodMade(state, p.id), eaten = foodEaten(state, p.id);
    p.food = (p.food || 0) + made - eaten;
    const hungry = Math.max(0, -p.food);
    p.food = Math.max(0, p.food);
    addLog(state, `${p.name} が手番終了（資源トークン +${n}${cost ? `・維持費 −${paid}` : ''}・食料 +${made} −${eaten}）`, 'income');
    const lack = (cost - paid) + hungry;
    const spare = cellsOf(state, p.id).filter(c => !c.core).length;
    if (lack > 0 && spare > 0) {
      state.abandon = { player: p.id, count: Math.min(lack, spare) };
      const why = hungry && cost - paid ? `維持費と食料が ${lack}` : hungry ? `食料が ${hungry}` : `維持費が ${lack}`;
      addLog(state, `${p.name} は${why} 足りないため、セルを ${state.abandon.count} つ捨てる`, 'abandon');
      return;
    }
    advance(state);
  }

  // 手番終了時に作る食料：コア +5、強化済のセル（コアも）1つにつき +1、農地マスのセル1つにつき +1
  function foodMade(state, id) {
    const f = RULES.food;
    return cellsOf(state, id).reduce((n, c) => n + (c.core ? f.core : 0) + (c.strong ? f.strong : 0) + (c.terrain === 'farm' ? RULES.farmFood : 0), 0);
  }

  // 手番終了時に食べる食料：セル1つにつき1
  function foodEaten(state, id) {
    return cellsOf(state, id).length * RULES.food.perCell;
  }

  // 捨てるセルを選ぶ（コアは捨てられない）
  function abandonCells(state, id, cells) {
    const ab = state.abandon;
    if (state.over || !ab) return fail('いまはセルを捨てるところではありません');
    if (ab.player !== id) return fail('セルを捨てるのはあなたではありません');
    if (!Array.isArray(cells)) return fail('捨てるセルを選んでください');
    const keys = [...new Set(cells.map(String))];
    if (keys.length !== ab.count) return fail(`捨てるセルを ${ab.count} つ選んでください`);
    for (const k of keys) {
      const c = state.board[k];
      if (!c || c.owner !== id) return fail('自分のセルを選んでください');
      if (c.core) return fail('コアは捨てられません');
    }
    for (const k of keys) Object.assign(state.board[k], { owner: null, strong: false, core: false });
    const p = playerById(state, id);
    addLog(state, `${p.name} がセル ${keys.map(k => cellLabel(state.board[k])).join(' ')} を捨てた`, 'abandon');
    state.abandon = null;
    advance(state);
    return { ok: true };
  }

  // 捨てるセルのおすすめ（時間切れ・CPU 用）：一番大きなかたまりから外れたもの、未強化、コアから遠いものから
  function suggestAbandon(state, id) {
    const ab = state.abandon;
    if (!ab || ab.player !== id) return [];
    const p = playerById(state, id);
    const core = parseKey(p.core);
    const group = new Set(largestGroup(state, id));
    return cellsOf(state, id).filter(c => !c.core)
      .map(c => ({ k: key(c.q, c.r), s: (group.has(key(c.q, c.r)) ? 0 : 1000) + (c.strong ? 0 : 100) + dist([c.q, c.r], core) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, ab.count)
      .map(x => x.k);
  }

  // 次の生きているプレイヤーの手番へ。
  // 先行（内側の人が先に動く）が終わったらラウンド1。ラウンドが一周したら、
  // 次のラウンドは最初の人を1人ずらす（2人戦はずらさない。脱落した人は飛ばす）
  function advance(state) {
    const n = state.players.length;
    if (state.round === 0) {
      while (state.preQueue.length) {
        const i = state.preQueue.shift();
        if (state.players[i].alive) { setTurn(state, i); return; }
      }
      state.round = 1;
      state.roundStart = 0;
      state.roundPos = -1;
      addLog(state, `ラウンド 1 / ${state.rounds}`, 'round');
    }
    let i;
    do {
      state.roundPos++;
      if (state.roundPos >= n) {
        state.round++;
        if (state.round > state.rounds) { finishByGroup(state); return; }
        if (n > 2) do { state.roundStart = (state.roundStart + 1) % n; } while (!state.players[state.roundStart].alive);
        state.roundPos = 0;
        addLog(state, `ラウンド ${state.round} / ${state.rounds}${n > 2 ? `（最初は ${state.players[state.roundStart].name}）` : ''}`, 'round');
      }
      i = (state.roundStart + state.roundPos) % n;
    } while (!state.players[i].alive);
    setTurn(state, i);
  }

  function setTurn(state, i) {
    state.turn = i;
    state.turnNo = (state.turnNo || 0) + 1;
    state.actionsLeft = state.actionsPerTurn;
    state.extraBought = 0;
  }

  // 12ラウンド終了：つながっている一番大きなかたまりが大きい人の勝利
  function finishByGroup(state) {
    state.round = state.rounds;
    const alive = state.players.filter(p => p.alive);
    const sizes = alive.map(p => largestGroup(state, p.id).length);
    const best = Math.max(...sizes);
    finish(state, alive.filter((p, i) => sizes[i] === best), `${state.rounds}ラウンド終了・最大のかたまり ${best} セル`);
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

  // 次に行動 +1 を買うのに必要な資源
  function extraActionCost(state) {
    return RULES.extraAction.base + RULES.extraAction.step * (state.extraBought || 0);
  }

  // 脱落させる（切断したまま戻らないときなどに使う）
  function forfeit(state, id) {
    const p = playerById(state, id);
    if (!p || !p.alive || state.over) return;
    if (state.pending && (state.pending.attacker === id || state.pending.defender === id)) state.pending = null;
    if (state.abandon && state.abandon.player === id) state.abandon = null;
    const wasTurn = current(state).id === id;
    eliminate(state, p);
    // 手番の人が抜けたら次へ（資源は受け取らない）
    if (!state.over && wasTurn) advance(state);
    autoEndIfStuck(state);
  }

  // 今だれの操作を待っているか（攻防中は、まだ数を決めていない人。2人のこともある）
  function waiting(state) {
    if (state.over) return [];
    const pd = state.pending;
    if (pd) return [pd.atk === null ? pd.attacker : null, pd.def === null ? pd.defender : null].filter(Boolean);
    if (state.abandon) return [state.abandon.player];
    return [current(state).id];
  }

  return {
    RULES, DIRS, TERRAIN_NAMES, ACTION_NAMES,
    key, parseKey, dist, neighbors, ring, corePositions, generateBoard,
    createGame, apply, targets, actionBlocked, income, expandCost, cellsOf, waiting, forfeit, current,
    largestGroup, extraActionCost, upkeep, turnMs, suggestAbandon, autoSettings, minBid, foodMade, foodEaten,
  };
});
