/* ───────── 렌더 ───────── */
const NS = 'http://www.w3.org/2000/svg';
const RH = 18, HH = 26, GH = 18, PAD = 6;
const F_MONO = '11px "IBM Plex Mono", ui-monospace, monospace';
const F_NAME = '600 12px "IBM Plex Mono", ui-monospace, monospace';
const F_NOTE = '10px "IBM Plex Sans KR", "Malgun Gothic", system-ui, sans-serif';
const F_GRAIN = '10.5px "IBM Plex Sans KR", "Malgun Gothic", system-ui, sans-serif';
const cv = document.createElement('canvas').getContext('2d');
function tw(s, f) { cv.font = f; return cv.measureText(s).width; }
function fit(s, f, max) { if (max <= 8) return ''; if (tw(s, f) <= max) return s; let t = s; while (t.length > 1 && tw(t + '…', f) > max) t = t.slice(0, -1); return t + '…'; }
function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function stext(parent, x, y, cls, s, anchor) { const t = el('text', { x, y, class: cls }, parent); if (anchor) t.setAttribute('text-anchor', anchor); t.textContent = s; return t; }
function boxH(t) { return HH + GH + t.cols.length * RH + PAD; }
const PREFIX = { gold: 'gold.' };
function fullName(id) { const t = T[id]; if (!t) return id; const o = t.ghostOf ? T[t.ghostOf] : t; return (PREFIX[o.s] || '') + o.name; }
function refName(ref) { return T[ref] ? fullName(ref) : ref; }
function resolveIn(view, target) { if (view.pos[target]) return target; for (const id in view.pos) if (T[id].ghostOf === target) return id; return null; }
function pkCount(t) { return t.cols.filter(c => c[1] === 'PK' || c[1] === 'PF').length; }

const state = { view: null, sel: null };
const svg = document.getElementById('erd-svg');

