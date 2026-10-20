
const ITEMS = [{"screen":"Global > Overview","items":[{"n":"AI 노출률","k":"지표","g":false,"s":"언급"},{"n":"AI 점유율","k":"지표","g":false,"s":"언급"},{"n":"AI 우호도","k":"지표","g":false,"s":"언급+감정"},{"n":"AI 우선 노출도","k":"지표","g":false,"s":"언급"},{"n":"AI 인용 점유율","k":"지표","g":false,"s":"인용+자사"},{"n":"경쟁사 미니 행 (카드 ①~④)","k":"기능","g":false,"s":"언급+감정"},{"n":"카드 ⑤ 경쟁사 행","k":"기능","g":false,"s":"인용+자사"},{"n":"국가별 GEO 현황","k":"기능","g":false,"s":"언급+감정"}]},{"screen":"Global > Answer analysis > Mention","items":[{"n":"AI 노출률","k":"지표","g":false,"s":"언급"},{"n":"AI 점유율","k":"지표","g":false,"s":"언급"},{"n":"AI 우호도 · 긍정 신호 비율","k":"지표","g":false,"s":"언급+감정"},{"n":"AI 우호도 · 부정 신호 비율","k":"지표","g":false,"s":"언급+감정"},{"n":"AI 우선 노출도","k":"지표","g":false,"s":"언급"},{"n":"경쟁사 분석 표","k":"기능","g":false,"s":"언급"},{"n":"AI 엔진별","k":"기능","g":false,"s":"언급+감정"},{"n":"멘션 유형별","k":"기능","g":false,"s":"언급+감정"},{"n":"감정 분포 · 신호 프롬프트","k":"기능","g":false,"s":"언급+감정"},{"n":"멘션 유형별 감정 분포","k":"기능","g":false,"s":"언급+감정"},{"n":"주별 브랜드 언급 수","k":"기능","g":false,"s":"언급"},{"n":"브랜드 언급 순위","k":"기능","g":false,"s":"언급+감정"},{"n":"행 드릴다운 · 프롬프트","k":"기능","g":true,"s":"언급"},{"n":"행 드릴다운 · 인용 출처","k":"기능","g":false,"s":"언급+인용"},{"n":"답변 모달","k":"기능","g":true,"s":"언급+인용"}]},{"screen":"Global > Answer analysis > Citation","items":[{"n":"공식(HMG) 인용 비중","k":"지표","g":false,"s":"인용"},{"n":"딜러·마켓 인용 비중","k":"지표","g":false,"s":"인용"},{"n":"공식(당사) URL 인용 프롬프트","k":"지표","g":false,"s":"인용+자사"},{"n":"공식(당사) URL 미인용 프롬프트","k":"지표","g":false,"s":"인용+자사"},{"n":"긍정 답변에 인용된 URL","k":"지표","g":false,"s":"인용+감정"},{"n":"부정 답변에 인용된 URL","k":"지표","g":false,"s":"인용+감정"},{"n":"출처 카테고리별 현황","k":"기능","g":false,"s":"인용"},{"n":"엔진별 출처 카테고리 구성","k":"기능","g":false,"s":"인용"},{"n":"멘션 유형별 출처 카테고리 구성","k":"기능","g":false,"s":"인용+감정"},{"n":"주별 상위 10개 도메인 인용 수","k":"기능","g":false,"s":"인용"},{"n":"도메인 인용 순위","k":"기능","g":false,"s":"인용"},{"n":"행 드릴다운 · 인용 URL·프롬프트 · 답변 모달","k":"기능","g":true,"s":"언급+인용"}]},{"screen":"Global > Answer analysis > Citation > 공식 도메인 인용 프롬프트","items":[{"n":"인용 프롬프트","k":"지표","g":false,"s":"인용"},{"n":"미인용 프롬프트","k":"지표","g":false,"s":"인용"},{"n":"프롬프트 목록 (검색·50행 페이지)","k":"기능","g":true,"s":"인용+자사"},{"n":"답변 모달 (인용 variant, 행별 답변 순회·본문)","k":"기능","g":true,"s":"언급+인용"}]},{"screen":"Global > Answer analysis > Citation > 긍정/부정 답변 인용 URL","items":[{"n":"긍정 답변 인용 URL","k":"지표","g":false,"s":"인용+감정"},{"n":"부정 답변 인용 URL","k":"지표","g":false,"s":"인용+감정"},{"n":"인용 URL/도메인 목록 (검색·50행 페이지)","k":"기능","g":false,"s":"인용+감정"}]},{"screen":"Global > AI Agent Funnel > ACR","items":[{"n":"Top1 ACR","k":"지표","g":false,"s":"ACR"},{"n":"Top5 ACR","k":"지표","g":false,"s":"ACR"},{"n":"답변 수","k":"지표","g":false,"s":"ACR"},{"n":"1순위 횟수","k":"지표","g":false,"s":"ACR"},{"n":"측정 프롬프트 수","k":"지표","g":false,"s":"ACR"},{"n":"측정 셀 수","k":"지표","g":false,"s":"ACR"},{"n":"측정 반복 수","k":"지표","g":false,"s":"ACR"},{"n":"브랜드별 ACR 표 (Top1·후보군 포함율·최종 선택·언급 수)","k":"기능","g":false,"s":"ACR"},{"n":"선택률 추이 (일별, 당사+주요 경쟁사 5)","k":"기능","g":false,"s":"ACR"},{"n":"모델별 선택 구도 (배틀 그리드, 30개 + 더 보기)","k":"기능","g":false,"s":"ACR"},{"n":"차종별 선택 전환율 표","k":"기능","g":false,"s":"ACR"},{"n":"모델별 점유 맵 (지역×엔진 시트 탭)","k":"기능","g":false,"s":"ACR"}]},{"screen":"Global > AI Agent Funnel > AI Conversion","items":[{"n":"AI 유입 전환율","k":"지표","g":false,"s":"GA4"},{"n":"일반 유입 전환율","k":"지표","g":false,"s":"GA4"},{"n":"전환 격차","k":"지표","g":false,"s":"GA4"},{"n":"ChatGPT 전환","k":"지표","g":false,"s":"GA4"},{"n":"Gemini 전환","k":"지표","g":false,"s":"GA4"},{"n":"AI 유입 사이트 방문 수 · 방문 수","k":"지표","g":false,"s":"GA4"},{"n":"AI 유입 사이트 방문 수 · 순 방문자","k":"지표","g":false,"s":"GA4"},{"n":"AI 유입 사이트 방문 수 · 방문 빈도","k":"지표","g":false,"s":"GA4"},{"n":"전환율 · 방문 수 추이","k":"기능","g":false,"s":"GA4"},{"n":"페이지별 전환 표","k":"기능","g":false,"s":"GA4"},{"n":"측정 커버리지 줄 · 국가별 전환 표","k":"기능","g":false,"s":"GA4"}]},{"screen":"Global > Customer interest > Google keywords","items":[{"n":"평균 관심도","k":"지표","g":false,"s":"키워드"},{"n":"SERP 표 + 제안 프롬프트(후보 추가 버튼 비활성) + 재생성","k":"기능","g":true,"s":"키워드"},{"n":"관련 검색어 표","k":"기능","g":true,"s":"키워드"}]},{"screen":"Website > Overview","items":[{"n":"AI 노출률","k":"지표","g":false,"s":"언급"},{"n":"AI 점유율","k":"지표","g":false,"s":"언급"},{"n":"AI 우호도","k":"지표","g":false,"s":"언급+감정"},{"n":"AI 우선 노출도","k":"지표","g":false,"s":"언급"},{"n":"AI 인용 점유율","k":"지표","g":false,"s":"인용+자사"},{"n":"경쟁사 SOV 비교","k":"지표","g":false,"s":"언급"},{"n":"자사 URL 인용률","k":"지표","g":false,"s":"인용+자사"},{"n":"타겟 URL 인용률","k":"지표","g":false,"s":"인용+자사"},{"n":"AI 타겟 출처 인용률","k":"지표","g":false,"s":"인용+자사"},{"n":"KPI 추이 차트(①~⑤ + ⑥ 선)","k":"기능","g":false,"s":"KPI 전체"},{"n":"인용 출처 구성 도넛(상위 7 + 기타)","k":"기능","g":false,"s":"인용"},{"n":"시장별 경쟁 위치(GEO)","k":"기능","g":false,"s":"언급+감정"}]},{"screen":"Website > Prompts","items":[{"n":"프롬프트 표(서버 페이징 50 · 정렬 · 검색 · 측정 횟수·최근 측정·엔진)","k":"기능","g":true,"s":"답변"}]},{"screen":"Website > Answer analysis > Mention","items":[{"n":"전체 언급 수","k":"지표","g":false,"s":"언급"},{"n":"언급 브랜드 수","k":"지표","g":false,"s":"언급"},{"n":"측정 프롬프트 수","k":"지표","g":false,"s":"답변"},{"n":"미언급 프롬프트 수","k":"지표","g":false,"s":"언급"},{"n":"복수 언급 답변 수","k":"지표","g":false,"s":"언급"},{"n":"Top 3 노출 비율","k":"지표","g":false,"s":"언급"},{"n":"헤드투헤드 비교(당사 합산 vs 자동 SOV 1위·수동 선택)","k":"지표","g":false,"s":"언급"},{"n":"긍정 키워드 언급 수","k":"지표","g":false,"s":"언급+감정"},{"n":"부정 키워드 언급 수","k":"지표","g":false,"s":"언급+감정"},{"n":"멘션 유형(유형 합계 · 유형×브랜드 점유)","k":"기능","g":false,"s":"언급+감정"},{"n":"신호 발생 프롬프트 목록(→ 답변 모달)","k":"기능","g":true,"s":"언급+감정"},{"n":"주별 브랜드 언급 수(당사 + 상위 10)","k":"기능","g":false,"s":"언급"},{"n":"브랜드 언급 순위(검색·정렬, 전 브랜드)","k":"기능","g":false,"s":"언급"},{"n":"브랜드별 언급 프롬프트·답변 참조","k":"기능","g":true,"s":"언급"},{"n":"브랜드 언급 답변의 인용 도메인","k":"기능","g":false,"s":"언급+인용"},{"n":"답변 모달(원문·인용·언급 배지)","k":"기능","g":true,"s":"언급+인용"}]},{"screen":"Website > Answer analysis > Citation","items":[{"n":"전체 인용 수","k":"지표","g":false,"s":"인용"},{"n":"인용 도메인 수","k":"지표","g":false,"s":"인용"},{"n":"출처 분류 수","k":"지표","g":false,"s":"인용"},{"n":"공식 (당사) 인용 비중","k":"지표","g":false,"s":"인용+자사"},{"n":"딜러·마켓 인용 비중","k":"지표","g":false,"s":"인용"},{"n":"자사 URL 인용률","k":"지표","g":false,"s":"인용+자사"},{"n":"타겟 URL 인용률","k":"지표","g":false,"s":"인용+자사"},{"n":"Owned base 인용 프롬프트","k":"지표","g":false,"s":"인용+자사"},{"n":"Owned base 미인용 프롬프트","k":"지표","g":false,"s":"인용+자사"},{"n":"주별 상위 10개 도메인 인용 수","k":"기능","g":false,"s":"인용"},{"n":"출처 카테고리 구성 추이(100% 누적 면적)","k":"기능","g":false,"s":"인용"},{"n":"분류별 인용 도넛(슬라이스 클릭 = 출처 필터 토글)","k":"기능","g":false,"s":"인용"},{"n":"엔진별 출처 카테고리 구성","k":"기능","g":false,"s":"인용"},{"n":"도메인 인용 순위(검색·정렬은 브라우저, 전 행 렌더)","k":"기능","g":false,"s":"인용"},{"n":"인용 URL · 인용 프롬프트 · 답변 모달","k":"기능","g":true,"s":"언급+인용"}]},{"screen":"Website > AI Agent Funnel > AI Conversion","items":[{"n":"AI 유입 전환율","k":"지표","g":false,"s":"GA4"},{"n":"일반 유입 전환율","k":"지표","g":false,"s":"GA4"},{"n":"전환 격차","k":"지표","g":false,"s":"GA4"},{"n":"권역·본사 · AI 유입 전환율","k":"지표","g":false,"s":"GA4"},{"n":"권역·본사 · 일반 유입 전환율","k":"지표","g":false,"s":"GA4"},{"n":"권역·본사 · 전환 격차","k":"지표","g":false,"s":"GA4"},{"n":"AI 유입 사이트 방문 수 · 방문 수","k":"지표","g":false,"s":"GA4"},{"n":"AI 유입 사이트 방문 수 · 순 방문자","k":"지표","g":false,"s":"GA4"},{"n":"AI 유입 사이트 방문 수 · 방문 빈도","k":"지표","g":false,"s":"GA4"}]},{"screen":"Website > AI Agent Funnel > ACR","items":[{"n":"Top1 ACR","k":"지표","g":false,"s":"ACR"},{"n":"Top5 ACR","k":"지표","g":false,"s":"ACR"},{"n":"답변 수","k":"지표","g":false,"s":"ACR"},{"n":"1순위 횟수","k":"지표","g":false,"s":"ACR"}]},{"screen":"Project > (프로젝트) > Dashboard","items":[{"n":"AI 노출률","k":"지표","g":false,"s":"언급"},{"n":"AI 점유율","k":"지표","g":false,"s":"언급"},{"n":"AI 우호도","k":"지표","g":false,"s":"언급+감정"},{"n":"AI 우선 노출도","k":"지표","g":false,"s":"언급"},{"n":"AI 인용 점유율","k":"지표","g":false,"s":"인용+자사"},{"n":"AI 타겟 출처 인용률","k":"지표","g":false,"s":"인용+자사"},{"n":"경쟁사 SOV 비교","k":"지표","g":false,"s":"언급"},{"n":"AI 유입 전환율","k":"지표","g":false,"s":"GA4"},{"n":"엔진 간 일관성 배지","k":"기능","g":false,"s":"언급+감정"},{"n":"KPI 추이 차트 (주 버킷)","k":"기능","g":false,"s":"KPI 전체"},{"n":"구성 (#21 주제별 프롬프트 · #22 출처 도메인)","k":"기능","g":false,"s":"언급+인용"}]},{"screen":"Project > (프로젝트) > Analysis > Mention","items":[{"n":"전체 언급 수","k":"지표","g":false,"s":"언급"},{"n":"언급 브랜드 수","k":"지표","g":false,"s":"언급"},{"n":"측정 프롬프트 수","k":"지표","g":false,"s":"답변"},{"n":"미언급 프롬프트 수","k":"지표","g":false,"s":"언급"},{"n":"복수 언급 답변 수","k":"지표","g":false,"s":"언급"},{"n":"Top 3 노출 비율","k":"지표","g":false,"s":"언급"},{"n":"긍정 신호 수","k":"지표","g":false,"s":"언급+감정"},{"n":"부정 신호 수","k":"지표","g":false,"s":"언급+감정"},{"n":"당사 vs 경쟁사 헤드투헤드","k":"기능","g":false,"s":"언급+감정"},{"n":"신호 프롬프트 다이얼로그","k":"기능","g":true,"s":"언급+감정"},{"n":"주별 브랜드 언급 추이","k":"기능","g":false,"s":"언급"},{"n":"브랜드 언급 순위표","k":"기능","g":false,"s":"언급+감정"},{"n":"행 드릴다운 · 프롬프트 탭","k":"기능","g":true,"s":"언급"},{"n":"행 드릴다운 · 인용 출처 탭","k":"기능","g":false,"s":"언급+인용"},{"n":"답변 모달","k":"기능","g":true,"s":"언급+인용"}]},{"screen":"Project > (프로젝트) > Analysis > Citation","items":[{"n":"전체 인용 수","k":"지표","g":false,"s":"인용"},{"n":"인용 도메인 수","k":"지표","g":false,"s":"인용"},{"n":"출처 분류 수","k":"지표","g":false,"s":"인용"},{"n":"공식 (당사) 인용 비중","k":"지표","g":false,"s":"인용+자사"},{"n":"딜러·마켓 인용 비중","k":"지표","g":false,"s":"인용"},{"n":"Owned base 인용 프롬프트","k":"지표","g":false,"s":"인용+자사"},{"n":"Owned base 미인용 프롬프트","k":"지표","g":false,"s":"인용+자사"},{"n":"주별 상위 도메인 인용 추이","k":"기능","g":false,"s":"인용"},{"n":"출처 카테고리 구성 추이","k":"기능","g":false,"s":"인용"},{"n":"출처 카테고리 도넛","k":"기능","g":false,"s":"인용"},{"n":"엔진별 출처 카테고리 구성","k":"기능","g":false,"s":"인용"},{"n":"도메인 인용 순위 표","k":"기능","g":false,"s":"인용"},{"n":"행 드릴다운 · 인용 URL / 프롬프트","k":"기능","g":true,"s":"인용"},{"n":"답변 모달","k":"기능","g":true,"s":"언급+인용"}]},{"screen":"Project > (프로젝트) > AI Agent Funnel > AI Conversion","items":[{"n":"AI 유입 전환율","k":"지표","g":false,"s":"GA4"},{"n":"일반 유입 전환율","k":"지표","g":false,"s":"GA4"},{"n":"전환 격차","k":"지표","g":false,"s":"GA4"},{"n":"AI 유입 사이트 방문 수 · 방문 수","k":"지표","g":false,"s":"GA4"},{"n":"AI 유입 사이트 방문 수 · 순 방문자","k":"지표","g":false,"s":"GA4"},{"n":"AI 유입 사이트 방문 수 · 방문 빈도","k":"지표","g":false,"s":"GA4"},{"n":"전환율 · 방문 수 추이","k":"기능","g":false,"s":"GA4"},{"n":"AI 모델(엔진)별 전환 (표본 부족 배지)","k":"기능","g":false,"s":"GA4"},{"n":"페이지별 전환 표 (상위 12, 정렬)","k":"기능","g":false,"s":"GA4"}]},{"screen":"Project > Prompt","items":[{"n":"영향받는 답변 수","k":"지표","g":false,"s":"답변"},{"n":"영향받는 언급 수","k":"지표","g":false,"s":"언급"},{"n":"영향받는 인용 수","k":"지표","g":false,"s":"인용"}]},{"screen":"Project > Intent > Google Keyword","items":[{"n":"평균 관심도","k":"지표","g":false,"s":"키워드"},{"n":"발견 검색어 수","k":"지표","g":false,"s":"키워드"},{"n":"SERP 표(순위·제목/URL·스니펫·제안 프롬프트, 정렬) + 재생성","k":"기능","g":true,"s":"키워드"}]},{"screen":"Project > Intent > Social Scraping","items":[{"n":"구매 맥락 수","k":"지표","g":false,"s":"소셜"},{"n":"구매 조건 수","k":"지표","g":false,"s":"소셜"},{"n":"관계 수","k":"지표","g":false,"s":"소셜"},{"n":"출처 도메인 수","k":"지표","g":false,"s":"소셜"},{"n":"상세 언급 수","k":"지표","g":false,"s":"소셜"},{"n":"구매 맥락 표(테마·관점 분포·연결 수·언급 수, 검색·정렬·페이지)","k":"기능","g":false,"s":"소셜"},{"n":"구매 조건 표(카테고리·관점·연결 수·언급 수)","k":"기능","g":false,"s":"소셜"},{"n":"조합 패턴 표(조건 A×B·동시출현·빈도 등급)","k":"기능","g":false,"s":"소셜"}]},{"screen":"Admin > Keyword tools","items":[{"n":"키워드 수","k":"지표","g":false,"s":"키워드"},{"n":"평균 검색량","k":"지표","g":false,"s":"키워드"},{"n":"총 검색량","k":"지표","g":false,"s":"키워드"},{"n":"고볼륨","k":"지표","g":false,"s":"키워드"},{"n":"중볼륨","k":"지표","g":false,"s":"키워드"},{"n":"저볼륨","k":"지표","g":false,"s":"키워드"},{"n":"생성 프롬프트 표(원 입력·질문·검색 의도·검색량)","k":"기능","g":true,"s":"키워드"}]},{"screen":"Admin > Global config > Global prompts","items":[{"n":"연결되지 않은 프롬프트 수","k":"지표","g":false,"s":"프롬프트 연결"}]},{"screen":"Admin > Global config > 인용 출처 분류","items":[{"n":"도메인 수","k":"지표","g":false,"s":"도메인"}]},{"screen":"Admin > Global config > Entity catalog","items":[{"n":"전체 엔티티 수","k":"지표","g":false,"s":"엔티티"},{"n":"자사 엔티티 수","k":"지표","g":false,"s":"엔티티"},{"n":"언급 샘플 + 쓰기: 초안 엔티티 편집·삭제, 표면 추가·삭제","k":"기능","g":true,"s":"엔티티"}]},{"screen":"원본 데이터 검수 > 검수 목록","items":[{"n":"필터 기준 답변 수","k":"지표","g":false,"s":"답변"},{"n":"답변 목록(프롬프트·표면·브랜드·국가·엔진·언어·측정일·멘션·인용·검수 상태·검수자/락 배지, 50행 + 더 보기)","k":"기능","g":true,"s":"언급+인용"}]},{"screen":"원본 데이터 검수 > 검수 목록 > 상세","items":[{"n":"답변 원문(프롬프트 user turn·AI 답변 하이라이트) + 앵커 접힘/미러 제외 고지","k":"기능","g":true,"s":"언급+인용"},{"n":"낱알 패널(프롬프트·멘션·인용·ACR·메타 블록, 블록별 판정 토글·미해결 노트 수)","k":"기능","g":true,"s":"언급+인용"}]}];

