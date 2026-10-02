"""GET /v1/mentions/brands 값 갭 보강(BG-12·13·14·15·16·19, D13 split_own) 통합 테스트.

기대값은 합성 픽스처 손 계산(back/tests/fixtures/fixture-10-data.sql, test_mentions_brands.py 머리 주석과 같은 답변셋).
글로벌 스냅샷(회차 11) 기본 엔진 std_in 답변: k1(p1·US·bgrp 5·chatgpt) k2(p1·US·5·gemini) k12(p3·US·8·chatgpt).
  rd.answer 당사 열: k1 ment_h 4·own_rk_h 2, k2 ment_k 2·own_rk_k 1, k12 ment_h 1·own_rk_h 1. 전체 언급 7 + 3 + 1 = 11.
  rd.answer_brand 경쟁 행(std_in): k1 Hyundai 4(own 1)·Toyota 3, k2 Kia 2(own 2)·smart 1, k12 Hyundai 1. t_mention = 언급 수, 그 밖 유형 0.
현대 관점 include:
  Hyundai(당사, rd.answer): 등장 프롬프트 {p1, p3} = 2, 복수(ment_h ≥ 2) = k1 → 답변 1·언급 4·프롬프트 1, 유형 mention 4 + 1 = 5.
  Toyota: 프롬프트 1, 복수 k1(3) → 1·3·1. Kia(형제, 경쟁): 프롬프트 1, 복수 k2(2) → 1·2·1, HMG 참. smart: 프롬프트 1, 복수 0.
  types_total mention = 5 + 3 + 2 + 1 = 11.
admin split_own(관점 비트 1·2·4 → Hyundai·Kia·Genesis, 행 키 = 비트의 부모 브랜드 코드라 Hyundai N 은 Hyundai 로 접힘):
  Hyundai 5(노출 k1·k12 = 2/3, 순위 2+1 / 2) · Kia 2(노출 1/3, 순위 1/1) · Genesis 0. 경쟁 Toyota 3·smart 1.
  순위: Hyundai 5 > Toyota 3 > Kia 2 > smart 1 > Genesis 0, brand_count 5. own 블록은 합친 관점 그대로(언급 7, 순위 1).
엔진별(현대 관점): chatgpt = k1·k12(답변 2, 전체 언급 8, Hyundai 5·Toyota 3), gemini = k2(답변 1, 전체 3, Kia 2·smart 1·Hyundai 0).
"""
from __future__ import annotations

import pytest

from app.core.filters import resolve_read_context
from app.features.analytics.mentions.brands.common import MENTIONS_SUPPORT
from app.features.analytics.mentions.brands.schemas import FULL_CAP, BrandsQuery
from app.features.analytics.mentions.brands.service import mention_brands, select_items
from app.features.analytics.mentions.brands.tests.mentions_testkit import (
    GLOBAL_SNAPSHOT,
    BrandRow,
    SynthAnswer,
    borrowed_run,
    brand_keys,
    cycle_row,
    insert_answers,
    prompt_key,
    rollback_tx,
)
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, TODAY, VENDOR, needs_db, principal

pytestmark = needs_db
URL = "/v1/mentions/brands"
ALL_INC = ["prompts", "multi", "types", "hmg"]
P1 = "b0000000-0000-4000-8000-000000000001"
P6 = "b0000000-0000-4000-8000-000000000006"
J1 = "90000000-0000-4000-8000-000000000001"
Z5 = {"mention": 0, "recommendation": 0, "comparison": 0, "definition": 0, "final_choice": 0}


def _t(**kw):
    return {**Z5, **kw}


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _by_name(brands):
    return {b["name"]: b for b in brands}


