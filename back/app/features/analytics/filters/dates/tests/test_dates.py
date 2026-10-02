"""analytics.filters.dates(F-2) 테스트.

손 계산 근거(tests/fixtures/fixture-10-data.sql 의 rd.cycle):
  global  루트(project_key 1): 10 · 09-07 · 노출 09-09 / 11 · 09-14 · 노출 09-16 / 12 · 09-21 · 비서빙(open) → 선택 가능 = 09-14, 09-07
  website Kia DE 사이트(2):    21 · 09-18 · 노출 09-19 · hidden_scope 2(인용 숨김) → mentions 09-18, citations·all 없음
  project 고객 프로젝트(3):    31 · 09-20 · 노출 09-21 → 09-20
프리셋(presetRange 이식, 끝점 = 최신, 시작 클램프 = 최초):
  global E=09-14, min=09-07: weekly 09-08, biweekly 08-31 → 09-07, monthly 08-16 → 09-07, yearly 2025-09-14 → 09-07
  project E=09-20, min=09-20(= E 라 클램프 안 함): weekly 09-14, biweekly 09-07, monthly 08-22, yearly 2025-09-20
"""
from __future__ import annotations

import pathlib
import uuid
from datetime import date, timedelta

import pytest

from app.core.codes import HIDDEN_EXCLUDE
from app.core.cycles import RoundDates
from app.features.analytics.filters.dates.service import FAMILY_KEY, MAX_DATES, build_dates, preset_range
from tests.support import (
    ADMIN,
    CUST_PROJECT,
    HQ_HYUNDAI,
    KIA_EU,
    KIA_US,
    SUSPENDED,
    VENDOR,
    WEBSITE_KIA,
    Sql,
    load_named_sql,
    needs_db,
    staged,
)

URL = "/v1/filters/dates"
D = date.fromisoformat


def _presets(j: dict) -> dict[str, tuple[str, str]]:
    return {p["preset"]: (p["from"], p["to"]) for p in j["data"]["presets"]}


# ── 순수 함수 ─────────────────────────────────────────────────────────────────
def test_preset_range_matches_ts_port():
    assert preset_range("weekly", D("2026-09-14"), None) == (D("2026-09-08"), D("2026-09-14"))
    assert preset_range("biweekly", D("2026-09-14"), None) == (D("2026-09-01"), D("2026-09-14"))
    assert preset_range("monthly", D("2026-03-01"), None) == (D("2026-01-31"), D("2026-03-01"))
    assert preset_range("yearly", D("2026-09-14"), None) == (D("2025-09-14"), D("2026-09-14"))
    # JS setFullYear: 2/29 의 1년 전은 3/1(없는 날이 다음 달로 넘어간다)
    assert preset_range("yearly", D("2028-02-29"), None) == (D("2027-03-01"), D("2028-02-29"))
    # 클램프: 시작 < min < 끝 일 때만
    assert preset_range("monthly", D("2026-09-14"), D("2026-09-07")) == (D("2026-09-07"), D("2026-09-14"))
    assert preset_range("weekly", D("2026-09-14"), D("2026-09-14")) == (D("2026-09-08"), D("2026-09-14"))
    assert preset_range("weekly", D("2026-09-14"), D("2026-09-01")) == (D("2026-09-08"), D("2026-09-14"))
    with pytest.raises(ValueError):
        preset_range("daily", D("2026-09-14"), None)


def test_build_dates_truncates_at_400():
    """core selectable_round_dates 는 DB 에서 MAX_DATES 개로 자르고 전체 개수·최초일을 따로 낸다. 응답은 그대로 싣고 절단 표식만 단다."""
    start = D("2024-01-01")
    alld = [start + timedelta(days=i) for i in range(MAX_DATES + 50)][::-1]
    d = build_dates("global", RoundDates(tuple(alld[:MAX_DATES]), len(alld), start, 3))
    assert len(d.dates) == MAX_DATES and d.dates_truncated
    assert d.latest_round_date == start + timedelta(days=MAX_DATES + 49) == d.dates[0]
    assert d.first_measured_date == start                     # 최초일은 절단 전 전체에서
    assert d.dates == sorted(d.dates, reverse=True)
    small = build_dates("global", RoundDates(tuple(alld[:3]), 3, alld[2], 3))
    assert not small.dates_truncated and len(small.dates) == 3
    empty = build_dates("global", RoundDates((), 0, None, 3))
    assert empty.latest_round_date is None and empty.dates == [] and empty.presets == []


