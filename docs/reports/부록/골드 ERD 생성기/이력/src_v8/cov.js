/* ───────── 전수 대응 검증 (페이지가 열릴 때 계산, 숫자를 손으로 적지 않는다) ───────── */
/* @cov-core start */
const APPSET = new Set(APP_GROUPS.flatMap(g => g.items));
function braces(s) { const m = s.match(/^(.*?)\{([^{}]*)\}(.*)$/); if (!m) return [s]; return m[2].split(',').flatMap(x => braces(m[1] + x.trim() + m[3])); }
function expandName(name) {
  const out = [];
  for (let part of name.split(/\s*·\s*/)) {
    part = part.trim().replace(/\[\]$/, '');
    if (!part) continue;
    let m = part.match(/^([a-z_]+?)(\d+) … \1(\d+)$/);
    if (m) { for (let i = +m[2]; i <= +m[3]; i++) out.push(m[1] + i); continue; }
    m = part.match(/^([a-z_]*?)(\d+)~(\d+)([a-z_]*)$/);
    if (m) { for (let i = +m[2]; i <= +m[3]; i++) out.push(m[1] + i + m[4]); continue; }
    if (part.includes('{')) { out.push(...braces(part).map(x => x.replace(/\[\]$/, ''))); continue; }
    if (/^[a-z_][a-z0-9_]*$/.test(part)) out.push(part);
  }
  return out;
}
function physCols(c) { return Array.isArray(c[4]) ? c[4] : expandName(c[0]); }
function colsOf(id) { const t = T[id]; if (!t || t.ghostOf) return null; const set = new Set(); t.cols.forEach(c => physCols(c).forEach(x => set.add(x))); return set; }
function featRefs(f) {
  const gold = new Set(), groups = new Set(), app = new Set(), kinds = new Set();
  (f.m || []).forEach(m => { const v = BEMODS[m]; if (!v) return; v.direct.forEach(o => { if (OBJMAP[o]) gold.add(OBJMAP[o]); }); v.groups.forEach(g => groups.add(g)); (v.writes || []).forEach(a => app.add(a)); (v.kinds || []).forEach(k => kinds.add(k)); if (!(v.writes || []).length) (v.app || []).forEach(a => app.add(a)); });
  (f.g || []).forEach(r => gold.add(r.split('.')[0]));
  (f.a || []).forEach(a => app.add(a));
  (f.w || []).forEach(k => kinds.add(k));
  return { gold: [...gold], groups: [...groups], app: [...app], kinds: [...kinds] };
}
function validateAll() {
  const R = { erd: [], col: { ok: 0, n: COLMAP.length, bad: [] }, feat: { ok: 0, n: FEATURES.length, bad: [] }, mod: { ok: 0, n: Object.keys(BEMODS).length, bad: [] } };
  const real = Object.values(T).filter(t => !t.ghostOf);
  real.forEach(t => t.cols.forEach(c => { const ref = c[3]; if (ref && !ref.startsWith('app.') && !T[ref]) R.erd.push(`${t.id}.${c[0]} → ${ref}: 대상 없음`); if (ref && !['FK', 'PF'].includes(c[1]) && t.s !== 'key') R.erd.push(`${t.id}.${c[0]}: 참조인데 FK/PF 표기 없음`); }));
  const placed = new Set();
  VIEWS.forEach(v => Object.keys(v.pos).forEach(id => { if (!T[id]) R.erd.push(`탭 ${v.id}: ${id} 없음`); placed.add(id); }));
  real.forEach(t => { if (!placed.has(t.id)) R.erd.push(`${t.id}: 어느 탭에도 없음`); });
  real.forEach(t => { const seen = {}; t.cols.forEach(c => physCols(c).forEach(x => { if (seen[x]) R.erd.push(`${t.id}: 열 ${x} 중복`); seen[x] = 1; })); });
  const objOK = {};
  COLMAP.forEach(e => {
    let why = '';
    if (e.h === 'func') { if (!e.n) why = '설명 없음'; }
    else { const i = e.t.indexOf('.'), tb = e.t.slice(0, i), col = e.t.slice(i + 1), cs = colsOf(tb); if (!cs) why = `${tb} 없음`; else if (!cs.has(col)) why = `${e.t} 없음`; }
    e.ok = !why; if (e.ok) R.col.ok++; else R.col.bad.push(`${e.o}.${e.c} → ${e.t || '—'}: ${why}`);
    objOK[e.o] = objOK[e.o] !== false && e.ok;
  });
  Object.entries(BEMODS).forEach(([m, v]) => {
    const objs = v.direct.concat(...v.groups.map(g => GROUP_OBJS[g] || []));
    v.miss = objs.filter(o => objOK[o] !== true).concat((v.app || []).filter(a => !APPSET.has(a)).map(a => 'app.' + a));
    v.ok = !v.miss.length; if (v.ok) R.mod.ok++; else R.mod.bad.push(`${m}: ${v.miss.join(', ')}`);
  });
  FEATURES.forEach(f => {
    const why = [];
    (f.m || []).forEach(m => { if (!BEMODS[m]) why.push(`모듈 ${m} 없음`); else if (!BEMODS[m].ok) why.push(`모듈 ${m} 미대응`); });
    (f.g || []).forEach(r => { const i = r.indexOf('.'), tb = i < 0 ? r : r.slice(0, i), cs = colsOf(tb); if (!cs) why.push(`${tb} 없음`); else if (i >= 0 && !cs.has(r.slice(i + 1))) why.push(`${r} 없음`); });
    (f.a || []).forEach(a => { if (!APPSET.has(a)) why.push(`app.${a} 없음`); });
    if (f.ui && !FEATURES.some(x => x.r === f.r && x.l === f.ui)) why.push(`원 항목 '${f.ui}' 없음`);
    if (!(f.m || []).length && !(f.g || []).length && !(f.a || []).length && !f.ui && !f.none) why.push('대응 없음');
    f.ok = !why.length; f.why = why;
  });
  FEATURES.forEach(f => { if (f.ok && f.ui) { const p = FEATURES.find(x => x.r === f.r && x.l === f.ui); if (p && !p.ok) { f.ok = false; f.why.push('원 항목 미대응'); } } });
  FEATURES.forEach(f => { if (f.ok) R.feat.ok++; else R.feat.bad.push(`${f.r} · ${f.l}: ${f.why.join('; ')}`); });
  return R;
}
/* @cov-core end */
const COV = validateAll();

