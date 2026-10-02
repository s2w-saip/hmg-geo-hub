"""발행 게이트 시험 공용 준비(합성 픽스처 위, 롤백 트랜잭션 안에서만 쓴다).

픽스처 카탈로그(tests/fixtures/fixture-10-data.sql)는 created_at 이 템플릿 구성 시각이고 Scope 프로젝트 시장(ing.sync_cursor.regions)이 비어
있어 활성 유닛이 거의 없다. gate_catalog 는 루트·Kia DE 사이트 카탈로그를 회차 앵커들보다 앞(2026-09-01)에 등록된 것으로 두고
프로젝트 시장을 루트 {US}·사이트 {DE} 로 채운다. 그러면
  루트 활성 유닛 = Scope 프롬프트 01·02·03·04·06(05 는 삭제, 07 은 카탈로그 밖) × {chatgpt, gemini} × US = 10
  사이트 활성 유닛 = 21·22·23 × {chatgpt, gemini} × DE = 6
"""
from __future__ import annotations

import uuid

import asyncpg

ROOT = uuid.UUID("a0000000-0000-4000-8000-000000000001")
SITE = uuid.UUID("a0000000-0000-4000-8000-000000000002")
SYSTEM = "5eed0000-0000-4000-8000-000000000001"


def sp(n: int) -> uuid.UUID:
    """픽스처 Scope 프롬프트 id(b0000000-…-0000000000NN)."""
    return uuid.UUID(f"b0000000-0000-4000-8000-0000000000{n:02d}")


async def as_owner(c: asyncpg.Connection, sql: str, *args) -> str:
    """loader 롤 연결에서 소유자로 한 문장(준비용). 끝나면 loader 로 돌아간다."""
    await c.execute("RESET ROLE")
    try:
        await c.execute("SELECT set_config('app.actor_id', $1, true), set_config('app.actor_type', 'system', true)", SYSTEM)
        return await c.execute(sql, *args)
    finally:
        await c.execute("SET ROLE loader")


async def gate_catalog(c: asyncpg.Connection) -> None:
    await as_owner(c, "UPDATE app.prompt SET created_at = '2026-09-01' WHERE project_id = 'c0000000-0000-4000-8000-000000000001'")
    await as_owner(c, "UPDATE app.website_prompt SET created_at = '2026-09-01'")
    await c.execute("UPDATE ing.sync_cursor SET regions = '{US}' WHERE scope_project_id = $1", ROOT)
    await c.execute("UPDATE ing.sync_cursor SET regions = '{DE}' WHERE scope_project_id = $1", SITE)


async def add_answer(c: asyncpg.Connection, run_id: uuid.UUID, prompt: uuid.UUID, target: str, region: str, *,
                     status: str = "completed", n_mentions: int = 1) -> None:
    jid = uuid.uuid4()
    k = await c.fetchval("INSERT INTO ing.answer_key_map (job_id, run_month) VALUES ($1, '2026-09-01') RETURNING answer_key", jid)
    await c.execute("""INSERT INTO ing.answer (run_month, job_id, answer_key, run_id, prompt_id, target, region, status, measured_at, n_mentions,
                                              content_hash, load_id)
                       VALUES ('2026-09-01', $1, $2, $3, $4, $5, $6, $7, now(), $8, '\\x00', 1)""",
                    jid, k, run_id, prompt, target, region, status, n_mentions)
