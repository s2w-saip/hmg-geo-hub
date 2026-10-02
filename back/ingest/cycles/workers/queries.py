"""ingest.cycles.workers SQL(loader 쓰기 경로: 큐 상태 전이·아웃박스 상태·파티션 선생성·DataForSEO 적재)."""

# ── judgment_change 큐(FOR UPDATE SKIP LOCKED, change_id 순) ──
CLAIM = """
SELECT change_id, kind, subject_uuids, subject_texts, payload, requested_by, status
  FROM app.judgment_change
 WHERE status = 'pending' AND kind = ANY($1::text[]) AND NOT (change_id = ANY($2::bigint[]))
 ORDER BY change_id
 FOR UPDATE SKIP LOCKED LIMIT 1
"""
CLAIM_ONE = """
SELECT change_id, kind, subject_uuids, subject_texts, payload, requested_by, status
  FROM app.judgment_change WHERE change_id = $1 AND status IN ('pending', 'running') FOR UPDATE SKIP LOCKED
"""
# entity_version 선행 준비(재스캔)용 엿보기: CLAIM 과 같은 순서, 잠그지 않는다(경합으로 다른 행을 집어도 재스캔은 멱등이라 해가 없다)
PEEK = """
SELECT change_id, kind, payload FROM app.judgment_change
 WHERE status = 'pending' AND kind = ANY($1::text[]) AND NOT (change_id = ANY($2::bigint[])) ORDER BY change_id LIMIT 1
"""
PEEK_ONE = "SELECT change_id, kind, payload FROM app.judgment_change WHERE change_id = $1 AND status IN ('pending', 'running')"
# entity_version 청크 진행: 행은 pending 그대로(다음 처리가 같은 행을 다시 집는다), 마지막 청크 load 만 남긴다
PROGRESS = "UPDATE app.judgment_change SET claimed_at = coalesce(claimed_at, now()), applied_load_id = $2, error = NULL WHERE change_id = $1"
APPLIED = """
UPDATE app.judgment_change SET status = 'applied', claimed_at = coalesce(claimed_at, now()), applied_at = now(), applied_load_id = $2, error = NULL
 WHERE change_id = $1
"""
FAILED = "UPDATE app.judgment_change SET status = 'failed', claimed_at = coalesce(claimed_at, now()), error = $2 WHERE change_id = $1"
ESCALATED = """
UPDATE app.judgment_change SET status = 'escalated_rebuild', claimed_at = coalesce(claimed_at, now()), error = $2 WHERE change_id = $1
"""
RUNNING = "UPDATE app.judgment_change SET status = 'running', claimed_at = now() WHERE change_id = $1"
PENDING_COUNT = "SELECT count(*) FROM app.judgment_change WHERE status = 'pending' AND kind = ANY($1::text[])"

