# mention-4kpi-tabs

## ADDED Requirements

### Requirement: standard mention 화면은 4-KPI 탭으로 나뉜다

`/standard/answer-analysis/mention` 은 `?kpi=exposure|sov|favorability|first-rank` 네 탭을
제공해야 한다(SHALL). 파라미터 부재·미지값은 `exposure` 로 폴백한다. 탭 전환은 현재 적용된
디멘션·프롬프트 필터를 유지해야 하며(SHALL), website/project 표면의 mention 화면은 이 변경의
영향을 받지 않아야 한다(SHALL — 회귀 기준).

#### Scenario: 탭 전환 시 필터 유지
- **WHEN** 필터(브랜드·국가·엔진·기간·depth 등)를 적용한 상태에서 다른 KPI 탭으로 전환하면
- **THEN** 동일 필터가 적용된 채 해당 KPI 데이터가 로드된다 (URL 에 필터 파라미터 보존)

#### Scenario: 타 표면 무영향
- **WHEN** website·project mention 화면을 렌더하면
- **THEN** 이 변경 도입 전과 동일한 화면이 나온다 (탭 미노출)

### Requirement: 모든 탭 지표는 동일 모집단 술어를 쓴다

신규 집계 4종은 답변 모집단 필터를 `detailAnswerWhere` 로만 조립해야 한다(SHALL). 같은 필터
조합에서 탭 히어로 값과 기존 요약 카드(sub KPI)의 분모(전체 답변 수)는 일치해야 한다(SHALL) —
단 아래 카브아웃 2축은 예외로 한다.

**카브아웃 (2026-08-28 확정 — verifier 실측으로 표면화, 제품 책임자 승인)**: `detailAnswerWhere`
(상세 경로)와 `answerWhere`(sub KPI 경로)는 기왕 설계상 두 필터 축의 해석이 다르다 —
① `funnelStage`: sub KPI 는 catalog `prompts.funnel_stage`, 탭은 `scope_prompts.funnel_stage`
② `brandPresence` 복수 선택: sub KPI 무필터 vs 탭 `IS NOT NULL`. 이 두 축이 걸린 필터
조합에서는 분모 불일치를 허용한다(MAY). 무필터·region/engine/date/brand/depth 축은 일치가
실측 확인됨. 술어 해석 통일은 기존 화면 산출 변경을 수반하므로 별도 변경(후속)으로 다룬다.

#### Scenario: 모집단 일치
- **WHEN** 카브아웃 2축이 걸리지 않은 동일 필터로 노출률 탭 히어로와 기존
  `aggregateSubKpisFromMirror` 를 각각 집계하면
- **THEN** 두 산출의 전체 답변 수(분모)가 같다

### Requirement: 우선 노출도는 답변 안 경쟁 순위의 평균이며 산식을 화면에 명시한다

우선 노출도 지표는 답변 안 **경쟁 순위**로 계산해야 한다(SHALL): 답변(job)마다 브랜드(표시명)별
`min(scope_mentions.avg_position)` 을 접고, 그 답변 안에서 `rank()`(동률 공동, 다음 순위 건너뜀)로
몇 번째로 언급된 브랜드인지 매긴 뒤, 브랜드 값은 그 순위의 평균(소수 1자리)이다. 회차 추이는
(회차, 브랜드, 답변) 에 같은 규칙을 적용한다. 순위는 시리즈 상한(상위 N) 적용 **전**, 그 답변의 적격
브랜드 전부 위에서 매긴다. 이 축은 Overview 카드 ④·경쟁사 행·언급 브랜드 표의 "평균 위치"와 같아야
한다(SHALL). 브랜드별 값은 Overview 경쟁사 행과 같은 리더의 값이 있으면 그 값을 쓰고 그 값 기준으로
순위를 다시 매긴다(MAY: 리더가 없으면 미러 값).
화면 캡션에 "답변마다 브랜드가 처음 언급된 순서로 순위를 매기고 그 순위를 평균한다"는 산식을
명시해야 한다(SHALL). 순위 시계열 차트의 y축은 낮은 순위(1위)가 위로 가도록 반전한다.

(2026-09-28 개정. 종전 산식은 "답변 내 평균 등장 순위(avg_position)의 회차 평균" = 본문 서수의
이중 평균이었고, 같은 화면의 카드 ④·경쟁사 행과 축이 달라 값이 엇갈렸다. 제품 책임자 A안으로 교체.)

#### Scenario: 본문 위치와 경쟁 순위가 갈리는 답변
- **WHEN** 한 답변에서 브랜드 A 의 최소 `avg_position` 이 1, B 가 10, C 가 30 이면
- **THEN** 그 답변의 순위는 A 1 · B 2 · C 3 이고, 본문 위치(10·30)는 값에 들어가지 않는다

#### Scenario: 언급 없는 브랜드
- **WHEN** 필터 범위에서 언급이 0건인 브랜드를 순위 테이블에 그리면
- **THEN** 0위·0% 가 아니라 "측정 없음" 상태로 표기된다 (null 전파 — 0 과 구분)

### Requirement: 트렌드·스파크라인은 빈 회차를 갭으로 남긴다

회차 시계열(탭 트렌드·경쟁사 스파크라인·주별 Top10)은 측정이 없는 회차를 직전값으로 잇지
않고 갭으로 남겨야 한다(SHALL). 측정 커버리지 라벨(회차 날짜·측정 일수)을 차트 하단에
표기한다.

#### Scenario: 결측 회차
- **WHEN** 4회차 창 중 1회차에 해당 필터의 측정이 없으면
- **THEN** 스파크라인은 그 지점을 비우고, 커버리지 라벨이 결측을 드러낸다

### Requirement: 노출률·점유율 탭은 공용 컴포넌트를 공유한다

`CompetitorKpiTable` · `EngineKpiSection` · `TypeKpiSection` 은 metric(`exposure|sov`) prop 을
받아 두 탭에서 재사용되어야 한다(SHALL). 경쟁사 테이블 행은 값 바·직전 4회차 스파크라인·
WoW 증감·당사 대비 Gap 을 포함한다.

#### Scenario: 유형별 토글
- **WHEN** 유형 섹션에서 "자사만"과 "타사 포함"을 전환하면
- **THEN** 스택바 분모가 당사 한정 ↔ 전 브랜드로 바뀌고 라벨이 함께 갱신된다

### Requirement: 브랜드 언급 순위 Top100 은 검색·토글·내보내기를 제공한다

공통 하단 브랜드 테이블은 상위 100 브랜드를 정렬 가능하게 그리고(SHALL), 브랜드명 검색·
복수 언급 토글(당사 언급 2회 이상 답변 기준 전환)·Excel 내보내기(`lib/export/xlsx.ts`)를
제공해야 한다(SHALL). 검색·정렬 재계산은 기존 useDeferredValue 패턴을 유지한다(INP 회귀 방지).

#### Scenario: Excel 내보내기
- **WHEN** 필터·검색이 적용된 상태에서 내보내기를 실행하면
- **THEN** 화면에 보이는 것과 동일한 행 집합·열이 xlsx 로 내려온다
