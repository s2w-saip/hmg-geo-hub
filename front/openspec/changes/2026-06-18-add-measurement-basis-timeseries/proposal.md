## Why

대시보드에 KPI 시계열(추이)을 넣으려는데, scope 측정주기가 **일정하지 않다**는 게
가장 큰 리스크였다. 미러(`scope_*`)에 쌓인 `measured_at` 분포를 실측한 결과(2026-06-18,
~10일치 20,823 answers / 327 runs):

- 희소 배치(06-07) → **2일 공백(06-08~09)** → 06-11부터 시간당 cron 으로 **체제가 중간에 바뀜**.
- `run_id` 는 fragment·retry 가 섞여 "측정 회차" 단위로 못 쓴다(하루 36~54 run).
- KPI 셀(prompt×target×region×engine)당 측정된 날은 **평균 4.17일 / 9일(~46%)** 뿐이고,
  반대로 (prompt, 하루)는 **대부분 10+회** 과측정.

따라서 `measured_at` 을 그대로 x축에 찍으면 간격이 들쭉날쭉해 기간 대비(전주/전월 델타)가
무의미하고 GA4 일단위와 정렬도 안 된다. 이 change 는 **불규칙 측정주기를 캘린더 버킷으로
정규화하는 "측정 기준"을 제품 규약으로 확정**한다.

## What Changes

- **신규 capability `measurement-timeseries`**: 대시보드 KPI 시계열의 정규화 규약을 정의.
  - 측정 이벤트를 **캘린더 버킷**(주 기본 / 일 drill-down)으로 normalize. 저장 grain 은 일,
    표시 기본은 주. 인트라데이 과측정은 버킷 내 집계로 흡수(answer 1개 = 점 1개 금지).
  - **보간 금지**: 측정 없는 버킷은 행이 없고 차트에서 선이 끊긴다. 절대 직선으로 메우지 않는다.
  - 각 버킷에 **coverage(측정일수·답변수·마지막측정)** 를 함께 실어 불규칙성을 정직하게 노출.
  - **측정 기준(버킷 폭)은 사용자가 선택**(필터 상단 컨트롤, `?bucket=week|day` URL 파라미터).
  - 단위가 다른 KPI 는 **분리축**(% 좌축 / 평균순위 우축)으로 표시.
  - KPI 카드 **변화량(delta)** 은 정규화 시계열의 "마지막 측정 버킷 vs 직전 측정 버킷"으로 산출
    (단일 스냅샷이라 null 이던 값을 채움). 측정 기준과 동일 버킷이라 카드·차트가 정합.
- **시계열 읽기도 BFF 경계 유지**: `fetchStandardTrend`(enforce→audit→가공)만이 진입점.
  미러에 없는 ⑥ 타깃URL인용률 / ⑦ 유입전환율(GA4)은 시계열에서 제외(정직성).
- 이번 change 는 **프로토타입 구현까지 포함**(아래 Impact). 측정 cadence SLA·엔진별 분해
  라인·주차 라벨의 월 맥락 표기는 후속 open question 으로 남긴다.

## Capabilities

### New Capabilities
- `measurement-timeseries`: 불규칙 측정주기를 캘린더 버킷으로 정규화하는 KPI 시계열 규약
  (버킷 폭 선택, 보간 금지 + coverage, 분리축, 직전-버킷 델타).

### Modified Capabilities
<!-- 없음 — 기존 capability 의 요구사항 변경 없음 -->

## Impact

- **코드(프로토타입)**:
  - `lib/db/repositories/scope-aggregates.ts` — `aggregateStandardTrendFromMirror(filters, unit)`
    (버킷별 raw 집계 + coverage).
  - `lib/scope/server.ts` — `fetchStandardTrend` BFF wrapper + 캐시(unit 포함 키).
  - `app/[locale]/(dash)/dashboard/_data/live.ts` — `getLiveTrend`(버킷→KPI 매핑),
    `applyTrendDeltas`(직전-버킷 델타).
  - `app/[locale]/(dash)/dashboard/_components/live-trend-chart.tsx` — 분리축·주차 라벨·
    보간 없음·coverage 스트립.
  - `components/dash/measurement-basis-control.tsx` — 측정 기준 선택 UI(`?bucket`).
  - `components/dash/dimension-filter-panel.tsx` — 필터 상단 `basis` 슬롯.
  - `app/[locale]/(dash)/dashboard/{page.tsx,_components/overview-filters.tsx}` — 연결.
  - `messages/{ko,en}.json` — `dashboard.basis.*`, `dashboard.trend.{accruing,weekLabel,axis,coverage}`.
- **spec**: 신규 `openspec/specs/measurement-timeseries/spec.md`(아카이브 시 graduate).
- **보안 경계**: #1(server-only BFF) 유지 — 시계열도 `server.ts` 경유. #2(server-derived
  filter) 유지 — 동일 `answerWhere(filters)` 재사용. #3(scopeWhere) 무관(미러 읽기 전용).
- **외부 의존**: 없음. 미러는 out-of-band 로 동기화되어 mock 모드에서도 존재.
