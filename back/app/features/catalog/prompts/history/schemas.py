"""catalog.prompts.history 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

요청 = CommonFilters(surface 는 생략 또는 global 만, website·project 는 422) + prompt_id·event_type[]·cursor·limit·format.
from/to 는 이 엔드포인트에서만 created_at 의 KST 달력일로 해석한다(감사 이벤트는 회차 축이 아니다). 기본 from = 오늘(KST) - 90일.
범위 검사는 core CommonFilters(DATE_MIN~DATE_MAX = 2000-01-01~2100-12-31, 밖이면 422): 경계 계산(KST 자정 → UTC, to 다음날)이
date 범위를 넘거나 asyncpg 가 0년·±infinity 로 인코딩하지 않게 한다(검증 D2: 0001-01-01·9999-12-31 이 500 이었다).
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.core.filters import CommonFilters

EventType = Literal["created", "text_updated", "meta_updated", "enabled_changed", "kind_changed", "deleted", "restored"]


class HistoryQuery(CommonFilters):
    surface: Literal["global"] = Field("global", description="생략 또는 global(감사 원장은 app.prompt 트리거 전용)")
    prompt_id: uuid.UUID | None = Field(None, description="단일 프롬프트 타임라인. 스코프 밖이면 빈 목록 + meta.dropped_filters.prompt_id")
    event_type: list[EventType] = Field(default_factory=list, max_length=7, description="app.prompt_audit_log CHECK 어휘")
    cursor: str | None = Field(None, max_length=4096)
    limit: int | None = Field(None, description="기본 500(prompt_id 지정 시 100), 상한 500")
    format: Literal["json", "csv"] = Field("json", description="csv 는 cursor·limit 무시, 상한 5,000행")


class HistoryRow(BaseModel):
    audit_id: int
    prompt_id: uuid.UUID
    prompt_text: str | None
    prompt_brand: str | None
    event_type: str
    changes: dict[str, Any] = Field(description="필드명 → {old, new}(jsonb 그대로)")
    actor_id: uuid.UUID | None
    actor_type: str
    actor_email: str | None
    batch_id: uuid.UUID | None
    created_at: datetime


HISTORY_COLUMNS: tuple[str, ...] = tuple(HistoryRow.model_fields)
