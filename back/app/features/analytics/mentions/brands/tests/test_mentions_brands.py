"""GET /v1/mentions/brands (M-1) 통합 테스트. 기대값은 합성 픽스처 손 계산(아래 주석, back/tests/fixtures/fixture-10-data.sql).

글로벌 스냅샷 = 회차 11(round_date 2026-09-14). 기본 엔진·std_in 답변: k1(US·bgrp 5·chatgpt) k2(US·5·gemini) k12(US·8·chatgpt).
  현대 관점(bgrp 에 1|8 비트): 답변 3, 전체 언급 7+3+1 = 11, 당사 노출 k1·k12 = 2, 당사 언급 4+0+1 = 5, 당사 순위 2+1 / 2.
  경쟁 행(competitive ∧ std_in ∧ own_bit ≠ 1): Toyota k1 3(rk 1, neu 1·neg 1) · Kia k2 2(rk 1, pos 1·mix 1) · smart k2 1(rk 2).
    비경쟁 행(Apple k1, smart k2 두 번째 행)과 std_in 거짓 k3(Kia·Tata)은 빠진다.
  당사 감성(answer_brand Hyundai 행): k1 pos 3·neu 1, k12 pos 1 → 4·1·0·0.
  순위: Hyundai 5 > Toyota 3 > Kia 2 > smart 1.
기아 US 계정(관점 Kia, 국가 US): bgrp 에 2|8 비트 → k12 만. 경쟁 = Hyundai k12 1(형제 HMG 는 경쟁 행). Toyota(k1)는 보이지 않아야 한다.
admin(관점 1·2·4): 답변 3, 당사 언급 4+2+1 = 7, 노출 3, 순위 LEAST(k1 2, k2 1, k12 1) = 4/3. 경쟁 Toyota 3·smart 1(Kia 는 당사).
"""
from __future__ import annotations

import uuid

import pytest

from app.core import auth as auth_mod
from app.core.auth import Principal
from app.core.filters import resolve_read_context
from app.features.analytics.mentions.brands.common import MENTIONS_SUPPORT
from app.features.analytics.mentions.brands.schemas import BrandsQuery
from app.features.analytics.mentions.brands.service import mention_brands
from app.features.analytics.mentions.brands.tests.mentions_testkit import (
    GLOBAL_PREV,
    GLOBAL_SNAPSHOT,
    BrandRow,
    SynthAnswer,
    borrowed_run,
    brand_keys,
    cycle_row,
    hide,
    insert_answers,
    patch_window,
    prompt_key,
    rollback_tx,
)
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, TODAY, VENDOR, needs_db, principal

pytestmark = needs_db
URL = "/v1/mentions/brands"
NAMES = ["Hyundai", "Kia", "Toyota", "smart", "BMW"]
P1 = "b0000000-0000-4000-8000-000000000001"
J1 = "90000000-0000-4000-8000-000000000001"       # 픽스처 k1(run·적재를 합성 행이 빌린다)
RANGE = {"from": "2026-09-01", "to": "2026-09-30"}


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _by_name(body):
    return {b["name"]: b for b in body["data"]["brands"]}


async def test_global_hyundai_shape_and_values(client_as, ro):
    k = await brand_keys(ro, NAMES)
    r = await _get(client_as, HQ_HYUNDAI, surface="global")
    assert r.status_code == 200, r.text
    body = r.json()
    d, m = body["data"], body["meta"]
    assert m["mode"] == "snapshot" and m["as_of"] == "2026-09-14" and m["cycles"] == ["2026-09-14"] and m["suppressed"] == {}
    assert d["totals"] == {"answers": 3, "mentions_total": 11, "brand_count": 4}
    assert d["own"] == {"vp_label": "Hyundai", "brands": ["Hyundai"], "rank": 1, "mentions": 5,
                        "exposure": {"num": 2, "den": 3}, "share": {"num": 5, "den": 11}, "avg_rank": {"sum": 3, "count": 2}}
    assert [(b["name"], b["rank"], b["is_own"]) for b in d["brands"]] == [
        ("Hyundai", 1, True), ("Toyota", 2, False), ("Kia", 3, False), ("smart", 4, False)]
    b = _by_name(body)
    assert b["Hyundai"]["brand_key"] == k["Hyundai"] and b["Hyundai"]["sentiment"] == {"positive": 4, "neutral": 1, "mixed": 0, "negative": 0}
    assert b["Toyota"] == {"brand_key": k["Toyota"], "name": "Toyota", "is_own": False, "rank": 2, "mentions": 3,
                           "exposure": {"num": 1, "den": 3}, "share": {"num": 3, "den": 11}, "avg_rank": {"sum": 1, "count": 1},
                           "sentiment": {"positive": 0, "neutral": 1, "mixed": 0, "negative": 1}}
    assert b["Kia"]["sentiment"] == {"positive": 1, "neutral": 0, "mixed": 1, "negative": 0}
    assert b["smart"]["avg_rank"] == {"sum": 2, "count": 1}
    assert "Apple" not in b and "Tata" not in b                                    # 비경쟁 행·std_in 거짓 답변 제외


