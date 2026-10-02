"""admin.interest.keywords 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine, PgText

SourceType = Literal["google_keyword", "community_voc"]      # DDL CHECK app.standard_keyword.source_type


class Keyword(BaseModel):
    keyword_id: uuid.UUID
    term: str
    source_type: str
    brand_code: str | None = None
    enabled: bool
    notes: str | None = None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class KeywordList(BaseModel):
    items: list[Keyword]


class KeywordCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    term: PgLine = Field(min_length=1, max_length=200)
    source_type: SourceType
    brand_code: PgLine | None = Field(None, max_length=100)
    notes: PgText | None = Field(None, max_length=2000)
    enabled: bool = True


class KeywordPatch(BaseModel):
    """준 필드만 바꾼다. brand_code·notes 의 null = 비우기. term·source_type·enabled 는 null 불가."""
    model_config = ConfigDict(extra="forbid")
    term: PgLine | None = Field(None, min_length=1, max_length=200)
    source_type: SourceType | None = None
    brand_code: PgLine | None = Field(None, max_length=100)
    notes: PgText | None = Field(None, max_length=2000)
    enabled: bool | None = None


class KeywordDeleted(BaseModel):
    keyword_id: uuid.UUID
    deleted: bool = True
