"""admin.entities.versions SQL(SQLAlchemy Core text). 읽기 app(ecat_*·rule_param·judgment_change)·rd(dim_entity·answer_brand·문서형 뷰),
쓰기 app.ecat_*(api_rw, DB-v2.17 P94~P97·P102). rd 는 api_ro 로만 읽는다(api_rw 는 rd 권한 없음). ing 는 읽지 않는다(SQL 가드 G3).
"""

# ── 버전 ──
ACTIVE_VER = "SELECT ver FROM app.ecat_version WHERE status = 'active'"
DRAFT_VER = "SELECT ver FROM app.ecat_version WHERE status = 'draft'"
VERSION = """
SELECT ver, status, based_on, title, reason, origin, created_by, created_at, submitted_at, activated_at, retired_at,
       encode(content_md5, 'hex') AS content_md5, lint
  FROM app.ecat_version WHERE ver = :ver"""
VERSION_FOR_UPDATE = VERSION + " FOR UPDATE"
VERSIONS = """
SELECT v.ver, v.status, v.based_on, v.title, v.reason, v.origin, v.created_by, v.created_at, v.submitted_at, v.activated_at, v.retired_at,
       (SELECT count(*) FROM app.ecat_entity e WHERE e.ver = v.ver) AS entity_rows,
       (SELECT count(*) FROM app.ecat_surface s WHERE s.ver = v.ver) AS surface_rows
  FROM app.ecat_version v
 WHERE (CAST(:status AS text) IS NULL OR v.status = CAST(:status AS text))
 ORDER BY v.ver DESC
 LIMIT :lim"""
LAST_APPLY_OF = """
SELECT DISTINCT ON (a.ver) a.ver, a.apply_id, a.status, a.scope_kind, a.from_round_date, a.requested_at, a.finished_at
  FROM app.ecat_apply a WHERE a.kind = 'entity_version' AND a.ver = ANY(CAST(:vers AS int4[]))
 ORDER BY a.ver, a.apply_id DESC"""
CONTENT_MD5 = "SELECT encode(app.ecat_content_md5(CAST(:ver AS int4)), 'hex')"

INSERT_DRAFT = """
INSERT INTO app.ecat_version (status, based_on, title, reason, origin, created_by)
VALUES ('draft', :based_on, :title, :reason, :origin, app.actor())
RETURNING ver"""
COPY_ENTITIES = """
INSERT INTO app.ecat_entity (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by, updated_at)
SELECT :dst, e.entity_id, e.origin, e.name, e.entity_type, e.role, e.brand_code, e.merge_into, e.parent_brand_id, e.note, e.updated_by, e.updated_at
  FROM app.ecat_entity e WHERE e.ver = :src"""
COPY_SURFACES = "INSERT INTO app.ecat_surface (ver, surface_id, action) SELECT :dst, s.surface_id, s.action FROM app.ecat_surface s WHERE s.ver = :src"
UPDATE_DRAFT_META = "UPDATE app.ecat_version SET title = :title, reason = :reason WHERE ver = :ver RETURNING ver"
DISCARD = "UPDATE app.ecat_version SET status = 'discarded' WHERE ver = :ver AND status = 'draft' RETURNING ver"
SET_LINT = "UPDATE app.ecat_version SET lint = CAST(:lint AS jsonb) WHERE ver = :ver RETURNING ver"
MARK_SUBMITTED = "UPDATE app.ecat_version SET submitted_at = now() WHERE ver = :ver AND status = 'draft' RETURNING ver"

# ── 버전 내용 ──
ENTITIES_OF = """
SELECT e.entity_id, e.origin, e.name, e.entity_type, e.role, e.brand_code, e.merge_into, e.parent_brand_id, e.note, e.updated_by, e.updated_at
  FROM app.ecat_entity e WHERE e.ver = :ver ORDER BY e.entity_id"""
ENTITY_ONE = """
SELECT e.entity_id, e.origin, e.name, e.entity_type, e.role, e.brand_code, e.merge_into, e.parent_brand_id, e.note, e.updated_by, e.updated_at
  FROM app.ecat_entity e WHERE e.ver = :ver AND e.entity_id = :id"""
ENTITY_ROW_FOR_UPDATE = """
SELECT e.entity_id, e.origin, e.name, e.entity_type, e.role, e.brand_code, e.merge_into, e.parent_brand_id, e.note
  FROM app.ecat_entity e WHERE e.ver = :ver AND e.entity_id = :id FOR UPDATE"""