/* 헤더 상태 칩 */
(function meta() {
  const real = Object.values(T).filter(t => !t.ghostOf && t.d);
  const m = document.getElementById('meta');
  const full = (a, b) => a === b;
  const chips = [
    ['논리 설계 · DDL 아님', null, true],
    ['화면 항목 대응', `${COV.feat.ok} / ${COV.feat.n}`, !full(COV.feat.ok, COV.feat.n)],
    ['현행 열 대응', `${COV.col.ok} / ${COV.col.n}`, !full(COV.col.ok, COV.col.n)],
    ['BE 모듈 대응', `${COV.mod.ok} / ${COV.mod.n}`, !full(COV.mod.ok, COV.mod.n)],
    ['ERD 무결성 오류', String(COV.erd.length), COV.erd.length > 0],
    ['골드 테이블', String(real.filter(t => t.s === 'gold').length)],
    ['신규 요청', String(NEWREQ.length)],
    ['기준일', '2026-10-20'],
  ];
  chips.forEach(([k, v, warn]) => { const c = document.createElement('span'); c.className = 'chip' + (warn ? ' warn' : ''); c.textContent = k + (v != null ? ' ' : ''); if (v != null) { const b = document.createElement('b'); b.textContent = v; c.appendChild(b); } m.appendChild(c); });
  if (COV.erd.length || COV.col.bad.length || COV.mod.bad.length || COV.feat.bad.length) {
    const box = document.createElement('div'); box.className = 'cov-alert';
    box.textContent = '미대응: ' + COV.erd.concat(COV.col.bad, COV.mod.bad, COV.feat.bad).slice(0, 12).join(' · ');
    m.after(box);
  }
})();

/* 흐름 그림의 화면 쪽 숫자 */
(function flowNums() {
  const by = {}; FEATURES.forEach(f => { const k = KGROUP[f.k] || '기타'; by[k] = (by[k] || 0) + 1; });
  document.querySelectorAll('[data-kg]').forEach(t => { t.textContent = by[t.dataset.kg] || 0; });
  const tot = document.getElementById('flow-total'); if (tot) tot.textContent = FEATURES.length;
})();

