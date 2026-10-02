"""admin.cycles.cycles 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

내부 정수 키(cyc_key·project_key)는 응답에 싣지 않는다. 회차 식별자 = cycle_id(uuid). 경로 {cyc_key} 는 cycle_id 를 받는다
(운영 편의로 정수 cyc_key 도 받는다: 스크립트 이식 호환).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.core.filters import CommonFilters

# 운영 요청 감사 사유: 앞뒤 공백을 걷은 뒤 1자 이상(공백만 있는 사유는 422, 검증 D5)
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]

HiddenScope = Literal["none", "all", "citations", "mentions"]
HiddenReason = Literal["none", "collection_error", "operator"]
CycleStatus = Literal["open", "closed", "published", "stale"]
Op = Literal["hide", "unhide", "close", "set_view_date"]

HIDDEN_SCOPE_NAME: dict[int, HiddenScope] = {0: "none", 1: "all", 2: "citations", 3: "mentions"}
HIDDEN_REASON_NAME: dict[int, HiddenReason] = {0: "none", 1: "collection_error", 2: "operator"}
STATUS_NAME: dict[int, CycleStatus] = {0: "open", 1: "closed", 2: "published", 3: "stale"}


class PendingChange(BaseModel):
    change_id: int
    op: str | None
    status: Literal["pending", "running"]
    requested_by: uuid.UUID | None = None
    requested_at: datetime


class CycleItem(BaseModel):
    cycle_id: uuid.UUID
    surface: str
    project_id: uuid.UUID | None = Field(None, description="고객 프로젝트·표준 루트 id(웹사이트는 null)")
    site_id: uuid.UUID | None = Field(None, description="웹사이트 사이트 id")
    ledger_backed: bool
    round_date: date
    anchor_date: date
    status: CycleStatus
    servable: bool
    view_date: date | None = None
    hidden_scope: HiddenScope
    hidden_reason: HiddenReason
    generation: int
    pending: list[PendingChange] = Field(default_factory=list, description="대기·진행 중 운영 요청(cycle_admin)")


class JobDistribution(BaseModel):
    """rd.job(모든 status·드롭 포함) 조회 시 계산."""
    total: int
    completed: int
    running: int
    failed: int
    other: int
    dropped: int
    served: int


class AnswerDistribution(BaseModel):
    """rd.answer(완료·비드롭) 분석 상태 조회 시 계산. gap = 분석 미도착·실패(analysis_state ≥ 2)."""
    total: int
    gap: int
    analyzed_mentions: int
    analyzed_empty: int
    pending: int
    failed: int


class Counters(BaseModel):
    """ing.cycle 카운터의 rd.cycle 1:1 투영(Q2 개정 D8 예외 ③). 가상 회차 등 원장 없는 회차는 null."""
    expected_units: int | None = None
    completed_units: int | None = None
    completed_answers: int | None = None
    gap_answers: int | None = None


class CycleDetail(CycleItem):
    counters: Counters
    jobs: JobDistribution
    answers: AnswerDistribution


class CycleListQuery(CommonFilters):
    """회차 목록 쿼리 = 공통 필터(surface·project_id·from/to 만 지원) + 키셋. 쿼리 모델은 유일한 쿼리 파라미터여야 펼쳐진다.
    회차 운영 창은 자체 기본 창(최근 DEFAULT_WEEKS 주)을 쓰므로 공통 필터의 한쪽 기간 채움(분석 읽기 전용)을 받지 않는다: from·to 는 쌍."""
    cursor: str | None = Field(None, max_length=4096)
    limit: int = Field(200, ge=1, le=500)

    @model_validator(mode="after")
    def _pair(self) -> CycleListQuery:
        if (self.from_ is None) != (self.to is None):
            raise ValueError("from·to 는 둘 다 주거나 둘 다 생략")
        return self


class _WriteBase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    dry_run: bool = Field(False, description="참이면 경고·대상 상태만 돌려주고 요청을 남기지 않는다")
    expected_generation: int | None = Field(None, ge=0, description="rd.cycle.generation 과 다르면 409 generation_mismatch")


class HideBody(_WriteBase):
    hidden_scope: Literal["all", "citations"] = Field("all", description="운영 도구는 전체·인용 숨김만(Q18: mentions 미노출)")
    reason: Literal["collection_error", "operator"]


class UnhideBody(_WriteBase):
    pass


class CloseBody(_WriteBase):
    reason: Reason


class ViewDateBody(_WriteBase):
    view_date: date


class CycleState(BaseModel):
    status: CycleStatus
    view_date: date | None = None
    hidden_scope: HiddenScope
    hidden_reason: HiddenReason


class CycleRequestResult(BaseModel):
    cycle_id: uuid.UUID
    op: Op
    dry_run: bool
    change_id: int | None = None
    propagation: Literal["pending", "none"]
    current: CycleState
    requested: CycleState = Field(description="적재기가 반영한 뒤 기대 상태")
    warnings: list[str] = Field(default_factory=list)
