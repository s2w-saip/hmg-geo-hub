"""intent.social.context_map 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope.

감성은 비율을 Ratio{num, den} 정수 쌍으로만 낸다(core.envelope 규칙, pct 는 프론트). den = 긍정+부정+중립 합(utterance_count 아님,
현행 sentimentPerspective). den 0 이면 현행 화면은 중립 100% 로 표시한다(프론트 폴백). 구 필드명 perspective(buyer/seller)는 폐기.
"""
from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, Field

from app.core.envelope import Envelope, Ratio

Strength = Literal["high", "medium", "low"]


class Sentiment(BaseModel):
    positive: Ratio
    negative: Ratio
    neutral: Ratio


class Stats(BaseModel):
    contexts: int
    conditions: int
    drives: int
    combinations: int
    relationships: int = Field(description="drives + combinations")
    sources: int = Field(description="출처 도메인 수(count DISTINCT host)")


class ContextRow(BaseModel):
    id: uuid.UUID
    name: str
    theme_id: str = Field(description="dimension 코드, 없으면 '기타'")
    theme_name: str = Field(description="현행 DIMENSION_THEME 매핑(서버 고정 한국어)")
    mention_count: int
    utterance_count: int
    sentiment: Sentiment
    linked_count: int = Field(description="이 맥락이 유발하는 조건 수")


class ConditionRow(BaseModel):
    id: uuid.UUID
    name: str
    category: str = Field(description="이름 정규식 휴리스틱(표시 전용, 필터 축 아님)")
    mention_count: int
    utterance_count: int
    sentiment: Sentiment
    linked_count: int = Field(description="이 조건을 유발하는 맥락 수")


class CombinationRow(BaseModel):
    id: str = Field(description="'{cond_a}:{cond_b}'")
    cond_a_id: uuid.UUID
    cond_a_name: str
    cond_b_id: uuid.UUID
    cond_b_name: str
    co_count: int
    frequency: Strength = Field(description="스냅샷 전체 max(co_count) 대비 버킷(≥0.66 high, ≥0.33 medium)")


class ContextList(BaseModel):
    items: list[ContextRow]


class ConditionList(BaseModel):
    items: list[ConditionRow]


class CombinationList(BaseModel):
    items: list[CombinationRow]
    max_co_count: int = Field(description="버킷 기준값(스냅샷 전체)")


class Evidence(BaseModel):
    quote: str
    source_host: str | None
    source_url: str | None
    sentiment: str | None


class Domain(BaseModel):
    host: str
    count: int


class Linked(BaseModel):
    id: uuid.UUID
    name: str
    co_count: int
    strength: Strength = Field(description="이 엔티티 연결 중 max 대비")


class EntityDetail(BaseModel):
    id: uuid.UUID
    name: str
    type: Literal["ConsumerContext", "ConsumerRequirement"]
    mention_count: int
    utterance_count: int
    sentiment: Sentiment
    evidence: list[Evidence] = Field(description="근거 인용 최대 8")
    source_domains: list[Domain]
    linked: list[Linked]


StatsEnvelope = Envelope[Stats | None]
ContextListEnvelope = Envelope[ContextList]
ConditionListEnvelope = Envelope[ConditionList]
CombinationListEnvelope = Envelope[CombinationList]
EntityEnvelope = Envelope[EntityDetail]
