"""intent.candidates.submit SQL(api_rw, app 만).

같은 프로젝트의 동시 제출이 서로의 신규 텍스트를 못 보고 중복 삽입하지 않도록 프로젝트 행을 FOR NO KEY UPDATE 로 잡아 직렬화한다
(app.prompt_candidate 에 유니크 제약이 없어 현행은 앱 단 중복 제거만 했다). 후보 dedup 은 prompt_candidate_project_idx 로 좁힌다."""
from __future__ import annotations

LOCK_PROJECT = "SELECT project_id FROM app.project WHERE project_id = :pid FOR NO KEY UPDATE"

EXISTING_TEXTS = "SELECT DISTINCT text FROM app.prompt_candidate WHERE project_id = :pid AND text = ANY(CAST(:texts AS text[]))"

INSERT = """
INSERT INTO app.prompt_candidate (project_id, source, source_keyword, text)
SELECT :pid, :source, x.kw, x.text
  FROM unnest(CAST(:texts AS text[]), CAST(:kws AS text[])) WITH ORDINALITY AS x(text, kw, ord)
 ORDER BY x.ord
RETURNING candidate_id
"""
