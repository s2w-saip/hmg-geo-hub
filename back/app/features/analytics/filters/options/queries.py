"""analytics.filters.options 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

사실 표(rd.answer·rd.citation) 질의는 core 빌더만으로 WHERE 를 만든다: Window.where(창 3술어) + measure.scope_where(스코프 축)
+ measure.citation_where(인용 계열). 비트 식(cat_mask 전개·브랜드 교집합)은 SQL 에 두지 않고 결과 소집합에서 파이썬으로 한다(계약서 §3).
"""
from __future__ import annotations

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.measure import CATEGORY_EXPR, OVERRIDE_JOIN, MeasureScope, citation_where, scope_where
from app.core.sqlb import Binder, Sql


def matrix_sql(ms: MeasureScope, win: Window) -> Sql:
    """옵션 창(row 계열: 전체 숨김 {1}만 배제) 안 측정 조합. 1단계 GROUP BY 로 수백 행 소집합을 만든다.
    모수 = cit_in(언급 모수 std_in ⊇ 가 아니라 그 상위 집합: 옵션 ⊇ 데이터, 모듈-필터 §2.2)."""
    b = Binder()
    where = win.where("a", "row", b) + scope_where(ms, "a", b) + ["a.cit_in"]
    return b.sql(f"SELECT a.project_key, a.geo_key, a.lang_key, a.cat_mask, a.engine_key FROM {fact_tables(ms).answer} a "
                 f"WHERE {' AND '.join(where)} GROUP BY 1, 2, 3, 4, 5")


def legacy_global_sql(ms: MeasureScope, win: Window) -> Sql:
    """현행 프로필 filter_options(F1W4, WU-8) 글로벌 옵션 소집합. 현행 hmg-geo 2670a16 + read_screens 14키(축 on) 규칙:
    - 국가 목록 listMeasuredRegions(scope-aggregates.ts:7698, rootScoped·dateRange): 루트 카탈로그 게이트(:7746) ∧ 옵션 창
      optionAnchorJobClause(:2073-2088 = 회차 창 + 기본 엔진 anchorDefaultEngineScope :1943·:2033) ∧ 숨김 지역 ∧ 스코프. **답변 상태 술어가
      없고**(실패·진행 중 답변만 있는 국가도 나온다) 지역 스코핑(rootRegionScopingPreds: 한국어 비-KR·시장 태그, run 상태)도 없다.
    - 매트릭스 listMeasuredScopeMatrix(:7846): 같은 창·게이트 + a.status = 'completed'(:7856).
    그래서 원천은 rd.answer(elig = 지역 스코핑·run 상태 포함)가 아니라 rd.job(모든 status)이다. served(= completed ∧ 운영자 드롭 아님)로
    매트릭스 행을 가른다. 운영자 드롭(ing.answer_drop)은 현행 앵커 표에서도 빠지므로 둘 다 뺀다. 엔진은 호출자가 기본 엔진 키로 넘긴다."""
    b = Binder()
    where = win.where("j", "row", b) + scope_where(ms, "j", b, dflt_column=False) + [
        "NOT j.dropped",
        f"EXISTS (SELECT 1 FROM {fact_tables(ms).prompt} p WHERE p.prompt_key = j.prompt_key AND p.in_root_catalog)"]
    return b.sql("SELECT j.project_key, j.geo_key, j.lang_key, j.bgrp AS cat_mask, j.engine_key, bool_or(j.status_code = 0) AS served "
                 f"FROM rd.job j WHERE {' AND '.join(where)} GROUP BY 1, 2, 3, 4, 5")


# 현행 프로필 filter_options(F1W4, WU-8) 웹사이트: 등록 사이트(app.website_site)와 그 프롬프트 언어(app.website_prompt). 측정 창 무관.
# 현행 website-sites.ts listWebsiteCountries(:258-281, website_sites DISTINCT country_code)·listWebsiteScopeMatrix(:216-254,
# website_prompts ⋈ website_sites DISTINCT brand·country·lang_code)·listMeasuredLanguages(:176-197). 스코프(관점 브랜드 비트·스코프 국가)는
# 서비스가 건다(ReadContext.bgrps·DataScope.site_allowed: 카탈로그 _scoped_sites 와 같은 판정).
LEGACY_WEBSITE_SITES_SQL = """
SELECT ws.site_id::text AS site_id, ws.scope_project_id::text AS scope_project_id, ws.brand_code, ws.country_code, br.brand_bit
  FROM app.website_site ws JOIN app.brand br ON br.brand_code = ws.brand_code
 WHERE br.brand_bit = ANY(CAST(:bits AS int2[]))
"""
LEGACY_WEBSITE_LANGS_SQL = """
SELECT DISTINCT wp.site_id::text AS site_id, wp.lang_code
  FROM app.website_prompt wp
 WHERE wp.site_id = ANY(CAST(:ids AS uuid[]))
"""

