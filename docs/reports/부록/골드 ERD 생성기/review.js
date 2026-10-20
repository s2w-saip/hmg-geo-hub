// 검토 원장: 빌드한 페이지의 모든 표시 요소를 뽑아 검토/*.json 의 판정 · 근거와 대조한다.
//   node review.js check <html>         요소 전수 대조 (미검토 · 변경 후 미검토 · 근거 형식) → 0 이어야 통과
//   node review.js todo <html> <원장>   그 원장 파일에서 아직 검토가 필요한 요소만 출력 (JSON)
//   node review.js stats <html>         원장 파일별 요소 수
// 원장 항목: { "<키>": { "t": 요소 텍스트, "v": "cur|des|dec|lbl", "e": 근거 } }
//   cur 현행 사실 — 근거: 레포 경로:줄 · db:스키마.객체[.열] · sql: … 중 하나 이상
//   des 설계(골드 신규 · 변경) — 근거: 요구 출처(화면 · 결정 · 사용자 지시 · NEWREQ)
//   dec 회의 결정 — 근거: 회의록 경로 + 결정 ID
//   lbl 표기 · 라벨 · 계산으로 채우는 자리 — 근거 생략 가능
const fs = require('fs');
const path = require('path');
const S = __dirname;
const LEDGER = path.join(S, '검토');

function loadPage(file) {
  const html = fs.readFileSync(file, 'utf8');
  const sc = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'));
  const dataEnd = sc.indexOf('/* ───────── 렌더 ───────── */');
  const layer = (sc.match(/^const LAYER = .*$/m) || [''])[0];
  const code = sc.slice(0, dataEnd) + '\n' + layer + '\nmodule.exports = { T, VIEWS, FAM, ACCEL, LAYER };';
  const tmp = path.join(S, `_review_tmp_${process.pid}.js`);
  fs.writeFileSync(tmp, code);
  delete require.cache[require.resolve(tmp)];
  const D = require(tmp);
  fs.unlinkSync(tmp);
  return { html, sc, D };
}

