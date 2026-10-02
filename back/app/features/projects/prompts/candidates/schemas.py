"""projects.prompts.candidates 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_IDS = 500


class CandidateItem(BaseModel):
    candidate_id: uuid.UUID
    source: Literal["google_keyword", "social_scraping", "manual"]
    source_keyword: str | None = None
    text: str
    created_at: datetime


class CandidateList(BaseModel):
    items: list[CandidateItem]
    next_cursor: str | None = None


class CandidateIds(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_IDS)

    @field_validator("candidate_ids")
    @classmethod
    def _dedupe(cls, v: list[uuid.UUID]) -> list[uuid.UUID]:
        return list(dict.fromkeys(v))


class SelectResult(BaseModel):
    """승격 결과. not_found = 이 프로젝트 후보가 아닌 id(다른 프로젝트 id 포함, 존재 여부는 구분하지 않는다)."""
    created: int
    prompt_ids: list[uuid.UUID]
    not_found: list[uuid.UUID]


class DeleteResult(BaseModel):
    deleted: int
    not_found: list[uuid.UUID]
