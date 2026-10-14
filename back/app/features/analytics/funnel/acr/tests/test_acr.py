"""GET /v1/funnel/acr 통합 테스트(로컬 합성 DB). 기대값은 conftest 표와 공용 픽스처 셀 501 에서 손으로 계산했다.

공용 셀 501: 회차 11 · SP3(HMG 엄브렐러 bgrp 8) · chatgpt · US · 유효 2 · Hyundai 선택 1(등장 2) · Toyota 1(1) · Apple keep 거짓.
관리자 스냅샷(회차 11, 기본 엔진 chatgpt·gemini) 셀 = 501·9101·9102 → 셀 3 · 프롬프트 3 · 유효 반복 9.
  Hyundai 선택 1+3+1 = 5(등장 2+4+1 = 7, 셀 3) · Toyota 1+1 = 2(1+2 = 3, 셀 2) · Kia 2(3, 셀 1).
"""
from __future__ import annotations

import pytest

from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_EU, KIA_US, SUSPENDED, VENDOR, Update, needs_db, savepoint, stage

URL = "/v1/funnel/acr"
P3 = "b0000000-0000-4000-8000-000000000003"
P9001 = "b9000000-0000-4000-8000-000000009001"
P9002 = "b9000000-0000-4000-8000-000000009002"
pytestmark = [needs_db, pytest.mark.usefixtures("acr_seed")]


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def _brands(body):
    return {b["brand"]: b for b in body["data"]["brands"]}


async def test_admin_snapshot_shape_and_values(client_as):
    r = await _get(client_as, ADMIN, surface="global")
    assert r.status_code == 200, r.text
    body = r.json()
    d, m = body["data"], body["meta"]
    assert m["mode"] == "snapshot" and m["surface"] == "global" and m["cycles"] == ["2026-09-14"] and m["suppressed"] == {}
    assert d["totals"] == {"prompt_runs": 3, "prompts": 3, "iterations": 9, "engines": ["chatgpt", "gemini"], "catalog_acr_prompts": 3}
    assert [b["brand"] for b in d["brands"]] == ["Hyundai", "Toyota", "Kia"]
    b = _brands(body)
    assert b["Hyundai"] == {"brand": "Hyundai", "is_ours": True, "choice": 5, "appearance": 7, "cells": 3,
                            "choice_share": {"num": 5, "den": 9}, "coverage": {"num": 3, "den": 3}}
    assert b["Toyota"]["is_ours"] is False and b["Toyota"]["choice"] == 2 and b["Toyota"]["cells"] == 2
    assert b["Kia"]["is_ours"] is True and b["Kia"]["coverage"] == {"num": 1, "den": 3}
    assert "Apple" not in b                                                  # keep 거짓 = 비경쟁 이름 제외

    # 추이: 스냅샷 창 끝(09-14)에서 거꾸로 게이트 회차 10·11, 시리즈 = 당사 우선(Hyundai·Kia) + Toyota
    t = d["trend"]
    assert t["series_brands"] == ["Hyundai", "Kia", "Toyota"]
    assert [x["round_date"] for x in t["buckets"]] == ["2026-09-07", "2026-09-14"]
    b07, b14 = t["buckets"]
    assert b07["den"] == 2 and b07["gap"] is False and {s["brand"]: s["num"] for s in b07["series"]} == {"Hyundai": 2, "Kia": 0, "Toyota": 0}
    assert b14["den"] == 9 and {s["brand"]: s["num"] for s in b14["series"]} == {"Hyundai": 5, "Kia": 2, "Toyota": 2}

    # 배틀: 프롬프트 선택 합 내림차순, 동률 승자는 브랜드 이름 순(501: Hyundai 1 = Toyota 1 → Hyundai)
    assert [x["prompt_id"] for x in d["battle"]] == [P9001, P9002, P3]
    cells = {x["prompt_id"]: x["cells"] for x in d["battle"]}
    assert cells[P9001] == [{"engine": "gemini", "winner_brand": "Hyundai", "winner_is_ours": True, "choice": 3}]
    assert cells[P9002] == [{"engine": "chatgpt", "winner_brand": "Kia", "winner_is_ours": True, "choice": 2}]
    assert cells[P3] == [{"engine": "chatgpt", "winner_brand": "Hyundai", "winner_is_ours": True, "choice": 1}]

    # 차종: deepseek 셀의 RAV4 는 기본 엔진 밖
    assert d["model_conversion"] == [{"brand": "Hyundai", "model": "Hyundai Creta", "is_ours": True,
                                      "conversion": {"num": 2, "den": 4}, "cells": 1, "top1": 2}]
    # 점유 맵: (US, chatgpt) 셀 2 > (KR, gemini) 셀 1, 행은 프롬프트 문구 순
    terr = d["territory"]
    assert [(s["country"], s["engine"], len(s["rows"])) for s in terr] == [("US", "chatgpt", 2), ("KR", "gemini", 1)]
    us = terr[0]["rows"]
    assert [row["prompt_text"] for row in us] == ["acr kia q", "acr q"]
    assert us[0]["valid_acr"] == 3 and us[0]["entries"] == [{"brand": "Kia", "choice": 2, "is_ours": True},
                                                          {"brand": "Hyundai", "choice": 1, "is_ours": True}]
    assert us[1]["entries"] == [{"brand": "Hyundai", "choice": 1, "is_ours": True}, {"brand": "Toyota", "choice": 1, "is_ours": False}]
    # 내부 정수 키 비노출
    assert "cyc_key" not in r.text and "brand_key" not in r.text and "geo_key" not in r.text


