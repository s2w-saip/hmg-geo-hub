"""bg-kpi-filters 검증 결함(D1·D2·D3·D5) 회귀. 재현 = 검증자 절차 그대로(스테이징은 gaps.pgsql, 블록이 끝나면 ROLLBACK).

기대값은 구현 SQL 을 복사하지 않는다: D1 은 카탈로그 목록 GET /v1/prompts(모듈-프롬프트 §5 대상 시장 3분기, 같은 계정)를 오라클로 쓰고,
D5 는 원시 app.prompt·rd.catalog_entry 행을 읽어 파이썬으로 비트를 판정한다.
"""
from __future__ import annotations

import pathlib
from datetime import date

import pytest

from app.features.analytics.kpi.summary.shared import kpi_today
from app.features.analytics.kpi.summary.tests.test_gaps import get
from tests.support import ADMIN, HQ_HYUNDAI, KIA_EU, KIA_US, TODAY, Sql, load_named_sql, needs_db, raw_fetch, staged

SUMMARY = "/v1/kpi/summary"
UNMEASURED = "/v1/kpi/unmeasured-prompts"
PROMPTS = "/v1/prompts"
BLOCKS = load_named_sql(pathlib.Path(__file__).with_name("gaps.pgsql"))
pytestmark = needs_db


@pytest.fixture
def today_at():
    """KPI 기준일 고정(test_gaps.today_at 과 같은 덮어쓰기)."""
    from app.main import app

    def set_(d: date = TODAY) -> None:
        app.dependency_overrides[kpi_today] = lambda: d
    set_()
    yield set_
    app.dependency_overrides.pop(kpi_today, None)


async def _catalog_texts(client_as, uid) -> set[str]:
    """같은 계정의 카탈로그 목록(측정 대상 = scope_prompt_id 있음) 본문 집합: 목록 권한 술어의 오라클."""
    r = await get(client_as, uid, PROMPTS, surface="global", measured="true")
    assert r.status_code == 200, r.text
    return {i["text"] for i in r.json()["data"]["items"]}


# ── D1: 미측정 목록이 계정 대상 시장 밖 카탈로그 행의 본문을 내지 않는다 ─────────────
async def test_d1_unmeasured_respects_market_scope_kia_eu(client_as, today_at):
    async with staged(Sql(BLOCKS["regions_us_only"]), actor=ADMIN):
        allowed = await _catalog_texts(client_as, KIA_EU)
        assert "us only" not in allowed and {"common q", "acr q"} <= allowed               # 카탈로그 목록 = 시장 밖 행 제외
        b = (await get(client_as, KIA_EU, UNMEASURED, surface="global")).json()
        texts = [i["text"] for i in b["data"]["items"]]
        assert "us only" not in texts                                                      # 재현: 수정 전 3건('us only' 본문·분류 노출)
        assert set(texts) <= allowed and set(texts) == {"common q", "acr q"} and b["meta"]["page"]["total"] == len(texts) == 2
        card = (await get(client_as, KIA_EU, SUMMARY, surface="global")).json()["data"]["params"]
        # 카드 applied_prompts 는 시장 게이트를 걸지 않는다(현행 catalogPromptCountWhere 와 같음, 게이트 여부는 메인 결정 대기
        # CORE-REQUESTS/bg-kpi-filters.md R1). 그래서 이 계정은 목록 total < 카드 applied − measured 다.
        assert card["measured_prompts"] == 0 and card["applied_prompts"] == 3


async def test_d1_unmeasured_respects_market_scope_kia_us(client_as, today_at):
    base = (await get(client_as, KIA_US, UNMEASURED, surface="global")).json()
    assert [i["text"] for i in base["data"]["items"]] == ["common q", "us only"]            # 무스테이징(regions NULL) 결과는 그대로
    async with staged(Sql(BLOCKS["regions_common_kr"]), actor=ADMIN):
        allowed = await _catalog_texts(client_as, KIA_US)
        assert "common q" not in allowed
        b = (await get(client_as, KIA_US, UNMEASURED, surface="global")).json()
        assert [i["text"] for i in b["data"]["items"]] == ["us only"] and b["meta"]["page"]["total"] == 1
        # 국가 스코프 없는 계정(ADMIN)은 시장 게이트가 없다(regions KR 행도 적용 집합)
        a = (await get(client_as, ADMIN, UNMEASURED, surface="global")).json()
        assert "common q" in {i["text"] for i in a["data"]["items"]}


async def test_d1_unmeasured_excludes_soft_deleted_rows(client_as, today_at):
    async with staged(Sql(BLOCKS["soft_delete_us_only"]), actor=ADMIN) as conn:
        left = await raw_fetch(conn, "SELECT count(*) AS n FROM rd.catalog_entry WHERE catalog_row_id = 'c1000000-0000-4000-8000-000000000006'")
        assert left[0]["n"] == 1                                                            # 재판정 전: 파생 행은 아직 있다
        b = (await get(client_as, KIA_US, UNMEASURED, surface="global")).json()
        assert [i["text"] for i in b["data"]["items"]] == ["common q"]


