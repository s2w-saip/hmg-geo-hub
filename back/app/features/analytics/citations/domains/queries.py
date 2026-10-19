"""analytics.citations.domains 읽기 SQL(SQLAlchemy Core text). rd·app·ext 만. surface·round_date 가지치기 필수.

문장 2개(모듈-인용 §2 C-1):
1. 주 스캔: rd.citation 을 (출처 키, 프롬프트 키)로 한 번 접고(해시 집계) 출처 키로 다시 접은 MATERIALIZED CTE(출처 수 규모) 위에서
   요약·경쟁사 합·키셋 페이지를 한 문장으로. 도메인 텍스트 GROUP BY 는 하지 않는다(QUERY-FIXES C-1: 정수 source_key 로 먼저 모은 뒤
   rd.dim_source 로 접기). 두 단계 접기는 BG-24 인용 프롬프트 수(DISTINCT 프롬프트)를 count(DISTINCT) 정렬 없이 내기 위한 것이다
   (나머지 열은 전부 가산이라 두 단계 합 = 한 단계 합).
2. 커버리지 분모: rd.answer cit_in 답변 수(같은 창·필터 축).

BG-21 검색(q)·정렬(sort·dir)·BG-20 선택(skey[]·competitor[])은 출처 단위 CTE 위에서만 건다(요약·경쟁사 합·share·coverage 분모는
전체 모집단). 순위 두 벌(현행 표면별 '#' 규칙):
- rank: 경쟁사 선택(competitor[]) 뒤, 검색(q)·skey[] 선택 전 모집단의 인용 순위 = 표준 표(citations-standard-view.tsx:559-560,
  applyCompetitorPick 뒤 번호 → 검색).
- match_rank: 경쟁사 선택·검색·skey[] 선택을 모두 적용한 행 안의 인용 순위 = 웹사이트·프로젝트 표(citations-view.tsx:277-280, 검색 뒤 번호).
정렬 동률은 rank(인용 수 내림차순·skey 오름차순) 오름차순: 현행 표가 인용 순 배열을 안정 정렬하는 것과 같다.
점유율·커버리지 정렬(검증 D3)은 현행 표가 비교하는 값 = 반올림한 퍼센트(pctOf = Math.round(n/d*1000)/10)로 한다. 원시 수로 정렬하면
표시값이 같은 행(예: 분모 10만에서 1000 과 1001 → 둘 다 1.0%)의 순서가 현행(표시값 동률 → 인용 순위 유지)과 달라진다.
정렬 키는 천분율 정수 share_pm·coverage_pm = floor(n*1000/d + 0.5)(정확 소수, 0.5 올림 = 내보내기 pct1 과 같은 반올림, 분모 0 이면 0).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.core.cycles import Window
from app.core.facts import fact_tables, frozen_read
from app.core.filters import ReadContext
from app.core.measure import (
    CATEGORY_EXPR,
    OVERRIDE_JOIN,
    MeasureScope,
    citation_population,
    citation_where,
    mention_population,
    own_expr,
    scope_where,
)
from app.core.pagination import Cursor, Dir, KeyType, keyset_predicate
from app.core.sqlb import Binder, Sql
from app.features.analytics.citations.domains.shared import EFFECTIVE_COMPETITOR, FAMILY

SORT_COLS = ("(-r.citations)", "r.skey")      # 기본 정렬 키셋: 인용 수 내림차순 = -citations 오름차순(키셋 행 값 비교는 한 방향만)

# 표기 일치 우선, 없으면 대소문자 무시(lower(bare)). 현행 프로필 NAME 의 bare 는 정본 표시명 그대로(answers.list RESOLVE_BRAND_SQL 과 같은 식)
BRAND_KEY_SQL = ("SELECT brand_key, name FROM rd.dim_brand_name WHERE brand_key <> 0 AND (name = :n OR lower(bare) = lower(:n)) "
                 "ORDER BY (name = :n) DESC, (bare = lower(:n)) DESC, brand_key LIMIT 1")

# 정렬 키 → 출처 CTE 열(화이트리스트). share·coverage 는 표시값(반올림 천분율) 기준(검증 D3)
_SORT_COL = {"citations": "citations", "share": "share_pm", "coverage": "coverage_pm", "prompts": "citing_prompts"}
# 반올림 천분율 정렬은 원시 수 정렬(이전 빌드 커서)과 키 의미가 달라 커서 sort 식별자를 바꾼다(이전 커서는 422 cursor_invalid)
_CURSOR_SORT = {"share": "share_pm", "coverage": "coverage_pm"}


@dataclass(frozen=True)
class SortSpec:
    """정렬 한 벌: 커서 sort 식별자·키셋 방향·키셋 열(별칭 r)·ORDER BY(별칭 {a})·커서 키 형·행 → 커서 키."""
    cursor_sort: str
    dir: Dir
    cols: tuple[str, ...]
    order: str
    types: tuple[KeyType, ...]
    key: Callable[[dict[str, Any]], tuple[Any, ...]]

    def order_by(self, alias: str) -> str:
        return self.order.format(a=alias)


def sort_spec(sort: str, direction: str | None) -> SortSpec:
    """정렬 명세. 기본(citations 내림차순)은 BG-21 이전 커서와 같은 모양(sort 'citations', 키 (-citations, skey))을 유지한다."""
    d = direction or ("asc" if sort == "skey" else "desc")
    if sort == "citations" and d == "desc":
        return SortSpec("citations", "asc", SORT_COLS, "{a}.citations DESC, {a}.skey", ("int8", "text"),
                        lambda r: (-int(r["citations"]), r["skey"]))
    if sort == "skey":
        return SortSpec(f"skey:{d}", "desc" if d == "desc" else "asc", ("r.skey",), "{a}.skey" + (" DESC" if d == "desc" else ""),
                        ("text",), lambda r: (r["skey"],))
    col = _SORT_COL[sort]
    cs = _CURSOR_SORT.get(sort, sort)
    if d == "desc":
        return SortSpec(f"{cs}:desc", "asc", (f"(-r.{col})", "r.rank"), f"{{a}}.{col} DESC, {{a}}.rank", ("int8", "int8"),
                        lambda r: (-int(r[col]), int(r["rank"])))
    return SortSpec(f"{cs}:asc", "asc", (f"r.{col}", "r.rank"), f"{{a}}.{col}, {{a}}.rank", ("int8", "int8"),
                    lambda r: (int(r[col]), int(r["rank"])))


def like_pattern(q: str) -> str:
    """ILIKE 부분 일치 패턴. 와일드카드(% _)와 이스케이프 문자(\\)는 글자 그대로 찾는다(현행 도메인 검색 = includes)."""
    esc = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{esc}%"


def mention_brand_exists(win: Window, outer: str, brand_key: int, b: Binder, ms: MeasureScope | None = None) -> str:
    """mention_brand: 그 브랜드가 언급 모수(core.measure.mention_population, ms 없으면 std_in = 옛 호출)로 언급된 답변만(현행 fetchBrandCitations).
    같은 창 3술어 + 답변 키 등치. 셀 대표는 인용 계열 대표(rep='c'): 현행은 인용 계열 답변 집합(snapshotRunFilter …"citations")의 언급으로 판정한다."""
    w = win.where("ab", FAMILY, b) + [f"ab.answer_key = {outer}.answer_key", f"ab.brand_key = {b.v(brand_key, 'int4')}",
                                 "ab.std_in" if ms is None else mention_population(ms, "ab", "brand", rep="c")]
    return f"EXISTS (SELECT 1 FROM {fact_tables(ms).answer_brand} ab WHERE {' AND '.join(w)})"


def card_host_fold(ctx: ReadContext, host_fold: bool = False) -> bool:
    """현행 프로필 domains_card_by_host(WU-12): 대시보드 도메인 목록을 도메인(호스트) 단위로 접나. 대상 = 카드 경로(card=true) 또는
    host_fold 요청(기간이 걸려 card 를 보내지 않는 대시보드 호출). 현행 대시보드 도메인은 기간 유무와 무관하게 호스트 단위다
    (집계층 summary-global-aggregates.ts:827-837 axis 'domain', 미러 scope-aggregates.ts:3086-3101 GROUP BY c2.domain)."""
    return (ctx.card or host_fold) and ctx.measure().profile.domains_card_by_host


# 카드 경로 도메인 접기(WU-12) 사상표: 출처 키 → 그 출처 도메인(rd.dim_source.domain)을 skey 로 갖는 출처(도메인 대표 행). 접히는 출처(공식 소셜
# 계정 그룹 키 'facebook.com/HyundaiMotorGroupTV' 처럼 skey ≠ domain 이고 도메인 대표 행이 있는 것)만 담아 작다(stg 2026-10-01 9행). 도메인 대표
# 행이 없으면(그 도메인 일반 인용이 전 이력에 한 번도 없음) 자기 키 그대로다. 접기는 인용 스캔이 아니라 이미 접은 CTE 위에서 한다
# (스캔에 조인을 붙이면 계획기가 병렬 계획을 버렸다: stg 9/28 limit=0 298 → 569ms). 열은 전부 가산(인용·자사·타겟·인용 답변 = 출처별 첫 행 수의
# 합 = 현행 도메인 축 sum)이고, 인용 프롬프트 수는 접힌 대표 키만 g0 에서 서로 다른 프롬프트 수로 다시 센다.
HOST_FOLD_MAP = ("fm AS (\n  SELECT d.source_key AS k, h.source_key AS hk\n    FROM rd.dim_source d JOIN rd.dim_source h ON h.skey = d.domain\n"
                 "   WHERE d.is_social AND h.source_key <> d.source_key),\n"     # is_social = (skey <> domain), 적재기 DIM_SOURCE
                 "fk AS (\n  SELECT k, hk FROM fm UNION SELECT hk, hk FROM fm)")
def _list_fold(where: list[str], ms: MeasureScope | None = None) -> str:
    """목록 문장 접기 CTE(gp·gf). gf = 출처 단위 g 중 접히는 키 행만 대표 키로 다시 접는다(나머지 행은 그대로, 가산 열 합).
    인용 프롬프트 수는 접힌 대표 키만 다시 센다: 같은 인용 술어로 rd.citation 을 출처 색인(cit_source_idx (source_key, round_date))으로 그 키들만
    읽어 서로 다른 프롬프트 수(gp). g0 를 두 번 읽지 않아 g0 는 인라인 그대로다(MATERIALIZED 면 stg 9/28 +50ms).
    동결 읽기(frozen_read)는 인용 원천이 카드 뷰라 출처 색인으로 몇 키만 읽는 길이 없고 다시 읽으면 뷰 전체(회차 셀 × rd 탐침)를 한 번 더 돈다
    (stg 9/28 글로벌 gp 760ms, 웹 9/25 1.87s). 그래서 동결 읽기는 g0 를 MATERIALIZED 로 한 번만 만들고(domains_sql) gp 를 g0 에서 센다.
    g0 는 같은 인용 술어의 (출처, 프롬프트) 집합이라 접힌 키의 서로 다른 프롬프트 수가 다시 읽기와 같다(be/int3-frzperf)."""
    if frozen_read(ms):
        gp = """gp AS (
  SELECT fk.hk, count(DISTINCT g0.prompt_key)::int8 AS np
    FROM g0 JOIN fk ON fk.k = g0.source_key
   GROUP BY fk.hk),"""
    else:
        gp = f"""gp AS (
  SELECT fk.hk, count(DISTINCT c.prompt_key)::int8 AS np
    FROM {fact_tables(ms).citation} c JOIN fk ON fk.k = c.source_key
   WHERE {' AND '.join(where)}
   GROUP BY fk.hk),"""
    return gp + """
