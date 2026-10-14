"""analytics.citations.domain_detail 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

한 문장: 출처 하나(c.source_key = :sk)로 좁힌 rd.citation 범위 스캔(cit_source_idx) → URL·프롬프트·답변 참조 집계.
상한 기본값은 현행 계승(scope-aggregates.ts:5284-5286): URL 10 · 프롬프트 12 · 프롬프트당 답변 참조 8. BG-25 로 요청이
urls_limit·prompts_limit·answers_limit 를 넓힐 수 있다(상한은 schemas 상수). url_total·prompt_total 은 자르기 전 전체 수.
BG-23 URL 행 prompt_text = 그 URL 의 가장 이른 인용(round_date·answer_key·ord 순)의 프롬프트(톤 드릴다운 ToneRow 와 같은 규칙).
답변 참조는 (인용 수 내림차순, answer_key) 로 순위를 매겨 8건을 자른 뒤에만 rd.job PK 로 job_id 를 붙인다(최대 12 × 8 = 96행,
모듈-인용 C-3 과 같은 규약: 표본 전 rd.job 조인 없음).
요약 자사 인용 수(own_citations)는 프롬프트별로 이미 센 pl 의 합이다(B013: 종전 스칼라 부분질의가 base 를 한 번 더 읽었다. 프롬프트 키로 나눈
FILTER 수의 합 = 전체 FILTER 수). base 스캔 = u·pl·rf·인용 수 4회.
"""
from __future__ import annotations

from app.core.cycles import Window
from app.core.facts import fact_tables
from app.core.filters import ReadContext
from app.core.measure import CATEGORY_EXPR, OVERRIDE_JOIN, citation_where, own_expr
from app.core.sqlb import Binder, Sql
from app.features.analytics.citations.domains.queries import mention_brand_exists
from app.features.analytics.citations.domains.shared import EFFECTIVE_COMPETITOR

URLS_PER_SOURCE = 10
PROMPTS_PER_SOURCE = 12
REFS_PER_PROMPT = 8

SOURCE_SQL = f"""
SELECT ds.source_key, ds.skey, ds.domain, ds.is_social, {CATEGORY_EXPR} AS category_key, bn.name AS competitor_brand
  FROM rd.dim_source ds {OVERRIDE_JOIN}
  LEFT JOIN rd.dim_brand_name bn ON bn.brand_key = {EFFECTIVE_COMPETITOR}
 WHERE ds.skey = :skey AND ds.source_key <> 0
"""


def detail_sql(ctx: ReadContext, win: Window, *, source_key: int, mention_brand_key: int | None, urls_limit: int = URLS_PER_SOURCE,
               prompts_limit: int = PROMPTS_PER_SOURCE, answers_limit: int = REFS_PER_PROMPT) -> Sql:
    ms = ctx.measure()
    b = Binder("x")
    where = citation_where(ms, win, "c", b) + [f"c.source_key = {b.v(source_key, 'int4')}"]
    if mention_brand_key is not None:
        where.append(mention_brand_exists(win, "c", mention_brand_key, b, ms))
    txt = f"""
WITH base AS MATERIALIZED (
  SELECT c.url_key, c.prompt_key, c.answer_key, c.engine_key, c.geo_key, c.round_date, c.ord, ({own_expr(ms, "c", b)}) AS own
    FROM {fact_tables(ms).citation} c
   WHERE {' AND '.join(where)}),
u AS (
  SELECT base.url_key, count(*) AS citations, array_agg(DISTINCT base.engine_key) AS engines,
         (array_agg(base.prompt_key ORDER BY base.round_date, base.answer_key, base.ord))[1] AS first_prompt_key
    FROM base GROUP BY base.url_key),
ut AS (
  SELECT u.citations, u.engines, du.url, du.title, ob.geo_code, encode(du.url_hash, 'hex') AS h, u.first_prompt_key
    FROM u JOIN rd.dim_url du ON du.url_key = u.url_key
    LEFT JOIN app.owned_base ob ON ob.owner_key = du.owner_key
   ORDER BY u.citations DESC, du.url_hash LIMIT {b.v(urls_limit, 'int4')}),
utp AS (
  SELECT ut.citations, ut.engines, ut.url, ut.title, ut.geo_code, ut.h, fp.text AS prompt_text
    FROM ut LEFT JOIN {fact_tables(ms).prompt} fp ON fp.prompt_key = ut.first_prompt_key),
pl AS (
  SELECT base.prompt_key, count(*) AS citations, count(*) FILTER (WHERE base.own) AS own_citations,
         array_agg(DISTINCT base.engine_key) AS engines
    FROM base GROUP BY base.prompt_key),
pk AS (
  SELECT pl.prompt_key, pl.citations, pl.own_citations, pl.engines, dp.prompt_id, dp.text, t.code AS funnel
    FROM pl JOIN {fact_tables(ms).prompt} dp ON dp.prompt_key = pl.prompt_key
    LEFT JOIN rd.dim_taxon t ON t.taxon_key = dp.funnel_key AND t.axis = 'funnel'
   ORDER BY pl.citations DESC, dp.prompt_id LIMIT {b.v(prompts_limit, 'int4')}),
rf AS (
  SELECT base.prompt_key, base.answer_key, base.engine_key, base.geo_key, count(*) AS cites
    FROM base JOIN pk ON pk.prompt_key = base.prompt_key
   GROUP BY base.prompt_key, base.answer_key, base.engine_key, base.geo_key),
rk AS (
  SELECT rf.prompt_key, rf.answer_key, rf.engine_key, rf.geo_key, rf.cites,
         row_number() OVER (PARTITION BY rf.prompt_key ORDER BY rf.cites DESC, rf.answer_key) AS rn
    FROM rf),
rs AS (
  SELECT rk.prompt_key, rk.rn, rk.engine_key, rk.geo_key, rk.cites, j.job_id
    FROM rk JOIN rd.job j ON j.answer_key = rk.answer_key
   WHERE rk.rn <= {b.v(answers_limit, 'int4')})
SELECT
  (SELECT count(*) FROM base) AS citations,
  (SELECT coalesce(sum(pl.own_citations), 0) FROM pl) AS own_citations,
  (SELECT count(*) FROM u) AS url_total,
  (SELECT count(*) FROM pl) AS prompt_total,
  (SELECT coalesce(json_agg(utp ORDER BY utp.citations DESC, utp.h), '[]'::json) FROM utp) AS urls,
  (SELECT coalesce(json_agg(pk ORDER BY pk.citations DESC, pk.prompt_id), '[]'::json) FROM pk) AS prompts,
  (SELECT coalesce(json_agg(rs ORDER BY rs.prompt_key, rs.rn), '[]'::json) FROM rs) AS refs
"""
    return b.sql(txt)
