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
    radius: { 2: 4, 3: 5, 4: 6 },       // 人数ごとの盤面の半径
    terrainRatio: { plain: 6, mountain: 2, mine: 2 }, // 平原：山岳：鉱山（要調整）
    startResource: 3,
    actionsPerTurn: 3,
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

  function generateBoard(count, rng) {
    const radius = RULES.radius[count];
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
   * 手番順はランダム。盤面上の配置も手番順に並べる。
   */
  function createGame(players, rng) {
    rng = rng || Math.random;
    if (players.length < RULES.minPlayers || players.length > RULES.maxPlayers) throw new Error('人数が正しくありません');
    const { radius, board, cores } = generateBoard(players.length, rng);
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
      pending: null,         // 破壊の攻防中： { attacker, defender, target, stage: 'defend'|'attack', def, atk }
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
   *         { type: 'defend', use: bool }（防御側） / { type: 'attack', use: bool }（攻撃側）
   */
  function apply(state, id, action) {
    if (!action || typeof action.type !== 'string') return fail('不明な行動です');
    if (action.type === 'defend' || action.type === 'attack') return respond(state, id, action.type, !!action.use);
    const blocked = actionBlocked(state, id, action.type);
    if (blocked) return fail(blocked);
    const p = playerById(state, id);
    if (action.type === 'endTurn') { endTurn(state); return { ok: true }; }
    if (action.type === 'reinforce') {
      p.resource -= RULES.cost.reinforce;
      p.defense += 1;
      state.actionsLeft--;
      addLog(state, `${p.name} が補強（防御トークン +1）`, 'reinforce');
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
      state.pending = { attacker: id, defender: def.id, target: k, stage: 'defend', def: 0, atk: 0 };
      if (def.defense <= 0) resolveDestroy(state, true);
    }
    return { ok: true };
  }

  // 破壊の攻防：防御側が防御トークンを出す／出さない、攻撃側が攻撃トークンを出す／諦める
  function respond(state, id, type, use) {
    const pd = state.pending;
    if (state.over || !pd) return fail('いまは攻防中ではありません');
    if (type === 'defend') {
      if (pd.stage !== 'defend' || pd.defender !== id) return fail('いまはあなたが防御を選ぶ番ではありません');
      const d = playerById(state, id);
      if (!use || d.defense <= 0) { addLog(state, `${d.name} は防御トークンを出さなかった`, 'destroy'); resolveDestroy(state, true); return { ok: true }; }
      d.defense -= 1;
      pd.def += 1;
      addLog(state, `${d.name} が防御トークンを出した（${pd.def} 個目）`, 'defend');
      pd.stage = 'attack';
      if (playerById(state, pd.attacker).attack <= 0) resolveDestroy(state, false);
      return { ok: true };
    }
    if (pd.stage !== 'attack' || pd.attacker !== id) return fail('いまはあなたが攻撃を選ぶ番ではありません');
    const a = playerById(state, id);
    if (!use || a.attack <= 0) { addLog(state, `${a.name} は破壊を諦めた`, 'defend'); resolveDestroy(state, false); return { ok: true }; }
    a.attack -= 1;
    pd.atk += 1;
    addLog(state, `${a.name} が攻撃トークンを出し、防御トークンを1個破壊（${pd.atk} 個目）`, 'destroy');
    pd.stage = 'defend';
    if (playerById(state, pd.defender).defense <= 0) resolveDestroy(state, true);
    return { ok: true };
  }

  function resolveDestroy(state, success) {
    const pd = state.pending;
    state.pending = null;
    state.lastClash = { attacker: pd.attacker, defender: pd.defender, target: pd.target, def: pd.def, atk: pd.atk, success };
    const cell = state.board[pd.target];
    const a = playerById(state, pd.attacker), d = playerById(state, pd.defender);
    if (!success) { addLog(state, `破壊失敗：${d.name} の${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}は守られた`, 'defend'); return; }
    const wasCore = cell.core;
    Object.assign(cell, { owner: null, strong: false, core: false });
    addLog(state, `破壊成功：${a.name} が ${d.name} の${wasCore ? 'コア' : 'セル'}${cellLabel(cell)}を破壊`, 'destroy');
    if (wasCore) eliminate(state, d);
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
        if (state.round > RULES.rounds) { finishByCells(state); return; }
        addLog(state, `ラウンド ${state.round} / ${RULES.rounds}`, 'round');
      }
    } while (!state.players[i].alive);
    state.turn = i;
    state.actionsLeft = RULES.actionsPerTurn;
  }

  function finishByCells(state) {
    state.round = RULES.rounds;
    const alive = state.players.filter(p => p.alive);
    const counts = alive.map(p => cellsOf(state, p.id).length);
    const best = Math.max(...counts);
    finish(state, alive.filter((p, i) => counts[i] === best), `${RULES.rounds}ラウンド終了・セル ${best} 個`);
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

  // 今だれの操作を待っているか
  function waitingFor(state) {
    if (state.over) return null;
    if (state.pending) return state.pending.stage === 'defend' ? state.pending.defender : state.pending.attacker;
    return current(state).id;
  }

  return {
    RULES, DIRS, TERRAIN_NAMES, ACTION_NAMES,
    key, parseKey, dist, neighbors, ring, corePositions, generateBoard,
    createGame, apply, targets, actionBlocked, income, expandCost, cellsOf, waitingFor, forfeit, current,
  };
});
