# Align Favorability (Core KPI ③) to Scope Mention-Unit Positive Rate

## Why

GGMD 요청 "코어 KPI 우호도와 파생 데이터를 업데이트된 Scope sentiment 기준으로 수정"에 대한
산식 정렬. Scope 감성 채점이 전용 LLM semantics pass(4값 positive/neutral/negative/mixed)로
개편·상시화(2026-07-29 측정워커 td:152)됐고, Scope 정본 KPI 구현(`getTrackedKpiAggregate`,
Scope repo `dashboard-aggregates.ts`)은 **언급(멘션 sentiment 카운트) 단위 긍정률**인데,
hmg-geo 우호도는 **답변 단위 우세(dominant) 분류**라 Scope 리포트와 수치가 계속 어긋난다
(2026-07-27주 HMG 3사 실측: 답변 단위 5.4% vs 언급 단위 9.1%).

**2026-07-29 제품 결정(D1)**: Scope 정본(언급 단위 긍정률) 정렬 채택. **과거 데이터 백필 없음**
— 신규 채점분만 유입되고, 07-29 전후 시계열 단절은 GGMD 고지로 대응(이 change 범위 밖).

부수 결함도 함께 소멸한다: 현행 SQL은 `p == ng > 0` 동률 답변을 긍정·부정 분자에 **동시
계상**하는데(JS 분류는 else-if 배타) 답변 분류 자체가 사라지므로 자연 해소된다.

## What Changes

- **산식 교체**: 우호도 = 모집단(해당 표면의 `answerWhere` 답변 × tracked rollup 멘션)의
  sentiment 카운트 합 `P/NE/NG/MX`에서 `100 × P ÷ (P+NE+NG+MX)`(round1). **분모 0 → null**
  ("측정 대기", 0%와 구분). mixed는 분모 포함.
- **파생 전체 동일 단위 정렬**: 추이 버킷 ③ · 엔진 간 일관성 ③ 입력 · 답변분석 감정분포
  (sentimentTotals = 언급 카운트 — "긍정 세그먼트 == 우호도" parity 유지) · 서브KPI
  negativeRate · KPI 카드 ratio 서브텍스트(분자/분모를 언급 카운트로 재정의).
  #17/#18(긍/부정 키워드 수)은 이미 신호 합(sum) — 산식 불변, 신 체제의 P·NG와 동일값.
- **폴백 경로 정합**: HTTP KPI 폴백(우세 분류 제거) · 공개 API mentions 폴백(현행은 전 브랜드
  집계 + mixed 미분기 — tracked 한정 + mixed 분기로 정렬).
- **필드 개명 + 캐시 세대 승격**: `*Answers` 필드명이 언급 카운트를 담으면 거짓말이 되므로
  개명하고, `mirrorCache` 공유 keyPart를 승격(`"mirror"` → `"mirror-v2"`)해 구(답변 단위)
  구조 캐시가 신 코드에 읽히는 30분 혼재 창을 차단한다.
- **i18n**: ko/en 우호도 정의·산식·ratio 라벨·감정분포 힌트를 언급 단위로 개정. KPI **명칭은
  불변**(ko "AI 우호도" / en "AI Sentiment" — 현행 사전이 정본, 개명 금지). 단 서브KPI 라벨
  ko "부정 답변 비율"은 산식이 언급 단위가 되면 라벨이 산식을 거짓말하게 되므로 **"부정 언급
  비율"로 개명**(정의 정확성 수준의 수정 — 스펙 승인 게이트에서 함께 승인).

### 범위 제외 (명시)

- 과거 데이터 백필 없음(제품 확정 2026-07-29) — 신규 채점분만.
- Scope API 계약 변경 없음 · 미러 스키마 변경 없음(`scope_mentions` sentiment 4컬럼 그대로).
- 추이 차트의 07-29 기준 변경 단절 마커는 선택 후속(별도 change).

## 코어/테넌트 판정

**코어.** Scope 정본 KPI 산식과의 정렬은 엔터프라이즈 패키지 공통 로직이다 — 어느 테넌트든
우호도가 Scope 리포트 수치와 일치해야 한다. tracked 판정 입력(`trackedRollupIn`·entity
roster)은 테넌트 자산이지만 이 change에서 불변.

## Capabilities

### Added Capabilities
- `kpi-favorability`: Core KPI ③ 우호도의 산식(언급 단위 긍정률)·null 규약·파생 일관성
  (parity)·캐시 세대 규약. 기존에 Core ③ 산식을 소유한 capability가 없어 신설.

### Modified Capabilities
- `dashboard-sub-kpi`: 감정 파생 Sub(부정 언급 비율·긍/부정 키워드 수)의 단위를 언급 기준으로
  정정, 엔진 간 일관성 ③ 입력을 Core ③ 동일 정의(언급 단위)로 명시, 라벨 개명 반영.

## Impact

- **집계**: `lib/db/repositories/scope-aggregates.ts` — ③ Core SQL(:479-501) · 추이 ③
  SQL(:891-905, 타입 :833-834, 병합 :959-960) · 서브 Q3 SQL(:681-702, 타입 :611-618, 매핑
  :757-761)
- **어댑터**: `lib/scope/result-adapter.ts` — sentiment 타입(:165-172) · HTTP KPI 폴백
  (:582-646, :704-710) · 미러 mentions 우세 분류(:1053-1065, parity 주석 :911-913) · 공개 API
  mentions 폴백(:1299-1304)
- **뷰모델**: `app/[locale]/(dash)/dashboard/_data/live.ts`(:253-267, :502-504, :675-677 —
  `buildMirrorKpis`는 projects 표면과 공유) · `website/_data/live.ts`(:164) ·
  `standard/answer-analysis/_data/sub-kpis.ts`(:22-27, :37-47)
- **캐시**: `lib/scope/server.ts` `mirrorCache` keyPart(:523)
- **i18n**: `messages/{ko,en}.json` — 정의(:245)·산식(:254)·`ratio.sentiment`(:288-291)·
  `sentimentHint`(:441)·negativeRate 라벨/정의 + en 대응 키
- **테스트**: `website/_data/live.test.ts` · `projects/[id]/_data/live.test.ts` ·
  `lib/db/repositories/scope-aggregates.slim.test.ts` 픽스처 + 신규 산식 단위 테스트
- **문서**: `docs/feature-spec.md` 우호도 서술
- (라인 앵커는 main `2093594` 기준 — 착수 시 재확인)

## 수용 기준 (요약 — 상세는 specs/tasks)

1. 산식 소비처 전부(카드·추이·일관성·감정분포·negativeRate·폴백 2종)가 언급 단위 동일 산식.
2. parity: 감정분포 긍정 세그먼트 비율 == 대시보드 우호도(동일 모집단, round1 오차 이내).
3. 분모 0 → null("측정 대기") — 0%로 표기 금지.
4. mixed 분모 포함.
5. `npm test` · `npm run build` · `npm run check:strings` · `npm run lint` 통과.
6. GGMD 루트 최근 주 실데이터에서 앱 신 산식 값 == 미러 SQL 직접 계산(참고치: 2026-07-27주
   HMG 3사 언급 단위 9.1% — 부분 신채점 유입 중이라 검증 시점 재계산 값 기준).
