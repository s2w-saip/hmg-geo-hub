## ADDED Requirements

### Requirement: profiles repository가 목록 조회와 부분 업데이트를 지원
`profiles` repository는 인증 사용자 목록 조회와 부분 업데이트(역할, 허용 범위, 이메일 메타)를 지원해야 한다(SHALL).
모든 호출은 서버 측에서만 수행되며, 업데이트는 지정된 필드에 한정되고 `updatedAt`은 서버에서 강제로 갱신된다.

#### Scenario: 관리자 콘솔이 사용자 목록을 조회
- **WHEN** 관리자 콘솔이 profiles 목록을 요청하면
- **THEN** repository가 전체 profiles 행을 서버에서 반환한다

#### Scenario: 역할 업데이트는 부분 업데이트로 수행
- **WHEN** 관리자가 특정 사용자의 역할만 변경하면
- **THEN** repository는 해당 행의 role 컬럼만 갱신하고 다른 컬럼은 유지하며 `updatedAt`을 서버에서 갱신한다

#### Scenario: 범위 업데이트는 배열 컬럼만 갱신
- **WHEN** 관리자가 특정 사용자의 brands / regions / countries 배열을 변경하면
- **THEN** repository는 지정된 배열 컬럼만 갱신하고 role은 유지하며 `updatedAt`을 서버에서 갱신한다

### Requirement: profiles의 변경은 관리자 액션을 통해서만
`profiles` 테이블의 쓰기(insert/update/delete)는 관리자 액션 또는 시드 스크립트만 수행해야 한다(SHALL).
사용자 자신이나 비관리자 코드 경로는 `profiles` 행을 직접 변경할 수 없으며, 브라우저는 어떠한 경우에도 `profiles`에 직접 접근하지 않는다.

#### Scenario: 비관리자 코드 경로에서 profiles 쓰기가 발견되지 않음
- **WHEN** repository 외부에서 profiles에 쓰는 코드를 찾으면
- **THEN** 그러한 호출은 존재하지 않거나, repository 경계 규칙에 의해 PR 단계에서 차단된다

#### Scenario: 브라우저에서 profiles 직접 접근이 차단됨
- **WHEN** anon 키로 PostgREST `profiles` 엔드포인트에 직접 요청하면
- **THEN** lockdown SQL에 의해 권한 거부(401)된다(기존 데이터 보안 모델과 동일)