/* ───────── 테이블 정의 ─────────
   cols: [이름, 키(PK|FK|PF|UK|''), 설명, 참조 테이블] · s: gold | silver | app | key | applist | ghost */
const T = {};
function tbl(id, o) { T[id] = Object.assign({ id, cols: [] }, o); }
function ghost(id, cols) { T[id + '_ref'] = { id: id + '_ref', ghostOf: id, s: 'ghost', name: T[id].name, cols: cols || T[id].cols.filter(c => c[1] === 'PK' || c[1] === 'PF').slice(0, 1).map(c => [c[0], 'PK', '']) }; }
const FAM = { dim: '차원', prompt: '프롬프트·웹 유닛', fact: '답변 사실', kpi: 'KPI·언급 셀', cit: '인용 셀', acr: 'ACR', ga4: 'GA4', kw: '키워드', soc: '소셜', pub: '발행 세대', build: '빌드·릴리스', silver: '답변 원문', queue: 'BE 요청 큐', vis: 'AI Visibility' };
const ACCEL = '선택 사항입니다. 없으면 BE 가 지금처럼 사실 테이블에서 계산하고, 성능 병목이 확인된 계열부터 적재합니다.';

/* ── 공통 차원 ── */
tbl('cell_key', { s: 'key', name: 'C 공통 셀 키', fam: 'dim', grain: '셀 집계 PK 의 앞부분 · 사실의 필터 열', cols: [
  ['build_id', 'FK', '빌드(세대)', 'build'], ['population_key', 'FK', '모수 규칙', 'dim_population'], ['surface', '', '1 global · 2 website · 3 project'],
  ['project_key', 'FK', '', 'dim_project'], ['cyc_key', 'FK', '회차', 'dim_cycle'], ['round_date · bucket_date', '', '회차일 · 지표별 버킷'],
  ['prompt_key', 'FK', '', 'dim_prompt'], ['engine_key', 'FK', '', 'dim_engine'], ['geo_key', 'FK', '국가', 'dim_country'], ['lang_key', 'FK', '', 'dim_lang'], ['bgrp', '', '당사 브랜드 그룹 비트'] ], d: {
  grain: '테이블이 아니라 키 묶음입니다. 셀 집계(kpi_cell · brand_cell · citation_cell · url_prompt_cell)의 PK 앞부분이고, 사실 테이블(job_index · answer_fact · answer_brand_fact · citation_fact · acr_cell_fact)은 같은 좌표를 일반 열로 가집니다.',
  pk: '—', inputs: '답변 정제 · 프롬프트 매핑', uses: '모든 필터·권한 축: 표면, 프로젝트, 회차·기간, 프롬프트, 엔진, 국가·권역, 언어, 당사 브랜드',
  cur: 'rd.answer · rd.job 의 필터 열', rules: ['bucket_date 의 의미(측정일 · 회차일 · 앵커일)는 지표별로 고정하고 섞지 않습니다.', '국가·프로젝트·표면 권한을 이 키로 거르므로 상위 합계도 권한 축은 지우지 않습니다.'] } });
tbl('cell_key_c', { s: 'key', ghostOf: 'cell_key', name: 'C 공통 셀 키', cols: [['build · population', '', ''], ['surface · project · cyc', '', ''], ['round_date · bucket', '', ''], ['prompt · engine', '', ''], ['geo · lang · bgrp', '', '']] });
tbl('dim_population', { s: 'gold', name: 'dim_population', fam: 'dim', grain: '모수 규칙 1개', cols: [['population_key', 'PK', 'int2'], ['code', '', 'mentions · citations · gap · url · acr'], ['gate', '', 'std_in · cit_in · web_reg · acr_in'], ['rep_mode', '', '대표 답변 선택 규칙']], d: {
  grain: '셀 집계의 모수 규칙 1개 = 1행.', pk: 'population_key', inputs: '—', uses: '셀 집계의 행 구분', cur: '없음. 사실에서는 answer_fact 의 std_in · cit_in · gap · acr_in 열이 같은 역할',
  rules: ['언급·인용·URL·ACR 모수가 서로 달라 답변 수 하나로 모든 분모를 대신할 수 없습니다.'] } });
tbl('dim_project', { s: 'gold', name: 'dim_project', fam: 'dim', grain: '측정 프로젝트 1개', cols: [
  ['project_key', 'PK', 'int2'], ['scope_project_id', 'UK', 'uuid'], ['surface', '', '1 · 2 · 3'], ['is_root', '', 'global 루트'], ['project_id', 'FK', '', 'app.project'], ['site_id', 'FK', '', 'app.website_site'], ['site_brand_bit · site_geo_key', '', '웹사이트 사이트'], ['regions[]', '', ''] ], d: {
  grain: '측정 프로젝트 1개 = 1행. global 루트, 웹사이트 사이트, 고객 프로젝트가 모두 들어갑니다.', pk: 'project_key', inputs: '프롬프트 매핑 + app.project · app.website_site',
  uses: '표면·프로젝트 권한, 웹사이트 사이트 브랜드·국가, Project 화면 전체', cur: 'rd.dim_project' } });
tbl('dim_cycle', { s: 'gold', name: 'dim_cycle', fam: 'dim', grain: '회차 1개', cols: [
  ['cyc_key', 'PK', '회차 키'], ['cycle_id', 'UK', 'uuid'], ['surface · ledger_backed', '', ''], ['project_key', 'FK', '', 'dim_project'], ['round_date · anchor_date', '', ''], ['status · servable', '', '진행 · 노출 가능'],
  ['view_date · hidden_scope · hidden_reason', '', '노출일 · 숨김'], ['expected_units · completed_units', '', '진행률'], ['completed_answers · gap_answers', '', ''], ['generation · ecat_ver', '', ''] ], d: {
  grain: '회차 1개 = 1행. 프로젝트 가상 회차도 같은 발급처에서 키를 받습니다.', pk: 'cyc_key', inputs: '답변 정제 (회차 확정) + judgment_change cycle_admin',
  uses: '기간·회차 선택, 추이, 이전 기간 비교, 회차 관제(진행률·숨김·노출일), 엔티티 카탈로그 반영 범위', cur: 'rd.cycle (열 전부)',
  rules: ['servable · view_date · hidden_scope 는 조회 게이트라 BE 가 즉시 반영합니다.', '골드 집계는 회차 분석이 끝난 뒤 계산합니다 (20261015/D07).'] } });
tbl('dim_engine', { s: 'gold', name: 'dim_engine', fam: 'dim', grain: 'AI 엔진 1개', cols: [['engine_key', 'PK', 'int2'], ['code', 'UK', 'AI 엔진 코드'], ['is_default', '', '기본 노출']], d: {
  grain: 'AI 엔진 1개 = 1행.', pk: 'engine_key', inputs: '답변 정제', uses: '엔진 필터, 엔진별 KPI·출처·전환, 프로젝트 엔진 설정', cur: 'rd.dim_engine' } });
tbl('dim_country', { s: 'gold', name: 'dim_country', fam: 'dim', grain: '국가(시장) 1개', cols: [['geo_key', 'PK', 'int2'], ['code', 'UK', 'ISO · pseudo'], ['region_key', 'FK', '권역', 'dim_region'], ['kind · virtual_brand_bit', '', 'iso · pseudo · virtual_brand'], ['hidden_standard', '', '표준 숨김 시장']], d: {
  grain: '국가(시장) 1개 = 1행.', pk: 'geo_key', inputs: '답변 정제 · GA4 AI 유입 분류(시장 매핑)', uses: '국가 필터·권한, 국가별 GEO 현황, GA4 국가별 전환, 사용자 국가 범위', cur: 'rd.dim_country' } });
tbl('dim_region', { s: 'gold', name: 'dim_region', fam: 'dim', grain: '권역 1개', cols: [['region_key', 'PK', 'int2'], ['code', 'UK', '권역 코드']], d: {
  grain: '권역 1개 = 1행.', pk: 'region_key', inputs: 'app.rhq_region', uses: '권역·본사 전환율, 권역 필터 옵션', cur: 'rd.dim_region' } });
tbl('dim_lang', { s: 'gold', name: 'dim_lang', fam: 'dim', grain: '언어 1개', cols: [['lang_key', 'PK', 'int2'], ['code', 'UK', '소문자 언어 코드']], d: {
  grain: '언어 1개 = 1행.', pk: 'lang_key', inputs: '답변 정제', uses: '언어 필터, 웹사이트 유닛·타겟 URL', cur: 'rd.dim_lang' } });

/* ── 프롬프트 · 카탈로그 · 웹 유닛 ── */
tbl('dim_prompt', { s: 'gold', name: 'dim_prompt', fam: 'prompt', grain: '측정 프롬프트 1개', cols: [
  ['prompt_key', 'PK', 'int4'], ['prompt_id', 'UK', 'uuid'], ['surface · kind', '', 'single · acr'], ['project_key', 'FK', '', 'dim_project'], ['text', '', '검색용 본문'], ['lang_key', 'FK', '', 'dim_lang'], ['funnel_key', 'FK', '', 'dim_taxon'],
  ['cat_mask · cat_mask_all', '', '카탈로그 비트 · 삭제 포함'], ['in_root_catalog · in_root_catalog_all', '', ''], ['unit_key', 'FK', '웹 보고 유닛', 'web_unit'], ['targets[]', '', '웹 타겟 URL 정규형'], ['web_reg', '', '웹 카탈로그 등록'], ['regions[] · is_korean', '', ''], ['rule_ver', '', ''] ], d: {
  grain: '측정 프롬프트 1개 = 1행 (single · acr).', pk: 'prompt_key', inputs: '프롬프트 원천 → 프롬프트 매핑 + app 카탈로그',
  uses: '프롬프트 필터·검색, 측정 프롬프트 수, 미측정 목록, URL 인용률 분모(web_reg), 카탈로그 관리, 검수 목록', cur: 'rd.dim_prompt (열 전부)',
  rules: ['cat_mask_all · in_root_catalog_all 은 삭제 행 포함 카탈로그 프로필 스위치(A41)가 씁니다.'] } });
tbl('catalog_entry', { s: 'gold', name: 'catalog_entry', fam: 'prompt', grain: '카탈로그 행 1개 (삭제 포함)', cols: [
  ['catalog_row_id', 'PK', 'uuid'], ['prompt_key', 'FK', '', 'dim_prompt'], ['brand_bit', '', '카탈로그 브랜드'], ['kind', '', 'single · acr …'], ['presence_key', 'FK', '', 'dim_taxon'], ['funnel_key · list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon'], ['build_id', 'FK', '현행 load_id', 'build'] ], d: {
  grain: '카탈로그 행 1개 = 1행. 한 프롬프트에 여러 행이 붙을 수 있습니다.', pk: 'catalog_row_id', inputs: 'app 카탈로그 (judgment_change catalog · website_catalog)',
  uses: 'KPI 요약의 적용·측정 프롬프트 수와 퍼널, 국가별 GEO 카탈로그 게이트, 필터 옵션, 답변 상세 택소노미', cur: 'rd.catalog_entry',
  rules: ['여러 카탈로그 행이 붙어도 측정 수를 중복하지 않게 EXISTS 로만 거릅니다.'] } });
tbl('dim_taxon', { s: 'gold', name: 'dim_taxon', fam: 'prompt', grain: '택소노미 코드 1개', cols: [['taxon_key', 'PK', 'int2'], ['axis', '', 'funnel · presence · list_type · depth1~3'], ['code', '', ''], ['parent_key', 'FK', '상위 코드', 'dim_taxon']], d: {
  grain: '택소노미 코드 1개 = 1행.', pk: 'taxon_key', inputs: 'app 카탈로그', uses: '필터 옵션, 퍼널 분포, 카탈로그 관리', cur: 'rd.dim_taxon' } });
tbl('web_unit', { s: 'gold', name: 'web_unit', fam: 'prompt', grain: '웹사이트 보고 유닛 1개', cols: [
  ['unit_key', 'PK', 'int2'], ['project_key', 'FK', '', 'dim_project'], ['file_seq', 'UK', '보고 유닛 번호'], ['lang_codes[]', '', ''], ['base · base_src', '', '소유 베이스'], ['sibs[] · home_host', '', ''], ['turls[]', '', '타겟 URL'], ['rule_ver', '', ''] ], d: {
  grain: '웹사이트 보고 유닛 1개 = 1행.', pk: 'unit_key (프로젝트 × file_seq 유일)', inputs: 'app.website_report_unit + 프롬프트 매핑',
  uses: 'Website KPI 모수 게이트(보고서 유닛 소속), ⑥ 유닛 판정, 웹 자사·타겟 판정', cur: 'rd.web_unit' } });
tbl('web_report_prompt', { s: 'gold', name: 'web_report_prompt', fam: 'prompt', grain: '프롬프트의 보고 유닛 소속', cols: [['prompt_key', 'PF', '', 'dim_prompt'], ['report_fs', 'FK', 'file_seq', 'web_unit']], d: {
  grain: '웹 프롬프트 1개의 보고 유닛 소속 = 1행.', pk: 'prompt_key', inputs: '프롬프트 매핑', uses: 'Website 모수 게이트 (WEBREG16, LIVE)', cur: 'rd.web_report_prompt' } });
tbl('web_target_url', { s: 'gold', name: 'web_target_url', fam: 'prompt', grain: '프로젝트 × 언어 × 타겟 URL', cols: [['project_key', 'PF', '', 'dim_project'], ['lang_key', 'PF', '', 'dim_lang'], ['url_key', 'PF', '', 'dim_url']], d: {
  grain: '웹 프로젝트 × 언어 × 타겟 URL = 1행. 타겟 정규형을 dim_url 키로 미리 풀어 둡니다.', pk: 'project_key + lang_key + url_key', inputs: '자사/타겟 URL 매칭',
  uses: '⑥ AI 타겟 출처 인용률 (LIVE)', cur: 'rd.web_target_url' } });
tbl('website_report_excluded', { s: 'app', name: 'website_report_excluded', fam: 'prompt', grain: '제외 보고 유닛', cols: [['file_seq', 'PF', '', 'web_unit'], ['note', '', '']], d: {
  grain: 'Website 모수에서 뺄 보고 유닛 1개 = 1행. GEO HUB 설정입니다.', pk: 'file_seq', inputs: 'GEO HUB 설정', uses: 'Website 모수 게이트 (조회 시점 적용)', cur: 'app.website_report_excluded' } });

/* ── 답변 사실 ── */
tbl('job_index', { s: 'gold', name: 'job_index', fam: 'fact', grain: 'Scope job 1건 (모든 상태)', cols: [
  ['answer_key', 'PK', 'int4'], ['job_id', 'UK', 'uuid'], ['run_key', '', ''], ['C 좌표', 'FK', 'cyc·prompt·project·engine·geo·lang·bgrp', 'cell_key'], ['surface · round_date', '', ''], ['measured_at', '', '측정 시각'],
  ['status_code', '', '0 완료 · 1 대기·실행 · 2 실패'], ['analysis_code', '', ''], ['dropped · served', '', ''], ['build_id', 'FK', '', 'build'] ], d: {
  grain: 'Scope job 1건 = 1행. 대기·실행·실패·드롭까지 모든 상태를 담습니다.', pk: 'answer_key (job_id 유일)', inputs: '답변 원문 → 답변 정제', triggers: '적재마다, 드롭·앵커 고정 반영',
  uses: '필터 옵션(국가·엔진 매트릭스), 답변 모달 링크(job_id), 추이의 측정 일수(measured_at), 회차·job 관제, 검수 목록·진행률·노트, scope 연결 진단', cur: 'rd.job',
  rules: ['served = 완료 ∧ 드롭 아님. answer_fact 는 served job 만 가집니다.', 'job_id ↔ answer_key 해석과 접근 범위 검사(fail-closed)가 이 테이블을 거칩니다.'] } });
