"""analytics.citations.sources 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from app.core.envelope import Ratio
from app.features.analytics.citations.domains.shared import CategoryRef

MentionType = Literal["mention", "recommendation", "comparison", "definition", "final_choice"]
MENTION_TYPES: tuple[MentionType, ...] = ("mention", "recommendation", "comparison", "definition", "final_choice")


class CategoryCount(BaseModel):
    category: CategoryRef
    citations: int
    share: Ratio = Field(description="M09: 이 카테고리 인용 / 전체 인용")


class EngineCategoryCount(BaseModel):
    category_key: int
    citations: int


class EngineCategories(BaseModel):
    engine: str = Field(description="엔진 코드")
    total: int
    categories: list[EngineCategoryCount]


class ToneTile(BaseModel):
    urls: int = Field(description="DISTINCT 인용 URL 수")
    citations: int = Field(description="인용 수")
    answers: int = Field(description="인용이 있는 답변 수")


class ToneSummary(BaseModel):
    positive: ToneTile
    negative: ToneTile


class TypeCategories(BaseModel):
    type: MentionType
    total: int = Field(description="이 유형 신호가 있는 당사 언급 답변들이 인용한 인용 수(유형 간 중복 계상)")
    categories: list[EngineCategoryCount]


class SourcesData(BaseModel):
    total_citations: int
    categories: list[CategoryCount] = Field(description="카테고리 분포(인용 수 내림차순, 0 인 카테고리 제외)")
    by_engine: list[EngineCategories] = Field(description="엔진 × 카테고리(현행 engineCategories)")
    tone: ToneSummary = Field(description="답변 톤(관점 브랜드 sent_pos 합 대 sent_neg 합)별 인용 요약 타일")
    types: list[TypeCategories] = Field(description="언급 유형 5종 × 카테고리(Q19: /sources/types 를 이 응답에 합침)")


class TypesData(BaseModel):
    items: list[TypeCategories]
