"""WU-3 현행 프로필 카드 경로(card=true) DB 시험: card_slot_rep(R04CIT, 기간 창 자리 대표)·summary_all_engines(DFLT·DC-01, 전 엔진).

근거: 계획서 notes/hgh-impl/revert-to-current-plan-20261001.md 5.2절, 제품 결정 19·25(현행 값 재현, 예외 없음).
현행(hmg-geo 2670a16 + read_screens 14키) 대시보드 카드·GEO·경쟁사·도메인·엔진 배지·추이·기간 비교는 집계층 사실표를 읽는다:
  · 기간 창 = 회차 집합을 자리(round_date)마다 대표 하나로 좁힌다(server.ts:1945-1958 viaGlobalS1 → cycle-set.ts:883 restrictToTrendSlotSet)
  · 엔진 필터가 없으면 전 엔진(summary-trend-aggregates.ts:730 은 고른 엔진만 거른다, 사실표에는 회차 run 의 모든 target 이 있다)
답변분석 화면(미러 앵커 경로)은 둘 다 아니다: 요청 card 가 없으면 스위치가 켜져 있어도 종전(허브) 정의 그대로다.

오라클은 기능 코드의 새 경로를 거치지 않는 같은 엔드포인트의 종전 정의 상태다(롤백 전용 staged 준비):
  자리 대표  픽스처 글로벌 회차 10(09-07)을 회차 11(09-14) 자리로 옮기고 앵커를 늦추고 인용 숨김(수집 오류)으로 만든다 →
             현행 카드 = 언급 대표 10·인용 대표 11. 오라클 = 스위치 꺼짐에서 회차 11 을 언급 숨김(3)으로 둔 상태(계열 키가 같다: 언급 {10}·인용 {11}).
  전 엔진    회차 11 의 비기본 엔진 답변 1건 → 오라클 = 스위치 꺼짐에서 그 답변(과 사실 표 사본)의 dflt 를 참으로 둔 상태.
"""
from __future__ import annotations

import json
from typing import Any

import pytest

from tests.support import ADMIN, HQ_HYUNDAI, Sql, needs_db, raw_fetch, staged

pytestmark = needs_db

PERIOD = {"from": "2026-09-01", "to": "2026-09-20"}
# 회차 10 → 09-14 자리, 앵커 09-15(회차 11 의 09-14 보다 늦다), 인용 숨김(수집 오류). rd.cycle 만 바꾼다: 답변의 round_date(09-07)는 창 안이다
MOVE_10 = ("UPDATE rd.cycle SET round_date = DATE '2026-09-14', anchor_date = DATE '2026-09-15', hidden_scope = 2, hidden_reason = 1 "
           "WHERE cyc_key = 10")
HIDE_11_MENTIONS = "UPDATE rd.cycle SET hidden_scope = 3, hidden_reason = 2 WHERE cyc_key = 11"
# 회차 11 의 비기본 엔진 답변을 기본 엔진 답변처럼(dflt 참) 보이게: 사실 표 4종의 사본까지
DFLT_ALL = tuple(f"UPDATE rd.{t} SET dflt = true WHERE surface = 1 AND cyc_key = 11 AND NOT dflt"
                 for t in ("answer", "answer_brand", "citation"))

# 카드 경로 엔드포인트(대시보드 호출 모양, warm_calls D1·D2·D8·D9·M7 과 같은 파라미터에서 card 를 뺀 것: card 는 시험이 붙인다)
CALLS: tuple[tuple[str, dict[str, Any]], ...] = (
    ("/v1/kpi/summary", {}),
    ("/v1/mentions/brands", {"top_n": "20", "sort": "mentions", "include": "hmg"}),
    ("/v1/citations/domains", {"limit": "0", "competitor_sources": "true"}),
    ("/v1/geo", {}),
    ("/v1/kpi/engines", {"part": "all"}),
)


def _set(settings, spec: str) -> None:
    from app.core.config import set_settings

    set_settings(settings.model_copy(update={"legacy_profile": spec}))


async def _data(client_as, uid, extra: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    async with client_as(uid) as cl:
        for path, params in CALLS:
            r = await cl.get(path, params={"surface": "global", **params, **extra})
            body = r.json()
            assert r.status_code == 200, (path, body)
            out[path] = body["data"]
    return out


@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI])
async def test_card_slot_rep_equals_family_keys_oracle(client_as, settings, uid):
    try:
        _set(settings, "card_slot_rep")
        async with staged(Sql(MOVE_10)) as conn:
            keys = await raw_fetch(conn, "SELECT cyc_key, round_date, hidden_scope FROM rd.cycle WHERE surface = 1 AND cyc_key IN (10, 11) ORDER BY 1")
            assert [(r["round_date"].isoformat(), r["hidden_scope"]) for r in keys] == [("2026-09-14", 2), ("2026-09-14", 0)]
            on = await _data(client_as, uid, {**PERIOD, "card": "true"})
            plain = await _data(client_as, uid, PERIOD)                         # card 없음 = 종전 창(스위치 켜짐이어도)
        _set(settings, "off")
        async with staged(Sql(MOVE_10), Sql(HIDE_11_MENTIONS)):
            oracle = await _data(client_as, uid, PERIOD)
        async with staged(Sql(MOVE_10)):
            off = await _data(client_as, uid, {**PERIOD, "card": "true"})       # 스위치 꺼짐 = card 무효
    finally:
        _set(settings, "off")
    assert on == oracle, json.dumps({k: [on[k], oracle[k]] for k in on if on[k] != oracle[k]}, ensure_ascii=False, default=str)[:1500]
    assert plain == off                                                        # card 는 스위치 꺼짐이면 효과 없음, 스위치 켜짐도 card 없으면 종전
    assert on != off                                                           # 대조가 비어 있지 않다(08-24 형태의 자리에서 값이 갈린다)


@pytest.mark.parametrize("uid", [ADMIN, HQ_HYUNDAI])
async def test_summary_all_engines_equals_dflt_oracle(client_as, settings, uid):
    try:
        _set(settings, "summary_all_engines")
        async with staged() as conn:
            n = await raw_fetch(conn, "SELECT count(*) AS n FROM rd.answer WHERE surface = 1 AND cyc_key = 11 AND NOT dflt")
            assert n[0]["n"] >= 1                                              # 픽스처에 비기본 엔진 답변이 있다(비어 있지 않은 대조)
            on_snap = await _data(client_as, uid, {"card": "true"})
            on_period = await _data(client_as, uid, {**PERIOD, "card": "true"})
            plain = await _data(client_as, uid, {})
        _set(settings, "off")
        async with staged(*(Sql(s) for s in DFLT_ALL)):
            oracle_snap = await _data(client_as, uid, {})
            oracle_period = await _data(client_as, uid, PERIOD)
        async with staged():
            off = await _data(client_as, uid, {})
    finally:
        _set(settings, "off")
    for got, want in ((on_snap, oracle_snap), (on_period, oracle_period)):
        assert got == want, json.dumps({k: [got[k], want[k]] for k in got if got[k] != want[k]}, ensure_ascii=False, default=str)[:1500]
    assert plain == off and on_snap != off