async def test_hyundai_scope_no_kia_leak(client_as):
    r = await _get(client_as, HQ_HYUNDAI, surface="global")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["totals"]["prompt_runs"] == 2 and d["totals"]["iterations"] == 6 and d["totals"]["catalog_acr_prompts"] == 2
    b = _brands(r.json())
    assert set(b) == {"Hyundai", "Toyota"} and b["Hyundai"]["choice"] == 4 and b["Hyundai"]["is_ours"] is True
    assert "Kia" not in r.text and "acr kia q" not in r.text and P9002 not in r.text


async def test_kia_us_scope_country_and_viewpoint(client_as):
    r = await _get(client_as, KIA_US, surface="global")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["totals"]["prompt_runs"] == 2 and d["totals"]["iterations"] == 5
    assert [x["brand"] for x in d["brands"]] == ["Hyundai", "Kia", "Toyota"]
    b = _brands(r.json())
    assert b["Kia"]["is_ours"] is True and b["Hyundai"]["is_ours"] is False and b["Hyundai"]["cells"] == 2
    assert "KR" not in {s["country"] for s in d["territory"]} and P9001 not in r.text   # 국가 스코프 밖(KR) 누출 0
    # 스코프 밖 국가 요청은 버리고 빈 집합(fail-closed)
    r2 = await _get(client_as, KIA_US, surface="global", country="KR")
    assert r2.json()["meta"]["dropped_filters"] == {"country": ["KR"]} and r2.json()["data"]["totals"]["prompt_runs"] == 0


async def test_kia_eu_empty_region(client_as):
    r = await _get(client_as, KIA_EU, surface="global")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["totals"]["prompt_runs"] == 0 and d["totals"]["catalog_acr_prompts"] == 2   # DE 셀 9105 는 acr_in 거짓
    assert d["brands"] == [] and d["battle"] == [] and d["territory"] == [] and r.json()["meta"]["suppressed"] == {}


@pytest.mark.parametrize(("params", "runs", "iters"), [
    ({"engine": "deepseek"}, 1, 5),
    ({"engine": ["deepseek", "chatgpt"]}, 3, 10),
    ({"country": "KR"}, 1, 4),
    ({"list_type": "L1"}, 2, 7),
    ({"lang": "de"}, 0, 0),
    ({"brand": "Kia"}, 1, 3),          # core 10라운드: brand[] 는 카탈로그 정확 일치(현행 acrWhere f.brand IN) → 공용 셀 501(HMG, 유효 2) 제외
])
async def test_filters_change_values(client_as, params, runs, iters):
    r = await _get(client_as, ADMIN, surface="global", **params)
    assert r.status_code == 200, r.text
    t = r.json()["data"]["totals"]
    assert (t["prompt_runs"], t["iterations"]) == (runs, iters)


