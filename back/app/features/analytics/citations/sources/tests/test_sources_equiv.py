"""/v1/citations/sources 성능 R2 재작성 동치 시험: 종전 문장 3개(stg 13859d9f 의 categories_sql·tone_sql·types_sql, 아래 legacy_* 사본)와
새 문장 2개(queries.sources_sql·tone_sql)를 같은 문맥·창에서 돌려 결과가 같은지 본다.

- 비교 단위: 카테고리 행 (engine_key, category_key, citations, grp) 집합 · 유형 행(카테고리별 t_* 5종, 0 이 아닌 행) · 톤 6값.
- 데이터: 합성 픽스처(ro) + 롤백 전용 준비(prompts/tests/staged.pgsql @global 회차 14, domains/tests/bg.pgsql @src_first·@tone_negative·
  @lang_ko·@share_tie) + equiv.pgsql @tone_dup. share_tie 는 답변 9115·9116 에 같은 URL 인용 2,001건을 더하고 tone_dup 이 두 답변에
  톤을 둬서 톤 안 (답변, url) 중복·url 수 대 인용 수 차이를 만든다.
- 경우: 필터 없음·브랜드·국가(1·2개)·엔진(단일·복수·결과 없음)·언어·출처 카테고리(source[])·빈 기간·다회차 기간·스코프 계정(현대 hq·기아 US)·
  프로젝트 표면·웹사이트(숨김만 뺀 창).
"""
from __future__ import annotations

import pathlib
from datetime import date
from typing import Any

from app.core.auth import load_principal
from app.core.cycles import Window
from app.core.db import fetch_all, fetch_one
from app.core.filters import CommonFilters, ReadContext, resolve_read_context
from app.core.measure import CATEGORY_EXPR, OVERRIDE_JOIN, citation_where, scope_where, tone_expr
from app.core.sqlb import Binder, Sql
from app.features.analytics.citations.domains.shared import CITATION_SUPPORT, FAMILY
from app.features.analytics.citations.domains.tests.helpers import website_window
from app.features.analytics.citations.prompts.tests.staged_db import SQL as PROMPT_SQL
from app.features.analytics.citations.sources import queries as q
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, VENDOR, load_named_sql, needs_db, staged
from tests.support import Sql as StageSql

pytestmark = needs_db
BG = load_named_sql(pathlib.Path(__file__).parents[2] / "domains" / "tests" / "bg.pgsql")
EQ = load_named_sql(pathlib.Path(__file__).with_name("equiv.pgsql"))
TYPE_COLS = tuple(q.TYPE_COLS.values())


# ════════════════════════════════════════════════════════════════════════════
# 종전 구현 사본(stg 13859d9f sources/queries.py). 비교 기준이라 고치지 않는다.
# ════════════════════════════════════════════════════════════════════════════
def _legacy_cat_filter(ctx: ReadContext, b: Binder) -> str:
    if ctx.source_category_keys is None:
        return ""
    return f"\n   WHERE {CATEGORY_EXPR} = ANY({b.ints(ctx.source_category_keys)})"


def legacy_categories_sql(ctx: ReadContext, win: Window) -> Sql:
    ms = ctx.measure()
    b = Binder("k")
    txt = f"""
WITH g AS (
  SELECT c.engine_key, c.source_key, count(*) AS n
    FROM rd.citation c
   WHERE {' AND '.join(citation_where(ms, win, "c", b))}
   GROUP BY c.engine_key, c.source_key),
e AS (
  SELECT g.engine_key, {CATEGORY_EXPR} AS category_key, g.n
    FROM g JOIN rd.dim_source ds ON ds.source_key = g.source_key
    {OVERRIDE_JOIN}{_legacy_cat_filter(ctx, b)})
SELECT e.engine_key, e.category_key, coalesce(sum(e.n), 0) AS citations, GROUPING(e.engine_key, e.category_key) AS grp
  FROM e
 GROUP BY GROUPING SETS ((e.category_key), (e.engine_key, e.category_key), ())
"""
    return b.sql(txt)


