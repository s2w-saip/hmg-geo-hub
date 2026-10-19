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
const PREFIX = { gold: 'gold.', app: 'app.' };
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
    const ty = (tt.s === 'key' || tt.s === 'applist' || tr < 0) ? b.y + HH / 2 : b.y + HH + GH + tr * RH + RH / 2;
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
    const hc = { gold: 'hdr-gold', app: 'hdr-app', applist: 'hdr-app', silver: 'hdr-silver', key: 'hdr-key', ghost: 'hdr-ghost' }[kind];
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

const UPSTREAM = ['답변 정제', '프롬프트 매핑', '인용 정규화', '자사/타겟 URL 매칭', 'GA4 AI 유입 분류', '키워드 정규화', '브랜드 언급 추출', '언급 감정 분류', 'ACR 최종 선택 판정', '구매 맥락 추출', '답변 원문', 'ACR 답변 원문', '프롬프트 원천', 'GA4 리포트', '키워드 원천', '소셜 원문'];
// 브론즈·실버 단계 이름은 데이터 분석팀 소관이라 '데이터 분석팀' 한 단어로 접는다
function shortCur(s) { return s ? s.split('. ')[0].replace(/ \(현행 API 가 쓰는 열은 모두 보존\)/, '') : s; }
function srcOf(s) { if (!s) return s; return [...new Set(s.split(' + ').map(p => UPSTREAM.some(w => p.includes(w)) ? '데이터 분석팀' : p))].join(' + '); }
const LAYER = { gold: '골드', app: 'app (GEO HUB 소유)', applist: 'app (GEO HUB 소유)', silver: '답변 원문 뷰', key: '키 묶음', ghost: '' };
function renderDetail(id) {
  const t = T[id], d = t.d || {}, box = document.getElementById('detail');
  box.textContent = '';
  const head = document.createElement('div'); head.className = 'd-head';
  const h = document.createElement('h3'); h.textContent = t.s === 'key' || t.s === 'applist' ? t.name : fullName(id); head.appendChild(h);
  [FAM[t.fam], LAYER[t.s]].filter(Boolean).forEach((s, i) => { const c = document.createElement('span'); c.className = 'chip' + (i === 1 && t.s === 'gold' ? ' warn' : ''); c.textContent = s; head.appendChild(c); });
  box.appendChild(head);
  const grid = document.createElement('div'); grid.className = 'd-grid';
  const left = document.createElement('div');
  const dl = document.createElement('dl'); dl.className = 'kv';
  [['한 행', t.grain], ['PK', d.pk], ['현행', shortCur(d.cur)]].forEach(([k, v]) => {
    if (!v) return; const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd);
  });
  left.appendChild(dl);
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
    const n = Object.keys(v.pos).filter(id => !T[id].ghostOf && T[id].s !== 'key' && T[id].s !== 'applist').length;
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

