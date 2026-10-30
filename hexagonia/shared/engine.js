/*
 * ヘキサゴニア — ルール判定
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
    radius: { 2: 3, 3: 3, 4: 4, 5: 5, 6: 5, 7: 6, 8: 6, 9: 7, 10: 7, 11: 7, 12: 7 },
    radiusRange: [3, 10],               // 設定できる半径（直径 7〜21 マス）
    innerCoresFrom: 7,                  // この人数からは、コアの約3分の1を盤面の内側（中心と外周のあいだ）に置く
    turnSeconds: { normal: 120, many: 60, manyFrom: 7 }, // 1手番の持ち時間。7人以上は60秒
    // 平原：鉱山：森林（河川は別に流す）。効果のあるマスは合わせて約20%（4/20）で、2種類に均等に分ける。農地は「開墾」で作る
    terrainRatio: { plain: 16, mine: 2, forest: 2 },
    // ただし公平さのため、どのコアにも距離2（足りなければ3）のマスに2種類を1つずつ必ず置く（盤面が小さいと合計は少し増える）
    centerShare: 0.1,                   // コアの近くの2種類とは別に、少なくとも空きマスの 10% は効果のあるマスとして散らす
    centerBias: 3,                      // 散らすときの出やすさ：（半径 + 1 − 中心からの距離）の3乗に比例。真ん中ほど豊か
    islandShare: 0.6,                   // 河川で区切られても、どのコアも「盤面 ÷ 人数」の 3/5 以上の広さの島を持てるようにする
    minePower: 1,                       // 鉱山マス：拡張（破壊で取ったときも）と強化のときに戦力トークン +1
    farmFood: 1,                        // 農地（開墾したセル）：手番終了時に食料 +1（強化の +1 とは別）
    forestResource: 1,                  // 森林マス：このセルがあると手番終了時に資源 +1（強化の +1 とは別）
    // イベント：ラウンドの始まりに 1/3 の確率で、どれか1つが起きてそのラウンドの間続く（予告はしない）
    eventChance: 1 / 3,
    startResource: 3,
    startPower: 2,                      // 最初に戦力トークンを2個配る
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
    // 破壊は資源2で、戦力トークンが1個以上必要（攻防で1個以上出す）。
    // 生産：資源で戦力トークンを作る（行動回数を使わない・ログに出ない）
    // 開墾：自分の平原のセル（コア以外）を農地にする
    cost: { expand: 1, bridge: 3, strengthen: 2, cultivate: 2, destroy: 2, produce: 2 },
    // 手番終了時の資源。強化済セル +1、コアは +2（強化済ならさらに +1）
    income: { strong: 1, core: 2, coreStrongBonus: true },
    // 食料：手番終了時に、コア +6・強化済のセル（コアも）1つにつき +1 を作り、セル1つにつき1を食べる。
    // 余りは持ち越す。足りなければ、足りない数だけセルを選んで捨てる
    food: { start: 0, core: 6, strong: 1, perCell: 1 },
    strengthenPower: 1,                 // 強化でもらえる戦力トークン
    // 拠点：破壊できるのは、自分の強化済のセル（コアも強化すれば同じ）に隣接する相手のセルだけ
  };

  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const key = (q, r) => q + ',' + r;
  const parseKey = k => k.split(',').map(Number);
  const dist = (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[0] + a[1] - b[0] - b[1])) / 2;
  const neighbors = (q, r) => DIRS.map(([dq, dr]) => [q + dq, r + dr]);

  const TERRAIN_NAMES = { plain: '平原マス', mine: '鉱山マス', farm: '農地マス', forest: '森林マス', river: '河川マス' };
  // イベント。food・res：生産の倍率（切り捨て）、riverFood：河川の隣のセル1つにつき食料（マイナスは食べる量が増える）、actions：行動回数
  const EVENTS = {
    famine: { name: '不作', text: 'このラウンド、食料生産が0.5倍', food: 0.5 },
    harvest: { name: '豊作', text: 'このラウンド、食料生産が1.5倍', food: 1.5 },
    depletion: { name: '枯渇', text: 'このラウンド、資源生産が0.5倍', res: 0.5 },
    discovery: { name: '発見', text: 'このラウンド、資源生産が1.5倍', res: 1.5 },
    fishing: { name: '豊漁', text: 'このラウンド、河川の隣のセル1つにつき食料 +1', riverFood: 1 },
    flood: { name: '洪水', text: 'このラウンド、河川の隣のセル1つにつき食料 −1', riverFood: -1 },
    festival: { name: '祭事', text: 'このラウンド、行動可能回数 +1', actions: 1 },
    plague: { name: '疫病', text: 'このラウンド、行動可能回数 −1', actions: -1 },
  };

  const TERRAIN_KINDS = ['mine', 'forest'];   // 盤面を作るときに置く、効果のある地形（農地は開墾で作る）

  const ACTION_NAMES = { expand: '拡張', strengthen: '強化', cultivate: '開墾', destroy: '破壊', produce: '生産（戦力トークン）' };
  const PRODUCE = ['produce'];   // 生産（行動回数を使わない）

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
    const tributaries = radius >= 8 ? 1 : 0;   // 支流は大きな盤面だけ（河川で行動範囲が狭まりすぎないように）
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

    // どのコアも、河川を渡らずに十分な広さの土地（島）を持てること：盤面を人数で割った広さの 3/5 以上
    function fair(river) {
      const need = Math.floor(total * RULES.islandShare / cores.length);
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

    for (let i = 0; i < 80; i++) {
      const river = attempt();
      if (river.size >= radius && fair(river)) return river;
    }
    return new Set();   // どうしても広さを満たせなければ河川なし
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
    const kinds = TERRAIN_KINDS;
    const effect = kinds.reduce((n, t) => n + (ratio[t] || 0), 0);
    // 公平さのため、どのコアにも、距離2（足りなければ3）のマスに3種類を1つずつ置く
    const used = new Set(), owners = new Map();   // 置いたマスと、どのコアのために置いたか
    let placed = 0;
    for (const c of cores) {
      for (let d = 2; d <= 3; d++) {
        const ks = shuffle(ring(d).map(([q, r]) => key(c[0] + q, c[1] + r)).filter(k => board[k] && !fixed.has(k) && !river.has(k) && !used.has(k)), rng);
        const mine = [...used].filter(k => owners.get(k) === c);
        const want = kinds.filter(t => !mine.some(k => board[k].terrain === t));
        for (const t of want) {
          const k = ks.shift();
          if (!k) break;
          board[k].terrain = t;
          used.add(k);
          owners.set(k, c);
          placed++;
        }
      }
    }
    // 残りは、効果のあるマスの合計（約27%）に届くまで、種類ごとの数がそろうように散らす。
    // コアの近くの分で合計に届いていても、少なくとも空きマスの centerShare の分は散らす。
    // 盤面の中心に近いほど出やすい（真ん中ほど豊かな土地）
    const sum = Math.max(placed + Math.round(free.length * RULES.centerShare), Math.round(free.length * effect / (ratio.plain + effect)));
    const have = t => free.filter(k => board[k].terrain === t).length;
    const rest = free.filter(k => !used.has(k)).map(k => ({ k, w: Math.pow(1 + radius - dist(parseKey(k), [0, 0]), RULES.centerBias) }));
    for (let left = sum - placed; left > 0 && rest.length; left--) {
      let x = rng() * rest.reduce((n, c) => n + c.w, 0), i = 0;
      while (i < rest.length - 1 && (x -= rest[i].w) > 0) i++;
      const [{ k }] = rest.splice(i, 1);
      const t = shuffle(kinds.slice(), rng).sort((a, b) => have(a) / (ratio[a] || 1) - have(b) / (ratio[b] || 1))[0];
      board[k].terrain = t;
    }
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
        return { id: p.id, name: p.name, color: p.color, resource: RULES.startResource, power: RULES.startPower, food: RULES.food.start, alive: true, core: key(q, r),
          // powerSeen：ほかの人から見てわかる戦力トークンの数の目安（見えている増え方から、攻防で少なくとも出したはずの数を引く。生産の分は含まない）
          powerSeen: RULES.startPower };
      }),
      actionsPerTurn: actions,
      rounds,
      turn: 0,               // players の何番目の手番か
      turnNo: 1,             // 何回目の手番か（通し番号）
      round: 1,              // 0 は内側の人の先行
      preQueue: [],          // 先行で、このあと手番が来る人（players の何番目か）
      eventPlan: [],         // ラウンドごとのイベント（ホストだけが持つ。ほかの人には今と次のラウンドの分だけ送る）
      event: null,           // このラウンドのイベント
      roundStart: 0,         // 最初の人（players の何番目か）。ラウンドが変わってもずらさない
      roundPos: 0,           // このラウンドで何人目の手番か
      actionsLeft: actions,
      extraBought: 0,        // この手番で行動 +1 を買った回数
      pending: null,         // 破壊の攻防中： { attacker, defender, target, atk, def }（出す数。null はまだ決めていない）
      lastEndTurn: null,     // 最後の手番終了で増えた・減った資源と食料（画面の演出用）
      abandon: null,         // 食料が足りず、セルを捨てる途中： { player, count }
      over: false,
      winners: [],
      endReason: '',
      log: [],
      logSeq: 0,
    };
    addLog(state, `ゲーム開始。手番順：${state.players.map(p => p.name).join(' → ')}（1手番 ${actions} 行動・${rounds} ラウンド）`, 'info');
    // イベントを決めておく（ラウンドごとに 1/3 の確率）
    const keys = Object.keys(EVENTS);
    const withEvents = !(opts && opts.events === false);
    for (let r = 1; r <= rounds; r++) state.eventPlan[r] = withEvents && rng() < RULES.eventChance ? keys[Math.floor(rng() * keys.length)] : null;
    // 内側にコアがある人は、ラウンド1の前に先に2手番ずつ動く
    const inner = state.players.map((p, i) => i).filter(i => dist(parseKey(state.players[i].core), [0, 0]) < radius);
    if (inner.length) {
      for (let t = 0; t < RULES.preTurns; t++) state.preQueue.push(...inner);
      state.round = 0;
      state.turn = state.preQueue.shift();
      addLog(state, `先行：内側にコアがある人（${inner.map(i => state.players[i].name).join('・')}）が、ラウンド1の前に ${RULES.preTurns} 手番ずつ動く`, 'round');
    } else {
      addLog(state, `ラウンド 1 / ${rounds}`, 'round');
      startRoundEvent(state);
      state.actionsLeft = actionsThisTurn(state);
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

  // 自分の強化済のセルに隣接しているか（破壊の拠点）
  function adjacentToStrong(state, id, q, r) {
    return neighbors(q, r).some(([nq, nr]) => { const c = state.board[key(nq, nr)]; return c && c.owner === id && c.strong; });
  }


  // ターン終了時に受け取る資源
  // ラウンドが始まったら、このラウンドのイベントを決める
  function startRoundEvent(state) {
    state.event = state.eventPlan[state.round] || null;
    if (state.event) addLog(state, `イベント：${EVENTS[state.event].name}（${EVENTS[state.event].text}）`, 'event');
  }

  const eventOf = state => (state.round >= 1 && state.event ? EVENTS[state.event] : null);

  // このラウンドの1手番の行動回数（祭事・疫病で増減。1回より少なくはならない）
  function actionsThisTurn(state) {
    const ev = eventOf(state);
    return Math.max(1, state.actionsPerTurn + ((ev && ev.actions) || 0));
  }

  // 河川の隣にある自分のセルの数（橋は除く。豊漁・洪水で使う）
  function riversideCells(state, id) {
    return cellsOf(state, id).filter(c => c.terrain !== 'river' && neighbors(c.q, c.r).some(([q, r]) => { const n = state.board[key(q, r)]; return n && n.terrain === 'river'; })).length;
  }

  function income(state, id) {
    const ev = eventOf(state);
    return Math.floor(baseIncome(state, id) * ((ev && ev.res) || 1));
  }

  function baseIncome(state, id) {
    const inc = RULES.income;
    let n = 0;
    for (const c of cellsOf(state, id)) {
      if (c.core) n += inc.core + (c.strong && inc.coreStrongBonus ? inc.strong : 0);
      else if (c.strong) n += inc.strong;
      if (c.terrain === 'forest') n += RULES.forestResource;   // 森林は強化とは別に +1
    }
    return n;
  }

  function expandCost(cell) {
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
    // 生産は行動回数を使わない
    if (!PRODUCE.includes(type) && state.actionsLeft <= 0) return 'この手番の行動回数を使い切りました';
    const min = type === 'expand' ? RULES.cost.expand : RULES.cost[type];
    if (p.resource < min) return '資源トークンが足りません';
    if (type === 'destroy' && p.power < 1) return '破壊には戦力トークンが1個以上必要です';
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
      } else if (type === 'cultivate') {
        if (c.owner === id && !c.core && c.terrain === 'plain') out.push(k);
      } else if (type === 'destroy') {
        if (c.owner && c.owner !== id && adjacentToStrong(state, id, c.q, c.r)) out.push(k);
      }
    }
    return out;
  }

  function fail(error) { return { ok: false, error }; }

  /*
   * 行動を実行する。state は書き換わる。
   * action: { type: 'expand'|'strengthen'|'destroy', q, r } / { type: 'produce' } / { type: 'endTurn' }
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
    if (PRODUCE.some(t => !actionBlocked(state, id, t)) || !actionBlocked(state, id, 'buyAction')) return true;
    return ['expand', 'strengthen', 'cultivate', 'destroy'].some(t => targets(state, id, t).length > 0);
  }

  function applyAction(state, id, action) {
    if (!action || typeof action.type !== 'string') return fail('不明な行動です');
    if (action.type === 'bid') return bid(state, id, action.count);
    if (action.type === 'abandon') return abandonCells(state, id, action.cells);
    if (action.type === 'cancelDestroy') return cancelDestroy(state, id);
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
    // 生産：資源でトークンを作る。行動回数を使わず、ログにも出さない
    if (action.type === 'produce') {
      p.resource -= RULES.cost.produce;
      p.power += 1;
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
      extra = terrainGain(p, cell);
      if (extra) extra = `（${extra}）`;
      state.actionsLeft--;
      if (cell.terrain === 'river') addLog(state, `${p.name} が河川マス${cellLabel(cell)}に橋をかけた（資源 ${cost}）`, 'expand');
      else addLog(state, `${p.name} が${TERRAIN_NAMES[cell.terrain]}${cellLabel(cell)}に拡張${extra}`, 'expand');
    } else if (action.type === 'cultivate') {
      p.resource -= RULES.cost.cultivate;
      cell.terrain = 'farm';
      state.actionsLeft--;
      addLog(state, `${p.name} がセル${cellLabel(cell)}を開墾して農地に（毎手番 食料 +${RULES.farmFood}）`, 'strengthen');
    } else if (action.type === 'strengthen') {
      p.resource -= RULES.cost.strengthen;
      cell.strong = true;
      p.power += RULES.strengthenPower;
      p.powerSeen += RULES.strengthenPower;   // ログに出るので、ほかの人にもわかる
      let extra = `戦力トークン +${RULES.strengthenPower}`;
      const tg = terrainGain(p, cell);
      if (tg) extra += `・${tg}`;
      state.actionsLeft--;
      addLog(state, `${p.name} が${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}を強化（${extra}）`, 'strengthen');
    } else if (action.type === 'destroy') {
      const def = playerById(state, cell.owner);
      p.resource -= RULES.cost.destroy;
      state.actionsLeft--;
      addLog(state, `${p.name} が ${def.name} の${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}に破壊を宣言`, 'destroy');
      // 攻撃側（1個以上）・防御側（0個から）が、出す戦力トークンの数を伏せて決める。
      // 戦力トークンの数はおたがいに見えないので、0個しか出せなくても選ぶ
      state.pending = { attacker: id, defender: def.id, target: k, atk: null, def: null };
      if (p.power === 1) state.pending.atk = 1;                     // 1個しかなければ1個に決まる
      if (state.pending.atk !== null && state.pending.def !== null) resolveDestroy(state, state.pending.atk, state.pending.def);
    }
    return { ok: true };
  }

  // 破壊の攻防：攻撃側と防御側が出す数を伏せて決め、そろったら同時に公開する。
  // 攻撃 ≧ 防御なら破壊成功（同じ数なら攻撃側の勝ち）。出したトークンはすべてなくなる
  function bid(state, id, count) {
    const pd = state.pending;
    if (state.over || !pd) return fail('いまは攻防中ではありません');
    const side = pd.attacker === id ? 'atk' : pd.defender === id ? 'def' : null;
    if (!side) return fail('この攻防には加わっていません');
    if (pd[side] !== null) return fail('もう決めました');
    const p = playerById(state, id);
    const have = p.power;
    const n = Number(count);
    if (!Number.isInteger(n) || n < minBid(side) || n > have) return fail(side === 'atk' && n < 1 ? '攻撃側は戦力トークンを1個以上出してください' : '出せる数ではありません');
    pd[side] = n;
    if (pd.atk !== null && pd.def !== null) resolveDestroy(state, pd.atk, pd.def);
    return { ok: true };
  }

  // 破壊の取りやめ：攻防が決着する前なら、攻撃側は宣言を取り消せる。資源と行動回数は戻り、トークンは減らない。
  // 何回でもできる（攻防のあいだも持ち時間は進むので、引き延ばしにはならない）
  function cancelDestroy(state, id) {
    const pd = state.pending;
    if (state.over || !pd) return fail('いまは攻防中ではありません');
    if (pd.attacker !== id) return fail('破壊を取りやめられるのは攻撃側だけです');
    const p = playerById(state, id);
    const cell = state.board[pd.target];
    state.pending = null;
    p.resource += RULES.cost.destroy;
    state.actionsLeft++;
    addLog(state, `${p.name} が${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}への破壊を取りやめた（資源と行動回数は戻る）`, 'info');
    return { ok: true };
  }

  // 攻防で出す数の下限：攻撃側は1個以上、防御側は0個から
  function minBid(side) { return side === 'atk' ? 1 : 0; }

  function resolveDestroy(state, atk, def) {
    const pd = state.pending;
    state.pending = null;
    const cell = state.board[pd.target];
    const a = playerById(state, pd.attacker), d = playerById(state, pd.defender);
    a.power -= atk;
    d.power -= def;
    const success = atk >= def;
    // 出した数は公開しない（成功か失敗かだけ）。数は当人にだけ見せる（room.js）
    state.lastClash = { seq: state.logSeq + 1, attacker: pd.attacker, defender: pd.defender, target: pd.target, def, atk, success };
    // 見えている数の目安：攻撃側は少なくとも1個、守られたなら防御側は少なくとも2個（攻撃側の1個より多く）出したはず
    a.powerSeen = Math.max(0, a.powerSeen - 1);
    if (!success) d.powerSeen = Math.max(0, d.powerSeen - 2);
    const what = cell.core ? 'コア' : 'セル';
    addLog(state, `攻防：${a.name} と ${d.name} がトークンを出し合った（出した数は非公開）`, 'clash');
    if (!success) { addLog(state, `破壊失敗：${d.name} の${what}${cellLabel(cell)}は守られた`, 'defend'); return; }
    const wasCore = cell.core;
    Object.assign(cell, { owner: null, strong: false, core: false });
    if (cell.terrain === 'river') {
      // 橋は破壊されると落ちて、河川に戻る（攻撃側のセルにはならない）
      addLog(state, `破壊成功：${a.name} が ${d.name} の橋${cellLabel(cell)}を落とした（河川に戻る）`, 'destroy');
      return;
    }
    addLog(state, `破壊成功：${a.name} が ${d.name} の${what}${cellLabel(cell)}を破壊`, 'destroy');
    if (wasCore) eliminate(state, d, a);   // コアを破壊した人が、相手のセルとトークンをまるごと奪う
    // 破壊したマスはそのまま攻撃側のセル（未強化）になる。鉱山マスなら拡張と同じく戦力トークン +1
    Object.assign(cell, { owner: a.id, strong: false, core: false });
    let extra = terrainGain(a, cell);
    if (extra) extra = `（${extra}）`;
    addLog(state, `${a.name} が${TERRAIN_NAMES[cell.terrain]}${cellLabel(cell)}にそのまま拡張${extra}`, 'expand');
  }

  // 鉱山マスを拡張・強化したとき（破壊で取ったときも）にもらえる戦力トークン。ログ用の文を返す
  function terrainGain(p, cell) {
    if (cell.terrain !== 'mine') return '';
    p.power += RULES.minePower;
    p.powerSeen += RULES.minePower;   // ログに出るので、ほかの人にもわかる
    return `鉱山：戦力トークン +${RULES.minePower}`;
  }

  // 脱落。heir（コアを破壊した人）がいれば、セル（強化済はそのまま）・資源・戦力・食料をまるごと受け継ぐ。
  // いなければ（切断などで脱落させたとき）、セルは空きマスに戻り、トークンもなくなる
  function eliminate(state, p, heir) {
    p.alive = false;
    const cells = cellsOf(state, p.id);
    for (const c of cells) Object.assign(c, heir ? { owner: heir.id, core: false } : { owner: null, strong: false, core: false });
    if (heir) {
      heir.resource += p.resource;
      heir.power += p.power;
      heir.powerSeen += p.powerSeen;
      heir.food = (heir.food || 0) + (p.food || 0);
    }
    p.resource = 0; p.power = 0; p.food = 0; p.powerSeen = 0;
    addLog(state, heir
      ? `💀 ${p.name} のコアが破壊され、脱落。セル ${cells.length} 個とトークンはすべて ${heir.name} のものに`
      : `💀 ${p.name} が脱落`, 'out');
    const alive = state.players.filter(x => x.alive);
    if (alive.length === 1) finish(state, alive, `${alive[0].name} 以外の全員が脱落`);
  }

  function finish(state, winners, reason) {
    state.over = true;
    state.pending = null;
    state.abandon = null;
    state.event = null;
    state.winners = winners.map(p => p.id);
    state.endReason = reason;
    addLog(state, `🏆 ${winners.map(p => p.name).join('・')} の${winners.length > 1 ? '同率優勝' : '勝利'}（${reason}）`, 'win');
  }

  // 手番終了：資源を受け取り、食料を作って食べる。食料が足りなければ、足りない数だけセルを選んで捨ててから次へ
  function endTurn(state) {
    const p = current(state);
    const n = income(state, p.id);
    const resBefore = p.resource, foodBefore = p.food || 0;
    p.resource += n;
    const made = foodMade(state, p.id), eaten = foodEaten(state, p.id);
    p.food = foodBefore + made - eaten;
    const hungry = Math.max(0, -p.food);
    p.food = Math.max(0, p.food);
    // 画面で「増えてから減る」を見せるための記録（どのマスがいくつ作ったかは、画面の側で盤面から数える）
    state.lastEndTurn = { seq: state.logSeq + 1, player: p.id, resBefore, resource: n, foodBefore, made, eaten, hungry };
    addLog(state, `${p.name} が手番終了（資源トークン +${n}・食料 +${made} −${eaten}）`, 'income');
    const spare = cellsOf(state, p.id).filter(c => !c.core).length;
    if (hungry > 0 && spare > 0) {
      state.abandon = { player: p.id, count: Math.min(hungry, spare) };
      addLog(state, `${p.name} は食料が ${hungry} 足りないため、セルを ${state.abandon.count} つ捨てる`, 'abandon');
      return;
    }
    advance(state);
  }

  // 手番終了時に作る食料：コア +6、強化済のセル（コアも）1つにつき +1、農地のセル1つにつき +1
  function foodMade(state, id) {
    const f = RULES.food;
    const ev = eventOf(state);
    let n = cellsOf(state, id).reduce((k, c) => k + (c.core ? f.core : 0) + (c.strong ? f.strong : 0) + (c.terrain === 'farm' ? RULES.farmFood : 0), 0);
    if (ev && ev.riverFood > 0) n += riversideCells(state, id) * ev.riverFood;   // 豊漁
    return Math.floor(n * ((ev && ev.food) || 1));                               // 不作・豊作
  }

  // 手番終了時に食べる食料：セル1つにつき1（洪水のときは河川の隣のセル1つにつきさらに1）
  function foodEaten(state, id) {
    const ev = eventOf(state);
    const flood = ev && ev.riverFood < 0 ? riversideCells(state, id) * -ev.riverFood : 0;
    return cellsOf(state, id).length * RULES.food.perCell + flood;
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
      startRoundEvent(state);
    }
    let i;
    do {
      state.roundPos++;
      if (state.roundPos >= n) {
        state.round++;
        if (state.round > state.rounds) { finishByGroup(state); return; }
        state.roundPos = 0;
        addLog(state, `ラウンド ${state.round} / ${state.rounds}`, 'round');
        startRoundEvent(state);
      }
      i = (state.roundStart + state.roundPos) % n;
    } while (!state.players[i].alive);
    setTurn(state, i);
  }

  function setTurn(state, i) {
    state.turn = i;
    state.turnNo = (state.turnNo || 0) + 1;
    state.actionsLeft = actionsThisTurn(state);
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
    RULES, DIRS, TERRAIN_NAMES, TERRAIN_KINDS, ACTION_NAMES, EVENTS, PRODUCE,
    key, parseKey, dist, neighbors, ring, corePositions, generateBoard,
    createGame, apply, targets, actionBlocked, income, expandCost, cellsOf, waiting, forfeit, current,
    adjacentToStrong, largestGroup, extraActionCost, turnMs, suggestAbandon, autoSettings, minBid, foodMade, foodEaten, riversideCells, actionsThisTurn,
  };
});
