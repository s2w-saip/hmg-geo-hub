## Context

HMG Sub KPI 7종을 정의받았다. 의도는 **Core 카드 안에 함께 노출**(별도 화면 X)이고,
산출 가능성·중복 여부가 항목마다 달라 규약으로 못박는다.

## Sub KPI 판정 요약

| # | Sub KPI | 상위 Core | 데이터원 | 처리 |
|---|---|---|---|---|
| 1 | 브랜드 언급 답변 수 | ① 노출률 | scope_mentions(tracked) | ✅ 카드 Sub |
| 2 | 복수 언급 답변 수 | ② 점유율 | mention_count 합 ≥2 | ✅ 카드 Sub |
| 3 | 부정 답변 비율 | ③ 우호도 | sentiment_negative dominant | ⚠️ 카드 Sub + **측정 대기**(backfill) |
| 4 | Top3 노출 비율 | ④ 우선노출도 | min(avg_position) ≤3 | ✅ 카드 Sub |
| 5 | 프롬프트 주제별 구성비 | (포트폴리오) | prompts 카탈로그 | ⛔ 백로그(필터 taxonomy 와 동일 데이터) |
| 6 | 출처별 구성비 | ⑤ 인용점유율 | scope_citations | ⛔ 백로그(인용분석/⑤와 중복) |
| 7 | 엔진 간 일관성 | 모든 Core | target별 Core | ✅ 각 카드 Sub |

## Decisions

### D1. Sub 는 Core 카드 안에 동거
- `KpiSummary.subs: SubMetric[]` 로 카드 하단(값/coverage 아래)에 라벨–값 행으로 노출.
- 카드↔Sub 매핑: ①→#1, ②→#2, ③→#3, ④→#4, 그리고 모든 미러 Core 에 #7.

### D2. 측정 대기 칩 (#3)
- `SubMetric.pending=true` (또는 value null) → 숫자 대신 "측정 대기" 칩(Core 의 `kpi.pending` 재사용).
- #3 부정 답변 비율은 sentiment backfill 전까지 `sentAnswers=0` → pending. ③ Core 와 동일 의존성.

### D3. #7 엔진 간 일관성 = min ÷ max × 100
- 해당 Core 의 엔진(`target`)별 값 중 (분모>0 인 엔진만) min/max 비율. 유효 엔진 <2 면 비교
  불가라 **생략**(100% 로 오인 금지). position 은 평균순위라 그대로 min/max 비율로 본다.
- 엔진은 `scope_answers.target`(chatgpt/gemini, 깨끗). `model_slug`(null 다수 + "3 Flash" 등 지저분)는 미사용.

### D4. #5/#6 중복은 백로그
- #6 은 `CitationsLive.domains/categories/urls` 로 인용분석에 이미 있고 Core ⑤(자사인용÷전체인용)의
  일반화 — 새 데이터가 아니라 표현(%구성비) 차이. 독립 KPI 신설 대신 ⑤ breakdown/인용분석 흡수.
- #5 는 측정이 아니라 프롬프트 셋 구성 — 필터 depth taxonomy 와 동일 데이터. 카탈로그 요약으로.

### D5. 개별 프로젝트 재사용(#0)
- Sub 산출은 엔진별 미러 집계 + 언급/인용 순수 transform 공유 위에 있어, 개별 프로젝트(scope HTTP)
  경로에도 동일 패턴으로 반영 가능. 이번엔 표준 대시보드만; 개별 프로젝트는 후속.

## Open Questions
- #3 부정/긍정 동시 dominant(tie) 처리 — 현재 긍정-우세와 동일 규칙(ng≥others). 임계/우선순위 재논의 여지.
- #7 을 카드 Sub 외에 별도 "엔진 비교" 뷰로도 승격할지.
- #5/#6 흡수 위치(카탈로그 요약 vs ⑤ breakdown) 확정.
