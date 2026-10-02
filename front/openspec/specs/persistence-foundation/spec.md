# persistence-foundation Specification

## Purpose
TBD - created by archiving change add-supabase-persistence-auth. Update Purpose after archive.
## Requirements
### Requirement: 서버 전용 Postgres 직결
hmg-geo는 Supabase의 Postgres에 표준 연결 문자열로 서버에서만 직결해야 한다(SHALL). 데이터 쿼리에
supabase-js나 PostgREST anon API를 사용하지 않으며, 연결 문자열은 서버 전용 비밀로 둔다.

#### Scenario: 데이터 접근은 서버에서만
- **WHEN** 코드가 hmg-geo 데이터를 읽거나 쓰면
- **THEN** Next 서버 측에서 Postgres 직결로 수행되며 브라우저에 연결 정보가 노출되지 않는다

#### Scenario: supabase-js 데이터 쿼리 미사용
- **WHEN** 데이터 쿼리를 작성하면
- **THEN** Drizzle를 통한 표준 Postgres 접근이 사용되고 supabase-js 데이터 API에 묶이지 않는다

### Requirement: 코드로 관리되는 스키마와 마이그레이션
데이터베이스 스키마는 Drizzle 코드로 정의되고 마이그레이션으로 적용되어야 한다(SHALL). 대시보드
수동 변경을 진실원천으로 삼지 않으며, 스키마 코드는 임의의 Postgres에 적용 가능해야 한다.

#### Scenario: 스키마가 코드에 존재함
- **WHEN** 테이블을 추가하거나 변경하면
- **THEN** 변경이 Drizzle 스키마 코드 + 마이그레이션으로 표현되어 버전 관리된다

#### Scenario: 다른 Postgres에 이식 가능
- **WHEN** 대상 Postgres가 바뀌면(예: 설치형 HMG 서버)
- **THEN** 동일 마이그레이션을 적용해 스키마를 재현할 수 있다

### Requirement: repository 인터페이스 뒤의 DB 접근
모든 데이터 접근은 repository 인터페이스 뒤에 위치해야 한다(SHALL). 화면·서비스 코드는 구체적인
DB 구현(Drizzle/Postgres)을 직접 알지 않으며, 추후 설치형 이전 시 구현 교체로 대응한다.

#### Scenario: 구현 교체가 한 겹에 한정됨
- **WHEN** DB 엔진/호스트가 교체되면
- **THEN** repository 구현만 바뀌고 호출 측 화면·로직은 변경되지 않는다

### Requirement: profiles로 유저-역할-범위 매핑
시스템은 `profiles` 테이블로 인증 사용자를 역할·허용범위에 매핑해야 한다(SHALL). 매핑은 Supabase
auth.users의 id를 참조하며, 역할(HQ/권역/국가/관리자)과 허용 범위(브랜드/권역/국가)를 담는다.

#### Scenario: 인증 사용자에 역할·범위가 연결됨
- **WHEN** 인증된 사용자가 로드되면
- **THEN** profiles에서 그 사용자의 역할과 허용 범위가 조회된다

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