tbl('answer_fact', { s: 'gold', name: 'answer_fact', fam: 'fact', grain: '빌드 × 정상 완료 답변 1건', cols: [
  ['build_id', 'PF', '', 'build'], ['surface · round_date', 'PK', '파티션'], ['answer_key', 'PF', '', 'job_index'], ['C 좌표', 'FK', 'cyc·run·prompt·project·engine·geo·lang·bgrp', 'cell_key'],
  ['anchor_date · anchor_src · region_geo_key', '', ''], ['cat_mask · acr_iter_rank · analysis_state', '', ''], ['elig · dflt · is_acr · is_rep · web_reg', '', '게이트'], ['std_in · cit_in · gap · acr_in', '', '모수'],
  ['elig_nc · std_in_nc · cit_in_nc', '', '프로필 대체 모수'], ['own_mask · own_rk_{h,k,g} · t_own', '', '당사 경쟁 순위'], ['own_fp_{h,k,g}', '', '텍스트 첫 등장 · 신규'], ['ment_total · ment_{h,k,g}', '', ''],
  ['sent_{pos,neg,all}_{h,k,g}', '', ''], ['cit_n · cit_n_all · cit_off', '', '인용 수 · Official'], ['cit_own_{h,k,g}[c] · cit_own_x', '', '글로벌 자사'], ['cit_loc · cit_tgt · cit_loc_tgt', '', '웹·프로젝트 자사'],
  ['cit_c1 … cit_c13', '', '카테고리별'], ['has_cit · tgt_cited · own_url_cited', '', 'URL 인용률'], ['rep_cit_xor', '', '인용 대표 보정'], ['ecat_ver · rule_ver', '', '판정 버전'] ], d: {
  grain: '빌드 × 정상 완료 답변 1건 = 1행 (ACR 반복 포함, 본문 제외).', pk: 'build_id + surface + round_date + answer_key',
  inputs: '답변 정제 · 프롬프트 매핑 · 브랜드 언급 추출 · 언급 감정 분류 · 인용 정규화 · 자사/타겟 URL 매칭', triggers: '회차 마감, 재판정(judgment_change), 드롭·앵커 고정',
  uses: 'KPI 카드·엔진·비교·추이·국가별 GEO, 언급·인용 분석 전반, 답변 목록, 회차 관제, 프롬프트 라이프사이클 영향 수, scope 연결 진단', cur: 'rd.answer (열 전부) + rd.rep_cit_delta',
  rules: ['현행 rd.answer 열을 줄이지 않습니다. *_nc 열은 레거시 프로필 스위치가 쓰는 대체 모수입니다.', 'own_fp_{h,k,g} 는 GEO 우선 노출도(T001)용 신규 열입니다. 텍스트상 첫 등장 순서입니다.', 'rep_cit_xor 는 현행 rd.rep_cit_delta 를 열로 접은 것입니다. 답변분석 인용 대표 = is_rep XOR rep_cit_xor.'] } });
tbl('answer_brand_fact', { s: 'gold', name: 'answer_brand_fact', fam: 'fact', grain: '빌드 × 답변 × 표시 브랜드 × 경쟁', cols: [
  ['build_id', 'PF', '', 'build'], ['surface · round_date · answer_key', 'PF', '', 'answer_fact'], ['brand_key', 'PF', '', 'dim_brand'], ['competitive', 'PK', '경쟁 행'], ['C 좌표 사본', 'FK', '', 'cell_key'],
  ['own_bit · entity_rows · rid_n', '', ''], ['mention_count · rk', '', '경쟁 순위'], ['first_pos', '', '텍스트 첫 등장 · 신규'], ['s_pos · s_neu · s_neg · s_mix', '', ''], ['t_mention … t_final_choice', '', '유형 5종'],
  ['std_in · elig · dflt · is_rep · std_in_nc', '', '게이트 사본'], ['rule_ver', '', ''] ], d: {
  grain: '빌드 × 답변 × 표시 브랜드 × 경쟁 여부 = 1행.', pk: 'build_id + 답변 PK + brand_key + competitive', inputs: '브랜드 언급 추출 · 언급 감정 분류',
  uses: '경쟁사 표, 브랜드 순위·주별 언급, 멘션 유형, 헤드투헤드, 답변 목록 브랜드 배지, 인용 출처의 언급 브랜드 조건, 엔티티 카탈로그 버전 영향', cur: 'rd.answer_brand',
  rules: ['게이트 열은 answer_fact 사본입니다 (현행 rd.propagate_answer_gates).', 'first_pos 는 T001 용 신규 열입니다.', 'exposure_answers = Σrid_n (프로필 스위치).'] } });
tbl('answer_stance_fact', { s: 'gold', name: 'answer_stance_fact', fam: 'fact', grain: '빌드 × 답변 × 턴 × 엔티티', cols: [
  ['build_id', 'PF', '', 'build'], ['surface · round_date · answer_key', 'PF', '', 'answer_fact'], ['turn_index', 'PK', ''], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key', 'FK', '', 'dim_brand'], ['cyc_key', '', ''],
  ['own_bit · stance', '', '1 긍정 2 중립 3 혼합 4 부정'], ['first_turn', '', '대표 턴'], ['std_in · is_rep · std_in_nc', '', '게이트 사본'] ], d: {
  grain: '빌드 × 답변 × 턴 × 엔티티 = 1행.', pk: 'build_id + 답변 PK + turn_index + entity_key', inputs: '언급 감정 분류(스탠스)',
  uses: '멘션 유형 화면의 스탠스 4종 분포, 답변 상세', cur: 'rd.answer_stance',
  rules: ['first_turn = (답변, 엔티티) 안 가장 이른 턴. 화면 집계는 first_turn 만 셉니다.', '카드 경로는 스탠스를 읽지 않아 발행 세대에 넣지 않습니다.'] } });
tbl('citation_fact', { s: 'gold', name: 'citation_fact', fam: 'fact', grain: '빌드 × 인용 원소 1건', cols: [
  ['build_id', 'PF', '', 'build'], ['surface · round_date · answer_key', 'PF', '', 'answer_fact'], ['ord', 'PK', '인용 순서'], ['url_key', 'FK', '', 'dim_url'], ['source_key', 'FK', '', 'dim_source'], ['C 좌표 사본', 'FK', '', 'cell_key'],
  ['scope_key · owner_key', '', ''], ['cit_in · gap · dflt · is_rep · cit_in_nc', '', '게이트 사본'], ['loc_owned · tgt_hit · src_first', '', ''], ['rule_ver', '', ''] ], d: {
  grain: '빌드 × 인용 원소 1건 = 1행.', pk: 'build_id + 답변 PK + ord', inputs: '인용 정규화 · 자사/타겟 URL 매칭',
  uses: '출처·도메인·톤·카테고리, 인용 프롬프트·도메인 상세, 추이, 출처 교정 영향 수, 프롬프트 라이프사이클 영향 수, 검수 상세', cur: 'rd.citation',
  rules: ['URL 문자열은 dim_url 에만 둡니다.', '일별 고유 URL 수를 더하지 않습니다.'] } });
tbl('dim_brand', { s: 'gold', name: 'dim_brand', fam: 'kpi', grain: '표시 브랜드 1개', cols: [['brand_key', 'PK', 'int4'], ['name', 'UK', '표시명'], ['bare', 'UK', '접두 없는 이름'], ['kind', '', '0 ~ 3'], ['own_bit', '', '0 · 1 · 2 · 4']], d: {
  grain: '표시 브랜드 1개 = 1행.', pk: 'brand_key', inputs: '브랜드 언급 추출(롤업) + app 엔티티 카탈로그', uses: '경쟁사 표, 브랜드 순위, 헤드투헤드, ACR 브랜드 표, 엔티티 관리',
  cur: 'rd.dim_brand_name', rules: ['kind = 1 ⇔ own_bit ≠ 0 (당사 브랜드).'] } });
tbl('dim_entity', { s: 'gold', name: 'dim_entity', fam: 'kpi', grain: '엔티티 1개', cols: [['entity_key', 'PK', 'int4'], ['entity_id', 'UK', 'uuid'], ['entity_type · registry_role', '', ''], ['rep_name', '', '대표 표시명'], ['brand_key', 'FK', '', 'dim_brand']], d: {
  grain: '엔티티 1개 = 1행 (브랜드 · 차종 · 회사).', pk: 'entity_key', inputs: '브랜드 언급 추출 + app 엔티티 카탈로그(ecat)', uses: 'ACR 차종·회사 레벨, 엔티티 관리, 답변·검수 상세 역할 표시', cur: 'rd.dim_entity' } });

/* ── KPI · 언급 셀 ── */
tbl('dim_perspective', { s: 'gold', name: 'dim_perspective', fam: 'kpi', grain: '당사 브랜드 조합 1개', cols: [['perspective_key', 'PK', 'int2'], ['own_bits', '', '1 현대 · 2 기아 · 4 제네시스'], ['label', '', 'HMG 통합 · 브랜드별']], d: {
  grain: '당사 브랜드 비트 조합 1개 = 1행. 실제 쓰는 조합만 둡니다 (최대 7개).', pk: 'perspective_key', inputs: '—', uses: '셀 집계의 관점 구분', cur: '없음. 사실에서는 own_bits 로 _h · _k · _g 열을 고릅니다.',
  rules: ['조회는 관점 1개를 명시해 중복 합산을 막습니다.'] } });
tbl('kpi_cell', { s: 'gold', name: 'kpi_cell', fam: 'kpi', grain: '셀(C) × 관점 · 가속', cols: [
  ['C', 'PF', '셀 키 11개', 'cell_key'], ['perspective_key', 'PF', '', 'dim_perspective'], ['answers · tracked', '', '노출률'], ['own_mentions · total_mentions', '', '점유율'], ['sent_pos · sent_neg · sent_all', '', '우호도'],
  ['st_pos · st_neu · st_mix · st_neg', '', '스탠스 4종'], ['rank_sum · ranked', '', '경쟁 순위'], ['fp_sum · fp_n', '', '텍스트 첫 등장 · 신규'], ['multi_answers · multi_mentions', '', '복수 언급'], ['t_mention … t_final_choice', '', '유형 5종'],
  ['gap_answers · gap_base', '', '분석 누락'], ['cit_total · cit_m05 · cit_owned', '', '인용 점유율'], ['has_measured · has_mention', '', '프롬프트 존재'] ], d: {
  grain: '셀(C) × 관점 1개 = 1행. 언급·인용이 0 이어도 분모 셀은 남깁니다.', pk: 'C(11) + perspective_key', inputs: 'answer_fact · answer_stance_fact (같은 build)', triggers: '사실 build 와 같은 빌드',
  uses: 'KPI 요약·엔진·비교, 국가별 GEO, 추이, 멘션 유형 스탠스 분포 → /v1/kpi/*, /v1/geo, /v1/trend, /v1/mentions/types', cur: '없음 (신규 가속층). 현행은 rd.answer 를 조회 때마다 SUM',
  rules: [ACCEL, 'M05 인용 점유율 분자: global 은 cit_m05(= Σcit_off, Official 카테고리), website · project 는 cit_owned. 서로 대체하지 않습니다.', '우선 노출도: 카드 ④는 경쟁 순위(rank_sum), 국가별 GEO 현황은 텍스트 첫 등장(fp_sum)을 씁니다 (T001).'] } });
tbl('kpi_rollup', { s: 'gold', name: 'kpi_rollup', fam: 'kpi', grain: '상위 합계 D × 관점 · 가속', cols: [['D', 'PF', 'C − prompt_key', 'cell_key'], ['perspective_key', 'PF', '', 'dim_perspective'], ['rollup_kind', 'PK', ''], ['(가산 열)', '', 'kpi_cell 과 동일'], ['eligibility', '', '지원 축 · 대표 창']], d: {
  grain: 'kpi_cell 에서 prompt_key 를 뺀 상위 합계 1행.', pk: 'D + perspective_key + rollup_kind', inputs: 'kpi_cell (같은 build 에서 SUM)', uses: '프롬프트 필터 없는 KPI · 국가 · 엔진 조회 가속', cur: '없음 (신규)',
  rules: ['택소노미·검색처럼 rollup 이 표현하지 못하는 축이 걸리면 kpi_cell 이나 사실을 읽습니다.'] } });
tbl('brand_cell', { s: 'gold', name: 'brand_cell', fam: 'kpi', grain: '셀(C) × 브랜드 × 경쟁 · 가속', cols: [
  ['C', 'PF', '셀 키 11개', 'cell_key'], ['brand_key', 'PF', '', 'dim_brand'], ['competitive', 'PK', ''], ['mention_count', '', ''], ['answers_present', '', 'Σrid_n'], ['rank_sum · ranked', '', '경쟁 순위'], ['fp_sum · fp_n', '', '텍스트 첫 등장 · 신규'],
  ['s_pos · s_neu · s_neg · s_mix', '', ''], ['t_mention … t_final_choice', '', '유형 5종'], ['multi_answers · multi_mentions', '', ''], ['has_brand · has_multi', '', '프롬프트 존재'] ], d: {
  grain: '셀(C) × 표시 브랜드 × 경쟁 여부 = 1행.', pk: 'C(11) + brand_key + competitive', inputs: 'answer_brand_fact (같은 build)', triggers: '사실 build 와 같은 빌드',
  uses: '경쟁사 표, 브랜드 언급 순위, 주별 언급 수, GEO 경쟁 비교 → /v1/mentions/brands, /v1/geo', cur: '없음 (신규 가속층). 현행은 rd.answer_brand 를 조회 때 집계',
  rules: [ACCEL, 'HMG 통합 관점은 브랜드 행을 더하지 않고 kpi_cell 관점 행을 씁니다.', '형제 HMG 브랜드는 경쟁 행에 남습니다 (M-1).'] } });
tbl('entity_mention_total', { s: 'gold', name: 'entity_mention_total', fam: 'kpi', grain: '엔티티 전 기간 합계', cols: [['entity_key', 'PF', '', 'dim_entity'], ['answers', '', '언급 답변 수'], ['mentions', '', '언급 수'], ['updated_at', '', '']], d: {
  grain: '엔티티 1개의 전 기간 합계 = 1행. 기간·게이트 없이 드롭 답변만 뺍니다.', pk: 'entity_key', inputs: '브랜드 언급 추출', uses: 'Admin > Entity catalog 엔티티 목록·수', cur: 'rd.entity_mention_total' } });

/* ── 인용 셀 ── */
tbl('citation_cell', { s: 'gold', name: 'citation_cell', fam: 'cit', grain: '셀 × 관점 × 출처 × 소유 · 가속', cols: [
  ['C', 'PF', '셀 키 11개', 'cell_key'], ['perspective_key', 'PF', '', 'dim_perspective'], ['source_key', 'PF', '', 'dim_source'], ['owner_key', 'PF', '', 'owned_base'], ['category_key', 'PF', '유효 카테고리', 'dim_category'],
  ['loc_owned · tgt_hit', 'PK', '소유 · 타겟 판정'], ['citations', '', '인용 원소 수'], ['source_first_count', '', 'src_first 합'], ['cit_t_{mention…final}', '', '유형 5종'], ['cit_pos · cit_neg', '', '톤별 인용'] ], d: {
  grain: '셀(C) × 관점 × 출처 × 소유자 × 유효 카테고리 × 소유·타겟 판정 = 1행.', pk: 'C(11) + perspective_key + source_key + owner_key + category_key + loc_owned + tgt_hit',
  inputs: 'citation_fact + answer_fact(톤) (같은 build)', triggers: '사실 build 와 같은 빌드', uses: '도메인·출처 순위, 긍정/부정 답변 인용, 출처 카테고리, 자사 인용/미인용 프롬프트 → /v1/citations/*',
  cur: '없음 (신규 가속층). 현행은 rd.citation ⋈ dim_source · dim_url 을 조회 때 집계',
  rules: [ACCEL, '소유·출처 조건을 먼저 걸고 나서 축을 지워 합칩니다.', '자사 미인용 = 인용은 1건 이상인데 자사 인용이 0 인 프롬프트입니다.'] } });
tbl('url_prompt_cell', { s: 'gold', name: 'url_prompt_cell', fam: 'cit', grain: '셀(C) · 가속', cols: [['C', 'PF', '셀 키 11개', 'cell_key'], ['eligible', '', '적격 프롬프트'], ['any_target · any_owned', '', 'BOOL_OR 용'], ['url_den', '', '측정 단위 분모'], ['tgt_hits · own_url_hits', '', ''], ['tgt_own_hits', '', '정확도 분자']], d: {
  grain: '셀(C) 1개 = 1행.', pk: 'C(11)', inputs: 'answer_fact (tgt_cited · own_url_cited · web_reg)', uses: '자사 URL 인용률 · 타겟 URL 인용률 · 인용 정확도 (Website · Project)',
  cur: '없음 (신규 가속층)', rules: [ACCEL, '엔진·회차를 합칠 때 prompt_key 기준 OR 로 묶습니다.'] } });
tbl('report_value', { s: 'gold', name: 'report_value', fam: 'cit', grain: '발행 × 보고 유닛', cols: [
  ['build_id', 'PK', ''], ['pub_id', 'PK', '발행 ID'], ['round_date · file_seq', 'PK', '보고 유닛'], ['cyc_key', 'FK', '', 'dim_cycle'], ['brand · country_code · lang_code', '', ''], ['in_headline_pool', '', ''],
  ['target_hit_prompts · measured_prompts', '', ''], ['owned_prompts · owned_prompts_den', '', ''], ['prev_*', '', '전 회차 4종'] ], d: {
  grain: '발행 1건 × 보고 유닛(file_seq) 1개 = 1행.', pk: 'build_id + pub_id + round_date + file_seq', inputs: '자사/타겟 URL 매칭 + app.report_publication',
  triggers: '발행 · 명시적 재발행 (judgment_change report_publication)', uses: 'Website ⑥ AI 타겟 출처 인용률 발행값 (R09 우선) → /v1/citations/targets', cur: 'rd.report_unit_value',
  rules: ['발행값을 원문 재계산값으로 자동 교체하지 않습니다.', '발행 유닛을 답변 수로 가중하지 않습니다.'] } });
