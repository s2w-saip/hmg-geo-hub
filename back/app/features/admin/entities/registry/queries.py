"""admin.entities.registry SQL(SQLAlchemy Core text). 읽기 rd·app, 쓰기 app.entity_registry(api_rw).

- 목록 행 = rd.dim_entity(entity_type='Brand') ∪ 레지스트리에만 있는(또는 Brand 가 아닌) 등재 엔티티(현행 listDiscoveredBrands 동작 보존).
- 유효 귀속(own_brand)은 SQL 이 아니라 service 가 페이지 행에 붙인다(versions.service.active_own_brands = 드로어와 같은 RollupRule 판정).
  차원 표시 브랜드(rd.dim_entity.brand_key)만 보면 덮어쓰기(원본 쌍만 반영)·제거가 빠진다(검증 5차 CE25).
- 수치 = rd.entity_mention_total(엔티티별 전 기간 합계, 운영 listDiscoveredBrands 정의, DB-v2.25 P132). 표시 브랜드 단위(G-23 a)·창·게이트는
  쓰지 않는다(5차 항목 1, 결정 25 현행 재현). 동적 조립이라 여기엔 조각만 둔다.
"""

PROJECT_KEYS_SQL = "SELECT project_key FROM rd.dim_project WHERE surface = :sf ORDER BY project_key"

# {outer} = 역할·검색·키셋 술어, {order}·{limit} = 정렬·한도.
# 수치 = rd.entity_mention_total(엔티티별 전 기간 합계, 운영 hmg-geo 2670a16 listDiscoveredBrands 정의: entity-registry.ts:118-136
# scope_mentions entity_type='Brand' ∧ brand(표시명) 있음, entity_id 별 count(DISTINCT job_id)·sum(mention_count), 기간·게이트 없음,
# 드롭 답변 제외). 같은 표시 브랜드로 묶이는 엔티티도 각자 값이다(5차 항목 1, 결정 25). 집계 없음(PK 조회) = 대형 엔티티와 무관.
LIST_TEMPLATE = """
WITH ents AS (
  SELECT e.entity_id, e.entity_type, coalesce(r.name, e.rep_name, '') AS name, e.brand_key,
         coalesce(r.role, 'competitor') AS role, r.brand_code, (r.entity_id IS NOT NULL) AS registered, r.updated_at
    FROM rd.dim_entity e
    LEFT JOIN app.entity_registry r ON r.entity_id = e.entity_id
   WHERE e.entity_type = 'Brand'
  UNION ALL
  SELECT r.entity_id, e.entity_type, r.name, e.brand_key, r.role, r.brand_code, true, r.updated_at
    FROM app.entity_registry r
    LEFT JOIN rd.dim_entity e ON e.entity_id = r.entity_id
   WHERE e.entity_type IS DISTINCT FROM 'Brand'),
x AS (
  SELECT ents.entity_id, ents.entity_type, ents.name, bn.name AS brand_name, ents.role, ents.brand_code, ents.registered,
         ents.updated_at, coalesce(t.answers, 0)::int8 AS answers, coalesce(t.mentions, 0)::int8 AS mentions
    FROM ents
    LEFT JOIN rd.dim_brand_name bn ON bn.brand_key = ents.brand_key AND ents.brand_key <> 0
    LEFT JOIN rd.entity_mention_total t ON t.entity_id = ents.entity_id)
SELECT x.*, left(x.name, 256) AS name_key
  FROM x
 WHERE {outer}
 ORDER BY {order}
 LIMIT {limit}"""

SORTS = {
    "answers_desc": (("x.answers", "x.entity_id"), "desc", ("int8", "uuid"), ("answers", "entity_id")),
    "name_asc": (("left(x.name, 256)", "x.entity_id"), "asc", ("text", "uuid"), ("name_key", "entity_id")),
}

DIM_ENTITY_SQL = "SELECT entity_id, entity_type, rep_name FROM rd.dim_entity WHERE entity_id = :id"

LOCK_REGISTRY_SQL = "SELECT entity_id, name, role, brand_code FROM app.entity_registry WHERE entity_id = :id FOR UPDATE"

UPSERT_SQL = """
INSERT INTO app.entity_registry AS r (entity_id, name, role, brand_code, updated_by, updated_at)
VALUES (:id, :name, :role, :brand_code, app.actor(), now())
ON CONFLICT (entity_id) DO UPDATE SET name = EXCLUDED.name, role = EXCLUDED.role, brand_code = EXCLUDED.brand_code,
                                      updated_by = EXCLUDED.updated_by, updated_at = now()
RETURNING r.entity_id"""

ACTIVE_ECAT_SQL = "SELECT ver FROM app.ecat_version WHERE status = 'active'"   # DB-v2.17 P94(컷오버 뒤 PUT 거부)

DELETE_SQL = "DELETE FROM app.entity_registry r WHERE r.entity_id = :id RETURNING r.entity_id"
