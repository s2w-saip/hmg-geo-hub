## ADDED Requirements

### Requirement: RLS 비의존 — 앱 레이어 인가
데이터 인가는 데이터베이스(RLS)가 아니라 애플리케이션 레이어에서 강제되어야 한다(SHALL). RLS에
의존하지 않으며, 따라서 RLS 부재가 곧 데이터 노출이 되지 않도록 아래 통제로 보완한다.

#### Scenario: RLS 없이도 범위가 강제됨
- **WHEN** scoped 데이터에 접근하면
- **THEN** DB 정책이 아니라 앱 레이어가 사용자 허용 범위로 결과를 제한한다

### Requirement: 브라우저 직접 데이터 접근 차단
브라우저는 데이터베이스에 직접 접근하지 못하도록 차단되어야 한다(MUST). DB 연결 문자열과 service
키는 브라우저에 노출하지 않으며, 인증용 anon 키는 노출되더라도 RLS를 끈 테이블이 PostgREST/anon으로
데이터 접근되지 않도록 테이블 권한을 차단한다(anon 키는 Supabase Auth 용도로만 기능).

#### Scenario: 클라이언트에 데이터 자격이 없음
- **WHEN** 클라이언트 번들을 검사하면
- **THEN** DB 연결 문자열과 service 키가 포함되어 있지 않다(인증용 anon 키 외 데이터 접근 수단 없음)

#### Scenario: 자동 API로 데이터가 노출되지 않음
- **WHEN** anon 키로 PostgREST를 통해 테이블 데이터 접근을 시도하면
- **THEN** 테이블 권한이 차단돼 있어 접근이 거부된다

### Requirement: repository choke point와 AuthContext 강제
scoped 데이터 접근은 단일 repository 레이어를 통해서만 일어나야 하며(SHALL), 모든 scoped 작업은
세션에서 도출한 AuthContext(사용자·역할·허용 범위)를 인자로 요구한다. 범위 필터는 역할에서 서버가
주입하고 클라이언트가 보낸 범위 값은 신뢰하지 않는다.

#### Scenario: 컨텍스트 없는 접근은 거부됨(default-deny)
- **WHEN** AuthContext 없이 scoped 데이터 작업이 호출되면
- **THEN** 작업이 거부된다(우회 가능한 unscoped 메서드는 제공되지 않는다)

#### Scenario: 클라이언트가 보낸 범위는 무시됨
- **WHEN** 클라이언트가 허용 범위 밖의 범위 파라미터를 보내면
- **THEN** 서버는 그 값을 버리고 역할에서 도출한 범위를 적용한다

#### Scenario: repository 밖 DB 접근 금지
- **WHEN** repository 레이어 밖의 코드가 DB 클라이언트를 직접 import하면
- **THEN** 이는 결함(PR 차단)으로 취급된다

### Requirement: 보상 통제
RLS 안전망 상실을 보완하기 위한 통제가 갖춰져야 한다(SHALL): 최소권한 DB 접속 계정, 역할별 범위
격리 자동 테스트, repository 접근 경계 강제(lint), 데이터 접근 감사 로그.

#### Scenario: 역할별 범위 격리 테스트
- **WHEN** 테스트가 한 역할로 scoped 데이터를 조회하면
- **THEN** 허용 범위 밖의 행은 결과에 포함되지 않음이 검증된다

#### Scenario: 최소권한 접속
- **WHEN** 앱이 DB에 접속하면
- **THEN** 필요한 테이블/동작에만 권한이 있는 계정으로 접속한다
