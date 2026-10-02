## Why

GGMD 1차 고도화 피그마([최종, 327:1455](https://www.figma.com/design/Iy1rTIxLcBvbK2tYhXN3IP/GGMD-1차-고도화?node-id=327-1455))가
답변분석 > Mention 화면을 **4-KPI 탭 구조**(AI 노출률 · AI 점유율 · AI 우호도 · AI 우선
노출도)로 재편했다. 현행 화면은 단일 스크롤 페이지(`mentions-view.tsx` 1,320줄)로 요약
카드·트렌드·헤드투헤드·감정/유형 breakdown·브랜드 테이블을 한 면에 다 그린다 — KPI 하나를
깊게 보는 동선이 없고, 디자인의 신규 시각화(경쟁사 KPI 테이블·순위별 보기·유형×감정
매트릭스·주별 Top10)가 부재하다.

워크스페이스 정본 플랜: `workspace/internal-kb/hmg-geo-mention-4kpi-redesign-plan-2026-08-25.md`.

## What Changes

- **탭 셸**: standard mention 페이지에 `?kpi=exposure|sov|favorability|first-rank` URL 탭 4개.
  탭 전환 시 필터 유지(`filter-encoding.ts` 규약). website/project 표면은 이번 범위 밖 —
  기존 화면 그대로.
- **집계 신설 4종** (`lib/db/repositories/scope-aggregates.ts`에 추가, 기존 시그니처 불변):
  - `aggregateBrandTrendFromMirror` — 회차×브랜드 언급 수/노출률/점유율 (주별 Top10 차트·
    경쟁사 스파크라인 4회차·WoW).
  - `aggregateEngineKpiTrendFromMirror` — 엔진(chatgpt/gemini)별 노출률·점유율 시계열.
  - `aggregateTypeKpiFromMirror` — 멘션 유형 5종 × (당사/비교 브랜드) 노출·점유율 +
    유형×감정 매트릭스. `scope_mentions.type_*` 5컬럼 + `sentiment_*` 4컬럼 소비.
  - `aggregateFirstPositionFromMirror` — 브랜드별 등장 순위(회차 시계열 + 최신 순위 분포).
- **탭 뷰 4종 + 공통 하단**: 히어로(게이지/순위/긍·부정) · KPI 트렌드(커스텀 툴팁·측정
  커버리지 라벨) · 경쟁사 KPI 테이블(바·스파크라인·WoW·당사 대비 Gap·경쟁사 선택) ·
  엔진별/유형별 섹션(자사만·타사 포함 토글) · 순위별 보기(RankLadder) · 주별 상위 10개
  브랜드 라인차트 · 브랜드 언급 순위 Top100(복수 언급 토글·검색·Excel 내보내기) ·
  프롬프트/인용 출처 테이블(순위·퍼널·엔진 열·언급 TOP 3 뱃지).
- **필터 바 재배치**: `DimensionFilterPanel` 축 로직 불변, 디자인의 2행 레이아웃(디멘션 행 +
  프롬프트 필터 행 + 적용) + 측정 개요 카드(적용/측정/미측정 프롬프트 수).

## Decisions (2026-08-28 확정)

- **우선 노출도 = `scope_mentions.avg_position` 기반의 답변 안 경쟁 순위.** 미러 실측(2026-08-28,
  supabase-hmg): 2,077,033행 채움율 **100.0%**, 백필 불필요.
  (2026-09-28 개정, 제품 책임자 A안) 답변(job)마다 브랜드(표시명)별 `min(avg_position)` 위에 `rank()`
  (동률 공동, 다음 건너뜀)를 매기고 그 순위를 평균한다. 카드 ④·경쟁사 행·언급 브랜드 표와
  같은 축이다. 종전 정의(answer×brand 롤업 avg_position 의 회차 평균 = 본문 서수 이중 평균)는
  같은 화면의 경쟁 순위 값들과 엇갈려 폐기했다. 정본 산식은 spec.md 의 해당 Requirement.
- **표면 범위 = standard 먼저.** 내부 섹션은 metric-prop 주입형 공용 컴포넌트로 추출하되
  (`CompetitorKpiTable`·`EngineKpiSection`·`TypeKpiSection` — 노출률/점유율 탭이 공유),
  탭 셸은 standard 한정. website/project 는 기존 `MentionsView` 경로를 유지하고 이번
  변경으로 **렌더 결과가 바뀌지 않아야 한다**(회귀 기준).
- **스파크라인 빈 회차 = 갭 유지.** 직전값 연결로 매끈하게 만들지 않는다 —
  `aggregateStandardTrendFromMirror` 의 coverage 필드(measuredDays·firstAt·lastAt)가 이미
  정직성 신호를 내려주는 것과 같은 원칙.
- **집계는 EXPLAIN 선행.** 회차×브랜드 분해는 스캔량이 큼 — 신규 쿼리는 프로덕션 규모
  데이터에서 EXPLAIN 확인 전 머지 금지(성능 수정 EXPLAIN 원칙 준용). 필요 시
  `slimMentionsLiveForCache` 패턴으로 캐시 슬림화.
- **필터 술어는 `detailAnswerWhere` 재사용.** 신규 집계가 자체 WHERE 를 조립하지 않는다 —
  탭 간·기존 화면 간 모집단 불일치가 가장 싼 오진 경로다.

## Decisions (2026-08-28 WU-1 구현 중 추가)

- **`detailAnswerWhere` 에 선택적 3번째 인자 `{ allRuns?: boolean }` 추가.** 스냅샷(셀당
  최신 1건) 술어 그대로는 회차 시계열이 버킷 1개로 붕괴한다. 자체 WHERE 조립(금지) 대신
  `answerWhere` 가 이미 가진 `allRuns` 와 동일 시맨틱을 같은 함수에 얹었다 — 기존 2-인자
  호출부의 컴파일 SQL 은 바이트 동일(테스트 고정).
- **유형×감정 매트릭스는 근사.** 미러 `type_*`·`sentiment_*` 는 같은 (답변×브랜드) 행의
  독립 분해라 진짜 교차가 원자료에 없다. "그 유형 신호가 있는 행들의 감정 합"으로 내며,
  **유형 안에서의 구성비로만 읽고 유형 간 합산 금지**(화면 캡션·주석 명시). 엄밀 교차는
  scope 분류 패스의 교차 카운트 신설이 선행돼야 한다(후속).
- **우선 노출도는 답변 가중, 기존 브랜드 테이블 평균 위치는 행 가중** — 모델 롤업이 여러
  행인 답변에서 값이 갈라지므로 두 수를 한 화면에 나란히 놓지 않는다(PR ② 배치 제약).
- **PR ② 소비 규약**: 신규 추이 집계는 4.5~4.7s 급(120일 창) — 페이지 로드에 직결 금지.
  기존 `readMentionBrandDayCounts` 와 같은 8s statement_timeout 가드 + 추이만 null degrade,
  또는 스파크라인 용도는 `trendDays: 28`(창이 지배 비용 — 스캔 비례 축소).

## Impact

- 신규/개편: 프론트 3,000~4,500줄 · 집계 800~1,200줄 · i18n ~100키쌍. DB 스키마 변경 **없음**.
- PR 3개 묶음: ① 집계+테스트 ② 탭 셸+탭 뷰 4종 ③ 공통 하단+i18n+검증.
- 회귀 기준: website/project mention 화면 무변화, 기존 `npm test` 전량 통과.
