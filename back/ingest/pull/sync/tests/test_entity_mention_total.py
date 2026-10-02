"""관리 엔티티 목록 합계 rd.entity_mention_total(DB-v2.25 P132~P135) 증분 = 전체 재계산 시험(엔티티 관리 5차 항목 1, B안).

증분 = ing.mention·ing.answer_drop 문장 트리거 차분 → 적재 마무리(ingest.common.db.finalize)의 rd.flush_entity_mention_total().
전체 = rd.refresh_entity_mention_total(NULL)(= rd.entity_mention_total_expected(NULL)). rd.assert_entity_mention_total() 가 표 = 전체를 단언한다.
독립 기대값 = 운영 hmg-geo 2670a16 listDiscoveredBrands 식(entity-registry.ts:118-136)을 ing 에 옮긴 SQL(허브 함수 미사용).
경로: ① pull 패스(새 run) ② 재분석 재pull(한 job 에서 엔티티가 빠지고 다른 엔티티가 생김) ③ 답변 드롭·복구(handle_answer_drop + finalize)
④ 동시 적재 두 개의 finalize(같은 새 엔티티, 검증 5차 CE24).
일회 DB(fresh_db). 증분 쪽은 loader 롤.
"""
from __future__ import annotations

import asyncio
import uuid

import asyncpg

from ingest.common.db import LoaderDB, begin_load, finalize
from ingest.cycles.ledger import service as L
from ingest.pull.sync.service import run_pass
from ingest.pull.sync.tests.test_pull import NOW, R10, ROOT, TOY, _j, _settings, _source
from ingest.testkit import mention
from tests.support import needs_db

KIA = "00000000-0000-0000-0000-000000000302"
PROD_DEF = """
SELECT m.entity_id::text AS id, count(DISTINCT m.job_id)::int8 AS a, sum(m.mention_count)::int8 AS m
  FROM ing.mention m
 WHERE m.entity_type = 'Brand' AND m.display_name IS NOT NULL AND m.job_id NOT IN (SELECT d.job_id FROM ing.answer_drop d)
 GROUP BY m.entity_id"""


async def _check(url: str) -> dict[str, tuple[int, int]]:
    """표 = 전체 재계산(assert) = 운영 정의 독립 재계산. 반환 = 표."""
    c = await asyncpg.connect(url)
    try:
        assert await c.fetchval("SELECT count(*) FROM ing.entity_mention_delta") == 0       # finalize 가 차분을 비웠다
        await c.fetchval("SELECT rd.assert_entity_mention_total()")
        table = {str(r["entity_id"]): (int(r["answers"]), int(r["mentions"]))
                 for r in await c.fetch("SELECT entity_id, answers, mentions FROM rd.entity_mention_total")}
        prod = {r["id"]: (int(r["a"]), int(r["m"])) for r in await c.fetch(PROD_DEF)}
        assert table == prod, (table, prod)
        return table
    finally:
        await c.close()


@needs_db
async def test_incremental_equals_full_through_loader(fresh_db):
    db = LoaderDB(fresh_db, role="loader")
    t0 = await _check(fresh_db)
    # ① pull 패스: j101(Hyundai·Toyota), j102(Hyundai), j104(Hyundai) 새 언급
    rep = await run_pass(db, _source(), project=ROOT, now=NOW, settings=_settings())
    assert rep.error is None and [r.status for r in rep.runs] == ["committed"]
    t1 = await _check(fresh_db)
    assert t1[TOY][0] == t0.get(TOY, (0, 0))[0] + 1
    # ② 재분석 재pull: j101 에서 Toyota 가 빠지고 Kia 가 생긴다(job 단위 지우고 다시 넣기: 빠진 엔티티도 차분으로 줄어야 한다)
    src = _source()
    j101 = next(j for j in src.jobs[R10] if j["job_id"] == _j(101))
    ms = [m for m in j101["analysis"]["resolved_mentions"] if m["entity_id"] != TOY]
    j101["analysis"]["resolved_mentions"] = ms + [mention(KIA, "Kia", count=3)]
    rep = await run_pass(db, src, project=ROOT, now=NOW, force=True, settings=_settings())
    assert [(r.status, r.jobs_changed) for r in rep.runs if str(r.run_id) == R10] == [("committed", 1)]
    t2 = await _check(fresh_db)
    assert t2.get(TOY, (0, 0)) == t0.get(TOY, (0, 0)) and t2[KIA][1] == t0.get(KIA, (0, 0))[1] + 3
    # ③ 드롭·복구(운영 미러는 드롭 답변 언급을 지운다): 적재 마무리와 같은 트랜잭션 경로
    for payload in ({"job_id": _j(101), "reason": "dup"}, {"job_id": _j(101), "op": "restore"}):
        async with db.session() as conn, db.tx(conn):
            ctx = await begin_load(conn, "judgment")
            await L.handle_answer_drop(conn, ctx, payload, None)
            await finalize(conn, ctx)
        t3 = await _check(fresh_db)
        if payload.get("op") == "restore":
            assert t3 == t2
        else:
            assert t3[KIA][1] == t2[KIA][1] - 3


