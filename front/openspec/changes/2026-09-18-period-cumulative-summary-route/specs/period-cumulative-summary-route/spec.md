# period-cumulative-summary-route

## ADDED Requirements

### Requirement: 기간이 지정된 요청은 집계층이 회차 누적을 직접 서빙한다

기간(`dateFrom` 또는 `dateTo`)이 지정된 표준·웹사이트 카드 계열 요청은 회차 집합 모드
(`mode: "period"`)로 읽기 경로를 판정해야 한다(SHALL). 그 경로가 가능한 한
`filters.cumulative` 를 이유로 미러 직조회로 폴백해서는 안 된다(SHALL NOT).

기간 의미론은 2026-09-16 확정 정본을 그대로 따른다(SHALL): 기간 없음 = 최신 1회차 스냅샷,
기간 지정 = 그 기간에 걸치는 회차 앵커 전부 누적.

#### Scenario: 30일 기간의 글로벌 대시보드
- **WHEN** `/ko/dashboard?time=2026-08-20..2026-09-18` 을 admin 무필터로 렌더하면
- **THEN** 런타임 로그에 `x-hmg-summary(global S1.dashboard …): fallback:cumulative` 가 남지 않고
  `hit cycles:<n>` 이 남는다
- **AND** KPI 카드 ①~⑤ 가 값을 갖는다(빈 카드·degrade 문구가 아니다)

#### Scenario: 기간 없는 요청은 종전 그대로
- **WHEN** 기간 파라미터 없이 같은 화면을 렌더하면
- **THEN** 읽기 경로 판정·발행 SQL 텍스트·캐시 키·로그 문자열이 이 변경 이전과 동일하다

#### Scenario: 기간 없는 cumulative 는 스냅샷과 동치
- **WHEN** 화면이 기간 없이 `cumulative: true` 를 넘기면(인용·언급 계열)
- **THEN** 미러 산식 정본(`cumulativeMode`)이 스냅샷으로 판정하는 것과 같은 의미론으로
  사실표 스냅샷을 읽으며, `cumulative` 를 이유로 폴백하지 않는다

### Requirement: 누적 비율 지표는 분자 합 / 분모 합으로 낸다

회차 N개를 누적하는 비율 지표(노출률·점유율·자사 인용 비율·긍정 비율·평균 순위)는
각 회차 비율의 산술 평균이 아니라 **분자 합을 분모 합으로 나눈 값**이어야 한다(SHALL).

#### Scenario: 가중 평균
- **WHEN** 회차 A(분자 10 / 분모 100)와 회차 B(분자 1 / 분모 10)를 누적하면
- **THEN** 결과는 `(10+1) / (100+10)` 이며 `(10% + 10%) / 2` 로 계산하지 않는다

### Requirement: 프롬프트 단위 고유 개수는 회차 간 합산하지 않는다

프롬프트 고유 개수 계열(측정 프롬프트 수·미언급 프롬프트 수·주제별 프롬프트 수)은
집계층 키 그룹 안에서 DISTINCT 로 굳어 있어 그룹 간·회차 간 SUM 이 이중 계상이다.
기간 모드에서 이 지표를 집계층 컬럼(`prompts_measured`·`prompts_tracked`)의 합으로
내서는 안 된다(SHALL NOT). 회차 집합 전체에 대한 고유 개수로 산출하거나,
산출이 불가능하면 그 셀의 기준(최신 회차)을 화면에 명시해야 한다(SHALL).

#### Scenario: 4회차 누적에서 프롬프트 수
- **WHEN** 같은 프롬프트가 창 안 4회차에서 모두 측정된 상태로 30일 기간을 조회하면
- **THEN** 측정 프롬프트 수는 4가 아니라 1로 센다

### Requirement: 기간 모드의 폴백 목적지는 미러이며 단일 회차 세부층이 아니다

기간 모드에서 집계층이 거부될 때(`agg-fold-missing`·`agg-empty`·`agg-widget-empty`)
단일 회차만 읽는 세부층 리더로 폴백해서는 안 된다(SHALL NOT). 목적지는 미러다(SHALL).
스냅샷 모드의 폴백 목적지는 종전대로 세부층이다.

#### Scenario: 창 안 한 회차의 접기가 누락된 경우
- **WHEN** 기간 창 안 회차 중 하나가 집계층에 접혀 있지 않아 집계층이 거부되면
- **THEN** 화면은 미러 누적 값을 받는다 (1회차 값이 30일 라벨 아래 실리지 않는다)

### Requirement: 회차 집합 판정 실패는 값이 아니라 경로만 바꾼다

회차 집합 판정이 실패하면(구멍·주 중복·판정 불가) 폴백이 일어나고, 그 사유는
응답 헤더·로그(`x-hmg-summary`)에 남아야 한다(SHALL). 폴백은 느릴 뿐 값의 의미론을
바꾸지 않는다.

#### Scenario: 창 안 미발행 회차
- **WHEN** 웹사이트 함대의 창 안에 노출 불가 회차가 섞여 있으면
- **THEN** 로그에 `fallback:unpublished-cycle-in-range` 가 남고 화면은 미러 경로로 값을 낸다

### Requirement: 예산 초과로 빈 지면은 데이터 없음과 구분해 표시한다

집계가 예산(문장 상한 또는 벽시계 마감)을 넘겨 비는 경우, 화면은 "측정 데이터가 아직 없습니다"
가 아니라 지연 문구를 보여야 한다(SHALL). 표준 대시보드와 웹사이트 오버뷰는 **같은 문구 키**를
써야 한다(SHALL). 이를 위해 새 i18n 키를 만들지 않는다.

#### Scenario: 웹사이트 오버뷰 예산 초과
- **WHEN** 웹사이트 오버뷰 카드 집계가 예산에 걸려 `null` 로 닫히면
- **THEN** 화면은 `dashboard.kpi.degraded` 문구를 보여준다

#### Scenario: 실제 데이터 없음
- **WHEN** 필터 조합이 공집합이라 값이 없으면
- **THEN** 화면은 종전 `empty` 문구를 보여준다

### Requirement: 기간 모드 전환은 화면 키 스위치로 되돌릴 수 있다

집계층 기간 서빙은 `summary_settings.read_screens` 의 화면 키로 끌 수 있어야 한다(SHALL).
새 플래그를 추가하지 않는다(SHALL NOT). 고객이 보는 숫자를 바꾸는 키는
`SUMMARY_SCREEN_OPT_IN` 규약을 따라 이름을 명시했을 때만 켜져야 한다(SHALL).

#### Scenario: 되돌리기
- **WHEN** 값 이상이 신고되어 해당 화면 키를 `read_screens` 에서 내리면
- **THEN** 다음 요청부터 그 화면은 종전 미러 경로로 돌아가며, 코드 배포가 필요하지 않다

### Requirement: 이 변경은 마이그레이션을 수반하지 않는다

집계층 표·인덱스·접기 스키마를 변경하지 않는다(SHALL NOT). `lib/db/migrations/` 에
새 파일이 추가되지 않아야 하고 `meta/_journal.json` 이 변하지 않아야 한다(SHALL).

#### Scenario: 배포 순서
- **WHEN** 이 변경을 배포하면
- **THEN** `db:apply` 선행이 필요 없다 (마이그레이션이 없으므로 배포 단독으로 완결된다)
