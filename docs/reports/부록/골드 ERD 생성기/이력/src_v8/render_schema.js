/* ───────── 스키마 경계 ───────── */
function schemaOf(id) {
  if (typeof id === 'string' && id.startsWith('app.')) return 'app';
  const t = T[id]; if (!t) return null;
  const o = t.ghostOf ? T[t.ghostOf] : t;
  if (o.s === 'app' || o.s === 'applist' || o.fam === 'queue') return 'app';
  return 'gold';
}
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
  const h = document.createElement('h3'); h.textContent = sc.label; if (sc.sub) { const sb = document.createElement('span'); sb.className = 'sub'; sb.textContent = sc.sub; h.appendChild(sb); }
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
  top.append(h, chips); if (sc.desc) top.appendChild(d); p.appendChild(top);

  const grid = document.createElement('div'); grid.className = 'sch-groups';
  const card = (title, n, note) => { const g = document.createElement('div'); g.className = 'sch-g'; const h4 = document.createElement('h4'); h4.textContent = title; const sp = document.createElement('span'); sp.textContent = n; h4.appendChild(sp); g.appendChild(h4); if (note) { const gn = document.createElement('div'); gn.className = 'gn'; gn.textContent = note; g.appendChild(gn); } return g; };
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
  if ((sc.rules || []).length) {
    const rt = document.createElement('div'); rt.className = 'sch-sec'; rt.textContent = '규칙'; p.appendChild(rt);
    const ul = document.createElement('ul'); ul.className = 'sch-rules'; sc.rules.forEach(r => { const li = document.createElement('li'); li.textContent = r; ul.appendChild(li); }); p.appendChild(ul);
  }

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