def legacy_tone_sql(ctx: ReadContext, win: Window) -> Sql:
    ms = ctx.measure()
    b = Binder("t")
    pos, neg = tone_expr(ctx.own_bits, "a")
    where = (citation_where(ms, win, "c", b) + win.where("a", FAMILY, b)
             + ["a.answer_key = c.answer_key"])
    txt = f"""
SELECT count(DISTINCT c.url_key) FILTER (WHERE {pos}) AS pos_urls,
       count(*) FILTER (WHERE {pos}) AS pos_citations,
       count(DISTINCT c.answer_key) FILTER (WHERE {pos}) AS pos_answers,
       count(DISTINCT c.url_key) FILTER (WHERE {neg}) AS neg_urls,
       count(*) FILTER (WHERE {neg}) AS neg_citations,
       count(DISTINCT c.answer_key) FILTER (WHERE {neg}) AS neg_answers
  FROM rd.citation c
  JOIN rd.answer a ON a.surface = c.surface AND a.round_date = c.round_date AND a.answer_key = c.answer_key
 WHERE {' AND '.join(where)}
"""
    return b.sql(txt)


def legacy_types_sql(ctx: ReadContext, win: Window) -> Sql:
    ms = ctx.measure()
    b = Binder("y")
    ab_where = win.where("ab", FAMILY, b) + scope_where(ms, "ab", b) + ["ab.std_in", f"ab.own_bit = ANY({b.ints(ctx.own_bits)})"]
    flags = ",\n         ".join(f"bool_or(ab.{col} > 0) AS {col}" for col in TYPE_COLS)
    counts = ",\n         ".join(f"count(*) FILTER (WHERE jt.{col}) AS {col}" for col in TYPE_COLS)
    sums = ", ".join(f"sum(g.{col}) AS {col}" for col in TYPE_COLS)
    txt = f"""
WITH jt AS (
  SELECT ab.answer_key,
         {flags}
    FROM rd.answer_brand ab
   WHERE {' AND '.join(ab_where)}
   GROUP BY ab.answer_key),
g AS (
  SELECT c.source_key,
         {counts}
    FROM rd.citation c JOIN jt ON jt.answer_key = c.answer_key
   WHERE {' AND '.join(citation_where(ms, win, "c", b))}
   GROUP BY c.source_key)
SELECT {CATEGORY_EXPR} AS category_key, {sums}
  FROM g JOIN rd.dim_source ds ON ds.source_key = g.source_key
  {OVERRIDE_JOIN}{_legacy_cat_filter(ctx, b)}
 GROUP BY 1
"""
    return b.sql(txt)


# ════════════════════════════════════════════════════════════════════════════
# 비교
# ════════════════════════════════════════════════════════════════════════════
TONE_KEYS = ("pos_urls", "pos_citations", "pos_answers", "neg_urls", "neg_citations", "neg_answers")


def _types_of(rows: list[dict[str, Any]]) -> dict[int, tuple[int, ...]]:
    out = {}
    for r in rows:
        v = tuple(int(r[c] or 0) for c in TYPE_COLS)
        if any(v):
            out[int(r["category_key"])] = v
    return out


async def _run(conn: Any, s: Sql, one: bool = False) -> Any:
    return (await fetch_one(conn, s.text, s.params) or {}) if one else await fetch_all(conn, s.text, s.params)