# ── D13 split_own ────────────────────────────────────────────────────────────
async def test_split_own_admin_rows(client_as):
    r = await _get(client_as, ADMIN, surface="global", split_own="true")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["totals"] == {"answers": 3, "mentions_total": 11, "brand_count": 5}
    assert d["own"] == {"vp_label": "HMG", "brands": ["Hyundai", "Kia", "Genesis", "Hyundai N"], "rank": 1, "mentions": 7,
                        "exposure": {"num": 3, "den": 3}, "share": {"num": 7, "den": 11}, "avg_rank": {"sum": 4, "count": 3}}
    assert [(b["name"], b["rank"], b["is_own"], b.get("own_brand_code")) for b in d["brands"]] == [
        ("Hyundai", 1, True, "Hyundai"), ("Toyota", 2, False, None), ("Kia", 3, True, "Kia"), ("smart", 4, False, None),
        ("Genesis", 5, True, "Genesis")]
    b = _by_name(d["brands"])
    assert (b["Hyundai"]["mentions"], b["Hyundai"]["exposure"], b["Hyundai"]["avg_rank"], b["Hyundai"]["sentiment"]) == (
        5, {"num": 2, "den": 3}, {"sum": 3, "count": 2}, {"positive": 4, "neutral": 1, "mixed": 0, "negative": 0})
    assert (b["Kia"]["mentions"], b["Kia"]["exposure"], b["Kia"]["avg_rank"], b["Kia"]["sentiment"]) == (
        2, {"num": 1, "den": 3}, {"sum": 1, "count": 1}, {"positive": 1, "neutral": 0, "mixed": 1, "negative": 0})
    assert b["Genesis"]["mentions"] == 0 and b["Genesis"]["avg_rank"] is None and b["Genesis"]["brand_key"] is None
    assert "own_brand_code" not in b["Toyota"]                                             # 경쟁 행에는 키가 없다
    # 가른 행 합 = 합친 관점 언급(당사 열 가산), 감성 합 = 합친 감성
    base = (await _get(client_as, ADMIN, surface="global")).json()["data"]
    assert sum(x["mentions"] for x in d["brands"] if x["is_own"]) == base["own"]["mentions"] == 7
    assert {k: sum(x["sentiment"][k] for x in d["brands"] if x["is_own"]) for k in ("positive", "neutral", "mixed", "negative")} == \
        _by_name(base["brands"])["HMG"]["sentiment"]


async def test_split_own_single_viewpoint_and_other_surfaces(client_as):
    """D-1 회귀: 관점 비트가 하나면 가르지 않는다(core.measure.split_own_scopes 가 () 를 낸다 = trend 와 같은 판정).
    응답은 split_own 을 주지 않은 것과 바이트까지 같고 own_brand_code 키가 없다."""
    base = (await _get(client_as, HQ_HYUNDAI, surface="global")).json()["data"]
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", split_own="true")).json()["data"]
    assert d == base and all("own_brand_code" not in b for b in d["brands"])
    for uid, params in ((KIA_EU, {"surface": "website"}), (VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT)}),
                        (ADMIN, {"surface": "global", "brand": ["Kia"]})):                   # 마지막: brand[] 로 관점 하나
        base = await _get(client_as, uid, **params)
        r = await _get(client_as, uid, **params, split_own="true")
        assert r.status_code == 200 and r.json()["data"] == base.json()["data"], (uid, params)
        assert all("own_brand_code" not in b for b in r.json()["data"]["brands"])


async def test_split_own_key_is_parent_code_of_bit(client_as):
    """D-1 회귀: 행 키 = 비트의 부모 브랜드 코드(trend/series _own_parts 와 같은 Refs.brand_code_of_bit). 관점이 [Hyundai N, Kia] 여도
    비트 1 행 키는 'Hyundai'(예전 구현은 'Hyundai N' 이라 trend 계열 키와 어긋났다)."""
    d = (await _get(client_as, ADMIN, surface="global", split_own="true", brand=["Hyundai N", "Kia"])).json()["data"]
    assert set(d["own"]["brands"]) == {"Hyundai N", "Kia"}
    own = [b for b in d["brands"] if b["is_own"]]
    assert sorted(b["own_brand_code"] for b in own) == ["Hyundai", "Kia"]
    assert all(b["name"] == b["own_brand_code"] for b in own)
    assert sum(b["mentions"] for b in own) == d["own"]["mentions"]


def test_split_own_scopes_is_trend_contract():
    """D-1 회귀: core.measure.split_own_scopes 는 trend 그룹(818b56f)이 먼저 만든 시그니처 하나다: (ms) → ((bit, 스코프), ...).
    비트 오름차순, 비트 하나면 (), 가른 스코프는 own_bits 만 (bit,) 이고 owner(글로벌 M05 자사 배열)는 None."""
    import inspect

    from app.core.measure import MeasureScope, split_own_scopes

    assert list(inspect.signature(split_own_scopes).parameters) == ["ms"]
    ms = MeasureScope(sf=1, project_keys=(1,), own_bits=(4, 1, 2), bgrps=(5, 8))
    got = split_own_scopes(ms)
    assert [(bit, s.own_bits, s.bgrps, s.owner) for bit, s in got] == [(1, (1,), (5, 8), None), (2, (2,), (5, 8), None), (4, (4,), (5, 8), None)]
    assert split_own_scopes(MeasureScope(sf=1, project_keys=(1,), own_bits=(1,), bgrps=None)) == ()


