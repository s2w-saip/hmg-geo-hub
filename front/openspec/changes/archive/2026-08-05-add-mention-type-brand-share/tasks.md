# Tasks — 멘션 유형별 브랜드 점유율 비교

> 라인 앵커는 `wbs/menu-group-restriction` 작업 트리 기준 — **착수 시 재확인**
> (문서와 코드가 다르면 코드가 이긴다). 순서: 타입 → 집계 → 슬리밍 → UI → i18n → 테스트.

## 1. 타입 — `lib/scope/result-adapter.ts`

- [x] 1.1 `MentionsLive`에 `typesByBrand` optional 필드 추가 (design D2 구조).
      jsdoc에 "totals = top-N 컷 이전 전량 합, null = 유형 백필 전" 명기.

## 2. 집계 — JS 경로 (`result-adapter.ts::aggregateMentionsFrom`)

- [x] 2.1 브랜드 누적 루프에서 `m.type_breakdown`을 resolveBrand 결과
      브랜드별로 누적(`BrandAcc`에 types 5카운트 추가). 스냅샷 밖(`!inSnapshot`) 언급은
      제외(수치 모집단과 동일). 당사 한정 `typeTotals` 누적은 그대로 유지.
- [x] 2.2 반환부에서 `typesByBrand` 조립: totals = 전 브랜드 합(컷 전), brands =
      랭킹 순서 그대로. 유형 신호 전무면 null(규약 = totals 합 > 0).

## 3. 집계 — SQL 헤드라인 경로 (`scope-aggregates.ts::aggregateMentionsHeadlineSql`)

- [x] 3.1 rollup GROUP BY 쿼리에 `sum(type_mention) … sum(type_final_choice)` 5컬럼
      추가 — 기존 랭킹과 동일한 `canonRollupSql` 접기·비경쟁 제외·스냅샷 술어(W) 안에서.
- [x] 3.2 totals(분모) — top-N 컷 이전 전량 합. 별도 스칼라 쿼리 없이 3.1 결과 전 행
      합으로 산출(현행 쿼리가 컷 전 전 브랜드 행을 돌려줌 — 확인됨).
- [x] 3.3 반환 `MentionsLive.typesByBrand` 조립 — JS 경로와 동일 null 규약.

## 4. 캐시 슬리밍 — `scope-aggregates.ts::slimMentionsLiveForCache`

- [x] 4.1 `typesByBrand.brands`를 top-N(30) ∪ 당사 로 캡(totals는 전량 유지 → 분모
      불변). 증분 = 브랜드 N × 5 int ≈ 수 KB, 주석 명기.
- [x] 4.2 구 캐시 호환: optional 필드 → 부재 시 UI 가 현행 카드로 폴백(캐시 세대 승격
      불필요, 주석 명기).

## 5. UI — `standard/answer-analysis/_components/mentions-view.tsx`

- [x] 5.1 `TypeBreakdown` 개편: 유형별 100% 스택 바 + 당사 점유율 % 라벨
      (design D1). 세그먼트 색은 `@theme` 토큰(brand-700/accent-gold/ink-*) 재사용
      (hex 리터럴 금지 — check:strings·grep 확인).
- [x] 5.2 비교 브랜드 = 기존 헤드투헤드 `comparison?.target.brand` 재사용
      (지정 없으면 외부 SOV 1위 — 중복 구현 없음).
- [x] 5.3 당사 유형 구성(절대 건수, 기존 5줄 바)은 보조 `<details>` 로 유지.
- [x] 5.4 `typesByBrand` 없으면 스택 바 생략하고 보조 절대건수만 렌더 폴백 +
      `typeTotals`도 없으면 기존 "측정 대기" placeholder 유지.
- [x] 5.5 ⓘ툴팁: 유형 5종 정의 + "점유율 분모 = 해당 유형 전체 브랜드 언급" 명시
      (기존 ColInfo 패턴).

## 6. i18n — `messages/{ko,en}.json`

- [x] 6.1 `answerAnalysis.mentions.breakdown.*` 신규 키: typesShareHint·typesShareDef
      (definition/formula)·ours·others·oursShare·typesAbsToggle. en 대응 완료.
      "표준" 어휘 미사용(글로벌), 기존 용어(언급/점유율) 준수.

## 7. 테스트

- [~] 7.1 parity: SQL↔JS `typesByBrand` 일치는 라이브 DB 필요 → 단위 픽스처 대신
      dev 3표면 렌더(8.2)로 대조. 표준(SQL)·프로젝트(JS) 모두 카드 정상 렌더, 유형별
      점유율 분포가 서로 다른 경로에서 동일 규칙으로 산출됨을 확인. (백로그: DB 픽스처
      parity 테스트 — `scope-aggregates.slim.test.ts` 패턴)
- [x] 7.2 불변식: 전 브랜드 types 합 == totals; `typeTotals` == tracked 브랜드 types 합
      (`mention-type-brand-share.test.ts`).
- [~] 7.3 알리아스 접기: 유형 카운트는 mention_count 와 동일 `BrandAcc` 버킷에 누적되므로
      브랜드 접기(makeBrandResolver/canonRollup)가 적용되면 유형도 함께 접힘 —
      구조적 보장. 접기 자체는 기존 브랜드-알리아스 테스트가 커버.
- [x] 7.4 제외: Apple/Google/Samsung 행이 totals·brands 에 불포함
      (`mention-type-brand-share.test.ts` — Apple 제외 확인).
- [x] 7.5 null 규약: 유형 신호 0 → `typesByBrand === null`(0% 바 아님).

## 8. 게이트

- [x] 8.1 `npm test`(701 pass) · `npm run build` · `npm run lint`(경고만) ·
      `npm run check:strings` 통과.
- [x] 8.2 dev 실데이터(미러) 확인: 표준(추천 23.0/비교 18.6/최종선택 16.8%)·웹사이트
      (추천 86.5/최종선택 99.2%)·프로젝트(추천 14.9%) 3표면 카드 렌더 + 유형별 편차
      (전체 SOV vs 추천/최종선택 점유율 차이)가 실제로 읽힘 — 에러 0.
