# Design — 우호도 언급 단위 정렬

## 1. 단위 정의 (정본)

"언급 단위"의 정확한 뜻: 미러 `scope_mentions` 한 행(job × 엔티티)은 sentiment 4계열 **카운트**
(`sentiment_positive/neutral/negative/mixed` — LLM semantics pass가 절 단위로 매긴 신호 수)를
갖는다. 신 산식은 모집단의 tracked rollup 멘션 행들에서 이 4계열을 **그대로 합산**한다:

```
P  = Σ sentiment_positive     NE = Σ sentiment_neutral
NG = Σ sentiment_negative     MX = Σ sentiment_mixed
우호도 = round1(100 × P ÷ (P+NE+NG+MX)),  분모 0 → null
```

- 답변(job) 단위 grouping·우세 판정·동률 규칙이 **전부 사라진다**. SQL의 job별 CTE(`WITH ts AS
  (... GROUP BY job_id)`)도 불필요 — 단순 합 1쿼리로 축소된다.
- 모집단 술어는 불변: 해당 표면의 `answerWhere`(표준=스냅샷 배치, 추이=`allRuns`) ×
  `trackedRollupIn(filters)`. 바뀌는 것은 그 모집단 위의 **집계 단위뿐**이다.
- Scope 정본 대응: `getTrackedKpiAggregate`(Scope repo `dashboard-aggregates.ts`)와 동일 구조
  (tracked 언급 sentiment 카운트 합의 positive 비율). Scope 코드는 착수 시 현행 main 재확인.

## 2. 동률 이중카운트 비대칭 — 자연 해소

현행 서브 Q3 SQL은 `p > 0 AND p >= ne AND p >= ng AND p >= mx`(긍정)와 `ng > 0 AND ng >= p AND
ng >= ne AND ng >= mx`(부정)를 **독립 FILTER**로 세므로 `p == ng > 0` 답변이 양쪽 분자에 동시
계상된다. 반면 JS 분류(`result-adapter.ts:1053-1065`)는 else-if 배타라 긍정만 센다. 언급 단위
전환으로 답변 분류 자체가 없어져 이 비대칭은 **정의상 소멸**한다 — 신규 테스트로 고정한다
(tasks 6.2).

## 3. 필드 개명 원칙

답변 카운트를 담던 필드에 언급 카운트를 넣고 이름을 유지하면 이름이 거짓말한다. 규칙:
**`*Answers` 이름을 언급 카운트 용도로 유지해서는 안 된다.** 권고 명명(구현자가 동등 명명으로
대체 가능, 단 일관되게):

| 위치 | 현행 | 신규 |
| --- | --- | --- |
| `StandardAggregates.sentiment` | `positiveAnswers` / `sampledAnswers` | `positiveMentions` / `sampledMentions` |
| `StandardTrendBucket` | `sentAnswers` / `positiveAnswers` | `sentMentions` / `positiveMentions` |
| `SubKpiEngineRow` | `sentAnswers` / `positiveAnswers` / `negativeAnswers` / `positiveKeywords` / `negativeKeywords` | `sentMentions` / `positiveMentions` / `negativeMentions` (키워드 필드 흡수 — §4) |

jsdoc에 "멘션 sentiment 카운트(신호) 합 — 답변 수 아님"을 명기한다. `positiveRate` 이름은 유지.

## 4. SubKpiEngineRow 통합 — #17/#18과 분자의 동치

현행 `positiveKeywords = Σp`, `negativeKeywords = Σng`(신호 합)는 신 체제의 분자 `P`·`NG`와
**정확히 같은 값**이다. 별도 필드 5개를 유지할 이유가 없다 — `sentMentions / positiveMentions /
negativeMentions` 3필드로 통합하고, 뷰모델(`sub-kpis.ts`)이 #17=`positiveMentions`,
#18=`negativeMentions`, negativeRate=`negativeMentions ÷ sentMentions`로 매핑한다.
#17/#18의 **표시 값은 불변**(산식 무관 — 이미 신호 합)이다.

## 5. 캐시 세대 승격

