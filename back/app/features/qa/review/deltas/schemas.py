"""qa.review.deltas 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.features.qa.answers.list.scope import QaLock

MAX_IDS = 200


class QaDeltasQuery(BaseModel):
    """job_ids: 반복(?job_ids=a&job_ids=b) 또는 쉼표 구분. 200개 초과분은 무시하고 meta.dropped_filters.job_ids 에 적는다(현행 계승)."""
    model_config = ConfigDict(extra="ignore")
    job_ids: list[str] = Field(default_factory=list, max_length=1000)


class QaReviewDelta(BaseModel):
    job_id: uuid.UUID
    status: Literal["ok", "issue"]
    reviewer_name: str
    updated_at: datetime


class QaDeltas(BaseModel):
    locks: list[QaLock] = Field(description="TTL 안의 유효 락만")
    reviews: list[QaReviewDelta]
