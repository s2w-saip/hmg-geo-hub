"""analytics.kpi.compare(K-2) DB 통합 테스트(로컬 개발 DB 합성 픽스처).

픽스처 글로벌 회차: 10(09-07, 계획 1, 전부 gap) · 11(09-14, 계획 10) · 12(09-21, open 비서빙 → 원장 밖). 웹사이트 21(09-18, 계획 2, 인용 숨김).
D6: kind=cycle 의 cur·prev = K-1 스냅샷 offset 0·1 과 같은 빌더 합이어야 한다.
"""
from __future__ import annotations

from datetime import date

import pytest

from app.features.analytics.kpi.summary.shared import kpi_today
from app.features.analytics.kpi.summary.tests.seed import seeded_rounds  # noqa: F401  (픽스처 등록)
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, TODAY, VENDOR, needs_db

URL = "/v1/kpi/compare"
pytestmark = needs_db
PAIR = {"visibility": "visibility", "share_of_voice": "share_of_voice", "sentiment": "sentiment", "position": "position",
        "citation_share": "citation_share"}


@pytest.fixture
def today_at():
    from app.main import app

    def set_(d: date = TODAY) -> None:
        app.dependency_overrides[kpi_today] = lambda: d
    set_()
    yield set_
    app.dependency_overrides.pop(kpi_today, None)


async def get(client_as, uid, url=URL, **params):
    async with client_as(uid) as c:
        return await c.get(url, params=params)


def zero(unit):
    return {"sum": 0, "count": 0} if unit == "rank" else {"num": 0, "den": 0}


async def test_cycle_kind_matches_summary_snapshots(client_as, today_at):
    r = await get(client_as, HQ_HYUNDAI, surface="global", kind="cycle")
    assert r.status_code == 200, r.text
    b = r.json()
    s0 = (await get(client_as, HQ_HYUNDAI, "/v1/kpi/summary", surface="global")).json()["data"]
    s1 = (await get(client_as, HQ_HYUNDAI, "/v1/kpi/summary", surface="global", cycle_offset=1)).json()["data"]
    for it in b["data"]:
        assert it["cur"] == s0[it["metric"]]                             # D6: 같은 빌더
        assert it["prev"] == (s1[it["metric"]] or zero(it["unit"]))
        assert it["suppressed"] and it["reason"] == "no_data" and it["delta"] is None   # 회차 10 은 std_in·인용 0
        assert (it["cycles_prev"], it["cycles_cur"], it["planned_prev"], it["planned_cur"]) == (1, 1, 1, 10)
    m = b["meta"]
    assert m["compare"]["kind"] == "cycle" and m["compare"]["first_published"] == "2026-09-07"
    assert m["compare"]["windows"]["prev"] == {"lo": "2026-09-07", "hi": "2026-09-07"}
    assert m["compare"]["windows"]["cur"] == {"lo": "2026-09-14", "hi": "2026-09-14"}
    assert m["cycles"] == ["2026-09-07", "2026-09-14"] and m["mode"] == "cumulative"
    assert [i["metric"] for i in b["data"]] == list(PAIR)
    assert [(i["family"], i["unit"]) for i in b["data"]][-2:] == [("mention", "rank"), ("citation", "pp")]


async def test_window_default_end_is_latest_exposed_round(client_as, today_at):
    b = (await get(client_as, HQ_HYUNDAI, surface="global", days=7)).json()
    w = b["meta"]["compare"]["windows"]
    assert w["cur"] == {"lo": "2026-09-08", "hi": "2026-09-14"} and w["prev"] == {"lo": "2026-09-01", "hi": "2026-09-07"}
    vis = b["data"][0]
    assert vis["cur"] == {"num": 2, "den": 3} and vis["prev"] == {"num": 0, "den": 0}
    b30 = (await get(client_as, HQ_HYUNDAI, surface="global")).json()     # 기본 30일
    assert b30["meta"]["compare"]["windows"]["cur"] == {"lo": "2026-08-16", "hi": "2026-09-14"}
    assert b30["data"][0]["reason"] == "no_prev"                        # 직전 30일(07-17~08-15) 발행 회차 0


