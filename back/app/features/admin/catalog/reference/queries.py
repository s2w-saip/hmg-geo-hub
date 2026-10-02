"""admin.catalog.reference 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만(사실 표 없음).

- 택소노미 = 표준 루트 app.prompt 활성 행의 라벨 DISTINCT(현행 listCatalogTaxonomy, lib/db/repositories/standards.ts:394).
- 시장 어휘 = rd.dim_project.regions(표준 루트, Scope getProject 시장 설정의 1:1 투영, DB-v2.4 P05). Scope 직접 호출 금지.
"""

TAXONOMY_SQL = """
SELECT DISTINCT p.brand_code, p.brand_presence, p.list_type, p.depth1, p.depth2, p.depth3, p.depth4
  FROM app.prompt p
  JOIN app.project r ON r.project_id = p.project_id AND r.kind = 'standard_root'
 WHERE p.deleted_at IS NULL
 ORDER BY p.list_type, p.depth1, p.depth2, p.depth3, p.depth4, p.brand_code, p.brand_presence"""

FUNNEL_SQL = """
SELECT DISTINCT p.funnel_stage
  FROM app.prompt p
  JOIN app.project r ON r.project_id = p.project_id AND r.kind = 'standard_root'
 WHERE p.deleted_at IS NULL AND p.funnel_stage IS NOT NULL
 ORDER BY p.funnel_stage"""
