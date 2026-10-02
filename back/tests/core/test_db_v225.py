"""DB-v2.25 통합 공통 처리(be/int3): P136 ing 하위 파티션 쓰기 권한 회수 · P137 mig.known_diff AD-2 정리.

P136: 엔티티 합계 트리거(P133)는 ing.mention·ing.answer_drop 부모 문장 트리거라 월 leaf 직접 쓰기가 차분을 우회한다(rd 사실 표 leaf 는 DB-v2.21 P119).
  - 기존 leaf 전부와 새 월 leaf(rd.ensure_month_leaf·rd.ensure_hub_match_leaf 가 만든 것)에 loader·migrator 쓰기 권한이 없다(읽기는 있다).
  - 부모 경유 쓰기(INSERT·UPDATE·DELETE·COPY)는 파티션 라우팅이 부모 권한만 보므로 그대로 되고, 엔티티 차분도 남는다.
  - ing 밖 부모(ext.dfs_call 등)의 새 leaf 는 종전 그대로(기본 권한).
롤백 트랜잭션(복제본 불변).
"""
from __future__ import annotations

import asyncpg
import pytest

from tests.support import DB_URL, needs_db

pytestmark = needs_db
WRITE = ("INSERT", "UPDATE", "DELETE", "TRUNCATE")
ING_LEAVES = """
SELECT p.relid::regclass::text AS leaf FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 CROSS JOIN LATERAL pg_partition_tree(c.oid) p
 WHERE n.nspname = 'ing' AND c.relkind = 'p' AND NOT c.relispartition AND p.level > 0 ORDER BY 1"""


async def _conn() -> tuple[asyncpg.Connection, asyncpg.transaction.Transaction]:
    c = await asyncpg.connect(DB_URL)
    tr = c.transaction()
    await tr.start()
    return c, tr


async def _writable(c: asyncpg.Connection, role: str, rel: str) -> list[str]:
    return [p for p in WRITE if await c.fetchval("SELECT has_table_privilege($1, $2, $3)", role, rel, p)]


async def test_ing_leaves_have_no_write_privilege_including_new_leaves():
    c, tr = await _conn()
    try:
        await c.execute("SELECT rd.ensure_month_leaf('ing.mention'::regclass, '2027-03-01'::date)")
        await c.execute("SELECT rd.ensure_month_leaf('ing.answer'::regclass, '2027-03-01'::date)")
        await c.execute("SELECT rd.ensure_hub_match_leaf('2027-03-01'::date)")
        await c.execute("SELECT rd.ensure_month_leaf('ext.dfs_call'::regclass, '2027-03-01'::date)")
        leaves = [r[0] for r in await c.fetch(ING_LEAVES)]
        assert {"ing.mention_202703", "ing.answer_202703", "ing.hub_match_202703", "ing.mention_202609"} <= set(leaves), leaves
        for leaf in leaves:
            for role in ("loader", "migrator"):
                assert await _writable(c, role, leaf) == [], (role, leaf)
            assert await c.fetchval("SELECT has_table_privilege('loader', $1, 'SELECT')", leaf), leaf
        for root in ("ing.mention", "ing.answer", "ing.citation", "ing.hub_match", "ing.answer_stance", "ing.mention_occurrence"):
            assert await _writable(c, "loader", root) == ["INSERT", "UPDATE", "DELETE"], root           # 부모 권한은 그대로(TRUNCATE 는 원래 없음)
        assert "INSERT" in await _writable(c, "loader", "ext.dfs_call_202703"), "ing 밖 부모의 새 leaf 는 종전 그대로"
    finally:
        await tr.rollback()
        await c.close()


async def test_root_writes_route_and_leave_entity_delta_leaf_writes_denied():
    """loader 롤: 부모 경유 DELETE·INSERT·COPY 는 leaf 로 라우팅되고 엔티티 차분이 남는다. leaf 직접 쓰기는 권한 오류."""
    c, tr = await _conn()
    try:
        job = await c.fetchval("SELECT job_id FROM ing.mention WHERE entity_type = 'Brand' AND display_name IS NOT NULL ORDER BY job_id LIMIT 1")
        leaf = await c.fetchval("SELECT tableoid::regclass::text FROM ing.mention WHERE job_id = $1 LIMIT 1", job)
        await c.execute("DELETE FROM ing.entity_mention_delta")
        await c.execute("SET ROLE loader")
        rows = await c.fetch("SELECT * FROM ing.mention WHERE job_id = $1 ORDER BY ord", job)
        cols = list(rows[0].keys())
        for sql in (f"UPDATE {leaf} SET mention_count = mention_count WHERE job_id = $1", f"DELETE FROM {leaf} WHERE job_id = $1"):
            with pytest.raises(asyncpg.InsufficientPrivilegeError):
                async with c.transaction():
                    await c.execute(sql, job)
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            async with c.transaction():
                await c.execute(f"TRUNCATE {leaf}")
        n_del = await c.execute("DELETE FROM ing.mention WHERE job_id = $1", job)
        assert n_del == f"DELETE {len(rows)}"
        half = len(rows) // 2 or 1
        await c.copy_records_to_table("mention", schema_name="ing", columns=cols, records=[tuple(r) for r in rows[:half]])
        if rows[half:]:
            await c.executemany(f"INSERT INTO ing.mention ({', '.join(cols)}) VALUES ({', '.join(f'${i + 1}' for i in range(len(cols)))})",
                                [tuple(r) for r in rows[half:]])
        with pytest.raises(asyncpg.InsufficientPrivilegeError):
            async with c.transaction():
                await c.execute(f"INSERT INTO {leaf} SELECT * FROM ing.mention WHERE false")
        await c.execute("RESET ROLE")
        assert await c.fetchval("SELECT count(*) FROM ing.mention WHERE job_id = $1 AND tableoid = $2::regclass", job, leaf) == len(rows)
        assert await c.fetchval("SELECT count(*) FROM ing.entity_mention_delta") > 0, "부모 경유 쓰기는 엔티티 차분을 남긴다"
        await c.fetchval("SELECT rd.flush_entity_mention_total()")
        await c.fetchval("SELECT rd.assert_entity_mention_total()")             # 지우고 같은 행을 다시 넣었다 = 합계 불변
    finally:
        await tr.rollback()
        await c.close()


async def test_known_diff_ad2_removed():
    c, tr = await _conn()
    try:
        assert await c.fetchval("SELECT count(*) FROM mig.known_diff WHERE rule_id = 'AD-2'") == 0
        assert await c.fetchval("SELECT count(*) FROM mig.known_diff WHERE rule_id = 'K-1b'") >= 1      # 다른 행은 그대로
    finally:
        await tr.rollback()
        await c.close()