async def _compare(conn: Any, ctx: ReadContext, win: Window, label: str) -> dict[str, Any]:
    old_cat = await _run(conn, legacy_categories_sql(ctx, win))
    old_tone = await _run(conn, legacy_tone_sql(ctx, win), one=True)
    old_typ = await _run(conn, legacy_types_sql(ctx, win))
    new_rows = await _run(conn, q.sources_sql(ctx, win))
    new_tone = await _run(conn, q.tone_sql(ctx, win), one=True)
    cat_key = lambda r: (r["engine_key"], r["category_key"], int(r["citations"]), int(r["grp"]))   # noqa: E731
    assert {cat_key(r) for r in new_rows} == {cat_key(r) for r in old_cat}, label
    assert len(new_rows) == len(old_cat), label
    assert _types_of([r for r in new_rows if int(r["grp"]) == 2]) == _types_of(old_typ), label
    # 새 유형 합이 /sources/types 문장(types_sql, jt 내부 조인 유지)과도 같다
    assert _types_of(await _run(conn, q.types_sql(ctx, win))) == _types_of(old_typ), label
    old_t = tuple(int(old_tone.get(k) or 0) for k in TONE_KEYS)
    new_t = tuple(int(new_tone.get(k) or 0) for k in TONE_KEYS)
    assert new_t == old_t, (label, old_t, new_t)
    total = next((int(r["citations"]) for r in old_cat if int(r["grp"]) == 3), 0)
    return {"total": total, "tone": old_t, "types": _types_of(old_typ)}


async def _ctx(conn: Any, uid: Any, **f: Any) -> tuple[ReadContext, Window]:
    p = await load_principal(conn, uid)
    ctx = await resolve_read_context(conn, p, CommonFilters(**f), support=CITATION_SUPPORT)
    return ctx, await ctx.window(conn)


G: dict[str, Any] = {"surface": "global"}
CASES: list[tuple[str, Any, dict[str, Any]]] = [
    ("admin", ADMIN, G),
    ("hq_hyundai", HQ_HYUNDAI, G),
    ("brand_kia", ADMIN, {**G, "brand": ["Kia"]}),
    ("brand_hyundai_genesis", ADMIN, {**G, "brand": ["Hyundai", "Genesis"]}),
    ("country_us", ADMIN, {**G, "country": ["US"]}),
    ("country_us_kr", ADMIN, {**G, "country": ["US", "KR"]}),
    ("engine_chatgpt", ADMIN, {**G, "engine": ["chatgpt"]}),
    ("engine_deepseek", ADMIN, {**G, "engine": ["deepseek"]}),
    ("engine_multi", ADMIN, {**G, "engine": ["chatgpt", "gemini", "deepseek"]}),
    ("engine_gemini_empty", ADMIN, {**G, "engine": ["gemini"]}),
    ("lang_ko", ADMIN, {**G, "lang": ["ko"]}),
    ("source_two", ADMIN, {**G, "source": ["communityForums", "newsMedia"]}),
    ("source_brand_country", HQ_HYUNDAI, {**G, "source": ["officialHmg", "other"], "country": ["US"]}),
    ("range_multi_round", ADMIN, {**G, "from": date(2026, 9, 1), "to": date(2026, 9, 30)}),
    ("empty_period", ADMIN, {**G, "from": date(2025, 1, 1), "to": date(2025, 1, 31)}),
    ("kia_us", KIA_US, G),
    ("project", VENDOR, {"surface": "project", "project_id": CUST_PROJECT}),
]


async def _all_cases(conn: Any) -> dict[str, dict[str, Any]]:
    out = {}
    for label, uid, f in CASES:
        ctx, win = await _ctx(conn, uid, **f)          # 빈 창(서비스는 문장을 건너뛴다)도 두 구현이 같은 빈 결과인지 돌려 본다
        out[label] = await _compare(conn, ctx, win, label)
    p = await load_principal(conn, KIA_EU)
    wctx = await resolve_read_context(conn, p, CommonFilters(surface="website"), support=CITATION_SUPPORT)
    out["website"] = await _compare(conn, wctx, website_window(wctx.project_keys), "website")
    return out


async def test_equiv_base_fixture(ro):
    got = await _all_cases(ro)
    assert got["admin"]["total"] == 9 and got["admin"]["tone"] == (9, 9, 1, 0, 0, 0)     # 손 계산(helpers.py 머리 주석)
    assert got["website"]["total"] == 4 and got["project"]["total"] == 4
    assert got["empty_period"]["total"] == 0