# ── include(BG-12·13·14·15) ─────────────────────────────────────────────────
async def test_include_values_hyundai(client_as):
    r = await _get(client_as, HQ_HYUNDAI, surface="global", include=ALL_INC)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    b = _by_name(d["brands"])
    assert (b["Hyundai"]["prompts"], b["Hyundai"]["multi"], b["Hyundai"]["types"], b["Hyundai"]["is_hmg_own"]) == (
        2, {"mentions": 4, "answers": 1, "prompts": 1}, _t(mention=5), True)
    assert (b["Toyota"]["prompts"], b["Toyota"]["multi"], b["Toyota"]["types"], b["Toyota"]["is_hmg_own"]) == (
        1, {"mentions": 3, "answers": 1, "prompts": 1}, _t(mention=3), False)
    assert (b["Kia"]["prompts"], b["Kia"]["multi"], b["Kia"]["is_hmg_own"]) == (1, {"mentions": 2, "answers": 1, "prompts": 1}, True)
    assert (b["smart"]["prompts"], b["smart"]["multi"], b["smart"]["is_hmg_own"]) == (1, {"mentions": 0, "answers": 0, "prompts": 0}, False)
    assert d["types_total"] == _t(mention=11)
    # 부분 요청: 요청한 필드만 나온다
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", include=["hmg"])).json()["data"]
    assert all(set(x) - {"brand_key", "name", "is_own", "rank", "mentions", "exposure", "share", "avg_rank", "sentiment"} == {"is_hmg_own"}
               for x in d["brands"]) and "types_total" not in d


async def test_include_split_own_admin(client_as):
    d = (await _get(client_as, ADMIN, surface="global", split_own="true", include=ALL_INC)).json()["data"]
    b = _by_name(d["brands"])
    assert (b["Hyundai"]["prompts"], b["Hyundai"]["multi"], b["Hyundai"]["types"]) == (2, {"mentions": 4, "answers": 1, "prompts": 1},
                                                                                       _t(mention=5))
    assert (b["Kia"]["prompts"], b["Kia"]["multi"], b["Kia"]["types"], b["Kia"]["is_hmg_own"]) == (
        1, {"mentions": 2, "answers": 1, "prompts": 1}, _t(mention=2), True)
    assert (b["Genesis"]["prompts"], b["Genesis"]["multi"], b["Genesis"]["types"]) == (0, {"mentions": 0, "answers": 0, "prompts": 0}, Z5)
    assert d["types_total"] == _t(mention=11)
    d = (await _get(client_as, ADMIN, surface="global", include=ALL_INC)).json()["data"]            # 합친 당사 행
    h = _by_name(d["brands"])["HMG"]
    # 합친 관점: 등장 {p1(k1·k2), p3(k12)} = 2, 복수(당사 열 합 ≥ 2) k1(4)·k2(2) → 답변 2·언급 6·프롬프트 1, 유형 5 + 2
    assert (h["prompts"], h["multi"], h["types"], h["is_hmg_own"]) == (2, {"mentions": 6, "answers": 2, "prompts": 1}, _t(mention=7), True)


