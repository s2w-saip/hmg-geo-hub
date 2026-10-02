"""admin.entities.registry 요청·응답 모델(Pydantic v2). 응답 봉투는 app.core.envelope."""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.filters import PgLine
from app.core.write import WriteAccepted

Role = Literal["own", "excluded", "competitor"]
Sort = Literal["answers_desc", "name_asc"]


class EntityRow(BaseModel):
    """엔티티 한 행. 수치는 엔티티 단위 전 기간 합계(운영 listDiscoveredBrands 정의, rd.entity_mention_total)."""
    entity_id: uuid.UUID
    entity_type: str | None = Field(None, description="rd.dim_entity.entity_type. 레지스트리에만 있고 아직 관측 전이면 null")
    name: str = Field(description="레지스트리 등재명 우선, 없으면 관측 대표 표기(rep_name)")
    brand_name: str | None = Field(None, description="귀속 표시 브랜드(rd.dim_brand_name.name)")
    role: Role
    brand_code: str | None = Field(None, description="own 이면 자사 브랜드(app.brand)")
    registered: bool = Field(description="app.entity_registry 행 존재(competitor 는 파생 기본값이라 행 없음)")
    own_brand: str | None = Field(None, description="활성 버전 기준 유효 귀속: 이 엔티티 언급이 집계되는 자사 브랜드(접두 교정·롤업·덮어쓰기·"
                                                    "제거 반영, 명부 역할과 별개, 버전 상세 effective_own_brand 와 같은 판정), 자사 아님 = null")
    answers: int = Field(description="전 기간 이 엔티티가 나온 답변 수(Brand·표시명 있는 언급의 job distinct, 드롭 답변 제외)")
    mentions: int = Field(description="전 기간 이 엔티티 언급 수 합(mention_count)")
    updated_at: datetime | None = None


class EntityList(BaseModel):
    items: list[EntityRow]


class RoleBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: Role
    brand_code: PgLine | None = Field(None, max_length=100, description="own 필수(app.brand, 엄브렐러 불가). competitor 는 무시")
    name: PgLine | None = Field(None, max_length=300, description="등재명. 생략하면 기존 등재명 또는 관측 대표 표기")


class RoleResult(WriteAccepted):
    entity_id: uuid.UUID
    name: str | None
    role: Role
    brand_code: str | None
    applied: bool = Field(description="false = 변경 없음(요청 안 남김)")
    warnings: list[str] = Field(default_factory=list, description="full_rebuild = 적재기가 전 기간 leaf 를 재구축할 수 있다(비동기)")
