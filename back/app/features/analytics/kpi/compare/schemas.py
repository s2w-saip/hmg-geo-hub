"""analytics.kpi.compare 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope 의 Meta 를 확장한 CompareMeta.

prev·cur 는 정수 쌍(P3): 비율 지표 Ratio{num, den}, 순위 지표 RankAvg{sum, count}. 억제돼도 채운다(캡션용), delta 만 null.
"""
from __future__ import annotations

from datetime import date

from pydantic import BaseModel, Field, field_validator

from app.core.envelope import Meta, RankAvg, Ratio
from app.core.filters import CommonFilters

from .logic import CompareFamily, CompareKind, CompareUnit, MetricKey, SuppressReason

ALLOWED_DAYS = (7, 14, 30, 365)


class CompareQuery(CommonFilters):
    """공통 필터 + 비교 인자. from/to 는 창 비교에서 cur 창의 lo·hi(달력 월은 1일~그 달 안, 달력 주는 월요일~그 주 안)."""
    kind: CompareKind = Field("window", description="window|calendarMonth|calendarWeek|cycle")
    days: int | None = Field(None, description="7|14|30|365. window 에서 from/to 가 없을 때 창 길이(기본 30). from/to 가 있으면 무시")
    metrics: list[MetricKey] = Field(default_factory=list, max_length=7,
                                     description="비우면 M01~M05 전부. mentions_per_answer·citations_per_answer(단위 pct)는 요청할 때만(BG-05)")

    @field_validator("days")
    @classmethod
    def _days(cls, v: int | None) -> int | None:
        if v is not None and v not in ALLOWED_DAYS:
            raise ValueError("days 는 7|14|30|365")
        return v


class CompareItem(BaseModel):
    metric: MetricKey
    family: CompareFamily
    unit: CompareUnit
    prev: Ratio | RankAvg
    cur: Ratio | RankAvg
    delta: float | None = Field(description="pp = round1((cur − prev) × 100), rank = round1(cur − prev), pct = round1((cur − prev) ÷ prev × 100)"
                                            "(직전 값 0 이면 null). 억제·분모 0 이면 null")
    suppressed: bool
    reason: SuppressReason | None
    cycles_prev: int = Field(description="직전 구간 발행 회차(round_date) 수. 지표 계열(family) 기준, 원장은 함대 기준(필터·스코프 무관)")
    cycles_cur: int
    planned_prev: int = Field(description="직전 구간 Σ expected_units(Q2), 그 계열 숨김 회차 제외")
    planned_cur: int
    missing_share_prev: float = Field(description="직전 구간 미발행 계획 단위 비중(0~1)")
    missing_share_cur: float


class Span(BaseModel):
    lo: date
    hi: date


class CompareWindows(BaseModel):
    prev: Span | None = Field(description="cycle 에서 직전 노출 회차가 없으면 null")
    cur: Span
    before: Span | None = None


class CompareInfo(BaseModel):
    kind: CompareKind
    windows: CompareWindows | None = Field(description="끝점(최신 노출 회차)이 없으면 null")
    first_published: date | None = Field(description="전 이력 첫 발행 회차 round_date, 언급 계열(M01~M04 의 start_window·start_month 판정)")
    first_published_citation: date | None = Field(
        None, description="전 이력 첫 발행 회차 round_date, 인용 계열(M05 판정. 언급 숨김 회차는 인용 계열에서 발행으로 센다)")


class CompareMeta(Meta):
    compare: CompareInfo


class CompareResponse(BaseModel):
    data: list[CompareItem]
    meta: CompareMeta