async def test_include_synthetic_multi_types(ro, refs):
    """합성 행으로 유형 5종·복수 언급·프롬프트 수를 가른다(회차 11, 현대 관점 bgrp 5, chatgpt US).
    9201(p1): Hyundai 3·rk1, Toyota 2·rk2 유형(0,1,1,0,0), BMW 1·rk3 유형(0,0,0,1,0). 9202(p6): Toyota 2 유형(1,1,0,0,0), Hyundai 1.
    기대(픽스처 + 합성): Hyundai 등장 {p1, p3, p6} = 3, 복수 k1(4)·9201(3) → 2·7·{p1} 1, 유형 mention 4 + 1 + 3 + 1 = 9.
    Toyota 등장 {p1, p6} = 2, 복수 k1(3)·9201(2)·9202(2) → 3·7·2, 유형 mention 3 + 0 + 1 = 4·recommendation 2·comparison 1.
    BMW 등장 1, 복수 0, 유형 definition 1. types_total = mention 9 + 4 + 2(Kia) + 1(smart) = 16, recommendation 2, comparison 1, definition 1."""
    async with rollback_tx() as (c, tx):
        k = await brand_keys(tx, ["Hyundai", "Toyota", "BMW"])
        run_key, load_id = await borrowed_run(c, J1)
        cyc = await cycle_row(tx, 1, GLOBAL_SNAPSHOT)
        common = dict(cyc=cyc, engine_key=refs.engines["chatgpt"][0], geo_key=refs.geo_key("US"), lang_key=refs.langs["en"], bgrp=5)
        await insert_answers(c, [
            SynthAnswer(answer_key=9_201, prompt_key=await prompt_key(tx, P1), **common, brands=(
                BrandRow(k["Hyundai"], 1, 3, rk=1), BrandRow(k["Toyota"], 0, 2, rk=2, types=(0, 1, 1, 0, 0)),
                BrandRow(k["BMW"], 0, 1, rk=3, types=(0, 0, 0, 1, 0)))),
            SynthAnswer(answer_key=9_202, prompt_key=await prompt_key(tx, P6), **common, brands=(
                BrandRow(k["Toyota"], 0, 2, rk=1, types=(1, 1, 0, 0, 0)), BrandRow(k["Hyundai"], 1, 1, rk=2)))],
            run_key=run_key, load_id=load_id)
        q = BrandsQuery.model_validate({"surface": "global", "include": ALL_INC, "full": True})
        ctx = await resolve_read_context(tx, await principal(ro, HQ_HYUNDAI), q, support=MENTIONS_SUPPORT, refs=refs)
        win = await ctx.window(tx, today=TODAY)
        d = await mention_brands(tx, ctx, win, top_n=q.top_n, sort=q.sort, brand_keys=None, include=q.include, full=True)
        b = {i.name: i for i in d.brands}
        assert (b["Hyundai"].prompts, b["Hyundai"].multi.model_dump(), b["Hyundai"].types.model_dump()) == (
            3, {"mentions": 7, "answers": 2, "prompts": 1}, _t(mention=9))
        assert (b["Toyota"].prompts, b["Toyota"].multi.model_dump(), b["Toyota"].types.model_dump()) == (
            2, {"mentions": 7, "answers": 3, "prompts": 2}, _t(mention=4, recommendation=2, comparison=1))
        assert (b["BMW"].prompts, b["BMW"].multi.model_dump(), b["BMW"].types.model_dump(), b["BMW"].is_hmg_own) == (
            1, {"mentions": 0, "answers": 0, "prompts": 0}, _t(definition=1), False)
        assert d.types_total.model_dump() == _t(mention=16, recommendation=2, comparison=1, definition=1)
        # 독립 대조: 브랜드별 유형 합 = rd.answer_brand 원행을 파이썬으로 더한 값(구현 SQL 과 다른 경로)
        raw = await c.fetch("SELECT brand_key, own_bit, t_recommendation, t_comparison FROM rd.answer_brand "
                            "WHERE surface = 1 AND round_date = $1 AND cyc_key = ANY($2::int4[]) AND competitive AND std_in AND dflt "
                            "AND bgrp = ANY('{5,8}'::int2[])", GLOBAL_SNAPSHOT, [cyc.cyc_key])
        rec = sum(int(r["t_recommendation"]) for r in raw if int(r["brand_key"]) == k["Toyota"])
        assert rec == b["Toyota"].types.recommendation == 2


# ── group_by=engine(BG-16) ──────────────────────────────────────────────────
async def test_group_by_engine_matches_engine_filter(client_as):
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", group_by="engine", include=["hmg"])).json()["data"]
    assert [e["engine"] for e in d["by_engine"]] == ["chatgpt", "gemini"]
    e = {x["engine"]: x for x in d["by_engine"]}
    assert e["chatgpt"]["totals"] == {"answers": 2, "mentions_total": 8, "brand_count": 2}
    assert [(b["name"], b["mentions"], b["exposure"]) for b in e["chatgpt"]["brands"]] == [
        ("Hyundai", 5, {"num": 2, "den": 2}), ("Toyota", 3, {"num": 1, "den": 2})]
    assert e["gemini"]["totals"] == {"answers": 1, "mentions_total": 3, "brand_count": 3}
    assert [(b["name"], b["rank"], b["is_hmg_own"]) for b in e["gemini"]["brands"]] == [("Kia", 1, True), ("smart", 2, False), ("Hyundai", 3, True)]
    assert "prompts" not in e["gemini"]["brands"][0]                                     # 엔진별 행은 prompts·multi·types 없음
    # 엔진별 스냅샷 = engine 필터로 부른 결과(다른 경로: 필터 축)
    for eng in ("chatgpt", "gemini"):
        f = (await _get(client_as, HQ_HYUNDAI, surface="global", engine=eng, include=["hmg"])).json()["data"]
        assert f["totals"] == e[eng]["totals"] and f["brands"] == e[eng]["brands"], eng
    # 전체 값은 group_by 와 무관
    base = (await _get(client_as, HQ_HYUNDAI, surface="global")).json()["data"]
    assert (d["totals"], d["own"]) == (base["totals"], base["own"])