function renderView(view) {
  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
  svg.style.minWidth = Math.round(view.w * 0.8) + 'px';
  svg.setAttribute('aria-label', `${view.label} ERD: ${Object.keys(view.pos).map(id => T[id].name).join(', ')}`);
  const gE = el('g', { class: 'edges' }, svg), gT = el('g', { class: 'tables' }, svg);
  const geo = {};
  for (const id in view.pos) { const [x, y, w] = view.pos[id]; geo[id] = { x, y, w, h: boxH(T[id]) }; }
  const lanes = {};
  const laneC = k => { lanes[k] = (lanes[k] || 0) + 1; const n = lanes[k] - 1; return n === 0 ? 0 : (n % 2 ? (n + 1) / 2 : -n / 2); };
  const laneL = k => { lanes[k] = (lanes[k] || 0) + 1; return lanes[k] - 1; };
  function route(a, b, loopSide) {
    if (a.x + a.w <= b.x) { const sx = a.x + a.w, tx = b.x, m = (sx + tx) / 2; return { sx, tx, cx: m + 8 * laneC('c' + Math.round(m)), ds: 1, dt: -1 }; }
    if (b.x + b.w <= a.x) { const sx = a.x, tx = b.x + b.w, m = (sx + tx) / 2; return { sx, tx, cx: m + 8 * laneC('c' + Math.round(m)), ds: -1, dt: 1 }; }
    if ((loopSide || 'R') === 'R') { const sx = a.x + a.w, tx = b.x + b.w, base = Math.max(sx, tx); return { sx, tx, cx: base + 14 + 8 * laneL('R' + base), ds: 1, dt: 1 }; }
    const sx = a.x, tx = b.x, base = Math.min(sx, tx); return { sx, tx, cx: base - 14 - 8 * laneL('L' + base), ds: -1, dt: -1 };
  }

  // 관계선
  const edges = [], seen = new Set(), drawn = new Set();
  for (const id in view.pos) {
    T[id].cols.forEach((c, i) => {
      const ref = c[3]; if (!ref) return;
      const tg = resolveIn(view, ref); if (!tg || tg === id) return;
      const k = id + '>' + tg; if ((view.skip || []).includes(k)) return;
      drawn.add(id + '#' + i);
      if (seen.has(k)) return; seen.add(k);
      edges.push({ s: id, t: tg, r: i, one: c[1] === 'PF' && pkCount(T[id]) === 1 });
    });
  }
  for (const e of edges) {
    const a = geo[e.s], b = geo[e.t], tt = T[e.t];
    const sy = a.y + HH + GH + e.r * RH + RH / 2;
    const tr = tt.cols.findIndex(c => c[1] === 'PK' || c[1] === 'PF');
    const ty = (tt.s === 'key' || tr < 0) ? b.y + HH / 2 : b.y + HH + GH + tr * RH + RH / 2;
    const { sx, tx, cx, ds, dt } = route(a, b, (view.loop || {})[e.s + '>' + e.t]);
    const g = el('g', { class: 'edge', 'data-s': e.s, 'data-t': e.t }, gE);
    el('path', { d: `M${sx},${sy} H${cx} V${ty} H${tx}` }, g);
    if (e.one) el('path', { d: `M${sx + 6 * ds},${sy - 5} V${sy + 5} M${sx + 10 * ds},${sy - 5} V${sy + 5}` }, g);
    else el('path', { d: `M${sx},${sy - 5} L${sx + 10 * ds},${sy} M${sx},${sy + 5} L${sx + 10 * ds},${sy} M${sx + 13 * ds},${sy - 5} V${sy + 5}` }, g);
    el('path', { d: `M${tx + 6 * dt},${ty - 5} V${ty + 5} M${tx + 10 * dt},${ty - 5} V${ty + 5}` }, g);
  }
  // 파생(같은 build 에서 합계)
  const inCount = {};
  (view.derive || []).forEach(([s, t, lbl]) => {
    const a = geo[s], b = geo[t];
    const g = el('g', { class: 'edge derive', 'data-s': s, 'data-t': t }, gE);
    if (a.x < b.x + b.w && b.x < a.x + a.w) {
      const x = a.x + a.w / 2;
      el('path', { class: 'ln', d: `M${x},${a.y + a.h} V${b.y - 2}` }, g);
      el('path', { class: 'head', d: `M${x - 5},${b.y - 9} L${x},${b.y - 1} L${x + 5},${b.y - 9} Z` }, g);
      stext(g, x + 10, (a.y + a.h + b.y) / 2 + 4, 'e-lbl', lbl);
      return;
    }
    const k = inCount[t] = (inCount[t] || 0) + 1;
    const sy = a.y + Math.min(a.h / 2, 40), ty = b.y + 9 + 10 * (k - 1);
    const { sx, tx, cx, dt } = route(a, b);
    const tip = tx + 2 * dt;
    el('path', { class: 'ln', d: `M${sx},${sy} H${cx} V${ty} H${tip + 7 * dt}` }, g);
    el('path', { class: 'head', d: `M${tip + 8 * dt},${ty - 4.5} L${tip},${ty} L${tip + 8 * dt},${ty + 4.5} Z` }, g);
    stext(g, (sx + cx) / 2, sy - 5, 'e-lbl', lbl, 'middle');
  });

  // 테이블
  for (const id in view.pos) {
    const t = T[id], { x, y, w, h } = geo[id];
    const kind = t.s;
    const g = el('g', { class: 'tbl v-' + kind, 'data-id': id, tabindex: '0', role: 'button' }, gT);
    g.setAttribute('aria-label', (t.ghostOf ? '다른 탭으로 이동: ' : '') + fullName(id));
    el('rect', { x, y, width: w, height: h, rx: 5, class: 'box' }, g);
    const hc = { gold: 'hdr-gold', key: 'hdr-key', ghost: 'hdr-ghost' }[kind];
    el('path', { class: hc, d: `M${x + 0.5},${y + 5} a4.5,4.5 0 0 1 4.5,-4.5 H${x + w - 5} a4.5,4.5 0 0 1 4.5,4.5 V${y + HH} H${x + 0.5} Z` }, g);
    const nm = el('text', { x: x + 10, y: y + 17, class: 't-name' }, g);
    const orig = t.ghostOf ? T[t.ghostOf] : t;
    const pre = PREFIX[orig.s] || '';
    const label = t.name + (t.ghostOf ? '  ↗' : '');
    if (pre && tw(pre + label, F_NAME) <= w - 20) { const s1 = el('tspan', { class: 't-schema' }, nm); s1.textContent = pre; }
    const s2 = el('tspan', {}, nm); s2.textContent = fit(label, F_NAME, w - 20);
    const grain = t.ghostOf && T[t.ghostOf].s !== 'key' ? viewLabel(HOME[t.ghostOf]) + ' 탭' : t.ghostOf ? '키 12열 · 공통 차원 탭' : (t.grain || '');
    stext(g, x + 10, y + HH + 13, 't-grain', fit(grain, F_GRAIN, w - 20));
    el('line', { x1: x, x2: x + w, y1: y + HH + GH, y2: y + HH + GH, class: 'sep' }, g);
    const keyed = t.cols.some(cc => cc[1]);
    t.cols.forEach((c, i) => {
      const ry = y + HH + GH + i * RH + 12.5;
      if (c[1]) stext(g, x + 8, ry, 't-key k-' + c[1], c[1]);
      const nx = x + (keyed ? 30 : 10);
      const nameW = Math.min(tw(c[0], F_MONO), w - (nx - x) - 12);
      stext(g, nx, ry, 't-col', fit(c[0], F_MONO, w - (nx - x) - 12));
      let note = c[2], cls = 't-note';
      if (c[3] === id) { note = '→ 자기 참조'; cls = 't-ref'; }
      else if (c[3] && !drawn.has(id + '#' + i)) { note = '→ ' + (T[c[3]] ? T[c[3]].name : c[3]); cls = 't-ref'; }
      const avail = w - (nx - x) - nameW - 18;
      if (note && avail > 20) stext(g, x + w - 8, ry, cls, fit(note, F_NOTE, avail), 'end');
    });
    g.addEventListener('click', () => onPick(id));
    g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick(id); } });
  }
}