# ── D3: 측정 프롬프트 0 인 비어 있지 않은 창 = prompts_without_brand null(no_data) ────────
async def test_d3_prompts_without_brand_null_when_nothing_measured(client_as, today_at):
    for params in ({}, {"lang": "ko"}):
        b = (await get(client_as, KIA_EU, SUMMARY, surface="global", **params)).json()
        assert b["meta"]["as_of"] is not None and "*" not in b["meta"]["suppressed"]          # 창은 비어 있지 않다
        assert b["data"]["params"]["measured_prompts"] == 0
        assert b["data"]["params"]["prompts_without_brand"] is None                          # 재현: 수정 전 0
        assert b["meta"]["suppressed"]["prompts_without_brand"] == "no_data"
    k = (await get(client_as, KIA_US, SUMMARY, surface="global")).json()                    # 측정이 있으면 값(회귀 없음)
    assert k["data"]["params"]["prompts_without_brand"] == 1 and "prompts_without_brand" not in k["meta"]["suppressed"]


# ── D2: depth4 를 선언하지 않은 엔드포인트는 meta.ignored_filters 에 적는다 ──────────────
@pytest.mark.parametrize("url", ["/v1/mentions/brands", "/v1/citations/domains", "/v1/geo"])
async def test_d2_depth4_ignored_on_undeclared_endpoints(client_as, today_at, url):
    async with staged(Sql(BLOCKS["depth4_marks"]), actor=ADMIN):
        base = (await get(client_as, ADMIN, url, surface="global")).json()
        b = (await get(client_as, ADMIN, url, surface="global", depth4="D4y")).json()
        assert "depth4" in b["meta"]["ignored_filters"]                                     # 재현: 수정 전 []
        assert b["data"] == base["data"]                                                    # 값은 무필터와 같다(적용하지 않는다)
        s = (await get(client_as, ADMIN, SUMMARY, surface="global", depth4="D4y")).json()
        assert "depth4" not in s["meta"]["ignored_filters"]                                  # 선언한 KPI 는 적용


async def test_d2_catalog_prompts_depth4_single_mark(client_as, today_at):
    async with staged(Sql(BLOCKS["depth4_marks"]), actor=ADMIN):
        g = (await get(client_as, ADMIN, PROMPTS, surface="global", depth4="D4y")).json()
        assert "depth4" not in g["meta"]["ignored_filters"]                                  # 자체 인자로 적용(CATALOG_SUPPORT 선언)
        assert [i["text"] for i in g["data"]["items"]] == ["현대 SUV 추천"]
        w = (await get(client_as, ADMIN, PROMPTS, surface="website", depth4="D4y")).json()
        assert w["meta"]["ignored_filters"].count("depth4") == 1                             # core·모듈 표식이 겹쳐도 한 번


# ── D5: depth4 행 매칭·dropped 는 관점 카탈로그 행(brand_bit ∈ pop_bits)으로 한정 ─────────
async def test_d5_depth4_limited_to_viewpoint_catalog_rows(client_as, today_at):
    async with staged(Sql(BLOCKS["depth4_genesis"]), actor=ADMIN) as conn:
        rows = await raw_fetch(conn, "SELECT ce.prompt_key, ce.brand_bit FROM rd.catalog_entry ce JOIN app.prompt p "
                                     "ON p.prompt_id = ce.catalog_row_id WHERE p.depth4 = 'D4z'")
        bits = {int(r["brand_bit"]) for r in rows}
        assert rows and not any(x & 9 for x in bits)                                                       # D4z 행은 현대(1)·엄브렐러(8) 밖
        h = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", depth4="D4z")).json()
        assert h["meta"]["dropped_filters"] == {"depth4": ["D4z"]}                           # 재현: 수정 전 dropped 없음 + answers 2
        assert h["data"]["params"]["answers"] == 0 and h["data"]["params"]["applied_prompts"] == 0
        u = (await get(client_as, HQ_HYUNDAI, UNMEASURED, surface="global", depth4="D4z")).json()
        assert u["data"]["items"] == [] and u["meta"]["page"]["total"] == 0
        a = (await get(client_as, ADMIN, SUMMARY, surface="global", depth4="D4z")).json()
        assert a["meta"]["dropped_filters"] == {} and a["data"]["params"]["applied_prompts"] == len({r["prompt_key"] for r in rows})


# ── 2차 검증(c755897) 결함 회귀 ─────────────────────────────────────────────────────────
async def _catalog_all(client_as, uid, **params) -> list[str]:
    """같은 계정·같은 필터의 카탈로그 목록 GET /v1/prompts(global) 본문(검증자 재현과 같은 호출: measured 인자 없음)."""
    r = await get(client_as, uid, PROMPTS, surface="global", **params)
    assert r.status_code == 200, r.text
    return [i["text"] for i in r.json()["data"]["items"]]


