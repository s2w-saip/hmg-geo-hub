"""intent.keywords.research 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

검색량·순위는 정수 그대로(비율이 아니라 분자·분모 규약 대상 아님). 신선도·관측 시각은 meta.source 에 싣는다.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.core.envelope import Envelope

Status = Literal["found", "missing"]


class TrendPoint(BaseModel):
    month: date
    search_volume: int | None
    competition_index: int | None
    cpc: float | None


class SerpRow(BaseModel):
    rank: int
    url: str
    domain: str | None
    title: str | None
    snippet: str | None
    suggested_prompt: str | None = Field(description="최신 gen 초안. 없으면 null(화면 폴백은 프론트)")
    draft_model: str | None
    draft_gen: int | None


class Insight(BaseModel):
    term: str
    country: str
    location_code: int
    language_code: str
    trend: list[TrendPoint] = Field(description="시간순, 최대 12")
    serp_call_id: int | None
    serp: list[SerpRow] = Field(description="최신 SERP 호출의 행, 최대 limit")


class RelatedItem(BaseModel):
    term: str
    search_volume: int | None
    intent: str | None


class Related(BaseModel):
    term: str
    country: str
    found_count: int = Field(description="최신 호출의 연관어 수(seed 제외)")
    total_count: int | None = Field(None, description="DataForSEO 가 알려 준 원래 연관어 총수(최신 호출 tasks[0].result[0].total_count, 현행 "
                                                      "'N건 발견' foundCount, BG-39). 응답에 값이 없던 호출·호출 없음은 null(현행처럼 items 수로 폴백)")
    items: list[RelatedItem]


class LookupRow(BaseModel):
    term: str
    status: Status
    search_volume: int | None = Field(description="seed 행 검색량(최신 연관어 호출에 seed 가 없으면 null)")
    intent: str | None
    related: list[RelatedItem]
    total_count: int | None = Field(None, description="최신 연관어 호출의 DataForSEO total_count(BG-39). 없으면 null")


class Lookup(BaseModel):
    country: str
    items: list[LookupRow]


class StandardKeyword(BaseModel):
    """표준 열람자용 표준 키워드(app.standard_keyword, enabled 만). 관리용 필드(notes·created_by·enabled)는 싣지 않는다.

    한 항목 = 가시 행을 app.term_norm(term) 으로 합친 묶음(수정 라운드 검증 D4: 공통 행과 브랜드 행이 같은 term 이면 화면 탭이 둘이 됐다).
    term 은 대표 행 원문이다. 응답 안에서 term_norm 이 같은 항목은 둘이 되지 않는다(화면 탭 label 유일 가정과 맞다)."""
    keyword_id: uuid.UUID = Field(description="대표 행 id(묶음에서 created_at 최신, 동률 keyword_id 최소). 화면 탭 id 로 쓴다")
    keyword_ids: list[uuid.UUID] = Field(description="묶음의 전 행 id(대표 행 먼저, created_at DESC·keyword_id ASC)")
    term: str = Field(description="대표 행 원문 term")
    source_type: str
    brand_codes: list[str | None] = Field(description="묶음 행들의 brand_code(중복 제거, null = 공통이며 맨 앞)")
    created_at: datetime = Field(description="대표 행 created_at(정렬·커서 키)")
    updated_at: datetime = Field(description="묶음 행 updated_at 최댓값")


class StandardKeywordList(BaseModel):
    source_type: str
    items: list[StandardKeyword]


InsightEnvelope = Envelope[Insight]
RelatedEnvelope = Envelope[Related]
LookupEnvelope = Envelope[Lookup]
StandardKeywordEnvelope = Envelope[StandardKeywordList]


class TermObserved(BaseModel):
    """fetches 가 쓰는 term 별 관측 시각(내부 전달용)."""
    term_norm: str
    volume_at: datetime | None
    serp_at: datetime | None
    related_at: datetime | None
    search_at: datetime | None