function onPick(id) {
  const t = T[id];
  if (t.ghostOf) { showView(HOME[t.ghostOf], t.ghostOf, true); return; }
  select(id);
}
function select(id) {
  state.sel = id;
  svg.classList.toggle('has-sel', !!id);
  const near = new Set();
  svg.querySelectorAll('.edge').forEach(e => {
    const hot = e.dataset.s === id || e.dataset.t === id;
    e.classList.toggle('hot', hot);
    if (hot) { near.add(e.dataset.s); near.add(e.dataset.t); }
  });
  svg.querySelectorAll('.tbl').forEach(g => { g.classList.toggle('sel', g.dataset.id === id); g.classList.toggle('near', near.has(g.dataset.id)); });
  renderDetail(id);
}
function gotoTable(id) { if (!T[id]) return; const home = HOME[id]; if (state.view && state.view.pos[id]) { select(id); document.getElementById('erd').scrollIntoView({ behavior: 'smooth', block: 'start' }); } else showView(home, id, true); }

const LAYER = { gold: '골드', key: '키 묶음', ghost: '' };
function renderDetail(id) {
  const t = T[id], d = t.d || {}, box = document.getElementById('detail');
  box.textContent = '';
  const head = document.createElement('div'); head.className = 'd-head';
  const h = document.createElement('h3'); h.textContent = t.s === 'key' ? t.name : fullName(id); head.appendChild(h);
  [FAM[t.fam], LAYER[t.s]].filter(Boolean).forEach((s, i) => { const c = document.createElement('span'); c.className = 'chip' + (i === 1 && t.s === 'gold' ? ' warn' : ''); c.textContent = s; head.appendChild(c); });
  box.appendChild(head);
  const grid = document.createElement('div'); grid.className = 'd-grid';
  const left = document.createElement('div');
  const dl = document.createElement('dl'); dl.className = 'kv';
  [['한 행', d.grain || t.grain], ['PK', d.pk], ['입력', d.inputs], ['갱신', d.triggers], ['용도', d.uses]].forEach(([k, v]) => {
    if (!v) return; const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd);
  });
  left.appendChild(dl);
  if ((d.rules || []).length) {
    const rt = document.createElement('div'); rt.className = 'rules-title'; rt.textContent = '규칙'; left.appendChild(rt);
    const ul = document.createElement('ul'); ul.className = 'rules';
    d.rules.forEach(r => { const li = document.createElement('li'); li.textContent = r; ul.appendChild(li); });
    left.appendChild(ul);
  }
  const right = document.createElement('div'); right.className = 'cols-wrap';
  const tb = document.createElement('table'); tb.className = 'cols';
  tb.innerHTML = '<thead><tr><th>열</th><th>키</th><th>설명</th><th>참조</th></tr></thead>';
  const body = document.createElement('tbody');
  t.cols.forEach(c => {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = c[0];
    const td2 = document.createElement('td'); td2.className = 'kc'; td2.textContent = c[1] || '';
    td2.style.color = c[1] === 'FK' ? 'var(--app)' : c[1] ? 'var(--gold-ink)' : '';
    const td3 = document.createElement('td'); td3.textContent = c[2] || '';
    const td4 = document.createElement('td');
    if (c[3] && T[c[3]]) {
      const b = document.createElement('button'); b.className = 'linkbtn'; b.type = 'button'; b.textContent = refName(c[3]);
      b.addEventListener('click', () => gotoTable(c[3]));
      td4.appendChild(b);
    } else if (c[3]) td4.textContent = c[3];
    tr.append(td1, td2, td3, td4); body.appendChild(tr);
  });
  tb.appendChild(body); right.appendChild(tb);
  grid.append(left, right); box.appendChild(grid);
}