async def test_filter_details(client_as):
    r = await _get(client_as, ADMIN, surface="global", engine="deepseek")
    d = r.json()["data"]
    assert d["model_conversion"] == [{"brand": "Toyota", "model": "Toyota RAV4", "is_ours": False,
                                      "conversion": {"num": 3, "den": 5}, "cells": 1, "top1": 3}]
    r = await _get(client_as, ADMIN, surface="global", brand=["Kia", "Bogus"])
    assert r.json()["meta"]["dropped_filters"] == {"brand": ["Bogus"]}
    assert _brands(r.json())["Hyundai"]["is_ours"] is False                   # 관점 = Kia
    r = await _get(client_as, ADMIN, surface="global", list_type="L1")
    assert r.json()["data"]["totals"]["catalog_acr_prompts"] == 2
    r = await _get(client_as, ADMIN, surface="global", source="news")
    assert r.json()["meta"]["ignored_filters"] == ["source"]                 # 인용 전용 축은 무시를 드러낸다


async def test_period_mode_and_trend_cycles(client_as):
    r = await _get(client_as, ADMIN, **{"surface": "global", "from": "2026-09-01", "to": "2026-09-30"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["meta"]["mode"] == "cumulative" and body["meta"]["cycles"] == ["2026-09-07", "2026-09-14"]
    assert body["data"]["totals"]["prompt_runs"] == 4 and body["data"]["totals"]["iterations"] == 11   # 비서빙 회차 12(9106) 제외
    assert _brands(body)["Hyundai"]["choice"] == 7
    r = await _get(client_as, ADMIN, surface="global", trend_cycles=1, top_brands=1)
    d = r.json()["data"]
    assert [x["round_date"] for x in d["trend"]["buckets"]] == ["2026-09-14"]
    assert d["trend"]["series_brands"] == ["Hyundai"] and [b["brand"] for b in d["brands"]] == ["Hyundai"]
    r = await _get(client_as, ADMIN, **{"surface": "global", "from": "2026-10-01", "to": "2026-10-31"})
    assert r.status_code == 200 and r.json()["data"]["totals"]["prompt_runs"] == 0 and r.json()["meta"]["suppressed"] == {}


async def test_limits_cap_sections(client_as):
    r = await _get(client_as, ADMIN, surface="global", battle_limit=1, territory_limit=1, model_limit=1)
    d = r.json()["data"]
    assert [x["prompt_id"] for x in d["battle"]] == [P9001]
    assert [(s["country"], s["engine"]) for s in d["territory"]] == [("US", "chatgpt")]


@pytest.mark.parametrize("params", [
    {"surface": "global", "top_brands": 0},
    {"surface": "global", "trend_cycles": 105},
    {"surface": "global", "battle_limit": 501},
    {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"},
    {"surface": "global", "from": "2026-09-30", "to": "2026-09-01"},
    {"surface": "nowhere"},
    {"surface": "project"},
])
async def test_bad_params_422(client_as, params):
    r = await _get(client_as, ADMIN, **params)
    assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable"


async def test_auth_and_menu_gates(client_as):
    assert (await _get(client_as, None, surface="global")).status_code == 401
    assert (await _get(client_as, SUSPENDED, surface="global")).json()["error"]["code"] == "no_account"
    r = await _get(client_as, VENDOR, surface="global")          # core 표면 경로 게이트(D-vendor): 역할이 표준 경로 밖
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"
    r = await _get(client_as, HQ_HYUNDAI, surface="website")
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
    r = await _get(client_as, KIA_US, surface="project", project_id=str(CUST_PROJECT))   # Hyundai US 프로젝트: 비가시 = 404
    assert r.status_code == 404


async def test_website_and_project_source_pending(client_as):
    r = await _get(client_as, ADMIN, surface="website")
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["suppressed"] == {"*": "source_pending"} and r.json()["data"]["totals"]["prompt_runs"] == 0
    r = await _get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
    assert r.status_code == 200, r.text
    assert r.json()["meta"]["suppressed"] == {"*": "source_pending"}



# ── B097: 계산 생략(include_option_countries·include_catalog_count)·배틀 상한 SQL ─────────────────────
@pytest.mark.parametrize(("uid", "params"), [
    (ADMIN, {"surface": "global"}),
    (KIA_US, {"surface": "global"}),
    (ADMIN, {"surface": "global", "from": "2026-09-01", "to": "2026-09-30", "lang": "en"}),
])
async def test_option_countries_off_skips_statement(client_as, monkeypatch, uid, params):
    """include_option_countries=false: 국가 옵션 문장 없음, options.countries = [], 나머지 data·meta 는 기본 호출과 같다."""
    from app.features.analytics.funnel.acr import service as S

    full = (await _get(client_as, uid, **params)).json()
    assert full["data"]["options"]["countries"]                                  # 기본 = 종전(국가 옵션 계산)

    def boom(*a, **k):
        raise AssertionError("option_countries_sql must not run when include_option_countries=false")

    monkeypatch.setattr(S.q, "option_countries_sql", boom)
    r = await _get(client_as, uid, **params, include_option_countries="false")
    assert r.status_code == 200, r.text
    d = full["data"]
    assert r.json()["data"] == {**d, "options": {**d["options"], "countries": []}} and r.json()["meta"] == full["meta"]


@pytest.mark.parametrize(("uid", "params", "measured"), [
    (ADMIN, {"surface": "global"}, True),
    (HQ_HYUNDAI, {"surface": "global", "list_type": "L1"}, True),
    (KIA_EU, {"surface": "global"}, False),                                     # 셀 0 = 측정 대기(카탈로그 수 필요)
    (ADMIN, {"surface": "global", "from": "2026-10-01", "to": "2026-10-31"}, False),
    (ADMIN, {"surface": "website"}, False),                                     # 원천 준비 중(카탈로그 0 판정)
    (VENDOR, {"surface": "project", "project_id": str(CUST_PROJECT)}, False),
])
async def test_catalog_count_only_when_unmeasured(client_as, monkeypatch, uid, params, measured):
    """include_catalog_count=false: 셀이 있으면 카탈로그 수 문장 없이 totals.catalog_acr_prompts = null, 셀이 없는 응답은 기본과 같다
    (측정 대기 안내가 이 값을 읽는다). 나머지 data·meta 는 기본 호출과 같다."""
    from app.features.analytics.funnel.acr import service as S

    full = (await _get(client_as, uid, **params)).json()
    calls: list[int] = []
    real = S.catalog_acr_prompts

    async def spy(*a, **k):
        calls.append(1)
        return await real(*a, **k)

    monkeypatch.setattr(S, "catalog_acr_prompts", spy)
    r = await _get(client_as, uid, **params, include_catalog_count="false")
    assert r.status_code == 200, r.text
    assert (full["data"]["totals"]["prompt_runs"] > 0) is measured
    assert len(calls) == (0 if measured else 1)
    d = full["data"]
    want = {**d, "totals": {**d["totals"], "catalog_acr_prompts": None}} if measured else d
    assert r.json()["data"] == want and r.json()["meta"] == full["meta"]


async def _battle(client_as, limit):
    r = await _get(client_as, ADMIN, surface="global", battle_limit=limit)
    assert r.status_code == 200, r.text
    return [(x["prompt_id"], x["cells"]) for x in r.json()["data"]["battle"]]


async def _assert_prefixes(client_as):
    whole = await _battle(client_as, 500)
    for n in range(1, len(whole) + 1):
        assert await _battle(client_as, n) == whole[:n], n
    return [p for p, _ in whole]


async def test_battle_sql_limit_same_order_as_app(client_as, acr_seed):
    """배틀 상한을 SQL 에서 먼저 잘라도(상위 n 프롬프트의 셀만) 결과 = 전체 목록의 앞 n 개(앱 정렬: 선택 합 내림차순 → 문구(NULL = '') → id).
    동률·대소문자(코드 포인트 순: 'Zeta' < 'alpha')·NULL 문구 경우를 세이브포인트 안에서 만든다."""
    assert await _assert_prefixes(client_as) == [P9001, P9002, P3]
    kia_choice = Update("rd.acr_choice", {"acr_cell_key": 9102, "entity_key": 2, "level": 1}, {"choice": 3})
    async with savepoint(acr_seed):
        await stage(acr_seed, kia_choice)                                          # P9002 합 3 = P9001 합 3 → 문구 순
        assert await _assert_prefixes(client_as) == [P9001, P9002, P3]
        await stage(acr_seed, Update("rd.dim_prompt", {"prompt_key": 9001}, {"text": "alpha"}),
                    Update("rd.dim_prompt", {"prompt_key": 9002}, {"text": "Zeta"}))
        assert await _assert_prefixes(client_as) == [P9002, P9001, P3]            # 코드 포인트 순(로캘 순이면 alpha 가 먼저)
        await stage(acr_seed, Update("rd.dim_prompt", {"prompt_key": 9001}, {"text": None}))
        assert await _assert_prefixes(client_as) == [P9001, P9002, P3]            # NULL 문구 = '' 가 먼저
