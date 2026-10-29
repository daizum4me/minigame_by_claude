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
    maxPlayers: 4,
    radius: { 2: 3, 3: 4, 4: 5 },       // 人数ごとの盤面の半径（直径 7・9・11 マス）。部屋の設定で変えられる
    radiusRange: [3, 7],                // 設定できる半径（直径 7〜15 マス）
    terrainRatio: { plain: 14, mountain: 3, mine: 3 }, // 平原：山岳：鉱山 = 70%：15%：15%（要調整）
    startResource: 3,
    actionsPerTurn: 3,
    extraAction: { base: 6, step: 4 },  // 行動回数を使い切ったあと、資源を払って行動 +1。同じ手番で買うたびに +4（6, 10, 14…）
    rounds: 12,
    cost: { expand: 1, expandMountain: 2, strengthen: 2, destroy: 1, reinforce: 2 },
    income: { strong: 1, mineBonus: 1, core: 2, coreStrongBonus: true }, // 要確認：強化済コアは +1 も得る（暫定：得る）
  };

  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const key = (q, r) => q + ',' + r;
  const parseKey = k => k.split(',').map(Number);
  const dist = (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[0] + a[1] - b[0] - b[1])) / 2;
  const neighbors = (q, r) => DIRS.map(([dq, dr]) => [q + dq, r + dr]);

  const TERRAIN_NAMES = { plain: '平原マス', mountain: '山岳マス', mine: '鉱山マス' };
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

  // コアの位置：外周の1つ内側の輪に、人数で等間隔に並べる
  function corePositions(radius, count) {
    const cells = ring(radius - 1);
    return Array.from({ length: count }, (_, i) => cells[Math.round(i * cells.length / count) % cells.length]);
  }

  function generateBoard(count, rng, radius) {
    radius = radius || RULES.radius[count];
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
    const free = Object.keys(board).filter(k => !fixed.has(k));
    const ratio = RULES.terrainRatio;
    const total = ratio.plain + ratio.mountain + ratio.mine;
    const nMountain = Math.round(free.length * ratio.mountain / total);
    const nMine = Math.round(free.length * ratio.mine / total);
    shuffle(free, rng);
    free.forEach((k, i) => { board[k].terrain = i < nMountain ? 'mountain' : i < nMountain + nMine ? 'mine' : 'plain'; });
    return { radius, board, cores };
  }

  /*
   * players: [{ id, name, color }]（2〜4人）
   * opts.radius：盤面の半径（省略すると人数に合わせる）
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
    const state = {
      radius,
      board,
      players: order.map((p, i) => {
        const [q, r] = cores[i];
        Object.assign(board[key(q, r)], { owner: p.id, core: true });
        return { id: p.id, name: p.name, color: p.color, resource: RULES.startResource, attack: 0, defense: 0, alive: true, core: key(q, r) };
      }),
      turn: 0,               // players の何番目の手番か
      round: 1,
      actionsLeft: RULES.actionsPerTurn,
      extraBought: 0,        // この手番で行動 +1 を買った回数
      pending: null,         // 破壊の攻防中： { attacker, defender, target, atk, def }（出す数。null はまだ決めていない）
      over: false,
      winners: [],
      endReason: '',
      log: [],
      logSeq: 0,
    };
    addLog(state, `ゲーム開始。手番順：${state.players.map(p => p.name).join(' → ')}`, 'info');
    addLog(state, `ラウンド 1 / ${RULES.rounds}`, 'round');
    return state;
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
      if (c.core) n += inc.core + (c.strong && inc.coreStrongBonus ? inc.strong : 0) + (c.strong && c.terrain === 'mine' ? inc.mineBonus : 0);
      else if (c.strong) n += inc.strong + (c.terrain === 'mine' ? inc.mineBonus : 0);
    }
    return n;
  }

  function expandCost(cell) {
    return cell.terrain === 'mountain' ? RULES.cost.expandMountain : RULES.cost.expand;
  }

  // 今その行動ができるか（マスの指定がいらない判定）。できなければ理由を返す
  function actionBlocked(state, id, type) {
    if (state.over) return 'ゲームは終わっています';
    const p = current(state);
    if (!p || p.id !== id) return 'あなたの手番ではありません';
    if (state.pending) return '破壊の攻防が終わるまで待ってください';
    if (type === 'endTurn') return '';
    if (type === 'buyAction') {
      if (state.actionsLeft > 0) return 'まだ行動回数が残っています';
      if (p.resource < extraActionCost(state)) return '資源トークンが足りません';
      return '';
    }
    if (!(type in ACTION_NAMES)) return '不明な行動です';
    if (state.actionsLeft <= 0) return 'この手番の行動回数を使い切りました';
    const min = type === 'expand' ? RULES.cost.expand : RULES.cost[type];
    if (p.resource < min) return '資源トークンが足りません';
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
    if (!action || typeof action.type !== 'string') return fail('不明な行動です');
    if (action.type === 'bid') return bid(state, id, action.count);
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
      p.attack += 1;
      state.actionsLeft--;
      addLog(state, `${p.name} が補強（防御トークン +1・攻撃トークン +1）`, 'reinforce');
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
      state.actionsLeft--;
      addLog(state, `${p.name} が${TERRAIN_NAMES[cell.terrain]}${cellLabel(cell)}に拡張${extra}`, 'expand');
    } else if (action.type === 'strengthen') {
      p.resource -= RULES.cost.strengthen;
      cell.strong = true;
      p.attack += 1;
      let extra = '攻撃トークン +1';
      if (cell.terrain === 'mountain') { p.defense += 1; extra += '・山岳：防御トークン +1'; }
      state.actionsLeft--;
      addLog(state, `${p.name} が${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}を強化（${extra}）`, 'strengthen');
    } else if (action.type === 'destroy') {
      const def = playerById(state, cell.owner);
      p.resource -= RULES.cost.destroy;
      state.actionsLeft--;
      addLog(state, `${p.name} が ${def.name} の${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}に破壊を宣言`, 'destroy');
      // 攻撃側・防御側が、出すトークンの数を伏せて決める
      state.pending = { attacker: id, defender: def.id, target: k, atk: null, def: null };
      if (def.defense <= 0) resolveDestroy(state, 0, 0);           // 防御トークンがなければそのまま成功
      else if (p.attack <= 0) state.pending.atk = 0;               // 攻撃トークンがなければ 0 個に決まる
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
    if (!Number.isInteger(n) || n < 0 || n > have) return fail('出せる数ではありません');
    pd[side] = n;
    if (pd.atk !== null && pd.def !== null) resolveDestroy(state, pd.atk, pd.def);
    return { ok: true };
  }

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
    addLog(state, `破壊成功：${a.name} が ${d.name} の${what}${cellLabel(cell)}を破壊`, 'destroy');
    if (wasCore) eliminate(state, d);
    // 破壊したマスはそのまま攻撃側のセル（未強化）になる。山岳マスなら拡張と同じく防御トークン +1
    Object.assign(cell, { owner: a.id, strong: false, core: false });
    let extra = '';
    if (cell.terrain === 'mountain') { a.defense += 1; extra = '（山岳：防御トークン +1）'; }
    addLog(state, `${a.name} が${TERRAIN_NAMES[cell.terrain]}${cellLabel(cell)}にそのまま拡張${extra}`, 'expand');
  }

  function eliminate(state, p) {
    p.alive = false;
    for (const c of cellsOf(state, p.id)) Object.assign(c, { owner: null, strong: false, core: false });
    p.resource = 0; p.attack = 0; p.defense = 0;
    addLog(state, `💀 ${p.name} のコアが破壊され、脱落`, 'out');
    const alive = state.players.filter(x => x.alive);
    if (alive.length === 1) finish(state, alive, `${alive[0].name} 以外の全員が脱落`);
  }

  function finish(state, winners, reason) {
    state.over = true;
    state.pending = null;
    state.winners = winners.map(p => p.id);
    state.endReason = reason;
    addLog(state, `🏆 ${winners.map(p => p.name).join('・')} の${winners.length > 1 ? '同率優勝' : '勝利'}（${reason}）`, 'win');
  }

  function endTurn(state) {
    const p = current(state);
    const n = income(state, p.id);
    p.resource += n;
    addLog(state, `${p.name} が手番終了（資源トークン +${n}）`, 'income');
    advance(state);
  }

  // 次の生きているプレイヤーの手番へ。一周したらラウンドが進む
  function advance(state) {
    let i = state.turn;
    do {
      i++;
      if (i >= state.players.length) {
        i = 0;
        state.round++;
        if (state.round > RULES.rounds) { finishByGroup(state); return; }
        addLog(state, `ラウンド ${state.round} / ${RULES.rounds}`, 'round');
      }
    } while (!state.players[i].alive);
    state.turn = i;
    state.actionsLeft = RULES.actionsPerTurn;
    state.extraBought = 0;
  }

  // 12ラウンド終了：つながっている一番大きなかたまりが大きい人の勝利
  function finishByGroup(state) {
    state.round = RULES.rounds;
    const alive = state.players.filter(p => p.alive);
    const sizes = alive.map(p => largestGroup(state, p.id).length);
    const best = Math.max(...sizes);
    finish(state, alive.filter((p, i) => sizes[i] === best), `${RULES.rounds}ラウンド終了・最大のかたまり ${best} セル`);
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
    const wasTurn = current(state).id === id;
    eliminate(state, p);
    // 手番の人が抜けたら次へ（資源は受け取らない）
    if (!state.over && wasTurn) advance(state);
  }

  // 今だれの操作を待っているか（攻防中は、まだ数を決めていない人。2人のこともある）
  function waiting(state) {
    if (state.over) return [];
    const pd = state.pending;
    if (pd) return [pd.atk === null ? pd.attacker : null, pd.def === null ? pd.defender : null].filter(Boolean);
    return [current(state).id];
  }

  return {
    RULES, DIRS, TERRAIN_NAMES, ACTION_NAMES,
    key, parseKey, dist, neighbors, ring, corePositions, generateBoard,
    createGame, apply, targets, actionBlocked, income, expandCost, cellsOf, waiting, forfeit, current,
    largestGroup, extraActionCost,
  };
});
