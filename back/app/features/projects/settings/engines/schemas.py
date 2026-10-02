"""projects.settings.engines 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine


class EngineSettings(BaseModel):
    stored: list[str] | None = Field(None, description="저장값(NULL = 명시 저장 전: 기본 엔진으로 측정 중)")
    effective: list[str] = Field(description="실제 측정 엔진(저장값, 없으면 app.rule_param default_engines)")
    allowed: list[str] = Field(description="선택 가능 엔진 코드(rd.dim_engine, 카탈로그 순서)")
    can_edit: bool = Field(False, description="PUT /settings/engines 가능 여부 = 설정 can_edit ∧ core.can_operate_project"
                                              "(현행 setting/page.tsx canEditEngines 계승: 보이는 것 = 할 수 있는 것)")


class EnginesPut(BaseModel):
    model_config = ConfigDict(extra="forbid")
    engines: list[PgLine] = Field(max_length=20, description="빈 목록 = 수집 중단(현행 계승)")


class EnginesWrite(BaseModel):
    engines: list[str]
    changed: bool = Field(description="false = 같은 값이라 아무것도 쓰지 않음")
    reenable: bool = Field(False, description="직전 명시 [] 에서 1개 이상으로 되켬")
    outbox_id: int | None = Field(None, description="schedule:set_targets 아웃박스 행(변경 시)")
    propagation: str = "none"


class EngineHistoryEntry(BaseModel):
    history_id: str
    engines: list[str]
    changed_by: uuid.UUID | None = None
    changed_by_email: str | None = None
    changed_at: datetime


class EngineHistoryList(BaseModel):
    items: list[EngineHistoryEntry]
    next_cursor: str | None = None
