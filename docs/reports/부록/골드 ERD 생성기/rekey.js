// 표기만 바뀐 열 행의 판정 승계 (검토 원장).
// 같은 표에서 키 · 참조가 같고, 새 행의 물리 열(또는 이름 토큰)이 옛 행의 것에 포함되며, 설명이 같거나 비었을 때만 옛 판정을 물려받는다.
//   node rekey.js <html> <옛 원장 폴더> <원장 이름...>   (키트 폴더에서 실행)
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [html, before, ...ledgers] = process.argv.slice(2);
function braces(s) { const m = s.match(/^(.*?)\{([^{}]*)\}(.*)$/); if (!m) return [s]; return m[2].split(',').flatMap(x => braces(m[1] + x.trim() + m[3])); }
const tok = c => Array.isArray(c[4]) ? c[4] : c[0].split(/\s*·\s*/).flatMap(p => p.includes('{') ? braces(p) : [p]).map(x => x.replace(/\[\]$/, ''));
for (const lg of ledgers) {
  const old = JSON.parse(fs.readFileSync(path.join(before, lg + '.json'), 'utf8'));
  const todo = JSON.parse(cp.execFileSync('node', ['review.js', 'todo', html, lg], { encoding: 'utf8', maxBuffer: 1 << 26 }));
  const dec = {}, left = [];
  for (const e of todo) {
    const m = e.k.match(/^T:([a-z0-9_]+):col:\d+$/);
    if (!m) { left.push(e.k); continue; }
    const nc = JSON.parse(e.t), nt = tok(nc);
    const cand = Object.entries(old).filter(([k]) => k.startsWith(`T:${m[1]}:col:`)).map(([k, v]) => ({ k, v, c: JSON.parse(v.t) }))
      .filter(o => o.c[1] === nc[1] && (o.c[3] || '') === (nc[3] || '') && (nc[2] === o.c[2] || !nc[2]) && nt.every(x => tok(o.c).includes(x)));
    if (cand.length !== 1) { left.push(e.k + ` (후보 ${cand.length})`); continue; }
    const o = cand[0];
    dec[e.k] = { v: o.v.v, e: o.v.e + (o.v.e.includes('표기 정리') ? '' : ' · 표기 정리(물리 열 같음)') };
    console.log(lg, e.k, '←', o.k, JSON.stringify(o.c[0]), '→', JSON.stringify(nc[0]));
  }
  if (Object.keys(dec).length) {
    const f = path.join(require('os').tmpdir(), `rekey_${lg}.json`);
    fs.writeFileSync(f, JSON.stringify(dec));
    console.log(cp.execFileSync('node', ['review.js', 'put', html, lg, f], { encoding: 'utf8' }).trim());
  }
  if (left.length) console.log(lg, '승계 못 함:', left.join(', '));
}