# ── API(DB) ──────────────────────────────────────────────────────────────────
@needs_db
async def test_global_shape_and_presets(client_as):
    async with client_as(ADMIN) as c:
        r = await c.get(URL, params={"surface": "global"})
    assert r.status_code == 200, r.text
    j = r.json()
    d = j["data"]
    assert d["surface"] == "global"
    assert d["latest_round_date"] == "2026-09-14" and d["first_measured_date"] == "2026-09-07"
    assert d["dates"] == ["2026-09-14", "2026-09-07"] and d["dates_truncated"] is False     # 09-21 비서빙 제외
    assert _presets(j) == {"weekly": ("2026-09-08", "2026-09-14"), "biweekly": ("2026-09-07", "2026-09-14"),
                           "monthly": ("2026-09-07", "2026-09-14"), "yearly": ("2026-09-07", "2026-09-14")}
    assert [p["preset"] for p in d["presets"]] == ["weekly", "biweekly", "monthly", "yearly"]
    m = j["meta"]
    assert m["surface"] == "global" and m["mode"] == "snapshot" and m["as_of"] == "2026-09-14"
    assert m["cycles"] == [] and m["generation"] == 1 and m["ignored_filters"] == [] and m["dropped_filters"] == {}


@needs_db
async def test_latest_matches_options_snapshot(client_as):
    """숨김 없는 픽스처: F-2 latest_round_date(mentions 기본) = F-1 스냅샷 meta.as_of. 일반 규칙은 아래 hidden_scope 매개변수 테스트."""
    async with client_as(ADMIN) as c:
        dts = (await c.get(URL, params={"surface": "global"})).json()
        opt = (await c.get("/v1/filters/options", params={"surface": "global"})).json()
        dts_p = (await c.get(URL, params={"surface": "project", "project_id": str(CUST_PROJECT)})).json()
        opt_p = (await c.get("/v1/filters/options", params={"surface": "project", "project_id": str(CUST_PROJECT)})).json()
    assert dts["data"]["latest_round_date"] == opt["meta"]["as_of"] == "2026-09-14"
    assert dts_p["data"]["latest_round_date"] == opt_p["meta"]["as_of"] == "2026-09-20"


# 준비 문장(rd 쓰기)은 API 문장 정적 가드 대상이 아니라 데이터 파일 mutations.pgsql 에 두고 core 롤백 전용 준비(staged)로 실행한다.
M = load_named_sql(pathlib.Path(__file__).with_name("mutations.pgsql"))
HIDE_11 = M["hide_cycle_11"]