ENTITY_IN_VER = "SELECT e.entity_id, e.origin, e.role, e.merge_into FROM app.ecat_entity e WHERE e.ver = :ver AND e.entity_id = :id"
UPSERT_ENTITY = """
INSERT INTO app.ecat_entity AS t (ver, entity_id, origin, name, entity_type, role, brand_code, merge_into, parent_brand_id, note, updated_by, updated_at)
VALUES (:ver, :id, :origin, :name, :entity_type, :role, :brand_code, :merge_into, :parent_brand_id, :note, app.actor(), now())
ON CONFLICT (ver, entity_id) DO UPDATE SET origin = EXCLUDED.origin, name = EXCLUDED.name, entity_type = EXCLUDED.entity_type,
  role = EXCLUDED.role, brand_code = EXCLUDED.brand_code, merge_into = EXCLUDED.merge_into, parent_brand_id = EXCLUDED.parent_brand_id,
  note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()
RETURNING t.entity_id"""
DELETE_ENTITY = "DELETE FROM app.ecat_entity e WHERE e.ver = :ver AND e.entity_id = :id RETURNING e.entity_id"
ENTITY_REFS = """
SELECT (SELECT count(*) FROM app.ecat_entity e WHERE e.ver = :ver AND (e.merge_into = :id OR e.parent_brand_id = :id)) AS entity_refs,
       (SELECT count(*) FROM app.ecat_surface s JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id
         WHERE s.ver = :ver AND d.entity_id = :id) AS surface_refs"""

SURFACES_OF = """
SELECT s.surface_id, s.action, d.entity_id, d.surface, d.surface_norm, d.lang, d.created_by, d.created_at
  FROM app.ecat_surface s JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id
 WHERE s.ver = :ver ORDER BY s.surface_id"""
SURFACE_ONE = """
SELECT s.surface_id, s.action, d.entity_id, d.surface, d.surface_norm, d.lang, d.created_by, d.created_at
  FROM app.ecat_surface s JOIN app.ecat_surface_def d ON d.surface_id = s.surface_id
 WHERE s.ver = :ver AND s.surface_id = :sid"""
FIND_SURFACE_DEF = """
SELECT d.surface_id FROM app.ecat_surface_def d
 WHERE d.entity_id IS NOT DISTINCT FROM CAST(:eid AS uuid) AND d.surface_norm = :norm AND d.lang IS NOT DISTINCT FROM CAST(:lang AS text)"""
INSERT_SURFACE_DEF = """
INSERT INTO app.ecat_surface_def (entity_id, surface, surface_norm, lang, created_by)
VALUES (CAST(:eid AS uuid), :surface, :norm, CAST(:lang AS text), app.actor())
ON CONFLICT ON CONSTRAINT ecat_surface_def_uniq DO NOTHING
RETURNING surface_id"""
SURFACE_IN_VER = "SELECT s.action FROM app.ecat_surface s WHERE s.ver = :ver AND s.surface_id = :sid FOR UPDATE"
UPSERT_SURFACE = """
INSERT INTO app.ecat_surface AS t (ver, surface_id, action) VALUES (:ver, :sid, :action)
ON CONFLICT (ver, surface_id) DO UPDATE SET action = EXCLUDED.action RETURNING t.surface_id"""
DELETE_SURFACE = "DELETE FROM app.ecat_surface s WHERE s.ver = :ver AND s.surface_id = :sid RETURNING s.action"
SURFACE_DEF = "SELECT d.surface_id, d.entity_id, d.surface, d.surface_norm, d.lang FROM app.ecat_surface_def d WHERE d.surface_id = :sid"

# 린트 관측 표면(ing 없이 닿는 범위): 활성·초안 버전의 다른 엔티티 add 표면 정의 + 검토 대기함 새 표면
OBSERVED_DEFS = """
SELECT d.surface_norm, d.entity_id FROM app.ecat_surface_def d
 WHERE d.surface_norm = ANY(CAST(:norms AS text[])) AND d.entity_id IS NOT NULL
   AND EXISTS (SELECT 1 FROM app.ecat_surface s JOIN app.ecat_version v ON v.ver = s.ver
                WHERE s.surface_id = d.surface_id AND s.action = 'add' AND v.status IN ('active', 'draft'))"""
