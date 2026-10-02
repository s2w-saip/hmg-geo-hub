## Why

HMG Sub KPI 정의가 확정됐다. Core KPI 7종 각각의 "근거/세부"를 카드 안에서 함께 보여주기
위한 보조 지표다(별도 화면이 아니라 **Core 카드 내 동거**가 의도). 일부는 미러 데이터로 즉시
산출되고, 일부는 scope backfill 의존(측정 대기), 일부는 기존 인용분석/Core 와 중복이라
정리가 필요하다 — 이 change 는 정의·산출 가능성·중복 판정을 규약으로 확정한다.

## What Changes

- **신규 capability `dashboard-sub-kpi`**: Core 카드에 동거하는 Sub KPI 의 정의와 표시 규약.
- **즉시 구현(미러 데이터)** — Core 카드 안에 Sub 행으로 노출:
  - #1 브랜드 언급 답변 수 → ① 노출률 카드 (= tracked 답변 수)
  - #2 브랜드 복수 언급 답변 수 → ② 점유율 카드 (당사 mention_count 합 ≥2)
  - #4 Top 3 노출 비율 → ④ 우선 노출도 카드 (min 당사 순위 ≤3 ÷ tracked × 100)
  - #7 엔진 간 일관성 → 각 Core 카드 (해당 Core 의 엔진 간 min ÷ max × 100; 측정 엔진 <2 면 생략)
- **측정 대기 칩**:
  - #3 브랜드 부정 답변 비율 → ③ 우호도 카드. scope sentiment backfill 전까지 값이 없으므로
    숫자 대신 "측정 대기" 칩을 렌더(③ Core 와 동일 의존성).
- **백로그(중복 정리 — 이번 미구현)**:
  - #5 프롬프트 주제별 구성비 → 인용분석과 무중복이나 **프롬프트 카탈로그 구성**(필터 taxonomy 와
    동일 데이터)이라 별도 KPI 보다 표준프롬프트/카탈로그 요약으로 흡수 검토.
  - #6 출처별 구성비 → **인용분석 페이지(`CitationsLive.domains/categories/urls`) 및 Core ⑤와
    高중복**. 새 데이터가 아니라 "카운트→%구성비" 표현 차이라, ⑤의 breakdown / 인용분석에 흡수 검토.
- **개별 프로젝트 대시보드 재사용 가능(#0)**: Sub 산출은 엔진별 미러 집계 위에 있고, 언급/인용
  롤업의 순수 transform 을 공유하므로 개별 프로젝트(scope HTTP) 경로에도 같은 패턴으로 반영 가능
  (이번엔 표준 대시보드만 구현, 개별 프로젝트는 후속).

## Capabilities

### New Capabilities
- `dashboard-sub-kpi`: Core KPI 카드에 동거하는 Sub KPI 의 정의·산출·표시(측정 대기 포함) 규약.

### Modified Capabilities
<!-- 없음 -->

## Impact

- **코드**:
  - `lib/db/repositories/scope-aggregates.ts` — `aggregateSubKpisFromMirror(filters)`
    (engine별 #1~4 입력 + #7 분해).
  - `lib/scope/server.ts` — `fetchStandardSubKpis` BFF wrapper + 캐시.
  - `app/[locale]/(dash)/dashboard/_data/live.ts` — `getLiveSubKpis`, `applySubKpis`
    (전체 보조 지표 + 엔진 일관성 → 카드별 subs, #3 pending).
  - `app/[locale]/(dash)/dashboard/_data/sample.ts` — `SubMetric` 타입 + `KpiSummary.subs`.
  - `app/[locale]/(dash)/dashboard/_components/summary-tiles.tsx` — 카드 내 Sub 행 + 측정 대기 칩.
  - `app/[locale]/(dash)/dashboard/page.tsx` — fetch + apply.
  - `messages/{ko,en}.json` — `dashboard.kpi.sub.*`.
- **spec**: 신규 `openspec/specs/dashboard-sub-kpi/spec.md`(아카이브 시 graduate).
- **보안 경계**: #1(server-only BFF) 유지 — Sub 도 `server.ts` 경유. #2 동일 `answerWhere` 재사용.
- **데이터 의존**: #3·#6유형은 scope sentiment/domain-classifier backfill 대기. #7 엔진은
  `scope_answers.target`(깨끗) 사용 — `model_slug` 미사용.

---

## 이행 결과 (2026-07-29 아카이브 시점)

제안 당시의 "Core 카드 내부 행" 전제는 폐기됐다. 2026-07-01 커밋(`56a6d6d`)이 카드의 Sub 행을
분자/분모 2줄로 교체하면서 Sub 는 계산만 되고 어디에도 렌더되지 않는 상태로 7개월 가까이
남아 있었다. 2026-07-29 재배치로 지면을 다시 정했다:

- **답변분석 > 언급** — 미언급 프롬프트 수, 복수 언급 답변 수, Top 3 노출 비율(요약 타일),
  긍정·부정 키워드 언급 수, 부정 답변 비율(감정 분포 패널). 표준·웹사이트·프로젝트 3표면 공용.
- **AI 퍼널 > 전환** — 브랜드 사이트 방문 수(이미 `VisitsView` 로 노출 중이었다).
- **Core KPI 카드** — 엔진 간 일관성만 값 오른쪽 배지로.

부수적으로 두 건이 함께 교정됐다: (1) 엔진별·버킷별 평균순위가 미진입 답변을 100위로 채우던
문제 — 카드는 6위대, 추이선은 40~65대를 표시하던 모순의 원인, (2) `KpiSummary.subs` 죽은 구조
제거. 백로그 6.1·6.2(주제·출처 구성비)는 별도 KPI 신설 없이 대시보드 구성 분석 섹션으로
흡수되어 완료 처리했다.
