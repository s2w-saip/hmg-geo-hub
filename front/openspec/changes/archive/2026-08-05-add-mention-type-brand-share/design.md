# Design — 멘션 유형별 브랜드 점유율 비교

## D1. 카드 형태: 기존 카드 확장 (신규 카드 아님)

기존 "멘션 유형" 카드를 확장한다. 근거: 같은 질문("어떤 맥락으로 언급되나")의 심화라
카드가 갈라지면 어느 쪽이 정본인지 혼선. 확장 후 구성:

```
멘션 유형                                    ⓘ
유형별 브랜드 언급 점유율 — 당사 vs 경쟁

추천     [■■■■■■당사■■■■■□□비교□□□□기타□□]  당사 34.2%
비교     [■■■당사■■□□□□비교□□□□□기타□□□□]  당사 21.0%
단순 언급 [■■■■■■■■당사■■■■■□비교□□기타□]  당사 45.1%
정의     [...]                              당사 …%
최종 선택 [...]                              당사 …%

범례: ■당사(Hyundai) ■비교(Toyota) ■기타 상위 브랜드 …
보조: 당사 유형 구성(절대 건수) — 기존 가로 바 5줄 유지(접기 가능)
```

- 각 유형 행 = 그 유형 전체 언급을 분모로 한 100% 스택 바. 세그먼트: 당사(스코프 내
  3사 합 또는 브랜드별 — hq 계정은 3사 개별 세그먼트로, 단일 브랜드 스코프는 1개),
  비교 브랜드, 그 외 상위 브랜드(랭킹 top-N 컷), 잔여는 "기타"로 접음.
- 우측 % 라벨 = 당사 합산 점유율. 고객 시나리오("추천으로 좁히면 격차가 좁혀지나")를
  라벨만 훑어도 읽을 수 있게 한다.
- 비교 브랜드 선정은 `mentions-view.tsx` 헤드투헤드 기존 규칙 재사용:
  `designatedTargetBrand`(프로젝트 지정) 우선, 없으면 외부 브랜드 SOV 1위.

## D2. 데이터 구조

```ts
// MentionsLive에 추가 (optional — 구 캐시 엔트리 폴백)
typesByBrand?: {
  totals: MentionTypeBreakdown;            // 유형별 전 브랜드 합 (분모, 전량)
  brands: Array<{                          // 스냅샷 상위 브랜드 (랭킹 동일 컷)
    brand: string;
    isTracked: boolean;
    types: MentionTypeBreakdown;
  }>;
} | null;   // null = 유형 백필 전 (typeTotals와 동일 시맨틱)
```

- `totals`는 top-N 컷 **이전** 전량 합 — 세그먼트 합 + 기타 = totals 불변식의 기준.
- "기타" 세그먼트 = `totals[type] − Σ brands[].types[type]` (음수 방지 clamp 0).
- null 규약은 기존 `typeTotals`와 동일: 유형 신호가 하나도 없으면 null → 카드가
  "측정 대기" placeholder (0을 지어내지 않는다).

## D3. 집계 경로 2곳의 동일 규칙

| 규칙 | JS 경로 (`aggregateMentionsFrom`) | SQL 경로 (`aggregateMentionsHeadlineSql`) |
| --- | --- | --- |
| 브랜드 해석 | `makeBrandResolver` (rollup id 우선) | `canonRollupSql` GROUP BY |
| 알리아스 접기 | `rollupCanonicalPairs` 로스터 | 동일 (기존 랭킹과 같은 접기) |
| 비경쟁 제외 | `isNonCompetitorBrand` | 기존 랭킹의 제외 술어 재사용 |
| 당사 판정 | `isTracked` (축E: 활성 brand 필터 ∩ 로스터) | `trackedRollupIn(filters)` |
| 모집단 | 스냅샷 배치 (기간 내 최신) | 동일 (`snapshotAnswerIds`) |

기존 `typeTotals`(당사 한정 절대 건수)는 **유지** — 값은
`typesByBrand.brands.filter(isTracked)` 합과 일치해야 한다(parity 테스트 대상).

## D4. 전역 유형 필터 축을 만들지 않는 이유 (범위 제외 재확인)

필터 패널 축(geography/engine/funnel/…)은 답변(job) 또는 프롬프트 단위 술어다.
멘션 유형은 **언급 내부의 카운트 분해**라서 축으로 넣으면 (a) 답변 수·노출률 등
답변 단위 KPI에는 적용 불가(의미 없음), (b) 언급 수 계열만 부분 적용되는 반쪽 축이
된다 — 축마다 적용 범위가 다른 필터는 QA 불변식(값 vs 선택지)을 깨기 쉽다.
유형 슬라이스는 이 카드 안으로 한정하고, 전역 축 수요가 실재하면 "언급 단위 축"
클래스를 별도 change로 설계한다.