/* ───────── 기능 커버리지 ───────── */
const OLD2NEW = {
  'rd.answer': ['answer_fact'], 'rd.answer_brand': ['answer_brand_fact'], 'rd.answer_stance': ['answer_stance_fact'], 'rd.citation': ['citation_fact'], 'rd.job': ['job_index'],
  'rd.cycle': ['dim_cycle'], 'rd.dim_brand_name': ['dim_brand'], 'rd.dim_source': ['dim_source'], 'rd.dim_prompt': ['dim_prompt'], 'rd.dim_entity': ['dim_entity'], 'rd.dim_country': ['dim_country'],
  'rd.dim_region': ['dim_region'], 'rd.dim_taxon': ['dim_taxon'], 'rd.dim_project': ['dim_project'], 'rd.dim_engine': ['dim_engine'], 'rd.dim_lang': ['dim_lang'], 'rd.dim_url': ['dim_url'],
  'rd.catalog_entry': ['catalog_entry'], 'rd.ga4_dim_property': ['ga4_property'], 'rd.ga4_dim_value': ['ga4_value'], 'rd.ga4_row': ['ga4_row'],
  'rd.dim_keyword': ['dim_keyword'], 'rd.kw_volume_monthly': ['kw_volume_monthly'], 'rd.kw_serp': ['kw_serp'], 'rd.kw_suggestion': ['kw_suggestion'],
  'ext.ctx_snapshot': ['ctx_snapshot'], 'ext.ctx_entity': ['ctx_entity'], 'ext.ctx_drive': ['ctx_drive'], 'ext.ctx_combination': ['ctx_combination'], 'ext.ctx_domain': ['ctx_domain'], 'ext.ctx_evidence': ['ctx_evidence'],
  'rd.report_unit_value': ['report_value'], 'rd.acr_cell': ['acr_cell_fact'], 'rd.acr_choice': ['acr_entity_fact'], 'rd.acr_cell_job': ['acr_cell_job'],
  'rd.v_answer_body': ['answer_body'], 'rd.v_answer_mention_raw': ['answer_mention_raw'], 'rd.v_answer_occurrence': ['answer_occurrence'], 'rd.v_answer_stance_raw': ['answer_stance_raw'],
  'rd.v_answer_citation_raw': ['answer_citation_raw'], 'rd.v_answer_registry': ['answer_registry'], 'rd.v_acr_cell_run': ['acr_cell_run'], 'rd.v_entity_mention_surface': ['entity_mention_surface'],
  'rd.entity_mention_total': ['entity_mention_total'], 'rd.web_unit': ['web_unit'], 'rd.web_report_prompt': ['web_report_prompt'], 'rd.web_target_url': ['web_target_url'],
  'rd.rep_cit_delta': ['answer_fact'], 'rd.surface_generation': ['active_release'], 'rd.today_kst': ['~today_kst()'],
  'frz.generation': ['publication'], 'frz.cell': ['pub_cell'], 'frz.cell_web': ['pub_cell_web'], 'frz.prompt': ['pub_prompt'], 'frz.prompt_axis': ['pub_prompt_axis'], 'frz.brand_name': ['pub_brand_name'],
  'frz.kept': ['publication'], 'frz.keep_answer': ['publication'], 'frz.keep_answer_brand': ['publication'], 'frz.keep_citation': ['publication'],
  'frz.card': ['publication', 'pub_cell', 'pub_cell_web', 'pub_prompt', 'pub_prompt_axis', 'pub_brand_name'], 'frz.grid': ['publication', 'pub_cell', 'pub_prompt'],
  'ing.load': ['build'], 'app.judgment_change': ['judgment_change'],
  'need.visibility': ['page_visibility_daily', 'page_crawl_daily', 'dim_crawl_bot', 'dim_url', 'dim_project'], 'need.acr': ['acr_cell_fact', 'acr_entity_fact', 'dim_entity', 'dim_brand'],
  'need.social': ['ctx_snapshot', 'ctx_entity', 'ctx_drive', 'ctx_combination', 'ctx_domain', 'ctx_evidence'], 'need.ga4_users': ['ga4_users_window', 'ga4_row'],
};
const ACCEL_OF = { 'analytics/kpi/compare': ['kpi_cell', 'kpi_rollup'], 'analytics/kpi/engines': ['kpi_cell'], 'analytics/kpi/summary': ['kpi_cell', 'kpi_rollup'], 'analytics/geo/markets': ['kpi_cell', 'brand_cell'],
  'analytics/trend/series': ['kpi_cell', 'brand_cell', 'citation_cell'], 'analytics/mentions/brands': ['brand_cell'], 'analytics/mentions/types': ['kpi_cell'], 'analytics/citations/domains': ['citation_cell'],
  'analytics/citations/sources': ['citation_cell'], 'analytics/citations/tone': ['citation_cell'], 'analytics/citations/targets': ['url_prompt_cell'] };