function pillTo(id, cls) {
  if (T[id] && !T[id].ghostOf) { const b = document.createElement('button'); b.type = 'button'; b.className = 'pill ' + (cls || (T[id].s === 'app' ? 'p-app' : '')); b.textContent = T[id].name; b.title = fullName(id) + ' · ERD 에서 보기'; b.addEventListener('click', () => gotoTable(id)); return b; }
  const s = document.createElement('span'); s.className = 'pill p-off'; s.textContent = id; return s;
}
function chipEl(text, cls, title) { const s = document.createElement('span'); s.className = cls; s.textContent = text; if (title) s.title = title; return s; }

/* 신규 요청 */
(function newreq() {
  const root = document.getElementById('newreq'); if (!root) return;
  const tb = document.createElement('table'); tb.className = 'acc nr';
  tb.innerHTML = '<thead><tr><th>#</th><th>골드 대상</th><th>구분</th><th>받는 화면 기능</th><th>채우는 방법 (제안)</th></tr></thead>';
  const body = document.createElement('tbody');
  NEWREQ.forEach((r, i) => {
    const tr = document.createElement('tr');
    const td0 = document.createElement('td'); td0.textContent = String(i + 1);
    const td1 = document.createElement('td'); const lb = document.createElement('div'); lb.textContent = r.t; td1.appendChild(lb);
    const by = {}; (r.cover.length ? r.cover : [r.t]).forEach(x => { const [tb, ...rest] = x.split('.'); (by[tb] = by[tb] || []).push(rest.join('.')); });
    const ps = document.createElement('div'); ps.className = 'cov-tabs';
    Object.entries(by).forEach(([tb, cs]) => { ps.appendChild(pillTo(tb)); cs.filter(Boolean).forEach(c => ps.appendChild(chipEl(c, 'pill p-col'))); });
    td1.appendChild(ps);
    const td2 = document.createElement('td'); td2.appendChild(chipEl(r.kind, 'r ' + (r.kind === '신규 테이블' ? 'r-w' : 'r-u')));
    const td3 = document.createElement('td'); td3.className = 'what'; td3.textContent = r.f;
    const td4 = document.createElement('td'); td4.className = 'what'; td4.textContent = r.src;
    tr.append(td0, td1, td2, td3, td4); body.appendChild(tr);
  });
  tb.appendChild(body); root.appendChild(tb);
})();

