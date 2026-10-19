// 최종 HTML 의 <script> 에서 데이터 + @cov-core 만 떼어 node 로 같은 검증을 돌린다.
const fs = require('fs');
const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');
const sc = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
const dataEnd = sc.indexOf('/* ───────── 렌더 ───────── */');
const data = sc.slice(0, dataEnd);
const grab = (name) => { const m = sc.match(new RegExp('^const ' + name + ' = [\\s\\S]*?^\\];', 'm')); if (!m) throw new Error('no ' + name); return m[0]; };
const core = sc.slice(sc.indexOf('/* @cov-core start */'), sc.indexOf('/* @cov-core end */'));
const covData = sc.slice(sc.indexOf('/* @cov-data start */'), sc.indexOf('/* @cov-data end */'));
const code = data + '\n' + covData + '\n' + grab('APP_GROUPS') + '\n' + core + '\nmodule.exports = { R: validateAll(), T, FEATURES, COLMAP, BEMODS, NEWREQ, colsOf };';
fs.writeFileSync(__dirname + '/_check_tmp.js', code);
const { R, FEATURES: F, NEWREQ: N } = require('./_check_tmp.js');
console.log('ERD 무결성 오류', R.erd.length); R.erd.forEach(x => console.log('  ', x));
console.log('현행 열', R.col.ok, '/', R.col.n); R.col.bad.forEach(x => console.log('  ', x));
console.log('BE 모듈', R.mod.ok, '/', R.mod.n); R.mod.bad.forEach(x => console.log('  ', x));
console.log('화면 항목', R.feat.ok, '/', R.feat.n); R.feat.bad.slice(0, 200).forEach(x => console.log('  ', x));
console.log('신규 요청', N.length);
process.exit(R.erd.length || R.col.bad.length || R.mod.bad.length || R.feat.bad.length ? 1 : 0);
