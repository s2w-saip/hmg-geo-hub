"""qa.review.lock 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.features.qa.answers.list.scope import QaLock


class QaLockHeld(BaseModel):
    """heartbeat 결과. held=false 면 락을 잃었다(TTL 만료 후 탈취 또는 해제)."""
    held: bool
    lock: QaLock | None = None


class QaLockReleased(BaseModel):
    released: bool = Field(description="본인 세션 락을 지웠으면 true(없거나 남의 락이면 false)")


class QaLockHolder(BaseModel):
    reviewer_name: str
    acquired_at: datetime
