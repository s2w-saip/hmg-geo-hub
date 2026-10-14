"""analytics.answers.detail 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

- 헤더 = rd.job(job_id UNIQUE) ⋈ rd.cycle 에 노출(R03)·숨김 all(R04)·served·스코프 게이트를 WHERE 로 건다(실패는 전부 404).
- 번들 = 한 문장(스칼라 서브쿼리 json_agg). 사실 표는 헤더의 (surface, round_date, cyc_key) 상수 3술어 + answer_key 등치(PK 프리픽스),
  문서형 뷰(rd.v_answer_*)는 answer_key 등치 + 스코프 열(surface·project_key) 재단언. ing 는 뷰로만 닿는다(A17).
- 숨김 계열(언급·인용)은 그 부분 서브쿼리를 아예 싣지 않는다(NULL): 숨김 데이터를 읽지 않는다.
- lite(답변 모달): 모달이 쓰지 않는 값(카탈로그 서브쿼리·cycle_id·anchor_date·model_slug·is_rep·acr_iter_rank·인용 owned·target_hit)을
  계산하지 않고 NULL 로 싣는다. 게이트 술어·나머지 값은 lite 와 무관하게 같다.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date

from app.core.codes import HIDDEN_EXCLUDE
from app.core.facts import fact_tables
from app.core.measure import MeasureScope, own_expr
from app.core.sqlb import Binder, Sql

# 1단계: 표면·프로젝트만(스코프 계산 입력). 응답에 싣지 않는다.
LOCATE_SQL = """
SELECT j.surface, d.project_id FROM rd.job j JOIN rd.dim_project d ON d.project_key = j.project_key WHERE j.job_id = :jid"""


def header_sql(job_id: str, project_keys: tuple[int, ...], bgrps: tuple[int, ...] | None, geo_keys: tuple[int, ...] | None,
               *, lite: bool = False) -> Sql:
    """2단계: 노출·숨김·served·스코프 게이트를 건 헤더. 없으면 404(존재·권한·노출 실패를 구분하지 않는다).
    lite = cycle_id·anchor_date 를 싣지 않는다(NULL, 게이트 술어는 같다)."""
    b = Binder()
    w = [f"j.job_id = {b.v(job_id, 'uuid')}", "j.served", "c.servable", "c.view_date IS NOT NULL", "c.view_date <= rd.today_kst()",
         f"NOT (c.hidden_scope = ANY({b.ints(HIDDEN_EXCLUDE['row'])}))",
         f"j.project_key = ANY({b.ints(project_keys)})"]
    if bgrps is not None:
        w.append(f"j.bgrp = ANY({b.ints(bgrps)})")
    if geo_keys is not None:
        w.append(f"j.geo_key = ANY({b.ints(geo_keys)})")
    meta = "NULL::uuid AS cycle_id, NULL::date AS anchor_date" if lite else "c.cycle_id, c.anchor_date"
    return b.sql(
        "SELECT j.answer_key, j.job_id, j.surface, j.project_key, j.cyc_key, j.round_date, j.measured_at, j.engine_key, j.geo_key,\n"
        f"       j.lang_key, j.prompt_key, {meta}, c.hidden_scope,\n"
        "       (SELECT g.generation FROM rd.surface_generation g WHERE g.surface = j.surface) AS generation\n"
        "  FROM rd.job j JOIN rd.cycle c ON c.cyc_key = j.cyc_key\n WHERE " + "\n   AND ".join(w))


@dataclass(frozen=True)
class BundleInput:
    answer_key: int
    sf: int
    project_key: int
    round_date: date
    cyc_key: int
    prompt_key: int
    with_catalog: bool
    with_mentions: bool
    with_citations: bool
    lite: bool = False          # 모달이 쓰지 않는 값(is_rep·acr_iter_rank·model_slug·인용 owned·target_hit)을 NULL 로. 카탈로그는 with_catalog 로 끈다


def _fact(b: Binder, alias: str, x: BundleInput) -> str:
    """사실 표 3술어(상수) + answer_key 등치."""
    return (f"{alias}.surface = {b.v(x.sf, 'int2')} AND {alias}.round_date = {b.date(x.round_date)} "
            f"AND {alias}.cyc_key = ANY({b.ints((x.cyc_key,), 'int4')}) AND {alias}.answer_key = {b.v(x.answer_key, 'int4')}")


def _view(b: Binder, alias: str, x: BundleInput) -> str:
    """문서형 뷰: answer_key 등치 + 스코프 열 재단언(fail-closed)."""
    return (f"{alias}.answer_key = {b.v(x.answer_key, 'int4')} AND {alias}.surface = {b.v(x.sf, 'int2')} "
            f"AND {alias}.project_key = {b.v(x.project_key, 'int2')}")


def bundle_sql(x: BundleInput, ms: MeasureScope) -> Sql:
    b = Binder()
    parts: list[str] = []
    parts.append(
        "(SELECT json_build_object('prompt_id', p.prompt_id, 'text', p.text, 'kind', p.kind,\n"
        "        'funnel', (SELECT t.code FROM rd.dim_taxon t WHERE t.taxon_key = p.funnel_key AND t.axis = 'funnel'))\n"
        f"   FROM {fact_tables(ms).prompt} p WHERE p.prompt_key = {b.v(x.prompt_key, 'int4')}) AS prompt")
    if x.with_catalog:
        parts.append(
            "(SELECT coalesce(json_agg(json_build_object('brand_bit', ce.brand_bit, 'presence', tp.code, 'list_type', tl.code,\n"
            "        'depth1', t1.code, 'depth2', t2.code, 'depth3', t3.code) ORDER BY ce.brand_bit), '[]')\n"
            "   FROM rd.catalog_entry ce\n"
            "   LEFT JOIN rd.dim_taxon tp ON tp.taxon_key = ce.presence_key LEFT JOIN rd.dim_taxon tl ON tl.taxon_key = ce.list_type_key\n"
            "   LEFT JOIN rd.dim_taxon t1 ON t1.taxon_key = ce.depth1_key LEFT JOIN rd.dim_taxon t2 ON t2.taxon_key = ce.depth2_key\n"
            "   LEFT JOIN rd.dim_taxon t3 ON t3.taxon_key = ce.depth3_key\n"
            f"  WHERE ce.prompt_key = {b.v(x.prompt_key, 'int4')}) AS catalog")
    else:
        parts.append("NULL::json AS catalog")
    rep = "NULL, 'acr_iter_rank', NULL" if x.lite else "a.is_rep,\n        'acr_iter_rank', a.acr_iter_rank"
    parts.append(
        f"(SELECT json_build_object('analysis_state', a.analysis_state, 'gap', a.gap, 'is_acr', a.is_acr, 'is_rep', {rep})\n"
        f"   FROM {fact_tables(ms).answer} a WHERE {_fact(b, 'a', x)}) AS answer")
    slug = "NULL" if x.lite else "v.model_slug"
    parts.append(
        f"(SELECT json_build_object('answer_text', v.answer_text, 'model_slug', {slug})\n"
        f"   FROM rd.v_answer_body v WHERE {_view(b, 'v', x)}) AS body")
    if x.with_mentions:
        parts.append(
            "(SELECT coalesce(json_agg(json_build_object('name', bn.name, 'own_bit', ab.own_bit, 'competitive', ab.competitive,\n"
            "        'mention_count', ab.mention_count, 'rk', ab.rk) ORDER BY ab.brand_key, ab.competitive), '[]')\n"
            f"   FROM {fact_tables(ms).answer_brand} ab JOIN rd.dim_brand_name bn ON bn.brand_key = ab.brand_key\n"
            f"  WHERE {_fact(b, 'ab', x)}) AS brands")
        parts.append(
            "(SELECT coalesce(json_agg(json_build_object('entity_id', m.entity_id, 'name', m.display_name, 'entity_type', m.entity_type,\n"
            "        'mention_count', m.mention_count, 'avg_position', m.avg_position, 'rollup_id', m.brand_rollup_entity_id,\n"
            "        'own_bit', ebn.own_bit, 'brand', ebn.name, 'rollup_own_bit', rbn.own_bit, 'rollup_brand', rbn.name) ORDER BY m.ord), '[]')\n"
            "   FROM rd.v_answer_mention_raw m\n"
            "   LEFT JOIN rd.dim_entity ee ON ee.entity_key = m.entity_key LEFT JOIN rd.dim_brand_name ebn ON ebn.brand_key = ee.brand_key\n"
            "   LEFT JOIN rd.dim_entity re ON re.entity_id = m.brand_rollup_entity_id LEFT JOIN rd.dim_brand_name rbn ON rbn.brand_key = re.brand_key\n"
            f"  WHERE {_view(b, 'm', x)}) AS mention_raw")
        parts.append(
            "(SELECT coalesce(json_agg(json_build_object('entity_id', o.entity_id, 'turn_index', o.turn_index, 'source_start', o.source_start,\n"
            "        'source_end', o.source_end, 'surface_text', o.surface_text, 'sentiment', o.sentiment, 'assertion', o.assertion,\n"
            "        'context_snippet', o.context_snippet, 'descriptors', o.descriptors, 'criteria', o.criteria,\n"
            "        'own_bit', obn.own_bit, 'brand', obn.name) ORDER BY o.turn_index, o.source_start, o.ord), '[]')\n"
            "   FROM rd.v_answer_occurrence o\n"
            "   LEFT JOIN rd.dim_entity oe ON oe.entity_id = o.entity_id LEFT JOIN rd.dim_brand_name obn ON obn.brand_key = oe.brand_key\n"
            f"  WHERE {_view(b, 'o', x)}) AS occurrences")
        # 스탠스: 근거 대조에 판정 원문(evidence_text·confidence·reason)이 필요해 같은 그레인의 문서형 뷰 + 엔티티 → 정본 브랜드(own_bit)
        #   차원으로 읽는다(rd.answer_stance 는 판정 코드만 투영한다. DB-v2.5 로 cyc_key 가 생겨 집계 경로(M-2)는 사실 표를 쓴다).
        parts.append(
            "(SELECT coalesce(json_agg(json_build_object('turn_index', r.turn_index, 'entity_id', r.entity_id, 'own_bit', bn.own_bit,\n"
            "        'stance', r.stance, 'brand', bn.name, 'brand_label', r.brand_label, 'confidence', r.confidence,\n"
            "        'evidence_text', r.evidence_text, 'evidence_start', r.evidence_start, 'evidence_end', r.evidence_end,\n"
            "        'reason', r.reason)), '[]')\n"
            "   FROM rd.v_answer_stance_raw r\n"
            "   LEFT JOIN rd.dim_entity e ON e.entity_id = r.entity_id\n"
            "   LEFT JOIN rd.dim_brand_name bn ON bn.brand_key = e.brand_key AND e.brand_key <> 0\n"
            f"  WHERE {_view(b, 'r', x)}) AS stances")
    else:
        parts += ["NULL::json AS brands", "NULL::json AS mention_raw", "NULL::json AS occurrences", "NULL::json AS stances"]
    if x.with_citations:
        owned = "NULL, 'target_hit', NULL" if x.lite else f"{own_expr(ms, 'c', b)}, 'target_hit', c.tgt_hit"
        parts.append(
            "(SELECT coalesce(json_agg(json_build_object('ord', c.ord, 'url', u.url, 'title', u.title, 'domain', nullif(u.domain, ''),\n"
            f"        'category', cc.slug, 'owned', {owned}) ORDER BY c.ord), '[]')\n"
            f"   FROM {fact_tables(ms).citation} c JOIN rd.dim_url u ON u.url_key = c.url_key\n"
            "   LEFT JOIN rd.dim_source sc ON sc.source_key = c.source_key LEFT JOIN app.citation_category cc ON cc.category_key = sc.category_key\n"
            f"  WHERE {_fact(b, 'c', x)}) AS citations")
    else:
        parts.append("NULL::json AS citations")
    return b.sql("SELECT " + ",\n       ".join(parts))
