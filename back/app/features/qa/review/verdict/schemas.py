"""qa.review.verdict 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Flag = Literal["ok", "issue"]
SECTIONS = ("answer", "prompt", "mentions", "citations", "acr", "meta")


class QaSectionFlags(BaseModel):
    """섹션별 판정. 생략한 섹션은 NULL(미판정)로 저장한다. 모르는 섹션 키는 422."""
    model_config = ConfigDict(extra="forbid")
    answer: Flag | None = None
    prompt: Flag | None = None
    mentions: Flag | None = None
    citations: Flag | None = None
    acr: Flag | None = None
    meta: Flag | None = None


class QaReviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    section_flags: QaSectionFlags


class QaReview(BaseModel):
    job_id: uuid.UUID
    status: Literal["ok", "issue"] = Field(description="DB GENERATED: 하나라도 issue 면 issue")
    section_flags: QaSectionFlags
    reviewer_name: str
    session_id: uuid.UUID | None
    reviewed_at: datetime
    updated_at: datetime
