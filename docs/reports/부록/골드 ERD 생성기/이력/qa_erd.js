// ERD 내부 정합성 점검: FK 대상, PK 표기, 탭 배치, 고스트, 개수 주장
const d = require('./erd_data.json');
const T = d.T, V = d.VIEWS;
const real = Object.values(T).filter(t => !t.ghostOf);
const out = (k, ...a) => console.log(k, ...a);

// 1. FK target existence
real.forEach(t => t.cols.forEach(c => {
  const ref = c[3]; if (!ref) return;
  if (ref.startsWith('app.')) return;
  if (!T[ref]) out('FK_MISSING', t.id, c[0], '->', ref);
}));
// 2. FK flag without ref, ref without FK flag
real.forEach(t => t.cols.forEach(c => {
  if ((c[1] === 'FK' || c[1] === 'PF') && !c[3] && t.s !== 'key') out('FK_NO_TARGET', t.id, c[0], c[1]);
  if (c[3] && !['FK', 'PF'].includes(c[1])) out('REF_NOT_FLAGGED', t.id, c[0], c[1] || '(none)', '->', c[3]);
}));
// 3. PK text vs columns flagged PK/PF
real.forEach(t => {
  if (!t.d || t.s === 'key' || t.s === 'applist') return;
  const flagged = t.cols.filter(c => c[1] === 'PK' || c[1] === 'PF').map(c => c[0]);
  if (!flagged.length) out('NO_PK_COL', t.id, 'pk text:', t.d.pk);
  const uk = t.cols.filter(c => c[1] === 'UK').map(c => c[0]);
  if (/유일|UK/.test(t.d.pk || '') && !uk.length) out('PK_TEXT_MENTIONS_UNIQUE_NO_UK', t.id, t.d.pk);
});
// 4. tables not placed in any view / views referencing unknown ids
const placed = new Set(); V.forEach(v => Object.keys(v.pos).forEach(id => { if (!T[id]) out('VIEW_UNKNOWN_ID', v.id, id); placed.add(id); }));
real.forEach(t => { if (!placed.has(t.id)) out('NOT_IN_ANY_VIEW', t.id, t.s); });
// 5. FK edges whose target isn't on the same view (drawn nowhere)
V.forEach(v => {
  const ids = Object.keys(v.pos);
  ids.forEach(id => {
    const t = T[id]; if (t.ghostOf) return;
    t.cols.forEach(c => {
      const ref = c[3]; if (!ref || ref.startsWith('app.')) return;
      const onView = ids.includes(ref) || ids.includes(ref + '_ref') || ids.some(x => T[x] && T[x].ghostOf === ref);
      if (!onView && HOME(id) === v.id) out('EDGE_TARGET_OFF_VIEW', v.id, id + '.' + c[0], '->', ref);
    });
  });
});
function HOME(id) { for (const v of V) if (v.pos[id] && !T[id].ghostOf) return v.id; }
// 6. tables with `uses` missing
real.forEach(t => { if (t.d && !t.d.uses && t.s === 'gold') out('NO_USES', t.id); });
// 7. counts
const gold = real.filter(t => t.s === 'gold').length;
out('COUNT gold', gold, 'app', real.filter(t => t.s === 'app').length, 'key', real.filter(t => t.s === 'key').length);
out('COUNT views', V.length, 'non-app views', V.filter(v => v.g !== 'app').length);
// 8. ITEMS per family (matrix FAMOF)
const FAMOF = { '답변': ['kpi'], '언급': ['kpi'], '언급+감정': ['kpi'], '엔티티': ['kpi'], '인용': ['cit'], '인용+자사': ['cit'], '인용+감정': ['cit'], '도메인': ['cit'], '언급+인용': ['kpi', 'cit'], 'KPI 전체': ['kpi', 'cit'], 'ACR': ['acr'], 'GA4': ['ga4'], '키워드': ['kw'], '소셜': ['soc'], '프롬프트 연결': ['dim'] };
const cnt = {}; let n = 0; const unk = new Set(); const sCnt = {};
d.ITEMS.forEach(s => s.items.forEach(i => { n++; sCnt[i.s] = (sCnt[i.s] || 0) + 1; if (i.g) { cnt.silver = (cnt.silver || 0) + 1; return; } const f = FAMOF[i.s]; if (!f) unk.add(i.s); (f || []).forEach(x => cnt[x] = (cnt[x] || 0) + 1); }));
out('ITEMS total', n, 'matrix counts', JSON.stringify(cnt), 'unknown s', [...unk]);
out('ITEMS by s', JSON.stringify(sCnt));
// 9. self-described column dup names across table (same col twice)
real.forEach(t => { const seen = {}; t.cols.forEach(c => c[0].split(/\s*·\s*/).forEach(p => { if (seen[p]) out('DUP_COL', t.id, p); seen[p] = 1; })); });
// 10. naming consistency of build_id presence in gold facts
const gf = ['job_index','answer_fact','answer_brand_fact','answer_stance_fact','citation_fact','catalog_entry','acr_cell_fact','acr_entity_fact','acr_cell_job','kpi_cell','kpi_rollup','brand_cell','citation_cell','url_prompt_cell','report_value','page_visibility_daily','page_crawl_daily'];
gf.forEach(id => { const t = T[id]; const has = t.cols.some(c => /\bbuild_id\b/.test(c[0])) || t.cols.some(c => c[3] === 'cell_key'); if (!has) out('GOLD_FACT_NO_BUILD', id); });
// cell_key-based PK includes build? kpi_cell PK = C(11)+perspective
['kpi_cell','brand_cell','citation_cell','url_prompt_cell','kpi_rollup'].forEach(id => out('CELL_PK', id, T[id].d.pk));
// 11. tables whose cur says '없음' (new)
real.forEach(t => { if (t.d && /^없음/.test(t.d.cur || '')) out('NEW_TABLE', t.id, '|', t.d.cur); });
