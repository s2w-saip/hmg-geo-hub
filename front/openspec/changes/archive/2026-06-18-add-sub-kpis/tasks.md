## 1. Sub KPI 집계 (lib/db)

- [x] 1.1 `aggregateSubKpisFromMirror(filters)` — engine(target)별 5쿼리(answer-level: visibility/
      multi/top1/top3/avg_position, mentions: SOV, sentiment: pos/neg + 키워드 신호, citations:
      owned, prompt-grain: 미언급 프롬프트) → `SubKpiEngineRow[]` + `promptsWithoutBrand`.
- [x] 1.2 기존 `answerWhere(filters)`·`TRACKED`·`OWNED` 재사용(필터·추적브랜드·자사도메인 일관).
- [x] 1.3 (2026-07-29) 엔진별 `avg_position` 을 `avg(COALESCE(tp,100))` → `avg(tp)` 로 교정 —
      Core ④ 와 동일 정의. 미진입을 100 으로 채우면 평균이 순위가 아니라 노출률의 역수가 되어
      일관성이 ① 노출률 일관성을 복제했다(실측 61.1% → 95.9%).
- [x] 1.4 (2026-07-29) 추이 버킷 position 도 같은 교정 — 카드(6위대)와 추이선(40~65대)이 서로
      다른 값을 말하던 모순 해소.

## 2. BFF wrapper (lib/scope/server.ts)

- [x] 2.1 `fetchStandardSubKpis(filters)` — enforce→rootId→assertProjectInScope→캐시.
- [x] 2.2 `cachedSubKpis` — mirror TTL/tag 재사용.
- [x] 2.3 `fetchProjectSubKpis(localProjectId, filters)` / `fetchWebsiteSubKpis(filters)` — 표면별
      캐시 네임스페이스 분리(표준/프로젝트 캐시 오염 구조적 불가).

## 3. View-model

- [x] 3.1 `buildMentionSubKpis(sub)` (답변분석 `_data/sub-kpis.ts`) — 엔진 행 합산 → 언급 화면용
      스칼라 6종. sentiment 없으면 null(측정 대기).
- [x] 3.2 `applyEngineConsistency(kpis, rows)` (dashboard `_data/live.ts`) — Core 별 엔진 min/max →
      `KpiSummary.engineConsistency`. 유효 엔진 <2 또는 카드 측정 대기면 미부착.
- [x] 3.3 `KpiSummary.subs` / `SubMetric` 제거 — 2026-07-01 카드가 분자/분모 2줄로 교체된 뒤로
      아무도 렌더하지 않던 죽은 구조. 방문 수 카드 sub 도 제거하고 sparkline 만 유지.

## 4. 표시

- [x] 4.1 답변분석 > 언급 요약 타일 행 3-up → 6-up (미언급/복수언급/Top3) + `ColInfo` 정의 툴팁.
- [x] 4.2 감정 분포 패널 하단에 Sub 3종 행 — 값 없으면 "측정 대기" 칩.
- [x] 4.3 Core 카드 값 줄 우측에 엔진 간 일관성 배지(중립색 + ⇄ 아이콘 + ⓘ 정의).

## 5. 연결 + i18n

- [x] 5.1 언급 화면 3표면 배선 — 표준/웹사이트/프로젝트 각 `page.tsx` 가 본 집계와 동일 필터로
      Sub 집계 호출. dead export 였던 `fetchWebsiteSubKpis` 활성화.
- [x] 5.2 대시보드 3표면 배선 — 표준/웹사이트/프로젝트가 `applyEngineConsistency` 적용.
- [x] 5.3 `messages/{ko,en}.json` — `answerAnalysis.mentions.summary/def.*`,
      `answerAnalysis.mentions.breakdown.sub.*`, `dashboard.kpi.sub.def.engineConsistency.*`.

## 6. 백로그

- [x] 6.1 #5 프롬프트 주제별 구성비 — 대시보드 구성 분석 도넛(`getLiveTopicComposition`)으로 흡수.
- [x] 6.2 #6 출처별 구성비 — 같은 구성 분석 섹션 + 인용분석 화면으로 흡수(신규 KPI 아님).
- [x] 6.3 개별 프로젝트 표면에도 Sub 반영(공유 transform 경로).
- [ ] 6.4 ③ 우호도 일관성 최소 표본 가드 — 우호도 절대값이 낮아(실측 2.0% / 0.7%) 비율이 쉽게
      흔들린다. 표본 하한 정책 미정.

## 7. 검증

- [x] 7.1 `tsc --noEmit` · `eslint`(lib/db 경계) · `check:strings` · `vitest`(636 passed) ·
      `next build`(78 pages).
- [x] 7.2 실 미러 실측 — 순위 결측 0건(언급 행 905,521 전수), Top3 33.4%(40,054/120,011),
      엔진 일관성 = 노출률 57.8% / 점유율 90.5% / 우호도 35.5% / 순위 95.9%.
- [ ] 7.3 (후속) 라이브 세션에서 언급 화면 타일·감정 패널·카드 배지 육안 확인.