# 최신 회차 11(09-14)의 hidden_scope → (F-1 as_of, F-2 mentions·citations·all latest). 이전 회차 10 = 09-07.
@needs_db
@pytest.mark.parametrize("hs, as_of, men, cit, alla", [
    (0, "2026-09-14", "2026-09-14", "2026-09-14", "2026-09-14"),
    (1, "2026-09-07", "2026-09-07", "2026-09-07", "2026-09-07"),     # 전체 숨김: 둘 다 직전 회차로
    (2, "2026-09-14", "2026-09-14", "2026-09-07", "2026-09-07"),     # 인용 숨김
    (3, "2026-09-14", "2026-09-07", "2026-09-14", "2026-09-07"),     # 언급 숨김(Q18 예비값): mentions 는 F-1 과 갈린다(검증 M3)
])
async def test_latest_vs_options_as_of_by_hidden_scope(client_as, hs, as_of, men, cit, alla):
    """기준일은 family 별(모듈-필터 열린 질문 3 의 family 별 안), F-1 스냅샷은 row 계열. 불변식: F-2 latest ≤ F-1 as_of,
    같음 ⇔ 최신 회차 hidden_scope 가 그 family 배제 집합 밖이거나 1(둘 다 물러남)."""
    async with staged(Sql(HIDE_11, (hs,))), client_as(ADMIN) as c:
        opt = (await c.get("/v1/filters/options", params={"surface": "global"})).json()
        got = {f: (await c.get(URL, params={"surface": "global", "family": f})).json()["data"] for f in ("mentions", "citations", "all")}
    assert opt["meta"]["as_of"] == as_of
    assert (got["mentions"]["latest_round_date"], got["citations"]["latest_round_date"], got["all"]["latest_round_date"]) == (men, cit, alla)
    for f, d in got.items():
        assert d["latest_round_date"] <= opt["meta"]["as_of"]
        excluded = HIDDEN_EXCLUDE[FAMILY_KEY[f]]
        assert (d["latest_round_date"] == opt["meta"]["as_of"]) == (hs not in excluded or hs == 1), f
        assert d["dates"][-1] == "2026-09-07" and d["first_measured_date"] == "2026-09-07"


@needs_db
async def test_view_gate_separate_from_servable(client_as):
    """회차 12(09-21)를 서빙 가능으로 두고 노출일만 바꾼다: 내일이면 빠지고, 오늘(KST, 포함)이면 들어온다.
    노출일이 오늘이어도 servable 거짓이면 빠진다. F-1 스냅샷 기준일도 같은 게이트를 따른다."""
    gate = M["gate_cycle_12"]
    out = {}
    for label, servable, days in (("future", True, 1), ("today", True, 0), ("not_servable", False, 0)):
        async with staged(Sql(gate, (servable, days))), client_as(ADMIN) as c:
            out[label] = ((await c.get(URL, params={"surface": "global"})).json()["data"],
                          (await c.get("/v1/filters/options", params={"surface": "global"})).json()["meta"]["as_of"])
    assert out["future"][0]["dates"] == ["2026-09-14", "2026-09-07"] and out["future"][1] == "2026-09-14"
    assert out["today"][0]["dates"] == ["2026-09-21", "2026-09-14", "2026-09-07"] and out["today"][1] == "2026-09-21"
    assert out["today"][0]["latest_round_date"] == "2026-09-21"
    assert out["not_servable"][0]["dates"] == ["2026-09-14", "2026-09-07"] and out["not_servable"][1] == "2026-09-14"


@needs_db
async def test_website_family_hidden_gate(client_as):
    async with client_as(ADMIN) as c:
        men = (await c.get(URL, params={"surface": "website"})).json()["data"]
        cit = (await c.get(URL, params={"surface": "website", "family": "citations"})).json()["data"]
        alla = (await c.get(URL, params={"surface": "website", "family": "all"})).json()["data"]
    assert men["dates"] == ["2026-09-18"] and men["latest_round_date"] == "2026-09-18"
    assert cit["dates"] == [] and cit["latest_round_date"] is None and cit["presets"] == []          # 회차 21 인용 숨김
    assert alla["dates"] == [] and alla["first_measured_date"] is None


@needs_db
async def test_project_surface_and_membership(client_as):
    async with client_as(VENDOR) as c:                   # 활성 멤버(viewer)
        r = await c.get(URL, params={"surface": "project", "project_id": str(CUST_PROJECT)})
    assert r.status_code == 200
    j = r.json()
    assert j["data"]["dates"] == ["2026-09-20"] and j["data"]["first_measured_date"] == "2026-09-20"
    assert _presets(j) == {"weekly": ("2026-09-14", "2026-09-20"), "biweekly": ("2026-09-07", "2026-09-20"),
                           "monthly": ("2026-08-22", "2026-09-20"), "yearly": ("2025-09-20", "2026-09-20")}
    async with client_as(KIA_US) as c:                   # Kia·US 계정: Hyundai 프로젝트는 스코프 밖·비멤버 → 404(존재 은폐)
        r = await c.get(URL, params={"surface": "project", "project_id": str(CUST_PROJECT)})
    assert r.status_code == 404 and r.json()["error"]["code"] == "not_found"
    async with client_as(ADMIN) as c:
        r = await c.get(URL, params={"surface": "project", "project_id": str(uuid.uuid4())})
        r2 = await c.get(URL, params={"surface": "project"})
    assert r.status_code == 404
    assert r2.status_code == 422


