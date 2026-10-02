"""intent.keywords.fetches SQL. 큐 행 INSERT·같은 요청 대조(advisory 잠금 + payload @> dedupe_key)는 core.write.enqueue_change_result 가
한다(기능 SQL 없음). 상태 조회는 app.judgment_change(api_ro 읽기). ext.dfs_call 은 적재기 전용이라 읽지 않는다."""
from __future__ import annotations

CHANGE = """
SELECT change_id, kind, subject_texts, payload, requested_by, requested_at, status, claimed_at, applied_at, error
  FROM app.judgment_change WHERE change_id = :cid AND kind = 'dfs_fetch'
"""
