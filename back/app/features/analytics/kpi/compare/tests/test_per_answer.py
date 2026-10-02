"""K-2 답변당 언급·인용 수(BG-05) 테스트. 현행 measuresOf(summary-period-compare.ts:790-801):
  mentionsPerAnswer = 관점 언급 합 ÷ 답변(언급 계열), citationsPerAnswer = 인용 합 ÷ 답변(인용 계열), 단위 pct(증감률).

손 계산(seeded_rounds, HQ_HYUNDAI, 창 09-03~09-14 → cur 회차 41(언급 숨김)·44·10·42·11)
  언급 계열 std_in: 4401·4201(k1 사본, 현대 언급 4씩) + 회차 11 k1(4)·k2(0)·k12(1)          → 13 / 5
  인용 계열 cit_in: 4101(41, 인용 9)·4401(9)·k16·k17·k18(0)·4201(9)·k1(9)·k2·k4·k9·k12(0)     → 36 / 11
  회차 41 은 언급 숨김이라 같은 스캔의 gap_base 로 못 센다(보조 문장 경로).
기대값은 원시 행 + rd.cycle 숨김 코드를 파이썬으로 접어 독립 계산한다(구현 SQL 복사 없음).
"""
from __future__ import annotations

from datetime import date

import pytest

from app.features.analytics.kpi.compare.logic import delta_of
from app.features.analytics.kpi.summary.shared import kpi_today
from app.features.analytics.kpi.summary.tests.seed import seeded_rounds  # noqa: F401  (픽스처 등록)
from tests.support import HQ_HYUNDAI, KIA_US, TODAY, needs_db, raw_fetch

URL = "/v1/kpi/compare"
pytestmark = needs_db
PER = ("mentions_per_answer", "citations_per_answer")


@pytest.fixture
def today_at():
    from app.main import app

    def set_(d: date = TODAY) -> None:
        app.dependency_overrides[kpi_today] = lambda: d
    set_()
    yield set_
    app.dependency_overrides.pop(kpi_today, None)


async def get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


def by(b):
    return {i["metric"]: i for i in b["data"]}


async def expected(conn, lo: str, hi: str, bits: int) -> dict[str, tuple[int, int]]:
    lo_d, hi_d = date.fromisoformat(lo), date.fromisoformat(hi)
    cyc = [r["cyc_key"] for r in await raw_fetch(conn, "SELECT cyc_key FROM rd.cycle WHERE surface = 1 AND round_date BETWEEN $1 AND $2",
                                                 lo_d, hi_d)]
    rows = await raw_fetch(conn, "SELECT a.std_in, a.cit_in, a.dflt, a.bgrp, a.ment_h, a.cit_n, c.hidden_scope, c.servable, c.view_date "
                                 "FROM rd.answer a JOIN rd.cycle c ON c.cyc_key = a.cyc_key "
                                 "WHERE a.surface = 1 AND a.round_date BETWEEN $1::date AND $2::date AND a.cyc_key = ANY($3::int4[])",
                           lo_d, hi_d, cyc)
    rows = [r for r in rows if r["dflt"] and r["cit_in"] and (r["bgrp"] & bits) and r["servable"] and r["view_date"] <= TODAY]
    m = [r for r in rows if r["hidden_scope"] not in (1, 3) and r["std_in"]]
    c = [r for r in rows if r["hidden_scope"] not in (1, 2)]
    return {"mentions_per_answer": (sum(r["ment_h"] for r in m), len(m)), "citations_per_answer": (sum(r["cit_n"] for r in c), len(c))}


async def test_per_answer_values_independent(client_as, today_at, seeded_rounds):  # noqa: F811
    want = await expected(seeded_rounds, "2026-09-03", "2026-09-14", 9)
    assert want == {"mentions_per_answer": (13, 5), "citations_per_answer": (36, 11)}
    r = await get(client_as, HQ_HYUNDAI, surface="global", metrics=list(PER), **{"from": "2026-09-03", "to": "2026-09-14"})
    assert r.status_code == 200, r.text
    b = by(r.json())
    assert list(b) == list(PER)                                        # 요청한 지표만, 요청 순서
    for k in PER:
        assert (b[k]["cur"]["num"], b[k]["cur"]["den"]) == want[k], k
        assert b[k]["unit"] == "pct" and b[k]["prev"] == {"num": 0, "den": 0}
    assert b["mentions_per_answer"]["family"] == "mention" and b["citations_per_answer"]["family"] == "citation"


async def test_per_answer_not_in_default_and_delta_pct(client_as, today_at, seeded_rounds):  # noqa: F811
    d = (await get(client_as, HQ_HYUNDAI, surface="global", kind="cycle")).json()
    assert [i["metric"] for i in d["data"]] == ["visibility", "share_of_voice", "sentiment", "position", "citation_share"]   # 기본 = M01~M05
    b = by((await get(client_as, HQ_HYUNDAI, surface="global", kind="cycle", metrics=["mentions_per_answer", "visibility"])).json())
    it = b["mentions_per_answer"]
    # cycle: cur = 09-14(k1·k2·k12 = 5/3), prev = 09-10(4201 = 4/1)
    assert it["cur"] == {"num": 5, "den": 3} and it["prev"] == {"num": 4, "den": 1}
    assert not it["suppressed"] and it["reason"] is None                               # 두 회차 모두 발행·데이터 있음
    assert it["delta"] == delta_of("pct", (4, 1), (5, 3)) == round((5 / 3 - 4) / 4 * 100, 1) == -58.3   # 증감률(pp 아님)
    assert b["visibility"]["unit"] == "pp"


async def test_per_answer_filters_and_scope(client_as, today_at, seeded_rounds):  # noqa: F811
    kr = by((await get(client_as, HQ_HYUNDAI, surface="global", metrics=list(PER), country="KR",
                       **{"from": "2026-09-03", "to": "2026-09-14"})).json())
    assert kr["mentions_per_answer"]["cur"] == {"num": 0, "den": 0}
    assert kr["citations_per_answer"]["cur"] == {"num": 0, "den": 1}                  # KR k4: cit_in, 인용 0
    ko = by((await get(client_as, HQ_HYUNDAI, surface="global", metrics=list(PER), lang="ko",
                       **{"from": "2026-09-03", "to": "2026-09-14"})).json())
    assert ko["citations_per_answer"]["cur"] == {"num": 0, "den": 1}                  # BG-01 lang 도 같은 모수
    k = by((await get(client_as, KIA_US, surface="global", metrics=list(PER), **{"from": "2026-09-03", "to": "2026-09-14"})).json())
    want = await expected(seeded_rounds, "2026-09-03", "2026-09-14", 10)
    # KIA_US(기아·US): 모수 비트 2|8 행은 k18·k12(둘 다 US, 인용 0)뿐이라 국가 스코프로 더 줄지 않는다. 현대 사본(bgrp 5)은 누출 0
    assert (k["citations_per_answer"]["cur"]["num"], k["citations_per_answer"]["cur"]["den"]) == want["citations_per_answer"] == (0, 2)


async def test_per_answer_422(client_as, today_at):
    r = await get(client_as, HQ_HYUNDAI, surface="global", metrics=["answers_per_prompt"])
    assert r.status_code == 422
    r = await get(client_as, HQ_HYUNDAI, surface="global", metrics=["visibility"] * 8)
    assert r.status_code == 422
