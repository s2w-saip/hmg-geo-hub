"""동결 층 보관 관문(DB-v2.21 P117, 결정 31·32, 설계 card-snapshot-design.md 12.11).

rd 사실 표(answer·answer_brand·citation)에는 보관 트리거가 없다. 사실 쓰기의 단일 관문 ingest.project.apply.service._write_facts 가
다시 쓰기 직전에 before() 로 "이번에 다시 쓰는 답변 ∩ 활성 동결 셀 ∩ 그 세대 아직 미보관"의 지금 rd 행을 frz.keep_* 로 복사하고,
쓰기·단언이 끝난 뒤 settle() 로 값이 같아진 보관을 정리한다(장부 열 is_rep·load_id·ecat_ver·rule_ver 제외, 답변 단위 비교).
비용은 다시 쓰는 동결 답변 수에 비례한다(동결 셀이 없으면 함수가 첫 줄에서 돌아온다).

bulk 재구축(seed-30·40)은 SQL 안에서 같은 함수를 src 'bulk' 로 부른다. 이관 작업(열 백필·fill-v2xx)은 보관 비대상이다(seed 는 -v frz_no_keep=1).
관문 밖 rd 사실 쓰기는 tests/core/test_frz_keep_gate.py 가 막는다(적재 코드에서 사실 쓰기 SQL 은 _write_facts 와 장부 열 쓰기만).
"""
from __future__ import annotations

import asyncpg

READY = "SELECT to_regprocedure('frz.keep_rewrite(int4[], text)') IS NOT NULL"
REWRITE = "SELECT frz.keep_rewrite($1::int4[], 'apply')"
SETTLE = "SELECT frz.keep_settle($1::int4[], 'apply')"


async def ready(conn: asyncpg.Connection) -> bool:
    """DB-v2.21 적용 여부(패치 전 DB 면 관문이 할 일 없음: 배포 순서 무관)."""
    return bool(await conn.fetchval(READY))


async def before(conn: asyncpg.Connection, answer_keys: list[int]) -> int:
    """다시 쓰기 직전: 동결 답변의 지금 행 보관. 반환 = 이번에 보관한 (세대, 답변) 수."""
    if not answer_keys or not await ready(conn):
        return 0
    return int(await conn.fetchval(REWRITE, answer_keys) or 0)


async def settle(conn: asyncpg.Connection, answer_keys: list[int]) -> int:
    """쓰기 뒤: 이 트랜잭션에서 보관한 것 중 값이 같은 것 정리. 반환 = 정리한 (세대, 답변) 수."""
    if not answer_keys or not await ready(conn):
        return 0
    return int(await conn.fetchval(SETTLE, answer_keys) or 0)
