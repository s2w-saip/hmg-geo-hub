# mention-type-analysis Specification (delta)

## ADDED Requirements

### Requirement: 멘션 유형별 브랜드 점유율을 제공해야 한다

답변 분석 멘션 탭은 멘션 유형(단순 언급/추천/비교/정의/최종 선택) 각각에 대해 브랜드별
언급 점유율을 표시해야 한다(SHALL). 유형별 분모는 **그 유형의 전체 브랜드 언급 카운트**
(top-N 표시 컷 이전 전량 합)여야 하며(SHALL), 표시 브랜드 세그먼트 합과 "기타" 세그먼트의
합은 분모와 일치해야 한다(SHALL). 당사 판정은 축E(활성 브랜드 필터 ∩ 엔티티 로스터)를
따르고, 세팅(추적 대상)으로 집계 대상을 제한해서는 안 된다(SHALL NOT).

#### Scenario: 유형으로 좁힌 점유율 비교

- **WHEN** 전체 SOV가 당사 42%·비교 브랜드 13%이고 '추천' 유형 카운트가 당사 30·비교 25·기타 45이면
- **THEN** 추천 행은 당사 30%·비교 25%·기타 45%를 표시해 전체 SOV와의 격차 변화를 읽을 수 있다

#### Scenario: 세그먼트 합 불변식

- **WHEN** 임의 유형의 표시 브랜드 세그먼트와 기타 세그먼트를 합산하면
- **THEN** 그 유형의 전량 언급 카운트(totals)와 일치한다

### Requirement: 브랜드 해석·제외 규칙은 언급 랭킹과 동일해야 한다

유형×브랜드 집계의 브랜드 해석은 언급 랭킹과 동일해야 한다(SHALL): rollup entity id
우선(모델 언급은 소속 브랜드로 합산), 자국어 알리아스는 정본 브랜드로 접고
(`rollupCanonicalPairs`/`canonRollupSql`), 비경쟁 브랜드(Apple/Google/Samsung)는
분자·분모 모두에서 제외한다. SQL 헤드라인 경로와 JS 경로는 동일 입력에서 동일 결과를
내야 한다(SHALL — parity).

#### Scenario: 알리아스 접기

- **WHEN** '기아' 엔티티에 추천 유형 카운트 n이 있으면
- **THEN** Kia의 추천 세그먼트에 n이 합산되고 '기아' 행은 별도로 표시되지 않는다

#### Scenario: 두 경로 parity

- **WHEN** 동일 미러 데이터를 SQL 헤드라인 경로와 JS 경로로 집계하면
- **THEN** `typesByBrand`의 totals·브랜드별 카운트가 일치한다

### Requirement: 유형 신호가 없으면 측정 대기여야 한다

모집단에 유형 신호가 하나도 없으면 유형×브랜드 집계는 null이어야 하며(SHALL), UI는
0% 바 대신 측정 대기 placeholder를 표시해야 한다(SHALL). 캐시된 구 구조(필드 부재)를
읽은 경우에도 오류 없이 기존 카드로 폴백해야 한다(SHALL).

#### Scenario: 백필 전 placeholder

- **WHEN** scope 유형 분류 백필 전 데이터만 있으면
- **THEN** 카드는 측정 대기를 표시하고 0%를 지어내지 않는다
