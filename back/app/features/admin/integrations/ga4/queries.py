"""admin.integrations.ga4 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

GA4 행(rd.ga4_row)은 표면·회차 축이 없는 외부 데이터 표다(RANGE(date) 파티션): prop_key 등치 + date 상수 범위로 가지치기한다.
app.ga4_property·app.ga4_tracked_event 는 설정 원본(쓰기 api_rw), 적재 반영(rd.ga4_dim_property·is_conv)은 적재기.
"""

TODAY_SQL = "SELECT rd.today_kst() AS today"

# app 만 읽는다(쓰기 트랜잭션 api_rw 에서도 같은 문장으로 응답을 만든다: api_rw 는 rd 권한 없음). rd 투영은 DIMS_SQL(api_ro).
LIST_SQL = """
SELECT g.property_id, g.brand_code, g.country_code, g.status, g.verified_at, g.updated_by, u.email::text AS updated_by_email, g.updated_at,
       (SELECT count(*) FROM app.ga4_tracked_event t WHERE t.property_id = g.property_id)::int AS tracked_events,
       coalesce((SELECT json_agg(json_build_object('project_id', p.project_id, 'name', p.name, 'brand_code', p.brand_code,
                                                   'country_code', p.country_code) ORDER BY p.name, p.project_id)
                   FROM app.project p WHERE p.ga4_property_id = g.property_id), '[]') AS project_overrides
  FROM app.ga4_property g
  LEFT JOIN app.user_account u ON u.user_id = g.updated_by
 WHERE (CAST(:pid AS text) IS NULL OR g.property_id = CAST(:pid AS text))
   AND (CAST(:brand AS text) IS NULL OR g.brand_code = CAST(:brand AS text))
   AND (CAST(:country AS text) IS NULL OR g.country_code = CAST(:country AS text))
   AND (CAST(:status AS text) IS NULL OR g.status = CAST(:status AS text))
 ORDER BY g.brand_code NULLS LAST, g.country_code NULLS LAST, g.property_id
"""

# 프로젝트 직접 지정 전체(BG-43, 현행 ga4/page.tsx:53-61 = projectRepository.listAll 중 ga4PropertyId 있는 것, createdAt DESC).
# 레지스트리(app.ga4_property)에 없는 속성을 지정한 프로젝트도 포함한다(registered 거짓). app 만 읽는다.
# (created_at, project_id) DESC 키셋. {keyset} = core.pagination.keyset_predicate 조각 또는 true. 페이지 상한 = core.pagination.MAX_LIMIT.
PROJECT_OVERRIDES_SQL = """
SELECT p.project_id, p.name, p.kind, p.brand_code, p.country_code, p.ga4_property_id AS property_id, p.created_at,
       g.property_id IS NOT NULL AS registered, g.status AS property_status
  FROM app.project p
  LEFT JOIN app.ga4_property g ON g.property_id = p.ga4_property_id
 WHERE p.ga4_property_id IS NOT NULL AND p.ga4_property_id <> ''
   AND (CAST(:pid AS text) IS NULL OR p.ga4_property_id = CAST(:pid AS text))
   AND (CAST(:registered AS bool) IS NULL OR (g.property_id IS NOT NULL) = CAST(:registered AS bool))
   AND {keyset}
 ORDER BY p.created_at DESC, p.project_id DESC
 LIMIT CAST(:lim AS int4)
"""

PENDING_SQL = """
SELECT j.change_id, j.kind, j.status, j.requested_at, j.subject_texts
  FROM app.judgment_change j
 WHERE j.status IN ('pending', 'running') AND j.kind IN ('ga4_property', 'ga4_tracked_event')
   AND j.subject_texts && CAST(:pids AS text[])
 ORDER BY j.change_id
"""

DIMS_SQL = "SELECT property_id, prop_key, conv_basis FROM rd.ga4_dim_property WHERE property_id = ANY(CAST(:pids AS text[]))"

