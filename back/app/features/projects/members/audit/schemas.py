"""projects.members.audit 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel

AuditAction = Literal["invite", "cancel_invite", "remove", "promote", "demote", "accept", "reject"]


class MemberAuditEntry(BaseModel):
    audit_id: str                  # bigint → 문자열(JS 정밀도)
    actor_id: uuid.UUID
    actor_email: str | None = None
    target_user_id: uuid.UUID
    target_email: str | None = None
    action: AuditAction
    context: str | None = None
    created_at: datetime


class MemberAuditList(BaseModel):
    items: list[MemberAuditEntry]
    next_cursor: str | None = None
