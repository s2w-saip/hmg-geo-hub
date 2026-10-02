"""ingest.ecat SQL. 스캔 단위 = (job, 본문 턴). 저장 본문(ing.answer.answer_text)은 job 의 **마지막 턴**이다:
단일 턴 답변 = 턴 1, ACR 답변(prompt_run_id 있음, 2턴) = 턴 2. ACR 1턴은 본문이 없어 스캔하지 않는다(설계 부록 A: ACR 2턴 발생의
본문 위치 일치 4,323/4,325, 1턴 239/17,019). 턴 번호는 ing.mention_occurrence.turn_index 와 같은 1부터 척도다.
"""
from __future__ import annotations

# 본문 턴(ing.hub_match.turn_index). 한 곳에서만 정의한다(rematch 도 이 식을 쓴다).
BODY_TURN = "(CASE WHEN a.prompt_run_id IS NOT NULL THEN 2 ELSE 1 END)::int2"

SCHEMA_READY = "SELECT to_regclass('ing.hub_match') IS NOT NULL AND to_regclass('app.ecat_surface') IS NOT NULL"

# ── 표면 ──
SURFACES_BY_ID = """
SELECT d.surface_id, d.entity_id, d.surface FROM app.ecat_surface_def d WHERE d.surface_id = ANY($1::int4[]) ORDER BY d.surface_id
"""
SURFACES_OF_VER = """
SELECT d.surface_id, d.entity_id, d.surface
  FROM app.ecat_surface s JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id
 WHERE s.ver = $1 AND s.action = 'add' ORDER BY d.surface_id
"""
# 적재 훅·기본 CLI 대상: 활성·초안 버전이 켠 add 표면(초안 = 미리보기 전에 이미 새 답변을 따라가게) ∪ 회차가 고정한 버전
#   (rd.cycle.ecat_ver: 보관된 버전이라도 그 회차 답변은 그 버전 규칙으로 투영된다. 빠지면 고정 회차 답변이 재적재될 때 그 버전의
#   재매칭 행이 옛 본문 해시로 남아 무시되고 bulk 재구축으로도 돌아오지 않는다: 검증 반례 CE15). 표면 행은 버전 무관이라 합집합으로 충분하다
SURFACES_LIVE = """
SELECT DISTINCT d.surface_id, d.entity_id, d.surface
  FROM app.ecat_surface s JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id JOIN app.ecat_version v ON v.ver = s.ver
 WHERE s.action = 'add'
   AND (v.status IN ('active', 'draft') OR v.ver IN (SELECT DISTINCT c.ecat_ver::int4 FROM rd.cycle c WHERE c.ecat_ver IS NOT NULL))
 ORDER BY d.surface_id
"""
SCAN_STATE = "SELECT surface_id, scanned_to_load_id FROM ing.hub_match_scan WHERE surface_id = ANY($1::int4[])"

# ── 워터마크 ── 스캔 시작 시점에 "그 load 이하가 쓴 본문은 다 커밋됐다"고 말할 수 있는 가장 큰 load_id.
# 아직 도는 다른 load 가 있으면 그 직전까지(그 load 가 나중에 커밋하는 본문은 load_id > W 라 다음 따라잡기가 잡는다).
# 스캔 load(본문을 쓰지 않는다)는 빼고 본다. 죽은 채 running 으로 남은 load 는 W 를 낮게 묶을 뿐이다(따라잡기가 더 넓어질 뿐, 누락 없음).
WATERMARK = """
SELECT least(coalesce((SELECT max(load_id) FROM ing.load WHERE load_id <> $1), 0),
             coalesce((SELECT min(load_id) - 1 FROM ing.load
                        WHERE status = 'running' AND load_id <> $1
                          AND NOT (kind = 'rebuild' AND coalesce(scope_ref->>'source', '') = 'ecat_scan')), 9223372036854775807))
"""

# ── 재개: 같은 표면 집합·같은 모드의 미완 스캔 load ──
RESUMABLE = """
SELECT load_id, scope_ref FROM ing.load
 WHERE kind = 'rebuild' AND status = 'running' AND scope_ref->>'source' = 'ecat_scan'
   AND scope_ref->>'mode' = $1 AND scope_ref->'surfaces' = $2::jsonb
 ORDER BY load_id DESC LIMIT 1
"""
LOAD_PROGRESS = "UPDATE ing.load SET scope_ref = scope_ref || $2::jsonb WHERE load_id = $1"

