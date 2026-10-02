"""admin.changes.queue 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

ChangeStatus = Literal["pending", "running", "applied", "failed", "escalated_rebuild"]


class ChangeItem(BaseModel):
    """app.judgment_change 한 행. 비동기 쓰기(재판정·운영 요청)의 반영 상태 확인용."""
    change_id: int
    kind: str
    status: ChangeStatus
    subject_uuids: list[uuid.UUID] = Field(default_factory=list)
    subject_texts: list[str] = Field(default_factory=list)
    payload: dict[str, Any] | None = None
    requested_by: uuid.UUID | None = None
    requested_by_email: str | None = Field(None, description="요청자 이메일(계정이 지워졌으면 null)")
    requested_at: datetime
    claimed_at: datetime | None = None
    applied_at: datetime | None = None
    applied_load_id: int | None = Field(None, description="반영한 적재 id(ing.load)")
    error: str | None = None
