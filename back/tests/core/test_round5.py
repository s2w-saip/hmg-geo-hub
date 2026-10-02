"""core 5라운드(분석 기능 요청 반영) 시험: 표면 경로 게이트, 회차 원장 조회, 출처 카테고리 축, 헤드라인 풀, 롤백 전용 준비 도우미.

기대값은 합성 픽스처(tests/README.md 4절)의 손 계산이다. 픽스처에 없는 상태는 tests.support.staged 로 만들고 롤백한다.
"""
from __future__ import annotations

import uuid
from datetime import date

import pytest

from app.core import errors
from app.core.auth import SURFACE_MENU, SURFACE_ROLES, Principal, shows_geo_map, surface_denial
from app.core.codes import load_refs
from app.core.cycles import (
    CycleRow,
    bucket_start,
    build_window,
    first_published,
    ledger_rows,
    resolve_recent_window,
    selectable_round_dates,
)
from app.core.db import fetch_all, fetch_val
from app.core.envelope import SUPPRESS_HIDDEN, SUPPRESS_NO_SNAPSHOT, SUPPRESS_PARTIAL_HIDDEN, Page, window_suppression
from app.core.filters import KPI_SUPPORT, CommonFilters, FilterSupport, resolve_read_context
from app.core.measure import (
    MeasureScope,
    applied_prompts_sql,
    brand_rows,
    citation_counts,
    fetch_counts,
    plan_counts,
    scope_where,
    url_rates,
)
from app.core.sqlb import Binder
from app.core.sqlguard import fact_guard
from app.core.write import AccessAuditWriter
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    TODAY,
    VENDOR,
    WEBSITE_KIA,
    Rows,
    Update,
    needs_db,
    principal,
    savepoint,
    stage,
    staged,
)

G = date(2026, 9, 7), date(2026, 9, 14)


def _p(role: str, menu: tuple[str, ...] | None = None, scope_all: bool = False) -> Principal:
    return Principal(user_id=uuid.uuid4(), email="x@example.test", role=role, operator="none", scope_all=scope_all,  # type: ignore[arg-type]
                     scope_brands=("Kia",), scope_regions=(), scope_countries=(), menu_groups=menu,  # type: ignore[arg-type]
                     is_qa_reviewer=False)


# ════════════════════════════════════════════════════════════════════════════
# 표면 경로 게이트(D-vendor, route-policy.ts:26-35)
# ════════════════════════════════════════════════════════════════════════════
def test_surface_gate_matrix_matches_route_policy():
    expect = {  # (역할, 표면) → 허용 (route-policy STANDARD_VIEWERS·WEBSITE_VIEWERS·PROJECT_VIEWERS)
        "hq": {"global", "website", "project"}, "region": {"global", "website", "project"}, "country": {"global", "website", "project"},
        "admin": {"global", "website", "project"}, "vendor": {"project"}, "website": {"website"},
    }
    for role, ok in expect.items():
        for sf in ("global", "website", "project"):
            assert (surface_denial(_p(role), sf) is None) == (sf in ok), (role, sf)
            if sf not in ok:
                assert surface_denial(_p(role), sf) == "role_forbidden"
    assert SURFACE_MENU == {"global": "standard", "website": "website", "project": "project"}
    assert SURFACE_ROLES["website"] == SURFACE_ROLES["global"] | {"website"}
    # menu_groups 는 좁히기만(역할이 허용해도 메뉴 밖이면 menu_forbidden, None = 무제한)
    assert surface_denial(_p("hq", ("standard", "project")), "website") == "menu_forbidden"
    assert surface_denial(_p("hq", ("website",)), "website") is None
    assert surface_denial(_p("vendor", ("standard",)), "global") == "role_forbidden"      # 메뉴로 넓힐 수 없다
    with pytest.raises(ValueError):
        surface_denial(_p("hq"), "nope")
    # 시장 지도(showsGeoMap): 무제한 스코프 ∨ hq·region
    assert shows_geo_map(_p("hq")) and shows_geo_map(_p("region")) and shows_geo_map(_p("admin", scope_all=True))
    assert not shows_geo_map(_p("country")) and not shows_geo_map(_p("vendor"))


