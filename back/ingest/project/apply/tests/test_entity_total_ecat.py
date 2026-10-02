"""엔티티 관리 반영(제거·병합)은 관리 엔티티 목록 합계 rd.entity_mention_total 을 바꾸지 않는다(운영 listDiscoveredBrands = 엔티티 원천 합,
엔티티 관리 5차 항목 1). 반영은 ing.mention 을 쓰지 않으므로 차분이 없고, flush 뒤 표 = 반영 전 표 = 전체 재계산. 롤백 트랜잭션.
"""
from __future__ import annotations

import asyncpg

from ingest.project.apply.service import apply
from ingest.project.apply.tests.test_ecat_lint_parity import _edit, _new_ver, _step
from ingest.project.apply.tests.test_ecat_overlay import ACTOR, CRETA, TOYOTA, TOYOTA2, _all_keys, _as_loader, _stage_v1
from tests.support import DB_URL, needs_db

pytestmark = needs_db
TOTALS = "SELECT entity_id, answers, mentions FROM rd.entity_mention_total ORDER BY entity_id"


async def test_entity_management_apply_does_not_change_totals():
    c = await asyncpg.connect(DB_URL)
    try:
        tr = c.transaction()
        await tr.start()
        try:
            ctx = await _stage_v1(c)
            await c.fetchval("SELECT rd.refresh_entity_mention_total(NULL)")
            before = [tuple(r) for r in await c.fetch(TOTALS)]
            keys = await _all_keys(c)
            await c.execute("SELECT app.ecat_cutover_v1($1, 'totals')", ACTOR)
            await _as_loader(c, lambda: apply(c, ctx, keys))
            v2 = await _new_ver(c, 1)
            await _edit(c, v2, TOYOTA, {"role": "removed"})
            await _edit(c, v2, CRETA, {"merge_into": TOYOTA2})
            await _step(c, ctx, 1, v2)
            assert await c.fetchval("SELECT count(*) FROM ing.entity_mention_delta") == 0      # 반영은 원천 언급을 쓰지 않는다
            await c.fetchval("SELECT rd.flush_entity_mention_total()")
            after = [tuple(r) for r in await c.fetch(TOTALS)]
            assert after == before and len(before) > 0
            assert await c.fetchval("SELECT rd.assert_entity_mention_total()") == len(before)
        finally:
            await tr.rollback()
    finally:
        await c.close()
