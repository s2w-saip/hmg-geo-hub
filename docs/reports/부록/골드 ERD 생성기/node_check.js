// 골드 ERD 전수 대응 검증 (키트 전용, 페이지에는 넣지 않는다).
//   node node_check.js       src 표 정의 + coverage_data.js 로 검증
// 1 ERD 무결성: 참조 대상 · 키 표기 · 탭 배치 · 열 중복 · 골드 밖 참조 없음 · 골드 · 키 묶음만 · 표시하지 않는 필드 없음
// 2 현행 열 → 골드 열 (BE 가 읽는 rd · frz · ext 열 전부)   3 BE 모듈   4 화면 항목 789
const fs = require('fs');
const path = require('path');
const S = __dirname;
const rd = p => fs.readFileSync(path.join(S, p), 'utf8');
const tables = fs.readdirSync(path.join(S, 'src', 'tables')).sort().filter(f => f.endsWith('.js')).map(f => rd('src/tables/' + f)).join('\n');
const app = new Set();
rd('db_cols.tsv').split('\n').forEach(l => { const [sch, rel] = l.split('\t'); if (sch === 'app') app.add(rel); });
const code = tables + '\n' + rd('src/views.js') + '\n' + rd('coverage_data.js') + '\nconst APPSET = new Set(' + JSON.stringify([...app]) + ');\n' + rd('cov_core.js') +
  '\nmodule.exports = { R: validateAll(), T, VIEWS };';
const tmp = path.join(S, `_check_tmp_${process.pid}.js`);
fs.writeFileSync(tmp, code);
let mod;
try { mod = require(tmp); } finally { fs.unlinkSync(tmp); }
const { R, T } = mod;
const SHOWN = ['grain', 'pk', 'inputs', 'triggers', 'uses', 'rules'];
Object.values(T).forEach(t => {
  if (!['gold', 'key', 'ghost'].includes(t.s)) R.erd.push(`${t.id}: 골드 · 키 묶음이 아님 (s=${t.s})`);
  t.cols.forEach(c => { if (c[3] && !T[c[3]]) R.erd.push(`${t.id}.${c[0]} → ${c[3]}: 골드 밖 참조`); });
  const extra = Object.keys(t.d || {}).filter(k => !SHOWN.includes(k));
  if (extra.length) R.erd.push(`${t.id}: 표시하지 않는 필드 ${extra.join(',')}`);
});
console.log('ERD 무결성 오류', R.erd.length); R.erd.forEach(x => console.log('  ', x));
console.log('현행 열', R.col.ok, '/', R.col.n); R.col.bad.forEach(x => console.log('  ', x));
console.log('BE 모듈', R.mod.ok, '/', R.mod.n); R.mod.bad.forEach(x => console.log('  ', x));
console.log('화면 항목', R.feat.ok, '/', R.feat.n); R.feat.bad.slice(0, 200).forEach(x => console.log('  ', x));
process.exit(R.erd.length || R.col.bad.length || R.mod.bad.length || R.feat.bad.length ? 1 : 0);