async def test_group_by_engine_split_own_and_filters(client_as):
    d = (await _get(client_as, ADMIN, surface="global", group_by="engine", split_own="true")).json()["data"]
    e = {x["engine"]: x for x in d["by_engine"]}
    assert [(b["name"], b["mentions"], b.get("own_brand_code")) for b in e["gemini"]["brands"]] == [
        ("Kia", 2, "Kia"), ("smart", 1, None), ("Genesis", 0, "Genesis"), ("Hyundai", 0, "Hyundai")]
    for eng in ("chatgpt", "gemini"):
        f = (await _get(client_as, ADMIN, surface="global", engine=eng, split_own="true")).json()["data"]
        assert f["brands"] == e[eng]["brands"], eng
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", group_by="engine", engine="gemini")).json()["data"]
    assert [x["engine"] for x in d["by_engine"]] == ["gemini"]                             # 엔진 필터 적용
    d = (await _get(client_as, HQ_HYUNDAI, surface="global", group_by="engine", top_n=1)).json()["data"]
    assert [b["name"] for b in {x["engine"]: x for x in d["by_engine"]}["gemini"]["brands"]] == ["Kia", "Hyundai"]


# ── q·full(BG-19) ───────────────────────────────────────────────────────────
async def test_q_and_full(client_as):
    r = await _get(client_as, HQ_HYUNDAI, surface="global", q="toy")
    assert [(b["name"], b["rank"]) for b in r.json()["data"]["brands"]] == [("Hyundai", 1), ("Toyota", 2)]   # 순위는 전체 기준
    r = await _get(client_as, HQ_HYUNDAI, surface="global", q="SMA")                  # 대소문자 무시
    assert [(b["name"], b["rank"]) for b in r.json()["data"]["brands"]] == [("Hyundai", 1), ("smart", 4)]
    r = await _get(client_as, HQ_HYUNDAI, surface="global", q="zzz")
    assert [b["name"] for b in r.json()["data"]["brands"]] == ["Hyundai"] and r.json()["data"]["totals"]["brand_count"] == 4
    r = await _get(client_as, HQ_HYUNDAI, surface="global", full="true", top_n=1)      # full 은 top_n 무시
    d = r.json()["data"]
    assert [b["name"] for b in d["brands"]] == ["Hyundai", "Toyota", "Kia", "smart"] and d["truncated"] is False
    assert "truncated" not in (await _get(client_as, HQ_HYUNDAI, surface="global")).json()["data"]


def test_full_cap_truncates():
    """전량 모드 상한(코드 상수 FULL_CAP): 경쟁 행이 상한을 넘으면 상한까지만 + truncated."""
    rows = [{"brand_key": None, "name": "Own", "is_own": True, "rank": FULL_CAP + 2, "rank_sum": 0, "ranked": 0}]
    rows += [{"brand_key": i, "name": f"b{i}", "is_own": False, "rank": i, "rank_sum": 0, "ranked": 0} for i in range(1, FULL_CAP + 2)]
    chosen, truncated = select_items(rows, top_n=10, sort="mentions", only_keys=None, full=True)
    assert truncated is True and len(chosen) == FULL_CAP + 1 and chosen[-1]["is_own"]
    chosen, truncated = select_items(rows[:50], top_n=10, sort="mentions", only_keys=None, full=True)
    assert truncated is False and len(chosen) == 50