async def test_calendar_month_and_week(client_as, today_at):
    b = (await get(client_as, HQ_HYUNDAI, surface="global", kind="calendarMonth")).json()
    w = b["meta"]["compare"]["windows"]
    assert w["cur"] == {"lo": "2026-09-01", "hi": "2026-09-14"} and w["before"] == {"lo": "2026-07-01", "hi": "2026-07-31"}
    assert b["data"][0]["cycles_cur"] == 2 and b["data"][0]["planned_cur"] == 11 and b["data"][0]["reason"] == "no_prev"
    b = (await get(client_as, HQ_HYUNDAI, surface="global", kind="calendarWeek", **{"from": "2026-09-14", "to": "2026-09-16"})).json()
    assert b["meta"]["compare"]["windows"]["prev"] == {"lo": "2026-09-07", "hi": "2026-09-13"}
    r = await get(client_as, HQ_HYUNDAI, surface="global", kind="calendarWeek", **{"from": "2026-09-15", "to": "2026-09-16"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "invalid_compare_period"
    r = await get(client_as, HQ_HYUNDAI, surface="global", kind="calendarMonth", **{"from": "2026-09-02", "to": "2026-09-16"})
    assert r.status_code == 422


async def test_ignored_params_are_declared(client_as, today_at):
    b = (await get(client_as, HQ_HYUNDAI, surface="global", kind="cycle", days=30, **{"from": "2026-09-01", "to": "2026-09-30"})).json()
    assert b["meta"]["ignored_filters"] == ["period", "days"]
    b = (await get(client_as, HQ_HYUNDAI, surface="global", lang="en", source="news")).json()
    assert b["meta"]["ignored_filters"] == ["source"]                 # 글로벌 lang 은 지원 축(BG-01), source 는 아님


async def test_future_round_leaves_ledger(client_as, today_at):
    """기준일 09-10: 회차 11(노출 09-16)은 아직 안 보인다 → 끝점 = 09-07, 회차 11 은 원장에서도 빠진다(누락으로 세지 않음)."""
    today_at(date(2026, 9, 10))
    b = (await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-01", "to": "2026-09-30"})).json()
    assert b["data"][0]["planned_cur"] == 1 and b["data"][0]["missing_share_cur"] == 0.0 and b["meta"]["cycles"] == ["2026-09-07"]
    c = (await get(client_as, HQ_HYUNDAI, surface="global", kind="cycle")).json()
    assert c["meta"]["compare"]["windows"]["prev"] is None and c["data"][0]["reason"] == "no_prev"


async def test_filters_change_values(client_as, today_at):
    base = (await get(client_as, HQ_HYUNDAI, surface="global", kind="cycle")).json()["data"][0]["cur"]
    gem = (await get(client_as, HQ_HYUNDAI, surface="global", kind="cycle", engine="gemini")).json()["data"][0]["cur"]
    assert base == {"num": 2, "den": 3} and gem == {"num": 0, "den": 1}


async def test_scope_and_auth(client_as, today_at):
    assert (await get(client_as, None, surface="global")).status_code == 401
    r = await get(client_as, VENDOR, surface="global")
    assert r.status_code == 403 and r.json()["error"]["code"] == "role_forbidden"          # core 표면 경로 게이트(D-vendor)
    de = (await get(client_as, KIA_US, surface="global", kind="cycle", country="DE")).json()
    assert de["meta"]["dropped_filters"] == {"country": ["DE"]}
    assert all(i["cur"] == zero(i["unit"]) for i in de["data"])          # 스코프 밖 국가 값 누출 0
    assert (await get(client_as, KIA_US, surface="project", project_id=str(CUST_PROJECT))).status_code == 404


async def test_website_single_round_and_project(client_as, today_at):
    b = (await get(client_as, ADMIN, surface="website", kind="cycle")).json()
    assert b["meta"]["compare"]["windows"]["prev"] is None
    cit = next(i for i in b["data"] if i["metric"] == "citation_share")
    assert cit["cur"] == {"num": 0, "den": 0} and cit["reason"] == "no_prev"   # 인용 숨김 회차: 인용 값 없음
    assert b["data"][0]["cur"] == {"num": 1, "den": 2} and b["data"][0]["planned_cur"] == 2
    p = await get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT), kind="cycle")
    assert p.status_code == 200 and p.json()["data"][0]["planned_cur"] == 0   # 가상 회차: 계획 단위 없음(판정 불가)


async def test_invalid_params_422(client_as, today_at):
    for params in ({"surface": "global", "days": 5}, {"surface": "global", "kind": "year"},
                   {"surface": "global", "metrics": "bogus"}, {"surface": "global", "from": "2026-09-02", "to": "2026-09-01"}):
        r = await get(client_as, HQ_HYUNDAI, **params)
        assert r.status_code == 422, params


async def test_no_exposed_round(client_as, today_at):
    today_at(date(2026, 9, 1))
    b = (await get(client_as, HQ_HYUNDAI, surface="global")).json()
    assert b["meta"]["suppressed"]["*"] == "no_active_snapshot" and b["meta"]["compare"]["windows"] is None
    assert all(i["reason"] == "no_prev" and i["delta"] is None for i in b["data"])


# ── 검증 결함 회귀(D1·D2·M4·M5) ─────────────────────────────────────────────
async def test_period_bounds(client_as, today_at):
    """D1·D2 → core R10: 공통 필터 from·to 허용 범위(2000-01-01~2100-12-31) 밖은 core 가 422 unprocessable 로 막는다(달력 끝 산술 없음).
    하한 경계 창(2000-01)은 직전 구간이 1999 로 내려가도 200 이고 이력이 없어 no_prev."""
    for kind, lo, hi in (("window", "2000-01-01", "2000-01-31"), ("calendarMonth", "2000-01-01", "2000-01-31"),
                         ("calendarWeek", "2000-01-03", "2000-01-05")):
        r = await get(client_as, HQ_HYUNDAI, surface="global", kind=kind, **{"from": lo, "to": hi})
        assert r.status_code == 200, (kind, r.text)
        b = r.json()
        assert b["meta"]["compare"]["windows"]["cur"] == {"lo": lo, "hi": hi} and b["meta"]["compare"]["first_published"] is None
        assert all(i["reason"] == "no_prev" and i["delta"] is None for i in b["data"])
    b = (await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2000-01-01", "to": "2026-09-30"})).json()
    assert b["meta"]["compare"]["first_published"] == "2026-09-07" and b["data"][0]["cycles_cur"] == 2
    for kind, lo, hi in (("window", "0001-01-01", "9999-12-31"), ("calendarMonth", "0001-01-01", "0001-01-31"),
                         ("window", "1999-01-01", "1999-01-31"), ("window", "2026-09-01", "2101-01-01")):
        r = await get(client_as, HQ_HYUNDAI, surface="global", kind=kind, **{"from": lo, "to": hi})
        assert r.status_code == 422 and r.json()["error"]["code"] == "unprocessable", (kind, lo, hi, r.text)
    r = await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2100-12-30", "to": "2100-12-31"})   # 위쪽 끝
    assert r.status_code == 200, r.text


def _by(b):
    return {i["metric"]: i for i in b["data"]}


@pytest.mark.usefixtures("seeded_rounds")
async def test_citation_family_ledger_counts_mention_hidden_round(client_as, today_at):
    """M4: 언급 숨김 회차 41(09-03)은 인용 계열에서 발행이다. 인용 지표의 발행 회차·계획·첫 발행이 값의 모수와 같은 회차를 센다.
    창 09-03~09-09: cur = 41(언급 숨김, 계획 2) · 44(계획 2) · 10(계획 1), prev = 40(closed 비서빙, 계획 4 전부 누락)."""
    b = (await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-03", "to": "2026-09-09"})).json()
    by = _by(b)
    v, c = by["visibility"], by["citation_share"]
    assert v["cur"] == {"num": 1, "den": 1} and (v["cycles_cur"], v["planned_cur"]) == (2, 3)          # 41 은 언급 원장 밖
    assert c["cur"] == {"num": 8, "den": 18} and (c["cycles_cur"], c["planned_cur"]) == (3, 5)          # 41·44 = k1 열 복사(공식 4/9씩)
    for it in (v, c):
        assert (it["planned_prev"], it["missing_share_prev"], it["cycles_prev"]) == (4, 1.0, 0) and it["reason"] == "no_prev"
    info = b["meta"]["compare"]
    assert info["first_published"] == "2026-09-05" and info["first_published_citation"] == "2026-09-03"
    assert b["meta"]["source"] == {"ledger": "fleet"}


@pytest.mark.usefixtures("seeded_rounds")
async def test_missing_share_suppresses_on_db_ledger(client_as, today_at):
    """M5: 실제 core.cycles.ledger_rows 경로에서 closed ∧ 비서빙 회차(40·43)가 누락으로 잡히고 30% 이상이면 missing_share 로 억제한다.
    달력 주 09-07~09-13: cur = 10(1) · 42(3) · 43(누락 4) → 4/8, prev = 40(누락 4) · 41(언급 숨김) · 44(2)."""
    b = (await get(client_as, HQ_HYUNDAI, surface="global", kind="calendarWeek", **{"from": "2026-09-07", "to": "2026-09-13"})).json()
    by = _by(b)
    v, c = by["visibility"], by["citation_share"]
    assert v["reason"] == "missing_share" and v["delta"] is None and v["cur"] == {"num": 1, "den": 1} and v["prev"] == {"num": 1, "den": 1}
    assert (v["planned_prev"], v["planned_cur"], v["cycles_prev"], v["cycles_cur"]) == (6, 8, 1, 2)
    assert v["missing_share_cur"] == 0.5 and v["missing_share_prev"] == pytest.approx(4 / 6)
    assert c["reason"] == "missing_share" and (c["planned_prev"], c["cycles_prev"]) == (8, 2)          # 41 은 인용 발행
    assert b["meta"]["suppressed"]["visibility"] == "missing_share"


@pytest.mark.usefixtures("seeded_rounds")
async def test_start_window_on_db_history(client_as, today_at):
    """M5: 7일 창 09-06~09-12(누락 비중 미적용), prev 08-30~09-05. 첫 발행 F(언급 09-05, 인용 09-03) > prev 시작 + 2 → start_window."""
    b = (await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-06", "to": "2026-09-12"})).json()
    assert {i["reason"] for i in b["data"]} == {"start_window"}
    v = _by(b)["visibility"]
    assert (v["planned_cur"], v["missing_share_cur"]) == (8, 0.5)          # 43(closed 비서빙) 누락은 원장에 있지만 7일 창은 임계 미적용