# 이벤트 × 창 eventCount 합(events 보고서 = report 3, 이벤트 키 0 = 빈 값 제외)
EVENT_COUNTS_SQL = """
SELECT v.value AS event_name, sum(r.event_count)::bigint AS cnt
  FROM rd.ga4_row r
  JOIN rd.ga4_dim_value v ON v.kind = 'event' AND v.value_key = r.event_key
 WHERE r.prop_key = CAST(:pk AS int2) AND r.report = 3 AND r.date BETWEEN CAST(:lo AS date) AND CAST(:hi AS date)
   AND r.event_key <> 0
 GROUP BY v.value
"""

# ── 쓰기(api_rw, app 만) ──
PROP_LOCK_SQL = "SELECT property_id, brand_code, country_code, status FROM app.ga4_property WHERE property_id = :pid FOR UPDATE"
PROP_SQL = "SELECT property_id FROM app.ga4_property WHERE property_id = :pid"
MARKET_TAKEN_SQL = """
SELECT property_id FROM app.ga4_property
 WHERE brand_code = :brand AND country_code = :country AND property_id <> :pid LIMIT 1
"""
# verified_at(DB-v2.9 P60): verify 성공이면 now(), 아니면 기존 값 유지(현행 verifyGa4Mapping 만 갱신, upsertGa4Mapping 은 건드리지 않음:
# 매핑이 바뀌어도 초기화하지 않는다)
UPSERT_SQL = """
INSERT INTO app.ga4_property (property_id, brand_code, country_code, status, verified_at, updated_by, updated_at)
VALUES (:pid, :brand, :country, :status, CASE WHEN CAST(:verified AS bool) THEN now() END, app.actor(), now())
ON CONFLICT (property_id) DO UPDATE SET brand_code = EXCLUDED.brand_code, country_code = EXCLUDED.country_code,
       status = EXCLUDED.status, verified_at = coalesce(EXCLUDED.verified_at, app.ga4_property.verified_at),
       updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
"""
OVERRIDE_COUNT_SQL = "SELECT count(*)::int AS n FROM app.project WHERE ga4_property_id = :pid"
DELETE_EVENTS_SQL = "DELETE FROM app.ga4_tracked_event WHERE property_id = :pid RETURNING event_name"
DELETE_PROP_SQL = "DELETE FROM app.ga4_property WHERE property_id = :pid RETURNING property_id, brand_code, country_code, status"
TRACKED_SQL = "SELECT event_name FROM app.ga4_tracked_event WHERE property_id = :pid ORDER BY event_name"
INSERT_EVENTS_SQL = """
INSERT INTO app.ga4_tracked_event (property_id, event_name, updated_by, updated_at)
SELECT :pid, e, app.actor(), now() FROM unnest(CAST(:names AS text[])) e
"""

# ── 속성 없는 시장(app.ga4_market_pending, DB-v2.9 P61) ──
# 같은 시장을 두고 속성 매핑(PUT properties)과 대기 등록(PUT markets)이 경합하지 않게 시장 단위 트랜잭션 잠금을 먼저 잡는다
MARKET_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtextextended('hgh.ga4.market:' || CAST(:brand AS text) || ':' || CAST(:country AS text), 0))"
MARKETS_SQL = """
SELECT m.brand_code, m.country_code, m.note, m.updated_by, u.email::text AS updated_by_email, m.updated_at
  FROM app.ga4_market_pending m
  LEFT JOIN app.user_account u ON u.user_id = m.updated_by
 WHERE (CAST(:brand AS text) IS NULL OR m.brand_code = CAST(:brand AS text))
   AND (CAST(:country AS text) IS NULL OR m.country_code = CAST(:country AS text))
 ORDER BY m.brand_code, m.country_code
"""
MARKET_MAPPED_SQL = "SELECT property_id FROM app.ga4_property WHERE brand_code = :brand AND country_code = :country ORDER BY property_id LIMIT 1"
MARKET_UPSERT_SQL = """
INSERT INTO app.ga4_market_pending (brand_code, country_code, note, updated_by, updated_at)
VALUES (:brand, :country, :note, app.actor(), now())
ON CONFLICT (brand_code, country_code) DO UPDATE SET note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at
RETURNING (xmax = 0) AS created
"""
MARKET_DELETE_SQL = "DELETE FROM app.ga4_market_pending WHERE brand_code = :brand AND country_code = :country RETURNING brand_code"