/* 기능 전수 대응 */
(function features() {
  const root = document.getElementById('feat'); if (!root) return;
  const bar = document.getElementById('feat-bar');
  const srcCount = {}; FEATURES.forEach(f => { const s = f.src === 'api' ? 'BE API' : SRC_LABEL[f.src] || f.src; srcCount[s] = (srcCount[s] || 0) + 1; });
  const scr = new Set(FEATURES.filter(f => f.r !== '(화면 밖)').map(f => f.r));
  [['화면', scr.size], ['화면 항목', FEATURES.filter(f => f.r !== '(화면 밖)').length], ['화면 밖', FEATURES.filter(f => f.r === '(화면 밖)').length], ['대응', `${COV.feat.ok} / ${COV.feat.n}`]].concat(Object.entries(srcCount)).forEach(([k, v]) => {
    const c = document.createElement('span'); c.className = 'chip' + (k === '대응' && COV.feat.ok !== COV.feat.n ? ' warn' : ''); c.textContent = k + ' '; const b = document.createElement('b'); b.textContent = v; c.appendChild(b); bar.appendChild(c);
  });
  const q = document.getElementById('feat-q');
  const groups = [];
  FEATURES.forEach(f => { const top = f.r === '(화면 밖)' ? '화면 밖 경로' : f.s.split(' › ')[0]; let g = groups.find(x => x.top === top); if (!g) groups.push(g = { top, screens: [] }); let s = g.screens.find(x => x.r === f.r); if (!s) g.screens.push(s = { r: f.r, s: f.s, items: [] }); s.items.push(f); });
  const rows = [];
  groups.forEach(g => {
    const n = g.screens.reduce((a, s) => a + s.items.length, 0);
    const gh = document.createElement('div'); gh.className = 'cov-group'; gh.textContent = g.top; gh.appendChild(chipEl(`화면 ${g.screens.length} · 항목 ${n}`, '')); root.appendChild(gh);
    g.screens.forEach(s => {
      const ok = s.items.filter(f => f.ok).length;
      const det = document.createElement('details'); det.className = 'fx';
      const sum = document.createElement('summary');
      sum.append(chipEl(s.s.split(' › ').slice(1).join(' › ') || s.s, 'fx-name'), chipEl(s.r, 'fx-route'), chipEl(`${ok} / ${s.items.length}`, ok === s.items.length ? 'fx-ok' : 'fx-bad'));
      det.appendChild(sum);
      const list = document.createElement('div'); list.className = 'fx-items';
      const hd = document.createElement('div'); hd.className = 'fx-row fx-hd';
      ['항목', '종류', '출처', '골드', 'app · 요청', ''].forEach(t => hd.appendChild(chipEl(t, ''))); list.appendChild(hd);
      s.items.forEach(f => {
        const r = document.createElement('div'); r.className = 'fx-row';
        const ref = featRefs(f);
        const c1 = document.createElement('div'); c1.textContent = f.l; if (f.note) c1.appendChild(chipEl(f.note, 'fx-note'));
        const c2 = chipEl(f.k, 'fx-k');
        const c3 = document.createElement('div'); c3.className = 'fx-src';
        if (f.src === 'api') { c3.textContent = `API ${f.api.length}`; c3.title = f.api.join('\n') + '\n' + (f.m || []).join('\n'); }
        else c3.textContent = SRC_LABEL[f.src] || f.src;
        if (f.ui) c3.title = `원 항목: ${f.ui}`;
        const c4 = document.createElement('div'); c4.className = 'cov-tabs';
        ref.gold.forEach(id => c4.appendChild(pillTo(id, 'p-gold')));
        ref.groups.forEach(gname => c4.appendChild(chipEl(gname.replace('공통 · ', '공통:'), 'pill p-fn', (GROUP_OBJS[gname] || []).map(o => OBJMAP[o] || o).filter((x, i, a) => a.indexOf(x) === i).join(', '))));
        (f.g || []).filter(x => x.includes('.')).forEach(x => c4.appendChild(chipEl(x.split('.').slice(1).join('.'), 'pill p-col', x)));
        if (f.ui) c4.appendChild(chipEl('= ' + f.ui, 'pill p-fn'));
        if (f.none) c4.appendChild(chipEl(f.none, 'pill p-fn'));
        const c5 = document.createElement('div'); c5.className = 'cov-tabs';
        ref.app.forEach(a => c5.appendChild(chipEl(a, 'pill p-app', 'app.' + a)));
        ref.kinds.forEach(k => c5.appendChild(chipEl('→ ' + k, 'pill p-kind', 'judgment_change kind')));
        const c6 = chipEl(f.ok ? '대응' : '미대응', f.ok ? 'cov-ok' : 'cov-bad', f.ok ? '' : f.why.join('\n'));
        r.append(c1, c2, c3, c4, c5, c6); list.appendChild(r);
        rows.push({ el: r, det, text: [f.l, f.k, f.r, ...(f.api || []), ...ref.gold, ...ref.app, ...ref.kinds, ...(f.g || [])].join(' ').toLowerCase() });
      });
      det.appendChild(list); root.appendChild(det);
    });
  });
  q.addEventListener('input', () => {
    const v = q.value.trim().toLowerCase();
    const open = new Set();
    rows.forEach(x => { const hit = !v || x.text.includes(v); x.el.hidden = !hit; if (hit && v) open.add(x.det); });
    root.querySelectorAll('details.fx').forEach(d => { const any = [...d.querySelectorAll('.fx-row:not(.fx-hd)')].some(r => !r.hidden); d.hidden = !any; d.open = !!v && open.has(d); });
  });
})();