// 표 id → 원장 파일 (표 정의 파일 이름을 따른다)
function tableFiles() {
  const dir = path.join(S, 'src', 'tables'), m = {};
  for (const f of fs.readdirSync(dir)) {
    const s = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const x of s.matchAll(/\btbl\('([a-z0-9_]+)'/g)) m[x[1]] = f.replace(/\.js$/, '');
    for (const x of s.matchAll(/\bghost\('([a-z0-9_]+)'/g)) m[x[1] + '_ref'] = f.replace(/\.js$/, '');
  }
  return m;
}

// 페이지 정적 HTML · JS 문자열의 한글 표시 문구
function htmlTexts(html) {
  const body = html.slice(html.indexOf('<body>'), html.indexOf('<script>'));
  const out = new Set();
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1]; if (title) out.add(title);
  for (const m of body.matchAll(/>([^<>]+)</g)) { const t = m[1].replace(/\s+/g, ' ').trim(); if (t) out.add(t); }
  for (const m of body.matchAll(/\b(?:aria-label|placeholder|title)="([^"]+)"/g)) out.add(m[1]);
  return [...out];
}
function jsTexts(sc) {
  const start = sc.indexOf('/* ───────── 렌더 ───────── */');
  const code = sc.slice(start);
  const out = new Set();
  // 문자열 리터럴 중 한글이 든 것 (주석 제외: 줄 주석 · 블록 주석 제거)
  const noCom = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  for (const m of noCom.matchAll(/'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const s = (m[1] ?? m[2] ?? '');
    if (/[가-힣]/.test(s)) out.add(s);
  }
  return [...out];
}

function elements(file) {
  const { html, sc, D } = loadPage(file);
  const tf = tableFiles();
  const E = []; // { k, f, t }
  const add = (f, k, t) => { if (t === undefined || t === null || t === '') return; E.push({ k, f, t: typeof t === 'string' ? t : JSON.stringify(t) }); };
  for (const [id, t] of Object.entries(D.T)) {
    const f = tf[id] || '??';
    if (t.ghostOf) { add(f, `T:${id}:ghost`, { name: t.name, cols: t.cols.map(c => c.slice(0, 4)) }); continue; }
    add(f, `T:${id}:head`, { name: t.name, s: t.s, fam: t.fam, grain: t.grain });
    t.cols.forEach((c, i) => add(f, `T:${id}:col:${i}`, c));
    const d = t.d || {};
    ['grain', 'pk', 'inputs', 'triggers', 'uses'].forEach(x => add(f, `T:${id}:${x}`, d[x]));
    (d.rules || []).forEach((r, i) => add(f, `T:${id}:rule:${i}`, r));
  }
  D.VIEWS.forEach(v => { add('views', `V:${v.id}`, { g: v.g, label: v.label, main: v.main }); add('views', `V:${v.id}:note`, v.note); (v.derive || []).forEach((x, i) => add('views', `V:${v.id}:derive:${i}`, x)); });
  add('page', 'K:FAM', D.FAM); add('page', 'K:ACCEL', D.ACCEL); add('page', 'K:LAYER', D.LAYER);
  htmlTexts(html).forEach(t => add('page', `H:${t}`, t));
  jsTexts(sc).forEach(t => add('page', `J:${t}`, t));
  return E;
}

function loadLedger() {
  const L = {};
  if (!fs.existsSync(LEDGER)) return L;
  for (const f of fs.readdirSync(LEDGER)) {
    if (!f.endsWith('.json')) continue;
    const j = JSON.parse(fs.readFileSync(path.join(LEDGER, f), 'utf8'));
    for (const [k, v] of Object.entries(j)) L[k] = { ...v, file: f.replace(/\.json$/, '') };
  }
  return L;
}

const EVID = /([A-Za-z0-9_\-./가-힣 ]+\.(py|ts|tsx|js|sql|md|json|html)(:\d+)?)|\bdb:|\bsql:/;
function judge(e, L) {
  const x = L[e.k];
  if (!x) return '미검토';
  if (x.t !== e.t) return '변경 후 미검토';
  if (!['cur', 'des', 'dec', 'lbl'].includes(x.v)) return '판정 값 오류';
  if (x.v === 'cur' && !EVID.test(x.e || '')) return '현행 근거 없음';
  if (x.v === 'dec' && !/\d{8}\/[A-Z]\d+|D\d{2}|A\d{2}/.test(x.e || '')) return '결정 근거 없음';
  if (x.v === 'des' && !(x.e || '').trim()) return '설계 근거 없음';
  return '';
}

const [cmd, file, arg] = process.argv.slice(2);
const E = elements(file);
const L = loadLedger();
if (cmd === 'put') {
  // node review.js put <html> <원장> <판정.json>   판정.json = { "<키>": { "v": "...", "e": "..." } } → t 는 현재 요소 텍스트로 채운다
  const dec = JSON.parse(fs.readFileSync(process.argv[5], 'utf8'));
  const lf = path.join(LEDGER, arg + '.json');
  const cur = fs.existsSync(lf) ? JSON.parse(fs.readFileSync(lf, 'utf8')) : {};
  const byK = Object.fromEntries(E.map(e => [e.k, e]));
  const miss = [];
  for (const [k, x] of Object.entries(dec)) {
    const e = byK[k]; if (!e) { miss.push(k); continue; }
    if (e.f !== arg) { miss.push(k + ' (원장 ' + e.f + ')'); continue; }
    cur[k] = { t: e.t, v: x.v, e: x.e || '' };
  }
  for (const k of Object.keys(cur)) if (!byK[k]) delete cur[k];
  const sorted = Object.fromEntries(E.filter(e => cur[e.k]).map(e => [e.k, cur[e.k]]));
  fs.mkdirSync(LEDGER, { recursive: true });
  fs.writeFileSync(lf, JSON.stringify(sorted, null, 1) + '\n');
  console.log('저장', Object.keys(sorted).length, '없는 키', miss.length); miss.forEach(k => console.log('  ', k));
  process.exit(miss.length ? 1 : 0);
} else if (cmd === 'todo') {
  const out = E.filter(e => e.f === arg).filter(e => judge(e, L)).map(e => ({ k: e.k, t: e.t, why: judge(e, L), prev: L[e.k] || null }));
  console.log(JSON.stringify(out, null, 1));
} else if (cmd === 'stats') {
  const by = {}; E.forEach(e => { by[e.f] = (by[e.f] || 0) + 1; }); console.log(by, E.length);
} else {
  const bad = E.map(e => ({ e, why: judge(e, L) })).filter(x => x.why);
  const keys = new Set(E.map(e => e.k));
  const stale = Object.keys(L).filter(k => !keys.has(k));
  const v = {}; E.forEach(e => { const x = L[e.k]; if (x && !judge(e, L)) v[x.v] = (v[x.v] || 0) + 1; });
  console.log('요소', E.length, '검토 완료', E.length - bad.length, v);
  const by = {}; bad.forEach(x => { const k = x.e.f + ' · ' + x.why; by[k] = (by[k] || 0) + 1; });
  Object.entries(by).forEach(([k, n]) => console.log('  ', k, n));
  if (stale.length) console.log('원장에만 있는 키(삭제된 요소)', stale.length);
  fs.writeFileSync(path.join(S, '_review_summary.json'), JSON.stringify({ n: E.length, ok: E.length - bad.length, v }));
  process.exit(bad.length || stale.length ? 1 : 0);
}