OBSERVED_REVIEW = """
SELECT r.surface_norm, r.entity_id FROM app.ecat_review r
 WHERE r.kind = 'new_surface' AND r.surface_norm = ANY(CAST(:norms AS text[]))"""
# 대표 표기 후보(api_ro). 정규형 동치는 파이썬 normalize_surface 로 다시 거른다(lower 는 1차 거르기)
OBSERVED_NAMES = "SELECT e.entity_id, e.rep_name FROM rd.dim_entity e WHERE lower(e.rep_name) = ANY(CAST(:names AS text[]))"
LINT_CONFIG = "SELECT value FROM app.rule_param WHERE key = 'ecat_lint'"
# 자사 귀속(엔티티 단위, 덮어쓰기 없을 때): 활성 투영 차원의 표시 브랜드(rd.dim_entity.brand_key → dim_brand_name.own_bit, 접두 교정 J1·Scope 롤업·
# 별칭 접기 결과) → 자사 브랜드 정본 엔티티(app.brand brand_bit = own_bit, Hyundai N 등 하위 브랜드는 부모 비트라 부모로 간다)
OWN_SCOPE_ATTRIBUTION = """
SELECT e.entity_id, b.canonical_entity_id AS own_id
  FROM rd.dim_entity e
  JOIN rd.dim_brand_name bn ON bn.brand_key = e.brand_key AND bn.own_bit <> 0
  JOIN app.brand b ON b.is_hmg_own AND NOT b.is_umbrella AND b.brand_bit = bn.own_bit AND b.canonical_entity_id IS NOT NULL
 WHERE e.entity_id = ANY(CAST(:ids AS uuid[]))"""
OWN_BRANDS = """
SELECT b.canonical_entity_id AS own_id, b.brand_code FROM app.brand b
 WHERE b.is_hmg_own AND NOT b.is_umbrella AND b.canonical_entity_id IS NOT NULL"""
# 전역 차단 대조(검증 N4): 자사 엔티티와 자사 브랜드로 롤업되는 엔티티의 Scope 관측 표면. 뷰 rd.v_entity_mention_surface(DB-v2.17 P104) 규약 =
# entity_id 또는 brand_rollup_entity_id 등치(ANY) + run_month 하한. admin_long 전용, 새 전역 차단이 있을 때만. 하한 = 오늘(KST) 달 시작 − (months − 1)개월.
# 표면 정규형 SQL = seed-3x-common §10 pg_temp.ecat_norm 본문(ingest watch _surface_norm_sql 과 같은 식): 차단 정규형과 같은 행만 돌려준다
# (상한이 원문 수가 아니라 적중 수에 걸리게). 정규화(ICU·정규식)는 행마다 비싸서 먼저 (엔티티, 롤업, 원문) distinct 를 물질화하고 그
# distinct 값에만 건다(합성 대형 자사 3개월 105만 언급·표면 187만: 행마다 9.9~13.7s → 3.3~6.2s, 정규화 1천여 값). 최종 판정은 파이썬 normalize_surface.
_NORM_SURFACE = ("normalize(btrim(regexp_replace(replace(replace(lower(normalize(r.surface, NFKC) COLLATE \"und-x-icu\"), 'ß', 'ss'), 'ς', 'σ'), "
                 "'\\s+', ' ', 'g'), ' '), NFC)")
_SINCE = "v.run_month >= (date_trunc('month', rd.today_kst()) - make_interval(months => CAST(:months AS int) - 1))::date"
# 자사 귀속 후보 엔티티(작은 차원 표만 읽는다): 투영 차원의 표시 브랜드가 자사(rd.dim_entity.brand_key → dim_brand_name.own_bit, 활성 버전의
# 접두 교정 J1·별칭 접기·롤업 결과) ∪ 대표 표기가 3사 접두 후보(앵커 정규식, 상위 집합). 언급 표의 표시명 술어는 색인이 없어 창 전체를 훑으므로
# (합성 대형 자사 225만 행에서 30초 상한 초과) 쓰지 않고, 언급 조회는 이 후보·추적 id 등치로만 좁힌다. 언급 단위의 정확한 귀속(접두 교정
# app.ecat_hmg_prefix_id 포함)은 적중 행에서 다시 계산해 lint.RollupRule 로 판정한다.
OWN_CANDIDATE_ENTITIES = """
SELECT e.entity_id FROM rd.dim_entity e
 WHERE e.brand_key IN (SELECT b.brand_key FROM rd.dim_brand_name b WHERE b.own_bit <> 0)
    OR e.rep_name ~* (SELECT '^' || app.ecat_rx_lead_trim() || '(' || string_agg(app.ecat_rx_escape(p.prefix), '|') || ')' FROM app.brand_name_prefix p)
 LIMIT :lim"""
