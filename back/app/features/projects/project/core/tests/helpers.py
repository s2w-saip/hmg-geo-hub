"""pj-core 그룹 테스트 공용 도우미(PJ-1·PJ-2·PJ-4 기능 테스트가 함께 쓴다).

- 각 테스트는 자기 프로젝트를 API(ADMIN = 소유자)로 만들고 끝나면 소유자 접속으로 지운다(공유 복제본 DB 오염 방지).
- 기대값 확인은 구현 SQL 이 아니라 여기 독립 SQL(asyncpg 소유자 접속)로 한다.
- 추가 테스트 계정 GLOBAL_KIA(hq · operator global · 브랜드 Kia)는 생성 스코프 검증용으로 멱등 UPSERT 한다.
"""
from __future__ import annotations

import contextlib
import uuid
from typing import Any

import asyncpg

from tests.support import ADMIN, DB_URL, SYSTEM

GLOBAL_KIA = uuid.UUID("11111111-0000-4000-8000-0000000000a1")      # pj-core 테스트 전용 계정

_EXTRA_ACCOUNT_SQL = """
INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, scope_regions, scope_countries, menu_groups, status)
VALUES ('11111111-0000-4000-8000-0000000000a1', 't-pj-global-kia@example.test', 'hq', 'global', false, '{Kia}', '{}', '{}', NULL, 'active')
ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role, operator = EXCLUDED.operator, scope_all = EXCLUDED.scope_all,
  scope_brands = EXCLUDED.scope_brands, scope_regions = EXCLUDED.scope_regions, scope_countries = EXCLUDED.scope_countries,
  status = EXCLUDED.status
"""


@contextlib.asynccontextmanager
async def owner_db():
    """소유자(postgres) 접속 + 트랜잭션 1개. 행위자 GUC 를 트랜잭션 로컬로 심어 트리거가 요구하는 app.actor() 를 채운다."""
    c = await asyncpg.connect(DB_URL)
    try:
        async with c.transaction():
            await c.execute("SELECT set_config('app.actor_id', $1, true)", str(SYSTEM))
            yield c
    finally:
        await c.close()


async def ensure_extra_accounts() -> None:
    async with owner_db() as c:
        await c.execute(_EXTRA_ACCOUNT_SQL)


def uniq(prefix: str = "pj") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}"


async def create_project(client_as, uid: uuid.UUID = ADMIN, **body: Any) -> dict[str, Any]:
    """API 로 프로젝트 생성(기본: ADMIN, US, 엔진 chatgpt). 응답 data 를 돌려준다."""
    payload = {"name": uniq(), "country_code": "US", "ai_engines": ["chatgpt"], **body}
    async with client_as(uid) as c:
        r = await c.post("/v1/projects", json=payload)
    assert r.status_code == 201, r.text
    return r.json()["data"]


async def purge(*project_ids: uuid.UUID | str) -> None:
    async with owner_db() as c:
        await c.execute("DELETE FROM app.project WHERE project_id = ANY($1::uuid[]) AND kind = 'customer'",
                        [str(x) for x in project_ids])


async def add_member(project_id, user_id, role: str = "viewer", status: str = "active") -> None:
    async with owner_db() as c:
        await c.execute("""
            INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at)
            VALUES ($1, $2, $3::app.member_role, $4::app.member_status, $5, CASE WHEN $4 = 'active' THEN now() END)
            ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role, status = EXCLUDED.status,
              accepted_at = EXCLUDED.accepted_at""", str(project_id), str(user_id), role, status, str(ADMIN))


async def fetch(sql: str, *args: Any) -> list[dict[str, Any]]:
    async with owner_db() as c:
        return [dict(r) for r in await c.fetch(sql, *args)]


async def fetchval(sql: str, *args: Any) -> Any:
    async with owner_db() as c:
        return await c.fetchval(sql, *args)
