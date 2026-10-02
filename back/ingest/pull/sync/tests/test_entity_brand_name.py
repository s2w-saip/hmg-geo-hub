"""롤업 대표 표기 원장 ing.entity_brand_name(DB-v2.26 P138~P140) 동시 적재 시험(be/int3-name).

같은 새 Brand 표기를 처음 들이는 두 적재가 동시에 열려 있어도 서로 막히지 않는다(원장에 유일 제약이 없다: 유일 색인이었을 때
test_entity_mention_total CE24 가 두 번째 적재의 ing.mention INSERT 에서 첫 적재 커밋까지 멈췄다). 둘 다 커밋한 뒤 원장은 그 쌍을
가진다(동시에 처음 본 경우만 중복 행, 읽는 쪽은 UNION). refresh 는 없는 쌍만 넣으므로 0. 일회 DB(fresh_db).
"""
from __future__ import annotations

import asyncio
import uuid

import asyncpg

from ingest.pull.sync.tests.test_entity_mention_total import _MENT, _new_job
from tests.support import needs_db


@needs_db
async def test_concurrent_loads_same_new_brand_name_do_not_block(fresh_db):
    fresh = uuid.uuid4()
    x = await asyncpg.connect(fresh_db)
    a = await asyncpg.connect(fresh_db)
    b = await asyncpg.connect(fresh_db)
    try:
        await x.execute("SELECT setval(pg_get_serial_sequence('ing.answer_key_map', 'answer_key'), "
                        "(SELECT coalesce(max(answer_key), 0) + 1 FROM ing.answer_key_map), false)")
        ta, tb = a.transaction(), b.transaction()
        await ta.start()
        await tb.start()
        ja, jb = await _new_job(a), await _new_job(b)
        await a.execute(_MENT, ja, 1, fresh, "Freshname", 1)
        await asyncio.wait_for(b.execute(_MENT, jb, 1, fresh, "Freshname", 2), 5)        # a 미커밋이어도 대기 없음
        await asyncio.wait_for(b.execute(_MENT, jb, 2, fresh, "Freshname2", 1), 5)
        await ta.commit()
        await tb.commit()
        got = await x.fetch("SELECT DISTINCT display_name FROM ing.entity_brand_name WHERE entity_id = $1 ORDER BY 1", fresh)
        assert [r[0] for r in got] == ["Freshname", "Freshname2"]
        assert await x.fetchval("SELECT count(*) FROM ing.entity_brand_name WHERE entity_id = $1", fresh) in (2, 3)
        firsts = {str(r[0]) for r in await x.fetch(
            "SELECT first_job FROM ing.entity_brand_name WHERE entity_id = $1 AND display_name = 'Freshname'", fresh)}
        assert firsts <= {str(ja), str(jb)} and firsts
        assert await x.fetchval("SELECT rd.refresh_entity_brand_name()") == 0
        # 커밋된 쌍을 다시 받으면 더하지 않는다(중복은 동시 첫 관측 때만)
        tc = a.transaction()
        await tc.start()
        jc = await _new_job(a)
        await a.execute(_MENT, jc, 1, fresh, "Freshname", 1)
        await tc.commit()
        assert await x.fetchval("SELECT count(*) FROM ing.entity_brand_name WHERE entity_id = $1 AND first_job = $2", fresh, jc) == 0
    finally:
        for c in (a, b, x):
            await c.close()


@needs_db
async def test_long_brand_name_does_not_break_mention_insert(fresh_db):
    """원장 색인 키 = (엔티티, md5(표기)): 표기가 btree 행 상한(2,704 바이트)을 넘어도 ing.mention 적재(원장 트리거)가 실패하지 않는다.
    원문 키 색인이면 'index row size exceeds' 로 적재 전체가 멈춘다(적재기 _ig_prior_url 과 같은 결함 유형). 압축이 안 되는 임의 표기 8,000자."""
    import os

    x = await asyncpg.connect(fresh_db)
    try:
        await x.execute("SELECT setval(pg_get_serial_sequence('ing.answer_key_map', 'answer_key'), "
                        "(SELECT coalesce(max(answer_key), 0) + 1 FROM ing.answer_key_map), false)")
        assert "md5(display_name)" in await x.fetchval("SELECT indexdef FROM pg_indexes WHERE schemaname = 'ing' "
                                                       "AND indexname = 'entity_brand_name_pair_idx'")
        e, name = uuid.uuid4(), os.urandom(4000).hex()
        tr = x.transaction()
        await tr.start()
        j = await _new_job(x)
        await x.execute(_MENT, j, 1, e, name, 1)
        await x.execute(_MENT, j, 2, e, name, 1)                                       # 같은 표기 다시 = 원장에 더하지 않는다
        await tr.commit()
        assert await x.fetchval("SELECT count(*) FROM ing.entity_brand_name WHERE entity_id = $1 AND display_name = $2", e, name) == 1
        assert await x.fetchval("SELECT rd.refresh_entity_brand_name()") == 0
    finally:
        await x.close()
