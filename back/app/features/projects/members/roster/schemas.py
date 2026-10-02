"""projects.members.roster 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.filters import PgLine

MemberRole = Literal["owner", "viewer"]
MemberStatus = Literal["pending", "active"]
_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")        # 현행 member/_actions.ts EMAIL_RE 와 같은 모양


class Member(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str | None = None
    role: MemberRole
    status: MemberStatus
    invited_by: uuid.UUID
    invited_by_email: str | None = None
    invited_at: datetime
    accepted_at: datetime | None = None


class MemberList(BaseModel):
    items: list[Member]


class InviteBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: PgLine = Field(min_length=3, max_length=320)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL.match(v):
            raise ValueError("이메일 형식 오류")
        return v


class RolePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: MemberRole
