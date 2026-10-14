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

# 발행 요청 일괄 적재(OutboxPublisher 기본 경로 = core.write.enqueue_scope(prompt, create) 의 행별 동작을 묶은 것, B025).
# 1) 미완료 create 가 이미 있는 대상(TARGETS_SQL.pending): 그 중 가장 최근 행 payload 를 최신으로(enqueue_scope 의 병합과 같다).
#    잠금 대기 중 워커가 끝낸 행(done_at)은 갱신하지 않고 아래 INSERT 로 넘긴다(enqueue_scope 의 FOR UPDATE 재평가와 같은 결과).
# 2) 나머지는 대상 순서(ord)대로 새 행(outbox_id 가 행별 적재와 같은 순서로 붙는다).
OUTBOX_MERGE_CREATE_SQL = """
UPDATE app.scope_outbox o SET payload = CAST(x.pl AS jsonb), next_attempt_at = now()
  FROM (SELECT t.id, t.pl,
               (SELECT o2.outbox_id FROM app.scope_outbox o2
                 WHERE o2.aggregate = 'prompt' AND o2.aggregate_id = t.id AND o2.op = 'create' AND o2.done_at IS NULL
                 ORDER BY o2.outbox_id DESC LIMIT 1) AS oid
          FROM unnest(CAST(:ids AS uuid[]), CAST(:pls AS text[])) AS t(id, pl)) x
 WHERE o.outbox_id = x.oid AND o.done_at IS NULL
RETURNING o.aggregate_id"""

OUTBOX_INSERT_CREATE_SQL = """
INSERT INTO app.scope_outbox (aggregate, aggregate_id, op, payload)
SELECT 'prompt', t.id, 'create', CAST(t.pl AS jsonb)
  FROM unnest(CAST(:ids AS uuid[]), CAST(:pls AS text[])) WITH ORDINALITY AS t(id, pl, ord)
 ORDER BY t.ord"""
