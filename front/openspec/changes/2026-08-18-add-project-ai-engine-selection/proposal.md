## Why

프로젝트가 **어느 AI 엔진에서 답변을 수집하는지**를 고객이 정하거나 볼 수 있는 표면이 없었다.
scope 미러는 프로젝트 생성 경로에서 `putSchedule` 을 호출하지 않아(워크스페이스 감사
2026-08-13 §6-6) 새 프로젝트가 **24h 글로벌 폴백으로 매일·기본 엔진(chatgpt·gemini)** 으로만
돌고, 엔진을 바꾸려면 운영자가 scope `project_schedules.targets` 를 직접 고쳐야 했다. 답변
분석의 engine 필터는 정적(chatgpt/gemini)이라 기간 내 수집이 없는 엔진이 죽은 필터로 뜬다.

## What Changes

- **프로젝트 생성**: `AI 엔진` 체크박스(필수 ≥1, 기본 chatgpt·gemini) → `projects.ai_engines`
  저장 + `project_engine_history` 첫 행 + scope 미러 직후 `putSchedule(targets=선택)`.
- **Setting > General > AI 엔진**: 선택 수정·저장 + **엔진 변경 이력**(저장 시점 전체 집합,
  최신순). 저장은 `updateProjectEngines` 액션 → 로컬 저장·이력 append·scope targets 전파(best-effort,
  전파 실패는 `pushed=false` 로 알림). 0개 선택 = `enabled=false`(수집 중단).
- **답변 분석(mention/citation)**: engine 필터 옵션을 정적 목록 대신 **해당 기간에 실제로 수집한
  엔진**(`listMeasuredEngines`: DISTINCT scope_answers.target, 스냅샷 읽기와 동일 기간 술어)으로 주입.
- 카탈로그 `lib/scope/engines.ts`(chatgpt/gemini/deepseek — scope TargetCode 부분집합) + DeepSeek 표기 라벨.
- `lib/scope/server.ts` 에 `getSchedule/putSchedule` 게이트웨이(enforce + assertProjectInScope) 추가.

## Capabilities

### New Capabilities
- `project-ai-engine-selection`: 프로젝트 단위 AI 엔진 선택·이력·scope schedule targets 전파·기간 내 수집 엔진 기반 필터 옵션.

## Impact

- DB: `0042_project_ai_engines.sql` (projects.ai_engines nullable text[] · project_engine_history) — 적용 후 lockdown 재실행.
- scope: schedule 행이 없던 프로젝트에 첫 행이 생긴다(주간·enabled=선택≥1). 기존 행은 targets 만 바뀐다(enabled/interval 보존).
- 레거시(ai_engines NULL) 프로젝트는 UI 가 기본 2종으로 표시, 저장 전까지 아무것도 밀지 않는다.