HYUNDAI = "00000000-0000-0000-0000-000000000301"
_MENT = ("INSERT INTO ing.mention (run_month, job_id, ord, entity_id, display_name, entity_type, mention_count) "
         "VALUES ('2026-09-01', $1, $2, $3, $4, 'Brand', $5)")


async def _new_job(c: asyncpg.Connection):
    jid = uuid.uuid4()
    ak = await c.fetchval("INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ($1, '2026-09-01') RETURNING answer_key", jid)
    await c.execute("""INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, target, status, measured_at, n_mentions, content_hash, load_id)
                       VALUES ('2026-09-01', $1, $2, $3, 'chatgpt', 'completed', now(), 1, '\\x00', 1)""", jid, ak, uuid.uuid4())
    return jid


async def test_concurrent_finalize_same_new_entity(fresh_db):
    """검증 5차 CE24: 같은 새 엔티티를 처음 언급하는 두 적재가 동시에 finalize(flush) 해도 두 번째 몫이 사라지지 않는다.
    flush·refresh 는 한 advisory 잠금으로 직렬화된다(두 번째는 첫 커밋까지 대기 → 커밋된 행을 보고 더한다). 두 적재가 기존 엔티티
    (Hyundai·Kia)를 서로 반대 순서로 건드려도 교착 없이 끝난다."""
    fresh = uuid.uuid4()
    x = await asyncpg.connect(fresh_db)
    a = await asyncpg.connect(fresh_db)
    b = await asyncpg.connect(fresh_db)
    try:
        await x.execute("SELECT setval(pg_get_serial_sequence('ing.answer_key_map', 'answer_key'), "
                        "(SELECT coalesce(max(answer_key), 0) + 1 FROM ing.answer_key_map), false)")
        await x.fetchval("SELECT rd.refresh_entity_mention_total(NULL)")
        before = {str(r[0]): (int(r[1]), int(r[2])) for r in await x.fetch(
            "SELECT entity_id, answers, mentions FROM rd.entity_mention_total WHERE entity_id = ANY($1::uuid[])", [HYUNDAI, KIA])}
        ta, tb = a.transaction(), b.transaction()
        await ta.start()
        await tb.start()
        ja, jb = await _new_job(a), await _new_job(b)
        for c, j, rows in ((a, ja, ((fresh, "Freshco", 2), (HYUNDAI, "Hyundai", 1), (KIA, "Kia", 1))),
                           (b, jb, ((fresh, "Freshco", 3), (KIA, "Kia", 5), (HYUNDAI, "Hyundai", 4)))):
            for i, (eid, name, n) in enumerate(rows, 1):
                await c.execute(_MENT, j, i, uuid.UUID(str(eid)), name, n)
        await a.fetchval("SELECT rd.flush_entity_mention_total()")
        fb = asyncio.create_task(b.fetchval("SELECT rd.flush_entity_mention_total()"))
        await asyncio.sleep(0.5)
        assert not fb.done()                                                            # 직렬화: a 커밋까지 대기
        await ta.commit()
        await asyncio.wait_for(fb, 15)
        await tb.commit()
        await x.fetchval("SELECT rd.assert_entity_mention_total()")
        assert await x.fetchval("SELECT count(*) FROM ing.entity_mention_delta") == 0
        got = {str(r[0]): (int(r[1]), int(r[2])) for r in await x.fetch(
            "SELECT entity_id, answers, mentions FROM rd.entity_mention_total WHERE entity_id = ANY($1::uuid[])", [fresh, HYUNDAI, KIA])}
        assert got[str(fresh)] == (2, 5), got                                           # 두 적재 몫 모두
        for eid, (da, dm) in ((HYUNDAI, (2, 5)), (KIA, (2, 6))):
            ba, bm = before.get(eid, (0, 0))
            assert got[eid] == (ba + da, bm + dm), (eid, got[eid], before.get(eid))
    finally:
        for c in (a, b, x):
            await c.close()
