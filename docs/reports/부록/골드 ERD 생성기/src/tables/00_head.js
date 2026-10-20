/* ───────── 테이블 정의 ─────────
   cols: [이름, 키(PK|FK|PF|UK|''), 설명, 참조 테이블] · s: gold | key | ghost */
const T = {};
function tbl(id, o) { T[id] = Object.assign({ id, cols: [] }, o); }
function ghost(id, cols) { T[id + '_ref'] = { id: id + '_ref', ghostOf: id, s: 'ghost', name: T[id].name, cols: cols || T[id].cols.filter(c => c[1] === 'PK' || c[1] === 'PF').slice(0, 1).map(c => [c[0], 'PK', '']) }; }
const FAM = { dim: '공통 차원', prompt: '프롬프트·웹 유닛', fact: '답변 사실', kpi: 'KPI·언급 셀', cit: '인용 셀', acr: 'ACR', ga4: 'GA4', kw: '키워드', soc: '소셜', pub: '발행 세대', build: '빌드·릴리스', silver: '답변 원문', vis: 'AI Visibility' };
const ACCEL = '선택 사항입니다. 없으면 사실 테이블에서 조회 때 계산하고, 성능 병목이 확인된 계열부터 적재합니다.';
