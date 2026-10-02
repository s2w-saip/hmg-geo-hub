## ADDED Requirements

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
