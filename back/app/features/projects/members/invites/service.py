"""projects.members.invites 업무 규칙(PJ-2). 초대 대상 본인만(자기 대기 행이 곧 권한, Owner 여부 무관).
수락 = status pending→active + accepted_at, 거절 = 행 삭제. 둘 다 member_audit_log(actor = target = 본인) 같은 트랜잭션.
대기 행이 없으면(다른 사람 초대·이미 수락·존재하지 않는 프로젝트 포함) 모두 404 no_pending_invite(존재 은닉)."""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.db import fetch_all, fetch_one
from app.features.projects.members.invites import queries as Q
from app.features.projects.members.roster.service import audit


async def respond(rw: AsyncConnection, p: Principal, project_id: uuid.UUID, accept: bool) -> None:
    r = await fetch_one(rw, Q.ACCEPT if accept else Q.REJECT, {"pid": project_id, "uid": p.user_id})
    if r is None:
        raise errors.not_found("대기 중인 초대가 없다", code="no_pending_invite")
    await audit(rw, project_id, p.user_id, p.user_id, "accept" if accept else "reject")


async def my_pending(ro: AsyncConnection, p: Principal) -> list[dict[str, Any]]:
    return await fetch_all(ro, Q.MY_PENDING, {"uid": p.user_id})