function showView(vid, selId, scroll) {
  const view = VIEWS.find(v => v.id === vid) || VIEWS[0];
  state.view = view;
  document.querySelectorAll('.tab').forEach(b => { const on = b.dataset.v === view.id; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
  document.getElementById('view-note').textContent = view.note || '';
  renderView(view);
  select(selId && view.pos[selId] ? selId : view.main);
  try { localStorage.setItem('gold-erd-view-v2', view.id); } catch (e) {}
  if (scroll) document.getElementById('erd').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* 탭 */
const tabs = document.getElementById('tabs');
const groups = [];
VIEWS.forEach(v => { let g = groups.find(x => x.g === v.g); if (!g) groups.push(g = { g: v.g, views: [] }); g.views.push(v); });
groups.forEach(gr => {
  const row = document.createElement('div'); row.className = 'tabgroup';
  const lb = document.createElement('span'); lb.className = 'tg-label'; lb.textContent = gr.g; row.appendChild(lb);
  gr.views.forEach(v => {
    const b = document.createElement('button'); b.className = 'tab'; b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.v = v.id; b.id = 'tab-' + v.id;
    const n = Object.keys(v.pos).filter(id => !T[id].ghostOf && T[id].s !== 'key').length;
    const s1 = document.createElement('span'); s1.textContent = v.label; const s2 = document.createElement('span'); s2.className = 'n'; s2.textContent = n;
    b.append(s1, s2);
    b.addEventListener('click', () => showView(v.id));
    row.appendChild(b);
  });
  tabs.appendChild(row);
});
tabs.addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = VIEWS.findIndex(v => v.id === state.view.id), j = (i + (e.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length;
  showView(VIEWS[j].id); document.getElementById('tab-' + VIEWS[j].id).focus();
});

/* 시작 */
function start() {
  let v = null;
  const hv = (location.hash || '').replace('#', '');
  if (VIEWS.some(x => x.id === hv)) v = hv;
  if (!v) { try { v = localStorage.getItem('gold-erd-view-v2'); } catch (e) {} }
  showView(v || 'fact');
}
start();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (state.view) { const s = state.sel; renderView(state.view); select(s); } });