@needs_db
async def test_surface_gate_in_read_context_and_http(ro, client_as):
    for uid, sf, code in ((VENDOR, "global", "role_forbidden"), (VENDOR, "website", "role_forbidden"),
                          (WEBSITE_KIA, "global", "role_forbidden"), (WEBSITE_KIA, "project", "role_forbidden"),
                          (HQ_HYUNDAI, "website", "menu_forbidden")):
        kw = {"project_id": CUST_PROJECT} if sf == "project" else {}
        with pytest.raises(errors.ApiError) as ei:
            await resolve_read_context(ro, await principal(ro, uid), CommonFilters.model_validate({"surface": sf, **kw}),
                                       support=KPI_SUPPORT)
        assert (ei.value.status, ei.value.code) == (403, code), (uid, sf)
    w = await resolve_read_context(ro, await principal(ro, WEBSITE_KIA), CommonFilters.model_validate({"surface": "website"}),
                                   support=KPI_SUPPORT)
    assert w.project_keys == (2,) and w.own_bits == (2,)
    async with client_as(VENDOR) as c:
        r = await c.get("/v1/kpi/summary", params={"surface": "global"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
        assert (await c.get("/v1/kpi/summary", params={"surface": "project", "project_id": str(CUST_PROJECT)})).status_code == 200


# ════════════════════════════════════════════════════════════════════════════
# 공통 필터: from·to 허용 범위, global 의 project_id 표시
# ════════════════════════════════════════════════════════════════════════════
def test_common_filters_date_range():
    CommonFilters.model_validate({"surface": "global", "from": "2000-01-01", "to": "2100-12-31"})
    for f, t in (("0001-01-01", "2026-09-01"), ("2026-09-01", "9999-12-31"), ("1999-12-31", "2000-01-02"), ("2026-09-01", "2101-01-01")):
        with pytest.raises(ValueError):
            CommonFilters.model_validate({"surface": "global", "from": f, "to": t})


@needs_db
async def test_global_project_id_is_marked_ignored(ro, client_as):
    c = await resolve_read_context(ro, await principal(ro, HQ_HYUNDAI),
                                   CommonFilters.model_validate({"surface": "global", "project_id": str(CUST_PROJECT)}), support=KPI_SUPPORT)
    assert "project_id" in c.ignored_filters and c.project_keys == (1,)
    async with client_as(HQ_HYUNDAI) as cl:
        r = await cl.get("/v1/kpi/summary", params={"surface": "global", "from": "0001-01-01", "to": "2026-09-30"})
        assert r.status_code == 422


# ════════════════════════════════════════════════════════════════════════════
# Refs 확장
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_refs_extensions(ro):
    refs = await load_refs(ro)
    assert refs.areas[3] == "Europe" and refs.area_code(refs.countries["DE"].region_key) == "Europe"
    assert refs.hidden_markets == {"global": frozenset({"ID"})} and refs.hidden_market("global", "id")
    assert not refs.hidden_market("website", "ID")
    cat = refs.category(6)
    assert cat is not None and (cat.slug, cat.name, cat.ord) == ("communityForums", "Community & Forums", 6)
    assert len(refs.category_refs) == 13 and refs.categories["communityForums"] == 6
    assert refs.engine_code(1) == "chatgpt" and refs.lang_code(refs.langs["de"]) == "de" and refs.engine_code(99) is None
    assert refs.default_engine_keys == (1, 2)
    us = refs.countries["US"]
    assert refs.country_by_key(us.geo_key) is us


# ════════════════════════════════════════════════════════════════════════════
# core.cycles: hidden_reason·최근 N 버킷·원장·첫 발행·선택 가능 날짜
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_cycle_rows_carry_hidden_reason(ro):
    c = await resolve_read_context(ro, await principal(ro, KIA_EU), CommonFilters.model_validate({"surface": "website"}),
                                   support=KPI_SUPPORT)
    w = await c.window(ro, today=TODAY)
    assert [(r.cyc_key, r.hidden_scope, r.hidden_reason) for r in w.cycles] == [(21, 2, 2)]
    assert w.hidden_reason_of(21) == 2 and w.hidden_reason_of(99) == 0
    assert window_suppression(w, "citations") == SUPPRESS_HIDDEN and window_suppression(w, "mentions") is None


def test_bucket_start_and_slot_rule():
    d = date(2026, 9, 17)                      # 목요일
    assert bucket_start(d, "cycle") == d and bucket_start(d, "week") == date(2026, 9, 14) and bucket_start(d, "month") == date(2026, 9, 1)
    assert CycleRow(1, 1, d, 1, 1).is_slot and not CycleRow(1, 1, d, 1, 2).is_slot and CycleRow(1, 1, d, 3, 2).is_slot


@needs_db
async def test_recent_window(ro):
    r1 = await resolve_recent_window(ro, surface="global", project_keys=(1,), n=1, bucket="cycle", today=TODAY)
    assert (r1.mode, r1.lo, r1.hi, r1.cyc_keys("row")) == ("cumulative", G[1], G[1], (11,))
    r12 = await resolve_recent_window(ro, surface="global", project_keys=(1,), n=12, bucket="cycle", today=TODAY)
    assert (r12.lo, r12.hi, r12.cyc_keys("row")) == (G[0], G[1], (10, 11))
    m = await resolve_recent_window(ro, surface="global", project_keys=(1,), n=1, bucket="month", today=TODAY)
    assert (m.lo, m.hi, m.cyc_keys("row")) == (date(2026, 9, 1), G[1], (10, 11))
    wk = await resolve_recent_window(ro, surface="global", project_keys=(1,), n=1, bucket="week", today=TODAY)
    assert (wk.lo, wk.hi) == (date(2026, 9, 14), G[1])
    none = await resolve_recent_window(ro, surface="global", project_keys=(99,), n=3, bucket="cycle", today=TODAY)
    assert none.lo is None and none.empty and none.generation is not None
    # 수집 오류 전체 숨김은 자리로 남고, 운영자 전체 숨김은 자리가 아니다(T-1 R11)
    async with staged(Update("rd.cycle", {"cyc_key": 11}, {"hidden_scope": 1, "hidden_reason": 1})) as conn:
        w = await resolve_recent_window(conn, surface="global", project_keys=(1,), n=1, bucket="cycle", today=TODAY)
        assert (w.lo, w.cyc_keys("row")) == (G[1], ())
    async with staged(Update("rd.cycle", {"cyc_key": 11}, {"hidden_scope": 1, "hidden_reason": 2})) as conn:
        w = await resolve_recent_window(conn, surface="global", project_keys=(1,), n=1, bucket="cycle", today=TODAY)
        assert (w.lo, w.hi, w.cyc_keys("row")) == (G[0], G[1], (10,))        # 하한 이후 운영자 숨김 회차도 창에 싣되 키에서 빠진다


@needs_db
async def test_ledger_first_published_and_dates(ro):
    rows = await ledger_rows(ro, surface="global", project_keys=(1,), lo=date(2026, 9, 1), hi=date(2026, 9, 30), family="mentions",
                             today=TODAY)
    assert [(r.cyc_key, r.expected_units, r.published) for r in rows] == [(10, 1, True), (11, 10, True)]   # 12 = 진행 중(비서빙 open)
    web = await ledger_rows(ro, surface="website", project_keys=(2,), lo=date(2026, 9, 1), hi=date(2026, 9, 30), family="citations",
                            today=TODAY)
    assert web == []                                                        # 회차 21 = 인용 숨김 → 인용 원장 밖
    early = await ledger_rows(ro, surface="global", project_keys=(1,), lo=date(2026, 9, 1), hi=date(2026, 9, 30), family="mentions",
                              today=date(2026, 9, 10))
    assert [r.cyc_key for r in early] == [10]                               # 11 = 노출일(09-16) 전 → 원장 밖
    async with staged(Update("rd.cycle", {"cyc_key": 12}, {"servable": False, "status": 1})) as conn:     # 마감됐지만 미발행
        led = await ledger_rows(conn, surface="global", project_keys=(1,), lo=date(2026, 9, 1), hi=date(2026, 9, 30),
                                family="mentions", today=TODAY)
        assert [(r.cyc_key, r.published) for r in led] == [(10, True), (11, True), (12, False)]
    assert await first_published(ro, surface="global", project_keys=(1,), family="mentions", today=TODAY) == G[0]
    assert await first_published(ro, surface="website", project_keys=(2,), family="citations", today=TODAY) is None
    assert await first_published(ro, surface="website", project_keys=(2,), family="mentions", today=TODAY) == date(2026, 9, 18)
    with pytest.raises(TypeError):
        await first_published(ro, surface="global", project_keys=(1,), today=TODAY)          # type: ignore[call-arg]  # family 필수
    d = await selectable_round_dates(ro, surface="global", project_keys=(1,), family="mentions", limit=1, today=TODAY)
    assert (d.dates, d.total, d.first) == ((G[1],), 2, G[0]) and d.generation is not None
    d2 = await selectable_round_dates(ro, surface="website", project_keys=(2,), family="any", limit=400, today=TODAY)
    assert (d2.dates, d2.total, d2.first) == ((), 0, None)


# ════════════════════════════════════════════════════════════════════════════
# core.measure: 출처 카테고리 축·acr_cell 기본 엔진·kind·형제 제외·빈 창 단락
# ════════════════════════════════════════════════════════════════════════════
async def _ctx(conn, uid, **kw):
    sup = FilterSupport.of(global_=("brand", "country", "lang", "engine", "period", "source"),
                           website=("brand", "country", "lang", "engine", "period", "source"),
                           project=("country", "lang", "engine", "period", "source"))
    return await resolve_read_context(conn, await principal(conn, uid), CommonFilters.model_validate(kw), support=sup)


@needs_db
async def test_source_category_axis(ro):
    c = await _ctx(ro, ADMIN, surface="global")
    w = await c.window(ro, today=TODAY)
    base = (await fetch_counts(ro, c.measure(), w, parts=("citations",)))[0]
    s = await _ctx(ro, ADMIN, surface="global", source=["officialHmg"])
    ms = s.measure()
    assert ms.source_category_keys == (1,)
    plan = plan_counts(ms, w, parts=("citations",))
    assert [role for role, _ in plan.statements] == ["main", "scan"]       # 출처 축 = 원소 스캔(답변 열은 출처 무관 합)
    a = (await fetch_counts(ro, ms, w, parts=("citations",)))[0]
    b = (await citation_counts(ro, ms, w))[0]
    assert (a["cit_total"], a["cit_owned"], a["cit_target"]) == (b["cit_total"], b["cit_owned"], b["cit_target"])
    assert 0 < a["cit_total"] < base["cit_total"]
    assert not fact_guard(plan.statements[1][1].text)
    # 오버라이드 우선(CATEGORY_EXPR): example.org(dim_source 5) 를 6 으로 바꾸면 communityForums 에 즉시 들어간다
    sql = ("SELECT count(*) FROM rd.citation c WHERE c.surface = CAST(:sf AS int2) AND c.round_date BETWEEN CAST(:lo AS date) "
           "AND CAST(:hi AS date) AND c.cyc_key = ANY(CAST(:ks AS int4[])) AND c.source_key = 4")
    n_org = await fetch_val(ro, sql, {"sf": 1, "lo": w.lo, "hi": w.hi, "ks": list(w.cyc_keys("citations"))})
    cf = await _ctx(ro, ADMIN, surface="global", source=["communityForums"])
    before = (await citation_counts(ro, cf.measure(), w))[0]["cit_total"]
    async with staged(Update("app.citation_domain_override", {"domain": "example.org"}, {"category_key": 6})) as conn:
        cf2 = await _ctx(conn, ADMIN, surface="global", source=["communityForums"])
        w2 = await cf2.window(conn, today=TODAY)
        after = (await citation_counts(conn, cf2.measure(), w2))[0]["cit_total"]
    assert after == before + n_org
    empty = await _ctx(ro, ADMIN, surface="global", source=["nope"])
    assert empty.source_category_keys == () and empty.dropped_filters == {"source": ("nope",)}
    assert (await fetch_counts(ro, empty.measure(), w, parts=("citations",)))[0]["cit_total"] == 0


@needs_db
async def test_acr_default_engine_kind_and_siblings(ro):
    c = await _ctx(ro, HQ_HYUNDAI, surface="global")
    ms = c.measure()
    assert ms.default_engine_keys == (1, 2)
    b = Binder("t")
    w = scope_where(ms, "x", b, dflt_column=False)
    assert "x.engine_key = ANY(" in w[2] and b.params[next(k for k in b.params if b.params[k] == [1, 2])] == [1, 2]
    n = await fetch_val(ro, f"SELECT count(*) FROM rd.acr_cell x WHERE {' AND '.join(w)}", b.params)
    b2 = Binder("t")
    n2 = await fetch_val(ro, "SELECT count(*) FROM rd.acr_cell x WHERE "
                         + " AND ".join(scope_where(MeasureScope(**{**ms.__dict__, "engine_keys": (1, 2)}), "x", b2)), b2.params)
    assert n == n2 == 1
    assert await fetch_val(ro, *(lambda q: (q.text, q.params))(applied_prompts_sql(ms, kind="acr"))) == 1
    assert await fetch_val(ro, *(lambda q: (q.text, q.params))(applied_prompts_sql(ms, kind="single"))) == 3
    with pytest.raises(ValueError):
        applied_prompts_sql(ms, kind="x")  # type: ignore[arg-type]
    win = await c.window(ro, today=TODAY)
    names = {r["brand_key"]: r["name"] for r in await fetch_all(ro, "SELECT brand_key, name FROM rd.dim_brand_name")}
    sib = {names[r["brand_key"]] for r in await brand_rows(ro, ms, win)}
    iso = {names[r["brand_key"]] for r in await brand_rows(ro, ms, win, hmg_siblings=False)}
    assert "Kia" in sib and "Kia" not in iso and iso == sib - {"Kia"}          # GEO-1 브랜드 격리: 관점 밖 HMG 형제 제외


async def test_empty_window_short_circuits_without_db():
    class NoDb:
        async def execute(self, *a, **k):
            raise AssertionError("빈 창인데 DB 문장이 나갔다")
    ms = MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=(1,), owner=None)
    empty = build_window(surface="global", mode="snapshot", rows=[], lo=None, hi=None, generation=1, project_keys=(1,))
    r = (await fetch_counts(NoDb(), ms, empty, parts=("mentions", "gap")))[0]
    assert r["answers"] == 0 and r["gap_base"] == 0
    assert await citation_counts(NoDb(), ms, empty) == [] and await brand_rows(NoDb(), ms, empty) == []
    assert window_suppression(empty, "mentions") == SUPPRESS_NO_SNAPSHOT
    part = build_window(surface="global", mode="cumulative", rows=[CycleRow(1, 1, G[0], 0), CycleRow(2, 1, G[1], 3)], lo=G[0], hi=G[1],
                        generation=1, project_keys=(1,))
    assert window_suppression(part, "mentions") is None and window_suppression(part, "mentions", partial=True) == SUPPRESS_PARTIAL_HIDDEN


# ════════════════════════════════════════════════════════════════════════════
# R09 헤드라인 풀(D-headline)·웹사이트 발행물만
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_headline_pool_rule_and_publication_surface(ro):
    c = await _ctx(ro, KIA_EU, surface="website")
    shown = build_window(surface="website", mode="snapshot", rows=[CycleRow(21, 2, date(2026, 9, 18), 0)], lo=date(2026, 9, 18),
                         hi=date(2026, 9, 18), generation=1, project_keys=(2,))
    args = {"brands": ["Kia"], "countries": None, "langs": None}
    pool_off = Update("rd.report_unit_value", {"round_date": date(2026, 9, 18), "file_seq": 102}, {"in_headline_pool": False})
    async with staged(pool_off) as conn:              # 선택 = 101(풀) + 102(비풀) → 풀 유닛만(현행 publishedSubtotal)
        r = (await url_rates(conn, c.measure(), shown, **args))[None]
        assert (r["target"], r["owned"], r["origin"], r["headline_pool_applied"]) == ((7, 10), (8, 10), "report", True)
    both_off = Update("rd.report_unit_value", {"round_date": date(2026, 9, 18), "file_seq": 101}, {"in_headline_pool": False})
    async with staged(pool_off, both_off) as conn:    # 선택에 풀 유닛 없음 → 전부
        r = (await url_rates(conn, c.measure(), shown, **args))[None]
        assert (r["target"], r["owned"], r["headline_pool_applied"]) == ((10, 15), (12, 15), False)
    non_web = Update("app.report_publication", {"slug": "rep-0918"}, {"surface": "global"})
    async with staged(non_web) as conn:              # 웹사이트 발행물만 합친다
        r = (await url_rates(conn, c.measure(), shown, **args))[None]
        assert r["origin"] == "live" and r["reason"] == "no_publication"


# ════════════════════════════════════════════════════════════════════════════
# 롤백 전용 준비 도우미·envelope·감사 버퍼
# ════════════════════════════════════════════════════════════════════════════
@needs_db
async def test_staged_rolls_back_and_runs_as_api_ro(ro):
    async with staged(Update("rd.cycle", {"cyc_key": 10}, {"expected_units": 77}),
                      Rows("app.hidden_market", [{"surface": "website", "country_code": "DE", "reason": "t"}])) as conn:
        assert await fetch_val(conn, "SELECT current_user") == "api_ro"
        assert await fetch_val(conn, "SELECT expected_units FROM rd.cycle WHERE cyc_key = 10") == 77
        assert (await load_refs(conn)).hidden_market("website", "de")
    async with staged() as conn:
        assert await fetch_val(conn, "SELECT expected_units FROM rd.cycle WHERE cyc_key = 10") == 1
        assert await fetch_val(conn, "SELECT count(*) FROM app.hidden_market WHERE surface = 'website'") == 0
    async with staged(role=None) as conn:
        assert await fetch_val(conn, "SELECT current_user") != "api_ro"
    async with staged() as conn:                     # 블록 안 추가 준비(stage) + 세이브포인트(시험 하나 몫만 되돌림)
        async with savepoint(conn):
            await stage(conn, Update("rd.cycle", {"cyc_key": 10}, {"expected_units": 55}))
            assert await fetch_val(conn, "SELECT expected_units FROM rd.cycle WHERE cyc_key = 10") == 55
            assert await fetch_val(conn, "SELECT current_user") == "api_ro"          # stage 뒤 요청 롤 복귀
        assert await fetch_val(conn, "SELECT expected_units FROM rd.cycle WHERE cyc_key = 10") == 1
        assert await fetch_val(conn, "SELECT current_user") == "api_ro"


def test_page_window_fields_and_audit_pending():
    p = Page(limit=50, window_from=date(2026, 9, 1), window_to=date(2026, 9, 30))
    assert p.model_dump(mode="json")["window_from"] == "2026-09-01" and Page(limit=1).window_to is None
    w = AccessAuditWriter()
    assert w.pending() == ()
    w.record(_p("hq"), "data_access", "x", target="t")
    ev = w.pending()
    assert len(ev) == 1 and ev[0].action == "x"
    w.record(_p("hq"), "download", "y")
    assert len(ev) == 1 and len(w.pending()) == 2                             # 스냅샷(버퍼 참조 아님)


@needs_db
async def test_kia_us_country_scope_unchanged(ro):
    """회귀: 계정 국가 스코프는 global·website 데이터 경로에 그대로(D-vendor 와 무관), project 는 미적용(모듈-필터 열린 질문 6)."""
    k = await _ctx(ro, KIA_US, surface="global")
    assert k.countries == ("US",)
    p = await resolve_read_context(ro, await principal(ro, HQ_HYUNDAI), CommonFilters.model_validate(
        {"surface": "project", "project_id": str(CUST_PROJECT)}), support=KPI_SUPPORT)
    assert p.countries is None and p.geo_keys is None