/* 현행 열 전수 대응 */
(function colmap() {
  const root = document.getElementById('colmap'); if (!root) return;
  const bar = document.getElementById('colmap-bar');
  const HOW = { same: '같은 열', rename: '이름 변경', path: '동결 경로', derived: '파생', func: '함수 대체' };
  const by = {}; COLMAP.forEach(e => { by[e.h] = (by[e.h] || 0) + 1; });
  const objs = []; COLMAP.forEach(e => { let o = objs.find(x => x.o === e.o); if (!o) objs.push(o = { o: e.o, rows: [] }); o.rows.push(e); });
  [['현행 객체', objs.length], ['열', COV.col.n], ['대응', `${COV.col.ok} / ${COV.col.n}`]].concat(Object.entries(by).map(([k, v]) => [HOW[k] || k, v])).forEach(([k, v]) => {
    const c = document.createElement('span'); c.className = 'chip' + (k === '대응' && COV.col.ok !== COV.col.n ? ' warn' : ''); c.textContent = k + ' '; const b = document.createElement('b'); b.textContent = v; c.appendChild(b); bar.appendChild(c);
  });
  objs.forEach(o => {
    const ok = o.rows.filter(e => e.ok).length, tgt = OBJMAP[o.o];
    const det = document.createElement('details'); det.className = 'fx';
    const sum = document.createElement('summary');
    const special = o.rows.filter(e => e.h !== 'same').length;
    sum.append(chipEl(o.o, 'fx-name mono'), chipEl(tgt ? '→ ' + (T[tgt] ? fullName(tgt) : tgt) : '→ BE 계산', 'fx-route'), chipEl(special ? `특이 ${special}` : '', 'fx-note'), chipEl(`${ok} / ${o.rows.length}`, ok === o.rows.length ? 'fx-ok' : 'fx-bad'));
    det.appendChild(sum);
    const tb = document.createElement('table'); tb.className = 'cols cm';
    tb.innerHTML = '<thead><tr><th>현행 열</th><th>방식</th><th>골드 열</th><th>설명</th><th></th></tr></thead>';
    const body = document.createElement('tbody');
    o.rows.forEach(e => {
      const tr = document.createElement('tr'); if (e.h !== 'same') tr.className = 'cm-x';
      [e.c, HOW[e.h] || e.h, e.t || '—', e.n || '', e.ok ? '대응' : '미대응'].forEach((v, i) => { const td = document.createElement('td'); td.textContent = v; if (i === 4) td.className = e.ok ? 'cov-ok' : 'cov-bad'; tr.appendChild(td); });
      body.appendChild(tr);
    });
    tb.appendChild(body); const wrap = document.createElement('div'); wrap.className = 'cols-wrap fx-items'; wrap.appendChild(tb); det.appendChild(wrap); root.appendChild(det);
  });
})();

/* BE 모듈 대응 */
(function modules() {
  const root = document.getElementById('mods'); if (!root) return;
  const hr = document.createElement('div'); hr.className = 'md-row md-hd';
  ['모듈', '현행 객체 (직접)', '골드', '공통 경로', 'app 쓰기 · 요청', ''].forEach(t => hr.appendChild(chipEl(t, ''))); root.appendChild(hr);
  Object.entries(BEMODS).sort((a, b) => a[0].localeCompare(b[0])).forEach(([m, v]) => {
    if (!v.direct.length && !(v.app || []).length && !v.groups.length) return;
    const r = document.createElement('div'); r.className = 'md-row';
    const c1 = chipEl(m, 'mono');
    const c2 = chipEl(v.direct.join(' '), 'md-objs');
    const c3 = document.createElement('div'); c3.className = 'cov-tabs'; [...new Set(v.direct.map(o => OBJMAP[o]).filter(Boolean))].forEach(id => c3.appendChild(pillTo(id, 'p-gold')));
    const c4 = document.createElement('div'); c4.className = 'cov-tabs'; v.groups.forEach(g => c4.appendChild(chipEl(g.replace('공통 · ', ''), 'pill p-fn')));
    const c5 = document.createElement('div'); c5.className = 'cov-tabs'; (v.writes || []).forEach(a => c5.appendChild(chipEl(a, 'pill p-app'))); (v.kinds || []).forEach(k => c5.appendChild(chipEl('→ ' + k, 'pill p-kind')));
    const c6 = chipEl(v.ok ? '대응' : '미대응', v.ok ? 'cov-ok' : 'cov-bad', (v.miss || []).join('\n'));
    r.append(c1, c2, c3, c4, c5, c6); root.appendChild(r);
  });
  const gr = document.getElementById('mods-groups');
  Object.entries(GROUP_OBJS).forEach(([g, objs]) => {
    const d = document.createElement('div'); d.className = 'sch-g';
    const h = document.createElement('h4'); h.textContent = g; h.appendChild(chipEl(String(objs.length), '')); d.appendChild(h);
    const p = document.createElement('div'); p.className = 'pills'; [...new Set(objs.map(o => OBJMAP[o]).filter(Boolean))].forEach(id => p.appendChild(pillTo(id, 'p-gold'))); d.appendChild(p);
    const o = chipEl(objs.join(' '), 'md-objs'); d.appendChild(o); gr.appendChild(d);
  });
})();
