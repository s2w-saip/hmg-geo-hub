## MODIFIED Requirements

### Requirement: 보상 통제
RLS 안전망 상실을 보완하기 위한 통제가 갖춰져야 한다(SHALL): 최소권한 DB 접속 계정, 역할별 범위
격리 자동 테스트, repository 접근 경계 강제(lint), **영속(append-only) 데이터 접근 감사 로그**.
감사 로그는 더 이상 콘솔 placeholder가 아니라 `bff_audit_logs` 테이블에 영속되어야 한다(SHALL).
신규 감사 테이블도 lockdown(anon/authenticated 권한 revoke) 대상에 포함되어야 한다(SHALL).

#### Scenario: 역할별 범위 격리 테스트
- **WHEN** 테스트가 한 역할로 scoped 데이터를 조회하면
- **THEN** 허용 범위 밖의 행은 결과에 포함되지 않음이 검증된다

#### Scenario: 최소권한 접속
- **WHEN** 앱이 DB에 접속하면
- **THEN** 필요한 테이블/동작에만 권한이 있는 계정으로 접속한다

#### Scenario: 데이터 접근이 영속 감사 로그에 남음
- **WHEN** 감사 대상 데이터 접근(예: admin 사용자 거버넌스, 엔티티 명부 변경)이 일어나면
- **THEN** `bff_audit_logs`에 (actor_id, 호출 시점 role 스냅샷, action, target 테이블) 행이 append 된다

#### Scenario: 신규 감사 테이블도 anon 접근이 차단됨
- **WHEN** lockdown 적용 후 anon 역할로 `bff_audit_logs` 접근을 시도하면
- **THEN** SELECT/INSERT/UPDATE/DELETE 어느 것도 허용되지 않는다(has_table_privilege = false)

## ADDED Requirements

### Requirement: 감사 sink는 fire-and-forget이며 요청을 실패시키지 않는다
감사 기록은 사용자 요청 경로를 지연시키거나 실패시키지 않아야 한다(SHALL NOT). 감사 함수
(`auditScopeCall`·`auditDataAccess`)는 동기 `void` 시그니처를 유지하고(SHALL), 쓰기는 응답 이후
(`after()`)로 dispatch 하되 request context 밖에서는 즉시 비동기 쓰기로 폴백해야 한다(SHALL).
어떤 컨텍스트에서도 호출자에게 예외를 전파하지 않아야 한다(SHALL NOT). sink 쓰기가 실패하면
원본 payload를 `console.error`로 폴백해 무음 유실을 막아야 한다(SHALL). `bff_audit_logs`에 대한
insert 자체는 감사 대상이 아니어야 한다(SHALL NOT — 재귀 금지). retention v1은 무기한이며
repository는 insert 계열만 노출한다(조회 UI 없음).

#### Scenario: sink 실패가 호출자를 막지 않음
- **WHEN** 감사 대상 액션 실행 중 `bff_audit_logs` insert가 실패하면
- **THEN** 호출자는 예외를 받지 않고 원본 payload가 `console.error`로 1회 폴백된다

#### Scenario: request context 밖에서도 throw 없음
- **WHEN** request context 밖(백그라운드 등 `after()` 미지원)에서 감사 함수가 호출되면
- **THEN** 즉시 비동기 쓰기로 폴백하며 호출자에게 예외가 전파되지 않는다

#### Scenario: 감사 sink는 재귀하지 않음
- **WHEN** `auditDataAccess` 또는 `auditScopeCall`이 `bff_audit_logs`에 기록하면
- **THEN** 그 insert는 다시 감사 대상이 되지 않는다(감사의 감사 없음)
