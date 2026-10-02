"""GET /v1/mentions/brands 2차 검증(ff74b52) 결함 회귀: D1 그룹 간 split_own 계약, D4 빈 엔진 블록, D7 창 스캔 수.

- D1: 같은 관점이면 /v1/mentions/brands?split_own=true 당사 행과 /v1/trend?dimension=brand&split_own=true 당사 계열이
  같은 (own_brand_code, brand_key) 집합을 낸다(판정 = core.measure.split_own_scopes 하나, 행 키 = Refs.brand_code_of_bit).
  trend 의 split_own 은 feat/bg-trend-geo 에 있다. 이 브랜치 단독(trend 가 인자를 무시)이면 건너뛰고, 통합 트리에서 실행된다.
- D4: group_by=engine 은 답변(std_in)이 0 인 엔진 블록을 내지 않는다. 창 WHERE 는 cit_in, 답변 수는 std_in FILTER 라
  분석 대기(갭) 답변만 있는 엔진이 answers 0 블록으로 나왔다(기간 2026-09-01~20 에서 회차 11 을 언급 숨김: 회차 10 의 갭 답변 16·17).
- D7: split_own 은 당사 합계·비트별 당사 열을 rd.answer 한 번 스캔(비트마다 FILTER)으로 센다. 예전에는 fetch_counts 를
  비트마다 다시 불러(엔진별도 같은 수) ADMIN split_own + group_by=engine 에서 rd.answer 스캔이 9번이었다.
"""
from __future__ import annotations

import re

import pytest

from app.core import db as core_db
from app.features.analytics.mentions.brands import service as brands_service
from app.features.analytics.mentions.brands.tests.mentions_testkit import GLOBAL_SNAPSHOT, hide, patch_window
from tests.support import ADMIN, HQ_HYUNDAI, KIA_US, needs_db

pytestmark = needs_db
URL = "/v1/mentions/brands"
PERIOD = {"from": "2026-09-01", "to": "2026-09-20"}
ALL_INC = ["prompts", "multi", "types", "hmg"]


async def _get(client_as, uid, url=URL, **params):
    async with client_as(uid) as c:
        return await c.get(url, params=params)


# ── D1: 그룹 간 split_own 계약(mentions ↔ trend) ─────────────────────────────
VIEWPOINTS = [(ADMIN, {}), (ADMIN, {"brand": ["Kia", "Hyundai N"]}), (ADMIN, {"brand": ["Hyundai"]}), (ADMIN, {"brand": ["Hyundai N"]}),
              (HQ_HYUNDAI, {}), (KIA_US, {})]


@pytest.mark.parametrize(("uid", "extra"), VIEWPOINTS)
async def test_split_own_contract_with_trend(client_as, uid, extra):
    m = await _get(client_as, uid, surface="global", split_own="true", full="true", **extra)
    t = await _get(client_as, uid, "/v1/trend", surface="global", dimension="brand", metrics="M01", split_own="true", **extra)
    assert m.status_code == 200 and t.status_code == 200, (m.text, t.text)
    series = [s for s in t.json()["data"]["series"] if s["is_own"] and s["metric"] == "visibility"]
    if not series or "own_brand_code" not in series[0]:
        pytest.skip("trend split_own 미통합(feat/bg-trend-geo 통합 트리에서 실행)")
    own_rows = [b for b in m.json()["data"]["brands"] if b["is_own"]]
    split_rows = {(b.get("own_brand_code"), b["brand_key"]) for b in own_rows if b.get("own_brand_code") is not None}
    split_series = {(s["own_brand_code"], s["brand_key"]) for s in series if s["own_brand_code"] is not None}
    assert split_rows == split_series, (uid, extra)
    # 관점 비트가 하나면 두 그룹 다 가르지 않는다(행 키 없음, 합친 당사 1행·1계열)
    if len(own_rows) == 1:
        assert own_rows[0].get("own_brand_code") is None and [s["own_brand_code"] for s in series] == [None]
    else:
        assert len(own_rows) == len(series) and all(s["own_brand_code"] == s["key"] for s in series)


async def test_split_own_contract_fixed_keys(client_as):
    """검증 재현 고정: ADMIN brand=[Kia, Hyundai N] 의 당사 행 = (Hyundai, 1)·(Kia, 2). 예전에는 ('Hyundai N', null)이었다.
    brand=[Hyundai](관점 하나)는 가르지 않는다(예전 own_brand_code 'Hyundai')."""
    d = (await _get(client_as, ADMIN, surface="global", split_own="true", brand=["Kia", "Hyundai N"])).json()["data"]
    assert sorted((b["own_brand_code"], b["brand_key"]) for b in d["brands"] if b["is_own"]) == [("Hyundai", 1), ("Kia", 2)]
    d = (await _get(client_as, ADMIN, surface="global", split_own="true", brand=["Hyundai"])).json()["data"]
    assert [b.get("own_brand_code") for b in d["brands"] if b["is_own"]] == [None]


