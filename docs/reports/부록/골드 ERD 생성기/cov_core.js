// 전수 대응 검증 핵심 (node_check.js 가 src 표 정의 · coverage_data.js 와 함께 읽는다). 페이지에는 넣지 않는다.
/* @cov-core start */
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