# ── 대상 본문 ──
COUNT_BODIES = "SELECT count(*) FROM ing.answer WHERE answer_text IS NOT NULL AND answer_text <> ''"
# 전체 스캔: (run_month, job_id) 키셋(ing.answer PK). 본문 없는 답변은 적중이 없으므로 건너뛰고, 그 구간의 옛 행은 범위 삭제가 지운다.
FULL_CHUNK = f"""
SELECT a.run_month, a.job_id, {BODY_TURN} AS turn_index, a.answer_text, a.content_hash
  FROM ing.answer a
 WHERE a.answer_text IS NOT NULL AND a.answer_text <> '' AND (a.run_month, a.job_id) > ($1::date, $2::uuid)
 ORDER BY a.run_month, a.job_id LIMIT $3
"""
# 전체 스캔 청크의 범위 삭제: (lo, hi] 구간의 이 표면 행 전부(그 사이 본문이 사라진 답변의 옛 행 포함)
DELETE_RANGE = """
DELETE FROM ing.hub_match WHERE surface_id = ANY($1::int4[])
   AND (run_month, job_id) > ($2::date, $3::uuid) AND (run_month, job_id) <= ($4::date, $5::uuid)
"""
# 전체 스캔 마지막: 마지막 커서 뒤(키가 더 큰) 옛 행
DELETE_TAIL = "DELETE FROM ing.hub_match WHERE surface_id = ANY($1::int4[]) AND (run_month, job_id) > ($2::date, $3::uuid)"
# 따라잡기: 워터마크 뒤에 바뀐 답변 키(본문 없음 포함: 본문이 사라졌으면 옛 행을 지운다)
CATCHUP_KEYS = "SELECT run_month, job_id FROM ing.answer WHERE load_id > $1 ORDER BY run_month, job_id"
BODIES_OF_KEYS = f"""
SELECT a.run_month, a.job_id, {BODY_TURN} AS turn_index, a.answer_text, a.content_hash
  FROM unnest($1::date[], $2::uuid[]) k(m, j) JOIN ing.answer a ON a.run_month = k.m AND a.job_id = k.j
 WHERE a.answer_text IS NOT NULL AND a.answer_text <> ''
 ORDER BY a.run_month, a.job_id
"""
DELETE_KEYS = """
DELETE FROM ing.hub_match h USING unnest($2::date[], $3::uuid[]) k(m, j)
 WHERE h.surface_id = ANY($1::int4[]) AND h.run_month = k.m AND h.job_id = k.j
"""
# 적재 훅: 이 적재 트랜잭션에서 바뀐 답변(pull 서비스의 _pl_changed, ingest/pull/sync/queries.py CHANGED)
CHANGED_BODIES = f"""
SELECT a.run_month, a.job_id, {BODY_TURN} AS turn_index, a.answer_text, a.content_hash
  FROM _pl_changed c JOIN ing.answer a ON a.run_month = c.run_month AND a.job_id = c.job_id
 WHERE a.answer_text IS NOT NULL AND a.answer_text <> ''
"""
CHANGED_MONTHS = "SELECT DISTINCT run_month FROM _pl_changed"
DELETE_CHANGED = """
DELETE FROM ing.hub_match h USING _pl_changed c WHERE h.surface_id = ANY($1::int4[]) AND h.run_month = c.run_month AND h.job_id = c.job_id
"""

ENSURE_LEAF = "SELECT rd.ensure_hub_match_leaf($1::date)"
HUB_COLUMNS = ("surface_id", "run_month", "job_id", "turn_index", "entity_id", "n_occ", "first_start", "starts", "ends", "answer_hash", "load_id")

