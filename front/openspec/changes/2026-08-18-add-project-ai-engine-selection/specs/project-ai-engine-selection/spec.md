# project-ai-engine-selection

## ADDED Requirements

### Requirement: 프로젝트는 답변을 수집할 AI 엔진을 명시적으로 갖는다

프로젝트 생성 폼은 AI 엔진(카탈로그 `lib/scope/engines.ts`)을 1개 이상 선택하지 않으면 제출을
거부해야 한다(SHALL). 저장값은 `projects.ai_engines`(카탈로그 순서로 정규화된 토큰 배열)이며,
NULL 은 "지정한 적 없음"(scope 기본 chatgpt·gemini 로 측정 중)으로 해석되고 `[]` 는 "전부 해제"다.

#### Scenario: 엔진 미선택 제출 거부
- **WHEN** 사용자가 AI 엔진을 모두 해제하고 프로젝트 생성을 제출하면
- **THEN** 액션은 `{ok:false}` 를 반환하고 프로젝트 행이 생성되지 않는다

#### Scenario: 미지·중복 토큰 정규화
- **WHEN** 액션이 `["gemini","chatgpt","gemini","bogus"]` 를 받으면
- **THEN** `["chatgpt","gemini"]` 로 저장된다

### Requirement: 엔진 선택 변경은 이력으로 남고 scope schedule targets 로 전파된다

`updateProjectEngines` 는 Owner/admin 만 호출할 수 있고(SHALL), 선택이 바뀌었거나 레거시(NULL)
첫 저장이면 `project_engine_history` 에 저장 시점의 전체 집합을 1행 append 해야 한다(SHALL).
동일 명시값 재저장은 이력을 늘리지 않는다. 저장 후 scope `PUT /projects/{id}/schedule` 로
`targets=선택` 을 전파하되, 기존 행이 있으면 `enabled/interval_days/regions/prompt_ids` 는 보존하고
없으면 `enabled=true·interval_days=7` 로 만든다. 선택이 0개면 `enabled=false`. 전파 실패는 액션
실패가 아니라 `pushed=false` 로 알린다.

#### Scenario: 변경 저장
- **WHEN** ai_engines=["chatgpt","gemini"] 인 프로젝트에서 ["gemini"] 를 저장하면
- **THEN** projects.ai_engines=["gemini"], 이력 1행 추가, scope targets=["gemini"] PUT

#### Scenario: 전부 해제
- **WHEN** [] 를 저장하면
- **THEN** 이력에 [] 행이 남고 scope schedule 이 enabled=false 로 PUT 된다

#### Scenario: 미러 없음
- **WHEN** scope_project_id 가 없는 프로젝트에서 저장하면
- **THEN** 미러 생성을 먼저 시도하고, 생성되면 그 id 로 스케줄을 밀고, 안 되면 로컬만 저장된다

### Requirement: 답변 분석의 engine 필터는 기간 내 실제 수집 엔진만 제공한다

`/projects/[id]/analysis/{mention,citation}` 의 engine 축 옵션은 정적 목록이 아니라
`listMeasuredEngines(scopeProjectId, filters)` — 선택 기간(run started_at 상·하한, 스냅샷 읽기와
동일 술어) 안에 completed 답변이 있는 DISTINCT `scope_answers.target` — 이어야 한다(SHALL).

#### Scenario: 엔진 해제 후 기간 필터
- **WHEN** 07-30 에 Gemini 를 해제한 프로젝트에서 기간 08-01..08-18 을 선택하면
- **THEN** engine 옵션에 gemini 가 없고 데이터에도 gemini 답변이 없다