ROLLUP_OBSERVED_SURFACES = f"""
WITH raw AS MATERIALIZED (
  SELECT DISTINCT v.entity_id, v.brand_rollup_entity_id AS rollup, v.display_name AS disp, v.surface FROM rd.v_entity_mention_surface v
   WHERE {_SINCE} AND v.surface IS NOT NULL
     AND (v.entity_id = ANY(CAST(:eids AS uuid[])) OR v.brand_rollup_entity_id = ANY(CAST(:ids AS uuid[]))))
SELECT r.entity_id, r.rollup, r.surface, app.ecat_hmg_prefix_id(r.disp) AS pfx FROM raw r
 WHERE {_NORM_SURFACE} = ANY(CAST(:norms AS text[]))
 LIMIT :lim"""
# 이름(대표 표기) 적중 후보 엔티티의 Scope 롤업·접두 교정(표면 없는 언급 포함)
ENTITY_SCOPE_ROLLUPS = f"""
SELECT x.entity_id, x.rollup, app.ecat_hmg_prefix_id(x.disp) AS pfx FROM (
  SELECT DISTINCT v.entity_id, v.brand_rollup_entity_id AS rollup, v.display_name AS disp FROM rd.v_entity_mention_surface v
   WHERE v.entity_id = ANY(CAST(:ids AS uuid[])) AND {_SINCE}) x
 LIMIT :lim"""
# Scope 롤업 대상 제거(검증 N8, 엔진 seed _acr_nm·_bn_pair: 롤업 대상이 removed 면 접두 교정 전에 브랜드 귀속 없음). 롤업이 대상 집합(:targets)에
# 걸리는 엔티티를 두 색인(mention_rollup_idx·mention_entity_idx) 등치로 먼저 고르고(hit), 그 엔티티의 Scope 롤업 전체를 돌려준다(엔티티 단위 판정은
# 롤업이 전부 제거일 때만 귀속 없음 = lint.RollupRule.entity_own). _FOR_IDS = 판정 대상 id 가 정해진 경우(목록 배지·버전 상세·린트 대상 행, 전 기간:
# 차원·합계와 같은 범위), _DEPENDENTS = 린트 역방향(제거·병합 편집 대상을 롤업으로 두는 엔티티, 최근 N개월·상한, admin_long 비차단).
_ROLLUP_SETS = """
WITH hit AS (SELECT DISTINCT v.entity_id FROM rd.v_entity_mention_surface v
              WHERE v.brand_rollup_entity_id = ANY(CAST(:targets AS uuid[])) {hit} LIMIT :lim)
SELECT DISTINCT v.entity_id, v.brand_rollup_entity_id AS rollup FROM rd.v_entity_mention_surface v
 WHERE v.entity_id IN (SELECT h.entity_id FROM hit h) AND v.brand_rollup_entity_id IS NOT NULL {since}
 LIMIT :lim"""
ROLLUP_SETS_FOR_IDS = _ROLLUP_SETS.format(hit="AND v.entity_id = ANY(CAST(:ids AS uuid[]))", since="")
ROLLUP_DEPENDENTS = _ROLLUP_SETS.format(hit=f"AND {_SINCE}", since=f"AND {_SINCE}")
# 포기 회차 고정(rd.cycle, api_ro): 노출 = app.core.cycles 후보 술어와 같다
ABANDON_CYCLES = """
SELECT c.cyc_key, c.round_date, c.surface, c.ecat_ver::int4 AS pin,
       (c.servable AND c.view_date IS NOT NULL AND c.view_date <= rd.today_kst()) AS exposed
  FROM rd.cycle c WHERE c.cyc_key = ANY(CAST(:keys AS int4[])) ORDER BY c.cyc_key"""
APPROVERS = "SELECT value FROM app.rule_param WHERE key = 'ecat_approvers'"