const CARD = new Set(['analytics/kpi/summary', 'analytics/mentions/brands', 'analytics/trend/series', 'analytics/geo/markets', 'analytics/kpi/engines', 'analytics/citations/domains', 'analytics/kpi/compare']);
const MODULES = [
  ['admin/accounts/users', 'rd.dim_country'],
  ['admin/catalog/prompts', 'rd.dim_project rd.dim_prompt rd.dim_taxon'],
  ['admin/catalog/reference', 'rd.dim_project'],
  ['admin/changes/queue', 'app.judgment_change ing.load'],
  ['admin/citation_sources/overrides', 'rd.citation rd.dim_source'],
  ['admin/cycles/cycles', 'rd.answer rd.cycle rd.dim_project rd.job rd.today_kst'],
  ['admin/cycles/jobs', 'rd.answer rd.cycle rd.job rd.today_kst rd.v_answer_registry'],
  ['admin/entities/registry', 'rd.dim_brand_name rd.dim_entity rd.dim_project rd.entity_mention_total rd.today_kst'],
  ['admin/entities/versions', 'rd.answer_brand rd.cycle rd.dim_brand_name rd.dim_entity rd.today_kst rd.v_answer_body rd.v_answer_mention_raw rd.v_answer_occurrence rd.v_entity_mention_surface'],
  ['admin/integrations/ga4', 'rd.ga4_dim_property rd.ga4_dim_value rd.ga4_row rd.today_kst'],
  ['admin/integrations/keyword_tools', 'rd.dim_keyword rd.kw_volume_monthly'],
  ['analytics/answers/detail', 'rd.answer_brand rd.answer_stance rd.catalog_entry rd.cycle rd.dim_brand_name rd.dim_entity rd.dim_project rd.dim_source rd.dim_taxon rd.dim_url rd.job rd.surface_generation rd.today_kst rd.v_answer_body rd.v_answer_mention_raw rd.v_answer_occurrence rd.v_answer_stance_raw'],
  ['analytics/answers/list', 'rd.answer rd.answer_brand rd.dim_brand_name rd.dim_source rd.job'],
  ['analytics/citations/domain_detail', 'rd.citation rd.dim_brand_name rd.dim_source rd.dim_taxon rd.dim_url rd.job'],
  ['analytics/citations/domains', 'rd.answer rd.citation rd.dim_brand_name rd.dim_source frz.card'],
  ['analytics/citations/prompts', 'rd.answer rd.citation rd.dim_prompt rd.dim_taxon rd.job'],
  ['analytics/citations/sources', 'rd.answer rd.answer_brand rd.citation rd.dim_source'],
  ['analytics/citations/targets', 'rd.answer rd.report_unit_value'],
  ['analytics/citations/tone', 'rd.answer rd.citation rd.dim_source rd.dim_url'],
  ['analytics/filters/dates', 'rd.cycle'],
  ['analytics/filters/options', 'rd.answer rd.catalog_entry rd.citation rd.dim_country rd.dim_engine rd.dim_project rd.dim_region rd.dim_source rd.dim_taxon rd.job'],
  ['analytics/funnel/acr', 'rd.acr_cell rd.acr_choice rd.cycle rd.dim_brand_name rd.dim_country rd.dim_engine rd.dim_entity rd.dim_lang'],
  ['analytics/funnel/conversion', 'rd.dim_engine rd.ga4_dim_property rd.ga4_dim_value rd.ga4_row rd.today_kst'],
  ['analytics/geo/markets', 'rd.answer rd.catalog_entry rd.dim_brand_name rd.dim_country frz.card'],
  ['analytics/kpi/compare', 'rd.answer frz.card'],
  ['analytics/kpi/engines', 'rd.answer frz.card'],
  ['analytics/kpi/summary', 'rd.answer rd.catalog_entry rd.dim_prompt rd.dim_taxon rd.today_kst frz.card'],
  ['analytics/mentions/brands', 'rd.answer rd.answer_brand rd.dim_brand_name frz.card'],
  ['analytics/mentions/prompts', 'rd.dim_brand_name rd.dim_country rd.dim_engine rd.dim_entity rd.dim_taxon rd.job rd.v_answer_mention_raw'],
  ['analytics/mentions/types', 'rd.answer rd.answer_brand rd.answer_stance'],
  ['analytics/trend/series', 'rd.answer rd.answer_brand rd.citation rd.cycle rd.dim_brand_name rd.dim_source rd.job frz.card frz.grid'],
  ['catalog/prompts/catalog', 'rd.answer rd.dim_project rd.dim_prompt rd.dim_taxon'],
  ['intent/keywords/fetches', 'rd.kw_suggestion app.judgment_change'],
  ['intent/keywords/research', 'rd.dim_keyword rd.kw_serp rd.kw_suggestion rd.kw_volume_monthly'],
  ['intent/keywords/serp_drafts', 'rd.dim_keyword rd.kw_serp'],
  ['intent/keywords/tracked', 'rd.dim_keyword rd.kw_volume_monthly'],
  ['intent/social/context_map', 'ext.ctx_combination ext.ctx_domain ext.ctx_drive ext.ctx_entity ext.ctx_evidence ext.ctx_snapshot'],
  ['projects/project/core', 'rd.dim_engine'],
  ['projects/prompts/lifecycle', 'rd.answer rd.answer_brand rd.citation rd.cycle rd.dim_project rd.dim_prompt'],
  ['projects/settings/engines', 'rd.dim_engine'],
  ['projects/settings/scope_link', 'rd.answer rd.cycle rd.dim_project rd.job'],
  ['qa/answers/detail', 'rd.acr_cell rd.acr_cell_job rd.acr_choice rd.answer rd.citation rd.dim_brand_name rd.dim_entity rd.dim_lang rd.dim_project rd.dim_prompt rd.dim_taxon rd.dim_url rd.job rd.v_acr_cell_run rd.v_answer_body rd.v_answer_citation_raw rd.v_answer_mention_raw rd.v_answer_registry'],
  ['qa/answers/list', 'rd.dim_country rd.dim_engine rd.dim_lang rd.dim_prompt rd.job rd.v_answer_citation_raw rd.v_answer_mention_raw'],
  ['qa/notes/notes', 'rd.dim_prompt rd.job'],
  ['qa/review/deltas', 'rd.job'],
  ['screen/Global > AI Visibility', 'need.visibility'], ['screen/Project > AI Visibility', 'need.visibility'], ['screen/Project > ACR', 'need.acr'], ['screen/Website > ACR', 'need.acr'],
  ['screen/Global > Social Scraping', 'need.social'], ['screen/Admin > Customer interest config 맥락 지도', 'need.social'], ['screen/AI Conversion 순 방문자 · 방문 빈도', 'need.ga4_users'],
  ['core (공통 지표 빌더 · 카드 경로)', 'rd.web_unit rd.web_report_prompt rd.web_target_url rd.rep_cit_delta rd.surface_generation frz.generation frz.cell frz.cell_web frz.prompt frz.prompt_axis frz.brand_name frz.kept frz.keep_answer frz.keep_answer_brand frz.keep_citation'],
];
let covOk = 0;
(function coverage() {
  const root = document.getElementById('cov');
  const hr = document.createElement('div'); hr.className = 'cov-row cov-head';
  ['모듈', '테이블', ''].forEach(s => { const d = document.createElement('div'); d.textContent = s; hr.appendChild(d); });
  root.appendChild(hr);
  const AREA = { admin: 'Admin', analytics: '분석 화면', catalog: '카탈로그', intent: 'Intent', projects: 'Project', qa: '원본 데이터 검수', screen: '정적 표본 · API 미지원 화면', core: '공통' };
  let lastArea = null;
  MODULES.forEach(([mod, objs]) => {
    const area = mod.split(/[/ ]/)[0];
    if (area !== lastArea) {
      lastArea = area;
      const n = MODULES.filter(m => m[0].split(/[/ ]/)[0] === area).length;
      const g = document.createElement('div'); g.className = 'cov-group'; g.textContent = AREA[area] || area;
      const sp = document.createElement('span'); sp.textContent = `모듈 ${n}`; g.appendChild(sp); root.appendChild(g);
    }
    const old = objs.split(' ');
    const ids = new Set(), missing = [];
    old.forEach(o => { const m = OLD2NEW[o]; if (!m) missing.push(o); else m.forEach(x => ids.add(x)); });
    (ACCEL_OF[mod] || []).forEach(x => ids.add(x));
    const r = document.createElement('div'); r.className = 'cov-row';
    const m = document.createElement('div'); m.className = 'cov-mod';
    const mt = document.createElement('span'); mt.textContent = mod.replace(/^(admin|analytics|catalog|intent|projects|qa|screen)\//, ''); m.appendChild(mt);
    if (CARD.has(mod)) { const b = document.createElement('span'); b.className = 'badge card'; b.textContent = '카드 동결'; m.appendChild(b); }
    if (ACCEL_OF[mod]) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = '셀 가속'; m.appendChild(b); }
    const mid = document.createElement('div');
    const pills = document.createElement('div'); pills.className = 'cov-tabs';
    [...ids].forEach(x => {
      if (x.startsWith('~')) { const p = document.createElement('span'); p.className = 'pill p-fn'; p.textContent = x.slice(1); pills.appendChild(p); return; }
      const t = T[x]; const p = document.createElement('button'); p.type = 'button';
      p.className = 'pill ' + (t.s === 'silver' ? 'p-silver' : t.s === 'app' ? 'p-app' : (ACCEL_OF[mod] || []).includes(x) ? 'p-gold' : '');
      p.textContent = t.name; p.title = (ACCEL_OF[mod] || []).includes(x) ? '가속층 (선택)' : fullName(x);
      p.addEventListener('click', () => gotoTable(x)); pills.appendChild(p);
    });
    mid.appendChild(pills);
    
    const ok = document.createElement('div'); ok.className = missing.length ? 'cov-bad' : 'cov-ok'; ok.textContent = missing.length ? '빠짐 ' + missing.join(', ') : '대응';
    if (!missing.length) covOk++;
    r.append(m, mid, ok); root.appendChild(r);
  });
})();

