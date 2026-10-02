"""intent.keywords.serp_drafts SQL. 읽기(api_ro): rd.kw_serp 한 호출의 행 + 행별 최신 gen. 쓰기(api_rw): app.kw_prompt_draft 만.

rd.kw_serp 는 파티션 표가 아니다: PK(call_id, rank) 선두로 한 호출의 행(≤ depth 10)만 읽는다."""
from __future__ import annotations

SERP_ROWS = """
SELECT s.call_id, s.rank, s.title, s.snippet, s.location_code, s.language_code, k.term, k.term_norm,
       (SELECT max(d.gen) FROM app.kw_prompt_draft d WHERE d.serp_call_id = s.call_id AND d.rank = s.rank) AS max_gen
  FROM rd.kw_serp s JOIN rd.dim_keyword k ON k.kw_key = s.kw_key
 WHERE s.call_id = :cid
 ORDER BY s.rank
"""

# gen = 같은 (호출, 순위)의 기존 max + 1 을 쓰기 트랜잭션 안에서 다시 계산. 동시 생성이 같은 gen 을 노리면 PK 충돌 → 건너뜀
INSERT = """
INSERT INTO app.kw_prompt_draft (serp_call_id, rank, gen, prompt, model)
SELECT :cid, x.rank,
       (SELECT coalesce(max(d.gen), 0) + 1 FROM app.kw_prompt_draft d WHERE d.serp_call_id = :cid AND d.rank = x.rank),
       x.prompt, :model
  FROM unnest(CAST(:ranks AS int2[]), CAST(:prompts AS text[])) AS x(rank, prompt)
ON CONFLICT DO NOTHING
RETURNING rank, gen, prompt, model, generated_at
"""
