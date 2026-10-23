/* 豆鉄砲 (gunlet) — UI */
(function () {
  'use strict';

  const G = window.Gunlet;
  const AI = window.GunletAI;
  const { N } = G;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const VIEW = 800, MARGIN = 76, STEP = (VIEW - MARGIN * 2) / (N - 1);
  const PLAYER_NAME = ['先手', '後手'];

  const $ = (id) => document.getElementById(id);
  const boardEl = $('board');

  const app = {
    state: G.initialState(),
    history: [],
    log: [],
    mode: 'pvp',        // pvp | cpu0 | cpu1  (cpuN: CPU plays player N)
    selected: null,     // index of selected piece
    placing: null,      // 'wall' | 'tower'
    last: null,         // last event
    thinking: false,
  };

  /* ---------- geometry ---------- */

  const flipped = () => app.mode === 'cpu0';
  function pos(i) {
    let [x, y] = G.xy(i);
    if (flipped()) { x = N - 1 - x; y = N - 1 - y; }
    return [MARGIN + x * STEP, MARGIN + (N - 1 - y) * STEP];
  }

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  /* ---------- glyphs ---------- */

  // Draws a piece shape centered at (0,0) into group g.
  function drawGlyph(g, type, owner, opts = {}) {
    const cls = owner === 0 ? 'pc p0' : 'pc p1';
    const up = opts.up !== undefined ? opts.up : true;
    switch (type) {
      case 'general':
        el('circle', { r: 25, class: cls }, g);
        el('circle', { r: 9, class: 'pc-mark ' + (owner === 0 ? 'm0' : 'm1') }, g);
        break;
      case 'archer': {
        const d = up ? 'M0,-25 L23,17 L-23,17 Z' : 'M0,25 L23,-17 L-23,-17 Z';
        el('path', { d, class: cls, 'stroke-linejoin': 'round' }, g);
        break;
      }
      case 'gunner':
        el('rect', { x: -20, y: -20, width: 40, height: 40, rx: 3, class: cls }, g);
        if (opts.unloaded) el('rect', { x: -7, y: -7, width: 14, height: 14, class: 'pc-hole ' + (owner === 0 ? 'm0' : 'm1') }, g);
        break;
      case 'shield':
        el('rect', { x: -28, y: -13, width: 56, height: 26, rx: 13, class: cls }, g);
        break;
    }
  }

  function drawHp(g, p) {
    const max = G.TYPES[p.type].hp;
    if (max < 2) return;
    for (let k = 0; k < max; k++) {
      el('circle', {
        cx: (k - (max - 1) / 2) * 12, cy: 38, r: 3.6,
        class: k < p.hp ? 'pip on' : 'pip off',
      }, g);
    }
  }

  /* ---------- board rendering ---------- */

  function renderBoard() {
    const s = app.state;
    boardEl.textContent = '';

    // grid
    const grid = el('g', { class: 'grid' }, boardEl);
    const lo = MARGIN, hi = VIEW - MARGIN;
    for (let k = 0; k < N; k++) {
      const v = MARGIN + k * STEP;
      el('line', { x1: lo, y1: v, x2: hi, y2: v, class: 'ln' }, grid);
      el('line', { x1: v, y1: lo, x2: v, y2: hi, class: 'ln' }, grid);
    }
    for (let k = 1; k < 2 * N - 2; k++) {
      // x - y = const  and  x + y = const diagonals
      const a = Math.max(0, k - (N - 1)), b = Math.min(k, N - 1);
      el('line', {
        x1: MARGIN + a * STEP, y1: MARGIN + (k - a) * STEP,
        x2: MARGIN + b * STEP, y2: MARGIN + (k - b) * STEP, class: 'ln diag',
      }, grid);
      el('line', {
        x1: hi - a * STEP, y1: MARGIN + (k - a) * STEP,
        x2: hi - b * STEP, y2: MARGIN + (k - b) * STEP, class: 'ln diag',
      }, grid);
    }

    // coordinates
    const coords = el('g', { class: 'coords' }, boardEl);
    for (let k = 0; k < N; k++) {
      const [cx] = pos(G.idx(k, 0));
      const [, cy] = pos(G.idx(0, k));
      el('text', { x: cx, y: VIEW - 22, 'text-anchor': 'middle' }, coords).textContent = 'abcdefg'[k];
      el('text', { x: 26, y: cy + 5, 'text-anchor': 'middle' }, coords).textContent = String(k + 1);
    }

    // last move trace
    if (app.last && app.last.action.type === 'move') {
      const [x1, y1] = pos(app.last.action.from), [x2, y2] = pos(app.last.action.to);
      el('line', { x1, y1, x2, y2, class: 'trace' }, boardEl);
      el('circle', { cx: x1, cy: y1, r: 5, class: 'trace-dot' }, boardEl);
    }

    // terrain
    const terr = el('g', {}, boardEl);
    s.cells.forEach((c, i) => {
      if (!c.terrain) return;
      const [x, y] = pos(i);
      const g = el('g', { transform: `translate(${x},${y})` }, terr);
      if (c.terrain.kind === 'tower') {
        el('circle', { r: 40, class: 'tower' }, g);
        el('circle', { r: 33, class: 'tower-in' }, g);
      } else {
        el('rect', { x: -30, y: -30, width: 60, height: 60, rx: 4, class: 'wall' }, g);
        if (c.terrain.hp < 2) el('path', { d: 'M-30,-8 L-6,-2 L4,10 L30,14', class: 'crack' }, g);
      }
    });

    // pieces
    const pcs = el('g', {}, boardEl);
    s.cells.forEach((c, i) => {
      const p = c.piece;
      if (!p) return;
      const [x, y] = pos(i);
      const g = el('g', { transform: `translate(${x},${y})`, class: 'piece' }, pcs);
      if (i === app.selected) el('circle', { r: 44, class: 'sel' }, g);
      const up = (p.owner === 0) !== flipped();
      drawGlyph(g, p.type, p.owner, { up, unloaded: p.type === 'gunner' && !p.loaded });
      drawHp(g, p);
      const t = el('title', {}, g);
      t.textContent = `${PLAYER_NAME[p.owner]} ${G.TYPES[p.type].name} ${G.label(i)}`
        + (p.type === 'gunner' ? (p.loaded ? '（装填済）' : '（未装填）') : '')
        + (G.TYPES[p.type].hp > 1 ? ` 耐久${p.hp}` : '');
    });

    // hints
    const hints = el('g', {}, boardEl);
    for (const h of currentHints()) {
      const [x, y] = pos(h.at);
      if (h.kind === 'move') el('circle', { cx: x, cy: y, r: 7, class: 'h-move' }, hints);
      else if (h.kind === 'place') el('circle', { cx: x, cy: y, r: 9, class: 'h-place' }, hints);
      else el('circle', { cx: x, cy: y, r: 42, class: 'h-hit' }, hints);
    }

    // shot effect for the last attack
    if (app.last && app.last.fresh && (app.last.action.type === 'shoot' || app.last.action.type === 'melee')) {
      drawShot(app.last);
      app.last.fresh = false;
    }

    // hit areas
    const hit = el('g', { class: 'hits' }, boardEl);
    for (let i = 0; i < N * N; i++) {
      const [x, y] = pos(i);
      const r = el('rect', { x: x - STEP / 2, y: y - STEP / 2, width: STEP, height: STEP, class: 'hit' }, hit);
      r.addEventListener('click', () => onCell(i));
    }
  }

  function drawShot(ev) {
    const a = ev.action;
    const [x1, y1] = pos(a.from), [x2, y2] = pos(a.to);
    const fx = el('g', { class: 'fx' }, boardEl);
    if (ev.shooterType === 'archer') {
      // 山なりの弧
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
      let px = -dy / len, py = dx / len;
      if (py > 0 || (py === 0 && px < 0)) { px = -px; py = -py; } // 画面上側へ膨らませる
      const lift = len * 0.35;
      const cx = mx + px * lift, cy = my + py * lift;
      el('path', { d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`, class: 'shot arc' }, fx);
    } else if (ev.shooterType === 'gunner') {
      el('line', { x1, y1, x2, y2, class: 'shot' }, fx);
    }
    el('circle', { cx: x2, cy: y2, r: 30, class: 'burst' }, fx);
  }

  function currentHints() {
    const s = app.state;
    if (s.winner !== null || app.thinking || isCpuTurn()) return [];
    if (app.placing) return G.placeTargets(s).map((at) => ({ at, kind: 'place' }));
    if (app.selected === null) return [];
    return G.pieceActions(s, app.selected)
      .filter((a) => a.type !== 'reload')
      .map((a) => ({ at: a.to, kind: a.type === 'move' ? 'move' : 'hit' }));
  }

  /* ---------- side panels ---------- */

  function renderSides() {
    const s = app.state;
    const topPlayer = flipped() ? 0 : 1;
    const panels = { [topPlayer]: $('side-1'), [1 - topPlayer]: $('side-0') };
    for (const pl of [0, 1]) {
      const box = panels[pl];
      box.textContent = '';
      box.classList.toggle('active', s.turn === pl && s.winner === null);

      const who = document.createElement('div');
      who.className = 'who';
      const sw = document.createElementNS(SVG_NS, 'svg');
      sw.setAttribute('viewBox', '-14 -14 28 28');
      sw.setAttribute('class', 'swatch');
      el('circle', { r: 10, class: pl === 0 ? 'pc p0' : 'pc p1' }, sw);
      who.appendChild(sw);
      const nm = document.createElement('span');
      nm.textContent = PLAYER_NAME[pl] + (isCpu(pl) ? ' · CPU' : '');
      who.appendChild(nm);
      box.appendChild(who);

      const gi = G.findGeneral(s, pl);
      const gen = document.createElement('div');
      gen.className = 'gen';
      const hp = gi >= 0 ? s.cells[gi].piece.hp : 0;
      gen.innerHTML = `<span class="k">将</span><span class="hpbar">${'<i class="on"></i>'.repeat(hp)}${'<i></i>'.repeat(2 - hp)}</span>`;
      box.appendChild(gen);

      const res = document.createElement('div');
      res.className = 'reserve';
      for (const kind of ['wall', 'tower']) {
        const n = s.reserve[pl][kind];
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'res' + (app.placing === kind && s.turn === pl ? ' on' : '');
        b.disabled = n === 0 || s.turn !== pl || s.winner !== null || isCpu(pl) || app.thinking;
        b.title = (kind === 'wall' ? '壁' : '塔') + 'を置く';
        const ic = document.createElementNS(SVG_NS, 'svg');
        ic.setAttribute('viewBox', '-22 -22 44 44');
        if (kind === 'wall') el('rect', { x: -15, y: -15, width: 30, height: 30, rx: 2, class: 'wall' }, ic);
        else { el('circle', { r: 17, class: 'tower' }, ic); el('circle', { r: 13, class: 'tower-in' }, ic); }
        b.appendChild(ic);
        const t = document.createElement('span');
        t.textContent = `${kind === 'wall' ? '壁' : '塔'} ${n}`;
        b.appendChild(t);
        b.addEventListener('click', () => onReserve(kind));
        res.appendChild(b);
      }
      box.appendChild(res);
    }
  }

  /* ---------- status / actions / log ---------- */

  function renderStatus() {
    const s = app.state;
    const st = $('status');
    const acts = $('actions');
    acts.textContent = '';

    if (s.winner === 'draw') st.textContent = '引き分け';
    else if (s.winner !== null) st.textContent = `${PLAYER_NAME[s.winner]}の勝ち`;
    else if (app.thinking) st.textContent = `${PLAYER_NAME[s.turn]}（CPU）思考中…`;
    else if (app.placing) st.textContent = `${app.placing === 'wall' ? '壁' : '塔'}を置く点を選択`;
    else if (app.selected !== null) {
      const p = s.cells[app.selected].piece;
      st.textContent = `${G.TYPES[p.type].name} ${G.label(app.selected)}`
        + (p.type === 'gunner' ? (p.loaded ? ' · 装填済' : ' · 未装填') : '');
    } else st.textContent = `${PLAYER_NAME[s.turn]}の番 · ${s.ply + 1}手目`;
    st.classList.toggle('end', s.winner !== null);

    if (s.winner !== null) {
      acts.appendChild(button('もう一局', restart, 'primary'));
      return;
    }
    if (app.selected !== null) {
      const p = s.cells[app.selected].piece;
      if (p.type === 'gunner' && !p.loaded) {
        acts.appendChild(button('装填', () => commit({ type: 'reload', from: app.selected }), 'primary'));
      }
    }
    if (app.selected !== null || app.placing) acts.appendChild(button('取消', clearSel));
  }

  function button(text, fn, cls) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    if (cls) b.className = cls;
    b.addEventListener('click', fn);
    return b;
  }

  function renderLog() {
    const ol = $('log');
    ol.textContent = '';
    app.log.forEach((t, k) => {
      const li = document.createElement('li');
      li.className = k % 2 === 0 ? 'l0' : 'l1';
      li.innerHTML = `<span class="n">${k + 1}</span>${t}`;
      ol.appendChild(li);
    });
    ol.scrollLeft = ol.scrollWidth;
  }

  function render() {
    renderBoard();
    renderSides();
    renderStatus();
    renderLog();
    $('undo').disabled = app.history.length === 0 || app.thinking;
  }

  /* ---------- interaction ---------- */

  const isCpu = (pl) => (app.mode === 'cpu0' && pl === 0) || (app.mode === 'cpu1' && pl === 1);
  const isCpuTurn = () => app.state.winner === null && isCpu(app.state.turn);

  function clearSel() {
    app.selected = null;
    app.placing = null;
    render();
  }

  function onReserve(kind) {
    if (isCpuTurn() || app.thinking) return;
    app.selected = null;
    app.placing = app.placing === kind ? null : kind;
    render();
  }

  function onCell(i) {
    const s = app.state;
    if (s.winner !== null || app.thinking || isCpuTurn()) return;

    if (app.placing) {
      if (G.placeTargets(s).includes(i)) commit({ type: 'place', kind: app.placing, at: i });
      else { app.placing = null; render(); }
      return;
    }

    if (app.selected !== null) {
      const a = G.pieceActions(s, app.selected).find((x) => x.to === i);
      if (a) { commit(a); return; }
      if (i === app.selected) { clearSel(); return; }
    }

    const p = s.cells[i].piece;
    app.selected = p && p.owner === s.turn ? i : null;
    render();
  }

  function commit(a) {
    const s = app.state;
    const shooter = a.from !== undefined ? s.cells[a.from].piece : null;
    const text = G.notation(s, a);
    const { state, event } = G.apply(s, a);
    app.history.push({ state: s, log: app.log.slice(), last: app.last });
    app.state = state;
    app.log.push(text);
    event.fresh = true;
    event.shooterType = shooter ? shooter.type : null;
    app.last = event;
    app.selected = null;
    app.placing = null;
    render();
    maybeCpu();
  }

  function maybeCpu() {
    if (!isCpuTurn()) return;
    app.thinking = true;
    render();
    setTimeout(() => {
      const a = AI.chooseAction(app.state);
      app.thinking = false;
      if (a) commit(a); else render();
    }, 420);
  }

  function undo() {
    if (app.thinking || app.history.length === 0) return;
    let h = app.history.pop();
    // CPU戦では自分の手番まで戻す
    while (isCpu(h.state.turn) && app.history.length > 0) h = app.history.pop();
    app.state = h.state;
    app.log = h.log;
    app.last = h.last ? { ...h.last, fresh: false } : null;
    app.selected = null;
    app.placing = null;
    render();
    maybeCpu();
  }

  function restart() {
    app.state = G.initialState();
    app.history = [];
    app.log = [];
    app.last = null;
    app.selected = null;
    app.placing = null;
    app.thinking = false;
    render();
    maybeCpu();
  }

  /* ---------- wiring ---------- */

  // rule dialog glyphs
  document.querySelectorAll('svg.glyph').forEach((svg) => {
    const g = el('g', { transform: 'scale(0.7)' }, svg);
    drawGlyph(g, svg.dataset.type, 0);
  });

  $('restart').addEventListener('click', restart);
  $('undo').addEventListener('click', undo);
  $('rules-btn').addEventListener('click', () => $('rules').showModal());
  $('mode').addEventListener('change', (e) => {
    app.mode = e.target.value;
    restart();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') clearSel();
  });

  render();
})();
