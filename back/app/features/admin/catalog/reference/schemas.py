"""admin.catalog.reference 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

from pydantic import BaseModel, Field


class TaxonomyRow(BaseModel):
    """표준 루트 카탈로그(활성 행)의 라벨 조합 하나(DISTINCT). null = 그 단계 아래 값 없음(캐스케이드 끝)."""
    brand_code: str | None = None
    brand_presence: str | None = None
    list_type: str | None = None
    depth1: str | None = None
    depth2: str | None = None
    depth3: str | None = None
    depth4: str | None = Field(None, description="편집 전용 메타(분석 필터 축 아님)")


class TaxonomyData(BaseModel):
    items: list[TaxonomyRow]
    funnel_stages: list[str] = Field(description="활성 행의 funnel_stage 값(정렬, null 제외)")


class Market(BaseModel):
    code: str = Field(description="ISO alpha-2 또는 x: 의사코드")
    pseudo: bool


class MarketData(BaseModel):
    items: list[Market]
    bounded: bool = Field(description="false = 루트 프로젝트 시장 설정이 없어 편집 시 형식만 검사한다(상한 없음)")
