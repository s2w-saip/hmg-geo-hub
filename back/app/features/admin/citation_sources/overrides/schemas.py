"""admin.citation_sources.overrides 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.filters import CommonFilters

# rd.dim_source.category_src 코드(DB-인용-도메인-웹사이트.sql 주석, AD-3 명세): 1 override 2 social 3 owned 4 seed 5 rule 6 fallback
SourceBadge = Literal["override", "social", "owned", "seed", "rule", "fallback"]
CATEGORY_SRC: dict[int, SourceBadge] = {1: "override", 2: "social", 3: "owned", 4: "seed", 5: "rule", 6: "fallback"}


class Category(BaseModel):
    key: int = Field(description="app.citation_category.category_key(택소노미 식별자)")
    name: str
    slug: str


class CategoryItem(Category):
    ord: int


class OverrideItem(BaseModel):
    domain: str
    category: Category
    note: str | None = None
    updated_by: uuid.UUID | None = None
    updated_by_email: str | None = None
    updated_at: datetime


class OverrideInfo(BaseModel):
    category: Category
    note: str | None = None
    updated_by: uuid.UUID | None = None
    updated_at: datetime
    propagated: bool = Field(description="적재기가 rd.dim_source 에 반영했는지(현재 분류 = 오버라이드 분류이고 출처 = override)")


class CandidateItem(BaseModel):
    domain: str
    citations: int = Field(description="기간 안 인용 행 수(cit_in, 호스트 있는 인용만)")
    category: Category = Field(description="현재 적용 분류(rd.dim_source 선계산). dim_source 에 없으면 오버라이드 분류")
    source: SourceBadge
    in_dim_source: bool = Field(description="기간 안에 인용이 있어 rd.dim_source 분류로 집계됐는지")
    override: OverrideInfo | None = None
    shadows_owned: bool = Field(False, description="오버라이드가 당사 공식 도메인(현행 ownedBrandOf: 당사 등록 도메인 또는 그 서브도메인)을 "
                                                   "덮는지. 경고 배지용(BG-42). 당사 판정 = app.owned_base host ∪ rd.dim_source.owned_brand_bit, "
                                                   "서픽스 일치(인용 적재 이력 없는 도메인 포함). 오버라이드가 없으면 거짓")


class CandidateQuery(CommonFilters):
    """후보 조회 쿼리 = 공통 필터 + limit. FastAPI 쿼리 모델은 유일한 쿼리 파라미터여야 펼쳐지므로 한 모델로 묶는다."""
    limit: int = Field(500, ge=1, le=5000, description="상위 N(오버라이드 도메인은 N 밖이어도 포함)")


class OverridePut(BaseModel):
    """category_key(정수) 또는 category(slug·name) 중 하나만."""
    model_config = ConfigDict(extra="forbid")
    category_key: int | None = Field(None, ge=1, le=32767)
    category: str | None = Field(None, min_length=1, max_length=100, description="citation_category.slug 또는 name")
    note: str | None = Field(None, max_length=500)

    @model_validator(mode="after")
    def _one(self) -> OverridePut:
        if (self.category_key is None) == (self.category is None):
            raise ValueError("category_key 와 category 중 하나만 준다")
        return self


class OverrideWritten(BaseModel):
    domain: str
    category: Category
    note: str | None = None
    updated_by: uuid.UUID | None = None
    updated_at: datetime
    change_id: int | None = Field(None, description="분류가 바뀌었을 때만 judgment_change id(노트만 바뀌면 null)")
    propagation: Literal["pending", "none"] = "pending"


class OverrideCleared(BaseModel):
    domain: str
    reverted: bool = True
    change_id: int
    propagation: Literal["pending"] = "pending"