# ── 아웃박스(app.scope_outbox: loader 는 attempts·next_attempt_at·done_at·last_error 만 UPDATE) ──
OUTBOX_CLAIM = """
UPDATE app.scope_outbox o SET next_attempt_at = now() + interval '5 minutes'
 WHERE o.outbox_id IN (SELECT outbox_id FROM app.scope_outbox WHERE done_at IS NULL AND next_attempt_at <= coalesce($1::timestamptz, now())
                        ORDER BY outbox_id FOR UPDATE SKIP LOCKED LIMIT $2)
RETURNING o.outbox_id, o.aggregate, o.aggregate_id, o.op, o.payload, o.attempts
"""
# done_at IS NULL: 처리 중 API 가 같은 대상 토글을 superseded 로 닫았으면 그 표시를 덮지 않는다(pj-prompts §6 ④)
OUTBOX_DONE = "UPDATE app.scope_outbox SET done_at = now(), last_error = NULL WHERE outbox_id = $1 AND done_at IS NULL"
OUTBOX_FAIL = """
UPDATE app.scope_outbox SET attempts = attempts + 1, last_error = $2,
       next_attempt_at = now() + make_interval(mins => least(power(2, least(attempts, 10))::int, 1440))
 WHERE outbox_id = $1 AND done_at IS NULL RETURNING attempts
"""
PROJECT_SCOPE_ID = "SELECT scope_project_id FROM app.project WHERE project_id = $1"
PROMPT_SCOPE_IDS = """
SELECT p.scope_prompt_id, pr.scope_project_id FROM app.prompt p JOIN app.project pr ON pr.project_id = p.project_id WHERE p.prompt_id = $1
"""
SET_PROJECT_SCOPE = """
UPDATE app.project SET scope_project_id = $2, updated_at = now() WHERE project_id = $1 AND scope_project_id IS DISTINCT FROM $2
"""
SET_PROMPT_SCOPE = """
UPDATE app.prompt SET scope_prompt_id = $2, updated_by = app.actor(), updated_at = now() WHERE prompt_id = $1 AND scope_prompt_id IS DISTINCT FROM $2
"""
SYSTEM_ACTOR = "SELECT set_config('app.actor_id', $1, true), set_config('app.actor_type', 'system', true)"

# ── 파티션 선생성(일 1회): rd 사실 표 leaf(표면별) · ing 원본·GA4·접근 감사·DataForSEO 월 leaf ──
MONTH_PARENTS = ("ing.answer", "ing.mention", "ing.mention_occurrence", "ing.answer_stance", "ing.citation", "ing.ga4_row", "rd.ga4_row",
                 "app.access_audit_log", "ext.dfs_call")
LEAF_COUNT = """
SELECT count(*) FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname IN ('rd', 'ing', 'app', 'ext')
"""

# ── DataForSEO(dfs_fetch) ──
DFS_CALL = """
INSERT INTO ext.dfs_call (endpoint, location_code, language_code, keywords, request, response, status_code, cost, requested_by, project_id, requested_at)
VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11) RETURNING call_id
"""
# term_norm = DB 정본 app.term_norm(DB-v2.7 P55, API 조회·중복 판정과 같은 함수)
KW_KEY = """
WITH n AS (SELECT btrim($1::text) AS term, app.term_norm($1::text) AS term_norm),
ins AS (INSERT INTO rd.dim_keyword (term, term_norm) SELECT term, term_norm FROM n ON CONFLICT (term_norm) DO NOTHING RETURNING kw_key)
SELECT kw_key FROM ins UNION ALL SELECT d.kw_key FROM rd.dim_keyword d, n WHERE d.term_norm = n.term_norm LIMIT 1
"""
# competition(DB-v2.9 P62, bg-intent BG-40) = 응답 행 competition 라벨(LOW·MEDIUM·HIGH 밖이면 NULL)
KW_VOLUME = """
INSERT INTO rd.kw_volume_monthly (kw_key, location_code, language_code, month, search_volume, competition_index, cpc, call_id, observed_at,
                                  competition)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
ON CONFLICT (kw_key, location_code, language_code, month) DO UPDATE SET search_volume = EXCLUDED.search_volume,
       competition_index = EXCLUDED.competition_index, cpc = EXCLUDED.cpc, call_id = EXCLUDED.call_id, observed_at = EXCLUDED.observed_at,
       competition = EXCLUDED.competition
"""
KW_SERP = """
INSERT INTO rd.kw_serp (call_id, kw_key, location_code, language_code, rank, url, domain, title, snippet, observed_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (call_id, rank) DO NOTHING
"""
# total_count(DB-v2.9 P62, bg-intent BG-39) = 그 호출의 tasks[0].result[0].total_count(호출 단위 같은 값, 행마다 반복)
KW_SUGGEST = """
INSERT INTO rd.kw_suggestion (call_id, seed_kw_key, location_code, language_code, pos, kw_key, search_volume, intent, is_seed, observed_at,
                              total_count)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (call_id, pos) DO NOTHING
"""
