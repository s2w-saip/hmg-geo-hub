"""admin.cycles.jobs 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

job 식별자 = Scope job_id(uuid, 재적재 불변). 내부 answer_key·cyc_key 는 응답에 싣지 않는다.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

# 운영 요청 감사 사유: 앞뒤 공백을 걷은 뒤 1자 이상(공백만 있는 사유는 422, 검증 D5)
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]

JobStatus = Literal["completed", "running", "failed", "other"]
AnalysisState = Literal["analyzed_mentions", "analyzed_empty", "pending", "failed"]
JOB_STATUS: dict[int, JobStatus] = {0: "completed", 1: "running", 2: "failed", 3: "other"}
ANALYSIS: dict[int, AnalysisState] = {0: "analyzed_mentions", 1: "analyzed_empty", 2: "pending", 3: "failed"}


class Pin(BaseModel):
    anchor: date
    reason: str | None = None
    source_measured_at: datetime | None = None


class Drop(BaseModel):
    reason: str | None = None
    dropped_at: datetime | None = None
    source_measured_at: datetime | None = None


class PendingChange(BaseModel):
    change_id: int
    kind: Literal["anchor_pin", "answer_drop"]
    status: Literal["pending", "running"]
    requested_by: uuid.UUID | None = None
    requested_at: datetime


class JobRegistry(BaseModel):
    job_id: uuid.UUID
    surface: str
    cycle_id: uuid.UUID | None = None
    round_date: date
    measured_at: datetime | None = None
    status: JobStatus
    analysis_state: AnalysisState | None = Field(None, description="완료 job 의 분석 상태(비완료는 null)")
    dropped: bool
    served: bool
    pin: Pin | None = None
    drop: Drop | None = None
    pending: list[PendingChange] = Field(default_factory=list)


class _Body(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reason: Reason
    dry_run: bool = False


class AnchorPinBody(_Body):
    anchor: date = Field(description="고정할 앵커 날짜(KST, 오늘 이하)")


class DropBody(_Body):
    confirm: bool = Field(False, description="드롭은 서빙 답변을 모수에서 빼는 파괴적 요청이라 true 필수(dry_run 제외)")


class JobRequestResult(BaseModel):
    job_id: uuid.UUID
    kind: Literal["anchor_pin", "answer_drop"]
    dry_run: bool
    change_id: int | None = None
    propagation: Literal["pending", "none"]
    current: JobRegistry
    warnings: list[str] = Field(default_factory=list)