# ── D4: 답변 0 엔진 블록 ──────────────────────────────────────────────────────
async def test_by_engine_skips_zero_answer_engines(client_as, monkeypatch):
    patch_window(monkeypatch, hide([GLOBAL_SNAPSHOT]))           # 회차 11 언급 숨김 → 창 = 회차 10(갭 답변만)
    r = await _get(client_as, ADMIN, surface="global", group_by="engine", **PERIOD)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert all(e["totals"]["answers"] > 0 for e in d["by_engine"]), d["by_engine"]
    assert sum(e["totals"]["answers"] for e in d["by_engine"]) == d["totals"]["answers"]
    r = await _get(client_as, ADMIN, surface="global", group_by="engine", split_own="true", **PERIOD)
    assert all(e["totals"]["answers"] > 0 for e in r.json()["data"]["by_engine"])


@pytest.mark.parametrize(("uid", "extra"), [(KIA_US, {}), (KIA_US, PERIOD), (ADMIN, PERIOD), (HQ_HYUNDAI, PERIOD)])
async def test_by_engine_blocks_have_answers(client_as, uid, extra):
    d = (await _get(client_as, uid, surface="global", group_by="engine", split_own="true", **extra)).json()["data"]
    assert all(e["totals"]["answers"] > 0 for e in d["by_engine"]), (uid, extra, d["by_engine"])
    assert sum(e["totals"]["answers"] for e in d["by_engine"]) == d["totals"]["answers"]
    assert sum(e["totals"]["mentions_total"] for e in d["by_engine"]) == d["totals"]["mentions_total"]


# ── D7: 창 스캔 수 ────────────────────────────────────────────────────────────
_ANSWER_SCAN = re.compile(r"FROM rd\.answer\s+a\b")


def _count_answer_scans(monkeypatch) -> list[str]:
    seen: list[str] = []

    def wrap(orig):
        async def spy(conn, sql, params=None, *a, **kw):
            if _ANSWER_SCAN.search(sql):
                seen.append(sql)
            return await orig(conn, sql, params, *a, **kw)
        return spy

    monkeypatch.setattr(core_db, "fetch_all", wrap(core_db.fetch_all))   # core.measure.fetch_counts 는 호출 때 app.core.db.fetch_all 을 찾는다
    monkeypatch.setattr(brands_service, "fetch_all", wrap(brands_service.fetch_all))
    monkeypatch.setattr(brands_service, "fetch_one", wrap(brands_service.fetch_one))
    return seen


async def test_split_own_single_answer_scan_per_grouping(client_as, monkeypatch):
    base = (await _get(client_as, ADMIN, surface="global", group_by="engine", include=ALL_INC)).json()["data"]
    seen = _count_answer_scans(monkeypatch)
    r = await _get(client_as, ADMIN, surface="global", group_by="engine", include=ALL_INC, split_own="true")
    assert r.status_code == 200, r.text
    # 당사 합계+비트별(1) + 엔진별 당사 합계+비트별(1) + 당사 prompts·multi(own_extras 1). 예전 = 1 + 3 + 1 + 3 + 1 = 9
    assert len(seen) == 3, seen
    d = r.json()["data"]
    # 합친 관점 값은 그대로(brand_count 는 가른 행 기준이라 제외: 합친 1행 + 경쟁 2 → 가른 3행 + 경쟁 2)
    assert ({**d["totals"], "brand_count": 0}, d["own"]) == ({**base["totals"], "brand_count": 0}, base["own"])
    assert d["totals"]["brand_count"] == base["totals"]["brand_count"] + 2
    assert sum(b["mentions"] for b in d["brands"] if b["is_own"]) == d["own"]["mentions"]
    for e, eb in zip(d["by_engine"], base["by_engine"], strict=True):
        assert e["totals"]["answers"] == eb["totals"]["answers"] and e["totals"]["mentions_total"] == eb["totals"]["mentions_total"]
        own = [b for b in e["brands"] if b["is_own"]]
        merged = next(b for b in eb["brands"] if b["is_own"])
        assert sum(b["mentions"] for b in own) == merged["mentions"], e["engine"]
