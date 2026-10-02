"""projects.settings.tracked_urls 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine


class TrackedUrl(BaseModel):
    url: str
    url_norm: str = Field(description="정규화 키(삭제 파라미터 ?url_norm=, 타겟 인용 판정 등치 비교 값)")
    label: str | None = None
    created_by: uuid.UUID
    created_at: datetime


class TrackedUrlList(BaseModel):
    items: list[TrackedUrl]
    next_cursor: str | None = None
    total: int = Field(description="프로젝트 추적 URL 전체 수")


class TrackedUrlCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: PgLine = Field(min_length=1, max_length=2048)
    label: PgLine | None = Field(None, max_length=200)


class TrackedUrlWrite(BaseModel):
    tracked_url: TrackedUrl | None = None
    url_norm: str
    change_id: int
    propagation: str = "pending"


class TrackedUrlImport(BaseModel):
    created: int
    updated: int
    skipped: int
    warnings: list[str]
    change_id: int | None = Field(None, description="변경이 있었으면 judgment_change('project_target_url') 1건")
    propagation: str = "none"