/* 헤더 숫자 */
(function meta() {
  const real = Object.values(T).filter(t => !t.ghostOf && t.d);
  const gold = real.filter(t => t.s === 'gold').length, silver = real.filter(t => t.s === 'silver').length, app = real.filter(t => t.s === 'app').length;
  const m = document.getElementById('meta');
  const chips = [['논리 설계 · DDL 아님', null, true], ['화면 영역', '346 / 346'], ['기능 대응', `${covOk} / ${MODULES.length}`], ['골드 테이블', gold], ['app 참조', app], ['화면 항목', ITEMS.reduce((a, s) => a + s.items.length, 0)], ['기준일', '2026-10-19']];
  chips.forEach(([k, v, warn]) => { const c = document.createElement('span'); c.className = 'chip' + (warn ? ' warn' : ''); c.textContent = k + (v != null ? ' ' : ''); if (v != null) { const b = document.createElement('b'); b.textContent = v; c.appendChild(b); } m.appendChild(c); });
})();

/* 화면 × 데이터 계열 */
(function matrix() {
  const FAMOF = { '답변': ['kpi'], '언급': ['kpi'], '언급+감정': ['kpi'], '엔티티': ['kpi'], '인용': ['cit'], '인용+자사': ['cit'], '인용+감정': ['cit'], '도메인': ['cit'],
    '언급+인용': ['kpi', 'cit'], 'KPI 전체': ['kpi', 'cit'], 'ACR': ['acr'], 'GA4': ['ga4'], '키워드': ['kw'], '소셜': ['soc'], '프롬프트 연결': ['dim'] };
  const COLS = [['dim', '프롬프트 연결'], ['kpi', '언급 계열'], ['cit', '인용 계열'], ['acr', 'ACR'], ['ga4', 'GA4'], ['kw', '키워드'], ['soc', '소셜'], ['silver', '원문·목록']];
  const root = document.getElementById('matrix');
  const hr = document.createElement('div'); hr.className = 'mx-row mx-headrow';
  hr.appendChild(Object.assign(document.createElement('div'), { textContent: '화면' }));
  COLS.forEach(([, l]) => hr.appendChild(Object.assign(document.createElement('div'), { textContent: l })));
  hr.appendChild(Object.assign(document.createElement('div'), { textContent: '항목' }));
  root.appendChild(hr);
  const grs = [];
  ITEMS.forEach(s => { const top = s.screen.split(' > ')[0]; let g = grs.find(x => x.top === top); if (!g) grs.push(g = { top, rows: [] }); g.rows.push(s); });
  grs.forEach(g => {
    const n = g.rows.reduce((a, s) => a + s.items.length, 0);
    const gh = document.createElement('div'); gh.className = 'mx-group'; gh.textContent = g.top;
    const sp = document.createElement('span'); sp.textContent = `화면 ${g.rows.length} · 항목 ${n}`; gh.appendChild(sp); root.appendChild(gh);
    g.rows.forEach(s => {
      const cnt = {}; COLS.forEach(([k]) => cnt[k] = 0);
      s.items.forEach(i => { if (i.g) cnt.silver++; else (FAMOF[i.s] || []).forEach(f => cnt[f]++); });
      const det = document.createElement('details'); det.className = 'mx-item';
      const sumEl = document.createElement('summary'); const sum = document.createElement('div'); sum.className = 'mx-row'; sumEl.appendChild(sum);
      const nm = document.createElement('div'); nm.className = 'mx-name'; const nt = document.createElement('span'); nt.textContent = s.screen.split(' > ').slice(1).join(' › ') || s.screen; nm.appendChild(nt); sum.appendChild(nm);
      COLS.forEach(([k]) => { const c = document.createElement('div'); c.className = 'mx-c'; const sp2 = document.createElement('span'); const v = cnt[k];
        sp2.className = v === 0 ? 'c0' : k === 'silver' ? 'cs' : v >= 5 ? 'c2' : 'c1'; sp2.textContent = v === 0 ? '·' : v; c.appendChild(sp2); sum.appendChild(c); });
      const tot = document.createElement('div'); tot.className = 'mx-tot'; tot.textContent = s.items.length; sum.appendChild(tot);
      det.appendChild(sumEl);
      const list = document.createElement('div'); list.className = 'mx-items';
      s.items.forEach(i => { const r = document.createElement('div'); r.className = 'mx-it';
        const a = document.createElement('span'); a.textContent = i.n;
        const k = document.createElement('span'); k.className = 'tag'; k.textContent = `${i.k} · ${i.s}`;
        const l = document.createElement('span'); l.className = 'lay ' + (i.g ? 'lay-s' : 'lay-g'); l.textContent = i.g ? '원문·목록' : 'gold';
        r.append(a, k, l); list.appendChild(r); });
      det.appendChild(list); root.appendChild(det);
    });
  });
})();

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

