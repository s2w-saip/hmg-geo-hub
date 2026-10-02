"""동결 보관 관문(DB-v2.21 P117)과 엔티티 합계(DB-v2.25 P132~P135)가 같은 적재 트랜잭션에서 충돌 없이 도는지(be/int3 통합 공통 처리 ③).

한 적재 트랜잭션(loader 롤) 순서 = 운영 run 적재와 같다: ing.mention 다시 쓰기(부모 경유, 엔티티 차분) → apply(_write_facts 관문: 동결 답변 보관)
→ 발행 회차 동결 세대 생성(ingest.frz.freeze.freeze_published) → finalize(세대 +1, 엔티티 합계 flush).
  - 이미 동결된 회차의 답변: rd 는 새 값, 동결 뷰는 동결 시점 값(보관 src apply).
  - 같은 트랜잭션에서 뒤에 동결한 회차: 그 시점(재적재 뒤) rd 값을 굳힌다(보관 없음, frz.assert_generation 통과).
  - 엔티티 합계: flush 뒤 표 = 전체 재계산(rd.assert_entity_mention_total), 원장 비움. 동결 층은 합계 표를 읽거나 쓰지 않는다.
엔티티 관리 반영(엔진 → service.project → _write_facts)이 관문을 지나는 것은 test_keep_ecat.py, 반영이 합계를 바꾸지 않는 것은
ingest/project/apply/tests/test_entity_total_ecat.py. 롤백 트랜잭션.
"""
from __future__ import annotations

import asyncpg

from ingest.common.db import finalize
from ingest.frz.freeze import freeze_published
from ingest.frz.tests.support import freeze, keep_rows_of, kept, rd_rows_of, view_rows
from ingest.project.apply.service import apply
from ingest.project.apply.tests.test_equivalence import _ctx, _keys
from tests.support import DB_URL, needs_db

pytestmark = needs_db
FROZEN_CYC, LATER_CYC = 11, 21           # 글로벌 회차를 먼저 동결, 웹 회차는 같은 적재 트랜잭션에서 발행 동결


async def _brand_job(c: asyncpg.Connection, cyc: int, rollup: bool = True):
    """그 회차 대표 답변 중 Brand 언급(표시명 있음, rollup 이면 표시 브랜드 롤업 있음 = rd 브랜드 행이 바뀐다)이 있는 job 하나와 답변 키."""
    r = await c.fetchrow("""
        SELECT j.job_id, j.answer_key FROM rd.answer a JOIN rd.job j ON j.answer_key = a.answer_key
         WHERE a.cyc_key = $1 AND a.is_rep
           AND EXISTS (SELECT 1 FROM ing.mention m WHERE m.job_id = j.job_id AND m.entity_type = 'Brand' AND m.display_name IS NOT NULL
                                                    AND (NOT $2 OR m.brand_rollup_entity_id IS NOT NULL))
         ORDER BY a.answer_key LIMIT 1""", cyc, rollup)
    assert r is not None, cyc
    return r["job_id"], int(r["answer_key"])


async def _rewrite_mentions(c: asyncpg.Connection, job, bump: int) -> None:
    """적재기 CHILDREN 모양: job 의 언급을 부모로 지우고 다시 넣는다(언급 수 +bump). 엔티티 차분이 남는다."""
    rows = await c.fetch("SELECT * FROM ing.mention WHERE job_id = $1 ORDER BY ord", job)
    cols = list(rows[0].keys())
    await c.execute("DELETE FROM ing.mention WHERE job_id = $1", job)
    vals = [tuple((v + bump if k == "mention_count" and v is not None else v) for k, v in r.items()) for r in rows]
    await c.executemany(f"INSERT INTO ing.mention ({', '.join(cols)}) VALUES ({', '.join(f'${i + 1}' for i in range(len(cols)))})", vals)


async def test_keep_gate_and_entity_totals_in_one_load_transaction():
    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    try:
        await c.fetchval("SELECT rd.refresh_entity_mention_total(NULL)")
        totals0 = await c.fetch("SELECT entity_id, answers, mentions FROM rd.entity_mention_total ORDER BY entity_id")
        g_old = (await freeze(c, [FROZEN_CYC]))[FROZEN_CYC]
        v_old = await view_rows(c)
        job_f, ak_f = await _brand_job(c, FROZEN_CYC)
        job_l, ak_l = await _brand_job(c, LATER_CYC, rollup=False)
        before_f = await rd_rows_of(c, [ak_f])
        later_id = await c.fetchval("SELECT cycle_id FROM ing.cycle WHERE cyc_key = $1", LATER_CYC)
        assert await c.fetchval("SELECT status FROM ing.cycle WHERE cyc_key = $1", LATER_CYC) == "published"
        ctx = await _ctx(c)

        await c.execute("SET ROLE loader")
        try:
            async with c.transaction():
                await _rewrite_mentions(c, job_f, 2)
                await _rewrite_mentions(c, job_l, 3)
                assert await c.fetchval("SELECT count(*) FROM ing.entity_mention_delta") > 0
                keys = await _keys(c, "a.job_id = ANY($1::uuid[])", [job_f, job_l])
                res = await apply(c, ctx, keys)
                assert res.frz_kept >= 1 and res.frz_settled < res.frz_kept, (res.frz_kept, res.frz_settled)
                out = await freeze_published(c, [later_id])                       # 같은 트랜잭션, 재적재 뒤 동결
                assert [x["cycle"] for x in out["frozen"]] == [str(later_id)] and not out["failed"], out
                await finalize(c, ctx)                                            # 세대 +1, 엔티티 합계 flush
        finally:
            await c.execute("RESET ROLE")

        # 엔티티 합계 = 전체 재계산, 원장 비움, 바뀐 언급만큼 달라졌다
        assert await c.fetchval("SELECT count(*) FROM ing.entity_mention_delta") == 0
        await c.fetchval("SELECT rd.assert_entity_mention_total()")
        totals1 = await c.fetch("SELECT entity_id, answers, mentions FROM rd.entity_mention_total ORDER BY entity_id")
        assert sum(int(r["mentions"]) for r in totals1) > sum(int(r["mentions"]) for r in totals0)
        # 앞서 동결한 회차: 보관(apply) = 재적재 직전 값, 동결 뷰 중 그 세대 몫은 그대로
        assert (await kept(c)).get(ak_f) == "apply"
        assert await keep_rows_of(c, [ak_f]) == before_f and await rd_rows_of(c, [ak_f]) != before_f
        g_new = await c.fetchval("SELECT gen_key FROM frz.generation WHERE cyc_key = $1 AND state = 'active'", LATER_CYC)
        assert g_new and g_new != g_old
        assert ak_l not in await kept(c), "뒤에 동결한 회차는 재적재 뒤 값을 굳힌다(보관 없음)"
        for g in (g_old, g_new):
            await c.fetchval("SELECT frz.assert_generation($1)", g)
        v_new = await view_rows(c)
        old_cells = {int(r[0]) for r in await c.fetch("SELECT answer_key FROM frz.cell WHERE gen_key = $1", g_old)}
        import json
        for t in v_old:
            mine = lambda rows: [r for r in rows if json.loads(r)["answer_key"] in old_cells]   # noqa: E731
            assert mine(v_new[t]) == mine(v_old[t]), t
        assert await c.fetchval("SELECT count(*) FROM frz.cell WHERE gen_key = $1 AND answer_key = $2", g_new, ak_l) == 1
    finally:
        await tr.rollback()
        await c.close()