tbl('dim_source', { s: 'gold', name: 'dim_source', fam: 'cit', grain: '출처(도메인) 1개', cols: [
  ['source_key', 'PK', 'int4'], ['skey', 'UK', '도메인 정규 키'], ['domain · is_social', '', ''], ['category_key', 'FK', '', 'dim_category'], ['category_src', '', '판정 출처 1~6'], ['owned_brand_bit', '', '당사 공식 도메인'], ['competitor_brand_key', 'FK', '', 'dim_brand'] ], d: {
  grain: '출처(도메인) 1개 = 1행.', pk: 'source_key', inputs: '인용 정규화 + app.citation_domain_override', uses: '도메인 인용 순위, 출처 카테고리, 경쟁사 공식 도메인, 출처 교정 화면', cur: 'rd.dim_source' } });
tbl('dim_url', { s: 'gold', name: 'dim_url', fam: 'cit', grain: 'URL 1개', cols: [
  ['url_key', 'PK', 'int4 · 0 예약'], ['url_hash', 'UK', ''], ['url · title', '', ''], ['url_norm · url_base_norm', '', ''], ['host · domain', '', ''], ['source_key', 'FK', '', 'dim_source'], ['owner_key', 'FK', '', 'owned_base'] ], d: {
  grain: '인용 URL 1개 = 1행.', pk: 'url_key', inputs: '인용 정규화 · 자사/타겟 URL 매칭', uses: '인용 URL 목록, 타겟 URL 매칭, 답변·검수 상세', cur: 'rd.dim_url' } });
tbl('dim_category', { s: 'gold', name: 'dim_category', fam: 'cit', grain: '출처 카테고리 1개', cols: [['category_key', 'PK', 'int2'], ['name', 'UK', ''], ['slug', '', ''], ['ord', '', '표시 순서']], d: {
  grain: '출처 카테고리 1개 = 1행.', pk: 'category_key', inputs: 'app.citation_category 투영', uses: '출처 카테고리 도넛·추이, 공식(HMG)·딜러·마켓 비중. answer_fact.cit_c1~c13 의 번호', cur: 'app.citation_category' } });
tbl('owned_base', { s: 'app', name: 'owned_base', fam: 'cit', grain: '당사 소유 베이스 1개', cols: [['owner_key', 'PK', 'int2'], ['kind', '', 'base · root_home'], ['prefix · host', '', ''], ['brand_code', '', ''], ['geo_code · language', '', '']], d: {
  grain: '당사 소유 URL 베이스 1개 = 1행. GEO HUB 설정입니다.', pk: 'owner_key', inputs: 'GEO HUB 관리 화면', uses: 'Global 자사 인용 판정, KPI ⑥ 분모', cur: 'app.owned_base',
  rules: ['바뀌면 judgment_change owned_base → 재판정 → 영향 회차 새 build.'] } });

/* ── ACR ── */
tbl('acr_cell_fact', { s: 'gold', name: 'acr_cell_fact', fam: 'acr', grain: '빌드 × ACR 셀', cols: [
  ['build_id', 'PF', '', 'build'], ['acr_cell_key', 'PK', 'ACR 셀'], ['C 좌표', 'FK', '', 'cell_key'], ['round_date · measured_date', '', ''], ['cat_mask', '', ''], ['planned · valid_turn1 · valid_acr', '', '반복 모수'],
  ['co_single · co_conditional · co_generic', '', '결과 유형'], ['co_off_shortlist · co_unresolved · co_none', '', ''], ['is_rep · acr_in', '', ''] ], d: {
  grain: '빌드 × ACR 셀(프롬프트 × 엔진 × 국가 × 회차의 반복 측정 묶음) = 1행.', pk: 'build_id + acr_cell_key', inputs: 'ACR 답변 원문 → 답변 정제 → ACR 최종 선택 판정', triggers: 'ACR 수집 완료, 반복·셀 재판정',
  uses: 'Top1 · Top5 ACR, 답변 수, 1순위 횟수, 측정 프롬프트·셀·반복 수, 선택률 추이, 검수 상세 ACR 블록 → /v1/funnel/acr', cur: 'rd.acr_cell',
  rules: ['선택률 = choice / 전체 valid_acr · coverage = 등장 셀 / 전체 셀'] } });
tbl('acr_entity_fact', { s: 'gold', name: 'acr_entity_fact', fam: 'acr', grain: '빌드 × ACR 셀 × 레벨 × 엔티티', cols: [
  ['build_id · acr_cell_key', 'PF', '', 'acr_cell_fact'], ['level', 'PK', '1 브랜드 · 2 차종 · 3 회사'], ['entity_key', 'PF', '', 'dim_entity'], ['brand_key · parent_brand_key', 'FK', '차종 소속', 'dim_brand'], ['own_bit · name_own', '', ''],
  ['appearance · choice · cond_choice', '', ''], ['off_shortlist · unresolved · generic', '', ''], ['keep', '', '표시 유지'] ], d: {
  grain: '빌드 × ACR 셀 × 레벨 × 엔티티 = 1행.', pk: 'build_id + acr_cell_key + level + entity_key', inputs: 'ACR 최종 선택 판정 · 브랜드 언급 추출',
  uses: '브랜드별 ACR 표, 모델별 선택 구도(배틀 그리드), 차종별 선택 전환율, 모델별 점유 맵, 검수 상세', cur: 'rd.acr_choice (레벨 파티션)',
  rules: ['배틀 승자는 국가 등 필터를 건 뒤 계산합니다. 국가별 승자만 저장하지 않습니다.', '차종 분모 = 차종 엔티티 행에 붙은 셀의 valid_acr 합. 표시명 병합 때 임의로 중복 제거하지 않습니다.'] } });
tbl('acr_cell_job', { s: 'gold', name: 'acr_cell_job', fam: 'acr', grain: 'ACR 셀 × 소속 job', cols: [['build_id', 'PF', '', 'build'], ['answer_key', 'PF', '', 'job_index'], ['acr_cell_key', 'PF', '', 'acr_cell_fact']], d: {
  grain: 'ACR 셀 1개에 속한 job 1건 = 1행.', pk: 'build_id + answer_key + acr_cell_key', inputs: 'ACR 최종 선택 판정', uses: '검수 상세에서 job → ACR 셀 찾기', cur: 'rd.acr_cell_job' } });

/* ── GA4 ── */
tbl('ga4_property', { s: 'gold', name: 'ga4_property', fam: 'ga4', grain: 'GA4 속성 1개', cols: [['prop_key', 'PK', 'int2'], ['property_id', 'UK', ''], ['brand_bit', '', ''], ['geo_key', 'FK', '', 'dim_country'], ['status', '', 'active · pending_grant · unmapped'], ['source', '', 'registry · override · env']], d: {
  grain: 'GA4 속성 1개 = 1행.', pk: 'prop_key', inputs: 'app.ga4_property · 프로젝트 오버라이드 · env 매핑 (judgment_change ga4_property)', uses: '시장별 전환, 측정 커버리지, GA4 연동 관리', cur: 'rd.ga4_dim_property' } });
tbl('ga4_value', { s: 'gold', name: 'ga4_value', fam: 'ga4', grain: 'GA4 값 사전', cols: [['kind · value_key', 'PK', 'channel · source · device · nvr · event · page'], ['value', '', '빈 문자열 = 0']], d: {
  grain: 'GA4 차원 값 1개 = 1행.', pk: 'kind + value_key', inputs: 'GA4 리포트', uses: '기기·신규/재방문·페이지·이벤트 표시명', cur: 'rd.ga4_dim_value' } });
tbl('ga4_row', { s: 'gold', name: 'ga4_row', fam: 'ga4', grain: '속성 × 일 × report × 차원', cols: [
  ['prop_key', 'PF', '', 'ga4_property'], ['date', 'PK', ''], ['report', 'PK', '1 total · 2 ai · 3 events · 4 landing · 5 totals'], ['channel_key · source_key', 'PF', '', 'ga4_value'],
  ['device_key · nvr_key', 'PF', '', 'ga4_value'], ['page_key · event_key', 'PF', '', 'ga4_value'], ['is_ai', '', 'AI Assistant 채널'], ['engine_key', 'FK', 'AI 행만', 'dim_engine'], ['is_conv', '', '전환 이벤트'],
  ['sessions · users_day', '', ''], ['page_views · key_events · event_count', '', ''] ], d: {
  grain: '속성 × 보고일 × report × 차원 조합 = 1행.', pk: 'prop_key + date + report + channel · source · device · nvr · page · event', cur: 'rd.ga4_row (그대로)' } });
tbl('ga4_users_window', { s: 'gold', name: 'ga4_users_window', fam: 'ga4', grain: '속성 × 기간 × 코호트 × 차원', cols: [
  ['prop_key', 'PF', '', 'ga4_property'], ['window_end · window_days', 'PK', '7 · 28 · 90일'], ['cohort', 'PK', 'ai · general'], ['engine_key', 'PF', '', 'dim_engine'],
  ['device_key · nvr_key', 'PF', '', 'ga4_value'], ['page_key', 'PF', '0 = 전체', 'ga4_value'], ['users', '', '순 방문자'] ], d: {
  grain: '속성 × 기간 × 코호트 × 엔진 × 기기 × 신규/재방문 × 입구 페이지 = 1행.', pk: 'prop_key + window_end + window_days + cohort + engine_key + device_key + nvr_key + page_key',
  cur: '없음 (신규 · 순 방문자 · 방문 빈도 · 사용자 기준 전환율용)' } });

/* ── AI Visibility ── */
tbl('dim_crawl_bot', { s: 'gold', name: 'dim_crawl_bot', fam: 'vis', grain: 'AI 크롤러 1개', cols: [['bot_key', 'PK', 'int2'], ['code', 'UK', 'ChatGPT-User · Claude-Web · PerplexityBot · Googlebot-Vertex'], ['engine_key', 'FK', '', 'dim_engine']], d: {
  grain: 'AI 크롤러 1개 = 1행.', pk: 'bot_key', cur: '없음 (신규)' } });
tbl('page_visibility_daily', { s: 'gold', name: 'page_visibility_daily', fam: 'vis', grain: '사이트 × 페이지 × 일', cols: [
  ['build_id', 'PF', '', 'build'], ['project_key', 'PF', '사이트 · 프로젝트', 'dim_project'], ['url_key', 'PF', '페이지', 'dim_url'], ['geo_key · lang_key', 'FK', '시장 · 언어', 'dim_country'], ['date', 'PK', ''], ['seo_impressions', '', '검색 노출'], ['ai_crawls', '', 'AI 크롤 합계'] ], d: {
  grain: '사이트 × 페이지 × 일 = 1행.', pk: 'build_id + project_key + url_key + date', cur: '없음 (신규 · 현재 화면은 정적 표본)' } });
tbl('page_crawl_daily', { s: 'gold', name: 'page_crawl_daily', fam: 'vis', grain: '페이지 × 일 × 크롤러', cols: [['build_id · project_key · url_key · date', 'PF', '', 'page_visibility_daily'], ['bot_key', 'PF', '', 'dim_crawl_bot'], ['hits', '', '크롤 수']], d: {
  grain: '사이트 × 페이지 × 일 × AI 크롤러 = 1행.', pk: 'page_visibility_daily PK + bot_key', cur: '없음 (신규)' } });

/* ── 키워드 ── */
tbl('dim_keyword', { s: 'gold', name: 'dim_keyword', fam: 'kw', grain: '검색어 1개', cols: [['kw_key', 'PK', 'int4'], ['term', '', ''], ['term_norm', 'UK', '정규화']], d: {
  grain: '검색어 1개 = 1행.', pk: 'kw_key', inputs: '키워드 원천 → 키워드 정규화', uses: '키워드 화면 전체', cur: 'rd.dim_keyword' } });
tbl('kw_volume_monthly', { s: 'gold', name: 'kw_volume_monthly', fam: 'kw', grain: '검색어 × 지역 × 언어 × 월', cols: [['kw_key', 'PF', '', 'dim_keyword'], ['location_code · language_code', 'PK', ''], ['month', 'PK', '월 1일'], ['search_volume', '', ''], ['competition_index · cpc', '', ''], ['call_id', '', '수집 호출'], ['observed_at', '', '']], d: {
  grain: '검색어 × 지역 × 언어 × 월 = 1행.', pk: 'kw_key + location_code + language_code + month', inputs: '키워드 정규화', triggers: '정기 수집, BE 요청(judgment_change dfs_fetch)',
  uses: '평균 관심도, 키워드 수, 검색량, 볼륨 구간, 추적 키워드, 키워드 도구', cur: 'rd.kw_volume_monthly', rules: ['경쟁도 · CPC 는 일괄 합산하지 않습니다.', '최신 성공 관측만 읽고, 실패한 수집이 이전 값을 덮지 않습니다.'] } });
tbl('kw_serp', { s: 'gold', name: 'kw_serp', fam: 'kw', grain: '호출 × 순위', cols: [['call_id', 'PK', ''], ['rank', 'PK', ''], ['kw_key', 'FK', '', 'dim_keyword'], ['location_code · language_code', '', ''], ['url · domain', '', ''], ['title · snippet', '', ''], ['observed_at', '', '']], d: {
  grain: '수집 호출 × 순위 = 1행. 집계 없이 화면에 그대로 나갑니다.', pk: 'call_id + rank', inputs: '키워드 원천 (SERP)', triggers: 'BE 요청 dfs_fetch',
  uses: 'SERP 표 + 제안 프롬프트 초안', cur: 'rd.kw_serp' } });
tbl('kw_suggestion', { s: 'gold', name: 'kw_suggestion', fam: 'kw', grain: '호출 × 위치', cols: [['call_id', 'PK', ''], ['pos', 'PK', ''], ['seed_kw_key', 'FK', '시드', 'dim_keyword'], ['kw_key', 'FK', '', 'dim_keyword'], ['location_code · language_code', '', ''], ['search_volume · intent', '', ''], ['is_seed · observed_at', '', '7일 신선도']], d: {
  grain: '수집 호출 × 위치 = 1행. 집계 없이 화면에 그대로 나갑니다.', pk: 'call_id + pos', inputs: '키워드 원천 (연관 검색어)', triggers: 'BE 요청 dfs_fetch',
  uses: '관련 검색어 표, 생성 프롬프트 표, 키워드 수집 신선도 판정', cur: 'rd.kw_suggestion' } });

/* ── 소셜 ── */
tbl('ctx_snapshot', { s: 'gold', name: 'ctx_snapshot', fam: 'soc', grain: '분석 스냅샷 1개', cols: [['snapshot_id', 'PK', 'int2'], ['industry_entity_id', '', '산업 엔티티'], ['source', '', ''], ['utterance_total', '', ''], ['taken_at', '', ''], ['is_active', '', '산업당 활성 1개']], d: {
  grain: '구매 맥락 분석 스냅샷 1개 = 1행.', pk: 'snapshot_id', inputs: '소셜 원문 → 구매 맥락 추출', triggers: '스냅샷 전체 적재 성공 후 한 번', uses: 'Project > Intent > Social Scraping', cur: 'ext.ctx_snapshot' } });
tbl('ctx_entity', { s: 'gold', name: 'ctx_entity', fam: 'soc', grain: '스냅샷 × 맥락·조건', cols: [['snapshot_id', 'PF', '', 'ctx_snapshot'], ['id', 'PK', 'uuid'], ['type', '', 'Context · Requirement'], ['canonical_name', '', ''], ['dimension', '', '관점'], ['mention_count · utterance_count', '', ''], ['sentiment_pos · neg · neu', '', '']], d: {
  grain: '스냅샷 × 구매 맥락 또는 구매 조건 1개 = 1행.', pk: 'snapshot_id + id', inputs: '구매 맥락 추출', uses: '구매 맥락 표, 구매 조건 표, 맥락·조건 수', cur: 'ext.ctx_entity' } });
tbl('ctx_drive', { s: 'gold', name: 'ctx_drive', fam: 'soc', grain: '맥락 → 조건 연결', cols: [['snapshot_id', 'PK', ''], ['context_id', 'PF', '', 'ctx_entity'], ['requirement_id', 'PF', '', 'ctx_entity'], ['co_count', '', '동시 출현']], d: {
  grain: '스냅샷 × 맥락 × 조건 = 1행.', pk: 'snapshot_id + context_id + requirement_id', inputs: '구매 맥락 추출', uses: '관계 수, 연결 수', cur: 'ext.ctx_drive' } });
tbl('ctx_combination', { s: 'gold', name: 'ctx_combination', fam: 'soc', grain: '조건 A × 조건 B', cols: [['snapshot_id', 'PK', ''], ['cond_a', 'PF', '', 'ctx_entity'], ['cond_b', 'PF', '', 'ctx_entity'], ['co_count', '', '동시 출현']], d: {
  grain: '스냅샷 × 조건 쌍 = 1행.', pk: 'snapshot_id + cond_a + cond_b', inputs: '구매 맥락 추출', uses: '조합 패턴 표', cur: 'ext.ctx_combination' } });
tbl('ctx_domain', { s: 'gold', name: 'ctx_domain', fam: 'soc', grain: '엔티티 × 출처 host', cols: [['snapshot_id', 'PK', ''], ['entity_id', 'PF', '', 'ctx_entity'], ['host', 'PK', ''], ['n', '', '']], d: {
  grain: '스냅샷 × 엔티티 × 출처 host = 1행.', pk: 'snapshot_id + entity_id + host', inputs: '구매 맥락 추출', uses: '출처 도메인 수', cur: 'ext.ctx_domain' } });
tbl('ctx_evidence', { s: 'gold', name: 'ctx_evidence', fam: 'soc', grain: '근거 발화 1개', cols: [['snapshot_id', 'PK', ''], ['id', 'PK', 'uuid'], ['entity_id', 'FK', '', 'ctx_entity'], ['utterance_id', '', ''], ['quote', '', '근거 인용'], ['source_host · source_url', '', ''], ['sentiment', '', '']], d: {
  grain: '스냅샷 × 근거 발화 1개 = 1행.', pk: 'snapshot_id + id', inputs: '구매 맥락 추출', uses: '상세 언급 수, 근거 인용', cur: 'ext.ctx_evidence' } });

/* ── 발행 세대 (카드 동결) ── */
tbl('publication', { s: 'gold', name: 'publication', fam: 'pub', grain: '회차 × 발행 세대', cols: [
  ['pub_key', 'PK', ''], ['cyc_key', 'FK', '', 'dim_cycle'], ['surface', '', 'global · website'], ['source', '', 'ops 이관 · hub 발행'], ['state', '', 'building · active · retired'], ['build_id', 'FK', '고정한 사실 build', 'build'],
  ['judgment', '', '판정 입력 버전'], ['row_counts · verify', '', ''], ['created_at · activated_at · retired_at', '', ''] ], d: {
  grain: '회차 × 발행 세대 1개 = 1행. 회차당 active 는 1개입니다.', pk: 'pub_key', inputs: '회차 마감 후 발행', triggers: '발행, 명시적 재발행',
  uses: '카드 경로 API 7개(kpi/summary · mentions/brands · trend · geo · kpi/engines · citations/domains · kpi/compare)의 동결 읽기, 글로벌 추이 격자, 창 판정(세대 없는 발행 회차가 끼면 비카드 경로)',
  cur: 'frz.generation. frz.kept · keep_* 는 build_id 고정으로 대체', rules: ['build_id 로 발행 시점 사실 build 를 고정합니다. 발행 뒤 재판정은 새 build 로만 들어가 카드 값이 바뀌지 않습니다.', '활성 발행이 참조하는 build 는 지우지 않습니다.'] } });