/* ───────── 스키마 경계 ───────── */
function schemaOf(id) {
  if (typeof id === 'string' && id.startsWith('app.')) return 'app';
  const t = T[id]; if (!t) return null;
  const o = t.ghostOf ? T[t.ghostOf] : t;
  if (o.s === 'silver') return 'serve';
  if (o.s === 'app' || o.s === 'applist' || o.fam === 'queue') return 'app';
  return 'gold';
}
const APP_GROUPS = [
  { title: '판정 · 수집 입력', note: 'BE 가 쓰고 데이터 분석팀이 재판정 때 읽습니다. 저장하면 트리거가 judgment_change 를 쌓습니다.', items: ['owned_base', 'project_owned_base', 'project_tracked_url', 'website_site', 'website_prompt', 'website_report_unit', 'website_report_excluded', 'citation_category', 'citation_domain_override', 'brand', 'brand_name_prefix', 'brand_display_alias', 'competitor_domain_token', 'non_competitor_name', 'entity_registry', 'entity_alias', 'rhq_region', 'rhq_region_country', 'hidden_market', 'rule_param', 'rule_set', 'ga4_property', 'ga4_tracked_event', 'project', 'prompt', 'standard_keyword', 'standard_source', 'project_tracked_keyword'] },
  { title: '엔티티 카탈로그', note: 'BE 가 버전·초안을 편집하고, 데이터 분석팀이 읽어서 반영합니다. ecat_apply 진행률과 ecat_review 신규 표면 제안은 데이터 분석팀이 씁니다.', items: ['ecat_version', 'ecat_entity', 'ecat_surface', 'ecat_surface_def', 'ecat_apply', 'ecat_review', 'ecat_audit_log', 'ecat_alias_active', 'ecat_registry_active'] },
  { title: '요청 · 연동 큐', note: 'BE 가 쌓고 데이터 분석팀이 상태를 갱신합니다. 데이터 분석팀은 Scope 연결 id(project.scope_project_id · prompt.scope_prompt_id)도 채웁니다.', items: ['judgment_change', 'scope_outbox'] },
  { title: '발행 리포트', note: '웹사이트 발행 리포트 원장입니다. gold.report_value 의 출처입니다.', items: ['report_publication', 'report_site_fact', 'report_site_engine_fact'] },
  { title: 'BE 전용', note: '데이터 분석팀이 읽지 않습니다. 사용자·멤버, 프로젝트 추적 대상, 후보 풀, 커스텀 필드, 프롬프트 초안.', items: ['user_account', 'project_member', 'project_engine_history', 'project_custom_field', 'prompt_custom_field_value', 'prompt_candidate', 'project_tracked_brand', 'project_tracked_competitor', 'project_tracked_vehicle', 'kw_prompt_draft', 'ctx_generated_prompt', 'ga4_market_pending'] },
  { title: '검수 · 감사', note: '검수 리뷰·노트·잠금과 감사 로그입니다. 저장과 같은 트랜잭션으로 갱신해야 해서 골드 빌드와 묶지 않습니다.', items: ['qa_review_session', 'qa_answer_review', 'qa_review_note', 'qa_answer_lock', 'access_audit_log', 'member_audit_log', 'permission_audit_log', 'prompt_audit_log'] },
];
const INTERNAL = [
  { title: 'rcache · 결과 캐시', note: 'BE 응답 캐시입니다. 캐시 키의 데이터 버전을 지금은 rd.surface_generation 과 rcache 트리거에서, 골드에서는 gold.active_release.version 과 gold.data_version 에서 받습니다.', items: ['rcache.entry', 'rcache.stat', 'rcache.data_version'] },
  { title: 'mig · 이관 · 대조 원장', note: '현행 운영 데이터와 허브 결과를 대조하고 화면 그룹별로 전환하는 원장입니다 (migrator 역할).', items: ['mig.source_snapshot', 'mig.copy_chunk', 'mig.rebuild_batch', 'mig.partition_checksum', 'mig.run_fingerprint', 'mig.parity_run', 'mig.parity_result', 'mig.known_diff', 'mig.row_oracle_diff', 'mig.screen_group', 'mig.cutover_event', 'mig.repull_log', 'mig.archive_manifest'] },
];
const SCHEMAS = [
  { id: 'gold', label: 'gold', sub: '데이터 분석팀 쓰기 · BE 읽기 전용', desc: `화면이 읽는 데이터 전부입니다. ERD 탭 ${VIEWS.filter(v => v.g !== 'app').length}개가 모두 이 스키마에 들어가고, 계열 구분은 테이블 이름 접두어(dim_ · *_fact · *_cell · pub_ · ga4_ · kw_ · ctx_ · page_ · vis_)로 합니다.`,
    chips: [['쓰기', '데이터 분석팀 (loader)'], ['읽기', 'BE (api_ro)']],
    rules: ['BE 는 SELECT 만 합니다. 정정이 필요하면 app.judgment_change 로 요청합니다.', '큰 사실 테이블은 스키마를 나누지 않고 표면 × 회차일로 파티션합니다 (현행 rd 와 같음).', '공개는 active_release 전환 한 번으로 일어납니다. 계열이 한 스키마에 있어 여러 계열을 함께 바꾸기 쉽습니다.'] },
  { id: 'app', label: 'app', sub: 'BE 쓰기 · 데이터 분석팀 읽기 · 일부 상태 갱신', desc: 'GEO HUB BE 가 소유하는 설정·요청·운영 데이터입니다. 현행 app 스키마 60개 테이블을 쓰는 쪽 기준으로 나눴습니다. 데이터 분석팀 쓰기는 현행 적재기 코드에서 확인한 것만 적었습니다.',
    chips: [['쓰기', 'BE (api_rw)'], ['읽기', '데이터 분석팀 (loader)'], ['데이터 분석팀 갱신', 'judgment_change · scope_outbox · ecat_apply · ecat_review · ecat_audit_log · project · prompt']],
    groups: APP_GROUPS,
    rules: ['데이터 분석팀이 app 에 쓰는 곳은 상태 열과 Scope 연결 id 로 한정합니다. 설정 값 자체는 BE 만 씁니다.', '현행 DDL 은 rd.dim_source → app.citation_category, rd.dim_url → app.owned_base 에 스키마를 넘는 FK 가 있습니다. 소유자가 갈라지면 FK 를 유지할지 빌드 검증으로 바꿀지 정해야 합니다.'] },
  { id: 'internal', label: 'rcache · mig', sub: 'BE 내부', desc: 'BE 가 혼자 쓰는 운영 스키마입니다. 골드 설계와 무관하게 그대로 둡니다.',
    chips: [['쓰기', 'BE (api_rw) · migrator'], ['읽기', 'BE']], rules: ['골드 전환 뒤 캐시 무효화는 active_release.version 과 data_version 변경을 기준으로 합니다.'] },
];
function pillFor(name, schema) {
  const id = schema === 'app' ? (T[name] && schemaOf(name) === 'app' ? name : null) : name;
  if (id && T[id] && !T[id].ghostOf && T[id].s !== 'key' && T[id].s !== 'applist') {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'pill ' + (T[id].s === 'silver' ? 'p-silver' : T[id].s === 'app' ? 'p-app' : '');
    b.textContent = T[id].name; b.title = 'ERD 에서 보기'; b.addEventListener('click', () => gotoTable(id)); return b;
  }
  const s = document.createElement('span'); s.className = 'pill p-off'; s.textContent = name; s.title = 'ERD 밖 테이블'; return s;
}
function crossRefs(schema) {
  const out = [], seen = new Set();
  Object.values(T).forEach(t => {
    if (t.ghostOf || !t.d) return;
    const a = schemaOf(t.id);
    t.cols.forEach(c => {
      const ref = c[3]; if (!ref) return;
      const b = schemaOf(ref); if (!b || a === b) return;
      if (a !== schema && b !== schema) return;
      const tgt = T[ref] ? T[ref].name : ref.replace(/^app\./, '');
      const k = t.id + '.' + c[0] + '>' + tgt; if (seen.has(k)) return; seen.add(k);
      out.push({ from: `${a}.${t.name}.${c[0]}`, to: `${b}.${tgt}`, dir: a === schema ? 'out' : 'in' });
    });
  });
  return out;
}
function renderSchema(sid) {
  const sc = SCHEMAS.find(s => s.id === sid) || SCHEMAS[0];
  document.querySelectorAll('#sch-tabs .tab').forEach(b => { const on = b.dataset.s === sc.id; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
  const p = document.getElementById('sch-panel'); p.textContent = '';
  p.setAttribute('aria-labelledby', 'sch-tab-' + sc.id);
  const top = document.createElement('div'); top.className = 'sch-top';
  const h = document.createElement('h3'); h.textContent = sc.label;
  const d = document.createElement('p'); d.textContent = sc.desc;
  const chips = document.createElement('div'); chips.className = 'sch-chips';
  let groups = sc.groups;
  if (sc.id === 'gold') {
    groups = VIEWS.filter(v => v.g !== 'app').map(v => ({ title: v.label, view: v.id, items: Object.keys(v.pos).filter(id => !T[id].ghostOf && T[id].s === 'gold' && HOME[id] === v.id) })).filter(g => g.items.length);
  }
  let count = 0;
  if (groups) groups.forEach(g => count += g.items.length);
  if (sc.id === 'internal') INTERNAL.forEach(g => count += g.items.length);
  sc.chips.concat([['객체', String(count)]]).forEach(([k, v]) => { const c = document.createElement('span'); c.className = 'chip'; c.textContent = k + ' '; const b = document.createElement('b'); b.textContent = v; c.appendChild(b); chips.appendChild(c); });
  top.append(h, chips); p.appendChild(top);

  const grid = document.createElement('div'); grid.className = 'sch-groups';
  const card = (title, n, note) => { const g = document.createElement('div'); g.className = 'sch-g'; const h4 = document.createElement('h4'); h4.textContent = title; const sp = document.createElement('span'); sp.textContent = n; h4.appendChild(sp); g.appendChild(h4); return g; };
  if (groups) groups.forEach(gr => {
    const g = card(gr.title, gr.items.length, gr.note);
    const pills = document.createElement('div'); pills.className = 'pills';
    gr.items.forEach(n => pills.appendChild(pillFor(n, sc.id)));
    g.appendChild(pills);
    if (gr.view) { const b = document.createElement('button'); b.type = 'button'; b.className = 'linkbtn'; b.textContent = 'ERD 탭 열기'; b.addEventListener('click', () => showView(gr.view, null, true)); g.appendChild(b); }
    grid.appendChild(g);
  });
  if (sc.id === 'internal') INTERNAL.forEach(gr => {
    const g = card(gr.title, gr.items.length, gr.note);
    const pills = document.createElement('div'); pills.className = 'pills';
    gr.items.forEach(n => { const s = document.createElement('span'); s.className = 'pill p-off'; s.textContent = n; pills.appendChild(s); });
    g.appendChild(pills); grid.appendChild(g);
  });
  p.appendChild(grid);

  const refs = sc.id === 'internal' ? [] : crossRefs(sc.id);
  if (refs.length) {
    const wrap = document.createElement('div');
    const t = document.createElement('div'); t.className = 'sch-sec'; t.textContent = `다른 스키마 참조 ${refs.length}`; wrap.appendChild(t);
    const list = document.createElement('div'); list.className = 'refs';
    refs.sort((x, y) => (x.dir > y.dir ? -1 : x.dir < y.dir ? 1 : x.from.localeCompare(y.from))).forEach(r => {
      const row = document.createElement('div');
      const a = document.createElement('span'); a.textContent = r.from; const ar = document.createElement('span'); ar.className = 'ar'; ar.textContent = '→'; const b = document.createElement('span'); b.textContent = r.to;
      row.append(a, ar, b); list.appendChild(row);
    });
    wrap.appendChild(list); p.appendChild(wrap);
  }
  try { localStorage.setItem('gold-erd-schema', sc.id); } catch (e) {}
}
(function schemaTabs() {
  const bar = document.getElementById('sch-tabs');
  SCHEMAS.forEach(sc => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'tab'; b.setAttribute('role', 'tab'); b.dataset.s = sc.id; b.id = 'sch-tab-' + sc.id;
    const s1 = document.createElement('span'); s1.textContent = sc.label; s1.style.fontFamily = 'var(--font-mono)'; b.appendChild(s1);
    b.addEventListener('click', () => renderSchema(sc.id)); bar.appendChild(b);
  });
  bar.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const cur = document.querySelector('#sch-tabs .tab[aria-selected="true"]').dataset.s;
    const i = SCHEMAS.findIndex(s => s.id === cur), j = (i + (e.key === 'ArrowRight' ? 1 : -1) + SCHEMAS.length) % SCHEMAS.length;
    renderSchema(SCHEMAS[j].id); document.getElementById('sch-tab-' + SCHEMAS[j].id).focus();
  });
  let s0 = null; try { s0 = localStorage.getItem('gold-erd-schema'); } catch (e) {}
  renderSchema(s0 || 'gold');
})();

