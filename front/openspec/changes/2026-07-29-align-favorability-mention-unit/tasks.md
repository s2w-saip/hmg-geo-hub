# Tasks — 우호도 언급 단위 정렬

> 라인 앵커는 main `2093594` 기준 — **착수 시 현행 main에서 재확인**
> (문서와 코드가 다르면 코드가 이긴다). 구현 순서는 섹션 순서 권장(집계 → 어댑터 → 뷰모델 →
> 캐시 → i18n → 테스트). 필드 명명은 design §3 표를 따른다.

## 1. 집계 — `lib/db/repositories/scope-aggregates.ts`

- [ ] 1.1 ③ Core SQL (`aggregateStandardFromMirror` :479-501) — job별 CTE + dominant FILTER를
      제거하고 tracked 멘션 sentiment 4계열 단순 합 1쿼리로 교체. 반환 `sentiment`를
      `{ positiveRate, positiveMentions, sampledMentions }`로 개명(`sampledMentions =
      P+NE+NG+MX`). 분모 0 → `positiveRate: null`. 모집단 술어(`answerIds` ×
      `trackedRollupIn`) 불변. 주석의 "positive-dominant" 서술 갱신(:479).
- [ ] 1.2 추이 ③ 버킷 SQL (`aggregateStandardTrendFromMirror` :891-905) — 버킷별 4계열 합으로
      교체(job별 CTE 제거). `StandardTrendBucket.sentAnswers/positiveAnswers`(:833-834) →
      `sentMentions/positiveMentions` 개명 + 병합부(:959-960) 갱신.
- [ ] 1.3 서브 Q3 SQL (`aggregateSubKpisFromMirror` :681-702) — dominant 카운트(pos/neg FILTER)
      제거, 엔진별 `Σp/Σne/Σng/Σmx`만 조회. `SubKpiEngineRow`(:611-618)를 `sentMentions /
      positiveMentions / negativeMentions` 3필드로 통합(`positiveKeywords/negativeKeywords`
      흡수 — design §4) + 매핑(:757-761)·상단 #3 주석(:597) 갱신.

## 2. 어댑터 — `lib/scope/result-adapter.ts`

- [ ] 2.1 `StandardAggregates.sentiment` 타입(:165-172) 개명 + jsdoc "멘션 sentiment 카운트 합 —
      답변 수 아님" 명기.
- [ ] 2.2 HTTP KPI 폴백(:582-646, 반환 :704-710) — 답변별 peak(우세) 판정 제거, tracked 멘션의
      `m.sentiment` 4계열 전역 누적으로 교체(tracked 판정 로직 재사용). 분모 0 → null.
- [ ] 2.3 미러 mentions 어댑터 `aggregateMentionsFrom` — job별 우세 분류 블록(:1053-1065) 제거,
      tracked 멘션 4계열 카운트를 `sentimentTotals`에 직접 누적. 신호 합 0이면
      `sentimentTotals: null`(측정 대기) 유지. parity 주석(:911-913) 언급 단위로 갱신.
- [ ] 2.4 공개 API 폴백 `aggregateMentionsFromPublic`(:1299-1304) — **tracked 행만** 계상
      (`isTrackedRow` 재사용) + `mixed` 분기 추가(현행은 neutral로 흡수 — 계약 위반 수정).

## 3. 뷰모델

- [ ] 3.1 `app/[locale]/(dash)/dashboard/_data/live.ts` — ③ 카드 ratio(:253-267): "cached old
      struct" 역산 코드 삭제, `positiveMentions/sampledMentions` 직결. 추이 값(:502-504)·엔진
      일관성 ③ 입력(:675-677)을 신규 필드로. (`buildMirrorKpis`는 projects 표면 공유 —
      `projects/[id]/_data/live.ts`는 diff 없음 확인만.)
- [ ] 3.2 `app/[locale]/(dash)/website/_data/live.ts` — `buildTrendFromBuckets`(:164) 신규 필드로.
- [ ] 3.3 `app/[locale]/(dash)/standard/answer-analysis/_data/sub-kpis.ts`(:22-27, :37-47) —
      #17=`positiveMentions`, #18=`negativeMentions`, `negativeRate = negativeMentions ÷
      sentMentions`. null 시맨틱(신호 0 → 3종 모두 "측정 대기") 유지.
- [ ] 3.4 잔여 소비처 전수 스윕: `grep -rn "sentAnswers\|positiveAnswers\|sampledAnswers\|
      positiveKeywords\|negativeKeywords" app lib --include="*.ts*"`가 sentiment 용도로 0건
      (position/citations의 `sampledAnswers`는 별개 구조 — 오탐 제외).

