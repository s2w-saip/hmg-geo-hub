# Tasks — add-project-ai-engine-selection

## 1. 데이터·카탈로그
- [x] 1.1 `lib/scope/engines.ts` — AI_ENGINES 카탈로그·normalize/effective/same (+ 테스트)
- [x] 1.2 `lib/db/migrations/0042_project_ai_engines.sql` + `schema.ts` (projects.aiEngines, projectEngineHistory)
- [x] 1.3 `lib/db/repositories/projects.ts` — insert(aiEngines+첫 이력)·setAiEngines·listEngineHistory·delete cascade

## 2. scope 전파
- [x] 2.1 `lib/scope/server.ts` — getSchedule/putSchedule 게이트웨이
- [x] 2.2 `lib/scope/project-sync.ts` — syncScopeSchedule(행 유무별 enabled/interval 규칙)

## 3. UI·액션
- [x] 3.1 `components/dash/ai-engine-checkboxes.tsx` (공용)
- [x] 3.2 `projects/new` — 폼 필수 선택 + 액션 검증·저장·스케줄
- [x] 3.3 `projects/[id]/setting` — AiEnginesPanel(수정·이력) + updateProjectEngines (+ 테스트)
- [x] 3.4 i18n ko/en

## 4. 답변 분석
- [x] 4.1 `listMeasuredEngines` + `fetchProjectMeasuredEngines` + engineOptions(panel/views/pages)
- [x] 4.2 DeepSeek 라벨(TARGET_LABEL/ENGINE_LABEL/ScopeTarget)

## 4b. 검증 지적 반영 (2026-08-18)
- [x] 4b.1 syncScopeSchedule: GET 실패 시 PUT 금지(파괴적 덮어쓰기 차단) · 0→N 재선택 `reenable` 로 enabled 복구
- [x] 4b.2 attachScopeMirror — 지연 미러 경로 4곳(생성·설정 저장·소유URL·RUN 프롬프트 푸시) 통일, 명시 엔진이면 스케줄 전파
- [x] 4b.3 listMeasuredEngines 에 `r.status IN ('completed','partial_failed')` — 스냅샷 술어와 동치
- [x] 4b.4 insert: 이력 행을 Owner 멤버십 뒤로 · project-sync.schedule.test.ts 9케이스
- [x] 4b.5 엔진 변경에 `canOperateProject` 게이트 추가(제품 결정 08-18) · [ ] 레거시 NULL 표시가 운영자 옵트인 targets 와 다를 수 있음(설정 화면이 scope 실 targets 를 읽을지)

## 5. 배포
- [ ] 5.1 `npm run db:apply -- 0042` + lockdown 재실행 (운영 DB, 사용자 실행)
- [ ] 5.2 라이브에서 생성→scope schedule 행 확인·설정 저장→targets 반영 확인
