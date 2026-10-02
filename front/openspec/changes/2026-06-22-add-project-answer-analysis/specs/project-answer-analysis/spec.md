## ADDED Requirements

### Requirement: 개별 프로젝트 답변 분석은 enforce 경유 per-project seam 으로 제공된다
시스템은 개별 프로젝트의 mention/citation detail 을 server-only 강제 레이어(`lib/scope/server`)의
per-project read 함수로 제공해야 한다(SHALL). 각 호출은 세션 인증·per-user 감사(enforce)와
`assertProjectInScope` 를 거친 뒤 role-blind ScopeClient 를 통해 데이터를 가져와야 하며(SHALL),
표준(root) 답변 분석과 동일한 집계·컴포넌트를 재사용한다.

#### Scenario: 페이지가 seam 을 통해서만 데이터를 얻는다
- **WHEN** `/projects/[id]/analysis/mention` 또는 `/citation` 이 렌더되면
- **THEN** 데이터는 `fetchProjectMentions`/`fetchProjectCitations`(enforce 경유)로부터 오고
  클라이언트가 scope 를 직접 호출하지 않는다

#### Scenario: 미매핑 프로젝트는 EmptyState
- **WHEN** live 모드에서 아직 scope 에 미러되지 않은(scopeProjectId 없는) 프로젝트를 열면
- **THEN** read 가 null 을 반환하고 페이지는 임의 데이터 없이 EmptyState 를 렌더한다

### Requirement: 개발(mock) 모드는 scope seam 의 합성 데이터로 화면을 채운다
시스템은 측정 RUN 을 트리거할 수 없는 개발 환경에서, 페이지·컴포넌트에 가짜 데이터를 박지
않고(SHALL NOT page-level fixture) **scope client 계층(MockScopeClient)** 이 결정론적 합성 측정을
반환해 per-project 답변 분석이 채워지도록 해야 한다(SHALL). live 전환은 동일 코드가 프로젝트의
실제 run 을 읽으며 페이지 변경이 없어야 한다(SHALL).

#### Scenario: mock 모드에서 멘션·인용·트리가 채워진다
- **WHEN** SCOPE_MODE 가 mock(기본)일 때 임의 프로젝트의 분석 페이지를 열면
- **THEN** 합성 멘션 표·인용 도메인·Category→Subcategory 트리가 표시된다

#### Scenario: 합성은 seam 안에만 존재한다
- **WHEN** 코드에서 합성 측정의 출처를 찾으면
- **THEN** 그것은 `MockScopeClient`(scope 계층) 안에만 있고 페이지/컴포넌트에는 NODE_ENV 분기나
  fixture 가 없다

### Requirement: 개별 프로젝트 데이터는 scope 공개 표면에서만 읽는다
시스템은 개별 프로젝트의 mention/citation 을 scope 의 **공개·프로젝트 스코프 엔드포인트**
(`/projects/{id}/brand-mentions`, `/projects/{id}/citations`)에서 읽어야 하며(SHALL), 내부 전용
엔드포인트(`/results`, `/measurements`, `/query`)를 호출해서는 안 된다(SHALL NOT) — 후자는 HMG
공개 표면이 아니며 prod 에서 실패한다(docs/scope-integration-handoff.md). 공개 행이 담은
prompt/query-run 식별자로 동일한 뷰 shape 를 구성한다.

#### Scenario: 내부 측정 엔드포인트를 호출하지 않는다
- **WHEN** 개별 프로젝트 mention/citation 을 읽으면
- **THEN** `/projects/{id}/brand-mentions`·`/projects/{id}/citations` 만 호출하고
  `/results`·`/measurements`·`/query` 는 호출하지 않는다

#### Scenario: scope read 실패는 페이지를 500 내지 않는다
- **WHEN** live 모드에서 scope 공개 read 가 오류(미배포·5xx·예상외 shape)를 던지면
- **THEN** seam 이 이를 잡아 null 을 반환하고 페이지는 EmptyState 로 degrade 한다(500 금지)
