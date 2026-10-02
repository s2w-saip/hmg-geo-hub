# kpi-favorability Specification (delta)

## ADDED Requirements

### Requirement: AI 우호도는 언급 단위 긍정률로 산출되어야 한다
Core KPI ③ AI 우호도는 Scope 정본(`getTrackedKpiAggregate`)과 동일하게 **언급(멘션 sentiment
카운트) 단위 긍정률**로 산출해야 한다(SHALL): 모집단(해당 표면의 server-derived
`answerWhere` 답변 집합 × tracked rollup 멘션)의 sentiment 4계열 합 `P/NE/NG/MX`에서
`100 × P ÷ (P+NE+NG+MX)`(소수 1자리 반올림). `mixed`는 분모에 포함되어야 한다(SHALL).
답변(job) 단위 우세(dominant) 분류를 사용해서는 안 된다(SHALL NOT) — 우세 분류는 동률 답변을
긍정·부정 분자에 동시 계상하는 비대칭(SQL FILTER 독립 계상 vs JS else-if 배타)을 갖는다.
모집단 술어(스냅샷 배치·tracked rollup 판정)는 이 정렬로 변경되어서는 안 된다(SHALL NOT).

#### Scenario: 언급 카운트 합으로 산출
- **WHEN** 모집단의 tracked 멘션 sentiment 합이 P=6510, NE=604, NG=4, MX=209이면
- **THEN** 우호도는 round1(100×6510÷7327) = 88.8%로 표시된다

#### Scenario: mixed가 분모에 포함됨
- **WHEN** mixed 카운트만 0에서 양수로 증가하면
- **THEN** 분자는 불변이고 분모가 커져 우호도가 하락한다

#### Scenario: 동률 답변의 이중계상이 존재하지 않음
- **WHEN** 한 답변의 tracked sentiment가 긍정 n·부정 n(동률)이면
- **THEN** 그 답변의 신호는 긍정 분자에 n, 감정분포 부정 세그먼트에 n으로 각각 1회씩만 계상된다
  (어떤 카운트도 두 분자에 동시 계상되지 않는다)

### Requirement: 분모 0이면 null(측정 대기)이어야 한다
sentiment 신호 합(분모)이 0이면 우호도는 0%가 아니라 `null`이어야 하며(SHALL), UI는 이를 "측정
대기"로 표시해야 한다(SHALL). 값 0%(신호는 있으나 긍정이 0)와 측정 대기(신호 없음)를 혼동하게
표기해서는 안 된다(SHALL NOT).

#### Scenario: 신호 없음은 측정 대기
- **WHEN** 모집단에 sentiment 신호를 가진 tracked 멘션이 하나도 없으면
- **THEN** KPI 카드는 "측정 대기"를 표시하고 ratio 서브텍스트를 표시하지 않는다

#### Scenario: 긍정 0은 0%
- **WHEN** 신호는 존재하나 positive 합이 0이면
- **THEN** 우호도는 0%로 표시된다(측정 대기가 아니다)

### Requirement: 모든 표면·파생·폴백이 동일 단위·동일 산식이어야 한다
우호도의 모든 소비처는 같은 언급 단위 산식을 사용해야 한다(SHALL): 세 표면(표준/웹사이트/
프로젝트)의 KPI 카드 · 추이 버킷 ③ · 엔진 간 일관성 ③의 엔진별 입력 · 서브KPI 부정 언급
비율(분모 동일, 분자 NG) · KPI 카드 ratio 서브텍스트(분자 P, 분모 P+NE+NG+MX). 미러 경로가
아닌 폴백(HTTP KPI 폴백·공개 API mentions 폴백)도 동일 단위여야 하며(SHALL), 공개 API 폴백의
감정 집계는 tracked 행만 계상하고 `mixed`를 별도 분기해야 한다(SHALL).

#### Scenario: 추이 최신 버킷과 카드가 같은 단위
- **WHEN** 동일 필터·동일 기간 모집단으로 카드와 추이 버킷을 계산하면
- **THEN** 두 값은 같은 산식(언급 단위)의 결과다

#### Scenario: 엔진 간 일관성 입력이 카드 정의와 일치
- **WHEN** ③의 엔진 간 일관성을 산출하면
- **THEN** 엔진별 값은 그 엔진 모집단의 언급 단위 긍정률(Core ③ 동일 정의)이다

#### Scenario: 공개 API 폴백도 당사 한정
- **WHEN** 공개 API 폴백 경로에서 감정분포를 집계하면
- **THEN** tracked(당사) 행의 sentiment만 계상되고 mixed는 mixed 세그먼트로 분류된다

### Requirement: 감정분포 긍정 세그먼트는 우호도와 일치해야 한다 (parity)
답변분석 감정분포(sentimentTotals)는 동일 모집단의 tracked 멘션 sentiment 카운트
`{P, NE, NG, MX}`여야 하며(SHALL), 긍정 세그먼트 비율은 대시보드 우호도와 동일 산식·동일
값이어야 한다(SHALL). 신호 합이 0이면 감정분포는 null(측정 대기 placeholder)이어야 한다(SHALL).

#### Scenario: parity 검증
- **WHEN** 동일 모집단에서 감정분포와 우호도를 각각 계산하면
- **THEN** 감정분포의 긍정 세그먼트 비율 == 우호도(반올림 자리까지 동일)

### Requirement: 답변 단위 구조의 캐시가 신 코드에 읽혀서는 안 된다
집계 반환 구조의 필드는 언급 단위 의미의 이름을 가져야 하며(`*Answers` 이름에 언급 카운트를
담아서는 안 된다, SHALL NOT), 배포 전환 시 구(답변 단위) 구조로 캐시된 미러 집계 엔트리가 신
코드에 의해 읽히지 않도록 캐시 키 세대를 승격해야 한다(SHALL).

#### Scenario: 전환 직후 혼재 없음
- **WHEN** 신 코드 배포 직후 TTL이 남은 구 구조 캐시 엔트리가 존재하면
- **THEN** 신 코드는 그 엔트리를 키 불일치로 읽지 않고 재계산한다
