"""admin.interest.sources 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine, PgText

Channel = Literal["news", "pr", "social", "community"]      # DDL CHECK app.standard_source.channel


class Source(BaseModel):
    source_id: uuid.UUID
    url: str
    channel: str
    brand_code: str | None = None
    enabled: bool
    notes: str | None = None
    created_by: uuid.UUID
    created_at: datetime
    updated_at: datetime


class SourceList(BaseModel):
    items: list[Source]


class SourceCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    url: PgLine = Field(min_length=1, max_length=2000)
    channel: Channel
    brand_code: PgLine | None = Field(None, max_length=100)
    notes: PgText | None = Field(None, max_length=2000)
    enabled: bool = True


class SourcePatch(BaseModel):
    """준 필드만 바꾼다. brand_code·notes 의 null = 비우기. url·channel·enabled 는 null 불가."""
    model_config = ConfigDict(extra="forbid")
    url: PgLine | None = Field(None, min_length=1, max_length=2000)
    channel: Channel | None = None
    brand_code: PgLine | None = Field(None, max_length=100)
    notes: PgText | None = Field(None, max_length=2000)
    enabled: bool | None = None


class SourceDeleted(BaseModel):
    source_id: uuid.UUID
    deleted: bool = True
