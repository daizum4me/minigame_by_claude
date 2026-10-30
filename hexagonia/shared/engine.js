/*
 * ヘキサゴニア — ルール判定
 * 盤面の生成・行動の検証と実行・ターンの処理・脱落・勝敗をここで扱う。
 * 手番はなく、だれでもいつでも行動できる（行動力を使う）。15秒ごとの「ターン」で全員いっせいに資源・食料の処理をする。
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
      tickSeconds: 15,                      // 1ターンの長さ
      apSeconds: 5, apMax: 5, apStart: 3,   // 行動力：5秒に1回復・上限5。拡張・強化・開墾・攻撃で1使う（防御・生産は使わない）
      defMax: 6,                            // セルの防御の上限（六角形の辺の数）
      ticks: [[4, 28], [8, 24], [12, 20]],  // ターンの回数（[この人数まで, 回数]）。部屋の設定で変えられる
      ticksRange: [10, 80],
      eventEvery: [4, 8],                   // イベントはターン4〜8回ごとに起き、4ターンのあいだ続く
      eventLength: 4,
    },
    // 人数ごとの盤面の半径（直径 = 半径×2+1）。部屋の設定で変えられる
    radius: { 2: 4, 3: 4, 4: 5, 5: 6, 6: 6, 7: 7, 8: 7, 9: 8, 10: 8, 11: 8, 12: 8 },
    radiusRange: [3, 10],               // 設定できる半径（直径 7〜21 マス）
    innerCoresFrom: 7,                  // この人数からは、コアの約3分の1を盤面の内側（中心と外周のあいだ）に置く
    // 平原：鉱山：森林（河川は別に流す）。効果のあるマスは合わせて約20%（4/20）で、2種類に均等に分ける。農地は「開墾」で作る
    terrainRatio: { plain: 16, mine: 2, forest: 2 },
    // ただし公平さのため、どのコアにも距離2（足りなければ3）のマスに2種類を1つずつ必ず置く（盤面が小さいと合計は少し増える）
    centerShare: 0.1,                   // コアの近くの2種類とは別に、少なくとも空きマスの 10% は効果のあるマスとして散らす
    centerBias: 3,                      // 散らすときの出やすさ：（半径 + 1 − 中心からの距離）の3乗に比例。真ん中ほど豊か
    islandShare: 0.6,                   // 河川で区切られても、どのコアも「盤面 ÷ 人数」の 3/5 以上の広さの島を持てるようにする
    minePower: 1,                       // 鉱山マス：拡張（攻撃で取ったときも）と強化のときに戦力トークン +1
    farmFood: 1,                        // 農地（開墾したセル）：ターンごとに食料 +1（強化の +1 とは別）
    forestResource: 1,                  // 森林マス：このセルがあるとターンごとに資源 +1（強化の +1 とは別）
    startResource: 3,
    startPower: 2,                      // 最初に戦力トークンを2個配る
    // 生産：資源で戦力トークンを作る（行動力を使わない・ログに出ない）。開墾：自分の平原のセル（コア以外）を農地にする
    cost: { expand: 1, bridge: 3, strengthen: 2, cultivate: 2, produce: 2 },
    // ターンごとの資源。強化済セル +1、コアは +2（強化済ならさらに +1）
    income: { strong: 1, core: 2, coreStrongBonus: true },
    // 食料：ターンごとに、コア +6・強化済のセル（コアも）1つにつき +1 を作り、セル1つにつき1を食べる。
    // 余りは持ち越す。足りなければ、足りない数だけ自動でセルを捨てる
    food: { start: 0, core: 6, strong: 1, perCell: 1 },
    strengthenPower: 1,                 // 強化でもらえる戦力トークン
  };

  const DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  const key = (q, r) => q + ',' + r;
  const parseKey = k => k.split(',').map(Number);
  const dist = (a, b) => (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[0] + a[1] - b[0] - b[1])) / 2;
  const neighbors = (q, r) => DIRS.map(([dq, dr]) => [q + dq, r + dr]);

  const TERRAIN_NAMES = { plain: '平原マス', mine: '鉱山マス', farm: '農地マス', forest: '森林マス', river: '河川マス' };
  // イベント（4ターンのあいだ続く）。food・res：生産の倍率（切り捨て）、riverFood：河川の隣のセル1つにつき食料（マイナスは食べる量が増える）、ap：行動力の上限
  const EVENTS = {
    famine: { name: '不作', text: '食料生産が0.5倍', food: 0.5 },
    harvest: { name: '豊作', text: '食料生産が1.5倍', food: 1.5 },
    depletion: { name: '枯渇', text: '資源生産が0.5倍', res: 0.5 },
    discovery: { name: '発見', text: '資源生産が1.5倍', res: 1.5 },
    fishing: { name: '豊漁', text: '河川の隣のセル1つにつき食料 +1', riverFood: 1 },
    flood: { name: '洪水', text: '河川の隣のセル1つにつき食料 −1', riverFood: -1 },
    festival: { name: '祭事', text: '行動力の上限 +1', ap: 1 },
    plague: { name: '疫病', text: '行動力の上限 −1', ap: -1 },
  };

  const TERRAIN_KINDS = ['mine', 'forest'];   // 盤面を作るときに置く、効果のある地形（農地は開墾で作る）

  const ACTION_NAMES = { expand: '拡張', strengthen: '強化', cultivate: '開墾', destroy: '攻撃', produce: '生産（戦力トークン）', fortify: '防御', unfortify: '防御の解除' };
  // 行動力を使う行動（ほかは使わない）
  const AP_ACTIONS = ['expand', 'strengthen', 'cultivate', 'destroy'];

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
   * opts.radius：盤面の半径、opts.rounds：ターン数（省略すると人数に合わせる）、opts.events：false でイベントなし
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
      mode: 'realtime',
      radius,
      board,
      players: order.map((p, i) => {
        const [q, r] = cores[i];
        Object.assign(board[key(q, r)], { owner: p.id, core: true });
        return { id: p.id, name: p.name, color: p.color, resource: RULES.startResource, power: RULES.startPower, food: RULES.food.start, ap: rt.apStart, alive: true, core: key(q, r) };
      }),
      rounds,
      round: 0,              // 済んだターンの数
      // セルの防御は、セルの def（数）に持つ（攻撃1回で1減る。0 のときに攻撃されると奪われる）
      tickInfo: {},          // 人ごとの、最後のターンで増えた・減った資源と食料（画面の演出用）
      attacks: [],           // 最近の攻撃（攻撃されたことを画面で知らせる）
      events: opts.events !== false,
      event: null,           // いま起きているイベント
      nextEventAt: rt.eventEvery[0] + Math.floor(rng() * (rt.eventEvery[1] - rt.eventEvery[0] + 1)),
      eventUntil: 0,
      over: false,
      winners: [],
      endReason: '',
      log: [],
      logSeq: 0,
    };
    addLog(state, `ゲーム開始。${rt.tickSeconds}秒ごとのターンを ${rounds} 回。行動力は${rt.apSeconds}秒に1回復（上限${rt.apMax}）`, 'info');
    return state;
  }

  // 人数に合わせたターン数
  function autoTicks(count) {
    const row = RULES.rt.ticks.find(([n]) => count <= n) || RULES.rt.ticks[RULES.rt.ticks.length - 1];
    return row[1];
  }

  const eventOf = state => (state.event ? EVENTS[state.event] : null);

  // 行動力の上限（祭事・疫病で増減）
  function apMax(state) {
    const ev = eventOf(state);
    return RULES.rt.apMax + ((ev && ev.ap) || 0);
  }

  // 行動力の回復（部屋が5秒ごとに呼ぶ）
  function rtRegen(state) {
    if (state.over) return;
    const max = apMax(state);
    for (const p of state.players) if (p.alive) p.ap = Math.min(max, (p.ap || 0) + 1);
  }

  // ターンの終わり（部屋が15秒ごとに呼ぶ）：全員いっせいに資源をもらい、食料を作って食べる。足りなければ自動でセルを捨てる
  function rtTick(state, rng) {
    if (state.over) return;
    rng = rng || Math.random;
    state.round++;
    addLog(state, `ターン ${state.round} / ${state.rounds}`, 'round');
    const seq = state.logSeq;
    for (const p of state.players) {
      if (!p.alive) continue;
      const n = income(state, p.id);
      const resBefore = p.resource, foodBefore = p.food || 0;
      p.resource += n;
      const made = foodMade(state, p.id), eaten = foodEaten(state, p.id);
      p.food = foodBefore + made - eaten;
      const hungry = Math.max(0, -p.food);
      p.food = Math.max(0, p.food);
      state.tickInfo[p.id] = { seq, player: p.id, resBefore, resource: n, foodBefore, made, eaten, hungry };
      const keys = suggestAbandon(state, p.id, hungry);
      if (keys.length) {
        for (const k of keys) Object.assign(state.board[k], { owner: null, strong: false, core: false, def: 0 });
        addLog(state, `${p.name} は食料が ${hungry} 足りないため、セル ${keys.map(k => cellLabel(state.board[k])).join(' ')} を捨てた`, 'abandon');
      }
    }
    if (state.round >= state.rounds) { finishByGroup(state); return; }
    // イベント：ターン4〜8回ごとに起き、4ターンのあいだ続く
    const rt = RULES.rt;
    if (state.event && state.round >= state.eventUntil) {
      addLog(state, `イベント「${EVENTS[state.event].name}」が終わった`, 'event');
      state.event = null;
    }
    if (state.events && !state.event && state.round >= state.nextEventAt) {
      const keys = Object.keys(EVENTS);
      state.event = keys[Math.floor(rng() * keys.length)];
      state.eventUntil = state.round + rt.eventLength;
      state.nextEventAt = state.eventUntil + rt.eventEvery[0] + Math.floor(rng() * (rt.eventEvery[1] - rt.eventEvery[0] + 1));
      addLog(state, `イベント：${EVENTS[state.event].name}（${rt.eventLength}ターンのあいだ、${EVENTS[state.event].text}）`, 'event');
    }
    // 疫病のあいだは、上限を超えた行動力を減らす
    const max = apMax(state);
    for (const p of state.players) if (p.ap > max) p.ap = max;
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

  // 河川の隣にある自分のセルの数（橋は除く。豊漁・洪水で使う）
  function riversideCells(state, id) {
    return cellsOf(state, id).filter(c => c.terrain !== 'river' && neighbors(c.q, c.r).some(([q, r]) => { const n = state.board[key(q, r)]; return n && n.terrain === 'river'; })).length;
  }

  // ターンごとに受け取る資源
  function income(state, id) {
    const ev = eventOf(state);
    const inc = RULES.income;
    let n = 0;
    for (const c of cellsOf(state, id)) {
      if (c.core) n += inc.core + (c.strong && inc.coreStrongBonus ? inc.strong : 0);
      else if (c.strong) n += inc.strong;
      if (c.terrain === 'forest') n += RULES.forestResource;   // 森林は強化とは別に +1
    }
    return Math.floor(n * ((ev && ev.res) || 1));
  }

  // ターンごとに作る食料：コア +6、強化済のセル（コアも）1つにつき +1、農地のセル1つにつき +1
  function foodMade(state, id) {
    const f = RULES.food;
    const ev = eventOf(state);
    let n = cellsOf(state, id).reduce((k, c) => k + (c.core ? f.core : 0) + (c.strong ? f.strong : 0) + (c.terrain === 'farm' ? RULES.farmFood : 0), 0);
    if (ev && ev.riverFood > 0) n += riversideCells(state, id) * ev.riverFood;   // 豊漁
    return Math.floor(n * ((ev && ev.food) || 1));                               // 不作・豊作
  }

  // ターンごとに食べる食料：セル1つにつき1（洪水のときは河川の隣のセル1つにつきさらに1）
  function foodEaten(state, id) {
    const ev = eventOf(state);
    const flood = ev && ev.riverFood < 0 ? riversideCells(state, id) * -ev.riverFood : 0;
    return cellsOf(state, id).length * RULES.food.perCell + flood;
  }

  function expandCost(cell) {
    if (cell.terrain === 'river') return RULES.cost.bridge;   // 河川には橋をかける
    return RULES.cost.expand;
  }

  // 今その行動ができるか（マスの指定がいらない判定）。できなければ理由を返す
  function actionBlocked(state, id, type) {
    if (state.over) return 'ゲームは終わっています';
    const p = playerById(state, id);
    if (!p || !p.alive) return '脱落しています';
    if (!(type in ACTION_NAMES)) return '不明な行動です';
    if (type === 'unfortify') return '';
    if (AP_ACTIONS.includes(type) && (p.ap || 0) < 1) return `行動力が足りません（${RULES.rt.apSeconds}秒に1回復）`;
    if (type === 'fortify' || type === 'destroy') return p.power < 1 ? '戦力トークンが1個以上必要です' : '';
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
      } else if (type === 'cultivate') {
        if (c.owner === id && !c.core && c.terrain === 'plain') out.push(k);
      } else if (type === 'destroy') {
        if (c.owner && c.owner !== id && adjacentToOwn(state, id, c.q, c.r)) out.push(k);
      } else if (type === 'fortify') {
        if (c.owner === id && (c.def || 0) < RULES.rt.defMax) out.push(k);
      } else if (type === 'unfortify') {
        if (c.owner === id && c.def > 0) out.push(k);
      }
    }
    return out;
  }

  function fail(error) { return { ok: false, error }; }

  /*
   * 行動を実行する。state は書き換わる。
   * action: { type: 'expand'|'strengthen'|'cultivate'|'destroy'|'fortify'|'unfortify', q, r } / { type: 'produce' }
   */
  function apply(state, id, action) {
    if (!action || typeof action.type !== 'string') return fail('不明な行動です');
    const blocked = actionBlocked(state, id, action.type);
    if (blocked) return fail(blocked);
    const p = playerById(state, id);
    // 生産：資源で戦力トークンを作る。行動力を使わず、ログにも出さない
    if (action.type === 'produce') {
      p.resource -= RULES.cost.produce;
      p.power += 1;
      return { ok: true };
    }
    const k = key(Number(action.q), Number(action.r));
    const cell = state.board[k];
    if (!cell) return fail('盤面の外です');
    // 防御：自分のセルに戦力トークンを1個つぎ込むと、そのセルの防御が1増える（上限6）。
    // 解除すると、つぎ込んだ戦力トークンが全部戻る。防御の数はほかの人には見せないので、ログにも出さない
    if (action.type === 'fortify' || action.type === 'unfortify') {
      if (cell.owner !== id) return fail('自分のセルを選んでください');
      if (action.type === 'unfortify') {
        if (!cell.def) return fail('このセルに防御はありません');
        p.power += cell.def;
        cell.def = 0;
        return { ok: true };
      }
      if ((cell.def || 0) >= RULES.rt.defMax) return fail(`防御は ${RULES.rt.defMax} までです`);
      cell.def = (cell.def || 0) + 1;
      p.power -= 1;
      return { ok: true };
    }
    if (!targets(state, id, action.type).includes(k)) return fail('そのマスには' + ACTION_NAMES[action.type] + 'できません');
    p.ap--;
    if (action.type === 'expand') {
      const cost = expandCost(cell);
      p.resource -= cost;
      Object.assign(cell, { owner: id, strong: false, core: false, def: 0 });
      let extra = terrainGain(p, cell);
      if (extra) extra = `（${extra}）`;
      if (cell.terrain === 'river') addLog(state, `${p.name} が河川マス${cellLabel(cell)}に橋をかけた（資源 ${cost}）`, 'expand');
      else addLog(state, `${p.name} が${TERRAIN_NAMES[cell.terrain]}${cellLabel(cell)}に拡張${extra}`, 'expand');
    } else if (action.type === 'cultivate') {
      p.resource -= RULES.cost.cultivate;
      cell.terrain = 'farm';
      addLog(state, `${p.name} がセル${cellLabel(cell)}を開墾して農地に（ターンごとに食料 +${RULES.farmFood}）`, 'strengthen');
    } else if (action.type === 'strengthen') {
      p.resource -= RULES.cost.strengthen;
      cell.strong = true;
      p.power += RULES.strengthenPower;
      let extra = `戦力トークン +${RULES.strengthenPower}`;
      const tg = terrainGain(p, cell);
      if (tg) extra += `・${tg}`;
      addLog(state, `${p.name} が${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}を強化（${extra}）`, 'strengthen');
    } else if (action.type === 'destroy') {
      // 攻撃：行動力1と戦力トークン1個ですぐ決まる。セルに防御があれば防御が1減るだけ。防御が0のときに攻撃すると、そのセルを奪う
      const def = playerById(state, cell.owner);
      p.power -= 1;
      const took = !(cell.def > 0);
      // 攻撃されたことを画面で知らせるための記録（新しいものだけ残す）
      state.attacks = (state.attacks || []).concat({ seq: state.logSeq + 1, by: id, victim: def.id, key: k, took }).slice(-20);
      if (!took) {
        cell.def--;
        addLog(state, `${p.name} が ${def.name} の${cell.core ? 'コア' : 'セル'}${cellLabel(cell)}を攻撃（防御を削った）`, 'destroy');
      } else {
        takeCell(state, p, def, cell);
      }
    }
    return { ok: true };
  }

  // 攻撃の成功：マスを奪う（橋なら河川に戻す）。コアなら d は脱落し、a がすべてを奪う
  function takeCell(state, a, d, cell) {
    const what = cell.core ? 'コア' : 'セル';
    const wasCore = cell.core;
    Object.assign(cell, { owner: null, strong: false, core: false, def: 0 });
    if (cell.terrain === 'river') {
      // 橋は奪われると落ちて、河川に戻る（攻撃側のセルにはならない）
      addLog(state, `攻撃成功：${a.name} が ${d.name} の橋${cellLabel(cell)}を落とした（河川に戻る）`, 'destroy');
      return;
    }
    addLog(state, `攻撃成功：${a.name} が ${d.name} の${what}${cellLabel(cell)}を奪った`, 'destroy');
    if (wasCore) eliminate(state, d, a);   // コアを奪った人が、相手のセルとトークンをまるごと奪う
    // 奪ったマスはそのまま攻撃側のセル（未強化）になる。鉱山マスなら拡張と同じく戦力トークン +1
    Object.assign(cell, { owner: a.id, strong: false, core: false });
    let extra = terrainGain(a, cell);
    if (extra) extra = `（${extra}）`;
    addLog(state, `${a.name} が${TERRAIN_NAMES[cell.terrain]}${cellLabel(cell)}にそのまま拡張${extra}`, 'expand');
  }

  // 鉱山マスを拡張・強化したとき（攻撃で取ったときも）にもらえる戦力トークン。ログ用の文を返す
  function terrainGain(p, cell) {
    if (cell.terrain !== 'mine') return '';
    p.power += RULES.minePower;
    return `鉱山：戦力トークン +${RULES.minePower}`;
  }

  // 脱落。heir（コアを奪った人）がいれば、セル（強化済・防御はそのまま）・資源・戦力・食料をまるごと受け継ぐ。
  // いなければ（切断などで脱落させたとき）、セルは空きマスに戻り、トークンもなくなる
  function eliminate(state, p, heir) {
    p.alive = false;
    const cells = cellsOf(state, p.id);
    for (const c of cells) Object.assign(c, heir ? { owner: heir.id, core: false } : { owner: null, strong: false, core: false, def: 0 });
    if (heir) {
      heir.resource += p.resource;
      heir.power += p.power;
      heir.food = (heir.food || 0) + (p.food || 0);
    }
    p.resource = 0; p.power = 0; p.food = 0; p.ap = 0;
    addLog(state, heir
      ? `💀 ${p.name} のコアが奪われ、脱落。セル ${cells.length} 個とトークンはすべて ${heir.name} のものに`
      : `💀 ${p.name} が脱落`, 'out');
    const alive = state.players.filter(x => x.alive);
    if (alive.length === 1) finish(state, alive, `${alive[0].name} 以外の全員が脱落`);
  }

  function finish(state, winners, reason) {
    state.over = true;
    state.event = null;
    state.winners = winners.map(p => p.id);
    state.endReason = reason;
    addLog(state, `🏆 ${winners.map(p => p.name).join('・')} の${winners.length > 1 ? '同率優勝' : '勝利'}（${reason}）`, 'win');
  }

  // 食料が足りないときに捨てるセル：一番大きなかたまりから外れたもの、未強化、コアから遠いものから（コアは捨てない）
  function suggestAbandon(state, id, count) {
    if (!(count > 0)) return [];
    const p = playerById(state, id);
    const core = parseKey(p.core);
    const group = new Set(largestGroup(state, id));
    return cellsOf(state, id).filter(c => !c.core)
      .map(c => ({ k: key(c.q, c.r), s: (group.has(key(c.q, c.r)) ? 0 : 1000) + (c.strong ? 0 : 100) + dist([c.q, c.r], core) }))
      .sort((x, y) => y.s - x.s)
      .slice(0, count)
      .map(x => x.k);
  }

  // 最後のターンが終わったら：つながっている一番大きなかたまりが大きい人の勝利
  function finishByGroup(state) {
    state.round = state.rounds;
    const alive = state.players.filter(p => p.alive);
    const sizes = alive.map(p => largestGroup(state, p.id).length);
    const best = Math.max(...sizes);
    finish(state, alive.filter((p, i) => sizes[i] === best), `${state.rounds}ターン終了・最大のかたまり ${best} セル`);
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

  // 脱落させる（切断したまま戻らないときなどに使う）
  function forfeit(state, id) {
    const p = playerById(state, id);
    if (!p || !p.alive || state.over) return;
    eliminate(state, p);
  }

  return {
    RULES, DIRS, TERRAIN_NAMES, TERRAIN_KINDS, ACTION_NAMES, EVENTS, AP_ACTIONS,
    key, parseKey, dist, neighbors, ring, corePositions, generateBoard,
    createGame, apply, targets, actionBlocked, income, expandCost, cellsOf, forfeit,
    autoTicks, rtTick, rtRegen, apMax, largestGroup, suggestAbandon, foodMade, foodEaten, riversideCells,
  };
});
