"""projects.prompts.execute SQL(SQLAlchemy Core text). app 만(rd·ing·사실 표 없음).

대상 = draft ∪ (queued ∧ scope_prompt_id NULL): 후자는 Scope 발행이 끝나지 않은 복구 대상(현행 executePrompts 필터,
2026-08-18 고아 6건 교착 방지). 복구 대상 중 미완료 create outbox 가 이미 있으면 건너뛴다(중복 발행 방지).
"""
from __future__ import annotations

# 같은 프로젝트의 실행을 트랜잭션 단위로 직렬화(검증 D4). 행 FOR UPDATE 만으로는 READ COMMITTED 에서 잠금 대기 후
# 재평가된 행이 옛 스냅샷의 pending EXISTS(false)로 통과해 두 번째 호출이 recovered 로 잘못 보고했다.
# 잠금을 먼저 잡으면 TARGETS_SQL 스냅샷이 앞선 실행의 커밋 뒤에 찍혀 미완료 create 가 보인다.
EXECUTE_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('hgh.pj-prompts.execute:' || CAST(CAST(:pid AS uuid) AS text), 0))"

TARGETS_SQL = """
SELECT p.prompt_id, p.text, p.kind, p.brand_code, p.category, p.lang, p.regions, p.status, p.scope_prompt_id,
       EXISTS (SELECT 1 FROM app.scope_outbox o
                WHERE o.aggregate = 'prompt' AND o.aggregate_id = p.prompt_id AND o.op = 'create' AND o.done_at IS NULL) AS pending
  FROM app.prompt p
 WHERE p.project_id = :pid AND p.deleted_at IS NULL
   AND (p.status = 'draft' OR (p.status = 'queued' AND p.scope_prompt_id IS NULL))
 ORDER BY p.created_at, p.prompt_id
   FOR UPDATE OF p"""

MARK_QUEUED_SQL = """
UPDATE app.prompt p SET status = 'queued', updated_by = app.actor(), updated_at = now()
 WHERE p.project_id = :pid AND p.prompt_id = ANY(CAST(:ids AS uuid[])) AND p.status = 'draft'"""
