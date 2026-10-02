"""성능 라운드 A6(2026-09-30) 이전 domains_sql 사본: 동치 테스트(test_perf_equiv)의 기준. de720bb 식 그대로(limit=0 도 목록 문장과 같은 CTE).
요청 경로에서 쓰지 않는다."""
from __future__ import annotations

from app.core.cycles import Window
from app.core.filters import ReadContext
from app.core.measure import CATEGORY_EXPR, OVERRIDE_JOIN, citation_where, own_expr
from app.core.pagination import Cursor, keyset_predicate
from app.core.sqlb import Binder, Sql
from app.features.analytics.citations.domains.queries import SortSpec, like_pattern, mention_brand_exists, sort_spec
from app.features.analytics.citations.domains.shared import EFFECTIVE_COMPETITOR


def domains_sql(ctx: ReadContext, win: Window, *, limit: int, cursor: Cursor | None, mention_brand_key: int | None,
                spec: SortSpec | None = None, q: str | None = None, skeys: tuple[str, ...] = (),
                competitor_category_key: int | None = None, competitor_limit: int = 0, competitor_pick: tuple[str, ...] = (),
                answers_den: int = 0) -> Sql:
    """반환 열: summary(json) · competitors(json) · rows(json, 최대 limit+1) · matched(경쟁사 선택·q·skey 적용 행 수, limit=0 이어도 계산)
    · competitor_sources(json|null). answers_den = 커버리지 분모(answers_den_sql 결과): coverage 정렬 키(반올림 천분율)에만 쓴다.
    competitor_limit > 0 이면 유효 카테고리 = competitor_category_key 인 출처를 인용 수 내림차순으로 싣는다(없는 카테고리면 빈 배열).
    잘림 판정용으로 competitor_limit + 1 행까지 싣는다(호출자가 상한으로 자르고 넘친 행이 있으면 잘림 표식).
    competitor_pick 이 있으면 유효 카테고리 = competitor_category_key 인 행 중 고른 skey 만 남기고 다른 카테고리 행은 그대로 둔다
    (현행 applyCompetitorPick). rank 는 이 선택 뒤 번호다(요약·경쟁사 합·옵션은 선택과 무관)."""
    ms = ctx.measure()
    b = Binder("d")
    spec = spec or sort_spec("citations", None)
    own = own_expr(ms, "c", b)
    where = citation_where(ms, win, "c", b)
    if mention_brand_key is not None:
        where.append(mention_brand_exists(win, "c", mention_brand_key, b))
    cat_filter = ""
    if ctx.source_category_keys is not None:           # 출처 단위로 접은 뒤 거르므로 원소 세미조인과 같은 결과(카테고리는 출처 키에 종속)
        cat_filter = f"\n   WHERE {CATEGORY_EXPR} = ANY({b.ints(ctx.source_category_keys)})"
    row_where: list[str] = []
    if q:
        row_where.append(f"r.skey ILIKE {b.v(like_pattern(q), 'text')} ESCAPE '\\'")
    if skeys:
        row_where.append(f"r.skey = ANY({b.v(sorted(set(skeys)), 'text[]')})")
    pick_where = ""
    if competitor_pick and competitor_category_key is not None:     # 공식(경쟁사) 카테고리가 없으면 거를 행도 없다(현행과 같다)
        pick_where = (f" WHERE s.category_key IS DISTINCT FROM {b.v(competitor_category_key, 'int4')}"
                      f" OR s.skey = ANY({b.v(sorted(set(competitor_pick)), 'text[]')})")
    den = f"{b.v(max(int(answers_den), 0), 'int8')}::numeric"
    rows_sql = "'[]'::json"
    matched_sql = "(SELECT count(*) FROM m)"          # 검증 D4: limit=0 이어도 q·skey[]·competitor[] 로 좁힌 행 수
    if limit > 0:
        ks = keyset_predicate(spec.cols, spec.dir, cursor, b)
        rows_sql = (
            f"(SELECT coalesce(json_agg(p ORDER BY {spec.order_by('p')}), '[]'::json) FROM (\n"
            "     SELECT r.skey, r.domain, r.is_social, r.category_key, r.citations, r.own_citations, r.target_citations,\n"
            "            r.citing_answers, r.citing_prompts, r.rank, r.match_rank, r.share_pm, r.coverage_pm, bn.name AS competitor_brand\n"
            "       FROM m r LEFT JOIN rd.dim_brand_name bn ON bn.brand_key = r.competitor_brand_key\n"
            f"      {'WHERE ' + ks if ks else ''}\n"
            f"      ORDER BY {spec.order_by('r')} LIMIT {b.v(limit + 1, 'int4')}) p)")
    comp_sql = "NULL::json"
    if competitor_limit > 0:
        ck = b.v(competitor_category_key if competitor_category_key is not None else -1, "int4")
        comp_sql = (
            "(SELECT coalesce(json_agg(x ORDER BY x.citations DESC, x.skey), '[]'::json) FROM (\n"
            "     SELECT s.skey, s.domain, s.citations, bn.name AS brand\n"
            "       FROM s LEFT JOIN rd.dim_brand_name bn ON bn.brand_key = s.competitor_brand_key\n"
            f"      WHERE s.category_key = {ck}\n"
            f"      ORDER BY s.citations DESC, s.skey LIMIT {b.v(competitor_limit + 1, 'int4')}) x)")
    txt = f"""
WITH g0 AS (
  SELECT c.source_key, c.prompt_key, count(*) AS citations,
         count(*) FILTER (WHERE {own}) AS own_citations,
         count(*) FILTER (WHERE c.tgt_hit) AS target_citations,
         count(*) FILTER (WHERE c.src_first) AS citing_answers
    FROM rd.citation c
   WHERE {' AND '.join(where)}
   GROUP BY c.source_key, c.prompt_key),
g AS MATERIALIZED (
  SELECT g0.source_key, sum(g0.citations)::int8 AS citations, sum(g0.own_citations)::int8 AS own_citations,
         sum(g0.target_citations)::int8 AS target_citations, sum(g0.citing_answers)::int8 AS citing_answers,
         count(*)::int8 AS citing_prompts
    FROM g0 GROUP BY g0.source_key),
s AS MATERIALIZED (
  SELECT g.source_key, g.citations, g.own_citations, g.target_citations, g.citing_answers, g.citing_prompts, ds.skey, ds.domain, ds.is_social,
         {CATEGORY_EXPR} AS category_key, {EFFECTIVE_COMPETITOR} AS competitor_brand_key
    FROM g JOIN rd.dim_source ds ON ds.source_key = g.source_key
    {OVERRIDE_JOIN}{cat_filter}),
t AS (
  SELECT coalesce(sum(s.citations), 0)::numeric AS total FROM s),
r AS (
  SELECT s.*, row_number() OVER (ORDER BY s.citations DESC, s.skey) AS rank,
         CASE WHEN t.total > 0 THEN floor(s.citations * 1000 / t.total + 0.5)::int8 ELSE 0::int8 END AS share_pm,
         CASE WHEN {den} > 0 THEN floor(s.citing_answers * 1000 / {den} + 0.5)::int8 ELSE 0::int8 END AS coverage_pm
    FROM s CROSS JOIN t{pick_where}),
m AS (
  SELECT r.*, row_number() OVER (ORDER BY r.citations DESC, r.skey) AS match_rank FROM r{' WHERE ' + ' AND '.join(row_where) if row_where else ''})
SELECT
  (SELECT json_build_object('citations', coalesce(sum(s.citations), 0), 'own', coalesce(sum(s.own_citations), 0), 'sources', count(*))
     FROM s) AS summary,
  (SELECT coalesce(json_agg(json_build_object('brand', bn.name, 'citations', x.citations, 'sources', x.sources)
                            ORDER BY x.citations DESC, bn.name), '[]'::json)
     FROM (SELECT s.competitor_brand_key, sum(s.citations) AS citations, count(*) AS sources
             FROM s WHERE s.competitor_brand_key IS NOT NULL GROUP BY s.competitor_brand_key) x
     JOIN rd.dim_brand_name bn ON bn.brand_key = x.competitor_brand_key) AS competitors,
  {rows_sql} AS rows,
  {matched_sql} AS matched,
  {comp_sql} AS competitor_sources
"""
    return b.sql(txt)