# 스캔 완료: 표면별 진행 원장(hits = 지금 유효한 행 수, 본문 해시가 같은 것만)
SCAN_DONE = """
INSERT INTO ing.hub_match_scan AS s (surface_id, scanned_to_load_id, answers_scanned, hits, scanned_at)
SELECT x.sid, $2, $3,
       (SELECT count(*) FROM ing.hub_match h JOIN ing.answer a ON a.run_month = h.run_month AND a.job_id = h.job_id
                                                              AND a.content_hash = h.answer_hash WHERE h.surface_id = x.sid), now()
  FROM unnest($1::int4[]) x(sid)
ON CONFLICT (surface_id) DO UPDATE SET scanned_to_load_id = EXCLUDED.scanned_to_load_id,
       answers_scanned = CASE WHEN $4 THEN s.answers_scanned + EXCLUDED.answers_scanned ELSE EXCLUDED.answers_scanned END,
       hits = EXCLUDED.hits, scanned_at = now()
"""
# 전체 스캔 시작: 진행 원장을 "미완"(scanned_to_load_id NULL)으로 둔다. 따라잡기는 미완 표면을 건너뛴다
SCAN_BEGIN = """
INSERT INTO ing.hub_match_scan AS s (surface_id, scanned_to_load_id, answers_scanned, hits, scanned_at)
SELECT x.sid, NULL, 0, 0, now() FROM unnest($1::int4[]) x(sid)
ON CONFLICT (surface_id) DO UPDATE SET scanned_to_load_id = NULL, scanned_at = now()
"""

# ── rematch(E1·E4 읽기 계약) ──
# 유효 적중 = 스캔 당시 본문 해시가 지금 본문 해시와 같은 행(본문이 바뀌었는데 아직 재스캔 안 된 행은 버린다)
REMATCH_HITS = """
SELECT h.run_month, h.job_id, h.turn_index, h.surface_id, h.entity_id, h.starts, h.ends
  FROM ing.hub_match h JOIN ing.answer a ON a.run_month = h.run_month AND a.job_id = h.job_id AND a.content_hash = h.answer_hash
 WHERE h.surface_id = ANY($1::int4[])
   AND ($2::date[] IS NULL OR (h.run_month, h.job_id) IN (SELECT * FROM unnest($2::date[], $3::uuid[])))
"""
REMATCH_BODIES = f"""
SELECT a.run_month, a.job_id, {BODY_TURN} AS body_turn, a.answer_text
  FROM unnest($1::date[], $2::uuid[]) k(m, j) JOIN ing.answer a ON a.run_month = k.m AND a.job_id = k.j
"""
# 같은 job 의 Scope 발생(턴 번호 NULL 은 단일 턴 답변이면 턴 1 로 본다)과 언급 엔티티(발생 없는 언급 = 위치 모름)
REMATCH_OCC = """
SELECT o.run_month, o.job_id, o.turn_index, o.entity_id, o.source_start, o.source_end
  FROM unnest($1::date[], $2::uuid[]) k(m, j) JOIN ing.mention_occurrence o ON o.run_month = k.m AND o.job_id = k.j
"""
REMATCH_MENTIONS = """
SELECT DISTINCT m.run_month, m.job_id, m.entity_id
  FROM unnest($1::date[], $2::uuid[]) k(m, j) JOIN ing.mention m ON m.run_month = k.m AND m.job_id = k.j
"""
REMATCH_TEMP = """
DROP TABLE IF EXISTS {table};
CREATE TEMP TABLE {table} (
  run_month date NOT NULL, job_id uuid NOT NULL, turn_index int2 NOT NULL, entity_id uuid NOT NULL,
  is_new bool NOT NULL, mention_count int NOT NULL, first_start int NOT NULL, starts int[] NOT NULL, surface_ids int4[] NOT NULL,
  surfaces text[] NOT NULL, avg_position real, positions_known bool NOT NULL,
  sentiment_positive int NOT NULL, sentiment_neutral int NOT NULL, sentiment_negative int NOT NULL, sentiment_mixed int NOT NULL,
  sentiment_known bool NOT NULL, type_mention int NOT NULL, type_recommendation int NOT NULL, type_comparison int NOT NULL,
  type_definition int NOT NULL, type_final_choice int NOT NULL, extraction_source text NOT NULL,
  PRIMARY KEY (run_month, job_id, turn_index, entity_id)) ON COMMIT DROP;
"""
REMATCH_COLUMNS = ("run_month", "job_id", "turn_index", "entity_id", "is_new", "mention_count", "first_start", "starts", "surface_ids",
                   "surfaces", "avg_position", "positions_known", "sentiment_positive", "sentiment_neutral", "sentiment_negative",
                   "sentiment_mixed", "sentiment_known", "type_mention", "type_recommendation", "type_comparison", "type_definition",
                   "type_final_choice", "extraction_source")