`mirrorCache`(`lib/scope/server.ts:516-529`)는 `unstable_cache(fn, ["mirror", key])` + TTL
1800s. 필드 개명 후에도 구 구조 캐시 엔트리가 TTL까지 살아남아 신 코드가 읽으면 분자/분모가
undefined로 새는 30분 혼재 창이 생긴다. 대응: 공유 keyPart를 `"mirror" → "mirror-v2"`로 승격해
전 미러 캐시를 1회 무효화한다(개별 key 12곳을 고치는 것보다 한 줄·전면적). 이에 따라
`dashboard/_data/live.ts:259-266`의 "cached old struct" 허용 코드(`positiveAnswers ??` rate
역산)는 죽은 코드가 되므로 **삭제**한다.

## 6. 폴백 경로 2종의 정렬 상세

- **HTTP KPI 폴백**(`result-adapter.ts:582-646`): 현행은 답변별 tracked sentiment 합 →
  peak(우세) 판정. 신규는 tracked 멘션의 `m.sentiment.{positive,neutral,negative,mixed}`를
  전역 누적해 P/NE/NG/MX로 rate 산출. tracked 판정 로직(기존 답변 루프의 당사 판정)은 재사용.
- **공개 API mentions 폴백**(`aggregateMentionsFromPublic`, :1299-1304): 현행은 (a) tracked
  미필터 — **전 브랜드** 행의 `brand_sentiment`를 세고, (b) mixed 분기가 없어 mixed가 neutral로
  흡수된다. UI 힌트는 "당사 브랜드 언급"을 약속하므로 현행이 계약 위반 — tracked 행만 계상
  + `mixed` 분기 추가로 정렬한다. (공개 API 행은 행당 `brand_sentiment` 1값 = 이미 언급 단위
  — 우세 분류 제거 대상 아님.)
- **미러 mentions 어댑터**(`aggregateMentionsFrom`, :1053-1065): job별 우세 분류 블록을 제거하고
  tracked 멘션의 4계열 카운트를 `sentimentTotals`에 직접 누적. `sentimentSeen`(null → 측정 대기
  구분) 시맨틱은 유지 — 신호 합 0이면 `sentimentTotals: null`.

## 7. i18n — 사전 규범 안에서의 개정

- KPI **명칭 불변**: ko "AI 우호도" / en "AI Sentiment". 명칭 ko/en 불일치는 알려진 상태이며
  현행 사전이 정본(리포 docs/development-guide.md) — 이번엔 정의·산식 **문구 수준만** 개정한다.
- 개정 대상: 정의(ko:245/en:245) · 산식(ko:254/en:254) · `ratio.sentiment.num/den`
  (ko "긍정 언급 답변/브랜드 언급 답변" → 언급 신호 단위 문구) · `sentimentHint`(ko:441 "우세
  감정 분류(답변 단위)" → 언급 단위) · negativeRate 정의/산식.
- **라벨 개명 1건**: ko "부정 답변 비율" → "부정 언급 비율"(en "Negative answer rate" 계열 →
  "Negative mention rate" 계열). 산식이 언급 단위가 된 뒤에도 "답변"을 유지하면 라벨이 산식과
  모순 — 어휘 이주가 아니라 정확성 수정으로 판단. 스펙 승인 게이트에서 함께 승인받는다.

## 8. 검증 전략

- 단위 테스트(신규): 분모 0 → null / mixed 분모 포함 / `p==ng` 동률 입력에서 이중계상 소멸 /
  parity(감정분포 긍정 세그먼트 비율 == positiveRate, 동일 입력).
- 실데이터 대조(수용 기준 6): supabase-hmg 미러에서 GGMD 루트 최근 주를 SQL로 직접 계산해 앱
  값과 대조. 검증 SQL 스케치는 tasks 8.2.
- 머지 게이트: 독립 검증(데이터 정확성 렌즈) → 제품 책임자 승인. 구현자와 분리된 검증.

## 9. 기각·보류한 대안

- **현행 답변 단위 유지(D1b)**: Scope 리포트와 영구 불일치 — 제품 결정으로 기각.
- **필드명 유지 + 값만 교체**: 이름이 거짓말(§3) — 기각.
- **캐시 개별 key 버전 승격**: 12곳 산발 수정 — 공유 keyPart 1줄 승격으로 대체.
- **추이 단절 마커(07-29 채점 개편 주석)**: 구현 소형이나 별도 관심사 — 선택 후속 change.
- **`llm_sentiment_source` 커버리지 노출**: Scope 공개 API 계약 변경 필요 — 범위 밖, 필요 시
  `docs/scope-requests/` 요청서 별도.