## 4. 캐시 — `lib/scope/server.ts`

- [ ] 4.1 `mirrorCache` keyPart(:523) `"mirror"` → `"mirror-v2"` 승격(구 구조 엔트리 혼재 창
      차단 — design §5).

## 5. i18n — `messages/{ko,en}.json`

- [ ] 5.1 우호도 정의(:245)·산식(:254)을 언급 단위로 개정(예: "당사 브랜드 언급의 긍정 감정
      신호 수 ÷ 전체 감정 신호 수(긍정+중립+부정+혼합) × 100"). **명칭 키(:236) 불변.**
- [ ] 5.2 `dashboard.kpi.ratio.sentiment.num/den`(ko :288-291, en 대응) — "긍정 언급 답변/브랜드
      언급 답변" → 언급 신호 단위 라벨.
- [ ] 5.3 `mentions.breakdown.sentimentHint`(ko :441, en 대응) — "우세 감정 분류(답변 단위)" →
      언급 단위 문구, parity 문장("긍정 비율은 대시보드 AI 우호도와 동일 산식") 유지.
- [ ] 5.4 negativeRate 라벨 "부정 답변 비율" → "부정 언급 비율"(en 대응) + 정의·산식 문구
      (ko :465-470 일대) 언급 단위로 개정. #17/#18 정의는 값 불변이므로 문구 유지(단 "답변"
      표현이 있으면 정정).

## 6. 테스트

- [ ] 6.1 기존 픽스처 갱신: `website/_data/live.test.ts`(:54,:73,:97,:112) ·
      `projects/[id]/_data/live.test.ts`(:74) ·
      `lib/db/repositories/scope-aggregates.slim.test.ts`(:72,:170 — slim/live sentimentTotals
      parity 유지) · `lib/scope/mirror/sync.test.ts`는 스키마 불변이므로 무수정 통과 확인.
- [ ] 6.2 신규 단위 테스트 4케이스: ① 분모 0 → `positiveRate === null`(0 아님) ② mixed가
      분모에 포함 ③ `p==ng` 동률 입력에서 긍/부정 이중계상 소멸(합 기반이므로 분포 총합 ==
      신호 총합) ④ parity — 동일 입력에서 감정분포 긍정 세그먼트 비율 == positiveRate.

## 7. 문서

- [ ] 7.1 `docs/feature-spec.md` 우호도 서술(:98 KPI 타일 툴팁 문구 일대) 언급 단위로 갱신.
      `grep -rn "우호도" docs docs/development-guide.md README.md`로 잔여 답변 단위 서술 스윕.

## 8. 게이트

- [ ] 8.1 `npm test` · `npm run build` · `npm run lint` · `npm run check:strings` 전부 통과.
- [ ] 8.2 실데이터 대조(수용 기준 6): supabase-hmg 미러에서 GGMD 표준 루트 최근 완주 주차의
      언급 단위 긍정률을 SQL로 직접 계산해 앱 표시값과 대조(round1 일치). 스케치:
      ```sql
      SELECT round(100.0 * sum(m.sentiment_positive)
               / nullif(sum(m.sentiment_positive + m.sentiment_neutral
                          + m.sentiment_negative + m.sentiment_mixed), 0), 1)
      FROM scope_mentions m JOIN scope_answers a ON a.job_id = m.job_id
      WHERE a.measured_at >= date_trunc('week', <검증 주>)
        AND a.measured_at <  date_trunc('week', <검증 주>) + interval '7 days'
        AND m.brand_rollup_entity_id IN (<tracked rollup ids>);
      ```
      참고치: 2026-07-27주 HMG 3사 9.1%(부분 신채점 유입 상태 — 검증 시점 재계산 값 기준).
      대조 조건(스냅샷 배치 vs 주간 창)은 앱 카드의 모집단과 동일하게 맞출 것.
- [ ] 8.3 머지 전: 독립 검증(데이터 정확성 렌즈) → 제품 책임자 승인. (구현자와 분리된 검증.)
