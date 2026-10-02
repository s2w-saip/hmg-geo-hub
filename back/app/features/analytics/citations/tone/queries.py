"""analytics.citations.tone 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

한 문장: rd.citation ⋈ rd.answer(PK 등치, 같은 창 3술어) 에서 한 톤만 WHERE 로 남기고 url_key 또는 source_key 로 접는다 →
차원 조인(URL·출처·오버라이드·프롬프트) → 검색 q(집계 뒤 좁혀진 행에만) → 키셋 페이지 + 전체 행 수.
정렬 = 인용 수 내림차순, 동률은 url 모드 url_hash(16진), source 모드 skey. 키셋은 (-citations, 키) 오름차순 행 값 비교.
BG-27 탭 카운트(with_counts): 두 톤의 DISTINCT 인용 URL 수를 한 문장으로(/sources tone 타일 urls 와 같은 모집단·식, 검색 q 무관).
"""
from __future__ import annotations

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.filters import ReadContext
from app.core.measure import CATEGORY_EXPR, OVERRIDE_JOIN, citation_where, tone_expr
from app.core.pagination import Cursor, keyset_predicate
from app.core.sqlb import Binder, Sql
from app.features.analytics.citations.domains.shared import FAMILY

SORT_COLS = ("(-j.citations)", "j.k")
# 현행 citationDisplayUrlSql(scope-aggregates.ts:11413) 과 같은 문자열: 프래그먼트 제거 + 앞머리 http(s):// 제거(대소문자 구분)
DISPLAY_URL = "regexp_replace(split_part(du.url, '#', 1), '^https?://', '')"


def tone_rows_sql(ctx: ReadContext, win: Window, *, tone: str, group_by: str, q: str | None, limit: int, cursor: Cursor | None) -> Sql:
    ms = ctx.measure()
    b = Binder("r")
    pos, neg = tone_expr(ctx.own_bits, "a")
    where = (citation_where(ms, win, "c", b) + win.where("a", FAMILY, b)
             + ["a.answer_key = c.answer_key", pos if tone == "positive" else neg])
    gk = "c.url_key" if group_by == "url" else "c.source_key"
    if group_by == "url":
        dims = (f"SELECT t.citations, t.engines, t.prompt_key, encode(du.url_hash, 'hex') AS k, {DISPLAY_URL} AS display, du.url, du.title,\n"
                f"         ds.skey, ds.domain, {CATEGORY_EXPR} AS category_key\n"
                "    FROM t JOIN rd.dim_url du ON du.url_key = t.gk\n"
                "    JOIN rd.dim_source ds ON ds.source_key = du.source_key\n"
                f"    {OVERRIDE_JOIN}")
        search = f"{DISPLAY_URL} ILIKE {b.v('%' + q + '%')}" if q else ""
    else:
        dims = (f"SELECT t.citations, t.engines, t.prompt_key, ds.skey AS k, ds.skey AS display, NULL::text AS url, NULL::text AS title,\n"
                f"         ds.skey, ds.domain, {CATEGORY_EXPR} AS category_key\n"
                "    FROM t JOIN rd.dim_source ds ON ds.source_key = t.gk\n"
                f"    {OVERRIDE_JOIN}")
        search = f"ds.skey ILIKE {b.v('%' + q + '%')}" if q else ""
    ks = keyset_predicate(SORT_COLS, "asc", cursor, b)
    txt = f"""
WITH t AS (
  SELECT {gk} AS gk, count(*) AS citations, array_agg(DISTINCT c.engine_key) AS engines,
         (array_agg(c.prompt_key ORDER BY c.round_date, c.answer_key, c.ord))[1] AS prompt_key
    FROM {fact_tables(ms).citation} c
    JOIN {fact_tables(ms).answer} a ON a.surface = c.surface AND a.round_date = c.round_date AND a.answer_key = c.answer_key
   WHERE {' AND '.join(where)}
   GROUP BY 1),
j AS MATERIALIZED (
  {dims}{chr(10) + '   WHERE ' + search if search else ''})
SELECT j.citations, j.engines, j.k, j.display, j.url, j.title, j.skey, j.domain, j.category_key, dp.text AS prompt_text,
       (SELECT count(*) FROM j) AS total
  FROM j LEFT JOIN {fact_tables(ms).prompt} dp ON dp.prompt_key = j.prompt_key
 {'WHERE ' + ks if ks else ''}
 ORDER BY j.citations DESC, j.k
 LIMIT {b.v(limit + 1, 'int4')}
"""
    return b.sql(txt)


def tone_counts_sql(ctx: ReadContext, win: Window) -> Sql:
    """BG-27 두 톤 탭 카운트 = DISTINCT 인용 URL 수(현행 탭 카운트 = /sources tone.positive·negative.urls, 요약 타일과 같은 술어)."""
    ms = ctx.measure()
    b = Binder("u")
    pos, neg = tone_expr(ctx.own_bits, "a")
    where = citation_where(ms, win, "c", b) + win.where("a", FAMILY, b) + ["a.answer_key = c.answer_key"]
    txt = f"""
SELECT count(DISTINCT c.url_key) FILTER (WHERE {pos}) AS positive,
       count(DISTINCT c.url_key) FILTER (WHERE {neg}) AS negative
  FROM {fact_tables(ms).citation} c
  JOIN {fact_tables(ms).answer} a ON a.surface = c.surface AND a.round_date = c.round_date AND a.answer_key = c.answer_key
 WHERE {' AND '.join(where)}
"""
    return b.sql(txt)
