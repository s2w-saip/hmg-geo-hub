## MODIFIED Requirements

### Requirement: scope는 서버단 강제 레이어를 통해서만 접근 가능
scope API 접근은 오직 서버단 코드에서 단일 강제 레이어(lib/scope/server)를 통해서만 일어나야 한다(SHALL).
이 레이어는 세션 인증·역할 필터 도출·감사를 강제하며, route handler(app/api/**)와 서버 컴포넌트가
함께 사용한다. 클라이언트 컴포넌트는 scope API를 직접 호출하지 않으며, workspace key는 절대 브라우저에
도달하지 않는다. 강제 레이어가 남기는 감사는 콘솔 placeholder가 아니라 영속 append-only 저장소
(`bff_audit_logs`, kind=`scope_call`)에 기록되어야 하며(SHALL), 이 기록은 fire-and-forget이라 감사
쓰기 실패가 scope 호출 자체를 실패시키지 않아야 한다(SHALL NOT).

#### Scenario: 클라이언트단 scope 접근 없음
- **WHEN** 클라이언트 컴포넌트에서 scope API를 호출하려는 코드가 있으면
- **THEN** 이는 결함(PR 차단)으로 취급된다 — scope는 서버단 강제 레이어를 통해서만 접근 가능하다

#### Scenario: 모든 scope 접근이 강제 레이어를 경유함
- **WHEN** route handler 또는 서버 컴포넌트가 scope 데이터를 필요로 하면
- **THEN** 강제 레이어를 호출하며, 강제 레이어는 세션을 요구하고 역할 기반 필터를 주입하고 감사를 남긴다

#### Scenario: scope 호출 감사가 영속 sink에 기록됨
- **WHEN** 강제 레이어(enforce)가 scope 호출을 감사하면
- **THEN** `bff_audit_logs`에 kind=`scope_call` 행이 (actor_id, role 스냅샷, action, ScopeFilter
  스냅샷=detail)으로 append 되며, 이 쓰기는 fire-and-forget이라 실패해도 scope 호출은 정상 진행된다
