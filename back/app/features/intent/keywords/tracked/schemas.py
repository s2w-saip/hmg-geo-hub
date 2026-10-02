"""intent.keywords.tracked 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import date, datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.envelope import Envelope, ListData


class TrackedKeyword(BaseModel):
    keyword_id: uuid.UUID
    term: str
    country_code: str | None = Field(description="저장값(NULL = 프로젝트 국가)")
    country: str | None = Field(description="유효 국가(프리셋 id). 프로젝트 국가가 프리셋 밖이면 null")
    created_at: datetime
    latest_month: date | None
    latest_volume: int | None


class TrackedKeywordIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    term: str = Field(min_length=1, max_length=200)
    country: str | None = Field(None, max_length=8, description="ISO2 프리셋 id. 생략하면 프로젝트 국가를 따른다")


class Removed(BaseModel):
    removed_count: int


TrackedListEnvelope = Envelope[ListData[TrackedKeyword]]
TrackedEnvelope = Envelope[TrackedKeyword]
RemovedEnvelope = Envelope[Removed]