gf AS (
  SELECT g.source_key, g.citations, g.own_citations, g.target_citations, g.citing_answers, g.citing_prompts
    FROM g WHERE g.source_key NOT IN (SELECT k FROM fk)
  UNION ALL
  SELECT fk.hk, sum(g.citations)::int8, sum(g.own_citations)::int8, sum(g.target_citations)::int8, sum(g.citing_answers)::int8,
         max(gp.np)
    FROM g JOIN fk ON fk.k = g.source_key JOIN gp ON gp.hk = fk.hk GROUP BY fk.hk),"""


def domains_sql(ctx: ReadContext, win: Window, *, limit: int, cursor: Cursor | None, mention_brand_key: int | None,
                spec: SortSpec | None = None, q: str | None = None, skeys: tuple[str, ...] = (),
                competitor_category_key: int | None = None, competitor_limit: int | None = 0, competitor_pick: tuple[str, ...] = (),
                answers_den: int = 0, host_fold: bool = False, competitor_totals: bool = True, own_target: bool = True) -> Sql:
    """반환 열: summary(json) · competitors(json) · rows(json, 최대 limit+1) · matched(경쟁사 선택·q·skey 적용 행 수, limit=0 이어도 계산)
    · competitor_sources(json|null). answers_den = 커버리지 분모(answers_den_sql 결과): coverage 정렬 키(반올림 천분율)에만 쓴다.
    competitor_limit > 0 이면 유효 카테고리 = competitor_category_key 인 출처를 인용 수 내림차순으로 싣는다(없는 카테고리면 빈 배열).
    잘림 판정용으로 competitor_limit + 1 행까지 싣는다(호출자가 상한으로 자르고 넘친 행이 있으면 잘림 표식). None 이면 상한 없이 전부
    (대시보드 카드 경로, B012), 0 이면 싣지 않는다(NULL).
    competitor_pick 이 있으면 유효 카테고리 = competitor_category_key 인 행 중 고른 skey 만 남기고 다른 카테고리 행은 그대로 둔다
    (현행 applyCompetitorPick). rank 는 이 선택 뒤 번호다(요약·경쟁사 합·옵션은 선택과 무관).
    읽지 않는 계산 끄기(B011, 기본은 전부 계산): competitor_totals=False 면 competitors = '[]'(경쟁사 합 집계 생략), own_target=False 면
    목록 문장이 자사·타겟 인용 FILTER 를 세지 않는다(own_citations·target_citations·요약 own = 0: 내보내기 7열이 쓰지 않는 열)."""
    ms = ctx.measure()
    b = Binder("d")
    spec = spec or sort_spec("citations", None)
    own = own_expr(ms, "c", b) if own_target or limit == 0 else None
    where = citation_where(ms, win, "c", b)
    if mention_brand_key is not None:
        where.append(mention_brand_exists(win, "c", mention_brand_key, b, ms))
    cat_filter = ""
    if ctx.source_category_keys is not None:           # 출처 단위로 접은 뒤 거르므로 원소 세미조인과 같은 결과(카테고리는 출처 키에 종속)
        cat_filter = f"\n   WHERE {CATEGORY_EXPR} = ANY({b.ints(ctx.source_category_keys)})"
    ra = "r" if limit > 0 else "s"                      # 검색·선택 술어의 별칭(limit=0 은 s 위에서 바로 센다)
    row_where: list[str] = []
    if q:
        row_where.append(f"{ra}.skey ILIKE {b.v(like_pattern(q), 'text')} ESCAPE '\\'")
    if skeys:
        row_where.append(f"{ra}.skey = ANY({b.v(sorted(set(skeys)), 'text[]')})")
    pick = ""
    if competitor_pick and competitor_category_key is not None:     # 공식(경쟁사) 카테고리가 없으면 거를 행도 없다(현행과 같다)
        pick = (f"s.category_key IS DISTINCT FROM {b.v(competitor_category_key, 'int4')}"
                f" OR s.skey = ANY({b.v(sorted(set(competitor_pick)), 'text[]')})")
    pick_where = f" WHERE {pick}" if pick else ""
    if limit == 0:                                     # A6: 목록 없이 요약·경쟁사 합·경쟁사 출처·matched 만
        return _totals_sql(b, own or "", where, cat_filter, pick, row_where,
                           _competitor_sources_sql(b, competitor_category_key, competitor_limit), fold=card_host_fold(ctx, host_fold),
                           ms=ms, competitor_totals=competitor_totals)
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
    comp_sql = _competitor_sources_sql(b, competitor_category_key, competitor_limit)
    # t(합계 1행)는 MATERIALIZED: 인라인이면 계획기가 s 를 1행으로 잘못 추정할 때 합계 집계를 s 행마다 다시 돈다(O(n²), stg 9/25 웹 카드
    # 5,424 출처 × 5,424 = 4.2s, be/web-card-perf). 한 번 계산하는 형은 추정과 무관하게 같은 값이다.
    # B011: 검색·skey[] 선택이 없으면 match_rank = rank(같은 행·같은 정렬의 row_number)라 두 번째 창 함수를 돌리지 않는다.
    # 값은 같다(test_perf_equiv 목록 동치)
    fold = card_host_fold(ctx, host_fold)
    own_col = f"count(*) FILTER (WHERE {own})" if own is not None else "0::int8"
    tgt_col = "count(*) FILTER (WHERE c.tgt_hit)" if own_target else "0::int8"
    m_sql = ("SELECT r.*, row_number() OVER (ORDER BY r.citations DESC, r.skey) AS match_rank FROM r WHERE " + " AND ".join(row_where)
             if row_where else "SELECT r.*, r.rank AS match_rank FROM r")
    competitors_sql = _COMPETITORS_COL if competitor_totals else _NO_COMPETITORS
    txt = f"""