async def test_top_n_sort_and_brand_key(client_as, ro):
    k = await brand_keys(ro, NAMES)
    r = await _get(client_as, HQ_HYUNDAI, surface="global", top_n=1)
    assert [b["name"] for b in r.json()["data"]["brands"]] == ["Hyundai", "Toyota"]     # 당사 행은 top_n 과 무관
    r = await _get(client_as, HQ_HYUNDAI, surface="global", sort="avg_rank")
    assert [b["name"] for b in r.json()["data"]["brands"]] == ["Toyota", "Kia", "Hyundai", "smart"]   # 1.0, 1.0, 1.5, 2.0(동률은 rank)
    r = await _get(client_as, HQ_HYUNDAI, surface="global", brand_key=[k["smart"], 2**31 - 1])   # 없는 키는 무시
    assert [(b["name"], b["rank"]) for b in r.json()["data"]["brands"]] == [("Hyundai", 1), ("smart", 4)]   # 순위는 전체 기준 유지
    r = await _get(client_as, HQ_HYUNDAI, surface="global", sort="share")                # 분모 공유라 mentions 와 같은 순서
    assert [(b["name"], b["share"]) for b in r.json()["data"]["brands"]] == [
        ("Hyundai", {"num": 5, "den": 11}), ("Toyota", {"num": 3, "den": 11}), ("Kia", {"num": 2, "den": 11}), ("smart", {"num": 1, "den": 11})]


async def test_filter_changes_values(client_as):
    base = (await _get(client_as, HQ_HYUNDAI, surface="global")).json()["data"]
    r = await _get(client_as, HQ_HYUNDAI, surface="global", engine="gemini")          # k2 만
    d = r.json()["data"]
    assert base["totals"]["answers"] == 3 and d["totals"] == {"answers": 1, "mentions_total": 3, "brand_count": 3}
    assert d["own"]["mentions"] == 0 and d["own"]["avg_rank"] is None
    assert {b["name"]: b["mentions"] for b in d["brands"]} == {"Kia": 2, "smart": 1, "Hyundai": 0}
    r = await _get(client_as, HQ_HYUNDAI, surface="global", funnel="F2")               # 현대 모수 F2 프롬프트(2·6)에 std_in 답변 없음
    assert r.json()["data"]["totals"]["answers"] == 0
    r = await _get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-01", "to": "2026-09-30"})
    d = r.json()
    assert d["meta"]["mode"] == "cumulative" and d["meta"]["cycles"] == ["2026-09-07", "2026-09-14"]
    assert d["data"]["totals"]["answers"] == 3                                        # 회차 10 답변은 전부 결손(std_in 거짓)


async def test_kia_us_scope_no_leak(client_as):
    r = await _get(client_as, KIA_US, surface="global", country=["US", "DE"])
    body = r.json()
    assert r.status_code == 200 and body["meta"]["dropped_filters"] == {"country": ["DE"]}
    d = body["data"]
    assert d["totals"] == {"answers": 1, "mentions_total": 1, "brand_count": 2}
    assert d["own"]["vp_label"] == "Kia" and d["own"]["mentions"] == 0 and d["own"]["exposure"] == {"num": 0, "den": 1}
    assert {b["name"]: (b["mentions"], b["is_own"]) for b in d["brands"]} == {"Hyundai": (1, False), "Kia": (0, True)}


