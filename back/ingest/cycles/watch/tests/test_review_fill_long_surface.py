"""검토 대기함 채우기의 긴 표면(be/int3-prior 전수 점검): ing.surface_seen PK·app.ecat_review UNIQUE 는 (엔티티, 정규형) btree 라
정규형이 2,704 바이트를 넘으면 문장 전체가 실패한다(적재기 _ig_prior_url 의 긴 URL 과 같은 결함 유형). 표면은 Scope 원천 문자열.
SURFACE_MAX_BYTES(1,000) 를 넘는 표면은 원장·대기함에서 건너뛰고, 같은 창의 정상 표면은 그대로 큐된다(기준선·판정 창 두 문장 모두).
일회 DB(fresh_db), Slack 실제 발송 없음.
"""
from __future__ import annotations

import datetime as dt
import hashlib

import asyncpg

from ingest.common.alerts import MemoryAlertSink
from ingest.common.db import LoaderDB
from ingest.cycles.watch.service import SURFACE_MAX_BYTES, watch
from ingest.cycles.watch.tests.test_review_fill_first_seen import HYUNDAI, NOW, _answer, _review
from tests.support import needs_db


def _long_surface(nbytes: int = 3200) -> str:
    h, out = b"surface", ""
    while len(out) < nbytes:
        h = hashlib.sha256(h).digest()
        out += h.hex()
    return "Ioniq " + out[:nbytes]


@needs_db
async def test_long_surface_is_skipped_and_fill_succeeds(fresh_db):
    long = _long_surface()
    assert len(long.encode()) > 3000 > SURFACE_MAX_BYTES
    c = await asyncpg.connect(fresh_db)
    try:
        async with c.transaction():
            await _answer(c, NOW - dt.timedelta(days=30), HYUNDAI, ["Hyundai", long])        # 기준선 쪽(창 앞)
            await _answer(c, NOW - dt.timedelta(hours=1), HYUNDAI, [long + "x", "Ioniq Z"])   # 판정 창 쪽
    finally:
        await c.close()
    rep = await watch(LoaderDB(fresh_db, role="loader"), now=NOW, alerts=MemoryAlertSink(), checks=["review_fill"])
    rows = await _review(fresh_db)
    surf = {r["surface_norm"] for r in rows if r["kind"] == "new_surface"}
    assert surf == {"ioniq z"}, rows
    assert rep.info["review_fill"]["new_surface"] == 1, rep.info
    c = await asyncpg.connect(fresh_db)
    try:
        assert await c.fetchval("SELECT max(octet_length(surface_norm)) FROM ing.surface_seen") <= SURFACE_MAX_BYTES
        assert await c.fetchval("SELECT count(*) FROM ing.surface_seen WHERE surface_norm = 'hyundai'") == 1
    finally:
        await c.close()
