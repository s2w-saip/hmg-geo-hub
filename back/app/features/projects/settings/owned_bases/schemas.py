"""projects.settings.owned_bases 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine


class OwnedBase(BaseModel):
    base_url: str
    base_norm: str = Field(description="정규화 키(삭제 파라미터 ?base_norm=)")
    label: str | None = None
    created_by: uuid.UUID
    created_at: datetime


class OwnedBaseCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    base_url: PgLine = Field(min_length=1, max_length=2048)
    label: PgLine | None = Field(None, max_length=200)


class OwnedBaseWrite(BaseModel):
    """추가·삭제 결과: 대표 도메인(재동기화 후)과 재판정 큐 change_id(app.judgment_change 'project_owned_base')."""
    owned_base: OwnedBase | None = None
    base_norm: str
    domain: str | None = None
    change_id: int
    propagation: str = "pending"
