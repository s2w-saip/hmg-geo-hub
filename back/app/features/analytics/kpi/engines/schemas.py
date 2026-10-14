"""analytics.kpi.engines 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

행 값은 정수만(P3). part 로 계산하지 않은 필드는 0 이 아니라 null 이다(측정 없음과 구분: 현행 SubKpiOptions 주석의 위장 문제 해소).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.features.analytics.kpi.summary.schemas import SnapshotQuery

Part = Literal["all", "exposure", "sov", "favorability", "position", "citation"]


class EnginesQuery(SnapshotQuery):
    """공통 필터 + cycle_offset + part(히어로 좁힘, 현행 SUB_KPI_PARTS 계승) + parts(여러 part 합집합, B090)."""
    part: Part = Field("all", description="all|exposure|sov|favorability|position|citation. 계산할 열만 좁힌다")
    parts: list[Part] = Field(default_factory=list, max_length=6, description=(
        "B090: part 여럿의 합집합으로 열을 좁힌다(예: sov+citation = 엔진 일관성 배지 열, rank_detail 없음). 주면 part 대신 쓰고, "
        "비우면 [part](종전). 계산하지 않은 필드는 null(part 와 같은 규칙)"))


class EngineRow(BaseModel):
    answers: int | None = Field(description="std_in 답변 수")
    tracked: int | None = Field(description="관점 브랜드 등장 답변 수")
    multi: int | None = Field(description="관점 브랜드 언급 2회 이상 답변 수")
    top1: int | None = Field(description="순위 있는 답변 중 대표 순위 1")
    top3: int | None = Field(description="순위 있는 답변 중 대표 순위 3 이하")
    rank_sum: int | None
    ranked: int | None
    total_mentions: int | None
    tracked_mentions: int | None = Field(description="관점 브랜드 언급 합")
    sent_mentions: int | None = Field(description="관점 감성 채점 언급(A3 혼합 포함)")
    positive_mentions: int | None
    negative_mentions: int | None
    cit_total: int | None = Field(description="호스트 있는 인용 수(M05 분모)")
    cit_owned: int | None = Field(description="M05 인용 점유율 분자: global = 출처 카테고리 Official (HMG) 인용 수(hmg-geo #320·#321, "
                                              "rd.answer.cit_off), website·project = 표면 자사 인용 수. 엔진 일관성 citation_share 가 이 값을 쓴다")


class EngineItem(EngineRow):
    engine: str = Field(description="엔진 코드")


class EngineConsistency(BaseModel):
    """엔진 간 일관성 = round1(100 × min ÷ max). 유효 엔진(분모 > 0) 2개 미만·max 0·미계산 part 면 null(live.ts:831 이식)."""
    visibility: float | None
    share_of_voice: float | None
    sentiment: float | None
    position: float | None
    citation_share: float | None


class EnginesData(BaseModel):
    rows: list[EngineItem]
    total: EngineRow
    engine_consistency: EngineConsistency