@needs_db
async def test_filters_are_ignored_not_applied(client_as):
    """값 축·기간은 날짜 목록을 바꾸지 않고 ignored_filters 로 드러난다."""
    async with client_as(ADMIN) as c:
        base = (await c.get(URL, params={"surface": "global"})).json()
        r = await c.get(URL, params=[("surface", "global"), ("brand", "Kia"), ("country", "KR"), ("lang", "ko"), ("engine", "gemini"),
                                     ("from", "2026-09-10"), ("to", "2026-09-12"), ("funnel", "F1"), ("source", "other"),
                                     (f"cf.{uuid.uuid4()}", "x"), ("depth4", "D4x")])
    assert r.status_code == 200
    j = r.json()
    assert j["data"] == base["data"]
    assert j["meta"]["ignored_filters"] == ["brand", "country", "custom", "depth4", "engine", "funnel", "lang", "period", "source"]   # depth4 = BG-03
    assert j["meta"]["dropped_filters"] == {}


@needs_db
async def test_scope_limits_website_sites(client_as):
    """website 달력은 스코프 안 사이트의 회차만: Kia·US 계정은 Kia DE 사이트가 스코프 밖이라 빈 목록, Kia 서유럽 계정은 보인다."""
    async with client_as(KIA_US) as c:
        us = (await c.get(URL, params={"surface": "website"})).json()["data"]
    async with client_as(KIA_EU) as c:
        eu = (await c.get(URL, params={"surface": "website"})).json()["data"]
    assert us["dates"] == [] and us["latest_round_date"] is None
    assert eu["dates"] == ["2026-09-18"]


@needs_db
async def test_auth_and_menu_gates(client_as):
    async with client_as(None) as c:
        assert (await c.get(URL, params={"surface": "global"})).status_code == 401
    async with client_as(SUSPENDED) as c:
        r = await c.get(URL, params={"surface": "global"})
        assert r.status_code == 401 and r.json()["error"]["code"] == "no_account"
    async with client_as(HQ_HYUNDAI) as c:               # 메뉴 standard·project: website 금지
        r = await c.get(URL, params={"surface": "website"})
        assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
        assert (await c.get(URL, params={"surface": "global"})).status_code == 200
    for who, sf in ((VENDOR, "global"), (VENDOR, "website"), (WEBSITE_KIA, "global")):   # core 표면 경로 게이트(D-vendor)
        async with client_as(who) as c:
            r = await c.get(URL, params={"surface": sf})
            assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden", (who, sf)
    async with client_as(WEBSITE_KIA) as c:              # website 역할: 웹사이트 경로만
        assert (await c.get(URL, params={"surface": "website"})).status_code == 200


@needs_db
@pytest.mark.parametrize("params", [
    {},                                                   # surface 필수
    {"surface": "nope"},
    {"surface": "global", "family": "row"},
    {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"},   # from > to(한쪽 기간은 허용·기간 미지원이라 ignored)
    {"surface": "global", "from": "2026-09-10", "to": "2026-09-01"},
    {"surface": "global", "from": "not-a-date", "to": "2026-09-01"},
    {"surface": "project", "project_id": "not-a-uuid"},
    {"surface": "global", "cf.bad": "x"},                 # 커스텀 필드 키 형식
])
async def test_invalid_params_422(client_as, params):
    async with client_as(ADMIN) as c:
        r = await c.get(URL, params=params)
    assert r.status_code == 422, (params, r.text)
    assert r.json()["error"]["code"] == "unprocessable"
