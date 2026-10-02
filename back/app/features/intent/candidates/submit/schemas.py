"""intent.candidates.submit 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.envelope import Envelope

MAX_ITEMS = 200


class CandidateItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(max_length=2000)
    source_keyword: str | None = Field(None, max_length=200)


class CandidateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: Literal["google_keyword", "social_scraping"] = Field(description="'manual' 후보는 projects 모듈 소관")
    items: list[CandidateItem] = Field(min_length=1, max_length=MAX_ITEMS)


class CandidateOut(BaseModel):
    added_count: int
    skipped_count: int = Field(description="빈 텍스트·요청 안 중복·프로젝트에 이미 있는 텍스트")
    candidate_ids: list[uuid.UUID]


CandidateEnvelope = Envelope[CandidateOut]
