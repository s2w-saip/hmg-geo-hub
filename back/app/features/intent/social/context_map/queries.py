"""intent.social.context_map 읽기 SQL(SQLAlchemy Core text). ext 만(api_ro).

ext.ctx_* 는 파티션 표가 아니다(정적 스냅샷): 모든 문장이 snapshot_id 로 좁혀지고, 목록은 ctx_entity_type_mentions·
ctx_drive_requirement_idx·ctx_evidence_entity 인덱스를 쓴다. 정렬·방향은 화이트리스트에서만 SQL 조각을 고르고(service),
검색어는 ILIKE 이스케이프 후 바인드한다. 목록 문장은 정렬 조각이 들어가므로 service 가 조립한다(아래는 고정 문장).
"""
from __future__ import annotations

ACTIVE_BY_INDUSTRY = """
SELECT snapshot_id, industry_entity_id, source, utterance_total, taken_at
  FROM ext.ctx_snapshot WHERE is_active AND industry_entity_id = :ind
"""

ACTIVE_ANY = """
SELECT snapshot_id, industry_entity_id, source, utterance_total, taken_at
  FROM ext.ctx_snapshot WHERE is_active ORDER BY snapshot_id LIMIT 2
"""

STATS = """
SELECT (SELECT count(*) FROM ext.ctx_entity e WHERE e.snapshot_id = :s AND e.type = 'ConsumerContext') AS contexts,
       (SELECT count(*) FROM ext.ctx_entity e WHERE e.snapshot_id = :s AND e.type = 'ConsumerRequirement') AS conditions,
       (SELECT count(*) FROM ext.ctx_drive d WHERE d.snapshot_id = :s) AS drives,
       (SELECT count(*) FROM ext.ctx_combination c WHERE c.snapshot_id = :s) AS combinations,
       (SELECT count(DISTINCT m.host) FROM ext.ctx_domain m WHERE m.snapshot_id = :s) AS sources
"""

MAX_CO = "SELECT coalesce(max(c.co_count), 0) AS m FROM ext.ctx_combination c WHERE c.snapshot_id = :s"

ENTITY = """
SELECT e.id, e.type, e.canonical_name, e.dimension, e.mention_count, e.utterance_count,
       e.sentiment_positive, e.sentiment_negative, e.sentiment_neutral
  FROM ext.ctx_entity e WHERE e.snapshot_id = :s AND e.id = :id
"""

EVIDENCE = """
SELECT v.quote, v.source_host, v.source_url, v.sentiment
  FROM ext.ctx_evidence v WHERE v.snapshot_id = :s AND v.entity_id = :id
 ORDER BY v.id LIMIT :n
"""

DOMAINS = """
SELECT m.host, m.n FROM ext.ctx_domain m WHERE m.snapshot_id = :s AND m.entity_id = :id ORDER BY m.n DESC, m.host
"""

LINKED_FROM_CONTEXT = """
SELECT d.requirement_id AS id, e.canonical_name AS name, d.co_count
  FROM ext.ctx_drive d JOIN ext.ctx_entity e ON e.snapshot_id = d.snapshot_id AND e.id = d.requirement_id
 WHERE d.snapshot_id = :s AND d.context_id = :id
 ORDER BY d.co_count DESC, d.requirement_id
"""

LINKED_FROM_CONDITION = """
SELECT d.context_id AS id, e.canonical_name AS name, d.co_count
  FROM ext.ctx_drive d JOIN ext.ctx_entity e ON e.snapshot_id = d.snapshot_id AND e.id = d.context_id
 WHERE d.snapshot_id = :s AND d.requirement_id = :id
 ORDER BY d.co_count DESC, d.context_id
"""

# 내보내기(전량, 얇은 열): 표가 여는 순서 그대로(언급 내림차순 / 동시 언급 내림차순)
EXPORT_CONTEXTS = """
SELECT e.id, e.canonical_name, e.dimension, e.mention_count, e.sentiment_positive, e.sentiment_negative, e.sentiment_neutral,
       (SELECT count(*) FROM ext.ctx_drive d WHERE d.snapshot_id = e.snapshot_id AND d.context_id = e.id) AS linked_count
  FROM ext.ctx_entity e WHERE e.snapshot_id = :s AND e.type = 'ConsumerContext'
 ORDER BY e.mention_count DESC, e.id
"""

EXPORT_CONDITIONS = """
SELECT e.id, e.canonical_name, e.dimension, e.mention_count, e.sentiment_positive, e.sentiment_negative, e.sentiment_neutral,
       (SELECT count(*) FROM ext.ctx_drive d WHERE d.snapshot_id = e.snapshot_id AND d.requirement_id = e.id) AS linked_count
  FROM ext.ctx_entity e WHERE e.snapshot_id = :s AND e.type = 'ConsumerRequirement'
 ORDER BY e.mention_count DESC, e.id
"""

EXPORT_COMBINATIONS = """
SELECT c.cond_a, c.cond_b, c.co_count, a.canonical_name AS a_name, b.canonical_name AS b_name
  FROM ext.ctx_combination c
  JOIN ext.ctx_entity a ON a.snapshot_id = c.snapshot_id AND a.id = c.cond_a
  JOIN ext.ctx_entity b ON b.snapshot_id = c.snapshot_id AND b.id = c.cond_b
 WHERE c.snapshot_id = :s
 ORDER BY c.co_count DESC, c.cond_a, c.cond_b
"""

# 프롬프트 생성 시드 풀(intent.social.prompts 가 쓴다, 현행 getSeedPool 150/200/500)
POOL_ENTITIES = """
SELECT e.id, e.canonical_name AS name, e.mention_count
  FROM ext.ctx_entity e WHERE e.snapshot_id = :s AND e.type = :t
 ORDER BY e.mention_count DESC, e.id LIMIT :n
"""

POOL_COMBINATIONS = """
SELECT c.cond_a, c.cond_b, c.co_count, a.canonical_name AS a_name, b.canonical_name AS b_name
  FROM ext.ctx_combination c
  JOIN ext.ctx_entity a ON a.snapshot_id = c.snapshot_id AND a.id = c.cond_a
  JOIN ext.ctx_entity b ON b.snapshot_id = c.snapshot_id AND b.id = c.cond_b
 WHERE c.snapshot_id = :s AND c.cond_a = ANY(CAST(:ids AS uuid[])) AND c.cond_b = ANY(CAST(:ids AS uuid[]))
 ORDER BY c.co_count DESC, c.cond_a, c.cond_b LIMIT :n
"""

POOL_DRIVES = """
SELECT d.context_id, d.requirement_id, d.co_count
  FROM ext.ctx_drive d
 WHERE d.snapshot_id = :s AND d.context_id = ANY(CAST(:ctx AS uuid[])) AND d.requirement_id = ANY(CAST(:cond AS uuid[]))
 ORDER BY d.co_count DESC, d.context_id, d.requirement_id
"""

ENTITY_SEEDS = """
SELECT e.id, e.canonical_name AS name, e.type, e.mention_count
  FROM ext.ctx_entity e WHERE e.snapshot_id = :s AND e.id = ANY(CAST(:ids AS uuid[]))
"""
