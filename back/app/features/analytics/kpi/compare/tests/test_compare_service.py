"""기간 비교 조립(get_compare) 테스트: DB 대신 가짜 회차·원장·측정을 주입해 억제되지 않는 Δ·누락 비중·시작 구간을 손 계산으로 단언한다.

합성 픽스처는 직전 회차(10)가 전부 gap 이라 억제 없는 Δ 를 만들 수 없어, 조립 경로는 여기서 검사하고 DB 경로는 test_compare_db 가 검사한다.
창: from 2026-08-15 · to 2026-09-13(30일) → prev 07-16~08-14, cur 08-15~09-13.
  회차 0(06-01)  창 밖, 전 이력 첫 발행 F
  회차 1(07-20)·2(08-03)  prev, 계획 10·10
  회차 3(08-17)  cur, 계획 10
  회차 4(09-07)  cur, 인용 숨김(2) → 발행으로 세고 인용 값은 core 가 뺀다(가짜 측정도 인용 0)
  회차 5(08-24)  cur, 미발행(서빙 아님, 닫힘) → 누락 단위
  회차 6(09-10)  cur, 노출일 전 → 원장 밖 · 회차 7(09-12) 진행 중 → 원장 밖 · 회차 8(08-20) 전체 숨김 → 원장 밖
"""
from __future__ import annotations

from datetime import date

import pytest

from app.core.codes import HIDDEN_EXCLUDE
from app.core.cycles import CycleRow, LedgerRow, build_window
from app.core.filters import ReadContext
from app.features.analytics.kpi.compare import service as svc
from app.features.analytics.kpi.compare.schemas import CompareQuery

D = date.fromisoformat
HIST = [CycleRow(0, 1, D("2026-06-01"), 0), CycleRow(1, 1, D("2026-07-20"), 0), CycleRow(2, 1, D("2026-08-03"), 0),
        CycleRow(3, 1, D("2026-08-17"), 0), CycleRow(4, 1, D("2026-09-07"), 2)]
MEASURE = {   # cyc_key → 가짜 카운트(core fetch_counts 가 group_by cycle 로 낼 모양). M05 분자 = cit_m05(cit_owned 와 다른 값으로 둔다)
    1: dict(answers=10, tracked=5, own_mentions=4, total_mentions=10, sent_pos=3, sent_neg=0, sent_all=4, rank_sum=4, ranked=2,
            cit_total=10, cit_owned=1, cit_m05=3),
    2: dict(answers=10, tracked=5, own_mentions=4, total_mentions=10, sent_pos=3, sent_neg=0, sent_all=4, rank_sum=4, ranked=2,
            cit_total=10, cit_owned=1, cit_m05=3),
    3: dict(answers=10, tracked=8, own_mentions=6, total_mentions=10, sent_pos=4, sent_neg=0, sent_all=4, rank_sum=3, ranked=2,
            cit_total=10, cit_owned=2, cit_m05=4),
    4: dict(answers=10, tracked=8, own_mentions=6, total_mentions=10, sent_pos=4, sent_neg=0, sent_all=4, rank_sum=3, ranked=2,
            cit_total=0, cit_owned=0, cit_m05=0),
}


def ledger_raw(missing_eu: int = 2):
    """rd.cycle 원장 원본(가짜 core.cycles.ledger_rows 가 계열 규칙으로 거른다). ip = 진행 중, fut = 노출일 전."""
    def r(k, d, eu, hs=0, ip=False, fut=False):
        return {"cyc_key": k, "round_date": D(d), "hidden_scope": hs, "expected_units": eu, "in_progress": ip, "future": fut}
    return [r(1, "2026-07-20", 10), r(2, "2026-08-03", 10), r(3, "2026-08-17", 10), r(4, "2026-09-07", 10, hs=2),
            r(5, "2026-08-24", missing_eu), r(6, "2026-09-10", 50, fut=True), r(7, "2026-09-12", 50, ip=True),
            r(8, "2026-08-20", 50, hs=1)]


def ctx(lo: date | None, hi: date | None) -> ReadContext:
    return ReadContext(surface="global", sf=1, principal=None, scope=None, refs=None, project_keys=(1,), own_brands=("Hyundai",),  # type: ignore[arg-type]
                       own_bits=(1,), pop_bits=(1, 8), bgrps=(1, 9), geo_keys=None, countries=None, lang_keys=None, langs=None,
                       engine_keys=None, prompt_keys=None, source_category_keys=None, owner=None, date_from=lo, date_to=hi)


@pytest.fixture
def fake(monkeypatch):
    """core.cycles 세 함수(resolve_window·ledger_rows·first_published)를 같은 규칙의 가짜로 바꾼다. hist = 창 후보(노출) 회차."""
    state: dict = {"hist": list(HIST), "ledger": ledger_raw(), "seen_keys": None, "scan": None}

    def published(fam: str) -> set[int]:
        return {r.cyc_key for r in state["hist"] if r.hidden_scope not in HIDDEN_EXCLUDE[fam]}

    async def resolve_window(conn, *, surface, project_keys, date_from, date_to, offset=0, today=None, project_ids=None):
        state["scan"] = (date_from, date_to)
        rows = [r for r in state["hist"] if date_from <= r.round_date <= date_to]
        return build_window(surface=surface, mode="cumulative", rows=rows, lo=date_from, hi=date_to, generation=7,
                            project_keys=tuple(project_keys))

    async def ledger_rows(conn, *, surface, project_keys, lo, hi, family, today=None):
        pub = published(family)
        return [LedgerRow(r["cyc_key"], 1, r["round_date"], r["expected_units"], r["cyc_key"] in pub, r["hidden_scope"])
                for r in state["ledger"] if lo <= r["round_date"] <= hi and not r["in_progress"] and not r["future"]
                and r["hidden_scope"] not in HIDDEN_EXCLUDE[family]]

    async def first_published(conn, *, surface, project_keys, family, today=None):
        return min((r.round_date for r in state["hist"] if r.cyc_key in published(family)), default=None)

    async def fetch_counts(conn, ms, win, *, group_by=(), split_at=None, parts=()):
        assert group_by == ("cycle",)
        state["seen_keys"] = set(win.cyc_keys("row"))
        out = []
        for k in win.cyc_keys("row"):
            m = dict(MEASURE.get(k, {}))
            out.append({"cyc_key": k, **m})
        return out

    monkeypatch.setattr(svc, "resolve_window", resolve_window)
    monkeypatch.setattr(svc, "ledger_rows", ledger_rows)
    monkeypatch.setattr(svc, "first_published", first_published)
    monkeypatch.setattr(svc, "fetch_counts", fetch_counts)
    return state


