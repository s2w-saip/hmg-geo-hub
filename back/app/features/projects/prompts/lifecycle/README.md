# projects.prompts.lifecycle · 프로젝트 / 프로젝트 프롬프트 / 일시정지·재개·삭제 영향

설계 단위: PJ-3 · 상세 명세: `docs/design/api/units/<단위>.json`, 모듈 문서 `docs/design/api/모듈-*.md`

## 엔드포인트
| 메서드 | 경로 | 위험(10배) |
| --- | --- | --- |
| GET | `/v1/projects/{project_id}/prompts/{prompt_id}/lifecycle-impact` | medium |
| POST | `/v1/projects/{project_id}/prompts/{prompt_id}/pause` | low |
| POST | `/v1/projects/{project_id}/prompts/{prompt_id}/resume` | low |
| POST | `/v1/projects/{project_id}/prompts/{prompt_id}/hard-delete` | low |

## 이 기능을 쓰는 화면(프론트 그대로 유지, 데이터 함수만 이 API 로 교체)
- `/projects/[id]/prompt`

## 파일
- `router.py` 엔드포인트(APIRouter) · `schemas.py` 요청·응답(Pydantic) · `service.py` 업무 규칙 · `queries.py` 읽기 스키마 SQL(rd·app·ext) · `tests/`

## 구현 메모
- impact(Owner, api_ro): rd.dim_prompt 를 이 프로젝트 차원 키로 한정, 프로젝트 전 회차(rd.cycle)로 core.cycles.build_window → Window.where 3술어.
  rd.answer·rd.answer_brand·rd.citation 을 한 문장으로 센다(로컬 EXPLAIN: 표면 3 월 leaf 만 스캔, answer_prompt_idx 사용).
- pause(Owner): {queued, running, done, failed} 만, 공유 > 0 이면 409 shared_prompt. outbox(disable) + paused.
- resume(require_operator run): paused 만. outbox(enable) + done, 단 Scope 미발행 행은 queued(실행 복구 대상).
- 토글(disable·enable)은 `core.write.enqueue_scope(..., supersede=("disable", "enable"))` 로 적재한다: 같은 프롬프트의 미완료 토글을 superseded(done_at·last_error)로 닫고 새 행을 넣는다. 미완료 토글은 항상 최신 1행(검증 D1, 6라운드 core 반영 §7).
- hard-delete(Owner): 공유 0 ∧ 발행 이력이면 outbox(delete, was_paused), deleted_at soft delete. Scope 반영 3종은 접근 감사 scope_call.
- publisher 는 execute/publisher.py 의 주입 어댑터(기본 = core.write.enqueue_scope). 실패하면 트랜잭션 전체 롤백.