# ── 차원(api_ro) ──
DIM_ENTITIES = """
SELECT e.entity_id, e.entity_type, e.rep_name, e.brand_key, bn.name AS brand_name
  FROM rd.dim_entity e LEFT JOIN rd.dim_brand_name bn ON bn.brand_key = e.brand_key AND e.brand_key <> 0
 WHERE e.entity_id = ANY(CAST(:ids AS uuid[]))"""

# ── 반영 ──
APPLY_COLS = """a.apply_id, a.kind, a.ver, a.from_ver, a.scope_kind, a.from_round_date, a.cycle_keys, a.affected_answers, a.status,
       a.requested_by, a.approved_by, a.reason, a.requested_at, a.approved_at, a.started_at, a.finished_at, a.error,
       (a.preview IS NOT NULL) AS has_preview, coalesce((a.preview ->> 'requires_approval')::bool, false) AS requires_approval"""
APPLY = f"SELECT {APPLY_COLS}, a.preview FROM app.ecat_apply a WHERE a.apply_id = :id AND a.kind = 'entity_version'"
APPLY_FOR_UPDATE = APPLY + " FOR UPDATE OF a"
APPLIES = f"""
SELECT {APPLY_COLS} FROM app.ecat_apply a
 WHERE a.kind = 'entity_version'
   AND (CAST(:status AS text) IS NULL OR a.status = CAST(:status AS text))
   AND (CAST(:ver AS int4) IS NULL OR a.ver = CAST(:ver AS int4))
   AND (CAST(:before AS int8) IS NULL OR a.apply_id < CAST(:before AS int8))
 ORDER BY a.apply_id DESC LIMIT :lim"""
BUSY = """
SELECT a.apply_id, a.status FROM app.ecat_apply a
 WHERE a.status IN ('running', 'failed') AND a.apply_id <> coalesce(CAST(:id AS int8), -1) ORDER BY a.apply_id LIMIT 1"""
OPEN_FOR_VER = """
SELECT a.apply_id, a.status FROM app.ecat_apply a
 WHERE a.kind = 'entity_version' AND a.ver = :ver AND a.status IN ('draft', 'previewed', 'approved') ORDER BY a.apply_id LIMIT 1"""
APPLY_LOCK = "SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtextextended('app.ecat_apply', 0))) x"
INSERT_APPLY = """
INSERT INTO app.ecat_apply (kind, ver, from_ver, scope_kind, from_round_date, requested_by, reason)
VALUES ('entity_version', :ver, :from_ver, :scope_kind, :from_round_date, app.actor(), :reason)
RETURNING apply_id"""
SET_APPROVED = """
UPDATE app.ecat_apply SET status = 'approved', approved_by = app.actor(), approved_at = now(), error = NULL
 WHERE apply_id = :id AND status = 'previewed' RETURNING apply_id"""
SET_REJECTED = "UPDATE app.ecat_apply SET status = 'rejected', error = :err WHERE apply_id = :id RETURNING apply_id"
BACK_TO_PREVIEWED = "UPDATE app.ecat_apply SET status = 'previewed' WHERE apply_id = :id AND status = 'approved' RETURNING apply_id"
# 초안이 바뀌면 그 초안의 열린 요청을 낡음 표시(승인 전으로). 미리보기 전(draft) 요청도 표시한다(상태는 draft 그대로, 승인 때 린트 지문 재확인).
# 적재기 지문도 막지만 승인 자체를 먼저 막는다
STALE_OPEN = """
UPDATE app.ecat_apply SET status = CASE WHEN status = 'approved' THEN 'previewed' ELSE status END, error = :err
 WHERE kind = 'entity_version' AND ver = :ver AND status IN ('draft', 'previewed', 'approved') RETURNING apply_id"""
REJECT_OPEN = """
UPDATE app.ecat_apply SET status = 'rejected', error = :err
 WHERE kind = 'entity_version' AND ver = :ver AND status IN ('draft', 'previewed', 'approved') RETURNING apply_id"""
QUEUE_OF = """
SELECT j.change_id, j.status, j.payload ->> 'op' AS op, j.requested_at, j.applied_at, j.error
  FROM app.judgment_change j
 WHERE j.kind = 'entity_version' AND j.payload @> CAST(:pl AS jsonb)
 ORDER BY j.change_id DESC LIMIT 20"""
