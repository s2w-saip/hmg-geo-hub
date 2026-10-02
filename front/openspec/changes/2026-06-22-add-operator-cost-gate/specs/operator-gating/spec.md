## ADDED Requirements

### Requirement: 비용 유발 액션은 운영자 권한으로 게이팅된다
시스템은 비용을 유발하는 액션을 **프로젝트 생성 · 인텐트 수집 · 프롬프트 실행** 3종으로 한정하고,
이 3종만 운영자(operator) 권한으로 게이팅해야 한다(SHALL). 조회·대시보드·드릴다운 등 비용을
유발하지 않는 경로는 게이팅하지 않아야 한다(SHALL NOT). 게이팅 판정은 단일 정책 모듈
(`lib/auth/operator-policy`)을 통해서만 이루어져야 하며(SHALL), UI 가시성과 서버 액션 강제가
동일 함수를 사용해 *보이는 것 = 할 수 있는 것* 을 만족해야 한다.

#### Scenario: 조회는 게이팅되지 않음
- **WHEN** 운영자 권한이 없는(operator=none) 인증 사용자가 대시보드·답변분석·인용분석을 연다
- **THEN** 데이터가 역할 scope 범위 내에서 정상 표시된다(운영자 권한과 무관)

#### Scenario: 게이팅은 단일 정책 모듈을 경유
- **WHEN** 비용 액션의 허용 여부를 판정해야 하면
- **THEN** 모든 호출 경로(UI 가시성·서버 액션)가 동일한 operator-policy 함수를 통과한다

### Requirement: 운영자 권한은 none / assigned / global 세 값을 가진다
시스템은 각 사용자에게 운영자 권한 `operator ∈ {none, assigned, global}` 을 부여해야 하며(SHALL),
이는 데이터 scope·역할과 **직교(orthogonal)** 한다. 기본값은 `none`(조회만)이어야 한다(SHALL).

- `global` : 데이터 scope 내 모든 프로젝트에 대해 생성·수집·실행 가능.
- `assigned` : 배정(active member)된 프로젝트에 한해 수집·실행 가능. 신규 프로젝트 생성 불가.
- `none` : 비용 액션 전면 불가(조회만).

#### Scenario: 기본값은 조회 전용
- **WHEN** operator 값이 명시되지 않은 사용자가 로드되면
- **THEN** operator 는 `none` 으로 도출되어 어떤 비용 액션도 허용되지 않는다

### Requirement: 프로젝트 생성은 global 운영자(또는 admin)만 가능하다
시스템은 신규 프로젝트 생성을 `operator=global` 또는 admin 에게만 허용해야 한다(SHALL).
`assigned`·`none` 운영자의 생성 시도는 서버 액션에서 거부되어야 하며(SHALL), 라우트 가시성
(메뉴·"새 프로젝트" 버튼)도 동일 판정으로 숨겨져야 한다.

#### Scenario: global 운영자가 프로젝트를 생성
- **WHEN** operator=global 사용자가 자신의 scope 내 국가로 프로젝트 생성을 요청하면
- **THEN** 프로젝트가 생성되고 본인이 Owner(=배정)로 등록된다

#### Scenario: assigned 운영자는 신규 프로젝트를 생성할 수 없음
- **WHEN** operator=assigned 사용자가 프로젝트 생성 액션을 직접 호출하면
- **THEN** 액션이 거부되고 어떤 프로젝트도 생성되지 않는다

#### Scenario: 비운영자에게 생성 진입점이 보이지 않음
- **WHEN** operator=none 사용자가 프로젝트 목록을 렌더하면
- **THEN** "새 프로젝트" 생성 진입점이 표시되지 않으며 `/projects/new` 직접 접근도 차단된다

### Requirement: 인텐트 수집·프롬프트 실행은 운영자의 배정 프로젝트로 제한된다
시스템은 인텐트 수집(prompt candidate 추가)과 프롬프트 실행(measurement 트리거)을
`canOperateProject` 판정으로 게이팅해야 한다(SHALL): admin → 허용; `none` → 거부;
`global` → 허용; `assigned` → 해당 프로젝트의 active member 일 때만 허용. 배정 여부는
`project_members`(status=active)로 판정한다(SHALL).

#### Scenario: global 운영자는 scope 내 임의 프로젝트에서 실행
- **WHEN** operator=global 사용자가 프롬프트 실행을 요청하면
- **THEN** 해당 프로젝트의 draft 프롬프트가 queued 로 전이된다

#### Scenario: assigned 운영자는 배정 프로젝트에서만 실행
- **WHEN** operator=assigned 사용자가 자신이 active member 가 아닌 프로젝트에서 실행/수집을 호출하면
- **THEN** 액션이 거부되고 어떤 측정 트리거·후보 추가도 일어나지 않는다
- **AND** 동일 사용자가 active member 인 프로젝트에서는 실행/수집이 허용된다

#### Scenario: 비운영자는 실행·수집이 불가
- **WHEN** operator=none 사용자가(설령 프로젝트 member 라도) 실행 또는 인텐트 수집을 호출하면
- **THEN** 액션이 거부된다

### Requirement: 외부 수행사(vendor)는 운영자 권한이 영구 OFF 다
시스템은 role=`vendor` 사용자의 operator 를 항상 `none` 으로 강제해야 한다(SHALL). vendor 는
배정 프로젝트 READ 만 가능하며, 실제 실행은 이노션이 운영자 권한으로 수행한다. admin 이 vendor
에게 `none` 이외의 operator 를 부여하려는 시도는 거부되어야 한다(SHALL).

#### Scenario: vendor 의 운영자 권한은 도출 단계에서 none 으로 정규화
- **WHEN** 저장값과 무관하게 role=vendor 사용자가 세션으로 도출되면
- **THEN** operator 는 `none` 이고 어떤 비용 액션도 허용되지 않는다

#### Scenario: vendor 에 운영자 부여 시도는 거부됨
- **WHEN** admin 이 vendor 사용자에게 operator=global(또는 assigned)을 저장하려 하면
- **THEN** 액션이 거부되고 profiles 행의 operator 는 none 으로 유지된다