tbl('pub_cell', { s: 'gold', name: 'pub_cell', fam: 'pub', grain: '발행 × 셀 대표 답변', cols: [['pub_key', 'PF', '', 'publication'], ['answer_key', 'PF', '셀 대표', 'answer_fact'], ['surface · cyc_key', '', ''], ['round_date', '', '동결 좌석'], ['prompt_key · engine_key · geo_key', '', '셀 좌표']], d: {
  grain: '발행 세대 × 셀 대표 답변 1건 = 1행.', pk: 'pub_key + answer_key', inputs: 'answer_fact (고정 build) + 발행 정렬 규칙', uses: '카드·격자 읽기의 셀 집합', cur: 'frz.cell',
  rules: ['셀 대표는 발행 정렬 규칙(미러 시각 > 앵커 핀 > 원본)으로 고르며 LIVE 의 is_rep 와 다를 수 있습니다.'] } });
tbl('pub_cell_web', { s: 'gold', name: 'pub_cell_web', fam: 'pub', grain: '웹 셀 판정', cols: [['pub_key · answer_key', 'PF', '', 'pub_cell'], ['cyc_key', '', ''], ['report_fs', '', '보고 유닛'], ['unit_owned · unit_target', '', '⑥ 유닛 판정'], ['url_registered · url_owned_hit · url_target_hit', '', '']], d: {
  grain: '웹 셀 1개의 발행 시점 판정 = 1행.', pk: 'pub_key + answer_key', inputs: 'web_unit · web_target_url (발행 시점)', uses: 'Website 카드의 유닛 게이트 · ⑥ · URL 인용률', cur: 'frz.cell_web' } });
tbl('pub_prompt', { s: 'gold', name: 'pub_prompt', fam: 'pub', grain: '발행 × 프롬프트', cols: [
  ['pub_key', 'PF', '', 'publication'], ['prompt_key', 'PF', '', 'dim_prompt'], ['cyc_key', '', ''], ['in_full_cycle · expected_cells · window_cells', '', ''], ['in_root_catalog · catalog_deleted · cat_mask', '', '동결 카탈로그'],
  ['funnel · presence · list_type · depth1~3', '', ''], ['regions · is_korean · report_fs', '', ''], ['src', '', '운영 원값 (감사)'] ], d: {
  grain: '발행 세대 × 프롬프트 = 1행.', pk: 'pub_key + prompt_key', inputs: 'dim_prompt · catalog_entry (발행 시점)', uses: '카드의 in_full_cycle 게이트와 동결 카탈로그 비트', cur: 'frz.prompt' } });
tbl('pub_prompt_axis', { s: 'gold', name: 'pub_prompt_axis', fam: 'pub', grain: '발행 × 프롬프트 택소노미', cols: [['pub_key · prompt_key', 'PF', '', 'pub_prompt'], ['cyc_key', '', ''], ['funnel_key', 'FK', '', 'dim_taxon'], ['presence_keys[]', '', ''], ['list_type_key', 'FK', '', 'dim_taxon'], ['depth1~3_key', 'FK', '', 'dim_taxon']], d: {
  grain: '발행 세대 × 프롬프트의 택소노미 축 = 1행.', pk: 'pub_key + prompt_key', inputs: 'catalog_entry (발행 시점)', uses: '카드 경로 택소노미 필터', cur: 'frz.prompt_axis' } });
tbl('pub_brand_name', { s: 'gold', name: 'pub_brand_name', fam: 'pub', grain: '발행 × 브랜드 표시명', cols: [['pub_key', 'PF', '', 'publication'], ['brand_key', 'PF', '', 'dim_brand'], ['name', '', '발행 시점 표시명']], d: {
  grain: '발행 세대 × 브랜드 = 1행.', pk: 'pub_key + brand_key', inputs: 'dim_brand (발행 시점)', uses: '카드 경로 브랜드 표시명', cur: 'frz.brand_name' } });

/* ── 빌드 · 릴리스 ── */
tbl('gold_facts', { s: 'key', name: '골드 사실·셀 전체', fam: 'build', grain: 'build_id 를 가진 테이블', cols: [
  ['build_id', 'FK', '모든 사실·셀 공통', 'build'], ['job_index · answer_fact', '', ''], ['answer_brand_fact · answer_stance_fact', '', ''], ['citation_fact · catalog_entry', '', ''], ['acr_cell_fact · acr_entity_fact · acr_cell_job', '', ''],
  ['kpi_cell · kpi_rollup · brand_cell', '', ''], ['citation_cell · url_prompt_cell · report_value', '', ''], ['page_visibility_daily · page_crawl_daily', '', ''], ['GA4 · 키워드 · 소셜', '', '날짜 · call_id · snapshot_id'] ], d: {
  grain: 'build_id 로 세대를 나누는 골드 테이블 목록입니다. 키워드는 call_id · observed_at, 소셜은 snapshot_id 로 버전을 관리합니다.', pk: '—', inputs: '—',
  uses: 'API 요청 시작에 release 하나를 고정하고, 그 release 가 가리키는 build 의 행만 읽습니다. 카드 경로는 publication.build_id 를 읽습니다.', cur: '현행 rd 는 제자리 갱신 + frz 보관 행' } });
tbl('build', { s: 'gold', name: 'build', fam: 'build', grain: '빌드 1회', cols: [
  ['build_id', 'PK', ''], ['family', '', 'fact · kpi · citation · acr · ga4 …'], ['slice_key', '', '회차 · 속성×일 · 스냅샷'], ['input_snapshot · watermark', '', '입력 고정'], ['profile_signature · metric_version', '', ''],
  ['ecat_ver · rule_ver', '', '판정 버전'], ['status', '', 'pending · running · validated · failed'], ['row_counts · verify', '', 'jsonb'], ['error · attempt', '', ''], ['started_at · finished_at', '', ''] ], d: {
  grain: '패밀리 × 슬라이스 × 입력·규칙 버전의 빌드 1회 = 1행.', pk: 'build_id (유일: family + slice_key + 입력·규칙 버전)', inputs: '회차 마감, judgment_change 반영',
  triggers: '회차 마감, 재판정, GA4 날짜 배치, 소셜 스냅샷', uses: '데이터 분석팀 운영, 반영 큐 화면(applied_build_id), 실패 재시도', cur: 'ing.load (적재 이력) 의 역할을 대신',
  rules: ['재시도는 같은 출력의 교체·재개입니다. 활성 통계에 SUM 을 더하지 않습니다.', '실패한 빌드는 공개하지 않고 상태와 오류만 남깁니다.'] } });
tbl('release', { s: 'gold', name: 'release', fam: 'build', grain: '공개 manifest 1개', cols: [['release_id', 'PK', ''], ['read_mode', '', 'live · card · grid'], ['rule_signature', '', '활성 프로필'], ['base_release_id', 'FK', '이전 release', 'release'], ['validated_at', '', '']], d: {
  grain: '불변 공개 manifest 1개 = 1행.', pk: 'release_id', inputs: 'validated 된 build 묶음', uses: '한 응답 안의 숫자를 같은 세대로 고정', cur: '없음 (신규)' } });
tbl('release_item', { s: 'gold', name: 'release_item', fam: 'build', grain: 'release × 패밀리 × 슬라이스', cols: [['release_id', 'PF', '', 'release'], ['family', 'PK', ''], ['slice_key', 'PK', ''], ['build_id', 'FK', '', 'build'], ['state', '', 'ready · empty']], d: {
  grain: 'release × 패밀리 × 슬라이스 = 1행. 어느 회차·날짜에 어느 build 를 쓸지 정합니다.', pk: 'release_id + family + slice_key', inputs: 'build', uses: 'BE 조회 경로의 build_id 결정 (LIVE)', cur: '없음 (신규)',
  rules: ['빈 슬라이스도 empty 로 매핑해 삭제를 표현합니다.'] } });
tbl('active_release', { s: 'gold', name: 'active_release', fam: 'build', grain: '공개 포인터', cols: [['read_mode', 'PK', ''], ['rule_signature', 'PK', ''], ['scope', 'PK', '공개 범위'], ['release_id', 'FK', '', 'release'], ['version', '', '캐시 데이터 버전']], d: {
  grain: '읽기 모드 × 규칙 서명 × 공개 범위의 현재 release = 1행.', pk: 'read_mode + rule_signature + scope', inputs: 'release',
  triggers: '검증 통과 후 짧은 트랜잭션으로 자동 전환 (승인 없음, 20261015 회의)', uses: 'BE 는 읽기만. version 은 결과 캐시 키와 as_of 표시에 씀', cur: 'rd.surface_generation (표면별 데이터 버전)',
  rules: ['기대한 이전 release 와 입력 버전을 확인한 뒤 전환해서, 오래된 빌드가 새 입력을 덮지 못하게 합니다.'] } });

/* ── serve 뷰 ── */
const SCOPE = ['surface · project_key · geo_key · bgrp', '', '접근 범위'];
tbl('answer_body', { s: 'gold', name: 'answer_body', fam: 'silver', grain: '답변 본문·메타', cols: [['answer_key', 'PF', '', 'job_index'], ['job_id · run_id · prompt_run_id', '', ''], SCOPE, ['answer_text', '', '답변 본문'], ['model_slug', '', ''], ['measured_at', '', ''], ['status · analysis_status', '', ''], ['region', '', 'Scope 측정 지역']], d: {
  grain: '답변 1건의 본문과 측정 메타 = 1행.', pk: 'answer_key', inputs: '데이터 분석팀', uses: '답변 모달, 검수 상세, 엔티티 카탈로그 초안 표본', cur: 'rd.v_answer_body',
  rules: ['접근 범위 열(surface · project_key · geo_key · bgrp)을 꼭 둡니다. BE 가 권한 검사를 이 열로 합니다.'] } });
tbl('answer_registry', { s: 'gold', name: 'answer_registry', fam: 'silver', grain: '앵커 고정·드롭 사유', cols: [['answer_key', 'PF', '', 'job_index'], SCOPE, ['pin_anchor · pin_reason', '', ''], ['drop_reason · dropped_at', '', ''], ['pin/drop_source_measured_at', '', '']], d: {
  grain: '답변 1건의 앵커 고정·드롭 기록 = 1행.', pk: 'answer_key', inputs: 'judgment_change anchor_pin · answer_drop', uses: '회차·job 관제, 검수 상세', cur: 'rd.v_answer_registry' } });
tbl('answer_citation_raw', { s: 'gold', name: 'answer_citation_raw', fam: 'silver', grain: '인용 원본', cols: [['answer_key · ord', 'PF', '', 'job_index'], SCOPE, ['url · title', '', ''], ['ref_index', '', ''], ['scope_category', '', ''], ['host · domain_label', '', '']], d: {
  grain: '답변의 인용 원본 1건 = 1행.', pk: 'answer_key + ord', inputs: '답변 원문 → 인용 정규화', uses: '검수 목록·상세의 인용 블록', cur: 'rd.v_answer_citation_raw' } });
tbl('answer_mention_raw', { s: 'gold', name: 'answer_mention_raw', fam: 'silver', grain: '언급 원본', cols: [['answer_key · ord', 'PF', '', 'job_index'], SCOPE, ['entity_id · entity_key', 'FK', '', 'dim_entity'], ['registry_role · entity_type', '', ''], ['display_name', '', ''], ['mention_count · avg_position', '', ''], ['brand_rollup_entity_id · surfaces[]', '', ''], ['sentiment_pos · neu · neg · mixed', '', ''], ['type_mention … type_final_choice', '', '']], d: {
  grain: '답변의 엔티티 언급 원본 1건 = 1행 (모든 엔티티, 브랜드 롤업 전).', pk: 'answer_key + ord', inputs: '브랜드 언급 추출 · 언급 감정 분류', uses: '답변 모달 언급 배지, 언급 프롬프트 상세, 검수 목록·상세, 엔티티 카탈로그 표면 표본', cur: 'rd.v_answer_mention_raw' } });
tbl('answer_occurrence', { s: 'gold', name: 'answer_occurrence', fam: 'silver', grain: '본문 안 등장 위치', cols: [['answer_key · ord', 'PF', '', 'job_index'], SCOPE, ['entity_id · turn_index', '', ''], ['source_start · source_end', '', '본문 위치'], ['surface_text', '', ''], ['sentiment · mention_role · assertion', '', ''], ['context_snippet', '', ''], ['descriptors[] · criteria[]', '', '']], d: {
  grain: '답변 본문 안 언급 등장 1건 = 1행.', pk: 'answer_key + ord', inputs: '브랜드 언급 추출', uses: '본문 하이라이트, 엔티티 카탈로그 린트·미리보기', cur: 'rd.v_answer_occurrence' } });
tbl('answer_stance_raw', { s: 'gold', name: 'answer_stance_raw', fam: 'silver', grain: '스탠스 근거', cols: [['answer_key · turn_index · entity_id', 'PF', '', 'job_index'], SCOPE, ['brand_label', '', ''], ['stance · confidence', '', ''], ['evidence_text', '', ''], ['evidence_start · evidence_end', '', ''], ['reason', '', '']], d: {
  grain: '답변 × 턴 × 엔티티의 스탠스 근거 = 1행.', pk: 'answer_key + turn_index + entity_id', inputs: '언급 감정 분류', uses: '답변 상세의 스탠스 근거', cur: 'rd.v_answer_stance_raw' } });
tbl('acr_cell_run', { s: 'gold', name: 'acr_cell_run', fam: 'silver', grain: 'ACR 셀 실행', cols: [['acr_cell_key', 'PK', '', 'acr_cell_fact'], ['prompt_run_id', '', ''], ['run_id', '', '']], d: {
  grain: 'ACR 셀 1개의 Scope 실행 id = 1행.', pk: 'acr_cell_key', inputs: 'ACR 답변 원문', uses: '검수 상세 ACR 블록', cur: 'rd.v_acr_cell_run' } });
tbl('entity_mention_surface', { s: 'gold', name: 'entity_mention_surface', fam: 'silver', grain: '엔티티 × 월 × 표면', cols: [['entity_id', 'PK', '', 'dim_entity'], ['run_month', 'PK', ''], ['surface', 'PK', '표면 문자열'], ['brand_rollup_entity_id', '', ''], ['display_name', '', '']], d: {
  grain: '엔티티 × 월 × 관측 표면 = 1행.', pk: 'entity_id + run_month + surface', inputs: '브랜드 언급 추출', uses: 'Entity catalog 초안의 표면별 언급 표본', cur: 'rd.v_entity_mention_surface' } });

/* ── BE 요청 큐 ── */
tbl('app_inputs', { s: 'applist', name: 'app 입력 설정', fam: 'queue', grain: '데이터 분석팀이 판정에 읽는 GEO HUB 설정', cols: [
  ['owned_base · project_owned_base', '', '자사 판정'], ['project_tracked_url · website_report_unit', '', '타겟 · 웹 유닛'], ['citation_category · citation_domain_override', '', '출처 분류'], ['brand · competitor_domain_token · non_competitor_name', '', '브랜드 규칙'],
  ['ecat_version · ecat_entity · ecat_surface · ecat_apply', '', '엔티티 카탈로그'], ['prompt · website_prompt · project', '', '카탈로그 · 프로젝트'], ['ga4_property · ga4_tracked_event', '', 'GA4'], ['hidden_market · rule_param · rule_set', '', '노출 · 규칙'] ], d: {
  grain: 'GEO HUB BE 가 소유하고 데이터 분석팀이 읽는 app 테이블 묶음입니다.', pk: '—', inputs: 'GEO HUB 관리 화면', triggers: '저장 시 트리거가 judgment_change 를 적재',
  uses: '데이터 분석팀 재판정의 입력', cur: 'app 스키마 (현행 그대로)', rules: ['데이터 분석팀은 이 테이블을 읽기만 합니다. 쓰기는 BE 만 합니다.'] } });
tbl('judgment_change', { s: 'app', name: 'judgment_change', fam: 'queue', grain: 'BE → 데이터 분석팀 요청 1건', cols: [
  ['change_id', 'PK', ''], ['kind', 'FK', '요청 종류 22', 'judgment_kind'], ['subject_uuids · subject_texts', '', ''], ['payload', '', 'jsonb'], ['requested_by · requested_at', '', ''],
  ['status', '', 'pending · running · applied · failed · escalated_rebuild'], ['claimed_at · applied_at', '', ''], ['applied_build_id', 'FK', '현행 applied_load_id', 'build'], ['error', '', ''] ], d: {
  grain: 'BE 의 재판정·운영·수집 요청 1건 = 1행.', pk: 'change_id', inputs: 'BE 쓰기 (설정 저장 트리거, 회차 관제, 키워드 수집 버튼)', triggers: '데이터 분석팀이 claim → 적용 → 새 build',
  uses: '반영 큐 화면, 키워드 수집 상태, 회차 관제 쓰기, 엔티티 버전 반영', cur: 'app.judgment_change (applied_load_id → ing.load)',
  rules: ['cycle_admin · anchor_pin · answer_drop 은 payload 가 필수입니다.', 'scope_prompt 는 데이터 분석팀이 스스로 넣는 유일한 종류입니다 (Scope 쪽 regions · lang · kind 변경).'] } });
tbl('judgment_kind', { s: 'key', name: '요청 종류 22', fam: 'queue', grain: 'judgment_change.kind 값', cols: [
  ['카탈로그 · 프롬프트', '', 'catalog · prompt_kind · website_catalog · scope_prompt'], ['엔티티 · 브랜드', '', 'entity · entity_version · brand_rule · competitor_token'], ['출처 · 자사 판정', '', 'citation_override · owned_base · project_owned_base · project_target_url'],
  ['프로젝트 · 노출', '', 'project_setting · hidden_market · rule_param'], ['회차 · 답변 운영', '', 'cycle_admin · anchor_pin · answer_drop'], ['발행', '', 'report_publication'], ['외부 수집 요청', '', 'dfs_fetch · ga4_property · ga4_tracked_event'] ], d: {
  grain: 'judgment_change.kind 에 들어갈 수 있는 값 22개를 7개 묶음으로 나눈 것입니다 (CHECK 제약).', pk: '—', inputs: '—', uses: '데이터 분석팀이 kind 별로 처리기를 고릅니다.', cur: 'app.judgment_change kind CHECK (합성 DB 기준 22종)' } });