async def test_equiv_staged_rich(client_as):
    async with staged(StageSql(PROMPT_SQL["global"]), StageSql(BG["src_first"]), StageSql(BG["tone_negative"]),
                      StageSql(BG["lang_ko"]), StageSql(BG["share_tie"]), StageSql(EQ["tone_dup"])) as conn:
        got = await _all_cases(conn)
        # 준비가 의도대로 들어갔다(비교가 빈 값끼리의 일치가 아니다): 부정 톤·url 수 < 인용 수·다회차·언어 좁힘
        pu, pc, pa, nu, nc, na = got["hq_hyundai"]["tone"]
        assert na == 3 and nc > 1000 + nu and pa == 4 and pc > 1000 + pu, got["hq_hyundai"]["tone"]
        assert got["range_multi_round"]["total"] > got["admin"]["total"] > 0
        assert 0 < got["lang_ko"]["total"] < got["admin"]["total"]
        assert 0 < got["source_two"]["total"] < got["admin"]["total"]
        assert got["engine_deepseek"]["total"] > 0 and got["engine_gemini_empty"]["total"] == 0
        # API 응답도 새 문장으로 같은 값(톤 타일 = 종전 문장 값)
        async with client_as(HQ_HYUNDAI) as c:
            d = (await c.get("/v1/citations/sources", params=G)).json()["data"]
        assert (d["tone"]["positive"]["urls"], d["tone"]["positive"]["citations"], d["tone"]["positive"]["answers"],
                d["tone"]["negative"]["urls"], d["tone"]["negative"]["citations"], d["tone"]["negative"]["answers"]) == got["hq_hyundai"]["tone"]
        assert d["total_citations"] == got["hq_hyundai"]["total"]
        assert {t["type"]: t["total"] for t in d["types"]} == {
            t: sum(v[i] for v in got["hq_hyundai"]["types"].values()) for i, t in enumerate(q.TYPE_COLS)}


# ════════════════════════════════════════════════════════════════════════════
# 답변 열 경로(인용 성능 수정안 B, DB-v2.15 P86 cit_c1..13, WU-5) = 원소 경로(sources_sql)
# ════════════════════════════════════════════════════════════════════════════
async def _ans_vs_element(conn: Any, ctx: ReadContext, win: Window, label: str, *, expect_usable: bool = True) -> int:
    el = await _run(conn, q.sources_sql(ctx, win))
    raw = await _run(conn, q.sources_ans_sql(ctx, win))
    if not expect_usable:     # 모수 답변이 없으면 표시 열도 없다(원소 경로도 빈 결과라 어느 쪽이든 같다)
        assert not raw or not q.ans_path_usable(raw), (label, raw[:1])
        return 0
    assert q.ans_path_usable(raw), (label, raw[:1])
    ans = q.fold_ans_rows(raw, ctx.source_category_keys)
    key = lambda r: (r["engine_key"], r["category_key"], int(r["citations"]), int(r["grp"]))   # noqa: E731
    assert {key(r) for r in ans} == {key(r) for r in el}, label
    assert len(ans) == len(el), label
    assert _types_of([r for r in ans if int(r["grp"]) == 2]) == _types_of([r for r in el if int(r["grp"]) == 2]), label
    return next((int(r["citations"]) for r in ans if int(r["grp"]) == 3), 0)


async def _ans_all_cases(conn: Any, *, expect_usable: bool = True) -> dict[str, int]:
    out = {}
    for label, uid, f in CASES:
        ctx, win = await _ctx(conn, uid, **f)
        out[label] = await _ans_vs_element(conn, ctx, win, label, expect_usable=expect_usable)
    p = await load_principal(conn, KIA_EU)
    wctx = await resolve_read_context(conn, p, CommonFilters(surface="website"), support=CITATION_SUPPORT)
    out["website"] = await _ans_vs_element(conn, wctx, website_window(wctx.project_keys), "website", expect_usable=expect_usable)
    return out


async def test_ans_path_base_fixture(ro):
    """템플릿 행(seed-40 이 cit_c 를 쓴다): 모든 경우 답변 열 경로를 쓰고 원소 경로와 같다."""
    got = await _ans_all_cases(ro)
    assert got["admin"] == 9 and got["website"] == 4 and got["project"] == 4 and got["empty_period"] == 0