async def test_admin_multi_viewpoint(client_as):
    d = (await _get(client_as, ADMIN, surface="global")).json()["data"]
    assert d["own"]["vp_label"] == "HMG" and d["own"]["brands"] == ["Hyundai", "Kia", "Genesis", "Hyundai N"]   # 하위 브랜드는 부모 비트로 접힘
    assert (d["own"]["mentions"], d["own"]["exposure"], d["own"]["avg_rank"]) == (7, {"num": 3, "den": 3}, {"sum": 4, "count": 3})
    b = _by_name({"data": d})
    assert b["HMG"]["brand_key"] is None and set(b) == {"HMG", "Toyota", "smart"}
    assert b["HMG"]["sentiment"] == {"positive": 5, "neutral": 1, "mixed": 1, "negative": 0}   # Hyundai 4·1 + Kia(k2) pos 1·mix 1


async def test_website_and_project(client_as):
    r = await _get(client_as, KIA_EU, surface="website")
    d = r.json()["data"]                                    # 회차 21(인용 숨김, 언급은 보임): k21·k22
    assert r.status_code == 200 and d["totals"] == {"answers": 2, "mentions_total": 1, "brand_count": 1}
    assert d["own"]["mentions"] == 1 and d["brands"][0]["sentiment"] == {"positive": 0, "neutral": 1, "mixed": 0, "negative": 0}
    r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), lang="en")
    body = r.json()
    assert r.status_code == 200 and body["data"]["totals"]["answers"] == 1 and body["meta"]["ignored_filters"] == ["lang"]


async def test_access_denied(client_as):
    assert (await _get(client_as, None, surface="global")).status_code == 401
    assert (await _get(client_as, SUSPENDED, surface="global")).json()["error"]["code"] == "no_account"
    r = await _get(client_as, VENDOR, surface="global")                       # route-policy: vendor 는 표준 화면 밖
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    r = await _get(client_as, HQ_HYUNDAI, surface="website")                  # 메뉴 그룹 standard·project 만
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
    r = await _get(client_as, KIA_US, surface="project", project_id=str(CUST_PROJECT))   # 현대 US 프로젝트: 스코프 밖 = 404
    assert r.status_code == 404