# ── 권한·빈 결과·422 ─────────────────────────────────────────────────────────
async def test_scope_no_leak_with_new_params(client_as):
    """기아 US 계정: 모수 = k12(bgrp 8)만. 보강 필드·엔진별·전량·검색 어디에도 Toyota·smart(k1·k2)가 나오지 않는다."""
    r = await _get(client_as, KIA_US, surface="global", include=ALL_INC, group_by="engine", full="true", split_own="true",
                   country=["US", "DE"])
    body = r.json()
    assert r.status_code == 200 and body["meta"]["dropped_filters"] == {"country": ["DE"]}
    d = body["data"]
    names = {b["name"] for b in d["brands"]} | {b["name"] for e in d["by_engine"] for b in e["brands"]}
    assert names == {"Hyundai", "Kia"}
    b = _by_name(d["brands"])
    assert (b["Hyundai"]["is_own"], b["Hyundai"]["is_hmg_own"], b["Hyundai"]["prompts"], b["Hyundai"]["types"]) == (False, True, 1, _t(mention=1))
    assert ("own_brand_code" in b["Kia"], b["Kia"]["prompts"], b["Kia"]["types"]) == (False, 0, Z5)      # 단일 관점: 가르지 않음
    assert d["types_total"] == _t(mention=1)
    r = await _get(client_as, KIA_US, surface="global", q="toy")
    assert [b["name"] for b in r.json()["data"]["brands"]] == ["Kia"]


async def test_empty_window_new_params(client_as):
    r = await _get(client_as, ADMIN, surface="global", include=ALL_INC, group_by="engine", split_own="true",
                   **{"from": "2025-01-01", "to": "2025-01-31"})
    d = r.json()["data"]
    assert r.status_code == 200 and d["by_engine"] == [] and d["types_total"] == Z5
    assert [(b["name"], b["prompts"], b["multi"]) for b in d["brands"]] == [
        ("Genesis", 0, {"mentions": 0, "answers": 0, "prompts": 0}), ("Hyundai", 0, {"mentions": 0, "answers": 0, "prompts": 0}),
        ("Kia", 0, {"mentions": 0, "answers": 0, "prompts": 0})]


@pytest.mark.parametrize("params", [{"include": "bogus"}, {"group_by": "country"}, {"q": ""}, {"q": "a\x01b"}, {"q": "x" * 101},
                                    {"split_own": "maybe"}, {"full": "nope"}, {"include": ALL_INC + ["prompts"]}])
async def test_bad_new_params_422(client_as, params):
    r = await _get(client_as, HQ_HYUNDAI, surface="global", **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (params, r.text)


# ── core 9 U6-3: 전량 상한 10000 + meta.truncated ─────────────────────────────────
async def test_full_cap_and_meta_truncated_u63(client_as, monkeypatch):
    """full=true 응답은 meta.truncated = {brands[, by_engine]} 를 싣는다(상한에 걸렸는가). full 이 아니면 키가 없다.
    상한은 10000(stg 답변 등장 경쟁 브랜드 1,933 = 옛 상한 2000 의 97%). 상한을 줄여 잘림 경로를 확인한다."""
    from app.features.analytics.mentions.brands import service as S

    assert FULL_CAP == 10000 and S.FULL_CAP == 10000
    body = (await _get(client_as, HQ_HYUNDAI, surface="global", full="true")).json()
    assert body["meta"]["truncated"] == {"brands": False} and body["data"]["truncated"] is False
    body = (await _get(client_as, HQ_HYUNDAI, surface="global", full="true", group_by="engine")).json()
    assert body["meta"]["truncated"] == {"brands": False, "by_engine": False}
    assert body["data"]["by_engine"] and all(e["truncated"] is False for e in body["data"]["by_engine"])
    plain = (await _get(client_as, HQ_HYUNDAI, surface="global", group_by="engine")).json()
    assert "truncated" not in plain["meta"] and "truncated" not in plain["data"]
    assert all("truncated" not in e for e in plain["data"]["by_engine"])

    monkeypatch.setattr(S, "FULL_CAP", 2)                       # 경쟁 3개(Toyota·Kia·smart) > 2
    body = (await _get(client_as, HQ_HYUNDAI, surface="global", full="true", group_by="engine")).json()
    d = body["data"]
    assert [b["name"] for b in d["brands"]] == ["Hyundai", "Toyota", "Kia"] and d["truncated"] is True
    assert body["meta"]["truncated"] == {"brands": True, "by_engine": any(e["truncated"] for e in d["by_engine"])}
    assert all(len([b for b in e["brands"] if not b["is_own"]]) <= 2 for e in d["by_engine"])
