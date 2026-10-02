"""projects.settings.scope_link 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.core.envelope import Ratio

LinkState = Literal["unlinked", "pending_link", "link_error", "no_data", "partial", "healthy"]


class LatestRound(BaseModel):
    round_date: date
    status: str = Field(description="open|closed|published|stale")
    servable: bool
    view_date: date | None = None


class JobCounts(BaseModel):
    total: int
    served: int = Field(description="rd.answer 로 서빙되는 job(completed ∧ 비드롭)")
    in_progress: int
    failed: int
    served_ratio: Ratio = Field(description="served / total(정수 쌍, 비율 계산은 프론트)")
    last_measured_at: datetime | None = None


class OutboxRow(BaseModel):
    outbox_id: int
    aggregate: str
    op: str
    attempts: int
    created_at: datetime
    next_attempt_at: datetime
    done_at: datetime | None = None
    last_error: str | None = None


class OutboxStatus(BaseModel):
    pending: int = Field(description="프로젝트·스케줄 아웃박스 미완료 행")
    erroring: int = Field(description="미완료 중 last_error 가 있는 행")
    prompt_pending: int = Field(description="이 프로젝트 프롬프트 아웃박스 미완료 행")
    recent: list[OutboxRow]


class ScopeLink(BaseModel):
    project_id: uuid.UUID
    scope_project_id: uuid.UUID | None = None
    linked: bool
    state: LinkState
    latest_round: LatestRound | None = None
    jobs: JobCounts | None = None
    outbox: OutboxStatus
    live: dict[str, Any] | None = Field(None, description="라이브 Scope 진단(어댑터가 켜진 경우만, 기본 꺼짐)")
