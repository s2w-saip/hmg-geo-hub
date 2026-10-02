"""analytics.filters.dates 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.envelope import Envelope
from app.core.filters import CommonFilters

DateFamily = Literal["mentions", "citations", "all"]
Preset = Literal["weekly", "biweekly", "monthly", "yearly"]


class DatesQuery(CommonFilters):
    """공통 필터 + family. FastAPI 쿼리 모델은 다른 Query 인자와 섞으면 한 덩어리 파라미터로 바뀌므로 상속으로 붙인다."""
    family: DateFamily = Field("mentions", description="숨김 게이트(R04) 계열: mentions(기본)·citations·all")


class PresetRange(BaseModel):
    preset: Preset
    from_: date = Field(serialization_alias="from", alias="from")
    to: date

    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)


class DatesData(BaseModel):
    surface: str
    latest_round_date: date | None = Field(description="family 별 기준일(R05): 게이트(R01 servable·R03 노출·R04 family 숨김) 통과 최신 round_date."
                                                       " F-1 meta.as_of(row 계열) 이하이며, 최신 회차가 그 family 로 숨겨지면 더 이르다")
    first_measured_date: date | None = Field(description="같은 게이트의 최초 round_date(프리셋 시작 클램프·달력 min)")
    dates: list[date] = Field(description="선택 가능 회차 날짜(KST, 내림차순, 최대 400)")
    dates_truncated: bool = Field(description="전체 날짜 수가 상한(400)을 넘었는가")
    presets: list[PresetRange] = Field(description="기간 프리셋 4종(끝점 = latest_round_date, 시작 클램프 = first_measured_date)")


DatesResponse = Envelope[DatesData]
