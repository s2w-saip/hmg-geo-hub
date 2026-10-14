"""analytics.kpi.engines(K-3) 테스트. 로컬 개발 DB 합성 픽스처 기준.

손 계산(글로벌 회차 11 스냅샷, HQ_HYUNDAI, 기본 엔진 chatgpt·gemini):
  chatgpt: std_in k1·k12 → answers 2, tracked 2(own_mask 1), ment_h ≥ 2 는 k1(4) → multi 1,
           own_rk_h 2·1 → rank_sum 3, ranked 2, top1 1(k12), top3 2, ment_total 7+1 = 8, ment_h 5, sent_all_h 5, sent_pos_h 4,
           인용 cit_n k1 9 (k4·k9 는 cit_in 이지만 인용 0) → cit_total 9, cit_owned 4(M05 분자 = 공식(HMG) 카테고리: hyundai.com·
           hyundaiusa.com·kia.com·linkedin 공식 소셜, 동기화 S1 BE-B Q1 (a). 종전 현대 자사 base URL 이면 2)
  gemini : std_in k2 → answers 1, tracked 0, ment_total 3, 인용 0
  일관성: 노출률 chatgpt 1.0 · gemini 0 → round1(100 × 0 / 1) = 0.0, 점유율 5/8 · 0/3 → 0.0,
          우호도·순위·인용 점유율은 유효 엔진(분모 > 0) 1개 → null
"""
from __future__ import annotations

from datetime import date

import pytest

from app.features.analytics.kpi.engines.queries import FIELDS_BY_PART
from app.features.analytics.kpi.engines.service import ALL_FIELDS, consistency, requested_parts
from app.features.analytics.kpi.summary.shared import kpi_today
from tests.support import ADMIN, CUST_PROJECT, HQ_HYUNDAI, KIA_US, TODAY, VENDOR, needs_db

URL = "/v1/kpi/engines"


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


def test_consistency_rule():
    assert consistency([0.5, 0.25]) == 50.0
    assert consistency([0.5]) is None                    # 유효 엔진 2개 미만
    assert consistency([0.0, 0.0]) is None               # max 0
    assert consistency([2.0, 3.0, 2.5]) == 66.7


@needs_db
async def test_global_rows_hand_computed(client_as, today_at):
    r = await get(client_as, HQ_HYUNDAI, surface="global")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    rows = {x["engine"]: x for x in d["rows"]}
    assert list(rows) == ["chatgpt", "gemini"]
    c = rows["chatgpt"]
    assert (c["answers"], c["tracked"], c["multi"], c["top1"], c["top3"], c["rank_sum"], c["ranked"]) == (2, 2, 1, 1, 2, 3, 2)
    assert (c["total_mentions"], c["tracked_mentions"], c["sent_mentions"], c["positive_mentions"], c["negative_mentions"]) == (8, 5, 5, 4, 0)
    assert (c["cit_total"], c["cit_owned"]) == (9, 4)
    g = rows["gemini"]
    assert (g["answers"], g["tracked"], g["total_mentions"], g["cit_total"]) == (1, 0, 3, 0)
    assert d["engine_consistency"] == {"visibility": 0.0, "share_of_voice": 0.0, "sentiment": None, "position": None,
                                       "citation_share": None}
    assert "engine_key" not in r.text


@needs_db
async def test_total_equals_summary_card(client_as, today_at):
    """D6: 엔진 행 합 = K-1 카드(같은 빌더)."""
    t = (await get(client_as, HQ_HYUNDAI, surface="global")).json()["data"]["total"]
    s = (await get(client_as, HQ_HYUNDAI, "/v1/kpi/summary", surface="global")).json()["data"]
    assert {"num": t["tracked"], "den": t["answers"]} == s["visibility"]
    assert {"num": t["tracked_mentions"], "den": t["total_mentions"]} == s["share_of_voice"]
    assert {"num": t["positive_mentions"], "den": t["sent_mentions"]} == s["sentiment"]
    assert {"sum": t["rank_sum"], "count": t["ranked"]} == s["position"]
    assert {"num": t["cit_owned"], "den": t["cit_total"]} == s["citation_share"]


@needs_db
async def test_part_narrows_fields(client_as, today_at):
    d = (await get(client_as, HQ_HYUNDAI, surface="global", part="citation")).json()["data"]
    assert all(x["answers"] is None and x["multi"] is None and x["cit_total"] is not None for x in d["rows"])
    assert d["total"]["answers"] is None and d["total"]["cit_total"] == 9
    assert d["engine_consistency"]["visibility"] is None
    d = (await get(client_as, HQ_HYUNDAI, surface="global", part="sov")).json()["data"]
    assert all(x["multi"] is None and x["cit_total"] is None and x["total_mentions"] is not None for x in d["rows"])


def test_requested_parts_rule():
    """B090: parts 없으면 PART_MAP[part](종전), 있으면 합집합(part 무시)."""
    assert requested_parts("all") == ("mentions", "rank_detail", "citations")
    assert requested_parts("sov") == ("mentions",)
    assert requested_parts("all", ["sov", "citation"]) == ("mentions", "citations")
    assert requested_parts("citation", ["exposure", "position", "sov"]) == ("mentions", "rank_detail")


CONSISTENCY_FAMILY = {"visibility": "mentions", "share_of_voice": "mentions", "sentiment": "mentions", "position": "mentions",
                      "citation_share": "citations"}


