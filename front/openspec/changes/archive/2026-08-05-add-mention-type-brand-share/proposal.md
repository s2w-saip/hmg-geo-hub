# Add Mention-Type Brand Share (멘션 유형별 브랜드 점유율 비교)

## Why

GGMD 고객 질문(2026-08-05): "멘션 유형에서 주요 유형별 언급 점유율 혹은 브랜드별 비교가
가능한 뷰가 있나 — 예: 전반 SOV는 당사 42% vs 경쟁 13%로 격차가 크지만 '추천' 유형으로
좁히면 격차가 좁혀지는지 확인하고 싶다."

현행 답변 분석의 멘션 유형 카드는 **당사 언급의 유형 분포만** 보여준다
(`aggregateMentionsFrom`이 `isTracked`(당사) 언급의 `type_breakdown`만 합산 —
`lib/scope/result-adapter.ts:997-1006`, 카드 힌트도 "당사 브랜드가 어떤 맥락으로
언급됐는지"). 유형으로 좁힌 브랜드별 점유율 비교는 어떤 화면에도 없다.

데이터는 이미 준비돼 있다: scope 미러 `scope_mentions`가 (답변 × 브랜드 엔티티) 행마다
`type_mention / type_recommendation / type_comparison / type_definition /
type_final_choice` 5컬럼을 채우고(`lib/db/schema.ts:709-714`), rollup id
(`brand_rollup_entity_id`)로 모델 언급의 브랜드 합산·알리아스 접기도 성립한다.
집계와 UI만 추가하면 된다.

## What Changes

- **집계 — `MentionsLive`에 유형×브랜드 매트릭스 추가** (`typesByBrand`, optional):
  - `totals`: 유형별 전 브랜드 카운트 합(분모 — top-N 컷과 무관한 전량 합).
  - `brands[]`: 스냅샷 상위 브랜드(랭킹과 동일 컷)별 `{ brand, isTracked, types }`.
  - 두 읽기 경로 모두 구현: JS 경로(`aggregateMentionsFrom` — `resolveBrand` 후
    브랜드별 `type_breakdown` 누적)와 SQL 헤드라인 경로(`aggregateMentionsHeadlineSql`
    — rollup GROUP BY에 `sum(type_*)` 5컬럼 추가). 알리아스 rollup 접기
    (`canonRollupSql`/`rollupCanonicalPairs`)와 비경쟁 브랜드 제외
    (Apple/Google/Samsung)는 언급 랭킹과 동일 적용.
- **UI — 멘션 유형 카드 개편** (`mentions-view.tsx::TypeBreakdown`): 유형별 100% 스택
  바(당사 강조 + 비교 브랜드 + 상위 브랜드 + 기타)로 브랜드 점유율을 비교하고, 유형별
  당사 점유율 %를 라벨로 병기. 비교 브랜드는 기존 헤드투헤드 규칙 재사용(프로젝트
  지정 타겟 경쟁사, 미지정/타 표면은 SOV 1위 자동). 기존 당사 유형 분포(절대 건수)는
  카드 내 보조 표기로 유지(design D1). 정의 ⓘ툴팁 필수(유형 5종 + "점유율 분모 = 해당
  유형 전체 언급").
- **적용 표면**: `MentionsView`는 표준/웹사이트/프로젝트 공용 → 세 표면 동시 적용.
- **구 캐시 호환**: 신규 필드는 optional — 구 캐시 엔트리(30분 TTL)에는 없으므로 UI는
  `typesByBrand` 부재 시 현행 카드로 폴백(캐시 세대 승격 불필요).

### 범위 제외 (명시)

- **멘션 유형 전역 필터 축 없음** — 필터 패널 축은 답변(job)·프롬프트 단위 술어인데
  유형은 언급 내부 속성이라 축으로 넣으면 언급 가중치 의미론이 화면마다 갈라진다.
  유형 슬라이스는 이 카드 안에서만 제공하고, 전역 축은 수요 확인 후 별도 change.
- scope API/미러 스키마 변경 없음(컬럼 기존재). 대시보드 KPI 산식 불변.

## 코어/테넌트 판정

**코어.** 유형별 브랜드 점유율은 scope 분류 파이프라인의 표준 산출물 위 시각화로,
어느 테넌트에도 동일하게 적용된다. 당사 판정 입력(엔티티 로스터)은 테넌트 자산이지만
이 change에서 불변.

## Capabilities

### Added Capabilities

- `mention-type-analysis`: 멘션 유형×브랜드 점유율의 산출 규칙(분모·rollup 접기·비경쟁
  제외·두 경로 parity)과 표시 규약. 기존에 멘션 유형 분석을 소유한 capability 없음.

## Impact

(라인 앵커는 `wbs/menu-group-restriction` 작업 트리 기준 — 착수 시 재확인.)

- **타입**: `lib/scope/result-adapter.ts` — `MentionsLive`(:780-794)에 `typesByBrand`
  optional 추가; `lib/scope/types.ts::MentionTypeBreakdown`(:293) 재사용.
- **집계 JS 경로**: `result-adapter.ts::aggregateMentionsFrom`(:911-) — 브랜드별
  유형 누적(현행 당사 한정 :997-1006은 typeTotals 용으로 유지).
- **집계 SQL 경로**: `lib/db/repositories/scope-aggregates.ts::
  aggregateMentionsHeadlineSql`(:1580-) — `sum(type_*)` 5컬럼 + totals 스칼라.
- **캐시 슬리밍**: `slimMentionsLiveForCache` — `typesByBrand.brands`를 랭킹 top-N과
  동일 컷(분모 totals는 전량 유지).
- **UI**: `app/[locale]/(dash)/standard/answer-analysis/_components/mentions-view.tsx`
  — `TypeBreakdown`(:825-857) 개편 + 호출부(:374-377).
- **i18n**: `messages/{ko,en}.json` — `answerAnalysis.mentions.breakdown.*` 신규 키
  (비교 힌트·기타 라벨·툴팁 정의), 기존 `typesTitle`(:443) 유지.
- **테스트**: SQL/JS 경로 parity·rollup 접기·비경쟁 제외·분모 정합 단위 테스트
  (기존 `scope-aggregates.slim.test.ts` 패턴).

## 수용 기준 (요약 — 상세는 specs/tasks)

1. 유형별 브랜드 세그먼트 합(표시 브랜드 + 기타) == 그 유형의 전체 언급 카운트.
2. 동일 입력에서 SQL 헤드라인 경로와 JS 경로의 `typesByBrand`가 일치(parity).
3. 알리아스(기아/هيونداي 등) 언급이 정본 브랜드로 접혀 계상되고, Apple/Google/Samsung은
   제외된다.
4. 고객 예시 시나리오 재현: 전체 SOV와 '추천' 유형 내 점유율을 한 화면에서 비교 가능.
5. `npm test` · `npm run build` · `npm run lint` · `npm run check:strings` 통과.
