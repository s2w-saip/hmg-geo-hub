## ADDED Requirements

### Requirement: ScopeClient 계약
시스템은 모든 scope 데이터 접근을 나타내는 단일 `ScopeClient` 인터페이스를 정의해야 한다(SHALL).
(최소한 알려진 `query`/`results` 동작과, v1 화면이 요구하는 집계 데이터용 자리표시자 메서드를
포함하며, 이는 scope 팀과 합의할 계약 초안 역할을 한다.)

#### Scenario: 화면은 계약에만 의존함
- **WHEN** 화면이 scope 데이터를 필요로 하면
- **THEN** 화면은 `ScopeClient` 인터페이스를 사용하며 mock/http 출처를 알지 못한다

### Requirement: Mock-first, env 기반 구현 선택
시스템은 `ScopeClient`의 mock 구현과 http 구현을 모두 제공해야 하며(SHALL), `SCOPE_MODE`
env 변수(mock | live)로 선택하고 기본값은 mock으로 두어 scope API key 없이도 앱이 완전히
동작하게 한다. live 전환은 코드 변경 없이 env 변경만으로 가능해야 한다.

#### Scenario: API key 없이 동작함
- **WHEN** 앱이 SCOPE_MODE=mock(또는 미설정)으로 시작되면
- **THEN** 모든 scope 기반 화면이 mock 데이터로 렌더되고 key가 필요하지 않다

#### Scenario: env만으로 live 전환
- **WHEN** 유효한 key와 함께 SCOPE_MODE=live가 설정되면
- **THEN** 화면/계약 코드 변경 없이 http 구현이 사용된다

### Requirement: scope는 서버단 강제 레이어를 통해서만 접근 가능
scope API 접근은 오직 서버단 코드에서 단일 강제 레이어(lib/scope/server)를 통해서만 일어나야 한다(SHALL).
이 레이어는 세션 인증·역할 필터 도출·감사를 강제하며, route handler(app/api/**)와 서버 컴포넌트가
함께 사용한다. 클라이언트 컴포넌트는 scope API를 직접 호출하지 않으며, workspace key는 절대 브라우저에
도달하지 않는다.

#### Scenario: 클라이언트단 scope 접근 없음
- **WHEN** 클라이언트 컴포넌트에서 scope API를 호출하려는 코드가 있으면
- **THEN** 이는 결함(PR 차단)으로 취급된다 — scope는 서버단 강제 레이어를 통해서만 접근 가능하다

#### Scenario: 모든 scope 접근이 강제 레이어를 경유함
- **WHEN** route handler 또는 서버 컴포넌트가 scope 데이터를 필요로 하면
- **THEN** 강제 레이어를 호출하며, 강제 레이어는 세션을 요구하고 역할 기반 필터를 주입하고 감사를 남긴다