@needs_db
@pytest.mark.parametrize(("parts", "core"), [
    (["sov", "citation"], {"mentions", "citations"}),            # 엔진 일관성 배지 열(rank_detail 없음)
    (["favorability", "position"], {"mentions", "rank_detail"}),  # 언급 Sub KPI 열(cit_* 없음)
    (["sov"], {"mentions"}),
    (["citation"], {"citations"}),
])
async def test_parts_union_skips_columns_values_equal_all(client_as, today_at, monkeypatch, parts, core):
    """B090: parts 합집합의 core part 만 집계하고(스캔 1회), 계산한 열·일관성은 part=all 의 같은 값, 나머지는 null. part 는 무시."""
    from app.features.analytics.kpi.engines import service as S

    seen: list[tuple[str, ...]] = []
    real = S.fetch_counts

    async def spy(conn, ms, win, **kw):
        seen.append(tuple(kw["parts"]))
        return await real(conn, ms, win, **kw)

    monkeypatch.setattr(S, "fetch_counts", spy)
    full = (await get(client_as, HQ_HYUNDAI, surface="global")).json()
    seen.clear()
    got = (await get(client_as, HQ_HYUNDAI, surface="global", part="exposure", parts=parts)).json()
    assert len(seen) == 1 and set(seen[0]) == core
    filled = {fld for p in core for fld in FIELDS_BY_PART[p]}
    assert [r["engine"] for r in got["data"]["rows"]] == [r["engine"] for r in full["data"]["rows"]]
    for g, f in zip([*got["data"]["rows"], got["data"]["total"]], [*full["data"]["rows"], full["data"]["total"]], strict=True):
        assert {k: g[k] for k in ALL_FIELDS} == {k: (f[k] if k in filled else None) for k in ALL_FIELDS}
    assert got["data"]["engine_consistency"] == {k: (v if CONSISTENCY_FAMILY[k] in core else None)
                                                 for k, v in full["data"]["engine_consistency"].items()}
    assert got["meta"] == full["meta"]


@needs_db
async def test_parts_hidden_family_and_default(client_as, today_at):
    """B090: 숨김 계열 표식은 요청 계열만(part 와 같은 규칙). parts 를 비우면 part 하나 그대로(종전)."""
    b = (await get(client_as, ADMIN, surface="website", parts=["sov", "citation"])).json()
    assert b["meta"]["suppressed"] == {"citation_share": "hidden"} and b["data"]["total"]["cit_total"] is None
    assert b["data"]["total"]["multi"] is None and b["data"]["total"]["answers"] == 2
    assert (await get(client_as, ADMIN, surface="website", parts=["sov"])).json()["meta"]["suppressed"] == {}
    one = (await get(client_as, HQ_HYUNDAI, surface="global", part="sov")).json()
    assert (await get(client_as, HQ_HYUNDAI, surface="global", part="sov", parts=["sov"])).json() == one
    assert (await get(client_as, HQ_HYUNDAI, surface="global", parts=["bogus"])).status_code == 422


@needs_db
async def test_engine_filter_and_period(client_as, today_at):
    d = (await get(client_as, HQ_HYUNDAI, surface="global", engine="gemini")).json()["data"]
    assert [x["engine"] for x in d["rows"]] == ["gemini"]
    b = (await get(client_as, HQ_HYUNDAI, surface="global", **{"from": "2026-09-01", "to": "2026-09-30"})).json()
    assert b["meta"]["mode"] == "cumulative" and b["meta"]["cycles"] == ["2026-09-07", "2026-09-14"]
    assert {x["engine"]: x["answers"] for x in b["data"]["rows"]} == {"chatgpt": 2, "gemini": 1}   # 회차 10 은 std_in 0


@needs_db
async def test_website_hidden_citations(client_as, today_at):
    b = (await get(client_as, ADMIN, surface="website")).json()
    assert b["meta"]["suppressed"] == {"citation_share": "hidden"}
    assert all(x["cit_total"] is None for x in b["data"]["rows"]) and b["data"]["total"]["answers"] == 2


@needs_db
async def test_auth_scope(client_as, today_at):
    assert (await get(client_as, None, surface="global")).status_code == 401
    r = await get(client_as, HQ_HYUNDAI, surface="website")
    assert r.status_code == 403 and r.json()["error"]["code"] == "menu_forbidden"
    assert (await get(client_as, KIA_US, surface="project", project_id=str(CUST_PROJECT))).status_code == 404
    r = await get(client_as, VENDOR, surface="project", project_id=str(CUST_PROJECT))
    assert r.status_code == 200 and [x["engine"] for x in r.json()["data"]["rows"]] == ["chatgpt"]
    de = (await get(client_as, KIA_US, surface="global", country="DE")).json()
    assert de["data"]["rows"] == [] and de["meta"]["dropped_filters"] == {"country": ["DE"]}


@needs_db
async def test_invalid_and_empty(client_as, today_at):
    assert (await get(client_as, HQ_HYUNDAI, surface="global", part="bogus")).status_code == 422
    assert (await get(client_as, HQ_HYUNDAI, surface="global", cycle_offset=3)).status_code == 422
    today_at(date(2026, 9, 1))
    b = (await get(client_as, HQ_HYUNDAI, surface="global")).json()
    assert b["data"]["rows"] == [] and b["data"]["total"]["answers"] == 0
    assert b["meta"]["suppressed"]["*"] == "no_active_snapshot"
