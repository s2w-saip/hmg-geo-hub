# scope-gateway Specification

## Purpose
scope 의 확정된 공개 `/api/v1` 표면을 충실히 미러링하는 단일 역할-무지(role-blind) `ScopeClient` 계약을 정의하고, 서버단 강제 레이어를 통해서만 도달 가능하게 하는 capability.
## Requirements
### Requirement: ScopeClient 계약
시스템은 모든 scope 데이터 접근을 나타내는 단일 `ScopeClient` 인터페이스를 정의해야 한다(SHALL).
이 인터페이스는 scope 의 **확정된 공개 API 표면**(`/api/v1/*`)을 충실히 미러링하며, 다음만
포함한다(SHALL): 설정 표면 — projects/prompts CRUD; 결과 읽기 표면 — overview, brand-scores,
brand-mentions(+단건), citations(+by-domain), reports(+단건); 워크스페이스 — usage, health.

`ScopeClient` 는 **역할-무지(role-blind) 전송 계약**이어야 한다(SHALL): 메서드는 `ScopeFilter`
(brands/regions/countries) 인자를 받지 않으며, 역할→접근 게이팅은 전송 계약이 아니라 강제
레이어의 책임이다. 측정 트리거(`query`)와 내부 결과 엔드포인트(`results`/`measurements`)는
scope 내부 전용이므로 계약에 포함하지 않아야 한다(SHALL NOT).

#### Scenario: 화면은 계약에만 의존함
- **WHEN** 호출자(서버 컴포넌트·route handler)가 scope 데이터를 필요로 하면
- **THEN** `ScopeClient` 인터페이스를 사용하며 mock/http 출처를 알지 못한다

#### Scenario: 계약은 공개 표면만 노출함
- **WHEN** `ScopeClient` 메서드 집합을 검사하면
- **THEN** 모든 메서드는 scope 공개 엔드포인트(`/api/v1/projects/*`, `/api/v1/usage`,
  `/api/v1/health`)에 대응하며, 측정 트리거·내부 결과 엔드포인트에 대응하는 메서드는 없다

#### Scenario: 전송 계약은 역할을 알지 못함
- **WHEN** 어떤 `ScopeClient` 메서드든 호출하면
- **THEN** 시그니처에 `ScopeFilter`/역할 인자가 없으며, projectId 와 엔드포인트별 쿼리만 받는다

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

### Requirement: HttpScopeClient 는 확정된 공개 표면에 대해 호출 가능해야 한다
`HttpScopeClient` 는 base URL 에 `/api/v1` prefix 를 부착하고(SHALL), 모든 요청에
`Authorization: Bearer <SCOPE_API_KEY>` 를 붙여야 한다(SHALL). 워크스페이스 키는 서버단
(`lib/scope/http.ts`)에서만 읽혀야 하며 브라우저에 도달해서는 안 된다(SHALL NOT).

#### Scenario: 공개 prefix 사용
- **WHEN** `HttpScopeClient` 가 임의의 메서드로 요청을 만들면
- **THEN** 경로는 `<SCOPE_API_BASE>/api/v1/...` 형태이며 `/v1/...` 를 사용하지 않는다

#### Scenario: 내부 엔드포인트 미호출
- **WHEN** `HttpScopeClient` 의 어떤 메서드든 실행되면
- **THEN** `POST /api/v1/query`, `/api/v1/measurements`, `/api/v1/results` 중 어느 것도
  호출하지 않는다

### Requirement: live 공개 표면 검증 환경
시스템은 공개 표면을 실제 호출해 status·응답 shape 를 확인하는 검증 스크립트를 제공해야 한다(SHALL). 이 스크립트는 세션/역할 강제 레이어를 거치지 않고 `HttpScopeClient` 를 직접 사용하며, 워크스페이스 키로 서버→서버 호출한다(MUST).

#### Scenario: 공개 표면 동작 확인
- **WHEN** 유효한 키와 함께 검증 스크립트를 실행하면
- **THEN** projects/prompts CRUD 는 2xx 를, 결과 읽기 엔드포인트는 200(데이터 미시드 시
  빈 배열 포함)을 반환함을 확인한다

#### Scenario: 알려진 미배포 엔드포인트 처리
- **WHEN** 검증 스크립트가 reports 엔드포인트를 호출해 404 를 받으면
- **THEN** 이를 known-failure 로 분류하고 전체 검증 실패로 취급하지 않는다(scope 재배포 대기)

