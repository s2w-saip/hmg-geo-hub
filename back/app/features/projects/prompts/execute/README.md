# projects.prompts.execute · 프로젝트 / 프로젝트 프롬프트 / 측정 실행

설계 단위: PJ-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| POST | `/v1/projects/{project_id}/prompts/execute` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/prompt`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- 게이트: 프로젝트 가시(member) + core.auth.require_operator('run'). 202.
- 대상 = draft ∪ (queued ∧ scope_prompt_id NULL); 후자 중 미완료 create outbox 가 있으면 skipped_pending. 대상 0 이면 409 nothing_to_execute.
- 같은 프로젝트의 실행은 트랜잭션 advisory 잠금으로 직렬화한다(동시 2회 = 한쪽 202, 다른 쪽 409 skipped_pending, 검증 D4).
- 요청 경로는 Scope HTTP 를 부르지 않는다: `publisher.py` 어댑터(기본 OutboxPublisher = enqueue_scope, 테스트는 dependency_overrides 로 가짜 주입).
- 응답 {queued, recovered, skipped_pending, propagation}. 접근 감사 scope_call. op·payload 계약은 `core.contracts`(prompt:create·disable·enable·delete = PromptOut, 이력 필드 자유)가 적재 시 검증한다. 워커 규약(outbox_id 순서, scope_prompt_id·scope_project_id 가 null 이면 app.prompt·app.project 에서 다시 읽기, 완료 표시는 `done_at IS NULL` 조건)은 적재 모듈이 맞춘다(메인 처분 2026-09-28, 요청 §6). payload 의 scope_project_id 는 게이트 결과 `ProjectAccess.scope_project_id`.
