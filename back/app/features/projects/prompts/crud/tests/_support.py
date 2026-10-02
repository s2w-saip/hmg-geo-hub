"""pj-prompts 테스트 공용: 모듈마다 전용 고객 프로젝트·계정을 만들고 끝나면 지운다(공유 합성 픽스처 CUST_PROJECT 는 읽기만).

계정(모듈 전용, 끝나면 삭제)
  owner    hq · operator none · Hyundai · 프로젝트 활성 Owner
  op       hq · operator assigned · Hyundai · 프로젝트 활성 viewer(운영 가능, 소유 아님)
  nomenu   hq · operator none · Hyundai · 메뉴 {standard}(project 메뉴 없음 → 403)
공용 계정(tests.support): ADMIN 전권 · HQ_HYUNDAI 비멤버·스코프 안(읽기도 404: 메인 정정 2026-09-28) · VENDOR 활성 viewer(모듈 프로젝트에도 추가) ·
  KIA_US·KIA_EU 스코프 밖(404) · SUSPENDED 정지(401).
기대값은 구현 SQL 을 복붙하지 않고 이 모듈의 독립 SQL(소유자 접속)로 확인한다.
"""
from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

import asyncpg
import pytest_asyncio

from tests.support import DB_URL, SYSTEM, VENDOR


@dataclass
class Env:
    conn: asyncpg.Connection
    owner: uuid.UUID
    op: uuid.UUID
    nomenu: uuid.UUID
    project_id: uuid.UUID
    projects: list[uuid.UUID] = field(default_factory=list)

    async def q(self, sql: str, *args: Any) -> list[asyncpg.Record]:
        return await self.conn.fetch(sql, *args)

    async def val(self, sql: str, *args: Any) -> Any:
        return await self.conn.fetchval(sql, *args)

    async def as_actor(self, sql: str, *args: Any, actor: uuid.UUID = SYSTEM) -> list[asyncpg.Record]:
        async with self.conn.transaction():
            await self.conn.execute("SELECT set_config('app.actor_id', $1, true)", str(actor))
            return await self.conn.fetch(sql, *args)

    async def mk_project(self, *, brand: str = "Hyundai", country: str = "US") -> uuid.UUID:
        pid = uuid.uuid4()
        await self.as_actor("""
            INSERT INTO app.project (project_id, kind, name, brand_code, country_code, created_by)
            VALUES ($1, 'customer', $2, $3, $4, $5)""", pid, f"pj-prompts-test-{pid.hex[:8]}", brand, country, SYSTEM)
        await self.as_actor("""
            INSERT INTO app.project_member (project_id, user_id, role, status, invited_by, accepted_at) VALUES
              ($1, $2, 'owner', 'active', $5, now()), ($1, $3, 'viewer', 'active', $5, now()), ($1, $4, 'viewer', 'active', $5, now())""",
                            pid, self.owner, self.op, VENDOR, SYSTEM)
        self.projects.append(pid)
        return pid

    async def mk_prompt(self, text: str, *, project_id: uuid.UUID | None = None, status: str = "draft",
                        scope_prompt_id: uuid.UUID | None = None, kind: str = "single", created_at: datetime | None = None) -> uuid.UUID:
        rows = await self.as_actor("""
            INSERT INTO app.prompt (project_id, text, status, scope_prompt_id, kind, created_by, created_at)
            VALUES ($1, $2, $3, $4, $5, $6, coalesce($7::timestamptz, now())) RETURNING prompt_id""",
                                   project_id or self.project_id, text, status, scope_prompt_id, kind, SYSTEM, created_at)
        return rows[0]["prompt_id"]

    async def mk_field(self, label: str, *, project_id: uuid.UUID | None = None, archived: bool = False) -> uuid.UUID:
        return await self.val("""
            INSERT INTO app.project_custom_field (project_id, label, archived, created_by) VALUES ($1, $2, $3, $4) RETURNING field_id""",
                              project_id or self.project_id, label, archived, SYSTEM)

    async def set_tag(self, prompt_id: uuid.UUID, field_id: uuid.UUID, value: str, *, project_id: uuid.UUID | None = None) -> None:
        await self.conn.execute("""
            INSERT INTO app.prompt_custom_field_value (project_id, prompt_id, field_id, value) VALUES ($1, $2, $3, $4)
            ON CONFLICT (prompt_id, field_id) DO UPDATE SET value = EXCLUDED.value""",
                                project_id or self.project_id, prompt_id, field_id, value)

    async def mk_candidate(self, text: str, *, project_id: uuid.UUID | None = None, source: str = "manual",
                           keyword: str | None = None, created_at: datetime | None = None) -> uuid.UUID:
        return await self.val("""
            INSERT INTO app.prompt_candidate (project_id, source, source_keyword, text, created_at)
            VALUES ($1, $2, $3, $4, coalesce($5::timestamptz, now())) RETURNING candidate_id""",
                              project_id or self.project_id, source, keyword, text, created_at)

    async def outbox(self, prompt_id: uuid.UUID) -> list[dict[str, Any]]:
        rows = await self.q("SELECT op, payload, done_at FROM app.scope_outbox WHERE aggregate = 'prompt' AND aggregate_id = $1 "
                            "ORDER BY outbox_id", prompt_id)
        return [{"op": r["op"], "payload": json.loads(r["payload"]), "done_at": r["done_at"]} for r in rows]

    async def audits(self, prompt_id: uuid.UUID) -> list[asyncpg.Record]:
        return await self.q("SELECT event_type, actor_id, changes FROM app.prompt_audit_log WHERE prompt_id = $1 ORDER BY audit_id",
                            prompt_id)


def _user_sql(uid: uuid.UUID, operator: str, menus: list[str] | None) -> tuple[str, list[Any]]:
    return ("""INSERT INTO app.user_account (user_id, email, role, operator, scope_all, scope_brands, menu_groups, status)
               VALUES ($1, $2, 'hq', $3::app.operator_scope, false, '{Hyundai}', $4::app.menu_group[], 'active')""",
            [uid, f"t-pjp-{uid.hex[:12]}@example.test", operator, menus])


@pytest_asyncio.fixture(name="env", scope="module", loop_scope="session")
async def env_fixture(seeded):
    """모듈 전용 계정 3개 + 고객 프로젝트 1개(Hyundai US). 끝나면 프로젝트(CASCADE)·계정·outbox·judgment_change 를 지운다."""
    conn = await asyncpg.connect(DB_URL)
    owner, op, nomenu = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    e = Env(conn=conn, owner=owner, op=op, nomenu=nomenu, project_id=uuid.uuid4())
    for uid, oper, menus in ((owner, "none", None), (op, "assigned", None), (nomenu, "none", ["standard"])):
        sql, args = _user_sql(uid, oper, menus)
        await e.as_actor(sql, *args)
    e.project_id = await e.mk_project()
    try:
        yield e
    finally:
        ids = [str(p) for p in e.projects]
        await e.as_actor("DELETE FROM app.scope_outbox WHERE payload->>'project_id' = ANY($1::text[])", ids)
        await e.as_actor("DELETE FROM app.project WHERE project_id = ANY($1::uuid[])", ids)
        await e.as_actor("DELETE FROM app.judgment_change WHERE payload->>'project_id' = ANY($1::text[])", ids)
        await e.as_actor("DELETE FROM app.user_account WHERE user_id = ANY($1::uuid[])", [owner, op, nomenu])
        await conn.close()
