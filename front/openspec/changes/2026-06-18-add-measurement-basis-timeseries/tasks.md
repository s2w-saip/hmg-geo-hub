## 1. 시계열 롤업 (lib/db)

- [x] 1.1 `aggregateStandardTrendFromMirror(filters, unit)` — `date_trunc(week|day, measured_at)`
      버킷별 raw 집계(노출/SOV/우호도/순위/인용 입력값) + coverage(measuredDays/answers/first·lastAt).
      기존 `answerWhere(filters)` 재사용. unit 은 화이트리스트(SQL 주입 차단). `measured_at IS NULL` 제외.
- [x] 1.2 `BucketUnit` / `StandardTrendBucket` 타입 export.

## 2. BFF wrapper (lib/scope/server.ts)

- [x] 2.1 `fetchStandardTrend(filters, unit)` — enforce("standardTrend")→rootId→assertProjectInScope→캐시.
- [x] 2.2 `cachedStandardTrend` — unit 을 캐시 키에 포함, 기존 mirror TTL/tag 재사용.

## 3. View-model (dashboard/_data/live.ts)

- [x] 3.1 `getLiveTrend(filters, unit)` — 버킷→KPI 매핑(스냅샷과 동일 산식), null 버킷은 KPI null.
      ⑥⑦은 미러에 없어 시계열에서 제외.
- [x] 3.2 `applyTrendDeltas(kpis, trend)` — 마지막 vs 직전 (값 있는) 버킷 델타·방향. 2개 미만 → null.

## 4. 시각화 (dashboard/_components/live-trend-chart.tsx)

- [x] 4.1 recharts LineChart, `connectNulls={false}`(보간 없음), dot 표시.
- [x] 4.2 분리축 — % 좌축(pct) / 평균순위 우축(rank). 보이는 라인이 쓰는 축만 노출(`hide`).
- [x] 4.3 라벨 — 주 단위는 ISO 주차("N주차"/"WN"), 일 단위는 M/D.
- [x] 4.4 coverage 스트립 — 버킷별 "N일 측정".

## 5. 측정 기준 UI (필터 상단)

- [x] 5.1 `MeasurementBasisControl` — 주/일 세그먼트 + "측정일 기준 집계 · 보간 없음" 표기.
      `?bucket` 즉시 커밋, 필터 트랜지션 공유로 본문 dim. `readBucketParam` export.
- [x] 5.2 `DimensionFilterPanel` 에 `basis` 슬롯(최상단) 추가, `OverviewFilters` 에서 주입.

## 6. 페이지 연결 (dashboard/page.tsx)

- [x] 6.1 `?bucket` 읽어 `getLiveTrend` 호출, 추이 SectionCard 렌더(버킷 <2 면 "누적 대기" 안내).
- [x] 6.2 `applyTrendDeltas` 로 KPI 카드 변화량 채움. `SummaryTiles perturb={false}`(실측값).

## 7. i18n + 정리

- [x] 7.1 `messages/{ko,en}.json` — `dashboard.basis.*`, `dashboard.trend.{accruing,weekLabel,axis,coverage}`.
- [x] 7.2 진단 스크립트(`scripts/scope/cadence-probe*.ts`) 삭제(throwaway).

## 8. 검증

- [x] 8.1 `tsc --noEmit` · `eslint`(lib/db 경계 룰) · `check:strings` 통과.
- [x] 8.2 실 미러 SQL 동작 확인 — 주 3버킷/일 9버킷, 커버리지가 불규칙 cadence 를 정직하게 노출.
- [ ] 8.3 (후속) 라이브 세션에서 주↔일 토글 + 카드 델타 정합 수동 확인.
