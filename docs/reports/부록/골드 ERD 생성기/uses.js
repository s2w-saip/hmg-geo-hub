// 골드 테이블 → 현행 객체 → 그 객체를 읽는 BE 모듈(직접 · 공통 경로) → 그 모듈을 부르는 화면 항목. 용도(uses) 검증용.
//   node uses.js <골드 테이블 id>
const fs = require('fs');
eval(fs.readFileSync(__dirname + '/coverage_data.js', 'utf8').replace(/^const /gm, 'global.'));
const id = process.argv[2];
const objs = Object.entries(OBJMAP).filter(([o, g]) => g === id).map(([o]) => o);
console.log('현행 객체:', objs.join(', ') || '(없음 · 신규)');
const direct = Object.entries(BEMODS).filter(([m, v]) => v.direct.some(o => objs.includes(o))).map(([m]) => m);
const groups = Object.entries(GROUP_OBJS).filter(([g, os]) => os.some(o => objs.includes(o))).map(([g]) => g);
console.log('직접 읽는 모듈:', direct.join(', ') || '-');
console.log('공통 경로 묶음:', groups.join(', ') || '-');
const viaGroup = Object.entries(BEMODS).filter(([m, v]) => v.groups.some(g => groups.includes(g))).map(([m]) => m);
const feats = FEATURES.filter(f => (f.m || []).some(m => direct.includes(m)) || (f.g || []).some(r => r.split('.')[0] === id));
const byScreen = {};
feats.forEach(f => { (byScreen[f.s + ' ' + f.r] = byScreen[f.s + ' ' + f.r] || []).push(f.l); });
console.log('\n직접 모듈 · 수동 매핑으로 닿는 화면 항목', feats.length);
Object.entries(byScreen).forEach(([s, ls]) => console.log(' ', s, '·', ls.length, '·', ls.slice(0, 8).join(' | ') + (ls.length > 8 ? ' …' : '')));
console.log('\n공통 경로 묶음을 import 하는 모듈 수', viaGroup.length, '(과대 근사: 그 모듈이 이 객체를 실제로 읽는지는 코드 확인)');