/* ── 다른 탭 참조 상자 ── */
ghost('dim_prompt', [['prompt_key', 'PK', '']]); ghost('dim_project', [['project_key', 'PK', '']]); ghost('dim_lang', [['lang_key', 'PK', '']]); ghost('dim_url', [['url_key', 'PK', '']]);
ghost('dim_brand', [['brand_key', 'PK', '']]); ghost('dim_entity', [['entity_key', 'PK', '']]); ghost('dim_source', [['source_key', 'PK', '']]); ghost('dim_cycle', [['cyc_key', 'PK', '']]);
ghost('dim_taxon', [['taxon_key', 'PK', '']]); ghost('dim_engine', [['engine_key', 'PK', '']]); ghost('dim_country', [['geo_key', 'PK', '']]);
ghost('answer_fact', [['surface · round_date · answer_key', 'PK', '']]); ghost('answer_brand_fact', [['답변 PK · brand_key', 'PK', '']]); ghost('answer_stance_fact', [['답변 PK · turn · entity', 'PK', '']]);
ghost('citation_fact', [['답변 PK · ord', 'PK', '']]); ghost('job_index', [['answer_key', 'PK', '']]); ghost('build', [['build_id', 'PK', '']]);
ghost('publication', [['pub_key', 'PK', ''], ['build_id', 'FK', '', 'build']]); ghost('judgment_change', [['change_id', 'PK', ''], ['applied_build_id', 'FK', '', 'build']]);

/* ───────── 탭(뷰) ───────── */
const VIEWS = [
  { g: '차원', id: 'dim', label: '공통 차원', w: 1090, h: 660, main: 'cell_key',
    note: '셀 집계가 공유하는 키 묶음(C)과 공통 차원입니다. 정수 키는 현행 rd 처럼 발급 원장이고 재번호하지 않습니다.',
    pos: { dim_population: [20, 20, 220], dim_project: [20, 170, 220], dim_cycle: [20, 404, 240], cell_key: [320, 150, 240],
      dim_prompt_ref: [620, 20, 220], dim_engine: [620, 118, 220], dim_country: [620, 262, 220], dim_lang: [620, 442, 220], dim_region: [890, 290, 180] },
    loop: { 'dim_cycle>dim_project': 'L' } },
  { g: '차원', id: 'prompt', label: '프롬프트·웹 유닛', w: 1150, h: 520, main: 'dim_prompt',
    note: '프롬프트, 카탈로그 행, 웹사이트 보고 유닛입니다. Website KPI 는 보고 유닛 소속 프롬프트만 모수로 셉니다. dim_prompt → dim_project · dim_lang 관계는 열 옆에만 표시했습니다.',
    pos: { catalog_entry: [20, 20, 230], dim_taxon: [20, 262, 230], dim_prompt: [320, 20, 260], web_report_prompt: [650, 20, 230], web_unit: [650, 146, 230], web_target_url: [650, 380, 230],
      dim_project_ref: [950, 20, 180], dim_lang_ref: [950, 118, 180], dim_url_ref: [950, 216, 180], website_report_excluded: [950, 314, 180] },
    skip: ['dim_prompt>dim_project_ref', 'dim_prompt>dim_lang_ref'], loop: { 'catalog_entry>dim_taxon': 'L', 'web_report_prompt>web_unit': 'L' } },
  { g: '답변 계열', id: 'fact', label: '답변 사실', w: 1220, h: 840, main: 'answer_fact',
    note: '현행 rd.job · rd.answer · rd.answer_brand · rd.answer_stance · rd.citation 과 같은 그레인·열입니다. 현행 기능 대부분이 이 층을 읽고, 셀 집계는 여기서 만듭니다. 세 사실의 C 좌표 사본은 선이 겹쳐 생략했습니다.',
    pos: { job_index: [20, 20, 230], cell_key_c: [20, 300, 230], answer_fact: [320, 20, 290], answer_brand_fact: [690, 20, 270], answer_stance_fact: [690, 326, 270], citation_fact: [690, 578, 270],
      dim_brand_ref: [1030, 20, 170], dim_entity_ref: [1030, 118, 170], dim_url_ref: [1030, 600, 170], dim_source_ref: [1030, 698, 170] },
    skip: ['answer_brand_fact>cell_key_c', 'citation_fact>cell_key_c'], loop: { 'job_index>cell_key_c': 'L' } },
  { g: '답변 계열', id: 'kpi', label: 'KPI·언급 셀', w: 1330, h: 560, main: 'kpi_cell',
    note: '노출률·점유율·우호도·우선 노출도·스탠스와 경쟁 브랜드 비교를 셀 단위로 미리 더한 가속층입니다. 점선 화살표는 같은 build 의 사실에서 만든다는 뜻입니다.',
    pos: { answer_fact_ref: [20, 20, 160], answer_stance_fact_ref: [20, 118, 160], kpi_cell: [230, 20, 260], kpi_rollup: [230, 380, 260], cell_key_c: [560, 20, 190], dim_perspective: [560, 200, 190],
      brand_cell: [820, 20, 250], entity_mention_total: [820, 320, 250], answer_brand_fact_ref: [1130, 20, 170], dim_brand: [1130, 118, 170], dim_entity: [1130, 298, 170] },
    derive: [['answer_fact_ref', 'kpi_cell', 'SUM'], ['answer_stance_fact_ref', 'kpi_cell', 'SUM'], ['kpi_cell', 'kpi_rollup', 'SUM (가산 열)'], ['answer_brand_fact_ref', 'brand_cell', 'SUM']] },
  { g: '답변 계열', id: 'cit', label: '인용 셀', w: 1180, h: 790, main: 'citation_cell',
    note: '출처 · 카테고리 · 자사 판정과 URL 인용률입니다. citation_cell · url_prompt_cell 은 가속층이고, report_value 는 웹사이트 발행값이라 사실에서 다시 계산하지 않습니다.',
    pos: { dim_perspective: [20, 20, 190], owned_base: [20, 164, 190], citation_fact_ref: [20, 344, 190], answer_fact_ref: [20, 452, 190], citation_cell: [270, 20, 250], url_prompt_cell: [270, 300, 250],
      cell_key_c: [590, 20, 210], dim_source: [590, 200, 210], dim_url: [590, 416, 210], dim_category: [590, 632, 210], report_value: [900, 20, 240], dim_cycle_ref: [900, 272, 240] },
    skip: ['dim_url>owned_base'], derive: [['citation_fact_ref', 'citation_cell', 'SUM'], ['answer_fact_ref', 'url_prompt_cell', 'SUM']] },
  { g: '기타 계열', id: 'acr', label: 'ACR', w: 1170, h: 400, main: 'acr_cell_fact',
    note: 'AI 에이전트 최종 선택(ACR)입니다. 셀 단위 반복 모수와 엔티티 단위 선택 수를 나눠 적재하고, 배틀 승자는 필터를 건 뒤 BE 가 계산합니다.',
    pos: { cell_key_c: [20, 20, 200], job_index_ref: [20, 200, 200], acr_cell_fact: [290, 20, 260], acr_cell_job: [290, 272, 260], acr_entity_fact: [620, 20, 260], dim_entity: [950, 20, 180], dim_brand: [950, 190, 180] } },
  { g: '기타 계열', id: 'ga4', label: 'GA4', w: 870, h: 540, main: 'ga4_row', note: '',
    pos: { dim_engine: [20, 20, 190], ga4_row: [280, 20, 260], ga4_users_window: [280, 330, 260], ga4_property: [610, 20, 220], dim_country_ref: [610, 218, 220], ga4_value: [610, 326, 220] } },
  { g: '기타 계열', id: 'kw', label: '키워드', w: 960, h: 440, main: 'kw_volume_monthly',
    note: '키워드는 적재된 값을 그대로 씁니다. BE 의 수집 버튼은 judgment_change dfs_fetch 로 요청하고, 데이터 분석팀이 외부 호출 후 이 테이블에 씁니다. SERP 와 연관 검색어는 집계 없이 serve 뷰로 나갑니다.',
    pos: { kw_volume_monthly: [20, 20, 260], dim_keyword: [360, 20, 200], kw_serp: [650, 20, 280], kw_suggestion: [650, 236, 280] } },
  { g: '기타 계열', id: 'soc', label: '소셜', w: 900, h: 680, main: 'ctx_entity',
    note: '소셜 구매 맥락은 스냅샷 단위로 공개합니다. 연결 테이블의 snapshot_id 는 모두 ctx_snapshot 을 가리키지만 선은 ctx_entity 쪽만 그렸습니다.',
    pos: { ctx_snapshot: [20, 20, 220], ctx_entity: [310, 20, 250], ctx_drive: [640, 20, 230], ctx_combination: [640, 172, 230], ctx_domain: [640, 324, 230], ctx_evidence: [640, 476, 230] } },
  { g: '기타 계열', id: 'vis', label: 'AI Visibility', w: 830, h: 360, main: 'page_visibility_daily', note: '',
    pos: { page_visibility_daily: [20, 20, 260], page_crawl_daily: [20, 220, 260], dim_project_ref: [350, 20, 180], dim_url_ref: [350, 110, 180], dim_crawl_bot: [350, 220, 220], dim_engine_ref: [640, 220, 170] },
    loop: { 'page_crawl_daily>page_visibility_daily': 'L' } },
  { g: '공개', id: 'pub', label: '발행 세대', w: 1250, h: 670, main: 'publication',
    note: '대시보드 카드 경로 7개가 읽는 동결 값입니다. 발행 세대가 그 회차의 사실 build 를 고정하고, 셀 대표 집합·프롬프트 게이트·택소노미·표시명·웹 셀 판정을 발행 시점 값으로 보관합니다.',
    pos: { dim_cycle_ref: [20, 20, 190], build_ref: [20, 108, 190], publication: [280, 20, 260], pub_brand_name: [280, 300, 260], pub_cell: [610, 20, 250], pub_cell_web: [610, 200, 250], pub_prompt: [610, 380, 250],
      answer_fact_ref: [930, 20, 280], dim_prompt_ref: [930, 280, 280], pub_prompt_axis: [930, 380, 280], dim_taxon_ref: [930, 578, 280] },
    loop: { 'pub_brand_name>publication': 'L' } },
  { g: '공개', id: 'build', label: '빌드·릴리스', w: 1170, h: 490, main: 'build',
    note: '골드를 회차마다 자동 생성하되 검증을 통과한 세대만 보이게 하는 제어 테이블입니다. LIVE 는 active_release → release_item → build_id, 카드는 publication.build_id 를 읽습니다.',
    pos: { gold_facts: [20, 20, 280], publication_ref: [20, 274, 280], judgment_change_ref: [20, 380, 280], build: [370, 20, 260], release_item: [690, 20, 210], release: [960, 20, 190], active_release: [960, 190, 190] } },
  { g: '답변 계열', id: 'silver', label: '답변 원문', w: 1090, h: 730, main: 'answer_body',
    note: '답변 모달·검수·엔티티 카탈로그가 읽는 원문 조회 뷰입니다. 뷰 뒤의 원천은 데이터 분석팀 소관이고 BE 는 이 뷰 계약만 봅니다. 모든 뷰에 접근 범위 열이 있어야 BE 가 권한을 검사할 수 있습니다.',
    pos: { answer_body: [20, 20, 320], answer_registry: [20, 254, 320], answer_citation_raw: [20, 434, 320], job_index_ref: [420, 260, 230], acr_cell_run: [420, 420, 230], entity_mention_surface: [420, 560, 230],
      answer_mention_raw: [730, 20, 330], answer_occurrence: [730, 272, 330], answer_stance_raw: [730, 506, 330] } },
  { g: 'app', id: 'queue', label: 'BE 요청 큐', w: 1110, h: 320, main: 'judgment_change',
    note: 'GEO HUB 가 데이터 분석팀에 일을 넘기는 유일한 쓰기 경로입니다. 설정을 저장하면 트리거가 요청을 쌓고, 데이터 분석팀이 처리한 뒤 새 build 번호를 적습니다.',
    pos: { app_inputs: [20, 20, 330], judgment_change: [410, 20, 270], judgment_kind: [750, 20, 330], build_ref: [750, 220, 330] },
    derive: [['app_inputs', 'judgment_change', '저장 트리거']] },
];
const HOME = {};
VIEWS.forEach(v => Object.keys(v.pos).forEach(id => { if (!HOME[id] && !T[id].ghostOf) HOME[id] = v.id; }));
const viewLabel = id => (VIEWS.find(v => v.id === id) || {}).label || '';

/* ───────── 렌더 ───────── */
const NS = 'http://www.w3.org/2000/svg';
const RH = 18, HH = 26, GH = 18, PAD = 6;
const F_MONO = '11px "IBM Plex Mono", ui-monospace, monospace';
const F_NAME = '600 12px "IBM Plex Mono", ui-monospace, monospace';
const F_NOTE = '10px "IBM Plex Sans KR", "Malgun Gothic", system-ui, sans-serif';
const F_GRAIN = '10.5px "IBM Plex Sans KR", "Malgun Gothic", system-ui, sans-serif';
const cv = document.createElement('canvas').getContext('2d');
function tw(s, f) { cv.font = f; return cv.measureText(s).width; }
function fit(s, f, max) { if (max <= 8) return ''; if (tw(s, f) <= max) return s; let t = s; while (t.length > 1 && tw(t + '…', f) > max) t = t.slice(0, -1); return t + '…'; }
function el(tag, attrs, parent) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }
function stext(parent, x, y, cls, s, anchor) { const t = el('text', { x, y, class: cls }, parent); if (anchor) t.setAttribute('text-anchor', anchor); t.textContent = s; return t; }
function boxH(t) { return HH + GH + t.cols.length * RH + PAD; }
const PREFIX = { gold: 'gold.', app: 'app.', silver: 'serve.' };
function fullName(id) { const t = T[id]; if (!t) return id; const o = t.ghostOf ? T[t.ghostOf] : t; return (PREFIX[o.s] || '') + o.name; }
function refName(ref) { return T[ref] ? fullName(ref) : ref; }
function resolveIn(view, target) { if (view.pos[target]) return target; for (const id in view.pos) if (T[id].ghostOf === target) return id; return null; }
function pkCount(t) { return t.cols.filter(c => c[1] === 'PK' || c[1] === 'PF').length; }

const state = { view: null, sel: null };
const svg = document.getElementById('erd-svg');

