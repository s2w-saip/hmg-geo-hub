"""intent.social.prompts SQL. 읽기(api_ro): app.ctx_generated_prompt·추적 경쟁사·차종·기존 프롬프트·후보. 쓰기(api_rw): app 만.
시드 풀(ext.ctx_*) 조회 문장은 intent.social.context_map.queries 를 쓴다(같은 스냅샷 규칙)."""
from __future__ import annotations

LIST = """
SELECT prompt_id, seed_key, text, layer, funnel_stage, source_label, priority, origin, batch_no, model, generated_at
  FROM app.ctx_generated_prompt WHERE project_id = :pid AND removed_at IS NULL
 ORDER BY batch_no, priority DESC NULLS LAST, generated_at, prompt_id
"""

SEED_KEYS = "SELECT seed_key FROM app.ctx_generated_prompt WHERE project_id = :pid"

EXISTING_TEXTS = """
SELECT p.text, 'prompt' AS kind FROM app.prompt p WHERE p.project_id = :pid AND p.deleted_at IS NULL
UNION ALL
SELECT c.text, 'candidate' AS kind FROM app.prompt_candidate c WHERE c.project_id = :pid
"""

COMPETITORS = "SELECT brand_name FROM app.project_tracked_competitor WHERE project_id = :pid ORDER BY created_at, brand_name"
VEHICLES = "SELECT brand, model FROM app.project_tracked_vehicle WHERE project_id = :pid ORDER BY created_at, brand, model"

# batch_no = 프로젝트 max + 1(같은 트랜잭션). 시드 엔티티 id 는 'a,b' 문자열 배열로 받아 uuid[] 로 바꾼다(unnest 는 2차원 배열을 펼쳐 버린다)
INSERT = """
INSERT INTO app.ctx_generated_prompt (project_id, batch_no, seed_entity_ids, text, source_label, model, layer, funnel_stage,
                                      priority, origin, seed_key)
SELECT :pid, (SELECT coalesce(max(g.batch_no), 0) + 1 FROM app.ctx_generated_prompt g WHERE g.project_id = :pid),
       CAST(string_to_array(x.ids, ',') AS uuid[]), x.text, x.label, :model, x.layer, x.funnel, x.priority, :origin, x.seed_key
  FROM unnest(CAST(:ids AS text[]), CAST(:texts AS text[]), CAST(:labels AS text[]), CAST(:layers AS text[]),
              CAST(:funnels AS text[]), CAST(:priorities AS int2[]), CAST(:keys AS text[]))
       AS x(ids, text, label, layer, funnel, priority, seed_key)
ON CONFLICT (project_id, seed_key) DO NOTHING
RETURNING prompt_id, seed_key, text, layer, funnel_stage, source_label, priority, origin, batch_no, model, generated_at
"""

REMOVE = """
UPDATE app.ctx_generated_prompt SET removed_at = now()
 WHERE project_id = :pid AND prompt_id = ANY(CAST(:ids AS uuid[])) AND removed_at IS NULL
RETURNING prompt_id
"""