async def run(lo="2026-08-15", hi="2026-09-13", **q):
    query = CompareQuery(surface="global", **{"from": lo, "to": hi}, **q)
    return await svc.get_compare(None, ctx(D(lo), D(hi)), query, today=D("2026-09-11"))


async def test_unsuppressed_delta_hand_computed(fake):
    res = await run()
    by = {i.metric: i for i in res.data}
    assert fake["seen_keys"] == {1, 2, 3, 4}                          # 창 밖 회차 0 은 사실 표 스캔에서 빠진다
    v = by["visibility"]
    assert (v.prev.num, v.prev.den, v.cur.num, v.cur.den) == (10, 20, 16, 20)
    assert v.delta == 30.0 and not v.suppressed and v.reason is None
    assert (v.cycles_prev, v.cycles_cur) == (2, 2)                      # 인용 숨김 회차 4 는 발행으로 센다
    assert (v.planned_prev, v.planned_cur) == (20, 22)                  # 노출일 전·진행 중·전체 숨김은 원장 밖
    assert v.missing_share_prev == 0.0 and v.missing_share_cur == pytest.approx(2 / 22)
    p = by["position"]
    assert (p.prev.sum, p.prev.count, p.cur.sum, p.cur.count) == (8, 4, 6, 4) and p.delta == -0.5 and p.unit == "rank"
    c = by["citation_share"]
    assert (c.prev.num, c.prev.den, c.cur.num, c.cur.den) == (6, 20, 4, 10) and c.delta == 10.0 and c.family == "citation"   # cit_m05 합
    assert res.meta.compare.first_published == D("2026-06-01") and res.meta.mode == "cumulative"
    assert res.meta.compare.windows.prev.lo == D("2026-07-16") and res.meta.suppressed == {}
    assert res.meta.cycles == [D("2026-07-20"), D("2026-08-03"), D("2026-08-17"), D("2026-09-07")]


async def test_missing_share_suppresses_but_keeps_pairs(fake):
    fake["ledger"] = ledger_raw(missing_eu=10)                          # cur 누락 10/30 = 0.333 ≥ 0.3
    res = await run()
    v = next(i for i in res.data if i.metric == "visibility")
    assert v.suppressed and v.reason == "missing_share" and v.delta is None
    assert (v.cur.num, v.cur.den) == (16, 20) and v.missing_share_cur == pytest.approx(1 / 3)
    assert res.meta.suppressed["visibility"] == "missing_share"
    short = await run(lo="2026-09-07", hi="2026-09-13")                  # 7일 창은 임계 미적용
    assert all(i.reason != "missing_share" for i in short.data)


async def test_start_window_when_history_begins_mid_prev(fake):
    fake["hist"] = [CycleRow(1, 1, D("2026-07-30"), 0), *HIST[2:]]       # F = 07-30 > 07-16 + 8
    fake["ledger"] = [dict(r, round_date=D("2026-07-30")) if r["cyc_key"] == 1 else r for r in ledger_raw()]
    res = await run()
    assert {i.reason for i in res.data} == {"start_window"}


async def test_metrics_subset_order_and_days_ignored(fake):
    res = await run(metrics=["citation_share", "visibility"], days=7)
    assert [i.metric for i in res.data] == ["citation_share", "visibility"]
    assert res.meta.ignored_filters == ["days"]                         # from/to 가 이긴다


def test_windows_for_range_bounds():
    """D2: 순수 창 계산의 날짜 넘침은 422 invalid_compare_period(ApiError)로 바뀐다."""
    from app.core.errors import ApiError
    for kind, lo, hi in (("window", "0001-01-01", "9999-12-31"), ("calendarMonth", "0001-01-01", "0001-01-31"),
                         ("calendarWeek", "0001-01-01", "0001-01-03"), ("window", "0001-01-01", "0001-01-05")):
        with pytest.raises(ApiError) as e:
            svc.windows_for_range(kind, D(lo), D(hi))
        assert e.value.status == 422 and e.value.code == "invalid_compare_period", (kind, lo)
    assert svc.windows_for_range("window", D("0001-01-02"), D("0001-01-02")).prev.lo == D("0001-01-01")


async def test_scan_window_and_first_published_bound(fake):
    """스캔 창은 [직전(전전) 구간 시작, 현재 구간 끝] 그대로 core 에 넘긴다. 전 이력 첫 발행이 스캔 끝보다 늦으면 F 는 None(이력 이전 창)."""
    res = await run()
    assert fake["scan"] == (D("2026-07-16"), D("2026-09-13"))
    assert res.meta.compare.first_published == D("2026-06-01")
    early = await run(lo="2026-01-01", hi="2026-01-31")
    assert early.meta.compare.first_published is None and all(i.reason == "no_prev" for i in early.data)
