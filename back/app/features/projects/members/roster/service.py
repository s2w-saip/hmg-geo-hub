"""projects.members.roster 업무 규칙(PJ-2). 현행 member/_actions.ts·setting/_actions.ts(promote·demote) 불변식 이식.

- 조회: 활성 멤버 또는 admin(core resolve_project level='active_member'). 비멤버 404.
- 쓰기: 활성 Owner 또는 admin(core resolve_project level='owner'). 변경 1건 + app.member_audit_log 1건을 한 트랜잭션에.
- 불변식: 초대 대상은 기존 가입자(활성 계정), 본인 초대·제거 금지, Owner 는 강등 후 제거, 마지막 활성 Owner 강등 금지(FOR UPDATE).
"""
from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncConnection

from app.core import errors
from app.core.auth import Principal
from app.core.db import fetch_all, fetch_one
from app.features.projects.members.roster import queries as Q
from app.features.projects.project.core.shared import project_access


async def audit(rw: AsyncConnection, project_id: uuid.UUID, actor: uuid.UUID, target: uuid.UUID, action: str,
                context: str | None = None) -> None:
    """멤버 감사 1건(append-only, 같은 트랜잭션). action 은 DB CHECK 7값."""
    await rw.execute(text(Q.AUDIT), {"pid": project_id, "actor": actor, "target": target, "action": action, "context": context})


def already_member_error(status: str) -> errors.ApiError:
    """초대 중복 409(fe-u9 요청 1, U9-1): active = already_member("이미 멤버입니다"), pending = already_invited("이미 초대된 사용자입니다
    (대기 상태)"). 프론트는 코드로 가른다. details.status 는 호환용으로 계속 싣는다(바뀔 수 있는 값, 분기 근거 아님)."""
    if status == "active":
        return errors.conflict("already_member", "이미 활성 멤버", {"status": status})
    return errors.conflict("already_invited", "이미 초대 대기 중", {"status": status})


async def list_members(ro: AsyncConnection, p: Principal, project_id: uuid.UUID) -> list[dict[str, Any]]:
    await project_access(ro, p, project_id, "active_member")
    return await fetch_all(ro, Q.LIST, {"pid": project_id})


async def invite(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, email: str) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    inv = await fetch_one(rw, Q.INVITEE, {"email": email})
    if inv is None:
        raise errors.not_found("해당 이메일로 가입된 사용자가 없다", code="invitee_not_found")
    uid = inv["user_id"]
    if uid == p.user_id:
        raise errors.ApiError(400, "self_invite", "본인을 초대할 수 없다")
    cur = await fetch_one(rw, Q.EXISTING, {"pid": project_id, "uid": uid})
    if cur is not None:
        raise already_member_error(cur["status"])
    ins = await fetch_one(rw, Q.INSERT_INVITE, {"pid": project_id, "uid": uid, "actor": p.user_id})
    if ins is None:                     # 동시 초대 경합: 먼저 들어간 행을 다시 읽어 그 상태로 코드를 고른다(READ COMMITTED 새 스냅샷)
        cur = await fetch_one(rw, Q.EXISTING, {"pid": project_id, "uid": uid})
        if cur is None:                 # 그 사이 취소·거절로 지워졌다: 재시도하면 초대된다
            raise errors.conflict("retry_conflict", "동시 변경으로 초대가 반영되지 않았다(재시도 가능)")
        raise already_member_error(cur["status"])
    await audit(rw, project_id, p.user_id, uid, "invite", "role=viewer")
    row = await fetch_one(rw, Q.ONE, {"pid": project_id, "uid": uid})
    assert row is not None
    return row


async def change_role(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, user_id: uuid.UUID,
                      role: str) -> dict[str, Any]:
    await project_access(ro, p, project_id, "owner")
    owners: list[dict[str, Any]] = []
    if role == "viewer":                # 강등: 활성 Owner 행 전부를 먼저 잠가 동시 강등 경합에서도 마지막 Owner 를 지킨다
        owners = await fetch_all(rw, Q.LOCK_ACTIVE_OWNERS, {"pid": project_id})
    t = await fetch_one(rw, Q.LOCK_TARGET, {"pid": project_id, "uid": user_id})
    if t is None:
        raise errors.not_found("해당 멤버가 없다", code="member_not_found")
    if t["status"] != "active":
        raise errors.conflict("not_active", "활성 멤버만 역할을 바꿀 수 있다")
    if t["role"] == role:
        raise errors.conflict("already_that_role", "이미 그 역할이다")
    if role == "viewer" and len(owners) <= 1:
        raise errors.conflict("last_owner_cannot_demote", "마지막 Owner 는 강등할 수 없다")
    await rw.execute(text(Q.SET_ROLE), {"pid": project_id, "uid": user_id, "role": role})
    await audit(rw, project_id, p.user_id, user_id, "promote" if role == "owner" else "demote",
                "viewer->owner" if role == "owner" else "owner->viewer")
    row = await fetch_one(rw, Q.ONE, {"pid": project_id, "uid": user_id})
    assert row is not None
    return row


async def remove(ro: AsyncConnection, rw: AsyncConnection, p: Principal, project_id: uuid.UUID, user_id: uuid.UUID,
                 expect: str | None = None) -> str:
    """pending = 초대 취소(cancel_invite), active = 제거(remove). 수행한 action 을 돌려준다.
    expect(fe-u9 요청 2, U9-2): 'pending' 이면 대기 중인 초대만 취소한다(active 면 409 not_pending), 'active' 면 활성 멤버만 제거한다
    (pending 이면 409 not_active). 상태 확인은 대상 행 FOR UPDATE 잠금 안에서 해 조회와 삭제 사이 경합 창이 없다."""
    await project_access(ro, p, project_id, "owner")
    t = await fetch_one(rw, Q.LOCK_TARGET, {"pid": project_id, "uid": user_id})
    if t is None:
        raise errors.not_found("해당 멤버가 없다", code="member_not_found")
    if expect == "pending" and t["status"] != "pending":
        raise errors.conflict("not_pending", "대기 중인 초대가 아니다", {"status": t["status"]})
    if expect == "active" and t["status"] != "active":
        raise errors.conflict("not_active", "활성 멤버가 아니다", {"status": t["status"]})
    if t["status"] == "active":
        if t["role"] == "owner":
            raise errors.conflict("cannot_remove_owner", "Owner 는 강등한 뒤 제거한다")
        if user_id == p.user_id:
            raise errors.ApiError(400, "cannot_remove_self", "본인을 제거할 수 없다")
    await rw.execute(text(Q.DELETE_MEMBER), {"pid": project_id, "uid": user_id})
    if t["status"] == "pending":
        await audit(rw, project_id, p.user_id, user_id, "cancel_invite")
        return "cancel_invite"
    await audit(rw, project_id, p.user_id, user_id, "remove", f"role={t['role']}")
    return "remove"
