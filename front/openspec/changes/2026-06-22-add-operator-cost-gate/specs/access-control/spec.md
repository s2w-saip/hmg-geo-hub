## MODIFIED Requirements

### Requirement: 데이터 범위 계층을 가진 역할 모델
시스템은 각 사용자에게 역할(HQ / 권역 / 국가 / 관리자 / 수행사)을 부여해야 하며(SHALL), 역할과
허용 범위는 `profiles`(사용자가 수정 불가, 서버에서 read)에서 관리되어 브랜드 > 권역 > 국가 >
차종 계층을 따르는 허용 데이터 범위로 매핑되고, 관리자에게는 추가로 관리자 콘솔이 부여된다.

역할과 **직교(orthogonal)** 하게, 각 사용자는 운영자 권한 `operator ∈ {none, assigned, global}`
(default `none`)을 가지며(SHALL), 이는 비용 유발 액션의 실행 가능 여부를 결정한다(데이터 가시성과
별개의 축). 운영자 권한의 의미론과 게이팅은 `operator-gating` capability 가 정의한다.

#### Scenario: 역할이 허용 범위로 매핑됨
- **WHEN** 국가 역할 사용자가 로드되면
- **THEN** profiles에서 도출된 허용 범위가 해당 국가(및 하위)로 제한된다

#### Scenario: 사용자가 자신의 역할을 변경할 수 없음
- **WHEN** 클라이언트가 자신의 역할/범위를 바꾸려 시도하면
- **THEN** 역할/범위는 서버 통제 저장소(profiles)에서만 결정되므로 반영되지 않는다

#### Scenario: 운영자 권한은 역할과 별개로 부여됨
- **WHEN** 사용자가 로드되면
- **THEN** 역할/데이터 범위와 별개로 operator 값이 함께 도출되며, 미지정 시 `none`(조회 전용)이다

## ADDED Requirements

### Requirement: 관리자는 사용자의 운영자 권한을 원자적으로 함께 갱신한다
관리자 콘솔의 사용자 프로필 갱신 액션은 역할·허용 범위와 함께 운영자 권한(operator)을 단일
서버 액션에서 원자적으로 갱신해야 하며(SHALL), 부분 저장을 허용하지 않는다. role=`vendor` 인
대상에 대해서는 operator 를 `none` 외 값으로 저장할 수 없다(SHALL NOT) — 시도 시 액션이 거부된다.

#### Scenario: 관리자가 운영자 권한을 역할·범위와 함께 저장
- **WHEN** 관리자가 특정 사용자의 역할·허용 범위·operator 를 변경해 저장하면
- **THEN** 단일 액션으로 profiles 행이 한 번에 patch 되고 `updatedAt` 이 서버에서 갱신된다
- **AND** 부분 저장(일부 필드만 반영)은 발생하지 않는다

#### Scenario: vendor 에게는 운영자 권한을 부여할 수 없음
- **WHEN** 관리자가 role=vendor 인 사용자에게 operator=global 또는 assigned 를 저장하려 하면
- **THEN** 액션이 거부되고 operator 는 none 으로 유지된다

#### Scenario: 비관리자는 운영자 권한을 부여할 수 없음
- **WHEN** HQ·권역·국가·수행사 역할 사용자가 사용자 프로필 갱신 액션을 직접 호출하면
- **THEN** 액션이 권한 검증에서 즉시 실패하고 operator 를 포함한 어떤 필드도 변경되지 않는다