@pytest.mark.parametrize(("uid", "catalog", "unmeasured"), [
    (KIA_EU, ["acr q"], ["acr q"]),                     # 재현: 수정 전 ['acr q','common q','us only']
    (KIA_US, ["acr q", "us only"], ["us only"]),        # 재현: 수정 전 'common q'(KR 전용)가 미측정에 나왔다
])
async def test_r2_d1_unmeasured_subset_of_catalog_repro(client_as, today_at, uid, catalog, unmeasured):
    async with staged(Sql(BLOCKS["regions_d1_repro"]), actor=ADMIN):
        cat = await _catalog_all(client_as, uid)
        assert sorted(cat) == catalog                                                          # 오라클 = 검증자가 본 카탈로그 목록
        b = (await get(client_as, uid, UNMEASURED, surface="global")).json()
        texts = [i["text"] for i in b["data"]["items"]]
        ids = {i["prompt_id"] for i in b["data"]["items"]}
        assert set(texts) <= set(cat) and texts == unmeasured and b["meta"]["page"]["total"] == len(texts)
        if uid == KIA_EU:
            assert not ids & {"c1000000-0000-4000-8000-000000000002", "c1000000-0000-4000-8000-000000000006"}
        else:
            assert "c1000000-0000-4000-8000-000000000002" not in ids


@pytest.mark.parametrize("params", [{"funnel": "F2"}, {"funnel": "F1"}, {"list_type": "L1"}, {"depth1": "D1"}])
async def test_r2_d1_unmeasured_subset_under_taxonomy(client_as, today_at, params):
    """택소노미 축을 걸어도 미측정 목록 ⊆ 같은 필터의 카탈로그 목록(시장·축을 같은 행이 통과해야 한다)."""
    async with staged(Sql(BLOCKS["regions_d1_repro"]), actor=ADMIN):
        for uid in (KIA_EU, KIA_US, HQ_HYUNDAI, ADMIN):
            cat = set(await _catalog_all(client_as, uid, **params))
            b = (await get(client_as, uid, UNMEASURED, surface="global", **params)).json()
            assert {i["text"] for i in b["data"]["items"]} <= cat, (uid, params, b["data"]["items"])


# ── 2차 D2: depth4 비선언 엔드포인트 표식(검증자 재현 계정·값 그대로) ────────────────────
@pytest.mark.parametrize("url", ["/v1/mentions/brands", "/v1/citations/domains", "/v1/geo"])
async def test_r2_d2_unknown_depth4_marked_ignored_hq(client_as, today_at, url):
    base = (await get(client_as, HQ_HYUNDAI, url, surface="global")).json()
    b = (await get(client_as, HQ_HYUNDAI, url, surface="global", depth4="nope")).json()
    assert b["meta"]["ignored_filters"] == ["depth4"] and b["meta"]["dropped_filters"] == {}   # 재현: 수정 전 [] + {}
    assert b["data"] == base["data"]
    s = (await get(client_as, HQ_HYUNDAI, SUMMARY, surface="global", depth4="nope")).json()
    assert s["meta"]["dropped_filters"] == {"depth4": ["nope"]} and "depth4" not in s["meta"]["ignored_filters"]


# ── 2차 D3: 대표 행은 활성 택소노미·depth4 술어를 통과하는 형제 카탈로그 행 중에서 고른다 ─────
async def test_r2_d3_representative_row_matches_filter(client_as, today_at):
    async with staged(Sql(BLOCKS["sibling_rows_key6"]), actor=ADMIN) as conn:
        rows = await raw_fetch(conn, "SELECT p.prompt_id::text AS id, p.text, p.funnel_stage, p.depth4 FROM rd.catalog_entry ce "
                                     "JOIN app.prompt p ON p.prompt_id = ce.catalog_row_id WHERE ce.prompt_key = 6 ORDER BY p.prompt_id")
        assert [r["text"] for r in rows] == ["us only", "best suv (G)"]                     # 키 6 에 형제 행 둘(작은 id = F2 행)
        base = (await get(client_as, ADMIN, UNMEASURED, surface="global")).json()["data"]["items"]
        k6 = [i for i in base if i["scope_prompt_id"] == next(x["scope_prompt_id"] for x in base if x["text"] == "us only")]
        assert [i["text"] for i in k6] == ["us only"]                                        # 무필터 = 가장 작은 id 행(한 키 한 행)
        for params, text, stage in (({"funnel": "F1"}, "best suv (G)", "F1"), ({"depth4": "D4g"}, "best suv (G)", "F1"),
                                    ({"funnel": "F2"}, "us only", "F2")):
            items = (await get(client_as, ADMIN, UNMEASURED, surface="global", **params)).json()["data"]["items"]
            got = [i for i in items if i["scope_prompt_id"] == k6[0]["scope_prompt_id"]]
            assert [(i["text"], i["funnel_stage"]) for i in got] == [(text, stage)], params  # 재현: 수정 전 F1·D4g 에서 'us only'(F2)
            assert {i["funnel_stage"] for i in items} <= {stage}                             # 목록 전체가 필터 값과 맞는다