# 위 두 표(app.website_site·app.website_prompt)는 결과 캐시 추적 표(DB-v2.11 P67 트리거)가 아니다. 켜짐 + website 요청은 끝점 추가 키
# (router key_deps "legacy_web")로 이 지문을 캐시 키에 싣는다: 요청마다 같은 스냅샷에서 다시 읽으므로 두 표가 바뀌면 곧바로 미스다.
LEGACY_WEBSITE_VERSION_SQL = """
SELECT md5(coalesce(string_agg(x, '|' ORDER BY x), '')) AS v
  FROM (SELECT concat_ws(',', 's', ws.site_id, ws.scope_project_id, ws.brand_code, ws.country_code) FROM app.website_site ws
        UNION ALL
        SELECT DISTINCT concat_ws(',', 'p', wp.site_id, wp.lang_code) FROM app.website_prompt wp) t(x)
"""

def source_categories_sql(ms: MeasureScope, win: Window) -> Sql:
    """인용 원소가 있는 출처 카테고리(인용 계열 숨김 배제·cit_in·호스트 있는 인용).
    카테고리 = 유효 카테고리(core CATEGORY_EXPR: 운영자 오버라이드 우선, source[] 데이터 축과 같은 해석).
    형태(WU-12 성능, 결과 동일): 창 안 인용의 DISTINCT source_key 를 먼저 접고(병렬 HashAggregate, 1년 창 약 4만 행) 그 집합만 dim_source·
    오버라이드와 잇는다. 종전 카테고리별 EXISTS 는 플래너가 세미조인으로 풀어 인용 전 행(1년 창 약 210만)을 dim_source 와 먼저 잇느라
    stg hmg_r2 커스텀 계획 기준 C05 1,315ms → 338ms, C11 1,136ms → 285ms, 스냅샷 670ms → 203ms 였다(13 카테고리 집합 동일)."""
    b = Binder()
    where = citation_where(ms, win, "c", b)
    return b.sql("SELECT cc.slug, cc.name, cc.ord FROM app.citation_category cc WHERE cc.category_key IN ("
                 f"SELECT {CATEGORY_EXPR} FROM (SELECT DISTINCT c.source_key FROM {fact_tables(ms).citation} c WHERE {' AND '.join(where)}) s "
                 f"JOIN rd.dim_source ds ON ds.source_key = s.source_key {OVERRIDE_JOIN}) ORDER BY cc.ord, cc.slug")

# 카탈로그 택소노미(global): 루트 카탈로그 rd.catalog_entry. dim_prompt 와 조인하지 않는다(prompt_key NULL 행 보존). 측정 창 무관.
# depth4(BG-03)는 rd.dim_taxon 축이 아니라 원본 행(app.prompt.depth4, catalog_row_id = prompt_id)에서 읽는다(분석 축 해석과 같은 원천).
CATALOG_GLOBAL_SQL = """
SELECT ce.brand_bit, ce.funnel_key, ce.presence_key, ce.list_type_key, ce.depth1_key, ce.depth2_key, ce.depth3_key, p.depth4
  FROM rd.catalog_entry ce
  LEFT JOIN app.prompt p ON p.prompt_id = ce.catalog_row_id
 WHERE ce.brand_bit = ANY(CAST(:bits AS int2[]))
 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
"""

TAXON_SQL = "SELECT taxon_key, axis, code, parent_key FROM rd.dim_taxon"

# 카탈로그 택소노미(project): 그 프로젝트 프롬프트의 실제 값(현행 listCatalogTaxonomy(projectId), standards.ts:394). 측정 창 무관.
CATALOG_PROJECT_SQL = """
SELECT p.brand_code, p.funnel_stage, p.brand_presence, p.list_type, p.depth1, p.depth2, p.depth3, p.depth4
  FROM app.prompt p
 WHERE p.project_id = :pid AND p.deleted_at IS NULL
 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
"""

# 프로젝트 커스텀 필드(보관 제외)와 살아 있는 프롬프트에 붙은 값. 필드 순서 = 생성 순(BG-47: 현행 project-custom-fields.ts:19
# orderBy(createdAt), 프롬프트 필드 목록 GET /v1/projects/{id}/prompt-fields 와 같은 created_at, field_id).
CUSTOM_FIELDS_SQL = """
SELECT f.field_id::text AS field_id, f.label,
       coalesce((SELECT array_agg(DISTINCT v.value ORDER BY v.value)
                   FROM app.prompt_custom_field_value v
                   JOIN app.prompt p ON p.prompt_id = v.prompt_id AND p.deleted_at IS NULL
                  WHERE v.field_id = f.field_id), '{}') AS vals
  FROM app.project_custom_field f
 WHERE f.project_id = :pid AND NOT f.archived
 ORDER BY f.created_at, f.field_id
"""
