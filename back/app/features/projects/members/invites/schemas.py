"""projects.members.invites 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class PendingInvite(BaseModel):
    project_id: uuid.UUID
    project_name: str
    brand_code: str | None = None
    country_code: str
    role: str
    invited_by: uuid.UUID
    invited_by_email: str | None = None
    invited_at: datetime


class PendingInviteList(BaseModel):
    items: list[PendingInvite]
