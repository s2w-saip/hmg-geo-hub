"""GET /v1/funnel/acr 검증 결함 회귀(D3, 검증 커밋 c063a69).

D3: 스냅샷 회차에 ACR 셀이 0 이어도 추이를 낸다. 이전 게이트 회차는 값, 셀 없는 그 회차는 gap(추이 규칙 "셀 없는 게이트 회차 = gap").
시리즈 브랜드는 스냅샷 브랜드가 없으므로 추이 창(09-07·09-14·09-18) 전체 순위에서 당사 우선으로 고른다:
  Hyundai 선택 2+5 = 7 · Toyota 2(셀 2) · Kia 2(셀 1) → 당사 우선 Hyundai·Kia, 그다음 Toyota.
"""
from __future__ import annotations

import pathlib
from contextlib import asynccontextmanager

import pytest

from tests.support import ADMIN, TODAY, Sql, needs_db, savepoint, stage

URL = "/v1/funnel/acr"
pytestmark = [needs_db, pytest.mark.usefixtures("acr_seed")]

# 시드 조각은 rd 쓰기(소유자 실행)라 데이터 파일(.pgsql)로 두고 '-- @이름' 으로 나눠 읽는다(back/tests/README.md 6절).
_SQL: dict[str, str] = {}
for _part in (pathlib.Path(__file__).parent / "regress_acr.pgsql").read_text(encoding="utf-8").split("-- @")[1:]:
    _name, _, _body = _part.partition("\n")
    _SQL[_name.strip()] = _body.strip()


class _Stager:
    """시험 하나의 추가 행: core stage() 로 소유자가 넣는다(savepoint 안이라 시험 끝에 되돌린다)."""

    def __init__(self, conn):
        self.conn = conn

    async def execute(self, sql: str, *args) -> None:
        await stage(self.conn, Sql(sql, tuple(args)))


@asynccontextmanager
async def _owner(conn):
    async with savepoint(conn):
        yield _Stager(conn)


async def _get(client_as, uid, **params):
    async with client_as(uid) as c:
        return await c.get(URL, params=params)


async def test_d3_empty_snapshot_still_has_trend(client_as, acr_seed):
    assert TODAY.isoformat() >= "2026-09-20"                              # 새 회차의 노출일이 기준일 이전이어야 스냅샷이 된다
    async with _owner(acr_seed) as c:
        await c.execute(_SQL["d3"])
        r = await _get(client_as, ADMIN, surface="global")
        assert r.status_code == 200, r.text
        body = r.json()
        d, m = body["data"], body["meta"]
        assert m["mode"] == "snapshot" and m["cycles"] == ["2026-09-18"] and m["suppressed"] == {}
        assert d["totals"]["prompt_runs"] == 0 and d["brands"] == [] and d["battle"] == []
        t = d["trend"]
        assert t["series_brands"] == ["Hyundai", "Kia", "Toyota"]
        assert [(x["round_date"], x["gap"], x["den"]) for x in t["buckets"]] == [
            ("2026-09-07", False, 2), ("2026-09-14", False, 9), ("2026-09-18", True, 0)]
        assert [{s["brand"]: s["num"] for s in x["series"]} for x in t["buckets"]] == [
            {"Hyundai": 2, "Kia": 0, "Toyota": 0}, {"Hyundai": 5, "Kia": 2, "Toyota": 2}, {"Hyundai": 0, "Kia": 0, "Toyota": 0}]

        r = await _get(client_as, ADMIN, surface="global", trend_cycles=1)  # 창이 셀 없는 회차 하나뿐이면 시리즈 없이 gap 버킷 하나
        t = r.json()["data"]["trend"]
        assert t == {"series_brands": [], "buckets": [{"round_date": "2026-09-18", "gap": True, "den": 0, "series": []}]}

    r = await _get(client_as, ADMIN, surface="global")                      # 회차를 지우면 원래 스냅샷(09-14)으로 복귀
    assert r.json()["meta"]["cycles"] == ["2026-09-14"]
