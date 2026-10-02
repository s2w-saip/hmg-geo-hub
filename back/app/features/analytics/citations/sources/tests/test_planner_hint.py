"""/v1/citations/sources Gather 비용 힌트(core.db.planner_hint, be/web-card-perf 2026-10-01) 값 동치·되돌림 시험.

1. 힌트 켬 = 힌트 끔(바이트): /sources·/sources/types, 필터 4종(없음·brand=Hyundai·국가 1개·다회차 기간) × 계정 2개(관리자·현대 hq).
   합성 픽스처는 작아 기본 힌트로는 계획이 안 바뀌므로, 켬 쪽은 병렬을 강제하는 설정(parallel_setup_cost·min_parallel_*_scan_size 0)을
   더해 실제로 다른(병렬) 계획을 타게 한다. 강제가 걸렸는지는 블록 안 GUC 값으로 확인한다.
2. planner_hint: 블록 안에서만 값이 바뀌고 끝나면(예외여도) 원래 값, 허용 밖 키 거부, 블록 뒤 같은 트랜잭션이 계속 쓰인다.
준비: test_sources_equiv 와 같은 rich 준비(다회차·톤 음수·언어·톤 중복·출처).
"""
from __future__ import annotations

import pathlib
from typing import Any

import pytest

from app.core import db as core_db
from app.core.db import PARALLEL_GATHER_HINT, fetch_one, planner_hint
from app.features.analytics.citations.prompts.tests.staged_db import SQL as PROMPT_SQL
from app.features.analytics.citations.sources import service
from tests.support import ADMIN, HQ_HYUNDAI, load_named_sql, needs_db, staged
from tests.support import Sql as StageSql

pytestmark = needs_db
BG = load_named_sql(pathlib.Path(__file__).parents[2] / "domains" / "tests" / "bg.pgsql")
EQ = load_named_sql(pathlib.Path(__file__).with_name("equiv.pgsql"))
STEPS = (StageSql(PROMPT_SQL["global"]), StageSql(BG["src_first"]), StageSql(BG["tone_negative"]), StageSql(BG["lang_ko"]),
         StageSql(BG["share_tie"]), StageSql(EQ["tone_dup"]))
FILTERS: tuple[dict[str, Any], ...] = ({}, {"brand": "Hyundai"}, {"country": "US"}, {"from": "2026-08-01", "to": "2026-09-30"})
FORCE = PARALLEL_GATHER_HINT + (("parallel_setup_cost", "0"), ("min_parallel_table_scan_size", "0"), ("min_parallel_index_scan_size", "0"))


async def _bodies(client_as, uid) -> dict[str, bytes]:
    out: dict[str, bytes] = {}
    async with client_as(uid) as c:
        for path in ("/v1/citations/sources", "/v1/citations/sources/types"):
            for f in FILTERS:
                r = await c.get(path, params={"surface": "global", **f})
                out[f"{path} {f}"] = r.status_code.to_bytes(2, "big") + r.content
    return out


async def test_sources_hint_equals_no_hint(client_as, monkeypatch):
    seen: list[str] = []
    real = planner_hint

    def forced(conn, settings):
        assert settings == PARALLEL_GATHER_HINT                          # 서비스는 정의된 힌트만 건다
        return _recording(real(conn, FORCE), conn, seen)

    async with staged(*STEPS):
        with monkeypatch.context() as m:
            m.setattr(core_db, "PLANNER_HINT_KEYS", core_db.PLANNER_HINT_KEYS | {k for k, _ in FORCE})
            m.setattr(service, "planner_hint", forced)
            on = {uid: await _bodies(client_as, uid) for uid in (ADMIN, HQ_HYUNDAI)}
        with monkeypatch.context() as m:
            m.setattr(service, "planner_hint", _no_hint)
            off = {uid: await _bodies(client_as, uid) for uid in (ADMIN, HQ_HYUNDAI)}
    assert seen and set(seen) == {"0"}                                   # 켬 쪽에서 강제 설정이 실제로 걸렸다
    for uid in (ADMIN, HQ_HYUNDAI):
        diff = [k for k in on[uid] if on[uid][k] != off[uid][k]]
        assert not diff, (uid, diff)
        assert all(v[:2] == (200).to_bytes(2, "big") for v in on[uid].values())
    totals = {k: v for k, v in on[ADMIN].items() if k.startswith("/v1/citations/sources {")}
    assert len(set(totals.values())) > 1                                 # 필터가 값을 가른다(빈 대조 아님)


class _recording:
    """planner_hint 블록에 들어갈 때 parallel_setup_cost 를 기록한다(강제 설정이 걸렸는지)."""

    def __init__(self, cm, conn, seen):
        self.cm, self.conn, self.seen = cm, conn, seen

    async def __aenter__(self):
        c = await self.cm.__aenter__()
        r = await fetch_one(self.conn, "SELECT current_setting('parallel_setup_cost') AS v", {})
        self.seen.append(str(r["v"]))
        return c

    async def __aexit__(self, *exc):
        return await self.cm.__aexit__(*exc)


class _no_hint:
    def __init__(self, conn, settings):
        pass

    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


async def test_planner_hint_scoped_and_restored():
    async with staged() as conn:
        before = (await fetch_one(conn, "SELECT current_setting('parallel_tuple_cost') AS v", {}))["v"]
        async with planner_hint(conn, PARALLEL_GATHER_HINT):
            inside = (await fetch_one(conn, "SELECT current_setting('parallel_tuple_cost') AS v", {}))["v"]
        after = (await fetch_one(conn, "SELECT current_setting('parallel_tuple_cost') AS v", {}))["v"]
        assert inside == "0.001" and after == before != "0.001"
        with pytest.raises(RuntimeError, match="boom"):
            async with planner_hint(conn, PARALLEL_GATHER_HINT):
                raise RuntimeError("boom")
        assert (await fetch_one(conn, "SELECT current_setting('parallel_tuple_cost') AS v", {}))["v"] == before
        assert (await fetch_one(conn, "SELECT count(*) AS n FROM rd.cycle", {}))["n"] >= 0          # 트랜잭션은 계속 쓸 수 있다
        with pytest.raises(ValueError, match="허용되지 않은"):
            async with planner_hint(conn, (("work_mem", "1GB"),)):
                pass