WITH g0 AS (
  SELECT c.source_key, c.prompt_key, count(*) AS citations,
         {own_col} AS own_citations,
         {tgt_col} AS target_citations,
         count(*) FILTER (WHERE c.src_first) AS citing_answers
    FROM {fact_tables(ms).citation} c
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
t AS MATERIALIZED (
  SELECT coalesce(sum(s.citations), 0)::numeric AS total FROM s),
r AS (
  SELECT s.*, row_number() OVER (ORDER BY s.citations DESC, s.skey) AS rank,
         CASE WHEN t.total > 0 THEN floor(s.citations * 1000 / t.total + 0.5)::int8 ELSE 0::int8 END AS share_pm,
         CASE WHEN {den} > 0 THEN floor(s.citing_answers * 1000 / {den} + 0.5)::int8 ELSE 0::int8 END AS coverage_pm
    FROM s CROSS JOIN t{pick_where}),
m AS (
  {m_sql})
SELECT
{_SUMMARY_COL}
  {competitors_sql} AS competitors,
  {rows_sql} AS rows,
  {matched_sql} AS matched,
  {comp_sql} AS competitor_sources
"""
    if fold:      # 카드 경로 도메인 접기(WU-12): 출처 단위 g 를 대표 키로 접은 gf 를 s 가 읽는다(스캔·g0·g 문장은 그대로)
        g0 = "g0 AS MATERIALIZED (" if frozen_read(ms) else "g0 AS ("      # 동결 읽기는 gp 가 g0 를 다시 읽는다(_list_fold)
        txt = _replace_once(txt, "\nWITH g0 AS (", f"\nWITH {HOST_FOLD_MAP},\n{g0}")
        txt = _replace_once(txt, "\ns AS MATERIALIZED (", f"\n{_list_fold(where, ms)}\ns AS MATERIALIZED (")
        txt = _replace_once(txt, "    FROM g JOIN rd.dim_source ds ON ds.source_key = g.source_key",
                            "    FROM gf g JOIN rd.dim_source ds ON ds.source_key = g.source_key")
    return b.sql(txt)


def _replace_once(txt: str, anchor: str, new: str) -> str:
    """접기 치환(WU-12): 앵커가 문장에 정확히 한 번 있어야 한다. 문장 모양이 바뀌어 앵커가 없거나 둘 이상이면 조용히 미적용되지 않게 멈춘다."""
    n = txt.count(anchor)
    if n != 1:
        raise RuntimeError(f"domains 접기 치환 앵커 {anchor.strip()[:40]!r} 가 {n}번 있다(정확히 1번이어야 한다)")
    return txt.replace(anchor, new, 1)


# 요약·경쟁사 합(출처 CTE s 위, 목록·검색·선택과 무관한 전체 모집단). 목록 문장과 limit=0 문장이 같은 조각을 쓴다.
_SUMMARY_COL = """  (SELECT json_build_object('citations', coalesce(sum(s.citations), 0), 'own', coalesce(sum(s.own_citations), 0), 'sources', count(*))
     FROM s) AS summary,"""
_COMPETITORS_COL = """(SELECT coalesce(json_agg(json_build_object('brand', bn.name, 'citations', x.citations, 'sources', x.sources)
                            ORDER BY x.citations DESC, bn.name), '[]'::json)
     FROM (SELECT s.competitor_brand_key, sum(s.citations) AS citations, count(*) AS sources
             FROM s WHERE s.competitor_brand_key IS NOT NULL GROUP BY s.competitor_brand_key) x
     JOIN rd.dim_brand_name bn ON bn.brand_key = x.competitor_brand_key)"""
_NO_COMPETITORS = "'[]'::json"            # include_competitor_totals=false(B011): 경쟁사 합 집계 생략


def _competitor_sources_sql(b: Binder, competitor_category_key: int | None, competitor_limit: int | None) -> str:
    """BG-20 경쟁사 출처(유효 카테고리 = 공식(경쟁사)) 인용 수 내림차순, 상한 + 1 행(잘림 판정). competitor_limit 0 이면 NULL,
    None 이면 상한 없이 전부(대시보드 카드 경로: 출처를 브랜드로 접어 값을 내므로 상한이 값의 무음 절단이 된다, B012)."""
    if competitor_limit is not None and competitor_limit <= 0:
        return "NULL::json"
    ck = b.v(competitor_category_key if competitor_category_key is not None else -1, "int4")
    cap = f" LIMIT {b.v(competitor_limit + 1, 'int4')}" if competitor_limit is not None else ""
    return ("(SELECT coalesce(json_agg(x ORDER BY x.citations DESC, x.skey), '[]'::json) FROM (\n"
            "     SELECT s.skey, s.domain, s.citations, bn.name AS brand\n"
            "       FROM s LEFT JOIN rd.dim_brand_name bn ON bn.brand_key = s.competitor_brand_key\n"
            f"      WHERE s.category_key = {ck}\n"
            f"      ORDER BY s.citations DESC, s.skey{cap}) x)")


def _totals_sql(b: Binder, own: str, where: list[str], cat_filter: str, pick: str, row_where: list[str], comp_sql: str, *,
                fold: bool = False, ms: MeasureScope | None = None, competitor_totals: bool = True) -> Sql:
    """A6 limit=0(대시보드 경쟁사 행·D8): 목록 문장과 같은 반환 열(summary·competitors·rows='[]'·matched·competitor_sources).
    목록이 없으면 (출처, 프롬프트) 접기(citing_prompts 전용)·순위 창 함수·점유율/커버리지 정렬 키가 필요 없어 rd.citation 을 출처 키로
    한 번에 접는다. 요약·경쟁사 합·경쟁사 출처가 읽는 열(citations·own_citations = 가산)은 두 단계 합과 같다.
    matched = 경쟁사 선택(pick)·검색·skey[] 를 건 출처 수: 목록 문장의 count(m)(m = r 에 검색·선택, r = s 에 경쟁사 선택. r 의 CROSS JOIN t 는
    한 행이라 행 수를 바꾸지 않는다)와 같다. 술어·별칭은 목록 문장과 같은 조각(s.)을 쓴다."""
    conds = ([f"({pick})"] if pick else []) + row_where
    matched = "(SELECT count(*) FROM s" + (f" WHERE {' AND '.join(conds)}" if conds else "") + ")"
    txt = f"""
WITH g AS (
  SELECT c.source_key, count(*)::int8 AS citations, count(*) FILTER (WHERE {own})::int8 AS own_citations
    FROM {fact_tables(ms).citation} c
   WHERE {' AND '.join(where)}
   GROUP BY c.source_key),
s AS MATERIALIZED (
  SELECT g.source_key, g.citations, g.own_citations, ds.skey, ds.domain,
         {CATEGORY_EXPR} AS category_key, {EFFECTIVE_COMPETITOR} AS competitor_brand_key
    FROM g JOIN rd.dim_source ds ON ds.source_key = g.source_key
    {OVERRIDE_JOIN}{cat_filter})
SELECT
{_SUMMARY_COL}
  {_COMPETITORS_COL if competitor_totals else _NO_COMPETITORS} AS competitors,
  '[]'::json AS rows,
  {matched} AS matched,
  {comp_sql} AS competitor_sources
"""
    if fold:      # 카드 경로 도메인 접기(WU-12, 목록 문장과 같은 사상표): 출처 단위 접기 gs 를 대표 키로 다시 접는다(프롬프트 열 없음)
        txt = _replace_once(txt, "\nWITH g AS (", f"\nWITH {HOST_FOLD_MAP},\ngs AS (")
        txt = _replace_once(txt, "   GROUP BY c.source_key),\ns AS MATERIALIZED (",
                            "   GROUP BY c.source_key),\ng AS (\n  SELECT gs.source_key, gs.citations, gs.own_citations FROM gs"
                            " WHERE gs.source_key NOT IN (SELECT k FROM fk)\n  UNION ALL\n"
                            "  SELECT fk.hk, sum(gs.citations)::int8, sum(gs.own_citations)::int8 FROM gs JOIN fk ON fk.k = gs.source_key"
                            " GROUP BY fk.hk),\ns AS MATERIALIZED (")
    return b.sql(txt)


def answers_den_sql(ctx: ReadContext, win: Window, *, mention_brand_key: int | None) -> Sql:
    """커버리지 분모: 같은 창(인용 계열)·필터 축의 cit_in 답변 수. source[] 는 답변 단위 축이 아니라 걸지 않는다(모듈-인용 §2)."""
    ms = ctx.measure()
    b = Binder("n")
    where = win.where("a", FAMILY, b) + scope_where(ms, "a", b) + [citation_population(ms, "a")]
    if mention_brand_key is not None:
        where.append(mention_brand_exists(win, "a", mention_brand_key, b, ms))
    return b.sql(f"SELECT count(*) AS answers FROM {fact_tables(ms).answer} a WHERE {' AND '.join(where)}")
