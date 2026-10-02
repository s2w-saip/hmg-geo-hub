"""qa.answers.list 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.features.qa.answers.list.scope import QaLock, QaSurface, ReviewState

JobStatus = Literal["completed", "in_progress", "failed", "other"]


class QaListRow(BaseModel):
    job_id: uuid.UUID
    prompt_text: str | None
    surface: QaSurface
    brand: list[str] = Field(description="rd.job.bgrp 비트의 brand_code(app.brand 정렬 순, 카탈로그 밖이면 빈 목록)")
    country: str | None
    engine: str | None
    lang: str | None
    measured_at: datetime | None
    job_status: JobStatus
    dropped: bool
    mention_count: int
    citation_count: int
    note_count: int
    review_status: ReviewState
    reviewer_name: str | None
    lock: QaLock | None


class QaProgressCounts(BaseModel):
    total: int
    reviewed: int
    issues: int
    notes: int


class QaProgress(BaseModel):
    scoped: QaProgressCounts = Field(description="요청 필터 기준")
    total: QaProgressCounts = Field(description="서버 검수 범위 전체(필터 없음)")


class QaNeighbors(BaseModel):
    prev: uuid.UUID | None
    next: uuid.UUID | None


class QaFilterOptions(BaseModel):
    brand: list[str] = Field(description="app.brand 정렬 순(sort_order, brand_code)")
    country: list[str]
    engine: list[str]
    lang: list[str]
    reviewer: list[str]
    surface: list[QaSurface] = Field(description="서버 검수 범위의 표면")