async def test_ans_path_staged_rich(client_as):
    """다회차·언어·출처·톤 중복·경쟁사 카테고리(재판정 반영) 준비 + 답변 열 재계산 뒤 두 경로가 같고, API 도 같은 값."""
    async with staged(StageSql(PROMPT_SQL["global"]), StageSql(BG["src_first"]), StageSql(BG["tone_negative"]), StageSql(BG["lang_ko"]),
                      StageSql(BG["share_tie"]), StageSql(EQ["tone_dup"]), StageSql(BG["competitor"]), StageSql(EQ["reflect_override"]),
                      StageSql(EQ["refresh_cit_ext"])) as conn:
        got = await _ans_all_cases(conn)
        assert got["range_multi_round"] > got["admin"] > 0 and 0 < got["source_two"] < got["admin"]
        old = await _all_cases(conn)          # 원소 경로 3문장(종전)과도 같은 전체 수
        assert {k: v["total"] for k, v in old.items()} == got
        async with client_as(HQ_HYUNDAI) as c:
            d = (await c.get("/v1/citations/sources", params=G)).json()["data"]
            t = (await c.get("/v1/citations/sources/types", params=G)).json()["data"]
        assert d["total_citations"] == got["hq_hyundai"]
        assert {x["type"]: x["total"] for x in t["items"]} == {x["type"]: x["total"] for x in d["types"]}


async def test_ans_path_falls_back(client_as):
    """재판정 전 오버라이드(bg @competitor: reddit.com 오버라이드 2, 차원 6) 또는 미채움 답변이면 원소 경로로 되돌린다(값 = 오버라이드 즉시 반영)."""
    async with staged(StageSql(PROMPT_SQL["global"]), StageSql(BG["competitor"]), StageSql(EQ["refresh_cit_ext"])) as conn:
        await _ans_all_cases(conn, expect_usable=False)
        async with client_as(ADMIN) as c:
            d = (await c.get("/v1/citations/sources", params=G)).json()["data"]
        ctx, win = await _ctx(conn, ADMIN, **G)
        el = await _run(conn, q.sources_sql(ctx, win))
        assert d["total_citations"] == next(int(r["citations"]) for r in el if int(r["grp"]) == 3)
    async with staged(StageSql(PROMPT_SQL["global"]), StageSql(EQ["null_cit_ext"])) as conn:
        ctx, win = await _ctx(conn, ADMIN, **G)
        assert not q.ans_path_usable(await _run(conn, q.sources_ans_sql(ctx, win)))


STG_PROFILE = ("compare_epoch_gate,compare_suppress,trend_grid,cell_rep,rep_pick_latest_first,acr_iter_unfolded,gap_in_population,"
               "catalog_incl_deleted,display_name_latin,brand_exposure_per_alias,filter_options")      # stg 2026-10-01 HGH_LEGACY_PROFILE


async def test_equiv_under_stg_profile(settings, client_as):
    """stg 현행 프로필(셀 대표 is_rep·삭제 포함 카탈로그 세미조인)에서도 종전 3문장 = 새 2문장(톤 인용 쪽 술어 축소 포함) = 답변 열 경로."""
    from app.core.config import set_settings

    set_settings(settings.model_copy(update={"legacy_profile": STG_PROFILE}))
    try:
        async with staged(StageSql(PROMPT_SQL["global"]), StageSql(BG["src_first"]), StageSql(BG["tone_negative"]), StageSql(BG["lang_ko"]),
                          StageSql(BG["share_tie"]), StageSql(EQ["tone_dup"]), StageSql(EQ["refresh_cit_ext"]),
                          StageSql(EQ["profile_cols"])) as conn:
            ctx, _ = await _ctx(conn, ADMIN, **G)
            assert ctx.measure().profile.catalog_incl_deleted and ctx.measure().profile.cell_rep
            old = await _all_cases(conn)
            got = await _ans_all_cases(conn)
            assert {k: v["total"] for k, v in old.items()} == got and got["admin"] > 0
    finally:
        set_settings(settings)