function renderView(view) {
  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${view.w} ${view.h}`);
  svg.style.minWidth = Math.round(view.w * 0.8) + 'px';
  svg.setAttribute('aria-label', `${view.label} ERD: ${Object.keys(view.pos).map(id => T[id].name).join(', ')}`);
  const gE = el('g', { class: 'edges' }, svg), gT = el('g', { class: 'tables' }, svg);
  const geo = {};
  for (const id in view.pos) { const [x, y, w] = view.pos[id]; geo[id] = { x, y, w, h: boxH(T[id]) }; }
  const lanes = {};
  const laneC = k => { lanes[k] = (lanes[k] || 0) + 1; const n = lanes[k] - 1; return n === 0 ? 0 : (n % 2 ? (n + 1) / 2 : -n / 2); };
  const laneL = k => { lanes[k] = (lanes[k] || 0) + 1; return lanes[k] - 1; };
  function route(a, b, loopSide) {
    if (a.x + a.w <= b.x) { const sx = a.x + a.w, tx = b.x, m = (sx + tx) / 2; return { sx, tx, cx: m + 8 * laneC('c' + Math.round(m)), ds: 1, dt: -1 }; }
    if (b.x + b.w <= a.x) { const sx = a.x, tx = b.x + b.w, m = (sx + tx) / 2; return { sx, tx, cx: m + 8 * laneC('c' + Math.round(m)), ds: -1, dt: 1 }; }
    if ((loopSide || 'R') === 'R') { const sx = a.x + a.w, tx = b.x + b.w, base = Math.max(sx, tx); return { sx, tx, cx: base + 14 + 8 * laneL('R' + base), ds: 1, dt: 1 }; }
    const sx = a.x, tx = b.x, base = Math.min(sx, tx); return { sx, tx, cx: base - 14 - 8 * laneL('L' + base), ds: -1, dt: -1 };
  }

  // 관계선
  const edges = [], seen = new Set(), drawn = new Set();
  for (const id in view.pos) {
    T[id].cols.forEach((c, i) => {
      const ref = c[3]; if (!ref) return;
      const tg = resolveIn(view, ref); if (!tg || tg === id) return;
      const k = id + '>' + tg; if ((view.skip || []).includes(k)) return;
      drawn.add(id + '#' + i);
      if (seen.has(k)) return; seen.add(k);
      edges.push({ s: id, t: tg, r: i, one: c[1] === 'PF' && pkCount(T[id]) === 1 });
    });
  }
  for (const e of edges) {
    const a = geo[e.s], b = geo[e.t], tt = T[e.t];
    const sy = a.y + HH + GH + e.r * RH + RH / 2;
    const tr = tt.cols.findIndex(c => c[1] === 'PK' || c[1] === 'PF');
    const ty = (tt.s === 'key' || tt.s === 'applist' || tr < 0) ? b.y + HH / 2 : b.y + HH + GH + tr * RH + RH / 2;
    const { sx, tx, cx, ds, dt } = route(a, b, (view.loop || {})[e.s + '>' + e.t]);
    const g = el('g', { class: 'edge', 'data-s': e.s, 'data-t': e.t }, gE);
    el('path', { d: `M${sx},${sy} H${cx} V${ty} H${tx}` }, g);
    if (e.one) el('path', { d: `M${sx + 6 * ds},${sy - 5} V${sy + 5} M${sx + 10 * ds},${sy - 5} V${sy + 5}` }, g);
    else el('path', { d: `M${sx},${sy - 5} L${sx + 10 * ds},${sy} M${sx},${sy + 5} L${sx + 10 * ds},${sy} M${sx + 13 * ds},${sy - 5} V${sy + 5}` }, g);
    el('path', { d: `M${tx + 6 * dt},${ty - 5} V${ty + 5} M${tx + 10 * dt},${ty - 5} V${ty + 5}` }, g);
  }
  // 파생(같은 build 에서 합계)
  const inCount = {};
  (view.derive || []).forEach(([s, t, lbl]) => {
    const a = geo[s], b = geo[t];
    const g = el('g', { class: 'edge derive', 'data-s': s, 'data-t': t }, gE);
    if (a.x < b.x + b.w && b.x < a.x + a.w) {
      const x = a.x + a.w / 2;
      el('path', { class: 'ln', d: `M${x},${a.y + a.h} V${b.y - 2}` }, g);
      el('path', { class: 'head', d: `M${x - 5},${b.y - 9} L${x},${b.y - 1} L${x + 5},${b.y - 9} Z` }, g);
      stext(g, x + 10, (a.y + a.h + b.y) / 2 + 4, 'e-lbl', lbl);
      return;
    }
    const k = inCount[t] = (inCount[t] || 0) + 1;
    const sy = a.y + Math.min(a.h / 2, 40), ty = b.y + 9 + 10 * (k - 1);
    const { sx, tx, cx, dt } = route(a, b);
    const tip = tx + 2 * dt;
    el('path', { class: 'ln', d: `M${sx},${sy} H${cx} V${ty} H${tip + 7 * dt}` }, g);
    el('path', { class: 'head', d: `M${tip + 8 * dt},${ty - 4.5} L${tip},${ty} L${tip + 8 * dt},${ty + 4.5} Z` }, g);
    stext(g, (sx + cx) / 2, sy - 5, 'e-lbl', lbl, 'middle');
  });

  // 테이블
  for (const id in view.pos) {
    const t = T[id], { x, y, w, h } = geo[id];
    const kind = t.s;
    const g = el('g', { class: 'tbl v-' + kind, 'data-id': id, tabindex: '0', role: 'button' }, gT);
    g.setAttribute('aria-label', (t.ghostOf ? '다른 탭으로 이동: ' : '') + fullName(id));
    el('rect', { x, y, width: w, height: h, rx: 5, class: 'box' }, g);
    const hc = { gold: 'hdr-gold', app: 'hdr-app', applist: 'hdr-app', silver: 'hdr-silver', key: 'hdr-key', ghost: 'hdr-ghost' }[kind];
    el('path', { class: hc, d: `M${x + 0.5},${y + 5} a4.5,4.5 0 0 1 4.5,-4.5 H${x + w - 5} a4.5,4.5 0 0 1 4.5,4.5 V${y + HH} H${x + 0.5} Z` }, g);
    const nm = el('text', { x: x + 10, y: y + 17, class: 't-name' }, g);
    const orig = t.ghostOf ? T[t.ghostOf] : t;
    const pre = PREFIX[orig.s] || '';
    const label = t.name + (t.ghostOf ? '  ↗' : '');
    if (pre && tw(pre + label, F_NAME) <= w - 20) { const s1 = el('tspan', { class: 't-schema' }, nm); s1.textContent = pre; }
    const s2 = el('tspan', {}, nm); s2.textContent = fit(label, F_NAME, w - 20);
    const grain = t.ghostOf && T[t.ghostOf].s !== 'key' ? viewLabel(HOME[t.ghostOf]) + ' 탭' : t.ghostOf ? '키 11개 · 공통 차원 탭' : (t.grain || '');
    stext(g, x + 10, y + HH + 13, 't-grain', fit(grain, F_GRAIN, w - 20));
    el('line', { x1: x, x2: x + w, y1: y + HH + GH, y2: y + HH + GH, class: 'sep' }, g);
    const keyed = t.cols.some(cc => cc[1]);
    t.cols.forEach((c, i) => {
      const ry = y + HH + GH + i * RH + 12.5;
      if (c[1]) stext(g, x + 8, ry, 't-key k-' + c[1], c[1]);
      const nx = x + (keyed ? 30 : 10);
      const nameW = Math.min(tw(c[0], F_MONO), w - (nx - x) - 12);
      stext(g, nx, ry, 't-col', fit(c[0], F_MONO, w - (nx - x) - 12));
      let note = c[2], cls = 't-note';
      if (c[3] === id) { note = '→ 자기 참조'; cls = 't-ref'; }
      else if (c[3] && !drawn.has(id + '#' + i)) { note = '→ ' + (T[c[3]] ? T[c[3]].name : c[3]); cls = 't-ref'; }
      const avail = w - (nx - x) - nameW - 18;
      if (note && avail > 20) stext(g, x + w - 8, ry, cls, fit(note, F_NOTE, avail), 'end');
    });
    g.addEventListener('click', () => onPick(id));
    g.addEventListener('keydown', ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onPick(id); } });
  }
}

function onPick(id) {
  const t = T[id];
  if (t.ghostOf) { showView(HOME[t.ghostOf], t.ghostOf, true); return; }
  select(id);
}
function select(id) {
  state.sel = id;
  svg.classList.toggle('has-sel', !!id);
  const near = new Set();
  svg.querySelectorAll('.edge').forEach(e => {
    const hot = e.dataset.s === id || e.dataset.t === id;
    e.classList.toggle('hot', hot);
    if (hot) { near.add(e.dataset.s); near.add(e.dataset.t); }
  });
  svg.querySelectorAll('.tbl').forEach(g => { g.classList.toggle('sel', g.dataset.id === id); g.classList.toggle('near', near.has(g.dataset.id)); });
  renderDetail(id);
}
function gotoTable(id) { if (!T[id]) return; const home = HOME[id]; if (state.view && state.view.pos[id]) { select(id); document.getElementById('erd').scrollIntoView({ behavior: 'smooth', block: 'start' }); } else showView(home, id, true); }

const UPSTREAM = ['답변 정제', '프롬프트 매핑', '인용 정규화', '자사/타겟 URL 매칭', 'GA4 AI 유입 분류', '키워드 정규화', '브랜드 언급 추출', '언급 감정 분류', 'ACR 최종 선택 판정', '구매 맥락 추출', '답변 원문', 'ACR 답변 원문', '프롬프트 원천', 'GA4 리포트', '키워드 원천', '소셜 원문'];
// 브론즈·실버 단계 이름은 데이터 분석팀 소관이라 '데이터 분석팀' 한 단어로 접는다
function shortCur(s) { return s ? s.split('. ')[0].replace(/ \(현행 API 가 쓰는 열은 모두 보존\)/, '') : s; }
function srcOf(s) { if (!s) return s; return [...new Set(s.split(' + ').map(p => UPSTREAM.some(w => p.includes(w)) ? '데이터 분석팀' : p))].join(' + '); }
const LAYER = { gold: '골드', app: 'app (GEO HUB 소유)', applist: 'app (GEO HUB 소유)', silver: 'serve 뷰', key: '키 묶음', ghost: '' };
function renderDetail(id) {
  const t = T[id], d = t.d || {}, box = document.getElementById('detail');
  box.textContent = '';
  const head = document.createElement('div'); head.className = 'd-head';
  const h = document.createElement('h3'); h.textContent = t.s === 'key' || t.s === 'applist' ? t.name : fullName(id); head.appendChild(h);
  [FAM[t.fam], LAYER[t.s]].filter(Boolean).forEach((s, i) => { const c = document.createElement('span'); c.className = 'chip' + (i === 1 && t.s === 'gold' ? ' warn' : ''); c.textContent = s; head.appendChild(c); });
  box.appendChild(head);
  const grid = document.createElement('div'); grid.className = 'd-grid';
  const left = document.createElement('div');
  const dl = document.createElement('dl'); dl.className = 'kv';
  [['한 행', t.grain], ['PK', d.pk], ['현행', shortCur(d.cur)]].forEach(([k, v]) => {
    if (!v) return; const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd);
  });
  left.appendChild(dl);
  const right = document.createElement('div'); right.className = 'cols-wrap';
  const tb = document.createElement('table'); tb.className = 'cols';
  tb.innerHTML = '<thead><tr><th>열</th><th>키</th><th>설명</th><th>참조</th></tr></thead>';
  const body = document.createElement('tbody');
  t.cols.forEach(c => {
    const tr = document.createElement('tr');
    const td1 = document.createElement('td'); td1.textContent = c[0];
    const td2 = document.createElement('td'); td2.className = 'kc'; td2.textContent = c[1] || '';
    td2.style.color = c[1] === 'FK' ? 'var(--app)' : c[1] ? 'var(--gold-ink)' : '';
    const td3 = document.createElement('td'); td3.textContent = c[2] || '';
    const td4 = document.createElement('td');
    if (c[3] && T[c[3]]) {
      const b = document.createElement('button'); b.className = 'linkbtn'; b.type = 'button'; b.textContent = refName(c[3]);
      b.addEventListener('click', () => gotoTable(c[3]));
      td4.appendChild(b);
    } else if (c[3]) td4.textContent = c[3];
    tr.append(td1, td2, td3, td4); body.appendChild(tr);
  });
  tb.appendChild(body); right.appendChild(tb);
  grid.append(left, right); box.appendChild(grid);
}

function showView(vid, selId, scroll) {
  const view = VIEWS.find(v => v.id === vid) || VIEWS[0];
  state.view = view;
  document.querySelectorAll('.tab').forEach(b => { const on = b.dataset.v === view.id; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
  renderView(view);
  select(selId && view.pos[selId] ? selId : view.main);
  try { localStorage.setItem('gold-erd-view-v2', view.id); } catch (e) {}
  if (scroll) document.getElementById('erd').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* 탭 */
const tabs = document.getElementById('tabs');
const groups = [];
VIEWS.forEach(v => { let g = groups.find(x => x.g === v.g); if (!g) groups.push(g = { g: v.g, views: [] }); g.views.push(v); });
groups.forEach(gr => {
  const row = document.createElement('div'); row.className = 'tabgroup';
  const lb = document.createElement('span'); lb.className = 'tg-label'; lb.textContent = gr.g; row.appendChild(lb);
  gr.views.forEach(v => {
    const b = document.createElement('button'); b.className = 'tab'; b.type = 'button'; b.setAttribute('role', 'tab'); b.dataset.v = v.id; b.id = 'tab-' + v.id;
    const n = Object.keys(v.pos).filter(id => !T[id].ghostOf && T[id].s !== 'key' && T[id].s !== 'applist').length;
    const s1 = document.createElement('span'); s1.textContent = v.label; const s2 = document.createElement('span'); s2.className = 'n'; s2.textContent = n;
    b.append(s1, s2);
    b.addEventListener('click', () => showView(v.id));
    row.appendChild(b);
  });
  tabs.appendChild(row);
});
tabs.addEventListener('keydown', e => {
  if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
  const i = VIEWS.findIndex(v => v.id === state.view.id), j = (i + (e.key === 'ArrowRight' ? 1 : -1) + VIEWS.length) % VIEWS.length;
  showView(VIEWS[j].id); document.getElementById('tab-' + VIEWS[j].id).focus();
});

/* ───────── 기능 커버리지 ───────── */
const OLD2NEW = {
  'rd.answer': ['answer_fact'], 'rd.answer_brand': ['answer_brand_fact'], 'rd.answer_stance': ['answer_stance_fact'], 'rd.citation': ['citation_fact'], 'rd.job': ['job_index'],
  'rd.cycle': ['dim_cycle'], 'rd.dim_brand_name': ['dim_brand'], 'rd.dim_source': ['dim_source'], 'rd.dim_prompt': ['dim_prompt'], 'rd.dim_entity': ['dim_entity'], 'rd.dim_country': ['dim_country'],
  'rd.dim_region': ['dim_region'], 'rd.dim_taxon': ['dim_taxon'], 'rd.dim_project': ['dim_project'], 'rd.dim_engine': ['dim_engine'], 'rd.dim_lang': ['dim_lang'], 'rd.dim_url': ['dim_url'],
  'rd.catalog_entry': ['catalog_entry'], 'rd.ga4_dim_property': ['ga4_property'], 'rd.ga4_dim_value': ['ga4_value'], 'rd.ga4_row': ['ga4_row'],
  'rd.dim_keyword': ['dim_keyword'], 'rd.kw_volume_monthly': ['kw_volume_monthly'], 'rd.kw_serp': ['kw_serp'], 'rd.kw_suggestion': ['kw_suggestion'],
  'ext.ctx_snapshot': ['ctx_snapshot'], 'ext.ctx_entity': ['ctx_entity'], 'ext.ctx_drive': ['ctx_drive'], 'ext.ctx_combination': ['ctx_combination'], 'ext.ctx_domain': ['ctx_domain'], 'ext.ctx_evidence': ['ctx_evidence'],
  'rd.report_unit_value': ['report_value'], 'rd.acr_cell': ['acr_cell_fact'], 'rd.acr_choice': ['acr_entity_fact'], 'rd.acr_cell_job': ['acr_cell_job'],
  'rd.v_answer_body': ['answer_body'], 'rd.v_answer_mention_raw': ['answer_mention_raw'], 'rd.v_answer_occurrence': ['answer_occurrence'], 'rd.v_answer_stance_raw': ['answer_stance_raw'],
  'rd.v_answer_citation_raw': ['answer_citation_raw'], 'rd.v_answer_registry': ['answer_registry'], 'rd.v_acr_cell_run': ['acr_cell_run'], 'rd.v_entity_mention_surface': ['entity_mention_surface'],
  'rd.entity_mention_total': ['entity_mention_total'], 'rd.web_unit': ['web_unit'], 'rd.web_report_prompt': ['web_report_prompt'], 'rd.web_target_url': ['web_target_url'],
  'rd.rep_cit_delta': ['answer_fact'], 'rd.surface_generation': ['active_release'], 'rd.today_kst': ['~today_kst()'],
  'frz.generation': ['publication'], 'frz.cell': ['pub_cell'], 'frz.cell_web': ['pub_cell_web'], 'frz.prompt': ['pub_prompt'], 'frz.prompt_axis': ['pub_prompt_axis'], 'frz.brand_name': ['pub_brand_name'],
  'frz.kept': ['publication'], 'frz.keep_answer': ['publication'], 'frz.keep_answer_brand': ['publication'], 'frz.keep_citation': ['publication'],
  'frz.card': ['publication', 'pub_cell', 'pub_cell_web', 'pub_prompt', 'pub_prompt_axis', 'pub_brand_name'], 'frz.grid': ['publication', 'pub_cell', 'pub_prompt'],
  'ing.load': ['build'], 'app.judgment_change': ['judgment_change'],
  'need.visibility': ['page_visibility_daily', 'page_crawl_daily', 'dim_crawl_bot', 'dim_url', 'dim_project'], 'need.acr': ['acr_cell_fact', 'acr_entity_fact', 'dim_entity', 'dim_brand'],
  'need.social': ['ctx_snapshot', 'ctx_entity', 'ctx_drive', 'ctx_combination', 'ctx_domain', 'ctx_evidence'], 'need.ga4_users': ['ga4_users_window', 'ga4_row'],
};
const ACCEL_OF = { 'analytics/kpi/compare': ['kpi_cell', 'kpi_rollup'], 'analytics/kpi/engines': ['kpi_cell'], 'analytics/kpi/summary': ['kpi_cell', 'kpi_rollup'], 'analytics/geo/markets': ['kpi_cell', 'brand_cell'],
  'analytics/trend/series': ['kpi_cell', 'brand_cell', 'citation_cell'], 'analytics/mentions/brands': ['brand_cell'], 'analytics/mentions/types': ['kpi_cell'], 'analytics/citations/domains': ['citation_cell'],
  'analytics/citations/sources': ['citation_cell'], 'analytics/citations/tone': ['citation_cell'], 'analytics/citations/targets': ['url_prompt_cell'] };
const CARD = new Set(['analytics/kpi/summary', 'analytics/mentions/brands', 'analytics/trend/series', 'analytics/geo/markets', 'analytics/kpi/engines', 'analytics/citations/domains', 'analytics/kpi/compare']);
const MODULES = [
  ['admin/accounts/users', 'rd.dim_country'],
  ['admin/catalog/prompts', 'rd.dim_project rd.dim_prompt rd.dim_taxon'],
  ['admin/catalog/reference', 'rd.dim_project'],
  ['admin/changes/queue', 'app.judgment_change ing.load'],
  ['admin/citation_sources/overrides', 'rd.citation rd.dim_source'],
  ['admin/cycles/cycles', 'rd.answer rd.cycle rd.dim_project rd.job rd.today_kst'],
  ['admin/cycles/jobs', 'rd.answer rd.cycle rd.job rd.today_kst rd.v_answer_registry'],
  ['admin/entities/registry', 'rd.dim_brand_name rd.dim_entity rd.dim_project rd.entity_mention_total rd.today_kst'],
  ['admin/entities/versions', 'rd.answer_brand rd.cycle rd.dim_brand_name rd.dim_entity rd.today_kst rd.v_answer_body rd.v_answer_mention_raw rd.v_answer_occurrence rd.v_entity_mention_surface'],
  ['admin/integrations/ga4', 'rd.ga4_dim_property rd.ga4_dim_value rd.ga4_row rd.today_kst'],
  ['admin/integrations/keyword_tools', 'rd.dim_keyword rd.kw_volume_monthly'],
  ['analytics/answers/detail', 'rd.answer_brand rd.answer_stance rd.catalog_entry rd.cycle rd.dim_brand_name rd.dim_entity rd.dim_project rd.dim_source rd.dim_taxon rd.dim_url rd.job rd.surface_generation rd.today_kst rd.v_answer_body rd.v_answer_mention_raw rd.v_answer_occurrence rd.v_answer_stance_raw'],
  ['analytics/answers/list', 'rd.answer rd.answer_brand rd.dim_brand_name rd.dim_source rd.job'],
  ['analytics/citations/domain_detail', 'rd.citation rd.dim_brand_name rd.dim_source rd.dim_taxon rd.dim_url rd.job'],
  ['analytics/citations/domains', 'rd.answer rd.citation rd.dim_brand_name rd.dim_source frz.card'],
  ['analytics/citations/prompts', 'rd.answer rd.citation rd.dim_prompt rd.dim_taxon rd.job'],
  ['analytics/citations/sources', 'rd.answer rd.answer_brand rd.citation rd.dim_source'],
  ['analytics/citations/targets', 'rd.answer rd.report_unit_value'],
  ['analytics/citations/tone', 'rd.answer rd.citation rd.dim_source rd.dim_url'],
  ['analytics/filters/dates', 'rd.cycle'],
  ['analytics/filters/options', 'rd.answer rd.catalog_entry rd.citation rd.dim_country rd.dim_engine rd.dim_project rd.dim_region rd.dim_source rd.dim_taxon rd.job'],
  ['analytics/funnel/acr', 'rd.acr_cell rd.acr_choice rd.cycle rd.dim_brand_name rd.dim_country rd.dim_engine rd.dim_entity rd.dim_lang'],
  ['analytics/funnel/conversion', 'rd.dim_engine rd.ga4_dim_property rd.ga4_dim_value rd.ga4_row rd.today_kst'],
  ['analytics/geo/markets', 'rd.answer rd.catalog_entry rd.dim_brand_name rd.dim_country frz.card'],
  ['analytics/kpi/compare', 'rd.answer frz.card'],
  ['analytics/kpi/engines', 'rd.answer frz.card'],
  ['analytics/kpi/summary', 'rd.answer rd.catalog_entry rd.dim_prompt rd.dim_taxon rd.today_kst frz.card'],
  ['analytics/mentions/brands', 'rd.answer rd.answer_brand rd.dim_brand_name frz.card'],
  ['analytics/mentions/prompts', 'rd.dim_brand_name rd.dim_country rd.dim_engine rd.dim_entity rd.dim_taxon rd.job rd.v_answer_mention_raw'],
  ['analytics/mentions/types', 'rd.answer rd.answer_brand rd.answer_stance'],
  ['analytics/trend/series', 'rd.answer rd.answer_brand rd.citation rd.cycle rd.dim_brand_name rd.dim_source rd.job frz.card frz.grid'],
  ['catalog/prompts/catalog', 'rd.answer rd.dim_project rd.dim_prompt rd.dim_taxon'],
  ['intent/keywords/fetches', 'rd.kw_suggestion app.judgment_change'],
  ['intent/keywords/research', 'rd.dim_keyword rd.kw_serp rd.kw_suggestion rd.kw_volume_monthly'],
  ['intent/keywords/serp_drafts', 'rd.dim_keyword rd.kw_serp'],
  ['intent/keywords/tracked', 'rd.dim_keyword rd.kw_volume_monthly'],
  ['intent/social/context_map', 'ext.ctx_combination ext.ctx_domain ext.ctx_drive ext.ctx_entity ext.ctx_evidence ext.ctx_snapshot'],
  ['projects/project/core', 'rd.dim_engine'],
  ['projects/prompts/lifecycle', 'rd.answer rd.answer_brand rd.citation rd.cycle rd.dim_project rd.dim_prompt'],
  ['projects/settings/engines', 'rd.dim_engine'],
  ['projects/settings/scope_link', 'rd.answer rd.cycle rd.dim_project rd.job'],
  ['qa/answers/detail', 'rd.acr_cell rd.acr_cell_job rd.acr_choice rd.answer rd.citation rd.dim_brand_name rd.dim_entity rd.dim_lang rd.dim_project rd.dim_prompt rd.dim_taxon rd.dim_url rd.job rd.v_acr_cell_run rd.v_answer_body rd.v_answer_citation_raw rd.v_answer_mention_raw rd.v_answer_registry'],
  ['qa/answers/list', 'rd.dim_country rd.dim_engine rd.dim_lang rd.dim_prompt rd.job rd.v_answer_citation_raw rd.v_answer_mention_raw'],
  ['qa/notes/notes', 'rd.dim_prompt rd.job'],
  ['qa/review/deltas', 'rd.job'],
  ['screen/Global > AI Visibility', 'need.visibility'], ['screen/Project > AI Visibility', 'need.visibility'], ['screen/Project > ACR', 'need.acr'], ['screen/Website > ACR', 'need.acr'],
  ['screen/Global > Social Scraping', 'need.social'], ['screen/Admin > Customer interest config 맥락 지도', 'need.social'], ['screen/AI Conversion 순 방문자 · 방문 빈도', 'need.ga4_users'],
  ['core (공통 지표 빌더 · 카드 경로)', 'rd.web_unit rd.web_report_prompt rd.web_target_url rd.rep_cit_delta rd.surface_generation frz.generation frz.cell frz.cell_web frz.prompt frz.prompt_axis frz.brand_name frz.kept frz.keep_answer frz.keep_answer_brand frz.keep_citation'],
];
let covOk = 0;
(function coverage() {
  const root = document.getElementById('cov');
  const hr = document.createElement('div'); hr.className = 'cov-row cov-head';
  ['모듈', '테이블', ''].forEach(s => { const d = document.createElement('div'); d.textContent = s; hr.appendChild(d); });
  root.appendChild(hr);
  const AREA = { admin: 'Admin', analytics: '분석 화면', catalog: '카탈로그', intent: 'Intent', projects: 'Project', qa: '원본 데이터 검수', screen: '정적 표본 · API 미지원 화면', core: '공통' };
  let lastArea = null;
  MODULES.forEach(([mod, objs]) => {
    const area = mod.split(/[/ ]/)[0];
    if (area !== lastArea) {
      lastArea = area;
      const n = MODULES.filter(m => m[0].split(/[/ ]/)[0] === area).length;
      const g = document.createElement('div'); g.className = 'cov-group'; g.textContent = AREA[area] || area;
      const sp = document.createElement('span'); sp.textContent = `모듈 ${n}`; g.appendChild(sp); root.appendChild(g);
    }
    const old = objs.split(' ');
    const ids = new Set(), missing = [];
    old.forEach(o => { const m = OLD2NEW[o]; if (!m) missing.push(o); else m.forEach(x => ids.add(x)); });
    (ACCEL_OF[mod] || []).forEach(x => ids.add(x));
    const r = document.createElement('div'); r.className = 'cov-row';
    const m = document.createElement('div'); m.className = 'cov-mod';
    const mt = document.createElement('span'); mt.textContent = mod.replace(/^(admin|analytics|catalog|intent|projects|qa|screen)\//, ''); m.appendChild(mt);
    if (CARD.has(mod)) { const b = document.createElement('span'); b.className = 'badge card'; b.textContent = '카드 동결'; m.appendChild(b); }
    if (ACCEL_OF[mod]) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = '셀 가속'; m.appendChild(b); }
    const mid = document.createElement('div');
    const pills = document.createElement('div'); pills.className = 'cov-tabs';
    [...ids].forEach(x => {
      if (x.startsWith('~')) { const p = document.createElement('span'); p.className = 'pill p-fn'; p.textContent = x.slice(1); pills.appendChild(p); return; }
      const t = T[x]; const p = document.createElement('button'); p.type = 'button';
      p.className = 'pill ' + (t.s === 'silver' ? 'p-silver' : t.s === 'app' ? 'p-app' : (ACCEL_OF[mod] || []).includes(x) ? 'p-gold' : '');
      p.textContent = t.name; p.title = (ACCEL_OF[mod] || []).includes(x) ? '가속층 (선택)' : fullName(x);
      p.addEventListener('click', () => gotoTable(x)); pills.appendChild(p);
    });
    mid.appendChild(pills);
    
    const ok = document.createElement('div'); ok.className = missing.length ? 'cov-bad' : 'cov-ok'; ok.textContent = missing.length ? '빠짐 ' + missing.join(', ') : '대응';
    if (!missing.length) covOk++;
    r.append(m, mid, ok); root.appendChild(r);
  });
})();

/* 헤더 숫자 */
(function meta() {
  const real = Object.values(T).filter(t => !t.ghostOf && t.d);
  const gold = real.filter(t => t.s === 'gold').length, silver = real.filter(t => t.s === 'silver').length, app = real.filter(t => t.s === 'app').length;
  const m = document.getElementById('meta');
  const chips = [['논리 설계 · DDL 아님', null, true], ['화면 영역', '346 / 346'], ['기능 대응', `${covOk} / ${MODULES.length}`], ['골드 테이블', gold], ['app 참조', app], ['화면 항목', ITEMS.reduce((a, s) => a + s.items.length, 0)], ['기준일', '2026-10-19']];
  chips.forEach(([k, v, warn]) => { const c = document.createElement('span'); c.className = 'chip' + (warn ? ' warn' : ''); c.textContent = k + (v != null ? ' ' : ''); if (v != null) { const b = document.createElement('b'); b.textContent = v; c.appendChild(b); } m.appendChild(c); });
})();

/* 화면 × 데이터 계열 */
(function matrix() {
  const FAMOF = { '답변': ['kpi'], '언급': ['kpi'], '언급+감정': ['kpi'], '엔티티': ['kpi'], '인용': ['cit'], '인용+자사': ['cit'], '인용+감정': ['cit'], '도메인': ['cit'],
    '언급+인용': ['kpi', 'cit'], 'KPI 전체': ['kpi', 'cit'], 'ACR': ['acr'], 'GA4': ['ga4'], '키워드': ['kw'], '소셜': ['soc'], '프롬프트 연결': ['dim'] };
  const COLS = [['dim', '프롬프트 연결'], ['kpi', '언급 계열'], ['cit', '인용 계열'], ['acr', 'ACR'], ['ga4', 'GA4'], ['kw', '키워드'], ['soc', '소셜'], ['silver', '원문·목록']];
  const root = document.getElementById('matrix');
  const hr = document.createElement('div'); hr.className = 'mx-row mx-headrow';
  hr.appendChild(Object.assign(document.createElement('div'), { textContent: '화면' }));
  COLS.forEach(([, l]) => hr.appendChild(Object.assign(document.createElement('div'), { textContent: l })));
  hr.appendChild(Object.assign(document.createElement('div'), { textContent: '항목' }));
  root.appendChild(hr);
  const grs = [];
  ITEMS.forEach(s => { const top = s.screen.split(' > ')[0]; let g = grs.find(x => x.top === top); if (!g) grs.push(g = { top, rows: [] }); g.rows.push(s); });
  grs.forEach(g => {
    const n = g.rows.reduce((a, s) => a + s.items.length, 0);
    const gh = document.createElement('div'); gh.className = 'mx-group'; gh.textContent = g.top;
    const sp = document.createElement('span'); sp.textContent = `화면 ${g.rows.length} · 항목 ${n}`; gh.appendChild(sp); root.appendChild(gh);
    g.rows.forEach(s => {
      const cnt = {}; COLS.forEach(([k]) => cnt[k] = 0);
      s.items.forEach(i => { if (i.g) cnt.silver++; else (FAMOF[i.s] || []).forEach(f => cnt[f]++); });
      const det = document.createElement('details'); det.className = 'mx-item';
      const sumEl = document.createElement('summary'); const sum = document.createElement('div'); sum.className = 'mx-row'; sumEl.appendChild(sum);
      const nm = document.createElement('div'); nm.className = 'mx-name'; const nt = document.createElement('span'); nt.textContent = s.screen.split(' > ').slice(1).join(' › ') || s.screen; nm.appendChild(nt); sum.appendChild(nm);
      COLS.forEach(([k]) => { const c = document.createElement('div'); c.className = 'mx-c'; const sp2 = document.createElement('span'); const v = cnt[k];
        sp2.className = v === 0 ? 'c0' : k === 'silver' ? 'cs' : v >= 5 ? 'c2' : 'c1'; sp2.textContent = v === 0 ? '·' : v; c.appendChild(sp2); sum.appendChild(c); });
      const tot = document.createElement('div'); tot.className = 'mx-tot'; tot.textContent = s.items.length; sum.appendChild(tot);
      det.appendChild(sumEl);
      const list = document.createElement('div'); list.className = 'mx-items';
      s.items.forEach(i => { const r = document.createElement('div'); r.className = 'mx-it';
        const a = document.createElement('span'); a.textContent = i.n;
        const k = document.createElement('span'); k.className = 'tag'; k.textContent = `${i.k} · ${i.s}`;
        const l = document.createElement('span'); l.className = 'lay ' + (i.g ? 'lay-s' : 'lay-g'); l.textContent = i.g ? '원문·목록' : 'gold';
        r.append(a, k, l); list.appendChild(r); });
      det.appendChild(list); root.appendChild(det);
    });
  });
})();

/* 시작 */
function start() {
  let v = null;
  const hv = (location.hash || '').replace('#', '');
  if (VIEWS.some(x => x.id === hv)) v = hv;
  if (!v) { try { v = localStorage.getItem('gold-erd-view-v2'); } catch (e) {} }
  showView(v || 'fact');
}
start();
if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (state.view) { const s = state.sel; renderView(state.view); select(s); } });

/* ───────── 스키마 경계 ───────── */
function schemaOf(id) {
  if (typeof id === 'string' && id.startsWith('app.')) return 'app';
  const t = T[id]; if (!t) return null;
  const o = t.ghostOf ? T[t.ghostOf] : t;
  if (o.s === 'silver') return 'serve';
  if (o.s === 'app' || o.s === 'applist' || o.fam === 'queue') return 'app';
  return 'gold';
}
const APP_GROUPS = [
  { title: '판정 · 수집 입력', note: 'BE 가 쓰고 데이터 분석팀이 재판정 때 읽습니다. 저장하면 트리거가 judgment_change 를 쌓습니다.', items: ['owned_base', 'project_owned_base', 'project_tracked_url', 'website_site', 'website_prompt', 'website_report_unit', 'website_report_excluded', 'citation_category', 'citation_domain_override', 'brand', 'brand_name_prefix', 'brand_display_alias', 'competitor_domain_token', 'non_competitor_name', 'entity_registry', 'entity_alias', 'rhq_region', 'rhq_region_country', 'hidden_market', 'rule_param', 'rule_set', 'ga4_property', 'ga4_tracked_event', 'project', 'prompt', 'standard_keyword', 'standard_source', 'project_tracked_keyword'] },
  { title: '엔티티 카탈로그', note: 'BE 가 버전·초안을 편집하고, 데이터 분석팀이 읽어서 반영합니다. ecat_apply 진행률과 ecat_review 신규 표면 제안은 데이터 분석팀이 씁니다.', items: ['ecat_version', 'ecat_entity', 'ecat_surface', 'ecat_surface_def', 'ecat_apply', 'ecat_review', 'ecat_audit_log'] },
  { title: '요청 · 연동 큐', note: 'BE 가 쌓고 데이터 분석팀이 상태를 갱신합니다. 데이터 분석팀은 Scope 연결 id(project.scope_project_id · prompt.scope_prompt_id)도 채웁니다.', items: ['judgment_change', 'scope_outbox'] },
  { title: '발행 리포트', note: '웹사이트 발행 리포트 원장입니다. gold.report_value 의 출처입니다.', items: ['report_publication', 'report_site_fact', 'report_site_engine_fact'] },
  { title: 'BE 전용', note: '데이터 분석팀이 읽지 않습니다. 사용자·멤버, 프로젝트 추적 대상, 후보 풀, 커스텀 필드, 프롬프트 초안.', items: ['user_account', 'project_member', 'project_engine_history', 'project_custom_field', 'prompt_custom_field_value', 'prompt_candidate', 'project_tracked_brand', 'project_tracked_competitor', 'project_tracked_vehicle', 'kw_prompt_draft', 'ctx_generated_prompt', 'ga4_market_pending'] },
  { title: '검수 · 감사', note: '검수 리뷰·노트·잠금과 감사 로그입니다. 저장과 같은 트랜잭션으로 갱신해야 해서 골드 빌드와 묶지 않습니다.', items: ['qa_review_session', 'qa_answer_review', 'qa_review_note', 'qa_answer_lock', 'access_audit_log', 'member_audit_log', 'permission_audit_log', 'prompt_audit_log'] },
];
const INTERNAL = [
  { title: 'rcache · 결과 캐시', note: 'BE 응답 캐시입니다. 캐시 키의 데이터 버전을 지금은 rd.surface_generation 에서, 골드에서는 gold.active_release.version 에서 받습니다.', items: ['rcache.entry', 'rcache.stat', 'rcache.data_version'] },
  { title: 'mig · 이관 · 대조 원장', note: '현행 운영 데이터와 허브 결과를 대조하고 화면 그룹별로 전환하는 원장입니다 (migrator 역할).', items: ['mig.source_snapshot', 'mig.copy_chunk', 'mig.rebuild_batch', 'mig.partition_checksum', 'mig.run_fingerprint', 'mig.parity_run', 'mig.parity_result', 'mig.known_diff', 'mig.row_oracle_diff', 'mig.screen_group', 'mig.cutover_event', 'mig.repull_log', 'mig.archive_manifest'] },
];
const SCHEMAS = [
  { id: 'gold', label: 'gold', sub: '데이터 분석팀 쓰기 · BE 읽기 전용', desc: '화면이 읽는 데이터 전부입니다. ERD 탭 11개(공통 차원 ~ 빌드·릴리스)가 모두 이 스키마에 들어가고, 계열 구분은 테이블 이름 접두어(dim_ · *_fact · *_cell · pub_ · ga4_ · kw_ · ctx_)로 합니다.',
    chips: [['쓰기', '데이터 분석팀 (loader)'], ['읽기', 'BE (api_ro)']],
    rules: ['BE 는 SELECT 만 합니다. 정정이 필요하면 app.judgment_change 로 요청합니다.', '큰 사실 테이블은 스키마를 나누지 않고 표면 × 회차일로 파티션합니다 (현행 rd 와 같음).', '공개는 active_release 전환 한 번으로 일어납니다. 계열이 한 스키마에 있어 여러 계열을 함께 바꾸기 쉽습니다.'] },
  { id: 'app', label: 'app', sub: 'BE 쓰기 · 데이터 분석팀 읽기 · 일부 상태 갱신', desc: 'GEO HUB BE 가 소유하는 설정·요청·운영 데이터입니다. 현행 app 스키마 60개 테이블을 쓰는 쪽 기준으로 나눴습니다. 데이터 분석팀 쓰기는 현행 적재기 코드에서 확인한 것만 적었습니다.',
    chips: [['쓰기', 'BE (api_rw)'], ['읽기', '데이터 분석팀 (loader)'], ['데이터 분석팀 갱신', 'judgment_change · scope_outbox · ecat_apply · ecat_review · ecat_audit_log · project · prompt']],
    groups: APP_GROUPS,
    rules: ['데이터 분석팀이 app 에 쓰는 곳은 상태 열과 Scope 연결 id 로 한정합니다. 설정 값 자체는 BE 만 씁니다.', '현행 DDL 은 rd.dim_source → app.citation_category, rd.dim_url → app.owned_base 에 스키마를 넘는 FK 가 있습니다. 소유자가 갈라지면 FK 를 유지할지 빌드 검증으로 바꿀지 정해야 합니다.'] },
  { id: 'internal', label: 'rcache · mig', sub: 'BE 내부', desc: 'BE 가 혼자 쓰는 운영 스키마입니다. 골드 설계와 무관하게 그대로 둡니다.',
    chips: [['쓰기', 'BE (api_rw) · migrator'], ['읽기', 'BE']], rules: ['골드 전환 뒤 캐시 무효화는 active_release.version 변경을 기준으로 합니다.'] },
];
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
  const h = document.createElement('h3'); h.textContent = sc.label;
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
  top.append(h, chips); p.appendChild(top);

  const grid = document.createElement('div'); grid.className = 'sch-groups';
  const card = (title, n, note) => { const g = document.createElement('div'); g.className = 'sch-g'; const h4 = document.createElement('h4'); h4.textContent = title; const sp = document.createElement('span'); sp.textContent = n; h4.appendChild(sp); g.appendChild(h4); return g; };
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