@pytest.mark.parametrize("params", [{"surface": "global", "top_n": 0}, {"surface": "global", "top_n": 101},
                                    {"surface": "global", "sort": "x"}, {"surface": "global", "brand_key": 0},
                                    {"surface": "global", "brand_key": 2**31}, {"surface": "global", "brand_key": 2**63},
                                    {"surface": "global", "brand_key": 10**30},
                                    {"surface": "nope"}, {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"}])
async def test_bad_params_422(client_as, params):
    r = await _get(client_as, HQ_HYUNDAI, **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"


async def test_empty_window(client_as):
    r = await _get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2025-01-01", "to": "2025-01-31"})
    body = r.json()
    assert r.status_code == 200 and body["meta"]["cycles"] == [] and body["meta"]["suppressed"] == {}
    assert body["data"]["totals"] == {"answers": 0, "mentions_total": 0, "brand_count": 1}
    assert [b["name"] for b in body["data"]["brands"]] == ["Hyundai"] and body["data"]["own"]["avg_rank"] is None


async def test_int4_boundary_brand_key(client_as):
    """D1 회귀: int4 상한 이내는 통과(없는 키 = 무시), 넘으면 바인드 전에 422(이전에는 asyncpg DataError → 500)."""
    r = await _get(client_as, HQ_HYUNDAI, surface="global", brand_key=[2**31 - 1])
    assert r.status_code == 200 and [b["name"] for b in r.json()["data"]["brands"]] == ["Hyundai"]
    for v in (2**31, 2**63, 10**30):
        r = await _get(client_as, HQ_HYUNDAI, surface="global", brand_key=[v])
        assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (v, r.text)


async def test_mentions_hidden_cycle_over_http(client_as, monkeypatch):
    """회차 언급 숨김(hidden_scope 3): 스냅샷 = 전체 억제 hidden·0, 기간 = 숨긴 회차만 빠짐(억제 없음)."""
    patch_window(monkeypatch, hide([GLOBAL_SNAPSHOT]))
    body = (await _get(client_as, HQ_HYUNDAI, surface="global")).json()
    assert body["meta"]["suppressed"] == {"*": "hidden"} and body["meta"]["cycles"] == ["2026-09-14"]
    assert body["data"]["totals"] == {"answers": 0, "mentions_total": 0, "brand_count": 1}
    assert [b["name"] for b in body["data"]["brands"]] == ["Hyundai"] and body["data"]["own"]["mentions"] == 0
    body = (await _get(client_as, HQ_HYUNDAI, surface="global", **RANGE)).json()
    assert body["meta"]["suppressed"] == {} and body["data"]["totals"]["answers"] == 0       # 남은 회차 10 은 전부 결손
    monkeypatch.undo()
    patch_window(monkeypatch, hide([GLOBAL_PREV]))
    body = (await _get(client_as, HQ_HYUNDAI, surface="global", **RANGE)).json()
    assert body["meta"]["suppressed"] == {} and body["data"]["totals"] == {"answers": 3, "mentions_total": 11, "brand_count": 4}


async def test_website_role_gate(client_as):
    """website 역할(route-policy WEBSITE_VIEWERS 만): website 200, global·project 403 role_forbidden."""
    from app.main import app
    p = Principal(user_id=uuid.uuid4(), email="t-web@example.test", role="website", operator="none", scope_all=False,
                  scope_brands=("Kia",), scope_regions=(), scope_countries=("DE",), menu_groups=None, is_qa_reviewer=False)
    app.dependency_overrides[auth_mod.get_principal] = lambda: p
    try:
        r = await _get(client_as, KIA_EU, surface="website")
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["totals"] == {"answers": 2, "mentions_total": 1, "brand_count": 1} and d["own"]["mentions"] == 1
        for params in ({"surface": "global"}, {"surface": "project", "project_id": str(CUST_PROJECT)}):
            r = await _get(client_as, KIA_EU, **params)
            assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden", params
    finally:
        app.dependency_overrides.pop(auth_mod.get_principal, None)


async def _service(tx, ro, refs, uid, **params):
    q = BrandsQuery.model_validate({"surface": "global", **params})
    ctx = await resolve_read_context(tx, await principal(ro, uid), q, support=MENTIONS_SUPPORT, refs=refs)
    win = await ctx.window(tx, today=TODAY)
    return win, await mention_brands(tx, ctx, win, top_n=q.top_n, sort=q.sort, brand_keys=q.brand_key or None)


async def test_cumulative_both_cycles_non_empty(ro, refs):
    """기간 모드에서 두 회차 모두 값이 있을 때 합산: 회차 10 에 std_in 답변 1건(Hyundai 1·rk 3·pos 1, Toyota 3·rk 1·neg 1)을 롤백 트랜잭션에 넣는다.
    기대: 답변 3+1, 전체 언급 11+4, 당사 5+1(노출 3/4, 순위 합 3+3 / 3), Toyota 3+3(노출 2/4, 순위 1+1 / 2, neg 1+1). 당사·Toyota 6 동률은 이름 순."""
    async with rollback_tx() as (c, tx):
        k = await brand_keys(tx, NAMES)
        run_key, load_id = await borrowed_run(c, J1)
        cyc10 = await cycle_row(tx, 1, GLOBAL_PREV)
        await insert_answers(c, [SynthAnswer(
            answer_key=9_101, cyc=cyc10, prompt_key=await prompt_key(tx, P1), engine_key=refs.engines["chatgpt"][0],
            geo_key=refs.geo_key("US"), lang_key=refs.langs["en"], bgrp=5,
            brands=(BrandRow(k["Hyundai"], 1, 1, rk=3, pos=1), BrandRow(k["Toyota"], 0, 3, rk=1, neg=1)))], run_key=run_key, load_id=load_id)
        win, d = await _service(tx, ro, refs, HQ_HYUNDAI, **RANGE)
        assert win.mode == "cumulative" and win.cyc_keys("mentions") == tuple(sorted((cyc10.cyc_key, (await cycle_row(tx, 1, GLOBAL_SNAPSHOT)).cyc_key)))
        assert (d.totals.answers, d.totals.mentions_total, d.totals.brand_count) == (4, 15, 4)
        assert (d.own.rank, d.own.mentions, d.own.exposure.model_dump(), d.own.avg_rank.model_dump()) == (
            1, 6, {"num": 3, "den": 4}, {"sum": 6, "count": 3})
        b = {i.name: i for i in d.brands}
        assert [(i.name, i.rank) for i in d.brands] == [("Hyundai", 1), ("Toyota", 2), ("Kia", 3), ("smart", 4)]
        t = b["Toyota"]
        assert (t.mentions, t.exposure.model_dump(), t.avg_rank.model_dump(), t.sentiment.model_dump()) == (
            6, {"num": 2, "den": 4}, {"sum": 2, "count": 2}, {"positive": 0, "neutral": 1, "mixed": 0, "negative": 2})
        assert b["Hyundai"].sentiment.model_dump() == {"positive": 5, "neutral": 1, "mixed": 0, "negative": 0}
        _, snap = await _service(tx, ro, refs, HQ_HYUNDAI)                          # 스냅샷(회차 11)은 그대로
        assert (snap.totals.answers, snap.totals.mentions_total, snap.own.mentions) == (3, 11, 5)


async def test_multi_own_avg_rank_counts_each_answer_once(ro, refs):
    """다중 관점(HMG) 당사 M04 = 답변마다 당사 브랜드 순위 중 최상위 하나의 평균(헤드투헤드 '당사' 행이 이 값을 쓴다).
    픽스처 답변은 당사 브랜드가 하나씩만 순위를 가져(off: 합 4 / 3) 이 경로를 타지 않는다. 한 답변에 Hyundai rk 3 · Kia rk 1 을 넣으면
    그 답변은 1 하나로 센다 → 순위 합 +1, 순위 답변 +1. 브랜드 행을 합치면 +4 / +2 가 되어 같은 답변을 두 번 센다.
    값은 넣기 전 대비 증분으로 본다(프로필마다 픽스처 모수가 달라도 같은 답변 하나의 몫은 같다)."""
    async with rollback_tx() as (c, tx):
        _, before = await _service(tx, ro, refs, ADMIN)
        k = await brand_keys(tx, NAMES)
        run_key, load_id = await borrowed_run(c, J1)
        cyc11 = await cycle_row(tx, 1, GLOBAL_SNAPSHOT)
        await insert_answers(c, [SynthAnswer(
            answer_key=9_201, cyc=cyc11, prompt_key=await prompt_key(tx, P1), engine_key=refs.engines["chatgpt"][0],
            geo_key=refs.geo_key("US"), lang_key=refs.langs["en"], bgrp=5,
            brands=(BrandRow(k["Hyundai"], 1, 1, rk=3), BrandRow(k["Kia"], 2, 2, rk=1), BrandRow(k["Toyota"], 0, 1, rk=2)))],
            run_key=run_key, load_id=load_id)
        _, d = await _service(tx, ro, refs, ADMIN)
        assert d.own.vp_label == before.own.vp_label == "HMG"
        r0 = before.own.avg_rank.model_dump() if before.own.avg_rank else {"sum": 0, "count": 0}
        assert (d.own.mentions - before.own.mentions, d.own.exposure.num - before.own.exposure.num,
                d.own.avg_rank.sum - r0["sum"], d.own.avg_rank.count - r0["count"]) == (3, 1, 1, 1)


async def test_hyundai_n_only_prompt_excluded_from_hyundai(ro, refs):
    """G-01 결정: Hyundai N 전용(bgrp 16) 답변은 현대 관점 모수에서 빠지고 Hyundai N 관점에는 들어간다(core.measure bgrps).
    회차 11 에 bgrp 16 std_in 답변(Hyundai 당사 2·rk 1, BMW 1)을 넣고 전후 차이로 본다."""
    async with rollback_tx() as (c, tx):
        k = await brand_keys(tx, NAMES)
        run_key, load_id = await borrowed_run(c, J1)
        _, h0 = await _service(tx, ro, refs, HQ_HYUNDAI)
        _, n0 = await _service(tx, ro, refs, ADMIN, brand=["Hyundai N"])
        await insert_answers(c, [SynthAnswer(
            answer_key=9_102, cyc=await cycle_row(tx, 1, GLOBAL_SNAPSHOT), prompt_key=await prompt_key(tx, P1),
            engine_key=refs.engines["chatgpt"][0], geo_key=refs.geo_key("US"), lang_key=refs.langs["en"], bgrp=16,
            brands=(BrandRow(k["Hyundai"], 1, 2, rk=1, pos=2), BrandRow(k["BMW"], 0, 1, rk=2)))], run_key=run_key, load_id=load_id)
        _, h1 = await _service(tx, ro, refs, HQ_HYUNDAI)
        _, n1 = await _service(tx, ro, refs, ADMIN, brand=["Hyundai N"])
        assert h1 == h0 and "BMW" not in {i.name for i in h1.brands}                   # 현대 관점: 변화 없음
        assert n1.own.vp_label == "Hyundai N"
        assert (n1.totals.answers - n0.totals.answers, n1.totals.mentions_total - n0.totals.mentions_total,
                n1.own.mentions - n0.own.mentions) == (1, 3, 2)
        assert {i.name: i.mentions for i in n1.brands}.get("BMW") == 1