QUEUE_OPEN = """
SELECT j.change_id, j.payload ->> 'op' AS op FROM app.judgment_change j
 WHERE j.kind = 'entity_version' AND j.status IN ('pending', 'running') AND j.payload @> CAST(:pl AS jsonb)
 ORDER BY j.change_id LIMIT 1"""

# ── 검토 대기함 ──
REVIEW_COLS = """r.review_id, r.kind, r.entity_id, r.surface, r.surface_norm, r.display_name, r.entity_type, r.first_seen_at, r.last_seen_at,
       r.n_mentions, r.n_answers, r.status, r.resolved_ver, r.decided_by, r.decided_at, r.note, r.alert_grade, r.alerted_at"""
REVIEWS = f"""
SELECT {REVIEW_COLS} FROM app.ecat_review r
 WHERE (CAST(:status AS text) IS NULL OR r.status = CAST(:status AS text))
   AND (CAST(:kind AS text) IS NULL OR r.kind = CAST(:kind AS text))
   AND (CAST(:q AS text) IS NULL OR r.display_name ILIKE CAST(:q AS text) OR r.surface ILIKE CAST(:q AS text))
   AND (CAST(:before AS int8) IS NULL OR r.review_id < CAST(:before AS int8))
 ORDER BY r.review_id DESC LIMIT :lim"""
REVIEW_FOR_UPDATE = f"SELECT {REVIEW_COLS} FROM app.ecat_review r WHERE r.review_id = :id FOR UPDATE"
DECIDE_REVIEW = """
UPDATE app.ecat_review SET status = :status, resolved_ver = :ver, decided_by = app.actor(), decided_at = now(), note = :note
 WHERE review_id = :id AND status = 'pending' RETURNING review_id"""

# ── 감사 ──
AUDIT_INSERT = """
INSERT INTO app.ecat_audit_log (action, ver, apply_id, review_id, entity_id, surface_id, detail, request_id)
VALUES (:action, :ver, :apply_id, :review_id, CAST(:entity_id AS uuid), :surface_id, CAST(:detail AS jsonb), CAST(:rid AS uuid))
RETURNING audit_id"""
AUDITS = """
SELECT l.audit_id, l.ts, l.actor_id, l.action, l.ver, l.apply_id, l.review_id, l.entity_id, l.surface_id, l.detail, l.request_id
  FROM app.ecat_audit_log l
 WHERE (CAST(:ver AS int4) IS NULL OR l.ver = CAST(:ver AS int4))
   AND (CAST(:apply_id AS int8) IS NULL OR l.apply_id = CAST(:apply_id AS int8))
   AND (CAST(:before AS int8) IS NULL OR l.audit_id < CAST(:before AS int8))
 ORDER BY l.audit_id DESC LIMIT :lim"""

# ── 언급 표본(api_ro·admin_long). 사실 표는 Window.where 3술어로 좁히고, 문서형 뷰는 answer_key 등치(표본 키 목록)로만 읽는다 ──
DIM_ENTITY = """
SELECT e.entity_id, e.entity_type, e.rep_name, e.brand_key, bn.name AS brand_name
  FROM rd.dim_entity e LEFT JOIN rd.dim_brand_name bn ON bn.brand_key = e.brand_key AND e.brand_key <> 0
 WHERE e.entity_id = :id"""
# {w} = Window.where 술어
SAMPLE_KEYS = """
SELECT ab.answer_key, ab.round_date, ab.surface
  FROM rd.answer_brand ab
 WHERE {w} AND ab.brand_key = :bk
 ORDER BY ab.round_date DESC, ab.answer_key DESC
 LIMIT :lim"""
SAMPLE_OCC = """
SELECT o.answer_key, o.ord, o.turn_index, o.source_start, o.source_end, o.surface_text, o.sentiment, o.mention_role, o.context_snippet
  FROM rd.v_answer_occurrence o
 WHERE o.answer_key = ANY(CAST(:keys AS int4[])) AND o.entity_id = :id
 ORDER BY o.answer_key DESC, o.ord"""
SAMPLE_MENTIONS = """
SELECT m.answer_key, m.surfaces, m.mention_count FROM rd.v_answer_mention_raw m
 WHERE m.answer_key = ANY(CAST(:keys AS int4[])) AND m.entity_id = :id"""
SAMPLE_BODIES = "SELECT b.answer_key, b.answer_text FROM rd.v_answer_body b WHERE b.answer_key = ANY(CAST(:keys AS int4[]))"
